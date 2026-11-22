import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from '../src/semantic/protocol-source-extensions-v8.js';
import {createSharedProtocolSourceComponentsV8} from '../src/semantic/protocol-source-bridge-v8.js';
import {createPromiseExecutorTeacherV8} from '../src/semantic/protocol-promise-executor-source-v8.js';
import {createEffectfulRegionAdapterV8} from '../src/semantic/effectful-teacher-v8.js';
import {compileSourceProjection} from '../src/semantic/source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from '../src/semantic/source-compiler-v8.js';
import {protocolSourceClaimsV8} from '../src/semantic/protocol-source-claims-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const generator='synchronous-generator-source/1';
const cases=[
  ['initial declaration, suspension, completion and reaction',
    'function* g(){yield 1;return 2;}function run(){const it=g();const a=it.next();'+
    'const p=new Promise(r=>r(a.value));const b=it.next();return p.then(v=>v+b.value);}',3],
  ['injected rejection is caught before cleanup suspends',
    'async function run(){function* g(){try{yield 1;}catch(e){yield e+1;}finally{yield 3;}return 4;}'+
    'const it=g();it.next();const p=new Promise(r=>r(it.throw(5).value));const clean=it.next();'+
    'const done=it.next();return (await p)+clean.value+done.value;}',13],
  ['live capture remains shared across Promise suspension',
    'async function run(){let x=1;function* g(){yield x;return x;}const it=g();'+
    'const p=new Promise(r=>r(it.next().value));x=9;return (await p)+it.next().value;}',10],
  ['generator without yield and already completed next',
    'async function run(){function* g(){return 3;}const it=g();const p=new Promise(r=>r(it.next().value));'+
    'return (await p)+(it.next().done?1:0);}',4],
  ['abrupt return before first resume',
    'async function run(){function* g(){yield 1;}const it=g();'+
    'const p=new Promise(r=>r(it.return(7).value));return await p;}',7],
  ['uncaught generator rejection unwinds the exact executor',
    'async function run(){function* g(){yield 1;}const it=g();it.next();'+
    'const p=new Promise(r=>{it.throw(7);});try{return await p;}catch(e){return e;}}',7]
].map(([name,body,expected])=>({name,source:'"use strict";'+body,expected}));
const artifacts=[];
let nativeReceipts=[];
function archive(source){
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});
  assert.equal(runtime.drive().kind,'terminated');return runtime.exportRun();
}
function components(bundle,change=()=>{}){
  const source=bundle.sources.find(row=>row.sourceId===bundle.entrySpec.sourceId).text,
    adapters=PROTOCOL_SOURCE_ADAPTERS_V8.map(make=>typeof make==='function'?make({source,bundle}):make).filter(Boolean);
  change(adapters);
  return [createPromiseExecutorTeacherV8(),...createSharedProtocolSourceComponentsV8({source,bundle,adapters})];
}
const snapshot=harness=>structuredClone({episode:harness.exportEpisode(),
  invocations:[...harness.invocations],realms:[...harness.realms]});
function project(bundle,extensions,target,before){
  const adapter=createEffectfulRegionAdapterV8({extensions});let live;
  const wrapped={...adapter,createHarness(options){live=adapter.createHarness(options);return live;},
    beginEvent(event,row,fact){if(event&&target(event))before(live,adapter,event);return adapter.beginEvent(event,row,fact);}};
  return compileSourceProjection(bundle,{regionAdapter:wrapped,projectionClient:SOURCE_PROJECTION_CLIENT_V8,
    semanticRegions:false,localStateCompaction:false,realmPolicy:'fresh',sessionId:'shared-generator-source'});
}

for(const scenario of cases)test('shared generator: '+scenario.name,async()=>{
  const bundle=archive(scenario.source),forward=compileProtocolSourceV8(bundle),
    reverse=compileProtocolSourceV8(bundle,{adapters:[...PROTOCOL_SOURCE_ADAPTERS_V8].reverse()});
  assert.deepEqual(reverse,forward);
  assert.equal(forward.sourceProfile,'composed-protocol-source/1');
  assert(forward.extensions.includes(generator));
  const verified=await verifyProtocolRegionTrainingCase({source:scenario.source,entry:'run',args:[],family:'shared-generator-promise'});
  assert(verified.exported,verified.reason);
  const checked=await recheckProtocolRegionEvidence(verified.exported);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  const controller=RegionExecutionHarness.replay(verified.exported).controller;
  assert.deepEqual(controller.completion,{kind:'return',value:['num',scenario.expected]});
  artifacts.push({name:scenario.name,exported:verified.exported,state:sharedRegionState(controller)});
});

test('a retained generator inside its executor resumes from the exact JSON checkpoint',()=>{
  const example=artifacts.find(row=>row.name===cases[1].name),timeline=example.exported.public.timeline,
    cut=timeline.findIndex(row=>row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='generator.handler.catch')+1;
  assert(cut>0);
  const prefix=RegionExecutionHarness.replay({...example.exported.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
    resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint())));
  assert.equal(resumed.controller.protocol.promiseExecutors.executors.at(-1).phase,'running');
  assert([...resumed.controller.heap.values()].some(node=>node.kind==='generator'&&node.phase==='executing'));
  assert.deepEqual(resumed.modelContext('invocation1'),prefix.modelContext('invocation1'));
  for(const row of timeline.slice(cut))resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(resumed.controller),example.state);
});

test('generator event ownership cannot be removed or duplicated before preparation',()=>{
  const bundle=archive(cases[0].source),target=event=>event.operation==='call.enter'&&
    event.stateChanges.some(change=>change.table==='heap'&&change.before===null&&change.after?.kind==='generator');
  for(const ambiguous of [false,true]){
    let live,before,prepared=0,eventId;
    const extensions=components(bundle).filter(component=>ambiguous||component.id!==generator);
    if(ambiguous)extensions.push({id:'duplicate-generator/1',claims:{event:protocolSourceClaimsV8(generator).event},
      prepare:{event:()=>{prepared++;return {kind:'duplicate'};}},event(){throw new Error('must not run');}});
    for(const component of extensions)for(const kind of Object.keys(component.prepare??{})){
      const original=component.prepare[kind];component.prepare[kind]=(view,input)=>{
        if(eventId&&view.event?.eventId===eventId)prepared++;return original(view,input);
      };
    }
    assert.throws(()=>project(bundle,extensions,target,(harness,_adapter,event)=>{
      live=harness;before=snapshot(harness);eventId=event.eventId;
    }),ambiguous?/ambiguous owner/:/generator|prototype|descriptor/);
    if(ambiguous){assert(live);assert.equal(prepared,0);assert.deepEqual(snapshot(live),before);}
  }
});

test('a generator observer failure rolls back its frame, descriptor state and Promise peers',()=>{
  const bundle=archive(cases[1].source),extensions=components(bundle,adapters=>{
    const index=adapters.findIndex(adapter=>adapter.id===generator),original=adapters[index];
    adapters[index]={...original,checkHeap(ctx,node){
      const valid=original.checkHeap(ctx,node);
      return node.kind==='generator'&&node.state==='executing'?false:valid;
    }};
  });
  let live,before,adapter,states;
  const target=event=>event.operation==='call.enter'&&event.operands[0]?.[1]?.[1]==='Generator.next';
  assert.throws(()=>project(bundle,extensions,target,(harness,current)=>{
    live=harness;before=snapshot(harness);adapter=current;
    states=structuredClone(Object.fromEntries(extensions.map(({id})=>[id,current.componentState(id)])));
  }),/shared protocol heap comparison failed/);
  assert(live);assert.deepEqual(snapshot(live),before);
  for(const {id}of extensions)assert.deepEqual(adapter.componentState(id),states[id],id);
});

test('composition refuses undeclared delegation and nested async helper suspension',()=>{
  const bodies=[
    ['function* inner(){yield 1;}function* outer(){yield* inner();}function run(){const p=new Promise(r=>r(1));const it=outer();return it.next().value;}',/yield delegation/],
    ['async function helper(){await 0;return 1;}async function run(){function* g(){yield 1;}const it=g();it.next();const p=new Promise(r=>r(1));return (await helper())+(await p);}',/synchronous owned closure/]
  ];
  for(const [body,reason]of bodies)assert.throws(()=>compileProtocolSourceV8(archive('"use strict";'+body)),reason);
});

test('actual native shared replay checks every generated context and continuation',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,cases.length);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
rows=json.load(sys.stdin)
out=[]
for row in rows:
    artifact=row['exported']
    receipt=validate_v8_artifact(artifact)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    state=_replay_shared_state(artifact['public']['timeline'],artifact['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state']
    out.append({'name':row['name'],'counts':receipt['counts']})
print(json.dumps(out))
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
    env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));
  nativeReceipts=JSON.parse(result.stdout);
  assert.equal(nativeReceipts.length,cases.length);
});

after(()=>{
  if(!process.env.RUNNER_TEMP)return;
  writeFileSync(join(process.env.RUNNER_TEMP,'shared-generator-source-evidence.json'),JSON.stringify({
    schema:'shared-generator-source-evidence/1',sourceCases:artifacts.length,actualNativeCases:nativeReceipts.length,
    generatedContexts:artifacts.reduce((total,row)=>total+row.exported.contexts.length,0),nativeReceipts,
    moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));
});
