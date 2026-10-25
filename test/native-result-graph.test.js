import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {validateHostJournal} from '../src/host-journal.js';
import {replayExact} from '../src/replay.js';
import {realizeGraph} from '../src/training/graph.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {compileEffectfulWitness} from '../src/training/effectful-compiler.js';

const fail=message=>{throw new Error(message);};
test('declared native result graphs enter only at delivery and preserve cycles and mutable aliases',async()=>{
  const child={n:3},value={left:child,right:child};value.self=value;
  const source='"use strict";async function run(){const value=await host.natlangCall("graph",null,[]);value.left.n=value.left.n+1;return value;}';
  let calls=0;
  const {bundle}=await executeWithNativeServices({entry:{text:source,functionName:'run'},
    services:{'natlang.call':()=>{calls++;return value;}}});
  const arrival=bundle.events.find(event=>event.operation==='external.input.arrive');
  const delivery=bundle.events.find(event=>event.operation==='external.input.deliver');
  assert.equal(arrival.stateChanges.filter(change=>change.table==='heap').length,0);
  assert.equal(delivery.stateChanges.filter(change=>change.table==='heap').length,2);
  const input=delivery.stateChanges.find(change=>change.table==='inputs').after;
  assert.notDeepEqual(input.value,input.graph.roots[0]);
  const result=realizeGraph(bundle.finalState.heap,[input.value])[0];
  assert.equal(result.self,result);assert.equal(result.left,result.right);assert.equal(result.right.n,4);
  assert.equal(value.left.n,3,'guest mutation must not modify the captured native source graph');
  assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
  assert.equal(calls,1,'replay cannot redispatch native work');

  const changed=structuredClone(bundle);
  const forged=changed.events.find(event=>event.operation==='external.input.deliver');
  forged.stateChanges.find(change=>change.table==='heap'&&change.after.properties.n)
    .after.properties.n.value=['num',900];
  assert.throws(()=>validateHostJournal(changed,fail),/immutable arrival bytes/);
  const identity=structuredClone(bundle);
  identity.events.find(event=>event.operation==='external.input.deliver').stateChanges
    .find(change=>change.table==='inputs').after.graphIdentities[0].target='o1';
  assert.throws(()=>validateHostJournal(identity,fail),/forge owned identities/);
});

test('native graph rejection retains its reason identity through synchronous guest catch',async()=>{
  const reason={detail:'missing'};reason.self=reason;
  const {bundle}=await executeWithNativeServices({entry:{functionName:'run',
    text:'"use strict";function run(){try{return host.natlangCallSync("graph",null,[]);}catch(reason){return reason.self===reason;}}'},
    services:{'natlang.callSync':()=>{throw reason;}}});
  assert.deepEqual(bundle.finalState.control.a0.completion.value,['bool',true]);
  assert.equal(Object.values(bundle.inputs)[0].abrupt,true);
  assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
});

test('graph snapshots refuse accessors and undeclared result codecs before native data enters owned state',async()=>{
  let reads=0;const value={};
  Object.defineProperty(value,'secret',{enumerable:true,get(){reads++;return 1;}});
  const {bundle}=await executeWithNativeServices({entry:{functionName:'run',
    text:'"use strict";async function run(){try{return await host.natlangCall("graph",null,[]);}catch(error){return error;}}'},
    services:{'natlang.call':()=>value}});
  assert.equal(reads,0);assert.equal(Object.values(bundle.inputs)[0].abrupt,true);
  assert.equal(Object.values(bundle.inputs)[0].graph,undefined);
  const runtime=createRuntime().start('host.readAsync("scalar");');runtime.drive();
  const effect=Object.values(runtime.state.effects)[0],before=runtime.events.length;
  assert.throws(()=>runtime.recordInputArrival({effectId:effect.id,kind:'completion',
    graph:{schema:'owned-graph/1',roots:[['null']],objects:[]}}),/no declared result graph/);
  assert.equal(runtime.events.length,before);
});

test('graph-result teacher survives independent source admission and serialized evidence checks',async()=>{
  const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id==='native-result-graph');
  const result=await verifyEffectfulTrainingCase(fixture);
  assert.equal(result.status,'locally_verified',result.reason);
  const receipt=await recheckEffectfulAdmission(JSON.parse(JSON.stringify(result.exported)),{requireAdmitted:false});
  assert.equal(receipt.effectsValidated,true);assert.equal(receipt.sourceValidated,true);
  const observed=result.exported.public.timeline.find(item=>item.kind==='result'&&item.result[0]==='ref');
  assert.match(observed.line,/"graph"/);
  const object=result.exported.sidecar.reference.outcome.graph.objects.find(item=>item.properties.some(([key])=>key==='n'));
  assert.deepEqual(object.properties,[['n',['num',4]]]);
});

test('source-certified checkpoint recovery changes observations without changing semantic selections',async()=>{
  const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id==='checkpoint-source-reread');
  const result=await verifyEffectfulTrainingCase(fixture);
  assert.equal(result.status,'locally_verified',result.reason);
  const episode=result.exported;
  const ordinary=compileEffectfulWitness(episode.sidecar.archive,{sourceLineage:fixture.family});
  const semantic=value=>value.public.timeline.filter(item=>item.kind==='semantic').map(item=>item.line);
  assert.deepEqual(semantic(episode),semantic(ordinary.exported));
  assert.equal(episode.public.timeline.filter(item=>item.kind==='source-evict').length,1);
  assert.equal(episode.public.timeline.filter(item=>item.kind==='source-read').length,1);
  const evidence=episode.sidecar.compiler.checkpoints[0];
  assert.equal(evidence.nativeRedispatches,0);assert.equal(evidence.publicReplayValidated,true);
  assert.equal(evidence.uncertainIntents.length,1);assert.match(evidence.integrity,/^[0-9a-f]{64}$/);
  const recovery=episode.public.timeline.find(item=>item.kind==='reconcile');
  assert.equal(recovery.disposition,'fulfilled');assert.match(recovery.evidenceId,/^owned-delivery:a0:e/);
  assert.equal((await recheckEffectfulAdmission(episode,{requireAdmitted:false})).effectsValidated,true);
  const fresh=compileEffectfulWitness(episode.sidecar.archive,{realmPolicy:'fresh',triggerId:'outside:second'});
  const invocation=fresh.exported.public.timeline.find(item=>item.kind==='invocation');
  assert.equal(invocation.realmPolicy,'fresh');assert.equal(invocation.triggerId,'outside:second');
});
