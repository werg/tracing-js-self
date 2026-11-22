// Live-clock native close recovery with real producer and native request journals.
// This verifies terminal ordering and recovery only, not learned execution quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readlinkSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {RegionSelectedOrchestrationDriver} from '../src/semantic/selected-orchestration-v8.js';
import {DurableNativeV8RequestJournal} from '../src/storage/native-request-journal-v8.js';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {DurableSelectedOrchestrationExecutionLock} from '../src/storage/selected-orchestration-execution-lock.js';
import {createSelectedOrchestrationExecutionClock} from '../src/storage/selected-orchestration-clock.js';

const copy=structuredClone,root=dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot=resolve(process.env.MEGATOKEN_ROOT??join(root,'../megatoken'));
const python=process.env.MEGATOKEN_PYTHON??'python3',peer=join(nativeRoot,'tests/fixtures/serve_semantic_v8_recovery_fixture.py');
const faultPeer=join(root,'test/fixtures/semantic-v8-durable-commit-peer.py');
const env={...process.env,PYTHONPATH:[join(nativeRoot,'src'),nativeRoot,process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
let namespaceAvailable=false,described;
try{namespaceAvailable=/^time:\[[1-9][0-9]*\]$/.test(readlinkSync('/proc/self/ns/time'));}catch{}
const paired=Object.hasOwn(process.env,'MEGATOKEN_ROOT')&&existsSync(peer);
const skip=!paired?'Exact paired native recovery runtime is unconfigured; hosted gate is mandatory':
  namespaceAvailable?false:'Actual Linux time namespace identity is unavailable; hosted gate is mandatory';
if(process.env.REQUIRE_KNOWN_CLOSE_RECOVERY==='1'){
  assert(namespaceAvailable,'Mandatory close recovery gate requires the actual Linux time namespace identity');
  assert(paired,'Mandatory close recovery gate requires its exact native peer');
}

async function setup(t,{fault=null,beforeRequest=false,timeoutMs=120000,finalAction='track_complete',
    raceCloseDuringIntentAck=false}={}){
  assert(existsSync(peer),'Actual paired native recovery fixture is required');
  described??=spawnSync(python,[peer,'--describe'],{cwd:nativeRoot,env,encoding:'utf8',timeout:120000});
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout),document=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64'),'utf8'),'base64')));
  const initialPublic={...copy(document.public),timeline:copy(document.public.timeline.slice(0,2))};
  const policy={...identity,maxActive:1,childBudget:64,maxCoordinatorSelections:16,maxPredictions:32,
    maxGenerated:64,maxOutstanding:64,maxStaleRetries:2,timeoutMs,automaticDelivery:false};
  const directory=await mkdtemp(join(tmpdir(),'known-close-history-'));
  t.after(async()=>{for(const value of [...opened])await close(value).catch(()=>{});
    await rm(directory,{recursive:true,force:true});});
  const sessionId=initialPublic.timeline[0].fields.session,streamId='native-close-history';
  const requests=new DurableNativeV8RequestJournal({directory:join(directory,'requests'),sessionId,streamId});
  const lock=new DurableSelectedOrchestrationExecutionLock({directory:join(directory,'owner'),sessionId,streamId,
    flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'});
  const history=new DurableSelectedHistoryJournal({directory:join(directory,'history'),streamId:'selected-history'});
  let head=null,count=0,failNextAck=false,first=null,racedClose=null,raceUsed=false;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head,'external head acknowledgement must extend its retained predecessor');
    const entry=await history.read(receipt);
    if(raceCloseDuringIntentAck&&!raceUsed&&entry.terminal?.phase==='requested'&&entry.terminal.closeBoundary){
      raceUsed=true;
      racedClose=copy(await first.select.closeTerminal({session:entry.terminal.session,
        reason:entry.terminal.reason}));
    }
    if(failNextAck){failNextAck=false;throw new Error('lost terminal close head acknowledgement');}
    head=copy(receipt);return copy(receipt);
  };
  const opened=new Set();
  async function open(faultKind=null){
    const executionLease=await lock.acquire(),log=join(directory,'decoder-'+(++count)+'.log');
    const args=faultKind?[faultPeer,'--peer',peer,'--fault',faultKind,'--fault-action','cancel']:[peer];
    if(finalAction!=='track_complete')args.push('--final-action',finalAction);
    args.push('--decoder-log',log,'--request-journal-dir',requests.directory,'--execution-lock-fd','3',
      '--execution-lock-path',executionLease.lockPath,'--execution-session-id',sessionId,'--execution-stream-id',streamId,
      '--execution-session-generation',String(requests.sessionGeneration));
    const select=createNativeV8ProcessSelector({command:python,args,cwd:nativeRoot,env,timeoutMs:120000,
      maxMessageBytes:64*1024*1024,durableRequests:{journal:requests,executionLease}});
    let closeRecoveryCalls=0,closeTerminalCalls=0,recovered=null;const closeTerminalInputs=[];
    const recoverClose=select.recoverClose,closeTerminal=select.closeTerminal;
    select.recoverClose=(...values)=>{closeRecoveryCalls++;return recoverClose(...values).then(value=>{
      recovered=copy(value);return value;
    });};
    select.closeTerminal=(...values)=>{closeTerminalCalls++;closeTerminalInputs.push(copy(values[0]));
      return closeTerminal(...values);};
    const value={select,lease:executionLease,log,closeRecoveryCalls:()=>closeRecoveryCalls,
      closeTerminalCalls:()=>closeTerminalCalls,closeTerminalInputs:()=>copy(closeTerminalInputs),
      recovered:()=>copy(recovered),released:false};
    opened.add(value);return value;
  }
  async function close(value){
    if(!value||value.released)return;
    try{if(!value.select.status().closed)await value.select.shutdown();}
    finally{await value.lease.release();value.released=true;opened.delete(value);}
  }
  const replacement=async()=>{
    const end=Date.now()+10000;
    for(;;){try{return await open();}catch(error){
      if(!/execution ownership is unavailable/.test(error.message)||Date.now()>=end)throw error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }}
  };
  first=await open(fault);
  if(beforeRequest)first.select.closeTerminal=async()=>
    {throw new Error('simulated process loss before the producer close request');};
  const driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first.select,...policy});
  driver.startAutomaticHistory({journal:history,acknowledge,executionClock:createSelectedOrchestrationExecutionClock()});
  const result=await driver.run();
  const entries=await history.readLatest(head),tail=entries.at(-1),receipt=first.select.durableRequestReceipt();
  return {history,requests,lock,initialPublic,policy,tail,entries,receipt,acknowledge,
    setFailNextAck(){failNextAck=true;},close,replacement,head:()=>copy(head),first,result,racedClose:()=>copy(racedClose),
    sessionId,streamId};
}

const decoderLines=path=>{
  try{return readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
};
const restoreOptions=(context,fresh,receipt,overrides={})=>({historyJournal:context.history,
  historyReceipt:context.head(),initialPublic:context.initialPublic,select:fresh.select,policy:context.policy,
  acknowledge:context.acknowledge,executionClock:createSelectedOrchestrationExecutionClock(),
  closeRecovery:receipt===null?null:{receipt:copy(receipt)},...overrides});
function assertClosedRoute(terminal,original,phase=terminal.phase){
  assert.equal(terminal.phase,phase);
  assert((phase==='requested'?['completed','cancelled']:[phase]).includes(terminal.snapshot.state.status));
  assertOriginalRouteSnapshot(terminal.snapshot,original);
  if(phase!=='requested')assert.deepEqual(terminal.closedNative.attempts,terminal.snapshot.native.attempts);
}
function assertOriginalRouteSnapshot(snapshot,original){
  assert.equal(snapshot.coordinatorAttempts.length,4);
  assert.equal(snapshot.childAttempts.length,2);
  assert.deepEqual(snapshot.coordinatorAttempts,original.coordinatorAttempts);
  assert.deepEqual(snapshot.childAttempts,original.childAttempts);
  assert.deepEqual(snapshot.native.attempts,original.nativeMetrics.attempts);
}
function assertCloseBoundary(terminal){
  const boundary=terminal.closeBoundary,previous=terminal.snapshot.native.attempts.at(-1)?.durableRequestReceipt;
  assert(boundary&&previous);
  assert.equal(boundary.ordinal,previous.ordinal+1);
  for(const key of ['sessionId','streamId','sessionGeneration'])assert.equal(boundary[key],previous[key]);
}
function assertNoModelOrDecoderWork(fresh){
  assert.equal(fresh.select.metrics().predictionAttempts,0);
  assert.deepEqual(decoderLines(fresh.log),[]);
}

test('a normally closed acknowledged head is returned only as a nonresumable disposition',{skip},async t=>{
  const c=await setup(t);let fresh;
  try{
    assert.equal(c.result.status,'completed',JSON.stringify(c.result.failure));
    assert.equal(c.result.publicCompleted,true);
    assertClosedRoute(c.tail.terminal,c.result,'completed');
    assertCloseBoundary(c.tail.terminal);
    assert.deepEqual(c.tail.terminal.closeRequestReceipt,c.receipt);
    assert.equal(c.tail.terminal.closeBoundary.ordinal,c.receipt.ordinal);
    await c.close(c.first);fresh=await c.replacement();
    const disposition=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,fresh,c.receipt));
    assert.equal(disposition.status,'completed');assert.equal(disposition.resumable,false);
    assert.equal(disposition.publicCompleted,true);
    assert.equal(fresh.closeRecoveryCalls(),1);assert.equal(fresh.closeTerminalCalls(),0);
    assert.equal(fresh.recovered().hostDispatches,0);assert.equal(fresh.recovered().hostRecoveryAuthorized,false);
    const latest=(await c.history.readLatest(disposition.historyReceipt)).at(-1).terminal;
    assertClosedRoute(latest,c.result,'completed');
    assert.deepEqual(latest.closeRequestReceipt,c.receipt);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.first.log));
  }finally{if(fresh)await c.close(fresh);await c.close(c.first);}
});

for(const fault of ['after-native-outcome','alter-reply'])
test('lost or altered close reply '+fault+' recovers only the known native close',{skip},async t=>{
  const c=await setup(t,{fault});let fresh;
  try{
    assert.equal(c.tail.terminal.phase,'requested');
    assert.equal(c.tail.terminal.ownerSnapshot,null);
    assert(c.receipt);assert.equal(c.receipt.ordinal,c.tail.terminal.closeBoundary.ordinal);
    assertCloseBoundary(c.tail.terminal);
    assert.equal(c.receipt.sessionId,c.sessionId);assert.equal(c.receipt.streamId,c.streamId);
    assert.equal(c.first.closeTerminalCalls(),1);
    assertClosedRoute(c.tail.terminal,c.result,'requested');
    await c.close(c.first);fresh=await c.replacement();
    const disposition=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,fresh,c.receipt));
    assert.equal(disposition.status,'completed');assert.equal(disposition.resumable,false);
    assert.equal(disposition.publicCompleted,true);
    assert.equal(fresh.closeRecoveryCalls(),1);assert.equal(fresh.closeTerminalCalls(),0);
    assert.equal(fresh.recovered().hostDispatches,0);assert.equal(fresh.recovered().hostRecoveryAuthorized,false);
    const latest=(await c.history.readLatest(disposition.historyReceipt)).at(-1).terminal;
    assertClosedRoute(latest,c.result,'completed');
    assert.deepEqual(latest.closeRequestReceipt,c.receipt);
    assert.deepEqual(latest.closeReceipt,c.tail.terminal.closeReceipt??fresh.recovered().result);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.first.log));
  }finally{if(fresh)await c.close(fresh);await c.close(c.first);}
});

test('repeated terminal close recovery preserves its original attempts, costs and elapsed time',{skip},async t=>{
  const c=await setup(t,{fault:'after-native-outcome'});let firstRecovery,secondRecovery;
  try{
    await c.close(c.first);firstRecovery=await c.replacement();
    const first=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,firstRecovery,c.receipt));
    assert.equal(first.resumable,false);assert.equal(firstRecovery.recovered().hostDispatches,0);
    const firstTerminal=(await c.history.readLatest(first.historyReceipt)).at(-1).terminal;
    assertClosedRoute(firstTerminal,c.result,'completed');
    await c.close(firstRecovery);secondRecovery=await c.replacement();
    const second=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,secondRecovery,firstTerminal.closeRequestReceipt));
    assert.equal(second.status,'completed');assert.equal(second.resumable,false);
    assert.equal(secondRecovery.recovered().hostDispatches,0);
    const secondTerminal=(await c.history.readLatest(second.historyReceipt)).at(-1).terminal;
    assertClosedRoute(secondTerminal,c.result,'completed');
    assert.deepEqual(secondTerminal.closeReceipt,firstTerminal.closeReceipt);
    assert.deepEqual(secondTerminal.closeRequestReceipt,firstTerminal.closeRequestReceipt);
    assert(secondTerminal.closeElapsedMs>=firstTerminal.closeElapsedMs);
    for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
      assert(secondTerminal.closedNative.runtimeMetrics[key]>=firstTerminal.closedNative.runtimeMetrics[key]);
    assert.deepEqual(secondTerminal.closedNative.attempts,firstTerminal.closedNative.attempts);
    assert.equal(secondRecovery.closeTerminalCalls(),0);
  }finally{
    if(secondRecovery)await c.close(secondRecovery);
    if(firstRecovery)await c.close(firstRecovery);
    await c.close(c.first);
  }
});

test('an unknown native close outcome is never retried as a host close',{skip},async t=>{
  const c=await setup(t,{fault:'before-native-intent'});let fresh;
  try{
    assert.equal(c.tail.terminal.phase,'requested');assert(c.receipt);
    const before=await c.requests.list();await c.close(c.first);fresh=await c.replacement();
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,fresh,c.receipt)));
    assert.equal(fresh.closeRecoveryCalls(),1);assert.equal(fresh.closeTerminalCalls(),0);
    assert.equal(fresh.select.status().closed,true);
    assert.deepEqual(await c.requests.list(),before);
    const latest=(await c.history.readLatest(c.head())).at(-1);
    assert.equal(latest.terminal.phase,'requested');
    assertNoModelOrDecoderWork(fresh);
  }finally{if(fresh)await c.close(fresh);await c.close(c.first);}
});

test('an acknowledged close intent without its producer request cannot trigger close recovery',{skip},async t=>{
  const c=await setup(t,{beforeRequest:true});let fresh;
  try{
    assert.equal(c.tail.terminal.phase,'requested');
    assert.equal((await c.requests.list()).length,c.tail.terminal.closeBoundary.ordinal-1);
    await c.close(c.first);fresh=await c.replacement();
    const boundary=c.tail.terminal.closeBoundary,fakeReceipt={schema:'semantic-native-producer-request-receipt/8',
      ordinal:boundary.ordinal,digest:'a'.repeat(64),bytes:1,sessionId:boundary.sessionId,
      streamId:boundary.streamId,sessionGeneration:boundary.sessionGeneration};
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,fresh,fakeReceipt)));
    assert.equal(fresh.closeRecoveryCalls(),1);assert.equal(fresh.closeTerminalCalls(),0);
    assert.equal(fresh.select.metrics().runtime.rpcCalls,0);
    assertNoModelOrDecoderWork(fresh);
    assert.equal((await c.requests.list()).length,boundary.ordinal-1);
  }finally{if(fresh)await c.close(fresh);await c.close(c.first);}
});

test('lost terminal head acknowledgement makes its older close intent stale before native recovery',{skip},async t=>{
  const c=await setup(t,{fault:'after-native-outcome'});let recovery,third;
  try{
    const oldHead=c.head();await c.close(c.first);recovery=await c.replacement();c.setFailNextAck();
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,recovery,c.receipt)),/lost terminal close head acknowledgement/);
    assert.deepEqual(c.head(),oldHead);assert.equal(recovery.closeRecoveryCalls(),1);
    await c.close(recovery);third=await c.replacement();
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,third,c.receipt)),/later durable history exists|stale history recovery/);
    assert.equal(third.closeRecoveryCalls(),0);assert.equal(third.closeTerminalCalls(),0);
    assert.equal(third.select.metrics().runtime.rpcCalls,0);
    assertNoModelOrDecoderWork(third);
  }finally{
    if(third)await c.close(third);
    if(recovery)await c.close(recovery);
    await c.close(c.first);
  }
});

test('selector close racing terminal-head acknowledgement cannot dispatch a second close',{skip},async t=>{
  const c=await setup(t,{raceCloseDuringIntentAck:true});let fresh;
  try{
    assert.equal(c.tail.terminal.phase,'requested');
    assert.equal(c.racedClose().schema,'semantic-native-close/8');
    assert.equal(c.first.closeTerminalCalls(),2);
    const [racingCall,driverCall]=c.first.closeTerminalInputs();
    assert.equal(Object.hasOwn(racingCall,'expectedBoundary'),false);
    assert.deepEqual(driverCall.expectedBoundary,c.tail.terminal.closeBoundary);
    assert.equal(driverCall.expectedCheckpointDigest,c.tail.terminal.snapshot.native.native.digest);
    assertCloseBoundary(c.tail.terminal);
    const durable=await c.requests.list();
    assert.equal(durable.length,c.tail.terminal.closeBoundary.ordinal);
    assert.equal(durable.at(-1).ordinal,c.tail.terminal.closeBoundary.ordinal,
      'the racing close admitted one request; the driver must not admit another');
    assert(c.result.cleanupFailure);
    await c.close(c.first);fresh=await c.replacement();
    const disposition=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,fresh,c.receipt));
    assert.equal(disposition.status,'completed');assert.equal(disposition.resumable,false);
    assert.equal(fresh.recovered().hostDispatches,0);assert.equal(fresh.closeTerminalCalls(),0);
    const latest=(await c.history.readLatest(disposition.historyReceipt)).at(-1).terminal;
    assertClosedRoute(latest,c.result,'completed');
  }finally{if(fresh)await c.close(fresh);await c.close(c.first);}
});

test('a fully settled cancellation recovers as a nonresumable close without host work',{skip},async t=>{
  const c=await setup(t,{fault:'after-native-outcome',finalAction:'track_cancel'});let fresh;
  try{
    assert.equal(c.tail.terminal.phase,'requested');
    assert.equal(c.tail.terminal.snapshot.state.status,'cancelled');
    assertClosedRoute(c.tail.terminal,c.result,'requested');
    assertCloseBoundary(c.tail.terminal);
    await c.close(c.first);fresh=await c.replacement();
    const disposition=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      restoreOptions(c,fresh,c.receipt));
    assert.equal(disposition.status,'cancelled');assert.equal(disposition.resumable,false);
    assert.equal(disposition.publicCompleted,false);
    assert.equal(fresh.recovered().hostDispatches,0);assert.equal(fresh.recovered().hostRecoveryAuthorized,false);
    assert.equal(fresh.closeTerminalCalls(),0);
    const latest=(await c.history.readLatest(disposition.historyReceipt)).at(-1).terminal;
    assertClosedRoute(latest,c.result,'cancelled');
    assert.equal(latest.closeReceipt.reason,c.tail.terminal.reason);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.first.log));
  }finally{if(fresh)await c.close(fresh);await c.close(c.first);}
});
