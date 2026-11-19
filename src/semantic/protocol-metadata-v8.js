// Private independent metadata receipts. Inspection is descriptor-only and
// refuses Proxies before a single trap can run. No receipt is a model target.
import {types,isDeepStrictEqual} from 'node:util';
import {encode} from '../values.js';
import {propertyKeyValue,WELL_KNOWN_SYMBOLS} from '../property-keys.js';
export const PROTOCOL_METADATA_SCHEMA='source-protocol-metadata/1';
const copy=structuredClone;
const fail=message=>{throw new TypeError('Protocol metadata observation: '+message);};
const cap=4096;
function tracker(adapter){
  const references=new Map(),symbols=new Map(),objects=[],symbolRows=[];
  function value(raw){const kind=adapter.type(raw);
    if(kind==='symbol'){
      const identity=adapter.identity(raw);if(!symbols.has(identity)){
        if(symbolRows.length>=cap)throw new RangeError('Symbol observation bound');
        const id='s'+(symbolRows.length+1);symbols.set(identity,id);symbolRows.push({id,...adapter.symbol(raw)});
      }return ['symbol',symbols.get(identity)];
    }
    if(kind==='reference'){
      const identity=adapter.identity(raw);if(!references.has(identity)){
        if(objects.length>=cap)throw new RangeError('Object observation bound');
        const id='r'+(objects.length+1);references.set(identity,id);objects.push({id,raw});
      }return ['ref',references.get(identity)];
    }
    return adapter.scalar(raw);
  }
  function snapshot(){const rows=[];
    for(let index=0;index<objects.length;index++){
      const {id,raw}=objects[index],node=adapter.object(raw);
      if(node.kind==='function'){rows.push({id,kind:'function'});continue;}
      const prototype=node.prototype===null||typeof node.prototype==='string'?node.prototype:value(node.prototype);
      const properties=node.properties.map(({key,descriptor:d})=>({key:value(key),descriptor:d.kind==='data'?
        {kind:'data',value:value(d.value),writable:d.writable,enumerable:d.enumerable,configurable:d.configurable}:
        {kind:'accessor',get:value(d.get),set:value(d.set),enumerable:d.enumerable,configurable:d.configurable}}));
      rows.push({id,kind:node.kind,prototype,extensible:node.extensible,properties});
    }
    return {objects:rows,symbols:copy(symbolRows)};
  }
  return {value,snapshot};
}
const descriptionGetter=Object.getOwnPropertyDescriptor(Symbol.prototype,'description').get;
const symbolKeyFor=Symbol.keyFor,apply=Reflect.apply;
const nativeWellKnown=new Map(WELL_KNOWN_SYMBOLS.map(name=>[Symbol[name],name]));
export function createNativeProtocolMetadata({initialValues=[],intrinsicPrototypes=[]}={}){
  const names=['Object.prototype','Array.prototype','Function.prototype'];
  const ordinaryPrototypes=new Map([[Object.prototype,names[0]],[Array.prototype,names[1]],[Function.prototype,names[2]]]);
  intrinsicPrototypes.forEach((value,index)=>ordinaryPrototypes.set(value,names[index%3]));
  const metadata=tracker({
    type(value){if(value!==null&&['object','function'].includes(typeof value)){
      if(types.isProxy(value))fail('Proxy metadata is outside the profile');return 'reference';}
      return typeof value==='symbol'?'symbol':'scalar';},
    identity:value=>value,scalar:encode,
    symbol(value){const description=apply(descriptionGetter,value,[]),name=nativeWellKnown.get(value),key=symbolKeyFor(value);
      return name?{kind:'well-known',name,description:encode(description)}:
        key!==undefined?{kind:'registry',key,description:encode(description)}:{kind:'unique',description:encode(description)};},
    object(value){
      if(types.isProxy(value))fail('Proxy metadata is outside the profile');
      if(typeof value==='function')return {kind:'function'};
      const descriptors=Object.getOwnPropertyDescriptors(value),prototype=Object.getPrototypeOf(value);
      return {kind:Array.isArray(value)?'array':'object',prototype:prototype===null?null:ordinaryPrototypes.has(prototype)?ordinaryPrototypes.get(prototype):prototype,
        extensible:Object.isExtensible(value),properties:Reflect.ownKeys(descriptors).map(key=>{
          const d=descriptors[key];return {key,descriptor:Object.hasOwn(d,'value')?
            {kind:'data',value:d.value,writable:d.writable,enumerable:d.enumerable,configurable:d.configurable}:
            {kind:'accessor',get:d.get,set:d.set,enumerable:d.enumerable,configurable:d.configurable}};
        })};
    }
  });
  for(const value of initialValues)metadata.value(value);metadata.snapshot();
  return {setIntrinsicPrototypes(values){values.forEach((value,index)=>ordinaryPrototypes.set(value,names[index%3]));},
    observe(site,kind,value){if(!['finally','break','continue'].includes(kind))metadata.value(value);
      return {schema:PROTOCOL_METADATA_SCHEMA,site,kind,...metadata.snapshot()};}};
}
function ownedKeys(node){
  const present=key=>Object.hasOwn(node.properties??{},key)||Object.hasOwn(node.accessors??{},key);
  const keys=[...new Set([...(node.propertyOrder??[]),...Object.keys(node.properties??{}),...Object.keys(node.accessors??{})])].filter(present);
  const integer=key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<4294967295;
  return [...keys.filter(integer).sort((a,b)=>Number(a)-Number(b)),
    ...keys.filter(key=>!integer(key)&&propertyKeyValue(key)[0]==='str'),...keys.filter(key=>propertyKeyValue(key)[0]==='symbol')];
}
export function createOwnedProtocolMetadata(bundle){
  let currentState=bundle.initialState;
  const metadata=tracker({
    type(value){if(!Array.isArray(value))fail('missing owned observation value');
      if(value[0]==='symbol')return 'symbol';
      if(['ref','builtinfn','intrinsic'].includes(value[0]))return 'reference';return 'scalar';},
    identity:value=>JSON.stringify(value),scalar:value=>copy(value),
    symbol(value){if(value[1].startsWith('well-known:')){const name=value[1].slice(11);
      if(!WELL_KNOWN_SYMBOLS.includes(name))fail('unknown well-known Symbol');return {kind:'well-known',name,description:['str','Symbol.'+name]};}
      const symbol=currentState.heap[value[1]];if(symbol?.kind!=='symbol')fail('missing Symbol declaration');
      return symbol.registeredKey===undefined?{kind:'unique',description:copy(symbol.description)}:
        {kind:'registry',key:symbol.registeredKey,description:copy(symbol.description)};
    },
    object(value){
      if(value[0]!=='ref')return {kind:'function'};
      const node=currentState.heap[value[1]];if(!node||!['object','array','function'].includes(node.kind))fail('nonordinary owned object');
      if(node.kind==='function'){
        if(Object.keys(node.properties??{}).length||Object.keys(node.accessors??{}).length||node.prototypeInitialized||node.classConstructor)
          fail('function own-state observation requires the construction profile');
        return {kind:'function'};
      }
      const prototype=node.prototype===undefined?(node.kind==='array'?'Array.prototype':'Object.prototype'):
        ['Object.prototype','Array.prototype'].includes(node.prototype)?node.prototype:
        node.prototype===null?null:typeof node.prototype==='string'?['ref',node.prototype]:fail('unmodeled owned prototype');
      return {kind:node.kind,prototype,extensible:node.extensible!==false,properties:ownedKeys(node).map(key=>{
        const accessor=node.accessors?.[key];
        const descriptor=accessor?{kind:'accessor',get:accessor.get?.value??['undefined'],set:accessor.set?.value??['undefined'],
          enumerable:accessor.enumerable,configurable:accessor.configurable}:
          {kind:'data',value:node.properties[key].value,writable:true,enumerable:!(node.kind==='array'&&key==='length'),
            configurable:!(node.kind==='array'&&key==='length'),...node.dataAttributes?.[key]};
        return {key:propertyKeyValue(key),descriptor};
      })};
    }
  });
  for(const value of bundle.entrySpec.arguments)metadata.value(value);metadata.snapshot();
  return {observe({row,tag,state}){currentState=state;if(!['finally','break','continue'].includes(row.kind))metadata.value(tag);
    return {schema:PROTOCOL_METADATA_SCHEMA,site:row.site,kind:row.kind,...metadata.snapshot()};}};
}
export function compareProtocolMetadata(expected,observed){
  if(!Array.isArray(expected)||!Array.isArray(observed))fail('metadata receipt arrays required');
  for(let index=0;index<Math.max(expected.length,observed.length);index++)if(!isDeepStrictEqual(expected[index],observed[index]))
    return {schema:PROTOCOL_METADATA_SCHEMA,status:'mismatch',checked:index,index,expected:expected[index]??null,observed:observed[index]??null};
  return {schema:PROTOCOL_METADATA_SCHEMA,status:'agreed',checked:expected.length,
    coverage:['ordinary-own-key-order','data-descriptor-values-and-flags','accessor-identities-and-flags','prototype-identity','extensibility','Symbol-identity-description-registry'],
    unsupported:['Proxy-metadata','function-own-state','private-brands','generator-continuations']};
}
