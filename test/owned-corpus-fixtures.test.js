import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnedFixtureEntry} from '../corpus/owned-fixture-adapter.mjs';
import {cases} from '../corpus/cases.mjs';
import {verifyTrainingCase} from 'tracing-js-self/training/diagnostic';

test('pinned callback executes in an owned guest closure, with independently verified data',()=>{
  const spec=cases.find(c=>c.project==='lodash'&&c.entry==='arrayMap');
  const fixture=buildOwnedFixtureEntry(spec.setup(0),'sample');
  const checked=verifyTrainingCase({
    source:'"use strict";\nfunction sample(array,callback){'+
      'const out=[];for(let i=0;i<array.length;i++){out.push(callback(array[i]));}'+
      'return out;}\n'+fixture.source,
    entry:fixture.entry,args:[],maxGenerated:1024
  });
  assert.equal(checked.status,'locally_verified',JSON.stringify(checked));
  assert.equal(checked.exported.sidecar.referenceStatus,'agreed');
});
test('pinned comparator fixture extension preserves data arguments',()=>{
  const spec=cases.find(c=>c.project==='lodash'&&c.entry==='baseFindIndex');
  const fixture=buildOwnedFixtureEntry(spec.setup(1),'sample');
  assert(fixture.source.includes('const __corpusArg2 = 0;'));
  assert(fixture.source.includes('const __corpusArg3 = false;'));
  assert(fixture.source.includes('return [__corpusResult, __corpusArg0, __corpusArg2, __corpusArg3];'));
});
test('unrecognized fixture scripts fail closed',()=>{
  for(const setup of [
    'globalThis.__testArgs=[1]; host.steal();',
    'globalThis.__testArgs.push(1);',
    'globalThis.__testArgs=[...items];',
    'globalThis.__testArgs=[1]; globalThis.__testArgs.unshift(2);'
  ]) assert.throws(()=>buildOwnedFixtureEntry(setup,'sample'));
});
