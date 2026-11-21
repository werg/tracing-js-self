// Service-owned Node/POSIX state. Sharing this directory between every service
// worker is essential; separate producer-local directories cannot deduplicate.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {stableAlgorithmJSON,assertAlgorithmFields} from '../semantic/ir.js';
import {validateSelectedServiceAction,validateSelectedServiceOutcome,selectedServiceActionKey,
  selectedServiceActionDigest} from '../host/selected-service.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new TypeError('Durable selected service journal: '+message);};
async function syncDirectory(path){const h=await open(path,constants.O_RDONLY);
  try{await h.sync();}finally{await h.close();}}

export class DurableSelectedServiceJournal {
  #claims=new WeakMap();
  constructor({directory,maxBytes=1024*1024}={}){
    if(typeof directory!=='string'||!directory.trim()||!Number.isSafeInteger(maxBytes)||maxBytes<1)
      fail('private service directory and positive byte bound required');
    Object.defineProperties(this,{directory:{value:resolve(directory),enumerable:true},
      maxBytes:{value:maxBytes,enumerable:true}});
  }
  path(key,kind){
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)||!['claim','outcome'].includes(kind))
      fail('invalid object identity');
    return join(this.directory,key+'.'+kind+'.json');
  }
  async readBytes(key,kind){
    const h=await open(this.path(key,kind),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await h.stat();
      if(!stat.isFile()||stat.size<1||stat.size>this.maxBytes)fail('invalid file or byte bound');
      const bytes=await h.readFile();
      if(bytes.length>this.maxBytes)fail('object exceeds byte bound');
      const record=JSON.parse(bytes.toString('utf8'));
      if(!Buffer.from(stableAlgorithmJSON(record),'utf8').equals(bytes))fail('noncanonical stored object');
      return {bytes,record};
    }finally{await h.close();}
  }
  async publish(key,kind,record){
    const bytes=Buffer.from(stableAlgorithmJSON(record));
    if(bytes.length>this.maxBytes)fail('object exceeds byte bound');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await syncDirectory(dirname(this.directory));
    const temporary=join(this.directory,'.tmp-'+randomUUID());let claimed=true;
    try{
      const h=await open(temporary,'wx',0o600);
      try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
      try{await link(temporary,this.path(key,kind));}
      catch(error){
        if(error.code!=='EEXIST')throw error;claimed=false;
        if(!(await this.readBytes(key,kind)).bytes.equals(bytes))fail('conflicting service action or outcome');
      }
      await syncDirectory(this.directory);
    }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    return Object.freeze({key,kind,digest:digest(bytes),bytes:bytes.length,claimed});
  }
  async claim(action){
    validateSelectedServiceAction(action);action=structuredClone(action);
    const key=selectedServiceActionKey(action),actionDigest=selectedServiceActionDigest(action);
    const receipt=await this.publish(key,'claim',{schema:'semantic-service-claim/8',action});
    if(receipt.claimed)this.#claims.set(receipt,actionDigest);
    return receipt;
  }
  async read(action){
    validateSelectedServiceAction(action);action=structuredClone(action);
    const key=selectedServiceActionKey(action),claim=await this.readBytes(key,'claim');
    assertAlgorithmFields(claim.record,['schema','action'],'service claim');
    if(claim.record.schema!=='semantic-service-claim/8'||
      stableAlgorithmJSON(claim.record.action)!==stableAlgorithmJSON(action))fail('stored claim binds another request');
    let outcome=null;
    try{outcome=(await this.readBytes(key,'outcome')).record;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(outcome){
      validateSelectedServiceOutcome(outcome,action);
      // A duplicate claim's synchronization can precede a concurrent outcome
      // link. Reading that later file is not a durable result acknowledgement.
      await syncDirectory(this.directory);
    }
    return {action:structuredClone(action),outcome};
  }
  async complete(action,outcome,receipt){
    validateSelectedServiceAction(action);validateSelectedServiceOutcome(outcome,action);
    action=structuredClone(action);outcome=structuredClone(outcome);
    if(this.#claims.get(receipt)!==selectedServiceActionDigest(action))
      fail('only the original acknowledged service claimant may record its result');
    await this.read(action);
    const result=await this.publish(selectedServiceActionKey(action),'outcome',outcome);
    this.#claims.delete(receipt);return result;
  }
}
