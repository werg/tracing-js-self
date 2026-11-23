import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {independentProtocolSourceReference} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

const fixtures=[
  ['captured-then-after-queued-mutation',`const p=Promise.resolve(1);const q=new Promise(resolve=>resolve(p));
    p.then=undefined;return await q;`,1],
  ['queued-then-and-live-constructor',`let log='';const p=Promise.resolve(7);const q=new Promise(resolve=>resolve(p));
    Object.defineProperty(p,'then',{get(){log+='t';throw 9;},configurable:true});
    Object.defineProperty(p,'constructor',{get(){log+=this===p?'g':'bad';return Promise;},configurable:true});
    const result=await q;return log+result;`,'g7'],
  ['arrow-constructor-lexical-receiver',`let log='';const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get:()=>{log+=this===undefined?'l':'bad';return Promise;}});
    const same=Promise.resolve(p)===p;return log+same;`,'ltrue'],
  ['method-has-own-accessor',`const p=Promise.resolve(1);let calls=0;
    Object.defineProperty(p,'x',{get(){calls++;return 7;}});
    return ''+p.hasOwnProperty('x')+p.hasOwnProperty('missing')+calls;`,'truefalse0'],
  ['borrowed-has-own-receiver',`const p=Promise.resolve(1);p.x=7;
    const other={y:9,check:p.hasOwnProperty};
    return ''+other.check('y')+other.check('x')+p.hasOwnProperty('x');`,'truefalsetrue'],
  ['numeric-update-conversion-and-modes',`const p=Promise.resolve(1);p.x='3';
    const a=p.x++;const b=++p.x;const c=p.x--;const d=--p.x;
    return a+':'+b+':'+c+':'+d+':'+p.x;`,'3:5:5:3:3'],
  ['bigint-update-modes',`const p=Promise.resolve(1);p.x=3n;
    return p.x++===3n&&--p.x===3n&&p.x===3n;`,true],
  ['inherited-update-creates-own-data',`const p=Promise.resolve(1);Object.setPrototypeOf(p,{x:2});
    const previous=p.x++;return previous===2&&p.x===3&&Object.hasOwn(p,'x');`,true]
].map(([id,body,expected])=>({id:'promise-review-'+id,family:'promise-object-review',
  source:'"use strict";async function run(){'+body+'}',entry:'run',args:[],expected}));
const artifacts=[],nativeReceipts=[];
const tag=value=>[typeof value==='boolean'?'bool':typeof value==='string'?'str':'num',value];
for(const fixture of fixtures)test('original/reference Promise review source: '+fixture.id,async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture);
  assert(result.exported,result.category+': '+result.reason);
  const checked=await recheckProtocolRegionEvidence(result.exported);
  for(const field of ['sourceValidated','projectionValidated','replayValidated'])assert.equal(checked[field],true);
  const replay=RegionExecutionHarness.replay(result.exported);
  assert.deepEqual(replay.controller.completion,{kind:'return',value:tag(fixture.expected)});
  artifacts.push({name:fixture.id,exported:result.exported,state:sharedRegionState(replay.controller)});
});

test('altered update computation cannot substitute a matching terminal completion',()=>{
  const original=artifacts.find(row=>row.name==='promise-review-numeric-update-conversion-and-modes');assert(original);
  const changed=structuredClone(original.exported),event=changed.public.timeline.find(event=>{
    if(event.kind!=='protocol')return false;
    const record=JSON.parse(event.fields.line.slice(9));return record.kind==='compute'&&record.expr?.op==='binary'&&record.result?.[0]==='num';
  });assert(event);
  const record=JSON.parse(event.fields.line.slice(9));record.result=['num',999];
  event.fields.line=encodeProtocolRecordV8(record);
  assert.throws(()=>RegionExecutionHarness.replay(changed),/computation|state|context|digest/i);
});

test('accessor and object-coercing updates retain their precise source continuation boundaries',async()=>{
  for(const [id,body,expected,reason]of [
    ['accessor',`const p=Promise.resolve(1);let x=3;Object.defineProperty(p,'x',{get(){return x;},set(v){x=v;}});p.x++;return x;`,
      4,'Accessor updates need an owned getter/setter continuation'],
    ['object',`const p=Promise.resolve(1);p.x={valueOf(){return 3;}};return p.x++;`,
      3,'Update coercion outside the bounded scalar profile']
  ]){
    const source='"use strict";async function run(){'+body+'}',reference=await independentProtocolSourceReference({
      source,entry:'run',inputGraph:encodeNativeGraph([]),awaitReturnedPromise:true,mode:'original'});
    assert.deepEqual(reference.outcome,{kind:'return',graph:{roots:[['num',expected]],objects:[]}});
    const result=await verifyProtocolRegionTrainingCase({id:'promise-review-update-'+id,family:'promise-object-review',source,entry:'run',args:[]});
    assert.equal(result.exported,undefined);assert.equal(result.status,'unsupported');
    assert.equal(result.category,'unsupported.protocol-source');assert.equal(result.reason,reason);
  }
});

test('native independently checks every Promise review source and retained continuation',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
    assert.equal(artifacts.length,fixtures.length);
    const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
out=[]
for row in json.load(sys.stdin):
    artifact=row['exported'];receipt=validate_v8_artifact(artifact)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    state=_replay_shared_state(artifact['public']['timeline'],artifact['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state'],row['name']
    out.append({'name':row['name'],'counts':receipt['counts']})
print(json.dumps(out))
`;
    const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python3',['-c',script],{cwd:root,
      env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
    assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts.push(...JSON.parse(result.stdout));
  });
after(()=>{
  if(process.env.REVIEW_SOURCE_CASES_OUT)writeFileSync(process.env.REVIEW_SOURCE_CASES_OUT,JSON.stringify(artifacts));
  if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'promise-object-review-source-evidence.json'),JSON.stringify({
    schema:'promise-object-review-source-evidence/1',sourceCases:artifacts.length,actualNativeCases:nativeReceipts.length,nativeReceipts,
    generatedContexts:artifacts.reduce((sum,row)=>sum+row.exported.contexts.length,0),
    moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));
});
