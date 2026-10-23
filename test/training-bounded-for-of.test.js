import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';

const verified=(code,args=[])=>{
  const result=verifyTrainingCase({source:'"use strict";\n'+code,
    entry:'f',args,maxGenerated:1024,maxSteps:10000});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  assert.equal(validateTrainingExport(result.exported).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(result.exported).valid,true);
  assert.equal(validateBundle(result.exported.sidecar.archive).valid,true);
  assert.equal(replayExact(result.exported.sidecar.archive).valid,true);
  return result.exported;
};

test('bounded array for-of matches V8, observes elements and supports nested break/continue',()=>{
  verified(`function f(xs){const out=[];for(const x of xs){
    if(x===2)continue; if(x===4)break;out.push(x*3);
  }return [out,xs];}`,[[1,2,3,4,5]]);
  verified(`function f(xs){const out=[];for(let x of xs){
    x++;out.push(x);
  }return out;}`,[[1,2,3]]);
  verified(`function f(xs){const out=[];for(var x of xs)out.push(x);
    return [out,x];}`,[[1,2,3]]);
});

test('for-of evaluates iterable once and retains per-iteration captured lexical cells',()=>{
  verified(`function f(xs){let n=0;const fs=[];
    function get(){n++;return xs;}
    for(const value of get())fs.push(()=>value+n);
    return [n,fs[0](),fs[1](),fs[2]()];}`,[[3,5,7]]);
});

test('for-of reads live array length during mutation as a V8 array iterator does',()=>{
  verified(`function f(xs){const result=[];for(const x of xs){
    result.push(x);if(xs.length===2)xs.push(3);
  }return [result,xs];}`,[[1,2]]);
});

test('for-of owns destructured pairs and captured per-iteration cells',()=>{
  verified(`function f(rows){const result=[];
    for(const [a,b] of rows){result.push(a*10+b);}
    return result;}`,[[[1,2],[3,4]]]);
  verified(`function f(rows){const fs=[];
    for(const [a,b] of rows){fs.push(()=>a*10+b);}
    return [fs[0](),fs[1]()];}`,[[[1,2],[3,4]]]);
});
test('array pair default expressions execute only for undefined per iteration',()=>{
  verified(`function f(rows){const out=[];
    for(const [a=7,b=a+1] of rows)out.push([a,b]);
    return out;}`,[[[undefined,undefined],[2,undefined],[0,null]]]);
  verified(`function f(rows){let n=0;const fs=[];
    for(const [a=++n,b=a+n] of rows)fs.push(()=>[a,b,n]);
    return [fs[0](),fs[1](),n];}`,[[[undefined,undefined],[undefined,undefined]]]);
});
test('for-of refuses non-array iterables, nested patterns and for-await',()=>{
  for(const [code,args] of [
    ['function f(s){let z="";for(const x of s)z+=x;return z;}', ['abc']],
    ['function f(xs){for(const [[x],y] of xs){}return 1;}',[[[1,2]]]],
    ['function f(xs){for(var [x,y] of xs){}return 1;}',[[[1,2]]]],
    ['function f(xs){for(const [x,y] of xs){}return 1;}',[[1,2]]],
    ['async function f(xs){for await(const x of xs){}return 1;}',[[1,2]]]
  ]){
    const result=verifyTrainingCase({source:'"use strict";\n'+code,entry:'f',args});
    assert.notEqual(result.status,'locally_verified');
  }
});
