// Actual service-owned terminal close recovery. The Python peer uses the real
// native V8 runtime; deterministic bytes replace only its final decoder output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readlinkSync} from 'node:fs';
import {mkdtemp,rm,unlink,writeFile} from 'node:fs/promises';
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
import {DurableFencedSelectedServiceJournal} from '../src/storage/selected-service-fence-journal.js';
import {SelectedServiceAdmissionCoordinator} from '../src/storage/selected-service-coordinator.js';

const copy=structuredClone,root=dirname(dirname(fileURLToPath(import.meta.url)));
const pairedRootConfigured=Object.hasOwn(process.env,'MEGATOKEN_ROOT');
const nativeRoot=resolve(process.env.MEGATOKEN_ROOT??join(root,'../megatoken'));
const python=process.env.MEGATOKEN_PYTHON??'python3',peer=join(nativeRoot,'tests/fixtures/serve_semantic_v8_recovery_fixture.py'),
  fixturePath=join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64');
const faultPeer=join(root,'test/fixtures/semantic-v8-durable-commit-peer.py');
const env={...process.env,PYTHONPATH:[join(nativeRoot,'src'),nativeRoot,process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
let namespaceAvailable=false,described;
try{namespaceAvailable=/^time:\[[1-9][0-9]*\]$/.test(readlinkSync('/proc/self/ns/time'));}catch{}
const nativeAvailable=existsSync(peer)&&existsSync(fixturePath)&&existsSync(faultPeer);
const skip=!pairedRootConfigured?'MEGATOKEN_ROOT is unset; optional paired native service-close test skipped':
  !nativeAvailable?'paired native recovery fixture is unavailable; hosted positive gate is mandatory':
  !namespaceAvailable?'Linux time namespace identity is unavailable; hosted positive gate is mandatory':false;
if(process.env.REQUIRE_KNOWN_CLOSE_RECOVERY==='1'){
  assert(pairedRootConfigured,'Mandatory service close recovery gate requires an explicit MEGATOKEN_ROOT');
  assert(namespaceAvailable,'Mandatory service close recovery gate requires the actual Linux time namespace identity');
  assert(nativeAvailable,'Mandatory service close recovery gate requires its exact paired native and producer fixtures');
}

async function setup(t,{fault='after-native-outcome',finalAction='track_complete'}={}){
  assert(existsSync(peer)&&existsSync(fixturePath),'Actual paired native recovery fixture is required');
  described??=spawnSync(python,[peer,'--describe'],{cwd:nativeRoot,env,encoding:'utf8',timeout:120000});
  if(described.status!==0&&process.env.REQUIRE_KNOWN_CLOSE_RECOVERY!=='1'){
    t.skip('paired native runtime is unavailable');return null;
  }
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout),document=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64'),'utf8'),'base64')));
  const initialPublic={...copy(document.public),timeline:copy(document.public.timeline.slice(0,2))};
  const policy={...identity,maxActive:1,childBudget:64,maxCoordinatorSelections:16,maxPredictions:32,
    maxGenerated:64,maxOutstanding:64,maxStaleRetries:2,timeoutMs:120000,automaticDelivery:false};
  const directory=await mkdtemp(join(tmpdir(),'known-service-close-'));
  const opened=new Set();
  t.after(async()=>{for(const value of [...opened])await close(value).catch(()=>{});
    await rm(directory,{recursive:true,force:true});});
  const sessionId=initialPublic.timeline[0].fields.session,streamId='native-service-close-history';
  const requests=new DurableNativeV8RequestJournal({directory:join(directory,'requests'),sessionId,streamId});
  const lock=new DurableSelectedOrchestrationExecutionLock({directory:join(directory,'owner'),sessionId,streamId,
    flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'});
  const history=new DurableSelectedHistoryJournal({directory:join(directory,'history'),streamId:'service-close-history'});
  let head=null,count=0,serviceFence=null;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head,'external head acknowledgement must extend its retained predecessor');
    head=copy(receipt);return copy(receipt);
  };
  class Unavailable extends DurableFencedSelectedServiceJournal{
    unavailable=false;
    async _synchronize(){
      if(this.unavailable)throw new Error('service journal sync unavailable');
      return super._synchronize();
    }
  }
  const services=[];
  for(const serviceId of ['alpha','beta']){
    const journal=new Unavailable({directory,serviceId,sessionId});
    const owner=await journal.advanceOwner({ownerId:'supervisor'});
    services.push({journal,owner});
  }
  const serviceCoordinator=new SelectedServiceAdmissionCoordinator({sessionId,services});
  const terminate=serviceCoordinator.terminate.bind(serviceCoordinator);
  serviceCoordinator.terminate=async request=>{
    serviceFence=copy(await terminate(request));return copy(serviceFence);
  };
  async function open(faultKind=null){
    const lease=await lock.acquire(),log=join(directory,'decoder-'+(++count)+'.log'),args=faultKind?
      [faultPeer,'--peer',peer,'--fault',faultKind,'--fault-action','cancel']:[peer];
    if(finalAction!=='track_complete')args.push('--final-action',finalAction);
    args.push('--decoder-log',log,'--request-journal-dir',requests.directory,'--execution-lock-fd','3',
      '--execution-lock-path',lease.lockPath,'--execution-session-id',sessionId,'--execution-stream-id',streamId,
      '--execution-session-generation',String(requests.sessionGeneration));
    const select=createNativeV8ProcessSelector({command:python,args,cwd:nativeRoot,env,timeoutMs:120000,
      maxMessageBytes:64*1024*1024,durableRequests:{journal:requests,executionLease:lease}});
    let closeRecoveryCalls=0;
    const recoverClose=select.recoverClose;
    select.recoverClose=(...values)=>{closeRecoveryCalls++;return recoverClose(...values);};
    const value={select,lease,log,closeRecoveryCalls:()=>closeRecoveryCalls,released:false};
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
      await new Promise(resolvePromise=>setTimeout(resolvePromise,20));
    }}
  };
  const first=await open(fault),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first.select,...policy,
    serviceAdmissionCoordinator:serviceCoordinator});
  driver.startAutomaticHistory({journal:history,acknowledge,
    executionClock:createSelectedOrchestrationExecutionClock()});
  const result=await driver.run(),entries=await history.readLatest(head),tail=entries.at(-1),receipt=first.select.durableRequestReceipt();
  return {directory,history,requests,lock,services,serviceCoordinator,identity,document,initialPublic,policy,
    tail,entries,receipt,acknowledge,replacement,close,first,result,head:()=>copy(head),sessionId,streamId,
    serviceFence:()=>copy(serviceFence)};
}

const decoderLines=path=>{
  try{return readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
};
const recoveryOptions=(context,selector,receipt,serviceAdmissionCoordinator,
    executionClock=createSelectedOrchestrationExecutionClock())=>({historyJournal:context.history,
  historyReceipt:context.head(),initialPublic:context.initialPublic,select:selector.select,policy:context.policy,
  acknowledge:context.acknowledge,executionClock,serviceAdmissionCoordinator,closeRecovery:{receipt:copy(receipt)}});
function instrumentRecovery(selector){
  let calls=0;const recover=selector.recoverClose;
  selector.recoverClose=(...values)=>{calls++;return recover(...values);};
  return ()=>calls;
}
function assertNoNativeRecovery(selector,closeCalls,log){
  assert.equal(closeCalls(),0,'service authority must be verified before native close recovery');
  assert.equal(selector.metrics().runtime.rpcCalls,0,'service refusal precedes every native recovery RPC');
  assert.equal(selector.metrics().predictionAttempts,0);
  assert.deepEqual(decoderLines(log),[],'service refusal cannot dispatch model or host work');
}

test('service-owned known close recovers only after exact same-owner authority and preserves it across process loss',
  {skip},async t=>{
    const c=await setup(t);if(!c)return;
    let ownerBlocked,syncBlocked,readBlocked,verifyBlocked,headBlocked,unknownBlocked,recovered,repeated;
    try{
      assert.notEqual(c.result.status,'completed',JSON.stringify(c.result.failure));
      assert.equal(c.tail.terminal.phase,'requested');
      assert.equal(c.tail.terminal.snapshot.state.status,'completed');
      assert.deepEqual(c.tail.terminal.ownerSnapshot,c.serviceCoordinator.ownerSnapshot());
      assert(c.tail.terminal.closeBoundary);
      assert(c.receipt);assert.equal(c.receipt.ordinal,c.tail.terminal.closeBoundary.ordinal);
      assert(c.serviceFence());
      assert.deepEqual(await c.serviceCoordinator.verify(c.serviceFence()),c.serviceFence());
      for(const {journal} of c.services){
        const state=await journal.inspect();
        assert.equal(state.terminal.reason,c.tail.terminal.reason);
        assert.deepEqual(state.head,state.terminal.receipt);
      }

      const wrongServices=c.services.map(({journal,owner})=>({journal,owner:copy(owner)}));
      wrongServices[0].owner.id='f'.repeat(64);
      const wrongOwner=new SelectedServiceAdmissionCoordinator({sessionId:c.sessionId,services:wrongServices});
      await c.close(c.first);ownerBlocked=await c.replacement();
      const ownerCalls=instrumentRecovery(ownerBlocked.select);
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        recoveryOptions(c,ownerBlocked,c.receipt,wrongOwner)),/exact retained service owner snapshot/);
      assertNoNativeRecovery(ownerBlocked.select,ownerCalls,ownerBlocked.log);
      await c.close(ownerBlocked);

      c.services.find(row=>row.journal.serviceId==='beta').journal.unavailable=true;
      syncBlocked=await c.replacement();
      const syncCalls=instrumentRecovery(syncBlocked.select);
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        recoveryOptions(c,syncBlocked,c.receipt,new SelectedServiceAdmissionCoordinator({
          sessionId:c.sessionId,services:c.services}))),/service journal sync unavailable/);
      assertNoNativeRecovery(syncBlocked.select,syncCalls,syncBlocked.log);
      await c.close(syncBlocked);
      const betaJournal=c.services.find(row=>row.journal.serviceId==='beta').journal;
      betaJournal.unavailable=false;
      const originalInspect=betaJournal.inspect.bind(betaJournal);
      betaJournal.inspect=async()=>{await betaJournal._synchronize();throw new Error('service journal read unavailable');};
      readBlocked=await c.replacement();
      const readCalls=instrumentRecovery(readBlocked.select);
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        recoveryOptions(c,readBlocked,c.receipt,new SelectedServiceAdmissionCoordinator({
          sessionId:c.sessionId,services:c.services}))),/service journal read unavailable/);
      assertNoNativeRecovery(readBlocked.select,readCalls,readBlocked.log);
      await c.close(readBlocked);
      betaJournal.inspect=originalInspect;

      const failedVerification=new SelectedServiceAdmissionCoordinator({sessionId:c.sessionId,services:c.services}),
        verifyFence=failedVerification.verify.bind(failedVerification);
      failedVerification.verify=async fence=>{
        await verifyFence(fence);throw new Error('service journal verification unavailable');
      };
      verifyBlocked=await c.replacement();
      const verifyCalls=instrumentRecovery(verifyBlocked.select);
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        recoveryOptions(c,verifyBlocked,c.receipt,failedVerification)),/service journal verification unavailable/);
      assertNoNativeRecovery(verifyBlocked.select,verifyCalls,verifyBlocked.log);
      await c.close(verifyBlocked);

      headBlocked=await c.replacement();
      const headCoordinator=new SelectedServiceAdmissionCoordinator({sessionId:c.sessionId,services:c.services}),
        headVerify=headCoordinator.verify.bind(headCoordinator),stalePath=join(c.history.directory,
          'selected-checkpoint-history',c.history.streamId,`${c.head().position+1}.json`);
      headCoordinator.verify=async fence=>{
        const retained=await headVerify(fence);
        await writeFile(stalePath,'{}',{flag:'wx',mode:0o600});
        return retained;
      };
      const headCalls=instrumentRecovery(headBlocked.select);
      try{
        await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
          recoveryOptions(c,headBlocked,c.receipt,headCoordinator)),/later durable history exists/);
        assertNoNativeRecovery(headBlocked.select,headCalls,headBlocked.log);
      }finally{
        await unlink(stalePath).catch(error=>{if(error.code!=='ENOENT')throw error;});
        await c.close(headBlocked);
      }

      const unknownFence=new SelectedServiceAdmissionCoordinator({sessionId:c.sessionId,services:c.services}),
        realTerminate=unknownFence.terminate.bind(unknownFence);
      unknownFence.terminate=async request=>{
        await realTerminate(request);throw new Error('service terminal acknowledgement unknown');
      };
      unknownBlocked=await c.replacement();
      const unknownCalls=instrumentRecovery(unknownBlocked.select);
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        recoveryOptions(c,unknownBlocked,c.receipt,unknownFence)),/service terminal acknowledgement unknown/);
      assertNoNativeRecovery(unknownBlocked.select,unknownCalls,unknownBlocked.log);
      await c.close(unknownBlocked);

      recovered=await c.replacement();
      const sameOwner=new SelectedServiceAdmissionCoordinator({sessionId:c.sessionId,services:c.services});
      const disposition=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        recoveryOptions(c,recovered,c.receipt,sameOwner));
      assert.equal(disposition.status,'completed');assert.equal(disposition.resumable,false);
      assert.equal(disposition.publicCompleted,true);
      assert.equal(recovered.select.metrics().predictionAttempts,0);
      assert.equal(recovered.select.metrics().runtime.rpcCalls,2,
        'known close recovery only checkpoints after its one durable recovery RPC');
      assert.deepEqual(decoderLines(recovered.log),[]);
      const firstTerminal=(await c.history.readLatest(disposition.historyReceipt)).at(-1).terminal;
      assert.deepEqual(firstTerminal.ownerSnapshot,c.tail.terminal.ownerSnapshot);
      assert.deepEqual(firstTerminal.serviceAdmission,c.serviceFence());
      assert.deepEqual(firstTerminal.closeRequestReceipt,c.receipt);
      assert.equal(firstTerminal.closeReceipt.reason,c.tail.terminal.reason);
      assert.equal(recovered.closeRecoveryCalls(),1);
      await c.close(recovered);

      repeated=await c.replacement();
      const retainedCoordinator=new SelectedServiceAdmissionCoordinator({sessionId:c.sessionId,services:c.services});
      let terminalizations=0;retainedCoordinator.terminate=async()=>{terminalizations++;throw new Error('must not reterminate');};
      const repeatedDisposition=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        recoveryOptions({...c,head:()=>copy(disposition.historyReceipt)},repeated,
          firstTerminal.closeRequestReceipt,retainedCoordinator));
      assert.equal(repeatedDisposition.status,'completed');assert.equal(repeatedDisposition.resumable,false);
      assert.equal(terminalizations,0,'completed close verifies its stored fence without terminalizing again');
      const secondTerminal=(await c.history.readLatest(repeatedDisposition.historyReceipt)).at(-1).terminal;
      assert.deepEqual(secondTerminal.ownerSnapshot,firstTerminal.ownerSnapshot);
      assert.deepEqual(secondTerminal.serviceAdmission,firstTerminal.serviceAdmission);
      assert.deepEqual(secondTerminal.closeRequestReceipt,firstTerminal.closeRequestReceipt);
      assert.deepEqual(secondTerminal.closeReceipt,firstTerminal.closeReceipt);
      assert.deepEqual(secondTerminal.closedNative.attempts,firstTerminal.closedNative.attempts);
      assert(secondTerminal.closeElapsedMs>=firstTerminal.closeElapsedMs);
      for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
        assert(secondTerminal.closedNative.runtimeMetrics[key]>=firstTerminal.closedNative.runtimeMetrics[key]);
      assert.equal(repeated.closeRecoveryCalls(),1);
      assert.deepEqual(decoderLines(repeated.log),[]);
    }finally{
      for(const value of [repeated,recovered,unknownBlocked,headBlocked,verifyBlocked,readBlocked,syncBlocked,ownerBlocked,c.first])
        await c.close(value);
    }
  });

test('service-owned settled cancellation preserves its exact owner and terminal fence',{skip},async t=>{
  const c=await setup(t,{fault:null,finalAction:'track_cancel'});if(!c)return;let fresh;
  try{
    assert.equal(c.result.status,'cancelled',JSON.stringify(c.result.failure));
    const terminal=c.tail.terminal;
    assert.equal(terminal.phase,'cancelled');assert.equal(terminal.snapshot.state.status,'cancelled');
    assert.deepEqual(terminal.ownerSnapshot,c.serviceCoordinator.ownerSnapshot());
    assert.deepEqual(terminal.serviceAdmission,c.serviceFence());
    assert.equal(terminal.closeReceipt.reason,terminal.reason);
    assert.deepEqual(terminal.closeRequestReceipt,c.receipt);
    await c.close(c.first);fresh=await c.replacement();
    const coordinator=new SelectedServiceAdmissionCoordinator({sessionId:c.sessionId,services:c.services});
    let terminalizations=0;coordinator.terminate=async()=>{terminalizations++;throw new Error('must not reterminate');};
    const disposition=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      recoveryOptions(c,fresh,c.receipt,coordinator));
    assert.equal(disposition.status,'cancelled');assert.equal(disposition.resumable,false);
    assert.equal(terminalizations,0);
    const repeated=(await c.history.readLatest(disposition.historyReceipt)).at(-1).terminal;
    assert.deepEqual(repeated.ownerSnapshot,terminal.ownerSnapshot);
    assert.deepEqual(repeated.serviceAdmission,terminal.serviceAdmission);
    assert.deepEqual(repeated.closeRequestReceipt,terminal.closeRequestReceipt);
    assert.deepEqual(repeated.closeReceipt,terminal.closeReceipt);
    assert.deepEqual(decoderLines(fresh.log),[]);
  }finally{await c.close(fresh);await c.close(c.first);}
});
