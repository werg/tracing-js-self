import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

test('owned user constructors initialize receivers and share the live prototype',()=>{
  runtimeDifferential('function C(x){this.x=x;}C.prototype.get=function(){return this.x;};const a=new C(4),b=new C(7);return [a.get(),b.get(),Object.getPrototypeOf(a)===C.prototype,a.constructor===C,Object.keys(C.prototype)];');
  runtimeDifferential('function C(x=3){this.x=x;}const p={get y(){return this.x+1;}};C.prototype=p;const a=new C();p.z=9;return [a.y,a.z,Object.getPrototypeOf(a)===p];');
  runtimeDifferential('function C(){this.x=3;}C.prototype=7;const a=new C();return [a.x,Object.getPrototypeOf(a)===Object.prototype];');
});
test('constructor completion substitutes object returns and ignores primitive returns',()=>{
  runtimeDifferential('function A(){this.x=1;return 9;}function B(){this.x=1;return {x:7};}function C(){return ()=>8;}return [(new A()).x,(new B()).x,(new C())()];');
  runtimeDifferential('let escaped;function C(){escaped=this;this.x=4;throw 7;}try{new C();}catch(e){return [escaped.x,e];}');
  runtimeDifferential('const ns={C:function(x){this.x=x;}};return (new ns.C(5)).x;');
});
test('arrows async functions generators and concise methods reject construction',()=>{
  for(const declaration of ['const C=()=>3;','async function C(){return 3;}','function* C(){yield 3;}','const o={m(){return 3;}};const C=o.m;'])
    runtimeDifferential(declaration+'try{new C();}catch(e){return e.name;}');
});
test('constructor prototype state is explicitly outside old detailed contracts',async()=>{
  const source='"use strict";function run(){function C(x){this.x=x;}C.prototype.get=function(){return this.x;};return (new C(7)).get();}';
  const result=await verifyEffectfulTrainingCase({source,entry:'run',family:'owned-user-constructor',fixture:{calls:[]}});
  assert.equal(result.status,'projection_refused');
});
