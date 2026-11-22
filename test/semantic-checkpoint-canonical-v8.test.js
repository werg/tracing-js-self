import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SelectedExecutionLifecycleV8} from '../src/semantic/lifecycle-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const source='"use strict";function run(){return 1;}';
function lifecycle(){
  const h=new SelectedExecutionLifecycleV8({sessionId:'canonical-checkpoint'});
  h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside'});
  h.selected('call',encodeDetailedRecord({kind:'return',fields:{value:['num',1]}}));
  h.selected('call',encodeDetailedRecord({kind:'end',fields:{kind:'return'}}));
  return h;
}
function reverseKeys(value){
  if(Array.isArray(value))return value.map(reverseKeys);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])]));
  return value;
}
function reseal(packet){const {integrity,...body}=packet;return {...body,integrity:hashAlgorithmData(body)};}

test('canonical JSON and recursively reordered object keys preserve lifecycle checkpoint integrity',()=>{
  const h=lifecycle(),packet=h.checkpoint();
  for(const wire of [stableAlgorithmJSON(packet),JSON.stringify(reverseKeys(packet))]){
    const restored=SelectedExecutionLifecycleV8.restore(JSON.parse(wire));
    assert.deepEqual(restored.timeline,h.timeline);
    assert.deepEqual(restored.invocations.get('call').controller.segmentPacket(),h.invocations.get('call').controller.segmentPacket());
    assert.equal(restored.checkpoint().integrity,packet.integrity);
  }
});

test('a canonical Region checkpoint retains the embedded core checkpoint without resigning either layer',()=>{
  const h=new RegionExecutionHarness({sessionId:'canonical-region'});
  h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside'});
  h.select('call',{kind:'return',fields:{value:['num',1]}});h.select('call',{kind:'end',fields:{kind:'return'}});
  const packet=h.checkpoint(),restored=RegionExecutionHarness.restore(JSON.parse(stableAlgorithmJSON(packet)));
  assert.equal(packet.selected.schema,'semantic-checkpoint/8');
  assert.deepEqual(restored.exportEpisode(),h.exportEpisode());
  assert.equal(restored.checkpoint().selected.integrity,packet.selected.integrity);
});

test('canonical checksums still reject changed values and order, including rehashed private authority changes',()=>{
  const packet=lifecycle().checkpoint(),changed=JSON.parse(stableAlgorithmJSON(packet));
  changed.invocations[0][1].controller.completion.value=['num',99];
  assert.throws(()=>SelectedExecutionLifecycleV8.restore(changed),/integrity/);
  assert.throws(()=>SelectedExecutionLifecycleV8.restore(reseal(changed)),error=>!/integrity/i.test(error.message));
  const reordered=JSON.parse(stableAlgorithmJSON(packet));reordered.timeline.reverse();
  assert.throws(()=>SelectedExecutionLifecycleV8.restore(reordered),/integrity/);
  assert.throws(()=>SelectedExecutionLifecycleV8.restore(reseal(reordered)),error=>!/integrity/i.test(error.message));
});

test('historical insertion-order integrity is refused instead of being silently accepted as canonical',()=>{
  const packet=lifecycle().checkpoint(),{integrity,...body}=packet,
    previous=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  assert.notEqual(previous,integrity);
  assert.throws(()=>SelectedExecutionLifecycleV8.restore({...body,integrity:previous}),/integrity/);
});
