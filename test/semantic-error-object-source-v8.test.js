import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {issue51ObjectFixtures} from '../fixtures/semantic-regions/objects-issue51.js';
const expected={"issue51-error-own-message-descriptor":[false,false,true,true,"TypeError",[]],"issue51-error-prototype-identities":[true,true,true],"issue51-error-instance-prototype-mutation":["changed","inherited",4,["extra"]],"issue51-error-inherited-prototype-mutation":["later",false],"issue51-error-accessor-receiver":["Cannot use 'in' operator to search for 'x' in null",1,["answer"]],"issue51-error-instanceof-live-chain":[true,true,true,false,false,true],"issue51-error-instanceof-prototype-replacement":[true,false,true,true],"issue51-error-instanceof-custom-hasinstance":true,"issue51-class-instanceof-shared-prototype-chain":[true,true],"issue51-async-caught-error-standard-properties":["TypeError","Cannot use 'in' operator to search for 'x' in null",true],"issue51-async-caught-error-instanceof":true,"issue51-shared-promise-caught-error-properties":["TypeError","Cannot use 'in' operator to search for 'x' in null",true]};
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

test('an unhandled implicit Error keeps its brand and standard exception boundary through async completion',async()=>{
  const fixture=issue51ObjectFixtures.find(row=>row.id==='issue51-async-unhandled-derived-typeerror');
  const result=await verifyProtocolRegionTrainingCase(fixture);assert(result.exported,result.reason);
  const controller=RegionExecutionHarness.replay(result.exported).controller;
  assert.equal(controller.completion.kind,'throw');
  const error=controller.heap.get(controller.completion.value[1]);assert.equal(error.declaredError,'TypeError');
  assert.equal(error.properties.has('name'),false);
  assert.deepEqual(controller.observedGraph().objects[0].properties,[['name',['str','TypeError']],
    ['message',['str',"Cannot use 'in' operator to search for 'x' in null"]]]);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).valid,true);
});
