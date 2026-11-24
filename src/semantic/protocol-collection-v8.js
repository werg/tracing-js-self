// The issue51 Set slice retains the runtime's existing dense-array constructor
// representation while giving construction and operations an independent,
// operation-derived public machine.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {decode} from '../values.js';

export const COLLECTION_PROFILE_V8='owned-collections/1';
export const COLLECTION_STATE_V8='semantic-collections-state/1';
const bound=10000, U=['undefined'], N=['null'];
export const COLLECTION_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'set.lookup':['kind','object','key','method'],
  'set.create':['kind','name','iterable'],
  'set.add':['kind','object','value','result'],
  'set.has':['kind','object','value','result']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const identity=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Collection identity');};
function sameValueZero(left,right){
  if(left[0]!==right[0])return false;
  if(left[0]==='ref'||left[0]==='symbol')return left[1]===right[1];
  if(left[0]==='num'){
    const a=decode(left),b=decode(right);
    return a===b||Number.isNaN(a)&&Number.isNaN(b);
  }
  return JSON.stringify(left)===JSON.stringify(right);
}
function normalize(value){return value[0]==='num'&&decode(value)===0?['num',0]:structuredClone(value);}
function validateIterable(controller,value,api){
  api.known(controller,value);
  if(value[0]==='undefined'||value[0]==='null')return [];
  api.require(value[0]==='ref','Set constructor profile requires a dense ordinary array');
  const array=api.heapNode(controller,value[1]);
  api.require(array.kind==='array'&&[undefined,'ordinary','Array.prototype'].includes(array.prototype),
    'Set constructor profile requires a default array');
  api.require(!api.ownDescriptor(array,['symbol','well-known:iterator'])&&
    [...(array.descriptors?.values()??[])].every(row=>row.kind==='data'),
    'Set constructor iterator or accessors require a separate profile');
  const length=api.ownDescriptor(array,['str','length'])?.value;
  api.require(length?.[0]==='num'&&Number.isSafeInteger(decode(length))&&decode(length)>=0&&decode(length)<=bound,
    'Set constructor array length bound');
  const result=[];
  for(let i=0;i<decode(length);i++){
    const descriptor=api.ownDescriptor(array,['str',String(i)]);
    api.require(descriptor?.kind==='data','sparse Set constructor iterable is unsupported');
    api.known(controller,descriptor.value);
    if(!result.some(value=>sameValueZero(value,descriptor.value)))result.push(normalize(descriptor.value));
  }
  return result;
}
function setNode(controller,id,api){
  const node=controller.heap.get(id);
  api.require(node?.kind==='set'&&Array.isArray(node.entries),'owned Set required');
  return node;
}
function registry(controller,api){
  const state=api.state(controller);
  if(state.collections===null)state.collections={schema:COLLECTION_STATE_V8,collections:[]};
  api.require(state.collections?.schema===COLLECTION_STATE_V8,'collection registry schema');
  return state.collections.collections;
}
function register(controller,id,kind,api){
  const rows=registry(controller,api);
  api.require(rows.length<4096&&!rows.some(row=>row.id===id),'collection registry bound or duplicate');
  rows.push({id,kind});
}
export function validateCollectionRecordV8(record,{value}){
  const fields=COLLECTION_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'collection record');
  for(const name of ['object','name'])if(Object.hasOwn(record,name))identity(record[name]);
  if(record.kind==='set.lookup'){
    assertAlgorithmDataArray(record.key,'Set method key');
    if(record.key.length!==2||record.key[0]!=='str'||!['add','has'].includes(record.key[1])||
      record.method!=='Set.prototype.'+record.key[1])throw new TypeError('Unknown Set method selection');
  }else if(record.kind==='set.create'){
    identity(record.name);value(record.iterable);
    if(!['ref','null','undefined'].includes(record.iterable[0]))throw new TypeError('Set constructor iterable tag');
  }else{
    value(record.value);
    if(record.kind==='set.add'&&record.result[0]!=='ref')throw new TypeError('Set.add result identity');
    value(record.result);
  }
  return true;
}
export function applyCollectionRecordV8(controller,record,api){
  if(!Object.hasOwn(COLLECTION_RECORD_FIELDS,record.kind))return false;
  if(record.kind==='set.lookup'){
    setNode(controller,record.object,api);
    const expected=record.key[1]==='add'?'Set.prototype.add':'Set.prototype.has';
    api.require(record.method===expected,'false Set method identity');return true;
  }
  if(record.kind==='set.create'){
    api.fresh(controller,record.name);
    const entries=validateIterable(controller,record.iterable,api);
    controller.heap.set(record.name,{kind:'set',entries,properties:new Map()});
    register(controller,record.name,'set',api);return true;
  }
  const node=setNode(controller,record.object,api);
  api.known(controller,record.value);
  const index=node.entries.findIndex(value=>sameValueZero(value,record.value));
  if(record.kind==='set.has'){
    api.known(controller,record.result);
    api.require(api.eq(record.result,['bool',index!==-1]),'false Set.has result');return true;
  }
  api.known(controller,record.result);
  api.require(api.eq(record.result,['ref',record.object]),'Set.add must return its receiver');
  if(index===-1){
    api.require(node.entries.length<bound,'Set size bound');
    node.entries.push(normalize(record.value));
  }
  return true;
}
export function restoreCollectionStateV8(controller,snapshot,api){
  const nodes=[...controller.heap].filter(([,node])=>node.kind==='set');
  if(snapshot===null){api.require(nodes.length===0,'Set heap state lacks collection registry');return {valid:true,collections:0};}
  assertAlgorithmFields(snapshot,['schema','collections'],'collection registry');
  api.require(snapshot.schema===COLLECTION_STATE_V8&&Array.isArray(snapshot.collections)&&snapshot.collections.length<=4096,
    'collection registry shape');
  const rows=new Map();
  for(const row of snapshot.collections){
    assertAlgorithmFields(row,['id','kind'],'collection registry row');identity(row.id);
    api.require(row.kind==='set'&&!rows.has(row.id),'Set registry row identity/kind');rows.set(row.id,row.kind);
  }
  api.require(rows.size===nodes.length,'Set registry/node count');
  for(const [id,node]of nodes){
    api.require(rows.get(id)==='set'&&Object.keys(node).every(key=>['kind','entries','properties'].includes(key))&&
      node.properties instanceof Map&&node.properties.size===0&&Array.isArray(node.entries)&&node.entries.length<=bound,'Set heap shape/registry');
    const seen=[];
    for(const value of node.entries){
      api.known(controller,value);
      api.require(!seen.some(other=>sameValueZero(other,value)),'duplicate Set entry');
      seen.push(value);
    }
  }
  return {valid:true,collections:nodes.length};
}
export const hasCollectionStateV8=node=>node.kind==='set';
