import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolRecordV8,createProtocolStateV8,restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {PROTOCOL_MACHINE_ADAPTERS_V8} from '../src/semantic/protocol-machine-extensions-v8.js';

const ref=id=>['ref',id],key=name=>['str',name];
function controller(){return {heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
  frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8(),
  ready:[],effects:new Map(),jobs:new Map(),strictRequests:false};}
function allocation(name){return {kind:'allocate',name,objectKind:'object',length:null,properties:[],code:null,captures:[],
  functionKind:null,lexicalReceiver:null};}
function apply(c,...records){for(const record of records)applyProtocolRecordV8(c,record);return c;}

test('property.fault derives invalid in target and authenticates a fresh mutable TypeError identity',()=>{
  const c=controller();apply(c,allocation('key'));
  const before=structuredClone(c);
  assert.throws(()=>apply(c,{kind:'property.fault',operation:'has',target:ref('key'),key:ref('key'),error:'error'}),/primitive.*RHS|outside.*profile/i);
  assert.deepEqual(c,before);
  apply(c,{kind:'property.fault',operation:'has',target:['null'],key:ref('key'),error:'error'});
  const error=c.heap.get('error');
  assert.equal(error.declaredError,'TypeError');
  assert.deepEqual(error.properties.get('name'),['str','TypeError']);
  assert.deepEqual(error.properties.get('message'),['str','Right-hand side of in is not an object']);
  assert.deepEqual(c.lastReturn,{kind:'throw',value:ref('error')});
  apply(c,{kind:'property.set',object:'error',key:key('name'),receiver:ref('error'),value:['str','changed'],success:true},
    {kind:'property.set',object:'error',key:key('message'),receiver:ref('error'),value:['str','changed message'],success:true});
  const updated=c.heap.get('error');
  assert.equal(updated.declaredError,'TypeError');
  assert.deepEqual(updated.properties.get('name'),['str','changed']);
  assert.deepEqual(updated.properties.get('message'),['str','changed message']);
  assert.equal(restoreProtocolStateV8(c,c.protocol).valid,true);
});

test('intrinsic Error brand restoration rejects forged kind or unknown type',()=>{
  const c=controller();apply(c,allocation('key'),
    {kind:'property.fault',operation:'has',target:['null'],key:ref('key'),error:'error'});
  const error=c.heap.get('error'),originalKind=error.kind;
  error.kind='array';assert.throws(()=>restoreProtocolStateV8(c,c.protocol),/intrinsic Error brand/);
  error.kind=originalKind;error.declaredError='ForgedError';
  assert.throws(()=>restoreProtocolStateV8(c,c.protocol),/intrinsic Error brand/);
});

test('the public registry has no free-standing Error allocation record',()=>{
  assert.equal(PROTOCOL_MACHINE_ADAPTERS_V8.some(adapter=>adapter.recordFields?.['error.create']),false);
});
