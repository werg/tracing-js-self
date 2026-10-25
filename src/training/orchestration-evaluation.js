// A coordinator and its selected children share one native Megatoken session.
// Only the controller/broker publishes observations; no teacher runs here.
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionHarness} from './harness-v4.js';
import {SelectedModelDriver} from './model-driver.js';
import {createFixtureBroker} from './fixture-broker.js';
import {decodeWitness} from './format.js';
import {hostOperation} from '../host/operations.js';

const copy=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const demand=(value,message)=>{if(!value)throw new TypeError(message);};
const failureOf=error=>({category:error?.category??error?.name??'Error',
  message:String(error?.message??error),evidence:copy(error?.evidence??null)});
const integer=(value,fallback,maximum,name)=>{
  value??=fallback;demand(Number.isSafeInteger(value)&&value>=1&&value<=maximum,'Invalid '+name);return value;
};

/** Bind authored fixture templates only to already observed native receipts.
 * There are no expressions, source execution, expected outcomes, or predictions.
 * Actual model mode never calls this function or forwards these templates. */
export function observedFixtureRecord(template,observed){
  const resolve=(value,depth=0)=>{
    demand(depth<=32,'Controlled lifecycle template exceeds its depth bound');
    if(value===null||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(item=>resolve(item,depth+1));
    if(Object.hasOwn(value,'$observed')){
      const path=value.$observed;demand(Object.keys(value).length===1&&Array.isArray(path)&&path.length<=32,
        'Invalid observed fixture reference');
      let found=observed;
      for(const key of path){
        demand((typeof key==='string'||Number.isSafeInteger(key))&&found!==null&&
          typeof found==='object'&&Object.hasOwn(found,key),'Fixture refers to an unavailable observation');
        found=found[key];
      }
      return copy(found);
    }
    if(Object.hasOwn(value,'$json')){
      demand(Object.keys(value).length===1,'Invalid observed JSON fixture');
      return JSON.stringify(resolve(value.$json,depth+1));
    }
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item,depth+1)]));
  };
  const record=typeof template==='string'?template:JSON.stringify(resolve(template));
  demand(typeof record==='string'&&Buffer.byteLength(record)<=65536,'Lifecycle fixture exceeds its byte bound');
  return record;
}

/** Wrap a separately checked source/session case in an explicit engineering
 * orchestration fixture. Source/child identities are never renamed after audit. */
export function controlledOrchestrationCase(sourceCase,{id=sourceCase?.id,sessionId='orchestration',
    maxActive=1,maxCoordinatorDecisions=128,maxChildSelections=4096}={}){
  demand(sourceCase?.referenceReceipt?.status==='agreed'&&
    sourceCase.referenceReceipt.requestDigest===hash(sourceCase.request)&&
    sourceCase.referenceReceipt.outcomeDigest===hash(sourceCase.expected),
    'Orchestration fixtures require exact independent source/outcome receipts');
  const original=copy(sourceCase.request),programs=original.programs??[original.program],
    invocations=original.invocations??[original.invocation];
  demand(original.schema==='selected-evaluation-case/4'&&invocations.length>0,
    'A checked selected execution case is required');
  const controlledCoordinatorActions=[];
  for(const [index,invocation] of invocations.entries()){
    const program=programs.find(program=>program.programId===invocation.programId);
    demand(program,'Child invocation lacks its frozen source');
    controlledCoordinatorActions.push(
      {name:'track_create',arguments:{purpose:'Execute observed child '+invocation.invocationId,
        completion:'Deliver its observed return or throw',budget:maxChildSelections,
        capabilities:['text',...program.capabilities],execution:{$observed:['state','children',index,'execution']}}},
      {name:'track_join',arguments:{address:{$observed:['state','track']},
        completion_dependency:{$observed:['decisions',index*3,'outcomes',0,'completion_dependency']}}},
      {name:'track_progress',arguments:{address:{$observed:['state','track']},progress:{$json:{
        kind:{$observed:['completions',index,'kind']},value:{$observed:['completions',index,'value']}}}}});
  }
  controlledCoordinatorActions.push({name:'track_complete',arguments:{address:{$observed:['state','track']}}});
  const request={schema:'selected-orchestration-evaluation-case/4',sessionId,programs,invocations,
    fixture:original.fixture,limits:{maxActive,maxCoordinatorDecisions,maxChildSelections},
    controlledCoordinatorActions,controlledSelectionsByRepresentation:original.controlledSelectionsByRepresentation};
  const completions=sourceCase.expected.completion.kind==='session'?
    sourceCase.expected.completion.value:[sourceCase.expected.completion];
  const expected={completion:{kind:'orchestration',value:{children:completions.map((completion,index)=>({
    invocationId:invocations[index].invocationId,...copy(completion)})),progress:copy(completions)}},
    state:original.programs?copy(sourceCase.expected.state):[copy(sourceCase.expected.state)],
    effects:copy(sourceCase.expected.effects),callbacks:copy(sourceCase.expected.callbacks),
    cleanup:{...copy(sourceCase.expected.cleanup),pendingTracks:0}};
  return {id,family:sourceCase.family,split:sourceCase.split,request,expected,
    referenceReceipt:{status:'agreed',requestDigest:hash(request),outcomeDigest:hash(expected)}};
}

function proposalPrefixes(programs,invocations,sessionId){
  return invocations.map(invocation=>{
    // This scratch harness only validates public proposals. Its records are not
    // appended to the real execution episode and cannot activate native work.
    const proposal=new SelectedExecutionHarness({sessionId});
    for(const program of programs)proposal.publishProgram(program);
    proposal.admitInvocation(invocation);
    const view=new SelectedModelDriver({harness:proposal,select:()=>{throw new Error('Proposals cannot execute');}});
    const prefix=view.prefix(invocation.invocationId);delete prefix.selectedState;
    view.close();return prefix;
  });
}

export async function evaluateOrchestrationCase(envelope,{origin='controlled',select=null,
    checkpointIdentity=null,timeoutMs=15000,cleanupTimeoutMs=1000}={}){
  demand(envelope?.schema==='semantic-evaluation-request/4'&&
    envelope.request?.schema==='selected-orchestration-evaluation-case/4'&&
    [17,29,43].includes(envelope.seed)&&['explicit','compact'].includes(envelope.representation),
    'Invalid interactive orchestration evaluation request');
  demand(['controlled','fixed-weights','trained'].includes(origin),'Invalid orchestration authority');
  for(const method of ['openOrchestration','stepOrchestration','statusOrchestration','cancelOrchestration',
    'complete','cancel','commitRequest'])demand(typeof select?.[method]==='function',
      'Orchestration requires one native process selector with '+method);
  demand(typeof select==='function','Orchestration requires its native semantic selector');
  demand(select.representation===undefined||select.representation===envelope.representation,
    'Orchestration and child representations differ');
  const request=envelope.request,sessionId=request.sessionId??'orchestration',
    programs=copy(request.programs),invocations=copy(request.invocations);
  demand(Array.isArray(programs)&&programs.length>0&&programs.length<=16&&
    Array.isArray(invocations)&&invocations.length>0&&invocations.length<=16&&
    new Set(programs.map(p=>p.programId)).size===programs.length&&
    new Set(invocations.map(i=>i.invocationId)).size===invocations.length,
    'Orchestration needs bounded distinct source and invocation proposals');
  const limits=request.limits??{},maxActive=integer(limits.maxActive,1,64,'active track bound'),
    maxSteps=integer(limits.maxCoordinatorDecisions,128,4096,'coordinator decision bound'),
    maxSelections=integer(limits.maxChildSelections,4096,100000,'child selection bound');
  timeoutMs=integer(timeoutMs,15000,300000,'evaluation deadline');
  cleanupTimeoutMs=integer(cleanupTimeoutMs,1000,30000,'cleanup deadline');
  const plans=origin==='controlled'?request.controlledSelectionsByRepresentation?.[envelope.representation]:null;
  if(origin==='controlled')demand(Array.isArray(request.controlledCoordinatorActions)&&plans&&
    typeof select.selectControlled==='function','Controlled orchestration needs explicit lifecycle and child fixtures');
  else demand(typeof select.initialize==='function'&&/^[0-9a-f]{64}$/.test(checkpointIdentity??''),
    'Model orchestration requires immutable native checkpoint identity');
  const proposals=proposalPrefixes(programs,invocations,sessionId);
  demand(proposals.every(prefix=>prefix.committed.length===2&&prefix.parentInvocationId===null),
    'Orchestration proposals contain only observed source and root invocation input');
  let inferenceIdentity=null;
  if(origin!=='controlled'){
    inferenceIdentity=await select.initialize({seed:envelope.seed,checkpointIdentity});
    demand(inferenceIdentity?.seed===envelope.seed&&inferenceIdentity.checkpointIdentity===checkpointIdentity&&
      (!envelope.checkpointIdentity||envelope.checkpointIdentity===checkpointIdentity),
      'Actual orchestration checkpoint or seed differs from frozen evaluation');
  }
  const broker=createFixtureBroker(request.fixture),services={},capabilities=new Set(programs.flatMap(p=>p.capabilities));
  let nativeCalls=0,queueDepth=0,futureLeaks=0;
  for(const operation of [...new Set(request.fixture.calls.map(call=>call.operation))])services[operation]=(args,meta)=>{
    nativeCalls++;const spec=hostOperation(operation);
    const result=broker.invoke(operation,args.map((arg,index)=>spec.callbackIndices.includes(index)?meta.callback(index):arg));
    if(['demo.unlisten','dom.off','dom.stopTimer'].includes(operation))
      return Promise.resolve(result).then(value=>{meta.closeSubscription(args[0]);return value;});
    return result;
  };
  const harness=new SelectedExecutionHarness({sessionId,services,maxGenerated:maxSelections}),
    timeline=[],ownerSequences=new Map(),observedIds=new Map(),decisions=[],childSelections=[],
    running=new Map(),completed=new Map(),startedChildren=new Set(),counters=new Map();
  let semanticCursor=0,state=null,failure=null,cleanupFailure=null,steps=0;
  const append=(owner,channel,record)=>{
    const ownerSequence=(ownerSequences.get(owner)??0)+1;ownerSequences.set(owner,ownerSequence);
    timeline.push({sequence:timeline.length+1,ownerSequence,owner,channel,record:copy(record)});
  };
  const drainSemantic=()=>{
    for(const item of harness.timeline.slice(semanticCursor))append(item.track,'semantic',item);
    semanticCursor=harness.timeline.length;
  };
  const observeNative=next=>{
    demand(next?.session===sessionId&&(!state||next.track===state.track),'Native orchestration changed its owner');
    for(const item of next.observations??[]){
      if(item.track!==next.track)continue; // Child source appears once in the semantic episode.
      if(observedIds.has(item.eventId)){
        demand(isDeepStrictEqual(observedIds.get(item.eventId),item),'Native observation history was rewritten');continue;
      }
      demand(typeof item.eventId==='string'&&typeof item.payloadHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(item.payloadHex),
        'Native coordinator observation lost its exact bytes');
      observedIds.set(item.eventId,copy(item));append(item.track,'coordinator',item);
    }
    queueDepth=Math.max(queueDepth,next.tracks.filter(track=>track.status==='waiting').length,
      harness.closureQueue.length);return next;
  };
  const abort=new AbortController();
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
  const timer=setTimeout(()=>{const error=new Error('Orchestration evaluation deadline exceeded');
    abort.abort(error);rejectAbort(error);},timeoutMs);
  const bounded=promise=>Promise.race([promise,aborted]);
  const childSelect=async prefix=>{
    drainSemantic();futureLeaks+=prefix.committed.filter(record=>record.sequence>harness.globalSequence).length;
    let output;
    if(origin==='controlled'){
      const index=counters.get(prefix.invocationId)??0,record=plans[prefix.invocationId]?.[index];
      demand(typeof record==='string','Controlled child selection fixture exhausted');
      const {kind,fields}=decodeWitness(record),controller=harness.invocations.get(prefix.invocationId).controller;
      const pending=[...controller.effects.values()].some(effect=>effect.status==='requested')||
        [...controller.continuations.values()].some(item=>item.state!=='resumed')||
        [...controller.jobs.values()].some(item=>item.status!=='completed');
      if(kind==='resume'&&!controller.ready.includes(fields.continuation)||
        kind==='job'&&fields.action==='dispatch'&&!controller.ready.includes(fields.job)||kind==='end'&&pending)
        return {wait:true};
      output=await bounded(select.selectControlled(prefix,record));counters.set(prefix.invocationId,index+1);
    }else output=await bounded(select(prefix));
    childSelections.push({invocationId:prefix.invocationId,record:output.record,selection:copy(output.selection)});
    return output;
  };
  childSelect.nativeCommitRequired=true;
  childSelect.commitRequest=(prefix,record)=>{drainSemantic();return bounded(select.commitRequest(prefix,record));};
  childSelect.complete=async prefix=>{
    drainSemantic();await bounded(select.complete(prefix));
    if(state)state=observeNative(await bounded(select.statusOrchestration({session:sessionId,track:state.track})));
  };
  childSelect.cancel=prefix=>select.cancel(prefix);
  const driver=new SelectedModelDriver({harness,select:childSelect,maxSelections});
  const elapsed=performance.now();
  const status=async()=>state=observeNative(await bounded(select.statusOrchestration({session:sessionId,track:state.track})));
  const completions=()=>invocations.flatMap(invocation=>{
    const receipt=state?.receipts.find(item=>item.schema==='semantic-completion/4'&&
      item.dependency.invocation===invocation.invocationId);
    return receipt?[{kind:receipt.kind,value:copy(receipt.value)}]:[];
  });
  const launch=()=>{
    for(const track of state.tracks){
      const identity=track.execution?.invocation_id;
      if(!identity||track.status!=='active'||startedChildren.has(identity))continue;
      const invocation=invocations.find(item=>item.invocationId===identity),proposal=proposals.find(item=>item.invocationId===identity);
      demand(invocation&&track.parent===state.track&&track.bootstrap_ready,'Native child lacks an observed bootstrapped proposal');
      const program=programs.find(item=>item.programId===invocation.programId);
      startedChildren.add(identity);
      // Actual source publication and activation occur here, after native create
      // acknowledgement/bootstrap and any capacity-releasing selected join.
      const work=(async()=>{
        let result=await driver.run({...program,...invocation,inputGraph:proposal.committed[1].inputGraph,
          args:[],signal:abort.signal});
        if(result.taskCompletion)result=await result.taskCompletion;
        completed.set(identity,{invocationId:identity,trackId:invocation.trackId,nativeTrack:track.address,
          completion:copy(result.completion),state:copy(result.observableGraph)});
        return {identity};
      })().catch(error=>({identity,error}));
      running.set(identity,work);
    }
  };
  try{
    state=observeNative(await bounded(select.openOrchestration({session:sessionId,proposals,maxActive,
      origin:origin==='controlled'?'controlled':'model'})));
    for(;;){
      launch();
      if(state.status==='completed'){
        // The native completion acknowledgement precedes resolution of the
        // driver's task. Await that receipt path, while rejecting a parent that
        // actually completed with unfinished required native children.
        demand(state.tracks.every(track=>['completed','cancelled'].includes(track.status)),
          'Coordinator completed with unfinished native children');
        const finished=await bounded(Promise.all(running.values()));
        if(finished.some(result=>result.error))throw finished.find(result=>result.error).error;
        demand(completed.size===invocations.length,'Coordinator completed before every required child result');break;
      }
      demand(state.status!=='cancelled','Coordinator cancelled before whole-task completion');
      if(state.status==='active'){
        demand(steps<maxSteps,'Coordinator decision budget exhausted');
        const template=origin==='controlled'?request.controlledCoordinatorActions[steps]:undefined;
        if(origin==='controlled')demand(template!==undefined,'Controlled coordinator fixture exhausted');
        const controlledRecord=origin==='controlled'?observedFixtureRecord(template,{state,
          decisions,completions:completions()}):undefined;
        const next=await bounded(select.stepOrchestration({session:sessionId,track:state.track,
          ...(controlledRecord===undefined?{}:{controlledRecord})}));
        drainSemantic();state=observeNative(next);decisions.push(copy(state.decision));steps++;
        demand(state.decision.outcomes.length===1&&!state.decision.outcomes.some(outcome=>outcome.error),
          'Native lifecycle refused the selected coordinator action');
      }else{
        demand(running.size>0,'Coordinator is blocked without owned runnable child work');
        const result=await bounded(Promise.race(running.values()));running.delete(result.identity);
        if(result.error)throw result.error;
        await status();
      }
    }
    const remaining=await bounded(Promise.all(running.values()));
    if(remaining.some(result=>result.error))throw remaining.find(result=>result.error).error;
    await bounded(Promise.all([...driver.running.values()].map(run=>run.task)));
    broker.finish();await status();
  }catch(error){failure=failureOf(error);}
  finally{
    clearTimeout(timer);
    if(failure){
      const error=new Error(failure.message);abort.abort(error);rejectAbort(error);broker.abort(error);
      driver.close();
      for(const [identity,activation] of harness.invocations)if(activation.status!=='cancelled')
        harness.cancelInvocation(identity,{reason:failure.message});
      let cleanupTimer;
      try{
        const cancel=state?select.cancelOrchestration({session:sessionId,track:state.track,reason:failure.message}):Promise.resolve(null);
        const finished=await Promise.race([Promise.all([cancel,...running.values()]),new Promise((_,reject)=>{
          cleanupTimer=setTimeout(()=>reject(new Error('Native orchestration cleanup deadline exceeded')),cleanupTimeoutMs);
        })]);
        if(finished[0])state=observeNative(finished[0]);
      }catch(error){cleanupFailure=failureOf(error);select.close?.();}
      finally{clearTimeout(cleanupTimer);}
    }
    driver.close();drainSemantic();broker.abort();
  }
  const episode=harness.exportEpisode({sourceLineage:'orchestration:'+envelope.caseId});
  episode.sidecar.selectionOrigin=origin==='controlled'?'controlled-test-injected':'actual-model-selected';
  episode.sidecar.evidenceKind=origin==='trained'?'model-evaluation':'deterministic-engineering';
  let replayValid=false,replayError=null;
  const beforeReplay=nativeCalls;
  try{if(harness.invocations.size){SelectedExecutionHarness.replay(episode);replayValid=true;}}
  catch(error){replayError=failureOf(error);}
  const finalCleanup={pendingEffects:[...harness.intents.values()].filter(intent=>
    ['committed','dispatching','dispatched','uncertain'].includes(intent.status)).length,
    pendingJobs:[...harness.invocations.values()].filter(item=>item.status!=='cancelled').reduce((sum,item)=>sum+
      [...item.controller.jobs.values()].filter(job=>job.status!=='completed').length,0),
    openHandlers:[...harness.handlers.values()].filter(handler=>handler.state!=='closed').length,
    pendingTracks:state?state.tracks.filter(track=>!['completed','cancelled'].includes(track.status)).length:0};
  const children=invocations.flatMap(item=>completed.has(item.invocationId)?[completed.get(item.invocationId)]:[]);
  const rawProgress=decisions.flatMap(decision=>{
    const action=JSON.parse(decision.record);if(action.name!=='track_progress')return [];
    try{return [JSON.parse(action.arguments.progress)];}catch{return [action.arguments.progress];}
  });
  const progress=rawProgress.map((value,index)=>{
    // Ordered child progress is validated against its original native receipt.
    // Score object identity in the same alpha-normalized observable graph as
    // the independent reference, while retaining native bytes in decisions.
    const identity=invocations[index]?.invocationId,child=completed.get(identity);
    const receipt=state?.receipts.find(item=>item.schema==='semantic-completion/4'&&
      item.dependency.invocation===identity);
    if(!child?.state||!receipt||!isDeepStrictEqual(value,{kind:receipt.kind,value:receipt.value})||
      !isDeepStrictEqual(child.completion,{kind:receipt.kind,value:receipt.value}))return value;
    return {kind:receipt.kind,value:copy(child.state.roots.at(-1))};
  });
  const dispatches=harness.timeline.filter(item=>item.kind==='dispatch');
  const unauthorized=Math.abs(dispatches.length-nativeCalls)+dispatches.filter(item=>{
    const intent=harness.intents.get(item.invocationId+'/'+item.effectId);
    return !intent||!capabilities.has(intent.operation);
  }).length;
  return {schema:'semantic-evaluation-result/4',origin,representation:envelope.representation,
    checkpointIdentity,inferenceIdentity,episode,failure,cleanupFailure,
    orchestration:{schema:'semantic-orchestration-evidence/4',session:sessionId,track:state?.track??null,
      proposals,decisions,timeline,finalState:copy(state),children:copy(children),childSelections,
      validation:{semanticReplay:replayValid,lifecycle:!failure&&!cleanupFailure,
        complete:state?.status==='completed'&&children.length===invocations.length},replayError},
    outcome:{completion:failure?{kind:'failure',failure}:{kind:'orchestration',value:{
      children:children.map(child=>({invocationId:child.invocationId,kind:child.completion.kind,
        value:child.state?.roots.at(-1)??child.completion.value})),progress}},
      state:children.map(child=>child.state),effects:copy(broker.receipts),
      callbacks:copy(broker.receipts.filter(item=>item.kind==='callback')),cleanup:finalCleanup},
    firstSemanticInconsistency:[...harness.invocations.values()].map(item=>item.controller.firstWitnessViolation).find(Boolean)??null,
    rejections:copy(driver.rejections),optimizerSteps:0,nativeRuntimeMetrics:select.metrics?.()??null,
    hardGates:{futureObservationLeaks:futureLeaks,unauthorizedEffects:unauthorized,
      untrackedNativeFallback:Math.max(0,nativeCalls-dispatches.length),falseAdmissions:0,
      replayNativeEffects:nativeCalls-beforeReplay},
    costScope:{computeSeconds:'case-wall-time-excluding-model-initialization',
      peakMemoryBytes:'sum-of-runner-and-native-process-lifetime-peak-rss-upper-bound'},
    costs:{computeSeconds:(performance.now()-elapsed)/1000,
      peakMemoryBytes:process.resourceUsage().maxRSS*1024+(select.metrics?.().peakMemoryBytes??0),
      dispatches:nativeCalls,queueDepth,leakedResources:Object.values(finalCleanup).reduce((sum,value)=>sum+value,0)}};
}
