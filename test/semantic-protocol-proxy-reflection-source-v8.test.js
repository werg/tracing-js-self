import test from 'node:test';
import assert from 'node:assert/strict';
import {issue51ProxyReflectionFixtures} from '../fixtures/semantic-regions/objects-issue51-proxy-reflection.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
for(const fixture of issue51ProxyReflectionFixtures)test(fixture.id,async()=>{
  const result=await verifyProtocolRegionTrainingCase({...fixture,timeoutMs:30000});
  assert(result.exported,result.reason);const artifact=result.exported;
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
  const cut=artifact.public.timeline.findIndex(row=>row.fields?.line?.includes('"kind":"proxy.reflect.call"'))+1;
  if(cut){
    const partial=RegionExecutionHarness.replay({...artifact.public,timeline:artifact.public.timeline.slice(0,cut)},{requireTerminal:false}),
      restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(partial.checkpoint())));
    for(const row of artifact.public.timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    assert.deepEqual(restored.exportEpisode(),artifact.public);
  }
});
