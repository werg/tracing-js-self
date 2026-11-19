import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {validateBundle} from '../src/validation.js';

test('class constructors and methods expose real name and length descriptors in native key order',()=>{
  runtimeDifferential('class C{constructor(a,b=1,c){}m(a,b){}get x(){return 1;}set x(v){}#m(a){}get p(){return this.#m;}}const c=new C();return [C.name,C.length,C.prototype.m.name,C.prototype.m.length,c.p.name,c.p.length,Object.getOwnPropertyNames(C),Object.getOwnPropertyNames(C.prototype.m),Object.getOwnPropertyDescriptor(C,"name"),Object.getOwnPropertyDescriptor(C.prototype.m,"length")];');
  runtimeDifferential('class B{}class D extends B{m(a,{x=2},...rest){}}return [B.length,D.length,D.prototype.m.length];');
  runtimeDifferential('class C{get x(){return 1;}set x(v){}}const d=Object.getOwnPropertyDescriptor(C.prototype,"x");return [d.get.name,d.get.length,d.set.name,d.set.length];');
});
test('computed Symbol names and private methods retain SetFunctionName distinctions',()=>{
  runtimeDifferential('const k=Symbol("thing"),none=Symbol();class C{[k](a,b=3){}[none](){}#m(){}read(){return this.#m.name;}}return [C.prototype[k].name,C.prototype[k].length,C.prototype[none].name,(new C()).read()];');
  runtimeDifferential('class C{[Symbol.iterator](){}get [Symbol.toStringTag](){return "C";}}return [C.prototype[Symbol.iterator].name,Object.getOwnPropertyDescriptor(C.prototype,Symbol.toStringTag).get.name];');
});
test('anonymous class name inference is visible before static initialization',()=>{
  runtimeDifferential('const C=class{static captured=this.name;};let D;D=class{};const o={x:class{static captured=this.name;}};return [C.name,C.captured,D.name,o.x.name,o.x.captured];');
  runtimeDifferential('class C{x=class{static n=this.name;};#y=class{};m(){return [this.x.name,this.x.n,this.#y.name];}}return (new C()).m();');
  runtimeDifferential('function f(C=class{}){return C.name;}const {D=class{}}={};let E;[E=class{}]=[];return [f(),D.name,E.name,(class{}).name];');
  runtimeDifferential('const k=Symbol("key");const o={[k]:class{static n=this.name;}};return [o[k].name,o[k].n];');
});
test('readonly class function metadata rejects strict writes and forged descriptors',()=>{
  runtimeDifferential('class C{}try{C.name="other";}catch(e){return [e.name,C.name];}');
  const {bundle}=runtimeDifferential('class C{m(a){}}return C.prototype.m.length;');
  const forged=structuredClone(bundle),event=forged.events.find(e=>e.operation==='function.home'&&e.stateChanges.some(p=>p.table==='heap'&&p.after?.properties?.name));
  event.stateChanges.find(p=>p.table==='heap'&&p.after?.properties?.name).after.dataAttributes.name.enumerable=true;
  assert.throws(()=>validateBundle(forged),/name\/length descriptor/);
});
