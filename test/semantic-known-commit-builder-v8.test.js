// Pure reconstruction controls use a deterministic JSONL protocol fixture.
// Actual native durability/reexecution is separately mandatory in the paired gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {RegionSelectedOrchestrationDriver} from '../src/semantic/selected-orchestration-v8.js';
import {buildRecoveredCoordinatorCheckpointV8,buildRecoveredBootstrapCheckpointV8,
  refreshRecoveredBootstrapCheckpointV8} from '../src/semantic/selected-orchestration-commit-recovery-v8.js';
import {verifySelectedOrchestrationCheckpoint} from '../src/semantic/selected-orchestration-checkpoint-v8.js';
import {validateSelectedHistoryChain,validateSelectedHistoryExtension} from '../src/semantic/selected-history-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),copy=structuredClone;
const example=JSON.parse(readFileSync(new URL('./fixtures/semantic-regions-v8.json',import.meta.url)))
  .examples.find(row=>row.id==='ordered-map');
const end=example.public.timeline.findIndex(row=>row.mode==='generated');
const initialPublic={...copy(example.public),timeline:copy(example.public.timeline.slice(0,end))};
const records=example.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line);
const policy={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64),trainingIdentity:null,seed:17,
  generationSettings:{device:'test-runtime',maxTokens:512,maxFragments:64,effort:1},maxActive:1,childBudget:128,
  maxCoordinatorSelections:128,maxPredictions:4096,maxGenerated:16384,maxOutstanding:64,maxStaleRetries:8,
  timeoutMs:60000,automaticDelivery:false};
const seal=body=>({...body,digest:hashAlgorithmData(body)});
const selector=()=>createNativeV8ProcessSelector({command:process.execPath,
  args:[resolve(root,'test/fixtures/semantic-orchestration-checkpoint-peer.mjs'),JSON.stringify(records)],timeoutMs:10000});
const cases=new Map();
async function fixture(kind){
  if(cases.has(kind))return copy(await cases.get(kind));
  const task=(async()=>{
    const first=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
    let base;
    try{
      const before=await driver.run({stopAt:{phase:'coordinator-ready',
        coordinatorSelections:kind==='track_create'?0:kind==='track_join'?1:2}});
      assert.equal(before.status,'paused',JSON.stringify(before.failure));base=before.checkpoint;
    }finally{first.close();}
    const second=selector();let after;
    try{
      const restored=await RegionSelectedOrchestrationDriver.restore(base,{initialPublic,select:second,policy});
      const next=await restored.run({stopAt:{phase:kind==='track_join'?'child-ready':
        kind==='track_create'?'bootstrap-ready':'coordinator-ready',
        coordinatorSelections:base.coordinatorAttempts.length+1}});
      assert.equal(next.status,'paused',JSON.stringify(next.failure));after=next.checkpoint;
    }finally{second.close();}
    const consumed=base.continuation.elapsedMs+0.01,clockReceipt=seal({schema:'selected-orchestration-clock-receipt/1',
      bootId:'12345678-1234-1234-1234-123456789abc',timeNamespace:'time:[1]',issuedMonotonicNs:'1000',
      consumedElapsedMs:consumed,timeoutMs:policy.timeoutMs});
    const requestBoundary={schema:'semantic-native-producer-request-boundary/8',ordinal:2,
      sessionId:base.session,streamId:'commit-test',sessionGeneration:1};
    const marker={schema:'semantic-selected-orchestration-pending/8',kind:'coordinator-selection',session:base.session,
      checkpointDigest:base.digest,attempt:base.coordinatorAttempts.length,
      coordinatorSelections:base.continuation.coordinatorSelections,track:base.state.track,clockReceipt,requestBoundary};
    const pending={...marker,id:hashAlgorithmData(marker)},attempt=after.coordinatorAttempts.at(-1);
    const receipt={schema:'semantic-native-producer-request-receipt/8',ordinal:2,digest:'a'.repeat(64),bytes:1,
      sessionId:base.session,streamId:'commit-test',sessionGeneration:1};
    const native=copy(after.native);native.attempts.at(-1).durableRequestReceipt=copy(receipt);
    const {digest,...nativeBody}=native;native.digest=hashAlgorithmData(nativeBody);
    const recovery={schema:'semantic-native-transport-commit-recovery/8',recovered:true,
      request:{id:'v8-commit-1-2',op:'commit-orchestration',session:base.session,track:base.state.track,
        record:attempt.record,selection:copy(attempt.selection)},result:copy(attempt.commitReceipt),receipt,
      nativeCheckpointDigest:native.native.digest,hostDispatches:0,hostRecoveryAuthorized:false};
    return {checkpoint:base,pending,recovery,native,state:after.state,
      elapsedMs:Math.max(after.continuation.elapsedMs,consumed)+1,policy,initialPublic};
  })();cases.set(kind,task);return copy(await task);
}

for(const kind of ['track_create','track_join','track_progress'])test('known '+kind+' reconstructs one exact cut with unchanged host work',async()=>{
  const input=await fixture(kind),snapshot=copy(input),next=buildRecoveredCoordinatorCheckpointV8(input);
  assert.deepEqual(input,snapshot);assert.deepEqual(next.bridge,input.checkpoint.bridge);
  assert.deepEqual(next.childAttempts,input.checkpoint.childAttempts);
  assert.equal(next.coordinatorAttempts.length,input.checkpoint.coordinatorAttempts.length+1);
  assert.equal(next.continuation.phase,kind==='track_join'?'child-ready':
    kind==='track_create'?'bootstrap-ready':'coordinator-ready');
  assert.deepEqual(next.continuation.clockReceipt,input.pending.clockReceipt);
  assert.equal(verifySelectedOrchestrationCheckpoint(JSON.parse(stableAlgorithmJSON(next)),policy,{initialPublic}),true);
});

let bootstrapCase;
async function bootstrapFixture(){
  if(bootstrapCase)return copy(await bootstrapCase);
  bootstrapCase=(async()=>{
    const first=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
    let base,after;
    try{
      const paused=await driver.run({stopAt:{phase:'bootstrap-ready',coordinatorSelections:1}});
      assert.equal(paused.status,'paused',JSON.stringify(paused.failure));base=paused.checkpoint;
    }finally{first.close();}
    const second=selector();
    try{
      const restored=await RegionSelectedOrchestrationDriver.restore(base,{initialPublic,select:second,policy});
      const paused=await restored.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:1}});
      assert.equal(paused.status,'paused',JSON.stringify(paused.failure));after=paused.checkpoint;
    }finally{second.close();}
    const previous={schema:'semantic-native-producer-request-receipt/8',ordinal:1,digest:'a'.repeat(64),bytes:1,
      sessionId:base.session,streamId:'bootstrap-test',sessionGeneration:1};
    for(const packet of [base,after]){
      packet.native.attempts.at(-1).durableRequestReceipt=copy(previous);
      const {digest,...body}=packet.native;packet.native=seal(body);
    }
    base.continuation.clockReceipt=seal({schema:'selected-orchestration-clock-receipt/1',
      bootId:'12345678-1234-1234-1234-123456789abc',timeNamespace:'time:[1]',issuedMonotonicNs:'1000',
      consumedElapsedMs:base.continuation.elapsedMs,timeoutMs:policy.timeoutMs});
    const {digest,...body}=base;base=seal(body);
    const last=after.coordinatorAttempts.at(-1),receipt={...previous,ordinal:2,digest:'b'.repeat(64)},
      pendingBody={schema:'semantic-selected-orchestration-pending/8',kind:'child-bootstrap',session:base.session,
        checkpointDigest:base.digest,attempt:0,track:base.state.track,childTrack:last.commitReceipt.track.address,
        clockReceipt:copy(base.continuation.clockReceipt),requestBoundary:{
          schema:'semantic-native-producer-request-boundary/8',ordinal:2,sessionId:base.session,
          streamId:'bootstrap-test',sessionGeneration:1}};
    return {checkpoint:base,pending:{...pendingBody,id:hashAlgorithmData(pendingBody)},
      recovery:{schema:'semantic-native-transport-bootstrap-recovery/8',recovered:true,
        request:{id:'v8-bootstrap-1-2',op:'bootstrap-orchestration-child',session:base.session,
          track:base.state.track,childTrack:last.commitReceipt.track.address},
        result:copy(last.bootstrapReceipt),receipt,nativeCheckpointDigest:after.native.native.digest,
        hostDispatches:0,hostRecoveryAuthorized:false},native:after.native,state:after.state,
      elapsedMs:after.continuation.elapsedMs+1,policy,initialPublic};
  })();return copy(await bootstrapCase);
}

test('bootstrap reconstruction preserves every host and model attempt and supports repeated sealed recovery',async()=>{
  const input=await bootstrapFixture(),before=copy(input),next=buildRecoveredBootstrapCheckpointV8(input);
  assert.deepEqual(input,before);assert.deepEqual(next.bridge,input.checkpoint.bridge);
  assert.deepEqual(next.native.attempts,input.checkpoint.native.attempts);
  assert.equal(next.continuation.phase,'coordinator-ready');
  assert.deepEqual(next.coordinatorAttempts.at(-1).bootstrapRequestReceipt,input.recovery.receipt);
  const again=refreshRecoveredBootstrapCheckpointV8({...input,checkpoint:next,elapsedMs:input.elapsedMs+1});
  assert.deepEqual(again.coordinatorAttempts,next.coordinatorAttempts);
  assert.deepEqual(again.bridge,next.bridge);assert(again.continuation.elapsedMs>next.continuation.elapsedMs);
});

test('bootstrap reconstruction refuses wrong children, extra selections, changed clocks and forged outcomes',async()=>{
  const baseline=await bootstrapFixture();
  for(const mutate of [
    value=>{value.recovery.request.childTrack='track:other';},
    value=>{value.recovery.receipt.ordinal++;},
    value=>{value.recovery.receipt.streamId='other';},
    value=>{value.recovery.result.track.execution.invocation_id='other';},
    value=>{value.recovery.hostDispatches=1;},
    value=>{value.native.attempts.push(copy(value.native.attempts[0]));},
    value=>{value.pending.clockReceipt.consumedElapsedMs++;},
    value=>{value.elapsedMs=value.policy.timeoutMs;},
    value=>{value.elapsedMs=value.checkpoint.continuation.elapsedMs-1;},
  ]){const input=copy(baseline);mutate(input);assert.throws(()=>buildRecoveredBootstrapCheckpointV8(input));}
});

test('known commit reconstruction refuses changed scope, owner, work, record, source or consumed budget',async()=>{
  const baseline=await fixture('track_join');
  for(const mutate of [
    value=>{value.pending.kind='child-dispatch';},
    value=>{value.pending.checkpointDigest='f'.repeat(64);},
    value=>{value.recovery.receipt.sessionGeneration++;},
    value=>{value.recovery.receipt.ordinal++;},
    value=>{value.recovery.receipt.streamId='another-stream';},
    value=>{value.recovery.hostDispatches=1;},
    value=>{value.recovery.hostRecoveryAuthorized=true;},
    value=>{value.recovery.request.record='{"name":"track_create","arguments":{}}';},
    value=>{value.recovery.request.selection.contextDigest='e'.repeat(64);},
    value=>{value.native.attempts.push(copy(value.native.attempts.at(-1)));},
    value=>{value.state.publicDigest='e'.repeat(64);},
    value=>{value.elapsedMs=value.checkpoint.continuation.elapsedMs-0.01;},
    value=>{value.elapsedMs=value.policy.timeoutMs;}
  ]){
    const changed=copy(baseline);mutate(changed);
    assert.throws(()=>buildRecoveredCoordinatorCheckpointV8(changed));
  }
});

test('clock-bound history cannot drop its clock or extend its deadline by rehashing a later sample',async()=>{
  const next=buildRecoveredCoordinatorCheckpointV8(await fixture('track_join'));
  const removed=copy(next);delete removed.continuation.clockReceipt;
  const {digest,...removedBody}=removed;removed.digest=hashAlgorithmData(removedBody);
  assert.throws(()=>validateSelectedHistoryExtension(next,removed),/clock/);
  const changed=copy(next),receipt=changed.continuation.clockReceipt;
  receipt.issuedMonotonicNs=String(BigInt(receipt.issuedMonotonicNs)+1000000000n);
  const {digest:oldClockDigest,...clockBody}=receipt;receipt.digest=hashAlgorithmData(clockBody);
  const {digest:oldDigest,...body}=changed;changed.digest=hashAlgorithmData(body);
  assert.throws(()=>validateSelectedHistoryExtension(next,changed),/clock/);
});

test('first clock-bound coordinator fence rejects a later-issued replacement through full history validation',async()=>{
  const input=await fixture('track_join'),next=buildRecoveredCoordinatorCheckpointV8(input),
    streamId='clock-substitution-test';
  assert.equal(Object.hasOwn(input.checkpoint.continuation,'clockReceipt'),false,
    'this must exercise a first clock-bound fence');
  const entry=(position,checkpoint,previous,pending)=>({schema:'semantic-selected-history-entry/8',streamId,position,
    previous,checkpoint,...(pending?{pending}: {})});
  const receiptFor=value=>({schema:'semantic-selected-history-receipt/8',streamId,position:value.position,
    id:hashAlgorithmData(value),bytes:Buffer.byteLength(stableAlgorithmJSON(value))});
  const first=entry(1,input.checkpoint,null),firstReceipt=receiptFor(first),
    fenced=entry(2,input.checkpoint,firstReceipt,input.pending),fencedReceipt=receiptFor(fenced),
    substituted=copy(next),later=substituted.continuation.clockReceipt;
  later.issuedMonotonicNs=String(BigInt(later.issuedMonotonicNs)+1000000000n);
  const {digest:clockDigest,...clockBody}=later;later.digest=hashAlgorithmData(clockBody);
  const {digest:checkpointDigest,...checkpointBody}=substituted;substituted.digest=hashAlgorithmData(checkpointBody);
  const resolved=entry(3,substituted,fencedReceipt),head=receiptFor(resolved);
  assert.throws(()=>validateSelectedHistoryChain([first,fenced,resolved],head),/pending clock/);
});
