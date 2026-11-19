import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {lowerJavaScript,tryLowerJavaScript} from '../src/semantic/lower-js.js';
import {evaluateAlgorithm,encodeAlgorithmScalar as scalar} from '../src/semantic/operations.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';

const source=body=>'"use strict";function run(xs){'+body+'}';
const lower=body=>lowerJavaScript({source:source(body),entry:'run'});
const inputs=xs=>({args:[['ref','xs']],heap:new Map([['xs',{kind:'array',properties:new Map([
  ['length',scalar(xs.length)],...xs.map((x,i)=>[String(i),scalar(x)])])}]])});
const run=(core,xs)=>{const {args,heap}=inputs(xs);return evaluateAlgorithm(core,args,{heap}).completion.value;};

test('certified intrinsic reduce converges with ascending sum loops and temporary callbacks',()=>{
  const bodies=[
    'let s=0;for(const x of xs)s+=x;return s;',
    'return xs.reduce((s,x)=>s+x,0);',
    'return xs.reduce(function(total,item){const next=total+item;return next;},0);',
    'return xs.reduce((sum,item)=>{sum+=item;return sum;},0);'
  ];
  const core=lower(bodies[0]).core;
  for(const body of bodies){
    const lowered=lower(body);assert.deepEqual(lowered.core,core);
    for(const xs of [[],[-0],[2,3,4],[1e16,1,-1e16],[1e16,-1e16,1],[Number.MAX_VALUE,Number.MAX_VALUE]]){
      const native=vm.runInNewContext(source(body)+';run(xs)',{xs},{timeout:1000});
      assert.deepEqual(run(core,xs),scalar(native));
    }
    const checked=verifyOwnedSourceCase({source:source(body),entry:'run',args:[[2,3,4]],maxSteps:10000,maxGenerated:1024});
    assert.equal(checked.status,'locally_verified',checked.reason);
  }
});

test('reduce refuses unsupported callback state, method replacement, traversal and initialization',()=>{
  for(const body of [
    'return xs.reduce((s,x)=>s+x);',
    'return xs.reduce((s,x)=>s+x,1);',
    'return xs.reduce((s,x,i)=>s+x+i,0);',
    'let count=0;return xs.reduce((s,x)=>{count++;return s+x;},0);',
    'return xs.reduce((s,x)=>x+s,0);',
    'return xs.reduce((s,x)=>{xs[0]=0;return s+x;},0);',
    'xs.reduce=()=>100;return xs.reduce((s,x)=>s+x,0);',
    'return xs.reduceRight((s,x)=>s+x,0);'
  ])assert.equal(tryLowerJavaScript({source:source(body),entry:'run'}).status,'refused',body);
  const core=lower('return xs.reduce((s,x)=>s+x,0);').core;
  const {args,heap}=inputs([2,3]);heap.get('xs').properties.set('reduce',['undefined']);
  assert.throws(()=>evaluateAlgorithm(core,args,{heap}),/extra/);
  heap.get('xs').properties.delete('reduce');heap.get('xs').properties.delete('0');
  assert.throws(()=>evaluateAlgorithm(core,args,{heap}),/holes/);
});

test('executed distinguishing pairs preserve absent initial and reversed traversal meanings',()=>{
  for(const [left,right,xs] of [
    ['return xs.reduce((s,x)=>s+x,0);','return xs.reduce((s,x)=>s+x);',[-0]],
    ['return xs.reduce((s,x)=>s+x,0);','let s=0;for(let i=xs.length-1;i>=0;i--)s+=xs[i];return s;',[1e16,-1e16,1]]
  ]){
    const native=body=>scalar(vm.runInNewContext(source(body)+';run(xs)',{xs},{timeout:1000}));
    assert.notDeepEqual(native(left),native(right));
    for(const body of [left,right]){
      const checked=verifyOwnedSourceCase({source:source(body),entry:'run',args:[xs],maxSteps:10000,maxGenerated:1024});
      assert.equal(checked.status,'locally_verified',checked.reason);
    }
  }
});
