// Exact pins for the independent v7 consumer. No v6 receipt is reusable.
import {readFileSync} from 'node:fs';
import {hashAlgorithmData} from './program.js';

const contract=JSON.parse(readFileSync(new URL('../../contracts/semantic-execution-v7.json',import.meta.url),'utf8'));
if(contract.digest!==hashAlgorithmData(contract.definition)||
  contract.fixtureDigest!==hashAlgorithmData(contract.fixtures))throw new Error('V7 contract digest changed');
export const V7_SCHEMA_DIGEST=contract.digest;
export const V7_FIXTURE_DIGEST=contract.fixtureDigest;
const HASH=/^[0-9a-f]{64}$/;
const REVISION=/^[0-9a-f]{40}$/;

export function validateV7NativePolicy(policy){
  if(policy?.schema!=='semantic-native-policy/7'||!REVISION.test(policy.consumerRevision??'')||
    !HASH.test(policy.tokenizerIdentity??'')||!HASH.test(policy.tokenizerSha256??'')||
    !HASH.test(policy.contractDigest??'')||policy.schemaDigest!==V7_SCHEMA_DIGEST||
    policy.fixtureDigest!==V7_FIXTURE_DIGEST)
    throw new Error('Exact v7 consumer, tokenizer and contract pins are required');
  return policy;
}

export function loadV7NativePolicy(path=new URL('../../contracts/semantic-native-policy-v7.json',import.meta.url)){
  return validateV7NativePolicy(JSON.parse(readFileSync(path,'utf8')));
}

export function validateV7NativeReceipt(exported,receipt,policy){
  validateV7NativePolicy(policy);
  if(receipt?.schema!=='semantic-native-admission/7'||receipt.componentGate!=='native-consumer-only'||
    receipt.traceFormat!=='semantic-trace/7'||receipt.representation!==exported.public.representation||
    receipt.episodeDigest!==hashAlgorithmData(exported.public)||
    receipt.contextsDigest!==hashAlgorithmData(exported.contexts)||receipt.optimizerSteps!==0||
    receipt.datasetBindingDigest!==(exported.sidecar?.datasetBinding?hashAlgorithmData(exported.sidecar.datasetBinding):null)||
    !HASH.test(receipt.nativeTrainingDigest??'')||
    ['consumerRevision','schemaDigest','fixtureDigest','contractDigest','tokenizerIdentity','tokenizerSha256']
      .some(key=>receipt[key]!==policy[key])||
    ['admitted','lossMaskValidated','visibilityValidated','fragmentationValidated','contextValidated',
      'continuationValidated'].some(key=>receipt[key]!==true)||
    ['generatedTokens','observedTokens','physicalRecords','actions'].some(key=>
      !Number.isSafeInteger(receipt[key])||receipt[key]<0)||
    receipt.generatedTokens===0||receipt.observedTokens===0||receipt.physicalRecords===0)
    throw new Error('Native v7 receipt is missing, stale, or incompatible with this artifact and policy');
  return true;
}
