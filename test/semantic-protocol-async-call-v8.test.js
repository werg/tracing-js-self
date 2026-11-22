import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const source='"use strict";async function helper(){return 1;}function run(){}';
function fixture({settled=true,complete=true}={}){
  const harness=new RegionExecutionHarness({automaticDelivery:false});
  harness.publishProgram({programId:'program1',source,entry:'run',capabilities:[]});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'async-resolution-test',inputGraph:{roots:[],objects:[]},realmPolicy:'fresh'});
  const detail=(kind,fields)=>harness.select('invocation1',encodeDetailedRecord({kind,fields},{role:'generated'})),
    protocol=record=>harness.select('invocation1',encodeProtocolRecordV8(record));
  detail('allocate',{name:'helper',kind:'closure',code:'helper',captures:[],properties:[]});
  detail('promise',{action:'create',promise:'p1'});detail('promise',{action:'create',promise:'p2'});
  detail('promise',{action:'create',promise:'p3'});detail('promise',{action:'create',promise:'p4'});
  if(settled)detail('promise',{action:'resolve',promise:'p2',value:['num',1]});
  protocol({kind:'async.function',object:'helper'});
  protocol({kind:'async.call',promise:'p1',child:'outer-body',callee:['ref','helper'],receiver:['undefined'],arguments:[]});
  if(complete)protocol({kind:'async.complete',promise:'p1',invocation:'outer-body',
    completion:{kind:'return',value:['ref','p2']}});
  return {harness,detail,protocol};
}
const enqueue=(protocol,job='j1',settlementJob='j2')=>protocol({kind:'async.resolve.enqueue',
  promise:'p1',invocation:'outer-body',target:'p2',job,settlementJob});
const subscribe=(protocol,job='j1',settlementJob='j2')=>protocol({kind:'async.resolve.subscribe',
  promise:'p1',invocation:'outer-body',target:'p2',job,settlementJob});
const settle=(protocol,job='j2',status='fulfilled',value=['num',1])=>protocol({kind:'async.resolve.settle',
  promise:'p1',invocation:'outer-body',target:'p2',job,status,value});
const dispatchComplete=(detail,job)=>{
  detail('job',{action:'dispatch',job,owner:'invocation1'});
  detail('job',{action:'complete',job,owner:'invocation1'});
};

test('owned async Promise return uses separate FIFO enqueue, subscription, and settlement turns',()=>{
  const {harness,detail,protocol}=fixture();enqueue(protocol);
  assert.equal(harness.controller.heap.get('p1').state,'pending');
  detail('promise',{action:'react',promise:'p1',job:'j3',reaction:'then'});
  detail('promise',{action:'react',promise:'p2',job:'j4',reaction:'then'});
  detail('job',{action:'enqueue',job:'j5',owner:'invocation1'});
  detail('await',{invocation:'invocation1',promise:'p1',continuation:'c1'});
  assert.deepEqual(harness.controller.ready,['j1','j4','j5']);
  subscribe(protocol);
  assert.equal(harness.controller.heap.get('p1').state,'pending');
  assert.deepEqual(harness.controller.ready,['j4','j5','j2']);
  dispatchComplete(detail,'j4');dispatchComplete(detail,'j5');
  assert.deepEqual(harness.controller.ready,['j2']);
  settle(protocol);
  assert.equal(harness.controller.heap.get('p1').state,'fulfilled');
  assert.deepEqual(harness.controller.heap.get('p1').result,['num',1]);
  assert.deepEqual(harness.controller.ready,['j3','c1']);
  dispatchComplete(detail,'j3');
  const state=sharedRegionState(harness.controller),restored=RegionExecutionHarness.restore(
    JSON.parse(JSON.stringify(harness.checkpoint())));
  assert.deepEqual(sharedRegionState(restored.controller),state);
  assert.equal(restored.controller.heap.get('p1').asyncCall.resolution.phase,'settled');
});

test('pending target subscribes first and schedules settlement with competing Promise jobs',()=>{
  const {harness,detail,protocol}=fixture({settled:false});enqueue(protocol);
  detail('promise',{action:'react',promise:'p2',job:'j3',reaction:'then'});
  detail('promise',{action:'react',promise:'p1',job:'j4',reaction:'then'});
  detail('await',{invocation:'invocation1',promise:'p1',continuation:'c1'});
  subscribe(protocol);
  assert.equal(harness.controller.jobs.get('j2').status,'waiting');
  assert.deepEqual(harness.controller.ready,[]);
  detail('promise',{action:'resolve',promise:'p2',value:['num',7]});
  assert.deepEqual(harness.controller.ready,['j3','j2']);
  dispatchComplete(detail,'j3');
  assert.deepEqual(harness.controller.ready,['j2']);
  settle(protocol,'j2','fulfilled',['num',7]);
  assert.deepEqual(harness.controller.ready,['j4','c1']);
  assert.equal(harness.controller.heap.get('p1').state,'fulfilled');
  assert.deepEqual(harness.controller.heap.get('p1').result,['num',7]);
});

test('wrong targets, missing turns, FIFO bypasses and self-resolution refuse atomically',()=>{
  {
    const {harness,protocol}=fixture({settled:false,complete:false}),before=sharedRegionState(harness.controller);
    assert.throws(()=>protocol({kind:'async.complete',promise:'p1',invocation:'outer-body',
      completion:{kind:'return',value:['ref','p1']}}),/resolution cycle|distinct owned target/);
    assert.deepEqual(sharedRegionState(harness.controller),before);
  }
  const {harness,detail,protocol}=fixture();
  const afterComplete=sharedRegionState(harness.controller);
  assert.throws(()=>protocol({kind:'async.resolve.enqueue',promise:'p1',invocation:'outer-body',target:'p3',
    job:'bad1',settlementJob:'bad2'}),/exact completed async return/);
  assert.deepEqual(sharedRegionState(harness.controller),afterComplete);
  enqueue(protocol);
  detail('await',{invocation:'invocation1',promise:'p1',continuation:'c1'});
  const queued=sharedRegionState(harness.controller);
  assert.throws(()=>settle(protocol),/subscribed FIFO observer/);
  assert.deepEqual(sharedRegionState(harness.controller),queued);
  assert.throws(()=>detail('job',{action:'dispatch',job:'j1',owner:'invocation1'}),/async-scoped-call/);
  assert.deepEqual(sharedRegionState(harness.controller),queued);
  assert.throws(()=>detail('promise',{action:'resolve',promise:'p1',value:['num',9]}),/async-scoped-call/);
  assert.deepEqual(sharedRegionState(harness.controller),queued);
  subscribe(protocol);
  const subscribed=sharedRegionState(harness.controller);
  for(const record of [
    {kind:'async.resolve.settle',promise:'p1',invocation:'outer-body',target:'p3',job:'j2',status:'fulfilled',value:['num',1]},
    {kind:'async.resolve.settle',promise:'p1',invocation:'outer-body',target:'p2',job:'j1',status:'fulfilled',value:['num',1]},
    {kind:'async.resolve.settle',promise:'p1',invocation:'outer-body',target:'p2',job:'j2',status:'rejected',value:['num',1]},
    {kind:'async.resolve.settle',promise:'p1',invocation:'outer-body',target:'p2',job:'j2',status:'fulfilled',value:['num',99]}
  ]){assert.throws(()=>protocol(record),/settlement requires|exact subscribed FIFO observer/);
    assert.deepEqual(sharedRegionState(harness.controller),subscribed);}
});

test('future settlement identities stay reserved across ordinary jobs and other async returns',()=>{
  const {harness,detail,protocol}=fixture({settled:false});enqueue(protocol);
  const queued=sharedRegionState(harness.controller);
  assert.equal(harness.controller.jobs.get('j2').status,'reserved');
  assert.throws(()=>detail('job',{action:'enqueue',job:'j2',owner:'invocation1'}),/duplicate job|async-scoped-call/);
  assert.deepEqual(sharedRegionState(harness.controller),queued);
  protocol({kind:'async.call',promise:'p3',child:'other-body',callee:['ref','helper'],receiver:['undefined'],arguments:[]});
  protocol({kind:'async.complete',promise:'p3',invocation:'other-body',completion:{kind:'return',value:['ref','p2']}});
  const second=sharedRegionState(harness.controller);
  assert.throws(()=>protocol({kind:'async.resolve.enqueue',promise:'p3',invocation:'other-body',target:'p2',
    job:'j3',settlementJob:'j2'}),/job identities must be fresh/);
  assert.deepEqual(sharedRegionState(harness.controller),second);
  protocol({kind:'async.resolve.enqueue',promise:'p3',invocation:'other-body',target:'p2',job:'j3',settlementJob:'j4'});
  detail('await',{invocation:'invocation1',promise:'p1',continuation:'c1'});
  const reservation=harness.controller.jobs.get('j2');
  harness.controller.jobs.set('j2',{...reservation,reaction:'unrelated'});
  const forged=sharedRegionState(harness.controller);
  assert.throws(()=>subscribe(protocol),/queued async|assimilation|resolution/);
  assert.deepEqual(sharedRegionState(harness.controller),forged);
  assert.throws(()=>RegionExecutionHarness.restore(JSON.parse(JSON.stringify(harness.checkpoint()))),
    /queued async assimilation|checkpoint differs/);
  assert.deepEqual(sharedRegionState(harness.controller),forged);
  harness.controller.jobs.set('j2',reservation);
  subscribe(protocol);
});

test('throwing an owned Promise preserves it as the rejection reason at restored cuts',()=>{
  const {harness,protocol}=fixture({complete:false});
  protocol({kind:'async.complete',promise:'p1',invocation:'outer-body',
    completion:{kind:'throw',value:['ref','p2']}});
  assert.equal(harness.controller.heap.get('p1').state,'rejected');
  assert.deepEqual(harness.controller.heap.get('p1').result,['ref','p2']);
  assert.equal(harness.controller.heap.get('p1').asyncCall.resolution,null);
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(harness.checkpoint())));
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(harness.controller));
});

test('every retained resolution cut restores its body, observer and job ownership',()=>{
  const {harness,detail,protocol}=fixture({settled:false}),cuts=[];
  const retain=()=>cuts.push({packet:harness.checkpoint(),state:sharedRegionState(harness.controller)});
  enqueue(protocol);detail('await',{invocation:'invocation1',promise:'p1',continuation:'c1'});retain();subscribe(protocol);retain();
  detail('promise',{action:'resolve',promise:'p2',value:['num',1]});retain();settle(protocol);retain();
  for(const {packet,state}of cuts){
    const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(packet)));
    assert.deepEqual(sharedRegionState(restored.controller),state);
  }
});
