import test from 'node:test';
import assert from 'node:assert/strict';
import {issue51CollectionFixtures} from '../fixtures/semantic-regions/objects-issue51-collections.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

test('issue51 collection, spread and nested iterator originals retain source/native evidence',async()=>{
  assert.equal(Object.isFrozen(issue51CollectionFixtures),true);
  assert(issue51CollectionFixtures.every(row=>Object.isFrozen(row)&&Object.isFrozen(row.ancestorIds)&&
    row.ancestorIds.includes('issue51-original-objects')));
  for(const fixture of issue51CollectionFixtures){
    const result=await verifyProtocolRegionTrainingCase(fixture);
    assert(result.exported,result.reason+' ('+fixture.id+')');
    const artifact=result.exported;
    assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.status,'agreed',fixture.id);
    assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed',fixture.id);
    const replay=RegionExecutionHarness.replay(artifact);
    assert.equal(replay.controller.completion.kind,'return',fixture.id);
    assert((await recheckProtocolRegionEvidence(artifact)).valid,fixture.id);
  }
});
