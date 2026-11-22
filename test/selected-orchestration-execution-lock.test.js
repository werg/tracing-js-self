import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,lstat,mkdir,writeFile,symlink,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DurableSelectedOrchestrationExecutionLock} from '../src/storage/selected-orchestration-execution-lock.js';

const fixture=fileURLToPath(new URL('./fixtures/selected-orchestration-execution-lock-worker.mjs',import.meta.url));
async function root(t){
 const path=await mkdtemp(join(tmpdir(),'selected-orchestration-lock-'));
 t.after(()=>rm(path,{recursive:true,force:true}));return path;
}
function runOnce(directory,session='session1',stream='history1',flockPath='/usr/bin/flock'){
 return spawnSync(process.execPath,[fixture,directory,session,stream,'once',flockPath],
   {encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],shell:false});
}
function start(directory,session='session1',stream='history1',mode='hold',flockPath='/usr/bin/flock'){
 const child=spawn(process.execPath,[fixture,directory,session,stream,mode,flockPath],
   {stdio:['pipe','pipe','pipe'],shell:false});
 child.__stdoutText='';
 child.stdout.on('data',chunk=>{child.__stdoutText+=String(chunk);});
 return child;
}
function waitText(child,pattern,timeout=5000){
 let output=child.__stdoutText??'';
 if(pattern.test(output))return Promise.resolve(output);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('worker output timeout: '+output));},timeout);
  const data=chunk=>{output+=String(chunk);if(pattern.test(output)){cleanup();resolve(output);}};
  const error=failure=>{cleanup();reject(failure);};
  const exit=(code,signal)=>{cleanup();reject(new Error('worker exited '+String(code??signal)+': '+output));};
  const cleanup=()=>{clearTimeout(timer);child.stdout.off('data',data);child.off('error',error);child.off('exit',exit);};
  child.stdout.on('data',data);child.once('error',error);child.once('exit',exit);
 });
}
function exited(child,timeout=5000){
 if(child.exitCode!==null||child.signalCode!==null)
  return Promise.resolve({code:child.exitCode,signal:child.signalCode});
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('worker exit timeout'));},timeout);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
 });
}

test('kernel flock lease excludes a separate process until the parent file descriptor is released',async t=>{
 const directory=await root(t),first=new DurableSelectedOrchestrationExecutionLock({
   directory,sessionId:'session1',streamId:'history1'}),lease=await first.acquire();
 assert.equal(lease.assertHeld(),true);
 const refused=runOnce(directory);
 assert.equal(refused.status,3,String(refused.error??'')+'\n'+refused.stdout+'\n'+refused.stderr);
 assert.match(refused.stderr,/execution lock|flock helper/i);
 await lease.release();assert.throws(()=>lease.assertHeld(),/released/);
 const after=start(directory,'session1','history1','once'),afterExit=exited(after);
 assert.match(await waitText(after,/released/),/released/);
 assert.deepEqual(await afterExit,{code:0,signal:null});
});

test('kernel releases the shared open-file-description lock after a crashed holder exits without unlinking it',async t=>{
 const directory=await root(t),worker=start(directory,'session2','history2','crash');
 assert.match(await waitText(worker,/acquired/),/acquired/);
 const lock=new DurableSelectedOrchestrationExecutionLock({directory,sessionId:'session2',streamId:'history2'});
 const before=await lstat(lock.lockPath);
 const workerExit=exited(worker);worker.kill('SIGKILL');assert.equal((await workerExit).signal,'SIGKILL');
 const lease=await lock.acquire();
 const after=await lstat(lock.lockPath);
 assert.equal(after.ino,before.ino,'lock inode must remain stable across release and reacquisition');
 assert.equal(after.nlink,1);
 await lease.release();
});

test('an inherited native-worker descriptor keeps the flock held after supervisor release',async t=>{
 const directory=await root(t),supervisor=start(directory,'session5','history5','inherit'),
   supervisorExit=exited(supervisor);
 t.after(()=>{if(supervisor.exitCode===null&&supervisor.signalCode===null&&!supervisor.stdin.destroyed)
   supervisor.stdin.write('release-parent\nrelease-child\n',()=>{});});
 assert.match(await waitText(supervisor,/native-held/),/native-held/);
 assert.equal(runOnce(directory,'session5','history5').status,3);
 supervisor.stdin.write('release-parent\n');
 assert.match(await waitText(supervisor,/parent-released/),/parent-released/);
 assert.equal(runOnce(directory,'session5','history5').status,3,
   'the inherited native worker still holds the same open-file-description lock');
 supervisor.stdin.write('release-child\n');
 assert.match(await waitText(supervisor,/child-exited/),/child-exited/);
 assert.deepEqual(await supervisorExit,{code:0,signal:null});
 assert.equal(runOnce(directory,'session5','history5').status,0);
});

test('different session namespaces do not contend while repeated exact namespaces do',async t=>{
 const directory=await root(t),a=new DurableSelectedOrchestrationExecutionLock({
   directory,sessionId:'session-a',streamId:'history1'});
 const b=new DurableSelectedOrchestrationExecutionLock({directory,sessionId:'session-b',streamId:'history1'});
 const aLease=await a.acquire(),bLease=await b.acquire();
 const exactContender=runOnce(directory,'session-a','history1');
 assert.equal(exactContender.status,3,String(exactContender.error??'')+'\n'+exactContender.stderr);
 await aLease.release();await bLease.release();
});

test('lock refuses an unavailable helper and a symlinked lock inode',async t=>{
 const directory=await root(t);
 const missing=new DurableSelectedOrchestrationExecutionLock({directory,sessionId:'session3',
   streamId:'history3',flockPath:join(directory,'missing-flock')});
 await assert.rejects(missing.acquire(),/ENOENT|flock/i);
 const lock=new DurableSelectedOrchestrationExecutionLock({directory,sessionId:'session4',streamId:'history4'});
 await mkdir(join(directory,'selected-orchestration-execution-locks'),{mode:0o700});
 const target=join(directory,'target');await writeFile(target,'target',{mode:0o600});
 await symlink(target,lock.lockPath);
 await assert.rejects(lock.acquire());
});

test('lock refuses a writable helper before executing it',async t=>{
 const directory=await root(t),helper=join(directory,'writable-flock');
 await writeFile(helper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 await chmod(helper,0o777);
 const lock=new DurableSelectedOrchestrationExecutionLock({directory,sessionId:'session6',
   streamId:'history6',flockPath:helper});
 await assert.rejects(lock.acquire(),/trusted executable/);
});
