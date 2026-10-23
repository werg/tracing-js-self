// Commit a replay-verified owned data graph back to an explicitly supplied
// live host graph. This is a narrow data-only boundary: functions, proxies,
// descriptors and native resources must never cross it.
import {types} from 'node:util';
import {decode} from './values.js';

export function synchronizeLiveGraph(initialHeap,finalHeap,root,original,result,{stage=false}={}){
  const originals=new Map();
  const validateHost=(object,array)=>{
    if(!object || typeof object!=='object' || types.isProxy(object) ||
       Object.getPrototypeOf(object)!==(array?Array.prototype:Object.prototype) &&
       !(Object.getPrototypeOf(object)===null&&!array))
      throw new TypeError('Live values must be plain data objects or dense arrays');
    if(!Object.isExtensible(object))
      throw new TypeError('A live host object must be extensible');
    for(const key of Reflect.ownKeys(object)){
      const d=Object.getOwnPropertyDescriptor(object,key);
      if(typeof key!=='string'||!d||!Object.hasOwn(d,'value') ||
         (!array||key!=='length') && (!d.writable||!d.configurable||!d.enumerable))
        throw new TypeError('Live host descriptors must be mutable own data properties');
      if(array&&key==='length'&&!d.writable)
        throw new TypeError('Live array length must be writable');
    }
  };
  function bind(value,object){
    if(value[0]!=='ref')return;
    const id=value[1],entity=initialHeap[id];
    if(!entity||!['object','array'].includes(entity.kind))
      throw new TypeError('Live guest identity is not an ordinary data object');
    if(originals.has(id)){
      if(originals.get(id)!==object)throw new TypeError('Live aliases must preserve identity');
      return;
    }
    validateHost(object,entity.kind==='array');
    originals.set(id,object);
    for(const [key,slot] of Object.entries(entity.properties)){
      if(entity.kind==='array'&&key==='length')continue;
      const desc=Object.getOwnPropertyDescriptor(object,key);
      if(!desc||!Object.hasOwn(desc,'value'))
        throw new TypeError('Live graph was externally modified during guest execution');
      bind(slot.value,desc.value);
    }
  }
  bind(root,original);
  const verifyInitial=()=>{
    const seen=new Set();
    function visit(value,host){
      if(!Array.isArray(value))throw new TypeError('Invalid initial live graph token');
      if(value[0]!=='ref'){
        if(!Object.is(decode(value),host))
          throw new TypeError('Live input data changed outside the owned guest');
        return;
      }
      const id=value[1],entity=initialHeap[id];
      if(originals.get(id)!==host||!entity)
        throw new TypeError('Live input identity changed outside the owned guest');
      if(seen.has(id))return;
      seen.add(id);
      const array=entity.kind==='array';
      validateHost(host,array);
      const expected=new Set(Object.keys(entity.properties));
      const keys=Reflect.ownKeys(host);
      if(expected.size!==keys.length||keys.some(key=>!expected.has(key)))
        throw new TypeError('Live input property shape changed outside the owned guest');
      for(const [key,slot] of Object.entries(entity.properties)){
        const desc=Object.getOwnPropertyDescriptor(host,key);
        if(!desc||!Object.hasOwn(desc,'value'))
          throw new TypeError('Live input descriptor changed outside the owned guest');
        visit(slot.value,desc.value);
      }
    }
    visit(root,original);
  };
  verifyInitial();

  const objects=new Map(originals),actions=new Map(),visited=new Set();
  function materialize(value){
    if(!Array.isArray(value))throw new TypeError('Invalid live guest token');
    if(value[0]!=='ref')return decode(value);
    const id=value[1],entity=finalHeap[id];
    if(!entity||!['object','array'].includes(entity.kind))
      throw new TypeError('Live boundary cannot export guest functions or exotic objects');
    if(!objects.has(id)){
      const length=entity.kind==='array'?decode(entity.properties.length?.value):0;
      if(entity.kind==='array'&&(!Number.isSafeInteger(length)||length<0||length>4096))
        throw new RangeError('Live array exceeds the data-only boundary');
      objects.set(id,entity.kind==='array'?new Array(length):{});
    }
    plan(id);
    return objects.get(id);
  }
  function plan(id){
    if(visited.has(id))return;
    visited.add(id);
    const entity=finalHeap[id],object=objects.get(id),array=entity?.kind==='array';
    if(!entity||!['object','array'].includes(entity.kind))
      throw new TypeError('Unsupported live guest identity');
    const length=array?decode(entity.properties.length?.value):null;
    if(array&&(!Number.isSafeInteger(length)||length<0||length>4096))
      throw new RangeError('Invalid live array length');
    const entries=new Map();
    actions.set(id,{object,array,length,entries});
    for(const [key,slot] of Object.entries(entity.properties)){
      if(array&&key==='length')continue;
      if(key==='__proto__')throw new TypeError('Unsafe live property name');
      entries.set(key,materialize(slot.value));
    }
  }
  for(const id of originals.keys())materialize(['ref',id]);
  const output=materialize(result);
  // Stage first. The onTrace success hook may itself throw, so it must run
  // before any live host mutation; the guard is rechecked at commit time.
  const commit=()=>{
    verifyInitial();
    for(const {object,array} of actions.values())validateHost(object,array);
    for(const {object,array,length,entries} of actions.values()){
      for(const key of Reflect.ownKeys(object)){
        if(array&&key==='length')continue;
        if(!entries.has(key))Reflect.deleteProperty(object,key);
      }
      if(array)object.length=length;
      for(const [key,value] of entries)
        Object.defineProperty(object,key,{value,writable:true,enumerable:true,configurable:true});
    }
  };
  if(stage)return {result:output,commit};
  commit();
  return output;
}
