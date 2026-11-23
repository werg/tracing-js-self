import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

// These unchanged controls now use shared ordinary Promise storage. Require
// actual owned results, fresh original-source agreement and public replay for
// each operation, including the cases whose guest catch formerly hid no error.
const objectOperations=[
  ['prototype-null','Object.setPrototypeOf(p,null);return 7;',7],
  ['prototype-object','Object.setPrototypeOf(p,{});return 7;',7],
  ['prototype-computed','const key="setPrototypeOf";Object[key](p,null);return 7;',7],
  ['prototype-target-alias','const alias=p;Object.setPrototypeOf(alias,null);return 7;',7],
  ['prototype-evaluated-spread','Object.setPrototypeOf(...[p,null]);return 7;',7],
  ['prototype-caught','try{Object.setPrototypeOf(p,null);}catch(error){}return 7;',7],
  ['prototype-read','Object.getPrototypeOf(p);return 7;',7],
  ['prototype-read-computed','const key="getPrototypeOf";Object[key](p);return 7;',7],
  ['prototype-read-caught','try{Object.getPrototypeOf(p);}catch(error){}return 7;',7],
  ['create-with-promise-prototype','Object.create(p);return 7;',7],
  ['create-computed','const key="create";Object[key](p);return 7;',7],
  ['promise-as-new-prototype','Object.setPrototypeOf({},p);return 7;',7],
  ['promise-as-descriptor','Object.defineProperty({},"x",p);return 7;',7],
  ['prevent-extensions','Object.preventExtensions(p);return 7;',7],
  ['prevent-extensions-spread','Object.preventExtensions(...[p]);return 7;',7],
  ['extensibility-read','return Object.isExtensible(p);',true],
  ['extensibility-read-computed','const key="isExtensible";return Object[key](p);',true]
].map(([name,body,expected])=>({name,source:'"use strict";async function run(){const p=Promise.resolve(1);'+body+'}',expected}));
const positives=[...objectOperations,...[
  ['promise-identity','"use strict";async function run(){const p=Promise.resolve(1);return Object.is(p,p);}',true],
  ['promise-not-frozen','"use strict";async function run(){const p=Promise.resolve(1);return Object.isFrozen(p);}',false],
  ['shadowed-extensibility-method','"use strict";async function run(){const Object={isExtensible:function(value){return 7;}};const p=Promise.resolve(1);return Object.isExtensible(p);}',7],
  ['shadowed-prototype-method','"use strict";async function run(){const Object={setPrototypeOf:function(value,proto){return value;}};const p=Promise.resolve(1);Object.setPrototypeOf(p,null);return await p;}',1],
  ['ordinary-object-prototype','"use strict";function run(){const p={x:2};Object.setPrototypeOf(p,null);return p.x;}',2]
].map(([name,source,expected])=>({name,source,expected}))];
const observations=[],artifacts=[];let nativeReceipts=[];
const tagged=value=>[typeof value==='boolean'?'bool':typeof value==='string'?'str':'num',value];
if(process.env.REQUIRE_PROMISE_ADOPTION_V8==='1')
  assert(process.env.MEGATOKEN_ROOT,'Mandatory Promise object gate requires its exact native checkout');
function originalOutcome(source){
  const result=spawnSync(process.execPath,['-e',source+
    ';Promise.resolve(run()).then(value=>process.stdout.write(JSON.stringify({kind:"return",value})),error=>process.stdout.write(JSON.stringify({kind:"throw",name:error?.name,message:error?.message})));'],
    {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));return JSON.parse(result.stdout);
}
function archive(source,expected){const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});
  assert.equal(runtime.drive().kind,'terminated');
  const completion=runtime.state.control.a0.completion;assert.equal(completion.kind,'return');
  let value=completion.value;
  if(value[0]==='promise'){
    const promise=runtime.state.promises[value[1]];assert.equal(promise.status,'fulfilled');value=promise.value.value;
  }
  assert.deepEqual(value,tagged(expected),'owned execution must independently produce the original result');
  return runtime.exportRun();}
for(const scenario of positives)test('Promise object profile preserves '+scenario.name,async()=>{
  const original=originalOutcome(scenario.source);assert.deepEqual(original,{kind:'return',value:scenario.expected});
  const projected=compileProtocolSourceV8(archive(scenario.source,scenario.expected));
  assert.deepEqual(projected.outcome,{kind:'return',graph:{roots:[tagged(scenario.expected)],objects:[]}});
  const result=await verifyProtocolRegionTrainingCase({source:scenario.source,entry:'run',args:[],family:'promise-object-profile:'+scenario.name});
  assert(result.exported,result.reason);assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
  const replay=RegionExecutionHarness.replay(result.exported);
  assert.deepEqual(replay.controller.completion,{kind:'return',value:tagged(scenario.expected)});
  artifacts.push({name:scenario.name,exported:result.exported,state:sharedRegionState(replay.controller)});
  observations.push({...scenario,original,refused:false,sourceValidated:true,contexts:result.exported.contexts.length});
});
test('native independently replays every eligible Promise object control',{skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,22);assert.equal(artifacts.length,positives.length);
  assert.equal(observations.filter(row=>row.refused).length,0);
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
  assert.equal(nativeReceipts.length,positives.length);
});
after(()=>{if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'promise-object-profile-evidence.json'),JSON.stringify({
  schema:'promise-object-profile-evidence/1',sourceCases:observations.length,refusedSources:observations.filter(row=>row.refused).length,
  eligibleSources:artifacts.length,actualNativeCases:nativeReceipts.length,nativeReceipts,
  generatedContexts:artifacts.reduce((total,row)=>total+row.exported.contexts.length,0),
  moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,observations,cases:artifacts}));});
