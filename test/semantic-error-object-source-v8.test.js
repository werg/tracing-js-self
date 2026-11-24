import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {issue51ObjectFixtures} from '../fixtures/semantic-regions/objects-issue51.js';
const expected={"issue51-error-own-message-descriptor":[false,false,true,true,"TypeError",[]],"issue51-error-prototype-identities":[true,true,true],"issue51-error-instance-prototype-mutation":["changed","inherited",4,["extra"]],"issue51-error-inherited-prototype-mutation":["later",false],"issue51-error-accessor-receiver":["Cannot use 'in' operator to search for 'x' in null",1,["answer"]]};
for(const [id,value]of Object.entries(expected))test(id,async()=>{
  const fixture=issue51ObjectFixtures.find(row=>row.id===id);assert(fixture);
  const result=await verifyProtocolRegionTrainingCase(fixture);assert(result.exported,result.reason);
  const reference=result.exported.sidecar.sourceArtifact.sidecar.reference;
  assert.equal(reference.status,'agreed');
  for(const name of ['completionAudit','metadataAudit'])assert.equal(reference[name].status,'agreed');
  const controller=RegionExecutionHarness.replay(result.exported).controller;
  assert.deepEqual(controller.materialize(controller.completion.value),value);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).valid,true);
});
