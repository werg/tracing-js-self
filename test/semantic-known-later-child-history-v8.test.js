// Controlled decoder bytes exercise the real native adapter and durable stores.
// A completed earlier child is retained while a later create/startup is recovered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readlinkSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
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
import {laterSiblingBootstrapFixture} from './helpers/native-bootstrap-fixture-v8.js';

const copy=structuredClone,root=dirname(dirname(fileURLToPath(import.meta.url))),
  nativeRoot=resolve(process.env.MEGATOKEN_ROOT??join(root,'../megatoken')),
  python=process.env.MEGATOKEN_PYTHON??'python3',
  peer=join(nativeRoot,'tests/fixtures/serve_semantic_v8_recovery_fixture.py'),
  faultPeer=join(root,'test/fixtures/semantic-v8-durable-commit-peer.py'),
  env={...process.env,PYTHONPATH:[join(nativeRoot,'src'),nativeRoot,process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
const paired=Object.hasOwn(process.env,'MEGATOKEN_ROOT')&&existsSync(peer);
let namespaceAvailable=false,description;
try{namespaceAvailable=/^time:\[[1-9][0-9]*\]$/.test(readlinkSync('/proc/self/ns/time'));}catch{}
const skip=!paired?'An explicitly paired native runtime is required':
  namespaceAvailable?false:'Linux time namespace identity is unavailable; hosted recovery gate is mandatory';
if(process.env.REQUIRE_KNOWN_COMMIT_RECOVERY==='1'){
  assert(paired,'Mandatory later-child recovery requires the exact native peer');
  assert(namespaceAvailable,'Mandatory later-child recovery requires actual Linux time namespace identity');
}

async function setup(t,stage=null){
  description??=spawnSync(python,[peer,'--describe'],{cwd:nativeRoot,env,encoding:'utf8',timeout:120000});
  assert.equal(description.status,0,description.stderr);
  const identity=JSON.parse(description.stdout),document=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64'),'utf8'),'base64'))),
    expanded=laterSiblingBootstrapFixture(document),initialPublic=expanded.initialPublic,
    policy={...identity,maxActive:1,childBudget:64,maxCoordinatorSelections:16,maxPredictions:32,
      maxGenerated:64,maxOutstanding:64,maxStaleRetries:2,timeoutMs:300000,automaticDelivery:false},
    directory=await mkdtemp(join(tmpdir(),'later-child-history-')),
    sessionId=initialPublic.timeline[0].fields.session,streamId='later-child-history',
    requests=new DurableNativeV8RequestJournal({directory:join(directory,'requests'),sessionId,streamId}),
    lock=new DurableSelectedOrchestrationExecutionLock({directory:join(directory,'owner'),sessionId,streamId,
      flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'}),
    history=new DurableSelectedHistoryJournal({directory:join(directory,'history'),streamId:'selected-history'}),
    records=join(directory,'lexical-records.json');
  await writeFile(records,JSON.stringify(expanded.records),{mode:0o600});
  const opened=new Set();let head=null,count=0;
  t.after(async()=>{for(const item of [...opened])await close(item).catch(()=>{});
    await rm(directory,{recursive:true,force:true});});
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head);head=copy(receipt);return copy(receipt);
  };
  async function open(inject=false){
    const lease=await lock.acquire(),log=join(directory,'decoder-'+(++count)+'.log'),
      args=[faultPeer,'--peer',peer,'--fixture-records',records,
        ...(inject?['--fault','after-native-outcome','--fault-action',
          stage==='create'?'track_create':'bootstrap-orchestration-child',
          '--fault-request-ordinal',String(stage==='create'?expanded.createOrdinal:expanded.bootstrapOrdinal)]:[])];
    args.push('--decoder-log',log,'--request-journal-dir',requests.directory,'--execution-lock-fd','3',
      '--execution-lock-path',lease.lockPath,'--execution-session-id',sessionId,'--execution-stream-id',streamId,
      '--execution-session-generation',String(requests.sessionGeneration));
    const select=createNativeV8ProcessSelector({command:python,args,cwd:nativeRoot,env,timeoutMs:120000,
      maxMessageBytes:64*1024*1024,durableRequests:{journal:requests,executionLease:lease}});
    let bootstrapCalls=0;const bootstrap=select.bootstrapOrchestrationChild;
    select.bootstrapOrchestrationChild=(...values)=>{bootstrapCalls++;return bootstrap(...values);};
    const item={select,lease,log,bootstrapCalls:()=>bootstrapCalls,released:false};opened.add(item);return item;
  }
  async function close(item){
    if(item.released)return;
    try{if(!item.select.status().closed)await item.select.shutdown();}
    finally{await item.lease.release();item.released=true;opened.delete(item);}
  }
  const replacement=async()=>{
    const deadline=Date.now()+10000;
    for(;;){try{return await open();}catch(error){
      if(!/execution ownership is unavailable/.test(error.message)||Date.now()>=deadline)throw error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }}
  };
  const first=await open(stage!==null),driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first.select,...policy});
  driver.startAutomaticHistory({journal:history,acknowledge,
    executionClock:stage===null?null:createSelectedOrchestrationExecutionClock()});
  const result=await driver.run(),receipt=first.select.durableRequestReceipt();
  assert.equal(result.status,stage===null?'completed':'failed',JSON.stringify(result.failure));
  await close(first);
  const tail=(await history.readLatest(head)).at(-1);
  if(stage!==null){
    assert.equal(tail.pending.kind,stage==='create'?'coordinator-selection':'child-bootstrap');
    assert.equal(receipt.ordinal,stage==='create'?expanded.createOrdinal:expanded.bootstrapOrdinal);
  }
  return {history,requests,initialPublic,policy,acknowledge,close,replacement,result,receipt,tail,
    head:()=>copy(head),firstLog:first.log,stage};
}
const decoderLines=path=>readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));
const options=(context,fresh)=>({historyJournal:context.history,historyReceipt:context.head(),
  initialPublic:context.initialPublic,select:fresh.select,policy:context.policy,acknowledge:context.acknowledge,
  executionClock:createSelectedOrchestrationExecutionClock(),
  [context.stage==='create'?'commitRecovery':'bootstrapRecovery']:{receipt:copy(context.receipt)}});

test('two actual declared children complete without a live-clock qualification claim',{skip:paired?false:'An explicitly paired native runtime is required'},async t=>{
  const c=await setup(t);
  assert.equal(c.result.publicCompleted,true);
  assert.equal(c.result.coordinatorAttempts.length,7);assert.equal(c.result.childAttempts.length,4);
  assert.equal(c.result.finalState.children.length,2);
  assert(c.result.finalState.children.every(child=>child.completion?.completion?.kind==='return'));
  assert.equal(c.result.finalState.published.length,2);
  assert.equal((await c.requests.list()).length,13);
  assert.equal(c.tail.terminal.phase,'completed');
});

for(const stage of ['create','bootstrap'])
test('later child '+stage+' recovery preserves completed work through repeated process loss',{skip},async t=>{
  const c=await setup(t,stage),before=copy(c.tail.checkpoint),oldChild=copy(before.state.children[0]),
    oldTrack=copy(before.state.tracks.find(row=>row.address===oldChild.track)),origin=copy(c.tail.pending.clockReceipt);
  assert.equal(before.childAttempts.length,2);assert.equal(before.contexts.length,2);
  assert(oldChild.completion);assert.equal(oldTrack.status,'completed');
  assert.equal(before.state.published.length,1);
  assert.equal(before.coordinatorAttempts.length,stage==='create'?3:4);
  let fresh=await c.replacement();
  try{
    await RegionSelectedOrchestrationDriver.restoreLatest(before,options(c,fresh));
    const sealed=(await c.history.readLatest(c.head())).at(-1).checkpoint;
    assert.equal(fresh.bootstrapCalls(),0);assert.equal(fresh.select.metrics().predictionAttempts,6);
    assert.equal(sealed.coordinatorAttempts.length,4);assert.equal(sealed.native.attempts.length,6);
    for(const key of ['bridge','contexts','childAttempts','childRejections'])assert.deepEqual(sealed[key],before[key]);
    assert.deepEqual(sealed.coordinatorAttempts.slice(0,3),before.coordinatorAttempts.slice(0,3));
    assert.deepEqual(sealed.native.attempts.slice(0,5),before.native.attempts.slice(0,5));
    assert.deepEqual(sealed.state.children[0],oldChild);
    assert.deepEqual(sealed.state.tracks.find(row=>row.address===oldChild.track),oldTrack);
    assert.deepEqual(sealed.continuation.clockReceipt,origin);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.firstLog));
    await c.close(fresh);fresh=await c.replacement();
    const restored=await RegionSelectedOrchestrationDriver.restoreLatest(sealed,options(c,fresh)),
      repeated=(await c.history.readLatest(c.head())).at(-1).checkpoint;
    assert.equal(fresh.bootstrapCalls(),0);assert.equal(fresh.select.metrics().predictionAttempts,6);
    for(const key of ['bridge','contexts','coordinatorAttempts','childAttempts','childRejections','state'])
      assert.deepEqual(repeated[key],sealed[key],key+' changed across repeated loss');
    assert.deepEqual(repeated.native.native,sealed.native.native);
    assert.deepEqual(repeated.native.attempts,sealed.native.attempts);
    assert.deepEqual(repeated.continuation.clockReceipt,origin);
    assert(repeated.continuation.elapsedMs>sealed.continuation.elapsedMs);
    for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
      assert(repeated.native.runtimeMetrics[key]>=sealed.native.runtimeMetrics[key]);
    assert.deepEqual(decoderLines(fresh.log),decoderLines(c.firstLog));
    const result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));assert.equal(result.publicCompleted,true);
    assert.equal(result.coordinatorAttempts.length,7);assert.equal(result.childAttempts.length,4);
    assert.equal(fresh.select.metrics().predictionAttempts,11);assert.equal(fresh.select.metrics().semanticallyAccepted,11);
    assert.equal(fresh.bootstrapCalls(),stage==='create'?1:0);
    assert.deepEqual(result.public.timeline.slice(0,before.bridge.public.timeline.length),before.bridge.public.timeline);
    assert.deepEqual(result.finalState.children[0],oldChild);
    assert.equal(result.finalState.children.length,2);assert.equal(result.finalState.published.length,2);
    assert.equal((await c.history.readLatest(c.head())).at(-1).terminal.phase,'completed');
  }finally{await c.close(fresh);}
});
