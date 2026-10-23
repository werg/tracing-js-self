import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
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
      assert.deepEqual(await reopened.put(session),receipt,
        'identical committed histories must have identical bytes and IDs');
      assert.equal((await session.invoke('read')).result,8,
        'restored session must have independent module state');
      assert.notEqual((await reopened.put(session)).id,receipt.id,
        'committing another call must change the content-addressed checkpoint');
    }finally{session.close();restored?.close();}
  });
});

test('checkpoint replays committed module history in a separate Node process',async()=>{
  await inDirectory(async store=>{
    const session=createBoundedRetainedModuleSession({modules,entryModule:'main.ts'});
    try{
      assert.equal((await session.invoke('add',[2])).result,3);
      assert.equal((await session.invoke('add',[5])).result,8);
      const receipt=await store.put(session);
      const script=`
        import {createDurableRetainedModuleStore} from './src/storage/node.js';
        const store=createDurableRetainedModuleStore({directory:process.argv[1]});
        const session=await store.get(process.argv[2]);
        try{
          const before=(await session.invoke('read')).result;
          const after=(await session.invoke('add',[4])).result;
          console.log(JSON.stringify({before,after,calls:session.history.length}));
        }finally{session.close();}
      `;
      const stdout=execFileSync(process.execPath,
        ['--input-type=module','--eval',script,store.directory,receipt.id],
        {cwd:process.cwd(),encoding:'utf8',timeout:30000});
      assert.deepEqual(JSON.parse(stdout),{before:8,after:12,calls:4});
      assert.equal(session.history.length,2,
        'restoring in another process may not mutate the original realm');
    }finally{session.close();}
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
      await assert.rejects(store.put(session),/committed module invocation/);
      assert.deepEqual(await store.list(),[]);
      assert.throws(()=>{store.directory=directory+'/other';},TypeError);
      assert.throws(()=>{store.maxBytes=1;},TypeError);
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
