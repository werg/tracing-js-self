// Pure reconstruction controls use a deterministic JSONL protocol fixture.
// Actual native close/reexecution and live clocks are separately mandatory in the paired gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {RegionSelectedOrchestrationDriver} from '../src/semantic/selected-orchestration-v8.js';
import {buildRecoveredTerminalCloseV8} from '../src/semantic/selected-orchestration-close-recovery-v8.js';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

const rehash=value=>{const {digest,...body}=value;return seal(body);};
let cached;
async function fixture(){
  if(cached)return copy(await cached);
  cached=(async()=>{
    const directory=await mkdtemp(join(tmpdir(),'known-close-builder-')),
      journal=new DurableSelectedHistoryJournal({directory,streamId:'terminal-builder'});
    const select=selector(),driver=new RegionSelectedOrchestrationDriver({initialPublic,select,...policy});
    let head=null,entries;
    try{
      driver.startAutomaticHistory({journal,acknowledge:async({receipt,previous})=>{
        assert.deepEqual(previous,head);head=copy(receipt);return copy(receipt);
      }});
      const result=await driver.run();assert.equal(result.status,'completed',JSON.stringify(result.failure));
      entries=await journal.readLatest(head);
    }finally{select.close();await rm(directory,{recursive:true,force:true});}
    const old=entries.at(-1).terminal,base=entries.at(-1).checkpoint,snapshot=copy(old.snapshot),
      closed=copy(old.closedNative),prior={schema:'semantic-native-producer-request-receipt/8',ordinal:7,
        digest:'a'.repeat(64),bytes:1,sessionId:base.session,streamId:'close-builder',sessionGeneration:1};
    snapshot.native.attempts.at(-1).durableRequestReceipt=copy(prior);
    snapshot.native=rehash(snapshot.native);
    // This is a plain structural clock receipt for pure validation only. It is
    // never passed to a live clock or used to authorize an actual restoration.
    snapshot.continuation.clockReceipt=seal({schema:'selected-orchestration-clock-receipt/1',
      bootId:'12345678-1234-1234-1234-123456789abc',timeNamespace:'time:[1]',issuedMonotonicNs:'1000',
      consumedElapsedMs:snapshot.continuation.elapsedMs,timeoutMs:policy.timeoutMs});
    const captured=rehash(snapshot),closeBoundary={schema:'semantic-native-producer-request-boundary/8',
      ordinal:8,sessionId:base.session,streamId:'close-builder',sessionGeneration:1},
      identity={schema:'semantic-selected-orchestration-terminal-event/8',phase:'requested',session:base.session,
        baseCheckpointDigest:base.digest,pendingId:old.pendingId,snapshotDigest:hashAlgorithmData(captured),
        reason:old.closeReceipt.reason,ownerSnapshotDigest:hashAlgorithmData(null),closeBoundary},
      terminal=seal({...identity,terminalId:hashAlgorithmData(identity),snapshot:captured,ownerSnapshot:null});
    closed.attempts=copy(snapshot.native.attempts);
    const native=rehash(closed),receipt={...prior,ordinal:8,digest:'b'.repeat(64)};
    return {checkpoint:base,terminal,native,elapsedMs:captured.continuation.elapsedMs+1,
      recovery:{schema:'semantic-native-transport-close-recovery/8',recovered:true,hostDispatches:0,
        hostRecoveryAuthorized:false,preCheckpointDigest:captured.native.native.digest,nativeCheckpointDigest:native.native.digest,
        request:{op:'cancel',session:base.session,reason:old.closeReceipt.reason,id:'v8-close-1-8'},
        result:old.closeReceipt,receipt},policy:base.policy,initialPublic,
      prefix:entries.slice(0,-1)};
  })();return copy(await cached);
}
function chain(prefix,...terminals){
  const base=prefix.at(-1).checkpoint,rows=[...copy(prefix),...terminals.map(terminal=>({
    schema:'semantic-selected-history-entry/8',streamId:'terminal-builder',checkpoint:copy(base),terminal:copy(terminal)}))];
  let previous=null;
  for(const [index,row]of rows.entries()){
    row.position=index+1;row.previous=copy(previous);
    previous={schema:'semantic-selected-history-receipt/8',streamId:row.streamId,position:row.position,
      id:hashAlgorithmData(row),bytes:Buffer.byteLength(stableAlgorithmJSON(row))};
  }
  return {rows,receipt:previous};
}

test('known close produces only an exact closed disposition and preserves complete history',async()=>{
  const input=await fixture(),before=copy(input),closed=buildRecoveredTerminalCloseV8(input);
  assert.deepEqual(input,before);assert.equal(closed.phase,'completed');
  assert.deepEqual(closed.closedNative.native.sessions,{});
  assert.deepEqual(closed.snapshot.bridge,input.terminal.snapshot.bridge);
  assert.deepEqual(closed.snapshot.childAttempts,input.terminal.snapshot.childAttempts);
  assert.deepEqual(closed.closeRequestReceipt,input.recovery.receipt);
  const history=chain(input.prefix,input.terminal,closed);
  assert.equal(validateSelectedHistoryChain(history.rows,history.receipt).length,history.rows.length);
});

test('repeated closed reconstruction retains consumed costs and cannot become active history',async()=>{
  const input=await fixture(),first=buildRecoveredTerminalCloseV8(input),nextNative=copy(input.native);
  nextNative.runtimeMetrics.rpcCalls+=2;nextNative.runtimeMetrics.computeSeconds+=0.2;
  const next=buildRecoveredTerminalCloseV8({...input,terminal:first,native:rehash(nextNative),elapsedMs:input.elapsedMs+2});
  const history=chain(input.prefix,input.terminal,first,next);
  assert.equal(validateSelectedHistoryChain(history.rows,history.receipt).length,history.rows.length);
  const refund=copy(nextNative);refund.runtimeMetrics.rpcCalls=input.native.runtimeMetrics.rpcCalls;
  assert.throws(()=>buildRecoveredTerminalCloseV8({...input,terminal:next,native:rehash(refund),
    elapsedMs:input.elapsedMs+3}),/refund|cost/);
  const active=copy(history.rows);active.push(copy(active.at(-1)));delete active.at(-1).terminal;
  let previous=history.receipt;const tail=active.at(-1);tail.position=previous.position+1;tail.previous=previous;
  const receipt={schema:'semantic-selected-history-receipt/8',streamId:tail.streamId,position:tail.position,
    id:hashAlgorithmData(tail),bytes:Buffer.byteLength(stableAlgorithmJSON(tail))};
  assert.throws(()=>validateSelectedHistoryChain(active,receipt),/closed session/);
});

test('known close refuses changed request authority, original outcome, attempts or elapsed budget',async()=>{
  const baseline=await fixture();
  for(const mutate of [
    value=>{value.recovery.receipt.ordinal++;},value=>{value.recovery.receipt.sessionGeneration++;},
    value=>{value.recovery.receipt.streamId='other';},value=>{value.recovery.request.reason='other';},
    value=>{value.recovery.request.session='other';},value=>{value.recovery.request.op='commit';},
    value=>{value.recovery.preCheckpointDigest='f'.repeat(64);},
    value=>{value.recovery.hostDispatches=1;},value=>{value.recovery.hostRecoveryAuthorized=true;},
    value=>{value.recovery.result.reason='changed outcome';},
    value=>{value.native.attempts.push(copy(value.native.attempts[0]));value.native=rehash(value.native);},
    value=>{value.elapsedMs=value.terminal.snapshot.continuation.elapsedMs-1;},
    value=>{value.elapsedMs=value.policy.timeoutMs;},
    value=>{const target=value.native.native.closedSessions[value.checkpoint.session];
      target.contexts=[];value.native.native=rehash(value.native.native);value.native=rehash(value.native);
      value.recovery.nativeCheckpointDigest=value.native.native.digest;},
  ]){const input=copy(baseline);mutate(input);assert.throws(()=>buildRecoveredTerminalCloseV8(input));}
});
