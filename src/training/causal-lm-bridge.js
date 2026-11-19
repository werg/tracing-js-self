// Experimental conventional causal-LM bridge over certified production V6 bytes.
// The selector sees only the production driver's public prefix. Independent
// expectations and source admission receipts remain outside its request.
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {SelectedExecutionHarness} from './harness-v4.js';
import {SelectedModelDriver} from './model-driver.js';
import {recheckEffectfulAdmission} from './effectful-admit.js';
import {decodeWitness,validateHarnessRecord,WITNESS_VERSION} from './format.js';
import {syntaxOnlyV6Grammar} from './trace-gbnf.js';
export {syntaxOnlyV6Grammar} from './trace-gbnf.js';

export const CAUSAL_LM_BRIDGE_VERSION='semantic-causal-lm/1';
const PREFIX_FIELDS=['schema','programId','entry','source','sourceDigest','invocationId','trackId',
  'realmId','committed','realmCommitted','completionPolicy','maxOutstanding','taskRevision',
  'parentInvocationId','receiver','closureId','activation','selectedState'];
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const sha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const require=(value,message)=>{if(!value)throw new TypeError('Causal LM bridge: '+message);};
const utf8=new TextDecoder('utf-8',{fatal:true});

export function causalLmPrompt(prefix){
  require(prefix?.schema==='selected-inference-prefix/2','requires the live selected inference prefix');
  require(Object.keys(prefix).length===PREFIX_FIELDS.length&&
    PREFIX_FIELDS.every(key=>Object.hasOwn(prefix,key)),'unexpected or missing public-prefix fields');
  for(const key of ['committed','realmCommitted']){
    require(Array.isArray(prefix[key])&&prefix[key].length>0,'complete prior public records required');
    let sequence=0;
    for(const record of prefix[key]){
      validateHarnessRecord(record);
      require(record.sequence>sequence,'public records must be in their original causal order');
      sequence=record.sequence;
    }
  }
  const program=prefix.committed.find(row=>row.kind==='program'&&row.programId===prefix.programId);
  require(program?.source===prefix.source&&program?.digest===prefix.sourceDigest,
    'source context differs from its committed program');
  const publicPrefix=Object.fromEntries(PREFIX_FIELDS.map(key=>[key,structuredClone(prefix[key])]));
  return 'Predict one complete semantic-trace/6 record from this public execution context.\n'+
    JSON.stringify(publicPrefix)+'\nNext record:\n';
}

function codecContract(tokenizer,eosTokenId){
  require(tokenizer&&sha(tokenizer.identity)&&typeof tokenizer.encode==='function'&&
    typeof tokenizer.decode==='function','a frozen lossless tokenizer is required');
  require(Number.isSafeInteger(eosTokenId)&&eosTokenId>=0,'an explicit end-of-record token ID is required');
}
function encode(tokenizer,text,eosTokenId){
  const ids=tokenizer.encode(text);
  require(Array.isArray(ids)&&ids.length>0&&ids.every(id=>Number.isSafeInteger(id)&&id>=0),
    'tokenizer must return nonempty exact integer IDs');
  const decoded=Buffer.from(tokenizer.decode(ids));
  require(decoded.equals(Buffer.from(text,'utf8')),'tokenizer does not reproduce original UTF-8 bytes');
  require(!ids.includes(eosTokenId),'ordinary public text cannot inject the record terminator');
  return ids;
}

export function encodeCausalLmExample(prefix,target,{tokenizer,eosTokenId,maxContextTokens}={}){
  codecContract(tokenizer,eosTokenId);
  require(Number.isSafeInteger(maxContextTokens)&&maxContextTokens>1,'an explicit flat context budget is required');
  const {kind}=decodeWitness(target);
  require(!['code','input','observe','value-open','value-part','value-close'].includes(kind),
    'only complete generated semantic records are supervised');
  const prompt=causalLmPrompt(prefix),promptIds=encode(tokenizer,prompt,eosTokenId),
    targetIds=encode(tokenizer,target,eosTokenId);
  // These two explicit segments are the encoding contract. Serving uses the
  // identical prompt IDs; no full-string BPE retokenization may shift the cut.
  const inputIds=[...promptIds,...targetIds,eosTokenId];
  require(inputIds.length<=maxContextTokens,'flat context budget exceeded; truncation is forbidden');
  return {schema:CAUSAL_LM_BRIDGE_VERSION,traceFormat:WITNESS_VERSION,
    tokenizerIdentity:tokenizer.identity,encoding:'independent-prefix-and-target-segments',
    prompt,target,promptSha256:hash(prompt),targetSha256:hash(target),
    inputIds,labels:[...promptIds.map(()=>-100),...targetIds,eosTokenId],
    attentionMask:inputIds.map(()=>1),eosTokenId,
    boundaries:{promptTokens:promptIds.length,targetTokens:targetIds.length,terminalTokens:1},
    costs:{flatContextTokens:inputIds.length,observedAndPriorTokens:promptIds.length,
      generatedTokens:targetIds.length,terminalTokens:1,maxContextTokens}};
}

export async function buildCausalLmExamples(exported,options={}){
  require(exported?.public?.traceFormat===WITNESS_VERSION,'frozen V6 training data required');
  require(exported?.sidecar?.split==='train','training bridge never moves evaluation or quarantine rows');
  const receipt=await recheckEffectfulAdmission(exported,{requireAdmitted:false});
  const side=exported.sidecar;
  require(typeof side.splitIdentity?.componentId==='string','frozen component identity required');
  const maximum=options.maxExamples??4096;
  require(Number.isSafeInteger(maximum)&&maximum>0,'positive example cap required');
  const result=[];
  for(const [index,item] of exported.public.timeline.entries()){
    if(item.kind!=='semantic')continue;
    require(result.length<maximum,'example cap exceeded; partial episodes are not silently exported');
    // Replaying this exact cutoff uses no host services, teacher journal or
    // future results, and reconstructs the same state as the serving driver.
    const harness=SelectedExecutionHarness.replay({public:{...exported.public,
      timeline:exported.public.timeline.slice(0,index)}},{requireTerminal:false});
    harness.prepareModelContext(item.invocationId);
    const driver=new SelectedModelDriver({harness,select:()=>{throw new Error('Preparation cannot select');}});
    try{
      const prefix=driver.prefix(item.invocationId);
      result.push({...encodeCausalLmExample(prefix,item.line,options),
        metadata:{identityDigest:side.identityDigest,sourceFamily:side.sourceFamily,
          sourceComponent:side.splitIdentity.componentId,splitPolicy:side.splitIdentity.policy,
          split:side.split,sequence:item.sequence,invocationId:item.invocationId,
          sourceAdmission:receipt,nativeAdmissionClaim:false}});
    }finally{driver.close();}
  }
  require(result.length>0,'certified episode has no generated records');
  return result;
}

export function createCausalLmSelector({runtime,tokenizer,checkpointIdentity,eosTokenId,
    maxContextTokens,maxNewTokens=512,arm='unconstrained'}={}){
  codecContract(tokenizer,eosTokenId);
  require(sha(checkpointIdentity),'immutable checkpoint identity required');
  require(runtime&&typeof runtime.initialize==='function'&&typeof runtime.generate==='function',
    'actual initialized generation runtime required');
  require(['unconstrained','syntax-only'].includes(arm),'unknown decoding arm');
  require(Number.isSafeInteger(maxNewTokens)&&maxNewTokens>0&&Number.isSafeInteger(maxContextTokens)&&
    maxContextTokens>maxNewTokens,'explicit generation and context budgets required');
  let initialized=false;
  const emissions=[];
  const grammar=arm==='syntax-only'?syntaxOnlyV6Grammar():null;
  const grammarDigest=grammar===null?null:hash(grammar);
  const select=async prefix=>{
    require(initialized,'runtime has not attested its loaded checkpoint');
    const prompt=causalLmPrompt(prefix),inputIds=encode(tokenizer,prompt,eosTokenId);
    require(inputIds.length+maxNewTokens<=maxContextTokens,
      'generation exceeds flat context budget; truncation is forbidden');
    const response=await runtime.generate({schema:CAUSAL_LM_BRIDGE_VERSION,
      inputIds,maxNewTokens,eosTokenId,doSample:false,arm,
      ...(grammar===null?{}:{grammar,grammarFormat:'gbnf',grammarDigest})});
    const ids=response?.tokenIds;
    const evidence={adapter:CAUSAL_LM_BRIDGE_VERSION,arm,checkpointIdentity,
      tokenizerIdentity:tokenizer.identity,promptSha256:hash(prompt),emittedTokenIds:structuredClone(ids??null),
      grammarDigest,stopReason:response?.stopReason??null,payloadHex:null};
    emissions.push(evidence);
    const refuse=message=>{const error=new Error('Causal LM bridge: '+message);
      error.category='causal-lm-emission';error.evidence=structuredClone(evidence);throw error;};
    if(!Array.isArray(ids)||!ids.length||ids.length>maxNewTokens||
      ids.some(id=>!Number.isSafeInteger(id)||id<0))refuse('invalid original emitted token sequence');
    let payload;
    try{payload=Buffer.from(tokenizer.decode(ids.at(-1)===eosTokenId?ids.slice(0,-1):ids));}
    catch{refuse('original emitted tokens could not be decoded');}
    evidence.payloadHex=payload.toString('hex');
    if(ids.at(-1)!==eosTokenId||ids.slice(0,-1).includes(eosTokenId)||response.stopReason!=='eos')
      refuse('record did not end at its declared generated terminator');
    if(arm==='syntax-only'&&response.appliedGrammarDigest!==grammarDigest)
      refuse('runtime did not attest the requested syntax-only constraint');
    let record;
    try{record=utf8.decode(payload);}catch{refuse('original record is invalid UTF-8');}
    // No trim, JSON rewrite, missing-field completion, teacher retry or repair.
    // SelectedModelDriver validates these original bytes and all effects.
    return {record,selection:{causalLmSelected:true,...structuredClone(evidence)}};
  };
  select.representation='compact';
  select.initialize=async request=>{
    require(request?.checkpointIdentity===checkpointIdentity,'requested checkpoint differs from frozen weights');
    const receipt=await runtime.initialize({...request,tokenizerIdentity:tokenizer.identity,arm});
    require(receipt?.checkpointIdentity===checkpointIdentity&&receipt?.tokenizerIdentity===tokenizer.identity&&
      receipt.seed===request.seed,'loaded checkpoint/tokenizer/seed attestation differs');
    initialized=true;
    return {schema:'semantic-inference-identity/4',checkpointIdentity,
      tokenizerIdentity:tokenizer.identity,seed:request.seed,adapter:CAUSAL_LM_BRIDGE_VERSION,
      arm,nativeAdmissionClaim:false};
  };
  select.metrics=()=>({adapter:CAUSAL_LM_BRIDGE_VERSION,arm,emissions:structuredClone(emissions),
    generatedTokens:emissions.reduce((total,row)=>total+(row.emittedTokenIds?.length??0),0),
    contextAccounting:'flat-token-sequences',nativeAdmissionClaim:false});
  if(typeof runtime.close==='function')select.close=()=>runtime.close();
  return select;
}
