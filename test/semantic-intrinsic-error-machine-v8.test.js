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
  assert.deepEqual(c.protocol.intrinsicErrors,{schema:'semantic-intrinsic-error-state/1',
    errors:[{id:'error',errorType:'TypeError'}]});
  assert.equal(error.declaredError,'TypeError');
  assert.equal(error.properties.has('name'),false);
  apply(c,{kind:'property.get',object:'error',key:key('name'),receiver:ref('error'),result:['str','TypeError']});
  assert.equal(error.descriptors.get('message').enumerable,false);
  assert.deepEqual(error.properties.get('message'),['str',"Cannot use 'in' operator to search for '#<Object>' in null"]);
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

test('intrinsic Error restoration requires exact retained allocation provenance',()=>{
  const forged=controller();apply(forged,allocation('ordinary'));
  forged.heap.get('ordinary').declaredError='TypeError';
  assert.throws(()=>restoreProtocolStateV8(forged,forged.protocol),/intrinsic Error|extension heap state/);

  const c=controller();apply(c,{kind:'property.fault',operation:'has',target:['null'],key:['str','x'],error:'error'});
  for(const mutate of [
    state=>{state.intrinsicErrors.errors=[];},
    state=>{state.intrinsicErrors.errors[0].errorType='RangeError';},
    state=>{state.intrinsicErrors.errors[0].id='missing';},
    state=>{state.intrinsicErrors.errors.push({...state.intrinsicErrors.errors[0]});}
  ]){
    const snapshot=structuredClone(c.protocol);mutate(snapshot);
    assert.throws(()=>restoreProtocolStateV8(c,snapshot),/intrinsic Error/);
  }
  assert.equal(restoreProtocolStateV8(c,c.protocol).valid,true);
});

test('the public registry has no free-standing Error allocation record',()=>{
  assert.equal(PROTOCOL_MACHINE_ADAPTERS_V8.some(adapter=>adapter.recordFields?.['error.create']),false);
});

test('hasInstance derives live prototype membership independently of the Error allocation brand',()=>{
  const c=controller();apply(c,{kind:'property.fault',operation:'has',target:['null'],key:key('x'),error:'error'});
  const intrinsic=name=>'intrinsic'+name.replace(/[^a-z0-9]/gi,'').toLowerCase();
  const check=(name,result)=>({kind:'object.hasInstance',constructor:ref(intrinsic(name)),value:ref('error'),result:['bool',result]});
  apply(c,check('TypeError',true),check('Error',true),check('Object',true),check('RangeError',false));
  const before=structuredClone(c);
  assert.throws(()=>apply(c,check('RangeError',true)),/live prototype chain/);assert.deepEqual(c,before);
  apply(c,{kind:'property.prototype',object:'error',prototype:ref(intrinsic('RangeError.prototype')),success:true},
    check('TypeError',false),check('RangeError',true),check('Error',true));
  assert.equal(c.heap.get('error').declaredError,'TypeError');
  assert.equal(restoreProtocolStateV8(c,c.protocol).valid,true);
  apply(c,{kind:'object.hasInstance',constructor:ref(intrinsic('TypeError')),value:['num',7],result:['bool',false]});
});
