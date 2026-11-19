import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {createNumberObservationAdapterV8} from '../src/semantic/protocol-number-observations-v8.js';
import {prepareProtocolObservationExtensionsV8} from '../src/semantic/protocol-source-observations-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {applyProtocolRecordV8} from '../src/semantic/protocol-state-v8.js';
import {validateRegionTrainingContexts} from '../src/semantic/causal-lm-v8.js';

const source=body=>'"use strict";function run(){'+body+'}';
function observed(text){
  const extensions=prepareProtocolObservationExtensionsV8({source:text,adapters:[createNumberObservationAdapterV8]});
  const context=vm.createContext({...extensions.globals});extensions.initializeRealm(expression=>vm.runInContext(expression,context));
  const result=vm.runInContext(extensions.instrument(text)+';run()',context);
  return {result,observations:extensions.observations()};
}
function archive(text){const runtime=createRuntime().startEntry({text,functionName:'run',args:[]});runtime.drive();return runtime.exportRun();}
const fixture=body=>({source:source(body),entry:'run',family:'number-source',timeoutMs:30000});

test('native Number observation preserves private brands, live selection, aliases and exact method order',()=>{
  for(const body of [
    'class Counter{#n=2;[Symbol.toPrimitive](hint){return hint==="number"?++this.#n:0;}}const value=new Counter();return [Number(value),Number(value)];',
    'let log="";const o={valueOf:function(){log+="v";this.toString=function(){log+="t";return "7";};return {};},toString:function(){return "9";}};const n=Number(o);return [n,log];',
    'const inner={valueOf:function(){return 2;}};const outer={valueOf:function(){return Number(inner)+3;}};return Number(outer);',
    'const o={valueOf:()=>3};return [Number(o),Number(),Number("-0"),Number(9007199254740993n),Number({})];'
  ]){
    const text=source(body),actual=observed(text),expected=vm.runInNewContext(text+';run()');
    assert.deepEqual(structuredClone(actual.result),structuredClone(expected));
    const owned=createNumberObservationAdapterV8({source:text,side:'owned',bundle:archive(text)}).observations();
    assert.deepEqual(actual.observations,[{profile:'number-conversion-observations/1',rows:owned}]);
    assert(owned.some(row=>row.kind==='select'));assert(owned.some(row=>row.kind==='finish'));
  }
});

test('observer keeps source values unchanged and refuses accessors or guest Proxies without running their hooks',()=>{
  const text=source('let n=0;const o={};Object.defineProperty(o,"valueOf",{value:function(){n++;return this===o?4:0;},writable:false,configurable:false});return [Number(o),n,Object.getOwnPropertyDescriptor(o,"valueOf").writable];');
  assert.deepEqual(structuredClone(observed(text).result),[4,1,false]);
  for(const body of [
    'let calls=0;const o={get valueOf(){calls++;return ()=>3;}};try{Number(o);}catch(e){}return calls;',
    'let calls=0;const o=new Proxy({},{get(){calls++;return ()=>3;}});try{Number(o);}catch(e){}return calls;'
  ])assert.throws(()=>observed(source(body)),/accessor|Proxy/);
});

test('source-qualified Number conversions share private class state and exact continuation checkpoints',async()=>{
  const body='const before=2+3;class Counter{#n=2;[Symbol.toPrimitive](hint){return hint==="number"?++this.#n:0;}}'+
    'const value=new Counter();const first=Number(value);const second=Number(value);const after=first+second;return before+after;';
  const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const artifact=result.exported,reference=artifact.sidecar.sourceArtifact.sidecar.reference;
  assert.equal(reference.extensionAudit.status,'agreed');assert(reference.extensionAudit.observed>=10);
  assert(artifact.sidecar.protocolExtensions.includes('number-conversion-source/1'));
  assert(artifact.sidecar.regionCoverage.compactRegions>=2);
  assert.equal(validateRegionTrainingContexts(artifact).length,artifact.contexts.length);
  const replay=RegionExecutionHarness.replay(artifact);
  assert.deepEqual(replay.controller.completion,{kind:'return',value:['num',12]});
  assert.equal(replay.controller.protocol.numberConversions.operations.length,2);
  assert(replay.controller.protocol.numberConversions.operations.every(row=>row.phase==='complete'));
  const pendingIndex=artifact.public.timeline.findIndex(row=>row.fields?.line?.includes('"kind":"number.call"'));
  assert(pendingIndex>=0);
  const prefix=structuredClone(artifact);prefix.public.timeline=prefix.public.timeline.slice(0,pendingIndex+1);
  const partial=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),packet=JSON.parse(JSON.stringify(partial.checkpoint()));
  const restored=RegionExecutionHarness.restore(packet);assert.deepEqual(restored.modelContext('invocation1'),partial.modelContext('invocation1'));
  for(const row of artifact.public.timeline.slice(pendingIndex+1))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(restored.exportEpisode(),artifact.public,'resume must not invoke either conversion callback again');
  const malformed=structuredClone(packet),state=malformed.selected.invocations[0][1].state;
  state.protocol.numberConversions.operations[0].child='missing';
  const {integrity,...rest}=malformed;malformed.integrity=hashAlgorithmData(rest);
  assert.throws(()=>RegionExecutionHarness.restore(malformed),/callback identity|exact public shared state|Number/);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
});

test('source-qualified Number handles scalar leaves, ordinary fallback, nested calls and live method mutation',async()=>{
  for(const [body,expected]of [
    ['return Number(9007199254740993n);',9007199254740992],
    ['return Number();',0],
    ['const o={valueOf:1,toString:function(){return "-0";}};return Number(o);','-0'],
    ['const o={valueOf:function(){this.toString=function(){return "7";};return {};},toString:function(){return "9";}};return Number(o);',7],
    ['const inner={valueOf:function(){return 2;}};const outer={valueOf:function(){return Number(inner)+3;}};return Number(outer);',5],
    ['const o={valueOf:()=>3};return Number(o);',3],
    ['return Number({});','NaN']
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
    assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind:'return',value:['num',expected]});
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  }
});

test('false Number method order, receiver, result and source-observer evidence remain rejected',async()=>{
  const text=source('const o={valueOf:function(){return 3;}};return Number(o);'),native=observed(text),bundle=archive(text);
  const mutated=structuredClone(bundle),dispatch=mutated.events.find(event=>event.operation==='call.enter'&&event.operands[0]?.[1]==='Number');
  dispatch.readObservations[0].value=['num',0];
  const expected=createNumberObservationAdapterV8({source:text,side:'owned',bundle:mutated}).observations();
  assert.notDeepEqual(native.observations[0].rows,expected,'an unchanged scalar cannot hide a different selected method');
  const result=await verifyProtocolRegionTrainingCase({source:text,entry:'run',family:'number-mutants',timeoutMs:30000});assert(result.exported,result.reason);
  const timeline=result.exported.public.timeline,index=timeline.findIndex(row=>row.fields?.line?.includes('"kind":"number.begin"'));
  const prefix=structuredClone(result.exported);prefix.public.timeline=timeline.slice(0,index+1);
  const controller=RegionExecutionHarness.replay(prefix,{requireTerminal:false}).controller,before=structuredClone(controller.protocol);
  assert.throws(()=>applyProtocolRecordV8(controller,{kind:'number.finish',id:'number1',result:['num',3]}),/number.select/);
  assert.deepEqual(controller.protocol,before);
});

test('unqualified abrupt, accessor, exotic and extra-argument Number behavior has explicit source dispositions',async()=>{
  for(const body of [
    'return Number({valueOf:function(){throw 7;}});',
    'return Number({[Symbol.toPrimitive]:function(){return {};}});',
    'return Number({get valueOf(){return function(){return 2;};}});',
    'return Number([3]);',
    'return Number(2,3);'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.status,'unsupported',result.reason);
    assert.equal(result.regionDisposition,'source-unqualified');assert(!result.exported);
  }
});
