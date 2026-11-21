import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedProtocolQualificationFixtures} from '../fixtures/semantic-regions/qualification.js';

async function checked(body){
  const result=await verifyProtocolRegionTrainingCase({source:'"use strict";function run(){'+body+'}',
    entry:'run',args:[],family:'live-array-map-source',timeoutMs:30000});
  assert(result.exported,result.reason);
  assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.status,'agreed');
  return result.exported;
}

test('sparse map distinguishes holes from undefined and preserves its original length',async()=>{
  for(const body of [
    'let calls=0;const output=[,undefined,,3,].map((value,index)=>{calls++;return index;});return [output,calls];',
    'let calls=0;const output=[,,,].map(()=>{calls++;return 9;});return [output,calls];',
    'const output=[,,2,,].map(value=>value+1);return output;',
    'const output=[,,,].map(function*(){yield 1;});return output;'
  ]){
    const artifact=await checked(body);
    assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
    assert(artifact.public.timeline.some(row=>row.fields.line?.includes('"kind":"property.hasOwn"')));
  }
});

test('map reads live values, observes filled holes and ignores elements beyond the captured length',async()=>{
  for(const body of [
    'const input=[1,,3];let calls=0;const output=input.map((value,index,array)=>{calls++;if(index===0){array[1]=7;array[2]=8;array.push(9);}return value+index;});return [input,output,calls];',
    'const input=[1,2,3];let calls=0;const output=input.map((value,index,array)=>{calls++;if(index===0){array.length=1;}return value;});return [input,output,calls];',
    'const input=[1,2,3];const output=input.map((value,index,array)=>{if(index===0){array.pop();array[1]=undefined;}return value;});return [input,output];',
    'const input=[1,2];const output=input.map((value,index,array)=>{array.push(value+9);return [value,index,array.length];});return [input,output];',
    'const input=[1,,3];const output=input.map((value,index,array)=>{return [value].map(inner=>{if(index===0)array[1]=5;return inner+1;})[0];});return [input,output];'
  ])await checked(body);
});

test('a saved map continuation retains live mutation and rejects a fabricated hole transactionally',async()=>{
  const artifact=await checked('const input=[1,2,3];const output=input.map((value,index,array)=>{if(index===0)array.length=1;return value;});return output;'),
    timeline=artifact.public.timeline,cut=timeline.findIndex(row=>row.kind==='protocol'&&
      decodeProtocolRecordV8(row.fields.line).kind==='property.hasOwn');
  assert(cut>0);
  const prefix={...artifact.public,timeline:timeline.slice(0,cut)},
    paused=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(paused.checkpoint()))),
    before=sharedRegionState(restored.controller),hole=decodeProtocolRecordV8(timeline[cut].fields.line);
  assert.throws(()=>restored.select(timeline[cut].fields.invocationId,
    encodeProtocolRecordV8({...hole,result:['bool',true]})),/false own-property result/);
  assert.deepEqual(sharedRegionState(restored.controller),before);
  for(const row of timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(RegionExecutionHarness.replay(artifact).controller));
});

test('recurring sparse and Promise-map sources retain fresh source and checkpoint correspondence',async()=>{
  for(const id of ['map-sparse-live-mutation','promise-map-sparse-truncate']){
    const fixture=sharedProtocolQualificationFixtures().find(row=>row.id===id),
      result=await verifyProtocolRegionTrainingCase({...fixture,timeoutMs:30000});
    assert(result.exported,result.reason);
    assert.equal((await recheckProtocolRegionEvidence(result.exported)).valid,true);
    const complete=RegionExecutionHarness.replay(result.exported),
      restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(complete.checkpoint())));
    assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(complete.controller));
  }
});
