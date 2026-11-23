import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {ownedObjectHeap,ensurePromisePrototype} from '../src/owned-object-storage.js';
import {ordinaryGet} from '../src/spec-operations.js';

const wire=value=>JSON.parse(JSON.stringify(value));
function checked(runtime){
  assert.equal(runtime.drive().kind,'terminated');
  const archive=wire(runtime.exportRun());
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  return archive;
}
function entry(body){
  const text='"use strict";function run(){'+body+'}',
    runtime=createRuntime().startEntry({text,functionName:'run'}),archive=checked(runtime);
  assert.deepEqual(archive.finalState.control.a0.completion.value,
    ['str',vm.runInNewContext(text+';run()',{}, {timeout:1000})]);
  return archive;
}

test('standalone original scripts reflect live global var and function cells but exclude lexical cells',()=>{
  const text=`var x=1;let hidden=2;const secret=3;function fn(){};
    var result=Object.hasOwn(globalThis,'x')+':'+globalThis.x+':'+
      Object.prototype.hasOwnProperty.call(globalThis,'fn')+':'+(globalThis.fn===fn)+':'+
      Object.hasOwn(globalThis,'hidden')+':'+Object.hasOwn(globalThis,'secret');
    x=9;result+=':'+globalThis.x+':'+(globalThis.Object===Object)+':'+
      Reflect.apply(Object.prototype.hasOwnProperty,globalThis,['x']);`;
  const runtime=createRuntime(),source=runtime.registerSource({text,scriptProfile:true});
  runtime.start(source);const environment=runtime.state.frames[runtime.state.control.a0.activeFrameId].envId;
  const archive=checked(runtime),reference=vm.createContext({});vm.runInContext(text,reference,{timeout:1000});
  assert.deepEqual(archive.finalState.envs[environment].bindings.result.token.value,['str',reference.result]);
  assert.equal(reference.result,'true:1:true:true:false:false:9:true:true');
});

test('separate original scripts retain the same global object-backed cells across later declarations',()=>{
  const texts=['var x=1;let hidden=2;const secret=3;function fn(){return x;}',
    `x=4;var later=5;var result=Object.prototype.hasOwnProperty.call(globalThis,'x')+':'+
      globalThis.fn()+':'+Object.hasOwn(globalThis,'later')+':'+
      Object.hasOwn(globalThis,'hidden')+':'+Object.hasOwn(globalThis,'secret');`];
  const runtime=createRuntime(),sources=texts.map(text=>runtime.registerSource({text,scriptProfile:true}));
  runtime.startScriptSequence(sources);const archive=checked(runtime),reference=vm.createContext({});
  for(const text of texts)vm.runInContext(text,reference,{timeout:1000});
  const environment=archive.finalState.control.a0.scriptSequence.environmentId;
  assert.deepEqual(archive.finalState.envs[environment].bindings.result.token.value,['str',reference.result]);
  assert.equal(reference.result,'true:4:true:false:false');
});

test('own function name and length presence agrees across static and adapted reflection',()=>{
  const archive=entry(`function fn(a){}const arrow=()=>1;async function asyncFn(){}function* generator(){};
    return Object.hasOwn(fn,'length')+':'+Object.prototype.hasOwnProperty.call(fn,'name')+':'+
      Object.hasOwn(fn,'prototype')+':'+Object.hasOwn(fn,'missing')+':'+
      Object.hasOwn(arrow,'name')+':'+Object.hasOwn(arrow,'length')+':'+Object.hasOwn(arrow,'prototype')+':'+
      Object.hasOwn(asyncFn,'length')+':'+Object.hasOwn(asyncFn,'prototype')+':'+
      Object.hasOwn(generator,'prototype');`);
  const forged=wire(archive),event=forged.events.find(event=>event.operation==='call.enter'&&
    event.operands[0]?.[0]==='method'&&event.operands[0][1]?.[1]==='Function.prototype.call');
  assert(event);event.result=['bool',false];
  assert.throws(()=>validateBundle(forged),/Own property adapter result differs/);
});

test('Promise prototype lookup follows owned function data and inherited accessors with the Promise receiver',()=>{
  entry(`const p=Promise.resolve(1),alias=p;function proto(){}proto.x=7;let stored=3;
    const parent={get y(){return this===alias?stored:99;},set y(value){stored=this===p?value:99;}};
    Object.setPrototypeOf(proto,parent);
    Object.setPrototypeOf(p,proto);const before=p.x+':'+p.y;p.y=8;
    return before+':'+p.y+':'+('x' in p)+':'+(Object.getPrototypeOf(p)===proto);`);
});

test('unmodeled function prototype metadata remains an explicit refusal outside guest catch',()=>{
  const runtime=createRuntime().startEntry({text:`"use strict";function run(){
    function proto(){}const p=Promise.resolve(1);Object.setPrototypeOf(p,proto);
    try{return p.name;}catch(error){return 'caught';}}`,functionName:'run'});
  assert.throws(()=>runtime.drive(),/Unmodeled Promise ordinary property lookup/);
});

test('Promise in-operator checks retain pristine and live shared prototype properties without invoking getters',()=>{
  entry(`const p=Promise.resolve(1);let reads=0;
    const before=('then' in p)+':'+('missing' in p);
    Object.defineProperty(Promise.prototype,'extra',{get(){reads++;return 1;}});
    const shared=('extra' in p)+':'+(Symbol.toStringTag in p);
    Object.setPrototypeOf(p,null);return before+':'+shared+':'+('then' in p)+':'+reads;`);
});

test('ordinary property lookup does not enumerate unrelated Promise storage or materialize its prototype',()=>{
  const object={id:'object',kind:'object',properties:{x:{value:['num',7],origin:null}},propertyVersions:{x:0},shapeVersion:0};
  const promises=new Proxy({promise:{id:'promise',kind:'promise',properties:{},propertyVersions:{}}},
    {ownKeys(){throw new Error('Unrelated Promise enumeration');}});
  const state={heap:{object},promises},view=ownedObjectHeap(state);
  assert.deepEqual(ordinaryGet(view,['ref','object'],'x').method.value,['num',7]);
  assert.equal(view.promise,promises.promise);
  const pristine=view['Promise.prototype'];assert.equal(pristine,view['Promise.prototype']);
  assert.equal(state.heap['Promise.prototype'],undefined);
  const materialized=ensurePromisePrototype(state);assert.equal(view['Promise.prototype'],materialized);
  assert.equal(state.heap.object,object);
});
