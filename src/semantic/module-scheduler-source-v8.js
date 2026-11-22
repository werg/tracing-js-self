// Teacher-side ownership of actual evaluated-module scheduler events. This
// produces source-bound cuts; it does not grant public or training admission.
import {isDeepStrictEqual as eq} from 'node:util';
import {createRuntime} from '../runtime.js';
import {linkEvaluatedModules} from '../evaluated-modules.js';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {buildModuleSchedulerPlanV8,createModuleSchedulerStateV8,
  applyModuleSchedulerActionV8} from './module-scheduler-state-v8.js';
import {deriveModuleSchedulerSourceSitesV8} from './module-scheduler-source-sites-v8.js';

const copy=structuredClone;
const fail=message=>{throw new TypeError('Module scheduler source: '+message);};
const need=(condition,message)=>{if(!condition)fail(message);};
const value=(node,key)=>node?.properties?.[key]?.value;
const binding=(state,env,name)=>{
  const seen=new Set();
  while(env&&!seen.has(env)){
    seen.add(env);const row=state.envs[env];
    if(row?.bindings?.[name]?.initialized)return row.bindings[name].token.value;
    env=row?.parent;
  }
  return null;
};

export function deriveModuleSchedulerSourceCutsV8({request,bundle}={}){
  const linked=linkEvaluatedModules(request),plan=buildModuleSchedulerPlanV8(linked.metadata);
  need(bundle&&validateBundle(bundle).valid===true&&replayExact(bundle).valid===true,'invalid owned execution');
  const fresh=JSON.parse(JSON.stringify(createRuntime().startEntry({text:linked.source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true}).exportRun()));
  // A rehashed archive or caller-supplied source map cannot change the code
  // owning an event. Recompile the original request, including the linker.
  for(const field of ['sources','programs','sites','entrySpec','initialState'])
    need(eq(bundle[field],fresh[field]),'original source/compiler identity differs: '+field);
  const scheduler=linked.metadata.instantiationAndEvaluation.find(row=>row.kind==='async-scheduler');
  need(scheduler,'missing original scheduler span');
  const functions=new Map();
  for(const program of Object.values(bundle.programs))for(const instruction of program.instructions){
    if(instruction.op==='DEF_FN'&&instruction.start>=scheduler.start&&instruction.end<=scheduler.end){
      need(!functions.has(instruction.arg.name),'duplicate scheduler declaration');
      functions.set(instruction.arg.name,instruction.arg.codeId);
    }
  }
  const asynchronous=functions.get('__traced_eval_async'),synchronous=functions.get('__traced_eval_sync'),
    failed=functions.get('__traced_eval_failed'),startAsync=functions.get('__traced_eval_start_async');
  need(asynchronous&&synchronous&&failed&&startAsync,'exact scheduler helpers are absent');
  const callbacks=new Map();
  for(const instruction of bundle.programs[startAsync].instructions){
    if(instruction.op!=='MAKE_FUNCTION')continue;
    const program=bundle.programs[instruction.arg.codeId];
    for(const status of ['fulfilled','failed'])if(program.instructions.some(row=>row.op==='GET'&&row.arg==='__traced_eval_'+status))
      callbacks.set(status,instruction.arg.codeId);
  }
  need(callbacks.size===2,'exact module completion callbacks are absent');
  const sourceSites=deriveModuleSchedulerSourceSitesV8({
    source:linked.source,moduleSchedulerPlan:plan,bundle
  });
  const instructions=Object.values(bundle.programs).flatMap(program=>program.instructions);
  const moduleFunctionByFile=new Map();
  const moduleBodyCodeIds=new Map(sourceSites.moduleFunctions.map(module=>{
    const defs=instructions.filter(instruction=>instruction.op==='DEF_FN'&&
      instruction.arg?.name===module.name&&instruction.start===module.start&&
      instruction.end===module.end);
    need(defs.length===1,'module generator definition is ambiguous');
    const codeId=defs[0].arg.codeId;
    need(bundle.programs[codeId]?.generator===true,'module body is not the proved generator');
    moduleFunctionByFile.set(module.file,{...module,codeId,definitionSiteId:defs[0].siteId});
    return [module.file,codeId];
  }));
  const sites=new Map(bundle.sites.map(row=>[row.siteId,row])),records=new Map(),drivers=new Map(),
    executions=new Map(),settlements=new Map(),claimed=new Set(),cuts=[],observations=[];
  let state=copy(bundle.initialState),selected=createModuleSchedulerStateV8(plan);
  function emit(event,action,facts,ownerProof=null){
    need(!claimed.has(event.eventId),'runtime event already has a module lifecycle owner');
    const before=copy(selected),after=applyModuleSchedulerActionV8(plan,before,action,facts);
    const frame=state.frames[event.invocationId],instruction=frame&&bundle.programs[frame.codeId]?.instructions[frame.pc];
    if(event.operation!=='job.enter')need(instruction?.siteId===event.siteId&&frame.codeId===event.codeId,
      'event does not own its exact current instruction');
    const site=sites.get(event.siteId);
    cuts.push({action:copy(action),facts:copy(facts),before,after:copy(after),
      ...(ownerProof?{runtimeOwner:copy(ownerProof)}:{}),
      certificate:{eventId:event.eventId,sequence:event.sequence,operation:event.operation,
        codeId:event.codeId,pc:frame?.pc??null,site:site?{start:site.start,end:site.end}:null}});
    claimed.add(event.eventId);selected=after;
  }
  function frameFact(frame,file,awaitedPromiseId){
    return {id:frame.id,moduleFile:file,executionPromiseId:frame.asyncPromiseId,
      ...(awaitedPromiseId!==undefined?{awaitedPromiseId}:{}),
      ...(frame.status==='completed'?{status:'completed',completion:{type:frame.completion.type,
        value:copy(frame.completion.value.value)}}:{})};
  }
  function promiseFact(promise){
    return {id:promise.id,status:promise.status,...(promise.value?{value:copy(promise.value.value)}:{})};
  }
  for(const event of bundle.events){
    const next={...state};
    for(const change of event.stateChanges){
      next[change.table]={...next[change.table]};
      if(change.after===null)delete next[change.table][change.id];
      else next[change.table][change.id]=change.after;
    }
    const site=sites.get(event.siteId),span=site&&linked.metadata.instantiationAndEvaluation.find(row=>
      row.kind==='module-record'&&site.start>=row.start&&site.end<=row.end);
    if(span&&event.operation==='property.write'){
      const recordId=event.operands?.[2]?.[0]==='ref'?event.operands[2][1]:null,node=recordId&&next.heap[recordId],
        module=plan.modules.find(row=>row.file===span.file);
      if(node&&value(node,'index')){
        need(!records.has(recordId)&&eq(value(node,'index'),['num',module.index])&&
          eq(value(node,'hasTLA'),['bool',module.hasTLA])&&eq(value(node,'entry'),['bool',module.file===plan.entryModule]),
          'module record differs from original linker row');
        const dependencies=next.heap[value(node,'dependencies')?.[1]],
          actual=Array.from({length:value(dependencies,'length')?.[1]??-1},(_,i)=>value(dependencies,String(i))?.[1]);
        need(eq(actual,module.dependencies.map(file=>plan.modules.find(row=>row.file===file).index)),
          'module dependency identities differ from source');
        const generatorId=value(node,'iterator')?.[1],iterator=next.heap[generatorId],
          generatorFrameId=iterator?.frameId,generatorFrame=generatorFrameId&&next.frames[generatorFrameId],
          bodyCodeId=moduleBodyCodeIds.get(module.file);
        need(iterator?.kind==='generator'&&generatorFrame&&
          generatorFrame.generatorId===generatorId&&generatorFrame.codeId===bodyCodeId&&
          bundle.programs[bodyCodeId]?.generator===true,
          'module generator lacks its source-bound body frame');
        const initializerGeneratorEvents=bundle.events.filter(candidate=>{
          const candidateSite=sites.get(candidate.siteId);
          return linked.metadata.instantiationAndEvaluation.some(candidateSpan=>
            candidateSpan.kind==='module-record'&&candidateSpan.file===module.file&&
            candidateSite&&candidateSite.start>=candidateSpan.start&&candidateSite.end<=candidateSpan.end)&&
            candidate.stateChanges.some(change=>change.table==='heap'&&change.id===generatorId&&
              change.before===null&&change.after?.kind==='generator');
        });
        need(initializerGeneratorEvents.length===1&&
          initializerGeneratorEvents[0].stateChanges.some(change=>change.table==='frames'&&
            change.before===null&&change.after?.id===generatorFrameId&&
            change.after.generatorId===generatorId&&change.after.codeId===bodyCodeId),
          'module generator creation lacks its exact initializer owner');
        const iteratorWrites=bundle.events.filter(candidate=>
          candidate.operation==='property.write'&&candidate.operands?.[0]?.[0]==='ref'&&
          candidate.operands?.[0]?.[1]===recordId&&
          candidate.operands?.[1]?.[0]==='str'&&candidate.operands[1][1]==='iterator'&&
          candidate.operands?.[2]?.[0]==='ref'&&candidate.operands[2][1]===generatorId);
        const iteratorSite=sites.get(iteratorWrites[0]?.siteId);
        need(iteratorWrites.length===1&&iteratorSite&&
          linked.metadata.instantiationAndEvaluation.some(candidateSpan=>
            candidateSpan.kind==='module-record'&&candidateSpan.file===module.file&&
            iteratorSite.start>=candidateSpan.start&&iteratorSite.end<=candidateSpan.end)&&
          initializerGeneratorEvents[0].sequence<iteratorWrites[0].sequence&&
          iteratorWrites[0].sequence<event.sequence,
          'module generator allocation or iterator binding is after record publication');
        const moduleFunction=moduleFunctionByFile.get(module.file);
        need(moduleFunction,'module generator definition mapping is absent');
        records.set(recordId,{file:module.file,recordId,generatorId,
          generatorFrameId,bodyCodeId,recordAssignmentEventId:event.eventId,
          recordAssignmentSequence:event.sequence,
          generatorAllocationEventId:initializerGeneratorEvents[0].eventId,
          generatorAllocationSequence:initializerGeneratorEvents[0].sequence,
          iteratorBindingEventId:iteratorWrites[0].eventId,
          iteratorBindingSequence:iteratorWrites[0].sequence,
          definitionSiteId:moduleFunction.definitionSiteId});
      }
    }
    const child=event.operation==='call.enter'&&event.stateChanges.find(change=>change.table==='frames'&&change.before===null)?.after;
    if(child&&[asynchronous,synchronous].includes(child.codeId)){
      const record=binding(next,child.envId,'record'),recordOwner=record?.[0]==='ref'&&records.get(record[1]),
        file=recordOwner?.file,module=plan.modules.find(row=>row.file===file);
      need(module&&module.hasTLA===(child.codeId===asynchronous),'driver lacks its original module record');
      need(!drivers.has(child.id),'duplicate driver identity');
      const facts={frames:{[child.id]:frameFact(child,file)},promises:{},jobs:{}};
      if(child.asyncPromiseId!==null){
        facts.promises[child.asyncPromiseId]=promiseFact(next.promises[child.asyncPromiseId]);
        executions.set(child.asyncPromiseId,{...recordOwner,file,frameId:child.id,
          driverFrameId:child.id,executionPromiseId:child.asyncPromiseId});
      }
      emit(event,{type:'module.start',file,frameId:child.id,executionPromiseId:child.asyncPromiseId},facts,
        {...recordOwner,driverFrameId:child.id,executionPromiseId:child.asyncPromiseId});
      drivers.set(child.id,{...recordOwner,driverFrameId:child.id,
        executionPromiseId:child.asyncPromiseId});observations.push({file,type:'start'});
    }
    const owner=drivers.get(event.invocationId);
    if(owner&&event.operation==='async.await'){
      const frame=next.frames[event.invocationId],promiseId=frame.awaiting;
      need(frame.codeId===asynchronous&&frame.status==='suspended'&&next.promises[promiseId],
        'await lacks the actual driver continuation');
      emit(event,{type:'module.await',file:owner.file,frameId:frame.id,promiseId},
        {frames:{[frame.id]:frameFact(frame,owner.file,promiseId)},promises:{[promiseId]:promiseFact(next.promises[promiseId])},jobs:{}},
        owner);
      observations.push({file:owner.file,type:'await'});
    }
    if(event.operation==='job.enter'){
      const queued=state.control.a0.queue?.[0],owner=queued&&drivers.get(queued.frameId);
      if(queued?.kind==='await'&&owner){
        const frame=state.frames[queued.frameId],promise=state.promises[queued.promiseId];
        need(frame.awaiting===queued.promiseId&&next.frames[frame.id].awaiting===null,
          'reaction does not resume its retained driver await');
        emit(event,{type:'module.resume',file:owner.file,frameId:frame.id,promiseId:promise.id,jobId:event.eventId},
          {frames:{[frame.id]:frameFact(frame,owner.file,promise.id)},promises:{[promise.id]:promiseFact(promise)},
            jobs:{[event.eventId]:{id:event.eventId,promiseId:promise.id,frameId:frame.id,status:promise.status,
              moduleFile:owner.file,kind:'promise-reaction',value:copy(promise.value.value)}}},owner);
      }else if(queued?.kind==='reaction'&&executions.has(queued.promiseId)){
        const owner=executions.get(queued.promiseId),promise=state.promises[queued.promiseId],
          callback=queued.reaction[promise.status==='fulfilled'?'onFulfilled':'onRejected'],
          fn=callback?.[0]==='ref'&&state.heap[callback[1]],
          closureRecord=fn&&binding(state,fn.closureEnvId,'record');
        const callbackFrameId=event.causes?.find(cause=>cause.kind==='invocation')?.frameId,
          callbackFrame=callbackFrameId&&next.frames[callbackFrameId];
        need(fn?.codeId===callbacks.get(promise.status==='fulfilled'?'fulfilled':'failed')&&
          eq(closureRecord,['ref',owner.recordId])&&callbackFrame?.codeId===fn.codeId&&
          callbackFrame.reactionJob===true&&
          callbackFrame.reactionPromiseId===queued.reaction.resultId&&
          eq(binding(next,callbackFrame.envId,'record'),['ref',owner.recordId]),
          'completion reaction lacks its original callback frame and module closure');
        const callbackFrameChange=event.stateChanges.find(change=>change.table==='frames'&&
          change.before===null&&change.after?.id===callbackFrameId);
        need(callbackFrameChange?.after?.codeId===fn.codeId,
          'completion job did not allocate its exact callback function frame');
        const facts={frames:{},promises:{[promise.id]:promiseFact(promise)},jobs:{[event.eventId]:{
          id:event.eventId,promiseId:promise.id,frameId:owner.driverFrameId,status:promise.status,moduleFile:owner.file,
          kind:promise.status==='fulfilled'?'module-execution-settle':'module-evaluation-failure',value:copy(promise.value.value)}}};
        emit(event,{type:promise.status==='fulfilled'?'module.complete':'module.reject',file:owner.file,
          frameId:owner.driverFrameId,promiseId:promise.id,jobId:event.eventId},facts,
          {...owner,callbackFrameId,completionJobEventId:event.eventId});
        settlements.set(event.eventId,facts);
      }
    }
    if(owner){
      const frame=next.frames[event.invocationId],previous=state.frames[event.invocationId];
      if(previous.status!=='completed'&&frame.status==='completed'){
        observations.push({file:owner.file,type:frame.completion.type==='throw'?'throw':'complete'});
        if(frame.asyncPromiseId===null){
          const status=frame.completion.type==='throw'?'rejected':'fulfilled',facts={
            frames:{[frame.id]:frameFact(frame,owner.file)},promises:{},jobs:{[event.eventId]:{
              id:event.eventId,promiseId:null,frameId:frame.id,status,moduleFile:owner.file,
              kind:status==='fulfilled'?'module-synchronous-complete':'module-synchronous-failure',
              value:copy(frame.completion.value.value)}}};
          need(owner.generatorFrameId&&state.frames[owner.generatorFrameId]?.status==='completed'&&
            state.frames[owner.generatorFrameId]?.generatorId===owner.generatorId,
            'synchronous helper completed without its module generator body');
          emit(event,{type:status==='fulfilled'?'module.complete':'module.reject',file:owner.file,
            frameId:frame.id,promiseId:null,jobId:event.eventId},facts,
            {...owner,driverFrameId:frame.id,synchronousCompletionEventId:event.eventId});
          settlements.set(event.eventId,facts);
        }
      }
    }
    if(child?.codeId===failed){
      const record=binding(next,child.envId,'record'),recordOwner=record?.[0]==='ref'&&records.get(record[1]),
        file=recordOwner?.file;
      if(file&&selected.modules[file].status==='waiting'){
        const module=plan.modules.find(row=>row.file===file),dependencyFile=module.dependencies.find(dependency=>
          selected.modules[dependency].status==='rejected');
        need(dependencyFile,'failed parent lacks a settled dependency');
        const failure=selected.modules[dependencyFile].failure,facts=settlements.get(failure.jobId);
        need(facts&&eq(binding(next,child.envId,'error'),facts.jobs[failure.jobId].value),
          'propagated error differs from the dependency outcome');
        emit(event,{type:'module.propagateFailure',file,dependencyFile,promiseId:failure.promiseId,jobId:failure.jobId},facts,
          recordOwner);
      }
    }
    state=next;
  }
  need(records.size===plan.modules.length,'missing original module record ownership');
  need(Object.values(selected.modules).every(row=>['fulfilled','rejected'].includes(row.status)),
    'module execution is incomplete or outside the bounded ownership profile');
  return {schema:'semantic-module-scheduler-source-cuts/1',plan,cuts,state:copy(selected),observations,
    ownedEventCount:claimed.size,publicAdmission:false,trainingAdmission:false};
}
