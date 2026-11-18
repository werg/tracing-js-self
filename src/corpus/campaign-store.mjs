// Durable collection checkpoints. An entry is committed only after all of its
// content-addressed objects have been fsynced and renamed into place. The log is
// append-only; a torn final line is recoverable, a changed committed byte is not.
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync,renameSync,
  existsSync,fsyncSync,appendFileSync,ftruncateSync,statSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';

export const sha256=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value)+'\n';
const digest=/^[a-f0-9]{64}$/;
const safeId=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;
const validStatus=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,127}$/.test(value);
const validCosts=({durationMs,peakRssBytes})=>Number.isFinite(durationMs)&&durationMs>=0&&
  (peakRssBytes===null||Number.isSafeInteger(peakRssBytes)&&peakRssBytes>=0);
const objectKinds=['candidates','sources','inputs','fixtures','results','public','private','registries'];
const registryFormat='semantic-campaign-registry-evidence/1';
const registryReference='semantic-campaign-source-registry-reference/1';
const isRegistry=value=>value?.schema==='semantic-source-registry/1'&&
  Array.isArray(value.sources)&&Array.isArray(value.components);
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
  constructor(directory,identity,{resume=false,readOnly=false,maxObjectBytes=268435456,recoverTornLog=true}={}){
    this.directory=resolve(directory);this.identity=identity;
    this.identityDigest=identityHash(identity);this.maxObjectBytes=maxObjectBytes;this.readOnly=readOnly;
    this.recoverTornLog=recoverTornLog;
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
      if(!this.recoverTornLog)throw new Error('Incomplete campaign log; resume collection before read-only export');
      atomicWrite(join(this.directory,'recovery','torn-log-'+sha256(bytes.subarray(end))+'.bin'),bytes.subarray(end));
      const descriptor=openSync(this.logPath,'r+');
      try{ftruncateSync(descriptor,end);fsyncSync(descriptor);}finally{closeSync(descriptor);}
    }
    for(const line of bytes.subarray(0,end).toString('utf8').split('\n').filter(Boolean)){
      const entry=JSON.parse(line),{entryDigest,...payload}=entry;
      if(entry.schema!=='semantic-generation-entry/1'||!validStatus(entry.status)||!validCosts(entry)||
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
  putObject(kind,value,{compress=false,deduplicateRegistries=true}={}){
    this.assertWritable();
    if(!objectKinds.includes(kind))
      throw new TypeError('Unknown campaign object kind');
    const raw=Buffer.from(json(value));
    if(raw.length>this.maxObjectBytes)throw new RangeError('Campaign object exceeds output limit');
    // Storage references never enter public traces or admission identities.
    // An envelope records exactly which paths were replaced, so reference-like
    // user data is preserved literally rather than interpreted as a CAS link.
    if(deduplicateRegistries&&kind!=='public'&&kind!=='registries'){
      const references=[];
      const extract=(item,path)=>{
        if(isRegistry(item)){
          const reference=this.putRawObject('registries',Buffer.from(json(item)),true);
          const index=references.length;references.push({path,reference});
          return {schema:registryReference,index};
        }
        if(item&&typeof item==='object')for(const key of Object.keys(item))
          Object.defineProperty(item,key,{value:extract(item[key],[...path,key]),
            writable:true,enumerable:true,configurable:true});
        return item;
      };
      const packed=extract(JSON.parse(raw.toString('utf8')),[]);
      if(references.length){
        const envelope=Buffer.from(json({schema:registryFormat,value:packed,registryReferences:references}));
        return {...this.putRawObject(kind,envelope,compress),format:registryFormat,
          valueSha256:sha256(raw),valueBytes:raw.length};
      }
    }
    return this.putRawObject(kind,raw,compress);
  }
  putRawObject(kind,raw,compress){
    this.assertWritable();
    if(!objectKinds.includes(kind))throw new TypeError('Unknown campaign object kind');
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
  validateObjectReference(ref){
    if(!ref||typeof ref.path!=='string'||!digest.test(ref.sha256??'')||!digest.test(ref.contentSha256??'')||
      !/^objects\/(candidates|sources|inputs|fixtures|results|public|private|registries)\/[a-f0-9]{64}\.json(?:\.gz)?$/.test(ref.path??'')||
      !['json','gzip'].includes(ref.encoding)||
      !ref.path.endsWith('/'+ref.contentSha256+(ref.encoding==='gzip'?'.json.gz':'.json'))||
      !Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>this.maxObjectBytes||
      !Number.isSafeInteger(ref.uncompressedBytes)||ref.uncompressedBytes<0||ref.uncompressedBytes>this.maxObjectBytes||
      ref.format!==undefined&&ref.format!==registryFormat)
      throw new Error('Invalid campaign object reference');
    if(ref.format&&(!digest.test(ref.valueSha256??'')||
      !Number.isSafeInteger(ref.valueBytes)||ref.valueBytes<0||ref.valueBytes>this.maxObjectBytes))
      throw new Error('Invalid rehydrated campaign object bound');
  }
  readRawObject(ref){
    this.assertOpen();
    this.validateObjectReference(ref);
    const path=join(this.directory,ref.path);
    if(statSync(path).size!==ref.bytes)throw new Error('Campaign object size changed');
    const bytes=readFileSync(path);
    if(sha256(bytes)!==ref.sha256)throw new Error('Campaign object checksum mismatch');
    const raw=ref.encoding==='gzip'?gunzipSync(bytes,{maxOutputLength:this.maxObjectBytes}):bytes;
    if(raw.length!==ref.uncompressedBytes||sha256(raw)!==ref.contentSha256)
      throw new Error('Campaign content checksum mismatch');
    return raw;
  }
  readObject(ref){
    const raw=this.readRawObject(ref),stored=JSON.parse(raw.toString('utf8'));
    if(!ref.format)return stored; // Existing campaigns retain their raw format.
    if(stored?.schema!==registryFormat||!Object.hasOwn(stored,'value')||
      !Array.isArray(stored.registryReferences)||!stored.registryReferences.length)
      throw new Error('Invalid campaign registry envelope');
    const locations=[],paths=new Set();
    let valueBytes=Buffer.byteLength(json(stored.value));
    for(const [index,{path,reference}] of stored.registryReferences.entries()){
      this.validateObjectReference(reference);
      if(reference.format||!reference.path.startsWith('objects/registries/')||
        !Array.isArray(path)||path.some(key=>typeof key!=='string')||paths.has(JSON.stringify(path)))
        throw new Error('Invalid campaign registry path/reference');
      paths.add(JSON.stringify(path));
      let parent=stored,key='value';
      for(const segment of path){
        parent=parent[key];key=segment;
        if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))
          throw new Error('Missing campaign registry reference path');
      }
      const marker=parent[key];
      if(marker?.schema!==registryReference||marker.index!==index||Object.keys(marker).length!==2)
        throw new Error('Campaign registry reference marker changed');
      valueBytes+=reference.uncompressedBytes-1-Buffer.byteLength(JSON.stringify(marker));
      if(valueBytes>this.maxObjectBytes)throw new Error('Rehydrated campaign object exceeds output limit');
      locations.push({parent,key,reference});
    }
    if(valueBytes!==ref.valueBytes)throw new Error('Rehydrated campaign object size changed');
    // Cache bytes only during this read. Every later read verifies files again;
    // each occurrence is parsed separately to retain ordinary JSON semantics.
    const registries=new Map();
    for(const {parent,key,reference} of locations){
      const cacheKey=JSON.stringify(reference);
      if(!registries.has(cacheKey))registries.set(cacheKey,this.readRawObject(reference));
      const registry=JSON.parse(registries.get(cacheKey).toString('utf8'));
      if(!isRegistry(registry))throw new Error('Campaign registry reference resolved to a different content type');
      Object.defineProperty(parent,key,{value:registry,writable:true,enumerable:true,configurable:true});
    }
    const restored=Buffer.from(json(stored.value));
    if(restored.length!==ref.valueBytes||sha256(restored)!==ref.valueSha256)
      throw new Error('Rehydrated campaign content checksum mismatch');
    return stored.value;
  }
  storageStatistics(){
    this.assertOpen();
    const objects=Object.fromEntries(objectKinds.map(kind=>[kind,{objects:0,bytes:0}]));
    for(const kind of objectKinds){
      const directory=join(this.directory,'objects',kind);
      if(!existsSync(directory))continue;
      for(const entry of readdirSync(directory,{withFileTypes:true}))
        if(entry.isFile()&&/^[a-f0-9]{64}\.json(?:\.gz)?$/.test(entry.name)){
          objects[kind].objects++;objects[kind].bytes+=statSync(join(directory,entry.name)).size;
        }
    }
    return {scope:'all finalized CAS objects, including failed and retried attempts',byKind:objects,
      objects:Object.values(objects).reduce((n,row)=>n+row.objects,0),
      bytes:Object.values(objects).reduce((n,row)=>n+row.bytes,0)};
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
    if(!safeId.test(id)||!validStatus(result?.status)||!validCosts({durationMs,peakRssBytes}))
      throw new TypeError('Invalid campaign result status or measured costs');
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
