// One physical serializer for v8 preparation and serving. The trusted routing
// envelope is context; only the canonical generated line and EOS receive loss.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,TextDecoder} from 'node:util';
import {stableAlgorithmJSON,assertAlgorithmFields} from './ir.js';
import {validateRegionProgram,decodeRegionRecord,REGION_CONTEXT_VERSION,
  REGION_TRACE_VERSION,REGION_PROFILE} from './regions.js';
import {decodePureRegionRecord,pureRegionEntry} from './pure-region-v8.js';
import {decodeDetailedRecord} from './detailed-v7.js';
import {RegionExecutionHarness} from './region-harness.js';
import {recheckRegionEvidence} from './compiler-v8.js';
import {SEMANTIC_V8_DEFINITION} from './contract-v8.js';
import {hashAlgorithmData} from './program.js';

export const CAUSAL_LM_V8_BRIDGE_VERSION='semantic-causal-lm/4';
const HASH=/^[a-f0-9]{64}$/;
const utf8=new TextDecoder('utf-8',{fatal:true});
const sha=text=>createHash('sha256').update(text).digest('hex');
const bytes=text=>Buffer.byteLength(text,'utf8');
const sum=rows=>rows.reduce((a,b)=>a+b,0);
const fail=message=>{throw new TypeError('Causal LM v8: '+message);};
const require=(condition,message)=>{if(!condition)fail(message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));

export function validateRegionContext(context){
  assertAlgorithmFields(context,SEMANTIC_V8_DEFINITION.contextFields,'v8 model context');
  require(context.schema===REGION_CONTEXT_VERSION&&context.representation==='mixed'&&
    context.profile===REGION_PROFILE,'exact v8 context contract required');
  require(typeof context.invocationId==='string'&&context.invocationId.length>0&&
    Number.isSafeInteger(context.visibleThrough)&&context.visibleThrough>=2&&
    HASH.test(context.prefixDigest??''),'context identity or causal cutoff');
  require(Array.isArray(context.programs)&&context.programs.length>0&&context.programs.length<=1024,
    'published source definitions required');
  const ids=new Set();
  for(const row of context.programs){
    assertAlgorithmFields(row,['id','program'],'published region program');
    require(typeof row.id==='string'&&row.id.length>0&&!ids.has(row.id),'duplicate or invalid program identity');
    ids.add(row.id);validateRegionProgram(row.program);
  }
  assertAlgorithmFields(context.input,['graph'],'immutable input');
  require(plain(context.input.graph)&&Array.isArray(context.input.graph.roots)&&
    Array.isArray(context.input.graph.objects),'input graph');
  assertAlgorithmFields(context.state,SEMANTIC_V8_DEFINITION.sharedStateFields,'shared region state');
  for(const field of ['heap','locals','stack','effects','jobs','ready','captureAliases','continuations','frameFunctions','jobErrors'])
    require(Array.isArray(context.state[field]),'shared '+field+' must be a sequence');
  assertAlgorithmFields(context.regionCursor,['active','consumed'],'region cursor');
  require(context.regionCursor.active===null&&Array.isArray(context.regionCursor.consumed),
    'only committed prediction boundaries may be serialized');
  assertAlgorithmFields(context.obligations,['intents','handlers','callbacks','closureQueue'],'live obligations');
  for(const value of Object.values(context.obligations))require(Array.isArray(value),'obligation sequence');
  return true;
}

export function decodeCausalLmV8Target(target){
  require(typeof target==='string','canonical generated line required');
  if(target.startsWith('algorithm '))return {kind:'algorithm',record:decodePureRegionRecord(target)};
  if(target.startsWith('region '))return {kind:'region',record:decodeRegionRecord(target)};
  if(target.startsWith('detail '))return {kind:'semantic',record:decodeDetailedRecord(target,{role:'generated'})};
  fail('unknown generated record or observation in loss');
}

export function causalLmV8Prompt(context){
  validateRegionContext(context);
  return 'Predict one complete '+REGION_TRACE_VERSION+' record from this public execution context.\n'+
    stableAlgorithmJSON(context)+'\nNext record:\n';
}

function tokenizerContract(tokenizer,eosTokenId){
  require(tokenizer&&HASH.test(tokenizer.identity??'')&&typeof tokenizer.encode==='function'&&
    typeof tokenizer.decode==='function','a pinned lossless tokenizer is required');
  require(Number.isSafeInteger(eosTokenId)&&eosTokenId>=0,'explicit record terminator token ID required');
}
async function segment(tokenizer,text,eosTokenId){
  const ids=await tokenizer.encode(text);
  require(Array.isArray(ids)&&ids.length>0&&ids.every(id=>Number.isSafeInteger(id)&&id>=0),
    'tokenizer must emit exact nonempty integer sequences');
  let decoded;try{decoded=Buffer.from(await tokenizer.decode(ids));}catch{fail('tokenizer decode failed');}
  require(decoded.equals(Buffer.from(text,'utf8')),'tokenizer does not reproduce exact input bytes');
  require(!ids.includes(eosTokenId),'public text cannot inject EOS');
  return ids;
}

export async function encodeCausalLmV8Example(context,target,{tokenizer,eosTokenId,maxContextTokens}={}){
  tokenizerContract(tokenizer,eosTokenId);
  require(Number.isSafeInteger(maxContextTokens)&&maxContextTokens>1,'explicit context budget required');
  const decoded=decodeCausalLmV8Target(target),prompt=causalLmV8Prompt(context);
  const promptIds=await segment(tokenizer,prompt,eosTokenId),targetIds=await segment(tokenizer,target,eosTokenId);
  const inputIds=[...promptIds,...targetIds,eosTokenId];
  require(inputIds.length<=maxContextTokens,'flat context budget exceeded; truncation is forbidden');
  return {schema:CAUSAL_LM_V8_BRIDGE_VERSION,traceFormat:REGION_TRACE_VERSION,representation:'mixed',
    recordKind:decoded.kind,tokenizerIdentity:tokenizer.identity,
    encoding:'independent-context-and-target-segments/1',prompt,target,
    promptSha256:sha(prompt),targetSha256:sha(target),inputIds,
    labels:[...promptIds.map(()=>-100),...targetIds,eosTokenId],attentionMask:inputIds.map(()=>1),eosTokenId,
    boundaries:{promptTokens:promptIds.length,targetTokens:targetIds.length,terminalTokens:1},
    costs:{flatContextTokens:inputIds.length,publicContextTokens:promptIds.length,
      generatedTokens:targetIds.length,terminalTokens:1,maxContextTokens}};
}

/** Reconstruct every context from the public prefix, with no future receipt. */
export function validateRegionTrainingContexts(exported){
  const publicData=exported?.public,contexts=exported?.contexts;
  require(publicData?.schema==='semantic-execution/8'&&publicData.traceFormat===REGION_TRACE_VERSION&&
    publicData.contextFormat===REGION_CONTEXT_VERSION&&publicData.representation==='mixed'&&
    publicData.profile===REGION_PROFILE&&Array.isArray(publicData.timeline),'v8 execution artifact required');
  require(Array.isArray(contexts),'actual prediction contexts required');
  const harness=new RegionExecutionHarness({sessionId:publicData.timeline[0]?.fields?.session,
    automaticDelivery:false,now:()=>-Infinity}),items=[];
  for(const row of publicData.timeline){
    assertAlgorithmFields(row,['sequence','mode','kind','fields'],'v8 public row');
    require(row.sequence===harness.timeline.length+1,'noncontiguous public prefix');
    if(row.mode==='generated'){
      const context=contexts[items.length],actual=harness.modelContext(row.fields.invocationId);
      require(isDeepStrictEqual(context,actual),'context differs from already published state or cutoff');
      require(decodeCausalLmV8Target(row.fields.line).kind===row.kind,'generated record kind changed');
      items.push({row,context,targetOrdinal:items.length});
      harness.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    }else if(row.mode==='observed')harness.importObserved(row);
    else fail('unrecognized public authority');
    require(isDeepStrictEqual(harness.timeline.at(-1),row),'public row differs from checked replay');
  }
  require(items.length===contexts.length&&items.length>0,'one context per generated target required');
  RegionExecutionHarness.replay(publicData);
  return items;
}

export async function buildCausalLmV8Examples(exported,{tokenizer,eosTokenId,maxContextTokens,
    allowLocal=false,maxExamples=4096,expectedSplit='train',nativePolicy=null,nativeConsumer=null}={}){
  require(typeof allowLocal==='boolean','allowLocal must be explicit boolean');
  require(Number.isSafeInteger(maxExamples)&&maxExamples>0,'positive example cap required');
  require(['train','validation','test'].includes(expectedSplit),'invalid dataset split');
  const checked=await recheckRegionEvidence(exported,{nativePolicy,nativeConsumer,requireNative:!allowLocal});
  const {verifyRegionDatasetBinding}=await import('./family-registry-v8.js');
  const side=exported.sidecar,binding=verifyRegionDatasetBinding(exported,{expectedSplit});
  require(binding.valid,'immutable family/split binding failed: '+JSON.stringify(binding.errors));
  require(side.splitIdentity.split===expectedSplit&&side.split===expectedSplit,'dataset split cannot be relabeled');
  if(!allowLocal)require(nativePolicy?.tokenizerIdentity===tokenizer?.identity,
    'training tokenizer differs from admitted native policy');
  const items=validateRegionTrainingContexts(exported);
  require(items.length<=maxExamples,'example cap exceeded; partial episodes are forbidden');
  const rows=[];
  for(const {row,context,targetOrdinal} of items){
    const encoded=await encodeCausalLmV8Example(context,row.fields.line,{tokenizer,eosTokenId,maxContextTokens});
    rows.push({...encoded,metadata:{sourceFamily:side.sourceFamily,sourceId:side.splitIdentity.sourceId,
      sourceComponent:side.splitIdentity.componentId,splitPolicy:side.splitIdentity.policy,split:expectedSplit,
      targetOrdinal,sequence:row.sequence,invocationId:row.fields.invocationId,
      contextVisibleThrough:context.visibleThrough,publicDigest:side.publicDigest,contextDigest:side.contextDigest,
      sourceAdmission:checked.sourceValidated?'passed':'failed',nativeAdmission:checked.native.admitted===true,
      optimizerSteps:0,learningClaim:null}});
  }
  return rows;
}

/** The selector retains original emitted bytes. Semantic acceptance is separate
 * from syntax and is measured when selectInto commits through the live harness. */
export function createCausalLmV8Selector({runtime,tokenizer,checkpointIdentity,eosTokenId,
    maxContextTokens,maxNewTokens=1024}={}){
  tokenizerContract(tokenizer,eosTokenId);
  require(HASH.test(checkpointIdentity??''),'immutable model checkpoint identity required');
  require(runtime&&typeof runtime.initialize==='function'&&typeof runtime.generate==='function',
    'initialized generation runtime required');
  require(Number.isSafeInteger(maxNewTokens)&&maxNewTokens>0&&Number.isSafeInteger(maxContextTokens)&&
    maxContextTokens>maxNewTokens,'explicit generation and context budgets required');
  const emissions=[];let initialized=false;
  const select=async context=>{
    require(initialized,'runtime has not attested its checkpoint');
    const prompt=causalLmV8Prompt(context),inputIds=await segment(tokenizer,prompt,eosTokenId);
    require(inputIds.length+maxNewTokens<=maxContextTokens,'generation budget exceeded; truncation is forbidden');
    const promptSha256=sha(prompt),previous=emissions.findLast(row=>row.promptSha256===promptSha256&&row.status!=='accepted');
    const evidence={adapter:CAUSAL_LM_V8_BRIDGE_VERSION,checkpointIdentity,tokenizerIdentity:tokenizer.identity,
      prompt,promptSha256,promptBytes:bytes(prompt),promptTokens:inputIds.length,
      attempt:emissions.length,retryOf:previous?.attempt??null,status:'submitted',emittedTokenIds:null,
      generationMs:null,verificationMs:null,stopReason:null,payloadHex:null};
    emissions.push(evidence);const started=performance.now();let response;
    try{response=await runtime.generate({schema:CAUSAL_LM_V8_BRIDGE_VERSION,representation:'mixed',inputIds,
      maxNewTokens,eosTokenId,doSample:false});}
    catch(error){evidence.generationMs=performance.now()-started;evidence.status='runtime-failed';
      evidence.failure=String(error.message);throw error;}
    evidence.generationMs=performance.now()-started;const verifying=performance.now(),ids=response?.tokenIds;
    evidence.emittedTokenIds=structuredClone(ids??null);evidence.stopReason=response?.stopReason??null;
    const refuse=message=>{evidence.status='rejected';evidence.verificationMs=performance.now()-verifying;
      evidence.failure=message;const error=new Error('Causal LM v8: '+message);
      error.category='causal-lm-emission';error.evidence=structuredClone(evidence);throw error;};
    if(!Array.isArray(ids)||!ids.length||ids.length>maxNewTokens||ids.some(id=>!Number.isSafeInteger(id)||id<0))
      refuse('invalid original emitted token sequence');
    let payload;try{payload=Buffer.from(await tokenizer.decode(ids.at(-1)===eosTokenId?ids.slice(0,-1):ids));}
    catch{refuse('original emitted tokens could not be decoded');}
    evidence.payloadHex=payload.toString('hex');
    if(ids.at(-1)!==eosTokenId||ids.slice(0,-1).includes(eosTokenId)||response.stopReason!=='eos')
      refuse('record did not end at declared EOS');
    let record;try{record=utf8.decode(payload);decodeCausalLmV8Target(record);}
    catch{refuse('original bytes are not a canonical generated v8 record');}
    evidence.status='decoded';evidence.verificationMs=performance.now()-verifying;
    return {record,selection:{causalLmSelected:true,...structuredClone(evidence)}};
  };
  select.initialize=async request=>{
    require(request?.checkpointIdentity===checkpointIdentity,'requested checkpoint differs from frozen weights');
    const receipt=await runtime.initialize({...request,tokenizerIdentity:tokenizer.identity,representation:'mixed'});
    require(receipt?.checkpointIdentity===checkpointIdentity&&receipt?.tokenizerIdentity===tokenizer.identity&&
      receipt.seed===request.seed,'loaded checkpoint/tokenizer/seed attestation differs');
    initialized=true;return {schema:'semantic-inference-identity/8',checkpointIdentity,
      tokenizerIdentity:tokenizer.identity,seed:request.seed,adapter:CAUSAL_LM_V8_BRIDGE_VERSION,nativeAdmissionClaim:false};
  };
  select.selectInto=async(harness,invocationId)=>{
    const context=harness.modelContext(invocationId),candidate=await select(context),
      evidence=emissions[candidate.selection.attempt],started=performance.now();
    try{
      const decoded=decodeCausalLmV8Target(candidate.record),entry=decoded.kind==='region'?
        harness.entry(invocationId,decoded.record.region):decoded.kind==='algorithm'?
          pureRegionEntry(harness.program(invocationId),harness.activation(invocationId).controller,harness.timeline.length):null;
      // Entry hashes are host authority and never repaired/generated target text.
      const result=harness.select(invocationId,candidate.record,{entry});
      evidence.status='accepted';evidence.verificationMs+=performance.now()-started;
      return {result,record:candidate.record,selection:{causalLmSelected:true,...structuredClone(evidence)}};
    }catch(error){evidence.status='semantic-rejected';evidence.failure=String(error.message);
      evidence.verificationMs+=performance.now()-started;throw error;}
  };
  select.metrics=()=>({adapter:CAUSAL_LM_V8_BRIDGE_VERSION,emissions:structuredClone(emissions),
    promptTokens:sum(emissions.map(row=>row.promptTokens)),generatedTokens:sum(emissions.map(row=>row.emittedTokenIds?.length??0)),
    peakContextTokens:emissions.length?Math.max(...emissions.map(row=>row.promptTokens+(row.emittedTokenIds?.length??0))):0,
    predictionAttempts:emissions.length,retries:emissions.filter(row=>row.retryOf!==null).length,
    semanticallyAccepted:emissions.filter(row=>row.status==='accepted').length,
    decodedUnverified:emissions.filter(row=>row.status==='decoded').length,
    failedAttempts:emissions.filter(row=>!['accepted','decoded'].includes(row.status)).length,
    generationMs:sum(emissions.map(row=>row.generationMs??0)),verificationMs:sum(emissions.map(row=>row.verificationMs??0)),
    unknownGenerationCostAttempts:emissions.filter(row=>row.emittedTokenIds===null).length,
    contextAccounting:'submitted-flat-token-sequences',nativeAdmissionClaim:false});
  if(typeof runtime.close==='function')select.close=()=>runtime.close();
  return select;
}

export async function auditRegionServingCosts(exported,{tokenizer=null,eosTokenId=null,
    maxContextTokens=1048576,retainTokenIds=true}={}){
  const items=validateRegionTrainingContexts(exported),rows=[];
  for(const {row,context,targetOrdinal} of items){
    const target=row.fields.line,prompt=causalLmV8Prompt(context);
    const encoded=tokenizer?await encodeCausalLmV8Example(context,target,{tokenizer,eosTokenId,maxContextTokens}):null;
    rows.push({prediction:targetOrdinal,invocationId:context.invocationId,visibleThrough:context.visibleThrough,
      prompt,target,promptSha256:sha(prompt),targetSha256:sha(target),promptBytes:bytes(prompt),targetBytes:bytes(target),
      snapshotBytes:bytes(JSON.stringify(context)),detail:row.kind==='semantic',recordKind:row.kind,
      promptTokens:encoded?.boundaries.promptTokens??null,generatedTokens:encoded?.boundaries.targetTokens??null,
      terminalTokens:encoded?.boundaries.terminalTokens??null,totalTokens:encoded?.costs.flatContextTokens??null,
      ...(encoded&&retainTokenIds?{inputIds:encoded.inputIds,labels:encoded.labels}:{})});
  }
  const generatedBytes=sum(rows.map(row=>row.targetBytes)),detailedBytes=sum(rows.filter(row=>row.detail).map(row=>row.targetBytes)),
    generatedTokens=tokenizer?sum(rows.map(row=>row.generatedTokens)):null;
  return {schema:'semantic-flat-serving-costs/2',path:'actual-semantic-causal-lm/4',representation:'mixed',
    episodeDigest:hashAlgorithmData(exported.public),contextsDigest:hashAlgorithmData(exported.contexts),
    measurement:tokenizer?'passed':'untested',byteMeasurement:'passed',tokenizerIdentity:tokenizer?.identity??null,
    eosTokenId:tokenizer?eosTokenId:null,predictions:rows.length,
    tokenReason:tokenizer?null:'Exact pinned serving tokenizer and EOS were not supplied; bytes are not estimates',
    bytes:{generated:generatedBytes,detailed:detailedBytes,detailedShare:generatedBytes?detailedBytes/generatedBytes:0,
      peakContext:Math.max(0,...rows.map(row=>row.promptBytes)),cumulativeContext:sum(rows.map(row=>row.promptBytes)),
      cumulativePublicSnapshots:sum(rows.map(row=>row.snapshotBytes))},
    tokens:{generated:generatedTokens,terminal:tokenizer?rows.length:null,
      observedAndContext:tokenizer?sum(rows.map(row=>row.promptTokens)):null,
      peakContext:tokenizer?Math.max(0,...rows.map(row=>row.promptTokens)):null,
      cumulativeContext:tokenizer?sum(rows.map(row=>row.promptTokens)):null,total:tokenizer?sum(rows.map(row=>row.totalTokens)):null,
      detailedShare:tokenizer&&generatedTokens?sum(rows.filter(row=>row.detail).map(row=>row.generatedTokens))/generatedTokens:null},
    accounting:{wholePrompts:true,wholeTargets:true,physicalSequence:'prompt tokens + target tokens + one EOS',
      additive:'Only these independently encoded physical segments are additive. All definitions, input, live state and routing are included in each whole prompt.',
      contextReuse:'Full published definitions and state are repeated on every flat prediction; no native cache discount is assumed.'},
    model:{status:'untested',completedExecution:null,nextStepAccuracy:null,latencyMs:null,failures:null,retries:null,
      tokensPerSuccessfulExecution:null,reason:'Serializer accounting over source-checked teacher records, not a model run'},
    native:{status:'untested',reason:'Native framing and serving require an actual-run receipt'},rows};
}
