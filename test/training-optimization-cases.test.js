import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizationCase} from '../tools/build-optimization-cases.mjs';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

test('optimization evaluation strips teacher selections and keeps oracle outside the model envelope',async()=>{
  const checked=await verifyEffectfulTrainingCase({source:'"use strict";function run(){return 7;}',
    entry:'run',family:'optimizer-check',fixture:{calls:[]}});
  assert.equal(checked.status,'locally_verified');
  // This isolated shape test supplies the upstream native receipt explicitly;
  // actual smoke runs use the real pinned consumer to recheck every candidate.
  checked.exported.sidecar.admission='admitted';
  checked.exported.sidecar.nativeAdmission={admitted:true};
  checked.exported.sidecar.split='train';
  const result=optimizationCase(checked.exported);
  assert(result.expected.completion);
  assert.equal(result.envelope.request.controlledSelectionsByRepresentation,undefined);
  assert.equal(result.envelope.expected,undefined);
  assert.equal(result.envelope.request.expected,undefined);
  assert.equal(result.envelope.seed,17);
  assert.equal(checked.exported.public.timeline.filter(item=>item.kind==='semantic').length>0,true);
  checked.exported.sidecar.split='test';
  assert.throws(()=>optimizationCase(checked.exported),/training examples/);
  checked.exported.sidecar.split='train';
  checked.exported.sidecar.nativeAdmission.admitted=false;
  assert.throws(()=>optimizationCase(checked.exported),/training examples/);
});
