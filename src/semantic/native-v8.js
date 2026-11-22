// Native admission is a distinct gate from source checking and JS replay.
// A historical v6/v7 receipt or a bare admitted=true cannot qualify v8 data.
import {readFileSync} from 'node:fs';
import {hashAlgorithmData} from './program.js';
import {SEMANTIC_V8_DEFINITION} from './contract-v8.js';
import {identityDigest} from './source-identity.js';
import {validateOrchestrationTranscriptV8} from './orchestration-training-v8.js';

const contract=JSON.parse(readFileSync(new URL('../../contracts/semantic-execution-v8.json',import.meta.url),'utf8'));
if(contract.schema!=='semantic-execution-contract/8'||contract.digest!==hashAlgorithmData(contract.definition)||
  contract.digest!==hashAlgorithmData(SEMANTIC_V8_DEFINITION)||contract.fixtureDigest!==hashAlgorithmData(contract.fixtures)||
  contract.interoperabilityDigest!==hashAlgorithmData(contract.interoperability))
  throw new Error('V8 contract snapshot differs from the current producer');
export const V8_CONTRACT_DIGEST=contract.digest;
export const V8_FIXTURE_DIGEST=contract.fixtureDigest;
export const V8_INTEROPERABILITY_DIGEST=contract.interoperabilityDigest;
const HASH=/^[a-f0-9]{64}$/;
const REVISION=/^[a-f0-9]{40}$/;
const fail=message=>{throw new Error('Native v8: '+message);};
export const V8_NATIVE_CHECKS=Object.freeze(['replay','contexts','continuation','masks','sourceBinding','tokenizer']);

export function validateV8NativePolicy(policy){
  if(policy?.schema!=='semantic-native-policy/8'||policy.consumerRepository!=='werg/megatoken'||
    !REVISION.test(policy.consumerRevision??'')||policy.contractDigest!==V8_CONTRACT_DIGEST||
    policy.fixtureDigest!==V8_FIXTURE_DIGEST||policy.interoperabilityDigest!==V8_INTEROPERABILITY_DIGEST||!HASH.test(policy.tokenizerIdentity??'')||
    !HASH.test(policy.tokenizerSha256??''))fail('exact consumer, contract, fixtures and tokenizer pins required');
  return policy;
}
export function loadV8NativePolicy(path=new URL('../../contracts/semantic-native-policy-v8.json',import.meta.url)){
  return validateV8NativePolicy(JSON.parse(readFileSync(path,'utf8')));
}

export function validateV8NativeReceipt(exported,receipt,policy){
  validateV8NativePolicy(policy);
  const direct=exported?.sidecar?.schema==='semantic-protocol-host-region-evidence/1';
  if(exported?.public?.schema!=='semantic-execution/8'||exported.public.traceFormat!=='semantic-trace/8'||
    !Array.isArray(exported.contexts)||!['semantic-region-evidence/1','semantic-protocol-region-evidence/1',
      'semantic-protocol-host-region-evidence/1','semantic-session-region-evidence/1'].includes(exported.sidecar?.schema))
    fail('exact v8 source-bound artifact required');
  const side=exported.sidecar,identity=side.identity;
  let sourceArtifactDigest;
  if(direct){
    const execution=identity?.execution,certification=identity?.certification;
    if(Object.hasOwn(side,'sourceArtifact')||side.sourceArtifactDigest!=null||
      !identity||identity.schema!=='semantic-source-candidate-identity/8'||
      !HASH.test(side.identityDigest??'')||side.identityDigest!==identityDigest(identity)||
      execution?.execution!=='semantic-execution/8'||execution.trace!=='semantic-trace/8'||
      execution.context!=='semantic-context/8'||execution.harness!=='compositional-regions/1'||
      execution.representation!=='mixed'||certification?.schemaDigest!==V8_CONTRACT_DIGEST||
      certification.fixtureDigest!==V8_FIXTURE_DIGEST||certification.evidenceKind!=='deterministic-engineering'||
      certification.optimizerSteps!==0||certification.learnedSuccess!==null)
      fail('direct source identity is missing or incompatible');
    sourceArtifactDigest=null;
  }else{
    if(!side.sourceArtifact||typeof side.sourceArtifact!=='object'||Array.isArray(side.sourceArtifact)||
      side.sourceArtifactDigest!==hashAlgorithmData(side.sourceArtifact))fail('source artifact digest is missing or altered');
    if(side.schema==='semantic-session-region-evidence/1'&&
      (side.sourceArtifact.public?.schema!=='semantic-session-source-target/1'||
       side.sourceArtifact.sidecar?.schema!=='semantic-session-source-evidence/1'))
      fail('source session evidence has an incompatible original collection');
    sourceArtifactDigest=side.sourceArtifactDigest;
  }
  const generated=exported.public.timeline.filter(row=>row.mode==='generated').length;
  const hasOrchestration=Object.hasOwn(side,'orchestrationTranscript'),
    orchestrationDigest=hasOrchestration?hashAlgorithmData(side.orchestrationTranscript):null;
  if(hasOrchestration)validateOrchestrationTranscriptV8(exported);
  if(receipt?.schema!=='semantic-native-admission/8'||receipt.componentGate!=='native-consumer-only'||
    receipt.traceFormat!=='semantic-trace/8'||receipt.contextFormat!=='semantic-context/8'||
    receipt.representation!=='mixed'||receipt.admitted!==true||receipt.optimizerSteps!==0||receipt.learningClaim!==null||
    receipt.publicDigest!==hashAlgorithmData(exported.public)||receipt.contextsDigest!==hashAlgorithmData(exported.contexts)||
    receipt.sourceArtifactDigest!==sourceArtifactDigest||
    (hasOrchestration?receipt.orchestrationTranscriptDigest!==orchestrationDigest:
      Object.hasOwn(receipt,'orchestrationTranscriptDigest'))||
    (direct?receipt.sourceIdentityDigest!==side.identityDigest:Object.hasOwn(receipt,'sourceIdentityDigest'))||
    receipt.datasetBindingDigest!==(exported.sidecar.datasetBinding?hashAlgorithmData(exported.sidecar.datasetBinding):null)||
    !HASH.test(receipt.nativeTrainingDigest??''))fail('receipt is missing, stale, unadmitted, or bound to another artifact');
  for(const key of ['consumerRevision','contractDigest','fixtureDigest','interoperabilityDigest'])
    if(receipt[key]!==policy[key])fail('receipt differs from pinned '+key);
  if(V8_NATIVE_CHECKS.some(key=>receipt.checks?.[key]!=='passed'))fail('all independent native gates must pass');
  const source=receipt.sourceVerification;
  if(source?.schema!=='semantic-native-source-recheck/1'||source.producerTreeClean!==true||
    !REVISION.test(source.producerRevision??'')||source.sourceValidated!==true||
    source.projectionValidated!==true||source.replayValidated!==true||
    (hasOrchestration?source.orchestrationTranscriptDigest!==orchestrationDigest||
      source.orchestrationValidated!==true:Object.hasOwn(source,'orchestrationTranscriptDigest')||
      Object.hasOwn(source,'orchestrationValidated'))||
    !HASH.test(source.artifactSha256??'')||source.sourceArtifactDigest!==sourceArtifactDigest||
    (direct?source.sourceIdentityDigest!==side.identityDigest||source.identityValidated!==true:
      Object.hasOwn(source,'sourceIdentityDigest'))||
    source.publicDigest!==hashAlgorithmData(exported.public)||source.contextDigest!==hashAlgorithmData(exported.contexts))
    fail('receipt is missing fresh independent source correspondence verification');
  if(receipt.tokenizer?.status!=='passed'||receipt.tokenizer.identity!==policy.tokenizerIdentity||
    receipt.tokenizer.sha256!==policy.tokenizerSha256)fail('tokenizer bytes or identity changed');
  const counts=receipt.counts;
  if(!counts||counts.records!==exported.public.timeline.length||counts.contexts!==exported.contexts.length||
    counts.generatedRecords!==generated||generated!==exported.contexts.length||
    !Number.isSafeInteger(counts.generatedTokens)||counts.generatedTokens<1||
    !Number.isSafeInteger(counts.observedTokens)||counts.observedTokens<1)
    fail('physical supervision counts do not describe this execution');
  if(hasOrchestration&&(receipt.checks.orchestration!=='passed'||counts.orchestrationRecords!==4))
    fail('the four source-qualified lifecycle targets were not independently admitted');
  if(!hasOrchestration&&(Object.hasOwn(receipt.checks,'orchestration')||Object.hasOwn(counts,'orchestrationRecords')))
    fail('orchestration admission claims require the exact source-qualified transcript');
  return true;
}
