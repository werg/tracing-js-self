import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {createEnumerationObservationAdapterV8} from '../src/semantic/protocol-enumeration-observations-v8.js';
import {ownedProtocolSourceObservations} from '../src/semantic/protocol-source-observations-v8.js';
import {independentProtocolSourceReference} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const ownKeys='const object=Object.create({p:x});object.a=x;const keys=[];for(const key in object)if(Object.hasOwn(object,key))keys.push(key);return keys;';
const fixture=(body,args=[4])=>({source:'"use strict";function run(x){'+body+'}',entry:'run',args,family:'ordinary-for-in-source'});
async function checked(body,args=[4]){
  const result=await verifyProtocolRegionTrainingCase(fixture(body,args));assert(result.exported,result.reason);
  const checks=result.exported.sidecar.sourceArtifact.sidecar.reference;
  for(const name of ['operationAudit','branchAudit','completionAudit','metadataAudit','extensionAudit'])assert.equal(checks[name].status,'agreed',name);
  return result;
}

test('all eight frozen own-key for-in inputs pass common v8 source admission with explicit cursors',async()=>{
  for(const x of [-3,-1,0,1,2,7,10,100]){
    const result=await verifyRegionTrainingCase(fixture(ownKeys,[x]));assert(result.exported,result.reason);
    const compiler=result.exported.sidecar.sourceArtifact.sidecar.compiler;
    assert(compiler.extensions.includes('ordinary-for-in/1'));
    assert(compiler.claims.some(row=>row.record.kind==='property.hasOwn'));
    const replay=RegionExecutionHarness.replay(result.exported);
    assert.deepEqual(replay.controller.materialize(replay.controller.completion.value),['a']);
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  }
});

test('source enumeration preserves shadowing descriptors references values and abrupt exits',async()=>{
  for(const body of [
    'const p={2:2,duplicate:3,hidden:4,z:5};const o=Object.create(p);o.a=x;o[10]=10;o[1]=1;o.duplicate=8;Object.defineProperty(o,"hidden",{value:9});o[Symbol("skip")]=6;const out=[];for(const key in o)out.push(key);return out;',
    'let calls=0;const o={get a(){calls++;return x;},b:2};const out=[];for(const key in o)out.push(key);return [out,calls];',
    'const o={a:x,b:2};const out=[];for(const key in o){o.b=7;out.push(o[key]);}return out;',
    'const o={a:x,b:2};for(const key in o)return key;return "empty";',
    'const o={a:x,b:2};for(const key in o)throw key;return "empty";',
    'const o={a:x};for(const key in o){o.added=2;break;}return o.added;',
    'const out=[];outer:for(const a in {x:1,y:2})for(const b in {z:1}){out.push(a+b);continue outer;}return out;',
    'const out=[];for(const key in "a😀")out.push(key);for(const key in null)out.push(key);return out;'
  ])await checked(body);
});

test('native key hooks preserve body lexical shadowing and evaluate a called loop source once',()=>{
  for(const body of [
    'let calls=0;function object(){calls++;return {a:1,b:2};}const out=[];for(const key in object()){let key=7;out.push(key);}return [calls,out];',
    'const out=[];outer:for(let key in {a:1,b:2})for(let inner in {x:1}){out.push(key+inner);continue outer;}return out;'
  ]){
    const source=fixture(body).source,adapter=createEnumerationObservationAdapterV8({source});
    const context=vm.createContext({...adapter.globals});adapter.initializeRealm(text=>vm.runInContext(text,context));
    const actual=vm.runInContext(adapter.instrument(source)+';run()',context),expected=vm.runInNewContext(source+';run()');
    assert.deepEqual(structuredClone(actual),structuredClone(expected));assert(adapter.observations().some(row=>row.kind==='key'));
  }
});

test('independent enumeration observations reject cursor-key mutants hidden from scalar completion',async()=>{
  const input=fixture('const object={a:1,b:2};for(const key in object){}return 7;',[]),runtime=createRuntime().startEntry({text:input.source,functionName:'run',args:[]});
  runtime.drive();const bundle=runtime.exportRun(),source=bundle.sources.find(row=>row.sourceId===bundle.entrySpec.sourceId).text;
  const native=await independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([]),mode:'completions'});
  const original=ownedProtocolSourceObservations(bundle,source);assert.deepEqual(original.extensionObservations,native.extensionObservations);
  const mutant=structuredClone(bundle);
  for(const event of mutant.events)for(const change of event.stateChanges)if(change.table==='heap')
    for(const node of [change.before,change.after])if(node?.kind==='enumerator'){
      node.keys.reverse();node.chain[0].keys.reverse();
    }
  const changed=ownedProtocolSourceObservations(mutant,source);
  assert.deepEqual(changed.completions,original.completions);
  assert.notDeepEqual(changed.extensionObservations,native.extensionObservations);
});

test('enumeration checkpoint replay binds every prefix and rejects false keys without changing cursor state',async()=>{
  const result=await checked(ownKeys),artifact=result.exported,timeline=artifact.public.timeline;
  const cut=timeline.findIndex(row=>row.fields.line?.includes('"kind":"enumeration.next"'));
  assert(cut>0);const prefix={...artifact.public,timeline:timeline.slice(0,cut)},harness=RegionExecutionHarness.replay(prefix,{requireTerminal:false});
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(harness.checkpoint()))),before=sharedRegionState(restored.controller),
    selected=decodeProtocolRecordV8(timeline[cut].fields.line);
  assert.throws(()=>restored.select('invocation1',encodeProtocolRecordV8({...selected,result:['str','future']})),/enumeration next/);
  assert.deepEqual(sharedRegionState(restored.controller),before);
  for(const row of timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(RegionExecutionHarness.replay(artifact).controller));
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
});

test('structural mutation callable chains proxies and complex loop bindings stay outside the source profile',async()=>{
  for(const body of [
    'const o={a:1,b:2};for(const key in o)Object.defineProperty(o,"b",{enumerable:false});return 7;',
    'const o={a:1,b:2};for(const key in o)Object.setPrototypeOf(o,{p:1});return 7;',
    'const o=new Proxy({a:1},{});for(const key in o){}return 7;',
    'const f=()=>1;Object.setPrototypeOf(f,{prototype:3});for(const key in f){}return 7;',
    'const f=()=>1;f.p=1;const o=Object.create(f);for(const key in o){}return 7;',
    'for(const [key] in {a:1}){}return 7;'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.exported,undefined,body);assert.notEqual(result.status,'locally_verified');
  }
});
