import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {describeGraph,realizeGraph} from '../src/training/graph.js';

const source=body=>'"use strict";function run(){'+body+'}';
function runtime(body){return createRuntime().startEntry({text:source(body),functionName:'run'});}

test('Object.create explicitly refuses property descriptor arguments before allocation',()=>{
  for(const properties of ['{foo:{value:7}}','{}','null','7']){
    const r=runtime('return Object.create(null,'+properties+');');
    assert.throws(()=>r.drive(),/Object.create property descriptors are outside/);
    assert.equal(r.state.control.a0.status,'running');
    assert.equal(r.state.control.a0.completion,undefined);
  }
});

test('Object.create omitted and undefined descriptors preserve supported prototype behavior',()=>{
  for(const argument of ['',',undefined']){
    const r=runtime('const p={foo:7};const x=Object.create(p'+argument+');return x.foo;');
    assert.equal(r.drive().kind,'terminated');
    assert.deepEqual(r.result,['num',7]);
    assert.equal(validateBundle(r.exportRun()).valid,true);
    assert.equal(replayExact(r.exportRun()).valid,true);
  }
});

test('array index accessors refuse without exposing an inconsistent array length',()=>{
  for(const index of ['0','2','4294967294']){
    const r=runtime('const a=[];Object.defineProperty(a,"'+index+'",{get:()=>7});return a.length;');
    assert.throws(()=>r.drive(),/Array index accessor descriptors are outside/);
    const array=Object.values(r.state.heap).find(value=>value.kind==='array');
    assert.deepEqual(array.properties.length.value,['num',0]);
    assert.equal(array.accessors,undefined);
  }
});

test('unsupported descriptors are not admitted even when guest code catches TypeError',async()=>{
  for(const body of [
    'try{return Object.create(null,{foo:{value:7}}).foo;}catch(e){return 9;}',
    'const a=[];try{Object.defineProperty(a,"0",{get:()=>7});}catch(e){}return a.length;'
  ]){
    const result=await verifyEffectfulTrainingCase({source:source(body),entry:'run',
      family:'descriptor-refusal',fixture:{calls:[]}});
    assert.notEqual(result.status,'locally_verified');
    assert.notEqual(result.status,'admitted');
    assert.match(result.reason,/outside the bounded profile/);
  }
});

const accessorUpdates=[
  'let x=0;const o={};Object.defineProperty(o,"v",{get:()=>1,set:v=>{x=v;},configurable:true});'+
    'Object.defineProperty(o,"v",{get:()=>2});o.v=3;return [o.v,x];',
  'let x=0;const o={};Object.defineProperty(o,"v",{get:()=>1,set:v=>{x=v;},configurable:true});'+
    'Object.defineProperty(o,"v",{set:v=>{x=v+1;}});o.v=3;return [o.v,x];',
  'const o={};const get=()=>1;Object.defineProperty(o,"v",{get});'+
    'Object.defineProperty(o,"v",{get});return o.v;',
  'const o={};const get=()=>1;Object.defineProperty(o,"v",{get});'+
    'Object.defineProperty(o,"v",{});return o.v;',
  'const o={v:1};Object.defineProperty(o,"v",{get:()=>2});'+
    'Object.defineProperty(o,"v",{get:()=>3});return o.v;',
  'const o={};Object.defineProperty(o,"v",{get:()=>1,configurable:true});'+
    'Object.defineProperty(o,"v",{enumerable:true});'+
    'Object.defineProperty(o,"v",{get:undefined});return o.v;'
];

test('accessor updates preserve absent fields and allow unchanged non-configurable descriptors',async()=>{
  for(const body of accessorUpdates){
    const r=runtime(body);
    assert.equal(r.drive().kind,'terminated',body);
    const expected=Function(source(body)+';return run();')();
    assert.deepEqual(describeGraph(realizeGraph(r.state.heap,[r.result])),describeGraph([expected]),body);
    assert.equal(validateBundle(r.exportRun()).valid,true);
    assert.equal(replayExact(r.exportRun()).valid,true);
    const checked=await verifyEffectfulTrainingCase({source:source(body),entry:'run',
      family:'accessor-update-boundary',fixture:{calls:[]}});
    assert.equal(checked.status,'locally_verified',body+': '+checked.reason);
  }
});

test('non-configurable accessor invariants reject actual changes but retain the original property',()=>{
  for(const update of ['{get:()=>2}','{set:v=>{}}','{enumerable:true}','{configurable:true}']){
    const body='const o={};Object.defineProperty(o,"v",{get:()=>1});'+
      'let error="";try{Object.defineProperty(o,"v",'+update+');}catch(e){error=e.name;}return [error,o.v];';
    const r=runtime(body);
    assert.equal(r.drive().kind,'terminated');
    assert.deepEqual(describeGraph(realizeGraph(r.state.heap,[r.result])),
      describeGraph([Function(source(body)+';return run();')()]),body);
    assert.equal(replayExact(r.exportRun()).valid,true);
  }
});
