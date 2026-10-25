import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {realizeGraph,describeGraph} from '../src/training/graph.js';
import {verifyTrainingCase} from 'tracing-js-self/training/diagnostic';

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
  const check=verifyTrainingCase({source,entry:'f',args:[{a:2},{b:3}]});
  assert.equal(check.status,'locally_verified',JSON.stringify(check));
  assert.equal(validateBundle(check.exported.sidecar.archive).valid,true);
});
test('Object.assign rejects unsafe exotic sources without returning successful guest values',()=>{
  assert.throws(()=>createRuntime().startEntry({
    text:'"use strict";function f(){return Object.assign({},new Proxy({x:2},{}));}',
    functionName:'f',args:[]
  }),/Unsupported training-js\/1 NewExpression/);
});
