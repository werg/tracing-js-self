import {symbolPropertyKey} from './property-keys.js';

// These are ordinary intrinsic objects, not callable constructors. An owned
// generator's per-function prototype is a separate, freshly allocated object.
export const GENERATOR_INTRINSIC_PROTOTYPES=Object.freeze([
  'GeneratorFunction.prototype','Generator.prototype','Iterator.prototype'
]);
export function generatorIntrinsicParent(name){
  if(name==='GeneratorFunction.prototype')return 'Function.prototype';
  if(name==='Generator.prototype')return 'Iterator.prototype';
  if(name==='Iterator.prototype')return 'Object.prototype';
  return undefined;
}
export function generatorIntrinsicProperty(name,key){
  const data=(value,writable=true)=>({value,attributes:{writable,enumerable:false,configurable:true}});
  while(GENERATOR_INTRINSIC_PROTOTYPES.includes(name)){
    if(name==='GeneratorFunction.prototype'){
      if(key==='prototype')return data(['intrinsic','Generator.prototype'],false);
      if(key===symbolPropertyKey('well-known:toStringTag'))return data(['str','GeneratorFunction'],false);
      if(key==='constructor')throw new TypeError('Dynamic GeneratorFunction constructor is outside the owned profile');
    }
    if(name==='Generator.prototype'){
      if(['next','return','throw'].includes(key))return data(['builtinfn','Generator.'+key]);
      if(key==='constructor')return data(['intrinsic','GeneratorFunction.prototype'],false);
      if(key===symbolPropertyKey('well-known:toStringTag'))return data(['str','Generator'],false);
    }
    if(name==='Iterator.prototype'&&key===symbolPropertyKey('well-known:iterator'))
      return data(['builtinfn','Iterator.identity']);
    name=generatorIntrinsicParent(name);
  }
  if(name==='Function.prototype'){
    if(key===symbolPropertyKey('well-known:hasInstance'))return data(['builtinfn','Function.prototype.hasInstance'],false);
    if(['call','apply'].includes(key))return data(['builtinfn','Function.prototype.'+key]);
    if(['bind','caller','arguments','constructor','toString'].includes(key))
      throw new TypeError('Inherited function adapter requires its owned profile');
  }
  if(key==='valueOf'||key==='toString')return data(['builtinfn',key==='valueOf'?'Object.valueOf':'Object.toString']);
  if(['constructor','__proto__','hasOwnProperty','isPrototypeOf','propertyIsEnumerable','toLocaleString','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__'].includes(key))
    throw new TypeError('Inherited ordinary intrinsic property requires its owned profile');
  return data(['undefined']);
}

export function generatorInstancePrototype(heap,fn){
  if(fn?.kind!=='function'||fn.generatorFunction!==true)
    throw new TypeError('Generator invocation needs its exact owned function identity');
  if(Object.hasOwn(fn.accessors??{},'prototype'))
    throw new TypeError('Generator prototype accessor needs an owned creation continuation');
  const value=fn.properties.prototype?.value??['undefined'];
  if(value[0]==='ref'){
    if(!['object','array','function','generator'].includes(heap[value[1]]?.kind))
      throw new TypeError('Generator prototype requires an owned ordinary object');
    return value[1];
  }
  if(value[0]==='intrinsic'&&[...GENERATOR_INTRINSIC_PROTOTYPES,'Object.prototype','Array.prototype','Function.prototype'].includes(value[1]))return value[1];
  if(['promise','intrinsic','builtinfn','hostfn'].includes(value[0]))
    throw new TypeError('Exotic generator prototype requires its explicit object profile');
  return 'Generator.prototype';
}
