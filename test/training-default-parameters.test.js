import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase} from 'tracing-js-self/training';
import {recheckOwnedSourceEvidence} from '../src/training/source-check.js';
function verify(code,args=[]){
 const checked=verifyOwnedSourceCase({source:'"use strict";\n'+code,
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
test('later and self parameter dependencies project authenticated ReferenceError throws',()=>{
 for(const [name,code] of [
   ['b','function f(a=b,b=1){return a;}'],
   ['x','function f(x=x){return x;}']
 ]) {
   const r=verifyOwnedSourceCase({source:'"use strict";\n'+code,entry:'f',args:[]});
   assert.equal(r.status,'locally_verified',r.reason);
   assert.deepEqual(r.exported.sidecar.reference.outcome,{
     kind:'throw',graph:{roots:[['ref','o0']],objects:[{
       id:'o0',kind:'object',properties:[
         ['name',['str','ReferenceError']],
         ['message',['str',`Cannot access '${name}' before initialization`]]
       ]
     }]}
   });
   const faults=r.exported.sidecar.archive.events.filter(event=>event.completion?.parameterTdz);
   assert.equal(faults.length,1);
   assert.equal(faults[0].completion.parameterTdz.name,name);
   assert.equal(recheckOwnedSourceEvidence(r.exported).valid,true);
 }
});
test('a default closure cannot see an unbound body-only var',()=>{
 const r=verifyOwnedSourceCase({source:'"use strict";\nfunction f(cb=()=>y){var y=4;return cb();}',
   entry:'f',args:[]});
 assert.equal(r.status,'unsupported');
 assert.match(r.reason,/unbound identifier y/);
 assert.equal(r.exported,undefined);
});
