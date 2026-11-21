import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from '../src/semantic/protocol-source-extensions-v8.js';
import {createSharedProtocolSourceComponentsV8} from '../src/semantic/protocol-source-bridge-v8.js';
import {protocolSourceClaimsV8} from '../src/semantic/protocol-source-claims-v8.js';
import {createPromiseExecutorTeacherV8} from '../src/semantic/protocol-promise-executor-source-v8.js';
import {createPromiseJoinTeacherV8} from '../src/semantic/protocol-promise-join-source-v8.js';
import {createEffectfulRegionAdapterV8} from '../src/semantic/effectful-teacher-v8.js';
import {compileSourceProjection} from '../src/semantic/source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from '../src/semantic/source-compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {sharedProtocolQualificationFixtures} from '../fixtures/semantic-regions/qualification.js';

const fixture=()=>sharedProtocolQualificationFixtures().find(row=>row.id==='promise-number-proxy-memory-join');
const memory='owned-binary-memory/1',number='primitive-conversion-source/1',proxy='ordinary-data-proxy-source/1',
  iterator='builtin-iterator/1',arrayMap='ordinary-array-map-source/1';
function archive(source=fixture().source){
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});
  runtime.drive();return runtime.exportRun();
}
function components(bundle,{change=()=>{}}={}){
  const source=bundle.sources.find(row=>row.sourceId===bundle.entrySpec.sourceId).text,
    adapters=PROTOCOL_SOURCE_ADAPTERS_V8.map(adapter=>typeof adapter==='function'?adapter({source,bundle}):adapter).filter(Boolean);
  change(adapters);
  return [createPromiseExecutorTeacherV8(),createPromiseJoinTeacherV8(),
    ...createSharedProtocolSourceComponentsV8({source,bundle,adapters})];
}
function snapshot(harness){return structuredClone({episode:harness.exportEpisode(),
  invocations:[...harness.invocations],realms:[...harness.realms]});}
function project(bundle,extensions,{target=()=>false,before=()=>{}}={}){
  const adapter=createEffectfulRegionAdapterV8({extensions});let live;
  const wrapped={...adapter,
    createHarness(options){live=adapter.createHarness(options);return live;},
    beginEvent(event,row,fact){if(event&&target(event,row))before(live,adapter,event,row);
      return adapter.beginEvent(event,row,fact);}};
  return compileSourceProjection(bundle,{regionAdapter:wrapped,projectionClient:SOURCE_PROJECTION_CLIENT_V8,
    semanticRegions:false,localStateCompaction:false,realmPolicy:'fresh',sessionId:'shared-protocol-source'});
}

test('Promise, Number, Proxy and binary events share deterministic source ownership and independent evidence',async()=>{
  const bundle=archive(),forward=compileProtocolSourceV8(bundle),
    reverse=compileProtocolSourceV8(bundle,{adapters:[...PROTOCOL_SOURCE_ADAPTERS_V8].reverse()});
  assert.deepEqual(reverse,forward);
  assert.equal(forward.sourceProfile,'composed-protocol-source/1');
  assert.deepEqual(forward.extensions,[number,proxy,memory,'promise-executor/1','promise-join/1'].sort());
  const kinds=new Set(forward.claims.filter(row=>row.kind==='protocol').map(row=>row.record.kind));
  for(const kind of ['promise.executor.enter','conversion.begin','conversion.call','proxy.get.call',
    'memory.construct','memory.set','memory.get','proxy.finish','conversion.return','promise.resolver.call','promise.join.step'])
    assert(kinds.has(kind),kind);
  const result=await verifyProtocolRegionTrainingCase(fixture());assert(result.exported,result.reason);
  const checked=await recheckProtocolRegionEvidence(result.exported);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  assert.equal(checked.source.reference.extensionAudit.status,'agreed');
  for(const annotation of ['binary-buffer','binary-view','proxy-target-handler/1'])
    assert(checked.source.reference.metadataAudit.extensionAnnotations.includes(annotation));
  const exported=result.exported,timeline=exported.public.timeline,
    cut=timeline.findIndex(row=>row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='memory.set')+1;
  const prefix=RegionExecutionHarness.replay({...exported.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
    resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint())));
  assert.equal(resumed.controller.protocol.primitiveConversions.operations.at(-1).phase,'waiting');
  assert.equal(resumed.controller.protocol.proxyCalls.pending.length,1);
  assert.equal(resumed.controller.protocol.promiseExecutors.executors.at(-1).phase,'running');
  for(const row of timeline.slice(cut))resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  const complete=RegionExecutionHarness.replay(exported);
  assert.deepEqual(complete.controller.completion,{kind:'return',value:['num',6]});
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(complete.controller));
});

test('Promise source projection composes map callbacks and iterator state through JSON checkpoint recovery',async()=>{
  const selected=sharedProtocolQualificationFixtures().find(row=>row.id==='promise-map-iterator'),
    source=selected.source,
    bundle=archive(source),forward=compileProtocolSourceV8(bundle),
    reverse=compileProtocolSourceV8(bundle,{adapters:[...PROTOCOL_SOURCE_ADAPTERS_V8].reverse()});
  assert.deepEqual(reverse,forward);
  assert.equal(forward.sourceProfile,'composed-protocol-source/1');
  assert(forward.extensions.includes(arrayMap));assert(forward.extensions.includes(iterator));
  const result=await verifyProtocolRegionTrainingCase(selected);
  assert(result.exported,result.reason);
  const checked=await recheckProtocolRegionEvidence(result.exported);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  assert.equal(checked.source.reference.status,'agreed');
  const claims=result.exported.sidecar.sourceArtifact.sidecar.compiler.claims,
    kinds=new Set(claims.filter(row=>row.kind==='protocol').map(row=>row.record.kind));
  for(const kind of ['promise.executor.enter','conversion.begin','proxy.get.call','memory.set','iterator.create',
    'iterator.next','call','promise.join','promise.join.step'])assert(kinds.has(kind),kind);
  assert.deepEqual(forward.outcome.graph.roots.at(-1),['num',10]);

  const timeline=result.exported.public.timeline,
    cut=timeline.findIndex(row=>row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='iterator.next')+1;
  assert(cut>0,'the recovery point follows an actual iterator transition');
  const prefix=RegionExecutionHarness.replay({...result.exported.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
    packet=JSON.parse(JSON.stringify(prefix.checkpoint())),resumed=RegionExecutionHarness.restore(packet);
  assert([...resumed.controller.heap.values()].some(node=>node.kind==='iterator'));
  assert(resumed.controller.stack.some(invocation=>invocation.startsWith('guest')),
    'the checkpoint preserves the active map callback invocation');
  assert.equal(resumed.controller.protocol.promiseExecutors.executors.at(-1).phase,'running');
  assert.deepEqual(resumed.modelContext('invocation1'),prefix.modelContext('invocation1'));
  for(const row of timeline.slice(cut))resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(RegionExecutionHarness.replay(result.exported).controller));
});

test('a Promise/map interaction keeps the current callback argument across source array mutation',async()=>{
  const source='"use strict";async function run(){const result=new Promise(resolve=>{const array=[1,2];'+
    'const mapped=array.map(function(value){array[0]=9;return value;});resolve(mapped[0]);});return await result;}';
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'promise-map-live-mutation'});
  assert(result.exported,result.reason);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).valid,true);
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind:'return',value:['num',1]});
});

test('missing or ambiguous shared family ownership fails before preparation or publication',()=>{
  const bundle=archive(),target=event=>event.operation==='object.construct'&&event.operands[0]?.[1]==='Uint8Array';
  for(const ambiguous of [false,true]){
    let live,before,eventId,prepared=0;
    const extensions=components(bundle).filter(component=>ambiguous||component.id!==memory);
    if(ambiguous)extensions.push({id:'duplicate-memory/1',claims:{event:protocolSourceClaimsV8(memory).event},
      prepare:{event:()=>{prepared++;return {kind:'duplicate'};}},event(){throw new Error('must not execute');}});
    for(const component of extensions)for(const kind of Object.keys(component.prepare??{})){
      const original=component.prepare[kind];component.prepare[kind]=(view,input)=>{
        assert(Object.isFrozen(view));assert(Object.isFrozen(view.owned));
        if(eventId&&view.event?.eventId===eventId)prepared++;return original(view,input);
      };
    }
    assert.throws(()=>project(bundle,extensions,{target,before(harness,_adapter,event){
      live=harness;before=snapshot(live);eventId=event.eventId;
    }}),ambiguous?/ambiguous owner/:/missing owner/);
    assert(live);assert.equal(prepared,0);assert.deepEqual(snapshot(live),before);
  }
});

test('a declined Proxy handler cannot publish nested call state or consume family identities',()=>{
  const bundle=archive(),extensions=components(bundle),component=extensions.find(row=>row.id===proxy),original=component.event;
  let live,before,adapter,states,attempted=false;
  const target=(event,row)=>event.operation==='property.read'&&Boolean(row?.child);
  component.event=(ctx,event,row,prepared)=>{
    const accepted=original(ctx,event,row,prepared);
    if(!target(event,row))return accepted;
    attempted=true;
    assert.equal(ctx.controller(ctx.rootInvocation).protocol.proxyCalls.pending.length,1);
    assert.equal(live.invocations.get(ctx.rootInvocation).controller.protocol.proxyCalls?.pending.length??0,0);
    assert.equal(ctx.componentState(proxy).active.length,1);
    return false;
  };
  assert.throws(()=>project(bundle,extensions,{target,before(harness,current){
    live=harness;adapter=current;before=snapshot(live);
    states=structuredClone(Object.fromEntries(extensions.map(({id})=>[id,current.componentState(id)])));
  }}),/claimed source handler declined/);
  assert(attempted);assert.deepEqual(snapshot(live),before);
  for(const {id}of extensions)assert.deepEqual(adapter.componentState(id),states[id],id);
  assert.deepEqual(compileProtocolSourceV8(bundle).outcome.graph.roots.at(-1),['num',6]);
});

test('a failed binary backing comparison rolls back every active family and still runs later observers',()=>{
  const bundle=archive(),calls=[];
  const extensions=components(bundle,{change(adapters){
    const index=adapters.findIndex(adapter=>adapter.id===memory),original=adapters[index];
    adapters[index]={...original,checkHeap(ctx,node){
      const accepted=original.checkHeap(ctx,node);
      if(node.kind==='array-buffer'&&node.bytes[0]===3){calls.push('reject-memory');return false;}
      return accepted;
    }};
  }});
  let live,before,adapter,states;
  const target=event=>event.operation==='property.write'&&event.stateChanges.some(change=>change.table==='heap'&&change.after?.kind==='array-buffer');
  extensions.push({id:'z-later-observer/1',observes:(_view,{event})=>target(event),
    checkEvent(ctx){calls.push('later');assert.equal(ctx.componentState(proxy).active.length,1);return true;}});
  assert.throws(()=>project(bundle,extensions,{target,before(harness,current){
    live=harness;adapter=current;before=snapshot(live);
    states=structuredClone(Object.fromEntries(extensions.map(({id})=>[id,current.componentState(id)])));
  }}),/shared protocol heap comparison failed/);
  assert.deepEqual(calls,['reject-memory','later']);assert.deepEqual(snapshot(live),before);
  for(const {id}of extensions)assert.deepEqual(adapter.componentState(id),states[id],id);
});

test('one thrown callback unwinds Proxy, Number and executor completions through their exact owners',async()=>{
  const source='"use strict";async function run(){const p=new Promise(resolve=>{'+
    'const proxy=new Proxy({x:3},{get:function(){throw 7;}});'+
    'resolve(Number({valueOf:function(){return proxy.x;}}));});try{return await p;}catch(e){return e+1;}}';
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'shared-protocol-abrupt'});
  assert(result.exported,result.reason);
  const claims=result.exported.sidecar.sourceArtifact.sidecar.compiler.claims,
    group=new Map();
  for(const claim of claims)for(const event of claim.certificate.journalEvents){
    if(!group.has(event))group.set(event,[]);group.get(event).push(claim.record.kind);
  }
  assert([...group.values()].some(kinds=>['proxy.finish','conversion.throw','promise.executor.finish'].every(kind=>kinds.includes(kind))));
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion.value,['num',8]);
});

test('shared discovery is static and does not loosen unrelated continuation or construction gates',()=>{
  const source=fixture().source,bundle={programs:{},get events(){throw new Error('future events cannot choose components');}},
    adapters=PROTOCOL_SOURCE_ADAPTERS_V8.map(adapter=>typeof adapter==='function'?adapter({source,bundle}):adapter).filter(Boolean);
  assert.deepEqual(createSharedProtocolSourceComponentsV8({source,bundle,adapters}).map(row=>row.id).sort(),[number,proxy,memory].sort());
  const asynchronous='"use strict";async function run(){const values=await Promise.all([2]);return Number({valueOf:function(){return values[0];}});}';
  assert.throws(()=>compileProtocolSourceV8(archive(asynchronous)),/async conversion requires its own profile/);
  const construction='"use strict";async function run(){const p=new Promise(resolve=>{class Box{constructor(){this.x=1;}}resolve(new Box().x);});return await p;}';
  assert.throws(()=>compileProtocolSourceV8(archive(construction)),/class\/private|construction|prototype/);
});
