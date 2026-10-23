import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from 'tracing-js-self';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  exportTraining} from 'tracing-js-self/training';

const source='"use strict";function f(x){let y=x+1;if(y>3)y+=2;return y;}';
test('serialized locally verified episodes independently recheck with V8',()=>{
  const result=verifyTrainingCase({source,entry:'f',args:[3]});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const exported=JSON.parse(JSON.stringify(result.exported));
  const evidence=recheckIndependentTrainingEvidence(exported);
  assert.equal(evidence.valid,true,JSON.stringify(evidence));
  assert.equal(evidence.admitted,false);
  assert(evidence.operations>0);
  assert(evidence.branches>0);
});
test('post-serialization recheck rejects forged reference and branch receipts',()=>{
  const original=verifyTrainingCase({source,entry:'f',args:[3]});
  assert.equal(original.status,'locally_verified');
  const clean=JSON.parse(JSON.stringify(original.exported));
  const mutations=[
    e=>{e.sidecar.referenceStatus='not-checked';},
    e=>{e.sidecar.reference.outcome.graph.roots.at(-1)[1]=99;},
    e=>{e.sidecar.operationAudit.checked++;},
    e=>{e.sidecar.branchAudit.checked++;},
    e=>{e.sidecar.branchAudit.status='unverified';}
  ];
  for(const mutate of mutations) {
    const forged=structuredClone(clean);mutate(forged);
    const check=recheckIndependentTrainingEvidence(forged);
    assert.equal(check.valid,false,JSON.stringify(check));
    assert.equal(check.admitted,false);
  }
});
test('valid owned replay alone never substitutes for independent data evidence',()=>{
  const runtime=createRuntime().startEntry({text:source,functionName:'f',args:[3]});
  runtime.drive();
  const candidate=exportTraining(runtime);
  assert.equal(recheckIndependentTrainingEvidence(candidate).valid,false);
});
