import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {replayExact,validateBundle} from 'tracing-js-self';

class EvalFailure extends Error {
  constructor(message,events,debug) {
    super(message);
    this.events=events;
    this.debug=debug;
  }
}
const request=(code,extra={})=>({
  code,body:true,scope:{},path:'natlang://integrity.ts',...extra
});

test('synchronous onTrace closure blocks live-data commit and success',()=>{
  const live={counter:{n:1}};
  let env;
  env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:()=>env.close()});
  assert.throws(()=>env.execute(request(
    '__live.counter.n+=4;return __live.counter.n;', {live})),
    error=>error instanceof EvalFailure && /closed/.test(error.message));
  assert.equal(live.counter.n,1);
  assert.equal(env.closed,true);
});

test('asynchronous native onTrace closure blocks live-data commit and success',async()=>{
  const live={counter:{n:1}};
  let env;
  env=createBoundedNatlangEnvironment({EvalFailure,
    services:{'demo.readAsync':async()=>4},
    onTrace:()=>env.close()});
  await assert.rejects(env.executeAsync(request(
    "__live.counter.n+=await host.readAsync('key');return __live.counter.n;",
    {live})),
    error=>error instanceof EvalFailure && /closed/.test(error.message));
  assert.equal(live.counter.n,1);
});

test('synchronous callback cannot reenter owned execution, outer run still commits',()=>{
  const live={counter:{n:3}};
  let env,observed=0;
  env=createBoundedNatlangEnvironment({EvalFailure,onTrace:bundle=>{
    observed++;
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
    assert.throws(()=>env.execute(request('return 900;')),
      error=>error instanceof EvalFailure && /[Rr]eentrant/.test(error.message));
    // Consumer mutation of its own callback copy is not authoritative.
    bundle.finalState.control.a0.completion={forged:true};
  }});
  assert.equal(env.execute(request('__live.counter.n+=2;return __live.counter.n;', {live})).result,5);
  assert.equal(live.counter.n,5);
  assert.equal(env.execute(request('return 7;')).result,7);
  assert.equal(observed,2);
  env.close();
});

test('pending native service blocks another call and releases on completion',async()=>{
  let release,dispatches=0,signalDispatch;
  const dispatched=new Promise(resolve=>{signalDispatch=resolve;});
  const env=createBoundedNatlangEnvironment({EvalFailure,
    services:{'demo.readAsync':()=>{dispatches++;signalDispatch();return new Promise(resolve=>{release=resolve;});}}});
  try{
    const first=env.executeAsync(request("return await host.readAsync('key');"));
    // Native service dispatch happens asynchronously after bounded owned compilation.
    await dispatched;
    assert.equal(dispatches,1);
    assert.throws(()=>env.execute(request('return 5;')),
      error=>error instanceof EvalFailure && /[Oo]verlapping/.test(error.message));
    await assert.rejects(env.executeAsync(request('return 6;')),
      error=>error instanceof EvalFailure && /[Oo]verlapping/.test(error.message));
    release(8);
    assert.equal((await first).result,8);
    assert.equal(env.execute(request('return 9;')).result,9);
  }finally{env.close();}
});

test('retained CommonJS export callbacks cannot reenter the same module realm',()=>{
  let env,exports;
  env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:bundle=>{
      assert.equal(replayExact(bundle).valid,true);
      assert.throws(()=>exports.read(),
        error=>error instanceof EvalFailure && /[Rr]eentrant/.test(error.message));
    }});
  exports={};
  const module={exports};
  const code='exports.add=add;exports.read=read;'+
    'let n=1;function add(v){n+=v;return n;}function read(){return n;}';
  try{
    env.evaluateModule(code,{module,exports,require:()=>{throw Error('unowned require');}});
    assert.equal(exports.add(3),4);
    assert.equal(exports.add(2),6);
  }finally{env.close();}
});

test('failing synchronous trace callback rolls back a live mutation',()=>{
  const live={counter:{n:2}};
  const env=createBoundedNatlangEnvironment({EvalFailure,onTrace:()=>Promise.resolve()});
  try{
    assert.throws(()=>env.execute(request(
      '__live.counter.n+=5;return __live.counter.n;', {live})),EvalFailure);
    assert.equal(live.counter.n,2);
  }finally{env.close();}
});

test('direct CommonJS installation is retained-only and cannot reenter a trace callback',()=>{
  const code='exports.read=read;function read(){return 4;}';
  const fresh=createBoundedNatlangEnvironment({EvalFailure});
  const first={},firstModule={exports:first};
  assert.throws(()=>fresh.evaluatePureCommonJsModule(code,{module:firstModule,exports:first}),
    /retained mode/);
  fresh.close();

  let env,exports;
  env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:()=>{
      const nestedExports={},nestedModule={exports:nestedExports};
      assert.throws(()=>env.evaluatePureCommonJsModule(code,{
        module:nestedModule,exports:nestedExports
      }),/[Rr]eentrant/);
      assert.throws(()=>env.evaluateModule(code,{
        module:nestedModule,exports:nestedExports,require:()=>{}
      }),error=>error instanceof EvalFailure && /[Rr]eentrant/.test(error.message));
      assert.deepEqual(nestedExports,{});
    }});
  exports={};
  const module={exports};
  try{
    env.evaluateModule(code,{module,exports,require:()=>{}});
    assert.equal(exports.read(),4);
  }finally{env.close();}
});
