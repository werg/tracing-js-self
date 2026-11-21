// Historical source-admission identity client. Shared lineage/environment checks
// are format neutral; the active V8 client binds its own direct contract.
import {readFileSync} from 'node:fs';
import {EXECUTION_VERSION,WITNESS_VERSION,CONTEXT_VERSION,HARNESS_PROFILE} from './format.js';
import {bindSourceAdmissionIdentity,verifySourceAdmissionIdentity} from '../semantic/source-identity.js';
export {canonicalJson,identityDigest,effectfulFamilySplit,defaultSplitIdentity,cloneSplitIdentity,
  validateSplitIdentity,admissionEnvironment,normalizeSeeds} from '../semantic/source-identity.js';
function contract(){
  const stored=JSON.parse(readFileSync(new URL('../../contracts/semantic-harness-v6.json',import.meta.url),'utf8'));
  return {...stored,identitySchema:'semantic-candidate-identity/1',execution:EXECUTION_VERSION,
    trace:WITNESS_VERSION,context:CONTEXT_VERSION,harness:HARNESS_PROFILE};
}
export const bindAdmissionIdentity=exported=>bindSourceAdmissionIdentity(exported,contract());
export const verifyAdmissionIdentity=(exported,options={})=>verifySourceAdmissionIdentity(exported,contract(),options);
