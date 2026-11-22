// Real Python/native and genuine Linux clock authority. Fixed lexical decoder
// bytes isolate recovery semantics; this is not learned execution evidence.
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

const copy=structuredClone,root=dirname(dirname(fileURLToPath(import.meta.url))),
  nativeRoot=resolve(process.env.MEGATOKEN_ROOT??join(root,'../megatoken')),
  python=process.env.MEGATOKEN_PYTHON??'python3',peer=join(nativeRoot,'tests/fixtures/serve_semantic_v8_recovery_fixture.py'),
  faultPeer=join(root,'test/fixtures/semantic-v8-durable-commit-peer.py'),
  env={...process.env,PYTHONPATH:[join(nativeRoot,'src'),nativeRoot,process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
let namespaceAvailable=false,described;
try{namespaceAvailable=/^time:\[[1-9][0-9]*\]$/.test(readlinkSync('/proc/self/ns/time'));}catch{}
const skip=namespaceAvailable?false:'Actual Linux time namespace identity is unavailable; hosted bootstrap gate is mandatory';
if(process.env.REQUIRE_DURABLE_BOOTSTRAP_RECOVERY==='1'){
  assert(namespaceAvailable,'Mandatory bootstrap history gate requires the actual Linux time namespace identity');
  assert(existsSync(peer),'Mandatory bootstrap history gate requires its exact native peer');
}

async function setup(t,{stage='bootstrap',fault='after-native-outcome',pause=false,beforeRequest=false,timeoutMs=120000}={}){
  assert(existsSync(peer),'Actual paired bootstrap recovery fixture is required');
  described??=spawnSync(python,[peer,'--describe'],{cwd:nativeRoot,env,encoding:'utf8',timeout:120000});
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout),document=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64'),'utf8'),'base64'))),
    initialPublic={...copy(document.public),timeline:copy(document.public.timeline.slice(0,2))},
    policy={...identity,maxActive:1,childBudget:64,maxCoordinatorSelections:16,maxPredictions:32,
      maxGenerated:64,maxOutstanding:64,maxStaleRetries:2,timeoutMs,automaticDelivery:false},
    directory=await mkdtemp(join(tmpdir(),'known-bootstrap-history-')),
    sessionId=initialPublic.timeline[0].fields.session,streamId='native-bootstrap-history',
    requests=new DurableNativeV8RequestJournal({directory:join(directory,'requests'),sessionId,streamId}),
    lock=new DurableSelectedOrchestrationExecutionLock({directory:join(directory,'owner'),sessionId,streamId,
      flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'}),
    history=new DurableSelectedHistoryJournal({directory:join(directory,'history'),streamId:'selected-bootstrap-history'});
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let head=null,count=0;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head);head=copy(receipt);return copy(receipt);
  };
  async function open(inject=false){
    const lease=await lock.acquire(),log=join(directory,'decoder-'+(++count)+'.log'),
      args=inject&&!beforeRequest?[faultPeer,'--peer',peer,'--fault',fault,'--fault-operation',
        stage==='create'?'durable-commit':'durable-bootstrap-child',
        ...(stage==='create'?['--fault-action','track_create']:[])]:[peer];
    args.push('--decoder-log',log,'--request-journal-dir',requests.directory,'--execution-lock-fd','3',
      '--execution-lock-path',lease.lockPath,'--execution-session-id',sessionId,'--execution-stream-id',streamId,
      '--execution-session-generation',String(requests.sessionGeneration));
    const select=createNativeV8ProcessSelector({command:python,args,cwd:nativeRoot,env,timeoutMs:120000,
      maxMessageBytes:64*1024*1024,durableRequests:{journal:requests,executionLease:lease}});
    let recoverCalls=0,bootstrapCalls=0;
    for(const method of ['recoverCommit','recoverBootstrapChild']){
      const original=select[method];select[method]=(...args)=>{recoverCalls++;return original(...args);};
    }
    const bootstrap=select.bootstrapOrchestrationChild;
    select.bootstrapOrchestrationChild=async input=>{
      bootstrapCalls++;
      const entries=await history.readLatest(head),tail=entries.at(-1),
        sealed=entries.filter(row=>row.checkpoint.continuation.phase==='bootstrap-ready'&&!row.pending).at(-1);
      assert(sealed,'complete create cut must be acknowledged before any bootstrap call');
      assert.equal(tail.pending?.kind,'child-bootstrap');
      assert.equal(tail.pending.childTrack,input.childTrack);
      assert.deepEqual(tail.pending.clockReceipt,sealed.checkpoint.continuation.clockReceipt);
      assert.equal(tail.pending.requestBoundary.ordinal,tail.pending.createReceipt.ordinal+1);
      if(inject&&beforeRequest){select.close();throw new Error('process loss after bootstrap fence before producer intent');}
      return bootstrap(input);
    };
    return {select,lease,log,recoverCalls:()=>recoverCalls,bootstrapCalls:()=>bootstrapCalls};
  }
  const close=async value=>{
    if(!value.select.status().closed)await value.select.shutdown();await value.lease.release();
  };
  const replacement=async()=>{
    const end=Date.now()+10000;
    for(;;){try{return await open();}catch(error){
      if(!/execution ownership is unavailable/.test(error.message)||Date.now()>=end)throw error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }}
  };
  const first=await open(!pause);let result,receipt;
  try{
    const driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first.select,...policy});
    driver.startAutomaticHistory({journal:history,acknowledge,executionClock:createSelectedOrchestrationExecutionClock()});
    result=await driver.run(pause?{stopAt:{phase:'bootstrap-ready',coordinatorSelections:1}}:{});
    assert.equal(result.status,pause?'paused':'failed',JSON.stringify(result.failure));
    assert.equal(result.coordinatorAttempts.at(-1)?.status,pause||stage==='bootstrap'?'committed':'acknowledgement-unknown',
      JSON.stringify({failure:result.failure,transport:first.select.status()}));
    receipt=first.select.durableRequestReceipt();assert(receipt);
  }finally{await close(first);}
  const entries=await history.readLatest(head),tail=entries.at(-1),createReceipt=(await requests.inspect(1)).receipt;
  if(pause){assert.equal(tail.pending,undefined);assert.equal(tail.checkpoint.continuation.phase,'bootstrap-ready');}
  else{
    assert.equal(tail.pending?.kind,stage==='create'?'coordinator-selection':'child-bootstrap');
    assert(tail.pending.clockReceipt);
    assert.equal(tail.pending.requestBoundary.ordinal,beforeRequest?receipt.ordinal+1:receipt.ordinal);
  }
  return {history,requests,initialPublic,policy,tail,receipt,createReceipt,stage,acknowledge,close,replacement,
    head:()=>copy(head),original:result,firstLog:first.log};
}
const decoderLines=path=>readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));
const options=(c,fresh,overrides={})=>({historyJournal:c.history,historyReceipt:c.head(),initialPublic:c.initialPublic,
  select:fresh.select,policy:c.policy,acknowledge:c.acknowledge,executionClock:createSelectedOrchestrationExecutionClock(),
  ...(c.stage==='create'?{commitRecovery:{receipt:copy(c.receipt)}}:{bootstrapRecovery:{receipt:copy(c.receipt)}}),...overrides});
function assertNoNativeOrHostWork(peer){
  assert.equal(peer.recoverCalls(),0);assert.equal(peer.bootstrapCalls(),0);
  assert.equal(peer.select.metrics().runtime.rpcCalls,0);assert.equal(peer.select.metrics().predictionAttempts,0);
  assert.equal(existsSync(peer.log)?readFileSync(peer.log,'utf8'):'','');
}

for(const stage of ['create','bootstrap'])test('actual lost '+stage+' reply seals the exact intermediate cut and survives another process loss',{skip},async t=>{
  const c=await setup(t,{stage});let fresh=await c.replacement();
  try{
    const before=copy(c.tail.checkpoint),origin=copy(c.tail.pending.clockReceipt);
    let restored=await RegionSelectedOrchestrationDriver.restoreLatest(before,options(c,fresh)),
      sealed=(await c.history.readLatest(c.head())).at(-1);
    assert.equal(sealed.pending,undefined);
    assert.equal(sealed.checkpoint.continuation.phase,stage==='create'?'bootstrap-ready':'coordinator-ready');
    assert.equal(sealed.checkpoint.coordinatorAttempts.length,1);
    assert.deepEqual(sealed.checkpoint.bridge,before.bridge);assert.deepEqual(sealed.checkpoint.childAttempts,[]);
    assert.deepEqual(sealed.checkpoint.continuation.clockReceipt,origin);
    assert.equal(fresh.bootstrapCalls(),0);assert.equal(fresh.recoverCalls(),1);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.firstLog));
    await c.close(fresh);fresh=await c.replacement();
    restored=await RegionSelectedOrchestrationDriver.restoreLatest(sealed.checkpoint,options(c,fresh));
    const repeated=(await c.history.readLatest(c.head())).at(-1).checkpoint;
    assert.deepEqual(repeated.coordinatorAttempts,sealed.checkpoint.coordinatorAttempts);
    assert.deepEqual(repeated.native.native,sealed.checkpoint.native.native);
    assert.deepEqual(repeated.continuation.clockReceipt,origin);
    assert(repeated.continuation.elapsedMs>sealed.checkpoint.continuation.elapsedMs);
    assert(repeated.native.runtimeMetrics.rpcCalls>sealed.checkpoint.native.runtimeMetrics.rpcCalls);
    assert(repeated.native.runtimeMetrics.computeSeconds>=sealed.checkpoint.native.runtimeMetrics.computeSeconds);
    assert.equal(fresh.bootstrapCalls(),0);assert.deepEqual(decoderLines(fresh.log),decoderLines(c.firstLog));
    const result=await restored.run();assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.publicCompleted,true);assert.equal(result.coordinatorAttempts.length,4);
    assert.equal(result.childAttempts.length,2);assert.equal(fresh.select.metrics().predictionAttempts,6);
    assert.equal(fresh.select.metrics().semanticallyAccepted,6);
    assert.equal(fresh.bootstrapCalls(),stage==='create'?1:0);
    assert.equal((await c.history.readLatest(c.head())).at(-1).terminal.phase,'completed');
  }finally{await c.close(fresh);}
});

test('process loss at the acknowledged create cut returns bootstrap-ready before any child initialization',{skip},async t=>{
  const c=await setup(t,{stage:'create',pause:true}),fresh=await c.replacement();
  try{
    assert.equal((await c.requests.list()).length,1);
    const restored=await RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh));
    assert.equal(restored.continuation.phase,'bootstrap-ready');assert.equal(fresh.bootstrapCalls(),0);
    assert.deepEqual(restored.continuation.clockReceipt,c.tail.checkpoint.continuation.clockReceipt);
    const result=await restored.run();assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(fresh.bootstrapCalls(),1);assert.equal(result.coordinatorAttempts.length,4);
  }finally{await c.close(fresh);}
});

for(const stage of ['create','bootstrap'])test('unknown '+stage+' outcome cannot authorize recovery or fall back past pending bootstrap',{skip},async t=>{
  const c=await setup(t,{stage,fault:'before-native-intent'}),head=c.head(),fresh=await c.replacement();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh)),/never admitted/);
    assert.deepEqual(c.head(),head);assert.equal(fresh.bootstrapCalls(),0);
    assert.equal(fresh.select.metrics().predictionAttempts,0);assert.deepEqual(decoderLines(fresh.log),[]);
  }finally{await c.close(fresh);}
  if(stage==='bootstrap'){
    const third=await c.replacement();
    try{
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,third,{
        bootstrapRecovery:null,commitRecovery:{receipt:c.createReceipt}})),/clock-bound coordinator fence/);
      assertNoNativeOrHostWork(third);
    }finally{await c.close(third);}
  }
});

test('a published bootstrap fence before producer intent prevents stale-create fallback and guessed replay',{skip},async t=>{
  const c=await setup(t,{stage:'bootstrap',beforeRequest:true}),fresh=await c.replacement();
  try{
    assert.equal((await c.requests.list()).length,1);
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh)),/retained request scope/);
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh,{
      bootstrapRecovery:null,commitRecovery:{receipt:c.createReceipt}})),/clock-bound coordinator fence/);
    const earlier=(await c.history.readLatest(c.head())).find(row=>
      row.checkpoint.continuation.phase==='bootstrap-ready'&&!row.pending);
    const oldReceipt={schema:'semantic-selected-history-receipt/8',streamId:c.head().streamId,
      position:earlier.position,id:'f'.repeat(64),bytes:1};
    // The actual acknowledged earlier head comes from its successor's previous link.
    const successor=(await c.history.readLatest(c.head())).find(row=>row.position===earlier.position+1);
    Object.assign(oldReceipt,successor.previous);
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(earlier.checkpoint,options(c,fresh,{
      historyReceipt:oldReceipt,bootstrapRecovery:null,commitRecovery:{receipt:c.createReceipt}})),/latest|later/);
    assertNoNativeOrHostWork(fresh);
  }finally{await c.close(fresh);}
});

test('bootstrap recovery refuses changed owner scope, absent clock or mixed recovery authority before native RPC',{skip},async t=>{
  const c=await setup(t),fresh=await c.replacement();
  try{
    for(const key of ['ordinal','sessionId','streamId','sessionGeneration']){
      const receipt=copy(c.receipt);receipt[key]=typeof receipt[key]==='string'?'another-owner':receipt[key]+1;
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh,{
        bootstrapRecovery:{receipt}})),/retained request scope/);
    }
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh,{
      executionClock:{}})),/original live clock/);
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh,{
      commitRecovery:{receipt:c.createReceipt}})),/distinct exact native boundaries/);
    assertNoNativeOrHostWork(fresh);
  }finally{await c.close(fresh);}
});

test('lost reconstructed-bootstrap head acknowledgement leaves the old history fenced without runnable host work',{skip},async t=>{
  const c=await setup(t),fresh=await c.replacement(),head=c.head();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh,{
      acknowledge:async()=>{throw new Error('lost bootstrap recovered-head acknowledgement');}
    })),/lost bootstrap recovered-head acknowledgement/);
    assert.deepEqual(c.head(),head);assert.equal(fresh.select.status().closed,true);assert.equal(fresh.bootstrapCalls(),0);
  }finally{await c.close(fresh);}
  const third=await c.replacement();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,third)),/latest|later|head/);
    assertNoNativeOrHostWork(third);
  }finally{await c.close(third);}
});

test('bootstrap replacement cannot refund an actually expired original creation clock',{skip},async t=>{
  const c=await setup(t,{timeoutMs:30000}),clock=createSelectedOrchestrationExecutionClock(),
    used=await clock.elapsed(c.tail.pending.clockReceipt,{timeoutMs:c.policy.timeoutMs});
  await new Promise(resolve=>setTimeout(resolve,c.policy.timeoutMs-used+30));
  const fresh=await c.replacement();
  try{
    await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(c.tail.checkpoint,options(c,fresh)),/deadline has expired/);
    assertNoNativeOrHostWork(fresh);
  }finally{await c.close(fresh);}
});
