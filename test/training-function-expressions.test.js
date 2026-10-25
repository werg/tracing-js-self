import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence} from 'tracing-js-self/training/diagnostic';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
const strict=code=>'"use strict";\n'+code;
function verified(body,args=[]){
  const result=verifyTrainingCase({source:strict(body),entry:'f',args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const evidence=recheckIndependentTrainingEvidence(JSON.parse(JSON.stringify(result.exported)));
  assert.equal(evidence.valid,true,JSON.stringify(evidence));
  return result.exported;
}
test('arrows and anonymous function expressions execute in owned frames',()=>{
  const exported=verified('function f(x){const add=(y)=>x+y;const twice=function(z){return z*2;};return twice(add(3));}',[4]);
  assert(exported.sidecar.semantic.events.filter(x=>x.op==='call'&&x.child).length>=2);
});
test('arrow expression body can return objects with nested callable captures',()=>{
  verified('function f(n){const make=x=>({num:x+n});return make(4);}',[5]);
});
test('per-iteration arrow captures retain distinct loop binding identities',()=>{
  const exported=verified('function f(){let fs=[];for(let i=0;i<3;i++){fs[i]=()=>i;}return [fs[0](),fs[1](),fs[2]()];}');
  assert(exported.sidecar.semantic.events.some(x=>x.op==='alloc'&&
    x.allocations?.some(a=>a.kind==='function')));
});
test('arrow property-call ignores method receiver and still closes over bound variables',()=>{
  verified('function f(n){const receiver={x:90,call:(m)=>m+n};return receiver.call(4);}',[5]);
});
test('named expressions still fail closed; rest arrows remain owned',()=>{
  const body='function f(){const a=function self(x){return x;};return a(2);}';
  assert.equal(verifyTrainingCase({source:strict(body),entry:'f'}).status,'unsupported');
  verified('function f(){const a=(...x)=>x[0];return a(3);}');
});
test('natlang TS annotations on synchronous arrows lower to guest frames',()=>{
  class EvalFailure extends Error{constructor(message,events){super(message);this.events=events;}}
  const archives=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,onTrace:b=>archives.push(b)});
  const result=env.execute({code:'const add = (x: number): number => x + self.k; return add(3);',
    body:true,scope:{k:7},path:'natlang://arrow.ts'});
  assert.equal(result.result,10);
  assert.equal(archives.length,1);
});
