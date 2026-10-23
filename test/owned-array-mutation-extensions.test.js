import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {realizeGraph,describeGraph} from '../src/training/graph.js';

function guest(body,argumentsList=[]){
  const runtime=createRuntime({maxSteps:100000}).startEntry({
    text:'"use strict";function run(a){'+body+'}',
    functionName:'run',args:argumentsList
  });
  const status=runtime.drive();
  assert.equal(status.kind,'terminated',JSON.stringify(status));
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  const result=realizeGraph(runtime.state.heap,[runtime.result])[0];
  return {bundle,result};
}
test('dense array reverse/fill/copyWithin and immutable copy variants match V8',()=>{
  const body=`
    const r=a.reverse();
    const backwards=a.toReversed();
    const filled=a.fill(9,1,3);
    const copied=a.copyWithin(0,2);
    const changed=a.with(-1,55);
    return [a,r,backwards,filled,copied,changed,
      a===r,a===filled,a===copied,a===changed];`;
  const input=[1,2,3,4,5];
  const {result}=guest(body,[input.slice()]);
  function native(a){
    const r=a.reverse(),backwards=a.toReversed();
    const filled=a.fill(9,1,3),copied=a.copyWithin(0,2),
      changed=a.with(-1,55);
    return [a,r,backwards,filled,copied,changed,
      a===r,a===filled,a===copied,a===changed];
  }
  const expected=native(input.slice());
  assert.deepEqual(describeGraph([result]),describeGraph([expected]));
  assert.equal(result[0],result[1]);
  assert.equal(result[0],result[3]);
  assert.equal(result[0],result[4]);
  assert.notEqual(result[0],result[2]);
  assert.notEqual(result[0],result[5]);
});
test('copyWithin overlapping and negative-relative indexes preserve native semantics',()=>{
  const body=`
    const before=a.toReversed();
    a.copyWithin(-3,0,3);
    a.fill(null,-2,-1);
    return [before,a,a.with(0,14),a.with(-1,15)];`;
  const input=[0,1,2,3,4];
  const {result}=guest(body,[input.slice()]);
  function native(a){
    const before=a.toReversed();
    a.copyWithin(-3,0,3);a.fill(null,-2,-1);
    return [before,a,a.with(0,14),a.with(-1,15)];
  }
  assert.deepEqual(describeGraph([result]),describeGraph([native(input.slice())]));
});
test('fill preserves identical owned object aliases without host object coercion',()=>{
  const {result}=guest(`
    const value={x:3};
    a.fill(value,0,3);
    return [a,a[0]===a[1],a[1]===a[2],a[2]===value];`,[[1,2,3]]);
  assert.deepEqual(result[0],[{x:3},{x:3},{x:3}]);
  assert.equal(result[0][0],result[0][1]);
  assert.equal(result[0][1],result[0][2]);
  assert.deepEqual(result.slice(1),[true,true,true]);
});
test('Array.with validates out-of-bounds indices as owned guest RangeError',()=>{
  const {result}=guest(`
    try {a.with(99,1);return 'incorrect';}
    catch(e){return e.name;}`,[[1,2,3]]);
  assert.equal(result,'RangeError');
});
test('Array.copyWithin and fill reject unsupported index coercion without native fallback',()=>{
  for(const body of [
    'return a.copyWithin({},1);',
    'return a.fill(1,{});',
    'return a.with({},0);'
  ]){
    const runtime=createRuntime().startEntry({
      text:'"use strict";function run(a){'+body+'}',
      functionName:'run',args:[[1,2]]
    });
    const result=runtime.drive();
    assert.notEqual(result.kind,'terminated');
    const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
  }
});
