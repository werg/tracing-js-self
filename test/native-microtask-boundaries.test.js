import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {createRuntime} from '../src/runtime.js';
import {createFixtureBroker,canonicalFixturePlan} from '../src/training/fixture-broker.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {independentEffectfulReference,independentSemanticChecks} from '../src/semantic/source-reference.js';
import {realizeGraph} from '../src/training/graph.js';
import {describeCompletionGraph} from '../src/training/exception-profile.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const wire=value=>JSON.parse(JSON.stringify(value));
async function differential(source,plan,expected){
  const fixture=canonicalFixturePlan(plan),broker=createFixtureBroker(fixture);
  const run=await executeWithNativeServices({entry:{text:source,functionName:'run'},services:broker.services});
  const runtime=run.runtime,root=runtime.initialState.control.a0.activeFrameId;
  const promise=runtime.state.promises[runtime.initialState.frames[root].asyncPromiseId];
  const value=realizeGraph(runtime.state.heap,[promise.value.value],{exceptionProfile:promise.status==='rejected'})[0];
  assert.deepEqual(value,expected);
  const outcome={kind:promise.status==='rejected'?'throw':'return',
    graph:describeCompletionGraph([],value,promise.status==='rejected'?'throw':'return')};
  const effects=broker.finish(),references=[];
  for(const mode of ['original','operations','branches','completions']){
    const reference=await independentEffectfulReference({source,entry:'run',mode,
      inputGraph:encodeNativeGraph([]),fixture},{timeoutMs:30000});
    assert.deepEqual(reference.outcome,outcome,mode);
    assert.deepEqual(reference.effects,effects,mode);
    assert.deepEqual(reference.callbackFailures,[],mode);
    assert.deepEqual(reference.unhandledRejections,[],mode);
    references.push(reference);
  }
  assert.equal(independentSemanticChecks(run.bundle,source,references[1].operations,
    references[2].decisions,references[3].completions).status,'agreed');
  return run;
}

test('host settlement competes with callback-owned Promise jobs in native microtask order',async()=>{
  for(const wait of [false,true]){
    const source='"use strict";async function run(){let seen=0;'+
      (wait?'let complete;':'')+'await Promise.all([Promise.resolve(1)]);'+
      'await host.withCallback("value",function(n){'+(wait?'complete=':'return ')+
      'Promise.all([Promise.resolve(n).then(x=>x+1),Promise.resolve(2)]).then(function(a){'+
      'seen+=a[0]+a[1];host.store("callback",seen);return seen;});});'+
      (wait?'await complete;':'')+'const b=await Promise.all([Promise.resolve(seen)]);return b[0];}';
    await differential(source,{calls:[
      {operation:'demo.withCallback',arguments:['value',{callback:true}],
        callbacks:[{slot:1,arguments:[3]}]},
      {operation:'demo.store',arguments:['callback',6]}
    ]},wait?6:0);
  }
});

test('queued callbacks stay ahead of descendant microtasks and retain FIFO source completions',async()=>{
  for(const synchronousEffect of [false,true]){
    await differential('"use strict";async function run(){let order="";'+
      'await host.withCallback("ticks",function(n){order+=n;'+
      (synchronousEffect?'host.store("tick",n);':'')+
      'queueMicrotask(function(){order+="q"+n;});});return order;}',{calls:[
      {operation:'demo.withCallback',arguments:['ticks',{callback:true}],
        callbacks:[{slot:1,arguments:[1]},{slot:1,arguments:[2]}]},
      ...(synchronousEffect?[
        {operation:'demo.store',arguments:['tick',1]},
        {operation:'demo.store',arguments:['tick',2]}]:[])
    ]},'12q1q2');
  }
});

test('yielding before a job preserves its queue and an exact resumable open archive',()=>{
  const source='let value=0;Promise.resolve(1).then(function(n){value=n;'+
    'queueMicrotask(function(){value+=2;});});';
  const uninterrupted=createRuntime().start(source);
  assert.equal(uninterrupted.drive().kind,'terminated');
  const yielded=createRuntime().start(source),progress=yielded.drive({yieldBeforeJob:true});
  assert.equal(progress.kind,'yield');
  assert(progress.steps>0);
  assert(yielded.state.control.a0.queue.length>0);
  assert.equal(yielded.chunks.length,0,'a yield is not a sealed wait or completed chunk');
  const saved=wire(Object.fromEntries(Object.entries(yielded).filter(([key])=>key!=='adapters')));
  const restored=Object.assign(createRuntime(),saved);
  assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(wire(restored.exportRun()),wire(uninterrupted.exportRun()));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
});

test('native yields preserve a cumulative work limit and abort unbounded owned microtasks',async()=>{
  await assert.rejects(executeWithNativeServices({maxSteps:150,
    entry:{functionName:'run',text:'"use strict";async function run(){'+
      'function again(){queueMicrotask(again);}queueMicrotask(again);return 1;}'}}),/safety limit/);
  for(const maxSteps of [0,-1,1.5,Infinity])
    await assert.rejects(executeWithNativeServices({text:'let n=1;',maxSteps}),/step budget/);
});
