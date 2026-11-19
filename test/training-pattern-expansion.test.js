import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
const source=body=>'"use strict";function run(input){'+body+'}';
function check(body,args=[]){
  const r=verifyOwnedSourceCase({source:source(body),entry:'run',args,maxGenerated:8192});
  assert.equal(r.status,'locally_verified',r.reason);
  assert.equal(recheckOwnedSourceEvidence(r.exported).valid,true);
}
test('array holes rest and mixed declarations preserve lazy defaults and aliases',()=>{
  check('const a=[2,,4];const [,v=7,...tail]=a,n=3;return [v,tail,n];');
  check('const a={x:3};let [head,...tail]=[a,a];tail[0].x=9;return [head===tail[0],head.x];');
  check('const []=[];const {}=3;return 1;');
  check('try{const {}=null;}catch(e){return e.name;}');
});
test('object rest excludes evaluated keys and reads remaining getters exactly once',()=>{
  check('let calls=[];function key(){calls.push("key");return "a";}const o={get a(){calls.push("a");return 3;},get b(){calls.push("b");return 4;}};const {[key()]:a,...rest}=o;return [a,rest,calls];');
  check('const {x=5,...rest}={y:7};return [x,rest];');
  check('const {...chars}="ab";return chars;');
});
test('assignment patterns evaluate rhs once and retain the assignment result identity',()=>{
  check('let a=0,b=0;const o={};const xs=[3,4];const same=([a,o.x]=xs);({x:b,...o.rest}={x:8,y:9});return [a,b,o,same===xs];');
  check('let a=0;let count=0;[a=++count]=[0];[a=++count]=[];return [a,count];');
});
test('catch patterns bind in handler scope and preserve finally completion',async()=>{
  const body='let x=1;try{throw {a:4,b:5};}catch({a,...rest}){return [a,rest];}finally{x++;}';
  check(body);
  const r=await verifyEffectfulTrainingCase({source:source(body),entry:'run',family:'catch-patterns',fixture:{calls:[]}});
  assert.equal(r.status,'locally_verified',r.reason);
});

test('pattern assignment result has an independent completion receipt',async()=>{
  const body='let a=0;const o={};const data=[2,3];const same=([a,o.x]=data);return [a,o.x,same===data];';
  const r=await verifyEffectfulTrainingCase({source:source(body),entry:'run',family:'pattern-assignment',fixture:{calls:[]}});
  assert.equal(r.status,'locally_verified',r.reason);
});
