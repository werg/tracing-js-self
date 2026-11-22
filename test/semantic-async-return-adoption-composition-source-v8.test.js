import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';

// Original source bytes from the separate async-only candidate 7fe5a9d5,
// semantic-async-call-source-v8.test.js. Preserve these source-level ordering
// assertions when adopting the canonical shared Promise resolution procedure.
const cases=[
  ['owned Promise.resolve return adoption','async function h(){return Promise.resolve(1);}async function run(){let order="";const adopted=h();adopted.then(()=>{order+="a";});Promise.resolve().then(()=>{order+="q";});await adopted;return order;}','qa'],
  ['owned Promise return adoption FIFO','async function target(){return 1;}async function run(){let order="";const targetPromise=target();async function outer(){return targetPromise;}const adopted=outer();adopted.then(()=>{order+="a";});targetPromise.then(()=>{order+="d";});targetPromise.then(()=>{order+="q";});await adopted;return order;}','dqa']
].map(([name,body,expected])=>({name,source:'"use strict";'+body,expected}));
const artifacts=[];let nativeReceipts=[],cutCount=0;
const record=row=>row.kind==='protocol'?decodeProtocolRecordV8(row.fields.line):null;
if(process.env.REQUIRE_PROMISE_ADOPTION_V8==='1')
  assert(process.env.MEGATOKEN_ROOT,'Mandatory async source composition requires its exact native checkout');
for(const scenario of cases)test('original async-only source uses canonical adoption: '+scenario.name,async()=>{
  const original=spawnSync(process.execPath,['-e',scenario.source+';run().then(value=>process.stdout.write(JSON.stringify(value)));'],
    {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  assert.equal(original.status,0,original.stderr||String(original.error));assert.equal(JSON.parse(original.stdout),scenario.expected);
  const input={source:scenario.source,entry:'run',args:[],family:'async-return-adoption-composition'},
    result=await verifyProtocolRegionTrainingCase(input);
  assert(result.exported,result.reason);assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
  const replay=RegionExecutionHarness.replay(result.exported),state=sharedRegionState(replay.controller);
  assert.deepEqual(replay.controller.completion,{kind:'return',value:['str',scenario.expected]});
  const timeline=result.exported.public.timeline;
  for(const [index,row]of timeline.entries())if(['async.await','async.resume','async.complete',
    'promise.adopt.enqueue','promise.adopt.enter','promise.adopt.forward'].includes(record(row)?.kind)){
    const prefix=RegionExecutionHarness.replay({...result.exported.public,timeline:timeline.slice(0,index+1)},{requireTerminal:false}),
      restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint())));
    assert.deepEqual(restored.modelContext('invocation1'),prefix.modelContext('invocation1'));
    for(const later of timeline.slice(index+1))restored.select(later.fields.invocationId,later.fields.line,{entry:later.fields.entry??null});
    assert.deepEqual(sharedRegionState(restored.controller),state);cutCount++;
  }
  artifacts.push({name:scenario.name,source:scenario.source,sourceSha256:createHash('sha256').update(scenario.source).digest('hex'),
    exported:result.exported,state});
});
test('original async return binds one common enqueue, assimilation and forwarding sequence',()=>{
  assert.equal(artifacts.length,cases.length);
  for(const example of artifacts){
    const records=example.exported.public.timeline.map(record).filter(Boolean),
      completion=records.find(row=>row.kind==='async.complete'&&row.completion.value?.[0]==='ref'),
      resolution=records.filter(row=>row.kind.startsWith('promise.adopt.'));
    assert(completion);assert(!records.some(row=>row.kind.startsWith('async.resolve.')));
    assert.deepEqual(resolution.map(row=>row.kind),['promise.adopt.enqueue','promise.adopt.enter','promise.adopt.forward']);
    assert(resolution.every(row=>row.promise===completion.promise&&row.target===completion.completion.value[1]));
    assert.equal(resolution[0].job,resolution[1].job);assert.equal(resolution[1].forwarding,resolution[2].job);
    const returned=RegionExecutionHarness.replay(example.exported).controller.heap.get(completion.promise);
    assert.equal(returned.asyncCall.phase,'completed');assert.deepEqual(returned.asyncCall.completion,completion.completion);
    assert.equal(returned.adoption.cause.invocation,completion.invocation);assert.equal(returned.adoption.phase,'completed');
    assert.equal(returned.state,'fulfilled');assert.deepEqual(returned.result,['num',1]);
  }
});
test('native replays both exact original async-only source packets',{skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,cases.length);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
out=[]
for row in json.load(sys.stdin):
    a=row['exported'];receipt=validate_v8_artifact(a)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    state=_replay_shared_state(a['public']['timeline'],a['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state']
    out.append({'name':row['name'],'counts':receipt['counts']})
print(json.dumps(out))
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
    env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts=JSON.parse(result.stdout);
  assert.equal(nativeReceipts.length,cases.length);
});
after(()=>{if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'async-return-adoption-composition-evidence.json'),JSON.stringify({
  schema:'async-return-adoption-composition-evidence/1',originalSourceRevision:'7fe5a9d57fbf456f0165534f089116b4b5db7279',
  sourceCases:artifacts.length,actualNativeCases:nativeReceipts.length,nativeReceipts,snapshotCuts:cutCount,
  generatedContexts:artifacts.reduce((total,row)=>total+row.exported.contexts.length,0),
  moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));});
