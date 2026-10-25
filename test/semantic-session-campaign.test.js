import test from 'node:test';
import assert from 'node:assert/strict';
import {runSemanticSessionCampaign} from '../tools/semantic-session-campaign.mjs';
import {decodeWitness} from '../src/training/format.js';

test('bounded campaign verifies repeated ingress, checkpoint safety, cancellation and reverse settlement',async()=>{
  await assert.rejects(()=>runSemanticSessionCampaign({iterations:3,invocationCount:1}),/2 through 256/);
  const {report,episode}=await runSemanticSessionCampaign({iterations:3,invocationCount:6});
  assert.equal(report.referenceStatus,'agreed');
  assert.equal(report.optimizerSteps,0);
  assert.equal(report.learnedCapabilityClaim,false);
  assert.ok(report.sideEffects.fixtureBrokerReceiptsDuringSourceCertification>0);
  assert.equal(report.sideEffects.nativeAdapterCallsDuringSelectedReplay,0);
  assert.equal(report.scenarios.repeatedInvocations.count,6);
  assert.ok(report.scenarios.repeatedInvocations.statuses.every(status=>status==='completed'));
  assert.equal(report.scenarios.pendingCheckpointRestore.redispatchRefused,true);
  assert.equal(report.scenarios.pendingCheckpointRestore.adapterCalls,0);
  assert.equal(report.scenarios.duplicateDelivery.idempotent,true);
  assert.equal(report.scenarios.duplicateDelivery.result.recordedAsDuplicate,true);
  assert.equal(report.scenarios.duplicateDelivery.result.timelineUnchanged,true);
  assert.equal(report.scenarios.cancellation.cancelled,true);
  assert.equal(report.scenarios.cancellation.uncertaintyAtCancellation.length,1);
  assert.equal(report.scenarios.cancellation.lateResult.accepted,true);
  assert.equal(report.scenarios.cancellation.lateResult.cancelledInvocationStayedClosed,true);
  assert.equal(report.scenarios.cancellation.lateResult.remainingUncertainIntents,0);
  assert.ok(report.scenarios.orderReversal.verified);
  const witnesses=episode.public.timeline.filter(record=>record.kind==='semantic')
    .map(record=>decodeWitness(record.line));
  const request=witnesses.find(item=>item.kind==='request').fields;
  const awaited=witnesses.find(item=>item.kind==='await').fields;
  assert.notEqual(request.effect,request.promise);
  assert.notEqual(awaited.promise,awaited.continuation);
  assert.deepEqual(report.diagnostic.links.map(link=>link.kind).sort(),
    [...Array(12).fill('await-resume'),...Array(12).fill('request-await'),...Array(12).fill('request-result')]);
  assert.equal(report.diagnostic.partial,false);
  assert.deepEqual(report.scenarios.cleanup,{pendingIntents:0,pendingJobs:0,openHandlers:0,
    uncertaintyAtCancellation:1,remainingCancelledEffects:0});
  assert.equal(episode.public.timeline.filter(record=>record.kind==='invocation').length,6);
  assert.equal(report.sessionSize.tracks,6);
  assert.equal(report.resourceInventory.sessionIntentsByStatus.settled,12);
  assert.equal(report.resourceInventory.totalIntents,12);
  assert.equal(report.resourceInventory.activeJobs,0);
  assert.equal(report.resourceInventory.activeHandlers,0);
  assert.equal(report.resourceInventory.cancelledProbeUncertainIntentsAtCancel,1);
  assert.equal(report.resourceInventory.cancelledProbeUncertainIntentsAfterLateResult,0);
  assert.deepEqual(report.timing.warm.samples,2);
  assert.ok(report.memory.processLifetimeMaxRssBytes>=report.memory.rssAtCampaignStartBytes);
});
