// Producer-owned exact commit frames. This journal alone never authorizes a
// native retry or host replay; the native side must independently own its outcome.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,link,unlink,readdir} from 'node:fs/promises';
import {resolve,join,dirname,parse,relative} from 'node:path';
import {TextDecoder,isDeepStrictEqual} from 'node:util';
import {stableAlgorithmJSON} from '../semantic/ir.js';
import {hashAlgorithmData} from '../semantic/program.js';

const HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const issuedJournals=new WeakSet(),utf8=new TextDecoder('utf-8',{fatal:true});
const fail=message=>{throw new TypeError('Native v8 request journal: '+message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const canonical=value=>Buffer.from(stableAlgorithmJSON(value),'utf8');

export function decodeNativeV8CommitFrame(requestBase64){
  if(typeof requestBase64!=='string'||!requestBase64.length)fail('exact base64 request bytes required');
  const bytes=Buffer.from(requestBase64,'base64');
  if(bytes.toString('base64')!==requestBase64)fail('noncanonical request base64');
  let text,request;
  try{text=utf8.decode(bytes);request=JSON.parse(text);}catch{fail('request must be exact UTF-8 JSON');}
  if(!text.endsWith('\n')||text.slice(0,-1).includes('\n')||JSON.stringify(request)+'\n'!==text)
    fail('request must be one original JSONL frame without duplicate fields');
  if(!['commit','commit-orchestration'].includes(request?.op)||!ID.test(request?.session??'')||
      typeof request?.id!=='string'||!request.id||typeof request.record!=='string'||
      !request.selection||typeof request.selection.selectionId!=='string')
    fail('only an exact semantic or orchestration commit frame may be retained');
  return {bytes,request};
}

function validateIdentity(value,scope){
  if(!exact(value,['schema','session_id','stream_id','session_generation','ordinal','operation','model_identity'])||
      value.schema!=='semantic-native-request-identity/1'||!ID.test(value.session_id??'')||
      !ID.test(value.stream_id??'')||!positive(value.session_generation)||!positive(value.ordinal)||
      !['commit','commit-orchestration'].includes(value.operation))fail('invalid exact request identity');
  const model=value.model_identity;
  if(!exact(model,['checkpoint','tokenizer'])&&!exact(model,['checkpoint','tokenizer','training']))
    fail('model identity requires exact checkpoint, tokenizer and optional training hashes');
  if(!Object.values(model).every(value=>typeof value==='string'&&HASH.test(value)))fail('invalid model hash');
  if(scope&&(value.session_id!==scope.sessionId||value.stream_id!==scope.streamId||
      value.session_generation!==scope.sessionGeneration))fail('request belongs to another journal scope');
}

function validateIntent(record,scope){
  if(!exact(record,['schema','identity','requestBase64','checkpoint'])||
      record.schema!=='semantic-native-producer-request/8')fail('invalid intent fields');
  validateIdentity(record.identity,scope);
  const {request}=decodeNativeV8CommitFrame(record.requestBase64),packet=record.checkpoint;
  if(request.session!==record.identity.session_id||request.op!==record.identity.operation)
    fail('request bytes differ from their immutable identity');
  const {digest,...body}=packet??{},native=packet?.native,{digest:nativeDigest,...nativeBody}=native??{};
  if(packet?.schema!=='semantic-native-transport-checkpoint/8'||!HASH.test(digest??'')||
      digest!==hashAlgorithmData(body)||native?.schema!=='semantic-model-checkpoint/8'||
      native.equivalence!=='verified-model-reexecution'||!HASH.test(nativeDigest??'')||
      nativeDigest!==hashAlgorithmData(nativeBody)||!isDeepStrictEqual(packet.identity,native.initialization)||
      !Array.isArray(packet.attempts)||!packet.attempts.every((item,index)=>item?.attempt===index))
    fail('invalid independently captured precommit transport checkpoint');
  const model=record.identity.model_identity,identity=packet.identity;
  if(identity.checkpointIdentity!==model.checkpoint||identity.tokenizerIdentity!==model.tokenizer||
      (identity.trainingIdentity??null)!==(model.training??null))fail('checkpoint changed request model identity');
  const matching=packet.attempts.filter(item=>item.session===request.session&&
    item.selection?.selectionId===request.selection.selectionId);
  if(matching.length!==1||matching[0].status!=='acknowledging'||matching[0].record!==request.record||
      !isDeepStrictEqual(matching[0].selection,request.selection))fail('commit does not name the exact pending attempt');
  return record;
}

async function syncDirectory(path){
  const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await file.sync();}finally{await file.close();}
}
async function privateDirectory(path){
  let cursor=parse(path).root;
  for(const part of relative(cursor,path).split('/').filter(Boolean)){
    const parent=cursor;cursor=join(cursor,part);let info;
    try{info=await lstat(cursor);}catch(error){
      if(error.code!=='ENOENT')throw error;
      try{await mkdir(cursor,{mode:0o700});}catch(failure){if(failure.code!=='EEXIST')throw failure;}
      await syncDirectory(parent);info=await lstat(cursor);
    }
    if(!info.isDirectory()||info.isSymbolicLink())fail('journal path must not traverse symlinks');
  }
  const info=await lstat(path);
  if(info.uid!==process.getuid()||(info.mode&0o077)!==0)fail('journal directory must be owner-private');
  await syncDirectory(dirname(path));await syncDirectory(path);
}

/** Immutable ordinal slots retain exact JSONL bytes and the whole transport cut. */
export class DurableNativeV8RequestJournal {
  constructor({directory,sessionId,streamId,sessionGeneration=1,maxBytes=64*1024*1024,maxRequests=4096}={}){
    if(process.platform!=='linux'||typeof process.getuid!=='function')fail('trusted local Linux storage required');
    if(typeof directory!=='string'||!directory.trim()||!ID.test(sessionId??'')||!ID.test(streamId??'')||
        !positive(sessionGeneration)||!positive(maxBytes)||!positive(maxRequests))fail('invalid journal scope or bounds');
    const root=resolve(directory),scope={session_id:sessionId,stream_id:streamId,session_generation:sessionGeneration};
    Object.defineProperties(this,Object.fromEntries(Object.entries({directory:root,sessionId,streamId,
      sessionGeneration,maxBytes,maxRequests,scopeDirectory:join(root,'producer-native-requests',sha(canonical(scope)))})
      .map(([key,value])=>[key,{value,enumerable:true}])));
    issuedJournals.add(this);
  }
  path(ordinal){
    if(!positive(ordinal)||ordinal>this.maxRequests)fail('invalid request ordinal or request bound');
    return join(this.scopeDirectory,String(ordinal).padStart(20,'0')+'.intent.json');
  }
  async append({identity,requestBase64,checkpoint}){
    const record=validateIntent(structuredClone({schema:'semantic-native-producer-request/8',
      identity,requestBase64,checkpoint}),this),bytes=canonical(record),ordinal=record.identity.ordinal,
      target=this.path(ordinal);
    if(bytes.length>this.maxBytes)fail('intent exceeds configured byte limit');
    await privateDirectory(this.directory);
    await privateDirectory(dirname(this.scopeDirectory));await privateDirectory(this.scopeDirectory);
    const existing=await this.list();
    if(existing.length&&ordinal!==existing.at(-1).ordinal+1||!existing.length&&ordinal!==1)
      fail('new request must append to the exact journal sequence');
    const temporary=join(this.scopeDirectory,'.tmp-'+randomUUID());
    try{
      const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
      try{await link(temporary,target);}catch(error){
        if(error.code==='EEXIST')fail('existing intent requires explicit reconciliation, never another dispatch');
        throw error;
      }
      await syncDirectory(this.scopeDirectory);
    }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    const receipt={schema:'semantic-native-producer-request-receipt/8',ordinal,
      digest:sha(bytes),bytes:bytes.length,sessionId:this.sessionId,streamId:this.streamId,
      sessionGeneration:this.sessionGeneration};
    await this.read(receipt);
    return Object.freeze(receipt);
  }
  async read(receipt,{latest=false}={}){
    receipt=structuredClone(receipt);
    if(!exact(receipt,['schema','ordinal','digest','bytes','sessionId','streamId','sessionGeneration'])||
        receipt.schema!=='semantic-native-producer-request-receipt/8'||!HASH.test(receipt.digest??'')||
        !positive(receipt.bytes)||receipt.sessionId!==this.sessionId||receipt.streamId!==this.streamId||
        receipt.sessionGeneration!==this.sessionGeneration)fail('invalid exact journal receipt');
    await privateDirectory(this.scopeDirectory);
    const file=await open(this.path(receipt.ordinal),constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
    try{
      const stat=await file.stat();
      if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.nlink!==1||
          stat.size<1||stat.size>this.maxBytes)fail('unsafe intent file or byte bound');
      bytes=await file.readFile();
    }finally{await file.close();}
    if(bytes.length!==receipt.bytes||bytes.length>this.maxBytes||sha(bytes)!==receipt.digest)
      fail('intent differs from its independently retained receipt');
    let record;try{record=JSON.parse(utf8.decode(bytes));}catch{fail('intent is not exact UTF-8 JSON');}
    if(!canonical(record).equals(bytes))fail('noncanonical intent bytes');
    validateIntent(record,this);
    if(record.identity.ordinal!==receipt.ordinal)fail('ordinal slot changed');
    // Visible bytes after a lost directory-sync acknowledgement require a new
    // independent durability acknowledgement; visibility alone is not one.
    await syncDirectory(this.scopeDirectory);
    if(latest){const entries=await this.list();
      if(entries.at(-1)?.ordinal!==receipt.ordinal)fail('a later request exists; stale recovery is refused');}
    return record;
  }
  async inspect(ordinal){
    await privateDirectory(this.scopeDirectory);
    const file=await open(this.path(ordinal),constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
    try{
      const stat=await file.stat();
      if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.nlink!==1||
          stat.size<1||stat.size>this.maxBytes)fail('unsafe intent file or byte bound');
      bytes=await file.readFile();
    }finally{await file.close();}
    const receipt={schema:'semantic-native-producer-request-receipt/8',ordinal,digest:sha(bytes),bytes:bytes.length,
      sessionId:this.sessionId,streamId:this.streamId,sessionGeneration:this.sessionGeneration};
    return {receipt,intent:await this.read(receipt)};
  }
  async list(){
    let entries;try{entries=await readdir(this.scopeDirectory,{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
    const ordinals=entries.filter(item=>/^\d{20}\.intent\.json$/.test(item.name)).map(item=>{
      if(!item.isFile()||item.isSymbolicLink())fail('unsafe published intent');
      const ordinal=Number(item.name.slice(0,20));this.path(ordinal);return ordinal;
    }).sort((a,b)=>a-b);
    if(ordinals.some((value,index)=>value!==index+1))fail('journal sequence is incomplete');
    return ordinals.map(ordinal=>({ordinal}));
  }
}

export function assertDurableNativeV8RequestJournal(journal){
  if(!issuedJournals.has(journal))fail('an original durable producer request journal is required');
  return journal;
}
