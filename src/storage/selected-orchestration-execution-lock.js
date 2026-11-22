// Trusted-local Linux execution exclusion primitive for selected orchestration.
// This is intentionally not wired into restore authorization: callers must also
// reconcile native request outcomes and attest that every driver holds the lock.
import {constants} from 'node:fs';
import {lstat,mkdir,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {isAbsolute,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {stableAlgorithmJSON} from '../semantic/ir.js';

const ID=/^[a-z][a-z0-9:_-]{0,255}$/;
const fail=message=>{throw new TypeError('Selected orchestration execution lock: '+message);};
const digest=value=>createHash('sha256').update(stableAlgorithmJSON(value),'utf8').digest('hex');
const ownUid=()=>typeof process.getuid==='function'?process.getuid():null;
const issuedLeases=new WeakSet();
const childLeases=new WeakSet();

/** Only a live lease issued by this implementation can guard a native child. */
export function assertSelectedOrchestrationExecutionLease(lease,{sessionId,streamId}={}){
  if(!issuedLeases.has(lease))fail('an original kernel execution lease is required');
  lease.assertHeld();
  if(sessionId!==undefined&&lease.sessionId!==sessionId||streamId!==undefined&&lease.streamId!==streamId)
    fail('execution lease belongs to another session or stream');
  return lease;
}

/** A shared flock open-file description cannot exclude two children that both
 * inherit it. Consume each lease for at most one child, even after that child
 * closes; a replacement must release and acquire a fresh kernel description. */
export function claimSelectedOrchestrationExecutionLeaseForNative(lease){
  assertSelectedOrchestrationExecutionLease(lease);
  if(childLeases.has(lease))fail('execution lease already belongs to a native child; acquire a fresh lease');
  childLeases.add(lease);return lease.fileDescriptor;
}

async function requirePrivateDirectory(path){
  let info;
  try{info=await lstat(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!info){
    await mkdir(path,{recursive:false,mode:0o700});
    info=await lstat(path);
  }
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==ownUid()||(info.mode&0o077)!==0)
    fail('lock directories must be ordinary owner-only directories owned by this user');
}
function requireLinux(){
  if(process.platform!=='linux'||ownUid()===null)fail('kernel flock locking is supported only on Linux POSIX processes');
}
async function verifyFlockExecutable(path){
  if(typeof path!=='string'||!isAbsolute(path))fail('flock utility path must be absolute');
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o111)===0||(info.mode&0o022)!==0||
     info.uid!==0&&info.uid!==ownUid())
    fail('flock utility must be a trusted executable owned by root or this user');
}
function closeAfter(child){
  return new Promise((resolveExit,reject)=>{
    let error=null;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('flock helper deadline exceeded'));},5000);
    child.once('error',failure=>{error=failure;});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      if(error)reject(error);
      else resolveExit({code,signal});
    });
  });
}

/** Stable inode-scoped flock namespace. The returned lease holds the parent
 * file descriptor after the short-lived helper exits. No lock file is ever
 * unlinked: unlinking could split contenders across different inodes.
 */
export class DurableSelectedOrchestrationExecutionLock {
  #directory;
  #sessionId;
  #streamId;
  #flockPath;
  #lockPath;
  constructor({directory,sessionId,streamId,flockPath='/usr/bin/flock'}={}){
    requireLinux();
    if(typeof directory!=='string'||!directory.trim()||!ID.test(sessionId??'')||!ID.test(streamId??''))
      fail('private directory and stable session/stream identifiers are required');
    if(typeof flockPath!=='string'||!isAbsolute(flockPath))fail('flock utility path must be absolute');
    this.#directory=resolve(directory);
    this.#sessionId=sessionId;this.#streamId=streamId;this.#flockPath=flockPath;
    const lockId=digest({schema:'semantic-selected-orchestration-lock-key/1',sessionId,streamId});
    this.#lockPath=join(this.#directory,'selected-orchestration-execution-locks',lockId+'.lock');
    Object.defineProperties(this,{
      directory:{value:this.#directory,enumerable:true},
      sessionId:{value:sessionId,enumerable:true},
      streamId:{value:streamId,enumerable:true},
      lockPath:{value:this.#lockPath,enumerable:true}
    });
  }
  async acquire(){
    requireLinux();
    await verifyFlockExecutable(this.#flockPath);
    await requirePrivateDirectory(this.#directory);
    const lockDirectory=join(this.#directory,'selected-orchestration-execution-locks');
    try{await mkdir(lockDirectory,{recursive:false,mode:0o700});}
    catch(error){if(error.code!=='EEXIST')throw error;}
    await requirePrivateDirectory(lockDirectory);
    let handle;
    try{
      handle=await open(this.#lockPath,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
      const stat=await handle.stat();
      if(!stat.isFile()||stat.uid!==ownUid()||(stat.mode&0o077)!==0||stat.nlink!==1)
        fail('lock inode must be an owner-only ordinary file with one link');
    }catch(error){await handle?.close().catch(()=>{});throw error;}
    let child;
    try{
      // FD 3 is a dup of the parent handle. flock locks their shared open-file
      // description, so helper exit does not release while parent retains its fd.
      child=spawn(this.#flockPath,['--exclusive','--nonblock','3'],
        {stdio:['ignore','ignore','pipe',handle.fd],shell:false,windowsHide:true});
      const result=await closeAfter(child);
      if(result.code!==0){
        await handle.close();
        fail('flock helper did not acquire the lock; execution ownership is unavailable');
      }
    }catch(error){
      if(child&&!child.killed)child.kill('SIGKILL');
      await handle.close().catch(()=>{});
      if(error instanceof TypeError)throw error;
      fail('flock helper failed; execution ownership is unknown');
    }
    let released=false;
    const lease=Object.freeze({
      sessionId:this.#sessionId,streamId:this.#streamId,lockPath:this.#lockPath,
      get fileDescriptor(){if(released||handle.fd<0)fail('execution lock lease is released');return handle.fd;},
      assertHeld(){if(released||handle.fd<0)fail('execution lock lease is released');return true;},
      async release(){if(released)return;released=true;await handle.close();}
    });
    issuedLeases.add(lease);
    return lease;
  }
}
