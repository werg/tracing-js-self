import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {createProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {CONSTRUCTION_RECORD_FIELDS,applyConstructionRecordV8,validateConstructionRecordV8,
  restoreConstructionStateV8,constructionReservedIdentitiesV8,describeConstructionObjectV8} from '../src/semantic/protocol-construction-v8.js';

// The component uses this deliberately small host interface. Full serving
// dispatch, source admission and native parity are separate integration gates.
function fixture(){
  const controller={protocol:createProtocolStateV8(),heap:new Map()};
  const require=(ok,message)=>{if(!ok)throw new TypeError(message);};
  const api={require,copy:structuredClone,eq:isDeepStrictEqual,state:c=>c.protocol,
    known(c,value){validateProtocolValueV8(value);if(value[0]==='ref')require(c.heap.has(value[1]),'unknown reference');return value;},
    heapNode(c,id){const node=c.heap.get(id);require(node&&['object','array','closure'].includes(node.kind),'unknown object');return node;},
    fresh(c,id){require(!c.heap.has(id)&&!c.protocol.symbols.some(row=>row.id===id),'duplicate identity');},
    ownDescriptor(node,key){return node.descriptors.get(key[1])??null;},
    installDescriptor(node,key,descriptor){node.descriptors.set(key[1],structuredClone(descriptor));
      if(descriptor.kind==='data')node.properties.set(key[1],structuredClone(descriptor.value));else node.properties.delete(key[1]);}
  };
  const object=(id,kind='object')=>controller.heap.set(id,{kind,prototype:'ordinary',properties:new Map(),descriptors:new Map(),...(kind==='closure'?{code:id,functionKind:'ordinary'}:{})});
  const apply=record=>{
    validateConstructionRecordV8(record,{value:validateProtocolValueV8});
    const staged=structuredClone(controller);applyConstructionRecordV8(staged,record,api);Object.assign(controller,staged);
  };
  const klass=(name,heritage=['undefined'])=>{
    object(name,'closure');object(name+'-prototype');
    apply({kind:'callable.define',object:name,constructorKind:heritage[0]==='undefined'?'base':'derived',classConstructor:true});
    apply({kind:'class.link',object:name,prototype:['ref',name+'-prototype'],heritage});
  };
  return {controller,api,object,apply,klass};
}

test('construction records have exact fields and no opaque bytecode or whole-state payload',()=>{
  for(const fields of Object.values(CONSTRUCTION_RECORD_FIELDS))assert(!fields.some(field=>['state','journal','bytecode','patches'].includes(field)));
  assert.throws(()=>validateConstructionRecordV8({kind:'callable.define',object:'C',constructorKind:'derived',classConstructor:false},{value:validateProtocolValueV8}),/capability/);
  assert.throws(()=>validateConstructionRecordV8({kind:'private.get',object:'o',privateId:'p',result:['num',1],targetState:{}},{value:validateProtocolValueV8}),/field/i);
});
test('class linking installs real descriptor and prototype distinctions',()=>{
  const {controller,klass}=fixture();klass('Base');klass('Derived',['ref','Base']);klass('Null',['null']);
  class Base{}class Derived extends Base{}class Null extends null{}
  const descriptor=controller.heap.get('Base').descriptors.get('prototype'),native=Object.getOwnPropertyDescriptor(Base,'prototype');
  assert.deepEqual([descriptor.writable,descriptor.enumerable,descriptor.configurable],[native.writable,native.enumerable,native.configurable]);
  assert.deepEqual(controller.heap.get('Derived').prototype,['ref','Base']);assert.equal(Object.getPrototypeOf(Derived),Base);
  assert.deepEqual(controller.heap.get('Derived-prototype').prototype,['ref','Base-prototype']);assert.equal(Object.getPrototypeOf(Derived.prototype),Base.prototype);
  assert.equal(controller.heap.get('Null-prototype').prototype,Object.getPrototypeOf(Null.prototype));
  assert.equal(controller.heap.get('Null').prototype,'ordinary');
});
test('method home and initializer ownership remain immutable',()=>{
  const {controller,object,apply,klass}=fixture();klass('C');object('init','closure');
  apply({kind:'callable.define',object:'init',constructorKind:null,classConstructor:false});
  apply({kind:'callable.home',object:'init',home:['ref','C-prototype']});
  apply({kind:'class.initializer',object:'C',placement:'instance',initializer:['ref','init']});
  assert.deepEqual(controller.heap.get('C').callable.instanceInitializer,['ref','init']);
  const before=structuredClone(controller);
  assert.throws(()=>apply({kind:'callable.home',object:'init',home:['ref','C']}),/immutable/);assert.deepEqual(controller,before);
  assert.throws(()=>apply({kind:'class.initializer',object:'C',placement:'static',initializer:['ref','init']}),/home/);assert.deepEqual(controller,before);
});
test('private fields preserve separate class identities and writes agree with native private state',()=>{
  const {controller,api,object,apply,klass}=fixture();klass('Base');klass('Derived',['ref','Base']);object('instance');object('other');
  for(const owner of ['Base','Derived'])apply({kind:'private.declare',id:owner+'-x',owner,name:'x'});
  apply({kind:'private.define',object:'instance',privateId:'Base-x',elementKind:'field',value:['num',1]});
  apply({kind:'private.define',object:'instance',privateId:'Derived-x',elementKind:'field',value:['num',2]});
  class Base{#x=1;read(){return this.#x;}write(n){this.#x=n;}}class Derived extends Base{#x=2;derived(){return this.#x;}}
  const native=new Derived();native.write(7);
  apply({kind:'private.set',object:'instance',privateId:'Base-x',value:['num',7]});
  apply({kind:'private.get',object:'instance',privateId:'Base-x',result:['num',native.read()]});
  apply({kind:'private.get',object:'instance',privateId:'Derived-x',result:['num',native.derived()]});
  apply({kind:'private.has',object:'other',privateId:'Base-x',result:false});
  assert.equal(controller.heap.get('other').privateElements,undefined);
  assert.deepEqual([...controller.heap.get('instance').properties],[]);
  assert.deepEqual(constructionReservedIdentitiesV8(controller),['Base-x','Derived-x']);
  assert.equal(restoreConstructionStateV8(controller,structuredClone(controller.protocol.construction),api).valid,true);
  assert.equal(describeConstructionObjectV8(controller.heap.get('instance')).privateElements[0].version,2);
});
test('private brand, readonly method and duplicate identity failures leave staged state unchanged',()=>{
  const {controller,object,apply,klass}=fixture();klass('C');object('o');object('method','closure');
  apply({kind:'callable.define',object:'method',constructorKind:null,classConstructor:false});
  apply({kind:'private.declare',id:'m',owner:'C',name:'m'});
  apply({kind:'private.define',object:'o',privateId:'m',elementKind:'method',value:['ref','method']});
  const before=structuredClone(controller);
  for(const record of [
    {kind:'private.set',object:'o',privateId:'m',value:['num',3]},
    {kind:'private.get',object:'C',privateId:'m',result:['ref','method']},
    {kind:'private.declare',id:'m',owner:'C',name:'different'},
    {kind:'private.declare',id:'another',owner:'C',name:'m'},
    {kind:'private.get',object:'o',privateId:'m',result:['num',9]}
  ]){assert.throws(()=>apply(record));assert.deepEqual(controller,before);}
});
test('restoration rejects forged capability, home, brand and private version metadata',()=>{
  const {controller,api,object,apply,klass}=fixture();klass('C');object('o');
  apply({kind:'private.declare',id:'x',owner:'C',name:'x'});
  apply({kind:'private.define',object:'o',privateId:'x',elementKind:'field',value:['num',2]});
  for(const change of [
    c=>{c.heap.get('C').callable.homeObject=['str','C-prototype'];},
    c=>{c.heap.get('C').callable.constructorKind=null;},
    c=>{c.heap.get('o').privateElements.get('x').version=0;},
    c=>{c.protocol.construction.privateNames[0].id='C';}
  ]){const forged=structuredClone(controller);change(forged);assert.throws(()=>restoreConstructionStateV8(forged,forged.protocol.construction,api));}
});
