import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceClaimCoordinatorV8,immutableSourceDataV8} from '../src/semantic/source-claim-coordinator-v8.js';

const component=(id,claim,prepare=(_,input)=>({input}))=>({id,claims:{event:claim},prepare:{event:prepare}});
const slot=id=>({id,kind:'event',input:{operation:id}});
test('source ownership resolves every claim before preparation and does not depend on registry order',()=>{
  const calls=[],components=[component('base',(_,input)=>input.operation==='ordinary',(_,input)=>{calls.push('base');return input;}),
    component('join',(_,input)=>input.operation==='join',(_,input)=>{calls.push('join');return input;})],
    input={view:{event:{id:'current'},state:{counter:0}},slots:[slot('ordinary'),slot('join')]};
  const first=createSourceClaimCoordinatorV8(components).plan(input);
  assert.deepEqual(createSourceClaimCoordinatorV8([...components].reverse()).plan(input),first);
  assert.deepEqual(first.map(row=>row.owner),['base','join']);
  assert.deepEqual(calls,['base','join','base','join']);
  calls.length=0;
  assert.throws(()=>createSourceClaimCoordinatorV8([...components,component('duplicate',()=>true)])
    .plan(input),/ambiguous owner/);
  assert.deepEqual(calls,[]);
  assert.throws(()=>createSourceClaimCoordinatorV8(components).plan({...input,slots:[slot('ordinary'),slot('unknown')]}),/missing owner/);
  assert.deepEqual(calls,[]);
});
test('claimed but unprepared slots and mutable claim data are rejected',()=>{
  for(const value of [false,null,undefined])assert.throws(()=>createSourceClaimCoordinatorV8([
    component('base',()=>true,()=>value)]).plan({view:{},slots:[slot('ordinary')]}),/no prepared transition/);
  const view={state:{ready:[1]}};
  assert.throws(()=>createSourceClaimCoordinatorV8([component('base',view=>{
    view.state.ready.push(2);return true;
  })]).plan({view,slots:[slot('ordinary')]}),/extensible|read only|frozen/);
  assert.deepEqual(view,{state:{ready:[1]}});
  for(const value of [new Map(),new Set(),{get state(){throw new Error('must not execute');}}, {emit(){}}])
    assert.throws(()=>immutableSourceDataV8(value),/plain data|accessors/);
});
test('value, allocation, event and every frame-exit slot resolve before any preparation',()=>{
  const slots=[{id:'operand',kind:'value',input:{owner:'value'}},{id:'array',kind:'allocation',input:{owner:'allocation'}},
    {id:'transition',kind:'event',input:{owner:'event'}},{id:'helper',kind:'completion',input:{owner:'helper'}},
    {id:'executor',kind:'completion',input:{owner:'executor'}}],prepared=[],
    owners=slots.map(slot=>({id:slot.input.owner,claims:{[slot.kind]:(_view,input)=>input.owner===slot.input.owner},
      prepare:{[slot.kind]:(_view,input)=>{prepared.push(input.owner);return {owner:input.owner};}}}));
  const plan=createSourceClaimCoordinatorV8(owners).plan({view:{},slots});
  assert.deepEqual(plan.map(item=>item.owner),['value','allocation','event','helper','executor']);
  assert.deepEqual(prepared,['value','allocation','event','helper','executor']);
  for(const omitted of owners){
    prepared.length=0;
    assert.throws(()=>createSourceClaimCoordinatorV8(owners.filter(owner=>owner!==omitted)).plan({view:{},slots}),/missing owner/);
    assert.deepEqual(prepared,[]);
  }
  for(const claimed of [undefined,null,1,'yes',{}]){
    assert.throws(()=>createSourceClaimCoordinatorV8([component('bad',()=>claimed)])
      .plan({view:{},slots:[slot('current')]}),/claim must return a boolean/);
  }
});

test('claim data and registry inspection reject transparent proxies and accessors without executing them',()=>{
  let called=0;
  const proxy=new Proxy({state:1},{getPrototypeOf(){called++;return Object.prototype;},
    ownKeys(){called++;return ['state'];},getOwnPropertyDescriptor(){called++;return {value:1,enumerable:true,configurable:true};}});
  assert.throws(()=>immutableSourceDataV8(proxy),/plain data/);
  assert.throws(()=>createSourceClaimCoordinatorV8([proxy]),/ordinary data record/);
  assert.throws(()=>createSourceClaimCoordinatorV8([{get id(){called++;return 'bad';}}]),/accessors/);
  assert.throws(()=>createSourceClaimCoordinatorV8([component('ordinary',()=>true),
    {id:{toString(){called++;return 'coerced';}}}]),/identities/);
  const coordinator=createSourceClaimCoordinatorV8([component('ordinary',()=>true)]);
  assert.throws(()=>coordinator.plan({view:{},slots:[{get id(){called++;return 'current';},kind:'event',input:{}}]}),/accessors/);
  assert.throws(()=>coordinator.plan(new Proxy({view:{},slots:[]},{get(){called++;throw Error('must not run');}})),/plain data/);
  assert.equal(called,0);
});

test('a registered ownership policy cannot be changed through caller-owned component objects',()=>{
  const owner=component('ordinary',()=>true,()=>({kind:'original'})),coordinator=createSourceClaimCoordinatorV8([owner]);
  owner.id='different';owner.claims.event=()=>false;owner.prepare.event=()=>({kind:'substitute'});
  assert.deepEqual(coordinator.ids,['ordinary']);
  assert.deepEqual(coordinator.plan({view:{},slots:[slot('current')]}).map(({owner,prepared})=>({owner,prepared})),
    [{owner:'ordinary',prepared:{kind:'original'}}]);
});
