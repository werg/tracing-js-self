import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtocolStateV8,applyProtocolRecordV8,PROTOCOL_MACHINE_API_V8 as api} from '../src/semantic/protocol-state-v8.js';
import {validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {validateEnumerationRecordV8,applyEnumerationRecordV8,restoreEnumerationStateV8} from '../src/semantic/protocol-enumeration-v8.js';

function controller(){return {heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
  frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};}
function allocate(c,name,properties=[],kind='object'){
  applyProtocolRecordV8(c,{kind:'allocate',name,objectKind:kind,length:kind==='array'?0:null,properties,
    code:null,captures:[],functionKind:null,lexicalReceiver:null});
}
const property=(key,value)=>({key:['str',key],value:['num',value]});
function define(c,object,key,value,{enumerable=true}={}){applyProtocolRecordV8(c,{kind:'property.define',object,key,
  descriptor:{kind:'data',value,writable:true,enumerable,configurable:true},success:true});}
function write(c,object,key,value){applyProtocolRecordV8(c,{kind:'property.set',object,key:['str',key],receiver:['ref',object],value,success:true});}
function apply(c,record){validateEnumerationRecordV8(record,{value:validateProtocolValueV8});const staged=structuredClone(c);
  assert.equal(applyEnumerationRecordV8(staged,record,api),true);assert.equal(restoreEnumerationStateV8(staged,api).valid,true);Object.assign(c,staged);}
function create(c,name,source){apply(c,{kind:'enumeration.create',name,source});}
function next(c,object,name,key){apply(c,{kind:'enumeration.next',object,name,result:key===undefined?['undefined']:['str',key],done:key===undefined});}

test('ordinary enumeration walks prototype keys in own order and preserves nonenumerable shadowing',()=>{
  const c=controller();allocate(c,'proto',[property('p',1),property('hidden',2),property('2',3),property('duplicate',4)]);
  allocate(c,'object',[property('a',1),property('10',2),property('1',3),property('duplicate',5)]);
  applyProtocolRecordV8(c,{kind:'property.prototype',object:'object',prototype:['ref','proto'],success:true});
  define(c,'object',['str','hidden'],['num',8],{enumerable:false});
  define(c,'object',['symbol','well-known:iterator'],['num',9]);
  create(c,'cursor',['ref','object']);assert.deepEqual(c.heap.get('cursor').keys,['1','10','a','duplicate','2','p']);
  for(const [index,key]of ['1','10','a','duplicate','2','p',undefined,undefined].entries())next(c,'cursor','r'+index,key);
  assert.equal(c.heap.get('cursor').nextIndex,6);assert.equal(c.heap.get('cursor').done,true);
  assert.deepEqual([...c.heap.get('r0').properties.keys()],['value','done']);assert.notEqual(c.heap.get('r6'),c.heap.get('r7'));
});

test('for-in strings use UTF-16 indices while other primitives have empty cursors',()=>{
  const c=controller();create(c,'string',['str','a😀']);
  for(const [index,key]of ['0','1','2',undefined].entries())next(c,'string','s'+index,key);
  for(const [index,source]of [['undefined'],['null'],['bool',true],['num',3],['bigint','2'],['symbol','well-known:iterator']].entries()){
    create(c,'p'+index,source);next(c,'p'+index,'end'+index,undefined);
  }
});

test('own-property checks distinguish inherited missing and undefined values without invoking accessors',()=>{
  const c=controller();allocate(c,'proto',[property('inherited',1)]);allocate(c,'object');
  applyProtocolRecordV8(c,{kind:'property.prototype',object:'object',prototype:['ref','proto'],success:true});
  define(c,'object',['str','hidden'],['undefined'],{enumerable:false});define(c,'object',['symbol','well-known:iterator'],['undefined']);
  applyProtocolRecordV8(c,{kind:'property.define',object:'object',key:['str','accessor'],
    descriptor:{kind:'accessor',get:['undefined'],set:['undefined'],enumerable:true,configurable:true},success:true});
  for(const [key,result]of [[['str','inherited'],false],[['str','missing'],false],[['str','hidden'],true],[['str','accessor'],true],[['symbol','well-known:iterator'],true]])
    applyProtocolRecordV8(c,{kind:'property.hasOwn',object:'object',key,result:['bool',result]});
  assert.throws(()=>applyProtocolRecordV8(c,{kind:'property.hasOwn',object:'object',key:['str','inherited'],result:['bool',true]}),/own-property/);
});

test('enumeration permits value writes and refuses changed keys descriptors or prototype on the next step',()=>{
  for(const mutate of [
    c=>write(c,'object','new',['num',4]),
    c=>define(c,'object',['str','a'],['num',4],{enumerable:false}),
    c=>applyProtocolRecordV8(c,{kind:'property.prototype',object:'object',prototype:null,success:true})
  ]){
    const c=controller();allocate(c,'object',[property('a',1)]);create(c,'cursor',['ref','object']);
    write(c,'object','a',['num',3]);next(c,'cursor','r0','a');mutate(c);
    assert.equal(restoreEnumerationStateV8(c,api).valid,true);const before=structuredClone(c);
    assert.throws(()=>next(c,'cursor','end',undefined),/descriptor or prototype changed/);assert.deepEqual(c,before);
  }
});

test('false enumeration results and reused identities leave the cursor unchanged',()=>{
  const c=controller();allocate(c,'object',[property('a',1)]);create(c,'cursor',['ref','object']);const before=structuredClone(c);
  for(const record of [
    {kind:'enumeration.next',object:'cursor',name:'r0',result:['str','wrong'],done:false},
    {kind:'enumeration.next',object:'cursor',name:'r0',result:['undefined'],done:true},
    {kind:'enumeration.next',object:'cursor',name:'cursor',result:['str','a'],done:false}
  ]){assert.throws(()=>apply(c,record));assert.deepEqual(c,before);}
  let reads=0;assert.throws(()=>validateEnumerationRecordV8({kind:'enumeration.create',name:'cursor',get source(){reads++;return ['null'];}},
    {value:validateProtocolValueV8}),/ordinary data/);assert.equal(reads,0);
});

test('restoration checks cursor bounds exact fields ordered keys shadowing and chain links',()=>{
  const c=controller();allocate(c,'proto',[property('p',3)]);allocate(c,'object',[property('2',2),property('1',1),property('a',4)]);
  applyProtocolRecordV8(c,{kind:'property.prototype',object:'object',prototype:['ref','proto'],success:true});create(c,'cursor',['ref','object']);
  for(const mutate of [
    node=>node.hiddenArchive={},node=>node.nextIndex=-1,node=>node.nextIndex=5,node=>node.done=true,
    node=>node.properties.set('extra',['num',1]),node=>node.source=['ref','cursor'],
    node=>node.keys.reverse(),node=>node.chain[0].prototype=['ref','object'],
    node=>node.chain[1].id='object',node=>node.chain[0].keys.push(['a',true]),
    node=>{node.chain[0].keys.reverse();node.keys=['a','2','1','p'];}
  ]){const broken=structuredClone(c);mutate(broken.heap.get('cursor'));assert.throws(()=>restoreEnumerationStateV8(broken,api));}
});
