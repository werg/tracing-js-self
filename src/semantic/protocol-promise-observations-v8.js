// Independent Promise identity and observable metadata. Native inspection reads
// descriptors only; it never invokes a guest getter, constructor or then method.
// Settlement stays with actual execution and the independent scheduler checks.
import {types} from 'node:util';
import {symbolPropertyKey} from '../property-keys.js';
const profile='owned-promise-source/1';
const own=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,getPrototype=Object.getPrototypeOf,
  extensible=Object.isExtensible;
const objectMethods=['__defineGetter__','__defineSetter__','hasOwnProperty','__lookupGetter__',
  '__lookupSetter__','isPrototypeOf','propertyIsEnumerable','toString','valueOf','toLocaleString'];
const valueToken=value=>({value});
const functionTag=name=>['builtinfn',name==='Object.prototype.toString'?'Object.toString':
  name==='Object.prototype.valueOf'?'Object.valueOf':name];
const canonicalName=name=>name==='Object.toString'?'Object.prototype.toString':
  name==='Object.valueOf'?'Object.prototype.valueOf':name;
function intrinsicRecord(name){
  const record={kind:'object',prototype:name==='Promise.prototype'?'Object.prototype':null,
    properties:Object.create(null),dataAttributes:Object.create(null),accessors:Object.create(null),propertyOrder:[],extensible:true};
  const data=(key,value,writable=true)=>{
    record.properties[key]=valueToken(value);record.dataAttributes[key]={writable,enumerable:false,configurable:true};
    record.propertyOrder.push(key);
  };
  if(name==='Promise.prototype'){
    data('constructor',['intrinsic','Promise']);
    for(const method of ['then','catch','finally'])data(method,functionTag('Promise.prototype.'+method));
    data(symbolPropertyKey('well-known:toStringTag'),['str','Promise'],false);
  }else{
    data('constructor',['intrinsic','Object']);
    for(const method of objectMethods.filter(method=>method!=='toLocaleString'))data(method,functionTag('Object.prototype.'+method));
    record.accessors.__proto__={get:valueToken(functionTag('Object.prototype.__proto__.get')),
      set:valueToken(functionTag('Object.prototype.__proto__.set')),enumerable:false,configurable:true};
    record.propertyOrder.push('__proto__');data('toLocaleString',functionTag('Object.prototype.toLocaleString'));
  }
  return record;
}
const intrinsicNames=new Set(['Promise','Object',...['then','catch','finally'].map(name=>'Promise.prototype.'+name),
  ...objectMethods.map(name=>'Object.prototype.'+name),'Object.prototype.__proto__.get','Object.prototype.__proto__.set']);
const functionNode=name=>({kind:'function',annotations:[{name:'intrinsic-identity/1',values:[],data:{name}}]});
function unchanged(value,captured){
  if(getPrototype(value)!==captured.prototype||extensible(value)!==captured.extensible)return false;
  const descriptors=own(value),actual=keys(descriptors),expected=keys(captured.descriptors);
  return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]&&
    ['value','get','set','writable','enumerable','configurable'].every(field=>
      Object.hasOwn(descriptors[key],field)===Object.hasOwn(captured.descriptors[key],field)&&
      Object.is(descriptors[key][field],captured.descriptors[key][field])));
}
export function createPromiseObservationAdapterV8(){
  let promisePrototype=null,objectPrototype=null;
  const nativeIntrinsics=new Map();
  return {id:profile,initializeRealm(evaluate){
    const promise=evaluate('Promise'),object=evaluate('Object');
    promisePrototype=Object.getOwnPropertyDescriptor(promise,'prototype').value;
    objectPrototype=Object.getOwnPropertyDescriptor(object,'prototype').value;
    const capture=(name,value)=>nativeIntrinsics.set(value,{name,descriptors:own(value),
      prototype:getPrototype(value),extensible:extensible(value)});
    capture('Promise',promise);capture('Object',object);
    const promises=own(promisePrototype),objects=own(objectPrototype);
    for(const name of ['then','catch','finally'])capture('Promise.prototype.'+name,promises[name].value);
    for(const name of objectMethods)capture('Object.prototype.'+name,objects[name].value);
    capture('Object.prototype.__proto__.get',objects.__proto__.get);
    capture('Object.prototype.__proto__.set',objects.__proto__.set);
  },metadataAdapter:{
    ownedType(value){return value[0]==='promise'?'reference':null;},
    ownedNode(value,ctx){
      if(value[0]==='promise'){
        const node=ctx.state.promises[value[1]];
        if(!node||node.kind!=='promise')ctx.fail('unallocated owned Promise identity');
        return ctx.defaultNode(value,{node});
      }
      if(value[0]==='intrinsic'&&['Promise.prototype','Object.prototype'].includes(value[1]))
        return ctx.defaultNode(value,{node:ctx.state.heap[value[1]]??intrinsicRecord(value[1])});
      if(['intrinsic','builtinfn'].includes(value[0])&&intrinsicNames.has(canonicalName(value[1])))
        return functionNode(canonicalName(value[1]));
      return null;
    },
    nativeNode(value,ctx){
      if(types.isProxy(value))ctx.fail('Promise metadata requires an ordinary unproxied identity');
      const intrinsic=nativeIntrinsics.get(value);
      if(intrinsic){
        if(!unchanged(value,intrinsic))ctx.fail('modified intrinsic callable requires its declared storage profile');
        return functionNode(intrinsic.name);
      }
      if(value===promisePrototype||value===objectPrototype)return ctx.defaultNode(value);
      if(!types.isPromise(value))return null;
      if(!promisePrototype)ctx.fail('Promise realm identity has not been initialized');
      return {...ctx.defaultNode(value),kind:'promise'};
    }
  }};
}
