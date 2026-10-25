import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileExternalEffectsJS,compilePendingEffectJS,createOwnedEffectBridge}
  from '../src/effect-javascript.js';

function archive(source){
  const run=createRuntime({adapters:{
    'demo.store':()=>({kind:'normal',value:undefined}),
    'demo.readNumber':()=>({kind:'normal',value:3})
  }}).start(source);
  assert.equal(run.drive().kind,'terminated');
  return run.exportRun();
}

test('compiled external JS replays dispatch order and materialized snapshots',()=>{
  const bundle=archive('let o={n:2};host.store("a",o);o.n=9;host.store("b",o);');
  const javascript=compileExternalEffectsJS(bundle);
  const calls=[];
  new Function('effects',javascript)({'demo.store':(...args)=>calls.push(args)});
  assert.deepEqual(calls,[['a',{n:2}],['b',{n:9}]]);
});

test('missing handler fails before any external replay',()=>{
  const code=compileExternalEffectsJS(archive('host.store("a",1);host.readNumber("k");'));
  const calls=[];
  assert.throws(()=>new Function('effects',code)({
    'demo.store':(...args)=>calls.push(args)
  }),/Missing effect handler/);
  assert.deepEqual(calls,[]);
});

test('live generated effect JavaScript resolves an async native result into owned VM',async()=>{
  const runtime=createRuntime().start('let v=host.readAsync("A");');
  const pending=runtime.drive();
  assert.equal(pending.kind,'waiting');
  const fx=Object.values(runtime.state.effects)[0];
  assert.equal(fx.dispatch,'dispatched');
  const js=compilePendingEffectJS(runtime,fx.id);
  const bridge=createOwnedEffectBridge(runtime);
  new Function('effects','bridge',js)({
    'demo.readAsync':async key=>{assert.equal(key,'A');return 12;}
  },bridge);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runtime.state.effects[fx.id].external,'completed');
  assert.throws(()=>bridge.settle(fx.id,13),/duplicate settlement/);
  assert.equal(runtime.drive().kind,'terminated');
});

test('live generated effect JavaScript sends rejection back through owned input',async()=>{
  const runtime=createRuntime().start('host.readAsync("A");');
  assert.equal(runtime.drive().kind,'waiting');
  const fx=Object.values(runtime.state.effects)[0],bridge=createOwnedEffectBridge(runtime);
  new Function('effects','bridge',compilePendingEffectJS(runtime,fx.id))({
    'demo.readAsync':()=>Promise.reject(new Error('network failed'))
  },bridge);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runtime.state.effects[fx.id].external,'rejected');
  assert.equal(runtime.state.inputs[fx.inputIds[0]].abrupt,true);
});
