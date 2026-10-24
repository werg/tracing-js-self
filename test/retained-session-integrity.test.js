import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedRetainedModuleSession} from 'tracing-js-self/evaluated-module-session';
import {validateBundle,replayExact} from 'tracing-js-self';

test('retained history and replay configuration cannot be rewritten by host consumers',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export let n=0;export function add(v){n+=v;return n;}'
  },entryModule:'main.js'});
  try{
    const first=await session.invoke('add',[2]);
    assert.equal(validateBundle(first.bundle).valid,true);
    assert.equal(replayExact(first.bundle).valid,true);
    const visible=session.history;
    visible[0].args[0]=900;
    visible[0].exportName='unknown';
    visible.push({exportName:'add',args:[100]});
    assert.deepEqual(session.history,[{exportName:'add',args:[2]}]);
    assert.throws(()=>{session.history=[];},TypeError);
    assert.throws(()=>{session.maxSteps=1;},TypeError);
    assert.throws(()=>{session.entryModule='other.js';},TypeError);
    assert.throws(()=>{session.modules={};},TypeError);
    assert.throws(()=>{session.closed=true;},TypeError);
    session.queue=Promise.resolve();
    session.objects=new Map();
    session.outputs=[];
    assert.equal((await session.invoke('add',[3])).result,5);
    assert.deepEqual(session.snapshot().calls.map(c=>c.args[0]),[['num',2],['num',3]]);
    assert.equal(session.history.length,2);
  }finally{session.close();}
});

test('a non-writable retained array length refuses the next call before any host graph mutation',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':`export const a=[1],b=[2];
      export function read(){return [a,b];}
      export function grow(){a.push(3);b.push(4);return [a,b];}`
  },entryModule:'main.js'});
  try{
    const first=await session.invoke('read');
    const [a,b]=first.result;
    assert.deepEqual(a,[1]);
    assert.deepEqual(b,[2]);
    Object.defineProperty(b,'length',{writable:false});
    await assert.rejects(session.invoke('grow'),/unowned descriptors/);
    assert.deepEqual(a,[1],'first array must not be changed before the second fails');
    assert.deepEqual(b,[2]);
    assert.equal(session.history.length,1);
    assert.equal(session.snapshot().calls.length,1);
  }finally{session.close();}
});

test('retained maxSteps is bounded before any snapshot is admitted',()=>{
  for(const maxSteps of [0,-1,NaN,1.2,Infinity,100001,'100']){
    assert.throws(()=>createBoundedRetainedModuleSession({
      modules:{'main.js':'export function value(){return 1;}'},
      entryModule:'main.js',maxSteps
    }),/maxSteps/);
  }
});

test('closed flag cannot be reset to reopen a retained session',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export function answer(){return 42;}'
  },entryModule:'main.js'});
  assert.equal((await session.invoke('answer')).result,42);
  session.close();
  assert.equal(session.closed,true);
  assert.throws(()=>{session.closed=false;},TypeError);
  await assert.rejects(session.invoke('answer'),/closed/);
});

test('trace hooks cannot reenter synchronous calls or rewrite retained archive evidence',()=>{
  let session,seen=0;
  session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export let n=0;export function add(x){n+=x;return n;}'
  },entryModule:'main.js',onTrace:bundle=>{
    seen++;
    assert.throws(()=>session.invokeSync('add',[100]),/Reentrant synchronous/);
    bundle.finalState.control.a0.completion={kind:'broken'};
  }});
  try{
    const first=session.invokeSync('add',[2]);
    assert.equal(first.result,2);
    assert.equal(validateBundle(first.bundle).valid,true);
    assert.equal(replayExact(first.bundle).valid,true);
    const exposed=session.lastArchive;
    exposed.finalState.control.a0.completion={kind:'forged'};
    assert.equal(replayExact(session.lastArchive).valid,true);
    first.bundle.finalState.control.a0.completion={kind:'forged'};
    assert.equal(replayExact(session.lastArchive).valid,true);
    assert.equal(session.invokeSync('add',[3]).result,5);
    assert.equal(seen,2);
    assert.deepEqual(session.history.map(x=>x.args[0]),[2,3]);
    assert.throws(()=>{session.lastArchive=null;},TypeError);
  }finally{session.close();}
});

test('closing an environment inside a trace hook aborts a retained commit',()=>{
  let session;
  session=createBoundedRetainedModuleSession({modules:{
    'main.js':'export function value(){return 42;}'
  },entryModule:'main.js',onTrace:()=>session.close()});
  assert.throws(()=>session.invokeSync('value'),/closed during trace hook/);
  assert.equal(session.closed,true);
  assert.deepEqual(session.history,[]);
  assert.equal(session.lastArchive,null);
});
