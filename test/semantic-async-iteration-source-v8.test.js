import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {ASYNC_ITERATION_FIXTURES_V8} from '../fixtures/semantic-regions/async-iteration.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from '../src/semantic/protocol-source-extensions-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {hasAsyncIterationSourceCallableV8} from '../src/semantic/async-iteration-source-v8.js';

const artifacts=[],protocol=row=>row.kind==='protocol'?decodeProtocolRecordV8(row.fields.line):null;
const value=input=>[typeof input==='number'?'num':typeof input==='boolean'?'bool':'str',input];
for(const fixture of ASYNC_ITERATION_FIXTURES_V8)test('async iterator source: '+fixture.id,async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture);assert(result.exported,result.reason);
  const checked=await recheckProtocolRegionEvidence(result.exported);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  const controller=RegionExecutionHarness.replay(result.exported).controller;
  assert.deepEqual(controller.completion,{kind:'return',value:value(fixture.expected)});
  assert(result.exported.sidecar.protocolExtensions.includes('ordinary-completions-source/1'));
  artifacts.push({id:fixture.id,exported:result.exported,state:sharedRegionState(controller)});
});

test('async iterator source closures name only exact awaited-loop roles and retain cached method captures',()=>{
  const example=artifacts.find(row=>row.id==='source-async-iterator-array'),source=ASYNC_ITERATION_FIXTURES_V8[0].source,
    helpers=example.exported.public.timeline.map(protocol).filter(row=>row?.kind==='allocate'&&row.code?.startsWith('async-from-sync-'));
  assert.equal(helpers.length,2);assert.notEqual(helpers[0].code,helpers[1].code);
  for(const helper of helpers){
    assert(hasAsyncIterationSourceCallableV8(source,helper.code));
    assert(!hasAsyncIterationSourceCallableV8(source,helper.code.replace(/:[0-9]+$/,':999999')));
    assert(!hasAsyncIterationSourceCallableV8(source.replace('for await','for'),helper.code));
  }
  const next=helpers.find(row=>row.code.startsWith('async-from-sync-next'));
  assert(next.captures.some(row=>row.binding.includes('sync iterator next')));
  assert(next.captures.some(row=>row.binding.endsWith(' receiver')));
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});runtime.drive();
  const bundle=runtime.exportRun();
  assert.deepEqual(compileProtocolSourceV8(bundle,{adapters:[...PROTOCOL_SOURCE_ADAPTERS_V8].reverse()}),compileProtocolSourceV8(bundle));
});

test('async cleanup suspension restores exact pending throws, returns, sibling scopes and receiver cells',()=>{
  const observed=new Set();
  for(const example of artifacts){
    const timeline=example.exported.public.timeline;
    for(const [index,row]of timeline.entries()){
      const record=protocol(row),isAwait=record?.kind==='async.await'||row.fields?.line?.startsWith('detail ')&&row.fields.line.includes('"kind":"await"');
      if(!isAwait)continue;
      const prefix=RegionExecutionHarness.replay({...example.exported.public,timeline:timeline.slice(0,index+1)},{requireTerminal:false}),
        continuation=[...prefix.controller.continuations.values()].findLast(item=>item.state!=='resumed'),
        pending=continuation?.pending?.handler?.frames.flatMap(frame=>frame.handlers).findLast(handler=>handler.pending)?.pending,
        key=(record?.kind??'root-await')+':'+(pending?.kind??'normal')+':'+example.id;
      if(observed.has(key))continue;observed.add(key);
      const packet=JSON.parse(JSON.stringify(prefix.checkpoint())),restored=RegionExecutionHarness.restore(packet);
      assert.deepEqual(restored.modelContext('invocation1'),prefix.modelContext('invocation1'));
      for(const later of timeline.slice(index+1))restored.select(later.fields.invocationId,later.fields.line,{entry:later.fields.entry??null});
      assert.deepEqual(sharedRegionState(restored.controller),example.state);
    }
  }
  assert([...observed].some(key=>key.includes(':throw:')));
  assert([...observed].some(key=>key.includes(':return:')));
});

test('forged helper sites and rehashed suspended cleanup cannot gain source or recovery authority',async()=>{
  const example=artifacts.find(row=>row.id==='source-async-iterator-throw-precedence'),timeline=example.exported.public.timeline,
    index=timeline.findIndex(row=>protocol(row)?.kind==='async.await'),
    prefix=RegionExecutionHarness.replay({...example.exported.public,timeline:timeline.slice(0,index+1)},{requireTerminal:false});
  const saved=[...prefix.controller.continuations.values()].find(item=>item.pending?.handler?.frames.length);
  assert(saved);
  const controller=Object.assign(Object.create(Object.getPrototypeOf(prefix.controller)),structuredClone(prefix.controller)),
    retained=[...controller.continuations.values()].find(item=>item.pending?.handler?.frames.length);
  retained.pending.handler.frames[0].invocation='invented-invocation';
  assert.throws(()=>restoreProtocolStateV8(controller,controller.protocol),/handler frame|invocation/);

  const changed=structuredClone(example.exported),context=changed.contexts.find(row=>
    row.state.continuations.some(([,continuation])=>continuation.pending?.handler?.frames.length));
  context.state.continuations.find(([,continuation])=>continuation.pending?.handler?.frames.length)[1].pending=null;
  changed.sidecar.contextDigest=hashAlgorithmData(changed.contexts);
  await assert.rejects(()=>recheckProtocolRegionEvidence(changed),/contexts differ|context/);
  const altered=structuredClone(artifacts[0].exported),helper=altered.public.timeline.find(row=>protocol(row)?.code?.startsWith('async-from-sync-')),
    record=protocol(helper);record.code=record.code.replace(/:[0-9]+$/,':999999');helper.fields.line=encodeProtocolRecordV8(record);
  assert.throws(()=>RegionExecutionHarness.replay(altered),/immutable source|callee is absent/);
});

test('reference-engine disagreements cannot become source agreement and thenable source limits remain explicit',async t=>{
  const source='"use strict";async function run(){let count=0;const it={[Symbol.iterator](){return this;},next(){throw 7;},return(){count++;return {};}};try{for await(const x of it){}}catch{}return count;}',
    reference=await vm.runInNewContext(source+';run();'),
    compared=await verifyProtocolRegionTrainingCase({source,entry:'run',args:[],family:'async-iteration-boundary'});
  assert([0,1].includes(reference));
  if(reference===0)assert(compared.exported,compared.reason);
  else{assert(!compared.exported);assert.notEqual(compared.status,'locally_verified');}
  t.diagnostic(JSON.stringify({node:process.version,v8:process.versions.v8,specCloseCount:0,referenceCloseCount:reference,
    sourceAgreement:Boolean(compared.exported)}));
  const thenable=await verifyProtocolRegionTrainingCase({source:'"use strict";async function run(){for await(const x of [{then(resolve){resolve(1);}}])return x;}',
    entry:'run',args:[],family:'async-iteration-boundary'});
  assert(!thenable.exported);assert.notEqual(thenable.status,'locally_verified');
});

// Each original source case retains its own bounded native replay. A growing
// source population must not consume the next case's timeout or import state.
for(const fixture of ASYNC_ITERATION_FIXTURES_V8)test('native consumer replays awaited iterator helpers and restored cleanup scopes: '+fixture.id,
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,ASYNC_ITERATION_FIXTURES_V8.length);
  const example=artifacts.find(row=>row.id===fixture.id);assert(example,fixture.id);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
row=json.load(sys.stdin)
receipt=validate_v8_artifact(row['exported'])
assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
state=_replay_shared_state(row['exported']['public']['timeline'],row['exported']['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
assert state==row['state'],row['id']
print('checked')
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
    env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(example),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));
});
