import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {validateBundle} from '../src/validation.js';
import {validateGeneratorState} from '../src/generator-validation.js';

test('generator functions own exact descriptors and a distinct empty prototype',()=>{
  runtimeDifferential('function* g(a,b=2){yield a;}function* h(){}const it=g(3);return [g.name,g.length,Reflect.ownKeys(g),Reflect.ownKeys(g.prototype),g.prototype!==h.prototype,Object.getPrototypeOf(it)===g.prototype,Object.getOwnPropertyDescriptor(g,"name"),Object.getOwnPropertyDescriptor(g,"length"),Object.getOwnPropertyDescriptor(g,"prototype").writable,Object.getOwnPropertyDescriptor(g,"prototype").enumerable,Object.getOwnPropertyDescriptor(g,"prototype").configurable,it.next()];');
  runtimeDifferential('function* g(){}const p=Object.getPrototypeOf(g),q=Object.getPrototypeOf(g.prototype);return [typeof p,typeof Object.getPrototypeOf(p),p.prototype===q,q.constructor===p,Object.getPrototypeOf(Object.getPrototypeOf(p))===Object.prototype,Object.getPrototypeOf(Object.getPrototypeOf(q))===Object.prototype,Object.getPrototypeOf(Object.prototype)===null];');
});

test('generator named evaluation covers declarations defaults properties symbols and classes',()=>{
  runtimeDifferential('const a=function*(x){};const b=function* named(){};let c;c=function*(){};function f(d=function*(){}){const {e=function*(){}}={};return [d.name,e.name];}const s=Symbol("items"),t=Symbol();const obj={*items(a,b){},anon:function*(){},*[s](x){yield x;},[t]:function*(){}};return [a.name,a.length,b.name,c.name,f(),obj.items.name,obj.items.length,obj.anon.name,obj[s].name,obj[t].name,obj[s](7).next()];');
  runtimeDifferential('class C{*items(a){yield a;}static *s(){yield 3;}#hidden=function*(){};names(){return [this.#hidden.name];}}const o=new C();return [o.items.name,o.items.length,o.items(4).next(),C.s.name,C.s().next(),o.names()];');
});

test('generator creation reads current prototype once and existing instances retain theirs',()=>{
  runtimeDifferential('function* g(){yield 1;}const a=g(),first=g.prototype;g.prototype={x:3};const b=g();g.prototype=null;const c=g();let error;try{a instanceof g;}catch(e){error=e.name;}return [Object.getPrototypeOf(a)===first,Object.getPrototypeOf(b).x,typeof b.next,Object.getPrototypeOf(c)===Object.getPrototypeOf(first),c.next(),error];');
  runtimeDifferential('function* g(){yield 1;}const a=g(),p=g.prototype;g.prototype=Object.create(p);const b=g();return [a instanceof g,b instanceof g,Object.getPrototypeOf(b)===g.prototype,a.next(),b.next()];');
  runtimeDifferential('function make(n){return function* same(){yield n;};}const a=make(3),b=make(7),ga=a(),gb=b();return [a.name,b.name,a.prototype!==b.prototype,Object.getPrototypeOf(ga)===a.prototype,Object.getPrototypeOf(gb)===b.prototype,ga.next(),gb.next()];');
});

test('generator prototype getters preserve receiver and iterator identity is shared',()=>{
  runtimeDifferential('function* g(){yield 1;}Object.defineProperty(g.prototype,"value",{get:function(){return this===it?9:0;}});const it=g();return [it.value,it[Symbol.iterator]()===it,it[Symbol.iterator]===[][Symbol.iterator]()[Symbol.iterator],it.next()];');
  runtimeDifferential('function* g(){yield 1;}let seen=0;g.prototype.next=function(){seen++;return {value:7,done:true};};const it=g();return [it.next(),seen];');
  runtimeDifferential('function* g(){}let result;try{new g();}catch(e){result=e.name;}let write;try{g.name="x";}catch(e){write=e.name;}return [result,write,g.name];');
});

test('generator archive validation checks definition descriptors and callee prototype linkage',()=>{
  const {bundle,runtime}=runtimeDifferential('function* g(x){yield x;}const it=g(3);return [it.next(),it.next()];');
  const definition=bundle.events.find(event=>event.stateChanges.some(p=>p.after?.generatorFunction));
  const mutant=structuredClone(bundle),changed=mutant.events.find(event=>event.eventId===definition.eventId);
  changed.stateChanges.find(p=>p.after?.generatorFunction).after.dataAttributes.name.writable=true;
  assert.throws(()=>validateBundle(mutant),/Generator function allocation/);
  const allocation=bundle.events.find(event=>event.stateChanges.some(p=>p.before===null&&p.after?.kind==='generator'));
  const badPrototype=structuredClone(bundle),created=badPrototype.events.find(event=>event.eventId===allocation.eventId);
  created.stateChanges.find(p=>p.after?.kind==='generator').after.prototype='Object.prototype';
  assert.throws(()=>validateBundle(badPrototype),/current prototype/);
  // State-only restore cannot replace an exact callee with a same-code guess.
  const final=structuredClone(runtime.state);
  const generator=Object.values(final.heap).find(node=>node.kind==='generator');
  generator.functionId='missing';
  assert.throws(()=>validateGeneratorState(final,bundle.programs,message=>{throw new Error(message);}),/continuation identity/);
});
