import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const fixture=body=>({source:'"use strict";function run(x){'+body+'}',entry:'run',args:[4],family:'issue51-symbol-composition'});
const unique='const a=Symbol("same"),b=Symbol("same");const p=Promise.resolve(x);p[a]=1;p[b]=2;'+
  'const k={[Symbol.toPrimitive](){return a;}};return [a===b,Reflect.has(p,k),Reflect.deleteProperty(p,k),a in p,b in p];';
async function checked(body,expected){
  const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const artifact=result.exported,harness=RegionExecutionHarness.replay(artifact);
  assert.deepEqual(harness.controller.materialize(harness.controller.completion.value),expected);
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.status,'agreed');
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
  return artifact;
}
test('Promise property conversion preserves two fresh Symbols with identical descriptions',async()=>{
  await checked(unique,[false,true,true,false,true]);
});
test('registered Symbols share identity across Promise reflection and preserve registry key',async()=>{
  await checked('const a=Symbol.for("same"),b=Symbol.for("same");const p=Promise.resolve(x);p[a]=1;'+
    'return [a===b,Symbol.keyFor(a),Reflect.has(p,b),Reflect.deleteProperty(p,b),a in p];',[true,'same',true,true,false]);
});
test('captured fresh Symbol survives ordinary helper return inside Promise source',async()=>{
  await checked('const a=Symbol("x");const p=Promise.resolve(x);p[a]=1;function key(){return a;}'+
    'return [Reflect.has(p,key()),Reflect.deleteProperty(p,key()),a in p];',[true,true,false]);
});
test('restored Symbol conversion refuses another live identity atomically',async()=>{
  const artifact=await checked(unique,[false,true,true,false,true]),timeline=artifact.public.timeline;
  const at=timeline.findIndex(row=>row.fields.line?.includes('"kind":"conversion.finish"'));
  assert(at>0);
  const prefix={...artifact.public,timeline:timeline.slice(0,at)},
    harness=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(RegionExecutionHarness.replay(prefix,{requireTerminal:false}).checkpoint()))),
    original=decodeProtocolRecordV8(timeline[at].fields.line),before=sharedRegionState(harness.controller),
    other=harness.controller.protocol.symbols.find(row=>row.kind==='unique'&&row.id!==original.result[1]);
  assert(other);
  assert.throws(()=>harness.select(timeline[at].fields.invocationId,
    encodeProtocolRecordV8({...original,result:['symbol',other.id]})));
  assert.deepEqual(sharedRegionState(harness.controller),before);
  for(const row of timeline.slice(at))harness.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(harness.controller),sharedRegionState(RegionExecutionHarness.replay(artifact).controller));
});
test('shadowed Symbol source calls keep their actual function and original arguments',async()=>{
  await checked('const Symbol=function(value){return value+"!";};const p=Promise.resolve(x);const key=Symbol("x");'+
    'p[key]=1;return [key,Reflect.has(p,key)];',['x!',true]);
});
test('effectful Symbol descriptions retain an explicit unsupported conversion boundary',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture('const p=Promise.resolve(x);const a=Symbol({toString(){return "x";}});return a in p;'));
  assert(!result.exported);assert.match(result.reason,/conversion|coercion|profile|unsupported/i);
});
