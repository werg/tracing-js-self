import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {createAsyncCallTeacherV8} from '../src/semantic/protocol-async-call-source-v8.js';
import {createPromiseExecutorTeacherV8} from '../src/semantic/protocol-promise-executor-source-v8.js';
import {createEffectfulRegionAdapterV8} from '../src/semantic/effectful-teacher-v8.js';
import {compileSourceProjection} from '../src/semantic/source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from '../src/semantic/source-compiler-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from '../src/semantic/protocol-source-extensions-v8.js';

const cases=[
  ['immediate fulfillment','async function h(x){return x+1;}async function run(){return await h(2);}',3],
  ['immediate rejection','async function h(){throw 7;}async function run(){try{return await h();}catch(e){return e+1;}}',8],
  ['rejection after suspension','async function h(){await 0;throw 7;}async function run(){try{return await h();}catch(e){return e+1;}}',8],
  ['rejected await is caught by child','async function h(){try{await Promise.reject(7);}catch(e){return e+1;}}async function run(){return await h();}',8],
  ['sibling FIFO and repeated awaits','async function h(x){await 0;await 0;return x;}async function run(){const a=h(2),b=h(3);return (await a)+(await b);}',5],
  ['detachment inside an existing reaction job','async function h(){await 0;return 4;}function run(){const p=new Promise(r=>r(1));return p.then(function(){h();return 2;});}',2],
  ['receiver and live capture cells','async function run(){let n=1;const obj={n:3,h:async function(x){await 0;return this.n+x+n;}};const p=obj.h(2);n=9;return await p;}',14],
  ['nested detached children','async function child(){await 0;return 2;}async function parent(){const p=child();await 0;return (await p)+1;}async function run(){return await parent();}',3],
  ['ordinary reference completion','async function h(){await 0;return {x:2};}async function run(){const r=await h();return r.x;}',2],
  ['owned Promise.resolve return adoption','async function h(){return Promise.resolve(1);}async function run(){let order="";const adopted=h();adopted.then(()=>{order+="a";});Promise.resolve().then(()=>{order+="q";});await adopted;return order;}','qa'],
  ['owned Promise return adoption FIFO','async function target(){return 1;}async function run(){let order="";const targetPromise=target();async function outer(){return targetPromise;}const adopted=outer();adopted.then(()=>{order+="a";});targetPromise.then(()=>{order+="d";});targetPromise.then(()=>{order+="q";});await adopted;return order;}','dqa'],
  ['generator yields a child execution Promise','async function leaf(n){await 0;return n+1;}async function run(){function* g(){yield leaf(2);return 4;}const it=g();const first=await it.next().value;return first+it.next().value;}',7]
].map(([name,body,expected])=>({name,source:'"use strict";'+body,expected}));
const artifacts=[];
let nativeReceipts=[];
const protocol=row=>row.kind==='protocol'?decodeProtocolRecordV8(row.fields.line):null;
function prefix(example,index){return RegionExecutionHarness.replay({...example.exported.public,
  timeline:example.exported.public.timeline.slice(0,index)},{requireTerminal:false});}
function atomicRefusal(harness,record,pattern){
  const before=JSON.parse(JSON.stringify(harness.checkpoint()));
  assert.throws(()=>harness.select('invocation1',record),pattern);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.checkpoint())),before);
}
function archive(source){
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});
  runtime.drive();return runtime.exportRun();
}
function originalOutcome(source){
  const result=spawnSync(process.execPath,['-e','const unmodifiedThen=Promise.prototype.then;'+source+
    ';unmodifiedThen.call(run(),value=>process.stdout.write(JSON.stringify(value)))'],
  {encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||String(result.error));return JSON.parse(result.stdout);
}
const snapshot=harness=>structuredClone({episode:harness.exportEpisode(),
  invocations:[...harness.invocations],realms:[...harness.realms]});
function project(bundle,extensions,target,before){
  const adapter=createEffectfulRegionAdapterV8({extensions});let live;
  const wrapped={...adapter,createHarness(options){live=adapter.createHarness(options);return live;},
    beginEvent(event,row,fact){if(event&&target(event))before(live,adapter,event);return adapter.beginEvent(event,row,fact);}};
  return compileSourceProjection(bundle,{regionAdapter:wrapped,projectionClient:SOURCE_PROJECTION_CLIENT_V8,
    semanticRegions:false,localStateCompaction:false,realmPolicy:'fresh',sessionId:'nested-async-source'});
}

for(const scenario of cases)test('nested async source: '+scenario.name,async()=>{
  if(scenario.name==='owned Promise return adoption FIFO')assert.deepEqual(originalOutcome(scenario.source),'dqa');
  const verified=await verifyProtocolRegionTrainingCase({source:scenario.source,entry:'run',args:[],family:'nested-async-call'});
  assert(verified.exported,verified.reason);
  const checked=await recheckProtocolRegionEvidence(verified.exported);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  const controller=RegionExecutionHarness.replay(verified.exported).controller;
  assert.deepEqual(controller.completion,{kind:'return',value:[typeof scenario.expected==='string'?'str':'num',scenario.expected]});
  const example={name:scenario.name,exported:verified.exported,state:sharedRegionState(controller)};
  artifacts.push(example);
  for(const [index,row]of example.exported.public.timeline.entries())if(['async.await','async.resume','async.complete',
    'async.resolve.enqueue','async.resolve.subscribe','async.resolve.settle'].includes(protocol(row)?.kind)){
    const before=prefix(example,index+1),resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(before.checkpoint())));
    assert.deepEqual(resumed.modelContext('invocation1'),before.modelContext('invocation1'));
    for(const later of example.exported.public.timeline.slice(index+1))
      resumed.select(later.fields.invocationId,later.fields.line,{entry:later.fields.entry??null});
    assert.deepEqual(sharedRegionState(resumed.controller),example.state);
  }
});

test('owned async Promise return projects exact source-bound enqueue, subscription and settlement jobs',()=>{
  const example=artifacts.find(row=>row.name==='owned Promise return adoption FIFO'),records=example.exported.public.timeline
      .map(protocol).filter(Boolean),resolution=records.filter(row=>row.kind.startsWith('async.resolve.')),
    completion=records.find(row=>row.kind==='async.complete'&&row.completion.value[0]==='ref');
  assert(completion);assert.deepEqual(resolution.map(row=>row.kind),[
    'async.resolve.enqueue','async.resolve.subscribe','async.resolve.settle']);
  assert(resolution.every(row=>row.promise===completion.promise&&row.invocation===completion.invocation&&
    row.target===completion.completion.value[1]));
  assert.equal(resolution[0].job,resolution[1].job);assert.equal(resolution[0].settlementJob,resolution[1].settlementJob);
  assert.equal(resolution[2].job,resolution[0].settlementJob);
  const controller=RegionExecutionHarness.replay(example.exported).controller,
    returned=controller.heap.get(completion.promise),call=returned.asyncCall;
  assert.equal(call.phase,'completed');assert.equal(call.resolution.phase,'settled');
  assert.equal(returned.state,'fulfilled');assert.deepEqual(returned.result,['num',1]);
  assert.deepEqual(controller.completion,{kind:'return',value:['str','dqa']});
});

test('async resume verifies active-turn ownership, settled input and sibling FIFO atomically',()=>{
  const example=artifacts.find(row=>row.name==='sibling FIFO and repeated awaits'),timeline=example.exported.public.timeline,
    awaits=timeline.map((row,index)=>({record:protocol(row),index})).filter(row=>row.record?.kind==='async.await'),
    resumes=timeline.map((row,index)=>({record:protocol(row),index})).filter(row=>row.record?.kind==='async.resume');
  assert(resumes.length>=4);
  atomicRefusal(prefix(example,awaits[0].index+1),resumes[0].record,/FIFO|turn|ready order/);
  const before=prefix(example,resumes[0].index),selected=resumes[0].record;
  for(const record of [{...selected,value:['num',99]},{...selected,status:'rejected'},resumes[1].record,
    {...selected,promise:resumes[1].record.promise},{...selected,invocation:'invocation1'}])
    atomicRefusal(before,record,/settled|FIFO|ready order|continuation|invocation|Promise/);
});

test('generic operations cannot bypass an attached async call or execution Promise owner',()=>{
  const example=artifacts.find(row=>row.name==='sibling FIFO and repeated awaits'),timeline=example.exported.public.timeline,
    index=timeline.findIndex(row=>protocol(row)?.kind==='async.call'),call=protocol(timeline[index]),harness=prefix(example,index+1);
  atomicRefusal(harness,{kind:'return',invocation:call.child,value:['num',9]},/continuation|async/);
  atomicRefusal(harness,{kind:'promise',fields:{action:'resolve',promise:call.promise,value:['num',9]}},/continuation|async/);
  atomicRefusal(harness,{...call,child:'invented-child'},/unclaimed|pending|Promise/);
});

test('restored async continuation keeps its exact receiver and live capture aliases',()=>{
  const example=artifacts.find(row=>row.name==='receiver and live capture cells'),timeline=example.exported.public.timeline,
    index=timeline.findIndex(row=>protocol(row)?.kind==='async.await'),record=protocol(timeline[index]),harness=prefix(example,index+1);
  for(const [field,value]of [['receiver',['undefined']],['captureAliases',[]]]){
    const controller=Object.assign(Object.create(Object.getPrototypeOf(harness.controller)),structuredClone(harness.controller));
    controller.continuations.get(record.continuation)[field]=value;
    assert.throws(()=>restoreProtocolStateV8(controller,controller.protocol),/receiver or captured/);
  }
});

test('a changed async completion cannot acquire fresh source correspondence by rehashing',async()=>{
  const example=artifacts[0],forged=structuredClone(example.exported),row=forged.public.timeline.find(row=>protocol(row)?.kind==='async.complete'),
    record=protocol(row);
  record.completion.value=['num',99];row.fields.line=encodeProtocolRecordV8(record);
  forged.sidecar.publicDigest=hashAlgorithmData(forged.public);
  await assert.rejects(recheckProtocolRegionEvidence(forged),/source-certified|public differs|changed|projection/);
});

test('async event ownership is deterministic and cannot be duplicated before preparation',()=>{
  const bundle=archive(cases[2].source),forward=compileProtocolSourceV8(bundle);
  assert.deepEqual(compileProtocolSourceV8(bundle,{adapters:[...PROTOCOL_SOURCE_ADAPTERS_V8].reverse()}),forward);
  const async=createAsyncCallTeacherV8(),extensions=[async,createPromiseExecutorTeacherV8()];
  let live,before,eventId,prepared=0;
  extensions.push({id:'duplicate-async/1',claims:{event:async.claims.event},
    prepare:{event:()=>{prepared++;return {kind:'duplicate'};}},event(){throw new Error('must not run');}});
  for(const component of extensions)for(const kind of Object.keys(component.prepare??{})){
    const original=component.prepare[kind];component.prepare[kind]=(view,input)=>{
      if(eventId&&view.event?.eventId===eventId)prepared++;return original(view,input);
    };
  }
  assert.throws(()=>project(bundle,extensions,event=>event.operation==='call.enter'&&
    event.stateChanges.some(change=>change.table==='frames'&&change.before===null&&change.after?.asyncPromiseId),
  (harness,_adapter,event)=>{live=harness;before=snapshot(harness);eventId=event.eventId;}),/ambiguous owner/);
  assert(live);assert.equal(prepared,0);assert.deepEqual(snapshot(live),before);
});

test('an async observer failure rolls back detachment, caller scope and continuation identity',()=>{
  const bundle=archive(cases[2].source),async=createAsyncCallTeacherV8(),original=async.checkEvent,
    extensions=[async,createPromiseExecutorTeacherV8()];
  async.checkEvent=(ctx,event,row)=>event.operation==='async.await'?false:original(ctx,event,row);
  let live,before,adapter,states;
  assert.throws(()=>project(bundle,extensions,event=>event.operation==='async.await',(harness,current)=>{
    live=harness;before=snapshot(harness);adapter=current;
    states=structuredClone(Object.fromEntries(extensions.map(({id})=>[id,current.componentState(id)])));
  }),/observer failed|source state comparison|observer|state comparison/);
  assert(live);assert.deepEqual(snapshot(live),before);
  for(const {id}of extensions)assert.deepEqual(adapter.componentState(id),states[id],id);
});

test('owned async Promise returns are explicit while callbacks and thenables stay refused',()=>{
  const supported='"use strict";async function h(){return Promise.resolve(1);}async function run(){let order="";const adopted=h();adopted.then(()=>{order+="a";});Promise.resolve().then(()=>{order+="q";});await adopted;return order;}',
    runtime=createRuntime().startEntry({text:supported,functionName:'run',args:[],allowAsync:true});
  assert.deepEqual(originalOutcome(supported),'qa');
  runtime.drive();
  const projection=compileProtocolSourceV8(runtime.exportRun()),records=projection.claims
    .filter(row=>row.kind==='protocol').map(row=>row.record);
  assert.deepEqual(projection.outcome.graph.roots,[['str','qa']]);
  assert.deepEqual(records.filter(row=>row.kind==='async.resolve.enqueue').map(row=>row.kind),['async.resolve.enqueue']);
  assert.deepEqual(records.filter(row=>row.kind==='async.resolve.subscribe').map(row=>row.kind),['async.resolve.subscribe']);
  assert.deepEqual(records.filter(row=>row.kind==='async.resolve.settle').map(row=>row.kind),['async.resolve.settle']);
  const lookupMutations=[
    ['own Promise then override','async function target(){return 1;}async function run(){let order="";const p=target();p.then=function(resolve){order+="t";resolve(2);};async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}','t2'],
    ['own Promise then accessor','async function target(){return 1;}async function run(){let order="";const p=target();Object.defineProperty(p,"then",{get:function(){order+="g";return function(resolve){order+="t";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}','gt2'],
    ['Promise prototype then override','async function h(){return Promise.resolve(1);}async function run(){let order="";const original=Promise.prototype.then;Promise.prototype.then=function(resolve,reject){order+="t";return original.call(this,resolve,reject);};const adopted=h();await adopted;return order;}','t'],
    ['Promise.resolve override','async function h(){return Promise.resolve(1);}async function run(){Promise.resolve=function(value){return {then:function(resolve){resolve(value+1);}};};return await h();}',2],
    ['Promise.resolve shadow','async function h(Promise){return Promise.resolve(1);}async function run(){return await h({resolve:function(value){return Promise.resolve(value+1);}});}',2]
  ];
  for(const [name,source,expected]of lookupMutations){
    assert.deepEqual(originalOutcome(source),expected,name);
    const candidate=createRuntime().startEntry({text:'"use strict";'+source,functionName:'run',args:[],allowAsync:true});
    let refused=null;
    try{candidate.drive();compileProtocolSourceV8(candidate.exportRun());}catch(error){refused=error;}
    assert(refused,name+' was accepted without ordinary then lookup');
    assert.match(refused.message,/then lookup and resolver are unmodified|Not a writable guest object|Unsupported property receiver/,name);
    if(['own Promise then accessor','Promise.resolve shadow'].includes(name))
      assert.match(refused.message,/then lookup and resolver are unmodified/,name);
  }
  for(const source of [
    'function run(){return Promise.resolve(1).then(async function(x){await 0;return x;});}',
    'async function h(){return {then:function(resolve){resolve(1);}};}async function run(){return await h();}'
  ]){
    const runtime=createRuntime().startEntry({text:'"use strict";'+source,functionName:'run',args:[],allowAsync:true});runtime.drive();
    assert.throws(()=>compileProtocolSourceV8(runtime.exportRun()),/adoption|assimilation|thenable|then getter|explicit call protocol|async Promise callbacks/);
  }
});

test('plain async returns and unrelated object writes remain source-eligible',()=>{
  const controls=[
    ['async function h(o){o.x=2;return o.x;}async function run(){return await h({x:1});}',2],
    ['async function h(o){o.x=2;function inner(n){return n;}return inner(3);}async function run(){return await h({x:1});}',3]
  ];
  for(const [source,expected]of controls){
    assert.deepEqual(originalOutcome(source),expected);
    const runtime=createRuntime().startEntry({text:'"use strict";'+source,functionName:'run',args:[],allowAsync:true});
    runtime.drive();
    assert.deepEqual(compileProtocolSourceV8(runtime.exportRun()).outcome.graph.roots,[['num',expected]]);
  }
});

test('actual native async consumer replays every source context and restored continuation',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,cases.length);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
out=[]
for row in json.load(sys.stdin):
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
  nativeReceipts=JSON.parse(result.stdout);assert.equal(nativeReceipts.length,cases.length);
});

after(()=>{
  if(!process.env.RUNNER_TEMP)return;
  writeFileSync(join(process.env.RUNNER_TEMP,'nested-async-source-evidence.json'),JSON.stringify({
    schema:'nested-async-source-evidence/1',sourceCases:artifacts.length,actualNativeCases:nativeReceipts.length,
    generatedContexts:artifacts.reduce((total,row)=>total+row.exported.contexts.length,0),nativeReceipts,
    moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));
});
