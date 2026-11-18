import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {describeGraph,realizeGraph} from '../src/training/graph.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

function compare(body){
  const source='"use strict";function run(){'+body+'}';
  const runtime=createRuntime().startEntry({text:source,functionName:'run'});
  assert.equal(runtime.drive().kind,'terminated');
  const archive=runtime.exportRun();
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  const actual=realizeGraph(runtime.state.heap,[runtime.result]);
  const expected=Function(source+';return run();')();
  assert.deepEqual(describeGraph(actual),describeGraph([expected]),body);
}

test('array end defaults distinguish omitted and undefined from scalar coercion',()=>{
  for(const end of ['',',undefined',',null',',NaN',',0',',-0',',Infinity',',-Infinity',',-1',',1.9',',"2"']){
    compare('return [1,2,3].slice(0'+end+');');
    compare('const a=[1,2,3];a.fill(9,0'+end+');return a;');
    compare('const a=[1,2,3];a.copyWithin(0,1'+end+');return a;');
  }
});

test('method-specific undefined defaults leave lastIndexOf and splice semantics intact',()=>{
  compare('const a=[1,2,1];return [a.lastIndexOf(1),a.lastIndexOf(1,undefined)];');
  compare('const a=[1,2,3];const b=a.splice(1,undefined);return [a,b];');
});

test('array default repairs pass independent source and canonical v5 projection',async()=>{
  for(const body of [
    'return [1,2,3].slice(0,undefined);',
    'const a=[1,2,3];a.fill(9,0,undefined);return a;',
    'const a=[1,2,3];a.copyWithin(0,1,undefined);return a;'
  ]){
    const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(){'+body+'}',
      entry:'run',fixture:{calls:[]},family:'array-default-boundary'});
    assert.equal(result.status,'locally_verified',result.reason);
  }
});

test('top-level async helpers retain Promise-returning declaration semantics',async()=>{
  for(const body of ['return typeof helper();','return await helper();',
    'const x=helper();return [typeof x,await x];']){
    const result=await verifyEffectfulTrainingCase({
      source:'"use strict";async function helper(){return 7;}async function run(){'+body+'}',
      entry:'run',fixture:{calls:[]},family:'async-helper-declaration'});
    assert.equal(result.status,'locally_verified',result.reason);
  }
});
