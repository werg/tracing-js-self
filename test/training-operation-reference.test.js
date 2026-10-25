import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,validateTrainingExport} from 'tracing-js-self/training/diagnostic';
import {compareOperationObservations, instrumentOperationSource} from '../src/training/operation-reference.js';

const strict=code=>'"use strict";\n'+code;

test('V8 independently observes nested, repeated, overwritten and compound intermediate results',()=>{
  const source=strict('function inc(x){return x+1;} function f(n){let discarded=n*9; discarded=0;let sum=0;while(n>0){sum+=inc(n);n-=1;}return sum+discarded;}');
  const result=verifyTrainingCase({source,entry:'f',args:[3]});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const audit=result.exported.sidecar.operationAudit;
  assert.equal(audit.schema,'reference-operations/1');
  assert.equal(audit.status,'agreed');
  assert(audit.checked>=12);
  assert(audit.covered.ownedArithmetic>=8);
  assert(audit.covered.binary>=4);
  assert(audit.unverifiedFamilies.includes('binding.read'));
  assert.equal(validateTrainingExport(result.exported).valid,true);
  assert(!Object.hasOwn(result.exported.public,'operationAudit'),
    'independent reference evidence belongs in the private sidecar');
});

test('independent source observations preserve BigInt, -0, equality and reference typeof',()=>{
  const source=strict('function f(a,b){let overwritten=a**2n;overwritten=0n;return [-0, a**2n,b===b,typeof b];}');
  const result=verifyTrainingCase({source,entry:'f',args:[3n,{x:1}]});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const audit=result.exported.sidecar.operationAudit;
  assert.equal(audit.status,'agreed');
  assert.equal(audit.covered.ownedArithmetic,2);
  assert.equal(audit.covered.binary,1);
  assert.equal(audit.covered.unary,2);
});

test('comparison rejects an incorrect dead scalar, missing/reordered or extra operation',()=>{
  const expected=[{site:'2:5',value:['num',5]},{site:'8:11',value:['bool',true]}];
  assert.deepEqual(compareOperationObservations(expected,expected),{status:'agreed',checked:2});
  for(const observed of [
    [{site:'2:5',value:['num',6]},expected[1]],
    expected.slice(0,1),
    [expected[1],expected[0]],
    [...expected,{site:'12:14',value:['num',0]}]
  ]){
    const comparison=compareOperationObservations(expected,observed);
    assert.equal(comparison.status,'mismatch');
    assert(comparison.index>=0);
  }
});

test('source instrumentation never rewrites directive text or introduces untraced fallback',()=>{
  const source=strict('function f(a){return (a+1)*(a+2);}');
  const transformed=instrumentOperationSource(source);
  assert(transformed.startsWith('"use strict";\n'));
  assert.equal((transformed.match(/__tracingCapture/g)??[]).length,3);
  assert(transformed.includes('a+1'));
  assert(transformed.includes('a+2'));
});
