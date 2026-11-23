import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const U=['undefined'],P=['ref','intrinsicpromise'],ref=id=>['ref',id];
const detail=(h,kind,fields)=>h.select('invocation1',encodeDetailedRecord({kind,fields},{role:'generated'}));
const select=(h,record)=>h.select('invocation1',encodeProtocolRecordV8(record));
const start=h=>select(h,{kind:'promise.adopt.get',promise:'p1',target:'p2',job:'adopt1',child:'gettercall'});
const complete=(h,completion={kind:'return',value:P},forwarding=completion.kind==='throw'?null:'forward1')=>
  select(h,{kind:'promise.adopt.finish',promise:'p1',target:'p2',job:'adopt1',child:'gettercall',completion,forwarding});
function setup({competitor=false,constructorDescriptor=null,getterCaptures=[]}={}){
  const h=new RegionExecutionHarness({automaticDelivery:false});
  h.publishProgram({programId:'program1',source:'"use strict";function run(){return 0;}function getter(){return this;}function helper(){return 9;}',entry:'run',capabilities:[]});
  h.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'adoption-getter',
    inputGraph:{roots:[],objects:[]},realmPolicy:'fresh'});
  for(const promise of ['p1','p2','p3'])detail(h,'promise',{action:'create',promise});
  detail(h,'promise',{action:'resolve',promise:'p2',value:['num',7]});
  select(h,{kind:'promise.intrinsics'});
  for(const [name,code]of [['getter1','getter'],['helper1','helper']])select(h,{kind:'allocate',name,objectKind:'closure',length:null,
    properties:[],code,captures:name==='getter1'?getterCaptures:[],functionKind:'ordinary',lexicalReceiver:null});
  select(h,{kind:'property.define',object:'p2',key:['str','constructor'],success:true,descriptor:constructorDescriptor??
    {kind:'accessor',get:ref('getter1'),set:U,enumerable:false,configurable:true}});
  if(competitor)detail(h,'job',{action:'enqueue',job:'competitor',owner:'invocation1'});
  select(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p2',job:'adopt1'});
  detail(h,'return',{invocation:'invocation1',value:['num',0]});return h;
}
function roundtrip(h){const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(h.controller));return restored;}
function refuses(h,record,pattern){const before=sharedRegionState(h.controller);assert.throws(()=>select(h,record),pattern);
  assert.deepEqual(sharedRegionState(h.controller),before);}
function cloned(h,mutate){const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
  for(const key of ['heap','protocol','jobs','ready','scheduler','stack','locals','frameFunctions','captureAliases','receiver','continuations'])
    c[key]=structuredClone(c[key]);mutate(c);return c;}

test('constructor getters retain exact FIFO job, receiver and nested call scopes until forwarding registration',()=>{
  let h=setup({competitor:true});refuses(h,{kind:'promise.adopt.get',promise:'p1',target:'p2',job:'adopt1',child:'gettercall'},/FIFO|guard/);
  detail(h,'job',{action:'dispatch',job:'competitor',owner:'invocation1'});
  detail(h,'job',{action:'complete',job:'competitor',owner:'invocation1'});
  refuses(h,{kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'adopt1',forwarding:'bypass'},/getter/);
  start(h);h=roundtrip(h);assert.equal(h.controller.activeJob,'adopt1');assert.deepEqual(h.controller.receiver,ref('p2'));
  assert.deepEqual(h.controller.locals.get('gettercall:this'),ref('p2'));
  assert.equal(h.controller.protocol.callFrames.length,0);
  select(h,{kind:'call',child:'helpercall',callee:ref('helper1'),receiver:U,arguments:[]});h=roundtrip(h);
  assert.throws(()=>complete(h),/exact active job/);
  select(h,{kind:'return',invocation:'helpercall',value:['num',9]});
  refuses(h,{kind:'return',invocation:'gettercall',value:P},/guard/);
  assert.throws(()=>detail(h,'return',{invocation:'gettercall',value:P}),/guard/);
  complete(h);h=roundtrip(h);assert.equal(h.controller.activeJob,null);assert.deepEqual(h.controller.receiver,U);
  assert.equal(h.controller.heap.get('p1').state,'pending');assert.deepEqual(h.controller.ready,['forward1']);
  select(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'fulfilled',value:['num',7]});
  h=roundtrip(h);assert.deepEqual(h.controller.heap.get('p1').result,['num',7]);
});

test('adoption getter completion cannot replace its child, owner, target, constructor or required forwarding outcome',()=>{
  const h=setup();start(h);
  const finish={kind:'promise.adopt.finish',promise:'p1',target:'p2',job:'adopt1',child:'gettercall',completion:{kind:'return',value:P},forwarding:'forward1'};
  for(const patch of [{child:'other'},{job:'other'},{promise:'p3'},{target:'p3'},
    {completion:{kind:'return',value:ref('p3')}},{completion:{kind:'return',value:['num',7]}},
    {forwarding:null},{completion:{kind:'throw',value:ref('p3')}}])refuses(h,{...finish,...patch});
  complete(h,{kind:'return',value:U});roundtrip(h);
});

test('a thrown Promise remains an opaque rejection and never creates a forwarding job',()=>{
  let h=setup();start(h);complete(h,{kind:'throw',value:ref('p3')});h=roundtrip(h);
  assert.equal(h.controller.heap.get('p1').state,'rejected');assert.deepEqual(h.controller.heap.get('p1').result,ref('p3'));
  assert.equal(h.controller.heap.get('p3').state,'pending');assert.equal(h.controller.heap.get('p1').adoption.phase,'rejected');
  assert.deepEqual(h.controller.ready,[]);assert.equal(h.controller.jobs.has('forward1'),false);
  refuses(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'fulfilled',value:['num',7]});
  for(const mutate of [c=>{c.jobs.get('adopt1').returned.value=['num',7];},
    c=>{c.heap.get('p1').adoption.forwarding='invented';},c=>{delete c.heap.get('p1').adoption.lookup;}]){
    const controller=cloned(h,mutate);assert.throws(()=>restoreProtocolStateV8(controller,controller.protocol));
  }
});

test('restoration rejects altered active adoption getter ownership and retained caller state',()=>{
  const h=setup();start(h);
  for(const mutate of [
    c=>{c.activeJob=null;},c=>{c.receiver=ref('p3');},c=>{c.locals.set('gettercall:this',ref('p3'));},
    c=>{c.heap.get('p1').adoption.lookup.callee=ref('helper1');},c=>{c.heap.get('p1').adoption.lookup.child='other';},
    c=>{c.jobs.get('adopt1').status='completed';},c=>{c.jobs.get('adopt1').closure='helper1';},
    c=>{c.jobs.get('adopt1').priorAliases=[['wrong','missing-cell']];},c=>{c.ready.push('adopt1');}
  ]){
    const controller=cloned(h,mutate);assert.throws(()=>restoreProtocolStateV8(controller,controller.protocol));
  }
  // The shared heap can retain another invocation's adoption. Its activation
  // is validated by that owner, not against this invocation's local frames.
  const peer=cloned(h,c=>{
    c.rootInvocation='peer';c.frameFunctions=new Map([['peer','run']]);c.locals=new Map();c.stack=['peer'];
    c.jobs=new Map();c.ready=[];c.activeJob=null;c.receiver=U;c.captureAliases=new Map();
  });
  assert.equal(restoreProtocolStateV8(peer,peer.protocol).valid,true);
});

test('atomic adoption requires its actual default data constructor and cannot bypass an observable lookup',()=>{
  const uninitialized=setup({getterCaptures:[{binding:'value',cell:'uninitialized-cell'}]});
  refuses(uninitialized,{kind:'promise.adopt.get',promise:'p1',target:'p2',job:'adopt1',child:'gettercall'},/not initialized/);
  const descriptor=value=>({kind:'data',value,writable:true,enumerable:false,configurable:true});
  const invalid=setup({constructorDescriptor:descriptor(['num',7])});
  refuses(invalid,{kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'adopt1',forwarding:'forward1'},/constructor\/species/);
  refuses(invalid,{kind:'promise.adopt.get',promise:'p1',target:'p2',job:'adopt1',child:'gettercall'},/selected/);
  const valid=setup({constructorDescriptor:descriptor(U)});
  select(valid,{kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'adopt1',forwarding:'forward1'});roundtrip(valid);
});
