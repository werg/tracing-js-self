// Node durability for selected action intent and exact selected checkpoints.
// Host services are invoked only after append() resolves. Loading records never
// performs an effect, retries a write, or fabricates native resource continuity.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function syncDirectory(directory){
  const handle=await open(directory,constants.O_RDONLY);
  try{await handle.sync();}finally{await handle.close();}
}
export class SelectedIntentJournal {
  constructor({directory,maxBytes=16*1024*1024}={}){
    if(typeof directory!=='string'||!directory||!Number.isSafeInteger(maxBytes)||maxBytes<1)
      throw new TypeError('Selected journal requires a private directory and positive byte limit');
    this.directory=resolve(directory);this.maxBytes=maxBytes;
  }
  async put(key,record){
    if(!/^[a-f0-9]{64}$/.test(key))throw new TypeError('Invalid journal object key');
    const bytes=Buffer.from(JSON.stringify(record)+'\n');
    if(bytes.length>this.maxBytes)throw new RangeError('Selected journal byte limit exceeded');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const target=join(this.directory,key+'.json'),temporary=join(this.directory,'.tmp-'+randomUUID());
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      try{await link(temporary,target);}catch(error){
        if(error.code!=='EEXIST')throw error;
        const existing=await this.readBytes(key);
        if(!existing.equals(bytes))throw new Error('Conflicting durable selected action identity');
      }
      await syncDirectory(this.directory);
    }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    return Object.freeze({key,digest:digest(bytes),bytes:bytes.length});
  }
  async readBytes(key){
    if(!/^[a-f0-9]{64}$/.test(key))throw new TypeError('Invalid journal object key');
    const handle=await open(join(this.directory,key+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size<1||stat.size>this.maxBytes)throw new Error('Invalid selected journal file');
      const bytes=await handle.readFile();
      if(bytes.length>this.maxBytes)throw new RangeError('Selected journal byte limit exceeded');
      return bytes;
    }finally{await handle.close();}
  }
  intentKey(session,key,attempt){return digest(JSON.stringify([session,key,attempt]));}
  append(record){
    if(record?.schema!=='semantic-action-intent/4'||typeof record.session!=='string'||
       typeof record.key!=='string'||!Number.isSafeInteger(record.attempt)||record.attempt<1||
       typeof record.payload!=='string'||digest(record.payload)!==record.payloadDigest)
      throw new TypeError('Invalid durable selected action intent');
    return this.put(this.intentKey(record.session,record.key,record.attempt),record);
  }
  async readIntent(session,key,attempt=1){
    const record=JSON.parse(await this.readBytes(this.intentKey(session,key,attempt)));
    if(record.session!==session||record.key!==key||record.attempt!==attempt||
       record.schema!=='semantic-action-intent/4'||digest(record.payload)!==record.payloadDigest)
      throw new Error('Durable selected intent integrity mismatch');
    return record;
  }
  putCheckpoint(packet){
    if(packet?.schema!=='semantic-checkpoint/4')throw new TypeError('Expected selected checkpoint');
    const {integrity,...body}=packet;
    if(digest(JSON.stringify(body))!==integrity)throw new Error('Selected checkpoint integrity mismatch');
    return this.put(digest(JSON.stringify(packet)+'\n'),packet);
  }
  async readCheckpoint(key){
    const bytes=await this.readBytes(key);
    if(digest(bytes)!==key)throw new Error('Selected checkpoint object digest mismatch');
    const packet=JSON.parse(bytes),{integrity,...body}=packet;
    if(packet.schema!=='semantic-checkpoint/4'||digest(JSON.stringify(body))!==integrity)
      throw new Error('Selected checkpoint integrity mismatch');
    return packet;
  }
}
