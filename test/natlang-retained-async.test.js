import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
const create=(mode='fresh')=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,mode,
    onTrace:(bundle)=>traces.push(bundle)});
  return {env,traces};
};
const request=(code,{body=true,live,scope={}}={})=>({
  code,body,scope,path:'natlang://retained-data-test.ts',...(live===undefined?{}:{live})
});

test('an async natlang entry awaits owned fulfilled promises and replays exactly',async()=>{
  const {env,traces}=create();
  const r=await env.executeAsync(request(
    'const x = await Promise.resolve(self.x + 2); return x * 3;',
    {scope:{x:4}}));
  assert.equal(r.result,18);
  assert.equal(r.events[0].asyncGuest,true);
  assert.equal(traces.length,1);
  assert.equal(validateBundle(traces[0]).valid,true);
  assert.equal(replayExact(traces[0]).valid,true);
  const state=traces[0].finalState;
  assert(Object.values(state.promises).some(p=>p.status==='fulfilled'));
});

test('owned async rejection reaches natlang EvalFailure, never a successful trace',async()=>{
  const {env,traces}=create();
  await assert.rejects(env.executeAsync(request(
    "await Promise.reject('owned-failure'); return 3;")),
    error=>error instanceof EvalFailure && /owned-failure/.test(error.message));
  assert.equal(traces.length,0);
});

test('live data mutations retain host aliases and the identity of returned values',()=>{
  const {env,traces}=create();
  const cell={value:2};
  const live={left:cell,right:cell,history:[3,4]};
  const result=env.execute(request(
    'if(__live.left !== __live.right) throw 7;'+
    ' __live.left.value += 5; __live.history.push(__live.left.value);'+
    ' return __live.right;', {live}));
  assert.equal(result.result,cell);
  assert.equal(live.left,cell);
  assert.equal(live.right,cell);
  assert.deepEqual(cell,{value:7});
  assert.deepEqual(live.history,[3,4,7]);
  assert.equal(replayExact(traces[0]).valid,true);
});

test('mutating live data is rolled back on failed execution and invalid callbacks',()=>{
  const {env,traces}=create();
  const live={cell:{n:5}};
  assert.throws(()=>env.execute(request(
    ' __live.cell.n = 8; throw 42;', {live})),EvalFailure);
  assert.deepEqual(live,{cell:{n:5}});
  assert.equal(traces.length,0);
  const failing=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:()=>{throw new Error('sink refused');}});
  assert.throws(()=>failing.execute(request(' __live.cell.n=9;return 1;', {live})),EvalFailure);
  assert.deepEqual(live,{cell:{n:5}});
});

test('retained data-only CommonJS module commits exports without losing aliases',()=>{
  const {env,traces}=create('retained');
  const exports={count:1};
  const module={exports};
  const first=env.evaluateModule('exports.count += 2;', {module,exports});
  assert.equal(first,exports);
  assert.deepEqual(exports,{count:3});
  assert.equal(module.exports,exports);
  const second=env.evaluateModule('module.exports = {result: exports.count+4};',{module,exports});
  assert.equal(second,module.exports);
  assert.deepEqual(module.exports,{result:7});
  assert.deepEqual(exports,{count:3});
  assert.equal(traces.length,2);
  for(const archive of traces)assert.equal(replayExact(archive).valid,true);
});

test('retained module boundary refuses host callables and preserves state',()=>{
  const {env}=create('retained');
  const exports={answer:1};
  const module={exports};
  assert.throws(()=>env.evaluateModule('exports.answer=3;',
    {module,exports,require:()=>({})}),EvalFailure);
  assert.equal(exports.answer,1);
  assert.throws(()=>env.evaluateModule('module.exports=3;', {module,exports:{}}),EvalFailure);
  env.close();
  assert.throws(()=>env.evaluateModule('exports.answer=2;', {module,exports}),EvalFailure);
});

test('null-prototype data objects retain their prototype at guest and host boundaries',()=>{
  const {env,traces}=create();
  const obj=Object.create(null);
  obj.count=2;
  const result=env.execute(request(
    'if(Object.getPrototypeOf(__live.obj)!==null) throw 1;'+
    '__live.obj.count+=3;return __live.obj;', {live:{obj}}));
  assert.equal(result.result,obj);
  assert.equal(Object.getPrototypeOf(result.result),null);
  assert.equal(obj.count,5);
  assert.equal(replayExact(traces[0]).valid,true);
});
