import test from 'node:test';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
function check(code,args=[]){
  const source='"use strict";'+code;
  const r=verifyOwnedSourceCase({source,entry:'run',args,maxGenerated:8192});
  assert.equal(r.status,'locally_verified',r.reason);
  assert.equal(recheckOwnedSourceEvidence(r.exported).valid,true);
  return r;
}
test('parameter patterns initialize left to right with lazy defaults and rest',()=>{
  check('function run({x=3,...rest}={},[a=4,...tail]=[]){return [x,rest,a,tail];}',[{x:0,y:5},[undefined,6,7]]);
  check('function run({x=3}={},y=x+2){return [x,y];}');
  check('function run(...[a=2,b=3]){return [a,b];}',[5]);
  check('function run(){const f=({n=2},[x])=>n+x;return f({},[3]);}');
});
test('parameter patterns retain TDZ and isolate defaults from body bindings',()=>{
  check('function run({x=y}={},y=3){return x;}');
  check('function run({x=x}={}){return x;}');
  check('function run({x=2}={}, f=()=>x){var x=9;return [x,f()];}');
  check('function run({a=f(),b=4}={},f=()=>9){return [a,b];}');
});
test('default closures observe later pattern binding initialization',async()=>{
  const code='function run(f=()=>n,{n=7}={}){return f();}';
  runtimeDifferential('',{source:'"use strict";'+code});
  const r=await verifyEffectfulTrainingCase({source:'"use strict";'+code,entry:'run',family:'parameter-pattern-capture',fixture:{calls:[]}});
  assert.equal(r.status,'locally_verified',r.reason);
  assert(r.exported.sidecar.compiler.certificates.some(row=>row.rule==='owned-deferred-parameter-initialization/1'));
});
