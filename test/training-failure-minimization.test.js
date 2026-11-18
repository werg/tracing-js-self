import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {minimizeFailureRecord} from '../src/training/minimize-failure.js';
import {verifyFailureRecord} from '../src/training/failure-record.js';

const candidate={source:'"use strict";function unused(){return 42;} function run(){const x=1;const y=2;return this;}',
  entry:'run',args:[],fixture:{calls:[]},family:'minimize-unsupported'};
test('failure reducer preserves original evidence and independently verifies a smaller counterexample',async()=>{
  const original=await verifyEffectfulTrainingCase(candidate);
  assert.equal(original.category,'unsupported_source');
  const before=JSON.stringify(original.failure.original);
  const reduced=await minimizeFailureRecord(original.failure,{maxAttempts:32,maxTimeMs:10000});
  assert.equal(reduced.minimization.status,'reduced');
  assert(reduced.minimization.accepted>=2);
  assert.equal(JSON.stringify(reduced.original),before);
  assert.equal(reduced.failureDigest,original.failure.failureDigest);
  assert.equal(reduced.minimization.originalFailureDigest,original.failure.failureDigest);
  assert(reduced.minimization.counterexample.source.length<candidate.source.length);
  assert.match(reduced.minimization.counterexample.source,/return this/);
  assert.equal(reduced.minimization.counterexample.failure.original.category,'unsupported_source');
  assert.equal(verifyFailureRecord(JSON.parse(JSON.stringify(reduced))),true);
  const changed=structuredClone(reduced);changed.minimization.counterexample.source='invented';
  assert.throws(()=>verifyFailureRecord(changed),/receipt changed/);
});
test('minimization budgets and non-reproducing cases remain explicit',async()=>{
  const original=await verifyEffectfulTrainingCase(candidate);
  const bounded=await minimizeFailureRecord(original.failure,{maxAttempts:1,maxTimeMs:10000});
  assert.equal(bounded.minimization.status,'budget_exhausted');
  assert.equal(bounded.minimization.attempts,1);
  assert.equal(bounded.minimization.counterexample,null);
  const fixed=await minimizeFailureRecord(original.failure,{verify:async()=>({status:'locally_verified'})});
  assert.equal(fixed.minimization.status,'not_reproduced');
  assert.equal(fixed.minimization.counterexample,null);
  assert.equal(verifyFailureRecord(fixed),true);
});
