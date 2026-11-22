import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';

const detail=(h,kind,fields)=>h.select('invocation1',encodeDetailedRecord({kind,fields},{role:'generated'}));
const select=(h,record)=>h.select('invocation1',encodeProtocolRecordV8(record));
const call=(h,mode,value)=>select(h,{kind:'promise.resolver.call',resolver:['ref','p1'+mode],value});
const enqueue=(h)=>select(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p2',job:'adopt1'});
const enter=(h)=>select(h,{kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'adopt1',forwarding:'forward1'});
const forward=(h,status='fulfilled',value=['num',8])=>select(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status,value});
const finish=h=>select(h,{kind:'promise.executor.finish',promise:'p1',invocation:'guest1',completion:{kind:'return',value:['undefined']}});
const rootReturn=h=>detail(h,'return',{invocation:'invocation1',value:['ref','p1']});
function recordingHarness(record){
  const h=new RegionExecutionHarness({automaticDelivery:false});
  if(record){h.selectedContexts=[];const original=h.select.bind(h);
    h.select=(owner,line,options)=>{const context=h.modelContext(owner),result=original(owner,line,options);
      h.selectedContexts.push(context);return result;};}
  return h;
}
function setup({settled=false,record=false}={}){
  const h=recordingHarness(record);
  h.publishProgram({programId:'program1',source:'"use strict";function run(){return 0;}function executor(resolve,reject){}',entry:'run',capabilities:[]});
  h.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'adoption',
    inputGraph:{roots:[],objects:[]},realmPolicy:'fresh'});
  detail(h,'allocate',{name:'o1',kind:'closure',code:'executor',captures:[],properties:[]});
  for(const promise of ['p1','p2','p3'])detail(h,'promise',{action:'create',promise});
  if(settled)detail(h,'promise',{action:'resolve',promise:'p2',value:['num',8]});
  select(h,{kind:'promise.executor.enter',promise:'p1',executor:['ref','o1'],child:'guest1',resolve:'p1resolve',reject:'p1reject'});
  return h;
}
function roundtrip(h){const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(h.controller));return restored;}
function refuses(h,record,pattern){const before=sharedRegionState(h.controller);
  assert.throws(()=>select(h,record),pattern);assert.deepEqual(sharedRegionState(h.controller),before);}
function complete(h,job){detail(h,'job',{action:'dispatch',job,owner:'invocation1'});detail(h,'job',{action:'complete',job,owner:'invocation1'});}

test('settled target still requires the separate assimilation and forwarding FIFO turns',()=>{
  let h=setup({settled:true});call(h,'resolve',['ref','p2']);h=roundtrip(h);
  assert.equal(h.controller.protocol.promiseExecutors.capabilities[0].called,true);
  assert.equal(h.controller.heap.get('p1').state,'pending');
  refuses(h,{kind:'bind',name:'interleaved',value:['num',1]},/guard/);
  refuses(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p3',job:'wrong'},/guard/);
  refuses(h,{kind:'promise.adopt.enqueue',promise:'p3',target:'p2',job:'wrong'},/guard/);
  enqueue(h);h=roundtrip(h);call(h,'reject',['num',91]);call(h,'resolve',['num',92]);finish(h);
  detail(h,'job',{action:'enqueue',job:'competitor',owner:'invocation1'});rootReturn(h);
  enter(h);h=roundtrip(h);assert.deepEqual(h.controller.ready,['competitor','forward1']);
  assert.equal(h.controller.heap.get('p1').state,'pending');
  refuses(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'fulfilled',value:['num',8]},/FIFO/);
  complete(h,'competitor');forward(h);roundtrip(h);
  assert.deepEqual(h.controller.heap.get('p1').result,['num',8]);
  assert.deepEqual([...h.controller.jobs].map(([id,job])=>[id,job.status]),[
    ['adopt1','completed'],['competitor','completed'],['forward1','completed']]);
});
test('pending target registration preserves prior source reactions and microtasks ahead of forwarding',()=>{
  let h=setup();call(h,'resolve',['ref','p2']);enqueue(h);
  detail(h,'promise',{action:'react',promise:'p2',job:'direct',reaction:'then'});
  detail(h,'promise',{action:'resolve',promise:'p2',value:['num',8]});
  detail(h,'job',{action:'enqueue',job:'microtask',owner:'invocation1'});finish(h);rootReturn(h);enter(h);h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['direct','microtask','forward1']);
  complete(h,'direct');complete(h,'microtask');forward(h);roundtrip(h);
});
test('forwarding registered before target settlement waits through JSON restoration',()=>{
  let h=setup();call(h,'resolve',['ref','p2']);enqueue(h);
  detail(h,'job',{action:'enqueue',job:'settler',owner:'invocation1',closure:'o1'});
  finish(h);rootReturn(h);enter(h);h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['settler']);assert.equal(h.controller.jobs.get('forward1').status,'waiting');
  refuses(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'fulfilled',value:['num',8]},/FIFO/);
  detail(h,'job',{action:'dispatch',job:'settler',owner:'invocation1'});
  detail(h,'promise',{action:'resolve',promise:'p2',value:['num',8]});
  detail(h,'return',{invocation:'job:settler',value:['undefined']});
  detail(h,'job',{action:'complete',job:'settler',owner:'invocation1'});h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['forward1']);forward(h);roundtrip(h);
});
test('rejected adoption forwards an opaque Promise-valued reason without assimilating it',()=>{
  let h=setup();detail(h,'promise',{action:'reject',promise:'p2',value:['ref','p3']});
  call(h,'resolve',['ref','p2']);enqueue(h);finish(h);rootReturn(h);enter(h);
  forward(h,'rejected',['ref','p3']);h=roundtrip(h);
  assert.equal(h.controller.heap.get('p1').state,'rejected');assert.deepEqual(h.controller.heap.get('p1').result,['ref','p3']);
  assert.equal(h.controller.heap.get('p3').state,'pending');
});
test('direct self resolution rejects with its source error without enqueuing either job',()=>{
  let h=setup();
  call(h,'resolve',['ref','p1']);h=roundtrip(h);
  refuses(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p1',job:'self-job'},/distinct/);
  refuses(h,{kind:'promise.adopt.self',promise:'p1',error:'o1'},/duplicate|fresh/);
  select(h,{kind:'promise.adopt.self',promise:'p1',error:'error1'});finish(h);h=roundtrip(h);
  assert.equal(h.controller.jobs.size,0);assert.deepEqual(h.controller.heap.get('p1').result,['ref','error1']);
  detail(h,'write',{object:'error1',key:'name',value:['str','changed'],present:true});roundtrip(h);
});
test('distinct mutually adopting Promises remain pending without fabricating a cycle rejection',()=>{
  let h=setup();call(h,'resolve',['ref','p2']);enqueue(h);finish(h);
  select(h,{kind:'promise.adopt.enqueue',promise:'p2',target:'p1',job:'adopt2'});rootReturn(h);enter(h);
  select(h,{kind:'promise.adopt.enter',promise:'p2',target:'p1',job:'adopt2',forwarding:'forward2'});h=roundtrip(h);
  assert.deepEqual(h.controller.ready,[]);
  assert.equal(h.controller.heap.get('p1').state,'pending');assert.equal(h.controller.heap.get('p2').state,'pending');
  assert.equal(h.controller.jobs.get('forward1').status,'waiting');assert.equal(h.controller.jobs.get('forward2').status,'waiting');
  assert.throws(()=>detail(h,'end',{kind:'return'}),/pending|incomplete/i);
});
for(const [name,mutate]of [
  ['own data then',node=>node.properties.set('then',['ref','o1'])],
  ['own accessor then',node=>node.descriptors=new Map([['then',{kind:'accessor',get:['ref','o1'],set:['undefined'],enumerable:true,configurable:true}]])],
  ['custom prototype',node=>node.prototype=['ref','o1']],
  ['null prototype',node=>node.prototype=null],
  ['external Promise',node=>node.external='effect1']
])test('intrinsic Promise adoption refuses '+name+' before consuming the resolving cell',()=>{
  const h=setup();mutate(h.controller.heap.get('p2'));const before=sharedRegionState(h.controller);
  assert.throws(()=>call(h,'resolve',['ref','p2']),/intrinsic then|internal Promise/);
  assert.deepEqual(sharedRegionState(h.controller),before);
  assert.equal(h.controller.protocol.promiseExecutors.capabilities[0].called,false);
});
test('forged adoption owner, source, FIFO identity and settlement cannot mutate the public machine',()=>{
  const h=setup({settled:true});call(h,'resolve',['ref','p2']);enqueue(h);finish(h);rootReturn(h);
  for(const record of [
    {kind:'promise.adopt.enter',promise:'p1',target:'p3',job:'adopt1',forwarding:'forward1'},
    {kind:'promise.adopt.enter',promise:'p3',target:'p2',job:'adopt1',forwarding:'forward1'},
    {kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'p2',forwarding:'forward1'},
    {kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'adopt1',forwarding:'adopt1'}
  ])refuses(h,record);
  const before=sharedRegionState(h.controller);
  assert.throws(()=>detail(h,'job',{action:'dispatch',job:'adopt1',owner:'invocation1'}),/guard/);
  assert.deepEqual(sharedRegionState(h.controller),before);enter(h);
  for(const record of [
    {kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'rejected',value:['num',8]},
    {kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'fulfilled',value:['num',9]},
    {kind:'promise.adopt.forward',promise:'p1',target:'p3',job:'forward1',status:'fulfilled',value:['num',8]}
  ])refuses(h,record);
});
test('malformed restored adoption state cannot substitute its cause, owner or forwarding dependency',()=>{
  const h=setup({settled:true});call(h,'resolve',['ref','p2']);enqueue(h);finish(h);rootReturn(h);enter(h);
  for(const mutate of [
    c=>c.heap.get('p1').adoption.owner='another-owner',
    c=>{Object.assign(c.heap.get('p1').adoption,{owner:'another-owner',phase:'intent',job:null,forwarding:null});c.jobs.clear();c.ready=[];},
    c=>c.heap.get('p1').adoption.target='p3',
    c=>c.heap.get('p1').adoption.cause={kind:'source'},
    c=>c.heap.get('p1').adoption.cause.resolver='p1reject',
    c=>c.heap.get('p1').adoption.phase='completed',
    c=>c.heap.get('p1').adoption.forwarding='adopt1',
    c=>c.jobs.get('forward1').promise='p3',
    c=>c.jobs.get('forward1').owner='another-owner',
    c=>c.jobs.get('forward1').status='waiting',
    c=>c.ready.splice(0),
    c=>c.jobs.get('forward1').sequence=999999,
    c=>c.jobs.get('adopt1').closure='o1',
    c=>c.jobs.get('adopt1').extra=null,
    c=>c.jobs.get('forward1').extra=null
  ]){
    const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
    for(const key of ['heap','protocol','jobs','ready','scheduler'])c[key]=structuredClone(c[key]);mutate(c);
    assert.throws(()=>restoreProtocolStateV8(c,c.protocol));
  }
});
test('typed adoption forwarding cannot overtake another invocation in the shared realm FIFO',()=>{
  const h=asyncSetup({record:true});enqueue(h);rootReturn(h);
  h.admitInvocation({programId:'program1',invocationId:'invocation2',trackId:'worker2',realmId:'realm1',triggerId:'other',
    inputGraph:{roots:[],objects:[]},realmPolicy:'retained'});
  const other=(kind,fields)=>h.select('invocation2',encodeDetailedRecord({kind,fields},{role:'generated'}));
  h.select('invocation2',encodeProtocolRecordV8({kind:'bind',name:'secondOwner',value:['num',2]}));
  other('job',{action:'enqueue',job:'otherfirst',owner:'invocation2'});
  other('return',{invocation:'invocation2',value:['num',0]});enter(h);
  const before=[...h.invocations].map(([identity,row])=>[identity,sharedRegionState(row.controller)]);
  assert.throws(()=>forward(h),/global ready order/);
  assert.deepEqual([...h.invocations].map(([identity,row])=>[identity,sharedRegionState(row.controller)]),before);
  other('job',{action:'dispatch',job:'otherfirst',owner:'invocation2'});
  other('job',{action:'complete',job:'otherfirst',owner:'invocation2'});forward(h);
  detail(h,'end',{kind:'return'});other('end',{kind:'return'});
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  for(const [identity,row]of h.invocations)assert.deepEqual(sharedRegionState(restored.invocations.get(identity).controller),sharedRegionState(row.controller));
  if(process.env.MEGATOKEN_ROOT){
    const data={artifact:{public:h.exportEpisode(),contexts:h.selectedContexts},
      states:[...h.invocations].map(([owner,row])=>[owner,sharedRegionState(row.controller)])};
    if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'promise-adoption-shared-realm-public.json'),JSON.stringify(data));
    const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
data=json.load(sys.stdin)
receipt=validate_v8_artifact(data['artifact'])
assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
for owner,expected in data['states']:
    state=_replay_shared_state(data['artifact']['public']['timeline'],data['artifact']['contexts'],{},roundtrip=True,boundary_invocation=owner)['state']
    assert state==expected,owner
print(json.dumps({'owners':len(data['states']),'contexts':len(data['artifact']['contexts'])}))
`;
    const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
      env:{...process.env,PYTHONPATH:join(root,'src')},encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
      input:JSON.stringify(data)});
    assert.equal(result.status,0,result.stderr||String(result.error));assert.equal(JSON.parse(result.stdout).owners,2);
  }
});

// These async cases retain the distinct ordering and restore assertions from
// the earlier async-only proposal, using the shared Promise resolution records.
function asyncSetup({settled=true,completed=true,record=false}={}){
  const h=recordingHarness(record);
  h.publishProgram({programId:'program1',source:'"use strict";async function helper(){return 1;}function run(){}',entry:'run',capabilities:[]});
  h.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'async-adoption',
    inputGraph:{roots:[],objects:[]},realmPolicy:'fresh'});
  detail(h,'allocate',{name:'helper',kind:'closure',code:'helper',captures:[],properties:[]});
  for(const promise of ['p1','p2','p3'])detail(h,'promise',{action:'create',promise});
  if(settled)detail(h,'promise',{action:'resolve',promise:'p2',value:['num',8]});
  select(h,{kind:'async.function',object:'helper'});
  select(h,{kind:'async.call',promise:'p1',child:'body1',callee:['ref','helper'],receiver:['undefined'],arguments:[]});
  if(completed)select(h,{kind:'async.complete',promise:'p1',invocation:'body1',completion:{kind:'return',value:['ref','p2']}});
  return h;
}
test('async adoption readies result reactions before a later await after both FIFO turns',()=>{
  let h=asyncSetup();h=roundtrip(h);enqueue(h);
  detail(h,'promise',{action:'react',promise:'p1',job:'resultreaction',reaction:'then'});
  detail(h,'promise',{action:'react',promise:'p2',job:'directreaction',reaction:'then'});
  detail(h,'job',{action:'enqueue',job:'microtask',owner:'invocation1'});
  detail(h,'await',{invocation:'invocation1',promise:'p1',continuation:'c1'});
  assert.deepEqual(h.controller.ready,['adopt1','directreaction','microtask']);enter(h);h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['directreaction','microtask','forward1']);
  complete(h,'directreaction');complete(h,'microtask');forward(h);h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['resultreaction','c1']);
  assert.deepEqual(h.controller.heap.get('p1').asyncCall.completion,{kind:'return',value:['ref','p2']});
  assert.deepEqual(h.controller.heap.get('p1').result,['num',8]);
  complete(h,'resultreaction');detail(h,'resume',{invocation:'invocation1',continuation:'c1',status:'fulfilled',result:['num',8]});
  detail(h,'return',{invocation:'invocation1',value:['num',8]});roundtrip(h);
});
test('async adoption waits for a later target settlement and preserves registration order',()=>{
  let h=asyncSetup({settled:false});enqueue(h);
  detail(h,'allocate',{name:'settler',kind:'closure',code:'run',captures:[],properties:[]});
  detail(h,'promise',{action:'react',promise:'p2',job:'directreaction',reaction:'then'});
  detail(h,'promise',{action:'react',promise:'p1',job:'resultreaction',reaction:'then'});
  detail(h,'job',{action:'enqueue',job:'settlement',owner:'invocation1',closure:'settler'});
  detail(h,'await',{invocation:'invocation1',promise:'p1',continuation:'c1'});enter(h);h=roundtrip(h);
  assert.equal(h.controller.jobs.get('forward1').status,'waiting');
  detail(h,'job',{action:'dispatch',job:'settlement',owner:'invocation1'});
  detail(h,'promise',{action:'resolve',promise:'p2',value:['num',8]});
  detail(h,'return',{invocation:'job:settlement',value:['undefined']});
  detail(h,'job',{action:'complete',job:'settlement',owner:'invocation1'});h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['directreaction','forward1']);complete(h,'directreaction');forward(h);h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['resultreaction','c1']);
});
test('async completion and its adoption cannot substitute the body, target or settlement turn',()=>{
  const h=asyncSetup({completed:false});
  refuses(h,{kind:'async.complete',promise:'p1',invocation:'body2',completion:{kind:'return',value:['ref','p2']}});
  select(h,{kind:'async.complete',promise:'p1',invocation:'body1',completion:{kind:'return',value:['ref','p2']}});
  refuses(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p3',job:'wrong'});enqueue(h);
  detail(h,'await',{invocation:'invocation1',promise:'p1',continuation:'c1'});
  refuses(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'fulfilled',value:['num',8]});
  for(const fields of [
    {kind:'job',fields:{action:'dispatch',job:'adopt1',owner:'invocation1'}},
    {kind:'promise',fields:{action:'resolve',promise:'p1',value:['num',8]}}
  ]){const before=sharedRegionState(h.controller);assert.throws(()=>detail(h,fields.kind,fields.fields),/guard/);
    assert.deepEqual(sharedRegionState(h.controller),before);}
  enter(h);
  for(const [status,value]of [['rejected',['num',8]],['fulfilled',['num',99]]])
    refuses(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status,value});
});
test('restored async adoption binds its original body and completion through the settled result',()=>{
  let h=asyncSetup();h=roundtrip(h);enqueue(h);h=roundtrip(h);
  detail(h,'await',{invocation:'invocation1',promise:'p1',continuation:'c1'});enter(h);h=roundtrip(h);forward(h);h=roundtrip(h);
  for(const mutate of [
    c=>c.heap.get('p1').adoption.cause.invocation='body2',
    c=>c.heap.get('p1').adoption.owner='another-owner',
    c=>c.heap.get('p1').asyncCall.invocation='body2',
    c=>c.heap.get('p1').asyncCall.owner='another-owner',
    c=>c.heap.get('p1').asyncCall.completion.value=['num',8],
    c=>c.heap.get('p1').asyncCall.completion.value=['ref','p3'],
    c=>c.heap.get('p1').asyncCall.phase='running'
  ]){const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
    for(const key of ['heap','protocol','jobs','ready','scheduler'])c[key]=structuredClone(c[key]);mutate(c);
    assert.throws(()=>restoreProtocolStateV8(c,c.protocol));}
});
test('async throws preserve an owned Promise as an opaque rejection across restoration',()=>{
  let h=asyncSetup({completed:false});
  select(h,{kind:'async.complete',promise:'p1',invocation:'body1',completion:{kind:'throw',value:['ref','p2']}});
  h=roundtrip(h);
  const rejected=h.controller.heap.get('p1');
  assert.equal(rejected.state,'rejected');assert.deepEqual(rejected.result,['ref','p2']);
  assert.equal(rejected.adoption??null,null);assert.equal(h.controller.jobs.size,0);
  refuses(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p2',job:'invented-adoption'});
  assert.deepEqual(h.controller.heap.get('p2').result,['num',8]);
});
test('async forwarding identities cannot collide with ordinary jobs or another adopter',()=>{
  let h=asyncSetup();enqueue(h);
  detail(h,'job',{action:'enqueue',job:'ordinary',owner:'invocation1'});
  select(h,{kind:'async.call',promise:'p3',child:'body2',callee:['ref','helper'],receiver:['undefined'],arguments:[]});
  select(h,{kind:'async.complete',promise:'p3',invocation:'body2',completion:{kind:'return',value:['ref','p2']}});
  select(h,{kind:'promise.adopt.enqueue',promise:'p3',target:'p2',job:'adopt2'});rootReturn(h);
  assert.deepEqual(h.controller.ready,['adopt1','ordinary','adopt2']);
  for(const forwarding of ['ordinary','adopt2','adopt1'])
    refuses(h,{kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'adopt1',forwarding});
  enter(h);h=roundtrip(h);complete(h,'ordinary');
  refuses(h,{kind:'promise.adopt.enter',promise:'p3',target:'p2',job:'adopt2',forwarding:'forward1'});
  select(h,{kind:'promise.adopt.enter',promise:'p3',target:'p2',job:'adopt2',forwarding:'forward2'});h=roundtrip(h);
  assert.deepEqual(h.controller.ready,['forward1','forward2']);
  assert.equal(h.controller.heap.get('p1').adoption.forwarding,'forward1');
  assert.equal(h.controller.heap.get('p3').adoption.forwarding,'forward2');
});
