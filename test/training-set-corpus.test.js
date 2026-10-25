import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence} from '../src/training/diagnostic.js';
import {replayExact} from '../src/replay.js';

function checked(source,args=[]) {
  const result=verifyTrainingCase({source:'"use strict";\n'+source,entry:'f',args,
    maxSteps:10000,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  assert.equal(replayExact(result.exported.sidecar.archive).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(
    JSON.parse(JSON.stringify(result.exported))).valid,true);
  return result;
}

test('owned Set constructor, insertion order, SameValueZero and synchronous callback',()=>{
  checked('function f(a){const s=new Set();return a.filter(x=>{if(s.has(x))return false;s.add(x);return true;});}',[[1,2,1,3,2]]);
  checked('function f(a){const s=new Set(a);return [s.has(0),s.has(-0),s.has(NaN)];}',[[0,-0,NaN]]);
  checked('function f(a){return Array.from(new Set(a));}',[[3,2,3,-0,0,1]]);
});

test('Set constructor is only a bounded ordinary owned array iterable',()=>{
  const bad=verifyTrainingCase({source:'"use strict"; function f(){return new Set(5)}',entry:'f'});
  assert.notEqual(bad.status,'locally_verified');
});

test('unreached Error constructor and RegExp literal remain fail-closed when executed',()=>{
  checked('function f(x){if(x<0)throw new Error("no");return x+1;}',[2]);
  checked('function f(x,flag=false){if(flag)return x.replace(/\\./g, "");return x.toUpperCase()!==x;}', ['abc']);
  for(const text of ['function f(){return new Error("no")}',
    'function f(){return /a/g}']){
    const check=verifyTrainingCase({source:'"use strict"; '+text,entry:'f'});
    assert.notEqual(check.status,'locally_verified');
  }
});

test('bounded CR/LF RegExp split is an owned deterministic source-level leaf',()=>{
  checked('function f(s){return s.split(/\\r\\n|\\r|\\n/);}', ['a\r\nb\nc\rd']);
  checked('function f(s){return s.split(/(\\r\\n|\\r|\\n)/);}', ['a\r\nb\nc\rd']);
  checked('function f(s){return s.split(/(\\r\\n|\\r|\\n)/);}', ['']);
  const bad=verifyTrainingCase({source:'"use strict"; function f(s){return s.split(/x/)}',entry:'f',args:['x']});
  assert.notEqual(bad.status,'locally_verified');
});

test('pinned regexp-escape replacement is a bounded visible scalar leaf',()=>{
  checked(String.raw`function f(s){return s.replace(/[\\\{\}\*\+\?\|\^\$\.\[\]\(\)]/g, '\\$&');}`, ['(a.b)[c]?\\z']);
});
