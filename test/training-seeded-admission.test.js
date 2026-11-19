import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession,recheckEffectfulSession} from '../src/training/effectful-session.js';
import {bindAdmissionIdentity} from '../src/training/admission-identity.js';

const fixture={source:'"use strict";function run(){const x=Math.random();return x+Math.random();}',
  entry:'run',args:[],fixture:{calls:[]},family:'seeded-rng-admission'};
test('declared guest RNG fixture reaches owned, original/instrumented oracle and selected replay',async()=>{
  const zero=await verifyEffectfulTrainingCase({...fixture,randomSeed:0,seeds:{generation:11,input:12},seed:19});
  assert.equal(zero.status,'locally_verified',zero.reason);
  assert.equal(zero.exported.sidecar.seeds.guestRng,0);
  assert.equal(zero.exported.sidecar.seeds.split,19);
  assert.equal(zero.exported.sidecar.referenceInput.randomSeed,0);
  assert.equal(zero.exported.sidecar.archive.initialState.control.a0.randomSeed,0);
  assert.equal((await recheckEffectfulAdmission(zero.exported,{requireAdmitted:false})).sourceValidated,true);
  const same=await verifyEffectfulTrainingCase({...fixture,seeds:{guestRng:0},seed:19});
  assert.equal(same.status,'locally_verified',same.reason);
  assert.deepEqual(same.exported.public,zero.exported.public);
  const other=await verifyEffectfulTrainingCase({...fixture,seeds:{guestRng:1},seed:19});
  assert.equal(other.status,'locally_verified',other.reason);
  assert.notDeepEqual(other.exported.sidecar.reference.outcome,zero.exported.sidecar.reference.outcome);
  assert.equal(other.exported.sidecar.split,zero.exported.sidecar.split);
  const changed=structuredClone(zero.exported);changed.sidecar.seeds.guestRng=2;
  assert.throws(()=>bindAdmissionIdentity(changed),/guest RNG seed/);
});
test('missing and inconsistent guest seeds fail explicitly and unsupported cases retain the chosen seed',async()=>{
  const unseeded=await verifyEffectfulTrainingCase(fixture);
  assert.notEqual(unseeded.status,'locally_verified');
  assert.match(unseeded.reason,/seed/);
  await assert.rejects(verifyEffectfulTrainingCase({...fixture,randomSeed:2,seeds:{guestRng:1}}),/must match/);
  await assert.rejects(verifyEffectfulTrainingCase({...fixture,randomSeed:-1}),/uint32/);
  const unsupported=await verifyEffectfulTrainingCase({...fixture,source:'"use strict";function run(){return eval("1");}',
    randomSeed:7,seeds:{guestRng:7}});
  assert.equal(unsupported.status,'unsupported');
  assert.equal(unsupported.failure.original.seeds.guestRng,7);
});
test('each repeated invocation retains its own explicit guest RNG seed',async()=>{
  const result=await verifyEffectfulSession({family:fixture.family,cases:[
    {...fixture,seeds:{guestRng:0}},{...fixture,seeds:{guestRng:1}}]});
  assert.equal(result.status,'locally_verified',result.reason);
  assert.deepEqual(result.exported.sidecar.collection.components.map(row=>row.sidecar.seeds.guestRng),[0,1]);
  assert.equal((await recheckEffectfulSession(result.exported,{requireAdmitted:false})).sourceValidated,true);
});
