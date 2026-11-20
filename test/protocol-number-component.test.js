import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolRecordV8,createProtocolStateV8,PROTOCOL_MACHINE_API_V8} from '../src/semantic/protocol-state-v8.js';
import {validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {NUMBER_RECORD_FIELDS,validateNumberRecordV8,applyNumberRecordV8,assertNumberNextV8,restoreNumberStateV8}
  from '../src/semantic/protocol-number-v8.js';

function fixture(){
  const controller={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
    frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()},api=PROTOCOL_MACHINE_API_V8;
  const object=(name,kind='object')=>applyProtocolRecordV8(controller,{kind:'allocate',name,objectKind:kind,code:kind==='closure'?name:null,
    captures:[],functionKind:kind==='closure'?'ordinary':null,lexicalReceiver:null,length:null,properties:[]});
  const define=(name,key,value)=>applyProtocolRecordV8(controller,{kind:'property.define',object:name,key,descriptor:
    {kind:'data',value,writable:true,enumerable:true,configurable:true},success:true});
  const apply=record=>{
    validateNumberRecordV8(record,{value:validateProtocolValueV8});
    const staged=structuredClone(controller);assertNumberNextV8(staged,record,api);applyNumberRecordV8(staged,record,api);
    Object.assign(controller,staged);
  };
  const returned=value=>{
    const invocation=controller.stack.at(-1);applyProtocolRecordV8(controller,{kind:'return',invocation,value});
  };
  return {controller,api,object,define,apply,returned};
}

test('Number protocol has exact semantic records and explicitly converts BigInt or scalar input',()=>{
  for(const fields of Object.values(NUMBER_RECORD_FIELDS))assert(!fields.some(field=>['journal','patches','state','bytecode'].includes(field)));
  for(const value of [['num','-0'],['str',' 0x10 '],['str','bad'],['bigint','9007199254740993'],['bool',true],['null'],['undefined']]){
    const f=fixture(),native=value[0]==='bigint'?BigInt(value[1]):value[0]==='num'?-0:value[0]==='str'?value[1]:value[0]==='bool'?value[1]:value[0]==='null'?null:undefined;
    const converted=Number(native),result=['num',Object.is(converted,-0)?'-0':Number.isNaN(converted)?'NaN':converted];
    f.apply({kind:'number.begin',id:'conversion',value});f.apply({kind:'number.finish',id:'conversion',result});
    assert.deepEqual(f.controller.lastReturn,{kind:'return',value:result});
    assert.equal(restoreNumberStateV8(f.controller,f.controller.protocol.numberConversions,f.api).valid,true);
  }
});

test('Number captures a live Symbol.toPrimitive method and calls it once with number hint and receiver',()=>{
  const f=fixture();f.object('object');f.object('method','closure');f.define('object',['symbol','well-known:toPrimitive'],['ref','method']);
  f.apply({kind:'number.begin',id:'conversion',value:['ref','object']});
  f.apply({kind:'number.select',id:'conversion',key:['symbol','well-known:toPrimitive'],method:['ref','method'],builtin:null});
  f.apply({kind:'number.call',id:'conversion',child:'callback'});
  assert.deepEqual(f.controller.receiver,['ref','object']);assert.deepEqual(f.controller.protocol.callFrames.at(-1).arguments,[['str','number']]);
  assert.equal(restoreNumberStateV8(f.controller,f.controller.protocol.numberConversions,f.api).valid,true);
  f.returned(['str','12']);f.apply({kind:'number.return',id:'conversion',value:['str','12']});
  f.apply({kind:'number.finish',id:'conversion',result:['num',12]});
  let calls=0;const native={[Symbol.toPrimitive](hint){assert.equal(hint,'number');assert.equal(this,native);calls++;return '12';}};
  assert.equal(f.controller.lastReturn.value[1],Number(native));assert.equal(calls,1);
});

test('ordinary fallback skips noncallable valueOf and validates the live toString callback',()=>{
  const f=fixture();f.object('object');f.object('text','closure');f.define('object',['str','valueOf'],['num',1]);f.define('object',['str','toString'],['ref','text']);
  f.apply({kind:'number.begin',id:'conversion',value:['ref','object']});
  f.apply({kind:'number.select',id:'conversion',key:['symbol','well-known:toPrimitive'],method:['undefined'],builtin:null});
  f.apply({kind:'number.select',id:'conversion',key:['str','valueOf'],method:['num',1],builtin:null});
  f.apply({kind:'number.select',id:'conversion',key:['str','toString'],method:['ref','text'],builtin:null});
  f.apply({kind:'number.call',id:'conversion',child:'callback'});assert.deepEqual(f.controller.protocol.callFrames.at(-1).arguments,[]);
  f.returned(['str','5']);f.apply({kind:'number.return',id:'conversion',value:['str','5']});
  f.apply({kind:'number.finish',id:'conversion',result:['num',5]});assert.equal(Number({valueOf:1,toString(){return '5';}}),5);
});

test('ordinary intrinsic fallback checks Object.valueOf then Object.toString and toStringTag data',()=>{
  const f=fixture();f.object('object');f.define('object',['symbol','well-known:toStringTag'],['str','Tagged']);
  f.apply({kind:'number.begin',id:'conversion',value:['ref','object']});
  f.apply({kind:'number.select',id:'conversion',key:['symbol','well-known:toPrimitive'],method:['undefined'],builtin:null});
  f.apply({kind:'number.select',id:'conversion',key:['str','valueOf'],method:['undefined'],builtin:'Object.valueOf'});
  f.apply({kind:'number.builtin',id:'conversion',result:['ref','object']});
  f.apply({kind:'number.select',id:'conversion',key:['str','toString'],method:['undefined'],builtin:'Object.toString'});
  f.apply({kind:'number.builtin',id:'conversion',result:['str','[object Tagged]']});
  f.apply({kind:'number.finish',id:'conversion',result:['num','NaN']});assert(Number.isNaN(Number({[Symbol.toStringTag]:'Tagged'})));
});

test('false method result ordering and forged retained state fail without committing a partial conversion',()=>{
  const f=fixture();f.object('object');f.object('method','closure');f.define('object',['symbol','well-known:toPrimitive'],['ref','method']);
  f.apply({kind:'number.begin',id:'conversion',value:['ref','object']});const before=structuredClone(f.controller);
  assert.throws(()=>f.apply({kind:'number.select',id:'conversion',key:['str','valueOf'],method:['ref','method'],builtin:null}),/method order/);
  assert.deepEqual(f.controller,before);
  assert.throws(()=>assertNumberNextV8(f.controller,{kind:'compute'},f.api),/requires number.select/);
  f.apply({kind:'number.select',id:'conversion',key:['symbol','well-known:toPrimitive'],method:['ref','method'],builtin:null});
  f.apply({kind:'number.call',id:'conversion',child:'callback'});f.returned(['num',2]);
  assert.throws(()=>f.apply({kind:'number.return',id:'conversion',value:['num',99]}),/completion differs/);
  f.apply({kind:'number.return',id:'conversion',value:['num',2]});const state=structuredClone(f.controller.protocol.numberConversions);
  state.operations[0].primitive=null;assert.throws(()=>restoreNumberStateV8(f.controller,state,f.api),/primitive is absent/);
  assert.throws(()=>f.apply({kind:'number.finish',id:'conversion',result:['num',99]}),/false Number scalar/);
});

test('rejected direct Number entries never initialize conversion state',()=>{
  for(const [record,emptyStack,reason]of [
    [{kind:'number.begin',id:'conversion',value:['ref','missing']},false,/unallocated reference/],
    [{kind:'number.begin',id:'conversion',value:['num',3]},true,/active invocation/],
    [{kind:'number.finish',id:'missing',result:['num',3]},false,/unknown Number conversion/]
  ]){
    const f=fixture();if(emptyStack)f.controller.stack=[];
    const before=structuredClone(f.controller);
    assert.throws(()=>applyNumberRecordV8(f.controller,record,f.api),reason);
    assert.deepEqual(f.controller,before);
  }
});

test('Number scalar work bounds apply before retaining inputs and callback results',()=>{
  for(const tag of ['str','bigint']){
    const f=fixture(),oversized=[tag,'1'.repeat(10001)],before=structuredClone(f.controller);
    assert.throws(()=>applyNumberRecordV8(f.controller,{kind:'number.begin',id:'conversion',value:oversized},f.api),/scalar conversion bound/);
    assert.deepEqual(f.controller,before);
    const atLimit=[tag,'1'.repeat(10000)];
    f.apply({kind:'number.begin',id:'conversion',value:atLimit});
    assert.equal(restoreNumberStateV8(f.controller,f.controller.protocol.numberConversions,f.api).valid,true);
    f.apply({kind:'number.finish',id:'conversion',result:['num','+Infinity']});
  }
  const f=fixture();f.object('object');f.object('method','closure');f.define('object',['symbol','well-known:toPrimitive'],['ref','method']);
  f.apply({kind:'number.begin',id:'conversion',value:['ref','object']});
  f.apply({kind:'number.select',id:'conversion',key:['symbol','well-known:toPrimitive'],method:['ref','method'],builtin:null});
  f.apply({kind:'number.call',id:'conversion',child:'callback'});
  const value=['str','1'.repeat(10001)];f.returned(value);
  const before=structuredClone(f.controller);
  assert.throws(()=>applyNumberRecordV8(f.controller,{kind:'number.return',id:'conversion',value},f.api),/scalar conversion bound/);
  assert.deepEqual(f.controller,before);
});

test('ordinary Number conversion skips noncallable Promise values but rejects exotic toPrimitive',()=>{
  const f=fixture();f.object('object');f.object('text','closure');
  f.controller.heap.set('promise',{kind:'promise',properties:new Map(),state:'fulfilled',result:['num',1],reactions:[]});
  f.define('object',['str','valueOf'],['ref','promise']);f.define('object',['str','toString'],['ref','text']);
  f.apply({kind:'number.begin',id:'conversion',value:['ref','object']});
  f.apply({kind:'number.select',id:'conversion',key:['symbol','well-known:toPrimitive'],method:['undefined'],builtin:null});
  f.apply({kind:'number.select',id:'conversion',key:['str','valueOf'],method:['ref','promise'],builtin:null});
  f.apply({kind:'number.select',id:'conversion',key:['str','toString'],method:['ref','text'],builtin:null});
  f.apply({kind:'number.call',id:'conversion',child:'callback'});f.returned(['str','3']);
  f.apply({kind:'number.return',id:'conversion',value:['str','3']});
  f.apply({kind:'number.finish',id:'conversion',result:['num',3]});
  assert.equal(f.controller.lastReturn.value[1],Number({valueOf:Promise.resolve(1),toString(){return '3';}}));

  f.define('object',['symbol','well-known:toPrimitive'],['ref','promise']);
  f.apply({kind:'number.begin',id:'abrupt',value:['ref','object']});
  const before=structuredClone(f.controller);
  assert.throws(()=>applyNumberRecordV8(f.controller,{kind:'number.select',id:'abrupt',
    key:['symbol','well-known:toPrimitive'],method:['ref','promise'],builtin:null},f.api),/noncallable Symbol.toPrimitive/);
  assert.deepEqual(f.controller,before);
});

test('Number restore requires a live parent until conversion completes',()=>{
  const f=fixture();f.apply({kind:'number.begin',id:'conversion',value:['str','3']});
  f.controller.stack=[];
  assert.throws(()=>restoreNumberStateV8(f.controller,f.controller.protocol.numberConversions,f.api),/live parent/);
  f.controller.stack=['root'];f.apply({kind:'number.finish',id:'conversion',result:['num',3]});
  f.controller.stack=[];
  assert.equal(restoreNumberStateV8(f.controller,f.controller.protocol.numberConversions,f.api).valid,true);
});
