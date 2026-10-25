import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {validateHostJournal} from '../src/host-journal.js';
import {replayExact} from '../src/replay.js';
import {compileEffectfulWitness} from '../src/training/effectful-compiler.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';

const fail=message=>{throw new Error(message);};
const effectCause=event=>event.causes.find(cause=>cause.kind==='effect')?.effectId;
const deliver=(runtime,effect,value,abrupt=false)=>{
  const input=runtime.recordInputArrival({effectId:effect.id,kind:'completion',value,abrupt});
  runtime.deliverInput(input.inputId);
};

test('source-certified persistent callbacks occur after registration and close through actual selected serving',async()=>{
  const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id==='persistent-external-trigger');
  const result=await verifyEffectfulTrainingCase(fixture);
  assert.equal(result.status,'locally_verified',result.reason);
  assert.equal((await recheckEffectfulAdmission(result.exported,{requireAdmitted:false})).sourceValidated,true);
  const archive=result.exported.sidecar.archive;
  const registration=Object.values(archive.effects).find(effect=>effect.operation==='demo.listen');
  const close=Object.values(archive.effects).find(effect=>effect.operation==='demo.unlisten');
  const settled=archive.events.find(event=>event.operation==='external.input.deliver'&&effectCause(event)===registration.id);
  const callbacks=archive.events.filter(event=>event.operation==='external.callback.enqueue');
  assert.equal(callbacks.length,2);assert(callbacks.every(event=>event.sequence>settled.sequence));
  assert.deepEqual(registration.subscription,{state:'closed',token:['str','callback1'],closedBy:close.id});
  const timeline=result.exported.public.timeline;
  assert.equal(timeline.filter(item=>item.kind==='handler-close').length,1);
  assert.equal(timeline.filter(item=>item.kind==='event').length,2);
  const cohort=controlledEvaluationCase(result.exported,{id:fixture.id});
  const selected=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
    representation:'explicit',seed:17,request:cohort.request});
  assert.equal(selected.failure,null);assert.deepEqual(selected.outcome,cohort.expected);
  assert.deepEqual(selected.outcome.cleanup,{pendingEffects:0,pendingJobs:0,openHandlers:0});
});

test('root return preserves a native listener until a later owned callback closes its registration',async()=>{
  let callback;const calls=[],writes=[];
  const {bundle,progress}=await executeWithNativeServices({entry:{functionName:'run',
    text:'"use strict";async function run(){const token=await host.listen("tick",n=>{host.store("event",n);host.unlisten(token);});return 4;}'},
    services:{
      'demo.listen':({args})=>{calls.push('listen');callback=args[1];setImmediate(()=>callback(7));return 'native:1';},
      'demo.store':({args})=>{writes.push(args);},
      'demo.unlisten':({args})=>{calls.push('close:'+args[0]);}
    }});
  assert.equal(progress.kind,'terminated');assert.deepEqual(calls,['listen','close:native:1']);
  assert.deepEqual(writes,[['event',7]]);
  const arrival=bundle.events.find(event=>event.operation==='external.callback.enqueue');
  const returned=bundle.events.find(event=>event.operation==='call.return'&&
    event.invocationId===bundle.initialState.control.a0.activeFrameId);
  assert(returned&&arrival.sequence>returned.sequence,'outside event follows the original returned call');
  assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
  const selected=compileEffectfulWitness(bundle).exported.public.timeline;
  const rootEnd=selected.find(item=>item.kind==='semantic'&&item.invocationId==='invocation1'&&
    item.line.startsWith('end '));
  const event=selected.find(item=>item.kind==='event');
  assert(rootEnd&&event.sequence>rootEnd.sequence,'source projection retains the completed owner for later events');
  assert.deepEqual(calls,['listen','close:native:1'],'replay does not dispatch listeners again');
  assert.throws(()=>callback(8),/no longer active/);
});

test('one closure reused by two subscriptions retains the exact registration and close ownership',async()=>{
  const callbacks=new Map();
  const {bundle}=await executeWithNativeServices({entry:{functionName:'run',
    text:'"use strict";async function run(){let seen=0;function tick(n){seen+=n;}const first=await host.listen("first",tick);const second=await host.listen("second",tick);await host.readAsync("events");await host.unlisten(first);await host.unlisten(second);return seen;}'},
    services:{
      'demo.listen':({args})=>{callbacks.set(args[0],args[1]);return args[0]+':1';},
      'demo.readAsync':()=>{callbacks.get('second')(3);callbacks.get('first')(2);},
      'demo.unlisten':()=>undefined
    }});
  const episode=compileEffectfulWitness(bundle).exported;
  assert.deepEqual(episode.public.timeline.filter(item=>item.kind==='event').map(item=>item.subscriptionId),
    ['callback2','callback1']);
  assert.deepEqual(episode.public.timeline.filter(item=>item.kind==='handler-close').map(item=>item.subscriptionId),
    ['callback1','callback2']);
  const callbacksInSource=bundle.events.filter(item=>item.operation==='external.callback.enqueue')
    .map(item=>item.stateChanges[0].after.queue.at(-1));
  assert.equal(callbacksInSource[0].functionId,callbacksInSource[1].functionId);
  assert.notEqual(callbacksInSource[0].effectId,callbacksInSource[1].effectId);
});

test('unsubscribe cancels queued arrivals, refuses stale callbacks and independently checks exact ownership',()=>{
  const runtime=createRuntime();
  const source=runtime.registerSource({text:'"use strict";async function run(){const token=await host.listen("tick",n=>{host.store("event",n);});await host.unlisten(token);return 1;}',trainingProfile:true});
  runtime.startEntry({source,functionName:'run',allowAsync:true,allowHost:true});
  runtime.drive();
  const registration=Object.values(runtime.state.effects)[0];
  deliver(runtime,registration,'native:1');runtime.drive();
  const close=Object.values(runtime.state.effects).find(effect=>effect.operation==='demo.unlisten');
  runtime.recordExternalCallback({effectId:registration.id,callbackId:registration.args[1][1],args:[2]});
  assert.equal(runtime.state.control.a0.queue.filter(job=>job.kind==='external-callback').length,1);
  deliver(runtime,close,undefined);
  assert(!runtime.state.control.a0.queue.some(job=>job.kind==='external-callback'));
  const before=runtime.events.length;
  assert.throws(()=>runtime.recordExternalCallback({effectId:registration.id,callbackId:registration.args[1][1],args:[3]}),/active subscription/);
  assert.equal(runtime.events.length,before);assert.equal(runtime.drive().kind,'terminated');
  const bundle=runtime.exportRun();assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
  const projected=compileEffectfulWitness(bundle).exported;
  const closed=projected.public.timeline.find(item=>item.kind==='handler-close');
  assert.deepEqual(closed.discarded,['teacherevent1']);
  assert.equal(projected.public.timeline.filter(item=>item.kind==='event').length,0);
  const forged=structuredClone(bundle);
  const mutation=forged.events.find(event=>event.operation==='external.input.deliver'&&effectCause(event)===close.id)
    .stateChanges.find(change=>change.table==='effects'&&change.id===registration.id);
  mutation.after.subscription.closedBy=registration.id;
  assert.throws(()=>validateHostJournal(forged,fail),/foreign or inconsistent/);
  const creation=structuredClone(bundle);
  creation.events.find(event=>event.operation==='call.enter'&&effectCause(event)===registration.id)
    .stateChanges.find(change=>change.table==='effects').after.subscription.state='active';
  assert.throws(()=>validateHostJournal(creation,fail),/declared callback lifetime/);
});

test('rejected unsubscribe retains the callback lifetime and rejected registration never opens it',()=>{
  const runtime=createRuntime().start('async function run(){const token=await host.listen("tick",function(n){});try{await host.unlisten(token);}catch(error){}await host.unlisten(token);}run();');
  runtime.drive();const registration=Object.values(runtime.state.effects)[0];
  deliver(runtime,registration,'native:1');runtime.drive();
  const firstClose=Object.values(runtime.state.effects).find(effect=>effect.operation==='demo.unlisten');
  deliver(runtime,firstClose,'retry',true);
  assert.equal(runtime.state.effects[registration.id].subscription.state,'active');
  runtime.recordExternalCallback({effectId:registration.id,callbackId:registration.args[1][1],args:[3]});runtime.drive();
  const nextClose=Object.values(runtime.state.effects).find(effect=>effect.operation==='demo.unlisten'&&effect.id!==firstClose.id);
  deliver(runtime,nextClose,undefined);assert.equal(runtime.drive().kind,'terminated');
  assert.equal(validateBundle(runtime.exportRun()).valid,true);assert.equal(replayExact(runtime.exportRun()).valid,true);

  const rejected=createRuntime().start('async function run(){try{await host.listen("tick",function(n){});}catch(error){}}run();');
  rejected.drive();const failed=Object.values(rejected.state.effects)[0];deliver(rejected,failed,'denied',true);
  assert.equal(rejected.state.effects[failed.id].subscription.state,'closed');
  assert.throws(()=>rejected.recordExternalCallback({effectId:failed.id,callbackId:failed.args[1][1],args:[]}),/active subscription/);
  assert.equal(rejected.drive().kind,'terminated');assert.equal(replayExact(rejected.exportRun()).valid,true);
});

test('cancellation and abnormal collection failure release the native subscription owner',async()=>{
  const abort=new AbortController();let callback,released=0;
  await assert.rejects(executeWithNativeServices({entry:{functionName:'run',
    text:'"use strict";async function run(){await host.listen("tick",n=>{});return 1;}'},signal:abort.signal,
    services:{'demo.listen':({args,signal})=>{callback=args[1];signal.addEventListener('abort',()=>released++,{once:true});
      setImmediate(()=>abort.abort(new Error('owner cancelled')));return 'native:1';}}}),/owner cancelled/);
  assert.equal(released,1);assert.throws(()=>callback(1),/no longer active/);
  let abnormalReleased=0;
  await assert.rejects(executeWithNativeServices({entry:{functionName:'run',
    text:'"use strict";async function run(){await host.listen("tick",n=>{});while(true){};}'},maxSteps:150,
    services:{'demo.listen':({signal})=>{signal.addEventListener('abort',()=>abnormalReleased++,{once:true});return 'native:2';}}}),/step|budget|limit/i);
  assert.equal(abnormalReleased,1);
});
