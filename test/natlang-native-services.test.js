import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
test('natlang async strict guest awaits out-of-order native inputs with replay',async()=>{
  const calls=[],traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>traces.push(bundle),
    services:{
      'demo.readAsync':({args})=>{
        calls.push(args[0]);
        return args[0]==='slow'?
          new Promise(resolve=>setTimeout(()=>resolve(11),12)):
          Promise.resolve(7);
      }
    }
  });
  const result=await env.executeAsync({
    code:"const slow=host.readAsync('slow'); const fast=host.readAsync('fast');"+
      "return await slow + await fast + self.offset;",
    scope:{offset:3},body:true,path:'natlang://native-async.ts'
  });
  assert.equal(result.result,21);
  assert.equal(result.events[0].nativeServices,true);
  assert.deepEqual(calls,['slow','fast']);
  assert.equal(traces.length,1);
  const bundle=traces[0];
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  const arrival=bundle.events.filter(e=>e.operation==='external.input.arrive');
  assert.equal(arrival.length,2);
  const effects=Object.values(bundle.effects).filter(e=>e.operation==='demo.readAsync');
  assert.equal(arrival[0].causes.find(c=>c.kind==='effect').effectId,effects[1].id);
});

test('native async guest mutation is committed only after replay-verified completion',async()=>{
  const traces=[],counter={value:1};
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>traces.push(bundle),
    services:{'demo.readAsync':async()=>4}});
  const value=await env.executeAsync({
    code:"__live.counter.value+=await host.readAsync('k');return __live.counter;",
    body:true,scope:{},live:{counter},path:'natlang://native-live.ts'
  });
  assert.equal(value.result,counter);
  assert.equal(counter.value,5);
  assert.equal(replayExact(traces[0]).valid,true);
});

test('failed native service completion can be caught entirely inside the owned guest',async()=>{
  let calls=0;
  const env=createBoundedNatlangEnvironment({EvalFailure,
    services:{'demo.readAsync':()=>{calls++;return Promise.reject(new Error('service refused'));}}});
  const result=await env.executeAsync({
    code:"try {await host.readAsync('bad');return 1;}catch(e){return e;}",
    body:true,scope:{},path:'natlang://native-reject.ts'
  });
  assert.equal(result.result,'service refused');
  assert.equal(calls,1);
});

test('unregistered native helper calls fail closed and do not emit success',async()=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    services:{'demo.readAsync':async()=>4},onTrace:bundle=>traces.push(bundle)});
  await assert.rejects(env.executeAsync({
    code:"return host.unknown('secret');",body:true,scope:{},path:'natlang://unsupported.ts'
  }),EvalFailure);
  assert.equal(traces.length,0);
});

test('closing the evaluator aborts outstanding native waits without a success archive',async()=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    services:{'demo.readAsync':()=>new Promise(()=>{})},
    onTrace:bundle=>traces.push(bundle)});
  const run=env.executeAsync({
    code:"return await host.readAsync('never');",
    body:true,scope:{},path:'natlang://cancelled.ts'
  });
  env.close();
  await assert.rejects(run,error=>error instanceof EvalFailure &&
    /closed/.test(error.message));
  assert.equal(traces.length,0);
});

test('nested owned async lexical block keeps its await capability and replay',async()=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:bundle=>traces.push(bundle)});
  const result=await env.executeAsync({
    code:"if(self.active){const n=await Promise.resolve(3);return n+5;}return 0;",
    body:true,scope:{active:true},path:'natlang://nested-await.ts'
  });
  assert.equal(result.result,8);
  assert.equal(replayExact(traces[0]).valid,true);
});
