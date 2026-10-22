import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const value=(r,key)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([name])=>name===key)?.[1]?.token?.value;
function check(source){
  const runtime=createRuntime().start(source);
  assert.equal(runtime.drive().kind,'terminated');
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return {runtime,bundle};
}
test('Object.create walks inherited data and preserves own shadowing',()=>{
  const {runtime,bundle}=check(`let p={x:7};let c=Object.create(p);
    let inherited=c.x;c.x=12;let own=c.x;let original=p.x;`);
  assert.deepEqual(value(runtime,'inherited'),['num',7]);
  assert.deepEqual(value(runtime,'own'),['num',12]);
  assert.deepEqual(value(runtime,'original'),['num',7]);
  assert(bundle.events.some(e=>e.operation==='property.read'&&
    e.readObservations.some(o=>o.key==='x'&&!o.present&&o.value[1]===7)));
});
test('inherited methods receive child receiver and are replayed as guest calls',()=>{
  const {runtime}=check(`function read(){return this.x+1;}
    let p={read:read};let c=Object.create(p);c.x=9;
    let answer=c.read();`);
  assert.deepEqual(value(runtime,'answer'),['num',10]);
});
test('Object.setPrototypeOf and getPrototypeOf operate on owned identities',()=>{
  const {runtime}=check(`let p={a:2};let o={};
    let before=o.a;Object.setPrototypeOf(o,p);
    let after=o.a;let same=Object.getPrototypeOf(o)===p;`);
  assert.deepEqual(value(runtime,'before'),['undefined']);
  assert.deepEqual(value(runtime,'after'),['num',2]);
  assert.deepEqual(value(runtime,'same'),['bool',true]);
});
test('null prototype has no default Object methods',()=>{
  const {runtime}=check(`let o=Object.create(null);let absent=o.toString;
    let absentValue=o.valueOf;`);
  assert.deepEqual(value(runtime,'absent'),['undefined']);
  assert.deepEqual(value(runtime,'absentValue'),['undefined']);
});
test('inherited valueOf executes owned coercion with the original this receiver',()=>{
  const {runtime,bundle}=check(`function value(){return this.x;}
    let p={valueOf:value};let o=Object.create(p);o.x=8;
    let result=o+2;`);
  assert.deepEqual(value(runtime,'result'),['num',10]);
  assert(bundle.events.some(e=>e.operation==='spec.internal.get'&&
    e.readObservations[0]?.key==='valueOf'&&
    e.readObservations[0]?.present===false));
});
test('cyclic prototype mutation throws a catchable guest TypeError',()=>{
  const {runtime}=check(`let a={};let b={};Object.setPrototypeOf(a,b);
    let error='';try{Object.setPrototypeOf(b,a);}catch(e){error=e.name;}`);
  assert.deepEqual(value(runtime,'error'),['str','TypeError']);
});
test('a forged inherited method producer/version is rejected',()=>{
  const {bundle}=check(`function value(){return 7;}
    let p={valueOf:value};let o=Object.create(p);let result=o+1;`);
  const tampered=structuredClone(bundle);
  const read=tampered.events.find(e=>e.operation==='spec.internal.get'&&
    e.readObservations[0]?.key==='valueOf'&&!e.readObservations[0].present);
  assert(read);
  read.readObservations[0].supplyingEvent='a0:e1000000';
  assert.throws(()=>validateBundle(tampered),/method\/provenance mismatch/);
});
