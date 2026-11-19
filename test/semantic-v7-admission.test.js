import test from 'node:test';
import assert from 'node:assert/strict';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {V7_SCHEMA_DIGEST,V7_FIXTURE_DIGEST,validateV7NativeReceipt,
  validateV7NativePolicy} from '../src/semantic/native-v7.js';

const policy={schema:'semantic-native-policy/7',consumerRevision:'a'.repeat(40),
  tokenizerIdentity:'b'.repeat(64),tokenizerSha256:'c'.repeat(64),contractDigest:'d'.repeat(64),
  schemaDigest:V7_SCHEMA_DIGEST,fixtureDigest:V7_FIXTURE_DIGEST};
const exported={public:{schema:'semantic-execution/7',representation:'detailed'},contexts:[
  {schema:'semantic-context/7',representation:'detailed',visibleThrough:2}]};
const receipt=()=>({schema:'semantic-native-admission/7',componentGate:'native-consumer-only',
  traceFormat:'semantic-trace/7',representation:'detailed',episodeDigest:hashAlgorithmData(exported.public),
  contextsDigest:hashAlgorithmData(exported.contexts),consumerRevision:policy.consumerRevision,
  nativeTrainingDigest:'9'.repeat(64),
  schemaDigest:policy.schemaDigest,fixtureDigest:policy.fixtureDigest,contractDigest:policy.contractDigest,
  tokenizerIdentity:policy.tokenizerIdentity,tokenizerSha256:policy.tokenizerSha256,admitted:true,
  lossMaskValidated:true,visibilityValidated:true,fragmentationValidated:true,contextValidated:true,
  continuationValidated:true,optimizerSteps:0,generatedTokens:4,observedTokens:2,physicalRecords:7,actions:0});

test('v7 native receipts require exact declared policy pins and all admission gates',()=>{
  assert.equal(validateV7NativePolicy(policy),policy);
  assert.equal(validateV7NativeReceipt(exported,receipt(),policy),true);
  for(const mutate of [
    value=>{value.schema='semantic-native-admission/6';},
    value=>{value.admitted=false;},
    value=>{value.lossMaskValidated=false;},
    value=>{value.visibilityValidated=false;},
    value=>{value.fragmentationValidated=false;},
    value=>{value.contextValidated=false;},
    value=>{value.continuationValidated=false;},
    value=>{value.consumerRevision='e'.repeat(40);},
    value=>{value.tokenizerSha256='f'.repeat(64);},
    value=>{value.representation='algorithm';},
    value=>{value.contextsDigest='0'.repeat(64);}
  ]){
    const changed=receipt();mutate(changed);
    assert.throws(()=>validateV7NativeReceipt(exported,changed,policy));
  }
  const changedContexts=structuredClone(exported);changedContexts.contexts[0].visibleThrough++;
  assert.throws(()=>validateV7NativeReceipt(changedContexts,receipt(),policy));
  assert.throws(()=>validateV7NativePolicy({...policy,consumerRevision:'bad'}));
});
