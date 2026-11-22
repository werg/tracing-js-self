import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {realizeGraph} from '../src/training/graph.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {createRuntime} from '../src/runtime.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {buildModuleSchedulerPlanV8} from '../src/semantic/module-scheduler-state-v8.js';
import {deriveModuleSchedulerSourceSitesV8} from '../src/semantic/module-scheduler-source-sites-v8.js';

test('captures scheduler helper, frame, promise, await and consumed-job owners from a real sibling graph',()=>{
  const modules={
    'state.mjs':"export const trace=[];export function add(value){trace.push(value);}",
    'left.mjs':"import {add} from './state.mjs';add('left:start');await 0;add('left:end');export const left=1;",
    'right.mjs':"import {add} from './state.mjs';add('right:start');await 0;add('right:end');export const right=2;",
    'main.mjs':"import {add,trace} from './state.mjs';import {left} from './left.mjs';import {right} from './right.mjs';add('main');export function run(){return [left,right,trace.slice()];}"
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.mjs',exportName:'run'});
  assert.equal(linked.metadata.evaluationStrategy,'async-dependency-scheduler');
  const plan=buildModuleSchedulerPlanV8(linked.metadata);
  const runtime=createRuntime({maxSteps:30000}).startEntry({text:linked.source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true});
  assert.equal(runtime.drive().kind,'terminated');
  const bundle=runtime.exportRun();
  validateBundle(bundle);replayExact(bundle);
  const root=runtime.initialState.control.a0.activeFrameId;
  const promise=runtime.state.promises[runtime.initialState.frames[root].asyncPromiseId];
  assert.equal(promise.status,'fulfilled');
  const result=realizeGraph(runtime.state.heap,[promise.value.value])[0];
  assert.deepEqual(result,[1,2,['left:start','right:start','left:end','right:end','main']]);
  const sourceSites=deriveModuleSchedulerSourceSitesV8({
    source:linked.source,moduleSchedulerPlan:plan,bundle
  });
  assert.equal(sourceSites.moduleFunctions.length,plan.modules.length);
  const callBySite=new Map(sourceSites.calls.map(call=>[call.siteId,call]));
  const relevant=[];
  const promiseIds=new Set();
  for(const event of bundle.events){
    const call=callBySite.get(event.siteId);
    if(call&&['__traced_eval_start_async','__traced_eval_async',
      '__traced_eval_sync','__traced_eval_fulfilled','__traced_eval_failed',
      '__traced_eval_visit'].includes(call.helper)){
      relevant.push({eventId:event.eventId,operation:event.operation,helper:call.helper,
        caller:call.caller,siteId:event.siteId,invocationId:event.invocationId,
        operands:event.operands,result:event.result,causes:event.causes,
        stateChanges:event.stateChanges});
      for(const cause of event.causes??[])if(cause.promiseId)promiseIds.add(cause.promiseId);
      for(const change of event.stateChanges??[]){
        if(change.table==='frames'&&change.after?.asyncPromiseId)
          promiseIds.add(change.after.asyncPromiseId);
      }
    }
    if(event.operation==='async.await'){
      relevant.push({eventId:event.eventId,operation:event.operation,siteId:event.siteId,
        invocationId:event.invocationId,operands:event.operands,causes:event.causes,
        stateChanges:event.stateChanges});
      for(const cause of event.causes??[])if(cause.promiseId)promiseIds.add(cause.promiseId);
    }
  }
  for(const event of bundle.events){
    if(event.operation==='job.enter'&&
       (event.causes??[]).some(cause=>promiseIds.has(cause.promiseId))){
      relevant.push({eventId:event.eventId,operation:event.operation,
        invocationId:event.invocationId,causes:event.causes,stateChanges:event.stateChanges});
    }
  }
  assert(sourceSites.calls.some(row=>row.helper==='__traced_eval_async'));
  assert(relevant.some(row=>row.operation==='async.await'));
  assert(relevant.some(row=>row.operation==='job.enter'));
  assert(relevant.some(row=>row.helper==='__traced_eval_sync'));
  const evidence={schema:'experimental-module-scheduler-owned-capture/1',
    publicAdmission:false,plan,sites:sourceSites,events:relevant,result,
    finalState:bundle.finalState};
  if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,
    'module-scheduler-owner-capture.json'),JSON.stringify(evidence)+'\n');
});
