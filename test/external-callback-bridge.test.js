import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {compileExternalEffectsJS,compilePendingEffectJS,
  createOwnedEffectBridge} from '../src/effect-javascript.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

test('native callback goes back into owned closure before external Promise resolves',async()=>{
  const messages=[];
  const {progress,bundle}=await executeWithNativeServices({
    text:`async function run(){
      let v=1;
      await host.withCallback("change",function(n){v=n;});
      host.store("result",v);
    } run();`,
    services:{
      'demo.withCallback':({args})=>{
        assert.equal(args[0],'change');
        assert.equal(typeof args[1],'function');
        assert.equal(args[1](7),undefined);
        return Promise.resolve('finished');
      },
      'demo.store':({args})=>{messages.push(args);}
    }
  });
  assert.equal(progress.kind,'terminated');
  assert.deepEqual(messages,[['result',7]]);
  const callback=bundle.events.find(e=>e.operation==='external.callback.enqueue');
  assert(callback);
  const job=bundle.events.find(e=>e.operation==='job.enter'&&
    e.causes.some(c=>c.kind==='effect'));
  assert(job);
  assert(bundle.events.indexOf(callback)<bundle.events.indexOf(job));
  const resolved=bundle.events.find(e=>e.operation==='external.input.deliver'&&
    e.causes.some(c=>c.kind==='effect'&&
      bundle.effects[c.effectId]?.operation==='demo.withCallback'));
  assert(resolved);
  assert(bundle.events.indexOf(job)<bundle.events.indexOf(resolved));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);

  // This code contains *actual external JS calls*, not interpreter steps.
  const emitted=compileExternalEffectsJS(bundle);
  assert.match(emitted,/bridge.callback/);
  const replayed=[],registered=[];
  new Function('effects','bridge',emitted)({
    'demo.withCallback':(key,cb)=>{replayed.push(key);cb(11);},
    'demo.store':(...args)=>replayed.push(args)
  },{
    callback:(effectId,callbackId)=>{
      registered.push({effectId,callbackId});
      return (...args)=>registered.push({args});
    }
  });
  assert.deepEqual(replayed,['change',['result',7]]);
  assert.equal(registered.length,2);
});

test('multiple callbacks preserve FIFO and never execute guest function natively',async()=>{
  const received=[];
  const {bundle}=await executeWithNativeServices({
    text:`async function run(){
      let v=0;
      await host.withCallback("two",function(n){v=v*10+n;});
      host.store("accumulated",v);
    }run();`,
    services:{
      'demo.withCallback':({args})=>{
        args[1](2);args[1](3);
        return Promise.resolve(undefined);
      },
      'demo.store':({args})=>received.push(args)
    }
  });
  assert.deepEqual(received,[['accumulated',23]]);
  assert.equal(bundle.events.filter(e=>e.operation==='external.callback.enqueue').length,2);
  assert.equal(replayExact(bundle).valid,true);
});

test('native callback objects are refused rather than crossing owned data boundary',async()=>{
  const received=[];
  const {bundle}=await executeWithNativeServices({
    text:`async function run(){
      try{await host.withCallback("bad",function(x){return x;});}
      catch(e){host.store("error",e);}
    }run();`,
    services:{
      'demo.withCallback':({args})=>{args[1]({nativeEvent:true});},
      'demo.store':({args})=>received.push(args)
    }
  });
  assert.equal(received.length,1);
  assert.equal(received[0][0],'error');
  assert.match(received[0][1],/primitive arguments/);
  assert.equal(bundle.events.filter(e=>e.operation==='external.callback.enqueue').length,0);
  assert.equal(replayExact(bundle).valid,true);
});

test('manual generated effect bridge routes callback and promise result through owned state',async()=>{
  const runtime=createRuntime().start(`async function run(){
    let n=0;
    await host.withCallback("update",function(x){n=x;});
    host.store("value",n);
  }run();`);
  assert.equal(runtime.drive().kind,'waiting');
  const fx=Object.values(runtime.state.effects).find(e=>e.operation==='demo.withCallback');
  assert(fx);
  const generated=compilePendingEffectJS(runtime,fx.id);
  const bridge=createOwnedEffectBridge(runtime);
  new Function('effects','bridge',generated)({
    'demo.withCallback':(key,callback)=>{callback(9);return Promise.resolve(1);}
  },bridge);
  await new Promise(resolve=>setImmediate(resolve));
  // The bridge commits an actual owned callback job instead of calling it.
  assert(runtime.events.some(e=>e.operation==='external.callback.enqueue'));
  assert.equal(runtime.drive().kind,'waiting');
  const store=Object.values(runtime.state.effects).find(e=>e.operation==='demo.store');
  assert(store);
  assert.equal(store.request.payload,'["value",9]');
  assert.equal(runtime.state.effects[fx.id].external,'completed');
  assert.throws(()=>bridge.settle(fx.id,99),/duplicate settlement/);
});

test('invalid or stale callback capability cannot forge an owned invocation',async()=>{
  const runtime=createRuntime().start(`async function run(){
    await host.withCallback("cap",function(n){return n;});
  }run();`);
  assert.equal(runtime.drive().kind,'waiting');
  const fx=Object.values(runtime.state.effects).find(e=>e.operation==='demo.withCallback');
  const bridge=createOwnedEffectBridge(runtime);
  const before=runtime.events.length;
  assert.throws(()=>bridge.callback(fx.id,'o999')(2),/not passed by this guest invocation/);
  assert.equal(runtime.events.length,before);
  const native=new Function('effects','bridge',compilePendingEffectJS(runtime,fx.id));
  const pending=[];
  native({'demo.withCallback':(key,fn)=>{pending.push(fn);return Promise.resolve(0);}},bridge);
  await new Promise(resolve=>setImmediate(resolve));
  assert.throws(()=>pending[0](4),/Callback requires an outstanding dispatched effect/);
});
