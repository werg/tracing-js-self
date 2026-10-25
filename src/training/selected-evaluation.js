// Evaluation uses the production selected driver and external broker. Expected
// outcomes stay in the frozen cohort, outside this runner and every model prefix.
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SelectedExecutionHarness} from './harness-v4.js';
import {SelectedModelDriver} from './model-driver.js';
import {createFixtureBroker} from './fixture-broker.js';
import {decodeWitness} from './format.js';
import {hostOperation} from '../host/operations.js';
import {evaluateOrchestrationCase} from './orchestration-evaluation.js';
import {traceGraph} from './evaluation-graph.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>structuredClone(value);
const memoryUsage=select=>process.resourceUsage().maxRSS*1024+(select?.metrics?.().peakMemoryBytes??0);
const costScope={computeSeconds:'case-wall-time-excluding-model-initialization',
  peakMemoryBytes:'sum-of-runner-and-native-process-lifetime-peak-rss-upper-bound'};
const cleanup=h=>({pendingEffects:[...h.intents.values()].filter(i=>i.status!=='settled').length,
  pendingJobs:[...h.invocations.values()].reduce((n,a)=>n+[...a.controller.jobs.values()]
    .filter(j=>j.status!=='completed').length,0),
  openHandlers:[...h.handlers.values()].filter(h=>h.state!=='closed').length});

/** Construct a reviewable controlled fixture. Selection bytes are explicitly
 * test inputs; model mode refuses to consume them. The expectation is computed
 * from the independently captured source outcome and effects, never a rollout. */
export function controlledEvaluationCase(exported,{id,family,split}={}){
  if(exported?.sidecar?.referenceStatus!=='agreed')throw new TypeError('Independent reference required');
  const program=exported.public.timeline.find(item=>item.kind==='program');
  const invocation=exported.public.timeline.find(item=>item.kind==='invocation');
  const selections={};
  for(const item of exported.public.timeline)if(item.kind==='semantic')
    (selections[item.invocationId]??=[]).push(item.line);
  const request={schema:'selected-evaluation-case/4',
    program:{programId:program.programId,source:program.source,entry:program.entry,
      capabilities:program.capabilities},
    invocation:{programId:invocation.programId,invocationId:invocation.invocationId,
      trackId:invocation.track,realmId:invocation.realmId,triggerId:invocation.triggerId,
      inputGraph:invocation.inputGraph,realmPolicy:invocation.realmPolicy,
      completionPolicy:invocation.completionPolicy,receiverValue:invocation.receiver},
    fixture:copy(exported.sidecar.referenceInput.fixture),
    controlledSelectionsByRepresentation:{[exported.sidecar.representation??'explicit']:selections}};
  const references=exported.sidecar.reference.outcomes??[exported.sidecar.reference.outcome];
  const session=Boolean(exported.sidecar.reference.outcomes);
  if(session){
    request.programs=exported.public.timeline.filter(item=>item.kind==='program').map(item=>({
      programId:item.programId,source:item.source,entry:item.entry,capabilities:item.capabilities}));
    request.invocations=exported.public.timeline.filter(item=>item.kind==='invocation'&&
      item.parentInvocationId===null).map(item=>({
      programId:item.programId,invocationId:item.invocationId,trackId:item.track,realmId:item.realmId,
      triggerId:item.triggerId,inputGraph:item.inputGraph,realmPolicy:item.realmPolicy,
      completionPolicy:item.completionPolicy,receiverValue:item.receiver}));
    delete request.program;delete request.invocation;
  }
  const completions=references.map(reference=>({kind:reference.kind,value:reference.graph.roots.at(-1)}));
  const expected={completion:session?{kind:'session',value:completions}:completions[0],
    state:session?references.map(reference=>traceGraph(reference.graph)):traceGraph(references[0].graph),
    effects:copy(exported.sidecar.effects),
    callbacks:copy(exported.sidecar.effects.filter(item=>item.kind==='callback')),
    cleanup:{pendingEffects:0,pendingJobs:0,openHandlers:0}};
  if(!session&&!request.fixture.calls.length&&!program.capabilities.length)
    request.controlledOutcome={schema:'semantic-outcome/4',completion:copy(expected.completion),state:copy(expected.state)};
  return {id:id??exported.sidecar.taskId,family:family??exported.sidecar.sourceFamily,
    split:split??exported.sidecar.split,request,expected,referenceReceipt:{status:'agreed',
      requestDigest:hash(request),outcomeDigest:hash(expected)}};
}

export async function evaluateSelectedCase(envelope,{origin='controlled',select=null,
    checkpointIdentity=null,timeoutMs=15000,cleanupTimeoutMs=1000}={}){
  if(envelope?.request?.schema==='selected-orchestration-evaluation-case/4')
    return evaluateOrchestrationCase(envelope,{origin,select,checkpointIdentity,timeoutMs,cleanupTimeoutMs});
  if(envelope?.schema!=='semantic-evaluation-request/4'||
    envelope.request?.schema!=='selected-evaluation-case/4'||
    ![17,29,43].includes(envelope.seed)||!['explicit','compact','outcome-only'].includes(envelope.representation))
    throw new TypeError('Invalid frozen evaluation request');
  if(!['controlled','fixed-weights','trained'].includes(origin))throw new TypeError('Invalid execution authority');
  if(origin!=='controlled'&&(typeof select!=='function'||!/^[0-9a-f]{64}$/.test(checkpointIdentity??'')))
    throw new TypeError('Model evaluation needs actual selector and immutable checkpoint identity');
  let inferenceIdentity=null;
  if(origin!=='controlled'){
    if(select.representation!==undefined&&select.representation!==envelope.representation)
      throw new TypeError('Inference representation differs from the frozen experiment');
    if(typeof select.initialize!=='function')throw new TypeError('Model evaluator needs checkpoint/seed attestation');
    inferenceIdentity=await select.initialize({seed:envelope.seed,checkpointIdentity});
    if(inferenceIdentity?.checkpointIdentity!==checkpointIdentity||inferenceIdentity.seed!==envelope.seed||
      envelope.checkpointIdentity&&envelope.checkpointIdentity!==checkpointIdentity)
      throw new Error('Actual model identity or seed differs from frozen evaluation');
  }
  const {program,invocation,programs:programList,invocations:invocationList,fixture,
    controlledSelectionsByRepresentation}=copy(envelope.request);
  const programs=programList??[program],invocations=invocationList??[invocation];
  const capabilities=new Set(programs.flatMap(p=>p.capabilities));
  if(envelope.representation==='outcome-only'){
    if(programs.length!==1||invocations.length!==1||capabilities.size||fixture.calls.length)
      throw new TypeError('Outcome-only evaluation requires one pure common-support invocation');
    const started=performance.now(),harness=new SelectedExecutionHarness({sessionId:'outcomeevaluation'});
    harness.publishProgram(programs[0]);harness.admitInvocation(invocations[0]);
    const driver=new SelectedModelDriver({harness,select:select??(()=>{throw new Error('No semantic stepping in outcome-only control');})});
    const servedPrefix=driver.prefix(invocations[0].invocationId);
    let predicted,selection=null,record=null,failure=null;
    try{
      if(origin==='controlled'){
        predicted=copy(envelope.request.controlledOutcome);
        if(predicted?.schema!=='semantic-outcome/4')throw new TypeError('Explicit controlled outcome fixture required');
        record=JSON.stringify(predicted);
      }else{
        if(typeof select.outcome!=='function')throw new TypeError('Actual model outcome adapter required');
        const output=await select.outcome(servedPrefix);
        predicted=output.outcome;selection=output.selection;record=output.record;
      }
    }catch(error){failure={category:error.category??error.name,message:String(error.message??error),
      evidence:copy(error.evidence??null)};}
    finally{driver.close();}
    return {schema:'semantic-evaluation-result/4',origin,representation:'outcome-only',checkpointIdentity,
      inferenceIdentity,episode:null,record,selection,servedPrefix,failure,firstSemanticInconsistency:null,
      nativeRuntimeMetrics:select?.metrics?.()??null,costScope,
      outcome:{completion:predicted?.completion??{kind:'failure',failure},state:predicted?.state??null,
        effects:[],callbacks:[],cleanup:{pendingEffects:0,pendingJobs:0,openHandlers:0}},
      hardGates:{futureObservationLeaks:0,unauthorizedEffects:0,untrackedNativeFallback:0,
        falseAdmissions:0,replayNativeEffects:0},optimizerSteps:0,
      costs:{computeSeconds:(performance.now()-started)/1000,peakMemoryBytes:memoryUsage(select),
        dispatches:0,queueDepth:0,leakedResources:0}};
  }
  const broker=createFixtureBroker(fixture),services={};
  let nativeCalls=0,unauthorized=0,queueDepth=0,futureLeaks=0;
  for(const operation of [...new Set(fixture.calls.map(call=>call.operation))])
    services[operation]=(args,meta)=>{nativeCalls++;
      const spec=hostOperation(operation);
      const result=broker.invoke(operation,args.map((arg,index)=>spec.callbackIndices.includes(index)?
        meta.callback(index):arg));
      if(['demo.unlisten','dom.off','dom.stopTimer'].includes(operation))
        return Promise.resolve(result).then(value=>{meta.closeSubscription(args[0]);return value;});
      return result;};
  const harness=new SelectedExecutionHarness({sessionId:'evaluation',services});
  const counters=new Map();
  if(origin==='controlled'){
    const controlledSelections=controlledSelectionsByRepresentation?.[envelope.representation];
    if(!controlledSelections||select!==null)throw new TypeError('Controlled actions must be explicit fixture inputs');
    select=async prefix=>{
      const next=counters.get(prefix.invocationId)??0;
      const line=controlledSelections[prefix.invocationId]?.[next];
      if(typeof line!=='string')throw new Error('Controlled selection fixture exhausted');
      const {kind,fields}=decodeWitness(line),c=harness.invocations.get(prefix.invocationId).controller;
      const required=[...c.effects.values()].some(effect=>effect.status==='requested')||
        [...c.continuations.values()].some(continuation=>continuation.state!=='resumed')||
        [...c.jobs.values()].some(job=>job.status!=='completed');
      if(kind==='resume'&&!c.ready.includes(fields.continuation)||
        kind==='job'&&fields.action==='dispatch'&&!c.ready.includes(fields.job)||kind==='end'&&required)
        return {wait:true};
      counters.set(prefix.invocationId,next+1);return line;
    };
  }
  const actualSelect=select;
  const selections=[];
  const auditedSelect=async prefix=>{
    const visibleAt=harness.globalSequence;
    futureLeaks+=prefix.committed.filter(record=>record.sequence>visibleAt).length;
    queueDepth=Math.max(queueDepth,harness.closureQueue.length,
      ...[...harness.invocations.values()].map(a=>a.controller.ready.length));
    const decision=await actualSelect(prefix);
    if(decision?.selection&&typeof decision.record==='string')
      selections.push({invocationId:prefix.invocationId,record:decision.record,selection:copy(decision.selection)});
    return decision;
  };
  for(const method of ['commitRequest','complete','cancel'])if(typeof actualSelect[method]==='function')
    auditedSelect[method]=actualSelect[method].bind(actualSelect);
  const driver=new SelectedModelDriver({harness,select:auditedSelect});
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(new Error('Evaluation deadline exceeded')),timeoutMs);
  const started=performance.now();let result,failure=null;const completed=[];
  try{
    for(const invocation of invocations){
      const source=programs.find(p=>p.programId===invocation.programId);
      if(!source)throw new TypeError('Invocation has no frozen source');
      result=await driver.run({...source,...invocation,signal:abort.signal});
      if(result.taskCompletion)result=await result.taskCompletion;
      completed.push(result);
    }
    await Promise.all([...driver.running.values()].map(run=>run.task));
    broker.finish();
  }catch(error){failure={category:error.category??error.name,message:String(error.message??error),
    evidence:copy(error.evidence??null)};}
  finally{clearTimeout(timer);driver.close();}
  const episode=harness.exportEpisode({sourceLineage:'evaluation:'+envelope.caseId});
  episode.sidecar.selectionOrigin=origin==='controlled'?'controlled-test-injected':'actual-model-selected';
  episode.sidecar.evidenceKind=origin==='trained'?'model-evaluation':'deterministic-engineering';
  let replayNativeEffects=0;
  const beforeReplay=nativeCalls;
  if(!failure)SelectedExecutionHarness.replay(episode);
  replayNativeEffects=nativeCalls-beforeReplay;
  const dispatches=harness.timeline.filter(item=>item.kind==='dispatch');
  unauthorized+=Math.abs(dispatches.length-nativeCalls);
  unauthorized+=dispatches.filter(item=>{
    const intent=harness.intents.get(item.invocationId+'/'+item.effectId);
    return !intent||!capabilities.has(intent.operation);
  }).length;
  const state=programList?completed.map(r=>traceGraph(r.observableGraph)):
    result?traceGraph(result.observableGraph):null;
  const finalCleanup=cleanup(harness);
  const firstSemanticInconsistency=[...harness.invocations.values()]
    .map(a=>a.controller.firstWitnessViolation).find(Boolean)??null;
  const outcome={completion:result?(programList?{kind:'session',value:completed.map(r=>({kind:r.completion.kind,
    value:r.observableGraph?.roots.at(-1)??r.completion.value}))}:
    {kind:result.completion.kind,value:state?.roots.at(-1)??result.completion.value}):
    {kind:'failure',failure},state,effects:copy(broker.receipts),
    callbacks:copy(broker.receipts.filter(item=>item.kind==='callback')),cleanup:finalCleanup};
  broker.abort();
  return {schema:'semantic-evaluation-result/4',origin,representation:envelope.representation,
    checkpointIdentity,inferenceIdentity,episode,outcome,
    selections,
    nativeRuntimeMetrics:select?.metrics?.()??null,costScope,
    firstSemanticInconsistency,failure,rejections:copy(driver.rejections),optimizerSteps:0,
    hardGates:{futureObservationLeaks:futureLeaks,unauthorizedEffects:unauthorized,
      untrackedNativeFallback:Math.max(0,nativeCalls-dispatches.length),
      falseAdmissions:episode.sidecar.admission==='admitted'?1:0,replayNativeEffects},
    costs:{computeSeconds:(performance.now()-started)/1000,
      peakMemoryBytes:memoryUsage(select),dispatches:nativeCalls,queueDepth,
      leakedResources:finalCleanup.pendingEffects+finalCleanup.pendingJobs+finalCleanup.openHandlers}};
}
