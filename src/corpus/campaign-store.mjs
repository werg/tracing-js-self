// Durable collection checkpoints. An entry is committed only after all of its
// content-addressed objects have been fsynced and renamed into place. The log is
// append-only; a torn final line is recoverable, a changed committed byte is not.
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync,renameSync,
  existsSync,fsyncSync,appendFileSync,truncateSync,statSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';

export const sha256=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value)+'\n';
const digest=/^[a-f0-9]{64}$/;
const safeId=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;
export function canonicalJSON(value){
  const encode=(item,seen)=>{
    if(item===undefined)return ['undefined'];
    if(typeof item==='number'&&(!Number.isFinite(item)||Object.is(item,-0)))
      return ['number',Object.is(item,-0)?'-0':String(item)];
    if(typeof item==='bigint')return ['bigint',String(item)];
    if(item===null||typeof item!=='object'){
      if(['function','symbol'].includes(typeof item))throw new TypeError('Non-data campaign identity');
      return ['scalar',item];
    }
    if(seen.has(item))return ['reference',seen.get(item)];
    const index=seen.size;seen.set(item,index);
    if(Array.isArray(item))return ['array',index,item.map(x=>encode(x,seen))];
    if(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)
      throw new TypeError('Campaign identity requires plain data');
    return ['object',index,Object.keys(item).sort().map(key=>[key,encode(item[key],seen)])];
  };
  return JSON.stringify(encode(value,new Map()));
}
export const identityHash=value=>sha256(canonicalJSON(value));

export function atomicWrite(path,bytes){
  mkdirSync(dirname(path),{recursive:true});
  const temporary=path+'.tmp-'+randomUUID();
  const fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);
  const directory=openSync(dirname(path),'r');
  try{fsyncSync(directory);}finally{closeSync(directory);}
}

export class CampaignStore{
  constructor(directory,identity,{resume=false,maxObjectBytes=268435456}={}){
    this.directory=resolve(directory);this.identity=identity;
    this.identityDigest=identityHash(identity);this.maxObjectBytes=maxObjectBytes;
    this.latest=new Map();this.entries=[];this.previous=null;
    mkdirSync(this.directory,{recursive:true});
    this.headerPath=join(this.directory,'campaign.json');
    this.logPath=join(this.directory,'campaign.jsonl');
    if(existsSync(this.headerPath)){
      if(!resume)throw new Error('Campaign already exists; use --resume or a new output directory');
      const header=JSON.parse(readFileSync(this.headerPath,'utf8'));
      if(header.schema!=='semantic-generation-campaign/1'||
        header.identityDigest!==this.identityDigest||
        identityHash(header.identity)!==this.identityDigest)
        throw new Error('Campaign identity changed; refusing cached receipts from another source/environment');
    }else{
      if(existsSync(this.logPath))throw new Error('Campaign log has no immutable identity');
      atomicWrite(this.headerPath,json({schema:'semantic-generation-campaign/1',
        identityDigest:this.identityDigest,identity}));
    }
    if(existsSync(this.logPath))this.readLog();
  }
  readLog(){
    const bytes=readFileSync(this.logPath),end=bytes.lastIndexOf(10)+1;
    // A process can die during append. Complete records remain authoritative;
    // preserve the partial bytes as forensic evidence before trimming them.
    if(end!==bytes.length){
      atomicWrite(join(this.directory,'recovery','torn-log-'+sha256(bytes.subarray(end))+'.bin'),bytes.subarray(end));
      truncateSync(this.logPath,end);
    }
    for(const line of bytes.subarray(0,end).toString('utf8').split('\n').filter(Boolean)){
      const entry=JSON.parse(line),{entryDigest,...payload}=entry;
      if(entry.schema!=='semantic-generation-entry/1'||
        entry.campaignDigest!==this.identityDigest||entry.previous!==this.previous||
        identityHash(payload)!==entryDigest||!safeId.test(entry.id??'')||
        !digest.test(entry.candidateDigest??''))throw new Error('Corrupt or reordered campaign log');
      for(const ref of [entry.candidate,entry.result,entry.public,entry.private].filter(Boolean))this.readObject(ref);
      this.entries.push(entry);this.latest.set(entry.id,entry);this.previous=entryDigest;
    }
  }
  putObject(kind,value,{compress=false}={}){
    if(!['candidates','sources','inputs','fixtures','results','public','private'].includes(kind))
      throw new TypeError('Unknown campaign object kind');
    const raw=Buffer.from(json(value));
    if(raw.length>this.maxObjectBytes)throw new RangeError('Campaign object exceeds output limit');
    const hash=sha256(raw),bytes=compress?gzipSync(raw,{level:6,mtime:0}):raw;
    const path=join('objects',kind,hash+(compress?'.json.gz':'.json'));
    const absolute=join(this.directory,path);
    if(existsSync(absolute)){
      if(sha256(readFileSync(absolute))!==sha256(bytes))throw new Error('Content-addressed campaign object changed');
    }else atomicWrite(absolute,bytes);
    return {path,sha256:sha256(bytes),contentSha256:hash,bytes:bytes.length,
      uncompressedBytes:raw.length,encoding:compress?'gzip':'json'};
  }
  readObject(ref){
    if(!ref||!digest.test(ref.sha256??'')||!digest.test(ref.contentSha256??'')||
      !/^objects\/(candidates|sources|inputs|fixtures|results|public|private)\/[a-f0-9]{64}\.json(?:\.gz)?$/.test(ref.path??''))
      throw new Error('Invalid campaign object reference');
    const path=join(this.directory,ref.path);
    if(statSync(path).size!==ref.bytes||ref.bytes>this.maxObjectBytes||
      ref.uncompressedBytes>this.maxObjectBytes)throw new Error('Campaign object size changed');
    const bytes=readFileSync(path);
    if(sha256(bytes)!==ref.sha256)throw new Error('Campaign object checksum mismatch');
    const raw=ref.encoding==='gzip'?gunzipSync(bytes,{maxOutputLength:this.maxObjectBytes}):bytes;
    if(raw.length!==ref.uncompressedBytes||sha256(raw)!==ref.contentSha256)
      throw new Error('Campaign content checksum mismatch');
    return JSON.parse(raw.toString('utf8'));
  }
  candidateDigest(candidate){return identityHash({campaign:this.identityDigest,candidate});}
  cached(id,candidate,{retryFailures=false}={}){
    if(!safeId.test(id))throw new TypeError('Unsafe candidate ID');
    const entry=this.latest.get(id);
    if(!entry)return null;
    if(entry.candidateDigest!==this.candidateDigest(candidate))throw new Error('Candidate changed within frozen campaign: '+id);
    if(retryFailures&&!['admitted','locally_verified'].includes(entry.status))return null;
    return entry;
  }
  exported(entry){
    if(!entry.public||!entry.private)return null;
    return {public:this.readObject(entry.public),sidecar:this.readObject(entry.private)};
  }
  record(id,candidate,result,{durationMs=0,peakRssBytes=null}={}){
    if(!safeId.test(id)||typeof result?.status!=='string')throw new TypeError('Invalid campaign result');
    const {exported,...summary}=result;
    const previousAttempt=this.latest.get(id);
    if(previousAttempt&&previousAttempt.candidateDigest!==this.candidateDigest(candidate))
      throw new Error('Candidate identity changed before retry');
    const payload={schema:'semantic-generation-entry/1',id,
      campaignDigest:this.identityDigest,candidateDigest:this.candidateDigest(candidate),
      attempt:(previousAttempt?.attempt??0)+1,previous:this.previous,
      status:result.status,candidate:this.putObject('candidates',candidate,{compress:true}),
      result:this.putObject('results',summary,{compress:true}),
      public:exported?this.putObject('public',exported.public):null,
      private:exported?this.putObject('private',exported.sidecar,{compress:true}):null,
      durationMs,peakRssBytes};
    const entry={...payload,entryDigest:identityHash(payload)};
    const fd=openSync(this.logPath,'a',0o600);
    try{appendFileSync(fd,json(entry));fsyncSync(fd);}finally{closeSync(fd);}
    this.previous=entry.entryDigest;this.entries.push(entry);this.latest.set(id,entry);
    return entry;
  }
  materialize(entry,filename=entry.id+'.json'){
    if(!safeId.test(filename))throw new TypeError('Unsafe compatibility export path');
    const exported=this.exported(entry);
    if(exported)atomicWrite(join(this.directory,filename),json(exported));
    return exported?filename:null;
  }
}
