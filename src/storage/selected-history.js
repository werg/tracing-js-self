import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {stableAlgorithmJSON} from '../semantic/ir.js';
import {validateSelectedHistoryEntry,validateSelectedHistoryReceipt,validateSelectedHistoryChain} from
  '../semantic/selected-history-v8.js';

const fail=message=>{throw new TypeError('Durable selected history: '+message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function syncDirectory(path){const handle=await open(path,constants.O_RDONLY);
  try{await handle.sync();}finally{await handle.close();}}

/** Complete, explicitly requested cuts use the same immutable no-replace/fsync
 * discipline as host ingress. An unacknowledged file is never discovered as a
 * new head. Callers must retain the returned receipt independently. */
export class DurableSelectedHistoryJournal {
  constructor({directory,streamId,maxBytes=64*1024*1024,maxEntries=1024}={}){
    if(typeof directory!=='string'||!directory.trim()||!/^[a-z][a-z0-9:_-]*$/.test(streamId??'')||
      !Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>65536)
      fail('invalid directory, stream or resource bounds');
    Object.defineProperties(this,{directory:{value:resolve(directory),enumerable:true},
      streamId:{value:streamId,enumerable:true},maxBytes:{value:maxBytes,enumerable:true},
      maxEntries:{value:maxEntries,enumerable:true}});
  }
  entryPath(position){
    if(!Number.isSafeInteger(position)||position<1||position>this.maxEntries)fail('entry position exceeds bound');
    return join(this.directory,'selected-checkpoint-history',this.streamId,String(position)+'.json');
  }
  async read(receipt){
    validateSelectedHistoryReceipt(receipt);receipt=structuredClone(receipt);
    if(receipt.streamId!==this.streamId||receipt.bytes>this.maxBytes)fail('receipt differs from stream or byte bound');
    const handle=await open(this.entryPath(receipt.position),constants.O_RDONLY|constants.O_NOFOLLOW);
    let bytes;
    try{const stat=await handle.stat();
      if(!stat.isFile()||stat.size!==receipt.bytes||stat.size>this.maxBytes)fail('invalid entry file or size');
      bytes=await handle.readFile();
    }finally{await handle.close();}
    if(bytes.length!==receipt.bytes||digest(bytes)!==receipt.id)fail('entry receipt digest mismatch');
    const entry=JSON.parse(bytes.toString('utf8'));validateSelectedHistoryEntry(entry);
    if(entry.streamId!==this.streamId||entry.position!==receipt.position||stableAlgorithmJSON(entry)!==bytes.toString('utf8'))
      fail('noncanonical or substituted entry');
    return entry;
  }
  async readAll(receipt){
    validateSelectedHistoryReceipt(receipt);receipt=structuredClone(receipt);
    if(receipt.position>this.maxEntries)fail('log exceeds entry bound');
    const entries=[];let current=receipt,total=0;
    while(current){
      const entry=await this.read(current);total+=current.bytes;
      if(total>this.maxBytes)fail('complete log exceeds byte bound');
      entries.push(entry);current=entry.previous;
    }
    return validateSelectedHistoryChain(entries.reverse(),receipt);
  }
  async append(checkpoint,{previous=null,terminal=undefined,pending=undefined}={}){
    if(previous!==null)validateSelectedHistoryReceipt(previous);
    // Capture complete caller bytes before the first storage await.
    const entry={schema:'semantic-selected-history-entry/8',streamId:this.streamId,
      position:(previous?.position??0)+1,previous:structuredClone(previous),checkpoint:structuredClone(checkpoint),
      ...(terminal===undefined?{}:{terminal:structuredClone(terminal)}),
      ...(pending===undefined?{}:{pending:structuredClone(pending)})};
    validateSelectedHistoryEntry(entry);this.entryPath(entry.position);
    const bytes=Buffer.from(stableAlgorithmJSON(entry),'utf8');
    const receipt=Object.freeze({schema:'semantic-selected-history-receipt/8',streamId:this.streamId,
      position:entry.position,id:digest(bytes),bytes:bytes.length});
    if(bytes.length>this.maxBytes)fail('entry exceeds byte bound');
    if(entry.previous){
      const entries=await this.readAll(entry.previous);
      const receiptForValidation=Object.freeze({schema:'semantic-selected-history-receipt/8',
        streamId:this.streamId,position:entry.position,id:digest(bytes),bytes:bytes.length});
      validateSelectedHistoryChain([...entries,entry],receiptForValidation);
      if(entries.reduce((total,row)=>total+Buffer.byteLength(stableAlgorithmJSON(row)),bytes.length)>this.maxBytes)
        fail('complete log exceeds byte bound');
    }else validateSelectedHistoryChain([entry],receipt);
    const base=join(this.directory,'selected-checkpoint-history'),stream=join(base,this.streamId);
    await mkdir(this.directory,{recursive:true,mode:0o700});await mkdir(base,{recursive:true,mode:0o700});
    await mkdir(stream,{recursive:true,mode:0o700});await syncDirectory(this.directory);await syncDirectory(base);
    const temporary=join(stream,'.tmp-'+randomUUID());
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      try{await link(temporary,this.entryPath(entry.position));}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        if(!isDeepStrictEqual(await this.read(receipt),entry))fail('competing writer changed the expected head');
      }
      await syncDirectory(stream);
    }finally{
      await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await syncDirectory(stream);
    }
    return receipt;
  }
}
