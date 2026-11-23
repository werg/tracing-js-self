import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {ownedEffectfulOutcome} from '../src/training/effectful-compiler.js';
import {auditProtocolSourceV8,independentProtocolSourceReference} from '../src/semantic/protocol-source-reference-v8.js';
import {createPromiseObservationAdapterV8} from '../src/semantic/protocol-promise-observations-v8.js';
import {createNativeProtocolMetadata,compareProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {ownedProtocolSourceObservations} from '../src/semantic/protocol-source-observations-v8.js';

const cases=[
  ['ordinary assignment through a Promise alias',`"use strict";async function run(){
    const p=Promise.resolve(1);const alias=p;p.x=7;alias.x=9;return [p.x,alias===p];}`],
  ['accessor assignment keeps its receiver and expression result',`"use strict";async function run(){
    const p=Promise.resolve(1);let receiver=false;
    Object.defineProperty(p,"x",{set:function(value){receiver=this===p;this.y=value*2;},configurable:true});
    const written=(p.x=7);return [written,p.y,receiver,p.x];}`],
  ['data descriptor, alias and extensibility',`"use strict";async function run(){
    const p=Promise.resolve(1);const alias=p;
    Object.defineProperty(p,"x",{value:7,writable:false,enumerable:true,configurable:false});
    Object.preventExtensions(p);const d=Object.getOwnPropertyDescriptor(alias,"x");
    return [alias.x,Object.isExtensible(p),d.writable,d.enumerable,d.configurable];}`],
  ['accessor identity, receiver and side effects',`"use strict";async function run(){
    const p=Promise.resolve(1);let calls=0;
    function getX(){calls++;return this===p?7:8;}
    Object.defineProperty(p,"x",{get:getX,configurable:true});const alias=p;
    const d=Object.getOwnPropertyDescriptor(alias,"x");const x=alias.x;
    return [x,calls,d.get===getX,d.set===undefined];}`],
  ['shared Promise prototype constructor getter',`"use strict";function run(){
    let calls=0;let receiver=false;const log=[];const original=Object.getOwnPropertyDescriptor(Promise.prototype,"constructor");
    const p=Promise.resolve(4);const alias=p;
    Object.defineProperty(Promise.prototype,"constructor",{get:function(){calls++;receiver=this===alias;return Promise;},configurable:true});
    async function work(){const result=await p;Object.defineProperty(Promise.prototype,"constructor",original);
      log.push(result,calls,receiver,Object.getPrototypeOf(alias)===Promise.prototype);}
    work();return log;}`],
  ['async root with shared Promise prototype constructor getter',`"use strict";async function run(){
    let calls=0;let receiver=false;const original=Object.getOwnPropertyDescriptor(Promise.prototype,"constructor");
    const p=Promise.resolve(4);const alias=p;
    Object.defineProperty(Promise.prototype,"constructor",{get:function(){calls++;receiver=this===alias;return Promise;},configurable:true});
    const result=await p;Object.defineProperty(Promise.prototype,"constructor",original);
    return [result,calls,receiver,Object.getPrototypeOf(alias)===Promise.prototype];}`],
  ['custom prototype and Promise as an ordinary prototype',`"use strict";async function run(){
    const p=Promise.resolve(1);const proto={x:2};Object.setPrototypeOf(p,proto);const holder=Object.create(p);
    return [Object.getPrototypeOf(holder)===p,Object.getPrototypeOf(p)===proto,holder.x];}`],
  ['own getter reentry and thrown completion',`"use strict";async function run(){
    const p=Promise.resolve(1);let calls=0;let receiver=false;
    Object.defineProperty(p,"x",{get:function(){calls++;receiver=this===p;
      Object.defineProperty(p,"after",{value:9,configurable:true});throw 12;},configurable:true});
    let thrown=0;try{p.x;}catch(error){thrown=error;}return [calls,receiver,thrown,p.after];}`],
  ['ordinary hasOwnProperty receiver and accessor non-invocation',`"use strict";function run(){
    const p=Promise.resolve(1);let calls=0;
    Object.defineProperty(p,"x",{get:function(){calls++;return 7;},configurable:true});
    const has=Object.prototype.hasOwnProperty;
    return [has.call(p,"x"),has.call(p,"missing"),calls];}`]
];
for(const [name,source]of cases)test('Promise descriptor source observations agree: '+name,async()=>{
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});runtime.drive();
  const bundle=runtime.exportRun(),audit=await auditProtocolSourceV8({bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([]),awaitReturnedPromise:true},
    outcome:ownedEffectfulOutcome(bundle)});
  assert.equal(audit.status,'agreed');assert(audit.metadataAudit.checked>0);
  assert(audit.observations.metadata.some(row=>row.objects.some(node=>node.kind==='promise')));
});

function nativeObserver(){
  const realm=vm.createContext({}),evaluate=source=>vm.runInContext(source,realm),
    adapter=createPromiseObservationAdapterV8();adapter.initializeRealm(evaluate);
  const metadata=createNativeProtocolMetadata({intrinsicPrototypes:evaluate('[Object.prototype,Array.prototype,Function.prototype]'),
    adapters:[adapter.metadataAdapter]});
  return {evaluate,observe:value=>metadata.observe('test','assignment',value)};
}
test('native Promise metadata never calls own or prototype getters',()=>{
  const {evaluate,observe}=nativeObserver();
  const p=evaluate(`globalThis.reads=0;const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){reads++;throw 1;},configurable:true});
    Object.defineProperty(p,'then',{get(){reads++;throw 2;},configurable:true});
    Object.defineProperty(Promise.prototype,'extra',{get(){reads++;throw 3;},configurable:true});p;`);
  const first=observe(p),again=observe(p);
  assert.deepEqual(again,first);assert.equal(evaluate('reads'),0);
  const promise=first.objects.find(node=>node.kind==='promise');
  for(const key of ['constructor','then'])assert.equal(promise.properties.find(property=>
    property.key[0]==='str'&&property.key[1]===key).descriptor.kind,'accessor');
  assert.equal(promise.prototype[0],'ref');
  const prototype=first.objects.find(node=>node.id===promise.prototype[1]);
  assert(prototype.properties.some(property=>property.key[1]==='extra'&&property.descriptor.kind==='accessor'));
});
test('native Promise metadata rejects unregistered Proxy prototypes before any trap',()=>{
  const {evaluate,observe}=nativeObserver();
  const p=evaluate(`globalThis.traps=0;const proxy=new Proxy({}, {
    ownKeys(){traps++;return [];},getOwnPropertyDescriptor(){traps++;return undefined;},
    getPrototypeOf(){traps++;return null;}});const p=Promise.resolve(1);Object.setPrototypeOf(p,proxy);p;`);
  assert.throws(()=>observe(p),/Proxy metadata is outside/);assert.equal(evaluate('traps'),0);
});
test('native Promise metadata rejects unsupported intrinsic callable mutation',()=>{
  const {evaluate,observe}=nativeObserver();
  const p=evaluate(`const p=Promise.resolve(1);Object.defineProperty(Promise.prototype.then,'extra',{value:7});p;`);
  assert.throws(()=>observe(p),/modified intrinsic callable requires its declared storage profile/);
});
test('Promise metadata rejects altered descriptors, accessor and prototype identities',()=>{
  const {evaluate,observe}=nativeObserver();
  const p=evaluate(`const p=Promise.resolve(1);Object.defineProperty(p,'x',{get(){return 7;},configurable:true});p;`);
  const receipt=observe(p),promise=receipt.objects.find(node=>node.kind==='promise');
  for(const mutate of [
    row=>{row.properties.find(property=>property.key[1]==='x').descriptor.enumerable=true;},
    row=>{row.properties.find(property=>property.key[1]==='x').descriptor.get=['undefined'];},
    row=>{row.prototype=null;},
    row=>{row.extensible=false;}
  ]){
    const changed=structuredClone(receipt);mutate(changed.objects.find(node=>node.id===promise.id));
    assert.equal(compareProtocolMetadata([receipt],[changed]).status,'mismatch');
  }
});

test('native returned Promise inspection preserves identity without constructor, then or tag getters',async()=>{
  const source=`"use strict";function run(input){const p=Promise.resolve(input);
    Object.defineProperty(p,'constructor',{get(){input.push('constructor');throw 1;}});
    Object.defineProperty(p,'then',{get(){input.push('then');throw 2;}});
    Object.defineProperty(p,Symbol.toStringTag,{get(){input.push('tag');throw 3;}});return p;}`;
  for(const mode of ['original','operations','branches','completions']){
    const reference=await independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([[]]),
      mode,awaitReturnedPromise:true});
    assert.equal(reference.outcome.kind,'return');
    assert.deepEqual(reference.outcome.graph.roots,[['ref','o0'],['ref','o0']]);
    assert.deepEqual(reference.outcome.graph.objects[0].properties,[['length',['num',0]]]);
  }
});
test('native returned rejection remains a guest throw without observing its constructor',async()=>{
  const source=`"use strict";function run(){const p=Promise.reject(17);
    Object.defineProperty(p,'constructor',{get(){throw 99;}});return p;}`;
  const reference=await independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([]),
    mode:'original',awaitReturnedPromise:true});
  assert.deepEqual(reference.outcome,{kind:'throw',graph:{roots:[['num',17]],objects:[]}});
});
test('unsettled native returned Promise remains an explicit resource limit',async()=>{
  await assert.rejects(independentProtocolSourceReference({source:'function run(){return new Promise(()=>{});}',
    entry:'run',inputGraph:encodeNativeGraph([]),mode:'original',awaitReturnedPromise:true}),
  error=>error.category==='resource_limited'&&/remains pending/.test(error.message));
});
test('Promise assignment observation checks committed storage independently of its expression result',()=>{
  const source='"use strict";async function run(){const p=Promise.resolve(1);p.x=7;return p.x;}';
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});runtime.drive();
  const bundle=runtime.exportRun(),altered=structuredClone(bundle),write=altered.events.find(event=>
    event.operation==='property.write'&&event.operands[0]?.[0]==='promise');
  assert(write);assert.deepEqual(write.result,['num',7]);
  const change=write.stateChanges.find(change=>change.table==='promises'&&change.after?.properties?.x);
  assert(change);change.after.properties.x.value=['num',8];
  const assignment=ownedProtocolSourceObservations(altered,source).completions.find(row=>row.kind==='assign');
  assert.deepEqual(assignment.value,['num',8]);
  assert.deepEqual(ownedProtocolSourceObservations(bundle,source).completions.find(row=>row.kind==='assign').value,['num',7]);
});
