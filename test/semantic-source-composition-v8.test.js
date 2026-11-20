import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileSourceProjection} from '../src/semantic/source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from '../src/semantic/source-compiler-v8.js';
import {createEffectfulRegionAdapterV8} from '../src/semantic/effectful-teacher-v8.js';
import {createPromiseExecutorTeacherV8,createPromiseExecutorSourceAdapterV8} from '../src/semantic/protocol-promise-executor-source-v8.js';
import {createPromiseJoinTeacherV8,createPromiseJoinSourceAdapterV8} from '../src/semantic/protocol-promise-join-source-v8.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {sourcePromiseConstructorV8,sourcePromiseJoinEventV8} from '../src/semantic/source-projection-base-v8.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const source='"use strict";async function run(){let total=1;const p=new Promise(resolve=>{function add(x){total+=x;return total;}resolve(add(3));});const values=await Promise.all([p,Promise.resolve(2)]);return values[0]+values[1]+total;}';
function owned(text=source){const machine=createRuntime().startEntry({text,functionName:'run',args:[],allowAsync:true});
  machine.drive();return machine.exportRun();}
const peers=()=>[createPromiseExecutorTeacherV8(),createPromiseJoinTeacherV8()];
function snapshot(harness){return structuredClone({episode:harness.exportEpisode(),invocations:[...harness.invocations],
  intents:[...harness.intents],handlers:[...harness.handlers],realms:[...harness.realms],callbacks:[...harness.callbacks]});}
function project(bundle,extensions,{target=()=>false,before=()=>{}}={}){
  const adapter=createEffectfulRegionAdapterV8({extensions});let live;
  const wrapped={...adapter,
    createHarness(options){live=adapter.createHarness(options);return live;},
    beginEvent(event,row,fact){if(event&&target(event,row))before(live,adapter,event,row);
      return adapter.beginEvent(event,row,fact);}};
  return compileSourceProjection(bundle,{regionAdapter:wrapped,projectionClient:SOURCE_PROJECTION_CLIENT_V8,
    semanticRegions:false,localStateCompaction:false,realmPolicy:'fresh',sessionId:'source-composition'});
}

test('executor, join and ordinary event owners compose independently of registry order',()=>{
  const bundle=owned(),first=project(bundle,peers()),second=project(bundle,peers().reverse());
  assert.deepEqual(first,second);
  const operations=first.exported.public.timeline.filter(row=>row.kind==='protocol')
    .map(row=>decodeProtocolRecordV8(row.fields.line).kind);
  for(const kind of ['promise.executor.enter','promise.resolver.call','promise.executor.finish','promise.join','promise.join.step','call','return'])
    assert(operations.includes(kind),kind);
  const replay=RegionExecutionHarness.replay(first.exported);
  assert.deepEqual(replay.controller.completion.value,['num',10]);
  assert.deepEqual(sharedRegionState(RegionExecutionHarness.restore(JSON.parse(JSON.stringify(replay.checkpoint()))).controller),
    sharedRegionState(replay.controller));
  const adapters=[createPromiseExecutorSourceAdapterV8,createPromiseJoinSourceAdapterV8];
  const routed=compileProtocolSourceV8(bundle,{adapters});
  assert.deepEqual(compileProtocolSourceV8(bundle,{adapters:adapters.reverse()}),routed);
  assert.deepEqual(routed.extensions,['promise-executor/1','promise-join/1']);
});

test('missing and ambiguous event owners fail before preparation and preserve the live prefix',()=>{
  const bundle=owned();
  for(const ambiguous of [false,true]){
    let live,before,eventPreparations=0,targetEvent=null;
    const extensions=ambiguous?peers():[createPromiseExecutorTeacherV8()];
    if(ambiguous)extensions.push({id:'duplicate-join/1',claims:{event:sourcePromiseJoinEventV8},
      prepare:{event:()=>{eventPreparations++;return {kind:'duplicate'};}},event(){throw new Error('must not run');}});
    for(const component of extensions)for(const kind of Object.keys(component.prepare??{})){
      const prepare=component.prepare[kind];component.prepare[kind]=(view,input)=>{
        if(view.event?.eventId===targetEvent)eventPreparations++;
        return prepare(view,input);
      };
    }
    assert.throws(()=>project(bundle,extensions,{target:event=>event.operation==='call.enter'&&
      event.operands[0]?.[1]?.[1]==='Promise.all',before(harness,_adapter,event){
      live=harness;before=snapshot(live);targetEvent=event.eventId;
    }}),ambiguous?/ambiguous owner/:/missing owner/);
    assert(live);assert.equal(eventPreparations,0);
    assert.deepEqual(snapshot(live),before);
  }
});

test('a claimed handler cannot publish its Promise prelude or component mutation before success',()=>{
  const bundle=owned(),extensions=peers(),executor=extensions[0],original=executor.event;
  let live,before,adapter,stagedPromise,attempted=false;
  executor.event=(ctx,event,row,prepared)=>{
    if(!sourcePromiseConstructorV8(event))return original(ctx,event,row,prepared);
    attempted=true;
    stagedPromise=event.stateChanges.find(change=>change.table==='promises'&&change.before===null).id;
    assert(ctx.controller(ctx.rootInvocation).heap.has(stagedPromise),'prelude runs in detached state');
    assert(!live.invocations.get(ctx.rootInvocation).controller.heap.has(stagedPromise),'prelude is not public yet');
    ctx.componentState(executor.id).uncommitted=true;
    return false;
  };
  assert.throws(()=>project(bundle,extensions,{target:sourcePromiseConstructorV8,before(harness,componentAdapter){
    live=harness;adapter=componentAdapter;before=snapshot(live);
  }}),/claimed source handler declined/);
  assert(attempted);assert.deepEqual(snapshot(live),before);
  assert.equal(adapter.componentState(executor.id).uncommitted,undefined);
});

test('all applicable observers run and a rejected postcondition leaves the current event unpublished',()=>{
  const calls=[],extensions=peers();let live,before,eventId;
  for(const id of ['z-observer/1','a-observer/1'])extensions.push({id,
    observes(view,{event}){
      assert(Object.isFrozen(view));assert(Object.isFrozen(view.owned));
      return sourcePromiseConstructorV8(event);
    },checkEvent(ctx,event){
      calls.push(id);assert.equal(event.eventId,eventId);
      assert(ctx.controller(ctx.rootInvocation).protocol.promiseExecutors.executors.length>0);
      return id!=='a-observer/1';
    }});
  assert.throws(()=>project(owned(),extensions,{target:sourcePromiseConstructorV8,before(harness,_adapter,event){
    live=harness;before=snapshot(live);eventId=event.eventId;
  }}),/complete source-state comparison failed: a-observer/);
  assert.deepEqual(calls,['a-observer/1','z-observer/1']);assert.deepEqual(snapshot(live),before);
});

test('one owned throw independently assigns helper, executor and ordinary completion slots',()=>{
  const text='"use strict";async function run(){const p=new Promise(resolve=>{function fail(){throw 7;}fail();});try{return await Promise.all([p]);}catch(e){return e+1;}}',
    output=project(owned(text),peers()),timeline=output.exported.public.timeline,
    completionGroups=new Map();
  for(const certificate of output.certificates){
    const row=timeline[certificate.sequence-1];if(row.kind!=='protocol')continue;
    const record=decodeProtocolRecordV8(row.fields.line);
    if(!['throw','promise.executor.finish'].includes(record.kind))continue;
    for(const event of certificate.journalEvents){if(!completionGroups.has(event))completionGroups.set(event,[]);
      completionGroups.get(event).push(record.kind);}
  }
  assert([...completionGroups.values()].some(kinds=>kinds.includes('throw')&&kinds.includes('promise.executor.finish')));
  assert.deepEqual(RegionExecutionHarness.replay(output.exported).controller.completion.value,['num',8]);
});

test('component discovery reads static source syntax without looking at future owned events',()=>{
  const bundle={get events(){throw new Error('future journal must not be inspected');}},
    text='"use strict";async function run(use){const a=1;if(use){return await Promise.all([new Promise(done=>done(a))]);}return a;}';
  assert.equal(createPromiseExecutorSourceAdapterV8({source:text,bundle}).id,'promise-executor/1');
  assert.equal(createPromiseJoinSourceAdapterV8({source:text,bundle}).id,'promise-join/1');
  assert.equal(createPromiseExecutorSourceAdapterV8({source:'function run(){return 1;}',bundle}),null);
  assert.equal(createPromiseJoinSourceAdapterV8({source:'function run(){return 1;}',bundle}),null);
});

test('source handlers require explicit success and observer applicability requires a boolean',()=>{
  const bundle=owned();
  for(const invalid of [undefined,null,0,1,'accepted',{}]){
    const extensions=peers(),executor=extensions[0],original=executor.event;let live,before;
    executor.event=(ctx,event,row,prepared)=>sourcePromiseConstructorV8(event)?invalid:original(ctx,event,row,prepared);
    assert.throws(()=>project(bundle,extensions,{target:sourcePromiseConstructorV8,before(harness){
      live=harness;before=snapshot(live);
    }}),/claimed source handler declined/);
    assert.deepEqual(snapshot(live),before);
  }
  for(const invalid of [undefined,null,1]){
    let live,before,ran=false;
    const observer={id:'invalid-observer/1',observes:(_view,{event})=>sourcePromiseConstructorV8(event)?invalid:false,
      checkEvent(){ran=true;return true;}};
    assert.throws(()=>project(bundle,[...peers(),observer],{target:sourcePromiseConstructorV8,before(harness){
      live=harness;before=snapshot(live);
    }}),/observer applicability must return a boolean/);
    assert.equal(ran,false);assert.deepEqual(snapshot(live),before);
  }
});

test('a failed context copy cannot partially publish a prepared source event',async()=>{
  // Import a separate instance with a controllable clone fault. Production
  // still uses structuredClone; the injected allocation failure occurs only
  // at the final context copy, after the staged transition has succeeded.
  const nativeClone=globalThis.structuredClone;let rejectContextCopy=false,isolated;
  globalThis.structuredClone=value=>{
    if(rejectContextCopy&&Array.isArray(value)&&value[0]?.schema==='semantic-context/8')
      throw new RangeError('injected context copy failure');
    return nativeClone(value);
  };
  try{isolated=await import('../src/semantic/effectful-teacher-v8.js?context-copy-fault');}
  finally{globalThis.structuredClone=nativeClone;}
  const adapter=isolated.createEffectfulRegionAdapterV8(),live=adapter.createHarness({sessionId:'copy-fault'});
  live.publishProgram({programId:'program1',source:'"use strict";function run(){return 1;}',entry:'run',capabilities:[]});
  live.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'copy-fault-entry',inputGraph:{roots:[],objects:[]},realmPolicy:'fresh'});
  const before=snapshot(live),staged=live.fork();
  staged.prepareModelContext('invocation1');
  staged.selected('invocation1',SOURCE_PROJECTION_CLIENT_V8.encodeRecord('bind',{name:'saved',value:['num',3]}));
  rejectContextCopy=true;
  assert.throws(()=>live.commitPrepared(staged),/injected context copy failure/);
  rejectContextCopy=false;
  assert.deepEqual(snapshot(live),before);
  live.commitPrepared(staged);
  assert.deepEqual(snapshot(live),snapshot(staged));
  // A subsequent fork sees the newly committed context array through the
  // facade's live binding, rather than stale preparation metadata.
  assert.deepEqual(snapshot(live.fork()),snapshot(live));
});
