import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {encode} from '../src/values.js';
import {validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {MEMORY_RECORD_FIELDS,validateMemoryRecordV8,applyMemoryRecordV8,restoreMemoryStateV8} from '../src/semantic/protocol-memory-v8.js';
const require=(condition,message)=>{if(!condition)throw new TypeError(message);};
const api={require,copy:structuredClone,eq:isDeepStrictEqual,
  known(controller,value){validateProtocolValueV8(value);if(value[0]==='ref')require(controller.heap.has(value[1]),'unallocated reference');},
  fresh(controller,id){require(!controller.heap.has(id)&&!id.startsWith('well-known:'),'duplicate or reserved identity');},
  heapNode(controller,id){const node=controller.heap.get(id);require(node?.kind==='object','ordinary object required');return node;},
  ownDescriptor(node,key){const value=node.properties.get(key[1]);return value?{kind:'data',value}:null;},
  truthy(value){return !['undefined','null'].includes(value[0])&&(value[0]!=='bool'||value[1])&&(value[0]!=='num'||!['NaN','-0',0].includes(value[1]))&&(value[0]!=='str'||value[1]!=='');}
};
function machine(){let controller={heap:new Map()};return {
  get state(){return controller;},
  select(record){validateMemoryRecordV8(record,{value:validateProtocolValueV8});const staged=structuredClone(controller);
    assert.equal(applyMemoryRecordV8(staged,record,api),true);restoreMemoryStateV8(staged,api);controller=staged;},
};}
const construct=(constructor,name,args,backing=null)=>({kind:'memory.construct',constructor,name,backing,arguments:args});
const get=(object,key,result)=>({kind:'memory.get',object,key:['str',key],result});
const set=(object,key,value)=>({kind:'memory.set',object,key:['str',key],value});
const call=(method,receiver,args,result,name=null)=>({kind:'memory.call',method,receiver,arguments:args,name,result});

test('binary protocol retains aliased backing bytes and checks each claimed read',()=>{
  const m=machine();m.select(construct('ArrayBuffer','b',[['num',8]]));
  m.select(construct('Uint8Array','a',[['ref','b']]));m.select(construct('DataView','d',[['ref','b']]));
  m.select(set('a','0',['num',257]));m.select(call('DataView.prototype.setUint16',['ref','d'],[['num',2],['num',0x1234],['bool',true]],['undefined']));
  m.select(get('a','0',['num',1]));m.select(get('a','2',['num',0x34]));m.select(get('a','3',['num',0x12]));
  m.select(call('DataView.prototype.getUint16',['ref','d'],[['num',2],['bool',false]],['num',0x3412]));
  m.select(get('d','buffer',['ref','b']));
  const before=structuredClone(m.state);
  assert.throws(()=>m.select(get('a','0',['num',257])),/false.*read/);assert.deepEqual(m.state,before);
  assert.throws(()=>m.select(call('DataView.prototype.setUint8',['ref','d'],[['num',0],['num',9]],['num',9])),/false.*result/);
  assert.deepEqual(m.state,before,'a false write completion must not commit mutated bytes');
});
test('subarrays share bytes, buffer slices copy, and public values retain coercion distinctions',()=>{
  const m=machine();m.select(construct('Uint8Array','a',[['str','4.9']],'b'));m.select(set('a','1',['num',7]));
  m.select(call('TypedArray.prototype.subarray',['ref','a'],[['str','1'],['num',-1]],['ref','part'],'part'));
  m.select(call('ArrayBuffer.prototype.slice',['ref','b'],[['num',1],['num',3]],['ref','copy'],'copy'));
  m.select(construct('Uint8Array','copied',[['ref','copy']]));m.select(set('part','0',['num',9]));
  m.select(get('a','1',['num',9]));m.select(get('copied','0',['num',7]));m.select(get('part','buffer',['ref','b']));
  m.select(set('a','-0',['num',99]));m.select(get('a','-0',['undefined']));m.select(get('a','0',['num',0]));
  m.select(call('ArrayBuffer.isView',null,[['ref','part']],['bool',true]));
  m.select(call('ArrayBuffer.isView',null,[['ref','b']],['bool',false]));
});
test('binary public claims preserve floating-point, BigInt and explicit DataView byte order',()=>{
  const m=machine();m.select(construct('ArrayBuffer','b',[['num',16]]));m.select(construct('DataView','d',[['ref','b']]));
  m.select(construct('BigInt64Array','big',[['ref','b']]));
  m.select(set('big','0',['str','18446744073709551615']));m.select(get('big','0',['bigint','-1']));
  m.select(call('DataView.prototype.setFloat64',['ref','d'],[['num',8],encode(-0),['bool',true]],['undefined']));
  m.select(call('DataView.prototype.getFloat64',['ref','d'],[['num',8],['bool',true]],encode(-0)));
  const before=structuredClone(m.state);assert.throws(()=>m.select(set('big','100',['num',1])),/BigInt/);assert.deepEqual(m.state,before);
});
test('single-agent shared growth, tracking views, and atomic writes retain one shared heap',()=>{
  const m=machine();m.state.heap.set('options',{kind:'object',properties:new Map([['maxByteLength',['num',16]]])});
  m.select(construct('SharedArrayBuffer','b',[['num',4],['ref','options']]));
  m.select(construct('Int32Array','v',[['ref','b']]));m.select(construct('Uint8Array','bytes',[['ref','b'],['num',0],['num',4]]));
  m.select(call('Atomics.store',null,[['ref','v'],['num',0],['num',257]],['num',257]));m.select(get('bytes','0',['num',1]));
  m.select(call('SharedArrayBuffer.prototype.grow',['ref','b'],[['num',12]],['undefined']));
  m.select(get('v','length',['num',3]));m.select(get('bytes','length',['num',4]));m.select(get('v','2',['num',0]));
});
test('binary protocol restoration refuses missing backing objects, forged bytes and future metadata',()=>{
  const m=machine();m.select(construct('ArrayBuffer','b',[['num',8]]));m.select(construct('Uint16Array','v',[['ref','b'],['num',2],['num',2]]));
  for(const mutate of [s=>s.heap.get('b').bytes[0]=256,s=>s.heap.get('v').bufferId='missing',s=>s.heap.get('v').byteOffset=3,
    s=>s.heap.get('v').properties.set('custom',['num',1]),s=>s.heap.get('b').version=0,s=>s.heap.get('b').resizable=true]){
    const forged=structuredClone(m.state);mutate(forged);assert.throws(()=>restoreMemoryStateV8(forged,api),/binary|ArrayBuffer|archive/);
  }
  for(const record of [{...get('v','0',['num',0]),future:true},construct('ArrayBuffer',null,[['num',4]]),construct('HostBuffer','x',[])])
    assert.throws(()=>validateMemoryRecordV8(record,{value:validateProtocolValueV8}));
  assert.equal(Object.keys(MEMORY_RECORD_FIELDS).length,4);
});
