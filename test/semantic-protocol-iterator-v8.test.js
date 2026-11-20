import test from 'node:test';
import assert from 'node:assert/strict';
import {encode} from '../src/values.js';
import {createProtocolStateV8,applyProtocolRecordV8,PROTOCOL_MACHINE_API_V8 as api} from '../src/semantic/protocol-state-v8.js';
import {validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {validateIteratorRecordV8,applyIteratorRecordV8,restoreIteratorStateV8} from '../src/semantic/protocol-iterator-v8.js';

function controller(){return {heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
  frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};}
function array(c,id,length,properties=[]){applyProtocolRecordV8(c,{kind:'allocate',name:id,objectKind:'array',length,properties,
  code:null,captures:[],functionKind:null,lexicalReceiver:null});}
function apply(c,record){validateIteratorRecordV8(record,{value:validateProtocolValueV8});const staged=structuredClone(c);
  assert.equal(applyIteratorRecordV8(staged,record,api),true);assert.equal(restoreIteratorStateV8(staged,api).valid,true);Object.assign(c,staged);}
function next(c,id,name,result,done=false,entry=null){apply(c,{kind:'iterator.next',object:id,name,entry,result,done});
  return c.heap.get(name);}
function write(c,object,key,value){applyProtocolRecordV8(c,{kind:'property.set',object,key:['str',key],receiver:['ref',object],value,success:true});}

test('builtin iterators preserve holes, live length, permanent completion and fresh result identities',()=>{
  const c=controller(),native=[,2],it=native.values();array(c,'array',2,[{key:['str','1'],value:['num',2]}]);
  apply(c,{kind:'iterator.lookup',receiver:['ref','array'],key:['str','values'],method:'Array.prototype.values'});
  apply(c,{kind:'iterator.create',name:'iterator',iterated:['ref','array'],iterationKind:'values'});
  for(let i=0;i<2;i++){const expected=it.next(),actual=next(c,'iterator','r'+i,encode(expected.value),expected.done);
    assert.deepEqual(actual.properties.get('done'),encode(expected.done));}
  native.push(3);write(c,'array','2',['num',3]);
  for(let i=2;i<4;i++){const expected=it.next();next(c,'iterator','r'+i,encode(expected.value),expected.done);}
  native.push(4);write(c,'array','3',['num',4]);const terminal=it.next();next(c,'iterator','r4',encode(terminal.value),terminal.done);
  assert.equal(c.heap.get('iterator').nextIndex,3);assert.equal(c.heap.get('iterator').done,true);
  assert.notEqual(c.heap.get('r3'),c.heap.get('r4'));
  assert.throws(()=>next(c,'iterator','r4',['undefined'],true),/duplicate allocation/);
});

test('keys skip index value reads and entries allocate distinct pairs while preserving element aliases',()=>{
  const c=controller();array(c,'array',2,[{key:['str','0'],value:['num','-0']},{key:['str','1'],value:['num','NaN']}]);
  apply(c,{kind:'iterator.create',name:'keys',iterated:['ref','array'],iterationKind:'keys'});
  apply(c,{kind:'iterator.create',name:'entries',iterated:['ref','array'],iterationKind:'entries'});
  const native=[-0,NaN],keys=native.keys(),entries=native.entries();
  for(let i=0;i<2;i++){
    next(c,'keys','k'+i,encode(keys.next().value));
    const expected=entries.next().value;next(c,'entries','e'+i,['ref','pair'+i],false,'pair'+i);
    assert.deepEqual(c.heap.get('pair'+i).properties.get('0'),encode(expected[0]));
    assert.deepEqual(c.heap.get('pair'+i).properties.get('1'),encode(expected[1]));
  }
  next(c,'entries','end',['undefined'],true);assert.notEqual(c.heap.get('pair0'),c.heap.get('pair1'));
});

test('primitive string iteration advances Unicode code points without normalizing lone surrogates',()=>{
  const c=controller(),text='a😀\ud800z\udc00',native=text[Symbol.iterator]();
  apply(c,{kind:'iterator.lookup',receiver:['str',text],key:['symbol','well-known:iterator'],method:'String.prototype.iterator'});
  apply(c,{kind:'iterator.create',name:'string',iterated:['str',text],iterationKind:'string'});
  for(let i=0;i<7;i++){const expected=native.next();next(c,'string','r'+i,encode(expected.value),expected.done);}
  assert.equal(c.heap.get('string').nextIndex,text.length);
  const broken=structuredClone(c);broken.heap.get('string').nextIndex=2;broken.heap.get('string').done=false;
  assert.throws(()=>restoreIteratorStateV8(broken,api),/surrogate pair/);
});

test('method selection and standard-array guards reject overrides without invoking getters',()=>{
  const c=controller();array(c,'array',1);
  apply(c,{kind:'iterator.arrayGuard',iterated:['ref','array'],result:true});
  apply(c,{kind:'iterator.arrayGuard',iterated:['str','x'],result:false});
  applyProtocolRecordV8(c,{kind:'property.define',object:'array',key:['symbol','well-known:iterator'],
    descriptor:{kind:'data',value:['undefined'],writable:true,enumerable:true,configurable:true},success:true});
  apply(c,{kind:'iterator.arrayGuard',iterated:['ref','array'],result:false});
  assert.throws(()=>apply(c,{kind:'iterator.lookup',receiver:['ref','array'],key:['symbol','well-known:iterator'],method:'Array.prototype.values'}),/overridden/);
  apply(c,{kind:'iterator.lookup',receiver:['ref','array'],key:['str','values'],method:'Array.prototype.values'});
  assert.throws(()=>apply(c,{kind:'iterator.lookup',receiver:['ref','array'],key:['str','keys'],method:'Array.prototype.values'}),/selection/);
});

test('an array with null prototype cannot claim inherited builtin iteration',()=>{
  const c=controller();array(c,'array',0);
  applyProtocolRecordV8(c,{kind:'property.prototype',object:'array',prototype:null,success:true});
  apply(c,{kind:'iterator.arrayGuard',iterated:['ref','array'],result:false});
  const before=structuredClone(c);
  for(const record of [
    {kind:'iterator.arrayGuard',iterated:['ref','array'],result:true},
    {kind:'iterator.lookup',receiver:['ref','array'],key:['symbol','well-known:iterator'],method:'Array.prototype.values'},
    {kind:'iterator.lookup',receiver:['ref','array'],key:['str','values'],method:'Array.prototype.values'}
  ]){assert.throws(()=>applyProtocolRecordV8(c,record));assert.deepEqual(c,before);}
});

test('failed iterator claims commit no cursor or allocation changes and restore rejects hidden state',()=>{
  const c=controller();array(c,'array',1,[{key:['str','0'],value:['num',7]}]);
  apply(c,{kind:'iterator.create',name:'iterator',iterated:['ref','array'],iterationKind:'values'});
  const before=structuredClone(c);
  for(const record of [
    {kind:'iterator.next',object:'iterator',name:'bad',entry:null,result:['num',9],done:false},
    {kind:'iterator.next',object:'iterator',name:'bad',entry:'extra',result:['num',7],done:false},
    {kind:'iterator.next',object:'iterator',name:'iterator',entry:null,result:['num',7],done:false},
    {kind:'iterator.identity',object:'iterator',result:['ref','array']}
  ]){assert.throws(()=>apply(c,record));assert.deepEqual(c,before);}
  const broken=structuredClone(c);broken.heap.get('iterator').hiddenArchive={pc:1};
  assert.throws(()=>restoreIteratorStateV8(broken,api),/fields/);
  const alias=structuredClone(c);alias.heap.get('iterator').iterated=['ref','iterator'];
  assert.throws(()=>restoreIteratorStateV8(alias,api),/source identity/);
});

test('iterator properties expose only their declared non-observing profile',()=>{
  const c=controller();apply(c,{kind:'iterator.create',name:'string',iterated:['str','x'],iterationKind:'string'});
  apply(c,{kind:'iterator.lookup',receiver:['ref','string'],key:['str','next'],method:'Iterator.next'});
  apply(c,{kind:'iterator.identity',object:'string',result:['ref','string']});
  apply(c,{kind:'iterator.read',object:'string',key:['symbol','well-known:toStringTag'],result:['str','String Iterator']});
  apply(c,{kind:'iterator.read',object:'string',key:['str','absent'],result:['undefined']});
  assert.throws(()=>apply(c,{kind:'iterator.read',object:'string',key:['str','next'],result:['undefined']}),/declared operation/);
  let observed=0;const record={kind:'iterator.next',get object(){observed++;return 'string';},name:'r',entry:null,result:['str','x'],done:false};
  assert.throws(()=>validateIteratorRecordV8(record,{value:validateProtocolValueV8}),/ordinary data/);assert.equal(observed,0);
});

test('frozen iterator contract fixtures replay their exact result identities and cursor states',async()=>{
  const {readFile}=await import('node:fs/promises');
  const fixtures=JSON.parse(await readFile(new URL('./fixtures/semantic-iterator-v8.json',import.meta.url),'utf8'));
  for(const fixture of fixtures.cases){const c=controller();c.stack=['invocation1'];c.frameFunctions=new Map([['invocation1','run']]);
    for(const line of fixture.lines){const record=JSON.parse(line.slice('protocol '.length));
      if(record.kind.startsWith('iterator.')){apply(c,record);c.protocol.sequence++;}else applyProtocolRecordV8(c,record);
    }
    const expected=fixture.expected;
    assert.deepEqual(c.heap,new Map(expected.heap.map(([id,node])=>[id,{...node,properties:new Map(node.properties),
      ...(node.descriptors?{descriptors:new Map(node.descriptors)}:{})}])));
    assert.deepEqual(c.completion,expected.completion);assert.deepEqual(c.protocol,expected.protocol);
  }
});
