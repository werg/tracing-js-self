import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {stableAlgorithmJSON} from '../semantic/ir.js';
import {validateHostIngressArrival,validateHostIngressLogEntry,validateHostIngressLogReceipt}
  from '../semantic/host-ingress-journal-v8.js';

const fail=message=>{throw new TypeError('Durable host ingress journal: '+message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function syncDirectory(path){const handle=await open(path,constants.O_RDONLY);
  try{await handle.sync();}finally{await handle.close();}}

/** Immutable per-position files use no-overwrite links as a writer lease. A
 * competing append from the same predecessor can only succeed for identical
 * bytes. File and directory fsync complete before returning an acknowledgement.
 */
export class DurableHostIngressJournal {
  constructor({directory,streamId,maxBytes=16*1024*1024,maxEntries=4096}={}){
    if(typeof directory!=='string'||!directory.trim()||!/^[a-z][a-z0-9:_-]*$/.test(streamId??'')||
      !Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>65536)
      fail('invalid directory, stream or resource bounds');
    Object.defineProperties(this,{directory:{value:resolve(directory),enumerable:true},
      streamId:{value:streamId,enumerable:true},maxBytes:{value:maxBytes,enumerable:true},
      maxEntries:{value:maxEntries,enumerable:true}});
  }
  entryPath(position){
    if(!Number.isSafeInteger(position)||position<1||position>this.maxEntries)fail('entry position exceeds bound');
    return join(this.directory,'host-ingress-journals',this.streamId,String(position)+'.json');
  }
  async read(receipt){
    validateHostIngressLogReceipt(receipt);
    receipt=structuredClone(receipt);
    if(receipt.streamId!==this.streamId||receipt.bytes>this.maxBytes)fail('receipt belongs to another stream or byte bound');
    const handle=await open(this.entryPath(receipt.position),constants.O_RDONLY|constants.O_NOFOLLOW);
    let bytes;
    try{const stat=await handle.stat();
      if(!stat.isFile()||stat.size!==receipt.bytes||stat.size>this.maxBytes)fail('invalid entry file or size');
      bytes=await handle.readFile();
    }finally{await handle.close();}
    if(bytes.length!==receipt.bytes||digest(bytes)!==receipt.id)fail('entry receipt digest mismatch');
    const entry=JSON.parse(bytes.toString('utf8'));validateHostIngressLogEntry(entry);
    if(entry.streamId!==this.streamId||entry.position!==receipt.position||stableAlgorithmJSON(entry)!==bytes.toString('utf8'))
      fail('noncanonical or substituted entry');
    return entry;
  }
  async readAll(receipt){
    validateHostIngressLogReceipt(receipt);
    receipt=structuredClone(receipt);
    if(receipt.position>this.maxEntries)fail('log exceeds entry bound');
    const rows=[];let current=receipt,total=0;
    while(current){
      const row=await this.read(current);total+=current.bytes;
      if(total>this.maxBytes)fail('complete log exceeds byte bound');
      rows.push(row);current=row.previous;
    }
    return rows.reverse();
  }
  /** Read an unacknowledged next entry without accepting or delivering it.
   * The embedding can compare its original event and retry append with these
   * exact bytes to complete fsync and obtain a durable acknowledgement.
   */
  async inspectNext({previous=null}={}){
    if(previous!==null)validateHostIngressLogReceipt(previous);
    previous=structuredClone(previous);
    if(previous)await this.readAll(previous);
    const position=(previous?.position??0)+1;
    if(position>this.maxEntries)return null;
    let handle;
    try{handle=await open(this.entryPath(position),constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(error){if(error.code==='ENOENT')return null;throw error;}
    let bytes;
    try{const stat=await handle.stat();
      if(!stat.isFile()||stat.size<1||stat.size>this.maxBytes)fail('invalid unacknowledged entry size');
      bytes=await handle.readFile();
    }finally{await handle.close();}
    if(bytes.length>this.maxBytes)fail('unacknowledged entry exceeds byte bound');
    const receipt={schema:'semantic-host-ingress-log-receipt/8',streamId:this.streamId,
      position,id:digest(bytes),bytes:bytes.length};
    const entry=await this.read(receipt);
    if(!isDeepStrictEqual(entry.previous,previous))fail('unacknowledged entry has a different predecessor');
    return {receipt,entry};
  }
  async append(arrival,{previous=null}={}){
    validateHostIngressArrival(arrival);
    if(previous!==null)validateHostIngressLogReceipt(previous);
    // Capture the full wire record before the first asynchronous operation.
    const entry={schema:'semantic-host-ingress-log-entry/8',streamId:this.streamId,
      position:(previous?.position??0)+1,previous:structuredClone(previous),arrival:structuredClone(arrival)};
    validateHostIngressLogEntry(entry);
    const bytes=Buffer.from(stableAlgorithmJSON(entry),'utf8');
    const receipt=Object.freeze({schema:'semantic-host-ingress-log-receipt/8',streamId:this.streamId,
      position:entry.position,id:digest(bytes),bytes:bytes.length});
    this.entryPath(entry.position);
    if(bytes.length>this.maxBytes)fail('entry exceeds byte bound');
    if(entry.previous){
      const rows=await this.readAll(entry.previous),last=rows.at(-1);
      if(last.arrival.sessionId!==entry.arrival.sessionId||last.arrival.event.arrivalSequence+1!==entry.arrival.event.arrivalSequence)
        fail('session or arrival order changed');
      if(rows.reduce((sum,row)=>sum+Buffer.byteLength(stableAlgorithmJSON(row)),bytes.length)>this.maxBytes)
        fail('complete log exceeds byte bound');
    }
    const base=join(this.directory,'host-ingress-journals'),stream=join(base,this.streamId);
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
export {DurableHostIngressBroker} from '../semantic/host-ingress-journal-v8.js';
