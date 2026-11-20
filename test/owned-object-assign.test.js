import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {realizeGraph,describeGraph} from '../src/training/graph.js';
import {verifyOwnedSourceCase} from 'tracing-js-self/training';
import {runtimeDifferential} from './helpers/runtime-frontier.js';

function run(body,args){
  const runtime=createRuntime().startEntry({
    text:'"use strict";function run(a,b){'+body+'}',
    functionName:'run',args
  });
  assert.equal(runtime.drive().kind,'terminated');
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return {result:realizeGraph(runtime.state.heap,[runtime.result])[0],bundle};
}
test('owned Object.assign merges only own data and preserves nested reference aliases',()=>{
  const shared={k:4},a={num:2,shared},b={num:3,next:9};
  const body=`
    const merged=Object.assign({base:1},a,null,undefined,b);
    return [merged,merged.shared===a.shared,a.shared,merged.num];`;
  const {result}=run(body,[a,b]);
  const expected=(()=>{
    const merged=Object.assign({base:1},a,null,undefined,b);
    return [merged,merged.shared===a.shared,a.shared,merged.num];
  })();
  assert.deepEqual(describeGraph([result]),describeGraph([expected]));
  assert.equal(result[0].shared,result[2]);
});
test('Object.assign copies owned dense array enumerable indices but not length',()=>{
  const source=[7,8];
  const {result}=run('return Object.assign({name:"x"},a);',[source,{}]);
  assert.deepEqual(result,Object.assign({name:'x'},source));
  assert.equal(Object.hasOwn(result,'length'),false);
});
test('Object.assign skips non-enumerable class and template data properties',()=>{
  runtimeDifferential('class C{m(){return 1;}}C.prototype.visible=3;const copy=Object.assign({},C.prototype);return [Object.keys(copy),copy.visible,Object.hasOwn(copy,"m"),Object.hasOwn(copy,"constructor")];');
  runtimeDifferential('function tag(parts){const copy=Object.assign({},parts);return [Object.keys(copy),copy[0],copy[1],Object.hasOwn(copy,"raw"),Object.hasOwn(copy,"length")];}return tag`first${7}last`;');
});
test('Object.assign retains enumerable symbol values and ordinary own-key order',()=>{
  runtimeDifferential('const first=Symbol("first"),last=Symbol("last"),source={};source[first]=1;source.b=2;source[2]=3;source.a=4;source[last]=5;source[1]=6;const target=Object.assign({z:0},source);const keys=Reflect.ownKeys(target);return [Object.keys(target),keys[5]===first,keys[6]===last,target[first],target[last]];');
});
test('Object.assign writes the same target object identity and avoids native fallback',()=>{
  const body=`
    const target={a:1};const copy=Object.assign(target,a,b);
    return [copy,target,copy===target];`;
  const {result}=run(body,[{b:2},{c:3}]);
  assert.deepEqual(result[0],{a:1,b:2,c:3});
  assert.equal(result[0],result[1]);
  assert.equal(result[2],true);
});
test('Object.assign admits simple scalar-free candidate traces through independent V8 gate',()=>{
  const source='"use strict";function f(a,b){return Object.assign({x:1},a,b); }';
  const check=verifyOwnedSourceCase({source,entry:'f',args:[{a:2},{b:3}]});
  assert.equal(check.status,'locally_verified',JSON.stringify(check));
  assert.equal(validateBundle(check.exported.sidecar.archive).valid,true);
});
test('Object.assign rejects unsafe exotic sources without returning successful guest values',()=>{
  assert.throws(()=>createRuntime().startEntry({
    text:'"use strict";function f(){return Object.assign({},new Proxy({x:2},{}));}',
    functionName:'f',args:[]
  }).drive(),/Object.assign source requires an owned data object/);
});
