// Native admission is a distinct gate from source checking and JS replay.
// A historical v6/v7 receipt or a bare admitted=true cannot qualify v8 data.
import {readFileSync} from 'node:fs';
import {hashAlgorithmData} from './program.js';
import {SEMANTIC_V8_DEFINITION} from './contract-v8.js';

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
  if(exported?.public?.schema!=='semantic-execution/8'||exported.public.traceFormat!=='semantic-trace/8'||
    !Array.isArray(exported.contexts)||!['semantic-region-evidence/1','semantic-protocol-region-evidence/1'].includes(exported.sidecar?.schema))
    fail('exact v8 source-bound artifact required');
  const generated=exported.public.timeline.filter(row=>row.mode==='generated').length;
  if(receipt?.schema!=='semantic-native-admission/8'||receipt.componentGate!=='native-consumer-only'||
    receipt.traceFormat!=='semantic-trace/8'||receipt.contextFormat!=='semantic-context/8'||
    receipt.representation!=='mixed'||receipt.admitted!==true||receipt.optimizerSteps!==0||receipt.learningClaim!==null||
    receipt.publicDigest!==hashAlgorithmData(exported.public)||receipt.contextsDigest!==hashAlgorithmData(exported.contexts)||
    receipt.sourceArtifactDigest!==exported.sidecar.sourceArtifactDigest||
    receipt.datasetBindingDigest!==(exported.sidecar.datasetBinding?hashAlgorithmData(exported.sidecar.datasetBinding):null)||
    !HASH.test(receipt.nativeTrainingDigest??''))fail('receipt is missing, stale, unadmitted, or bound to another artifact');
  for(const key of ['consumerRevision','contractDigest','fixtureDigest','interoperabilityDigest'])
    if(receipt[key]!==policy[key])fail('receipt differs from pinned '+key);
  if(V8_NATIVE_CHECKS.some(key=>receipt.checks?.[key]!=='passed'))fail('all independent native gates must pass');
  if(receipt.tokenizer?.status!=='passed'||receipt.tokenizer.identity!==policy.tokenizerIdentity||
    receipt.tokenizer.sha256!==policy.tokenizerSha256)fail('tokenizer bytes or identity changed');
  const counts=receipt.counts;
  if(!counts||counts.records!==exported.public.timeline.length||counts.contexts!==exported.contexts.length||
    counts.generatedRecords!==generated||generated!==exported.contexts.length||
    !Number.isSafeInteger(counts.generatedTokens)||counts.generatedTokens<1||
    !Number.isSafeInteger(counts.observedTokens)||counts.observedTokens<1)
    fail('physical supervision counts do not describe this execution');
  return true;
}
