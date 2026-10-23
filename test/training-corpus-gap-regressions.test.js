import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';

function verified(body,args=[]){
  const check=verifyTrainingCase({source:'"use strict";\n'+body,
    entry:'f',args,maxGenerated:1024,maxSteps:10000});
  assert.equal(check.status,'locally_verified',JSON.stringify(check));
  const result=JSON.parse(JSON.stringify(check.exported));
  assert.equal(validateTrainingExport(result).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(result).valid,true);
  assert.equal(validateBundle(result.sidecar.archive).valid,true);
  assert.equal(replayExact(result.sidecar.archive).valid,true);
  return result;
}

test('Array(length) preserves absent slots and nested aliases before writes',()=>{
  verified('function f(n){const a=Array(n);for(let i=0;i<n;i++)a[i]=i*2;return a;}',[5]);
  verified('function f(){return [Array(3), Array(0), Array(1,2)];}');
});

test('static top-level source constants and Math function aliases match independent V8',()=>{
  verified('var ceil=Math.ceil,max=Math.max;function f(a,b){return max(ceil(a),b);}',[2.3,2]);
  verified('var LIMIT=11,round=Math.floor;function f(n){return round(n)+LIMIT;}',[3.8]);
  for(const initializer of ['fetch("https://example.com")','Date.now()',
    '(globalThis.flag=1)','Math.random()']){
    const check=verifyTrainingCase({source:'"use strict";\nconst x='+initializer+';function f(){return x;}',entry:'f'});
    assert.equal(check.status,'unsupported',initializer);
  }
});

test('owned array filter/map/reduce invoke guest callback frames and commit heap effects',()=>{
  const result=verified('function f(a){const mapped=a.map(x=>x*2);const good=a.filter(x=>x>1);return [mapped,good,a.reduce((n,x)=>n+x,0)];}',[[1,2,3]]);
  const calls=result.sidecar.semantic.events.filter(x=>x.op==='call'&&x.child);
  assert(calls.length>=9,'each guest callback must be a visible invocation');
  assert(result.sidecar.semantic.events.some(x=>x.op==='return'&&x.writes.some(w=>w.kind==='property')),
    'callback writes must be model-visible');
});

test('callback reads live mutated indexed slots, not an ahead-of-time snapshot',()=>{
  verified('function f(a){return a.map((x,i)=>{if(i===0)a[1]=50;return x;});}',[[1,2,3]]);
});

test('array growth preserves hole absence and allows subsequent sparse writes',()=>{
  verified('function f(a){a.length=5;a[4]=9;return a;}',[[1,2]]);
  verified('function f(a){a[5]=3;return a;}',[[1,2]]);
});
