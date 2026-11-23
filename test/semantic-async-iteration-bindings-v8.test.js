import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const cases=[
  {name:'array holes, defaults and rest',expected:'3:2:4;2:1:6;',body:
    'async function run(){let log="";for await(const [x=3,...rest] of [[,4,5],[2,6]])'+
    'log+=x+":"+rest.length+":"+rest[0]+";";return log;}'},
  {name:'failed default closes inner and outer iterators with throw precedence',expected:'io7',body:
    'async function run(){let log="";const inner={[Symbol.iterator](){return this;},'+
    'next(){return {done:false,value:undefined};},return(){log+="i";throw 9;}};'+
    'const outer={[Symbol.asyncIterator](){return this;},next(){return {done:false,value:inner};},'+
    'async return(){await 0;log+="o";return {};}};function fail(){throw 7;}'+
    'try{for await(const [x=fail()] of outer){log+="!";}}catch(error){return log+error;}}'},
  {name:'awaited default retains both iterator cleanup scopes',expected:'i3o',body:
    'async function run(){let log="";const inner={[Symbol.iterator](){return this;},'+
    'next(){return {done:false,value:undefined};},return(){log+="i";return {};}};'+
    'const outer={[Symbol.asyncIterator](){return this;},next(){return {done:false,value:inner};},'+
    'async return(){await 0;log+="o";return {};}};'+
    'for await(const [x=await Promise.resolve(3)] of outer){log+=x;break;}return log;}'}
];
const artifacts=[];
for(const fixture of cases)test('async iteration binding source: '+fixture.name,async()=>{
  const result=await verifyProtocolRegionTrainingCase({source:'"use strict";'+fixture.body,
    entry:'run',args:[],family:'async-iteration-bindings'});
  assert(result.exported,result.reason);
  const checked=await recheckProtocolRegionEvidence(result.exported);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  const controller=RegionExecutionHarness.replay(result.exported).controller;
  assert.deepEqual(controller.completion,{kind:'return',value:['str',fixture.expected]});
  artifacts.push({name:fixture.name,exported:result.exported,state:sharedRegionState(controller)});
});

test('restoration during an awaited binding preserves the inner and outer cleanup obligations',()=>{
  const example=artifacts.find(row=>row.name===cases[2].name),timeline=example.exported.public.timeline;
  let restored=false;
  for(const [index,row]of timeline.entries()){
    if(!row.fields?.line?.startsWith('detail ')||JSON.parse(row.fields.line.slice(7)).kind!=='await')continue;
    const prefix=RegionExecutionHarness.replay({...example.exported.public,timeline:timeline.slice(0,index+1)},
      {requireTerminal:false});
    const pending=[...prefix.controller.continuations.values()].find(continuation=>continuation.state!=='resumed')?.pending;
    if(!pending?.handler?.frames.some(frame=>frame.handlers.length>=2))continue;
    const harness=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint())));
    for(const later of timeline.slice(index+1))harness.select(later.fields.invocationId,later.fields.line,
      {entry:later.fields.entry??null});
    assert.deepEqual(sharedRegionState(harness.controller),example.state);
    restored=true;break;
  }
  assert(restored,'the default initializer must suspend with both cleanup scopes retained');
});

// Keep the existing native deadline per original binding case, with a fresh
// interpreter so cases cannot share import or execution state.
for(const fixture of cases)test('native consumer checks async binding, rest and nested cleanup records: '+fixture.name,
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,cases.length);
  const example=artifacts.find(row=>row.name===fixture.name);assert(example,fixture.name);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
row=json.load(sys.stdin)
receipt=validate_v8_artifact(row['exported'])
assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
state=_replay_shared_state(row['exported']['public']['timeline'],row['exported']['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
assert state==row['state'],row['name']
print('checked')
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
    env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(example),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));
});
