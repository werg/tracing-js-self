// Original-source certification for direct V8 detail. Native admission is bound
// later to the final compact/detail/protocol artifact, never to an old episode.
import {createSourceAdmissionClient} from './source-admission.js';
import {bindSourceAdmissionIdentity,verifySourceAdmissionIdentity} from './source-identity.js';
import {compileSourceWitnessV8,verifySourceProjectionV8} from './source-compiler-v8.js';
import {V8_LIFECYCLE_CONTRACT} from './lifecycle-v8.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST} from './native-v8.js';

export const SOURCE_ADMISSION_CONTRACT_V8=Object.freeze({
  identitySchema:'semantic-source-candidate-identity/8',
  execution:V8_LIFECYCLE_CONTRACT.executionVersion,trace:V8_LIFECYCLE_CONTRACT.traceVersion,
  context:V8_LIFECYCLE_CONTRACT.contextVersion,harness:V8_LIFECYCLE_CONTRACT.profile,
  digest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST
});
const client=createSourceAdmissionClient({
  compileProjection:compileSourceWitnessV8,verifyProjection:verifySourceProjectionV8,
  receiptSchema:'semantic-source-admission/8',
  bindIdentity:artifact=>bindSourceAdmissionIdentity(artifact,SOURCE_ADMISSION_CONTRACT_V8),
  verifyIdentity:(artifact,options)=>verifySourceAdmissionIdentity(artifact,SOURCE_ADMISSION_CONTRACT_V8,options)
});
export const verifySourceTrainingCaseV8=client.verifyTrainingCase;
export const recheckSourceAdmissionV8=client.recheckAdmission;
