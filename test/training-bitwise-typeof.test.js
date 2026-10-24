import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,replayExact,validateBundle} from 'tracing-js-self';
import {verifyTrainingCase,recheckIndependentTrainingEvidence} from 'tracing-js-self/training';

const strict=code=>'"use strict";\n'+code;
function agree(body,args=[]){
  const result=verifyTrainingCase({source:strict(body),entry:'f',args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const copy=JSON.parse(JSON.stringify(result.exported));
  assert.deepEqual(recheckIndependentTrainingEvidence(copy).valid,true);
  assert.equal(copy.sidecar.branchAudit.status,'agreed');
  return copy;
}
test('bitwise Number ToInt32/ToUint32 and BigInt operations have V8 operation receipts',()=>{
  const source=`function f(a,b){
    let dead=(a>>>0);dead=123;
    return [a&b,a|b,a^b,a<<2,a>>1,a>>>1,~a,dead];
  }`;
  for(const args of [[-1,5],[0xffffffff,4],[1.5,4],[-0,8],[NaN,3]]) {
    const exported=agree(source,args);
    assert(exported.sidecar.operationAudit.covered.binary>=6);
    assert(exported.sidecar.operationAudit.covered.unary>=1);
  }
  const bigint=agree('function f(a,b){return [a&b,a|b,a^b,a<<2n,a>>1n,~a];}',
    [-17n,5n]);
  assert.equal(bigint.sidecar.operationAudit.status,'agreed');
});
test('typeof unbound identifiers returns undefined and declared values retain their types',()=>{
  const source=`function f(x){
    let n=typeof neverDeclared;
    let y=typeof x;
    let z=typeof n;
    return [n,y,z,typeof undefined,typeof Object];
  }`;
  for(const arg of [0,undefined,{},[1],false]) {
    const exported=agree(source,[arg]);
    assert(exported.sidecar.operationAudit.covered.unary>=5);
  }
});
test('void evaluates operand exactly once, including object mutation',()=>{
  const exported=agree(`function f(o){
    let x=void (o.value+=1);
    let y=void o;
    return [x,y,o.value];
  }`,[{value:3}]);
  assert.equal(exported.sidecar.operationAudit.status,'agreed');
  assert.deepEqual(exported.sidecar.reference.graph.roots.at(-1),['ref','o1']);
});
test('typeof uninitialized lexical binding is a guest throw, not undefined',()=>{
  const source=strict('function f(){return typeof x;let x=1;}');
  const runtime=createRuntime().startEntry({text:source,functionName:'f'});
  const state=runtime.drive();
  assert.equal(state.kind,'runtime.failure');
  const bundle=runtime.exportRun();
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  assert.equal(bundle.finalState.control.a0.failure.completion.type,'throw');
  assert.notEqual(verifyTrainingCase({source,entry:'f'}).status,'locally_verified');
});
test('unresolved assignment and value reads remain unbound, no ambient fallback',()=>{
  for(const body of ['function f(){return absent+1;}',
    'function f(){absent=3;return 3;}']){
    assert.equal(verifyTrainingCase({source:strict(body),entry:'f'}).status,'unsupported');
  }
});
