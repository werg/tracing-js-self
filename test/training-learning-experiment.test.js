import test from 'node:test';
import assert from 'node:assert/strict';
import {learningCase,diverseSubset} from '../tools/freeze-learning-experiment.mjs';
import {buildSourceRegistry,frozenSplitIdentity} from '../src/corpus/source-registry.mjs';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

test('frozen learning requests exclude teacher selections and keep expected outcomes private',async()=>{
  const source='"use strict";function run(x){return x+1;}',family='frozen-learning-source';
  const registry=buildSourceRegistry([{id:'source',family,source,project:'held-out-project'}],
    {holdoutProjects:['held-out-project']});
  const splitIdentity=frozenSplitIdentity(registry,family);
  const checked=await verifyEffectfulTrainingCase({source,entry:'run',args:[7],fixture:{calls:[]},
    family,splitIdentity,seed:17});
  assert.equal(checked.status,'locally_verified');
  // Isolated shape fixture only. The CLI obtains these claims from a fresh
  // source/native-binding recheck in the exact immutable producer checkout.
  const side=checked.exported.sidecar;
  side.admission='admitted';side.nativeAdmission={admitted:true,generatedTokens:10};
  const sourceReceipt={identityValidated:true,identityDigest:side.identityDigest,
    producerRevision:side.producerRevision,sourceValidated:true,journalValidated:true,
    replayValidated:true,effectsValidated:true,episodeDigest:'fixture'};
  const frozen=learningCase(checked.exported,{path:'/fixture.json',fileSha256:'f'.repeat(64),sourceReceipt});
  assert.equal(frozen.split,'test');
  assert.equal(frozen.sourceCluster,splitIdentity.componentId);
  assert(frozen.slices.includes('upstream-project'));
  assert(frozen.slices.includes('pure-selected'));
  assert(frozen.expected.completion);
  assert.equal(frozen.envelope.request.controlledSelectionsByRepresentation,undefined);
  assert.equal(frozen.envelope.expected,undefined);
  assert.equal(frozen.envelope.request.expected,undefined);
  assert.equal(frozen.envelope.caseId,frozen.id);
  assert.throws(()=>learningCase(checked.exported,{sourceReceipt:{...sourceReceipt,identityDigest:'changed'}}),/Fresh source/);
  side.admission='locally_verified';
  assert.throws(()=>learningCase(checked.exported,{sourceReceipt}),/actual native admission/);
});

test('frozen admission selection covers components before repeated variants',()=>{
  const rows=[{id:'a0',sourceCluster:'a'},{id:'a1',sourceCluster:'a'},
    {id:'a2',sourceCluster:'a'},{id:'b0',sourceCluster:'b'},{id:'c0',sourceCluster:'c'}];
  assert.deepEqual(diverseSubset(rows,3).map(row=>row.id),['a0','b0','c0']);
  assert.deepEqual(diverseSubset(rows,4).map(row=>row.id),['a0','b0','c0','a1']);
  assert.deepEqual(diverseSubset([...rows].reverse(),3),diverseSubset(rows,3));
});
