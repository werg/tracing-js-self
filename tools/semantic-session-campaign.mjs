#!/usr/bin/env node
// Deterministic protocol campaign over source-certified SelectedExecutionHarness traces.
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {verifyEffectfulSession} from '../src/training/effectful-session.js';
import {decodeWitness} from '../src/training/format.js';
import {buildSemanticDiagnostics,renderSemanticDiagnosticsHtml} from '../src/training/semantic-diagnostics.js';

const SOURCE='"use strict";async function run(key){const first=host.readAsync(key);'+
  'const second=host.readAsync(key+"-second");const a=await first;const b=await second;return a+b;}';
const FAMILY='semantic-session-campaign-v1';
function makeCases(count){return Array.from({length:count},(_,index)=>{
  const key='session-'+String(index+1).padStart(4,'0'),first=index+2,second=index+3;
  return {source:SOURCE,entry:'run',args:[key],family:FAMILY,seed:17,
    fixture:{calls:[
      {operation:'demo.readAsync',arguments:[key],result:first},
      {operation:'demo.readAsync',arguments:[key+'-second'],result:second}
    ],settlementOrder:[1,0]}};
});}

const quantile=(values,q)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(q*sorted.length)-1)];
};
const summary=values=>({samples:values.length,p50Ms:quantile(values,.5),p95Ms:quantile(values,.95),valuesMs:values});
const rss=()=>process.memoryUsage().rss;
function invocationArgs(record){return {programId:record.programId,invocationId:record.invocationId,
  trackId:record.track,realmId:record.realmId,triggerId:record.triggerId,inputGraph:record.inputGraph,
  completionPolicy:record.completionPolicy,realmPolicy:record.realmPolicy,entry:record.entry,
  receiverValue:record.receiver,closureId:record.closureId,activation:record.activation,
  parentInvocationId:record.parentInvocationId,taskRevision:record.taskRevision,deadline:record.deadline,
  bindings:record.bindings,ingressKey:record.ingressKey};}

/**
 * A local controlled source/reference verification plus bounded replay timings.
 * No model, optimizer, training rows, or inference endpoint is used.
 */
export async function runSemanticSessionCampaign({iterations=7,invocationCount=32}={}){
  if(!Number.isSafeInteger(iterations)||iterations<3||iterations>25)
    throw new RangeError('iterations must be an integer from 3 through 25');
  if(!Number.isSafeInteger(invocationCount)||invocationCount<2||invocationCount>256)
    throw new RangeError('invocationCount must be an integer from 2 through 256');
  const cases=makeCases(invocationCount);
  const startRss=rss(),sourceStart=performance.now();
  const result=await verifyEffectfulSession({cases,family:FAMILY,seed:17,sessionId:'semanticcampaign'});
  const sourceCertificationMs=performance.now()-sourceStart;
  if(result.status!=='locally_verified'||result.exported?.sidecar?.referenceStatus!=='agreed'||
    result.exported?.sidecar?.optimizerSteps!==0)
    throw new Error(`Source certification did not agree: ${result.status} ${result.reason??''}`);
  const episode=result.exported,selected=episode.public.timeline;
  const coldStart=performance.now();
  const completed=SelectedExecutionHarness.replay(episode);
  const firstReplayMs=performance.now()-coldStart;
  const invocations=[...completed.invocations.entries()].map(([id,activation])=>({id,...activation}));
  const intents=[...completed.intents.values()];
  const requestPayloads=new Map();
  for(const record of selected)if(record.kind==='semantic'){
    try{const decoded=decodeWitness(record.line);if(decoded.kind==='request')
      requestPayloads.set(record.invocationId+'/'+decoded.fields.effect,decoded.fields.payload);}
    catch{}
  }
  const resultOrder=selected.filter(record=>record.kind==='result')
    .map(record=>requestPayloads.get(record.invocationId+'/'+record.effectId));
  const expectedReverse=episode.sidecar.referenceInput.fixture.settlementOrder;
  const expectedResultOrder=cases.flatMap(item=>item.fixture.settlementOrder.map(index=>
    JSON.stringify(item.fixture.calls[index]?.arguments)));
  if(invocations.length!==invocationCount||invocations.some(item=>item.status!=='completed')||
    intents.some(item=>item.status!=='settled'))throw new Error('Repeated-ingress session did not settle cleanly');

  const invocationRecord=selected.find(record=>record.kind==='invocation');
  const duplicateHarness=SelectedExecutionHarness.replay(episode);
  const beforeDuplicate=duplicateHarness.timeline.length;
  duplicateHarness.admitInvocation(invocationArgs(invocationRecord));
  const duplicateDelivery={idempotent:duplicateHarness.timeline.length===beforeDuplicate,
    timelineRecordsBefore:beforeDuplicate,timelineRecordsAfter:duplicateHarness.timeline.length};
  if(!duplicateDelivery.idempotent)throw new Error('Duplicate invocation delivery changed committed history');
  const dispatchIndex=selected.findIndex(record=>record.kind==='dispatch');
  if(dispatchIndex<0||!selected.slice(dispatchIndex+1).some(record=>record.kind==='result'&&
    record.invocationId===selected[dispatchIndex].invocationId&&record.effectId===selected[dispatchIndex].effectId))
    throw new Error('Certified trace does not contain a pending-at-dispatch checkpoint boundary');
  const prefix={...episode,public:{...episode.public,timeline:selected.slice(0,dispatchIndex+1)}};
  const pending=SelectedExecutionHarness.replay(prefix,{requireTerminal:false});
  const pendingPacket=pending.checkpoint();
  const pendingIdentity=pending.intents.values().next().value;
  const pendingResult=selected.find(record=>record.kind==='result'&&
    record.invocationId===pendingIdentity.invocationId&&record.effectId===pendingIdentity.effectId);
  if(pendingResult?.result?.[0]!=='num')throw new Error('Campaign result delivery requires the certified numeric fixture result');
  const duplicateResultHarness=SelectedExecutionHarness.replay(prefix,{requireTerminal:false});
  duplicateResultHarness.deliverResult(pendingIdentity.invocationId,pendingIdentity.effectId,
    {status:pendingResult.status,value:pendingResult.result[1]});
  const beforeDuplicateResult=duplicateResultHarness.timeline.length;
  const duplicateResult=duplicateResultHarness.deliverResult(pendingIdentity.invocationId,pendingIdentity.effectId,
    {status:pendingResult.status,value:pendingResult.result[1]});
  duplicateDelivery.result={returnedSequence:duplicateResult.sequence,
    recordedAsDuplicate:duplicateResultHarness.deliveries.at(-1)?.status==='duplicate',
    timelineUnchanged:duplicateResultHarness.timeline.length===beforeDuplicateResult};
  if(!duplicateDelivery.result.recordedAsDuplicate||!duplicateDelivery.result.timelineUnchanged)
    throw new Error('Duplicate result delivery was not idempotent');
  let adapterCalls=0;
  const restored=SelectedExecutionHarness.restore(pendingPacket,{services:{
    'demo.readAsync':()=>{adapterCalls++;return Promise.resolve(0);}
  }});
  let redispatchRefused=false;
  try{await restored.dispatch(pendingIdentity.invocationId,pendingIdentity.effectId);}
  catch(error){redispatchRefused=/uncertain|reconcil/i.test(String(error.message));}
  if(!redispatchRefused||adapterCalls!==0)throw new Error('Restore replayed an uncertain native operation');
  const beforeCancel=restored.timeline.length;
  restored.cancelInvocation(pendingIdentity.invocationId,{reason:'campaign cancellation probe'});
  const cancelled=restored.invocations.get(pendingIdentity.invocationId)?.status==='cancelled';
  const uncertaintyAtCancellation=[...restored.intents.values()]
    .filter(intent=>intent.status==='uncertain').map(intent=>intent.effectId);
  const beforeLateResult=restored.timeline.length;
  let lateResultOutcome;
  try{
    restored.deliverResult(pendingIdentity.invocationId,pendingIdentity.effectId,
      {status:pendingResult.status,value:pendingResult.result[1]});
    const replayedLate=SelectedExecutionHarness.replay(restored.exportEpisode(),{requireTerminal:false});
    lateResultOutcome={accepted:true,timelineChanged:restored.timeline.length!==beforeLateResult,
      cancelledInvocationStayedClosed:replayedLate.invocations.get(pendingIdentity.invocationId)?.status==='cancelled',
      remainingUncertainIntents:[...replayedLate.intents.values()].filter(intent=>intent.status==='uncertain').length};
  }catch(error){lateResultOutcome={accepted:false,error:String(error.message??error),
    timelineUnchanged:restored.timeline.length===beforeLateResult};}
  const cancellation={cancelled,uncertaintyAtCancellation,
    adapterCalls,recordsAdded:restored.timeline.length-beforeCancel,lateResult:lateResultOutcome};
  if(!cancelled||adapterCalls!==0)throw new Error('Cancellation did not preserve uncertainty without effects');

  const firstReplay=completed;
  const warm=[];
  for(let index=1;index<iterations;index++){
    const started=performance.now();
    const replay=SelectedExecutionHarness.replay(episode);
    warm.push(performance.now()-started);
    if(replay.timeline.length!==selected.length)throw new Error('Warm replay changed public record count');
  }
  if(firstReplay.timeline.length!==selected.length)throw new Error('First replay changed public record count');
  const finalRss=rss(),maxRssBytes=process.resourceUsage().maxRSS*1024;
  const diagnostics=buildSemanticDiagnostics(episode,{expected:episode});
  const totalJobs=[...completed.invocations.values()].flatMap(item=>[...item.controller.jobs.values()]);
  const totalHandlers=[...completed.handlers.values()];
  const report={schema:'semantic-session-campaign/1',evidenceKind:'deterministic-engineering',
    selectionOrigin:episode.sidecar.selectionOrigin,sourceFamily:FAMILY,
    referenceStatus:episode.sidecar.referenceStatus,optimizerSteps:episode.sidecar.optimizerSteps,
    learnedCapabilityClaim:false,certification:{status:result.status,sourceCertificationMs,
      sourceChecks:episode.sidecar.collection.components.map(component=>component.sidecar.reference.sourceChecks),
      referenceOutcomes:episode.sidecar.reference.outcomes},
    sessionSize:{invocations:invocations.length,tracks:new Set(invocations.map(item=>item.trackId)).size,
      publicRecords:selected.length,effectResults:selected.filter(record=>record.kind==='result').length,
      events:selected.filter(record=>record.kind==='event').length,handlers:selected.filter(record=>record.kind==='handler').length},
    scenarios:{repeatedInvocations:{count:invocations.length,statuses:invocations.map(item=>item.status),
      completions:invocations.map(item=>firstReplay.invocations.get(item.id).controller.completion)},
      pendingCheckpointRestore:{restored:true,redispatchRefused,adapterCalls},duplicateDelivery,
      cancellation,orderReversal:{requestedSettlementOrder:expectedReverse,resultOrder,
        expectedResultOrder,verified:JSON.stringify(resultOrder)===JSON.stringify(expectedResultOrder)},
      cleanup:{pendingIntents:intents.filter(item=>item.status!=='settled').length,
        pendingJobs:[...completed.invocations.values()].reduce((n,item)=>n+[...item.controller.jobs.values()]
          .filter(job=>job.status!=='completed').length,0),openHandlers:[...completed.handlers.values()]
          .filter(handler=>handler.state!=='closed').length,uncertaintyAtCancellation:cancellation.uncertaintyAtCancellation.length,
        remainingCancelledEffects:cancellation.lateResult.remainingUncertainIntents??null}},
    resourceInventory:{sessionIntentsByStatus:Object.fromEntries([...new Set(intents.map(item=>item.status))]
      .map(status=>[status,intents.filter(item=>item.status===status).length])),
      totalIntents:intents.length,totalJobs:totalJobs.length,
      activeJobs:totalJobs.filter(job=>job.status==='running'||job.status==='pending').length,
      totalHandlers:totalHandlers.length,
      activeHandlers:totalHandlers.filter(handler=>['active','closing','lost'].includes(handler.state)).length,
      cancelledProbeUncertainIntentsAtCancel:cancellation.uncertaintyAtCancellation.length,
      cancelledProbeUncertainIntentsAfterLateResult:cancellation.lateResult.remainingUncertainIntents??null},
    timing:{scope:'Node-process wall-clock around actual SelectedExecutionHarness.replay calls; verification is reported separately',
      quantileMethod:'nearest-rank',
      cold:{definition:'first replay in this process after source certification; module load is already warm',...summary([firstReplayMs])},
      warm:summary(warm),sourceCertificationMs},
    memory:{rssAtCampaignStartBytes:startRss,rssAtEndBytes:finalRss,
      processLifetimeMaxRssBytes:maxRssBytes,scope:'actual Node process RSS; lifetime maximum is not attributed to a scenario'},
    diagnostic:{replayValid:diagnostics.replayValid,recordCount:diagnostics.records.length,
      links:diagnostics.links,linkCount:diagnostics.links.length,firstDivergence:diagnostics.firstDivergence,
      partial:diagnostics.partial},
    sideEffects:{fixtureBrokerReceiptsDuringSourceCertification:episode.sidecar.effects.length,
      nativeAdapterCallsDuringSelectedReplay:0,
      optimizerSteps:0,trainingRowsProduced:0}};
  return {report,episode,diagnostics};
}

if(import.meta.url===new URL(process.argv[1],`file://${process.cwd()}/`).href){
  const outAt=process.argv.indexOf('--out'),iterationsAt=process.argv.indexOf('--iterations'),invocationsAt=process.argv.indexOf('--invocations');
  const out=outAt>=0?process.argv[outAt+1]:'semantic-session-campaign';
  const iterations=iterationsAt>=0?Number(process.argv[iterationsAt+1]):7;
  const invocationCount=invocationsAt>=0?Number(process.argv[invocationsAt+1]):32;
  const {report,episode,diagnostics}=await runSemanticSessionCampaign({iterations,invocationCount});
  report.episode={public:episode.public,sidecar:{sourceLineage:episode.sidecar.sourceLineage,
    split:episode.sidecar.split,selectionOrigin:episode.sidecar.selectionOrigin,
    referenceStatus:episode.sidecar.referenceStatus}};
  report.diagnostics=diagnostics;
  await writeFile(out+'.json',JSON.stringify(report,null,2)+'\n');
  await writeFile(out+'.html',renderSemanticDiagnosticsHtml(diagnostics));
  process.stdout.write(JSON.stringify({status:'passed',invocations:report.sessionSize.invocations,iterations:report.timing.warm.samples,
    coldMs:report.timing.cold.p50Ms,warmP50Ms:report.timing.warm.p50Ms,
    records:report.diagnostic.recordCount,outputs:[out+'.json',out+'.html']},null,2)+'\n');
}
