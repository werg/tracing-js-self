import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedRetainedModuleSession,restoreBoundedRetainedModuleSession} from 'tracing-js-self/evaluated-module-session';
import {validateBundle,replayExact} from 'tracing-js-self';

test('replay-backed retained module session carries mutable exports across JS invocations',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':`export let n=2;
      export function bump(){n+=3;return n;}
      export function read(){return n;}`
  },entryModule:'main.js'});
  try{
    const first=await session.invoke('bump');
    assert.equal(first.result,5);
    assert.equal(validateBundle(first.bundle).valid,true);
    assert.equal(replayExact(first.bundle).valid,true);
    const second=await session.invoke('read');
    assert.equal(second.result,5);
    const third=await session.invoke('bump');
    assert.equal(third.result,8);
    assert.equal(session.history.length,3);
    assert.equal(replayExact(third.bundle).valid,true);
  }finally{session.close();}
});

test('retained returned objects keep host identity and reflect subsequent module writes',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':`export const state={n:1};
      export function read(){return state;}
      export function step(){state.n+=2;return state.n;}`
  },entryModule:'main.js'});
  try{
    const first=await session.invoke('read');
    const identity=first.result;
    assert.deepEqual(identity,{n:1});
    assert.equal((await session.invoke('step')).result,3);
    assert.equal(identity.n,3);
    const again=(await session.invoke('read')).result;
    assert.equal(again,identity);
    assert.equal(again.n,3);
  }finally{session.close();}
});

test('retained module sessions serialize concurrent calls and retain independent state',async()=>{
  const modules={'main.js':`export let n=0;export function add(x){n+=x;return n;}`};
  const one=createBoundedRetainedModuleSession({modules,entryModule:'main.js'});
  const two=createBoundedRetainedModuleSession({modules,entryModule:'main.js'});
  try{
    const results=await Promise.all([
      one.invoke('add',[2]),one.invoke('add',[3]),two.invoke('add',[8])
    ]);
    assert.deepEqual(results.map(r=>r.result),[2,5,8]);
    assert.equal(one.history.length,2);
    assert.equal(two.history.length,1);
    for(const r of results)assert.equal(replayExact(r.bundle).valid,true);
  }finally{one.close();two.close();}
});

test('retained module session rejects native effects and rolls back unsuccessful calls',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':`export let x=1;
      export function read(){return x;}
      export function fail(){throw 'owned-reject';}
      export function external(){return host.readAsync('x');}`
  },entryModule:'main.js'});
  try{
    assert.equal((await session.invoke('read')).result,1);
    await assert.rejects(session.invoke('fail'),/Owned module evaluation rejected/);
    assert.equal(session.history.length,1);
    await assert.rejects(session.invoke('external'));
    assert.equal(session.history.length,1);
    assert.equal((await session.invoke('read')).result,1);
  }finally{session.close();}
});

test('retained module sessions reject callbacks and data getters in invocation arguments',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export function id(x){return x;}'
  },entryModule:'main.js'});
  try{
    await assert.rejects(session.invoke('id',[()=>5]),/primitive/);
    const arg=[];
    Object.defineProperty(arg,'0',{get(){throw new Error('native getter executed');}});
    arg.length=1;
    await assert.rejects(session.invoke('id',arg),/primitive/);
  }finally{session.close();}
});

test('closed retained realm rejects future calls and does not publish partial history',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export function value(){return 3;}'
  },entryModule:'main.js'});
  assert.equal((await session.invoke('value')).result,3);
  session.close();
  await assert.rejects(session.invoke('value'),/closed/);
  assert.equal(session.history.length,1);
});


test('retained module history can cross JSON/process boundaries by replaying committed invocations',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':`export let n=1;
      export function add(v){n+=v;return n;}
      export function read(){return n;}`
  },entryModule:'main.js'});
  let restored;
  try{
    assert.equal((await session.invoke('add',[2])).result,3);
    assert.equal((await session.invoke('add',[5])).result,8);
    const checkpoint=JSON.parse(JSON.stringify(session.snapshot()));
    assert.equal(checkpoint.schema,'bounded-retained-module-session/1');
    assert.equal(checkpoint.calls.length,2);
    restored=await restoreBoundedRetainedModuleSession(checkpoint);
    assert.equal((await restored.invoke('read')).result,8);
    assert.equal((await restored.invoke('add',[4])).result,12);
    assert.equal((await session.invoke('read')).result,8,
      'new session must not share its original host identities');
  }finally{session.close();restored?.close();}
});

test('session snapshots preserve the complete primitive scalar wire format',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export function identity(value){return value;}'
  },entryModule:'main.js'});
  let restored;
  try{
    for(const scalar of [-0,undefined,NaN,2n]){
      const got=(await session.invoke('identity',[scalar])).result;
      assert(Object.is(got,scalar));
    }
    const checkpoint=JSON.parse(JSON.stringify(session.snapshot()));
    assert.deepEqual(checkpoint.calls.map(call=>call.args[0][0]),
      ['num','undefined','num','bigint']);
    restored=await restoreBoundedRetainedModuleSession(checkpoint);
    assert.equal(restored.history.length,4);
    assert(Object.is((await restored.invoke('identity',[-0])).result,-0));
  }finally{session.close();restored?.close();}
});

test('retained snapshot restore rejects accessor metadata and noncanonical tokens',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export function identity(value){return value;}'
  },entryModule:'main.js'});
  try{
    await session.invoke('identity',[3]);
    const checkpoint=session.snapshot();
    checkpoint.calls[0].args[0]=['num','3'];
    await assert.rejects(restoreBoundedRetainedModuleSession(checkpoint),/token/);
    const accessor=session.snapshot();
    Object.defineProperty(accessor,'calls',{get(){throw new Error('unowned getter');}});
    await assert.rejects(restoreBoundedRetainedModuleSession(accessor),/snapshot field/);
    assert.equal(session.history.length,1);
  }finally{session.close();}
});
