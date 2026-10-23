import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createBoundedRetainedModuleSession} from 'tracing-js-self/evaluated-module-session';
import {replayExact} from 'tracing-js-self';
import {createDurableRetainedModuleStore,DurableRetainedModuleStorageError}
  from 'tracing-js-self/storage/node';

const modules={'main.ts':`
  export let n=1;
  export function add(x:number){n+=x;return n;}
  export function read(){return n;}
`};
async function inDirectory(callback){
  const directory=await mkdtemp(join(tmpdir(),'owned-retained-checkpoint-'));
  try{await callback(createDurableRetainedModuleStore({directory}),directory);}
  finally{await rm(directory,{recursive:true,force:true});}
}
test('durable retained checkpoint replays module cells in a fresh session',async()=>{
  await inDirectory(async(store,directory)=>{
    const session=createBoundedRetainedModuleSession({modules,entryModule:'main.ts'});
    let restored;
    try{
      assert.equal((await session.invoke('add',[2])).result,3);
      assert.equal((await session.invoke('add',[5])).result,8);
      const receipt=await store.put(session);
      assert.match(receipt.id,/^[a-f0-9]{64}$/);
      assert.equal(receipt.calls,2);
      assert.deepEqual(await store.list(),[receipt.id]);
      const reopened=createDurableRetainedModuleStore({directory});
      restored=await reopened.get(receipt.id);
      assert.equal((await restored.invoke('read')).result,8);
      assert.equal((await restored.invoke('add',[4])).result,12);
      assert.equal(replayExact(restored.lastArchive).valid,true);
      assert.equal((await session.invoke('read')).result,8,
        'restored session must have independent module state');
      assert.deepEqual(await reopened.put(session),receipt,
        'identical committed histories must have identical bytes and IDs');
    }finally{session.close();restored?.close();}
  });
});

test('corrupt or symlink checkpoint is rejected without guest execution',async()=>{
  await inDirectory(async store=>{
    const session=createBoundedRetainedModuleSession({modules,entryModule:'main.ts'});
    try{
      await session.invoke('add',[2]);
      const receipt=await store.put(session);
      await writeFile(store.objectPath(receipt.id),'{}\n');
      await assert.rejects(store.get(receipt.id),
        e=>e instanceof DurableRetainedModuleStorageError&&/digest mismatch/.test(e.message));
      const id='a'.repeat(64),file=store.objectPath(id);
      await mkdir(dirname(file),{recursive:true});
      await symlink(store.objectPath(receipt.id),file);
      await assert.rejects(store.get(id));
    }finally{session.close();}
  });
});

test('checkpoint admission is replay-checked and limited to owned sessions',async()=>{
  await inDirectory(async(store,directory)=>{
    await assert.rejects(store.put({snapshot(){return {};}}),/owned retained/);
    const session=createBoundedRetainedModuleSession({modules,entryModule:'main.ts'});
    try{
      await session.invoke('add',[2]);
      const narrow=createDurableRetainedModuleStore({directory,maxBytes:4});
      await assert.rejects(narrow.put(session),/byte limit/);
      const [first,second]=await Promise.all([store.put(session),store.put(session)]);
      assert.deepEqual(first,second);
      assert.deepEqual(await store.list(),[first.id]);
      assert.throws(()=>store.objectPath('../escape'),DurableRetainedModuleStorageError);
      session.close();
      await assert.rejects(store.put(session),/closed/);
    }finally{session.close();}
  });
});
