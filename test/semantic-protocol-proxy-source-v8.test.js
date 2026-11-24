import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {instrumentCompletionSource,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {createProxyObservationAdapterV8} from '../src/semantic/protocol-proxy-observations-v8.js';
import {createProtocolCompletionCapture,ownedProtocolSourceObservations} from '../src/semantic/protocol-source-observations-v8.js';
import {compareProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const source=body=>'"use strict";function run(){'+body+'}';
function archive(text){const runtime=createRuntime().startEntry({text,functionName:'run',args:[]});runtime.drive();return runtime.exportRun();}
function observed(text){
  const adapter=createProxyObservationAdapterV8({source:text}),capture=createProtocolCompletionCapture({adapters:[adapter.metadataAdapter]});
  const context=vm.createContext({...adapter.globals,[COMPLETION_HOOK]:capture.capture});
  capture.setIntrinsicPrototypes(vm.runInContext('[Object.prototype,Array.prototype,Function.prototype]',context));
  adapter.initializeRealm(expression=>vm.runInContext(expression,context));
  const result=vm.runInContext(adapter.instrument(instrumentCompletionSource(text))+';run()',context);
  return {result,capture,adapter};
}
const fixture=body=>({source:source(body),entry:'run',family:'ordinary-proxy-source',timeoutMs:30000});

test('independent Proxy metadata records native target/handler identities without replacing source objects',()=>{
  const text=source('const target={x:2},handler={get:null,set:null};const proxy=new Proxy(target,handler);'+
    'const first=proxy.x;target.x=4;const second=proxy.x;proxy.self=proxy;proxy.x=7;return [first,second,target.x,proxy===target,proxy.self===proxy];');
  const native=observed(text),owned=ownedProtocolSourceObservations(archive(text),text,{adapters:[createProxyObservationAdapterV8]});
  assert.deepEqual(structuredClone(native.result),[2,4,7,false,true]);
  assert.deepEqual(owned.completions,native.capture.observations);
  assert.deepEqual(owned.extensionObservations,[{profile:native.adapter.id,rows:native.adapter.observations()}]);
  assert.equal(compareProtocolMetadata(owned.metadata,native.capture.metadata).status,'agreed');
  const proxy=native.capture.metadata.flatMap(row=>row.objects).find(node=>node.kind==='proxy');assert(proxy);
  assert.equal(proxy.annotations[0].name,'proxy-target-handler/1');assert.notDeepEqual(proxy.annotations[0].values[0],proxy.annotations[0].values[1]);
});

test('unregistered native Proxies are refused before any metadata trap or unrelated observer runs',()=>{
  let calls=0;
  const adapter=createProxyObservationAdapterV8({source:source('return new Proxy({},{});')}),
    capture=createProtocolCompletionCapture({adapters:[adapter.metadataAdapter,{nativeNode(){calls++;return {kind:'function'};}}]});
  const proxy=new Proxy({}, {getPrototypeOf(){calls++;return Object.prototype;},ownKeys(){calls++;return [];}});
  assert.throws(()=>capture.capture('site','initialize',proxy),/registered profile/);assert.equal(calls,0);
});

test('a matching scalar cannot hide a different Proxy target in independent identity metadata',()=>{
  const text=source('const target={x:2},decoy={x:2},handler={};const proxy=new Proxy(target,handler);return 1;'),
    bundle=archive(text),native=observed(text),mutant=structuredClone(bundle);
  const targets=Object.values(bundle.finalState.heap).filter(node=>node.kind==='object'&&node.properties.x?.value?.[1]===2),
    proxy=Object.values(bundle.finalState.heap).find(node=>node.kind==='proxy'),decoy=targets.find(node=>node.id!==proxy.targetId);
  assert(decoy);
  for(const state of [mutant.initialState,mutant.finalState])if(state.heap[proxy.id])state.heap[proxy.id].targetId=decoy.id;
  for(const event of mutant.events)for(const patch of event.stateChanges)if(patch.table==='heap'&&patch.id===proxy.id)
    for(const node of [patch.before,patch.after])if(node)node.targetId=decoy.id;
  const owned=ownedProtocolSourceObservations(mutant,text,{adapters:[createProxyObservationAdapterV8]});
  assert.deepEqual(owned.completions,native.capture.observations);
  assert.equal(compareProtocolMetadata(owned.metadata,native.capture.metadata).status,'mismatch');
});

test('source-qualified Proxy access composes with compact computation and exact checkpoint continuation',async()=>{
  const body='const before=1+2;const target={x:2},handler={get:null,set:null};const proxy=new Proxy(target,handler);'+
    'const first=proxy.x;target.x=4;const second=proxy.x;proxy.x=7;const after=first+second;return before+after+target.x;';
  const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const artifact=result.exported;assert(artifact.sidecar.protocolExtensions.includes('ordinary-data-proxy-source/1'));
  assert(artifact.sidecar.regionCoverage.compactRegions>=2);
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
  assert.deepEqual(RegionExecutionHarness.replay(artifact).controller.completion,{kind:'return',value:['num',16]});
  const cut=artifact.public.timeline.findIndex(row=>row.fields?.line?.includes('"kind":"proxy.set"'))+1;assert(cut>2);
  const prefix={...artifact.public,timeline:artifact.public.timeline.slice(0,cut)},partial=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    packet=JSON.parse(JSON.stringify(partial.checkpoint())),restored=RegionExecutionHarness.restore(packet);
  for(const row of artifact.public.timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(restored.exportEpisode(),artifact.public);
  const changed=structuredClone(packet),node=changed.selected.invocations[0][1].state.heap.find(([,node])=>node.kind==='proxy')[1];
  node.target=node.handler;const {integrity,...rest}=changed;changed.integrity=hashAlgorithmData(rest);
  assert.throws(()=>RegionExecutionHarness.restore(changed),/exact public shared state/);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
});

test('source Proxy profile preserves empty/null handlers, symbol keys and alias writes',async()=>{
  for(const body of [
    'const target={x:2};const proxy=new Proxy(target,{});proxy.x=7;return target.x;',
    'const target={x:2};const proxy=new Proxy(target,{get:null,set:null});proxy.x=7;return proxy.x;',
    'const key=Symbol("x");const target={[key]:2};const proxy=new Proxy(target,{});target[key]=4;proxy[key]=7;return target[key];',
    'const target=Object.create(null);target.x=2;const handler=Object.create(null);const proxy=new Proxy(target,handler);proxy.x=7;return proxy.x;',
    'const proxy=new Proxy({x:2},{getPrototypeOf:0,has:null});return "x" in proxy;'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
    const completion=RegionExecutionHarness.replay(result.exported).controller.completion;
    assert(['num','bool'].includes(completion.value[0]));
  }
});

test('independent Proxy observations cover has/delete order, raw values and retained selection',()=>{
  const text=source('let order="";const target={x:2},handler={};const key={get [Symbol.toPrimitive](){'+
    'order+="g";return function(hint){order+="c"+hint;return "x";};}};'+
    'handler.has=function(t,k){order+="h"+k;handler.has=null;delete t[k];return 0;};'+
    'handler.deleteProperty=function(t,k){order+="d"+k;return "yes";};'+
    'const proxy=new Proxy(target,handler);const present=key in proxy;'+
    'const deleted=delete proxy[key];return [present,deleted,order,handler.has,target.x];'),
    native=observed(text),owned=ownedProtocolSourceObservations(archive(text),text,{adapters:[createProxyObservationAdapterV8]});
  assert.deepEqual(structuredClone(native.result),[false,true,'gcstringhxgcstringdx',null,undefined]);
  assert.deepEqual(owned.completions,native.capture.observations);
  assert.deepEqual(owned.extensionObservations,[{profile:native.adapter.id,rows:native.adapter.observations()}]);
  assert.equal(compareProtocolMetadata(owned.metadata,native.capture.metadata).status,'agreed');
  assert.deepEqual(native.adapter.observations().map(row=>row.kind),
    ['create','select','call','return','select','call','return']);
  assert.deepEqual(native.adapter.observations().filter(row=>row.kind==='select').map(row=>row.operation),['has','delete']);
});

test('source-qualified Proxy has/delete preserve object-key conversion ordering and native fault identity',async()=>{
  const objectKey='let order="";const target={x:1},handler={};const key={get [Symbol.toPrimitive](){order+="g";'+
    'return function(hint){order+="c"+hint;return "x";};}};'+
    'handler.has=function(t,k){order+="h"+k;handler.has=null;delete t[k];return 0;};'+
    'handler.deleteProperty=function(t,k){order+="d"+k;return "yes";};'+
    'const proxy=new Proxy(target,handler);const present=key in proxy;const deleted=delete proxy[key];'+
    'return [present,deleted,order,target.x,handler.has];';
  const ordered=await verifyProtocolRegionTrainingCase(fixture(objectKey));assert(ordered.exported,ordered.reason);
  const orderedReference=ordered.exported.sidecar.sourceArtifact.sidecar.reference;
  assert.equal(orderedReference.status,'agreed');
  assert.equal(orderedReference.extensionAudit.status,'agreed');
  assert.equal(orderedReference.metadataAudit.status,'agreed');
  assert(ordered.exported.sidecar.protocolExtensions.includes('ordinary-data-proxy-source/1'));

  const constructorArrow="class A{};class D extends A{#x=5;constructor(){const has=(t,k)=>"+
    "this.#x===5&&new.target===D&&k==='x';super();return {has};}}"+
    "const handler=new D();const proxy=new Proxy({x:1},handler);return 'x' in proxy;";
  const receiver=await verifyProtocolRegionTrainingCase(fixture(constructorArrow));assert(receiver.exported,receiver.reason);
  assert.equal(receiver.exported.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  assert.deepEqual(RegionExecutionHarness.replay(receiver.exported).controller.completion,{kind:'return',value:['bool',true]});

  for(const body of [
    'const proxy=new Proxy({}, {deleteProperty:function(){return false;}});try{delete proxy.x;return "none";}catch(error){return [error.name,error.message];}',
    'const target={};Object.defineProperty(target,"x",{value:1,configurable:false});const proxy=new Proxy(target,{});'+
      'try{delete proxy.x;return "none";}catch(error){return [error.name,error.message];}',
    'const target={};Object.defineProperty(target,"x",{value:1,configurable:false});'+
      'const proxy=new Proxy(target,{has:function(){return false;}});'+
      'try{return "x" in proxy;}catch(error){return [error.name,error.message];}',
    'const target={x:1};Object.preventExtensions(target);const proxy=new Proxy(target,{has:function(){return false;}});'+
      'try{return "x" in proxy;}catch(error){return error.message;}',
    'const target={x:1};Object.preventExtensions(target);'+
      'const proxy=new Proxy(target,{deleteProperty:function(){return true;}});'+
      'try{delete proxy.x;return "none";}catch(error){return error.message;}',
    'const reason={tag:7};const proxy=new Proxy({}, {has:function(){throw reason;}});'+
      'try{return "x" in proxy;}catch(error){return error===reason;}'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
    const reference=result.exported.sidecar.sourceArtifact.sidecar.reference;
    assert.equal(reference.status,'agreed');assert.equal(reference.extensionAudit.status,'agreed');
    assert.equal(reference.metadataAudit.status,'agreed');
  }
});

test('Proxy source fault receipts reject an unrelated Error property origin',()=>{
  const text=source('const proxy=new Proxy({}, {deleteProperty:function(){return false;}});'+
    'try{delete proxy.x;return "none";}catch(error){return error.message;}'),bundle=archive(text),
    event=bundle.events.find(row=>row.operation==='call.return'&&row.stateChanges.some(change=>
      change.table==='heap'&&change.before===null&&change.after?.declaredError==='TypeError'));
  assert(event);
  const unrelated=bundle.events.find(row=>row.eventId!==event.eventId).eventId,
    errorId=event.stateChanges.find(change=>change.table==='heap'&&change.after?.declaredError==='TypeError').id;
  for(const change of event.stateChanges)if(change.table==='heap'&&change.id===errorId&&change.after){
    change.after.properties.message.origin=unrelated;
  }
  for(const state of [bundle.finalState,...Object.values(bundle.checkpoints)])if(state.heap[errorId]){
    state.heap[errorId].properties.message.origin=unrelated;
  }
  // Exact source replay may reject the causal forgery before adapter projection.
  assert.throws(()=>compileProtocolSourceV8(bundle),/Replay divergence: semantic event|source origin/);
});

test('Proxy source deletion authenticates the caller strict mode',()=>{
  const bundle=archive(source('const proxy=new Proxy({}, {deleteProperty:function(){return false;}});'+
    'try{delete proxy.x;return \"none\";}catch(error){return error.message;}'));
  let changes=0;
  const alter=node=>{if(node?.pendingProperty?.kind==='delete'&&node.pendingProperty.proxy){
    node.pendingProperty.proxy.strict=false;changes++;
  }};
  for(const state of [bundle.initialState,bundle.finalState,...Object.values(bundle.checkpoints)])
    for(const node of Object.values(state.frames))alter(node);
  for(const event of bundle.events)for(const change of event.stateChanges)if(change.table==='frames'){
    alter(change.before);alter(change.after);
  }
  assert(changes>0);
  assert.throws(()=>compileProtocolSourceV8(bundle),/Replay divergence: semantic event|strict-delete context/);
});

test('strict false-set callback errors are source-qualified with the native message',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture('const proxy=new Proxy({}, {set:function(){return false;}});'+
    'try{proxy.x=7;return "missed";}catch(error){return error.message;}'));
  assert(result.exported,result.reason);
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,
    {kind:'return',value:['str',"'set' on proxy: trap returned falsish for property 'x'"]});
});

test('transparent nested target routes retain the original receiver and selected inner owner',async()=>{
  const body='let order="";const target={x:2};let outer=null;'+
    'const handler={get:function(t,k,r){order+="g";return r===outer?t[k]+1:-1;},'+
    'has:function(t,k){order+="h";return k==="x";},'+
    'deleteProperty:function(t,k){order+="d";return k==="y";}};'+
    'const inner=new Proxy(target,handler);outer=new Proxy(inner,{});'+
    'return outer.x+("x" in outer?10:0)+(delete outer.y?100:0)+target.x;';
  const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const artifact=result.exported,reference=artifact.sidecar.sourceArtifact.sidecar.reference,
    replay=RegionExecutionHarness.replay(artifact);
  assert.deepEqual(replay.controller.completion,{kind:'return',value:['num',115]});
  assert.equal(reference.status,'agreed');assert.equal(reference.extensionAudit.status,'agreed');
  assert.equal(reference.metadataAudit.status,'agreed');
  assert(artifact.sidecar.protocolExtensions.includes('ordinary-data-proxy-source/1'));
  const bundle=archive(source(body)),proxies=Object.values(bundle.finalState.heap).filter(node=>node.kind==='proxy'),
    inner=proxies.find(node=>bundle.finalState.heap[node.targetId]?.kind==='object'),
    outer=proxies.find(node=>node.targetId===inner?.id),
    event=bundle.events.find(row=>row.operation==='property.read'&&row.stateChanges.some(change=>
      change.table==='frames'&&change.after?.pendingProperty?.proxy)),
    pending=event?.stateChanges.find(change=>change.table==='frames'&&change.after?.pendingProperty?.proxy)?.after.pendingProperty.proxy;
  assert(inner&&outer&&pending);
  assert.equal(pending.owner,inner.id);
  assert.deepEqual(pending.object,['ref',outer.id]);
  assert.deepEqual(pending.route.map(row=>row.object),[outer.id,inner.id]);
});

test('unsupported Proxy traps, accessor targets, nesting and callable profiles remain explicit source refusals',async()=>{
  for(const body of [
    'return new Proxy({x:2},{get:async function(){return 2;}}).x;',
    'return new Proxy({x:2},{get:function*(){yield 2;}}).x;',
    'return new Proxy({get x(){return 2;}},{}).x;',
    'const target=new Proxy({x:2},{get:function(){return 3;}});return new Proxy(target,{get:function(){return 4;}}).x;',
    'return new Proxy({x:2},{get get(){return function(){return 2;};}}).x;',
    'return new Proxy(function(){return 2;},{})();'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.status,'unsupported',result.reason);
    assert(!result.exported);assert.equal(result.regionDisposition,'source-unqualified');
  }
});

test('independent native trap receipts preserve method selection, original receiver and live replacement order',()=>{
  const text=source('const target={x:2},handler={};let proxy=null;let calls=0;'+
    'const second=function(t,k,r){calls++;return this===handler&&r===proxy?t[k]+2:0;};'+
    'handler.get=function(t,k,r){calls++;handler.get=second;return this===handler&&r===proxy?t[k]+1:0;};'+
    'handler.set=function(t,k,v,r){calls++;t[k]=v+3;return this===handler&&r===proxy;};'+
    'proxy=new Proxy(target,handler);const a=proxy.x,b=proxy.x;const assigned=(proxy.x=4);return [a,b,assigned,target.x,calls];');
  const native=observed(text),owned=ownedProtocolSourceObservations(archive(text),text,{adapters:[createProxyObservationAdapterV8]});
  assert.deepEqual(structuredClone(native.result),[3,4,4,7,3]);
  assert.deepEqual(owned.completions,native.capture.observations);
  assert.equal(compareProtocolMetadata(owned.metadata,native.capture.metadata).status,'agreed');
  const rows=native.adapter.observations();
  assert.deepEqual(owned.extensionObservations,[{profile:native.adapter.id,rows}]);
  assert.deepEqual(rows.map(row=>row.kind),['create','select','call','return','select','call','return','select','call','return']);
  assert.notDeepEqual(rows[2].method,rows[5].method);
  assert.deepEqual(rows[2].receiver,rows[0].handler);
  assert.deepEqual(rows[2].arguments[0],rows[0].target);
  assert.deepEqual(rows[2].arguments[2],rows[0].object);
});

test('trap observations reject wrong receivers or arguments even when an unused-argument callback returns the same scalar',()=>{
  const text=source('const target={x:2},handler={get:function(t,k,r){return 7;}};const proxy=new Proxy(target,handler);return proxy.x;'),
    bundle=archive(text),event=bundle.events.find(event=>event.stateChanges.some(change=>change.table==='frames'&&change.after?.pendingProperty?.proxy)),
    caller=event.stateChanges.find(change=>change.table==='frames'&&change.after?.pendingProperty?.proxy).after,
    child=event.stateChanges.find(change=>change.table==='frames'&&change.id===caller.pendingProperty.waitingFrameId).after;
  for(const change of ['receiver','argument']){
    const mutant=structuredClone(bundle),selected=mutant.events.find(row=>row.eventId===event.eventId);
    if(change==='receiver')selected.stateChanges.find(row=>row.table==='frames'&&row.id===child.id).after.thisValue=['ref',caller.pendingProperty.proxy.target[1]];
    else selected.stateChanges.find(row=>row.table==='envs'&&row.id===child.envId).after.bindings.r.token.value=caller.pendingProperty.proxy.target;
    assert.throws(()=>ownedProtocolSourceObservations(mutant,text,{adapters:[createProxyObservationAdapterV8]}),
      /trap (effective receiver|parameter values) differ/);
  }
});

test('source-qualified Proxy traps compose with compact locals and restore in the middle of a live setter callback',async()=>{
  const body='const before=2+3;let calls=0;const target={x:2},handler={};let proxy=null;'+
    'handler.get=function(t,k,r){calls++;return this===handler&&t===target&&r===proxy?t[k]+1:0;};'+
    'handler.set=function(t,k,v,r){calls++;t[k]=v+2;return this===handler&&r===proxy;};'+
    'proxy=new Proxy(target,handler);const first=proxy.x;const assigned=(proxy.x=4);handler.get=null;'+
    'const second=proxy.x;const after=first+second;return before+after+assigned+calls;';
  const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const artifact=result.exported,reference=artifact.sidecar.sourceArtifact.sidecar.reference;
  assert(artifact.sidecar.regionCoverage.compactRegions>=2);assert.equal(reference.extensionAudit.status,'agreed');
  assert.equal(reference.metadataAudit.status,'agreed');assert(reference.extensionAudit.expected>=7);
  assert.deepEqual(RegionExecutionHarness.replay(artifact).controller.completion,{kind:'return',value:['num',20]});
  const cut=artifact.public.timeline.findIndex(row=>row.fields?.line?.includes('"kind":"proxy.set.call"'))+1;assert(cut>2);
  const partial=RegionExecutionHarness.replay({...artifact.public,timeline:artifact.public.timeline.slice(0,cut)},{requireTerminal:false}),
    packet=JSON.parse(JSON.stringify(partial.checkpoint())),restored=RegionExecutionHarness.restore(packet);
  assert.equal(restored.controller.protocol.proxyCalls.pending.length,1);
  for(const row of artifact.public.timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(restored.exportEpisode(),artifact.public);
  const changed=structuredClone(packet),pending=changed.selected.invocations[0][1].state.protocol.proxyCalls.pending[0];
  pending.callee=pending.target;const {integrity,...rest}=changed;changed.integrity=hashAlgorithmData(rest);
  assert.throws(()=>RegionExecutionHarness.restore(changed),/callback source identity|exact public shared state/);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
});

test('source Proxy traps preserve nested calls, Symbol keys, lexical receivers, Number calls and scalar throws',async()=>{
  for(const [body,kind,value]of [
    ['const inner=new Proxy({x:3},{get:function(t,k){return t[k]+1;}});const outer=new Proxy({x:2},{get:function(t,k){return inner.x+t[k];}});return outer.x;','return',6],
    ['const key=Symbol("key");const proxy=new Proxy({[key]:2},{get:function(t,k,r){return k===key?t[k]+1:0;}});return proxy[key];','return',3],
    ['const proxy=new Proxy({x:2},{get:(t,k,r)=>t[k]+(this===undefined?1:0)});return proxy.x;','return',3],
    ['const proxy=new Proxy({x:2},{get:function(t,k){return Number(t[k])+1;}});return proxy.x;','return',3],
    ['const proxy=new Proxy({},{get:function(){throw 7;}});return proxy.x;','throw',7]
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
    assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind,value:['num',value]});
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  }
});
