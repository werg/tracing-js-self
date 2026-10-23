// Node/POSIX checkpoints for committed, replay-backed ESM sessions.
// This persists deterministic invocation history, never a suspended VM.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {
  BoundedRetainedModuleSession,restoreBoundedRetainedModuleSession
} from '../evaluated-module-session.js';

const ID=/^[a-f0-9]{64}$/;
const MAX_BYTES=8*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export class DurableRetainedModuleStorageError extends Error {
  constructor(message,options){super(message,options);this.name='DurableRetainedModuleStorageError';}
}
const checkId=id=>{
  if(typeof id!=='string'||!ID.test(id))
    throw new DurableRetainedModuleStorageError('Invalid retained module checkpoint ID');
  return id;
};
async function syncDirectory(path){
  const handle=await open(path,constants.O_RDONLY);
  try{await handle.sync();}finally{await handle.close();}
}

/**
 * Immutable, content-addressed committed histories. Reads reconstruct the
 * entire module state by replay; they cannot restore guest continuations.
 * Requires a trusted private POSIX directory supporting link + directory fsync.
 */
export class DurableRetainedModuleStore {
  constructor({directory,maxBytes=MAX_BYTES}={}){
    if(typeof directory!=='string'||!directory.trim())
      throw new TypeError('Retained checkpoints need a private directory');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)
      throw new RangeError('maxBytes must be a positive safe integer');
    Object.defineProperties(this,{
      directory:{value:resolve(directory),enumerable:true},
      maxBytes:{value:maxBytes,enumerable:true}
    });
  }
  objectPath(id){
    checkId(id);
    return join(this.directory,'module-sessions',id.slice(0,2),id+'.json');
  }
  async prepare(id){
    const base=join(this.directory,'module-sessions');
    const shard=join(base,id.slice(0,2));
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await mkdir(base,{recursive:true,mode:0o700});
    await mkdir(shard,{recursive:true,mode:0o700});
    await syncDirectory(this.directory);
    await syncDirectory(base);
    return shard;
  }
  async readBytes(id){
    const handle=await open(this.objectPath(id),
      constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size<1||stat.size>this.maxBytes)
        throw new DurableRetainedModuleStorageError('Invalid retained checkpoint size or file');
      const bytes=await handle.readFile();
      if(bytes.length>this.maxBytes||digest(bytes)!==id)
        throw new DurableRetainedModuleStorageError('Retained checkpoint digest mismatch');
      return bytes;
    }finally{await handle.close();}
  }
  /**
   * Only the currently COMMITTED call history is persisted. Any invocation
   * still running is intentionally absent and cannot be recovered by this API.
   * Validation replays all committed history before publishing any bytes.
   */
  async put(session){
    if(!(session instanceof BoundedRetainedModuleSession))
      throw new TypeError('Expected an owned retained module session');
    const snapshot=session.snapshot();
    // An unexecuted graph cannot pass independent replay verification.
    if(snapshot.calls.length===0)
      throw new DurableRetainedModuleStorageError(
        'A retained checkpoint requires a committed module invocation');
    const bytes=Buffer.from(JSON.stringify(snapshot)+'\n','utf8');
    if(bytes.length>this.maxBytes)
      throw new DurableRetainedModuleStorageError('Retained checkpoint exceeds byte limit');
    const verified=await restoreBoundedRetainedModuleSession(snapshot);
    const calls=verified.history.length;
    verified.close();
    const id=digest(bytes),shard=await this.prepare(id);
    const target=this.objectPath(id),temp=join(shard,'.tmp-'+randomUUID());
    try{
      const handle=await open(temp,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}
      finally{await handle.close();}
      try{await link(temp,target);}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        if(!(await this.readBytes(id)).equals(bytes))
          throw new DurableRetainedModuleStorageError('Existing checkpoint has conflicting bytes');
      }
      await syncDirectory(shard);
    }finally{
      await unlink(temp).catch(error=>{
        if(error.code!=='ENOENT')throw error;
      });
      await syncDirectory(shard);
    }
    return Object.freeze({id,bytes:bytes.length,calls});
  }
  /** Digest, parse, validate and replay from source with no native services. */
  async get(id){
    const bytes=await this.readBytes(id);
    let snapshot;
    try{snapshot=JSON.parse(bytes.toString('utf8'));}
    catch(cause){
      throw new DurableRetainedModuleStorageError('Invalid retained checkpoint JSON',{cause});
    }
    if(!Array.isArray(snapshot?.calls)||snapshot.calls.length===0)
      throw new DurableRetainedModuleStorageError(
        'A retained checkpoint requires a committed module invocation');
    return restoreBoundedRetainedModuleSession(snapshot);
  }
  async list(){
    const base=join(this.directory,'module-sessions');
    let shards;
    try{shards=await readdir(base,{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
    const ids=[];
    for(const shard of shards){
      if(!shard.isDirectory()||!/^[a-f0-9]{2}$/.test(shard.name))continue;
      for(const entry of await readdir(join(base,shard.name),{withFileTypes:true})){
        if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
        const id=entry.name.slice(0,-5);
        if(ID.test(id)&&id.startsWith(shard.name))ids.push(id);
      }
    }
    return ids.sort();
  }
}
export function createDurableRetainedModuleStore(options){
  return new DurableRetainedModuleStore(options);
}
