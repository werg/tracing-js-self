// Fresh JSONL subprocess checks for bounded composite pause and restore. The
// protocol peer verifies JS transport wiring, not real native model quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {RegionSelectedOrchestrationDriver} from '../src/semantic/selected-orchestration-v8.js';
import {verifySelectedOrchestrationCheckpoint} from '../src/semantic/selected-orchestration-checkpoint-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const peer=resolve(root,'test/fixtures/semantic-orchestration-checkpoint-peer.mjs');
const artifact=JSON.parse(readFileSync(new URL('./fixtures/semantic-regions-v8.json',import.meta.url)))
  .examples.find(row=>row.id==='ordered-map');
const initialIndex=artifact.public.timeline.findIndex(row=>row.mode==='generated');
const initialPublic={...structuredClone(artifact.public),timeline:structuredClone(artifact.public.timeline.slice(0,initialIndex))};
const childRecords=artifact.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line);
const policy={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64),trainingIdentity:null,seed:17,
  generationSettings:{device:'test-runtime',maxTokens:512,maxFragments:64,effort:1},maxActive:1,childBudget:128,
  maxCoordinatorSelections:128,maxPredictions:4096,maxGenerated:16384,maxOutstanding:64,maxStaleRetries:8,
  timeoutMs:15000,automaticDelivery:false};

function selector({afterChildSelection=null}={}){
  const select=createNativeV8ProcessSelector({command:process.execPath,args:[peer,JSON.stringify(childRecords)],timeoutMs:10000});
  if(afterChildSelection===null)return select;
  let injected=false;
  const wrapped=async input=>{
    const output=await select(input);
    if(!injected&&input?.context?.invocationId){injected=true;afterChildSelection();}
    return output;
  };
  for(const [key,value]of Object.entries(select))wrapped[key]=value;
  return wrapped;
}

function rehash(packet){
  const seal=value=>{const {digest,...body}=value;return {...body,digest:hashAlgorithmData(body)};};
  packet.native.native=seal(packet.native.native);
  packet.native=seal(packet.native);
  const {digest,...body}=packet;packet.digest=hashAlgorithmData(body);
}

async function pauseAndResume(stopAt,overrides={}){
  const runPolicy={...policy,...overrides},first=selector(),driver=new RegionSelectedOrchestrationDriver({
    initialPublic,select:first,...runPolicy});
  let paused;
  try{
    paused=await driver.run({stopAt});
    assert.equal(paused.status,'paused',JSON.stringify({failure:paused.failure,childAttempts:paused.childAttempts,
      childRejections:paused.childRejections}));
    assert.equal(paused.failure,null);
    assert.equal(paused.checkpoint.continuation.phase,stopAt.phase);
    assert.equal(paused.checkpoint.continuation.coordinatorSelections,stopAt.coordinatorSelections);
    assert.equal(verifySelectedOrchestrationCheckpoint(paused.checkpoint,runPolicy,{initialPublic}),true);
  }finally{first.close();}
  const second=selector();
  try{
    const restored=await RegionSelectedOrchestrationDriver.restore(paused.checkpoint,
      {initialPublic,select:second,policy:runPolicy});
    const result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.publicCompleted,true);
    assert.equal(result.failure,null);
    assert.deepEqual(result.public.timeline.slice(0,initialPublic.timeline.length),initialPublic.timeline);
    const operations=second.metrics().attempts.map(row=>row.family==='orchestration'?
      JSON.parse(row.record).name:'child-selection');
    assert.deepEqual(operations,['track_create','track_join',...childRecords.map(()=> 'child-selection'),
      'track_progress','track_complete']);
    assert(second.metrics().attempts.length>=packetAttemptCount(paused.checkpoint),
      'restored native attempts should remain visible');
    return paused.checkpoint;
  }finally{second.close();}
}

function packetAttemptCount(packet){return packet.native.attempts.length;}

test('restores coordinator-ready after exact create and bootstrap receipts',async()=>{
  const packet=await pauseAndResume({phase:'coordinator-ready',coordinatorSelections:1});
  assert.equal(packet.state.children[0].track,'track:1');
  assert.equal(packet.state.tracks.find(row=>row.address==='track:1').bootstrap_ready,true);
  assert.equal(packet.coordinatorAttempts[0].bootstrapReceipt.bootstrapped,true);
});

test('restores bootstrapped active children within the declared active bound',async()=>{
  const packet=await pauseAndResume({phase:'coordinator-ready',coordinatorSelections:1},{maxActive:2});
  assert.equal(packet.state.tracks.find(row=>row.address==='track:1').status,'active');
  assert.equal(packet.policy.maxActive,2);
});

test('restored host bridge keeps the caller live clock',async()=>{
  const first=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
  let paused;
  try{
    paused=await driver.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:1}});
  }finally{first.close();}
  const second=selector(),now=()=>123456789;
  try{
    const restored=await RegionSelectedOrchestrationDriver.restore(paused.checkpoint,
      {initialPublic,select:second,policy,harnessOptions:{now}});
    assert.equal(restored.bridge.inner.now(),123456789);
  }finally{second.close();}
});

test('restores the exact acknowledged stale child rejection and retries its original selection',async()=>{
  const reference={driver:null},first=selector({afterChildSelection:()=>reference.driver.bridge.publishProgram({
    programId:'late-observed-source',source:'"use strict";function late(){return 0;}',entry:'late'})}),
    driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
  reference.driver=driver;
  let paused;
  try{
    paused=await driver.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:3}});
    assert.equal(paused.status,'paused',JSON.stringify(paused.failure));
  }finally{first.close();}
  const packet=paused.checkpoint,stale=packet.childAttempts.filter(row=>row.status==='stale');
  assert.equal(stale.length,1);
  assert.equal(packet.childRejections.length,1);
  const modelRejected=packet.native.native.attempts.find(row=>row.selectionId===stale[0].selection.selectionId),
    transportRejected=packet.native.attempts.find(row=>row.selection.selectionId===stale[0].selection.selectionId);
  assert.equal(modelRejected.status,'semantic-rejected');
  assert.equal(transportRejected.status,'rejected');
  assert.equal(modelRejected.failure,stale[0].failure);
  assert.equal(verifySelectedOrchestrationCheckpoint(packet,policy,{initialPublic}),true);
  const substituted=structuredClone(packet);
  substituted.native.native.attempts.find(row=>row.selectionId===stale[0].selection.selectionId).failure='forged';
  rehash(substituted);
  assert.throws(()=>verifySelectedOrchestrationCheckpoint(substituted,policy,{initialPublic}),
    /rejection|ownership|attempt/i);
  const second=selector();
  try{
    const restored=await RegionSelectedOrchestrationDriver.restore(packet,{initialPublic,select:second,policy}),
      result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.metrics.staleRetries,1);
    assert.equal(result.childRejections.length,1);
  }finally{second.close();}
});

test('restores join-before-run and executes only the acknowledged child',async()=>{
  const packet=await pauseAndResume({phase:'child-ready',coordinatorSelections:2});
  assert.equal(packet.state.status,'waiting');
  assert.equal(packet.continuation.joinedAttempt,1);
  assert.equal(packet.coordinatorAttempts[1].action.name,'track_join');
  assert.equal(packet.coordinatorAttempts[1].childCompletion,undefined);
});

test('restores the mixed child ledger after exact native child completion',async()=>{
  const packet=await pauseAndResume({phase:'coordinator-ready',coordinatorSelections:3});
  assert(packet.childAttempts.length>0);
  assert.equal(packet.childAttempts.filter(row=>row.status==='accepted').length,packet.contexts.length);
  assert.equal(packet.coordinatorAttempts[1].childCompletion.schema,'semantic-child-completion/8');
  assert(packet.native.native.sessions[packet.session].orchestration.operations.some(row=>row.kind==='completion'));
  const completion=packet.coordinatorAttempts[1].childCompletion.completion,
    expectedProgress=' { '+Object.entries(completion).reverse()
      .map(([key,value])=>JSON.stringify(key)+': '+JSON.stringify(value)).join(', ')+' } ';
  assert.equal(packet.coordinatorAttempts.find(row=>row.action.name==='track_progress').action.arguments.progress,
    expectedProgress);
});

test('composite verifier rejects mixed-ledger, dependency, and unknown-ack mutations',async()=>{
  const packet=await pauseAndResume({phase:'coordinator-ready',coordinatorSelections:2});
  for(const mutate of [
    value=>{value.coordinatorAttempts.pop();},
    value=>{value.coordinatorAttempts[0].commitReceipt.completion_dependency.invocation='forged';},
    value=>{value.childAttempts[0].record='forged';},
    value=>{value.continuation.joinedAttempt=1;},
  ]){
    const value=structuredClone(packet);mutate(value);delete value.digest;
    value.digest=hashAlgorithmData(value);
    assert.throws(()=>verifySelectedOrchestrationCheckpoint(value,policy,{initialPublic}),
      /differ|omits|changed|boundary|receipt|binding|ledger|attempt|flight|unbootstrapped/i);
  }
  const unknown=structuredClone(packet);
  const transport=unknown.native,{digest:transportDigest,...transportBody}=transport;
  const row=transport.attempts[0];row.status='acknowledgement-unknown';
  unknown.native={...transportBody,digest:(await import('../src/semantic/program.js')).hashAlgorithmData(transportBody)};
  delete unknown.digest;unknown.digest=hashAlgorithmData(unknown);
  assert.throws(()=>verifySelectedOrchestrationCheckpoint(unknown,policy,{initialPublic}),
    /acknowledged|native commit|attempt/i);
  const duplicate=structuredClone(packet);
  duplicate.coordinatorAttempts[0].record='{"name":"track_create","name":"track_create","arguments":{}}';
  delete duplicate.digest;duplicate.digest=hashAlgorithmData(duplicate);
  assert.throws(()=>verifySelectedOrchestrationCheckpoint(duplicate,policy,{initialPublic}),/duplicate key/i);
  const expired=structuredClone(packet);expired.continuation.elapsedMs=policy.timeoutMs;
  delete expired.digest;expired.digest=hashAlgorithmData(expired);
  assert.throws(()=>verifySelectedOrchestrationCheckpoint(expired,policy,{initialPublic}),/deadline|elapsed|continuation/i);
  const badReplay=structuredClone(packet);
  badReplay.native.native.sessions[packet.session].replay[0].acknowledgedThrough=badReplay.contexts[0].visibleThrough;
  rehash(badReplay);
  assert.throws(()=>verifySelectedOrchestrationCheckpoint(badReplay,policy,{initialPublic}),
    /replay|acknowledged|selection/i);
  const changedSelection=structuredClone(packet);
  changedSelection.native.native.attempts[0].generatedTokens=(changedSelection.native.native.attempts[0].generatedTokens??0)+1;
  rehash(changedSelection);
  assert.throws(()=>verifySelectedOrchestrationCheckpoint(changedSelection,policy,{initialPublic}),
    /attempt|selection|model ownership/i);
});

test('checkpoint is unavailable outside a captured safe point and durable history remains unavailable',()=>{
  const select=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
  try{
    assert.throws(()=>driver.checkpoint(),/requested quiescent safe-point pause/);
    assert.throws(()=>driver.checkpointDurableHistory(),/composite coordinator history/);
  }finally{select.close();}
});
