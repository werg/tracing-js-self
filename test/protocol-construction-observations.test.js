import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {createConstructionObservationAdapterV8} from '../src/semantic/protocol-construction-observations-v8.js';
import {instrumentCompletionSource,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {createProtocolCompletionCapture,ownedProtocolSourceObservations}
  from '../src/semantic/protocol-source-observations-v8.js';
import {createNativeProtocolMetadata,compareProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';

function observe(source){
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});runtime.drive();
  const bundle=runtime.exportRun(),adapter=createConstructionObservationAdapterV8({source}),
    capture=createProtocolCompletionCapture({adapters:[adapter.metadataAdapter]}),
    context=vm.createContext({...adapter.globals,result:undefined,[COMPLETION_HOOK]:capture.capture});
  capture.setIntrinsicPrototypes(vm.runInContext('[Object.prototype,Array.prototype,Function.prototype]',context));
  vm.runInContext(adapter.instrument(instrumentCompletionSource(source))+'\nresult=run();',context);
  const owned=ownedProtocolSourceObservations(bundle,source,{adapters:[createConstructionObservationAdapterV8]});
  return {source,bundle,owned,native:capture.metadata,result:context.result,
    audit:compareProtocolMetadata(owned.metadata,capture.metadata)};
}

test('independent class metadata observes actual descriptors prototypes and private fields',()=>{
  const checked=observe('"use strict";function run(){class C{#x=2;static #n=3;constructor(x){this.#x=x;}f(){return this.#x;}static g(){return this.#n;}}const o=new C(4);return o.f()+C.g();}');
  assert.equal(checked.result,7);assert.equal(checked.audit.status,'agreed',JSON.stringify(checked.audit));
  const objects=checked.native.at(-1).objects;
  assert(objects.some(node=>node.annotations?.some(row=>row.name==='private-element/1'&&row.data.name==='x'&&row.values[1][1]===4)));
  assert(objects.some(node=>node.kind==='function'&&node.properties.some(row=>row.key[1]==='length'&&row.descriptor.writable===false)));
  assert(objects.some(node=>node.annotations?.some(row=>row.name==='home-object/1')));
});

test('unused declared classes still root static private and function metadata after evaluation',()=>{
  const checked=observe('"use strict";function run(){class C{static #x=3;m(){return 1;}}return 7;}');
  assert.equal(checked.audit.status,'agreed',JSON.stringify(checked.audit));
  assert.equal(checked.owned.completions[0].kind,'initialize');
  const classes=checked.native.at(-1).objects.filter(node=>node.annotations?.some(row=>row.name==='class/1'));
  assert.equal(classes.length,1);
  assert(classes[0].annotations.some(row=>row.name==='private-element/1'&&row.data.name==='x'&&row.values[1][1]===3));
});

test('same-spelled private brands and private methods preserve distinct lexical owners',()=>{
  const checked=observe('"use strict";function run(){class A{#x=1;#m(){return this.#x;}a(){return this.#m();}}class B extends A{#x=2;b(){return this.#x;}}const o=new B();return o.a()+o.b();}');
  assert.equal(checked.result,3);assert.equal(checked.audit.status,'agreed',JSON.stringify(checked.audit));
  const object=checked.native.at(-1).objects.find(node=>node.annotations?.filter(row=>row.name==='private-element/1'&&row.data.name==='x').length===2);
  assert(object);const brands=object.annotations.filter(row=>row.name==='private-element/1'&&row.data.name==='x');
  assert.notDeepEqual(brands[0].values[0],brands[1].values[0]);
});

test('anonymous inferred class names and repeated source class evaluation retain observed identities',()=>{
  const checked=observe('"use strict";function run(){const C=class{#x=1;static named=this.name;m(){return this.#x;}};const a=new C();function make(){return class {#x=2;m(){return this.#x;}};}const D=make();const E=make();const b=new D();const c=new E();return C.named+a.m()+b.m()+c.m();}');
  assert.equal(checked.result,'C122');assert.equal(checked.audit.status,'agreed',JSON.stringify(checked.audit));
});

test('private values descriptor flags and hidden home links cannot disappear behind a scalar result',()=>{
  const checked=observe('"use strict";function run(){class C{#x=2;m(){return this.#x;}}const o=new C();return 7;}');
  assert.equal(checked.audit.status,'agreed',JSON.stringify(checked.audit));
  const changed=structuredClone(checked.bundle);
  function mutate(node){
    if(!node||typeof node!=='object')return;
    if(node.privateSlots)for(const slot of Object.values(node.privateSlots))if(slot.value[0]==='num')slot.value=['num',99];
    for(const child of Object.values(node))mutate(child);
  }
  mutate(changed);
  const wrongState=ownedProtocolSourceObservations(changed,checked.source,{adapters:[createConstructionObservationAdapterV8]});
  assert.deepEqual(wrongState.completions,checked.owned.completions);
  assert.equal(compareProtocolMetadata(wrongState.metadata,checked.native).status,'mismatch');
  const late=structuredClone(checked.owned.metadata),privateRow=late.at(-1).objects.flatMap(node=>node.annotations??[]).find(row=>row.name==='private-element/1');
  privateRow.values[1]=['num',99];assert.equal(compareProtocolMetadata(late,checked.native).status,'mismatch');
  const flags=structuredClone(checked.owned.metadata),method=flags.at(-1).objects.find(node=>node.kind==='function'&&node.properties?.some(row=>row.key[1]==='name'));
  method.properties.find(row=>row.key[1]==='name').descriptor.writable=true;
  assert.equal(compareProtocolMetadata(flags,checked.native).status,'mismatch');
  const home=structuredClone(checked.owned.metadata),homeRow=home.at(-1).objects.flatMap(node=>node.annotations??[]).find(row=>row.name==='home-object/1');
  homeRow.values[0]=['ref','wrong'];assert.equal(compareProtocolMetadata(home,checked.native).status,'mismatch');
});

test('metadata readers do not call ordinary getters and reject private accessors or Proxies',()=>{
  const source='class C{#x=1;get publicValue(){throw new Error("must not invoke");}m(){return this.#x;}}',
    adapter=createConstructionObservationAdapterV8({source}),context=vm.createContext({...adapter.globals,object:undefined});
  vm.runInContext(adapter.instrument(source)+'\nobject=new C();',context);
  const metadata=createNativeProtocolMetadata({adapters:[adapter.metadataAdapter],
    intrinsicPrototypes:vm.runInContext('[Object.prototype,Array.prototype,Function.prototype]',context)});
  assert.doesNotThrow(()=>metadata.observe('value','initialize',context.object));
  let traps=0;const proxy=new Proxy(context.object,{get(){traps++;throw Error('trap');},ownKeys(){traps++;throw Error('trap');}});
  assert.throws(()=>metadata.observe('proxy','initialize',proxy),/Proxy metadata/);assert.equal(traps,0);
  assert.throws(()=>createConstructionObservationAdapterV8({source:'class C{get #x(){throw 1;}}'}),/private accessor metadata/);
  assert.throws(()=>createConstructionObservationAdapterV8({source:'class C{};__tracingProtocolConstructionRegister(C,0,[])'}),/reserved observer/);
});

test('ordinary getter capabilities remain visible without inventing function descriptors',()=>{
  const checked=observe('"use strict";function run(){let reads=0;const proto={get n(){reads++;return 3;}};const o=Object.create(proto);const value=o.n;return [value,reads];}');
  assert.deepEqual(Array.from(checked.result),[3,1]);assert.equal(checked.audit.status,'agreed',JSON.stringify(checked.audit));
  const method=checked.native.at(-1).objects.find(node=>node.annotations?.some(row=>row.name==='ordinary-nonconstructible/1'));
  assert.equal(method.kind,'function');assert.equal(Object.hasOwn(method,'properties'),false);
  const changed=structuredClone(checked.bundle);
  function mutate(node){if(!node||typeof node!=='object')return;
    if(node.kind==='function'&&node.nonConstructible)node.nonConstructible=false;
    for(const child of Object.values(node))mutate(child);}
  mutate(changed);
  const observed=ownedProtocolSourceObservations(changed,checked.source,{adapters:[createConstructionObservationAdapterV8]});
  assert.deepEqual(observed.completions,checked.owned.completions);
  assert.equal(compareProtocolMetadata(observed.metadata,checked.native).status,'mismatch');
});

test('independent construction capability probes neither invoke functions nor read their prototypes',()=>{
  const adapter=createConstructionObservationAdapterV8({source:'const object={m(){}};'}),
    metadata=createNativeProtocolMetadata({adapters:[adapter.metadataAdapter]});
  let calls=0,reads=0;
  const constructor=(function(){calls++;}).bind(null),method=({m(){calls++;}}).m;
  for(const fn of [constructor,method])Object.defineProperty(fn,'prototype',{get(){reads++;throw new Error('must not read');}});
  const constructed=metadata.observe('constructor','initialize',constructor);
  assert.equal(constructed.objects[0].annotations,undefined);
  const nonconstructor=metadata.observe('method','initialize',method);
  assert(nonconstructor.objects.some(node=>node.annotations?.some(row=>row.name==='ordinary-nonconstructible/1')));
  assert.equal(calls,0);assert.equal(reads,0);
});
