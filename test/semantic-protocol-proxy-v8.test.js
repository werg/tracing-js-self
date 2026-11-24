import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolRecordV8,createProtocolStateV8,PROTOCOL_MACHINE_API_V8} from '../src/semantic/protocol-state-v8.js';
import {restoreProxyStateV8} from '../src/semantic/protocol-proxy-v8.js';
const ref=id=>['ref',id],key=name=>['str',name];
const restore=controller=>restoreProxyStateV8(controller,controller.protocol.proxyCalls,PROTOCOL_MACHINE_API_V8);
function fixture(){
  const controller={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
    frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};
  const apply=record=>{
    if(record.kind?.startsWith('proxy.')&&!['proxy.create','proxy.revocable','proxy.revoke','proxy.revoked.fault',
      'proxy.getMethod.begin','proxy.getMethod.finish','proxy.finish','proxy.fault'].includes(record.kind)){
      const operation=record.kind.split('.')[1],trapName=operation==='delete'?'deleteProperty':operation,
        lookup=typeof record.id==='string'?controller.protocol.proxyCalls?.getMethods?.find(row=>row.id===record.id):null,
        route=[];let current=record.object,node=controller.heap.get(current);
      if(lookup)route.push({object:lookup.object,target:structuredClone(lookup.target),handler:structuredClone(lookup.handler),method:structuredClone(lookup.method)});
      else{
        const seen=new Set();
        while(node?.kind==='proxy'){
          if(seen.has(current))throw new TypeError('cyclic test Proxy route');seen.add(current);
          const handler=controller.heap.get(node.handler[1]),method=handler?.properties.get(trapName)??['undefined'];
          route.push({object:current,target:structuredClone(node.target),handler:structuredClone(node.handler),method:structuredClone(method)});
          if(!['undefined','null'].includes(method[0]))break;
          current=node.target[1];node=controller.heap.get(current);
        }
      }
      record={...record,route};
      if(record.kind.endsWith('.call'))record={...record,owner:route.at(-1).object,receiver:ref(record.object)};
    }
    return applyProtocolRecordV8(controller,record);
  };
  for(const name of ['target','handler'])apply({kind:'allocate',name,objectKind:'object',length:null,properties:[],code:null,
    captures:[],functionKind:null,lexicalReceiver:null});
  apply({kind:'property.set',object:'target',key:key('x'),receiver:ref('target'),value:['num',2],success:true});
  apply({kind:'proxy.create',name:'proxy',target:ref('target'),handler:ref('handler')});return {controller,apply};
}
test('transparent Proxy reads and writes share target aliases and retain separate handler and proxy identities',()=>{
  const {controller,apply}=fixture();
  apply({kind:'proxy.get',object:'proxy',key:key('x'),result:['num',2]});
  apply({kind:'property.set',object:'target',key:key('x'),receiver:ref('target'),value:['num',4],success:true});
  apply({kind:'proxy.get',object:'proxy',key:key('x'),result:['num',4]});
  apply({kind:'proxy.set',object:'proxy',key:key('x'),value:['num',7],success:true});
  apply({kind:'proxy.set',object:'proxy',key:key('self'),value:ref('proxy'),success:true});
  assert.deepEqual(controller.heap.get('target').properties.get('x'),['num',7]);
  assert.deepEqual(controller.heap.get('target').properties.get('self'),ref('proxy'));
  assert.equal(controller.heap.get('proxy').properties.size,0);
  assert.equal(restore(controller).proxies,1);
  const target={x:2},handler={},proxy=new Proxy(target,handler);target.x=4;assert.equal(proxy.x,4);proxy.x=7;proxy.self=proxy;
  assert.equal(target.x,7);assert.equal(target.self,proxy);assert.notEqual(proxy,target);
});
test('Proxy.revocable retains a real callable identity and an ordinary pair result',()=>{
  const {controller,apply}=fixture();
  apply({kind:'proxy.revocable',proxy:'revocable',revoke:'revoker',result:'pair',
    target:ref('target'),handler:ref('handler')});
  const pair=controller.heap.get('pair'),revoker=controller.heap.get('revoker');
  assert.deepEqual(pair.properties.get('proxy'),ref('revocable'));
  assert.deepEqual(pair.properties.get('revoke'),ref('revoker'));
  assert.equal(revoker.kind,'closure');
  assert.equal(revoker.code,'Proxy.revoke:revocable');
  assert.deepEqual(revoker.properties.get('length'),['num',0]);
  assert.deepEqual(revoker.properties.get('name'),['str','']);
  assert.equal(restore(controller).proxies,2);
  apply({kind:'proxy.revoke',object:'revocable'});
  assert.deepEqual(controller.heap.get('revocable').target,['null']);
  assert.deepEqual(controller.heap.get('revocable').handler,['null']);
});

test('revocable Proxy clears both internal slots and preserves an already selected trap',()=>{
  const {controller,apply}=fixture();
  apply({kind:'proxy.revoke',object:'proxy'});
  assert.deepEqual(controller.heap.get('proxy').target,['null']);
  assert.deepEqual(controller.heap.get('proxy').handler,['null']);
  apply({kind:'proxy.revoke',object:'proxy'});
  apply({kind:'proxy.revoked.fault',object:'proxy',operation:'get',error:'revokedError'});
  assert.equal(controller.lastReturn.kind,'throw');
  assert.deepEqual(controller.lastReturn.value,ref('revokedError'));
  assert.deepEqual(controller.heap.get('revokedError').properties.get('message'),['str',"Cannot perform 'get' on a proxy that has been revoked"]);
  const active=fixture();trap(active,'has');
  active.apply({kind:'proxy.has.call',id:'has',object:'proxy',key:key('x'),child:'reader'});
  const selected=structuredClone(active.controller.protocol.proxyCalls.pending[0]);
  active.apply({kind:'proxy.revoke',object:'proxy'});
  active.apply({kind:'return',invocation:'reader',value:['bool',true]});
  active.apply({kind:'proxy.finish',id:'has',completion:{kind:'normal',value:['bool',true]}});
  assert.equal(active.controller.protocol.proxyCalls.pending.length,0);
  assert.deepEqual(selected.target,ref('target'));
});
test('Proxy descriptors and extensibility reuse ordinary assignment failure atomically',()=>{
  const {controller,apply}=fixture();
  apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'data',value:['num',2],
    writable:false,enumerable:true,configurable:false},success:true});
  apply({kind:'proxy.set',object:'proxy',key:key('x'),value:['num',7],success:false});
  const before=structuredClone(controller.heap);
  assert.throws(()=>apply({kind:'proxy.set',object:'proxy',key:key('x'),value:['num',7],success:true}),/false Proxy assignment/);
  assert.deepEqual(controller.heap,before);
  apply({kind:'property.preventExtensions',object:'target'});
  apply({kind:'proxy.set',object:'proxy',key:key('new'),value:['num',1],success:false});
  assert.throws(()=>apply({kind:'proxy.get',object:'proxy',key:key('x'),result:['num',7]}),/false Proxy data read/);
});
test('selected Proxy trap values are checked at use while accessor targets, exotic chains and forged aliases are bounded',()=>{
  const {controller,apply}=fixture();
  apply({kind:'property.set',object:'handler',key:key('get'),receiver:ref('handler'),value:['num',1],success:true});
  const before=structuredClone(controller.heap);
  assert.throws(()=>apply({kind:'proxy.get',object:'proxy',key:key('x'),result:['num',2]}),/explicit call boundary/);
  assert.deepEqual(controller.heap,before);
  assert.equal(restore(controller).proxies,1,'unused handler trap values are retained as data');
  const clean=fixture();clean.controller.heap.get('proxy').target=ref('proxy');
  assert.throws(()=>restore(clean.controller),/target graph contains a cycle/);
  const accessor=fixture();accessor.apply({kind:'property.define',object:'target',key:key('x'),
    descriptor:{kind:'accessor',get:['undefined'],set:['undefined'],enumerable:true,configurable:true},success:true});
  assert.throws(()=>accessor.apply({kind:'proxy.get',object:'proxy',key:key('x'),result:['undefined']}),/call boundary/);
  const forged=fixture();forged.controller.heap.get('proxy').properties.set('x',['num',2]);
  assert.throws(()=>restore(forged.controller),/invented own storage/);
});

function trap(fixture,operation,{name=operation+'Trap',functionKind='ordinary',lexicalReceiver=null}={}){
  fixture.apply({kind:'allocate',name,objectKind:'closure',length:null,properties:[],code:name,
    captures:[],functionKind,lexicalReceiver});
  fixture.apply({kind:'property.set',object:'handler',key:key(operation),receiver:ref('handler'),value:ref(name),success:true});
  return name;
}
test('Proxy traps enter the shared call scope with live selection, arguments and exact receivers',()=>{
  const f=fixture();trap(f,'get');trap(f,'set');
  f.apply({kind:'proxy.get.call',id:'read',object:'proxy',key:key('x'),child:'reader'});
  assert.deepEqual(f.controller.receiver,ref('handler'));
  assert.deepEqual(f.controller.protocol.callFrames[0].arguments,[ref('target'),key('x'),ref('proxy')]);
  assert.equal(restore(f.controller).calls,1);
  // Mutation after entry must not replace the already selected callback.
  f.apply({kind:'property.set',object:'handler',key:key('get'),receiver:ref('handler'),value:['null'],success:true});
  assert.equal(restore(f.controller).calls,1);
  f.apply({kind:'return',invocation:'reader',value:['num',3]});
  assert.throws(()=>f.apply({kind:'bind',name:'skip',value:['num',3]}),/pending Proxy callback/);
  assert.throws(()=>f.apply({kind:'proxy.finish',id:'read',completion:{kind:'normal',value:['num',2]}}),/false Proxy callback/);
  f.apply({kind:'proxy.finish',id:'read',completion:{kind:'normal',value:['num',3]}});
  assert.deepEqual(f.controller.receiver,['undefined']);
  f.apply({kind:'proxy.set.call',id:'write',object:'proxy',key:key('x'),value:['num',7],child:'writer',strict:false});
  assert.deepEqual(f.controller.protocol.callFrames[0].arguments,[ref('target'),key('x'),['num',7],ref('proxy')]);
  f.apply({kind:'property.set',object:'target',key:key('x'),receiver:ref('target'),value:['num',8],success:true});
  f.apply({kind:'return',invocation:'writer',value:ref('target')});
  f.apply({kind:'proxy.finish',id:'write',completion:{kind:'normal',value:['num',7]}});
  assert.deepEqual(f.controller.heap.get('target').properties.get('x'),['num',8]);
  assert.equal(restore(f.controller).calls,0);
});
test('Proxy nested callbacks retain selected source identities, arrow receivers and thrown values',()=>{
  const f=fixture();trap(f,'get',{functionKind:'arrow',lexicalReceiver:ref('target')});
  f.apply({kind:'proxy.get.call',id:'outer',object:'proxy',key:key('x'),child:'outerTrap'});
  assert.deepEqual(f.controller.receiver,ref('target'));
  f.apply({kind:'proxy.get.call',id:'inner',object:'proxy',key:key('x'),child:'innerTrap'});
  assert.equal(restore(f.controller).calls,2);
  const forged=structuredClone(f.controller);forged.protocol.proxyCalls.pending[0].callee=ref('target');
  assert.throws(()=>restore(forged),/source identity/);
  const reordered=structuredClone(f.controller);reordered.protocol.proxyCalls.pending.reverse();
  assert.throws(()=>restore(reordered),/stack relationship\/order/);
  f.apply({kind:'throw',invocation:'innerTrap',value:['str','thrown']});
  f.apply({kind:'proxy.finish',id:'inner',completion:{kind:'throw',value:['str','thrown']}});
  f.apply({kind:'throw',invocation:'outerTrap',value:['str','thrown']});
  f.apply({kind:'proxy.finish',id:'outer',completion:{kind:'throw',value:['str','thrown']}});
  assert.equal(restore(f.controller).calls,0);
});
test('Proxy set traps accept declared Symbols as truthy without storing the trap result',()=>{
  const f=fixture();trap(f,'set');
  f.apply({kind:'proxy.set.call',id:'write',object:'proxy',key:key('x'),value:['num',7],child:'writer',strict:false});
  f.apply({kind:'return',invocation:'writer',value:['symbol','well-known:iterator']});
  f.apply({kind:'proxy.finish',id:'write',completion:{kind:'normal',value:['num',7]}});
  assert.equal(restore(f.controller).calls,0);
  assert.deepEqual(f.controller.heap.get('target').properties.get('x'),['num',2]);
});
test('Proxy completion checks reject false setters and honor SameValue for frozen live target data',()=>{
  for(const value of [['num','-0'],['num','NaN'],ref('handler')]){
    const f=fixture();trap(f,'get');
    f.apply({kind:'proxy.get.call',id:'read',object:'proxy',key:key('x'),child:'reader'});
    f.apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'data',value,
      writable:false,enumerable:true,configurable:false},success:true});
    f.apply({kind:'return',invocation:'reader',value});
    f.apply({kind:'proxy.finish',id:'read',completion:{kind:'normal',value}});
  }
  const bad=fixture();trap(bad,'get');
  bad.apply({kind:'proxy.get.call',id:'read',object:'proxy',key:key('x'),child:'reader'});
  bad.apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'data',value:['num','-0'],
    writable:false,enumerable:true,configurable:false},success:true});
  bad.apply({kind:'return',invocation:'reader',value:['num',0]});
  const before=structuredClone(bad.controller);
  assert.throws(()=>bad.apply({kind:'proxy.finish',id:'read',completion:{kind:'normal',value:['num',0]}}),/derived abrupt boundary/);
  assert.deepEqual(bad.controller,before);
  const falseSet=fixture();trap(falseSet,'set');
  falseSet.apply({kind:'proxy.set.call',id:'write',object:'proxy',key:key('x'),value:['num',7],child:'writer',strict:true});
  falseSet.apply({kind:'return',invocation:'writer',value:['bool',false]});
  assert.throws(()=>falseSet.apply({kind:'proxy.finish',id:'write',completion:{kind:'normal',value:['num',7]}}),/derived abrupt boundary/);
  falseSet.apply({kind:'proxy.fault',id:'write',error:'strict-set-error'});
  assert.equal(falseSet.controller.heap.get('strict-set-error').properties.get('message')[1],
    "'set' on proxy: trap returned falsish for property 'x'");
});


function selectHasGetter(f,{id='lookup',getter='getHas',method='hasTrap',child='getterCall'}={}){
  for(const name of [getter,method])f.apply({kind:'allocate',name,objectKind:'closure',length:null,properties:[],
    code:name,captures:[],functionKind:'ordinary',lexicalReceiver:null});
  f.apply({kind:'property.define',object:'handler',key:key('has'),
    descriptor:{kind:'accessor',get:ref(getter),set:['undefined'],enumerable:true,configurable:true},success:true});
  f.apply({kind:'proxy.getMethod.begin',id,operation:'has',object:'proxy',target:ref('target'),
    handler:ref('handler'),receiver:ref('handler'),key:key('x'),child,getter:ref(getter)});
  f.apply({kind:'property.get.call',id,child,object:'handler',key:key('has'),receiver:ref('handler')});
  return {id,getter,method,child};
}
function finishHasGetter(f,selection,value){
  const thrown=value[0]==='throw';
  const result=thrown?value.value:value;
  f.apply(thrown?{kind:'throw',invocation:selection.child,value:result}:
    {kind:'return',invocation:selection.child,value:result});
  f.apply({kind:'property.finish',id:selection.id,completion:{kind:thrown?'throw':'normal',value:result}});
  f.apply({kind:'proxy.getMethod.finish',id:selection.id,
    completion:{kind:thrown?'throw':'normal',value:result}});
}
test('Proxy has GetMethod getter retains target, handler, receiver and selected closure through mutation',()=>{
  const f=fixture(),selection=selectHasGetter(f);
  assert.deepEqual(f.controller.receiver,ref('handler'));
  assert.deepEqual(f.controller.protocol.callFrames.at(-1).arguments,[]);
  const forgedActive=structuredClone(f.controller);
  forgedActive.protocol.proxyCalls.getMethods[0].getter=ref('hasTrap');
  assert.throws(()=>restore(forgedActive),/getter source identity|selected accessor/);
  f.apply({kind:'property.define',object:'handler',key:key('has'),
    descriptor:{kind:'data',value:['null'],writable:true,enumerable:true,configurable:true},success:true});
  finishHasGetter(f,selection,ref('hasTrap'));
  assert.equal(f.controller.protocol.proxyCalls.getMethods[0].phase,'returned');
  const forgedReturned=structuredClone(f.controller);
  forgedReturned.protocol.proxyCalls.getMethods[0].method=ref('getHas');
  assert.throws(()=>restore(forgedReturned),/method identity/);
  f.apply({kind:'proxy.has.call',id:selection.id,object:'proxy',key:key('x'),child:'hasBody'});
  assert.deepEqual(f.controller.protocol.callFrames.at(-1).callee,ref('hasTrap'),
    'replacement handler value does not replace the selected getter result');
  assert.deepEqual(f.controller.receiver,ref('handler'));
  f.apply({kind:'return',invocation:'hasBody',value:['bool',true]});
  f.apply({kind:'proxy.finish',id:selection.id,completion:{kind:'normal',value:['bool',true]}});
  assert.equal(f.controller.protocol.proxyCalls.getMethods.length,0);
  assert.equal(restore(f.controller).calls,0);
});
test('Proxy has GetMethod propagates getter throws unchanged and nullish fallback uses saved target after revocation',()=>{
  const marker=ref('handler');
  const failed=fixture(),throwingGetter=selectHasGetter(failed,{id:'throwing'});
  failed.apply({kind:'throw',invocation:throwingGetter.child,value:marker});
  failed.apply({kind:'property.finish',id:throwingGetter.id,completion:{kind:'throw',value:marker}});
  failed.apply({kind:'proxy.getMethod.finish',id:throwingGetter.id,completion:{kind:'throw',value:marker}});
  assert.deepEqual(failed.controller.lastReturn,{kind:'throw',value:marker});
  assert.equal(failed.controller.protocol.proxyCalls.getMethods.length,0);
  assert.equal(restore(failed.controller).calls,0);

  const direct=fixture(),selection=selectHasGetter(direct,{id:'direct'});
  direct.apply({kind:'proxy.revoke',object:'proxy'});
  finishHasGetter(direct,selection,['null']);
  direct.apply({kind:'proxy.has',id:selection.id,object:'proxy',key:key('x'),result:['bool',true]});
  assert.deepEqual(direct.controller.protocol.proxyCalls.getMethods,[]);
  assert.equal(restore(direct.controller).proxies,1);
  const target={x:2};let pair;
  pair=Proxy.revocable(target,{get has(){pair.revoke();return null;}});
  assert.equal('x' in pair.proxy,true);
});
