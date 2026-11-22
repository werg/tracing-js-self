import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
const source='"use strict";function run(){return 0;}function executor(resolve,reject){}';
function setup(){
  const h=new RegionExecutionHarness({automaticDelivery:false});
  h.publishProgram({programId:'program1',source,entry:'run',capabilities:[]});
  h.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'executor-test',
    inputGraph:{roots:[],objects:[]},realmPolicy:'fresh'});
  const detail=(kind,fields)=>h.select('invocation1',encodeDetailedRecord({kind,fields},{role:'generated'}));
  detail('allocate',{name:'o1',kind:'closure',code:'executor',captures:[],properties:[]});
  detail('promise',{action:'create',promise:'p1'});detail('promise',{action:'create',promise:'p2'});
  return h;
}
const select=(h,record)=>h.select('invocation1',encodeProtocolRecordV8(record));
const enter=(h)=>select(h,{kind:'promise.executor.enter',promise:'p1',executor:['ref','o1'],child:'guest1',resolve:'p1resolve',reject:'p1reject'});
const call=(h,mode,value)=>select(h,{kind:'promise.resolver.call',resolver:['ref','p1'+mode],value});
const finish=(h,kind='return',value=['undefined'])=>select(h,{kind:'promise.executor.finish',promise:'p1',invocation:'guest1',completion:{kind,value}});

test('executor resolving functions share one first-call cell across exact checkpoints',()=>{
  const h=setup();enter(h);
  const resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  for(const current of [h,resumed]){call(current,'resolve',['num',3]);call(current,'reject',['num',9]);finish(current);}
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(h.controller));
  assert.deepEqual(h.controller.heap.get('p1').result,['num',3]);assert.equal(h.controller.heap.get('p1').state,'fulfilled');
  assert.equal(h.controller.receiver[0],'undefined');assert.equal(h.controller.protocol.callFrames.length,0);
  assert.deepEqual(h.controller.lastReturn,{kind:'return',value:['ref','p1']});
  call(h,'resolve',['num',99]);assert.deepEqual(h.controller.heap.get('p1').result,['num',3]);
});
test('executor throw rejects only before settlement and retained resolving functions remain no-ops afterward',()=>{
  const first=setup();enter(first);finish(first,'throw',['num',7]);
  const capability=structuredClone(first.controller.protocol.promiseExecutors.capabilities[0]);
  assert.equal(capability.called,true);assert.deepEqual(capability.resolution,{mode:'reject',value:['num',7]});
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(first.checkpoint())));
  for(const current of [first,restored]){
    call(current,'resolve',['num',11]);call(current,'reject',['num',12]);
    assert.deepEqual(current.controller.protocol.promiseExecutors.capabilities[0],capability);
  }
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(first.controller));
  assert.equal(first.controller.heap.get('p1').state,'rejected');assert.deepEqual(first.controller.heap.get('p1').result,['num',7]);
  assert.equal(RegionExecutionHarness.restore(first.checkpoint()).controller.heap.get('p1').state,'rejected');
  const settled=setup();enter(settled);call(settled,'resolve',['num',4]);finish(settled,'throw',['num',12]);
  assert.equal(settled.controller.heap.get('p1').state,'fulfilled');assert.deepEqual(settled.controller.heap.get('p1').result,['num',4]);
});
test('restoration rejects invented first-call state after an executor throws',()=>{
  const h=setup();enter(h);finish(h,'throw',['num',7]);
  for(const mutate of [
    c=>{const cap=c.protocol.promiseExecutors.capabilities[0];cap.called=false;cap.resolution=null;},
    c=>{c.protocol.promiseExecutors.capabilities[0].resolution={mode:'resolve',value:['num',11]};},
    c=>{const cap=c.protocol.promiseExecutors.capabilities[0];cap.called=false;cap.resolution=null;
      Object.assign(c.heap.get('p1'),{state:'pending',result:null});}
  ]){
    const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
    for(const key of ['heap','protocol','stack'])c[key]=structuredClone(c[key]);mutate(c);
    assert.throws(()=>restoreProtocolStateV8(c,c.protocol),/first-call state contradicts|must consume its resolving pair/);
  }
});
test('executor adoption consumes its first-call cell and refuses progress until its exact enqueue',()=>{
  for(const settled of [false,true]){
    const h=setup();enter(h);
    if(settled)h.select('invocation1',encodeDetailedRecord({kind:'promise',fields:{action:'resolve',promise:'p2',value:['num',8]}},{role:'generated'}));
    call(h,'resolve',['ref','p2']);assert.equal(h.controller.protocol.promiseExecutors.capabilities[0].called,true);
    const before=sharedRegionState(h.controller);
    assert.throws(()=>finish(h),/guard/);
    assert.deepEqual(sharedRegionState(h.controller),before);
    select(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p2',job:'adopt1'});finish(h);
    assert.equal(h.controller.heap.get('p1').state,'pending');
  }
  const h=setup();enter(h);
  call(h,'resolve',['num',4]);call(h,'resolve',['ref','p2']);finish(h);
  assert.deepEqual(h.controller.heap.get('p1').result,['num',4]);
  assert.deepEqual(RegionExecutionHarness.restore(h.checkpoint()).controller.heap.get('p1').result,['num',4]);
});
test('executor protocol rejects bypasses, stale calls, bad identities and unavailable resolution profiles without mutation',()=>{
  const h=setup();enter(h);
  for(const record of [
    {kind:'promise.resolver.call',resolver:['ref','o1'],value:['num',1]},
    {kind:'promise.adopt.enqueue',promise:'p1',target:'p2',job:'stolen'},
    {kind:'promise.resolver.call',resolver:['ref','p1resolve'],value:['ref','o1']},
    {kind:'return',invocation:'guest1',value:['undefined']},
    {kind:'promise.executor.finish',promise:'p1',invocation:'invocation1',completion:{kind:'return',value:['undefined']}},
    {kind:'property.get',object:'p1resolve',key:['str','name'],receiver:['ref','p1resolve'],result:['undefined']}
  ]){const before=sharedRegionState(h.controller);assert.throws(()=>select(h,record));assert.deepEqual(sharedRegionState(h.controller),before);}
  for(const fields of [{action:'resolve',promise:'p1',value:['num',1]},{action:'adopt',promise:'p1',target:'p2'}]){
    const before=sharedRegionState(h.controller);
    assert.throws(()=>h.select('invocation1',encodeDetailedRecord({kind:'promise',fields},{role:'generated'})),/guard/);
    assert.deepEqual(sharedRegionState(h.controller),before);
  }
  finish(h);const before=sharedRegionState(h.controller);assert.throws(()=>finish(h),/active call/);assert.deepEqual(sharedRegionState(h.controller),before);
});

test('an executor capability cannot be reused as a join result or a generic detailed call',()=>{
  const h=setup();enter(h);finish(h);
  for(const record of [
    {kind:'promise.join',mode:'all',result:'p1',inputs:[],jobs:[],output:'empty',error:null},
    {kind:'promise.join',mode:'race',result:'p1',inputs:['p2'],jobs:['join1'],output:null,error:null}
  ]){const before=sharedRegionState(h.controller);assert.throws(()=>select(h,record),/guard/);
    assert.deepEqual(sharedRegionState(h.controller),before);}
  const before=sharedRegionState(h.controller);
  assert.throws(()=>h.select('invocation1',encodeDetailedRecord({kind:'call',fields:{
    callee:'p1resolve',child:'bypass',arguments:[['num',8]],receiver:['undefined']}},{role:'generated'})),/scoped call/);
  assert.deepEqual(sharedRegionState(h.controller),before);
  // A capability remains a valid join input; only ownership of its settlement
  // is reserved for the resolving functions.
  select(h,{kind:'promise.join',mode:'race',result:'p2',inputs:['p1'],jobs:['join2'],output:null,error:null});
  call(h,'resolve',['num',7]);assert.deepEqual(h.controller.ready,['join2']);
});

test('generator executors refuse before allocating a resolving pair or entering the body',()=>{
  const h=setup();h.controller.heap.get('o1').generatorFunction=true;
  const before=sharedRegionState(h.controller);
  assert.throws(()=>enter(h),/synchronous source closure/);
  assert.deepEqual(sharedRegionState(h.controller),before);
  assert.equal(h.controller.heap.has('p1resolve'),false);
  assert.equal(h.controller.stack.length,1);
});
test('restoration rejects dangling executor frames, altered resolver metadata and contradictory first-call state',()=>{
  const h=setup();enter(h);call(h,'resolve',['num',2]);
  for(const mutate of [
    c=>c.protocol.promiseExecutors.capabilities[0].called=false,
    c=>{c.protocol.promiseExecutors.capabilities[0].called=false;c.protocol.promiseExecutors.capabilities[0].resolution=null;},
    c=>c.heap.get('p1resolve').promiseResolver.promise='p2',
    c=>c.protocol.promiseExecutors.executors[0].parent='missing',
    c=>c.protocol.promiseExecutors.executors[0].promise=[],
    c=>c.protocol.callFrames[0].arguments.reverse(),
    c=>c.stack.pop(),
    c=>c.protocol.promiseExecutors.capabilities.push(structuredClone(c.protocol.promiseExecutors.capabilities[0]))
  ]){const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
    for(const key of ['heap','protocol','stack'])c[key]=structuredClone(c[key]);mutate(c);
    assert.throws(()=>restoreProtocolStateV8(c,c.protocol));}
});

test('restoration rejects an executor capability claiming independent join ownership',()=>{
  const h=setup();enter(h);finish(h);
  const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
  for(const key of ['heap','protocol','stack'])c[key]=structuredClone(c[key]);
  c.heap.get('p1').join={schema:'semantic-promise-join-state/1',owner:c.rootInvocation,mode:'race',inputs:[],jobs:[],
    observed:[],values:[],output:null,error:null,settled:false};
  assert.throws(()=>restoreProtocolStateV8(c,c.protocol),/capability cannot own a join/);
});

test('restoration cannot invent adopted or object-valued executor resolution',()=>{
  for(const value of [['ref','p2'],['ref','o1']]){
    const h=setup();enter(h);call(h,'resolve',['num',2]);finish(h);
    const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
    for(const key of ['heap','protocol','stack'])c[key]=structuredClone(c[key]);
    c.protocol.promiseExecutors.capabilities[0].resolution.value=value;
    if(value[1]==='p2')Object.assign(c.heap.get('p1'),{adopted:'p2',state:'pending',result:null});
    else c.heap.get('p1').result=value;
    assert.throws(()=>restoreProtocolStateV8(c,c.protocol),/first-call state contradicts/);
  }
});

test('reaction completion cannot implicitly adopt a returned Promise without assimilation jobs',()=>{
  const h=setup();enter(h);call(h,'resolve',['num',2]);finish(h);
  const detail=(kind,fields)=>h.select('invocation1',encodeDetailedRecord({kind,fields},{role:'generated'}));
  detail('promise',{action:'react',promise:'p2',job:'reaction1',reaction:'then',target:'p3',closure:'o1'});
  detail('promise',{action:'resolve',promise:'p2',value:['num',3]});
  detail('return',{value:['undefined'],invocation:'invocation1'});
  detail('job',{action:'dispatch',job:'reaction1',owner:'invocation1'});
  detail('return',{value:['ref','p1'],invocation:'job:reaction1'});
  const before=sharedRegionState(h.controller);
  assert.throws(()=>detail('job',{action:'complete',job:'reaction1',owner:'invocation1'}),/adoption.*job protocol/);
  assert.deepEqual(sharedRegionState(h.controller),before);
  assert.equal(h.controller.jobs.get('reaction1').status,'running');
  assert.equal(h.controller.heap.get('p3').state,'pending');
});
