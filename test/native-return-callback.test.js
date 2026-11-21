import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {ownedEffectfulOutcome} from '../src/semantic/source-projection.js';

const entry=text=>({text:'"use strict";'+text,functionName:'run'});
const outcome=bundle=>ownedEffectfulOutcome(bundle);
const scalar=(kind,value)=>({kind,graph:{roots:[['num',value]],objects:[]}});

test('native callback returns await original owned sync, async, and throwing closures',async()=>{
  for(const [body,kind,number] of [
    ['function(v){return v+2;}','return',6],
    ['function(v){throw v;}','throw',4],
    ['async function(v){return await Promise.resolve(v+3);}','return',7],
    ['function(v){return Promise.reject(v+1);}','throw',5]
  ]){
    const {bundle}=await executeWithNativeServices({
      entry:entry('function run(){return host.natlangCall("return",null,'+body+');}'),
      services:{'natlang.call':async({args})=>Reflect.apply(args[2],undefined,[4])}
    });
    assert.deepEqual(outcome(bundle),scalar(kind,number));
    const frame=Object.values(bundle.finalState.frames).find(f=>f.externalCallbackReturn);
    assert(frame);assert.equal(frame.externalCallbackReturn.id,'callbackreturn1');
    assert.equal(bundle.finalState.control.a0.status,'completed');
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
  }
});

test('native return callback snapshots receiver, arguments, aliases and cycles before yielding',async()=>{
  let result;
  const {bundle}=await executeWithNativeServices({
    entry:entry(`function run(){return host.natlangCall("graph",null,function(value,again){
      if(this!==value||again!==value||value.self!==value)throw 90;
      value.count=value.count+1;return {value:value,again:again};
    });}`),
    services:{'natlang.call':async({args})=>{
      const value={count:4};value.self=value;
      const waiting=Reflect.apply(args[2],value,[value,value]);
      value.count=100; // The already-captured arrival is immutable transport data.
      result=await waiting;
      assert.equal(result.value,result.again);assert.equal(result.value.self,result.value);
      return result.value.count;
    }}
  });
  assert.deepEqual(outcome(bundle),scalar('return',5));
  const arrival=bundle.events.find(e=>e.operation==='external.callback.enqueue');
  const job=arrival.stateChanges[0].after.queue.at(-1);
  assert.deepEqual(job.inputGraph.roots,[['ref','o0'],['ref','o0'],['ref','o0']]);
  assert.equal(replayExact(bundle).valid,true);
});

test('concurrent callback arrivals use FIFO capture cells and distinct return waiters',async()=>{
  const completions=[];
  const {bundle}=await executeWithNativeServices({
    entry:entry(`function run(){let total=0;return host.natlangCall("many",null,function(n){
      total=total*10+n;return total;
    });}`),
    services:{'natlang.call':async({args})=>{
      const first=Reflect.apply(args[2],undefined,[2]);
      const second=Reflect.apply(args[2],undefined,[3]);
      completions.push(...await Promise.all([first,second]));return completions[1];
    }}
  });
  assert.deepEqual(completions,[2,23]);assert.deepEqual(outcome(bundle),scalar('return',23));
  const ids=Object.values(bundle.finalState.frames).flatMap(f=>f.externalCallbackReturn?[f.externalCallbackReturn.id]:[]);
  assert.deepEqual(ids,['callbackreturn1','callbackreturn2']);
});

test('repeated owned callback handles retain one native trampoline identity',async()=>{
  const {bundle}=await executeWithNativeServices({
    entry:entry('function run(){const fn=function(v){return v+1;};'+
      'return host.natlangCall("identity",null,{first:fn,second:fn});}'),
    services:{'natlang.call':({args})=>{
      assert.equal(args[2].first,args[2].second);
      return Reflect.apply(args[2].second,undefined,[8]);
    }}
  });
  assert.deepEqual(outcome(bundle),scalar('return',9));
});

test('callback child may await another host request and callback before returning to its parent',async()=>{
  const calls=[];
  const {bundle}=await executeWithNativeServices({
    entry:entry(`function run(){return host.natlangCall("outer",null,async function(n){
      return n+await host.natlangCall("inner",null,function(v){return v*2;});
    });}`),
    services:{'natlang.call':async({args})=>{
      calls.push(args[0]);return Reflect.apply(args[2],undefined,[args[0]==='outer'?3:5]);
    }}
  });
  assert.deepEqual(calls,['outer','inner']);assert.deepEqual(outcome(bundle),scalar('return',13));
  assert.equal(Object.values(bundle.finalState.frames).filter(f=>f.externalCallbackReturn).length,2);
  assert.equal(replayExact(bundle).valid,true);
});

test('return callback authority, stable identity and graph validation refuse without committing',()=>{
  const runtime=createRuntime();
  const source=runtime.registerSource({text:entry(`function run(){
    return host.natlangCall("cap",null,function(v){return v;});}`).text,trainingProfile:true});
  runtime.startEntry({source,functionName:'run',allowAsync:true,allowHost:true});runtime.drive();
  const effect=Object.values(runtime.state.effects)[0],callbackId=effect.args[2][1];
  const valid={effectId:effect.id,callbackId,returnId:'return1',inputGraph:encodeNativeGraph([undefined,4])};
  for(const invalid of [
    {...valid,callbackId:'o999'},
    {...valid,inputGraph:{schema:'owned-graph/1',roots:[['undefined'],['ref','missing']],objects:[]}},
    {...valid,returnId:'bad identity'}
  ]){
    const prior=structuredClone(runtime.state),count=runtime.events.length;
    assert.throws(()=>runtime.recordExternalCallback(invalid));
    assert.deepEqual(runtime.state,prior);assert.equal(runtime.events.length,count);
  }
  runtime.recordExternalCallback(valid);
  const prior=structuredClone(runtime.state),count=runtime.events.length;
  assert.throws(()=>runtime.recordExternalCallback(valid),/Duplicate callback return identity/);
  assert.deepEqual(runtime.state,prior);assert.equal(runtime.events.length,count);
});

test('read-only validation refuses a changed callback graph and receiver mapping',async()=>{
  const {bundle}=await executeWithNativeServices({
    entry:entry('function run(){return host.natlangCall("check",null,function(v){return this===v?4:9;});}'),
    services:{'natlang.call':({args})=>{const value={};return Reflect.apply(args[2],value,[value]);}}
  });
  for(const mutate of [
    copy=>{const job=copy.events.find(e=>e.operation==='external.callback.enqueue').stateChanges[0].after.queue.at(-1);
      job.inputGraph.roots[1]=['ref','unknown'];},
    copy=>{const event=copy.events.find(e=>e.operation==='job.enter'&&e.causes.some(c=>c.kind==='effect'));
      event.stateChanges.find(p=>p.table==='frames').after.thisValue=['undefined'];}
  ]){
    const changed=structuredClone(bundle);mutate(changed);assert.throws(()=>validateBundle(changed));
  }
});
