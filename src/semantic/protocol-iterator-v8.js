// Explicit builtin iterator operations on the authoritative shared heap.
// No host iterator, archive cursor or executable source is an evaluator input.
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';

export const ITERATOR_PROFILE_V8='builtin-iterator/1';
export const ITERATOR_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'iterator.lookup':['kind','receiver','key','method'],
  'iterator.create':['kind','name','iterated','iterationKind'],
  'iterator.next':['kind','object','name','entry','result','done'],
  'iterator.identity':['kind','object','result'],
  'iterator.read':['kind','object','key','result'],
  'iterator.arrayGuard':['kind','iterated','result']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const ITERATOR_HEAP_FIELDS=Object.freeze(['kind','iterated','iterationKind','nextIndex','done','properties']);
const arrayKinds=new Set(['values','keys','entries']), collectionKinds=new Set([
  'set-values','set-keys','set-entries','map-keys','map-values','map-entries']);
const kinds=new Set([...arrayKinds,'string',...collectionKinds]),bound=10000;
const methods=new Set(['Array.prototype.values','Array.prototype.keys','Array.prototype.entries',
  'String.prototype.iterator','Iterator.next','Iterator.identity',
  'Set.prototype.values','Set.prototype.keys','Set.prototype.entries',
  'Map.prototype.keys','Map.prototype.values','Map.prototype.entries']);
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Iterator identity');};
const key=value=>{assertAlgorithmDataArray(value,'iterator key');
  if(value.length!==2||!['str','symbol'].includes(value[0])||typeof value[1]!=='string')throw new TypeError('Iterator property key');};
export function validateIteratorRecordV8(record,{value}){
  if(!isAlgorithmDataRecord(record))throw new TypeError('Iterator record must be ordinary data');
  const fields=ITERATOR_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'builtin iterator record');
  for(const name of ['object','name','entry'])if(Object.hasOwn(record,name)&&record[name]!==null)id(record[name]);
  if(Object.hasOwn(record,'key'))key(record.key);
  if(record.kind==='iterator.lookup'){
    value(record.receiver);if(!methods.has(record.method))throw new TypeError('Unknown iterator builtin');
  }else if(record.kind==='iterator.create'){
    id(record.name);value(record.iterated);if(!kinds.has(record.iterationKind))throw new TypeError('Iterator kind');
  }else if(record.kind==='iterator.arrayGuard'){
    value(record.iterated);if(typeof record.result!=='boolean')throw new TypeError('Iterator guard boolean');
  }else{
    value(record.result);if(record.kind==='iterator.next'&&typeof record.done!=='boolean')throw new TypeError('Iterator completion boolean');
  }
  return true;
}
function cursor(controller,id,api){const node=controller.heap.get(id);api.require(node?.kind==='iterator','builtin iterator identity required');return node;}
function standardArray(controller,value,api){
  api.known(controller,value);const node=value[0]==='ref'?controller.heap.get(value[1]):null;
  return node?.kind==='array'&&(node.prototype===undefined||node.prototype==='ordinary')&&
    api.ownDescriptor(node,['symbol','well-known:iterator'])===null;
}
function selectedMethod(controller,receiver,property,api){
  api.known(controller,receiver);api.knownKey(controller,property);
  if(receiver[0]==='str'){
    api.require(property[0]==='symbol'&&property[1]==='well-known:iterator','string iterator lookup key');return 'String.prototype.iterator';
  }
  api.require(receiver[0]==='ref','iterator lookup receiver');const node=controller.heap.get(receiver[1]);
  if(node?.kind==='array'){
    api.require((node.prototype===undefined||node.prototype==='ordinary')&&api.ownDescriptor(node,property)===null,
      'iterator method is overridden or has a custom prototype');
    if(property[0]==='symbol'&&property[1]==='well-known:iterator')return 'Array.prototype.values';
    api.require(property[0]==='str'&&arrayKinds.has(property[1]),'array iterator lookup key');return 'Array.prototype.'+property[1];
  }
  if(node?.kind==='set'||node?.kind==='map'){
    const kind=node.kind,allowed=kind==='set'?['values','keys','entries']:['keys','values','entries'];
    if(property[0]==='symbol'&&property[1]==='well-known:iterator')
      return kind==='set'?'Set.prototype.values':'Map.prototype.entries';
    api.require(property[0]==='str'&&allowed.includes(property[1]),kind+' iterator lookup key');
    return (kind==='set'?'Set':'Map')+'.prototype.'+property[1];
  }
  cursor(controller,receiver[1],api);
  if(property[0]==='str'&&property[1]==='next')return 'Iterator.next';
  api.require(property[0]==='symbol'&&property[1]==='well-known:iterator','iterator lookup key');return 'Iterator.identity';
}
function length(controller,id,api){
  const array=api.heapNode(controller,id);api.require(array.kind==='array','iterated reference must remain an array');
  const descriptor=api.ownDescriptor(array,['str','length']),tag=descriptor?.value;
  api.require(descriptor?.kind==='data'&&tag?.[0]==='num'&&Number.isSafeInteger(tag[1])&&tag[1]>=0&&tag[1]<=bound,'bounded array length');return tag[1];
}
function readIndex(controller,id,index,api){
  const seen=new Set();
  for(;;){
    api.require(!seen.has(id),'cyclic iterator source prototype');seen.add(id);
    const node=api.heapNode(controller,id),descriptor=api.ownDescriptor(node,['str',String(index)]);
    if(descriptor){
      api.require(descriptor.kind==='data'||descriptor.get[0]==='undefined','iterator index getter requires a scoped call continuation');
      return descriptor.kind==='data'?api.copy(descriptor.value):['undefined'];
    }
    const prototype=node.prototype===undefined?'ordinary':node.prototype;
    if(prototype===null||prototype==='ordinary')return ['undefined'];
    api.known(controller,prototype);api.require(prototype[0]==='ref','iterator source prototype');id=prototype[1];
  }
}
function allocationEntry(controller,iterationKind,raw,api){
  const value=iterationKind==='set-values'||iterationKind==='set-keys'?raw:
    iterationKind==='map-keys'?raw[0]:iterationKind==='map-values'?raw[1]:null;
  if(value!==null)return api.copy(value);
  const pair=iterationKind==='set-entries'?[api.copy(raw),api.copy(raw)]:
    iterationKind==='map-entries'?[api.copy(raw[0]),api.copy(raw[1])]:null;
  api.require(pair,'unsupported collection entry kind');
  return {pair};
}
function allocateResult(controller,name,value,done,api){
  api.allocate(controller,{name,objectKind:'object',length:null,code:null,captures:[],functionKind:null,lexicalReceiver:null,
    properties:[{key:['str','value'],value},{key:['str','done'],value:['bool',done]}]});
}
export function applyIteratorRecordV8(controller,record,api){
  if(!Object.hasOwn(ITERATOR_RECORD_FIELDS,record.kind))return false;
  if(record.kind==='iterator.lookup'){
    api.require(selectedMethod(controller,record.receiver,record.key,api)===record.method,'false iterator builtin selection');
  }else if(record.kind==='iterator.arrayGuard'){
    api.require(record.result===standardArray(controller,record.iterated,api),'false standard array iterator guard');
  }else if(record.kind==='iterator.create'){
    api.known(controller,record.iterated);api.fresh(controller,record.name);
    if(record.iterationKind==='string')api.require(record.iterated[0]==='str'&&record.iterated[1].length<=bound,'bounded primitive string iterator');
    else if(arrayKinds.has(record.iterationKind)) {
      api.require(record.iterated[0]==='ref','array iterator source');length(controller,record.iterated[1],api);
    } else {
      api.require(record.iterated[0]==='ref','collection iterator source');
      const collection=controller.heap.get(record.iterated[1]);
      api.require(collectionKinds.has(record.iterationKind)&&
        record.iterationKind.startsWith(collection.kind+'-')&&Array.isArray(collection.entries)&&collection.entries.length<=bound,
        'iteration kind must match a registered bounded collection');
    }
    controller.heap.set(record.name,{kind:'iterator',iterated:api.copy(record.iterated),iterationKind:record.iterationKind,
      nextIndex:0,done:false,properties:new Map()});
  }else{
    const node=cursor(controller,record.object,api);
    if(record.kind==='iterator.identity'){
      api.known(controller,record.result);api.require(api.eq(record.result,['ref',record.object]),'iterator self identity changed');
    }else if(record.kind==='iterator.read'){
      api.knownKey(controller,record.key);let expected=['undefined'];
      if(record.key[0]==='symbol'&&record.key[1]==='well-known:toStringTag'){
        const kind=node.iterationKind;
        expected=['str',kind==='string'?'String Iterator':collectionKinds.has(kind)?
          (kind.startsWith('set-')?'Set Iterator':'Map Iterator'):'Array Iterator'];
      }else api.require(!(record.key[0]==='str'&&['next','constructor','__proto__','toString','valueOf'].includes(record.key[1]))&&
        !(record.key[0]==='symbol'&&record.key[1]==='well-known:iterator'),'iterator inherited property requires its declared operation');
      api.known(controller,record.result);api.require(api.eq(expected,record.result),'false iterator property read');
    }else{
      let value=['undefined'];const index=node.nextIndex;api.require(index<=bound,'iterator position bound');
      if(!node.done){
        if(node.iterationKind==='string'){
          const text=node.iterated[1];if(index>=text.length)node.done=true;
          else{const code=text.charCodeAt(index),next=text.charCodeAt(index+1),width=
            code>=0xd800&&code<=0xdbff&&next>=0xdc00&&next<=0xdfff?2:1;
            value=['str',text.slice(index,index+width)];node.nextIndex+=width;}
        }else if(arrayKinds.has(node.iterationKind)){
          if(index>=length(controller,node.iterated[1],api))node.done=true;
          else{
            node.nextIndex++;
            value=node.iterationKind==='keys'?['num',index]:readIndex(controller,node.iterated[1],index,api);
            if(node.iterationKind==='entries'){
              api.require(record.entry!==null,'entry iteration requires its fresh pair identity');
              api.allocate(controller,{name:record.entry,objectKind:'array',length:2,code:null,captures:[],functionKind:null,lexicalReceiver:null,
                properties:[{key:['str','0'],value:['num',index]},{key:['str','1'],value}]});value=['ref',record.entry];
            }
          }
        }else{
          const collection=controller.heap.get(node.iterated[1]);api.require(collection.kind==='set'||collection.kind==='map','collection iterator source');
          const entries=collection.entries;let position=index;
          while(position<entries.length&&entries[position]===null)position++;
          if(position>=entries.length){node.nextIndex=position;node.done=true;}
          else{
            const raw=entries[position];node.nextIndex=position+1;
            const yielded=allocationEntry(controller,node.iterationKind,raw,api);
            if(yielded?.pair){
              api.require(record.entry!==null,'entry iteration requires its fresh pair identity');
              api.allocate(controller,{name:record.entry,objectKind:'array',length:2,code:null,captures:[],functionKind:null,lexicalReceiver:null,
                properties:[{key:['str','0'],value:yielded.pair[0]},{key:['str','1'],value:yielded.pair[1]}]});
              value=['ref',record.entry];
            }else value=yielded;
          }
        }
      }
      api.require(record.entry===null||collectionKinds.has(node.iterationKind)&&!node.done||
        arrayKinds.has(node.iterationKind)&&node.iterationKind==='entries'&&!node.done,'unexpected iterator pair allocation');
      api.known(controller,record.result);api.require(record.done===node.done&&api.eq(record.result,value),'false iterator next result');
      allocateResult(controller,record.name,value,node.done,api);
    }
  }
  return true;
}
export function restoreIteratorStateV8(controller,api){
  let count=0;
  for(const [id,node]of controller.heap)if(node.kind==='iterator'){
    assertAlgorithmFields(node,ITERATOR_HEAP_FIELDS,'builtin iterator heap node');count++;
    api.require(kinds.has(node.iterationKind)&&Number.isSafeInteger(node.nextIndex)&&node.nextIndex>=0&&node.nextIndex<=bound&&
      typeof node.done==='boolean'&&node.properties instanceof Map&&node.properties.size===0,'iterator state or own-property profile');
    api.known(controller,node.iterated);
    if(node.iterationKind==='string'){
      api.require(node.iterated[0]==='str'&&node.iterated[1].length<=bound&&node.nextIndex<=node.iterated[1].length,'string iterator cursor');
      const text=node.iterated[1],index=node.nextIndex;
      api.require(!(index>0&&index<text.length&&text.charCodeAt(index-1)>=0xd800&&text.charCodeAt(index-1)<=0xdbff&&
        text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff),'string iterator cursor splits a surrogate pair');
      if(node.done)api.require(index===text.length,'completed string iterator position');
    }else if(arrayKinds.has(node.iterationKind)){
      api.require(node.iterated[0]==='ref'&&node.iterated[1]!==id,'array iterator source identity');
      const size=length(controller,node.iterated[1],api);api.require(node.nextIndex<=size,'array iterator cursor');
    }else{
      api.require(collectionKinds.has(node.iterationKind)&&node.iterated[0]==='ref'&&node.iterated[1]!==id,'collection iterator source identity');
      const collection=controller.heap.get(node.iterated[1]),max=collection?.entries?.length;
      api.require(collection.kind===node.iterationKind.slice(0,3)&&Array.isArray(collection.entries)&&node.nextIndex<=max,'collection iterator cursor');
    }
  }
  return {valid:true,iterators:count};
}
export const hasIteratorStateV8=node=>node.kind==='iterator';
