import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolRecordV8,createProtocolStateV8,PROTOCOL_MACHINE_API_V8} from '../src/semantic/protocol-state-v8.js';
import {restoreProxyReflectionV8} from '../src/semantic/protocol-proxy-reflection-v8.js';
import {deriveProxyRouteV8} from '../src/semantic/protocol-proxy-v8.js';
const ref=id=>['ref',id],str=value=>['str',value];
function fixture(operation){
  const c={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
    frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};
  const apply=record=>applyProtocolRecordV8(c,record),allocate=(name,kind='object')=>apply({kind:'allocate',name,objectKind:kind,
    length:null,properties:[],code:kind==='closure'?name:null,captures:[],functionKind:kind==='closure'?'ordinary':null,lexicalReceiver:null});
  apply({kind:'promise.intrinsics'});for(const name of ['target','handler','other'])allocate(name);
  apply({kind:'proxy.create',name:'proxy',target:ref('target'),handler:ref('handler')});
  if(operation){allocate('trap','closure');apply({kind:'property.set',object:'handler',key:str(operation),receiver:ref('handler'),value:ref('trap'),success:true});}
  const start=(op=operation,caller='Reflect.'+op,args=[])=>apply({kind:'proxy.reflect.call',id:'reflection',object:'proxy',operation:op,
    caller,arguments:args,child:'callback',route:deriveProxyRouteV8(c,'proxy',op,PROTOCOL_MACHINE_API_V8).rows});
  const finish=value=>apply({kind:'proxy.reflect.finish',id:'reflection',completion:{kind:'normal',value}});
  const restore=(controller=c)=>restoreProxyReflectionV8(controller,controller.protocol.proxyReflection,PROTOCOL_MACHINE_API_V8);
  return {c,apply,start,finish,restore};
}
test('reflection retains the selected trap while live target extensibility changes',()=>{
  const f=fixture('isExtensible');f.start();
  assert.deepEqual(f.c.protocol.callFrames[0].arguments,[ref('target')]);assert.equal(f.restore().calls,1);
  f.apply({kind:'property.set',object:'handler',key:str('isExtensible'),receiver:ref('handler'),value:['undefined'],success:true});
  f.apply({kind:'property.preventExtensions',object:'target'});assert.equal(f.restore().calls,1);
  f.apply({kind:'return',invocation:'callback',value:['num',0]});f.finish(['bool',false]);assert.equal(f.restore().calls,0);
});
test('getPrototypeOf validates result type before consulting target extensibility',()=>{
  const f=fixture('getPrototypeOf');f.start();f.apply({kind:'return',invocation:'callback',value:['num',7]});
  assert.throws(()=>f.finish(['num',7]),/derived fault/);
  f.apply({kind:'proxy.reflect.fault',id:'reflection',error:'error'});
  assert.deepEqual(f.c.heap.get('error').properties.get('message'),str("'getPrototypeOf' on proxy: trap returned neither object nor null"));
});
test('nonextensible target prototype is checked after callback mutation',()=>{
  const f=fixture('getPrototypeOf');f.start();
  f.apply({kind:'property.prototype',object:'target',prototype:ref('other'),success:true});
  f.apply({kind:'property.preventExtensions',object:'target'});
  f.apply({kind:'return',invocation:'callback',value:ref('other')});f.finish(ref('other'));
});
test('Object and Reflect retain distinct falsish setPrototypeOf semantics',()=>{
  const reflect=fixture('setPrototypeOf');reflect.start('setPrototypeOf','Reflect.setPrototypeOf',[['null']]);
  reflect.apply({kind:'return',invocation:'callback',value:['str','']});reflect.finish(['bool',false]);
  const object=fixture('setPrototypeOf');object.start('setPrototypeOf','Object.setPrototypeOf',[['null']]);
  object.apply({kind:'return',invocation:'callback',value:['bool',false]});
  assert.throws(()=>object.finish(ref('proxy')),/derived fault/);
  object.apply({kind:'proxy.reflect.fault',id:'reflection',error:'error'});
});
test('successful preventExtensions callback must actually close target extension',()=>{
  const f=fixture('preventExtensions');f.start('preventExtensions','Object.preventExtensions');
  f.apply({kind:'return',invocation:'callback',value:ref('target')});
  f.apply({kind:'proxy.reflect.fault',id:'reflection',error:'error'});
  assert.equal(f.c.heap.get('target').extensible,undefined);
  const valid=fixture('preventExtensions');valid.start('preventExtensions','Object.preventExtensions');
  valid.apply({kind:'property.preventExtensions',object:'target'});
  valid.apply({kind:'return',invocation:'callback',value:ref('target')});valid.finish(ref('proxy'));
});
test('false reflection results and retained argument forgery fail atomically',()=>{
  const f=fixture('setPrototypeOf');f.start('setPrototypeOf','Reflect.setPrototypeOf',[ref('other')]);
  const forged=structuredClone(f.c);forged.protocol.proxyReflection.pending[0].arguments=[['null']];
  assert.throws(()=>f.restore(forged),/callback arguments/);
  f.apply({kind:'return',invocation:'callback',value:['bool',true]});
  const before=structuredClone(f.c);
  assert.throws(()=>f.finish(['bool',false]),/false Proxy reflection completion/);assert.deepEqual(f.c,before);
  assert.throws(()=>f.apply({kind:'bind',name:'skip',value:['bool',true]}),/requires completion/);
  f.finish(['bool',true]);
});
test('transparent reflection forwards prototype and extension operations without trap calls',()=>{
  const f=fixture();
  for(const [operation,args,result]of [
    ['setPrototypeOf',[ref('other')],['bool',true]],
    ['getPrototypeOf',[],ref('other')],
    ['preventExtensions',[],['bool',true]],
    ['isExtensible',[],['bool',false]],
    ['setPrototypeOf',[['null']],['bool',false]]
  ])f.apply({kind:'proxy.reflect.direct',object:'proxy',operation,caller:'Reflect.'+operation,arguments:args,result,
    route:deriveProxyRouteV8(f.c,'proxy',operation,PROTOCOL_MACHINE_API_V8).rows});
});
test('thrown trap values retain identity and suppress normal invariant checks',()=>{
  const f=fixture('getPrototypeOf');f.start();f.apply({kind:'throw',invocation:'callback',value:ref('other')});
  f.apply({kind:'proxy.reflect.finish',id:'reflection',completion:{kind:'throw',value:ref('other')}});
  assert.deepEqual(f.c.lastReturn,{kind:'throw',value:ref('other')});
});
