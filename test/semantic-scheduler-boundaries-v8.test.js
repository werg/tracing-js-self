import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticController} from '../src/training/controller.js';
import {encodeWitness} from '../src/training/format.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const source='"use strict";function run(){}function callback(value){}';
function fresh(){
  const h=new RegionExecutionHarness({sessionId:'scheduler'});
  h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'t',realmId:'r',triggerId:'entry',args:[]});
  return h;
}
const step=(h,kind,fields)=>h.select('root',{kind,fields});
const create=(h,promise)=>step(h,'promise',{action:'create',promise});
const commit=(c,kind,fields)=>c.commit(encodeWitness(kind,fields));

test('bare v8 adoption cannot invent settlement or queue order before assimilation jobs',()=>{
  for(const settled of [false,true])for(const action of ['adopt','resolve']){
    const h=fresh();for(const id of ['source','adopter'])create(h,id);
    step(h,'promise',{action:'react',promise:'adopter',job:'early',reaction:'then'});
    step(h,'promise',{action:'react',promise:'source',job:'direct',reaction:'then'});
    if(settled)step(h,'promise',{action:'resolve',promise:'source',value:['num',7]});
    const before=h.checkpoint();
    assert.throws(()=>step(h,'promise',{action,promise:'adopter',
      ...(action==='adopt'?{target:'source'}:{value:['ref','source']})}),/assimilation jobs/);
    assert.deepEqual(h.checkpoint(),before);
    assert.deepEqual(RegionExecutionHarness.restore(before).checkpoint(),before);
  }
});

test('controller adoption locks and Promise target requirements survive restored state',()=>{
  const h=fresh(),c=h.controller;for(const id of ['left','right'])create(h,id);
  // This legacy controller operation is deliberately not a v8 admission.
  commit(c,'promise',{action:'adopt',promise:'left',target:'right'});
  const restored=SemanticController.fromPacket(JSON.parse(JSON.stringify(c.segmentPacket())));
  for(const current of [c,restored])for(const action of ['resolve','reject','adopt']){
    const before=current.segmentPacket();
    assert.throws(()=>commit(current,'promise',{action,promise:'left',
      ...(action==='adopt'?{target:'right'}:{value:['num',1]})}),/settled or adopting/);
    assert.deepEqual(current.segmentPacket(),before);
  }
  const plain=fresh();create(plain,'p1');
  step(plain,'allocate',{name:'ordinary',kind:'object',properties:[]});
  const before=plain.checkpoint();
  assert.throws(()=>step(plain,'promise',{action:'adopt',promise:'p1',target:'ordinary'}),/Unknown owned Promise/);
  assert.deepEqual(plain.checkpoint(),before);
  step(plain,'promise',{action:'resolve',promise:'p1',value:['ref','ordinary']});
  create(plain,'p2');step(plain,'promise',{action:'reject',promise:'p2',value:['ref','p1']});
  assert.deepEqual(plain.controller.promise('p2').result,['ref','p1']);
});

test('generator and resolver closures cannot enter ordinary scheduler callback frames',()=>{
  for(const metadata of [{generatorFunction:true},{promiseResolver:{promise:'source',mode:'resolve'}}]){
    for(const route of ['closure','rejectionClosure','enqueue','dispatch']){
      const h=fresh();create(h,'source');
      step(h,'allocate',{name:'cb',kind:'closure',code:'callback',properties:[],captures:[]});
      if(route==='dispatch'){
        step(h,'promise',{action:'react',promise:'source',job:'reaction',reaction:'then',closure:'cb'});
        step(h,'promise',{action:'resolve',promise:'source',value:['num',1]});
        step(h,'return',{value:['num',0]});
      }
      Object.assign(h.controller.heap.get('cb'),metadata);
      const before=sharedRegionState(h.controller);
      assert.throws(()=>{
        if(route==='enqueue')step(h,'job',{action:'enqueue',job:'reaction',owner:'root',closure:'cb'});
        else if(route==='dispatch')step(h,'job',{action:'dispatch',job:'reaction',owner:'root'});
        else step(h,'promise',{action:'react',promise:'source',job:'reaction',reaction:'then',[route]:'cb'});
      },/explicit call protocol/);
      assert.deepEqual(sharedRegionState(h.controller),before);
    }
  }
});

function reaction(reaction,value,completion='return'){
  const h=fresh();for(const id of ['source','cleanup'])create(h,id);
  step(h,'allocate',{name:'cb',kind:'closure',code:'callback',properties:[],captures:[]});
  step(h,'promise',{action:'react',promise:'source',job:'reaction',reaction,closure:'cb',target:'result'});
  step(h,'promise',{action:'resolve',promise:'source',value:['num',1]});
  step(h,'await',{invocation:'root',promise:'result',continuation:'resume'});
  step(h,'job',{action:'dispatch',job:'reaction',owner:'root'});
  step(h,completion,{invocation:'job:reaction',value});
  return h;
}
test('reaction adoption and normal finally returns require explicit jobs before settlement',()=>{
  for(const [kind,value]of [['then',['ref','cleanup']],['finally',['ref','cleanup']],
    ['finally',['num',7]],['finally',['undefined']]]){
    const h=reaction(kind,value),before=h.checkpoint();
    assert.throws(()=>step(h,'job',{action:'complete',job:'reaction',owner:'root'}),/explicit.*jobs/);
    assert.deepEqual(h.checkpoint(),before);
  }
  const thrown=reaction('finally',['str','cleanup failed'],'throw');
  step(thrown,'job',{action:'complete',job:'reaction',owner:'root'});
  assert.equal(thrown.controller.promise('result').state,'rejected');
  assert.deepEqual(thrown.controller.promise('result').result,['str','cleanup failed']);
});

test('native Promise adoption and finally have observable jobs beyond direct settlement',async()=>{
  const adopted=[];let settle;
  const target=new Promise(resolve=>{settle=resolve;}),outer=new Promise(resolve=>resolve(target));
  outer.then(()=>adopted.push('adopted'));target.then(()=>adopted.push('direct'));
  settle(7);queueMicrotask(()=>adopted.push('queued'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(adopted,['direct','queued','adopted']);
  for(const cleanup of [()=>7,()=>undefined,()=>Promise.resolve(7)]){
    const order=[];Promise.resolve(1).finally(cleanup).then(()=>order.push('finally-result'));
    queueMicrotask(()=>{order.push('first');queueMicrotask(()=>order.push('nested'));});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(order,['first','nested','finally-result']);
  }
});
