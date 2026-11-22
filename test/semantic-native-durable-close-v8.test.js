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
  const sessionId=initialPublic.timeline[0].fields.session,streamId='terminal-close-history';
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

async function terminal(context,select){
  const request=await context.choose(select),created=await select.commitOrchestration(request);
  await select.bootstrapOrchestrationChild({session:request.session,track:request.track,
    childTrack:created.track.address});
  const reason='exact settled coordinator close';
  await select.cancelOrchestration({session:request.session,track:request.track,reason});
  return {session:request.session,reason};
}

for(const fault of [null,'after-native-outcome','alter-reply'])
test('actual Python terminal close restores a closed outcome: '+String(fault),async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open(fault,'cancel');let receipt,original,before,closed;
  try{
    const request=await terminal(context,first.select);before=await first.select.checkpoint();
    if(fault)await assert.rejects(first.select.closeTerminal(request),error=>{
      assert.equal(error.acknowledgementUnknown,true);return true;});
    else{original=await first.select.closeTerminal(request);closed=await first.select.checkpoint();}
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,3);
    assert.equal((await context.journal.inspect(3)).intent.identity.operation,'cancel');
    assert.equal(first.select.metrics().predictionAttempts,1);
  }finally{await close(first);}
  const fresh=await replacement(context);let recoveredCheckpoint;
  try{
    const result=await fresh.select.recoverClose({receipt});
    assert.equal(result.schema,'semantic-native-transport-close-recovery/8');
    assert.equal(result.hostDispatches,0);assert.equal(result.hostRecoveryAuthorized,false);
    assert.equal(result.result.closed,true);
    assert.equal(result.result.reason,'exact settled coordinator close');
    recoveredCheckpoint=await fresh.select.checkpoint();
    const model=recoveredCheckpoint.native,session=result.request.session;
    assert.deepEqual(model.sessions,{});
    assert.deepEqual(model.closedSessions[session],before.native.sessions[session]);
    assert.deepEqual(model.attempts,before.native.attempts);
    assert.equal(fresh.select.metrics().predictionAttempts,1);
    if(original){assert.deepEqual(result.result,original);assert.deepEqual(model,closed.native);}
    await assert.rejects(fresh.select.openOrchestration({session,public:before.native.sessions[session].public}),
      /closed|fresh|terminal/);
  }finally{await close(fresh);}
  // Repeated loss reconstructs the same closed state and retains all earlier
  // reconstruction costs. No model selection or session opening is authorized.
  const again=await replacement(context);
  try{
    await again.select.recoverClose({receipt,accountingCheckpoint:recoveredCheckpoint});
    const after=await again.select.checkpoint();
    assert.deepEqual(after.native,recoveredCheckpoint.native);
    assert.equal(after.attempts.length,recoveredCheckpoint.attempts.length);
    for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
      assert(after.runtimeMetrics[key]>=recoveredCheckpoint.runtimeMetrics[key]);
  }finally{await close(again);}
});

test('a producer close intent without a native outcome cannot close or restore the session',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open('before-native-intent','cancel');let receipt;
  try{
    const request=await terminal(context,first.select);
    await assert.rejects(first.select.closeTerminal(request));
    receipt=first.select.durableRequestReceipt();assert.equal(receipt.ordinal,3);
  }finally{await close(first);}
  const fresh=await replacement(context);
  try{
    await assert.rejects(fresh.select.recoverClose({receipt}),/never admitted/);
    assert.equal(fresh.select.metrics().predictionAttempts,0);
    assert.equal(fresh.select.status().closed,true);
    assert.equal(existsSync(fresh.log)?readFileSync(fresh.log,'utf8'):'','');
  }finally{await close(fresh);}
});

test('active work cannot be reclassified as a recoverable terminal close',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open();
  try{
    const request=await context.choose(first.select);
    await first.select.commitOrchestration(request);
    await assert.rejects(first.select.closeTerminal({session:request.session,reason:'too early'}),/terminal coordinator/);
    assert.equal((await context.journal.list()).length,1);
    assert.equal(first.select.status().closed,true);
  }finally{await close(first);}
});

for(const altered of ['boundary','checkpoint'])
test('terminal close refuses changed acknowledged '+altered+' before native dispatch',async t=>{
  const context=await inputs(t);if(!context)return;
  const first=await context.open();
  try{
    const request=await terminal(context,first.select),checkpoint=await first.select.checkpoint(),
      boundary=first.select.durableRequestBoundary(),before=first.select.metrics().runtime.rpcCalls;
    const expectedBoundary=structuredClone(boundary);
    if(altered==='boundary')expectedBoundary.ordinal++;
    await assert.rejects(first.select.closeTerminal({...request,expectedBoundary,
      expectedCheckpointDigest:altered==='checkpoint'?'f'.repeat(64):checkpoint.native.digest}),
    /changed after application acknowledgement/);
    assert.equal((await context.journal.list()).length,2,'no close intent may be appended for the changed authority');
    assert.equal(first.select.metrics().runtime.rpcCalls,before+(altered==='checkpoint'?1:0),
      'only the checkpoint comparison read may run before refusal');
    assert.equal(first.select.status().closed,true);
  }finally{await close(first);}
});
