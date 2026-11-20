import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';
import {assertPlainPromiseResolutionV8} from '../src/semantic/scheduler-boundaries-v8.js';

const source='"use strict";function run(){}function callback(value){}';
const ref=id=>['ref',id];
function fresh(text=source,capabilities=[]){
  const h=new RegionExecutionHarness({sessionId:'resolution',automaticDelivery:false});
  h.publishProgram({programId:'p',source:text,entry:'run',capabilities});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'t',realmId:'r',triggerId:'entry',args:[]});
  return h;
}
const step=(h,kind,fields)=>h.select('root',{kind,fields});
const create=(h,promise)=>step(h,'promise',{action:'create',promise});
const allocate=(h,name,kind='object',properties=[])=>step(h,'allocate',{name,kind,properties,
  ...(kind==='array'?{length:0}:kind==='closure'?{code:'callback',captures:[]}:{})});
const protocol=(h,record)=>h.select('root',record);
const resolve=(h,value)=>step(h,'promise',{action:'resolve',promise:'result',value});

test('Promise resolution refuses own and inherited callable then or accessors before any mutation',()=>{
  for(const inherited of [false,true])for(const accessor of [false,true]){
    const h=fresh();create(h,'result');allocate(h,'value');allocate(h,'parent');allocate(h,'callback','closure');
    const object=inherited?'parent':'value';
    protocol(h,{kind:'property.define',object,key:['str','then'],success:true,
      descriptor:accessor?{kind:'accessor',get:ref('callback'),set:['undefined'],enumerable:false,configurable:true}:
        {kind:'data',value:ref('callback'),writable:true,enumerable:false,configurable:true}});
    if(inherited)protocol(h,{kind:'property.prototype',object:'value',prototype:ref('parent'),success:true});
    const before=h.checkpoint();
    assert.throws(()=>resolve(h,ref('value')),/then.*(?:getter|assimilation jobs)/i);
    assert.deepEqual(h.checkpoint(),before);
    assert.deepEqual(RegionExecutionHarness.restore(before).checkpoint(),before);
  }
});

test('plain reference fulfillment preserves arrays, closures, noncallable then and own-property shadowing',()=>{
  for(const kind of ['object','array','closure'])for(const method of [null,['num',0],ref('data')]){
    const h=fresh();create(h,'result');allocate(h,'data');
    allocate(h,'value',kind,method?[{key:'then',value:method}]:[]);
    resolve(h,ref('value'));
    assert.deepEqual(h.controller.promise('result').result,ref('value'));
    assert.equal(h.controller.protocol,undefined,'descriptor proof must not activate another protocol');
  }
  const h=fresh();create(h,'result');allocate(h,'value');allocate(h,'parent');allocate(h,'callback','closure');
  protocol(h,{kind:'property.define',object:'parent',key:['str','then'],success:true,
    descriptor:{kind:'accessor',get:ref('callback'),set:['undefined'],enumerable:true,configurable:true}});
  protocol(h,{kind:'property.prototype',object:'value',prototype:ref('parent'),success:true});
  protocol(h,{kind:'property.define',object:'value',key:['str','then'],success:true,
    descriptor:{kind:'data',value:['undefined'],writable:true,enumerable:true,configurable:true}});
  resolve(h,ref('value'));
  assert.deepEqual(h.controller.promise('result').result,ref('value'));
});

test('Proxy resolution and unknown intrinsic chains cannot stand in for a data then lookup',()=>{
  const h=fresh();create(h,'result');allocate(h,'target');allocate(h,'handler');
  protocol(h,{kind:'proxy.create',name:'proxy',target:ref('target'),handler:ref('handler')});
  const before=h.checkpoint();
  assert.throws(()=>resolve(h,ref('proxy')),/ordinary object/);
  assert.deepEqual(h.checkpoint(),before);
  const controller={heap:new Map([['value',{kind:'object',prototype:'Unknown.prototype',properties:new Map()}]])};
  const saved=structuredClone(controller);
  assert.throws(()=>assertPlainPromiseResolutionV8(controller,ref('value')),/value|prototype|reference/);
  assert.deepEqual(controller,saved);
});

test('reaction result and changed pass-through values receive the same thenable guard',()=>{
  for(const callback of [true,false]){
    const h=fresh();create(h,'source');allocate(h,'callback','closure');allocate(h,'value');
    step(h,'promise',{action:'resolve',promise:'source',value:ref('value')});
    step(h,'promise',{action:'react',promise:'source',job:'reaction',reaction:'then',target:'result',
      ...(callback?{closure:'callback'}:{})});
    step(h,'write',{object:'value',key:'then',value:ref('callback'),present:true});
    step(h,'await',{invocation:'root',promise:'result',continuation:'resume'});
    step(h,'job',{action:'dispatch',job:'reaction',owner:'root'});
    if(callback)step(h,'return',{invocation:'job:reaction',value:ref('value')});
    const before=h.checkpoint();
    assert.throws(()=>step(h,'job',{action:'complete',job:'reaction',owner:'root'}),/assimilation jobs/);
    assert.deepEqual(h.checkpoint(),before);
  }
});

function external(){
  const h=fresh('"use strict";function run(){return host.natlangCall("x",null,null);}function callback(value){}',['natlang.call']);
  create(h,'existing');allocate(h,'callback','closure');allocate(h,'thenable','object',[{key:'then',value:ref('callback')}]);
  const [site]=h.controller.callSites.keys(),[start,end]=site.split(':').map(Number),args=[['str','x'],['null'],['null']];
  step(h,'request',{effect:'effect',operation:'natlang.call',invocation:'root',site:{start,end},arguments:args,
    payload:JSON.stringify({schema:'owned-graph/1',roots:args,objects:[]}),promise:'external'});
  h.importObserved({mode:'observed',kind:'dispatch',fields:{session:'resolution',track:'t',invocationId:'root',
    effectId:'effect',key:'root/effect',attempt:1}});
  return h;
}
function observation(h,route,{status='fulfilled',result,graph}){
  if(route==='deliver')return h.deliverResult('root','effect',{status,result,graph});
  if(route==='reconcile')return h.reconcile('root','effect',{disposition:status,evidenceId:'receipt',result,graph});
  return h.importObserved({mode:'observed',kind:'result',fields:{session:'resolution',track:'t',invocationId:'root',
    effectId:'effect',status,result,errorOrigin:null,line:encodeDetailedRecord({kind:'observe',
      fields:{effect:'effect',status,result,...(graph?{graph}:{})}},{role:'observed'})}});
}

test('observed and explicit existing-reference fulfillment cannot bypass Promise resolution atomically',()=>{
  for(const route of ['import','deliver','reconcile'])for(const identity of ['existing','thenable']){
    let h=external();
    if(route==='reconcile')h=RegionExecutionHarness.restore(h.checkpoint());
    const before=h.checkpoint();
    assert.throws(()=>observation(h,route,{result:ref(identity)}),/assimilation jobs/);
    assert.deepEqual(h.checkpoint(),before);
  }
});

test('fresh observed data graphs and opaque Promise rejection reasons remain supported',()=>{
  for(const route of ['import','deliver','reconcile']){
    let h=external();if(route==='reconcile')h=RegionExecutionHarness.restore(h.checkpoint());
    const graph={roots:[ref('fresh')],objects:[{id:'fresh',kind:'object',properties:[{key:'then',value:ref('data')}]},
      {id:'data',kind:'object',properties:[]}]};
    observation(h,route,{result:ref('fresh'),graph});
    assert.equal(h.controller.promise('external').state,'fulfilled');
    assert.deepEqual(h.controller.promise('external').result,ref('fresh'));
    h=external();if(route==='reconcile')h=RegionExecutionHarness.restore(h.checkpoint());
    observation(h,route,{status:'rejected',result:ref('existing')});
    assert.equal(h.controller.promise('external').state,'rejected');
    assert.deepEqual(h.controller.promise('external').result,ref('existing'));
  }
});

test('fresh-graph exemption still validates graph identities and property values before mutation',()=>{
  for(const route of ['import','deliver']){
    const h=external(),before=h.checkpoint();
    const graph={roots:[ref('fresh')],objects:[{id:'fresh',kind:'object',properties:[{key:'then',value:ref('callback')}]}]};
    assert.throws(()=>observation(h,route,{result:ref('fresh'),graph}),/dangling graph reference/);
    assert.deepEqual(h.checkpoint(),before);
  }
});

test('native thenable resolution calls then in its own FIFO job and adopts its result',async()=>{
  const order=[],value={then(resolve){order.push('then');resolve(7);}};
  new Promise(resolve=>resolve(value)).then(result=>order.push('value '+result));
  order.push('after resolve');queueMicrotask(()=>order.push('queued'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,['after resolve','then','queued','value 7']);
});
