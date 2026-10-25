import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase} from 'tracing-js-self/training/diagnostic';
function verify(code,args=[]){
 const checked=verifyTrainingCase({source:'"use strict";\n'+code,
   entry:'f',args,maxGenerated:1024});
 assert.equal(checked.status,'locally_verified',JSON.stringify(checked));
}
test('default parameters are owned and conditional on undefined only',()=>{
 verify('function f(x=5){return x+2;}');
 verify('function f(x=5){return x+2;}',[0]);
 verify('function f(x=5){return x+2;}',[null]);
 verify('function f(a=2,b=a+3){return [a,b];}');
 verify('function f(a=2,b=a+3){return [a,b];}',[4,undefined]);
});
test('default callback is created inside guest code and uses earlier bindings',()=>{
 verify('function f(values=[1,2],fn=(x)=>x*2){return [fn(values[0]),fn(values[1])];}');
 verify('function f(x,fn=(v)=>v+x){return fn(3);}',[5]);
});
test('unsafe later/self/body parameter initialization dependencies fail closed',()=>{
 for(const code of [
   'function f(a=b,b=1){return a;}',
   'function f(x=x){return x;}',
   'function f(cb=()=>y){var y=4;return cb();}'
 ]) {
   const r=verifyTrainingCase({source:'"use strict";\n'+code,entry:'f',args:[]});
   assert.notEqual(r.status,'locally_verified');
 }
});
