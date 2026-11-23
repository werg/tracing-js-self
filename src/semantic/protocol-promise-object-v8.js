// Promise objects use the ordinary descriptor machine. Intrinsic identities
// are materialized together, once per shared realm, rather than supplied as
// unverified ordinary allocations by the generated trace.
import {assertAlgorithmFields} from './ir.js';

export const PROMISE_OBJECT_PROFILE_V8='promise-object/1';
export const PROMISE_OBJECT_STATE_V8='semantic-promise-object-state/1';
export const PROMISE_OBJECT_RECORD_FIELDS=Object.freeze({
  'promise.intrinsics':Object.freeze(['kind']),
  'promise.intrinsic.get':Object.freeze(['kind','base','key','result']),
  'property.getPrototypeOf':Object.freeze(['kind','object','result']),
  'property.isExtensible':Object.freeze(['kind','object','result']),
  'property.descriptor':Object.freeze(['kind','object','key','descriptor','name'])
});
const objectMethods=['__defineGetter__','__defineSetter__','hasOwnProperty','__lookupGetter__',
  '__lookupSetter__','isPrototypeOf','propertyIsEnumerable','toString','valueOf','toLocaleString'];
export const PROMISE_OBJECT_INTRINSICS_V8=Object.freeze(['Promise','Promise.prototype',
  'Promise.prototype.then','Promise.prototype.catch','Promise.prototype.finally','Object','Object.prototype',
  ...objectMethods.map(name=>'Object.prototype.'+name),'Object.prototype.__proto__.get','Object.prototype.__proto__.set']);
export const promiseIntrinsicIdV8=name=>'intrinsic'+name.replace(/[^a-z0-9]/gi,'').toLowerCase();
const intrinsicCallables=PROMISE_OBJECT_INTRINSICS_V8.filter(name=>!['Promise.prototype','Object.prototype'].includes(name));
const copy=structuredClone;
const fail=message=>{throw new TypeError('Promise object: '+message);};
const id=value=>{if(typeof value!=='string'||!value||value.length>256)fail('bounded identity required');};
const ordinary=prototype=>({kind:'object',code:null,captures:[],prototype,properties:new Map(),
  descriptors:new Map(),keyOrder:[],extensible:true});
function install(node,key,value,{writable=true,enumerable=false,configurable=true}={}){
  node.properties.set(key,copy(value));node.descriptors.set(key,{kind:'data',writable,enumerable,configurable});
  node.keyOrder.push(key);
}
export function initializePromiseObjectsV8(controller,api){
  const protocol=api.state(controller);
  api.require(protocol.promiseObjects===null,'intrinsics are already initialized');
  for(const name of PROMISE_OBJECT_INTRINSICS_V8)api.fresh(controller,promiseIntrinsicIdV8(name));
  for(const name of intrinsicCallables)controller.heap.set(promiseIntrinsicIdV8(name),{kind:'intrinsic',intrinsicName:name,
    callableKind:['Promise','Object'].includes(name)?'constructor':'function',properties:new Map()});
  const object=ordinary(null);
  install(object,'constructor',['ref',promiseIntrinsicIdV8('Object')]);
  for(const name of objectMethods.filter(name=>name!=='toLocaleString'))install(object,name,['ref',promiseIntrinsicIdV8('Object.prototype.'+name)]);
  object.descriptors.set('__proto__',{kind:'accessor',get:['ref',promiseIntrinsicIdV8('Object.prototype.__proto__.get')],
    set:['ref',promiseIntrinsicIdV8('Object.prototype.__proto__.set')],enumerable:false,configurable:true});
  object.keyOrder.push('__proto__');install(object,'toLocaleString',['ref',promiseIntrinsicIdV8('Object.prototype.toLocaleString')]);
  controller.heap.set(promiseIntrinsicIdV8('Object.prototype'),object);
  const promise=ordinary(['ref',promiseIntrinsicIdV8('Object.prototype')]);
  install(promise,'constructor',['ref',promiseIntrinsicIdV8('Promise')]);
  for(const name of ['then','catch','finally'])install(promise,name,['ref',promiseIntrinsicIdV8('Promise.prototype.'+name)]);
  install(promise,['symbol','well-known:toStringTag'],['str','Promise'],{writable:false});
  controller.heap.set(promiseIntrinsicIdV8('Promise.prototype'),promise);
  for(const node of controller.heap.values())if(node.kind==='promise'&&[undefined,'ordinary'].includes(node.prototype))
    node.prototype=['ref',promiseIntrinsicIdV8('Promise.prototype')];
  protocol.promiseObjects={schema:PROMISE_OBJECT_STATE_V8,initialized:true};
}
export function validatePromiseObjectRecordV8(record,{value:validate}={}){
  const fields=PROMISE_OBJECT_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'Promise object record');
  if(record.object!==undefined)id(record.object);
  if(record.kind==='promise.intrinsic.get'){
    if(!['Promise','Object'].includes(record.base)||JSON.stringify(record.key)!=='["str","prototype"]')fail('intrinsic member');
    validate?.(record.result);
  }
  if(record.kind==='property.getPrototypeOf'){
    validate?.(record.result);if(!['null','ref'].includes(record.result?.[0]))fail('prototype result');
  }
  if(record.kind==='property.isExtensible'){
    validate?.(record.result);if(record.result?.[0]!=='bool')fail('extensibility result');
  }
  if(record.kind==='property.descriptor'){
    if(!Array.isArray(record.key)||record.key.length!==2||!['str','symbol'].includes(record.key[0]))fail('property key');
    if(record.descriptor===null){if(record.name!==null)fail('absent descriptor allocation');}
    else{id(record.name);if(!['data','accessor'].includes(record.descriptor?.kind))fail('descriptor kind');}
  }
  return true;
}
export function applyPromiseObjectRecordV8(controller,record,api){
  if(!validatePromiseObjectRecordV8(record,{value:value=>api.known(controller,value)}))return false;
  if(record.kind==='promise.intrinsics'){initializePromiseObjectsV8(controller,api);return true;}
  api.require(controller.protocol?.promiseObjects?.initialized,'intrinsics are not initialized');
  if(record.kind==='promise.intrinsic.get'){
    api.require(controller.protocol?.promiseObjects?.initialized&&
      api.eq(record.result,['ref',promiseIntrinsicIdV8(record.base+'.prototype')]),'intrinsic prototype identity differs');return true;
  }
  const node=api.heapNode(controller,record.object);
  if(record.kind==='property.getPrototypeOf'){
    let prototype=node.prototype;
    if(prototype===undefined||prototype==='ordinary'){
      api.require(node.kind==='object'&&controller.heap.has(promiseIntrinsicIdV8('Object.prototype')),'implicit prototype requires its intrinsic profile');
      prototype=['ref',promiseIntrinsicIdV8('Object.prototype')];
    }
    api.require(api.eq(record.result,prototype===null?['null']:prototype),'prototype identity differs');return true;
  }
  if(record.kind==='property.isExtensible'){
    api.require(api.eq(record.result,['bool',node.extensible!==false]),'extensibility differs');return true;
  }
  api.knownKey(controller,record.key);
  const descriptor=api.ownDescriptor(node,record.key);
  api.require(api.eq(record.descriptor,descriptor),'own descriptor differs');
  if(descriptor===null)return true;
  const values=descriptor.kind==='data'?{value:descriptor.value,writable:['bool',descriptor.writable]}:
    {get:descriptor.get,set:descriptor.set};
  values.enumerable=['bool',descriptor.enumerable];values.configurable=['bool',descriptor.configurable];
  api.allocate(controller,{kind:'allocate',name:record.name,objectKind:'object',length:null,
    properties:Object.entries(values).map(([key,value])=>({key:['str',key],value})),
    code:null,captures:[],functionKind:null,lexicalReceiver:null});return true;
}
export function restorePromiseObjectStateV8(controller,snapshot,api){
  assertAlgorithmFields(snapshot,['schema','initialized'],'Promise object state');
  api.require(snapshot.schema===PROMISE_OBJECT_STATE_V8&&snapshot.initialized===true,'intrinsic initialization state');
  for(const name of PROMISE_OBJECT_INTRINSICS_V8){
    const node=controller.heap.get(promiseIntrinsicIdV8(name));api.require(node,'missing initialized intrinsic '+name);
    if(['Promise.prototype','Object.prototype'].includes(name))api.require(node.kind==='object','intrinsic prototype kind');
    else{
      assertAlgorithmFields(node,['kind','intrinsicName','callableKind','properties'],'intrinsic identity');
      api.require(node.kind==='intrinsic'&&node.intrinsicName===name&&
        node.callableKind===(['Promise','Object'].includes(name)?'constructor':'function')&&
        node.properties instanceof Map&&node.properties.size===0,'altered intrinsic callable identity');
    }
  }
  for(const [name,node]of controller.heap)if(node.kind==='intrinsic')
    api.require(intrinsicCallables.includes(node.intrinsicName)&&promiseIntrinsicIdV8(node.intrinsicName)===name,'undeclared intrinsic identity');
  return {valid:true};
}
export function isPromiseIntrinsicValueV8(value){
  return ['intrinsic','builtinfn'].includes(value?.[0])&&PROMISE_OBJECT_INTRINSICS_V8.includes(value[1]);
}
