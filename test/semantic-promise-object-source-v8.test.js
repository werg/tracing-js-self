import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {PROMISE_OBJECT_FIXTURES_V8} from '../fixtures/semantic-regions/promise-objects.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const artifacts=[];let nativeReceipts=[];
const tag=value=>[typeof value==='boolean'?'bool':typeof value==='string'?'str':'num',value];
for(const fixture of PROMISE_OBJECT_FIXTURES_V8)test('original/reference and checked Promise object source: '+fixture.id,async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture);
  assert(result.exported,result.category+': '+result.reason);
  const verified=await recheckProtocolRegionEvidence(result.exported);
  assert.equal(verified.sourceValidated,true);assert.equal(verified.projectionValidated,true);assert.equal(verified.replayValidated,true);
  const replay=RegionExecutionHarness.replay(result.exported);
  assert.deepEqual(replay.controller.completion,{kind:'return',value:tag(fixture.expected)});
  artifacts.push({name:fixture.id,exported:result.exported,state:sharedRegionState(replay.controller)});
});
test('altered original source binding cannot be recertified by matching a final scalar',async()=>{
  const original=artifacts.find(row=>row.name==='promise-object-accessor-alias-receiver');assert(original);
  const altered=structuredClone(original.exported),source=altered.sidecar.sourceArtifact;
  source.sidecar.referenceInput.source=source.sidecar.referenceInput.source.replace('this===p?7:9','this===alias?7:9');
  altered.sidecar.sourceArtifactDigest=hashAlgorithmData(source);
  await assert.rejects(()=>recheckProtocolRegionEvidence(altered),/source|artifact|identity|changed|digest/i);
});
test('independent native checker replays every new source and retained shared state',{skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,PROMISE_OBJECT_FIXTURES_V8.length);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
out=[]
for row in json.load(sys.stdin):
    a=row['exported'];receipt=validate_v8_artifact(a)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    state=_replay_shared_state(a['public']['timeline'],a['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state'], row['name']
    out.append({'name':row['name'],'counts':receipt['counts']})
print(json.dumps(out))
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python3',['-c',script],{cwd:root,
    env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts=JSON.parse(result.stdout);
  assert.equal(nativeReceipts.length,PROMISE_OBJECT_FIXTURES_V8.length);
});
after(()=>{if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'promise-object-source-evidence.json'),JSON.stringify({
  schema:'promise-object-source-evidence/1',sourceCases:artifacts.length,actualNativeCases:nativeReceipts.length,
  nativeReceipts,generatedContexts:artifacts.reduce((sum,row)=>sum+row.exported.contexts.length,0),
  trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));});
