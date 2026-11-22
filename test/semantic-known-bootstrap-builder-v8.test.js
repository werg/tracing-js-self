// Structural and causal host reconstruction controls. The actual native process
// and genuine Linux execution clock are exercised by the separate paired gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {RegionSelectedOrchestrationDriver} from '../src/semantic/selected-orchestration-v8.js';
import {buildRecoveredBootstrapCheckpointV8,refreshRecoveredBootstrapCheckpointV8}
  from '../src/semantic/selected-orchestration-bootstrap-recovery-v8.js';
import {verifySelectedOrchestrationCheckpoint} from '../src/semantic/selected-orchestration-checkpoint-v8.js';
import {validateSelectedHistoryChain,validateSelectedHistoryExtension} from '../src/semantic/selected-history-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),copy=structuredClone,
  example=JSON.parse(readFileSync(new URL('./fixtures/semantic-regions-v8.json',import.meta.url)))
    .examples.find(row=>row.id==='ordered-map'),
  end=example.public.timeline.findIndex(row=>row.mode==='generated'),
  initialPublic={...copy(example.public),timeline:copy(example.public.timeline.slice(0,end))},
  records=example.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line),
  policy={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64),trainingIdentity:null,seed:17,
    generationSettings:{device:'test-runtime',maxTokens:512,maxFragments:64,effort:1},maxActive:1,childBudget:128,
    maxCoordinatorSelections:128,maxPredictions:4096,maxGenerated:16384,maxOutstanding:64,maxStaleRetries:8,
    timeoutMs:60000,automaticDelivery:false};
const rehash=value=>{const {digest,...body}=value;value.digest=hashAlgorithmData(body);return value;};
const selector=()=>createNativeV8ProcessSelector({command:process.execPath,
  args:[resolve(root,'test/fixtures/semantic-orchestration-checkpoint-peer.mjs'),JSON.stringify(records)],timeoutMs:10000});
let fixturePromise;
async function fixture(){
  fixturePromise??=(async()=>{
    const first=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
    let base,after;
    try{
      const before=await driver.run({stopAt:{phase:'bootstrap-ready',coordinatorSelections:1}});
      assert.equal(before.status,'paused',JSON.stringify(before.failure));base=before.checkpoint;
    }finally{first.close();}
    const second=selector();
    try{
      const restored=await RegionSelectedOrchestrationDriver.restore(base,{initialPublic,select:second,policy}),
        next=await restored.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:1}});
      assert.equal(next.status,'paused',JSON.stringify(next.failure));after=next.checkpoint;
    }finally{second.close();}
    const clockReceipt=rehash({schema:'selected-orchestration-clock-receipt/1',
      bootId:'12345678-1234-1234-1234-123456789abc',timeNamespace:'time:[1]',issuedMonotonicNs:'1000',
      consumedElapsedMs:base.continuation.elapsedMs,timeoutMs:policy.timeoutMs}),
      createReceipt={schema:'semantic-native-producer-request-receipt/8',ordinal:1,digest:'a'.repeat(64),bytes:1,
        sessionId:base.session,streamId:'bootstrap-test',sessionGeneration:1},
      receipt={...createReceipt,ordinal:2,digest:'b'.repeat(64)},
      requestBoundary={schema:'semantic-native-producer-request-boundary/8',ordinal:2,
        sessionId:base.session,streamId:'bootstrap-test',sessionGeneration:1},
      request={id:'v8-bootstrap-1-2',op:'bootstrap-orchestration-child',session:base.session,
        track:base.state.track,childTrack:base.coordinatorAttempts.at(-1).commitReceipt.track.address};
    base.continuation.clockReceipt=copy(clockReceipt);
    base.native.attempts.at(-1).durableRequestReceipt=copy(createReceipt);rehash(base.native);rehash(base);
    const result=copy(after.coordinatorAttempts.at(-1).bootstrapReceipt),native=copy(after.native);
    native.attempts.at(-1).durableRequestReceipt=copy(createReceipt);
    native.attempts.at(-1).durableBootstrap={schema:'semantic-native-transport-bootstrap/8',request:copy(request),
      receipt:copy(receipt),createReceipt:copy(createReceipt),preCheckpointDigest:base.native.native.digest,
      postCheckpointDigest:native.native.digest,result:copy(result)};rehash(native);
    const marker={schema:'semantic-selected-orchestration-pending/8',kind:'child-bootstrap',session:base.session,
      checkpointDigest:base.digest,attempt:0,track:base.state.track,childTrack:request.childTrack,
      clockReceipt,requestBoundary,createReceipt},pending={...marker,id:hashAlgorithmData(marker)},
      recovery={schema:'semantic-native-transport-bootstrap-recovery/8',recovered:true,request,result,
        receipt,createReceipt:copy(createReceipt),nativeCheckpointDigest:native.native.digest,
        hostDispatches:0,hostRecoveryAuthorized:false};
    return {checkpoint:base,pending,recovery,native,state:after.state,
      elapsedMs:Math.max(base.continuation.elapsedMs,after.continuation.elapsedMs)+1,policy,initialPublic};
  })();return copy(await fixturePromise);
}
function history(before,pending,after){
  const streamId='bootstrap-chain',receipt=value=>({schema:'semantic-selected-history-receipt/8',streamId,
    position:value.position,id:hashAlgorithmData(value),bytes:Buffer.byteLength(stableAlgorithmJSON(value))}),
    first={schema:'semantic-selected-history-entry/8',streamId,position:1,previous:null,checkpoint:before},
    fenced={schema:'semantic-selected-history-entry/8',streamId,position:2,previous:receipt(first),checkpoint:before,pending},
    last={schema:'semantic-selected-history-entry/8',streamId,position:3,previous:receipt(fenced),checkpoint:after};
  return {entries:[first,fenced,last],head:receipt(last)};
}

test('known bootstrap reconstructs the exact child-ready native state without another host or model attempt',async()=>{
  const input=await fixture(),snapshot=copy(input),next=buildRecoveredBootstrapCheckpointV8(input);
  assert.deepEqual(input,snapshot);assert.equal(next.continuation.phase,'coordinator-ready');
  assert.equal(next.coordinatorAttempts.length,1);assert.equal(next.native.attempts.length,1);
  assert.deepEqual(next.bridge,input.checkpoint.bridge);assert.deepEqual(next.childAttempts,[]);
  assert.deepEqual(next.continuation.clockReceipt,input.checkpoint.continuation.clockReceipt);
  assert.equal(verifySelectedOrchestrationCheckpoint(next,policy,{initialPublic}),true);
  const chain=history(input.checkpoint,input.pending,next);
  assert.equal(validateSelectedHistoryChain(chain.entries,chain.head).length,3);
});

test('sealed bootstrap recovery preserves its source, complete work and original clock across repeated loss',async()=>{
  const input=await fixture(),base=buildRecoveredBootstrapCheckpointV8(input),native=copy(base.native);
  native.runtimeMetrics.rpcCalls+=2;native.runtimeMetrics.computeSeconds+=1;rehash(native);
  const next=refreshRecoveredBootstrapCheckpointV8({...input,checkpoint:base,native,
    elapsedMs:base.continuation.elapsedMs+1});
  assert.deepEqual(next.coordinatorAttempts,base.coordinatorAttempts);
  assert.deepEqual(next.native.native,base.native.native);
  assert.deepEqual(next.continuation.clockReceipt,base.continuation.clockReceipt);
  assert.equal(validateSelectedHistoryExtension(base,next),true);
  native.runtimeMetrics.rpcCalls=0;rehash(native);
  assert.throws(()=>refreshRecoveredBootstrapCheckpointV8({...input,checkpoint:next,native,
    elapsedMs:next.continuation.elapsedMs+1}),/accounting/);
});

test('bootstrap reconstruction refuses changed causal authority, child, native work and execution budget',async t=>{
  const baseline=await fixture();
  const cases=[
    ['different child',x=>{x.recovery.request.childTrack='another-child';}],
    ['different owner',x=>{x.recovery.request.track='another-parent';}],
    ['different generation',x=>{x.recovery.receipt.sessionGeneration++;}],
    ['different stream',x=>{x.recovery.receipt.streamId='another-stream';}],
    ['receipt extension',x=>{x.recovery.receipt.extraAuthority=true;}],
    ['different request id',x=>{x.recovery.request.id='unbound-response-id';}],
    ['non-adjacent request',x=>{x.recovery.receipt.ordinal++;}],
    ['substituted create',x=>{x.recovery.createReceipt.digest='f'.repeat(64);}],
    ['host dispatch',x=>{x.recovery.hostDispatches=1;}],
    ['claimed host authority',x=>{x.recovery.hostRecoveryAuthorized=true;}],
    ['new model selection',x=>{x.native.attempts.push(copy(x.native.attempts.at(-1)));rehash(x.native);}],
    ['changed host public',x=>{x.state.publicDigest='f'.repeat(64);}],
    ['changed other track',x=>{x.state.tracks.find(row=>row.parent===null).purpose='substituted coordinator purpose';}],
    ['refunded elapsed time',x=>{x.elapsedMs=x.checkpoint.continuation.elapsedMs-1;}],
    ['expired elapsed time',x=>{x.elapsedMs=x.policy.timeoutMs;}],
    ['different native prestate',x=>{x.native.attempts.at(-1).durableBootstrap.preCheckpointDigest='f'.repeat(64);rehash(x.native);}],
    ['missing durable proof',x=>{delete x.native.attempts.at(-1).durableBootstrap;rehash(x.native);}],
    ['rehashed changed clock origin',x=>{
      x.pending.clockReceipt.issuedMonotonicNs='1000001000';rehash(x.pending.clockReceipt);
      const {id,...body}=x.pending;x.pending.id=hashAlgorithmData(body);
    }],
    ...['sessionId','streamId','sessionGeneration'].map(key=>['rehashed substituted '+key+' boundary',x=>{
      const changed=typeof x.pending.requestBoundary[key]==='string'?'substituted-owner':x.pending.requestBoundary[key]+1;
      x.pending.requestBoundary[key]=changed;x.recovery.receipt[key]=changed;
      const {id,...body}=x.pending;x.pending.id=hashAlgorithmData(body);
    }])
  ];
  for(const [name,mutate]of cases)await t.test(name,()=>{
    const changed=copy(baseline);mutate(changed);assert.throws(()=>buildRecoveredBootstrapCheckpointV8(changed));
  });
});

test('full history refuses a rehashed child-bootstrap marker with a substituted create, child or clock',async()=>{
  const input=await fixture(),next=buildRecoveredBootstrapCheckpointV8(input);
  for(const mutate of [
    x=>{x.childTrack='another-child';},x=>{x.track='another-parent';},
    x=>{x.createReceipt.digest='f'.repeat(64);},x=>{x.requestBoundary.ordinal++;},
    x=>{x.requestBoundary.sessionGeneration++;},
    x=>{x.clockReceipt.issuedMonotonicNs='1000001000';rehash(x.clockReceipt);}
  ]){
    const marker=copy(input.pending);mutate(marker);const {id,...body}=marker;marker.id=hashAlgorithmData(body);
    const chain=history(input.checkpoint,marker,next);
    assert.throws(()=>validateSelectedHistoryChain(chain.entries,chain.head));
  }
});
