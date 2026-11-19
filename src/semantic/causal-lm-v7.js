// Exact conventional causal-LM preparation and serving for semantic-trace/7.
// Training and generation share the same context serializer and independent
// prompt/target token segments; only generated target and EOS tokens are loss.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {TextDecoder} from 'node:util';
import {decodeAlgorithmRecord,ALGORITHM_TRACE_VERSION} from './trace-codec.js';
import {decodeDetailedRecord,DETAILED_CONTEXT_VERSION,DETAILED_TRACE_VERSION,
  validateDetailedProjection} from './detailed-v7.js';
import {hashAlgorithmData,validateAlgorithmProgram} from './program.js';
import {stableAlgorithmJSON} from './ir.js';
import {recheckAlgorithmEvidence} from './compiler.js';
import {verifySemanticSplitIdentity} from './family-registry.js';

export const CAUSAL_LM_V7_BRIDGE_VERSION='semantic-causal-lm/3';
const HASH=/^[0-9a-f]{64}$/;
const utf8=new TextDecoder('utf-8',{fatal:true});
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const fail=message=>{throw new TypeError('Causal LM v7: '+message);};
const require=(value,message)=>{if(!value)fail(message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));

function validateAlgorithmContext(context){
  if(!plain(context)||context.schema!==DETAILED_CONTEXT_VERSION||context.representation!=='algorithm'||
    !HASH.test(context.definition??'')||!HASH.test(context.input??'')||
    typeof context.invocationId!=='string'||!Number.isSafeInteger(context.visibleThrough)||
    !HASH.test(context.prefixDigest??'')||!plain(context.state))fail('invalid algorithm context envelope');
  const allowed=['schema','representation','definition','program','input','inputGraph','invocationId',
    'state','visibleThrough','prefixDigest'];
  if(Object.keys(context).some(key=>!allowed.includes(key))||
    Object.hasOwn(context,'program')&&!plain(context.program)||
    Object.hasOwn(context,'inputGraph')&&!plain(context.inputGraph))fail('algorithm context fields');
  if(Object.hasOwn(context,'program')&&context.program.definitionDigest!==context.definition)
    fail('program publication identity');
  if(Object.hasOwn(context,'program')){
    try{validateAlgorithmProgram(context.program);}catch{fail('published program source/core identity');}
  }
  if(Object.hasOwn(context,'inputGraph')&&hashAlgorithmData(context.inputGraph)!==context.input)
    fail('input graph publication identity');
  return true;
}

/** Resolve only definitions observed in this invocation's current/prior contexts. */
export function createAlgorithmContextResolver(){
  const programs=new Map(),inputs=new Map(),prefixes=new Map();
  return Object.freeze({resolve(context){
    validateAlgorithmContext(context);
    const prefix=prefixes.get(context.invocationId);
    if(prefix&&(context.visibleThrough<prefix.visibleThrough||
      context.visibleThrough===prefix.visibleThrough&&context.prefixDigest!==prefix.prefixDigest))
      fail('algorithm contexts moved backward or changed at the same public prefix');
    if(Object.hasOwn(context,'program')){
      const existing=programs.get(context.definition);
      if(existing&&!isDeepStrictEqual(existing,context.program))fail('published definition identity changed');
      if(!existing)programs.set(context.definition,structuredClone(context.program));
    }
    if(Object.hasOwn(context,'inputGraph')){
      const existing=inputs.get(context.input);
      if(existing&&!isDeepStrictEqual(existing,context.inputGraph))fail('published input identity changed');
      if(!existing)inputs.set(context.input,structuredClone(context.inputGraph));
    }
    const program=programs.get(context.definition),inputGraph=inputs.get(context.input);
    if(!program||!inputGraph)fail('algorithm source or input reference was not publicly published before use');
    if(program.definitionDigest!==context.definition||hashAlgorithmData(inputGraph)!==context.input)
      fail('resolved algorithm publication differs from referenced identity');
    prefixes.set(context.invocationId,{visibleThrough:context.visibleThrough,prefixDigest:context.prefixDigest});
    return {...structuredClone(context),program:structuredClone(program),inputGraph:structuredClone(inputGraph)};
  }});
}

function contextPayload(context,representation,resolver=null){
  if(representation==='detailed'){
    validateDetailedContext(context);
    return context;
  }
  if(representation==='algorithm'){
    return (resolver??createAlgorithmContextResolver()).resolve(context);
  }
  fail('unknown public representation');
}

function validateDetailedContext(context){
  if(!plain(context)||context.schema!==DETAILED_CONTEXT_VERSION||context.representation!=='detailed'||
    !plain(context.prefix)||context.prefix.schema!=='selected-inference-prefix/3'||
    context.prefix.representation!=='detailed'||context.prefix.traceFormat!==DETAILED_TRACE_VERSION||
    !Number.isSafeInteger(context.visibleThrough)||!HASH.test(context.prefixDigest??'')||
    context.visibleThrough!==Math.max(0,...(context.prefix.realmCommitted??[]).map(row=>row.sequence))||
    hashAlgorithmData(context.prefix)!==context.prefixDigest)fail('invalid detailed context or causal digest');
  for(const row of [...context.prefix.committed,...context.prefix.realmCommitted]){
    if(row.schema!=='semantic-execution/7')fail('legacy/non-v7 public row in context');
    if(row.kind==='semantic')decodeDetailedRecord(row.line,{role:'generated'});
    if(row.kind==='result')decodeDetailedRecord(row.line,{role:'observed'});
  }
  return true;
}

function targetRecord(target,representation){
  if(representation==='detailed')return decodeDetailedRecord(target,{role:'generated'});
  if(representation==='algorithm')return decodeAlgorithmRecord(target,{role:'generated'});
  fail('unknown target representation');
}

/** Full causal context prompt shared byte-for-byte by preparation and serving. */
export function causalLmV7Prompt(context,{representation=context?.representation,resolver=null}={}){
  const publicContext=contextPayload(context,representation,resolver);
  return `Predict one complete ${DETAILED_TRACE_VERSION} record from this public execution context.\n`+
    stableAlgorithmJSON(publicContext)+'\nNext record:\n';
}

function tokenizerContract(tokenizer,eosTokenId){
  require(tokenizer&&HASH.test(tokenizer.identity??'')&&typeof tokenizer.encode==='function'&&
    typeof tokenizer.decode==='function','a pinned lossless tokenizer is required');
  require(Number.isSafeInteger(eosTokenId)&&eosTokenId>=0,'an explicit record terminator token ID is required');
}
async function segment(tokenizer,text,eosTokenId){
  const ids=await tokenizer.encode(text);
  require(Array.isArray(ids)&&ids.length>0&&ids.every(id=>Number.isSafeInteger(id)&&id>=0),
    'tokenizer must emit nonempty exact integer sequences');
  let decoded;try{decoded=Buffer.from(await tokenizer.decode(ids));}catch{fail('tokenizer decode failed');}
  require(decoded.equals(Buffer.from(text,'utf8')),'tokenizer does not reproduce exact input bytes');
  require(!ids.includes(eosTokenId),'public text cannot inject the EOS token');
  return ids;
}

export async function encodeCausalLmV7Example(context,target,{tokenizer,eosTokenId,maxContextTokens,
    representation=context?.representation,resolver=null}={}){
  tokenizerContract(tokenizer,eosTokenId);
  require(Number.isSafeInteger(maxContextTokens)&&maxContextTokens>1,'an explicit context budget is required');
  targetRecord(target,representation);
  const prompt=causalLmV7Prompt(context,{representation,resolver});
  const promptIds=await segment(tokenizer,prompt,eosTokenId),targetIds=await segment(tokenizer,target,eosTokenId);
  const inputIds=[...promptIds,...targetIds,eosTokenId];
  require(inputIds.length<=maxContextTokens,'flat context budget exceeded; truncation is forbidden');
  return {schema:CAUSAL_LM_V7_BRIDGE_VERSION,traceFormat:DETAILED_TRACE_VERSION,representation,
    tokenizerIdentity:tokenizer.identity,encoding:'independent-context-and-target-segments/1',
    prompt,target,promptSha256:sha(prompt),targetSha256:sha(target),inputIds,
    labels:[...promptIds.map(()=>-100),...targetIds,eosTokenId],attentionMask:inputIds.map(()=>1),eosTokenId,
    boundaries:{promptTokens:promptIds.length,targetTokens:targetIds.length,terminalTokens:1},
    costs:{flatContextTokens:inputIds.length,publicContextTokens:promptIds.length,
      generatedTokens:targetIds.length,terminalTokens:1,maxContextTokens}};
}

function trainingContextItems(exported,representation){
  const targets=exported.public.timeline.filter(row=>row.kind==='semantic');
  const contexts=exported.contexts;
  if(!Array.isArray(contexts)||contexts.length!==targets.length)fail('one actual prefix/context per generated target is required');
  return targets.map((target,index)=>{
    const context=contexts[index];
    if(representation==='detailed'&&context?.prefix?.invocationId!==target.invocationId||
      representation==='algorithm'&&(!context?.invocationId||
        context.visibleThrough!==exported.public.timeline.slice(0,
          exported.public.timeline.indexOf(target)).filter(row=>['semantic','observation'].includes(row.kind)).length))
      fail('context does not match target cutoff and invocation');
    return {target,context,targetOrdinal:index};
  });
}

async function recheckTrainingExport(exported,{requireAdmitted,nativePolicy=null,nativeConsumer=null}){
  if(exported.public?.representation==='detailed')validateDetailedProjection(exported);
  if(!['algorithm','detailed'].includes(exported.public?.representation))
    fail('V7 public representation and private source evidence are required');
  const result=await recheckAlgorithmEvidence(exported,{requireAdmitted,nativePolicy,nativeConsumer});
  return {source:result.sourceAdmission??result.source??{valid:result.valid===true},
    admitted:result.admitted===true||result.native?.admitted===true};
}

/** Prepare only train rows from previously replayed public contexts. */
export async function buildCausalLmV7Examples(exported,options={}){
  const {tokenizer,eosTokenId,maxContextTokens,allowLocal=false,maxExamples=4096,
    expectedSplit='train',nativePolicy=null,nativeConsumer=null}=options;
  if(typeof allowLocal!=='boolean')fail('allowLocal must be explicit boolean');
  if(!Number.isSafeInteger(maxExamples)||maxExamples<1)fail('positive example cap required');
  require(exported?.public?.schema==='semantic-execution/7'&&
    exported.public.traceFormat===DETAILED_TRACE_VERSION&&
    exported.public.contextFormat===DETAILED_CONTEXT_VERSION&&
    ['algorithm','detailed'].includes(exported.public.representation),
    'new v7 execution artifact required; v6 artifacts cannot be exported');
  const representation=exported.public.representation;
  const check=await recheckTrainingExport(exported,{requireAdmitted:!allowLocal,nativePolicy,nativeConsumer});
  if(!['train','validation','test'].includes(expectedSplit))fail('requested output split is invalid');
  const privateSource=exported.sidecar?.sourceArtifact??exported.sidecar;
  const referenceInput=privateSource?.sidecar?.referenceInput;
  const source=referenceInput?.source??privateSource?.public?.timeline?.find(row=>row.kind==='program')?.source;
  const entry=referenceInput?.entry??privateSource?.public?.timeline?.find(row=>row.kind==='program')?.entry;
  const splitIdentity=exported.sidecar?.splitIdentity;
  if(!splitIdentity||typeof splitIdentity.componentId!=='string'||exported.sidecar.split!==splitIdentity.split)
    fail('complete versioned semantic-family identity required');
  verifySemanticSplitIdentity(splitIdentity,{id:splitIdentity.sourceId,
    family:exported.sidecar.sourceFamily??privateSource.sidecar?.sourceFamily,
    source,entry,coreDigest:exported.sidecar.coreDigest??undefined});
  if(exported.sidecar.split!==expectedSplit)fail('dataset split cannot be moved or relabeled');
  tokenizerContract(tokenizer,eosTokenId);
  const contexts=trainingContextItems(exported,representation),rows=[];
  const resolver=representation==='algorithm'?createAlgorithmContextResolver():null;
  for(const {target,context,targetOrdinal} of contexts){
    if(rows.length>=maxExamples)fail('example cap exceeded; partial episodes are not silently exported');
    const encoded=await encodeCausalLmV7Example(context,target.line,{tokenizer,eosTokenId,maxContextTokens,
      representation,resolver});
    rows.push({...encoded,metadata:{identityDigest:exported.sidecar.identityDigest??null,
      sourceFamily:exported.sidecar.sourceFamily??exported.sidecar.sourceArtifact?.sidecar?.sourceFamily??null,
      sourceId:splitIdentity.sourceId,targetOrdinal,
      sourceComponent:splitIdentity.componentId,
      splitPolicy:splitIdentity.policy,split:exported.sidecar.split,
      sequence:target.sequence??null,
      invocationId:target.invocationId??context.prefix?.invocationId??context.invocationId,
      contextVisibleThrough:context.visibleThrough,
      sourceAdmission:check.source,nativeAdmission:check.admitted}});
  }
  if(!rows.length)fail('certified episode has no generated targets');
  return rows;
}

/** Serving calls the same context builder and independent segment encoder. */
export function createCausalLmV7Selector({runtime,tokenizer,checkpointIdentity,eosTokenId,
    maxContextTokens,maxNewTokens=512,representation='algorithm'}={}){
  tokenizerContract(tokenizer,eosTokenId);
  require(HASH.test(checkpointIdentity??''),'immutable checkpoint identity required');
  require(runtime&&typeof runtime.initialize==='function'&&typeof runtime.generate==='function',
    'initialized production generation runtime required');
  require(['algorithm','detailed'].includes(representation),'unknown semantic-trace/7 representation');
  require(Number.isSafeInteger(maxNewTokens)&&maxNewTokens>0&&Number.isSafeInteger(maxContextTokens)&&
    maxContextTokens>maxNewTokens,'explicit generation and context budgets required');
  const emissions=[],resolver=representation==='algorithm'?createAlgorithmContextResolver():null;
  let initialized=false;
  const select=async context=>{
    require(initialized,'runtime has not attested its loaded checkpoint');
    const prompt=causalLmV7Prompt(context,{representation,resolver}),inputIds=await segment(tokenizer,prompt,eosTokenId);
    require(inputIds.length+maxNewTokens<=maxContextTokens,
      'generation exceeds context budget; truncation is forbidden');
    const started=performance.now(),promptSha256=sha(prompt);
    const previous=emissions.findLast(row=>row.promptSha256===promptSha256&&row.status!=='accepted');
    const evidence={adapter:CAUSAL_LM_V7_BRIDGE_VERSION,representation,checkpointIdentity,
      tokenizerIdentity:tokenizer.identity,promptSha256,emittedTokenIds:null,
      promptTokens:inputIds.length,promptBytes:Buffer.byteLength(prompt,'utf8'),
      attempt:emissions.length,retryOf:previous?.attempt??null,status:'submitted',
      generationMs:null,verificationMs:null,stopReason:null,payloadHex:null};
    emissions.push(evidence);
    let response;
    try{response=await runtime.generate({schema:CAUSAL_LM_V7_BRIDGE_VERSION,representation,
      inputIds,maxNewTokens,eosTokenId,doSample:false});}
    catch(error){evidence.generationMs=performance.now()-started;evidence.status='runtime-failed';
      evidence.failure=String(error.message);throw error;}
    evidence.generationMs=performance.now()-started;
    const verifying=performance.now(),ids=response?.tokenIds;
    evidence.emittedTokenIds=structuredClone(ids??null);evidence.stopReason=response?.stopReason??null;
    const refuse=message=>{evidence.status='rejected';evidence.verificationMs=performance.now()-verifying;
      evidence.failure=message;const error=new Error('Causal LM v7: '+message);
      error.category='causal-lm-emission';error.evidence=structuredClone(evidence);throw error;};
    if(!Array.isArray(ids)||!ids.length||ids.length>maxNewTokens||
      ids.some(id=>!Number.isSafeInteger(id)||id<0))refuse('invalid original emitted token sequence');
    let payload;try{payload=Buffer.from(await tokenizer.decode(ids.at(-1)===eosTokenId?ids.slice(0,-1):ids));}
    catch{refuse('original emitted tokens could not be decoded');}
    evidence.payloadHex=payload.toString('hex');
    if(ids.at(-1)!==eosTokenId||ids.slice(0,-1).includes(eosTokenId)||response.stopReason!=='eos')
      refuse('record did not end at its declared generated terminator');
    let record;try{record=utf8.decode(payload);targetRecord(record,representation);}
    catch{refuse('emitted original bytes are not a canonical generated v7 record');}
    evidence.status='accepted';evidence.verificationMs=performance.now()-verifying;
    return {record,selection:{causalLmSelected:true,...structuredClone(evidence)}};
  };
  select.representation=representation;
  select.initialize=async request=>{
    require(request?.checkpointIdentity===checkpointIdentity,'requested checkpoint differs from frozen weights');
    const receipt=await runtime.initialize({...request,tokenizerIdentity:tokenizer.identity,representation});
    require(receipt?.checkpointIdentity===checkpointIdentity&&receipt?.tokenizerIdentity===tokenizer.identity&&
      receipt.seed===request.seed,'loaded checkpoint/tokenizer/seed attestation differs');
    initialized=true;
    return {schema:'semantic-inference-identity/7',checkpointIdentity,
      tokenizerIdentity:tokenizer.identity,seed:request.seed,adapter:CAUSAL_LM_V7_BRIDGE_VERSION,
      representation,nativeAdmissionClaim:false};
  };
  select.metrics=()=>({adapter:CAUSAL_LM_V7_BRIDGE_VERSION,representation,
    emissions:structuredClone(emissions),
    generatedTokens:emissions.reduce((total,row)=>total+(row.emittedTokenIds?.length??0),0),
    promptTokens:emissions.reduce((total,row)=>total+row.promptTokens,0),
    peakContextTokens:emissions.length?Math.max(...emissions.map(row=>row.promptTokens)):0,
    predictionAttempts:emissions.length,retries:emissions.filter(row=>row.retryOf!==null).length,
    failedAttempts:emissions.filter(row=>row.status!=='accepted').length,
    generationMs:emissions.reduce((total,row)=>total+(row.generationMs??0),0),
    verificationMs:emissions.reduce((total,row)=>total+(row.verificationMs??0),0),
    unknownGenerationCostAttempts:emissions.filter(row=>row.emittedTokenIds===null).length,
    contextAccounting:'submitted-flat-token-sequences',nativeAdmissionClaim:false});
  if(typeof runtime.close==='function')select.close=()=>runtime.close();
  return select;
}
