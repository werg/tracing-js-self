// Immutable private host-arrival snapshots. Applications retain the returned
// receipt together with the acknowledged execution/model checkpoint.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {assertAlgorithmFields,stableAlgorithmJSON} from '../semantic/ir.js';
import {validatePendingIngressSnapshot} from '../semantic/pending-ingress-v8.js';

const HASH=/^[a-f0-9]{64}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new TypeError('Durable host ingress: '+message);};
async function syncDirectory(path){
  const handle=await open(path,constants.O_RDONLY);
  try{await handle.sync();}finally{await handle.close();}
}

export class DurableHostIngressStore {
  constructor({directory,maxBytes=16*1024*1024}={}){
    if(typeof directory!=='string'||!directory.trim())fail('private directory required');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)fail('positive byte bound required');
    Object.defineProperties(this,{directory:{value:resolve(directory),enumerable:true},
      maxBytes:{value:maxBytes,enumerable:true}});
  }
  objectPath(id){
    if(typeof id!=='string'||!HASH.test(id))fail('invalid snapshot digest');
    return join(this.directory,'host-ingress',id.slice(0,2),id+'.json');
  }
  async readBytes(id){
    const handle=await open(this.objectPath(id),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size<1||stat.size>this.maxBytes)fail('invalid snapshot file or size');
      const bytes=await handle.readFile();
      if(bytes.length>this.maxBytes||digest(bytes)!==id)fail('snapshot digest mismatch');
      return bytes;
    }finally{await handle.close();}
  }
  async put(value){
    validatePendingIngressSnapshot(value);
    // Capture synchronously before any storage await, including caller mutation.
    const bytes=Buffer.from(stableAlgorithmJSON(value),'utf8');
    if(bytes.length>this.maxBytes)fail('snapshot exceeds byte bound');
    const id=digest(bytes),base=join(this.directory,'host-ingress'),shard=join(base,id.slice(0,2));
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await mkdir(base,{recursive:true,mode:0o700});await mkdir(shard,{recursive:true,mode:0o700});
    await syncDirectory(this.directory);await syncDirectory(base);
    const temporary=join(shard,'.tmp-'+randomUUID());
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      try{await link(temporary,this.objectPath(id));}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        if(!(await this.readBytes(id)).equals(bytes))fail('conflicting immutable snapshot');
      }
      await syncDirectory(shard);
    }finally{
      await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await syncDirectory(shard);
    }
    return Object.freeze({schema:'semantic-host-ingress-receipt/8',id,bytes:bytes.length});
  }
  async get(receipt){
    assertAlgorithmFields(receipt,['schema','id','bytes'],'durable ingress receipt');
    if(!receipt||Object.keys(receipt).length!==3||receipt.schema!=='semantic-host-ingress-receipt/8'||
       !HASH.test(receipt.id??'')||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<1||receipt.bytes>this.maxBytes)
      fail('invalid durable receipt');
    const bytes=await this.readBytes(receipt.id);
    if(bytes.length!==receipt.bytes)fail('receipt byte count differs');
    const snapshot=JSON.parse(bytes.toString('utf8'));
    validatePendingIngressSnapshot(snapshot);
    if(stableAlgorithmJSON(snapshot)!==bytes.toString('utf8'))fail('noncanonical stored snapshot');
    return snapshot;
  }
}

export function createDurableHostIngressStore(options){return new DurableHostIngressStore(options);}
