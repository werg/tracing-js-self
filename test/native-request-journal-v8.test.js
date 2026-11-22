import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink,mkdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableNativeV8RequestJournal,decodeNativeV8RequestFrame} from '../src/storage/native-request-journal-v8.js';
import {DurableSelectedOrchestrationExecutionLock,assertSelectedOrchestrationExecutionLease}
  from '../src/storage/selected-orchestration-execution-lock.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const seal=body=>({...body,digest:hashAlgorithmData(body)});
function intent(ordinal=1){
  const model={schema:'semantic-inference-identity/8',checkpointIdentity:'a'.repeat(64),
    tokenizerIdentity:'b'.repeat(64),trainingIdentity:null,seed:17};
  const selection={selectionId:'v8:0',session:'session-a',status:'awaiting-commit',payloadHex:'00'};
  const native=seal({schema:'semantic-model-checkpoint/8',equivalence:'verified-model-reexecution',
    initialization:model,attempts:[selection],sessions:{'session-a':{unacknowledgedSelection:'v8:0'}}});
  const checkpoint=seal({schema:'semantic-native-transport-checkpoint/8',native,identity:model,
    attempts:[{attempt:0,session:'session-a',selection,record:'algorithm {}',status:'acknowledging'}],
    runtimeMetrics:{rpcCalls:2,computeSeconds:1,peakMemoryBytes:1024}});
  const request={id:'v8-commit-1-'+ordinal,op:'commit',session:'session-a',record:'algorithm {}',selection,
    public:{timeline:[]},contexts:[],invocationId:'invocation-a'};
  return {identity:{schema:'semantic-native-request-identity/1',session_id:'session-a',stream_id:'stream-a',
    session_generation:1,ordinal,operation:'commit',model_identity:{checkpoint:'a'.repeat(64),tokenizer:'b'.repeat(64)}},
    requestBase64:Buffer.from(JSON.stringify(request)+'\n').toString('base64'),checkpoint};
}
async function directory(t){
  const value=await mkdtemp(join(tmpdir(),'native-v8-requests-'));
  t.after(()=>rm(value,{recursive:true,force:true}));return value;
}
function journal(root,options={}){return new DurableNativeV8RequestJournal({directory:root,
  sessionId:'session-a',streamId:'stream-a',...options});}

test('producer journal preserves original request bytes and whole precommit state across reopening',async t=>{
  const root=await directory(t),first=journal(root),input=intent(),receipt=await first.append(input);
  input.requestBase64='AA==';input.checkpoint.attempts[0].record='mutated after append';
  const reopened=journal(root),found=await reopened.read(receipt,{latest:true});
  assert.equal(found.requestBase64,intent().requestBase64);
  assert.deepEqual(found.checkpoint,intent().checkpoint);
  assert.deepEqual(await reopened.inspect(1),{receipt,intent:found});
  assert.deepEqual(await reopened.list(),[{ordinal:1}]);
});

test('producer snapshots caller-owned bytes before the first storage await',async t=>{
  const store=journal(await directory(t)),input=intent(),pending=store.append(input);
  input.identity.ordinal=19;input.checkpoint.identity.seed=900;
  const receipt=await pending;
  assert.equal(receipt.ordinal,1);assert.equal((await store.read(receipt)).checkpoint.identity.seed,17);
});

test('producer refuses duplicate dispatch and newer intents fence stale recovery',async t=>{
  const store=journal(await directory(t)),first=await store.append(intent());
  await assert.rejects(store.append(intent()),/exact journal sequence|existing intent/);
  const second=await store.append(intent(2));
  await assert.rejects(store.read(first,{latest:true}),/later request/);
  assert.equal((await store.read(second,{latest:true})).identity.ordinal,2);
});

test('two appenders cannot both own the same immutable request ordinal',async t=>{
  const root=await directory(t),results=await Promise.allSettled([journal(root).append(intent()),journal(root).append(intent())]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(results.filter(item=>item.status==='rejected').length,1);
  assert.equal((await journal(root).list()).length,1);
});

test('producer refuses replaced request bytes, forged receipt, mismatched model and pending selection',async t=>{
  const root=await directory(t),store=journal(root),receipt=await store.append(intent());
  await assert.rejects(store.read({...receipt,digest:'c'.repeat(64)}),/retained receipt/);
  const bytes=await readFile(store.path(1));
  await writeFile(store.path(1),Buffer.concat([bytes,Buffer.from(' ')]));
  await assert.rejects(store.read(receipt),/retained receipt/);
  for(const change of [
    value=>{value.identity.model_identity.checkpoint='d'.repeat(64);},
    value=>{value.checkpoint.attempts[0].selection.selectionId='changed';},
    value=>{value.identity.operation='select';},
    value=>{value.identity.session_id='another-session';},
  ]){const value=intent();change(value);await assert.rejects(journal(await directory(t)).append(value));}
});

test('producer rejects missing ordinal slots, byte limits and unsafe filesystem objects',async t=>{
  const store=journal(await directory(t));
  await assert.rejects(store.append(intent(2)),/exact journal sequence/);
  await assert.rejects(journal(await directory(t),{maxBytes:64}).append(intent()),/byte limit/);
  const root=await directory(t),target=join(root,'actual');await mkdir(target,{mode:0o700});
  await symlink(target,join(root,'alias'));
  await assert.rejects(journal(join(root,'alias')).append(intent()),/symlinks/);
  const unsafe=journal(await directory(t)),receipt=await unsafe.append(intent());
  await chmod(unsafe.path(1),0o644);
  await assert.rejects(unsafe.read(receipt),/unsafe intent/);
});

test('commit bytes reject malformed UTF-8, multiple frames, duplicate fields and selection reuse',()=>{
  const input=intent(),raw=Buffer.from(input.requestBase64,'base64').toString();
  for(const bytes of [Buffer.from([255,10]),Buffer.from(raw+raw),Buffer.from(raw.trim()),
    Buffer.from(raw.replace('"op":"commit"','"op":"select"')),
    Buffer.from(raw.replace('"op":"commit"','"op":"commit","op":"commit"'))])
    assert.throws(()=>decodeNativeV8RequestFrame(bytes.toString('base64')));
  assert.throws(()=>decodeNativeV8RequestFrame(input.requestBase64+'\n'),/base64/);
});

test('only a live original kernel lease can authorize a native transport',async t=>{
  const lock=new DurableSelectedOrchestrationExecutionLock({directory:await directory(t),
    sessionId:'session-a',streamId:'stream-a',flockPath:process.env.TRACING_TEST_FLOCK??'/usr/bin/flock'}),
    lease=await lock.acquire();
  try{
    assert.equal(assertSelectedOrchestrationExecutionLease(lease,{sessionId:'session-a',streamId:'stream-a'}),lease);
    assert.throws(()=>assertSelectedOrchestrationExecutionLease({...lease}),/original kernel/);
    assert.throws(()=>assertSelectedOrchestrationExecutionLease(lease,{sessionId:'other'}),/another session/);
  }finally{await lease.release();}
  assert.throws(()=>assertSelectedOrchestrationExecutionLease(lease),/released/);
});
