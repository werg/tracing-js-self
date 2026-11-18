import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

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
