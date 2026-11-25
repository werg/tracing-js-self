// Independently derived bounded Set and Map construction and mutations.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {decode} from '../values.js';

export const COLLECTION_PROFILE_V8='owned-collections/1';
export const COLLECTION_STATE_V8='semantic-collections-state/1';
const bound=10000, U=['undefined'], N=['null'];
const recordDefinitions={
  'set.lookup':['kind','object','key','method'],'set.create':['kind','name','iterable'],
  'set.size':['kind','object','result'],'set.add':['kind','object','value','result'],
  'set.has':['kind','object','value','result'],'set.delete':['kind','object','value','result'],
  'set.clear':['kind','object','result'],
  'map.lookup':['kind','object','key','method'],'map.create':['kind','name','iterable'],
  'map.size':['kind','object','result'],'map.get':['kind','object','key','result'],
  'map.has':['kind','object','key','result'],'map.set':['kind','object','key','value','result'],
  'map.delete':['kind','object','key','result'],'map.clear':['kind','object','result']
};
export const COLLECTION_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries(recordDefinitions)
  .map(([kind,fields])=>[kind,Object.freeze(fields)])));
const identity=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Collection identity');};
function sameValueZero(left,right){
  if(left[0]!==right[0])return false;
  if(left[0]==='ref'||left[0]==='symbol')return left[1]===right[1];
  if(left[0]==='num'){const a=decode(left),b=decode(right);return a===b||Number.isNaN(a)&&Number.isNaN(b);}
  return JSON.stringify(left)===JSON.stringify(right);
}
function normalize(value){return value[0]==='num'&&decode(value)===0?['num',0]:structuredClone(value);}
function arrayNode(controller,value,api){
  api.require(value?.[0]==='ref','collection constructor requires a dense ordinary array');
  const array=api.heapNode(controller,value[1]);
  api.require(array.kind==='array'&&[undefined,'ordinary','Array.prototype'].includes(array.prototype),
    'collection constructor requires a default array');
  api.require(!api.ownDescriptor(array,['symbol','well-known:iterator'])&&
    [...(array.descriptors?.values()??[])].every(row=>row.kind==='data'),
    'collection constructor iterator or accessors require a separate profile');
  const length=api.ownDescriptor(array,['str','length'])?.value;
  api.require(length?.[0]==='num'&&Number.isSafeInteger(decode(length))&&decode(length)>=0&&decode(length)<=bound,
    'collection constructor array length bound');
  return {array,length:decode(length)};
}
function setEntries(controller,value,api){
  api.known(controller,value);
  if(value[0]==='undefined'||value[0]==='null')return [];
  const {array,length}=arrayNode(controller,value,api),result=[];
  for(let i=0;i<length;i++){
    const descriptor=api.ownDescriptor(array,['str',String(i)]);
    api.require(descriptor?.kind==='data','sparse Set constructor iterable is unsupported');
    api.known(controller,descriptor.value);
    if(!result.some(existing=>sameValueZero(existing,descriptor.value)))result.push(normalize(descriptor.value));
  }
  return result;
}
function mapEntries(controller,value,api){
  api.known(controller,value);
  if(value[0]==='undefined'||value[0]==='null')return [];
  const {array,length}=arrayNode(controller,value,api),result=[];
  for(let i=0;i<length;i++){
    const outer=api.ownDescriptor(array,['str',String(i)]);
    api.require(outer?.kind==='data','sparse Map constructor iterable is unsupported');
    const pair=arrayNode(controller,outer.value,api);
    api.require(pair.length===2,'Map constructor entry must contain exactly two dense values');
    const key=api.ownDescriptor(pair.array,['str','0'])?.value,value=api.ownDescriptor(pair.array,['str','1'])?.value;
    api.require(key&&value,'sparse Map constructor entry is unsupported');
    api.known(controller,key);api.known(controller,value);
    const normalized=normalize(key),index=result.findIndex(row=>sameValueZero(row[0],key));
    if(index<0)result.push([normalized,structuredClone(value)]);else result[index][1]=structuredClone(value);
  }
  return result;
}
function collectionNode(controller,id,kind,api){
  const node=controller.heap.get(id);
  api.require(node?.kind===kind&&Array.isArray(node.entries),kind==='set'?'owned Set required':'owned Map required');
  return node;
}
function collectionState(controller,api){
  const state=api.state(controller);
  if(state.collections===null)state.collections={schema:COLLECTION_STATE_V8,collections:[]};
  api.require(state.collections?.schema===COLLECTION_STATE_V8,'collection registry schema');
  return state.collections.collections;
}
function register(controller,id,kind,api){
  const rows=collectionState(controller,api);
  api.require(rows.length<4096&&!rows.some(row=>row.id===id),'collection registry bound or duplicate');
  rows.push({id,kind});
}
function liveEntries(node){return node.entries.filter(entry=>entry!==null);}
export function validateCollectionRecordV8(record,{value}){
  const fields=COLLECTION_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'collection record');
  for(const name of ['object','name'])if(Object.hasOwn(record,name))identity(record[name]);
  if(record.kind==='set.lookup'||record.kind==='map.lookup'){
    assertAlgorithmDataArray(record.key,'collection method key');
    const set=record.kind==='set.lookup',methodNames=set?
      ['add','has','delete','clear']:['get','set','has','delete','clear'];
    if(record.key.length!==2||record.key[0]!=='str'||!methodNames.includes(record.key[1])||
      record.method!==(set?'Set':'Map')+'.prototype.'+record.key[1])throw new TypeError('Unknown collection method selection');
  }else if(record.kind==='set.create'||record.kind==='map.create'){
    identity(record.name);value(record.iterable);
    if(!['ref','null','undefined'].includes(record.iterable[0]))throw new TypeError('Collection constructor iterable tag');
  }else if(record.kind==='set.size'||record.kind==='map.size'){
    value(record.result);if(record.result[0]!=='num'||!Number.isSafeInteger(decode(record.result))||decode(record.result)<0)
      throw new TypeError('Collection size result');
  }else{
    if(['set.add','set.has','set.delete'].includes(record.kind))value(record.value);
    if(['map.get','map.has','map.set','map.delete'].includes(record.kind))value(record.key);
    if(record.kind==='map.set')value(record.value);
    value(record.result);
    if(['set.add','map.set'].includes(record.kind)&&record.result[0]!=='ref')throw new TypeError('Collection mutator receiver identity');
    if(['set.has','set.delete','map.has','map.delete'].includes(record.kind)&&record.result[0]!=='bool')
      throw new TypeError('Collection boolean result');
    if(['set.clear','map.clear'].includes(record.kind)&&record.result[0]!=='undefined')
      throw new TypeError('Collection clear result');
  }
  return true;
}
export function applyCollectionRecordV8(controller,record,api){
  if(!Object.hasOwn(COLLECTION_RECORD_FIELDS,record.kind))return false;
  const kind=record.kind.startsWith('set.')?'set':'map';
  if(record.kind===kind+'.lookup'){
    collectionNode(controller,record.object,kind,api);
    api.require(record.method===kind[0].toUpperCase()+kind.slice(1)+'.prototype.'+record.key[1],
      'false collection method identity');return true;
  }
  if(record.kind===kind+'.create'){
    api.fresh(controller,record.name);
    const entries=kind==='set'?setEntries(controller,record.iterable,api):mapEntries(controller,record.iterable,api);
    controller.heap.set(record.name,{kind,entries,properties:new Map()});
    register(controller,record.name,kind,api);return true;
  }
  const node=collectionNode(controller,record.object,kind,api);
  const live=liveEntries(node),size=live.length;
  if(record.kind===kind+'.size'){
    api.known(controller,record.result);api.require(api.eq(record.result,['num',size]),'false collection size');return true;
  }
  if(record.kind===kind+'.clear'){
    api.known(controller,record.result);api.require(api.eq(record.result,U),'false collection clear result');
    node.entries=node.entries.map(()=>null);return true;
  }
  const lookup=kind==='set'?record.value:record.key;
  api.known(controller,lookup);
  const index=node.entries.findIndex(entry=>entry!==null&&sameValueZero(kind==='set'?entry:entry[0],lookup));
  if(record.kind===kind+'.has'||record.kind===kind+'.delete'){
    api.known(controller,record.result);
    api.require(api.eq(record.result,['bool',index!==-1]),'false collection membership/deletion result');
    if(record.kind===kind+'.delete'&&index!==-1)node.entries[index]=null;
    return true;
  }
  if(record.kind==='set.add'){
    api.known(controller,record.result);api.require(api.eq(record.result,['ref',record.object]),'Set.add must return its receiver');
    if(index===-1){api.require(size<bound,'Set size bound');node.entries.push(normalize(record.value));}
    return true;
  }
  if(record.kind==='map.get'){
    api.known(controller,record.result);
    const expected=index===-1?U:node.entries[index][1];
    api.require(api.eq(record.result,expected),'false Map.get result');return true;
  }
  if(record.kind==='map.set'){
    api.known(controller,record.value);api.known(controller,record.result);
    api.require(api.eq(record.result,['ref',record.object]),'Map.set must return its receiver');
    if(index===-1){api.require(size<bound,'Map size bound');node.entries.push([normalize(record.key),structuredClone(record.value)]);}
    else node.entries[index][1]=structuredClone(record.value);
    return true;
  }
  throw new TypeError('Unknown collection operation');
}
export function restoreCollectionStateV8(controller,snapshot,api){
  const nodes=[...controller.heap].filter(([,node])=>node.kind==='set'||node.kind==='map');
  if(snapshot===null){api.require(nodes.length===0,'collection heap state lacks allocation registry');return {valid:true,collections:0};}
  assertAlgorithmFields(snapshot,['schema','collections'],'collection registry');
  api.require(snapshot.schema===COLLECTION_STATE_V8&&Array.isArray(snapshot.collections)&&snapshot.collections.length<=4096,
    'collection registry shape');
  const rows=new Map();
  for(const row of snapshot.collections){
    assertAlgorithmFields(row,['id','kind'],'collection registry row');identity(row.id);
    api.require(['set','map'].includes(row.kind)&&!rows.has(row.id),'collection registry row identity/kind');rows.set(row.id,row.kind);
  }
  api.require(rows.size===nodes.length,'collection registry/node count');
  for(const [id,node]of nodes){
    api.require(rows.get(id)===node.kind&&Object.keys(node).every(key=>['kind','entries','properties'].includes(key))&&
      node.properties instanceof Map&&node.properties.size===0&&Array.isArray(node.entries)&&node.entries.length<=bound,
      'collection heap shape/registry');
    if(node.kind==='set'){
      const seen=[];
      for(const item of node.entries){if(item===null)continue;api.known(controller,item);
        api.require(!seen.some(other=>sameValueZero(other,item)),'duplicate Set entry');seen.push(item);}
    }else{
      const seen=[];
      for(const entry of node.entries){if(entry===null)continue;
        api.require(Array.isArray(entry)&&entry.length===2,'Map entry shape');
        api.known(controller,entry[0]);api.known(controller,entry[1]);
        api.require(!seen.some(other=>sameValueZero(other,entry[0])),'duplicate Map key');seen.push(entry);}
    }
  }
  return {valid:true,collections:nodes.length};
}
export const hasCollectionStateV8=node=>node.kind==='set'||node.kind==='map';
