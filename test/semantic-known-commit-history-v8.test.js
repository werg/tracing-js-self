// Real Python/native durability with deterministic final decoder bytes. These
// checks establish recovery ordering/identity, not learned execution quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readlinkSync,writeFileSync} from 'node:fs';
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
const skip=namespaceAvailable?false:'Linux time namespace identity is unavailable; hosted positive gate is mandatory';
if(process.env.REQUIRE_KNOWN_COMMIT_RECOVERY==='1'){
  assert(namespaceAvailable,'Mandatory recovery gate requires the actual Linux time namespace identity');
  assert(existsSync(peer),'Mandatory recovery gate requires its exact native peer');
}

async function setup(t,action,{fault='after-native-outcome',timeoutMs=120000}={}){
  assert(existsSync(peer),'Actual paired native recovery fixture is required');
  described??=spawnSync(python,[peer,'--describe'],{cwd:nativeRoot,env,encoding:'utf8',timeout:120000});
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout),document=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64'),'utf8'),'base64')));
  const initialPublic={...copy(document.public),timeline:copy(document.public.timeline.slice(0,2))};
  const policy={...identity,maxActive:1,childBudget:64,maxCoordinatorSelections:16,maxPredictions:32,
    maxGenerated:64,maxOutstanding:64,maxStaleRetries:2,timeoutMs,automaticDelivery:false};
  const directory=await mkdtemp(join(tmpdir(),'known-commit-history-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const sessionId=initialPublic.timeline[0].fields.session,streamId='native-commit-history';
  const requests=new DurableNativeV8RequestJournal({directory:join(directory,'requests'),sessionId,streamId});
  const lock=new DurableSelectedOrchestrationExecutionLock({directory:join(directory,'owner'),sessionId,streamId,
    flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'});
  const history=new DurableSelectedHistoryJournal({directory:join(directory,'history'),streamId:'selected-history'});
  let head=null,count=0;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head,'external head acknowledgement must extend its retained predecessor');
    head=copy(receipt);return copy(receipt);
  };
  async function open(faultAction=null){
    const executionLease=await lock.acquire(),log=join(directory,'decoder-'+(++count)+'.log');
    // Refusals can complete before the child initializes its decoder log.
    // Give the observation an empty baseline without waiting for model work.
    writeFileSync(log,'',{flag:'wx'});
    const args=faultAction?[faultPeer,'--peer',peer,'--fault',fault,'--fault-action',faultAction]:[peer];
    args.push('--decoder-log',log,'--request-journal-dir',requests.directory,'--execution-lock-fd','3',
      '--execution-lock-path',executionLease.lockPath,'--execution-session-id',sessionId,'--execution-stream-id',streamId,
      '--execution-session-generation',String(requests.sessionGeneration));
    const select=createNativeV8ProcessSelector({command:python,args,cwd:nativeRoot,env,timeoutMs:120000,
      maxMessageBytes:64*1024*1024,durableRequests:{journal:requests,executionLease}});
    return {select,lease:executionLease,log};
  }
  const close=async value=>{
    if(!value.select.status().closed)await value.select.shutdown();
    await value.lease.release();
  };
  const replacement=async()=>{
    const end=Date.now()+10000;
    for(;;){try{return await open();}catch(error){
      if(!/execution ownership is unavailable/.test(error.message)||Date.now()>=end)throw error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }}
  };
  const first=await open(action);let result,receipt;
  try{
    const driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first.select,...policy});
    driver.startAutomaticHistory({journal:history,acknowledge,executionClock:createSelectedOrchestrationExecutionClock()});
    result=await driver.run();
    assert.equal(result.status,'failed',JSON.stringify(result.failure));
    assert.equal(result.coordinatorAttempts.at(-1).status,'acknowledgement-unknown');
    receipt=first.select.durableRequestReceipt();assert(receipt);
  }finally{await close(first);}
  const entries=await history.readLatest(head),tail=entries.at(-1);
  assert.equal(tail.pending.kind,'coordinator-selection');
  assert(tail.pending.clockReceipt);assert.equal(tail.pending.requestBoundary.ordinal,receipt.ordinal);
  return {history,requests,initialPublic,policy,tail,receipt,acknowledge,close,replacement,
    head:()=>copy(head),original:result,firstLog:first.log};
}
const decoderLines=path=>readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));
const options=(context,fresh,overrides={})=>({historyJournal:context.history,historyReceipt:context.head(),
  initialPublic:context.initialPublic,select:fresh.select,policy:context.policy,
  acknowledge:context.acknowledge,executionClock:createSelectedOrchestrationExecutionClock(),
  commitRecovery:{receipt:copy(context.receipt)},...overrides});

for(const action of ['track_join','track_progress'])test('actual lost '+action+' reply seals history before exact continuation',{skip},async t=>{
  const c=await setup(t,action);let fresh=await c.replacement();
  try{
    const before=copy(c.tail.checkpoint),priorHead=c.head();
    let restored=await RegionSelectedOrchestrationDriver.restoreLatest(before,options(c,fresh));
    assert(c.head().position>priorHead.position);
    const retained=(await c.history.readLatest(c.head())).at(-1);
    assert.equal(Object.hasOwn(retained,'pending'),false);
    assert.deepEqual(retained.checkpoint.bridge,before.bridge);
    assert.deepEqual(retained.checkpoint.childAttempts,before.childAttempts);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.firstLog),'recovery reexecutes only the consumed model prefix');
    assert(retained.checkpoint.continuation.elapsedMs>before.continuation.elapsedMs);
    assert.deepEqual(retained.checkpoint.continuation.clockReceipt,c.tail.pending.clockReceipt);
    assert.equal(restored.automaticHistory.status,'ready');
    // A second process loss after the new head is acknowledged must recover
    // the same sealed cut, preserving all earlier reexecution costs and time.
    await c.close(fresh);fresh=await c.replacement();
    restored=await RegionSelectedOrchestrationDriver.restoreLatest(retained.checkpoint,options(c,fresh));
    const repeated=(await c.history.readLatest(c.head())).at(-1).checkpoint;
    assert.deepEqual(repeated.bridge,retained.checkpoint.bridge);
    assert.deepEqual(repeated.childAttempts,retained.checkpoint.childAttempts);
    assert.deepEqual(repeated.coordinatorAttempts,retained.checkpoint.coordinatorAttempts);
    assert(repeated.native.runtimeMetrics.rpcCalls>retained.checkpoint.native.runtimeMetrics.rpcCalls);
    assert(repeated.native.runtimeMetrics.computeSeconds>=retained.checkpoint.native.runtimeMetrics.computeSeconds);
    assert(repeated.continuation.elapsedMs>retained.checkpoint.continuation.elapsedMs);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.firstLog));
    const result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.publicCompleted,true);
    assert.equal(result.coordinatorAttempts.length,4);
    assert.equal(result.childAttempts.length,2);
    assert.equal(fresh.select.metrics().predictionAttempts,6);
    assert.equal(fresh.select.metrics().semanticallyAccepted,6);
    const final=(await c.history.readLatest(c.head())).at(-1);
    assert.equal(final.terminal.phase,'completed');
  }finally{await c.close(fresh);}
});

test('unknown native outcome cannot resolve the coordinator fence or authorize replay',{skip},async t=>{
  const c=await setup(t,'track_join',{fault:'before-native-intent'}),fresh=await c.replacement(),head=c.head();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh)),/never admitted/);
    assert.deepEqual(c.head(),head);assert.equal(readFileSync(fresh.log,'utf8'),'');
    assert.equal(fresh.select.metrics().predictionAttempts,0);
  }finally{await c.close(fresh);}
});

test('wrong request scope or absent live clock refuses before any native recovery RPC',{skip},async t=>{
  const c=await setup(t,'track_join'),fresh=await c.replacement();
  try{
    for(const key of ['ordinal','sessionGeneration','streamId']){
      const receipt=copy(c.receipt);receipt[key]=key==='streamId'?'other-stream':receipt[key]+1;
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
        options(c,fresh,{commitRecovery:{receipt}})),/retained request scope/);
    }
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,
      options(c,fresh,{executionClock:{}})),/original live clock/);
    assert.equal(fresh.select.metrics().predictionAttempts,0);
    assert.equal(fresh.select.metrics().rpcCalls,0);assert.equal(readFileSync(fresh.log,'utf8'),'');
  }finally{await c.close(fresh);}
});

test('lost reconciled-head acknowledgement leaves the old receipt fenced without another host dispatch',{skip},async t=>{
  const c=await setup(t,'track_join'),fresh=await c.replacement(),head=c.head();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh,{
      acknowledge:async()=>{throw new Error('lost recovered head acknowledgement');}
    })),/lost recovered head acknowledgement/);
    assert.deepEqual(c.head(),head);
    assert.equal(fresh.select.status().closed,true);
  }finally{await c.close(fresh);}
  const third=await c.replacement();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,third)),/latest|later|head/);
    assert.equal(third.select.metrics().predictionAttempts,0);
    assert.equal(third.select.metrics().rpcCalls,0);assert.equal(readFileSync(third.log,'utf8'),'');
  }finally{await c.close(third);}
});

test('a real expired pending clock cannot refund time on process replacement',{skip},async t=>{
  const c=await setup(t,'track_join',{timeoutMs:30000}),clock=createSelectedOrchestrationExecutionClock();
  const used=await clock.elapsed(c.tail.pending.clockReceipt,{timeoutMs:c.policy.timeoutMs});
  await new Promise(resolve=>setTimeout(resolve,c.policy.timeoutMs-used+30));
  const fresh=await c.replacement();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh)),/deadline has expired/);
    assert.equal(fresh.select.metrics().predictionAttempts,0);
    assert.equal(fresh.select.metrics().rpcCalls,0);assert.equal(readFileSync(fresh.log,'utf8'),'');
  }finally{await c.close(fresh);}
});
