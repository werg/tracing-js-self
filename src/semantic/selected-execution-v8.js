// Live v8 inference reuses the established host/callback lifecycle. Only the
// selected public prefix crosses the model boundary; no teacher or oracle does.
import {isDeepStrictEqual} from 'node:util';
import {SelectedModelDriver} from '../training/model-driver.js';
import {createFixtureBroker} from '../training/fixture-broker.js';
import {hostOperation} from '../host/operations.js';
import {RegionExecutionHarness} from './region-harness.js';
import {commitCausalLmV8Selection,decodeCausalLmV8Target} from './causal-lm-v8.js';
import {hashAlgorithmData} from './program.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
const demand=(value,message)=>{if(!value)throw new TypeError('Selected v8: '+message);};
const positive=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;

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
export class RegionSelectedModelDriver extends SelectedModelDriver {
  constructor({select,harness=new RegionExecutionHarness(),maxSelections=4096,maxOutstanding=64,
      maxStaleRetries=8,origin='model',checkpointIdentity=null,tokenizerIdentity=null,signal=null}={}){
    demand(typeof select==='function'&&['model','engineering'].includes(origin),'selector and explicit origin required');
    if(origin==='model')demand(typeof select.commit==='function'&&HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??''),
      'model selections require pinned identities and native commit acknowledgments');
    const contexts=[],predictions=new Map(),attempts=[],acknowledged=new Map();
    let driver,queue=Promise.resolve(),releaseActive=null,fatal=null,staleRetries=0;
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
          generationMs:null,commitMs:null,failure:null};
        attempts.push(attempt);const start=performance.now();let output;
        try{output=await select({...current,attempt:attempt.attempt});}
        finally{attempt.generationMs=performance.now()-start;}
        const record=typeof output==='string'?output:output?.record,selection=output?.selection??null;
        attempt.record=typeof record==='string'?record:null;attempt.selection=copy(selection);
        if(origin==='model')demand(selection?.modelSelected===true&&selection.origin==='actual-model-selected',
          'model experiment requires original model selection provenance');
        demand(typeof record==='string','one original canonical v8 record required');
        if(origin==='model')demand(selection.checkpointIdentity===checkpointIdentity&&
          selection.tokenizerIdentity===tokenizerIdentity&&selection.prefixDigest===current.context.prefixDigest&&
          selection.contextDigest===hashAlgorithmData(current.context)&&typeof selection.payloadHex==='string'&&
          /^(?:[0-9a-f]{2})+$/.test(selection.payloadHex)&&
          Buffer.from(selection.payloadHex,'hex').equals(Buffer.from(record,'utf8')),
          'selected bytes, model identity or causal provenance differ from the frozen invocation');
        attempt.provenanceValidated=origin==='model';
        decodeCausalLmV8Target(record);attempt.status='decoded';
        return {record,selection};
      }catch(error){
        if(attempt){attempt.status='rejected';attempt.failure=String(error.message);
          if(error.evidence)attempt.evidence=copy(error.evidence);}
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
      if(error.category!=='causal-lm-stale-context'||staleRetries>=maxStaleRetries)return false;
      const attempt=attempts.at(-1);attempt.status='stale';attempt.failure=String(error.message);
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
  }
  runInvocation(invocationId,{signal=this.executionSignal??null}={}){
    return super.runInvocation(invocationId,{signal});
  }
  prefix(invocationId){
    return {session:this.bridge.inner.sessionId,public:this.bridge.exportEpisode(),
      contexts:copy(this.contexts),context:this.bridge.modelContext(invocationId)};
  }
  metrics(){
    const rows=this.attempts,knownTokens=row=>row.selection?.fragments?.length>0&&
      row.selection.fragments.every(fragment=>Array.isArray(fragment.tokenIds));
    return {predictionAttempts:rows.length,accepted:rows.filter(row=>row.status==='accepted').length,
      rejected:rows.filter(row=>!['accepted','submitted','decoded'].includes(row.status)).length,
      staleRetries:rows.filter(row=>row.status==='stale').length,
      generatedBytes:rows.reduce((sum,row)=>sum+(typeof row.record==='string'?Buffer.byteLength(row.record):0),0),
      generatedTokens:rows.filter(knownTokens).reduce((sum,row)=>sum+row.selection.fragments
        .reduce((total,fragment)=>total+fragment.tokenIds.length,0),0),
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
    maxGenerated=16384,maxStaleRetries=8,maxOutstanding=64,timeoutMs=15000}={}){
  demand(HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??'')&&
    Number.isSafeInteger(seed)&&seed>=0,'frozen checkpoint, tokenizer and seed required');
  demand(positive(maxPredictions,100000)&&positive(maxGenerated,1000000)&&positive(maxOutstanding,1024)&&
    positive(timeoutMs,300000)&&Number.isSafeInteger(maxStaleRetries)&&maxStaleRetries>=0&&maxStaleRetries<=1000,
    'explicit bounded execution limits required');
  demand(typeof select==='function'&&typeof select.initialize==='function','an attested selector is required');
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
    inferenceIdentity=await Promise.race([select.initialize({seed,checkpointIdentity,tokenizerIdentity}),aborted]);
    demand(inferenceIdentity?.checkpointIdentity===checkpointIdentity&&inferenceIdentity.tokenizerIdentity===tokenizerIdentity&&
      inferenceIdentity.seed===seed,'selector attestation differs from the frozen experiment');
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
