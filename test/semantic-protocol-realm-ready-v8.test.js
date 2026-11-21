import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const source='"use strict";function run(){return host.readAsync("shared");}function callback(){}function reaction(value){}';
const step=(h,owner,kind,fields)=>h.select(owner,{kind,fields});
const create=(h,owner,promise)=>step(h,owner,'promise',{action:'create',promise});
const wait=(h,owner,promise,continuation)=>step(h,owner,'await',{invocation:owner,promise,continuation});
const resume=(h,owner,continuation,value)=>step(h,owner,'resume',
  {invocation:owner,continuation,status:'fulfilled',result:['num',value]});
const react=(h,owner,job,closure)=>step(h,owner,'promise',
  {action:'react',promise:'shared',job,reaction:'then',...(closure?{closure}:{})});
const job=(h,owner,action,identity)=>step(h,owner,'job',{action,job:identity,owner});
function join(h,owner,result,identity){
  create(h,owner,result);
  h.select(owner,{kind:'promise.join',mode:'all',result,inputs:['shared'],jobs:[identity],output:null,error:null});
}
const finishJoin=(h,owner,result,identity,output)=>h.select(owner,encodeProtocolRecordV8(
  {kind:'promise.join.step',result,job:identity,entry:null,output,error:null,status:'fulfilled',value:['ref',output]}));

function fresh(){
  const h=new RegionExecutionHarness({sessionId:'realm-readiness',automaticDelivery:false});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'t',realmId:'r',triggerId:'root'});
  for(const name of ['callback','reaction'])step(h,'root','allocate',
    {name,kind:'closure',code:name,properties:[],captures:[]});
  create(h,'root','gate');create(h,'root','blocked');
  const [site]=h.controller.callSites.keys(),[start,end]=site.split(':').map(Number);
  step(h,'root','request',{invocation:'root',effect:'effect',operation:'demo.readAsync',
    site:{start,end},arguments:[['str','shared']],payload:'["shared"]',promise:'shared'});
  h.importObserved({mode:'observed',kind:'dispatch',fields:{session:'realm-readiness',track:'t',
    invocationId:'root',effectId:'effect',key:'root/effect',attempt:1}});
  return h;
}
function callback(h){
  h.admitInvocation({programId:'p',invocationId:'callbackowner',trackId:'t',realmId:'r',
    triggerId:'callback',realmPolicy:'retained',activation:'callback',closureId:'callback',
    parentInvocationId:'root'});
}
function settle(h){h.deliverResult('root','effect',{status:'fulfilled',result:['num',7]});}
function sharedWave(){
  const h=fresh();react(h,'root','rootreaction');wait(h,'root','gate','rootgate');
  callback(h);join(h,'callbackowner','callbackresult','callbackjoin');
  react(h,'callbackowner','callbackreaction','reaction');
  step(h,'callbackowner','promise',{action:'resolve',promise:'gate',value:['num',0]});
  wait(h,'callbackowner','shared','callbackawait');
  resume(h,'root','rootgate',0);join(h,'root','rootresult','rootjoin');
  job(h,'root','enqueue','before');wait(h,'root','shared','rootawait');
  settle(h);return h;
}
function ready(h){return [...h.invocations].flatMap(([owner,{controller:c}])=>c.ready.map(identity=>({
  owner,identity,sequence:(c.continuations.get(identity)??c.jobs.get(identity)).readySequence
}))).sort((a,b)=>a.sequence-b.sequence);}
function boundary(h){
  const {integrity,...packet}=h.checkpoint();
  // Rejection audit entries may grow; every operational field and public row
  // must remain exactly at its committed boundary.
  delete packet.selected.integrity;delete packet.selected.rejections;return packet;
}
function unchanged(h,action,pattern){const before=boundary(h);assert.throws(action,pattern);assert.deepEqual(boundary(h),before);}

test('one observed settlement publishes retained join, reaction and await waiters in registration order',()=>{
  const h=sharedWave();
  assert.deepEqual(ready(h),[
    {owner:'root',identity:'before',sequence:2},
    {owner:'root',identity:'rootreaction',sequence:3},
    {owner:'callbackowner',identity:'callbackjoin',sequence:4},
    {owner:'callbackowner',identity:'callbackreaction',sequence:5},
    {owner:'callbackowner',identity:'callbackawait',sequence:6},
    {owner:'root',identity:'rootjoin',sequence:7},
    {owner:'root',identity:'rootawait',sequence:8}
  ]);
  assert.deepEqual(h.realms.get('r').scheduler,{registration:7,ready:8});
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  assert.deepEqual(ready(restored),ready(h));
  for(const [owner,{controller}]of h.invocations){
    const restoredController=restored.invocations.get(owner).controller;
    assert.deepEqual(sharedRegionState(restoredController),sharedRegionState(controller));
    assert.equal(restoredController.heap,restored.realms.get('r').heap);
    assert.equal(restoredController.scheduler,restored.realms.get('r').scheduler);
  }
});

test('retained scheduler dispatch, join and resume obey one global turn and preserve rejected boundaries',()=>{
  const h=sharedWave();
  unchanged(h,()=>finishJoin(h,'callbackowner','callbackresult','callbackjoin','callbackoutput'),/global ready order/);
  unchanged(h,()=>step(h,'root','job',{action:'dispatch',job:'before',owner:'callbackowner'}),/owner mismatch/i);
  job(h,'root','dispatch','before');job(h,'root','complete','before');
  unchanged(h,()=>resume(h,'callbackowner','callbackawait',7),/continuation guard/);
  job(h,'root','dispatch','rootreaction');job(h,'root','complete','rootreaction');
  unchanged(h,()=>finishJoin(h,'root','callbackresult','callbackjoin','forgedoutput'),/global ready order|another invocation/);
  finishJoin(h,'callbackowner','callbackresult','callbackjoin','callbackoutput');
  job(h,'callbackowner','dispatch','callbackreaction');
  unchanged(h,()=>finishJoin(h,'root','rootresult','rootjoin','rootoutput'),/active realm turn/);
  step(h,'callbackowner','return',{invocation:'job:callbackreaction',value:['num',8]});
  job(h,'callbackowner','complete','callbackreaction');resume(h,'callbackowner','callbackawait',7);
  unchanged(h,()=>finishJoin(h,'root','rootresult','rootjoin','rootoutput'),/active realm turn/);
  step(h,'callbackowner','return',{value:['num',7]});step(h,'callbackowner','end',{kind:'return'});
  finishJoin(h,'root','rootresult','rootjoin','rootoutput');resume(h,'root','rootawait',7);
  step(h,'root','return',{value:['num',7]});step(h,'root','end',{kind:'return'});
  assert.deepEqual(ready(h),[]);
  assert.deepEqual(h.controller.heap.get('callbackoutput').properties.get('0'),['num',7]);
  assert.deepEqual(h.controller.heap.get('rootoutput').properties.get('0'),['num',7]);
  assert.deepEqual(RegionExecutionHarness.replay(h.exportEpisode()).exportEpisode(),h.exportEpisode());
});

test('a returned callback job keeps its realm turn until the explicit job completion',()=>{
  const h=fresh();wait(h,'root','gate','rootgate');callback(h);
  react(h,'callbackowner','callbackreaction','reaction');
  step(h,'callbackowner','promise',{action:'resolve',promise:'gate',value:['num',0]});
  wait(h,'callbackowner','blocked','callbackblocked');resume(h,'root','rootgate',0);
  wait(h,'root','shared','rootawait');settle(h);
  unchanged(h,()=>resume(h,'root','rootawait',7),/global ready order/);
  job(h,'callbackowner','dispatch','callbackreaction');
  step(h,'callbackowner','return',{invocation:'job:callbackreaction',value:['num',8]});
  assert.equal(h.invocations.get('callbackowner').controller.activeJob,'callbackreaction');
  unchanged(h,()=>resume(h,'root','rootawait',7),/unfinished|active.*job|active.*turn/i);
  job(h,'callbackowner','complete','callbackreaction');resume(h,'root','rootawait',7);
});
