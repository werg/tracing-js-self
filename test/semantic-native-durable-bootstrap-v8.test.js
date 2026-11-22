// Actual paired native state and recovery; only final lexical decoder bytes are
// fixture-controlled. Bootstrap has no model choice of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {DurableNativeV8RequestJournal} from '../src/storage/native-request-journal-v8.js';
import {DurableSelectedOrchestrationExecutionLock} from '../src/storage/selected-orchestration-execution-lock.js';

const repository=dirname(dirname(fileURLToPath(import.meta.url))),
  configured=Object.hasOwn(process.env,'MEGATOKEN_ROOT'),
  required=process.env.REQUIRE_DURABLE_BOOTSTRAP_RECOVERY==='1',
  nativeRoot=resolve(process.env.MEGATOKEN_ROOT??join(repository,'../megatoken')),
  python=process.env.MEGATOKEN_PYTHON??'python3',
  peer=join(nativeRoot,'tests/fixtures/serve_semantic_v8_recovery_fixture.py'),
  faultPeer=join(repository,'test/fixtures/semantic-v8-durable-commit-peer.py'),
  env={...process.env,PYTHONPATH:[join(nativeRoot,'src'),nativeRoot,process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
let described;

async function inputs(t){
  if(!existsSync(peer)){
    if(configured||required)assert.fail('Required paired native bootstrap recovery fixture is absent');
    t.skip('paired native bootstrap runtime unavailable');return null;
  }
  described??=spawnSync(python,[peer,'--describe'],{cwd:nativeRoot,env,encoding:'utf8',timeout:120000});
  if(described.status!==0&&!configured&&!required){t.skip('paired native runtime unavailable');return null;}
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout),document=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64'),'utf8'),'base64'))),
    initialPublic={...structuredClone(document.public),timeline:structuredClone(document.public.timeline.slice(0,2))},
    directory=await mkdtemp(join(tmpdir(),'native-bootstrap-paired-')),
    sessionId=initialPublic.timeline[0].fields.session,streamId='bootstrap-history',
    journal=new DurableNativeV8RequestJournal({directory,sessionId,streamId}),
    lock=new DurableSelectedOrchestrationExecutionLock({directory,sessionId,streamId,
      flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'});
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let count=0;
  async function open(fault=null){
    const lease=await lock.acquire(),log=join(directory,'decoder-'+(++count)+'.log'),wireLog=join(directory,'wire-'+count+'.jsonl'),
      args=fault?[faultPeer,'--peer',peer,'--fault',fault,'--fault-operation','durable-bootstrap-child','--rpc-log',wireLog]:[peer];
    args.push('--decoder-log',log,'--request-journal-dir',journal.directory,'--execution-lock-fd','3',
      '--execution-lock-path',lease.lockPath,'--execution-session-id',sessionId,'--execution-stream-id',streamId,
      '--execution-session-generation',String(journal.sessionGeneration));
    const select=createNativeV8ProcessSelector({command:python,args,cwd:nativeRoot,env,timeoutMs:120000,
      maxMessageBytes:64*1024*1024,durableRequests:{journal,executionLease:lease}});
    return {select,lease,log,wireLog};
  }
  async function create(select){
    await select.initialize(identity);
    const state=await select.openOrchestration({session:sessionId,public:initialPublic,maxActive:1,childBudget:64}),
      output=await select.selectOrchestration({session:sessionId,track:state.track}),
      receipt=await select.commitOrchestration({session:sessionId,track:state.track,...output});
    assert.equal(JSON.parse(output.record).name,'track_create');
    return {session:sessionId,track:state.track,childTrack:receipt.track.address};
  }
  return {identity,journal,open,create};
}
async function close({select,lease}){
  if(!select.status().closed)await select.shutdown();
  await lease.release();
}
async function replacement(context){
  const deadline=Date.now()+10000;
  for(;;){try{return await context.open();}catch(error){
    if(!/execution ownership is unavailable/.test(error.message)||Date.now()>=deadline)throw error;
    await new Promise(resolve=>setTimeout(resolve,20));
  }}
}
const decoderLog=path=>(existsSync(path)?readFileSync(path,'utf8'):'').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));

test('actual native bootstrap preserves the accepted create and supports a second process loss without another selection',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open();let before,receipt,createReceipt,original;
  try{
    const request=await context.create(first.select);
    createReceipt=first.select.durableRequestReceipt();
    const created=await first.select.checkpoint();
    original=await first.select.bootstrapOrchestrationChild(request);
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,createReceipt.ordinal+1);
    before=await first.select.checkpoint();
    assert.equal(before.attempts.length,1);
    assert.deepEqual(before.native.attempts,created.native.attempts);
    assert.deepEqual(before.native.randomState,created.native.randomState);
    assert.deepEqual(before.attempts[0].durableRequestReceipt,createReceipt);
    assert.deepEqual(before.attempts[0].durableBootstrap.receipt,receipt);
    assert.deepEqual(before.attempts[0].durableBootstrap.result,original);
    assert.equal((await context.journal.read(receipt,{latest:true})).schema,'semantic-native-producer-bootstrap-request/8');
  }finally{await close(first);}
  for(let loss=0;loss<2;loss++){
    const fresh=await replacement(context);
    try{
      const result=await fresh.select.recoverBootstrapChild({receipt,accountingCheckpoint:before});
      assert.equal(result.hostDispatches,0);assert.equal(result.hostRecoveryAuthorized,false);
      assert.deepEqual(result.result,original);assert.deepEqual(result.createReceipt,createReceipt);
      const after=await fresh.select.checkpoint();
      assert.deepEqual(after.native,before.native);assert.deepEqual(after.attempts,before.attempts);
      assert(after.runtimeMetrics.rpcCalls>before.runtimeMetrics.rpcCalls);
      assert(after.runtimeMetrics.computeSeconds>=before.runtimeMetrics.computeSeconds);
      assert(after.runtimeMetrics.peakMemoryBytes>=before.runtimeMetrics.peakMemoryBytes);
      assert.equal(fresh.select.metrics().predictionAttempts,1);
      assert.equal(fresh.select.metrics().semanticallyAccepted,1);
      assert.deepEqual(decoderLog(fresh.log),decoderLog(first.log));
      assert.equal(fresh.select.durableRequestBoundary().ordinal,3);
      before=after;
    }finally{await close(fresh);}
  }
});

for(const fault of ['after-native-outcome','alter-reply'])test('actual native bootstrap '+fault+' preserves its known outcome for exact recovery',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open(fault);let receipt,request,createReceipt;
  try{
    request=await context.create(first.select);createReceipt=first.select.durableRequestReceipt();
    await assert.rejects(first.select.bootstrapOrchestrationChild(request));
    assert.equal(first.select.status().closed,true);
    assert.equal(first.select.metrics().predictionAttempts,1);
    assert.equal(first.select.metrics().attempts[0].status,'accepted');
    assert.deepEqual(first.select.metrics().attempts[0].durableRequestReceipt,createReceipt);
    assert.equal(first.select.metrics().attempts[0].durableBootstrap,undefined);
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,2);
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    const recovered=await fresh.select.recoverBootstrapChild({receipt});
    assert.equal(recovered.hostDispatches,0);assert.equal(recovered.result.bootstrapped,true);
    assert.equal(recovered.result.track.address,request.childTrack);
    assert.deepEqual(recovered.createReceipt,createReceipt);
    assert.equal(fresh.select.metrics().semanticallyAccepted,1);
    assert.deepEqual(decoderLog(fresh.log),decoderLog(first.log));
  }finally{await close(fresh);}
});

test('unknown bootstrap refuses replay, stale create recovery and a bootstrap receipt passed to commit recovery',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open('before-native-intent');let receipt,createReceipt;
  try{
    const request=await context.create(first.select);createReceipt=first.select.durableRequestReceipt();
    await assert.rejects(first.select.bootstrapOrchestrationChild(request));
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,2);
  }finally{await close(first);}
  for(const [operation,chosen,pattern,dispatches]of [
    ['recoverBootstrapChild',receipt,/never admitted|unknown/,1],
    ['recoverCommit',createReceipt,/later request/,0],
    ['recoverCommit',receipt,/selected-commit producer request/,0]
  ]){
    const fresh=await replacement(context);
    try{
      await assert.rejects(fresh.select[operation]({receipt:chosen}),pattern);
      assert.equal(fresh.select.metrics().predictionAttempts,0);
      assert.equal(fresh.select.metrics().runtime.rpcCalls,dispatches);
      assert.deepEqual(decoderLog(fresh.log),[]);
    }finally{await close(fresh);}
  }
});

test('durable bootstrap intent is immutable while publication serializes all native operations',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open();let release;
  try{
    const request=await context.create(first.select),original=structuredClone(request);
    let entered;const staged=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),
      append=context.journal.append.bind(context.journal);
    context.journal.append=async input=>{entered();await gate;return append(input);};
    const work=first.select.bootstrapOrchestrationChild(request);await staged;
    request.childTrack='forged-child';
    await assert.rejects(first.select.checkpoint(),/outstanding request/);
    await assert.rejects(first.select.bootstrapOrchestrationChild(original),/outstanding/);
    release();const result=await work;
    assert.equal(result.track.address,original.childTrack);
    assert.equal(first.select.metrics().predictionAttempts,1);
  }finally{release?.();await close(first);}
});

for(const operation of ['commit','bootstrap'])for(const failure of ['publication-acknowledgement','independent-readback'])
  test('actual '+operation+' producer intent '+failure+' ambiguity fences every later native action',async t=>{
    const context=await inputs(t);if(!context)return;
    const first=await context.open('none'),ordinal=operation==='bootstrap'?2:1;
    try{
      let request;
      if(operation==='bootstrap')request=await context.create(first.select);
      const append=context.journal.append.bind(context.journal),read=context.journal.read.bind(context.journal);
      if(failure==='publication-acknowledgement')context.journal.append=async input=>{
        await append(input);throw new Error('ambiguous producer publication acknowledgement');
      };
      else context.journal.read=async(receipt,options)=>{
        const retained=await read(receipt,options);
        if(receipt.ordinal===ordinal&&options?.latest)throw new Error('ambiguous producer independent readback');
        return retained;
      };
      await assert.rejects(operation==='bootstrap'?first.select.bootstrapOrchestrationChild(request):
        context.create(first.select),/ambiguous producer/);
      context.journal.read=read;
      const retained=await context.journal.inspect(ordinal),attempt=first.select.metrics().attempts.at(-1),
        closedAfterFailure=first.select.status().closed,cost=first.select.metrics().runtime.rpcCalls,
        forbidden=operation==='bootstrap'?'durable-bootstrap-child':'durable-commit';
      assert.equal(retained.intent.identity.ordinal,ordinal);
      assert.equal(retained.intent.identity.operation,operation==='bootstrap'?'bootstrap-orchestration-child':'commit-orchestration');
      const wireBefore=readFileSync(first.wireLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(wireBefore.filter(row=>row.op===forbidden).length,0,
        'producer publication/readback must finish before the durable native operation is dispatched');
      let laterMutationSucceeded=false;
      try{
        const result=await first.select.cancelOrchestration({session:attempt.session,track:attempt.track,
          reason:'probe after ambiguous producer storage'});
        laterMutationSucceeded=result.status==='cancelled';
      }catch(error){assert.match(error.message,/closed|attested|fenced|unknown/);}
      assert.equal(closedAfterFailure,true,JSON.stringify({closedAfterFailure,laterMutationSucceeded,
        retainedOrdinal:retained.receipt.ordinal,observedBeforeFailure:wireBefore.map(row=>row.op)}));
      assert.equal(laterMutationSucceeded,false);
      assert.equal(first.select.metrics().runtime.rpcCalls,cost);
      assert.deepEqual(readFileSync(first.wireLog,'utf8').trim().split('\n').map(line=>JSON.parse(line)),wireBefore);
    }finally{await close(first);}
  });
