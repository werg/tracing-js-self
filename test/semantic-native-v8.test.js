import test from 'node:test';
import assert from 'node:assert/strict';
import {loadV8NativePolicy,validateV8NativePolicy,validateV8NativeReceipt,V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST,V8_NATIVE_CHECKS} from '../src/semantic/native-v8.js';
import {verifyRegionTrainingCase,recheckRegionEvidence,admitRegionEvidence} from '../src/semantic/compiler-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {identityDigest} from '../src/semantic/source-identity.js';
import {attachSourceQualifiedOrchestrationV8} from '../src/semantic/orchestration-training-v8.js';

const policy={schema:'semantic-native-policy/8',consumerRepository:'werg/megatoken',consumerRevision:'a'.repeat(40),
  contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,tokenizerIdentity:'b'.repeat(64),tokenizerSha256:'c'.repeat(64)};
const fixture={id:'native-v8-gate',family:'native-v8-gate',source:'"use strict";function run(x){return x*2;}',
  entry:'run',args:[3],fixture:{calls:[]}};
const qualified=await verifyRegionTrainingCase(fixture);
assert.ok(qualified.exported,JSON.stringify(qualified));
const artifact=qualified.exported;
// This is deliberately a receipt-validation unit fixture, not a claim that an
// external native consumer ran. Actual interoperability receipts live in runs.
function unitReceipt(){return {schema:'semantic-native-admission/8',componentGate:'native-consumer-only',
  traceFormat:'semantic-trace/8',contextFormat:'semantic-context/8',representation:'mixed',admitted:true,
  consumerRevision:policy.consumerRevision,contractDigest:policy.contractDigest,fixtureDigest:policy.fixtureDigest,interoperabilityDigest:policy.interoperabilityDigest,
  publicDigest:hashAlgorithmData(artifact.public),contextsDigest:hashAlgorithmData(artifact.contexts),
  sourceArtifactDigest:artifact.sidecar.sourceArtifactDigest,datasetBindingDigest:null,
  sourceVerification:{schema:'semantic-native-source-recheck/1',producerRevision:'f'.repeat(40),producerTreeClean:true,
    artifactSha256:'e'.repeat(64),sourceArtifactDigest:hashAlgorithmData(artifact.sidecar.sourceArtifact),
    publicDigest:hashAlgorithmData(artifact.public),contextDigest:hashAlgorithmData(artifact.contexts),
    sourceValidated:true,projectionValidated:true,replayValidated:true},
  nativeTrainingDigest:'d'.repeat(64),optimizerSteps:0,learningClaim:null,
  tokenizer:{status:'passed',identity:policy.tokenizerIdentity,sha256:policy.tokenizerSha256},
  checks:Object.fromEntries(V8_NATIVE_CHECKS.map(key=>[key,'passed'])),
  counts:{records:artifact.public.timeline.length,contexts:artifact.contexts.length,
    generatedRecords:artifact.contexts.length,generatedTokens:100,observedTokens:1000}};}

test('v8 receipt validator requires exact contract, source, contexts, tokenizer and every native gate',()=>{
  assert.equal(validateV8NativeReceipt(artifact,unitReceipt(),policy),true);
  for(const field of ['consumerRevision','contractDigest','fixtureDigest','interoperabilityDigest','publicDigest','contextsDigest','sourceArtifactDigest','nativeTrainingDigest']){
    const bad=unitReceipt();bad[field]='bad';assert.throws(()=>validateV8NativeReceipt(artifact,bad,policy),/Native v8/);
  }
  for(const field of ['producerRevision','artifactSha256','sourceArtifactDigest','publicDigest','contextDigest']){
    const bad=unitReceipt();bad.sourceVerification[field]='bad';
    assert.throws(()=>validateV8NativeReceipt(artifact,bad,policy),/source correspondence/);
  }
  const missingSource=unitReceipt();delete missingSource.sourceVerification;
  assert.throws(()=>validateV8NativeReceipt(artifact,missingSource,policy),/source correspondence/);
  for(const gate of V8_NATIVE_CHECKS){const bad=unitReceipt();bad.checks[gate]='untested';
    assert.throws(()=>validateV8NativeReceipt(artifact,bad,policy),/gates/);}
  const badTokenizer=unitReceipt();badTokenizer.tokenizer.sha256='e'.repeat(64);
  assert.throws(()=>validateV8NativeReceipt(artifact,badTokenizer,policy),/tokenizer/);
  const badCounts=unitReceipt();badCounts.counts.generatedRecords++;
  assert.throws(()=>validateV8NativeReceipt(artifact,badCounts,policy),/counts/);
  const legacy=unitReceipt();legacy.schema='semantic-native-admission/7';
  assert.throws(()=>validateV8NativeReceipt(artifact,legacy,policy),/receipt/);
  assert.throws(()=>validateV8NativeReceipt(artifact,{admitted:true},policy),/receipt/);
  assert.throws(()=>validateV8NativePolicy({...policy,contractDigest:'f'.repeat(64)}),/exact/);
});

test('the current native contract accepts observed revisions without freezing the development pair',()=>{
  const current=loadV8NativePolicy();
  assert.equal(Object.hasOwn(current,'consumerRevision'),false);
  const {consumerRevision,...contract}=policy;
  assert.equal(validateV8NativePolicy(contract),contract);
  for(const revision of ['1'.repeat(40),'2'.repeat(40)]){
    const receipt={...unitReceipt(),consumerRevision:revision};
    assert.equal(validateV8NativeReceipt(artifact,receipt,contract),true);
    assert.throws(()=>validateV8NativeReceipt(artifact,receipt,policy),/consumerRevision/);
  }
  assert.throws(()=>validateV8NativeReceipt(artifact,{...unitReceipt(),consumerRevision:null},contract),/consumerRevision/);
  assert.throws(()=>validateV8NativePolicy({...contract,consumerRevision:null}),/observed consumer/);
});

test('production region admission reruns source checking and refuses missing or fabricated native evidence',async()=>{
  await assert.rejects(recheckRegionEvidence(artifact,{requireNative:true}),/pinned consumer/);
  await assert.rejects(admitRegionEvidence(artifact,{nativePolicy:policy,nativeConsumer:async()=>({admitted:true})}),/receipt/);
  await assert.rejects(admitRegionEvidence(artifact,{nativeConsumer:async()=>unitReceipt()}),/exact/);
  const modified=structuredClone(artifact);modified.contexts[0].state.locals[0][1]=['num',1000];
  let called=false;
  await assert.rejects(admitRegionEvidence(modified,{nativePolicy:policy,nativeConsumer:async()=>{called=true;return unitReceipt();}}),/contexts/);
  assert.equal(called,false,'invalid source/context evidence must fail before invoking the native gate');
});

test('orchestration admission requires one exact transcript across source and native receipts',async()=>{
  const augmented=await attachSourceQualifiedOrchestrationV8(artifact),
    digest=hashAlgorithmData(augmented.sidecar.orchestrationTranscript),receipt=unitReceipt();
  receipt.orchestrationTranscriptDigest=digest;
  Object.assign(receipt.sourceVerification,{orchestrationTranscriptDigest:digest,orchestrationValidated:true});
  receipt.checks.orchestration='passed';receipt.counts.orchestrationRecords=4;
  assert.equal(validateV8NativeReceipt(augmented,receipt,policy),true);
  for(const mutate of [
    row=>{delete row.orchestrationTranscriptDigest;},
    row=>{row.orchestrationTranscriptDigest='e'.repeat(64);},
    row=>{delete row.sourceVerification.orchestrationTranscriptDigest;},
    row=>{row.sourceVerification.orchestrationTranscriptDigest='e'.repeat(64);},
    row=>{row.sourceVerification.orchestrationValidated=false;},
    row=>{delete row.checks.orchestration;},
    row=>{row.counts.orchestrationRecords=0;}
  ]){
    const changed=structuredClone(receipt);mutate(changed);
    assert.throws(()=>validateV8NativeReceipt(augmented,changed,policy),/Native v8/);
  }
  for(const mutate of [
    row=>{row.orchestrationTranscriptDigest=digest;},
    row=>{row.sourceVerification.orchestrationValidated=true;},
    row=>{row.sourceVerification.orchestrationTranscriptDigest=digest;},
    row=>{row.checks.orchestration='passed';},
    row=>{row.counts.orchestrationRecords=4;}
  ]){
    const changed=unitReceipt();mutate(changed);
    assert.throws(()=>validateV8NativeReceipt(artifact,changed,policy),/Native v8/);
  }
  const nullTranscript=structuredClone(artifact);nullTranscript.sidecar.orchestrationTranscript=null;
  assert.throws(()=>validateV8NativeReceipt(nullTranscript,unitReceipt(),policy),/V8 orchestration training/);
});

test('direct host receipts bind exactly one verified source identity without a nested artifact',()=>{
  // Shape-only receipt controls. Actual original-source/native/tokenizer checks
  // run separately through qualify-semantic-v8 on clean paired revisions.
  const direct=structuredClone(artifact),side=direct.sidecar;
  delete side.sourceArtifact;delete side.sourceArtifactDigest;
  side.schema='semantic-protocol-host-region-evidence/1';
  side.identity={schema:'semantic-source-candidate-identity/8',
    execution:{execution:'semantic-execution/8',trace:'semantic-trace/8',context:'semantic-context/8',
      harness:'compositional-regions/1',representation:'mixed'},
    certification:{schemaDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,
      evidenceKind:'deterministic-engineering',optimizerSteps:0,learnedSuccess:null}};
  side.identityDigest=identityDigest(side.identity);
  const receipt=unitReceipt();receipt.sourceArtifactDigest=null;receipt.sourceIdentityDigest=side.identityDigest;
  Object.assign(receipt.sourceVerification,{sourceArtifactDigest:null,
    sourceIdentityDigest:side.identityDigest,identityValidated:true});
  assert.equal(validateV8NativeReceipt(direct,receipt,policy),true);
  for(const location of ['receipt','verification'])for(const field of ['sourceIdentityDigest','sourceArtifactDigest']){
    const changed=structuredClone(receipt),target=location==='receipt'?changed:changed.sourceVerification;
    target[field]='0'.repeat(64);
    assert.throws(()=>validateV8NativeReceipt(direct,changed,policy),/receipt|source correspondence/);
    delete target[field];
    assert.throws(()=>validateV8NativeReceipt(direct,changed,policy),/receipt|source correspondence/);
  }
  for(const value of [false,undefined]){
    const changed=structuredClone(receipt);changed.sourceVerification.identityValidated=value;
    assert.throws(()=>validateV8NativeReceipt(direct,changed,policy),/source correspondence/);
  }
  for(const mutate of [
    value=>{delete value.sidecar.identity;},
    value=>{value.sidecar.sourceArtifact={};},
    value=>{value.sidecar.identity.execution.trace='semantic-trace/6';},
    value=>{value.sidecar.identity.certification.schemaDigest='0'.repeat(64);},
    value=>{value.sidecar.identity.certification.learnedSuccess=true;}
  ]){
    const changed=structuredClone(direct);mutate(changed);
    if(changed.sidecar.identity)changed.sidecar.identityDigest=identityDigest(changed.sidecar.identity);
    assert.throws(()=>validateV8NativeReceipt(changed,receipt,policy),/direct source identity/);
  }
  const nested=unitReceipt();nested.sourceIdentityDigest=side.identityDigest;
  assert.throws(()=>validateV8NativeReceipt(artifact,nested,policy),/receipt/);
});
