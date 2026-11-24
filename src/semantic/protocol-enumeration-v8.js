// Ordinary for-in cursors on the authoritative shared heap. Candidate lists
// are derived here, never supplied by a teacher or a native enumeration call.
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';
import {promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';

export const ENUMERATION_PROFILE_V8='ordinary-for-in/1';
export const ENUMERATION_RECORD_FIELDS=Object.freeze({
  'enumeration.create':Object.freeze(['kind','name','source']),
  'enumeration.next':Object.freeze(['kind','object','name','result','done'])
});
export const ENUMERATION_HEAP_FIELDS=Object.freeze(['kind','source','chain','keys','nextIndex','done','properties']);
export const ENUMERATION_LIMITS_V8=Object.freeze({chain:128,keys:4096});
const ordinary=new Set(['object','array']);
const numericKey=key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<4294967295;
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Enumeration identity');};
export function validateEnumerationRecordV8(record,{value}){
  if(!isAlgorithmDataRecord(record))throw new TypeError('Enumeration record must be ordinary data');
  const fields=ENUMERATION_RECORD_FIELDS[record.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'ordinary enumeration record');id(record.name);
  if(record.kind==='enumeration.create')value(record.source);
  else{id(record.object);value(record.result);if(typeof record.done!=='boolean')throw new TypeError('Enumeration completion boolean');}
  return true;
}
function selectedKeys(chain,api){
  const visited=new Set(),keys=[];
  for(const row of chain)for(const [key,enumerable]of row.keys)if(!visited.has(key)){
    visited.add(key);api.require(visited.size<=ENUMERATION_LIMITS_V8.keys,'enumeration key bound');
    if(enumerable)keys.push(key);
  }
  return keys;
}
function snapshot(controller,source,api){
  api.known(controller,source);const chain=[];
  if(source[0]==='str'){
    api.require(source[1].length<=ENUMERATION_LIMITS_V8.keys,'enumeration string bound');
    return {chain,keys:Array.from({length:source[1].length},(_,index)=>String(index))};
  }
  if(source[0]!=='ref')return {chain,keys:[]};
  const seen=new Set();let current=source[1];
  for(;;){
    api.require(!seen.has(current)&&chain.length<ENUMERATION_LIMITS_V8.chain,'cyclic or excessive enumeration prototype chain');seen.add(current);
    const node=api.heapNode(controller,current);api.require(ordinary.has(node.kind),'enumeration requires ordinary storage');
    const keys=api.order(node).filter(key=>typeof key==='string').map(key=>[key,api.ownDescriptor(node,['str',key]).enumerable]);
    api.require(keys.length<=ENUMERATION_LIMITS_V8.keys,'enumeration own-key bound');
    const prototype=node.prototype===undefined?'ordinary':api.copy(node.prototype);chain.push({id:current,prototype,keys});
    if(prototype===null||prototype==='ordinary')break;
    api.known(controller,prototype);api.require(prototype[0]==='ref','enumeration prototype requires ordinary identity');current=prototype[1];
  }
  return {chain,keys:selectedKeys(chain,api)};
}
export function applyEnumerationRecordV8(controller,record,api){
  if(!Object.hasOwn(ENUMERATION_RECORD_FIELDS,record.kind))return false;
  if(record.kind==='enumeration.create'){
    api.fresh(controller,record.name);const selected=snapshot(controller,record.source,api);
    if(selected.chain.at(-1)?.prototype==='ordinary'&&controller.protocol?.promiseObjects?.initialized){
      const intrinsic=api.heapNode(controller,promiseIntrinsicIdV8('Object.prototype'));
      api.require(!api.order(intrinsic).some(key=>typeof key==='string'&&api.ownDescriptor(intrinsic,['str',key]).enumerable),
        'enumerable intrinsic prototype requires an explicit enumeration chain');
    }
    controller.heap.set(record.name,{kind:'enumerator',source:api.copy(record.source),...selected,nextIndex:0,done:false,properties:new Map()});
  }else{
    const node=controller.heap.get(record.object);api.require(node?.kind==='enumerator','enumeration cursor identity required');
    // Once exhausted, later mutations cannot revive a cursor. Before that,
    // keep captured order, ignore additions and skip names no longer present
    // anywhere on the current live chain, without ever reading a property value.
    if(!node.done){
      if(node.source[0]==='ref')while(node.nextIndex<node.keys.length&&
        !api.resolveProperty(controller,node.source[1],['str',node.keys[node.nextIndex]],{forHas:true}).descriptor)node.nextIndex++;
    }
    const done=node.nextIndex>=node.keys.length,result=done?['undefined']:['str',node.keys[node.nextIndex]];
    api.require(record.done===done&&api.eq(record.result,result),'false enumeration next result');
    api.allocate(controller,{name:record.name,objectKind:'object',length:null,code:null,captures:[],functionKind:null,lexicalReceiver:null,
      properties:[{key:['str','value'],value:result},{key:['str','done'],value:['bool',done]}]});
    node.done=done;if(!done)node.nextIndex++;
  }
  return true;
}
export function restoreEnumerationStateV8(controller,api){
  let count=0;
  for(const [identity,node]of controller.heap)if(node.kind==='enumerator'){
    assertAlgorithmFields(node,ENUMERATION_HEAP_FIELDS,'ordinary enumeration heap node');count++;
    api.known(controller,node.source);assertAlgorithmDataArray(node.chain,'enumeration chain');assertAlgorithmDataArray(node.keys,'enumeration keys');
    api.require(node.chain.length<=ENUMERATION_LIMITS_V8.chain&&node.keys.length<=ENUMERATION_LIMITS_V8.keys&&
      node.keys.every(key=>typeof key==='string')&&new Set(node.keys).size===node.keys.length&&
      Number.isSafeInteger(node.nextIndex)&&node.nextIndex>=0&&node.nextIndex<=node.keys.length&&
      typeof node.done==='boolean'&&(!node.done||node.nextIndex===node.keys.length)&&
      node.properties instanceof Map&&node.properties.size===0,'enumeration cursor state');
    if(node.source[0]!=='ref'){
      api.require(node.chain.length===0&&api.eq(node.keys,snapshot(controller,node.source,api).keys),'primitive enumeration snapshot');continue;
    }
    api.require(node.source[1]!==identity&&node.chain.length>0&&node.chain[0].id===node.source[1],'enumeration source identity');
    const seen=new Set();
    for(const [index,row]of node.chain.entries()){
      assertAlgorithmFields(row,['id','prototype','keys'],'enumeration chain entry');id(row.id);
      api.require(!seen.has(row.id)&&ordinary.has(api.heapNode(controller,row.id).kind),'enumeration chain identity');seen.add(row.id);
      assertAlgorithmDataArray(row.keys,'enumeration own keys');const own=new Set();
      api.require(row.keys.length<=ENUMERATION_LIMITS_V8.keys,'enumeration own-key bound');
      let stringSeen=false,previousIndex=-1;
      for(const pair of row.keys){assertAlgorithmDataArray(pair,'enumeration key descriptor');
        api.require(pair.length===2&&typeof pair[0]==='string'&&typeof pair[1]==='boolean'&&!own.has(pair[0]),'enumeration own-key descriptor');own.add(pair[0]);
        if(numericKey(pair[0])){api.require(!stringSeen&&Number(pair[0])>previousIndex,'enumeration integer-key order');previousIndex=Number(pair[0]);}
        else stringSeen=true;
      }
      if(index+1<node.chain.length)api.require(api.eq(row.prototype,['ref',node.chain[index+1].id]),'enumeration prototype linkage');
      else api.require(row.prototype===null||row.prototype==='ordinary','enumeration terminal prototype');
    }
    api.require(api.eq(node.keys,selectedKeys(node.chain,api)),'enumeration snapshot key order or shadowing');
    // A checkpoint may follow a source write before the next step (or a break).
    // Preserve that exact prefix; next checks current live existence and
    // skips removed candidates. It never reconstructs a cursor from new keys.
  }
  return {valid:true,enumerators:count};
}
export const hasEnumerationStateV8=node=>node.kind==='enumerator';
