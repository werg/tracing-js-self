import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const fixture=(body,args=[4])=>({source:'"use strict";function run(x){'+body+'}',entry:'run',args,family:'enumeration-own-keys-source'});
const idiom='const object=Object.create({p:x});object.a=x;return Object.entries(object).map(pair=>pair[0]);';
const mapped='const object=Object.create({p:x});object.a=x;object.b=3;return Object.entries(object).map((pair,i,array)=>pair[1]+i+array.length);';
async function checked(body,args=[4]){
  const result=await verifyProtocolRegionTrainingCase(fixture(body,args));assert(result.exported,result.reason);
  assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.status,'agreed');return result;
}

test('the frozen entries/map idiom qualifies without a new public protocol',async()=>{
  const result=await verifyRegionTrainingCase(fixture(idiom));assert(result.exported,result.reason);
  const artifact=result.exported.sidecar.sourceArtifact.sidecar;
  assert(artifact.compiler.extensions.includes('ordinary-array-map-source/1'));
  const records=artifact.compiler.claims.filter(row=>row.kind==='protocol').map(row=>row.record);
  assert(records.some(row=>row.kind==='property.keys'&&row.mode==='enumerable-strings'));
  assert(records.some(row=>row.kind==='call'&&row.arguments.length===3));
  assert(records.every(row=>!row.kind.startsWith('array.map')));
  const rechecked=await recheckProtocolRegionEvidence(result.exported);assert(rechecked.sourceValidated&&rechecked.replayValidated);
});

test('entries and values retain integer key order, descriptors, symbols and original references',async()=>{
  for(const body of [
    'const object=Object.create({p:x});object.b=x;object[2]=3;object[1]=2;Object.defineProperty(object,"hidden",{value:9,enumerable:false});object[Symbol("s")]=4;return Object.entries(object).map(pair=>pair[0]);',
    'const shared={v:x};const object=Object.create(null);object.a=shared;object.b=shared;const entries=Object.entries(object);return [entries[0][1]===shared,entries[0][1]===entries[1][1],Object.values(object)[0]===shared];',
    'const object=Object.create({get skipped(){throw 9;}});object.a=x;return Object.values(object);',
    'const object=Object.create(null);return Object.entries(object).map(pair=>pair[0]);'
  ])await checked(body);
});

test('map expands every callback with the actual receiver, index, array identity and shared captures',async()=>{
  for(const body of [mapped,
    'const object=Object.create(null);object.a=x;object.b=3;return Object.entries(object).map(function(pair,i,array){return this.n+pair[1]+i+array.length;},{n:2});',
    'const object=Object.create(null);object.a=x;object.b=3;let sum=0;const result=Object.entries(object).map(pair=>{sum+=pair[1];return sum;});return [result,sum];',
    'const object=Object.create(null);object.a=x;object.b=3;return Object.entries(object).map(pair=>[pair[1]].map(value=>value+1)[0]);'
  ])await checked(body);
});

test('a checkpoint between map callbacks retains the shared result and rejects false reads transactionally',async()=>{
  const result=await checked(mapped),timeline=result.exported.public.timeline;
  const callIndices=timeline.flatMap((row,index)=>row.fields.line?.startsWith('protocol ')&&
    decodeProtocolRecordV8(row.fields.line).kind==='call'?[index]:[]);
  assert.equal(callIndices.length,2);
  const cut=callIndices[1]-1,read=decodeProtocolRecordV8(timeline[cut].fields.line);assert.equal(read.kind,'property.get');
  const prefix={...result.exported.public,timeline:timeline.slice(0,cut)},harness=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(harness.checkpoint()))),before=sharedRegionState(restored.controller);
  assert.throws(()=>restored.select('invocation1',encodeProtocolRecordV8({...read,result:['num',999]})),/false property read/);
  assert.deepEqual(sharedRegionState(restored.controller),before);
  for(const row of timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(RegionExecutionHarness.replay(result.exported).controller));
});

test('accessors, sparse inputs, changed species, source mutation and abrupt map callbacks remain explicit refusals',async()=>{
  for(const body of [
    'const object={get a(){return x;}};return Object.entries(object);',
    'const array=[1,,3];return array.map(value=>value);',
    'const array=[1];array.constructor={};return array.map(value=>value);',
    'const object=Object.create(null);object.a=x;return Object.entries(object).map((pair,index,array)=>{array.push(pair);return pair[0];});',
    'const object=Object.create(null);object.a=x;return Object.entries(object).map(pair=>{throw pair[1];});'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.exported,undefined,body);
    assert.notEqual(result.status,'locally_verified');
  }
});
