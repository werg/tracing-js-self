import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

const source='"use strict";function run(){return;}function handler(value){return value;}';
const select=(h,id,kind,fields)=>h.select(id,{kind,fields});
function fixture({realmPolicy='retained',closure=false,owner=null}={}){
  const h=new RegionExecutionHarness({sessionId:'event-authority',automaticDelivery:false});
  h.publishProgram({programId:'program',source,entry:'run'});
  h.admitInvocation({programId:'program',invocationId:'root',realmId:'realm',trackId:'worker',
    triggerId:'start',realmPolicy:'retained',taskRevision:3});
  if(closure)select(h,'root','allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]});
  select(h,'root','return',{value:['undefined']});select(h,'root','end',{kind:'return'});
  h.registerEventHandler({subscriptionId:'events',programId:'program',realmId:'realm',trackId:'worker',
    entry:'handler',realmPolicy,closureId:closure?'fn':null,ownerInvocationId:owner});
  h.postEvent({subscriptionId:'events',eventId:'first',args:[7],deliver:true});
  const publicData=h.exportEpisode(),event=publicData.timeline.find(row=>row.kind==='event'),
    invocation=publicData.timeline.at(-1);
  return {h,publicData,event,invocation};
}
const prefix=(publicData,count)=>RegionExecutionHarness.replay({...publicData,
  timeline:publicData.timeline.slice(0,count)},{requireTerminal:false});

test('registered deliveries bind retained and fresh event invocations across replay and restore',()=>{
  for(const options of [{},{realmPolicy:'fresh'},{closure:true,owner:'root'}]){
    const {h,publicData,event,invocation}=fixture(options);
    assert.equal(invocation.fields.taskRevision,3);
    assert.equal(invocation.fields.triggerId,'event:events:first');
    assert.equal(invocation.fields.realmId,options.realmPolicy==='fresh'?'realmevent1':'realm');
    const replayed=RegionExecutionHarness.replay(publicData,{requireTerminal:false});
    assert.deepEqual(replayed.exportEpisode(),publicData);
    const interrupted=prefix(publicData,event.sequence);
    const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(interrupted.checkpoint())));
    restored.importObserved(invocation);
    assert.deepEqual(restored.exportEpisode(),h.exportEpisode());
    assert.deepEqual([...restored.invocations.get('event1').controller.locals],
      [...h.invocations.get('event1').controller.locals]);
  }
});

test('forged event routing and event counters refuse before changing subscription state',()=>{
  const {h:original,publicData,event}=fixture();
  for(const [key,value] of [['track','other'],['programId','other'],['realmId','other'],
    ['triggerId','unrelated'],['invocationId','event9'],['invocationId','event01']]){
    const h=prefix(publicData,event.sequence-1),before=h.checkpoint(),changed=structuredClone(event);
    changed.fields[key]=value;
    assert.throws(()=>h.importObserved(changed),/event|delivery|routing/i,key);
    assert.deepEqual(h.checkpoint(),before,key);
    assert.equal(h.handlers.get('events').seen.size,0,key);
    assert.equal(h.inner.nextEventDelivery,0,key);
  }
  const core=prefix(publicData,event.sequence-1).inner,before=core.checkpoint(),
    forged=structuredClone(original.inner.timeline.find(row=>row.kind==='event'));
  forged.eventId='callbackevent9007199254740993';
  forged.triggerId='event:events:'+forged.eventId;
  assert.throws(()=>core.replayRecord(forged),/event sequence/i);
  assert.deepEqual(core.checkpoint(),before,'neutral replay also validates before mutating');
});

test('an event cannot authorize a different callback activation or an intervening public record',()=>{
  const {publicData,event,invocation}=fixture({closure:true,owner:'root'});
  const mutations={
    invocationId:'other',track:'other',programId:'other',realmId:'other',triggerId:'other',
    entry:'run',activation:'call',closureId:null,parentInvocationId:null,realmPolicy:'fresh',
    taskRevision:4,deadline:1e20,receiver:['num',9],bindings:{injected:0},ingressKey:'other'
  };
  for(const [key,value] of Object.entries(mutations)){
    const h=prefix(publicData,event.sequence),before=h.checkpoint(),changed=structuredClone(invocation);
    changed.fields[key]=value;
    assert.throws(()=>h.importObserved(changed),/event|delivery|handler|callback/i,key);
    assert.deepEqual(h.checkpoint(),before,key);
    assert.equal(h.invocations.size,1,key);
  }
  const h=prefix(publicData,event.sequence),before=h.checkpoint();
  const changed={sequence:event.sequence+1,mode:'observed',kind:'handler-close',fields:{
    session:'event-authority',track:'host',subscriptionId:'events',discarded:[]}};
  assert.throws(()=>h.importObserved(changed),/event.*invocation/i);
  assert.deepEqual(h.checkpoint(),before);
});

test('host callback registration refuses unavailable ownership and fresh retained closures atomically',()=>{
  const {publicData,event}=fixture({closure:true,owner:'root'});
  const h=prefix(publicData,event.sequence-2),before=h.checkpoint();
  for(const options of [{ownerInvocationId:'missing'},{ownerInvocationId:'root',trackId:'other'},
    {realmPolicy:'fresh',closureId:'fn'}]){
    assert.throws(()=>h.registerEventHandler({subscriptionId:'different',programId:'program',
      realmId:'realm',trackId:'worker',entry:'handler',...options}),/owner|retained|realm/i);
    assert.deepEqual(h.checkpoint(),before);
  }
});

test('closing a handler retains discarded arrivals in public obligations and refuses false discard claims',()=>{
  const {publicData,event}=fixture();
  const h=prefix(publicData,event.sequence-1);
  h.postEvent({subscriptionId:'events',eventId:'queued',args:[{private:7}],deliver:false});
  h.closeEventHandler('events');
  const closed=h.exportEpisode(),receipt=closed.timeline.at(-1);
  assert.deepEqual(receipt.fields.discarded,['queued']);
  const replayed=RegionExecutionHarness.replay(closed);
  assert.deepEqual(replayed.modelContext('root'),h.modelContext('root'));
  assert.equal(replayed.handlers.get('events').seen.has('queued'),true);
  assert.equal(replayed.handlers.get('events').queue.length,0);
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  assert.deepEqual(restored.modelContext('root'),h.modelContext('root'));
  const waiting=prefix(publicData,event.sequence-1);
  waiting.postEvent({subscriptionId:'events',eventId:'different',args:[8],deliver:false});
  const before=structuredClone([...waiting.handlers]);
  assert.throws(()=>waiting.importObserved(receipt),/retained pending inputs/);
  assert.deepEqual([...waiting.handlers],before);
  for(const discarded of [['queued','queued'],['INVALID']]){
    const forged=structuredClone(closed);forged.timeline.at(-1).fields.discarded=discarded;
    assert.throws(()=>RegionExecutionHarness.replay(forged),/discard/i);
  }
  const delivered=fixture().h;
  select(delivered,'event1','return',{value:['num',7]});select(delivered,'event1','end',{kind:'return'});
  delivered.closeEventHandler('events');
  const forged=delivered.exportEpisode();forged.timeline.at(-1).fields.discarded=['first'];
  assert.throws(()=>RegionExecutionHarness.replay(forged),/already delivered/);
});
