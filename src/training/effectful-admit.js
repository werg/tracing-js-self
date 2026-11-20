// Production teacher/corpus gate. Each authority has a separate receipt:
// private journal/replay, selected public replay, independent native source
// execution and production native tokenizer/consumer. No optimizer runs here.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFileSync} from 'node:fs';
import {hostOperationContract} from '../host/operations.js';
import {compileEffectfulWitness,verifyEffectfulProjection} from './effectful-compiler.js';
import {decodeWitness} from './format.js';
import {recheckEffectfulSession} from './effectful-session.js';
import {bindAdmissionIdentity,verifyAdmissionIdentity,identityDigest} from './admission-identity.js';
import {createSourceAdmissionClient} from '../semantic/source-admission.js';
export {effectfulFamilySplit} from './admission-identity.js';

export {independentEffectfulReference} from '../semantic/source-reference.js';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function validateNativePolicy(policy){
  if(!policy||!/^[0-9a-f]{40}$/.test(policy.consumerRevision??'')||
    typeof policy.tokenizerIdentity!=='string'||!policy.tokenizerIdentity||
    !/^[0-9a-f]{64}$/.test(policy.tokenizerSha256??''))
    throw new TypeError('Native admission policy is incompatible or incomplete: exact consumer revision, tokenizer identity and SHA-256 are required');
  return {consumerRevision:policy.consumerRevision,tokenizerIdentity:policy.tokenizerIdentity,
    tokenizerSha256:policy.tokenizerSha256};
}
export function validateNativeProducer(producerRevision){
  if(!/^[0-9a-f]{40}$/.test(producerRevision??''))
    throw new TypeError('Native admission requires an exact pinned producer revision');
  return producerRevision;
}
export function requireNativeAdmission(exported,receipt,policy=null){
  const expected=validateNativePolicy(policy??exported?.sidecar?.nativePolicy);
  validateNativeProducer(exported?.sidecar?.producerRevision);
  if(!isDeepStrictEqual(expected,exported?.sidecar?.nativePolicy))
    throw new Error('Native admission policy differs from the immutable candidate identity');
  verifyAdmissionIdentity(exported);
  const catalog=JSON.stringify(hostOperationContract(),null,2)+'\n';
  const contract=JSON.parse(readFileSync(new URL('../../contracts/semantic-harness-v6.json',import.meta.url),'utf8'));
  if(receipt?.schema!=='semantic-native-admission/4'||receipt.componentGate!=='native-consumer-only'||
    receipt.admitted!==true||receipt.episodeDigest!==hash(exported.public)||
    receipt.contractDigest!==hash(catalog)||!receipt.lossMaskValidated||!receipt.visibilityValidated||
    receipt.schemaDigest!==contract.digest||receipt.fixtureDigest!==contract.fixtureDigest||
    !receipt.fragmentationValidated||receipt.optimizerSteps!==0||
    !/^[0-9a-f]{40}$/.test(receipt.consumerRevision??'')||
    !/^[0-9a-f]{64}$/.test(receipt.tokenizerSha256??'')||
    typeof receipt.tokenizerIdentity!=='string'||!receipt.tokenizerIdentity||
    !Number.isSafeInteger(receipt.generatedTokens)||receipt.generatedTokens<1||
    !Number.isSafeInteger(receipt.observedTokens)||receipt.observedTokens<1||
    receipt.consumerRevision!==expected.consumerRevision||
    receipt.tokenizerIdentity!==expected.tokenizerIdentity||receipt.tokenizerSha256!==expected.tokenizerSha256)
    throw new Error('Native admission receipt is incompatible, stale or incomplete');
  return true;
}
export function bindNativeAdmission(exported,receipt,policy=null){
  requireNativeAdmission(exported,receipt,policy);
  exported.sidecar.nativeAdmission=structuredClone(receipt);
  exported.sidecar.nativeBinding={schema:'semantic-native-receipt-binding/1',
    episodeDigest:hash(exported.public),identityDigest:exported.sidecar.identityDigest,
    receiptDigest:identityDigest(receipt),policyDigest:identityDigest(exported.sidecar.nativePolicy)};
  exported.sidecar.selectionOrigin='certified_teacher';
  exported.sidecar.admission='admitted';
  return exported.sidecar.nativeBinding;
}
export function verifyNativeBinding(exported,policy=null){
  const side=exported.sidecar;
  requireNativeAdmission(exported,side.nativeAdmission,policy);
  if(!isDeepStrictEqual(side.nativeBinding,{schema:'semantic-native-receipt-binding/1',
    episodeDigest:hash(exported.public),identityDigest:side.identityDigest,
    receiptDigest:identityDigest(side.nativeAdmission),policyDigest:identityDigest(side.nativePolicy)}))
    throw new Error('Native receipt does not bind the immutable candidate identity');
  return true;
}
const sourceAdmission=createSourceAdmissionClient({compileProjection:compileEffectfulWitness,
  verifyProjection:verifyEffectfulProjection,bindIdentity:bindAdmissionIdentity,verifyIdentity:verifyAdmissionIdentity,
  validateNativePolicy,validateNativeProducer,bindNativeAdmission,verifyNativeBinding,
  recheckSession:recheckEffectfulSession,receiptSchema:'semantic-source-admission/4'});
export const verifyEffectfulTrainingCase=sourceAdmission.verifyTrainingCase;
export const recheckEffectfulAdmission=sourceAdmission.recheckAdmission;

/** Counterfactual schedules share exactly the bytes visible before the first
+ * changed external observation. No fixture future can shape an earlier prefix. */
export function checkCounterfactualPrefixes(left,right){
  const a=left.public.timeline,b=right.public.timeline;
  let index=0;
  while(index<Math.min(a.length,b.length)&&isDeepStrictEqual(a[index],b[index]))index++;
  if(index===Math.min(a.length,b.length))throw new Error('Counterfactuals must differ in an observed outcome');
  if(a[index].mode!=='observed'||b[index].mode!=='observed'||
    !['result','event'].includes(a[index].kind)||a[index].kind!==b[index].kind)
    throw new Error('Counterfactual future leaked into an earlier source/action prefix');
  return {valid:true,identicalRecords:index,firstChangedObservation:index+1};
}
export function effectfulMetrics(exported){
  const timeline=exported.public.timeline;
  let generatedBytes=0,observedBytes=0,transportBytes=0,actions=0;
  for(const item of timeline){
    const bytes=Buffer.byteLength(JSON.stringify(item)),semantic=item.line?Buffer.byteLength(item.line):0;
    if(item.mode==='generated'){generatedBytes+=semantic;if(decodeWitness(item.line).kind==='request')actions++;}
    else observedBytes+=bytes;
    if(item.mode==='generated')transportBytes+=bytes-semantic;
  }
  return {generatedBytes,observedBytes,transportBytes,actions,
    generatedTokens:exported.sidecar.nativeAdmission?.generatedTokens??null,
    observedTokens:exported.sidecar.nativeAdmission?.observedTokens??null,
    learnedSuccess:null,optimizerSteps:0};
}
