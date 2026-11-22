import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticRecipeFamilies} from '../src/training/recipe-fixtures.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {verifyRegionSourceSessionV8} from '../src/semantic/source-session-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {regionArtifactSource,verifyRegionDatasetBinding} from '../src/semantic/family-registry-v8.js';
import {bindRegionFamilySplit} from '../src/semantic/dataset-v8.js';
import {buildSemanticRegionSupportCohortV8} from '../fixtures/semantic-regions/support-cohort.js';
import {validateV8NativeReceipt,V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST} from '../src/semantic/native-v8.js';

const family=semanticRecipeFamilies()[0],clone=structuredClone;
let collected;
const original=async()=>collected??=await verifyRegionTrainingCase({...family.repeated,
  sessionCases:family.repeated.cases,seed:17});
const sourceSide=artifact=>artifact.sidecar.sourceArtifact.sidecar;
const resignSource=artifact=>{artifact.sidecar.sourceArtifactDigest=hashAlgorithmData(artifact.sidecar.sourceArtifact);return artifact;};

test('source sessions retain both independently checked fresh roots and every original target byte',async()=>{
  const result=await original();
  assert.equal(result.status,'locally_verified',result.reason);
  assert.equal(result.declared,2);
  assert.equal(result.components.length,2);
  assert(result.components.every(row=>row.sourceQualified));
  const artifact=result.exported,collection=sourceSide(artifact).collection,
    roots=artifact.public.timeline.filter(row=>row.kind==='invocation');
  assert.equal(artifact.public.timeline.filter(row=>row.kind==='program').length,1);
  assert.deepEqual(roots.map(row=>row.fields.invocationId),['ingress1','ingress2']);
  assert.deepEqual(roots.map(row=>row.fields.realmId),['realm1','realm2']);
  assert(roots.every(row=>row.fields.realmPolicy==='fresh'&&row.fields.parentInvocationId===null));
  assert.deepEqual(artifact.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line),
    collection.components.flatMap(component=>component.public.timeline.filter(row=>row.mode==='generated')
      .map(row=>row.fields.line)));
  assert.equal(artifact.contexts.length,24);
  assert.equal(artifact.sidecar.receipts.length,artifact.public.timeline.length);
  assert.equal(artifact.sidecar.nativeAdmission,null);
  assert.equal(artifact.sidecar.optimizerSteps,0);
  assert.equal(artifact.sidecar.learningClaim,null);
  assert.equal(artifact.sidecar.regionCoverage.compactRegions,2);
  assert.equal(artifact.sidecar.regionCoverage.detailedRegions,4);
  assert.deepEqual(regionArtifactSource(artifact),{family:family.family,
    ancestors:['source-template:rectangle-perimeter'],source:family.repeated.cases[0].source,entry:'run'});
  assert.equal(RegionExecutionHarness.replay(artifact).invocations.size,2);
});

test('session source recheck independently reruns both components after a JSON round trip',async()=>{
  const artifact=JSON.parse(JSON.stringify((await original()).exported)),checked=await recheckRegionEvidence(artifact);
  assert.equal(checked.valid,true);
  assert.equal(checked.sourceValidated,true);
  assert.equal(checked.projectionValidated,true);
  assert.equal(checked.replayValidated,true);
  assert.equal(checked.completed,2);
  assert.equal(checked.source.components.length,2);
  assert(checked.source.components.every(row=>row.sourceValidated));
  assert.deepEqual(checked.native,{status:'untested',admitted:false});
});

test('source session remains one exact member of the registry frozen before collection',async()=>{
  const cohort=buildSemanticRegionSupportCohortV8(),fixture=cohort.fixtures.find(row=>
    row.supportCohort.template==='rectangle-perimeter'&&row.supportCohort.variant==='repeated-2calls'),
    member=cohort.registry.sources.find(row=>row.id===fixture.id),artifact=(await original()).exported,
    bound=bindRegionFamilySplit(artifact,{...member,artifact},cohort.registry);
  assert.equal(verifyRegionDatasetBinding(bound).valid,true);
  assert.equal(bound.sidecar.splitIdentity.sourceId,fixture.id);
  assert.equal((await recheckRegionEvidence(bound)).sourceValidated,true);
  const changed=clone(bound);changed.sidecar.datasetBinding.sourceId='a-different-source';
  assert.throws(()=>verifyRegionDatasetBinding(changed),/binding/);
});

test('rehashing an altered original source cannot certify a source session',async()=>{
  const changed=clone((await original()).exported),component=sourceSide(changed).collection.components[0];
  component.sidecar.sourceArtifact.sidecar.referenceInput.source+='\n/* changed after collection */';
  component.sidecar.sourceArtifactDigest=hashAlgorithmData(component.sidecar.sourceArtifact);
  resignSource(changed);
  await assert.rejects(recheckRegionEvidence(changed),/source|identity|binding|digest/i);
});

test('rehashed changes to the composition plan, public bytes and component authority refuse',async()=>{
  for(const mutate of [
    artifact=>{sourceSide(artifact).collection.plan.calls[1].invocationId='ingress1';resignSource(artifact);},
    artifact=>{const row=artifact.public.timeline.find(row=>row.mode==='generated');row.fields.line+=' ';
      artifact.sidecar.publicDigest=hashAlgorithmData(artifact.public);},
    artifact=>{sourceSide(artifact).collection.components[0].sidecar.datasetBinding={};resignSource(artifact);}
    ,artifact=>{sourceSide(artifact).collection.components[0].sidecar.sourceArtifact.sidecar.selectionOrigin=
      'controlled-fixture';resignSource(artifact);}
  ]){
    const changed=clone((await original()).exported);mutate(changed);
    await assert.rejects(recheckRegionEvidence(changed),/source|collection|public|component|binding|teacher|provenance/i);
  }
});

test('colliding callback identities retain both source dispositions and refuse session composition',async()=>{
  // The current source compiler starts its callback ID pool anew in each
  // independently collected component. These certified IDs are never renamed.
  const result=await verifyRegionSourceSessionV8({family:family.family,
    cases:[family.callbacks,family.callbacks]});
  assert.equal(result.status,'unsupported');
  assert.equal(result.phase,'session-composition');
  assert.equal(result.declared,2);
  assert(result.components.every(row=>row.sourceQualified));
  assert.match(result.reason,/callback registration collided/);
  assert.equal(result.exported,undefined);
});

test('a failed declared source call stays in the denominator and prevents partial session export',async()=>{
  const cases=clone(family.repeated.cases);
  cases[1].projectionOptions={...cases[1].projectionOptions,maxGenerated:1};
  const result=await verifyRegionSourceSessionV8({family:family.family,cases});
  assert.equal(result.status,'source-unqualified',result.reason);
  assert.equal(result.declared,2);
  assert.equal(result.components.length,2);
  assert.equal(result.components[0].sourceQualified,true);
  assert.equal(result.components[1].sourceQualified,false);
  assert.equal(result.exported,undefined);
});

test('the bounded session profile refuses changed sources and out-of-range root counts before collection',async()=>{
  const changed=clone(family.repeated.cases);changed[1].source+=' ';
  await assert.rejects(verifyRegionSourceSessionV8({family:family.family,cases:changed}),/one exact source/);
  for(const cases of [[],[family.repeated.cases[0]],Array(17).fill(family.repeated.cases[0])])
    await assert.rejects(verifyRegionSourceSessionV8({family:family.family,cases}),/two through sixteen/);
});

test('native session receipts must bind the complete source collection and exact native gates',async()=>{
  // This is a receipt-validator unit control. It deliberately does not claim
  // that the production tokenizer or independent Python admission ran here.
  const artifact=(await original()).exported,side=artifact.sidecar,
    policy={schema:'semantic-native-policy/8',consumerRepository:'werg/megatoken',consumerRevision:'a'.repeat(40),
      contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,
      interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,tokenizerIdentity:'b'.repeat(64),tokenizerSha256:'c'.repeat(64)},
    receipt={schema:'semantic-native-admission/8',componentGate:'native-consumer-only',traceFormat:'semantic-trace/8',
      contextFormat:'semantic-context/8',representation:'mixed',admitted:true,optimizerSteps:0,learningClaim:null,
      publicDigest:side.publicDigest,contextsDigest:side.contextDigest,sourceArtifactDigest:side.sourceArtifactDigest,
      datasetBindingDigest:null,nativeTrainingDigest:'d'.repeat(64),consumerRevision:policy.consumerRevision,
      contractDigest:policy.contractDigest,fixtureDigest:policy.fixtureDigest,interoperabilityDigest:policy.interoperabilityDigest,
      checks:Object.fromEntries(['replay','contexts','continuation','masks','sourceBinding','tokenizer'].map(key=>[key,'passed'])),
      sourceVerification:{schema:'semantic-native-source-recheck/1',producerTreeClean:true,producerRevision:'e'.repeat(40),
        sourceValidated:true,projectionValidated:true,replayValidated:true,artifactSha256:'f'.repeat(64),
        sourceArtifactDigest:side.sourceArtifactDigest,publicDigest:side.publicDigest,contextDigest:side.contextDigest},
      tokenizer:{status:'passed',identity:policy.tokenizerIdentity,sha256:policy.tokenizerSha256},
      counts:{records:artifact.public.timeline.length,contexts:artifact.contexts.length,
        generatedRecords:artifact.contexts.length,generatedTokens:1,observedTokens:1}};
  assert.equal(validateV8NativeReceipt(artifact,receipt,policy),true);
  const admitted=clone(artifact);
  Object.assign(admitted.sidecar,{admission:'admitted',nativeAdmission:clone(receipt)});
  assert.deepEqual((await recheckRegionEvidence(admitted)).native,{status:'untested',admitted:false},
    'source-only recheck never promotes even a structurally bound stored native receipt');
  const inconsistent=clone(artifact);inconsistent.sidecar.nativeAdmission=clone(receipt);
  await assert.rejects(recheckRegionEvidence(inconsistent),/claimed native admission/);
  const missing=clone(artifact);missing.sidecar.admission='admitted';
  await assert.rejects(recheckRegionEvidence(missing),/native|pins/i);
  for(const field of ['sourceArtifactDigest','publicDigest','contextsDigest']){
    const changed=clone(receipt);changed[field]='0'.repeat(64);
    assert.throws(()=>validateV8NativeReceipt(artifact,changed,policy),/receipt/);
  }
  const changed=clone(receipt);changed.checks.sourceBinding='untested';
  assert.throws(()=>validateV8NativeReceipt(artifact,changed,policy),/native gates/);
  await assert.rejects(recheckRegionEvidence(artifact,{requireNative:true}),/native admission/);
});
