// Fresh JSONL subprocess checks for bounded composite pause and restore. The
// protocol peer verifies JS transport wiring, not real native model quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {validateSelectedHistoryChain} from '../src/semantic/selected-history-v8.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
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
// Durable fsync and independent full-chain verification are part of this budget.
// These controls establish ordering and identity, not a 15-second performance SLA.
const automaticPolicy={...policy,timeoutMs:60000};

function selector({afterChildSelection=null,records=childRecords}={}){
  const select=createNativeV8ProcessSelector({command:process.execPath,args:[peer,JSON.stringify(records)],timeoutMs:10000});
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


function twoRootIngress(){
  const data=structuredClone(initialPublic),first=data.timeline.find(row=>row.kind==='invocation');
  first.fields.realmPolicy='fresh';first.fields.realmId='realm-one';
  const second=structuredClone(first);second.sequence=data.timeline.length+1;
  second.fields.invocationId='invocation-two';second.fields.realmId='realm-two';
  second.fields.track='worker-two';second.fields.triggerId='trigger-two';second.fields.ingressKey='trigger-two';
  data.timeline.push(second);return data;
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
function rechain(entries){
  let previous=null;
  const chained=entries.map((entry,index)=>{
    const row={...structuredClone(entry),position:index+1,previous:structuredClone(previous)};
    previous={schema:'semantic-selected-history-receipt/8',streamId:row.streamId,position:row.position,
      id:hashAlgorithmData(row),bytes:Buffer.byteLength(stableAlgorithmJSON(row))};
    return row;
  });
  return {entries:chained,receipt:previous};
}

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

test('checkpoint is unavailable before a safe point',()=>{
  const select=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
  try{assert.throws(()=>driver.checkpoint(),/requested quiescent safe-point pause/);}
  finally{select.close();}
});


test('two declared children restore from sparse acknowledged cuts without redispatch',async t=>{
  const publicData=twoRootIngress(),records=[...childRecords,...childRecords],directory=
    await mkdtemp(join(tmpdir(),'v8-composite-two-child-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'twochild'});
  let head=null;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head);head=structuredClone(receipt);return structuredClone(head);
  };
  const first=selector({records}),firstDriver=new RegionSelectedOrchestrationDriver({
    initialPublic:publicData,select:first,...policy});
  let firstPacket;
  try{
    const paused=await firstDriver.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:4}});
    assert.equal(paused.status,'paused',JSON.stringify(paused.failure));
    firstPacket=firstDriver.checkpoint();
    assert.equal(firstPacket.initialPublic.timeline.filter(row=>row.kind==='invocation').length,2);
    assert(firstPacket.state.children[0].track);
    assert(firstPacket.state.children[1].track);
    head=await firstDriver.checkpointDurableHistory({journal,acknowledge});
  }finally{first.close();}
  const middle=selector({records});
  let secondPacket;
  try{
    const resumed=await RegionSelectedOrchestrationDriver.restore(firstPacket,
      {initialPublic:publicData,select:middle,policy});
    const paused=await resumed.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:6}});
    assert.equal(paused.status,'paused',JSON.stringify(paused.failure));
    secondPacket=resumed.checkpoint();
    assert.equal(secondPacket.childAttempts.length,records.length);
    const ids=new Set(publicData.timeline.filter(row=>row.kind==='invocation').map(row=>row.fields.invocationId));
    assert(secondPacket.childAttempts.every(row=>ids.has(row.invocationId)));
    head=await resumed.checkpointDurableHistory({journal,acknowledge,previous:head});
  }finally{middle.close();}
  const last=selector({records}),restore=last.restore,priorAttempts=secondPacket.native.attempts.length;
  last.restore=async request=>{const receipt=await restore(request);assert.equal(receipt.hostDispatches,0);return receipt;};
  try{
    const restored=await RegionSelectedOrchestrationDriver.restoreLatest(firstPacket,{historyJournal:journal,
      historyReceipt:head,initialPublic:publicData,select:last,policy});
    const result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    const newActions=last.metrics().attempts.slice(priorAttempts).map(row=>row.family==='orchestration'?
      JSON.parse(row.record).name:'child-selection');
    assert.deepEqual(newActions,['track_complete']);
  }finally{last.close();}
});

test('durable composite checkpoint requires an independent exact head acknowledgement and restores latest',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'v8-composite-history-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'composite'});
  let head=null;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head);head=structuredClone(receipt);return structuredClone(head);
  };
  const first=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
  let packet;
  try{
    const result=await driver.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:1}});
    assert.equal(result.status,'paused');packet=driver.checkpoint();
    const receipt=await driver.checkpointDurableHistory({journal,acknowledge});
    assert.deepEqual(receipt,head);
    assert.deepEqual((await journal.readAll(receipt)).map(row=>row.checkpoint),[packet]);
  }finally{first.close();}
  const middleSelector=selector();
  try{
    const middle=await RegionSelectedOrchestrationDriver.restore(packet,
      {initialPublic,select:middleSelector,policy});
    const paused=await middle.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:3}});
    assert.equal(paused.status,'paused',JSON.stringify(paused.failure));
    const secondPacket=middle.checkpoint();
    head=await middle.checkpointDurableHistory({journal,acknowledge,previous:head});
    packet={first:packet,second:secondPacket};
  }finally{middleSelector.close();}
  const second=selector(),priorCount=packet.second.native.attempts.length,restore=second.restore;
  second.restore=async request=>{
    const receipt=await restore(request);assert.equal(receipt.hostDispatches,0);return receipt;
  };
  try{
    const restored=await RegionSelectedOrchestrationDriver.restoreLatest(packet.first,{historyJournal:journal,
      historyReceipt:head,initialPublic,select:second,policy});
    const result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    const operations=second.metrics().attempts.slice(priorCount).map(row=>row.family==='orchestration'?
      JSON.parse(row.record).name:'child-selection');
    assert.deepEqual(operations,['track_complete']);
  }finally{second.close();}
  const aliased=structuredClone(packet.first),aliasRead=journal.readAll.bind(journal);
  const blockedJournal={readAll:async receipt=>{
    await Promise.resolve();aliased.coordinatorAttempts[0].record='{}';return aliasRead(receipt);
  }};
  const aliasSelector=selector();
  try{
    const restored=await RegionSelectedOrchestrationDriver.restoreLatest(aliased,{historyJournal:blockedJournal,
      historyReceipt:head,initialPublic,select:aliasSelector,policy});
    assert.equal(restored.restored,true);
  }finally{aliasSelector.close();}
  const altered=structuredClone(packet.first);altered.coordinatorAttempts[0].record='{}';
  const tamperedSelector=selector();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(altered,{historyJournal:journal,
      historyReceipt:head,initialPublic,select:tamperedSelector,policy}),/absent from|digest|checkpoint/i);
  }finally{tamperedSelector.close();}
  await assert.rejects(journal.append(packet.first,{previous:head}),/extension|rolled back|changed/i);
});


test('automatic composite history acknowledges the join safe point before child dispatch',async t=>{
  const policy=automaticPolicy;
  const directory=await mkdtemp(join(tmpdir(),'v8-composite-automatic-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'automatic'});
  let head=null,release,arrive;
  const gate=new Promise(resolve=>{release=resolve;}),atJoin=new Promise(resolve=>{arrive=resolve;});
  const select=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
  driver.startAutomaticHistory({journal,acknowledge:async({receipt,previous})=>{
    assert.deepEqual(previous,head);
    const entry=await journal.read(receipt);
    if(entry.checkpoint.continuation.phase==='child-ready'){
      assert.equal(entry.pending?.kind,'child-dispatch');
      assert.equal(driver.bridge.exportEpisode().timeline.filter(row=>row.mode==='generated').length,0,
        'child host dispatch must wait for its durable join cut');
      head=structuredClone(receipt);arrive();await gate;
      const fresh=selector();
      try{
        await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(entry.checkpoint,{historyJournal:journal,
          historyReceipt:head,initialPublic,select:fresh,policy}),/unresolved in-flight work/i);
      }finally{fresh.close();}
      return structuredClone(head);
    }
    head=structuredClone(receipt);return structuredClone(head);
  }});
  try{
    const running=driver.run();
    await Promise.race([atJoin,running.then(result=>{throw new Error(
      'automatic history stopped before the child fence: '+JSON.stringify(result.failure));})]);
    assert.equal(driver.bridge.exportEpisode().timeline.filter(row=>row.mode==='generated').length,0);
    release();const result=await running;
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    const entries=await journal.readAll(head);
    assert(entries.some(row=>row.checkpoint.continuation.phase==='child-ready'));
    assert(entries.some(row=>row.checkpoint.continuation.phase==='coordinator-ready'&&
      row.checkpoint.childAttempts.length>0));
    const completedJoin=entries.find(row=>row.checkpoint.coordinatorAttempts.some(attempt=>
      attempt.childCompletion));
    const joinAttempt=completedJoin.checkpoint.coordinatorAttempts.find(attempt=>attempt.childCompletion);
    assert.equal(joinAttempt.childCompletion.track,'track:1');
    assert.equal(joinAttempt.childCompletion.invocationId,initialPublic.timeline.find(row=>row.kind==='invocation')
      .fields.invocationId);
    assert.deepEqual(joinAttempt.childOutcome.completion,joinAttempt.childCompletion.completion);
    assert.equal(entries.at(-1).position,head.position);
    assert.equal(entries.at(-1).pending?.kind,'coordinator-selection',
      'the unqualified terminal coordinator action remains explicitly fenced');
    const firstCoordinatorFence=entries.find(row=>row.pending?.kind==='coordinator-selection'&&
      row.pending.attempt===0),skippedCoordinator=entries.find(row=>row.checkpoint.coordinatorAttempts.length>=2);
    const skipped=rechain([firstCoordinatorFence,skippedCoordinator]);
    assert.throws(()=>validateSelectedHistoryChain(skipped.entries,skipped.receipt),
      /exactly one committed selection/i);
    const childFence=entries.find(row=>row.pending?.kind==='child-dispatch'),
      interleavedCoordinator=entries.find(row=>row.checkpoint.coordinatorAttempts.length>
        childFence.checkpoint.coordinatorAttempts.length&&row.checkpoint.continuation.phase==='coordinator-ready');
    const interleaved=rechain([childFence,interleavedCoordinator]);
    assert.throws(()=>validateSelectedHistoryChain(interleaved.entries,interleaved.receipt),
      /only the joined invocation/i);
  }finally{release();select.close();}
});

test('post-child persistence failure leaves a durable in-flight fence that refuses fresh replay',async t=>{
  const policy=automaticPolicy;
  const directory=await mkdtemp(join(tmpdir(),'v8-composite-child-fence-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'childfence'});
  let head=null,joinPacket=null;
  const select=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
  driver.startAutomaticHistory({journal,acknowledge:async({receipt,previous})=>{
    assert.deepEqual(previous,head);
    const entry=await journal.read(receipt);
    if(entry.pending?.kind==='child-dispatch'){joinPacket=structuredClone(entry.checkpoint);}
    if(entry.checkpoint.continuation.phase==='coordinator-ready'&&entry.checkpoint.childAttempts.length>0)
      throw new Error('simulated lost post-child head acknowledgement');
    head=structuredClone(receipt);return structuredClone(head);
  }});
  try{
    const result=await driver.run();
    assert.notEqual(result.status,'completed');
    assert.match(result.failure?.message??'',/simulated lost post-child head acknowledgement/);
    assert(joinPacket,'the child-dispatch intent was durably acknowledged');
    const fresh=selector();
    try{
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(joinPacket,{historyJournal:journal,
        historyReceipt:head,initialPublic,select:fresh,policy}),/unresolved in-flight work/i);
    }finally{fresh.close();}
  }finally{select.close();}
});



test('automatic persistence refuses a journal readback that drops its pending fence',async t=>{
  const policy=automaticPolicy;
  const directory=await mkdtemp(join(tmpdir(),'v8-composite-drop-fence-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'dropfence'});
  const select=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
  let head=null,acks=0;
  const droppingJournal={append:(checkpoint,options)=>{
      const {pending,...withoutPending}=options;
      return journal.append(checkpoint,withoutPending);
    },readAll:receipt=>journal.readAll(receipt)};
  driver.startAutomaticHistory({journal:droppingJournal,acknowledge:async({receipt,previous})=>{
    assert.deepEqual(previous,head);head=structuredClone(receipt);acks++;return structuredClone(head);
  }});
  try{
    const result=await driver.run();
    assert.notEqual(result.status,'completed');
    assert.match(result.failure?.message??'',/different checkpoint, predecessor or pending fence/);
    assert.equal(driver.coordinatorAttempts.length,0,'no coordinator selection follows a missing fence');
    assert.equal(acks,1,'the marker-free lookalike entry is never acknowledged');
  }finally{select.close();}
});


test('requested child-ready pause stores a complete cut and arms its fence only on resumed dispatch',async t=>{
  const policy=automaticPolicy;
  const directory=await mkdtemp(join(tmpdir(),'v8-composite-requested-child-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'requestedchild'});
  let head=null;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head);head=structuredClone(receipt);return structuredClone(head);
  };
  const first=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
  driver.startAutomaticHistory({journal,acknowledge});
  let packet;
  try{
    const result=await driver.run({stopAt:{phase:'child-ready',coordinatorSelections:2}});
    assert.equal(result.status,'paused',JSON.stringify(result.failure));
    packet=driver.checkpoint();
    const entry=(await journal.readAll(head)).at(-1);
    assert.equal(entry.checkpoint.continuation.phase,'child-ready');
    assert.equal(Object.hasOwn(entry,'pending'),false);
  }finally{first.close();}
  const second=selector(),restore=second.restore;
  second.restore=async request=>{const receipt=await restore(request);assert.equal(receipt.hostDispatches,0);return receipt;};
  try{
    const resumed=await RegionSelectedOrchestrationDriver.restoreLatest(packet,{historyJournal:journal,
      historyReceipt:head,initialPublic,select:second,policy});
    resumed.startAutomaticHistory({journal,acknowledge});
    const result=await resumed.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal((await journal.readAll(head)).some(row=>row.pending?.kind==='child-dispatch'),true);
  }finally{second.close();}
});

test('requested orchestration safe point is snapshotted before native initialization awaits',async()=>{
  const select=selector(),stopAt={phase:'coordinator-ready',coordinatorSelections:0},
    initialize=select.initialize;
  select.initialize=async request=>{
    stopAt.phase='child-ready';stopAt.coordinatorSelections=99;
    return initialize(request);
  };
  const driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
  try{
    const result=await driver.run({stopAt});
    assert.equal(result.status,'paused',JSON.stringify(result.failure));
    assert.equal(driver.checkpoint().continuation.phase,'coordinator-ready');
    assert.equal(driver.checkpoint().continuation.coordinatorSelections,0);
  }finally{select.close();}
});

test('failed durable head acknowledgement leaves no reusable history receipt',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'v8-composite-history-fail-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'compositefail'});
  const select=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
  try{
    await driver.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:1}});
    await assert.rejects(driver.checkpointDurableHistory({journal,acknowledge:async()=>null}),
      /acknowledgement|receipt/i);
    assert.equal(driver.historyReceipt,null);
  }finally{select.close();}
});
