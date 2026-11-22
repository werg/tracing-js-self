// Mandatory paired recovery control. The Python peer uses the real V8
// NativeSemanticInferenceV8 and shared MultiTrackRuntime, with only its final
// lexical decoder replaced by a deterministic byte fixture. This is controlled
// engineering evidence, not learned model quality or source-admission evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {RegionSelectedOrchestrationDriver} from '../src/semantic/selected-orchestration-v8.js';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {verifySelectedOrchestrationCheckpoint} from '../src/semantic/selected-orchestration-checkpoint-v8.js';

const repository=dirname(dirname(fileURLToPath(import.meta.url)));
const explicitMegatokenRoot=Object.hasOwn(process.env,'MEGATOKEN_ROOT');
const configuredMegatokenRoot=explicitMegatokenRoot?process.env.MEGATOKEN_ROOT:process.env.MEGATOKEN_REPOSITORY;
const megatokenRepository=configuredMegatokenRoot?resolve(configuredMegatokenRoot):resolve(repository,'../megatoken');
const python=process.env.MEGATOKEN_PYTHON??process.env.PYTHON??'python3';
const pythonDeps=process.env.MEGATOKEN_PYTHON_DEPS??resolve(repository,'../python-deps');
const peer=resolve(megatokenRepository,'tests/fixtures/serve_semantic_v8_recovery_fixture.py');
const fixturePath=resolve(megatokenRepository,'tests/fixtures/semantic-orchestration-teacher-v8.json.gz.b64');
const decoderPrefix='ORCH_DECODER ';

function pythonEnvironment(){
  return {...process.env,PYTHONPATH:[resolve(megatokenRepository,'src'),pythonDeps,megatokenRepository,
    process.env.PYTHONPATH]
    .filter(Boolean).join(delimiter)};
}

function readFixture(){
  const encoded=readFileSync(fixturePath,'utf8').trim();
  return JSON.parse(gunzipSync(Buffer.from(encoded,'base64')));
}

function recordsFrom(document){
  const decisions=document.sidecar.orchestrationTranscript.events
    .filter(event=>event.kind==='decision').map(event=>event.record);
  const childTargets=document.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line);
  assert.equal(decisions.length,4);
  assert.equal(childTargets.length,2);
  return [decisions[0],decisions[1],...childTargets,decisions[2],decisions[3]];
}

function selector(decoderLog){
  return createNativeV8ProcessSelector({command:python,args:[peer,'--decoder-log',decoderLog],cwd:megatokenRepository,
    env:pythonEnvironment(),timeoutMs:120000,maxMessageBytes:64*1024*1024});
}

function decoderTrace(decoderLog){
  return readFileSync(decoderLog,'utf8').split('\n').filter(line=>line.startsWith(decoderPrefix))
    .map(line=>{
      const [recordIndex,offset,byteCount,tokenCount,terminal,payloadSha256]=JSON.parse(line.slice(decoderPrefix.length));
      return {recordIndex,offset,byteCount,tokenCount,terminal,payloadSha256};
    });
}

function assertTracePrefix(trace,records){
  let cursor=0;
  for(const [recordIndex,record] of records.entries()){
    const bytes=Buffer.from(record,'utf8');
    let offset=0;
    while(offset<bytes.length){
      const item=trace[cursor++];
      assert(item,'deterministic decoder did not emit every expected fragment');
      assert.equal(item.recordIndex,recordIndex);
      assert.equal(item.offset,offset);
      assert(item.byteCount>0&&item.byteCount<=512);
      assert(item.tokenCount>0&&item.tokenCount<=512);
      assert.equal(item.terminal,offset+item.byteCount===bytes.length);
      assert.equal(item.payloadSha256,createHash('sha256').update(bytes.subarray(offset,offset+item.byteCount)).digest('hex'));
      offset+=item.byteCount;
    }
  }
  assert.equal(cursor,trace.length,'decoder consumed data outside the accepted sequence');
}

function assertSameTrace(left,right){
  assert.deepEqual(left.map(row=>({recordIndex:row.recordIndex,offset:row.offset,byteCount:row.byteCount,
    tokenCount:row.tokenCount,terminal:row.terminal,payloadSha256:row.payloadSha256})),
  right.map(row=>({recordIndex:row.recordIndex,offset:row.offset,byteCount:row.byteCount,
    tokenCount:row.tokenCount,terminal:row.terminal,payloadSha256:row.payloadSha256})));
}

function assertNativeSelection(attempt,record,index){
  assert.equal(attempt.selectionId,`v8:${index}`);
  assert.equal(attempt.status,'committed');
  assert.equal(attempt.modelSelected,true);
  assert.equal(attempt.origin,'actual-model-selected');
  assert.equal(attempt.payloadHex,Buffer.from(record,'utf8').toString('hex'));
  assert(attempt.fragments.length>0);
  assert.equal(attempt.fragments.map(row=>row.payloadHex).join(''),attempt.payloadHex);
  assert.equal(attempt.fragments.at(-1).terminal,true);
  assert(attempt.fragments.slice(0,-1).every(row=>row.terminal===false));
  for(const fragment of attempt.fragments){
    assert(fragment.tokenIds.length>0);
    assert(fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0));
    assert(fragment.tokenIds.length<=512);
    assert.equal(fragment.tokenIds.length,fragment.emittedTokenIds.length);
  }
}

function policyFor(identity){
  return {...identity,maxActive:1,childBudget:64,maxCoordinatorSelections:16,maxPredictions:32,
    maxGenerated:64,maxOutstanding:64,maxStaleRetries:2,timeoutMs:120000,automaticDelivery:false};
}

function nativeSession(packet){
  const value=packet.native.native.sessions[packet.session];
  assert(value,'composite checkpoint omitted its native V8 session');
  return value;
}


async function nativeAutomaticInputs(t){
  if(!existsSync(peer)||!existsSync(fixturePath)){
    if(explicitMegatokenRoot)assert.fail('MEGATOKEN_ROOT is set but the paired recovery peer or fixture is missing');
    t.skip('paired megatoken checkout is unavailable');return null;
  }
  const described=spawnSync(python,[peer,'--describe'],{cwd:megatokenRepository,env:pythonEnvironment(),
    encoding:'utf8',timeout:120000});
  if(described.status!==0&&!explicitMegatokenRoot){t.skip('paired native runtime is unavailable');return null;}
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout),policy=policyFor(identity),document=readFixture(),
    records=recordsFrom(document),initialPublic={...structuredClone(document.public),
      timeline:structuredClone(document.public.timeline.slice(0,2))};
  return {identity,policy,document,records,initialPublic};
}

test('actual Python native automatic history refuses an unacknowledged coordinator selection',async t=>{
  const input=await nativeAutomaticInputs(t);if(!input)return;
  const {policy,initialPublic}=input,root=await mkdtemp(join(tmpdir(),'native-auto-before-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory:root,streamId:'nativebefore'});
  const log=join(root,'model.jsonl'),select=selector(log),driver=new RegionSelectedOrchestrationDriver({
    initialPublic,select,...policy});
  let head=null;
  driver.startAutomaticHistory({journal,acknowledge:async({receipt,previous})=>{
    assert.deepEqual(previous,head);
    const entry=await journal.read(receipt);
    if(entry.pending?.kind==='coordinator-selection')
      throw new Error('simulated lost coordinator-fence acknowledgement');
    head=structuredClone(receipt);return structuredClone(head);
  }});
  try{
    const result=await driver.run();
    assert.notEqual(result.status,'completed');
    assert.match(result.failure?.message??'',/simulated lost coordinator-fence acknowledgement/);
    assert.equal(driver.coordinatorAttempts.length,0,'coordinator selection follows only an acknowledged fence');
    assert(head,'the initial coordinator-ready cut was retained before the failed fence');
    const entries=await journal.readAll(head);
    assert.equal(entries.at(-1).pending,undefined);
  }finally{await select.shutdown();}
});

test('actual Python child execution remains fenced after its completion-cut acknowledgement is lost',async t=>{
  const input=await nativeAutomaticInputs(t);if(!input)return;
  const {policy,initialPublic}=input,root=await mkdtemp(join(tmpdir(),'native-auto-after-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory:root,streamId:'nativeafter'});
  const log=join(root,'model.jsonl'),select=selector(log),driver=new RegionSelectedOrchestrationDriver({
    initialPublic,select,...policy});
  let head=null,childFence=null;
  driver.startAutomaticHistory({journal,acknowledge:async({receipt,previous})=>{
    assert.deepEqual(previous,head);
    const entry=await journal.read(receipt);
    if(entry.pending?.kind==='child-dispatch')childFence=structuredClone(entry.checkpoint);
    if(entry.checkpoint.continuation.phase==='coordinator-ready'&&entry.checkpoint.childAttempts.length>0)
      throw new Error('simulated lost child-completion cut acknowledgement');
    head=structuredClone(receipt);return structuredClone(head);
  }});
  try{
    const result=await driver.run();
    assert.notEqual(result.status,'completed');
    assert.match(result.failure?.message??'',/simulated lost child-completion cut acknowledgement/);
    assert(childFence,'the exact child dispatch intent was durably acknowledged');
    assert.equal(driver.bridge.exportEpisode().timeline.filter(row=>row.mode==='generated').length,2,
      'the real shared runtime completed the child before the later cut ACK failed');
    const freshLog=join(root,'fresh.jsonl'),fresh=selector(freshLog);
    let restoreCalls=0;const restore=fresh.restore;
    fresh.restore=async request=>{restoreCalls++;return restore(request);};
    try{
      await assert.rejects(RegionSelectedOrchestrationDriver.restoreLatest(childFence,{historyJournal:journal,
        historyReceipt:head,initialPublic,select:fresh,policy}),/unresolved in-flight work/i);
      assert.equal(restoreCalls,0,'fenced work is refused before native restore or any host dispatch');
    }finally{await fresh.shutdown();}
  }finally{await select.shutdown();}
});

test('actual Python V8 checkpoint bytes restore through the JS composite driver at mixed cuts',async t=>{
  if(!existsSync(peer)||!existsSync(fixturePath)){
    if(explicitMegatokenRoot)assert.fail('MEGATOKEN_ROOT is set but the paired recovery peer or fixture is missing');
    t.skip('paired megatoken checkout is unavailable');return;
  }
  const described=spawnSync(python,[peer,'--describe'],{cwd:megatokenRepository,env:pythonEnvironment(),
    encoding:'utf8',timeout:120000});
  if(described.status!==0&&!explicitMegatokenRoot){
    t.skip('paired native runtime is unavailable outside the mandatory MEGATOKEN_ROOT gate');return;
  }
  assert.equal(described.status,0,described.stderr);
  const identity=JSON.parse(described.stdout),policy=policyFor(identity),document=readFixture(),records=recordsFrom(document);
  const initialPublic={...structuredClone(document.public),timeline:structuredClone(document.public.timeline.slice(0,2))};
  const session=initialPublic.timeline[0].fields.session;
  assert.equal(identity.generationSettings.device,'cpu');
  assert(records[0].length>512,'the create action must exercise bounded native continuation fragments');

  const logRoot=await mkdtemp(join(tmpdir(),'semantic-native-orchestration-recovery-'));
  try{
  const firstLog=join(logRoot,'first.jsonl'),first=selector(firstLog);
  let firstTrace,createCheckpoint;
  try{
    const driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
    const paused=await driver.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:1}});
    assert.equal(paused.status,'paused',JSON.stringify(paused.failure));
    assert.equal(paused.failure,null);
    createCheckpoint=paused.checkpoint;
    assert.equal(verifySelectedOrchestrationCheckpoint(createCheckpoint,policy,{initialPublic}),true);
    const saved=nativeSession(createCheckpoint),attempt=saved.orchestration.decisions[0];
    assert.equal(saved.orchestration.origin,'model');
    assert.equal(saved.orchestration.children[0].track,'track:1');
    assert.equal(saved.orchestration.children[0].execution.completion_target,'track:0');
    assertNativeSelection(createCheckpoint.native.native.attempts[0],records[0],0);
    assert.equal(attempt.record,records[0]);
    firstTrace=decoderTrace(firstLog);
    assertTracePrefix(firstTrace,[records[0]]);
    assert.equal(firstTrace[0].terminal,false);
    assert.equal(firstTrace.at(-1).terminal,true);
  }finally{await first.shutdown();}

  const secondLog=join(logRoot,'second.jsonl'),second=selector(secondLog);
  let mixedCheckpoint,secondTrace;
  try{
    const restored=await RegionSelectedOrchestrationDriver.restore(createCheckpoint,
      {initialPublic,select:second,policy});
    const paused=await restored.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:2}});
    assert.equal(paused.status,'paused',JSON.stringify(paused.failure));
    assert.equal(paused.failure,null);
    mixedCheckpoint=paused.checkpoint;
    assert.equal(verifySelectedOrchestrationCheckpoint(mixedCheckpoint,policy,{initialPublic}),true);
    const saved=nativeSession(mixedCheckpoint),orchestration=saved.orchestration;
    assert.equal(orchestration.origin,'model');
    assert.equal(orchestration.children[0].completion.schema,'semantic-child-completion/8');
    assert.equal(orchestration.children[0].completion.track,'track:1');
    assert.equal(mixedCheckpoint.state.tracks.find(row=>row.address==='track:0').status,'active');
    assert.equal(mixedCheckpoint.state.tracks.find(row=>row.address==='track:1').status,'completed');
    assert.equal(mixedCheckpoint.state.receipts[0].schema,'semantic-completion/4');
    assert.equal(mixedCheckpoint.childAttempts.filter(row=>row.status==='accepted').length,2);
    assert.equal(orchestration.operations.filter(row=>row.kind==='semantic').length,2);
    assert.equal(orchestration.operations.at(-1).kind,'completion');
    const attempts=saved.orchestration.decisions;
    assert.equal(attempts[0].record,records[0]);
    assert.equal(attempts[1].record,records[1]);
    const nativeAttempts=mixedCheckpoint.native.native.attempts;
    assert.equal(nativeAttempts.length,4);
    for(let index=0;index<records.length-2;index++)assertNativeSelection(nativeAttempts[index],records[index],index);
    secondTrace=decoderTrace(secondLog);
    assertTracePrefix(secondTrace,records.slice(0,4));
    const createFragments=firstTrace.length;
    assertSameTrace(firstTrace,secondTrace.slice(0,createFragments));
  }finally{await second.shutdown();}

  const thirdLog=join(logRoot,'third.jsonl'),third=selector(thirdLog);
  try{
    const restored=await RegionSelectedOrchestrationDriver.restore(mixedCheckpoint,
      {initialPublic,select:third,policy});
    const result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.failure,null);
    assert.equal(result.publicCompleted,true);
    assert.equal(result.sourceValidated,false);
    assert.equal(result.qualification.defaultPromotion,false);
    assert.equal(result.nativeMetrics.nativeAdmissionClaim,false);
    assert.equal(result.nativeMetrics.sourceAdmissionClaim,false);
    assert.deepEqual(result.public.timeline,document.public.timeline);
    assert.equal(result.completionReceipts.length,1);
    assert.equal(result.completionReceipts[0].schema,'semantic-child-completion/8');
    const trace=decoderTrace(thirdLog);
    assertTracePrefix(trace,records);
    assertSameTrace(secondTrace,trace.slice(0,secondTrace.length));
    const attempts=third.metrics().attempts;
    assert.equal(attempts.length,6);
    assert.deepEqual(attempts.map(row=>row.selection.selectionId),records.map((_record,index)=>`v8:${index}`));
    assert(attempts.every(row=>row.selection.modelSelected===true&&
      row.selection.origin==='actual-model-selected'));
  }finally{await third.shutdown();}
  }finally{await rm(logRoot,{recursive:true,force:true});}
});


test('actual Python shared-runtime automatic history restores a child-complete sparse cut without redispatch',async t=>{
  const input=await nativeAutomaticInputs(t);if(!input)return;
  const {policy,document,records,initialPublic}=input,root=await mkdtemp(join(tmpdir(),
    'native-auto-success-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory:root,streamId:'nativesuccess'});
  let head=null;
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head);head=structuredClone(receipt);return structuredClone(head);
  };
  const firstLog=join(root,'first.jsonl'),first=selector(firstLog),
    driver=new RegionSelectedOrchestrationDriver({initialPublic,select:first,...policy});
  let anchor,firstTrace,latest;
  driver.startAutomaticHistory({journal,acknowledge});
  try{
    const paused=await driver.run({stopAt:{phase:'coordinator-ready',coordinatorSelections:2}});
    assert.equal(paused.status,'paused',JSON.stringify(paused.failure));
    latest=driver.checkpoint();
    assert.equal(latest.childAttempts.filter(row=>row.status==='accepted').length,2);
    assert.equal(latest.state.children[0].completion.schema,'semantic-child-completion/8');
    const entries=await journal.readAll(head);
    assert.deepEqual(entries.at(-1).checkpoint,latest);
    assert.equal(Object.hasOwn(entries.at(-1),'pending'),false,
      'a requested child-complete pause is a complete safe cut');
    anchor=entries.find(row=>row.checkpoint.coordinatorAttempts.length===1&&!Object.hasOwn(row,'pending'))
      ?.checkpoint;
    assert(anchor,'history retains an earlier source cut');
    firstTrace=decoderTrace(firstLog);assertTracePrefix(firstTrace,records.slice(0,4));
  }finally{await first.shutdown();}
  const secondLog=join(root,'second.jsonl'),second=selector(secondLog),restore=second.restore;
  second.restore=async request=>{
    const receipt=await restore(request);assert.equal(receipt.hostDispatches,0);return receipt;
  };
  try{
    const restored=await RegionSelectedOrchestrationDriver.restoreLatest(anchor,{historyJournal:journal,
      historyReceipt:head,initialPublic,select:second,policy});
    assert.deepEqual(restored.historyReceipt,head);
    restored.startAutomaticHistory({journal,acknowledge,previous:head});
    const result=await restored.run();
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.publicCompleted,true);
    assert.deepEqual(result.public.timeline,document.public.timeline);
    const newAttempts=second.metrics().attempts.slice(latest.native.attempts.length);
    assert.deepEqual(newAttempts.map(row=>row.family==='orchestration'?JSON.parse(row.record).name:'child-selection'),
      ['track_progress','track_complete']);
    const trace=decoderTrace(secondLog);
    assertTracePrefix(trace,records);
    assertSameTrace(firstTrace,trace.slice(0,firstTrace.length));
    assert.equal(result.terminalDisposition?.schema,'semantic-selected-orchestration-terminal-event/8');
    const terminalLog=join(root,'terminal.jsonl'),terminalSelect=selector(terminalLog),nativeRestore=terminalSelect.restore;
    let closeProof=null;
    terminalSelect.restore=async request=>{closeProof=await nativeRestore(request);return closeProof;};
    try{
      const disposition=await RegionSelectedOrchestrationDriver.restoreLatest(anchor,{historyJournal:journal,
        historyReceipt:head,initialPublic,select:terminalSelect,policy});
      assert.equal(disposition.schema,'semantic-selected-orchestration-disposition/8');
      assert.equal(disposition.status,'completed');
      assert.equal(disposition.resumable,false);
      assert.equal(disposition.sourceValidated,false);
      assert.equal(disposition.qualification.defaultPromotion,false);
      assert.equal(closeProof.restoredSessions,0);
      assert.equal(closeProof.hostDispatches,0);
      const terminalEvent=(await journal.readAll(head)).at(-1).terminal;
      assert.equal(closeProof.consumedAttempts,terminalEvent.closedNative.native.attempts.length);
    }finally{await terminalSelect.shutdown();}
  }finally{await second.shutdown();}
});
