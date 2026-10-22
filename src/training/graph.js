// Identity-preserving boundary for the deliberately bounded training profile.
// No user getter, toJSON, coercion hook, or guest code is invoked.
import {types} from 'node:util';
import {encode, decode, token} from '../values.js';

export function importGraph(state, roots, allocate, {maxNodes=256,maxProperties=4096}={}) {
  if (!Array.isArray(roots)) throw new TypeError('Entry arguments must be an array');
  const seen = new WeakMap();
  let properties = 0, nodes = 0;
  function visit(value) {
    if (value === null || typeof value !== 'object') return encode(value);
    if (types.isProxy(value)) throw new TypeError('Proxy input is unsupported');
    if (seen.has(value)) return ['ref',seen.get(value)];
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array))
      throw new TypeError('Only plain data objects and ordinary arrays are supported');
    if (++nodes > maxNodes) throw new RangeError('Entry graph node limit');
    const id=allocate('obj');
    seen.set(value,id);
    const entity={id,kind:array?'array':'object',properties:{},
      propertyVersions:{},shapeVersion:0,version:0};
    state.heap[id]=entity;
    const keys=Reflect.ownKeys(value);
    if (array && (!Number.isSafeInteger(value.length) || value.length > maxProperties))
      throw new RangeError('Entry array limit');
    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') throw new TypeError('Unsupported input property key');
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !Object.hasOwn(descriptor,'value'))
        throw new TypeError('Accessors are not valid entry graph data');
      if (++properties > maxProperties) throw new RangeError('Entry property limit');
      if (array && key === 'length') {
        entity.properties.length=token(encode(value.length));
      } else {
        entity.properties[key]=token(visit(descriptor.value));
      }
      entity.propertyVersions[key]=0;
    }
    if (array) {
      for(let i=0;i<value.length;i++)
        if(!Object.hasOwn(entity.properties,String(i)))
          throw new TypeError('Sparse entry arrays are not in training-js/1');
    }
    return ['ref',id];
  }
  return roots.map(visit);
}

export function realizeGraph(heap, roots) {
  const seen=new Map();
  function visit(value) {
    if (value[0] !== 'ref') return decode(value);
    const id=value[1];
    if(seen.has(id))return seen.get(id);
    const entity=heap[id];
    if (!entity || !['object','array'].includes(entity.kind))
      throw new TypeError('Entry graph contains an unsupported identity');
    const result=entity.kind==='array'?new Array(decode(entity.properties.length.value)):{};
    seen.set(id,result);
    for(const [key,record] of Object.entries(entity.properties)){
      if (entity.kind==='array' && key==='length') continue;
      Object.defineProperty(result,key,{value:visit(record.value),writable:true,
        configurable:true,enumerable:true});
    }
    return result;
  }
  return roots.map(visit);
}

// Used for independently comparing values, aliases, cycles, property absence,
// -0/NaN/Infinity and array length without relying on JSON structural equality.
export function describeGraph(roots) {
  const seen=new WeakMap(), objects=[];
  function visit(v) {
    if(v===null || typeof v!=='object')return encode(v);
    if(seen.has(v))return ['ref',seen.get(v)];
    const id='o'+objects.length;
    seen.set(v,id);
    const kind=Array.isArray(v)?'array':'object';
    const record={id,kind,properties:[]};
    objects.push(record);
    for(const key of Reflect.ownKeys(v)) {
      if(typeof key!=='string')throw new TypeError('Unsupported graph key');
      const desc=Object.getOwnPropertyDescriptor(v,key);
      if (!Object.hasOwn(desc,'value'))throw new TypeError('Accessor in observable graph');
      record.properties.push([key,visit(desc.value)]);
    }
    return ['ref',id];
  }
  return {roots:roots.map(visit),objects};
}
