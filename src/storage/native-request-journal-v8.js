// Producer-owned exact commit, child-bootstrap and terminal-close frames. This journal alone never authorizes a
// native retry or host replay; the native side must independently own its outcome.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,link,unlink,readdir} from 'node:fs/promises';
import {resolve,join,dirname,parse,relative} from 'node:path';
import {TextDecoder,isDeepStrictEqual} from 'node:util';
import {stableAlgorithmJSON} from '../semantic/ir.js';
import {hashAlgorithmData} from '../semantic/program.js';
import {deriveCallbackAdmissionV8} from '../semantic/orchestration-callback-v8.js';

const HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const issuedJournals=new WeakSet(),utf8=new TextDecoder('utf-8',{fatal:true});
const fail=message=>{throw new TypeError('Native v8 request journal: '+message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const canonical=value=>Buffer.from(stableAlgorithmJSON(value),'utf8');

function decodeNativeV8RequestFrame(requestBase64){
  if(typeof requestBase64!=='string'||!requestBase64.length)fail('exact base64 request bytes required');
  const bytes=Buffer.from(requestBase64,'base64');
  if(bytes.toString('base64')!==requestBase64)fail('noncanonical request base64');
  let text,request;
  try{text=utf8.decode(bytes);request=JSON.parse(text);}catch{fail('request must be exact UTF-8 JSON');}
  if(!text.endsWith('\n')||text.slice(0,-1).includes('\n')||JSON.stringify(request)+'\n'!==text)
    fail('request must be one original JSONL frame without duplicate fields');
  return {bytes,request};
}

export function decodeNativeV8CommitFrame(requestBase64){
  const {bytes,request}=decodeNativeV8RequestFrame(requestBase64);
  if(request?.op==='admit-orchestration-callback'){
    if(!exact(request,['id','op','session','track','public','contexts'])||!ID.test(request.session??'')||
      typeof request.id!=='string'||!request.id||typeof request.track!=='string'||!request.track||
      !request.public||!Array.isArray(request.contexts))fail('only an exact observed callback admission frame may be retained');
    return {bytes,request};
  }
  if(!['commit','commit-orchestration'].includes(request?.op)||!ID.test(request?.session??'')||
      typeof request?.id!=='string'||!request.id||typeof request.record!=='string'||
      !request.selection||typeof request.selection.selectionId!=='string')
    fail('only an exact semantic or orchestration commit frame may be retained');
  return {bytes,request};
}

export function decodeNativeV8BootstrapFrame(requestBase64){
  const {bytes,request}=decodeNativeV8RequestFrame(requestBase64);
  if(!exact(request,['id','op','session','track','childTrack'])||request.op!=='bootstrap-orchestration-child'||
      !ID.test(request.session??'')||typeof request.id!=='string'||!request.id||
      typeof request.track!=='string'||!request.track||typeof request.childTrack!=='string'||!request.childTrack)
    fail('only an exact reserved child-bootstrap frame may be retained');
  return {bytes,request};
}

export function decodeNativeV8CloseFrame(requestBase64){
  const {bytes,request}=decodeNativeV8RequestFrame(requestBase64);
  if(!exact(request,['op','session','reason','id'])||request.op!=='cancel'||
      !ID.test(request.session??'')||typeof request.id!=='string'||!request.id||
      typeof request.reason!=='string'||request.reason.length===0||
      Buffer.byteLength(request.reason,'utf8')>4096)
    fail('only an exact terminal session close frame may be retained');
  return {bytes,request};
}

function validateIdentity(value,scope){
  if(!exact(value,['schema','session_id','stream_id','session_generation','ordinal','operation','model_identity'])||
      value.schema!=='semantic-native-request-identity/1'||!ID.test(value.session_id??'')||
      !ID.test(value.stream_id??'')||!positive(value.session_generation)||!positive(value.ordinal)||
      !['commit','commit-orchestration','admit-orchestration-callback','bootstrap-orchestration-child','cancel'].includes(value.operation))
    fail('invalid exact request identity');
  const model=value.model_identity;
  if(!exact(model,['checkpoint','tokenizer'])&&!exact(model,['checkpoint','tokenizer','training']))
    fail('model identity requires exact checkpoint, tokenizer and optional training hashes');
  if(!Object.values(model).every(value=>typeof value==='string'&&HASH.test(value)))fail('invalid model hash');
  if(scope&&(value.session_id!==scope.sessionId||value.stream_id!==scope.streamId||
      value.session_generation!==scope.sessionGeneration))fail('request belongs to another journal scope');
}

function validateIntent(record,scope){
  const bootstrap=record?.schema==='semantic-native-producer-bootstrap-request/8';
  if(!exact(record,['schema','identity','requestBase64','checkpoint',...(bootstrap?['createReceipt']:[])])||
      !bootstrap&&record.schema!=='semantic-native-producer-request/8')fail('invalid intent fields');
  validateIdentity(record.identity,scope);
  const decode=bootstrap?decodeNativeV8BootstrapFrame:record.identity.operation==='cancel'?
    decodeNativeV8CloseFrame:decodeNativeV8CommitFrame;
  const {request}=decode(record.requestBase64),packet=record.checkpoint;
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
  if(request.op==='cancel'){
    assertNativeV8TerminalCloseCheckpoint(native,request.session);
    return record;
  }
  if(request.op==='admit-orchestration-callback'){
    const saved=native.sessions?.[request.session];
    if(!saved||saved.orchestration?.track!==request.track||
      Object.values(native.sessions).some(row=>row.unacknowledgedSelection!==null))
      fail('callback admission requires its exact quiescent coordinator');
    deriveCallbackAdmissionV8({session:request.session,state:saved.orchestration,previousPublic:saved.public,
      previousContexts:saved.contexts,completed:saved.completed,public:request.public,contexts:request.contexts});
    return record;
  }
  if(bootstrap){
    const receipt=record.createReceipt;
    if(!exact(receipt,['schema','ordinal','digest','bytes','sessionId','streamId','sessionGeneration'])||
        receipt.schema!=='semantic-native-producer-request-receipt/8'||!HASH.test(receipt.digest??'')||
        !positive(receipt.bytes)||receipt.ordinal!==record.identity.ordinal-1||
        receipt.sessionId!==record.identity.session_id||receipt.streamId!==record.identity.stream_id||
        receipt.sessionGeneration!==record.identity.session_generation)
      fail('bootstrap requires its exact immediately preceding create receipt');
    const creates=packet.attempts.filter(item=>item.family==='orchestration'&&item.status==='accepted'&&
      isDeepStrictEqual(item.durableRequestReceipt,receipt)&&item.commitReceipt?.track?.address===request.childTrack);
    if(creates.length!==1||creates[0]!==packet.attempts.at(-1)||
        creates[0].commitReceipt?.track?.parent!==request.track||
        creates[0].commitReceipt?.track?.bootstrap_ready!==false||Object.hasOwn(creates[0],'durableBootstrap'))
      fail('bootstrap is not the exact accepted create before any child initialization');
    return record;
  }
  const matching=packet.attempts.filter(item=>item.session===request.session&&
    item.selection?.selectionId===request.selection.selectionId);
  if(matching.length!==1||matching[0].status!=='acknowledging'||matching[0].record!==request.record||
      !isDeepStrictEqual(matching[0].selection,request.selection))fail('commit does not name the exact pending attempt');
  return record;
}

function validateBootstrapCreate(record,create){
  if(create.schema!=='semantic-native-producer-request/8')fail('bootstrap predecessor is not a selected create');
  const {request}=decodeNativeV8BootstrapFrame(record.requestBase64),
    {request:original}=decodeNativeV8CommitFrame(create.requestBase64),identity=record.identity;
  let action;try{action=JSON.parse(original.record);}catch{fail('bootstrap create record is not JSON');}
  if(original.op!=='commit-orchestration'||action?.name!=='track_create'||
      original.session!==request.session||original.track!==request.track||
      create.identity.ordinal+1!==identity.ordinal||
      !isDeepStrictEqual({...create.identity,ordinal:identity.ordinal,operation:identity.operation},identity))
    fail('bootstrap changed its create request, owner, generation or adjacent ordinal');
  const attempt=record.checkpoint.attempts.at(-1),receipt=attempt.commitReceipt;
  if(attempt.record!==original.record||!isDeepStrictEqual(attempt.selection,original.selection)||
      receipt?.selectionId!==original.selection.selectionId||receipt?.committed!==true||
      receipt?.track?.address!==request.childTrack||
      !isDeepStrictEqual(receipt.track.execution,action.arguments?.execution))
    fail('bootstrap create selection or reserved child binding changed');
  for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
    if(!Number.isFinite(record.checkpoint.runtimeMetrics?.[key])||
        record.checkpoint.runtimeMetrics[key]<create.checkpoint.runtimeMetrics?.[key])
      fail('bootstrap checkpoint refunded create accounting');
}

/** A recoverable close consumes a terminal coordinator, never uncertain active work. */
export function assertNativeV8TerminalCloseCheckpoint(native,sessionId){
  const session=native?.sessions?.[sessionId],state=session?.orchestration,
    last=state?.decisions?.at(-1),operation=state?.operations?.at(-1);
  let action=null;try{if(last)action=JSON.parse(last.record);}catch{fail('invalid terminal coordinator decision');}
  const selected=last?.outcome?.committed===true&&last.outcome.track?.address===state?.track&&
    operation?.kind==='coordinator'&&native.attempts?.[operation.attempt]?.selectionId===last.selectionId&&
    native.attempts[operation.attempt].status==='committed';
  const completed=selected&&action?.name==='track_complete'&&last.outcome.track.status==='completed'&&
    state.cancelled===null;
  const cancelled=typeof state?.cancelled==='string'&&state.cancelled.length>0&&
    (operation?.kind==='cancel'&&operation.reason===state.cancelled||
      selected&&action?.name==='track_cancel'&&last.outcome.track.status==='cancelled');
  if(!session||session.unacknowledgedSelection!==null||(!completed&&!cancelled)||
      !native.closedSessions||Object.hasOwn(native.closedSessions,sessionId)||
      Object.values(native.sessions).some(row=>row?.unacknowledgedSelection!==null))
    fail('durable close requires an exact terminal coordinator and no pending selection');
  return session;
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
  async append({identity,requestBase64,checkpoint,createReceipt}){
    const bootstrap=identity?.operation==='bootstrap-orchestration-child';
    const record=validateIntent(structuredClone({schema:bootstrap?'semantic-native-producer-bootstrap-request/8':
      'semantic-native-producer-request/8',identity,requestBase64,checkpoint,
      ...(bootstrap?{createReceipt}:{})}),this),bytes=canonical(record),ordinal=record.identity.ordinal,
      target=this.path(ordinal);
    if(bootstrap)validateBootstrapCreate(record,await this.read(record.createReceipt,{latest:true}));
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
    if(record.schema==='semantic-native-producer-bootstrap-request/8')
      validateBootstrapCreate(record,await this.read(record.createReceipt));
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
