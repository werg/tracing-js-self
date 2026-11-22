// Teacher-side ownership of actual evaluated-module scheduler events. This
// produces source-bound cuts; it does not grant public or training admission.
import {isDeepStrictEqual as eq} from 'node:util';
import {createRuntime} from '../runtime.js';
import {linkEvaluatedModules} from '../evaluated-modules.js';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {buildModuleSchedulerPlanV8,createModuleSchedulerStateV8,
  applyModuleSchedulerActionV8} from './module-scheduler-state-v8.js';

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
  const sites=new Map(bundle.sites.map(row=>[row.siteId,row])),records=new Map(),drivers=new Map(),
    executions=new Map(),settlements=new Map(),claimed=new Set(),cuts=[],observations=[];
  let state=copy(bundle.initialState),selected=createModuleSchedulerStateV8(plan);
  function emit(event,action,facts){
    need(!claimed.has(event.eventId),'runtime event already has a module lifecycle owner');
    const before=copy(selected),after=applyModuleSchedulerActionV8(plan,before,action,facts);
    const frame=state.frames[event.invocationId],instruction=frame&&bundle.programs[frame.codeId]?.instructions[frame.pc];
    if(event.operation!=='job.enter')need(instruction?.siteId===event.siteId&&frame.codeId===event.codeId,
      'event does not own its exact current instruction');
    const site=sites.get(event.siteId);
    cuts.push({action:copy(action),facts:copy(facts),before,after:copy(after),
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
        const iterator=next.heap[value(node,'iterator')?.[1]];
        need(iterator?.kind==='generator','module has no owned generator environment');
        records.set(recordId,module.file);
      }
    }
    const child=event.operation==='call.enter'&&event.stateChanges.find(change=>change.table==='frames'&&change.before===null)?.after;
    if(child&&[asynchronous,synchronous].includes(child.codeId)){
      const record=binding(next,child.envId,'record'),file=record?.[0]==='ref'&&records.get(record[1]),
        module=plan.modules.find(row=>row.file===file);
      need(module&&module.hasTLA===(child.codeId===asynchronous),'driver lacks its original module record');
      need(!drivers.has(child.id),'duplicate driver identity');
      const facts={frames:{[child.id]:frameFact(child,file)},promises:{},jobs:{}};
      if(child.asyncPromiseId!==null){
        facts.promises[child.asyncPromiseId]=promiseFact(next.promises[child.asyncPromiseId]);
        executions.set(child.asyncPromiseId,{file,frameId:child.id,recordId:record[1]});
      }
      emit(event,{type:'module.start',file,frameId:child.id,executionPromiseId:child.asyncPromiseId},facts);
      drivers.set(child.id,{file,recordId:record[1]});observations.push({file,type:'start'});
    }
    const owner=drivers.get(event.invocationId);
    if(owner&&event.operation==='async.await'){
      const frame=next.frames[event.invocationId],promiseId=frame.awaiting;
      need(frame.codeId===asynchronous&&frame.status==='suspended'&&next.promises[promiseId],
        'await lacks the actual driver continuation');
      emit(event,{type:'module.await',file:owner.file,frameId:frame.id,promiseId},
        {frames:{[frame.id]:frameFact(frame,owner.file,promiseId)},promises:{[promiseId]:promiseFact(next.promises[promiseId])},jobs:{}});
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
              moduleFile:owner.file,kind:'promise-reaction',value:copy(promise.value.value)}}});
      }else if(queued?.kind==='reaction'&&executions.has(queued.promiseId)){
        const owner=executions.get(queued.promiseId),promise=state.promises[queued.promiseId],
          callback=queued.reaction[promise.status==='fulfilled'?'onFulfilled':'onRejected'],
          fn=callback?.[0]==='ref'&&state.heap[callback[1]],
          closureRecord=fn&&binding(state,fn.closureEnvId,'record');
        need(fn?.codeId===callbacks.get(promise.status==='fulfilled'?'fulfilled':'failed')&&
          eq(closureRecord,['ref',owner.recordId]),'completion reaction lacks its original module closure');
        const facts={frames:{},promises:{[promise.id]:promiseFact(promise)},jobs:{[event.eventId]:{
          id:event.eventId,promiseId:promise.id,frameId:owner.frameId,status:promise.status,moduleFile:owner.file,
          kind:promise.status==='fulfilled'?'module-execution-settle':'module-evaluation-failure',value:copy(promise.value.value)}}};
        emit(event,{type:promise.status==='fulfilled'?'module.complete':'module.reject',file:owner.file,
          frameId:owner.frameId,promiseId:promise.id,jobId:event.eventId},facts);
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
          emit(event,{type:status==='fulfilled'?'module.complete':'module.reject',file:owner.file,
            frameId:frame.id,promiseId:null,jobId:event.eventId},facts);
          settlements.set(event.eventId,facts);
        }
      }
    }
    if(child?.codeId===failed){
      const record=binding(next,child.envId,'record'),file=record?.[0]==='ref'&&records.get(record[1]);
      if(file&&selected.modules[file].status==='waiting'){
        const module=plan.modules.find(row=>row.file===file),dependencyFile=module.dependencies.find(dependency=>
          selected.modules[dependency].status==='rejected');
        need(dependencyFile,'failed parent lacks a settled dependency');
        const failure=selected.modules[dependencyFile].failure,facts=settlements.get(failure.jobId);
        need(facts&&eq(binding(next,child.envId,'error'),facts.jobs[failure.jobId].value),
          'propagated error differs from the dependency outcome');
        emit(event,{type:'module.propagateFailure',file,dependencyFile,promiseId:failure.promiseId,jobId:failure.jobId},facts);
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
