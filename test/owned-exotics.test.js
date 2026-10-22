import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {encode} from '../src/values.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const value=(r,name)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
function compare(source,returnBinding='out'){
  const r=createRuntime().start(source);
  assert.equal(r.drive().kind,'terminated');
  const bundle=JSON.parse(JSON.stringify(r.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  const native=vm.runInNewContext(source+'\n'+returnBinding+';');
  assert.deepEqual(value(r,returnBinding),encode(native),'diverged from independent V8');
  return {r,bundle};
}
test('ordinary own vs inherited data respects a linked prototype',()=>{
  compare(`let parent={x:3};let child=Object.create(parent);
    let a=child.x;child.x=9;let out=a+child.x+parent.x;`);
});
test('Object.setPrototypeOf changes subsequent inherited reads',()=>{
  compare(`let parent={x:4};let child={};let missing=child.x;
    Object.setPrototypeOf(child,parent);let out=child.x;`);
});
test('Object.create(null) does not inherit Object.prototype methods',()=>{
  compare(`let child=Object.create(null);let out=child.toString;`);
});
test('cyclic prototype assignment is a guest TypeError, not an interpreter error',()=>{
  compare(`let a={};let b={};Object.setPrototypeOf(a,b);let out='';
    try{Object.setPrototypeOf(b,a);}catch(e){out=e.name;}`);
});
test('owned getter and setter observe receiver and trace their nested calls',()=>{
  const {bundle}=compare(`let object={saved:2};
    function read(){return this.saved;}
    function write(v){this.saved=v;}
    Object.defineProperty(object,'key',{get:read,set:write});
    let before=object.key;object.key=9;let out=before+object.key;`);
  assert(bundle.events.some(e=>e.operation==='property.read'&&e.causes.some(c=>c.kind==='invocation')));
  assert(bundle.events.some(e=>e.operation==='property.write'&&e.causes.some(c=>c.kind==='invocation')));
});
test('inherited getter executes with child receiver instead of prototype',()=>{
  compare(`function getter(){return this.x;}
    let parent={x:5};Object.defineProperty(parent,'g',{get:getter});
    let child=Object.create(parent);child.x=7;let out=child.g;`);
});
test('getters that return methods preserve the receiver during calls',()=>{
  compare(`function actual(){return this.value;}
    function getter(){return actual;}
    let object={value:13};
    Object.defineProperty(object,'method',{get:getter});
    let out=object.method();`);
});
test('throw from an owned getter reaches a guest catch block',()=>{
  compare(`function fail(){throw 'getter-failure';}
    let object={};Object.defineProperty(object,'x',{get:fail});
    let out='';try{let x=object.x;}catch(e){out=e;}`);
});
test('non-configurable accessor cannot be redefined',()=>{
  compare(`function first(){return 1;}function second(){return 2;}
    let object={};Object.defineProperty(object,'x',{get:first});
    let out='';try{Object.defineProperty(object,'x',{get:second});}
      catch(e){out=e.name;}`);
});
test('Proxy get trap receives target, key and receiver with guest identity',()=>{
  const {r,bundle}=compare(`function read(target,key,receiver){return target[key]+1;}
    let target={x:2};let proxy=new Proxy(target,{get:read});let out=proxy.x;`);
  assert(Object.values(r.state.heap).some(o=>o.kind==='proxy'));
  assert(bundle.events.some(e=>e.operation==='proxy.allocate'));
});
test('Proxy set trap mutates the target and assignment returns its RHS',()=>{
  compare(`function write(target,key,v,receiver){target[key]=v*2;return true;}
    let target={x:2};let proxy=new Proxy(target,{set:write});
    let assigned=proxy.x=7;let out=target.x+assigned;`);
});
test('a transparent Proxy forwards data gets and sets to the owned target',()=>{
  compare(`let target={x:3};let proxy=new Proxy(target,{});
    let before=proxy.x;proxy.x=6;let out=before+target.x;`);
});
test('Proxy method interception retains proxy as this receiver',()=>{
  compare(`function getter(){return this.x;}
    function read(target,key,receiver){return target[key];}
    let target={x:11,method:getter};
    let proxy=new Proxy(target,{get:read});let out=proxy.method();`);
});
test('Proxy get trap exception propagates as an owned guest completion',()=>{
  compare(`function fail(target,key,receiver){throw 'proxy-failure';}
    let proxy=new Proxy({},{get:fail});let out='';
    try{let value=proxy.someKey;}catch(e){out=e;}`);
});
test('invalid Proxy constructor arguments are catchable guest TypeErrors',()=>{
  compare(`let out='';try{let proxy=new Proxy(4,{});}
    catch(e){out=e.name;}`);
});
