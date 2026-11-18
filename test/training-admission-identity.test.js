import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission,effectfulFamilySplit} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession,recheckEffectfulSession} from '../src/training/effectful-session.js';
import {identityDigest,bindAdmissionIdentity} from '../src/training/admission-identity.js';

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
