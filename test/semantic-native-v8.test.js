import test from 'node:test';
import assert from 'node:assert/strict';
import {validateV8NativePolicy,validateV8NativeReceipt,V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST,V8_NATIVE_CHECKS} from '../src/semantic/native-v8.js';
import {verifyRegionTrainingCase,recheckRegionEvidence,admitRegionEvidence} from '../src/semantic/compiler-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

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

test('production region admission reruns source checking and refuses missing or fabricated native evidence',async()=>{
  await assert.rejects(recheckRegionEvidence(artifact,{requireNative:true}),/pinned consumer/);
  await assert.rejects(admitRegionEvidence(artifact,{nativePolicy:policy,nativeConsumer:async()=>({admitted:true})}),/receipt/);
  await assert.rejects(admitRegionEvidence(artifact,{nativeConsumer:async()=>unitReceipt()}),/exact/);
  const modified=structuredClone(artifact);modified.contexts[0].state.locals[0][1]=['num',1000];
  let called=false;
  await assert.rejects(admitRegionEvidence(modified,{nativePolicy:policy,nativeConsumer:async()=>{called=true;return unitReceipt();}}),/contexts/);
  assert.equal(called,false,'invalid source/context evidence must fail before invoking the native gate');
});
