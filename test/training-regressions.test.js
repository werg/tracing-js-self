import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {causalPrefix} from '../src/causal.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';

test('async returns adopt a fulfilled promise rather than returning its identity',()=>{
  const source='async function a(){return Promise.resolve(3);} async function b(){return await a();} let promise=b();';
  const r=createRuntime().start(source);
  assert.equal(r.drive().kind,'terminated');
  const val=Object.values(r.state.envs).find(e=>e.bindings.promise).bindings.promise.token.value;
  assert.equal(val[0],'promise');
  assert.deepEqual(r.state.promises[val[1]].value.value,['num',3]);
  assert.equal(r.state.promises[val[1]].status,'fulfilled');
  const bundle=r.exportRun();
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});

test('async returns correctly adopt an externally settling pending promise',()=>{
  const source='async function a(){return host.readAsync("A");} let promise=a();';
  const r=createRuntime().start(source);
  assert.equal(r.drive().kind,'waiting');
  const val=Object.values(r.state.envs).find(e=>e.bindings.promise).bindings.promise.token.value;
  const promise=r.state.promises[val[1]];
  assert.equal(promise.status,'pending');
  assert(promise.adopting,'adoption remains pending before external delivery');
  const effect=Object.values(r.state.effects)[0];
  const arrived=r.recordInputArrival({effectId:effect.id,kind:'completion',value:7});
  assert.equal(r.state.promises[val[1]].status,'pending','arrival is private and cannot settle');
  r.deliverInput(arrived.inputId);
  assert.equal(r.drive().kind,'terminated');
  assert.deepEqual(r.state.promises[val[1]].value.value,['num',7]);
  assert.equal(validateBundle(r.exportRun()).valid,true);
  assert.equal(replayExact(r.exportRun()).valid,true);
});

test('historical property reads retain observed values and per-property versions',()=>{
  const r=createRuntime().start('let o={a:1,b:2}; let x=o.a; o.a=9; let y=o.b;');
  assert.equal(r.drive().kind,'terminated');
  const read=r.events.find(e=>e.operation==='property.read');
  assert(read);
  const observation=read.readObservations[0];
  assert.deepEqual(observation.value,['num',1]);
  assert.equal(observation.present,true);
  assert.equal(observation.version,1);
  const obj=r.state.heap[observation.objectId];
  assert.deepEqual(obj.properties.a.value,['num',9]);
  assert.equal(obj.propertyVersions.a,2);
  assert.equal(obj.propertyVersions.b,1,'unrelated mutation does not advance b');
  assert.deepEqual(read.readObservations[0].value,['num',1],'old read must stay immutable');
  assert.equal(replayExact(r.exportRun()).valid,true);
});

test('unstarted registered sources are not published as predictor-visible code',()=>{
  const r=createRuntime();
  r.registerSource({text:'function secret(){return 873239;}',url:'private.js'});
  const entry=r.registerSource({text:'let answer=1;',url:'entry.js'});
  r.start(entry);
  assert.equal(r.drive().kind,'terminated');
  const prefix=causalPrefix(r.exportRun());
  assert.equal(prefix.sources.length,1);
  assert.equal(prefix.sources[0].url,'entry.js');
  assert(!JSON.stringify(prefix).includes('873239'));
  assert.throws(()=>r.registerSource({text:'let later=2;'}),/frozen/);
});

test('bounded array length expansion creates genuine absent slots and verifies against V8',()=>{
  const result=verifyOwnedSourceCase({source:'"use strict"; function run(){const a=[1];a.length=4;return a;}',entry:'run'});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
});
