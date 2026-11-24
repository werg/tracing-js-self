import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolRecordV8,createProtocolStateV8,PROTOCOL_MACHINE_API_V8} from '../src/semantic/protocol-state-v8.js';
import {restoreProxyStateV8} from '../src/semantic/protocol-proxy-v8.js';

const ref=id=>['ref',id],key=name=>['str',name];
function fixture(){
  const controller={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
    frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};
  const apply=record=>applyProtocolRecordV8(controller,record);
  for(const name of ['target','handler'])apply({kind:'allocate',name,objectKind:'object',length:null,properties:[],code:null,
    captures:[],functionKind:null,lexicalReceiver:null});
  apply({kind:'property.set',object:'target',key:key('x'),receiver:ref('target'),value:['num',2],success:true});
  apply({kind:'proxy.create',name:'proxy',target:ref('target'),handler:ref('handler')});
  return {controller,apply};
}
const restore=f=>restoreProxyStateV8(f.controller,f.controller.protocol.proxyCalls,PROTOCOL_MACHINE_API_V8);
function trap(f,operation,{name=operation+'Trap',functionKind='ordinary',lexicalReceiver=null}={}){
  f.apply({kind:'allocate',name,objectKind:'closure',length:null,properties:[],code:name,
    captures:[],functionKind,lexicalReceiver});
  const property=operation==='delete'?'deleteProperty':operation;
  f.apply({kind:'property.set',object:'handler',key:key(property),receiver:ref('handler'),value:ref(name),success:true});
  return name;
}

test('transparent Proxy has forwards own and inherited presence and delete removes only the target own property',()=>{
  const f=fixture();
  f.apply({kind:'proxy.has',object:'proxy',key:key('x'),result:['bool',true]});
  f.apply({kind:'proxy.has',object:'proxy',key:key('toString'),result:['bool',true]});
  f.apply({kind:'proxy.delete',object:'proxy',key:key('x'),success:true});
  f.apply({kind:'proxy.has',object:'proxy',key:key('x'),result:['bool',false]});
  f.apply({kind:'proxy.delete',object:'proxy',key:key('missing'),success:true});
  assert.equal(f.controller.heap.get('target').properties.has('x'),false);
  assert.equal(f.controller.heap.get('proxy').properties.size,0);
  assert.equal(restore(f).proxies,1);
});

test('Proxy has/delete trap calls use handler receiver, exact arguments, and Boolean ToBoolean results',()=>{
  const f=fixture();trap(f,'has');trap(f,'delete');
  f.apply({kind:'proxy.has.call',id:'has-call',object:'proxy',key:key('missing'),child:'hasTrapFrame'});
  assert.deepEqual(f.controller.receiver,ref('handler'));
  assert.deepEqual(f.controller.protocol.callFrames[0].arguments,[ref('target'),key('missing')]);
  assert.equal(restore(f).calls,1);
  f.apply({kind:'return',invocation:'hasTrapFrame',value:['str','']});
  f.apply({kind:'proxy.finish',id:'has-call',completion:{kind:'normal',value:['bool',false]}});
  assert.equal(restore(f).calls,0);

  f.apply({kind:'proxy.delete.call',id:'delete-call',object:'proxy',key:key('x'),child:'deleteTrapFrame',strict:false});
  assert.deepEqual(f.controller.receiver,ref('handler'));
  assert.deepEqual(f.controller.protocol.callFrames[0].arguments,[ref('target'),key('x')]);
  f.apply({kind:'return',invocation:'deleteTrapFrame',value:ref('target')});
  f.apply({kind:'proxy.finish',id:'delete-call',completion:{kind:'normal',value:['bool',true]}});
  assert.equal(f.controller.heap.get('target').properties.get('x')[1],2);
  assert.equal(restore(f).calls,0);
});

test('Proxy has invariant checking uses the live descriptor and extensibility after callback',()=>{
  for(const mode of ['nonconfigurable','nonextensible']){
    const f=fixture();trap(f,'has');
    if(mode==='nonconfigurable')f.apply({kind:'property.define',object:'target',key:key('x'),
      descriptor:{kind:'data',value:['num',2],writable:true,enumerable:true,configurable:false},success:true});
    else f.apply({kind:'property.preventExtensions',object:'target'});
    f.apply({kind:'proxy.has.call',id:'bad-has',object:'proxy',key:key('x'),child:'hasTrapFrame'});
    f.apply({kind:'return',invocation:'hasTrapFrame',value:['bool',false]});
    const before=structuredClone(f.controller);
    assert.throws(()=>f.apply({kind:'proxy.finish',id:'bad-has',completion:{kind:'normal',value:['bool',false]}}),
      /derived abrupt boundary/);
    assert.deepEqual(f.controller,before);
    f.apply({kind:'proxy.fault',id:'bad-has',error:'o90'});
    assert.deepEqual(f.controller.lastReturn,{kind:'throw',value:ref('o90')});
    assert.equal(f.controller.heap.get('o90').declaredError,'TypeError');
    assert.equal(f.controller.heap.get('o90').properties.get('message')[1],mode==='nonconfigurable'?
      "'has' on proxy: trap returned falsish for property 'x' which exists in the proxy target as non-configurable":
      "'has' on proxy: trap returned falsish for property 'x' but the proxy target is not extensible");
  }
  const allowed=fixture();trap(allowed,'has');
  allowed.apply({kind:'proxy.has.call',id:'false-has',object:'proxy',key:key('x'),child:'hasTrapFrame'});
  allowed.apply({kind:'return',invocation:'hasTrapFrame',value:['num',0]});
  allowed.apply({kind:'proxy.finish',id:'false-has',completion:{kind:'normal',value:['bool',false]}});
});

test('Proxy delete invariant rejects reporting a live own property deleted on a non-extensible target',()=>{
  const f=fixture();trap(f,'delete');
  f.apply({kind:'property.preventExtensions',object:'target'});
  f.apply({kind:'proxy.delete.call',id:'bad-delete',object:'proxy',key:key('x'),child:'deleteTrapFrame',strict:false});
  f.apply({kind:'return',invocation:'deleteTrapFrame',value:['bool',true]});
  const before=structuredClone(f.controller);
  assert.throws(()=>f.apply({kind:'proxy.finish',id:'bad-delete',completion:{kind:'normal',value:['bool',true]}}),
    /derived abrupt boundary/);
  assert.deepEqual(f.controller,before);
  f.apply({kind:'proxy.fault',id:'bad-delete',error:'o90'});
  assert.deepEqual(f.controller.lastReturn,{kind:'throw',value:ref('o90')});
  assert.equal(f.controller.heap.get('o90').properties.get('message')[1],
    "'deleteProperty' on proxy: trap returned truish for property 'x' but the proxy target is non-extensible");
});

test('Proxy finish cannot invent a fault-free callback result or conflate a child throw',()=>{
  const f=fixture();trap(f,'has');
  f.apply({kind:'proxy.has.call',id:'has-call',object:'proxy',key:key('missing'),child:'hasTrapFrame'});
  f.apply({kind:'return',invocation:'hasTrapFrame',value:['bool',true]});
  const before=structuredClone(f.controller);
  assert.throws(()=>f.apply({kind:'proxy.finish',id:'has-call',completion:{kind:'normal',value:['bool',false]}}),
    /false Proxy callback completion/);
  assert.throws(()=>f.apply({kind:'proxy.fault',id:'has-call',error:'o91'}),/not derived from the retained operation/);
  assert.deepEqual(f.controller,before);
  f.apply({kind:'proxy.finish',id:'has-call',completion:{kind:'normal',value:['bool',true]}});
  assert.equal(restore(f).calls,0);

  const thrown=fixture();trap(thrown,'delete');
  thrown.apply({kind:'proxy.delete.call',id:'delete-call',object:'proxy',key:key('missing'),child:'deleteTrapFrame',strict:false});
  thrown.apply({kind:'throw',invocation:'deleteTrapFrame',value:['str','boom']});
  thrown.apply({kind:'proxy.finish',id:'delete-call',completion:{kind:'throw',value:['str','boom']}});
  assert.equal(restore(thrown).calls,0);
});


test('Proxy fault derivation preserves frozen data SameValue and accessor invariants for get/set',()=>{
  const fixed=()=>{const f=fixture();f.apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'data',
    value:['num',0],writable:false,enumerable:true,configurable:false},success:true});return f;};
  const wrongGet=fixed();trap(wrongGet,'get');
  wrongGet.apply({kind:'proxy.get.call',id:'fixed-get',object:'proxy',key:key('x'),child:'getTrapFrame'});
  wrongGet.apply({kind:'return',invocation:'getTrapFrame',value:['num','-0']});
  assert.throws(()=>wrongGet.apply({kind:'proxy.finish',id:'fixed-get',completion:{kind:'normal',value:['num','-0']}}),
    /derived abrupt boundary/);
  wrongGet.apply({kind:'proxy.fault',id:'fixed-get',error:'o96'});
  assert.equal(wrongGet.controller.heap.get('o96').properties.get('message')[1],
    'Proxy get trap contradicted a non-configurable, non-writable target property');

  const matchingGet=fixed();trap(matchingGet,'get');
  matchingGet.apply({kind:'proxy.get.call',id:'matching-get',object:'proxy',key:key('x'),child:'getTrapFrame'});
  matchingGet.apply({kind:'return',invocation:'getTrapFrame',value:['num',0]});
  matchingGet.apply({kind:'proxy.finish',id:'matching-get',completion:{kind:'normal',value:['num',0]}});

  const wrongSet=fixed();trap(wrongSet,'set');
  wrongSet.apply({kind:'proxy.set.call',id:'fixed-set',object:'proxy',key:key('x'),value:['num','-0'],child:'setTrapFrame',strict:false});
  wrongSet.apply({kind:'return',invocation:'setTrapFrame',value:['bool',true]});
  assert.throws(()=>wrongSet.apply({kind:'proxy.finish',id:'fixed-set',completion:{kind:'normal',value:['num','-0']}}),
    /derived abrupt boundary/);
  wrongSet.apply({kind:'proxy.fault',id:'fixed-set',error:'o97'});
  assert.equal(wrongSet.controller.heap.get('o97').properties.get('message')[1],
    'Proxy set trap contradicted a non-configurable, non-writable target property');

  const accessor=()=>{const f=fixture();f.apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'accessor',
    get:['undefined'],set:['undefined'],enumerable:true,configurable:false},success:true});return f;};
  const badGet=accessor();trap(badGet,'get');
  badGet.apply({kind:'proxy.get.call',id:'accessor-get',object:'proxy',key:key('x'),child:'getTrapFrame'});
  badGet.apply({kind:'return',invocation:'getTrapFrame',value:['num',1]});
  badGet.apply({kind:'proxy.fault',id:'accessor-get',error:'o98'});
  assert.equal(badGet.controller.heap.get('o98').properties.get('message')[1],
    'Proxy get trap contradicted a non-configurable target accessor');

  const goodGet=accessor();trap(goodGet,'get');
  goodGet.apply({kind:'proxy.get.call',id:'undefined-get',object:'proxy',key:key('x'),child:'getTrapFrame'});
  goodGet.apply({kind:'return',invocation:'getTrapFrame',value:['undefined']});
  goodGet.apply({kind:'proxy.finish',id:'undefined-get',completion:{kind:'normal',value:['undefined']}});

  const badSet=accessor();trap(badSet,'set');
  badSet.apply({kind:'proxy.set.call',id:'accessor-set',object:'proxy',key:key('x'),value:['num',2],child:'setTrapFrame',strict:false});
  badSet.apply({kind:'return',invocation:'setTrapFrame',value:['bool',true]});
  badSet.apply({kind:'proxy.fault',id:'accessor-set',error:'o99'});
  assert.equal(badSet.controller.heap.get('o99').properties.get('message')[1],
    'Proxy set trap contradicted a non-configurable target accessor');
});

test('strict Proxy delete turns a false trap result into a fresh operation-derived TypeError',()=>{
  const f=fixture();trap(f,'delete');
  f.apply({kind:'proxy.delete.call',id:'strict-delete',object:'proxy',key:key('x'),child:'deleteTrapFrame',strict:true});
  f.apply({kind:'return',invocation:'deleteTrapFrame',value:['num',0]});
  const before=structuredClone(f.controller);
  assert.throws(()=>f.apply({kind:'proxy.finish',id:'strict-delete',completion:{kind:'normal',value:['bool',false]}}),
    /derived abrupt boundary/);
  assert.deepEqual(f.controller,before);
  f.apply({kind:'proxy.fault',id:'strict-delete',error:'o92'});
  assert.deepEqual(f.controller.lastReturn,{kind:'throw',value:ref('o92')});
  assert.equal(f.controller.heap.get('o92').declaredError,'TypeError');
  assert.equal(f.controller.heap.get('o92').properties.get('message')[1],
    "'deleteProperty' on proxy: trap returned falsish for property 'x'");
});


test('strict false Proxy set is a caller TypeError while sloppy false remains an assignment result',()=>{
  const strict=fixture();trap(strict,'set');
  strict.apply({kind:'proxy.set.call',id:'strict-set',object:'proxy',key:key('x'),value:['num',7],child:'setTrapFrame',strict:true});
  strict.apply({kind:'return',invocation:'setTrapFrame',value:['num',0]});
  assert.throws(()=>strict.apply({kind:'proxy.finish',id:'strict-set',completion:{kind:'normal',value:['num',7]}}),
    /derived abrupt boundary/);
  strict.apply({kind:'proxy.fault',id:'strict-set',error:'strictSetError'});
  assert.equal(strict.controller.heap.get('strictSetError').declaredError,'TypeError');
  assert.equal(strict.controller.heap.get('strictSetError').properties.get('message')[1],
    "'set' on proxy: trap returned falsish for property 'x'");

  const sloppy=fixture();trap(sloppy,'set');
  sloppy.apply({kind:'proxy.set.call',id:'sloppy-set',object:'proxy',key:key('x'),value:['num',7],child:'setTrapFrame',strict:false});
  sloppy.apply({kind:'return',invocation:'setTrapFrame',value:['bool',false]});
  sloppy.apply({kind:'proxy.finish',id:'sloppy-set',completion:{kind:'normal',value:['num',7]}});
});

test('direct Proxy strict delete fault requires absent trap and a live non-configurable target property',()=>{
  const f=fixture();
  assert.throws(()=>f.apply({kind:'proxy.delete.fault',object:'proxy',key:key('x'),error:'o93'}),
    /non-configurable target property/);
  f.apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'data',value:['num',2],
    writable:true,enumerable:true,configurable:false},success:true});
  f.apply({kind:'proxy.delete',object:'proxy',key:key('x'),success:false});
  f.apply({kind:'proxy.delete.fault',object:'proxy',key:key('x'),error:'o94'});
  assert.deepEqual(f.controller.lastReturn,{kind:'throw',value:ref('o94')});
  assert.equal(f.controller.heap.get('o94').properties.get('message')[1],
    "Cannot delete property 'x' of #<Object>");

  const nullPrototype=fixture();
  nullPrototype.apply({kind:'property.prototype',object:'target',prototype:null,success:true});
  nullPrototype.apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'data',value:['num',2],
    writable:true,enumerable:true,configurable:false},success:true});
  nullPrototype.apply({kind:'proxy.delete',object:'proxy',key:key('x'),success:false});
  nullPrototype.apply({kind:'proxy.delete.fault',object:'proxy',key:key('x'),error:'o96'});
  assert.equal(nullPrototype.controller.heap.get('o96').properties.get('message')[1],
    "Cannot delete property 'x' of [object Object]");

  const traptarget=fixture();
  traptarget.apply({kind:'property.define',object:'target',key:key('x'),descriptor:{kind:'data',value:['num',2],
    writable:true,enumerable:true,configurable:false},success:true});
  traptarget.apply({kind:'property.set',object:'handler',key:key('deleteProperty'),receiver:ref('handler'),
    value:['str','not callable'],success:true});
  assert.throws(()=>traptarget.apply({kind:'proxy.delete.fault',object:'proxy',key:key('x'),error:'o95'}),
    /absent trap/);
});
