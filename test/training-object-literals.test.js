import test from 'node:test';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
const source=body=>'"use strict";function run(){'+body+'}';
function verify(body){
  const r=verifyOwnedSourceCase({source:source(body),entry:'run',maxGenerated:4096});
  assert.equal(r.status,'locally_verified',r.reason);
  assert.equal(recheckOwnedSourceEvidence(r.exported).valid,true);
  return r;
}
test('computed keys and method literals preserve receiver and evaluation order',()=>{
  verify('let a=[];function key(){a.push(1);return "x";}function val(){a.push(2);return 9;}const o={[key()]:val(),read(){return this.x;}};return [o.read(),a];');
  verify('const o={x:2,read(){const f=()=>this.x;return f();}};return o.read();');
});
test('literal accessors execute owned calls and replacements do not invoke setters',async()=>{
  const body='let count=0;const o={value:4,get x(){count++;return this.value;},set x(v){this.value=v+1;}};o.x=7;const x=o.x;return [x,count,o.value];';
  verify(body);
  verify('let called=0;const o={set x(v){called++;},x:8};return [o.x,called];');
  verify('const o={x:1,get x(){return 9;}};return o.x;');
  const r=await verifyEffectfulTrainingCase({source:source(body),entry:'run',family:'literal-accessor',fixture:{calls:[]}});
  assert.equal(r.status,'locally_verified',r.reason);
});
test('prototype literal setters and computed __proto__ data stay distinct',()=>{
  runtimeDifferential('const p={x:4};const o={__proto__:p,y:2};return [o.x,o.y,Object.hasOwn(o,"x")];');
  runtimeDifferential('const o={__proto__:null,x:3};return [Object.getPrototypeOf(o)===null,o.x];');
  verify('const o={["__proto__"]:7};return [o.__proto__,Object.hasOwn(o,"__proto__")];');
});
test('object spread snapshots keys and reads getter results once in insertion order',()=>{
  verify('let seen=[];const a={a:1,get b(){seen.push("b");return 2;},c:3};const b={...a,z:4};return [b,seen,Object.keys(a)];');
  verify('let calls=0;const source={get x(){calls++;return 3;}};const o={set x(v){calls+=10;},...source};return [o.x,calls];');
  verify('const a={...null,...undefined,...3,..."ab",z:9};return a;');
  verify('const a={x:1};const b={...a,...(a.x=4,{y:a.x}),x:7};return [a,b];');
  verify('let out=[];const a={get x(){Object.defineProperty(a,"y",{enumerable:false});return 1;},get y(){out.push(2);return 2;}};return [{...a},out];');
});
