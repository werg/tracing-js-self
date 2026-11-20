// Live v8 inference reuses the established host/callback lifecycle. Only the
// selected public prefix crosses the model boundary; no teacher or oracle does.
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionDriver} from './execution-driver.js';
import {createFixtureBroker} from '../training/fixture-broker.js';
import {hostOperation} from '../host/operations.js';
import {RegionExecutionHarness} from './region-harness.js';
import {commitCausalLmV8Selection,decodeCausalLmV8Target} from './causal-lm-v8.js';
import {hashAlgorithmData} from './program.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
const demand=(value,message)=>{if(!value)throw new TypeError('Selected v8: '+message);};
const positive=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;
const isPayloadHex=value=>typeof value==='string'&&/^(?:[0-9a-f]{2})*$/.test(value);
const originalFragments=(payloadHex,selection)=>isPayloadHex(payloadHex)&&Array.isArray(selection?.fragments)&&
  selection.fragments.length>0&&selection.fragments.every(fragment=>Array.isArray(fragment?.tokenIds)&&fragment.tokenIds.length>0&&
    fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&isPayloadHex(fragment.payloadHex))&&
  Buffer.concat(selection.fragments.map(fragment=>Buffer.from(fragment.payloadHex,'hex')))
    .equals(Buffer.from(payloadHex,'hex'));
const boundPayload=(payloadHex,selection,context,checkpointIdentity,tokenizerIdentity)=>
  selection?.modelSelected===true&&selection.origin==='actual-model-selected'&&
  typeof selection.selectionId==='string'&&selection.selectionId.length>0&&
  selection.checkpointIdentity===checkpointIdentity&&selection.tokenizerIdentity===tokenizerIdentity&&
  selection.prefixDigest===context.prefixDigest&&selection.contextDigest===hashAlgorithmData(context)&&
  selection.payloadHex===payloadHex&&originalFragments(payloadHex,selection);
const boundSelection=(record,selection,context,checkpointIdentity,tokenizerIdentity)=>typeof record==='string'&&
  boundPayload(Buffer.from(record,'utf8').toString('hex'),selection,context,checkpointIdentity,tokenizerIdentity);
const attemptPayload=row=>typeof row.record==='string'?Buffer.from(row.record,'utf8').toString('hex'):
  isPayloadHex(row.rawPayloadHex)?row.rawPayloadHex:null;
const recoveryTickets=new WeakSet();

function verifyDriverCheckpoint(packet,policy){
  const fields=['schema','policy','bridge','contexts','attempts','staleRetries','native','digest'];
  demand(packet&&Object.keys(packet).length===fields.length&&fields.every(key=>Object.hasOwn(packet,key)),
    'invalid selected driver checkpoint fields');
  const {digest,...body}=packet;
  demand(packet.schema==='semantic-selected-driver-checkpoint/8'&&HASH.test(digest??'')&&
    digest===hashAlgorithmData(body),'selected driver checkpoint integrity differs');
  demand(policy&&isDeepStrictEqual(packet.policy,policy)&&HASH.test(policy.checkpointIdentity??'')&&
    HASH.test(policy.tokenizerIdentity??'')&&positive(policy.maxSelections,100000)&&
    positive(policy.maxOutstanding,1024)&&Number.isSafeInteger(policy.maxStaleRetries)&&
    policy.maxStaleRetries>=0&&policy.maxStaleRetries<=1000&&
    policy.nativeIdentity?.schema==='semantic-inference-identity/8'&&
    Number.isSafeInteger(policy.nativeIdentity.seed)&&policy.nativeIdentity.seed>=0&&
    policy.nativeIdentity.generationSettings&&typeof policy.nativeIdentity.generationSettings==='object'&&
    !Array.isArray(policy.nativeIdentity.generationSettings),
    'recovery requires the externally expected model identities and execution budgets');
  demand(Array.isArray(packet.contexts)&&Array.isArray(packet.attempts)&&
    packet.attempts.length<=policy.maxSelections&&Number.isSafeInteger(packet.staleRetries)&&
    packet.staleRetries===packet.attempts.filter(row=>row.status==='stale').length&&
    packet.staleRetries<=policy.maxStaleRetries,'retained prediction or stale-retry budget differs');
  const transport=packet.native,{digest:transportDigest,...transportBody}=transport??{};
  demand(transport?.schema==='semantic-native-transport-checkpoint/8'&&HASH.test(transportDigest??'')&&
    transportDigest===hashAlgorithmData(transportBody)&&
    transport.identity?.checkpointIdentity===policy.checkpointIdentity&&
    transport.identity?.tokenizerIdentity===policy.tokenizerIdentity&&
    isDeepStrictEqual(transport.identity,policy.nativeIdentity)&&
    Array.isArray(transport.attempts)&&transport.attempts.length===packet.attempts.length,
    'model transport checkpoint does not cover the driver identity and consumed attempts');
  const native=transport.native,{digest:nativeDigest,...nativeBody}=native??{};
  demand(native?.schema==='semantic-model-checkpoint/8'&&HASH.test(nativeDigest??'')&&
    nativeDigest===hashAlgorithmData(nativeBody)&&isDeepStrictEqual(native.initialization,transport.identity)&&
    Array.isArray(native.attempts)&&native.attempts.length===packet.attempts.length,
    'native checkpoint does not preserve the same acknowledged attempts');
  const publicData=packet.bridge?.public,session=publicData?.timeline?.[0]?.fields?.session;
  demand(typeof session==='string'&&native.sessions&&typeof native.sessions==='object'&&!Array.isArray(native.sessions)&&
    Object.keys(native.sessions).every(key=>key===session),
    'driver recovery requires a dedicated native transport for this session');
  const accepted=packet.attempts.filter(row=>row.status==='accepted');
  demand(accepted.length===packet.contexts.length,'acknowledged selections and causal contexts differ');
  for(const [index,attempt]of packet.attempts.entries()){
    const retained=transport.attempts[index],model=native.attempts[index];
    demand(attempt.attempt===index&&['accepted','stale'].includes(attempt.status)&&
      boundSelection(attempt.record,attempt.selection,attempt.context,policy.checkpointIdentity,policy.tokenizerIdentity)&&
      retained?.attempt===index&&retained.session===session&&retained.invocationId===attempt.invocationId&&
      retained.record===attempt.record&&isDeepStrictEqual(retained.selection,attempt.selection)&&
      retained.status===(attempt.status==='accepted'?'accepted':'rejected')&&
      model?.selectionId===attempt.selection.selectionId&&model.session===session&&
      model.invocationId===attempt.invocationId&&model.payloadHex===attempt.selection.payloadHex&&
      isDeepStrictEqual(model.fragments,attempt.selection.fragments)&&
      model.status===(attempt.status==='accepted'?'committed':'semantic-rejected'),
      'checkpoint contains unacknowledged, changed or omitted original selections');
  }
  const saved=native.sessions[session];
  if(!saved)demand(packet.attempts.length===0,'native checkpoint omitted its selected session');
  else{
    const prefix=saved.public?.timeline;
    demand(Array.isArray(prefix)&&saved.unacknowledgedSelection===null&&
      isDeepStrictEqual(saved.contexts,packet.contexts)&&
      isDeepStrictEqual({...saved.public,timeline:[]},{...publicData,timeline:[]})&&
      isDeepStrictEqual(prefix,publicData.timeline.slice(0,prefix.length))&&
      publicData.timeline.slice(prefix.length).every(row=>row.mode==='observed'),
      'native acknowledged history is not the same public prefix');
  }
  // Rebuild the causal boundaries from the public machine. Saved contexts or
  // locally rehashed state never substitute for the state before each record.
  const replay=new RegionExecutionHarness({sessionId:session,automaticDelivery:false,now:()=>-Infinity});
  let generated=0;
  for(const row of publicData.timeline){
    if(row.mode==='generated'){
      const attempt=accepted[generated],context=packet.contexts[generated];
      demand(attempt&&row.fields.invocationId===attempt.invocationId&&row.fields.line===attempt.record&&
        isDeepStrictEqual(context,attempt.context)&&
        isDeepStrictEqual(context,replay.modelContext(attempt.invocationId)),
        'checkpoint causal boundary or accepted record differs from public history');
      commitCausalLmV8Selection(replay,attempt.invocationId,attempt.record,{context});generated++;
    }else replay.importObserved(row);
    demand(isDeepStrictEqual(replay.timeline.at(-1),row),'checkpoint public history changed during replay');
  }
  demand(generated===accepted.length,'checkpoint omitted acknowledged generated records');
  return true;
}

function driverFacade(bridge,contexts,predictions){
  const host={
    publishProgram:options=>bridge.publishProgram(options),
    admitInvocation:options=>bridge.admitInvocation(options),
    prepareModelContext:invocationId=>bridge.modelContext(invocationId),
    selected(invocationId,line){
      const context=predictions.get(invocationId);
      demand(context,'selection has no captured public context');
      const result=commitCausalLmV8Selection(bridge,invocationId,line,{context});
      contexts.push(copy(context));predictions.delete(invocationId);return result;
    },
    dispatch:(...args)=>bridge.dispatch(...args),
    exportEpisode:()=>({public:bridge.exportEpisode(),contexts:copy(contexts)}),
    inspect:invocationId=>bridge.inner.inspect(invocationId),
    onRunnable:listener=>bridge.inner.onRunnable(invocationId=>{bridge.sync();listener(invocationId);})
  };
  for(const key of ['programs','invocations','intents','realms','sourceAvailability','closureQueue','now'])
    Object.defineProperty(host,key,{get:()=>bridge.inner[key]});
  for(const name of ['cancelInvocation','enqueueClosure','nextReadyInvocation','waitForActivity','wake',
    'restoreSource','recordModelContext'])host[name]=(...args)=>{
      const result=bridge.inner[name](...args);bridge.sync();return result;
    };
  return host;
}

/** No source-success claim is made here: the public machine checks values and
 * transitions; a separate private scorer checks correspondence after rollout. */
export class RegionSelectedModelDriver extends SelectedExecutionDriver {
  constructor({select,harness=new RegionExecutionHarness(),maxSelections=4096,maxOutstanding=64,
      maxStaleRetries=8,origin='model',checkpointIdentity=null,tokenizerIdentity=null,nativeIdentity=null,
      signal=null,recovery=null}={}){
    demand(typeof select==='function'&&['model','engineering'].includes(origin),'selector and explicit origin required');
    if(origin==='model')demand(typeof select.commit==='function'&&HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??''),
      'model selections require pinned identities and native commit acknowledgments');
    demand(recovery===null||recoveryTickets.has(recovery),'driver recovery must pass verified restoration');
    const contexts=copy(recovery?.contexts??[]),predictions=new Map(),attempts=copy(recovery?.attempts??[]),acknowledged=new Map();
    for(const attempt of attempts)if(attempt.status==='accepted')
      acknowledged.set(attempt.invocationId,{record:attempt.record,selection:copy(attempt.selection)});
    let driver,queue=Promise.resolve(),releaseActive=null,fatal=null,staleRetries=recovery?.staleRetries??0;
    const acquire=async()=>{
      const previous=queue;let release;queue=new Promise(resolve=>{release=resolve;});
      await previous;if(fatal){release();throw fatal;}return release;
    };
    const release=()=>{releaseActive?.();releaseActive=null;};
    const packet=invocationId=>({session:harness.inner.sessionId,public:harness.exportEpisode(),
      contexts:copy(contexts),invocationId});
    const selected=async previous=>{
      const unlock=await acquire();releaseActive=unlock;
      let attempt;
      try{
        demand(attempts.length<maxSelections,'global prediction budget exhausted');
        const invocationId=previous.context.invocationId,current=driver.prefix(invocationId);
        predictions.set(invocationId,copy(current.context));
        attempt={attempt:attempts.length,invocationId,context:copy(current.context),
          prefixDigest:current.context.prefixDigest,status:'submitted',record:null,selection:null,
          rawPayloadHex:null,completeRecord:false,generationMs:null,commitMs:null,failure:null};
        attempts.push(attempt);const start=performance.now();let output;
        try{output=await select({...current,attempt:attempt.attempt});}
        finally{attempt.generationMs=performance.now()-start;}
        const record=typeof output==='string'?output:output?.record,selection=output?.selection??null;
        attempt.record=typeof record==='string'?record:null;attempt.selection=copy(selection);
        if(attempt.record!==null)attempt.rawPayloadHex=Buffer.from(attempt.record,'utf8').toString('hex');
        if(origin==='model')demand(selection?.modelSelected===true&&selection.origin==='actual-model-selected',
          'model experiment requires original model selection provenance');
        demand(typeof record==='string','one original canonical v8 record required');
        if(origin==='model')demand(boundSelection(record,selection,current.context,checkpointIdentity,tokenizerIdentity),
          'selected bytes, model identity or causal provenance differ from the frozen invocation');
        attempt.provenanceValidated=origin==='model';
        decodeCausalLmV8Target(record);attempt.completeRecord=true;attempt.status='decoded';
        return {record,selection};
      }catch(error){
        if(attempt){attempt.status='rejected';attempt.failure=String(error.message);
          if(error.evidence){attempt.evidence=copy(error.evidence);
            // A transport can reject malformed output before returning it. Keep
            // those original bytes and token costs as failures, never repairs.
            if(attempt.record===null&&(typeof error.evidence.record==='string'||typeof error.evidence.rawPayloadHex==='string')){
              attempt.record=typeof error.evidence.record==='string'?error.evidence.record:null;
              attempt.selection=copy(error.evidence.selection??null);
              attempt.rawPayloadHex=typeof error.evidence.rawPayloadHex==='string'?error.evidence.rawPayloadHex:
                Buffer.from(attempt.record,'utf8').toString('hex');
              const bound=attempt.record!==null?boundSelection(attempt.record,attempt.selection,
                attempt.context,checkpointIdentity,tokenizerIdentity):
                boundPayload(attempt.rawPayloadHex,attempt.selection,attempt.context,checkpointIdentity,tokenizerIdentity)&&
                  attempt.selection.session===harness.inner.sessionId&&attempt.selection.invocationId===attempt.invocationId;
              attempt.provenanceValidated=origin==='model'&&error.evidence.schema==='semantic-native-selection-failure/1'&&
                error.evidence.provenanceValidated===true&&bound;
            }
          }}
        predictions.delete(previous.context.invocationId);fatal=error;release();throw error;
      }
    };
    const onCommitted=async({invocationId,record,selection})=>{
      const attempt=attempts.at(-1),start=performance.now();
      attempt.status='acknowledging';
      try{
        if(typeof select.commit==='function'){
          const receipt=await select.commit({...packet(invocationId),record,selection:copy(selection)});
          demand(receipt?.committed===true,'native model did not acknowledge the selected record');
          attempt.commitReceipt=copy(receipt);
        }else demand(origin==='engineering'&&!selection?.modelSelected,'model selection lacks a native acknowledgement');
        if(fatal)throw fatal;
        acknowledged.set(invocationId,{record,selection:copy(selection)});
        attempt.status='accepted';
      }catch(error){attempt.status='commit-failed';attempt.failure=String(error.message);fatal=error;throw error;}
      finally{attempt.commitMs=performance.now()-start;release();}
    };
    const onRejected=async({invocationId,selection,error})=>{
      const attempt=attempts.at(-1);
      // Only a refused preflight can retry. An acknowledgement failure occurs
      // after local commitment and must stop even if it names a stale context.
      if(error.category!=='causal-lm-stale-context'||attempt?.status!=='decoded'||!predictions.has(invocationId))return false;
      if(staleRetries>=maxStaleRetries){
        const exhausted=new RangeError('Selected v8: stale prediction retry budget exhausted');
        exhausted.category='causal-lm-stale-retry-budget';attempt.status='stale-limit';attempt.failure=exhausted.message;
        throw exhausted;
      }
      attempt.status='stale';attempt.failure=String(error.message);
      predictions.delete(invocationId);staleRetries++;
      try{
        if(selection?.modelSelected)demand(typeof select.reject==='function','native stale prediction requires rejection acknowledgement');
        await select.reject?.({session:harness.inner.sessionId,selectionId:selection?.selectionId,
          reason:error.message});
        return true;
      }finally{release();}
    };
    selected.complete=async previous=>{
      const invocationId=previous.context.invocationId,unlock=await acquire();
      try{return await select.complete?.({...packet(invocationId),
        completion:copy(harness.activation(invocationId).controller.completion)});}
      catch(error){fatal=error;throw error;}finally{unlock();}
    };
    selected.cancel=async previous=>{
      const invocationId=previous.context.invocationId,
        reason=driver.rejections.at(-1)?.error??'selected execution cancelled';
      fatal??=new Error(reason);
      const attempt=attempts.findLast(row=>row.invocationId===invocationId&&['decoded','acknowledging'].includes(row.status));
      if(attempt){attempt.status=attempt.status==='acknowledging'?'commit-failed':'semantic-rejected';attempt.failure=reason;}
      predictions.delete(invocationId);release();
      return select.cancel?.({...packet(invocationId),reason});
    };
    const decodeSelection=line=>{
      const decoded=decodeCausalLmV8Target(line);
      return decoded.kind==='semantic'?decoded.record:{kind:decoded.kind,fields:{}};
    };
    super({select:selected,harness:driverFacade(harness,contexts,predictions),maxSelections,maxOutstanding,
      decodeSelection,onCommitted,onRejected,prepareRequestDispatch:({invocationId,record,selection})=>{
        const checked=acknowledged.get(invocationId);
        demand(checked?.record===record&&isDeepStrictEqual(checked.selection,selection),
          'request cannot dispatch before its own selected record is acknowledged');
        return null; // The v8 acknowledgement already checked original native bytes.
      }});
    driver=this;this.bridge=harness;this.contexts=contexts;this.attempts=attempts;
    this.originalSelect=select;this.origin=origin;this.executionSignal=signal;
    const policy=Object.freeze({checkpointIdentity,tokenizerIdentity,nativeIdentity:copy(nativeIdentity),
      maxSelections,maxOutstanding,maxStaleRetries});
    this.checkpoint=async()=>{
      demand(origin==='model'&&typeof select.checkpoint==='function',
        'durable recovery requires a checkpoint-capable native model selector');
      const unlock=await acquire();
      try{
        // Acquiring the same lock as selection/acknowledgement ensures no
        // speculative local record can enter the saved public history. Native
        // observations may arrive while the model snapshot is collected; only
        // an observed suffix beyond its acknowledged prefix is permitted.
        demand(predictions.size===0,'cannot checkpoint an uncommitted prediction');
        const native=await select.checkpoint();
        const body={schema:'semantic-selected-driver-checkpoint/8',policy:copy(policy),
          bridge:harness.checkpoint(),contexts:copy(contexts),attempts:copy(attempts),staleRetries,native:copy(native)};
        const packet={...body,digest:hashAlgorithmData(body)};
        verifyDriverCheckpoint(packet,policy);return packet;
      }finally{unlock();}
    };
  }
  static async restore(packet,{select,policy,harnessOptions={},signal=null}={}){
    demand(typeof select==='function'&&typeof select.restore==='function'&&typeof select.checkpoint==='function',
      'fresh native model transport with checkpoint/restore is required');
    const saved=copy(packet);verifyDriverCheckpoint(saved,policy);
    // Restore host ownership before opening native model state. Neither step
    // dispatches a request or re-registers an existing callback. Unknown host
    // outcomes remain uncertain and require an explicit broker receipt.
    const harness=RegionExecutionHarness.restore(saved.bridge,harnessOptions);
    try{
      const receipt=await select.restore({checkpoint:saved.native});
      demand(receipt?.restored===true&&receipt.transportCheckpointDigest===saved.native.digest&&
        receipt.hostDispatches===0,'native restoration did not attest this checkpoint without host dispatch');
      const recovery={contexts:saved.contexts,attempts:saved.attempts,staleRetries:saved.staleRetries};
      recoveryTickets.add(recovery);
      const driver=new RegionSelectedModelDriver({select,harness,...saved.policy,origin:'model',signal,recovery});
      recoveryTickets.delete(recovery);return driver;
    }catch(error){select.close?.();throw error;}
  }
  runInvocation(invocationId,{signal=this.executionSignal??null}={}){
    return super.runInvocation(invocationId,{signal});
  }
  prefix(invocationId){
    return {session:this.bridge.inner.sessionId,public:this.bridge.exportEpisode(),
      contexts:copy(this.contexts),context:this.bridge.modelContext(invocationId)};
  }
  metrics(){
    const rows=this.attempts,knownTokens=row=>originalFragments(attemptPayload(row),row.selection)&&
      (this.origin==='engineering'||row.provenanceValidated),
      tokenCount=row=>row.selection.fragments.reduce((total,fragment)=>total+fragment.tokenIds.length,0);
    return {predictionAttempts:rows.length,accepted:rows.filter(row=>row.status==='accepted').length,
      rejected:rows.filter(row=>!['accepted','submitted','decoded'].includes(row.status)).length,
      staleRetries:rows.filter(row=>row.status==='stale').length,
      stalePredictions:rows.filter(row=>['stale','stale-limit'].includes(row.status)).length,
      generatedBytes:rows.reduce((sum,row)=>sum+(attemptPayload(row)?.length??0)/2,0),
      generatedTokens:rows.filter(knownTokens).reduce((sum,row)=>sum+tokenCount(row),0),
      unverifiedClaimedTokens:rows.filter(row=>originalFragments(attemptPayload(row),row.selection)&&!knownTokens(row))
        .reduce((sum,row)=>sum+tokenCount(row),0),
      unknownGenerationCostAttempts:rows.filter(row=>!knownTokens(row)).length,
      generationMs:rows.reduce((sum,row)=>sum+(row.generationMs??0),0),
      commitMs:rows.reduce((sum,row)=>sum+(row.commitMs??0),0),
      nativeAdmissionClaim:false,sourceAdmissionClaim:false};
  }
}

/** The initial prefix contains only host-published definitions and input.
 * Fixture replies and callbacks are supplied only when the selected request
 * reaches the ordinary broker; none are included in a model request. */
export async function runSelectedRegionExecution({initialPublic,fixture={calls:[]},select,
    checkpointIdentity,tokenizerIdentity,seed=17,origin='model',maxPredictions=4096,
    maxGenerated=16384,maxStaleRetries=8,maxOutstanding=64,timeoutMs=15000,generationSettings=null}={}){
  demand(HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??'')&&
    Number.isSafeInteger(seed)&&seed>=0,'frozen checkpoint, tokenizer and seed required');
  demand(positive(maxPredictions,100000)&&positive(maxGenerated,1000000)&&positive(maxOutstanding,1024)&&
    positive(timeoutMs,300000)&&Number.isSafeInteger(maxStaleRetries)&&maxStaleRetries>=0&&maxStaleRetries<=1000,
    'explicit bounded execution limits required');
  demand(typeof select==='function'&&typeof select.initialize==='function','an attested selector is required');
  demand(origin!=='model'||generationSettings&&typeof generationSettings==='object'&&!Array.isArray(generationSettings),
    'model execution requires frozen generation settings');
  const requestedSettings=copy(generationSettings);
  demand(initialPublic?.schema==='semantic-execution/8'&&initialPublic.timeline?.length>=2&&
    initialPublic.timeline.every(row=>row.mode==='observed'&&['program','invocation'].includes(row.kind)),
    'initial prefix may contain only published source and invocation input');
  demand(initialPublic.timeline.filter(row=>row.kind==='invocation').length===1,'one initial invocation is supported');
  const harness=RegionExecutionHarness.replay(copy(initialPublic),{requireTerminal:false}),
    broker=createFixtureBroker(copy(fixture)),contextsBefore=select.metrics?.()??null;
  harness.inner.automaticDelivery=true;harness.inner.maxGenerated=maxGenerated;
  harness.inner.maxOutstanding=maxOutstanding;
  for(const activation of harness.invocations.values())activation.controller.maxGenerated=maxGenerated;
  let calls=0;
  for(const operation of [...new Set(fixture.calls.map(call=>call.operation))])harness.inner.services[operation]=(args,meta)=>{
    calls++;const spec=hostOperation(operation),result=broker.invoke(operation,args.map((arg,index)=>
      spec.callbackIndices.includes(index)?meta.callback(index):arg));
    if(['demo.unlisten','dom.off','dom.stopTimer'].includes(operation))return Promise.resolve(result)
      .then(value=>{meta.closeSubscription(args[0]);return value;});
    return result;
  };
  const abort=new AbortController(),driver=new RegionSelectedModelDriver({select,harness,
    maxSelections:maxPredictions,maxStaleRetries,maxOutstanding,origin,checkpointIdentity,tokenizerIdentity,signal:abort.signal}),
    invocationId=initialPublic.timeline.find(row=>row.kind==='invocation').fields.invocationId,
    started=performance.now();
  let inferenceIdentity=null,failure=null,cleanupFailure=null,outcome=null,deadlineExceeded=false;
  let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
  const onAbort=()=>rejectAbort(abort.signal.reason);abort.signal.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>{deadlineExceeded=true;abort.abort(new Error('Selected v8 execution deadline exceeded'));},timeoutMs);
  try{
    inferenceIdentity=copy(await Promise.race([select.initialize({seed,checkpointIdentity,tokenizerIdentity}),aborted]));
    demand(inferenceIdentity?.checkpointIdentity===checkpointIdentity&&inferenceIdentity.tokenizerIdentity===tokenizerIdentity&&
      inferenceIdentity.seed===seed,'selector attestation differs from the frozen experiment');
    if(origin==='model')demand(isDeepStrictEqual(inferenceIdentity.generationSettings,requestedSettings),
      'loaded generation settings differ from the frozen experiment');
    outcome=await driver.runInvocation(invocationId,{signal:abort.signal});
    if(outcome.taskCompletion)outcome=await outcome.taskCompletion;
    await Promise.all([...driver.running.values()].map(row=>row.task));
    broker.finish();
  }catch(error){failure={category:error.category??error.name,message:String(error.message),evidence:copy(error.evidence??null)};}
  finally{
    if(driver.running.size&&!abort.signal.aborted)abort.abort(new Error('Selected v8 execution closed'));
    clearTimeout(timer);abort.signal.removeEventListener('abort',onAbort);driver.close();broker.abort();
    await Promise.allSettled([...driver.running.values()].map(row=>row.task));
    let cleanupTimer;
    try{await Promise.race([select.cancel?.({session:harness.inner.sessionId,public:harness.exportEpisode(),
      contexts:copy(driver.contexts),invocationId,reason:failure?'failed':'completed'}),new Promise((_,reject)=>{
        cleanupTimer=setTimeout(()=>reject(new Error('Selected v8 cleanup deadline exceeded')),Math.min(timeoutMs,1000));
      })]);}
    catch(error){cleanupFailure={category:error.category??error.name,message:String(error.message)};
      failure??=cleanupFailure;}
    finally{clearTimeout(cleanupTimer);}
  }
  const publicData=harness.exportEpisode(),controllers=[...harness.invocations.values()],
    publicCompleted=!failure&&controllers.every(row=>row.status==='completed'),
    firstViolation=controllers.map(row=>row.controller.firstWitnessViolation).find(Boolean)??null;
  if(publicCompleted)RegionExecutionHarness.replay(publicData);
  const result={schema:'semantic-selected-execution-result/8',origin,checkpointIdentity,tokenizerIdentity,seed,
    generationSettings:requestedSettings,
    inferenceIdentity,status:failure?(failure.message.includes('budget')||deadlineExceeded?'resource_limited':'failed'):
      publicCompleted?'completed':'incomplete',publicAccepted:!firstViolation&&!failure,publicCompleted,
    sourceValidated:false,sourceStatus:'unmeasured',completedExecution:false,
    public:publicData,contexts:copy(driver.contexts),attempts:copy(driver.attempts),
    completion:copy(harness.activation(invocationId).controller.completion??null),
    effects:copy(broker.receipts),failure,cleanupFailure,rejections:copy(driver.rejections),firstViolation:copy(firstViolation),
    costs:{...driver.metrics(),elapsedMs:performance.now()-started,hostDispatches:calls},
    nativeMetricsBefore:contextsBefore,nativeMetricsAfter:select.metrics?.()??null,
    optimizerSteps:0,qualification:{modelMeasurement:origin==='engineering'?'engineering-only':
      driver.attempts.some(row=>row.provenanceValidated)?'actual-model-selected':'unmeasured',
      sourceCorrespondence:'not-checked-by-public-replay',defaultPromotion:false}};
  return {...result,digest:hashAlgorithmData(result)};
}
