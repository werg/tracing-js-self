// Module lifecycle authority is derived from real shared call/Promise/job state.
// The model selects ordinary source records; it cannot select lifecycle facts.
import {isDeepStrictEqual as eq} from 'node:util';
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {verifyBoundModuleSchedulerPlanV8} from './module-scheduler-plan-v8.js';
import {createModuleSchedulerStateV8,validateModuleSchedulerStateV8,applyModuleSchedulerActionV8} from './module-scheduler-state-v8.js';

export const MODULE_SCHEDULER_PROFILE_V8='bound-module-scheduler/1';
export const MODULE_SCHEDULER_RECORD_FIELDS=Object.freeze({
  'module.scheduler.initialize':Object.freeze(['kind','object','planDigest'])
});
export const MODULE_SCHEDULER_LEDGER_FIELDS_V8=Object.freeze(['kind','properties','plan','owner','state','records','settlements','sequence']);
const copy=structuredClone;
const fail=message=>{throw new TypeError('Bound module scheduler: '+message);};
const need=(condition,message)=>{if(!condition)fail(message);};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const ledgers=controller=>[...controller.heap].filter(([,node])=>node.kind==='module-scheduler');
const property=(node,key)=>node?.properties?.get(key);
function recordOwner(controller,plan,object){
  const node=controller.heap.get(object),index=property(node,'index');
  need(node?.kind==='object'&&index?.[0]==='num'&&Number.isSafeInteger(index[1]),'module argument is not its owned record');
  const module=plan.modulePlan.modules[index[1]];
  need(module&&module.index===index[1]&&eq(property(node,'hasTLA'),['bool',module.hasTLA])&&
    eq(property(node,'entry'),['bool',module.file===plan.modulePlan.entryModule]),'module record differs from active source plan');
  const dependencyRef=property(node,'dependencies'),deps=dependencyRef?.[0]==='ref'&&controller.heap.get(dependencyRef[1]);
  need(deps?.kind==='array'&&eq(property(deps,'length'),['num',module.dependencies.length])&&
    module.dependencies.every((file,i)=>eq(property(deps,String(i)),['num',plan.modulePlan.modules.find(row=>row.file===file).index])),
    'module dependency array differs from source plan');
  const iteratorRef=property(node,'iterator'),iterator=iteratorRef?.[0]==='ref'&&controller.heap.get(iteratorRef[1]),
    callee=iterator?.callee?.[0]==='ref'&&controller.heap.get(iterator.callee[1]);
  need(iterator?.kind==='generator'&&callee?.code==='__traced_eval_module_'+module.index,
    'module record lacks its exact source environment generator');
  return module;
}
function binding(ledger,module,object){
  const previous=ledger.records.find(row=>row.file===module.file);
  need(!previous||previous.object===object,'module changed its source record identity');
  need(!ledger.records.some(row=>row.file!==module.file&&row.object===object),'module source record identity was reused');
  if(previous)return previous;
  const row={file:module.file,object,frame:null,execution:null};ledger.records.push(row);return row;
}
function execution(controller,identity){
  const promise=controller.heap.get(identity);
  need(promise?.kind==='promise'&&promise.external===null,'module execution Promise is not internal');return promise;
}
function promiseFact(controller,identity){const promise=execution(controller,identity);
  return {id:identity,status:promise.state,...(promise.state==='pending'?{}:{value:copy(promise.result)})};}
function settlementFacts(ledger,settlement){
  const module=ledger.plan.modulePlan.modules.find(row=>row.file===settlement.file),
    kind=module.hasTLA?(settlement.status==='fulfilled'?'module-execution-settle':'module-evaluation-failure'):
      (settlement.status==='fulfilled'?'module-synchronous-complete':'module-synchronous-failure');
  return {promises:settlement.promise===null?{}:{[settlement.promise]:{id:settlement.promise,status:settlement.status,value:copy(settlement.value)}},
    jobs:{[settlement.job]:{id:settlement.job,promiseId:settlement.promise,frameId:settlement.frame,status:settlement.status,
      moduleFile:settlement.file,kind,value:copy(settlement.value)}},frames:module.hasTLA?{}:{[settlement.frame]:{
      id:settlement.frame,moduleFile:settlement.file,executionPromiseId:null,status:'completed',
      completion:{type:settlement.status==='fulfilled'?'return':'throw',value:copy(settlement.value)}}}};
}
export function validateModuleSchedulerRecordV8(record){
  if(record?.kind!=='module.scheduler.initialize')return false;
  assertAlgorithmFields(record,MODULE_SCHEDULER_RECORD_FIELDS[record.kind],'module scheduler initialization');
  need(id(record.object)&&/^[0-9a-f]{64}$/.test(record.planDigest),'initialization identity or plan digest');return true;
}
export function applyModuleSchedulerRecordV8(controller,record){
  if(!validateModuleSchedulerRecordV8(record))return false;
  const plan=controller.moduleSchedulerPlan;
  need(plan&&plan.digest===record.planDigest,'initialization requires its active source-bound plan');
  verifyBoundModuleSchedulerPlanV8(plan);
  need(controller.generated===0&&controller.stack.length===1&&controller.stack[0]===controller.rootInvocation&&
    !controller.heap.has(record.object)&&!ledgers(controller).length,'module scheduler must initialize at its fresh entry boundary');
  controller.heap.set(record.object,{kind:'module-scheduler',properties:new Map(),plan:copy(plan),owner:controller.rootInvocation,
    state:createModuleSchedulerStateV8(plan.modulePlan),records:[],settlements:[],sequence:0});return true;
}
export function validateBoundModuleSchedulerStateV8(controller){
  const rows=ledgers(controller),plan=controller.moduleSchedulerPlan;
  if(!rows.length)return {valid:true};
  need(plan&&rows.length===1,'module ledger requires one active source-bound program');
  const [,ledger]=rows[0];assertAlgorithmFields(ledger,MODULE_SCHEDULER_LEDGER_FIELDS_V8,'module ledger');
  verifyBoundModuleSchedulerPlanV8(plan);
  need(eq(ledger.plan,plan)&&ledger.owner===controller.rootInvocation&&ledger.properties instanceof Map&&ledger.properties.size===0&&
    Number.isSafeInteger(ledger.sequence)&&ledger.sequence>=0&&ledger.sequence<=32768,'retained ledger owner or shape');
  validateModuleSchedulerStateV8(plan.modulePlan,ledger.state);
  assertAlgorithmDataArray(ledger.records,'module source records');assertAlgorithmDataArray(ledger.settlements,'module settlements');
  need(ledger.records.length<=plan.modulePlan.modules.length&&ledger.settlements.length<=plan.modulePlan.modules.length,'module ledger bound');
  const files=new Set(),objects=new Set(),settled=new Set();
  for(const record of ledger.records){
    assertAlgorithmFields(record,['file','object','frame','execution'],'module record binding');
    const module=recordOwner(controller,plan,record.object),state=ledger.state.modules[record.file];
    need(module.file===record.file&&!files.has(record.file)&&!objects.has(record.object),'module record binding identity');
    files.add(record.file);objects.add(record.object);
    need(record.frame===state.frameId&&record.execution===state.executionPromiseId,'retained module driver identity');
    if(record.frame!==null){
      need(controller.frameFunctions.get(record.frame)===plan.functions[module.hasTLA?'asyncDriver':'syncDriver'],
        'retained driver is outside active source plan');
      if(module.hasTLA){
        const promise=execution(controller,record.execution),call=promise.asyncCall;
        need(call?.owner===ledger.owner&&call.invocation===record.frame&&eq(call.arguments[0],['ref',record.object]),
          'retained module execution Promise has another call owner');
        if(state.status==='suspended')need(call.phase==='suspended'&&
          controller.continuations.get(call.continuations.at(-1))?.promise===state.awaited.promiseId,'retained module await differs');
        if(['fulfilled','rejected'].includes(state.status))need(call.phase==='completed'&&promise.state===state.status,'retained module settlement differs');
      }
    }
  }
  for(const [file,state]of Object.entries(ledger.state.modules))
    need(state.startOrder===null||files.has(file),'started module has no source record owner');
  for(const settlement of ledger.settlements){
    assertAlgorithmFields(settlement,['file','promise','job','frame','status','value'],'module settlement binding');
    const state=ledger.state.modules[settlement.file],module=plan.modulePlan.modules.find(row=>row.file===settlement.file);
    need(module&&!settled.has(settlement.file)&&state.status===settlement.status&&state.completionJobId===settlement.job&&
      state.frameId===settlement.frame&&state.executionPromiseId===settlement.promise,'retained module settlement owner');
    settled.add(settlement.file);
    if(module.hasTLA){const promise=execution(controller,settlement.promise),job=controller.jobs.get(settlement.job),
      owner=ledger.records.find(row=>row.file===settlement.file),
      fn=job&&controller.heap.get(settlement.status==='fulfilled'?job.closure:job.rejectionClosure),
      capture=fn?.captures.find(row=>row.binding==='record');
      need(promise.state===settlement.status&&eq(promise.result,settlement.value)&&job?.promise===settlement.promise&&
        job.owner===ledger.owner&&['running','completed'].includes(job.status)&&job.originalStatus===settlement.status&&
        eq(job.originalResult,settlement.value)&&fn?.code===plan.functions[settlement.status==='fulfilled'?'fulfilled':'rejected']&&
        capture&&eq(controller.locals.get(capture.cell),['ref',owner.object]),'retained execution reaction authority');}
    else need(settlement.job==='module-sync:'+settlement.frame,'retained synchronous completion identity');
  }
  for(const [file,state]of Object.entries(ledger.state.modules))
    need(state.frameId===null||!['fulfilled','rejected'].includes(state.status)||settled.has(file),
      'settled module has no retained completion authority');
  return {valid:true};
}
export function assertBoundModuleSchedulerNextV8(controller,record){
  if(!controller.moduleSchedulerPlan){need(!ledgers(controller).length,'module ledger lacks its active source plan');return true;}
  const rows=ledgers(controller);
  if(record.kind==='module.scheduler.initialize'){need(rows.length===0,'duplicate module ledger initialization');return true;}
  need(rows.length===1,'source-bound module execution must initialize its ledger first');
  const ledger=rows[0][1],fields=record.fields??record;
  need(fields.object!==rows[0][0],'logical module ledger cannot be targeted by guest records');
  if(record.kind==='end')need(Object.values(ledger.state.modules).every(row=>['fulfilled','rejected'].includes(row.status)),
    'module graph has unfinished lifecycle obligations');
  function inspect(value){if(!value||typeof value!=='object')return;
    if(Array.isArray(value)&&value[0]==='ref'&&value[1]===rows[0][0])fail('logical module ledger cannot escape into guest values');
    for(const child of Object.values(value))inspect(child);
  }inspect(fields);return true;
}
export function advanceBoundModuleSchedulerV8(before,after,record){
  if(!after.moduleSchedulerPlan)return;
  assertBoundModuleSchedulerNextV8(before,record);
  const rows=ledgers(after);need(rows.length===1,'source-bound module execution lost its ledger');
  const ledger=rows[0][1],plan=ledger.plan,fields=record.fields??record,kind=record.kind;
  const step=(action,facts)=>{ledger.state=applyModuleSchedulerActionV8(plan.modulePlan,ledger.state,action,facts);ledger.sequence++;};
  if(kind==='call'||kind==='async.call'){
    const callee=fields.callee?.[0]==='ref'&&before.heap.get(fields.callee[1]);
    if(callee&&[plan.functions.asyncDriver,plan.functions.syncDriver,plan.functions.failure].includes(callee.code)){
      need(fields.arguments?.[0]?.[0]==='ref','module driver lacks its record argument');
      const module=recordOwner(after,plan,fields.arguments[0][1]),entry=binding(ledger,module,fields.arguments[0][1]);
      if(callee.code===plan.functions.failure){
        if(ledger.state.modules[module.file].status==='waiting'){
          const dependency=module.dependencies.find(file=>ledger.state.modules[file].status==='rejected'),
            failure=dependency&&ledger.state.modules[dependency].failure,
            settled=failure&&ledger.settlements.find(row=>row.file===failure.moduleFile);
          need(settled&&eq(fields.arguments[1],settled.value),'parent failure lacks its rejected dependency outcome');
          step({type:'module.propagateFailure',file:module.file,dependencyFile:dependency,promiseId:settled.promise,jobId:settled.job},
            settlementFacts(ledger,settled));
        }
      }else{
        need(module.hasTLA===(kind==='async.call')&&callee.code===plan.functions[module.hasTLA?'asyncDriver':'syncDriver'],
          'module entered the wrong synchronous/async driver');
        entry.frame=fields.child;entry.execution=module.hasTLA?fields.promise:null;
        const facts={frames:{[entry.frame]:{id:entry.frame,moduleFile:module.file,executionPromiseId:entry.execution}},
          promises:entry.execution===null?{}:{[entry.execution]:promiseFact(after,entry.execution)},jobs:{}};
        step({type:'module.start',file:module.file,frameId:entry.frame,executionPromiseId:entry.execution},facts);
      }
    }
  }else if(kind==='async.await'||kind==='async.resume'){
    const entry=ledger.records.find(row=>row.frame===fields.invocation);
    if(entry){
      const awaited=kind==='async.await'?fields.awaited:before.continuations.get(fields.continuation)?.promise,
        promise=promiseFact(after,awaited),frame={id:entry.frame,moduleFile:entry.file,executionPromiseId:entry.execution,awaitedPromiseId:awaited},
        action={type:kind==='async.await'?'module.await':'module.resume',file:entry.file,frameId:entry.frame,promiseId:awaited},
        facts={frames:{[entry.frame]:frame},promises:{[awaited]:promise},jobs:{}};
      if(kind==='async.resume'){action.jobId=fields.continuation;facts.jobs[action.jobId]={id:action.jobId,promiseId:awaited,
        frameId:entry.frame,status:promise.status,moduleFile:entry.file,kind:'promise-reaction',value:copy(promise.value)};}
      step(action,facts);
    }
  }else if(kind==='job'&&fields.action==='dispatch'){
    const job=before.jobs.get(fields.job),entry=job&&ledger.records.find(row=>row.execution===job.promise);
    if(entry){
      const promise=execution(before,entry.execution),fn=before.heap.get(promise.state==='fulfilled'?job.closure:job.rejectionClosure),
        capture=fn?.captures.find(row=>row.binding==='record');
      need(fn?.code===plan.functions[promise.state==='fulfilled'?'fulfilled':'rejected']&&capture&&
        eq(before.locals.get(capture.cell),['ref',entry.object]),'module settlement reaction lacks its exact source record closure');
      const settled={file:entry.file,promise:entry.execution,job:fields.job,frame:entry.frame,status:promise.state,value:copy(promise.result)};
      step({type:promise.state==='fulfilled'?'module.complete':'module.reject',file:entry.file,frameId:entry.frame,
        promiseId:entry.execution,jobId:fields.job},settlementFacts(ledger,settled));ledger.settlements.push(settled);
    }
  }else if(kind==='return'||kind==='throw'){
    const frame=fields.invocation??before.stack.at(-1),entry=ledger.records.find(row=>row.frame===frame&&row.execution===null);
    if(entry){
      const settled={file:entry.file,promise:null,job:'module-sync:'+entry.frame,frame:entry.frame,
        status:kind==='return'?'fulfilled':'rejected',value:copy(fields.value)};
      step({type:kind==='return'?'module.complete':'module.reject',file:entry.file,frameId:entry.frame,promiseId:null,jobId:settled.job},
        settlementFacts(ledger,settled));ledger.settlements.push(settled);
    }
  }
  validateBoundModuleSchedulerStateV8(after);
}
