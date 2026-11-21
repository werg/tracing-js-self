// A service-owned sequenced log orders authority changes and new admissions
// together. Reading a fence and then claiming an unrelated file is not atomic.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,unlink,opendir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {assertAlgorithmFields,stableAlgorithmJSON} from '../semantic/ir.js';
import {SelectedServiceBoundaryError,validateSelectedServiceAction,validateSelectedServiceOutcome,
  selectedServiceActionKey,selectedServiceActionDigest} from '../host/selected-service.js';
import {DurableSelectedServiceJournal} from './selected-service-journal.js';

const ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const copy=structuredClone,eq=isDeepStrictEqual;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new TypeError('Durable service fence: '+message);};
const demand=(condition,message)=>{if(!condition)fail(message);};
const refuse=(code,message)=>{throw new SelectedServiceBoundaryError(message,{code});};
const identity=value=>typeof value==='string'&&value.length<=256&&ID.test(value);
const claimRecord=action=>({schema:'semantic-service-claim/8',action});
async function syncDirectory(path){const h=await open(path,constants.O_RDONLY);
  try{await h.sync();}finally{await h.close();}}

function validateReceipt(receipt,scope){
  assertAlgorithmFields(receipt,['schema','serviceId','sessionId','position','id','bytes'],'service fence receipt');
  stableAlgorithmJSON(receipt);
  demand(receipt.schema==='semantic-service-fence-receipt/8'&&
    receipt.serviceId===scope.serviceId&&receipt.sessionId===scope.sessionId&&
    Number.isSafeInteger(receipt.position)&&receipt.position>=1&&receipt.position<=scope.maxEntries&&
    typeof receipt.id==='string'&&HASH.test(receipt.id)&&
    Number.isSafeInteger(receipt.bytes)&&receipt.bytes>=1&&receipt.bytes<=scope.maxEntryBytes,
    'receipt scope or bounds differ');
  return receipt;
}
function receiptFor(entry,bytes){return Object.freeze({schema:'semantic-service-fence-receipt/8',
  serviceId:entry.serviceId,sessionId:entry.sessionId,position:entry.position,id:digest(bytes),bytes:bytes.length});}
function acknowledgement(action,claimed){const bytes=Buffer.from(stableAlgorithmJSON(claimRecord(action)));
  return Object.freeze({key:selectedServiceActionKey(action),kind:'claim',digest:digest(bytes),bytes:bytes.length,claimed});}

/** Strict fenced admission. The supervisor retains advanceOwner()/terminate();
 * service workers receive only a forOwner() binding. Every worker for the scope
 * must use the same directory; authority must never be synthesized from a model.
 */
export class DurableFencedSelectedServiceJournal {
  #claims=new WeakMap();
  #outcomes;
  constructor({directory,serviceId,sessionId,maxEntries=4096,maxEntryBytes=1024*1024,
      maxLogBytes=16*1024*1024}={}){
    demand(typeof directory==='string'&&directory.trim()&&identity(serviceId)&&identity(sessionId)&&
      Number.isSafeInteger(maxEntries)&&maxEntries>=1&&maxEntries<=65536&&
      Number.isSafeInteger(maxEntryBytes)&&maxEntryBytes>=1&&
      Number.isSafeInteger(maxLogBytes)&&maxLogBytes>=maxEntryBytes,
      'private directory, scope identities and positive finite bounds required');
    const root=resolve(directory),scope=join(root,'service-admission',digest(stableAlgorithmJSON([serviceId,sessionId])));
    Object.defineProperties(this,{directory:{value:root,enumerable:true},serviceId:{value:serviceId,enumerable:true},
      sessionId:{value:sessionId,enumerable:true},maxEntries:{value:maxEntries,enumerable:true},
      maxEntryBytes:{value:maxEntryBytes,enumerable:true},maxLogBytes:{value:maxLogBytes,enumerable:true},
      scopeDirectory:{value:scope,enumerable:true}});
    this.#outcomes=new DurableSelectedServiceJournal({directory:join(scope,'outcomes'),maxBytes:maxEntryBytes});
  }
  entryPath(position){
    demand(Number.isSafeInteger(position)&&position>=1&&position<=this.maxEntries,'entry position exceeds bound');
    return join(this.scopeDirectory,position+'.json');
  }
  async #prepare(){
    await mkdir(this.directory,{recursive:true,mode:0o700});await syncDirectory(dirname(this.directory));
    const base=dirname(this.scopeDirectory);
    await mkdir(base,{recursive:true,mode:0o700});await syncDirectory(this.directory);
    await mkdir(this.scopeDirectory,{recursive:true,mode:0o700});await syncDirectory(base);
  }
  // Separate synchronization permits deterministic failure controls to prove
  // that observing an unacknowledged link alone never grants durable authority.
  async _synchronize(){await syncDirectory(this.scopeDirectory);}
  async #readEntry(position){
    const h=await open(this.entryPath(position),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await h.stat();
      demand(stat.isFile()&&stat.size>=1&&stat.size<=this.maxEntryBytes,'invalid slot file or byte bound');
      const bytes=await h.readFile();demand(bytes.length<=this.maxEntryBytes,'entry exceeds byte bound');
      const entry=JSON.parse(bytes.toString('utf8'));
      demand(Buffer.from(stableAlgorithmJSON(entry),'utf8').equals(bytes),'noncanonical slot bytes');
      return {entry,bytes,receipt:receiptFor(entry,bytes)};
    }finally{await h.close();}
  }
  #action(action){
    validateSelectedServiceAction(action);
    demand(action.serviceId===this.serviceId&&action.sessionId===this.sessionId,'action belongs to another service session');
    return copy(action);
  }
  #owner(state,receipt){
    validateReceipt(receipt,this);
    const row=state.entries[receipt.position-1];
    demand(row&&eq(row.receipt,receipt)&&row.entry.command.kind==='owner','owner receipt has no matching authority entry');
    return row;
  }
  #replay(state,row){
    const {entry,receipt,bytes}=row;
    assertAlgorithmFields(entry,['schema','serviceId','sessionId','position','previous','command'],'service fence entry');
    demand(entry.schema==='semantic-service-fence-entry/8'&&entry.serviceId===this.serviceId&&
      entry.sessionId===this.sessionId&&entry.position===state.entries.length+1&&eq(entry.previous,state.head),
      'noncontiguous, substituted or foreign entry');
    demand(state.bytes+bytes.length<=this.maxLogBytes,'complete log exceeds byte bound');
    const command=entry.command;
    if(command?.kind==='owner'){
      assertAlgorithmFields(command,['kind','generation','ownerId','previous'],'service owner command');
      demand(!state.terminal&&identity(command.ownerId)&&Number.isSafeInteger(command.generation)&&
        command.generation===(state.owner?.generation??0)+1&&eq(command.previous,state.owner?.receipt??null),
        'owner transition does not extend the live authority');
      state.owner={generation:command.generation,ownerId:command.ownerId,receipt};
    }else if(command?.kind==='terminal'){
      assertAlgorithmFields(command,['kind','owner','reason'],'service terminal command');
      demand(!state.terminal&&state.owner&&eq(command.owner,state.owner.receipt)&&
        typeof command.reason==='string'&&command.reason.length>0&&Buffer.byteLength(command.reason)<=4096,
        'terminal transition does not bind the live authority');
      state.terminal={owner:copy(command.owner),reason:command.reason,receipt};
    }else if(command?.kind==='claim'){
      assertAlgorithmFields(command,['kind','owner','claim'],'service admission command');
      assertAlgorithmFields(command.claim,['schema','action'],'service admission claim');
      const action=this.#action(command.claim.action),key=selectedServiceActionKey(action);
      demand(command.claim.schema==='semantic-service-claim/8'&&!state.terminal&&state.owner&&
        eq(command.owner,state.owner.receipt)&&!state.actions.has(key),'new admission lacks current authority or repeats an action');
      state.actions.set(key,{action,owner:copy(command.owner),receipt});
    }else fail('unknown authority or admission command');
    state.entries.push(row);state.head=receipt;state.bytes+=bytes.length;
  }
  async #load(){
    const state={entries:[],head:null,owner:null,terminal:null,actions:new Map(),bytes:0},positions=[];
    let directory;
    try{directory=await opendir(this.scopeDirectory);}catch(error){if(error.code==='ENOENT')return state;throw error;}
    let count=0;
    for await(const entry of directory){
      demand(++count<=2*this.maxEntries+1,'directory entry bound exceeded');
      if(entry.name==='outcomes'){demand(entry.isDirectory(),'outcome directory must be ordinary');continue;}
      if(/^\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name)){
        demand(entry.isFile(),'temporary entry must be an ordinary file');continue;
      }
      demand(/^[1-9][0-9]*\.json$/.test(entry.name)&&entry.isFile(),'malformed position or nonordinary slot');
      const position=Number(entry.name.slice(0,-5));this.entryPath(position);positions.push(position);
      demand(positions.length<=this.maxEntries,'log entry bound exceeded');
    }
    positions.sort((left,right)=>left-right);
    for(let index=0;index<positions.length;index++){
      demand(positions[index]===index+1,'service admission log has a missing position');
      this.#replay(state,await this.#readEntry(index+1));
    }
    return state;
  }
  async _publishEntry(entry){
    const bytes=Buffer.from(stableAlgorithmJSON(entry));
    demand(bytes.length<=this.maxEntryBytes,'entry exceeds byte bound');
    const temporary=join(this.scopeDirectory,'.tmp-'+randomUUID());let claimed=true;
    try{
      const h=await open(temporary,'wx',0o600);
      try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
      try{await link(temporary,this.entryPath(entry.position));}
      catch(error){if(error.code!=='EEXIST')throw error;claimed=false;}
      // An identical occupied slot never recreates the winner's execution right.
      if(claimed)await this._synchronize();
    }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    return claimed;
  }
  async #update(select){
    await this.#prepare();
    for(let attempt=0;attempt<=this.maxEntries;attempt++){
      const state=await this.#load(),selection=select(state);
      if(selection.existing){
        // A prior link may have survived a directory-fsync/ack failure. Make
        // the observed authority durable again before acknowledging that fact.
        await this._synchronize();return {...selection.existing,claimed:false};
      }
      if(state.entries.length===this.maxEntries)refuse('journal-limit','Service admission log entry bound exhausted');
      const entry={schema:'semantic-service-fence-entry/8',serviceId:this.serviceId,sessionId:this.sessionId,
        position:state.entries.length+1,previous:state.head,command:copy(selection.command)},
        bytes=Buffer.from(stableAlgorithmJSON(entry)),receipt=receiptFor(entry,bytes);
      if(bytes.length>this.maxEntryBytes||state.bytes+bytes.length>this.maxLogBytes)
        refuse('journal-limit','Service admission log byte bound exhausted');
      this.#replay(state,{entry,bytes,receipt});
      if(await this._publishEntry(entry))return {entry,receipt,claimed:true};
    }
    refuse('journal-limit','Service admission contention exceeded the bounded log');
  }
  async advanceOwner({previous=null,ownerId}={}){
    demand(identity(ownerId),'bounded owner identity required');
    if(previous!==null)validateReceipt(previous,this);previous=copy(previous);
    const result=await this.#update(state=>{
      const parent=previous===null?null:this.#owner(state,previous),
        command={kind:'owner',generation:(parent?.entry.command.generation??0)+1,ownerId,previous},
        existing=state.entries.find(row=>eq(row.entry.command,command));
      if(existing)return {existing};
      if(state.terminal)refuse('session-terminal','Service session is durably terminal');
      if(!eq(previous,state.owner?.receipt??null))refuse('owner-conflict','Another service owner already advanced the expected authority');
      return {command};
    });
    return result.receipt;
  }
  async terminate({owner,reason}={}){
    validateReceipt(owner,this);owner=copy(owner);
    demand(typeof reason==='string'&&reason.length>0&&Buffer.byteLength(reason)<=4096,'bounded terminal reason required');
    const command={kind:'terminal',owner,reason};
    const result=await this.#update(state=>{
      this.#owner(state,owner);
      const existing=state.entries.find(row=>eq(row.entry.command,command));if(existing)return {existing};
      if(state.terminal)refuse('session-terminal','Service session already has a different terminal fence');
      if(!eq(owner,state.owner?.receipt))refuse('stale-owner','Only the current service owner can terminate admission');
      return {command};
    });
    return result.receipt;
  }
  forOwner(owner){
    validateReceipt(owner,this);owner=copy(owner);
    return Object.freeze({claim:action=>this.claim(action,{owner}),read:action=>this.read(action),
      complete:(action,outcome,receipt)=>this.complete(action,outcome,receipt)});
  }
  async claim(action,{owner}={}){
    action=this.#action(action);validateReceipt(owner,this);owner=copy(owner);
    const key=selectedServiceActionKey(action),actionDigest=selectedServiceActionDigest(action);
    const result=await this.#update(state=>{
      this.#owner(state,owner);
      const admitted=state.actions.get(key);
      if(admitted){
        demand(eq(admitted.action,action),'conflicting service action');
        return {existing:state.entries[admitted.receipt.position-1]};
      }
      if(state.terminal)refuse('session-terminal','Service session is durably terminal');
      if(!eq(owner,state.owner?.receipt))refuse('stale-owner','Service admission belongs to a newer owner');
      return {command:{kind:'claim',owner,claim:claimRecord(action)}};
    });
    const receipt=acknowledgement(action,result.claimed);
    if(result.claimed)this.#claims.set(receipt,{actionDigest,admission:result.receipt});
    return receipt;
  }
  async read(action){
    action=this.#action(action);
    const state=await this.#load(),admission=state.actions.get(selectedServiceActionKey(action));
    demand(admission&&eq(admission.action,action),'missing or conflicting service admission');
    let outcome=null;
    try{outcome=(await this.#outcomes.readBytes(selectedServiceActionKey(action),'outcome')).record;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(outcome){
      validateSelectedServiceOutcome(outcome,action);
      // A visible result may follow a failed acknowledgement; synchronize it
      // before the wrapper exposes an observed guest completion.
      await syncDirectory(this.#outcomes.directory);
    }
    return {action,outcome};
  }
  async complete(action,outcome,receipt){
    action=this.#action(action);validateSelectedServiceOutcome(outcome,action);outcome=copy(outcome);
    const grant=this.#claims.get(receipt);
    demand(grant?.actionDigest===selectedServiceActionDigest(action),
      'only the original acknowledged service claimant may record its result');
    const state=await this.#load(),admitted=state.actions.get(selectedServiceActionKey(action));
    demand(admitted&&eq(admitted.action,action)&&eq(admitted.receipt,grant.admission),'admission authority changed');
    // Authority changes deliberately do not revoke work already admitted.
    const result=await this.#outcomes.publish(selectedServiceActionKey(action),'outcome',outcome);
    this.#claims.delete(receipt);return result;
  }
  async inspect(){
    await this.#prepare();const state=await this.#load();
    if(state.head)await this._synchronize();
    return copy({head:state.head,owner:state.owner,terminal:state.terminal,
      admissions:[...state.actions].map(([key,row])=>({key,actionDigest:selectedServiceActionDigest(row.action),
        owner:row.owner,receipt:row.receipt})),bytes:state.bytes});
  }
}
