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

test('adapted own-property reflection converts numeric special values to their actual string keys',()=>{
  const archive=entry(`const value={Infinity:1,'+Infinity':2,'-Infinity':3,NaN:4,0:5};
    return Object.hasOwn.call(null,value,Infinity)+':'+
      Reflect.apply(Object.hasOwn,null,[value,Infinity])+':'+
      Object.prototype.hasOwnProperty.apply(value,[Infinity])+':'+
      Object.hasOwn.call(null,value,-Infinity)+':'+Object.hasOwn.call(null,value,NaN)+':'+
      Object.hasOwn.call(null,value,-0)+':'+Object.hasOwn.call(null,{'+Infinity':1},Infinity);`);
  const forged=wire(archive),event=forged.events.find(event=>event.operation==='call.enter'&&
    event.operands[0]?.[0]==='method'&&event.operands[0][1]?.[1]==='Function.prototype.call'&&
    event.operands.at(-1)?.[1]==='+Infinity');
  assert(event);event.result=['bool',false];
  assert.throws(()=>validateBundle(forged),/Own property adapter result differs/);
});

test('array hasOwnProperty inherits the Object builtin after own and explicit prototype overrides',()=>{
  entry(`const a=[7];const before=a.hasOwnProperty('length')+':'+a.hasOwnProperty(0)+':'+a.hasOwnProperty('missing');
    a.hasOwnProperty=function(key){return this===a&&key==='custom';};
    const own=a.hasOwnProperty('custom'),b=[1];
    Object.setPrototypeOf(b,{hasOwnProperty:Object.prototype.hasOwnProperty});
    return before+':'+own+':'+b.hasOwnProperty('length')+':'+b.hasOwnProperty('hasOwnProperty');`);
  const runtime=createRuntime().startEntry({text:'"use strict";function run(){try{return [].toLocaleString();}catch(error){return "caught";}}',
    functionName:'run'});
  assert.throws(()=>runtime.drive(),/Unmodeled ordinary \[\[Get\]\] or exotic property/);
});

test('descriptor conversion rejects invalid get before reading a later set accessor',()=>{
  for(const target of ['{}','[]','Promise.resolve(1)'])for(const inherited of [false,true]){
    entry(`const p=${target};let calls=0;const fields={get:1,get set(){calls++;return undefined;}};
      const descriptor=${inherited?'Object.create(fields)':'fields'};
      try{Object.defineProperty(p,'x',descriptor);return 'accepted';}
      catch(error){return error.name+':'+calls+':'+Object.hasOwn(p,'x');}`);
  }
  entry(`const p=Promise.resolve(1);let calls=0;
    try{Object.defineProperty(p,'x',{get(){calls++;},set:1});return 'accepted';}
    catch(error){return error.name+':'+calls+':'+Object.hasOwn(p,'x');}`);
});

test('descriptor accessor fields that are actually reached retain their outside-guest refusal',()=>{
  for(const [descriptor,expected]of [
    ['{get:undefined,get set(){calls++;return undefined;}}','after:1'],
    ['{get get(){calls++;return undefined;}}','after:1'],
    ['{get value(){calls++;return 1;},get:1}','TypeError:1']
  ]){
    const text='"use strict";function run(){const p=Promise.resolve(1);let calls=0;try{'+
      'Object.defineProperty(p,"x",'+descriptor+');return "after:"+calls;}catch(error){return error.name+":"+calls;}}';
    assert.equal(vm.runInNewContext(text+';run()',{}, {timeout:1000}),expected);
    const runtime=createRuntime().startEntry({text,functionName:'run'});
    assert.throws(()=>runtime.drive(),/Accessor descriptor fields are outside the bounded profile/);
  }
});
