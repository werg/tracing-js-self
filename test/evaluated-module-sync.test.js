import test from 'node:test';
import assert from 'node:assert/strict';
import {executeEvaluatedModulesSync} from 'tracing-js-self/evaluated-modules';
import {createBoundedRetainedModuleSession} from 'tracing-js-self/evaluated-module-session';
import {validateBundle,replayExact} from 'tracing-js-self';

const modules={'main.ts':`
  export let n=1;
  export function add(x:number){n+=x;return n;}
  export function read(){return n;}
`};

test('effect-free ESM exports run synchronously entirely through owned trace',()=>{
  const run=executeEvaluatedModulesSync({modules,entryModule:'main.ts',
    exportName:'add',args:[4]});
  assert.equal(run.result,5);
  assert.equal(validateBundle(run.bundle).valid,true);
  assert.equal(replayExact(run.bundle).valid,true);
  assert.throws(()=>executeEvaluatedModulesSync({modules,entryModule:'main.ts',
    exportName:'add',args:[1],services:{}}),/cannot use native services/);
});

test('synchronous retained ESM cells and host result identities preserve invocation order',()=>{
  const session=createBoundedRetainedModuleSession({modules,entryModule:'main.ts'});
  try{
    const a=session.invokeSync('add',[2]);
    assert.equal(a.result,3);
    assert.equal(replayExact(a.bundle).valid,true);
    assert.equal(session.invokeSync('read').result,3);
    assert.equal(session.invokeSync('add',[4]).result,7);
    assert.deepEqual(session.history.map(x=>x.exportName),['add','read','add']);
    assert.equal(session.snapshot().calls.length,3);
  }finally{session.close();}
});
test('synchronous retained API refuses concurrent async replay and rolls back errors',async()=>{
  const session=createBoundedRetainedModuleSession({modules:{
    ...modules,'main.ts':modules['main.ts']+'\nexport function fail(){throw "guest-failure";}'
  },entryModule:'main.ts'});
  try{
    const pending=session.invoke('add',[2]);
    assert.throws(()=>session.invokeSync('read'),/async calls are pending/);
    assert.equal((await pending).result,3);
    const before=session.snapshot();
    assert.throws(()=>session.invokeSync('fail'),/Owned module evaluation rejected/);
    assert.deepEqual(session.snapshot(),before);
    assert.equal(session.invokeSync('read').result,3);
  }finally{session.close();}
});

test('owned ESM linker invokes const arrow/function-expression exports',()=>{
  const sources={'main.ts':`
    export let total=1;
    export const add=(n:number)=>{total+=n;return total;};
    export const read=function(){return total;};
    export const data=99;
  `};
  const run=executeEvaluatedModulesSync({modules:sources,entryModule:'main.ts',
    calls:[{exportName:'add',args:[3]},
      {exportName:'read',args:[]},{exportName:'add',args:[5]}]});
  assert.deepEqual(run.result,[4,4,9]);
  assert.equal(validateBundle(run.bundle).valid,true);
  assert.equal(replayExact(run.bundle).valid,true);
  assert.throws(()=>executeEvaluatedModulesSync({
    modules:sources,entryModule:'main.ts',exportName:'data',args:[1]
  }),/non-function/);
});
