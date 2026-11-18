// Durable collection checkpoints. An entry is committed only after all of its
// content-addressed objects have been fsynced and renamed into place. The log is
// append-only; a torn final line is recoverable, a changed committed byte is not.
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync,renameSync,
  existsSync,fsyncSync,appendFileSync,ftruncateSync,statSync} from 'node:fs';
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

function syncDirectory(path){
  const descriptor=openSync(path,'r');
  try{fsyncSync(descriptor);}finally{closeSync(descriptor);}
}
export function atomicWrite(path,bytes){
  mkdirSync(dirname(path),{recursive:true});
  const temporary=path+'.tmp-'+randomUUID();
  const fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);
  syncDirectory(dirname(path));
}

export class CampaignStore{
  constructor(directory,identity,{resume=false,readOnly=false,maxObjectBytes=268435456}={}){
    this.directory=resolve(directory);this.identity=identity;
    this.identityDigest=identityHash(identity);this.maxObjectBytes=maxObjectBytes;this.readOnly=readOnly;
    this.latest=new Map();this.entries=[];this.previous=null;
    if(readOnly&&!existsSync(join(this.directory,'campaign.json')))throw new Error('Cannot read an absent campaign');
    mkdirSync(this.directory,{recursive:true});
    // flock locks the inherited open-file description, which remains open in
    // this process after the short helper exits. The kernel releases the lock
    // on close/crash; stale PID files and racy lock-file removal are unnecessary.
    // Never unlink this stable inode: that would let another writer bypass it.
    this.lockDescriptor=openSync(join(this.directory,'.campaign.lock'),'a',0o600);
    try{
      execFileSync('flock',[readOnly?'--shared':'--exclusive','--nonblock','3'],
        {stdio:['ignore','pipe','pipe',this.lockDescriptor]});
    }catch(error){
      closeSync(this.lockDescriptor);this.lockDescriptor=null;
      throw new Error(error.status===1?'Campaign is already open by another writer':
        'Campaign storage requires the OS flock utility for crash-safe writer exclusion', {cause:error});
    }
    try{
      this.headerPath=join(this.directory,'campaign.json');
      this.logPath=join(this.directory,'campaign.jsonl');
      if(existsSync(this.headerPath)){
        if(!resume&&!readOnly)throw new Error('Campaign already exists; use --resume or a new output directory');
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
    }catch(error){this.close();throw error;}
  }
  close(){
    if(this.lockDescriptor!==null){closeSync(this.lockDescriptor);this.lockDescriptor=null;}
  }
  [Symbol.dispose](){this.close();}
  assertOpen(){
    if(this.lockDescriptor===null)throw new Error('Campaign store is closed');
  }
  assertWritable(){
    this.assertOpen();
    if(this.readOnly)throw new Error('Campaign store is read only');
  }
  readLog(){
    this.assertOpen();
    const bytes=readFileSync(this.logPath),end=bytes.lastIndexOf(10)+1;
    // A process can die during append. Complete records remain authoritative;
    // preserve the partial bytes as forensic evidence before trimming them.
    if(end!==bytes.length){
      if(this.readOnly)throw new Error('Campaign has an incomplete log tail; resume recovery before release verification');
      atomicWrite(join(this.directory,'recovery','torn-log-'+sha256(bytes.subarray(end))+'.bin'),bytes.subarray(end));
      const descriptor=openSync(this.logPath,'r+');
      try{ftruncateSync(descriptor,end);fsyncSync(descriptor);}finally{closeSync(descriptor);}
    }
    for(const line of bytes.subarray(0,end).toString('utf8').split('\n').filter(Boolean)){
      const entry=JSON.parse(line),{entryDigest,...payload}=entry;
      if(entry.schema!=='semantic-generation-entry/1'||
        entry.campaignDigest!==this.identityDigest||entry.previous!==this.previous||
        identityHash(payload)!==entryDigest||!safeId.test(entry.id??'')||
        !digest.test(entry.candidateDigest??''))throw new Error('Corrupt or reordered campaign log');
      const candidate=this.readObject(entry.candidate),result=this.readObject(entry.result);
      if(entry.candidateDigest!==this.candidateDigest(candidate)||result.status!==entry.status||
        entry.attempt!==(this.latest.get(entry.id)?.attempt??0)+1||Boolean(entry.public)!==Boolean(entry.private))
        throw new Error('Campaign result, attempt or candidate binding changed');
      this.verifyCandidateObjects(candidate);
      for(const ref of [entry.public,entry.private].filter(Boolean))this.readObject(ref);
      this.entries.push(entry);this.latest.set(entry.id,entry);this.previous=entryDigest;
    }
  }
  verifyCandidateObjects(candidate){
    // Generator candidates reference shared original source/input/fixture
    // objects. Verify these too, not just the envelope that names them.
    if(candidate.inputs!==undefined){
      if(!Array.isArray(candidate.inputs))throw new Error('Invalid campaign candidate inputs');
      for(const input of candidate.inputs){
        if(!input||typeof input!=='object')throw new Error('Invalid campaign candidate input');
        for(const kind of ['source','input','fixture'])this.readObject(input[kind]);
      }
    }
  }
  putObject(kind,value,{compress=false}={}){
    this.assertWritable();
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
    if(!ref||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||
      !Number.isSafeInteger(ref.uncompressedBytes)||ref.uncompressedBytes<0||
      !['json','gzip'].includes(ref.encoding)||
      ref.path?.endsWith('.gz')!==(ref.encoding==='gzip')||
      !digest.test(ref.sha256??'')||!digest.test(ref.contentSha256??'')||
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
    // Cancellation is unfinished work. A plain resume reruns it; genuine
    // refusals remain cached unless --retry-failures explicitly requests more.
    if(entry.status==='cancelled'||retryFailures&&!['admitted','locally_verified'].includes(entry.status))return null;
    return entry;
  }
  exported(entry){
    if(!entry.public||!entry.private)return null;
    return {public:this.readObject(entry.public),sidecar:this.readObject(entry.private)};
  }
  record(id,candidate,result,{durationMs=0,peakRssBytes=null}={}){
    this.assertWritable();this.verifyCandidateObjects(candidate);
    if(identityHash(JSON.parse(json(candidate)))!==identityHash(candidate))
      throw new TypeError('Campaign candidate must encode non-JSON values before storage');
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
    syncDirectory(this.directory);
    this.previous=entry.entryDigest;this.entries.push(entry);this.latest.set(id,entry);
    return entry;
  }
  materialize(entry,filename=entry.id+'.json'){
    this.assertWritable();
    if(!safeId.test(filename))throw new TypeError('Unsafe compatibility export path');
    const exported=this.exported(entry);
    if(exported)atomicWrite(join(this.directory,filename),json(exported));
    return exported?filename:null;
  }
}
