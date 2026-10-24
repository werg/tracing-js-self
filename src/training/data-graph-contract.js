// Descriptor-only, effect-free boundary inspection for the bounded data profile.
// Never enumerate by reading guest values, coercing keys, or calling toJSON.
import {isProxy} from '#owned-proxy-check';

function ordinaryPrototype(proto,kind) {
  if(kind==='array') {
    if(proto===Array.prototype)return true;
    // Reference execution runs in a separate vm realm.
    return Array.isArray(proto) &&
      Object.getOwnPropertyDescriptor(
        Object.getOwnPropertyDescriptor(proto,'constructor')?.value??{},'prototype'
      )?.value===proto;
  }
  if(proto===Object.prototype)return true;
  return proto!==null && Object.getPrototypeOf(proto)===null &&
    Object.getOwnPropertyDescriptor(proto,'constructor')?.value?.name==='Object' &&
    Object.getOwnPropertyDescriptor(
      Object.getOwnPropertyDescriptor(proto,'constructor').value,'prototype'
    )?.value===proto;
}

export function inspectDataObject(value) {
  if(value===null||typeof value!=='object'||isProxy(value))
    throw new TypeError('Unsupported observable boundary: expected plain data object');
  const kind=Array.isArray(value)?'array':'object';
  const proto=Object.getPrototypeOf(value);
  if(!ordinaryPrototype(proto,kind) && !(kind==='object'&&proto===null))
    throw new TypeError('Unsupported observable boundary: custom prototype');
  if(!Object.isExtensible(value))
    throw new TypeError('Unsupported observable boundary: nonextensible object');
  const keys=Reflect.ownKeys(value),descriptors=new Map();
  for(const key of keys){
    if(typeof key!=='string'||key==='__proto__')
      throw new TypeError('Unsupported observable boundary: property key');
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(!d||!Object.hasOwn(d,'value'))
      throw new TypeError('Unsupported observable boundary: accessor');
    if(kind==='array'&&key==='length') {
      if(d.enumerable||d.configurable||!d.writable||
         !Number.isSafeInteger(d.value)||d.value<0||d.value>4294967295)
        throw new TypeError('Unsupported observable boundary: array length descriptor');
    }else if(!d.enumerable||!d.configurable||!d.writable)
      throw new TypeError('Unsupported observable boundary: property descriptor');
    descriptors.set(key,d);
  }
  if(kind==='array'&&!descriptors.has('length'))
    throw new TypeError('Unsupported observable boundary: missing array length');
  return {kind,prototype:proto===null?null:'ordinary',descriptors};
}

// Owned entities use a separate descriptor representation. An accessor or
// custom prototype must never be flattened by the graph reconstruction.
export function inspectOwnedDataEntity(entity) {
  if(!entity||!['array','object'].includes(entity.kind))
    throw new TypeError('Unsupported observable boundary: non-data identity');
  if(Object.keys(entity.accessors??{}).length)
    throw new TypeError('Unsupported observable boundary: owned accessor');
  if(entity.kind==='array'&&entity.prototype!==undefined &&
     entity.prototype!=='Array.prototype')
    throw new TypeError('Unsupported observable boundary: array prototype');
  if(entity.kind==='object'&&entity.prototype!==undefined &&
     entity.prototype!==null&&entity.prototype!=='Object.prototype')
    throw new TypeError('Unsupported observable boundary: object prototype');
  return entity.prototype===null?null:'ordinary';
}
