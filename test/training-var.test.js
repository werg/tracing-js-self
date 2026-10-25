import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase} from 'tracing-js-self/training/diagnostic';
function check(code,args=[]){
  const r=verifyTrainingCase({source:'"use strict";\n'+code,entry:'f',args,maxGenerated:1024});
  assert.equal(r.status,'locally_verified',JSON.stringify(r));
}
test('var hoisting and initialized undefined',()=>{
  check('function f(){const seen=[typeof value,value];var value=4;return [seen,value];}');
  check('function f(x){var x;return x+2;}',[5]);
});
test('var function scope through nested blocks, duplicate and for headers',()=>{
  check('function f(){if(true){var x=4;}var x;return x;}');
  check('function f(){var total=0;for(var i=0;i<4;i++){total+=i;}return [i,total];}');
  check('function f(){var a=1,b=2;return a+b;}');
});
test('var loop closures capture one mutable binding',()=>{
  check('function f(){const fns=[];for(var i=0;i<3;i++){fns.push(()=>i);}return [fns[0](),fns[1](),fns[2]()];}');
});
