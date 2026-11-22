// Actual paired Python recovery. Only final lexical decoder output is supplied;
// the production native engine owns all selections, commits and restored state.
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

const repository=dirname(dirname(fileURLToPath(import.meta.url)));
const configured=Object.hasOwn(process.env,'MEGATOKEN_ROOT');
const nativeRoot=resolve(process.env.MEGATOKEN_ROOT??join(repository,'../megatoken'));
const python=process.env.MEGATOKEN_PYTHON??'python3';
const peer=join(nativeRoot,'tests/fixtures/serve_semantic_v8_recovery_fixture.py');
const faultPeer=join(repository,'test/fixtures/semantic-v8-durable-commit-peer.py');
const env={...process.env,PYTHONPATH:[join(nativeRoot,'src'),nativeRoot,process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
let described;

async function inputs(t){
  if(!existsSync(join(nativeRoot,'src/megatoken/semantic_commit_recovery_v8.py'))){
    if(configured)assert.fail('Configured native checkout lacks the durable commit implementation');
    t.skip('paired native durable commit checkout unavailable');return null;
  }
  if(!described)described=spawnSync(python,[peer,'--describe'],{cwd:nativeRoot,env,encoding:'utf8',timeout:120000});
  if(described.status!==0&&!configured){t.skip('paired native runtime unavailable');return null;}
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout);
  const document=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    join(nativeRoot,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64'),'utf8'),'base64')));
  const initialPublic={...structuredClone(document.public),timeline:structuredClone(document.public.timeline.slice(0,2))};
  const directory=await mkdtemp(join(tmpdir(),'native-durable-paired-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const sessionId=initialPublic.timeline[0].fields.session,streamId='commit-history';
  const journal=new DurableNativeV8RequestJournal({directory,sessionId,streamId});
  const lock=new DurableSelectedOrchestrationExecutionLock({directory,sessionId,streamId,
    flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'});
  let count=0;
  async function open(fault=null,action=null){
    const executionLease=await lock.acquire(),log=join(directory,'decoder-'+(++count)+'.log');
    const args=fault?[faultPeer,'--peer',peer,'--fault',fault]:[peer];
    if(fault&&action)args.push('--fault-action',action);
    args.push('--decoder-log',log,'--request-journal-dir',journal.directory,'--execution-lock-fd','3',
      '--execution-lock-path',executionLease.lockPath,'--execution-session-id',sessionId,'--execution-stream-id',streamId,
      '--execution-session-generation',String(journal.sessionGeneration));
    const select=createNativeV8ProcessSelector({command:python,args,cwd:nativeRoot,env,timeoutMs:120000,
      maxMessageBytes:64*1024*1024,durableRequests:{journal,executionLease}});
    return {select,lease:executionLease,log};
  }
  async function choose(select){
    await select.initialize(identity);
    const state=await select.openOrchestration({session:sessionId,public:initialPublic,maxActive:1,childBudget:64});
    const output=await select.selectOrchestration({session:sessionId,track:state.track});
    return {session:sessionId,track:state.track,...output};
  }
  return {identity,journal,lock,open,choose,directory};
}
async function close({select,lease}){
  if(!select.status().closed)await select.shutdown();
  await lease.release();
}
async function replacement(context){
  // A dead transport does not imply its process has closed its inherited fd.
  // Kernel acquisition is the authority; retry only the local ownership probe.
  const deadline=Date.now()+10000;
  for(;;){try{return await context.open();}catch(error){
    if(!/execution ownership is unavailable/.test(error.message)||Date.now()>=deadline)throw error;
    await new Promise(resolve=>setTimeout(resolve,20));
  }}
}

test('actual Python commit acknowledgement restores exact whole native state and original fragments',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open();let before,original,receipt;
  try{
    const request=await context.choose(first.select);
    original=await first.select.commitOrchestration(request);
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,1);
    before=await first.select.checkpoint();
    assert.equal(first.select.metrics().semanticallyAccepted,1);
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    await assert.rejects(fresh.select.initialize(context.identity),/existing durable requests/);
    await assert.rejects(fresh.select.restore({checkpoint:before}),/explicit commit recovery/);
    const restored=await fresh.select.recoverCommit({receipt});
    assert.deepEqual(restored.result,original);
    assert.equal(restored.hostDispatches,0);assert.equal(restored.hostRecoveryAuthorized,false);
    const after=await fresh.select.checkpoint();
    assert.deepEqual(after.native,before.native);
    assert.deepEqual(after.attempts[0].selection,before.attempts[0].selection);
    assert.equal(fresh.select.metrics().semanticallyAccepted,1);
    assert.equal(fresh.select.metrics().predictionAttempts,1);
    const emitted=path=>readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));
    assert.deepEqual(emitted(fresh.log),emitted(first.log));
  }finally{await close(fresh);}
});

test('actual Python lost reply after durable outcome preserves unknown status then recovers exact acknowledgement',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open('after-native-outcome');let receipt,request;
  try{
    request=await context.choose(first.select);
    await assert.rejects(first.select.commitOrchestration(request),error=>{
      assert.equal(error.acknowledgementUnknown,true);return true;});
    assert.equal(first.select.metrics().unknownAcknowledgements,1);
    receipt=first.select.durableRequestReceipt();
    assert.equal((await context.journal.inspect(1)).receipt.digest,receipt.digest);
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    const restored=await fresh.select.recoverCommit({receipt});
    assert.equal(restored.result.committed,true);
    assert.deepEqual(restored.request.selection,request.selection);
    assert.equal(fresh.select.metrics().unknownAcknowledgements,0);
    assert.equal(fresh.select.metrics().semanticallyAccepted,1);
    assert.equal(restored.hostDispatches,0);
  }finally{await close(fresh);}
});

test('actual Python missing native intent cannot turn a saved producer request into a retry',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open('before-native-intent');let receipt;
  try{
    await assert.rejects(first.select.commitOrchestration(await context.choose(first.select)));
    receipt=first.select.durableRequestReceipt();assert(receipt);
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    await assert.rejects(fresh.select.recoverCommit({receipt}),/never admitted/);
    assert.equal(fresh.select.status().closed,true);
    assert.equal(fresh.select.metrics().semanticallyAccepted,0);
    assert.equal(readFileSync(fresh.log,'utf8'),'','no replay or new model selection is allowed');
  }finally{await close(fresh);}
});

test('actual Python altered durable reply cannot be accepted while its independently retained result can be recovered',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open('alter-reply');let receipt;
  try{
    await assert.rejects(first.select.commitOrchestration(await context.choose(first.select)),/request authority/);
    assert.equal(first.select.metrics().unknownAcknowledgements,1);
    receipt=first.select.durableRequestReceipt();
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{assert.equal((await fresh.select.recoverCommit({receipt})).result.committed,true);}
  finally{await close(fresh);}
});

test('actual Python later child bootstrap fences recovery of the earlier native commit',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open();let receipt;
  try{
    const request=await context.choose(first.select),committed=await first.select.commitOrchestration(request);
    receipt=first.select.durableRequestReceipt();
    await first.select.bootstrapOrchestrationChild({session:request.session,track:request.track,
      childTrack:committed.track.address});
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    await assert.rejects(fresh.select.recoverCommit({receipt}),/supersed|later native|later request/);
    assert.equal(fresh.select.metrics().semanticallyAccepted,0);
    assert.equal(readFileSync(fresh.log,'utf8'),'','stale poststate must refuse before decoder replay');
  }finally{await close(fresh);}
});

for(const fault of [null,'after-native-outcome','alter-reply'])
test('actual Python bootstrap has an independent durable outcome: '+String(fault),async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open(fault,'bootstrap-orchestration-child');let receipt,original,checkpoint;
  try{
    const request=await context.choose(first.select),committed=await first.select.commitOrchestration(request);
    const bootstrap=()=>first.select.bootstrapOrchestrationChild({session:request.session,track:request.track,
      childTrack:committed.track.address});
    if(fault)await assert.rejects(bootstrap(),error=>{assert.equal(error.acknowledgementUnknown,true);return true;});
    else{original=await bootstrap();checkpoint=await first.select.checkpoint();}
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,2);
    assert.equal(first.select.metrics().predictionAttempts,1);
    assert.equal((await context.journal.inspect(2)).intent.identity.operation,'bootstrap-orchestration-child');
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    const recovered=await fresh.select.recoverBootstrap({receipt});
    assert.equal(recovered.result.bootstrapped,true);assert.equal(recovered.result.track.bootstrap_ready,true);
    assert.equal(recovered.hostDispatches,0);assert.equal(recovered.hostRecoveryAuthorized,false);
    const after=await fresh.select.checkpoint();
    assert.equal(after.native.attempts.length,1);assert.equal(after.attempts.length,1);
    assert.equal(after.native.sessions[recovered.request.session].orchestration.operations
      .filter(row=>row.kind==='bootstrap').length,1);
    if(original){assert.deepEqual(recovered.result,original);assert.deepEqual(after.native,checkpoint.native);}
    assert.equal(fresh.select.metrics().predictionAttempts,1);
    const emitted=path=>readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('ORCH_DECODER '));
    assert.deepEqual(emitted(fresh.log),emitted(first.log));
  }finally{await close(fresh);}
});

test('missing native bootstrap outcome never authorizes replay or retry',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open('before-native-intent','bootstrap-orchestration-child');let receipt;
  try{
    const request=await context.choose(first.select),committed=await first.select.commitOrchestration(request);
    await assert.rejects(first.select.bootstrapOrchestrationChild({session:request.session,track:request.track,
      childTrack:committed.track.address}));
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,2);
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    await assert.rejects(fresh.select.recoverBootstrap({receipt}),/never admitted/);
    assert.equal(fresh.select.metrics().predictionAttempts,0);
    assert.equal(readFileSync(fresh.log,'utf8'),'');
  }finally{await close(fresh);}
});

test('durable publication serializes the complete request interval before native dispatch',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open();let entered,release;
  const staged=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const append=context.journal.append.bind(context.journal);
  context.journal.append=async input=>{entered();await gate;return append(input);};
  try{
    const request=await context.choose(first.select),commit=first.select.commitOrchestration(request);
    await staged;
    await assert.rejects(first.select.checkpoint(),/outstanding request/);
    await assert.rejects(first.select.initialize(context.identity),/request is outstanding/);
    await assert.rejects(first.select.cancel({session:request.session,reason:'racing cancellation'}),/request is outstanding/);
    await assert.rejects(first.select.commitOrchestration(request),/request is outstanding/);
    request.record='changed while storage waits';
    release();assert.equal((await commit).committed,true);
    assert.equal(first.select.metrics().semanticallyAccepted,1);
  }finally{release();await close(first);}
});

test('one kernel lease can start only one native process and cannot be forged or reused after close',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'native-single-owner-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableNativeV8RequestJournal({directory,sessionId:'session-a',streamId:'stream-a'});
  const lock=new DurableSelectedOrchestrationExecutionLock({directory,sessionId:'session-a',streamId:'stream-a',
    flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'}),lease=await lock.acquire();
  const start=executionLease=>createNativeV8ProcessSelector({command:process.execPath,
    args:['-e','process.stdin.resume()'],durableRequests:{journal,executionLease}});
  let first;
  try{
    assert.throws(()=>start({...lease}),/original kernel/);
    first=start(lease);assert.throws(()=>start(lease),/already belongs to a native child/);
    await first.shutdown();assert.throws(()=>start(lease),/already belongs to a native child/);
  }finally{first?.close();await lease.release();}
  const next=await lock.acquire(),second=start(next);
  try{await second.shutdown();}finally{second.close();await next.release();}
});
