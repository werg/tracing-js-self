import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {hostOperationContract} from '../src/host/operations.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission,effectfulFamilySplit,requireNativeAdmission,
  bindNativeAdmission} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession,recheckEffectfulSession} from '../src/training/effectful-session.js';
import {identityDigest,bindAdmissionIdentity} from '../src/training/admission-identity.js';
import {buildSourceRegistry,frozenSplitIdentity} from '../src/corpus/source-registry.mjs';

const fixture={source:'"use strict"; function run(x){return x+1;}',entry:'run',args:[7],
  fixture:{calls:[]},family:'identity-regression',ancestorIds:['algorithm:increment'],
  provenance:{repository:'https://example.invalid/fixture',revision:'a'.repeat(40),path:'increment.js',
    originalSourceDigest:'b'.repeat(64),licenseNotice:'test fixture'},seeds:{input:2,generation:3}};
let episode,session;
test.before(async()=>{
  const result=await verifyEffectfulTrainingCase(fixture);
  assert.equal(result.status,'locally_verified',result.reason);episode=result.exported;
  const repeated=await verifyEffectfulSession({cases:[fixture,{...fixture,args:[8]}],family:fixture.family,
    seeds:fixture.seeds,provenance:fixture.provenance});
  assert.equal(repeated.status,'locally_verified',repeated.reason);session=repeated.exported;
});
test('private immutable identity survives serialization and is bound by source receipt',async()=>{
  const encoded=JSON.parse(JSON.stringify(episode));
  const receipt=await recheckEffectfulAdmission(encoded,{requireAdmitted:false,
    expectedIdentityDigest:episode.sidecar.identityDigest});
  assert.equal(receipt.identityValidated,true);
  assert.equal(receipt.identityDigest,identityDigest(encoded.sidecar.identity));
  assert.equal(encoded.sidecar.identity.source.provenance.upstream.path,'increment.js');
  assert.equal(encoded.sidecar.identity.seeds.input,2);
  assert.equal(encoded.sidecar.identity.environment.node,process.versions.node);
  assert.equal(encoded.public.identity,undefined);
  assert.equal(JSON.stringify(encoded.public).includes('licenseNotice'),false);
  await assert.rejects(recheckEffectfulAdmission(encoded,{requireAdmitted:false,
    expectedIdentityDigest:'0'.repeat(64)}),/identity evidence changed/);
});
test('single-episode metadata tampering cannot pass source recheck',async()=>{
  const mutations={
    split:side=>{side.split=side.split==='test'?'train':'test';},
    sourceFamily:side=>{side.sourceFamily='renamed';},
    sourceLineage:side=>{side.sourceLineage='renamed';},
    ancestors:side=>{side.ancestorIds.push('different-algorithm');},
    taskId:side=>{side.taskId='another-task';},
    fixtureFamily:side=>{side.fixtureFamily='another-fixture';},
    upstream:side=>{side.sourceProvenance.upstream.revision='c'.repeat(40);},
    sourceSeed:side=>{side.sourceProvenance.seed++;},
    generationSeed:side=>{side.seeds.generation++;},
    runtime:side=>{side.environment.v8='other-runtime';},
    limits:side=>{side.executionLimits.maxSteps++;},
    capability:side=>{side.capabilityProfile.push('invented');},
    producer:side=>{side.producerRevision='a'.repeat(40);},
    evidenceKind:side=>{side.evidenceKind='optimizer-trained';},
    optimizerSteps:side=>{side.optimizerSteps=1;},
    learnedSuccess:side=>{side.learnedSuccess=1;},
    license:side=>{side.license='different-license';},
    payload:side=>{side.identity.lineage.ancestorIds.push('forged');},
    payloadDigest:side=>{side.identityDigest='0'.repeat(64);}
  };
  for(const [name,mutate] of Object.entries(mutations)){
    const altered=structuredClone(episode);mutate(altered.sidecar);
    await assert.rejects(recheckEffectfulAdmission(altered,{requireAdmitted:false}),
      /identity evidence changed|certificates or exact public bytes changed/,name);
  }
});
test('rehashing an incorrect split is rejected by the deterministic split policy',()=>{
  const altered=structuredClone(episode);
  altered.sidecar.splitIdentity.split=altered.sidecar.split==='test'?'train':'test';
  altered.sidecar.split=altered.sidecar.splitIdentity.split;
  assert.throws(()=>bindAdmissionIdentity(altered),/split policy/);
  assert.equal(episode.sidecar.split,effectfulFamilySplit(fixture.family));
});
test('session and component identities use the same lineage invariant',async()=>{
  const receipt=await recheckEffectfulSession(JSON.parse(JSON.stringify(session)),{requireAdmitted:false});
  assert.equal(receipt.identityValidated,true);
  assert.deepEqual(session.sidecar.identity.certification.componentIdentities,
    session.sidecar.collection.components.map(component=>component.sidecar.identityDigest));
  for(const field of ['taskId','fixtureFamily','sourceLineage','producerRevision']){
    const altered=structuredClone(session);altered.sidecar[field]='tampered';
    await assert.rejects(recheckEffectfulSession(altered,{requireAdmitted:false}),/identity evidence changed/,field);
  }
  const altered=structuredClone(session);
  altered.sidecar.collection.components[0].sidecar.ancestorIds.push('forged');
  await assert.rejects(recheckEffectfulSession(altered,{requireAdmitted:false}),/identity evidence changed/);
});

test('rebuilding a session independently rejects coherently rehashed top-level metadata',async()=>{
  const mutations={
    task:side=>{side.taskId='different-task';},
    fixture:side=>{side.fixtureFamily='different-fixture-family';},
    limits:side=>{side.executionLimits[0].maxSteps++;},
    seeds:side=>{side.seeds.input++;},
  };
  for(const [name,mutate] of Object.entries(mutations)){
    const altered=structuredClone(session);mutate(altered.sidecar);
    // A matching checksum alone cannot establish consistency with independently
    // collected components. Rebuilding the entire identity supplies that check.
    bindAdmissionIdentity(altered);
    await assert.rejects(recheckEffectfulSession(altered,{requireAdmitted:false}),
      /Repeated-ingress.*identity.*changed/,name);
  }
});

test('frozen global source registry is rechecked with its exact source and holdout assignment',async()=>{
  const registry=buildSourceRegistry([{id:'source-1',family:fixture.family,source:fixture.source,
    ancestorIds:fixture.ancestorIds,project:'held-out-project'}],{holdoutProjects:['held-out-project']});
  const splitIdentity=frozenSplitIdentity(registry,fixture.family);
  const result=await verifyEffectfulTrainingCase({...fixture,splitIdentity});
  assert.equal(result.status,'locally_verified',result.reason);
  assert.equal(result.exported.sidecar.split,'test');
  await recheckEffectfulAdmission(result.exported,{requireAdmitted:false});
  const altered=structuredClone(result.exported);
  altered.sidecar.splitIdentity.registry.sources[0].source='"use strict"; function run(){return 99;}';
  altered.sidecar.splitIdentity.registryDigest=identityDigest(altered.sidecar.splitIdentity.registry);
  assert.throws(()=>bindAdmissionIdentity(altered),/frozen source registry/);
  const wrongSource=await verifyEffectfulTrainingCase({...fixture,splitIdentity,
    source:'"use strict"; function run(x){return x+2;}'});
  assert.notEqual(wrongSource.status,'locally_verified');
  assert.match(wrongSource.reason,/source bytes absent/);
});

const policy={consumerRevision:'c'.repeat(40),tokenizerIdentity:'synthetic-test-tokenizer',tokenizerSha256:'d'.repeat(64)};
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
// Shape-only fixture. It tests the producer boundary, not actual native admission.
function syntheticReceipt(exported){
  const contract=JSON.parse(readFileSync(new URL('../contracts/semantic-harness-v5.json',import.meta.url),'utf8'));
  return {schema:'semantic-native-admission/4',componentGate:'native-consumer-only',admitted:true,
    episodeDigest:sha(exported.public),contractDigest:sha(JSON.stringify(hostOperationContract(),null,2)+'\n'),
    schemaDigest:contract.digest,fixtureDigest:contract.fixtureDigest,
    lossMaskValidated:true,visibilityValidated:true,fragmentationValidated:true,optimizerSteps:0,
    generatedTokens:10,observedTokens:10,...policy};
}
test('native API requires exact consumer and tokenizer policy before calling a consumer',async()=>{
  let calls=0;
  const nativeConsumer=async exported=>{calls++;return syntheticReceipt(exported);};
  await assert.rejects(verifyEffectfulTrainingCase({...fixture,nativeConsumer}),/policy is incompatible/);
  await assert.rejects(verifyEffectfulTrainingCase({...fixture,nativeConsumer,
    nativePolicy:{consumerRevision:policy.consumerRevision,tokenizerIdentity:policy.tokenizerIdentity}}),/SHA-256/);
  await assert.rejects(verifyEffectfulTrainingCase({...fixture,nativeConsumer,nativePolicy:policy}),/pinned producer/);
  assert.equal(calls,0);
  const unpinned=await verifyEffectfulTrainingCase({...fixture,nativePolicy:policy});
  assert.equal(unpinned.status,'locally_verified');
  assert.throws(()=>bindNativeAdmission(unpinned.exported,syntheticReceipt(unpinned.exported),policy),/pinned producer/);
  const result=await verifyEffectfulTrainingCase({...fixture,nativeConsumer,nativePolicy:policy,producerRevision:'a'.repeat(40)});
  assert.equal(result.status,'admitted',result.reason);
  assert.equal(calls,1);
  assert.equal(result.exported.sidecar.nativeBinding.identityDigest,result.exported.sidecar.identityDigest);
  const receipt=await recheckEffectfulAdmission(result.exported,{nativePolicy:policy});
  assert.equal(receipt.identityValidated,true);
  for(const field of ['consumerRevision','tokenizerIdentity','tokenizerSha256']){
    const changed={...syntheticReceipt(result.exported),[field]:'a'.repeat(field==='consumerRevision'?40:64)};
    assert.throws(()=>requireNativeAdmission(result.exported,changed,policy),/incompatible/);
  }
  const altered=structuredClone(result.exported);altered.sidecar.nativeBinding.identityDigest='0'.repeat(64);
  await assert.rejects(recheckEffectfulAdmission(altered),/does not bind/);
  const forged=structuredClone(result.exported);forged.sidecar.split='forged';
  assert.throws(()=>bindNativeAdmission(forged,syntheticReceipt(forged),policy),/identity evidence changed/);
});

test('native session policy binds each component and whole-session receipt',async()=>{
  const result=await verifyEffectfulSession({cases:[fixture,{...fixture,args:[8]}],family:fixture.family,
    nativePolicy:policy,producerRevision:'a'.repeat(40),nativeConsumer:async exported=>syntheticReceipt(exported)});
  assert.equal(result.status,'admitted',result.reason);
  assert(result.exported.sidecar.collection.components.every(item=>
    item.sidecar.identity.certification.nativePolicy.consumerRevision===policy.consumerRevision));
  assert.equal((await recheckEffectfulSession(result.exported,{nativePolicy:policy})).identityValidated,true);
});
