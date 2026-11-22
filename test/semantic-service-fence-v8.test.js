import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DurableFencedSelectedServiceJournal as Journal} from '../src/storage/selected-service-fence-journal.js';
import {createDurableSelectedService,SelectedServiceBoundaryError,selectedServiceActionDigest,selectedServiceActionKey}
  from '../src/host/selected-service.js';
import {SelectedExecutionLifecycleV8 as Lifecycle} from '../src/semantic/lifecycle-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const copy=structuredClone;
const options=directory=>({directory,serviceId:'fenced-store',sessionId:'session'});
async function directory(t){const path=await mkdtemp(join(tmpdir(),'v8-service-fence-'));
  t.after(()=>rm(path,{recursive:true,force:true}));return path;}
function context(effectId='effect',value=7){const payload=JSON.stringify(['key',value]),
  selectedAction={sessionId:'session',invocationId:'call',effectId,operation:'demo.store',
    idempotencyKey:'session/call/'+effectId,payload,payloadDigest:digest(payload),taskRevision:1,witness:'request '+effectId};
  return {...selectedAction,selectedAction};}
const action=c=>({schema:'semantic-service-action/8',serviceId:'fenced-store',...c.selectedAction});
const outcome=(a,value=7)=>({schema:'semantic-service-outcome/8',actionDigest:selectedServiceActionDigest(a),
  status:'fulfilled',result:['num',value],errorOrigin:null});
const adapter=(journal,owner,service)=>createDurableSelectedService({serviceId:'fenced-store',operation:'demo.store',
  journal:journal.forOwner(owner),service});
const code=wanted=>error=>error instanceof SelectedServiceBoundaryError&&error.code===wanted;
function child(t,configuration){
  const proc=fork(new URL('./fixtures/selected-service-fence-worker.mjs',import.meta.url),
    [JSON.stringify(configuration)],{stdio:['ignore','pipe','pipe','ipc']});
  let output='',errors='';const messages=[],waiters=[];
  proc.stdout.on('data',data=>{output+=data;});proc.stderr.on('data',data=>{errors+=data;});
  proc.on('message',message=>{messages.push(message);
    for(const waiter of [...waiters])if(waiter.phase===message.phase){
      waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message);
    }});
  const exit=new Promise((resolve,reject)=>{
    proc.on('error',reject);proc.once('exit',(code,signal)=>resolve({code,signal,output,errors}));
  });
  t.after(()=>{if(proc.exitCode===null)proc.kill();});
  return {proc,exit,phase:phase=>{
    const found=messages.find(row=>row.phase===phase);if(found)return Promise.resolve(found);
    return Promise.race([new Promise(resolve=>waiters.push({phase,resolve})),
      exit.then(result=>{throw new Error('Worker exited before '+phase+': '+JSON.stringify(result));})]);
  }};
}
async function noEffect(path){await assert.rejects(readFile(join(path,'effects.jsonl')),{code:'ENOENT'});}

test('owner transitions fence new actions while original outcomes remain readable across owners and terminal',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),old=await journal.advanceOwner({ownerId:'old'});
  let calls=0;const original=adapter(journal,old,()=>{calls++;return 7;});
  assert.equal(await original(['key',7],context()),7);
  const next=await journal.advanceOwner({previous:old,ownerId:'next'}),current=adapter(journal,next,()=>{calls++;return 7;});
  await assert.rejects(original(['key',7],context('new')),code('stale-owner'));
  assert.equal(await current(['key',7],context()),7);assert.equal(calls,1);
  await assert.rejects(current(['key',8],context('effect',8)),code('service-unavailable'));
  const terminal=await journal.terminate({owner:next,reason:'cancelled'});
  await assert.rejects(current(['key',7],context('new')),code('session-terminal'));
  assert.equal(await original(['key',7],context()),7);assert.equal(calls,1);
  await assert.rejects(journal.advanceOwner({previous:next,ownerId:'third'}),code('session-terminal'));
  assert.deepEqual(await journal.advanceOwner({previous:old,ownerId:'next'}),next,'retry acknowledges history without reactivating it');
  assert.deepEqual(await journal.terminate({owner:next,reason:'cancelled'}),terminal);
  const state=await new Journal(options(path)).inspect();
  assert.equal(state.owner.generation,2);assert.equal(state.head.position,4);assert.equal(state.admissions.length,1);
  assert.deepEqual(state.terminal.receipt,terminal);
});

test('a stale process with a precomputed admission slot cannot cross a successor or terminal fence',async t=>{
  for(const disposition of ['successor','terminal']){
    const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'old'}),
      old=child(t,{directory:path,owner,role:'old',mode:'pause-before-publish'});
    await old.phase('before-publish');
    if(disposition==='successor')await journal.advanceOwner({previous:owner,ownerId:'next'});
    else await journal.terminate({owner,reason:'cancelled'});
    old.proc.send('continue');
    assert.deepEqual(await old.phase('finished'),{phase:'finished',status:'refused',
      code:disposition==='successor'?'stale-owner':'session-terminal'});
    assert.equal((await old.exit).code,0);await noEffect(path);
    assert.equal((await journal.inspect()).admissions.length,0);
  }
});

test('an admission linked before acknowledgement may finish after successor and terminal fencing',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'old'}),
    old=child(t,{directory:path,owner,role:'old',mode:'pause-linked-claim'});
  await old.phase('linked');
  const next=await journal.advanceOwner({previous:owner,ownerId:'next'});
  await journal.terminate({owner:next,reason:'cancelled'});
  const waiting=child(t,{directory:path,owner:next,role:'next',mode:'read'});
  assert.deepEqual(await waiting.phase('finished'),{phase:'finished',status:'refused',code:'outcome-unknown'});
  assert.equal((await waiting.exit).code,0);await noEffect(path);
  old.proc.send('continue');
  assert.deepEqual(await old.phase('finished'),{phase:'finished',status:'fulfilled',value:7});
  assert.equal((await old.exit).code,0);
  const recovered=child(t,{directory:path,owner:next,role:'recovered',mode:'read'});
  assert.deepEqual(await recovered.phase('finished'),{phase:'finished',status:'fulfilled',value:7});
  assert.equal((await recovered.exit).code,0);
  assert.equal(await readFile(join(path,'effects.jsonl'),'utf8'),'old\n');
  const state=await journal.inspect();assert.equal(state.head.position,4);assert.equal(state.admissions.length,1);
});

test('two service processes sharing an owner receive at most one execution capability',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'owner'}),
    workers=['first','second'].map(role=>child(t,{directory:path,owner,role,mode:'race-claim'}));
  await Promise.all(workers.map(worker=>worker.phase('ready')));workers.forEach(worker=>worker.proc.send('start'));
  const winner=await Promise.any(workers.map((worker,index)=>worker.phase('effect-recorded').then(()=>index))),loser=1-winner;
  assert.deepEqual(await workers[loser].phase('finished'),{phase:'finished',status:'refused',code:'outcome-unknown'});
  workers[winner].proc.send('continue');
  assert.deepEqual(await workers[winner].phase('finished'),{phase:'finished',status:'fulfilled',value:7});
  assert.deepEqual((await Promise.all(workers.map(worker=>worker.exit))).map(row=>row.code),[0,0]);
  assert.equal((await journal.inspect()).admissions.length,1);
  assert.equal(await readFile(join(path,'effects.jsonl'),'utf8'),['first','second'][winner]+'\n');
});

test('competing successor processes compare the same expected owner instead of both advancing it',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'old'}),
    workers=['first','second'].map(role=>child(t,{directory:path,owner,role,mode:'advance'}));
  await Promise.all(workers.map(worker=>worker.phase('ready')));workers.forEach(worker=>worker.proc.send('start'));
  const results=await Promise.all(workers.map(worker=>worker.phase('finished')));
  assert.equal(results.filter(result=>result.status==='advanced').length,1);
  assert.equal(results.filter(result=>result.code==='owner-conflict').length,1);
  assert.deepEqual((await Promise.all(workers.map(worker=>worker.exit))).map(row=>row.code),[0,0]);
  const state=await journal.inspect();assert.equal(state.owner.generation,2);assert.equal(state.head.position,2);
  await assert.rejects(journal.terminate({owner,reason:'stale cancellation'}),code('stale-owner'));
});

test('process death after admission link or effect never makes unknown work executable again',async t=>{
  for(const mode of ['crash-linked-claim','crash-after-effect']){
    const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'old'}),
      old=child(t,{directory:path,owner,role:'old',mode});
    assert.equal((await old.exit).code,17);
    const next=await journal.advanceOwner({previous:owner,ownerId:'next'});
    await journal.terminate({owner:next,reason:'cancelled'});
    const recovered=child(t,{directory:path,owner:next,role:'recovered',mode:'read'});
    assert.deepEqual(await recovered.phase('finished'),{phase:'finished',status:'refused',code:'outcome-unknown'});
    assert.equal((await recovered.exit).code,0);
    if(mode==='crash-linked-claim')await noEffect(path);
    else assert.equal(await readFile(join(path,'effects.jsonl'),'utf8'),'old\n');
    assert.equal((await journal.inspect()).admissions.length,1);
  }
});

test('owner and terminal lost acknowledgements require directory fsync again on retry and inspection',async t=>{
  class UnavailableSync extends Journal {
    unavailable=false;syncs=0;
    async _synchronize(){this.syncs++;if(this.unavailable)throw Error('directory sync unavailable');return super._synchronize();}
  }
  const path=await directory(t),journal=new UnavailableSync(options(path));journal.unavailable=true;
  await assert.rejects(journal.advanceOwner({ownerId:'owner'}),/sync unavailable/);
  assert.equal(JSON.parse(await readFile(journal.entryPath(1),'utf8')).command.kind,'owner');
  await assert.rejects(journal.advanceOwner({ownerId:'owner'}),/sync unavailable/);
  await assert.rejects(journal.inspect(),/sync unavailable/);assert.equal(journal.syncs,3);
  journal.unavailable=false;const owner=await journal.advanceOwner({ownerId:'owner'});
  assert.equal(owner.position,1);journal.unavailable=true;
  await assert.rejects(journal.terminate({owner,reason:'cancelled'}),/sync unavailable/);
  await assert.rejects(journal.terminate({owner,reason:'cancelled'}),/sync unavailable/);
  await assert.rejects(journal.inspect(),/sync unavailable/);assert.equal(journal.syncs,7);
  await assert.rejects(journal.claim(action(context()),{owner}),code('session-terminal'));
  journal.unavailable=false;
  const terminal=await journal.terminate({owner,reason:'cancelled'});
  assert.equal(terminal.position,2);assert.deepEqual((await journal.inspect()).terminal.receipt,terminal);
  assert.deepEqual((await readdir(journal.scopeDirectory)).sort(),['1.json','2.json']);
});

test('claim publication failures stop dispatch and occupied unacknowledged claims stay unknown',async t=>{
  for(const stage of ['before-link','before-sync','after-sync']){
    class Broken extends Journal {
      async _publishEntry(entry){
        if(entry.command.kind!=='claim')return super._publishEntry(entry);
        if(stage==='before-link')throw Error('publication unavailable');
        this.claiming=true;await super._publishEntry(entry);throw Error('acknowledgement lost');
      }
      async _synchronize(){if(this.claiming&&stage==='before-sync')throw Error('directory sync unavailable');
        return super._synchronize();}
    }
    const path=await directory(t),journal=new Broken(options(path)),owner=await journal.advanceOwner({ownerId:'owner'});
    let calls=0;
    await assert.rejects(adapter(journal,owner,()=>{calls++;return 7;})(['key',7],context()),code('service-unavailable'));
    assert.equal(calls,0);
    const recovery=new Journal(options(path)),next=adapter(recovery,owner,()=>{calls++;return 7;});
    if(stage==='before-link')assert.equal(await next(['key',7],context()),7);
    else await assert.rejects(next(['key',7],context()),code('outcome-unknown'));
    assert.equal(calls,stage==='before-link'?1:0);
  }
});

test('lost outcome acknowledgement recovers after terminal while missing outcome remains unknown',async t=>{
  for(const published of [false,true]){
    const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'owner'}),
      bound=journal.forOwner(owner);let calls=0;
    const first=createDurableSelectedService({serviceId:'fenced-store',operation:'demo.store',
      journal:{...bound,complete:async(...args)=>{if(published)await bound.complete(...args);throw Error('lost result acknowledgement');}},
      service:()=>{calls++;return 7;}});
    await assert.rejects(first(['key',7],context()),code('service-unavailable'));
    await journal.terminate({owner,reason:'cancelled'});
    const next=adapter(new Journal(options(path)),owner,()=>{calls++;return 8;});
    if(published)assert.equal(await next(['key',7],context()),7);
    else await assert.rejects(next(['key',7],context()),code('outcome-unknown'));
    assert.equal(calls,1);
  }
});

test('only the acknowledged process capability may complete an admitted action, including after terminal',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'owner'}),
    a=action(context()),receipt=await journal.claim(a,{owner});
  await assert.rejects(journal.complete(a,outcome(a),copy(receipt)),/original acknowledged service claimant/);
  await assert.rejects(new Journal(options(path)).complete(a,outcome(a),receipt),/original acknowledged service claimant/);
  const next=await journal.advanceOwner({previous:owner,ownerId:'next'});
  assert.equal((await journal.claim(a,{owner:next})).claimed,false);
  await journal.terminate({owner:next,reason:'cancelled'});
  await journal.complete(a,outcome(a),receipt);
  assert.deepEqual((await journal.read(a)).outcome,outcome(a));
  await assert.rejects(journal.complete(a,outcome(a,8),receipt),/original acknowledged service claimant/);
});

test('scope, authority shape and captured owner cannot be replaced by caller metadata',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'owner'}),
    a=action(context());
  await assert.rejects(journal.claim(a),/receipt.*fields/);
  await assert.rejects(journal.advanceOwner({ownerId:['owner']}),/owner identity/);
  for(const change of [{serviceId:'other'},{sessionId:'other'},{id:'0'.repeat(64)},{bytes:owner.bytes+1},
    {position:2},{extra:true}])await assert.rejects(journal.claim(a,{owner:{...owner,...change}}));
  for(const key of ['serviceId','sessionId'])await assert.rejects(journal.claim({...a,[key]:'other'},{owner}),/another service session/);
  let hooks=0;const malformed={...owner};Object.defineProperty(malformed,'id',{enumerable:true,get(){hooks++;return owner.id;}});
  assert.throws(()=>journal.forOwner(malformed));assert.equal(hooks,0);
  const captured=copy(owner),bound=journal.forOwner(captured),next=await journal.advanceOwner({previous:owner,ownerId:'next'});
  Object.assign(captured,next);
  await assert.rejects(bound.claim(a),code('stale-owner'));
  const terminal=await journal.terminate({owner:next,reason:'cancelled'});
  await assert.rejects(journal.forOwner(terminal).claim(a),/owner receipt has no matching authority entry/);
  assert.equal((await journal.inspect()).admissions.length,0);
});

test('all slots, canonical bytes and state transitions are replayed before admission',async t=>{
  for(const mutation of ['gap','zero','leading-zero','oversized-position','extra','symlink','foreign','previous',
    'generation','fields','utf8','after-terminal']){
    const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'owner'}),
      next=await journal.advanceOwner({previous:owner,ownerId:'next'}),terminal=await journal.terminate({owner:next,reason:'cancelled-\ufffd'});
    const filename=journal.entryPath(2),record=JSON.parse(await readFile(filename,'utf8'));
    if(mutation==='gap')await rm(filename);
    if(mutation==='zero')await writeFile(join(journal.scopeDirectory,'0.json'),'{}');
    if(mutation==='leading-zero')await writeFile(join(journal.scopeDirectory,'02.json'),'{}');
    if(mutation==='oversized-position')await writeFile(join(journal.scopeDirectory,'9007199254740992.json'),'{}');
    if(mutation==='extra')await writeFile(join(journal.scopeDirectory,'ignored.json'),'{}');
    if(mutation==='symlink'){await rm(filename);await symlink(journal.entryPath(1),filename);}
    if(mutation==='foreign')await writeFile(filename,stableAlgorithmJSON({...record,sessionId:'other'}));
    if(mutation==='previous')await writeFile(filename,stableAlgorithmJSON({...record,previous:{...record.previous,id:'0'.repeat(64)}}));
    if(mutation==='generation')await writeFile(filename,stableAlgorithmJSON({...record,command:{...record.command,generation:3}}));
    if(mutation==='fields')await writeFile(filename,stableAlgorithmJSON({...record,unbound:true}));
    if(mutation==='utf8'){
      const file=journal.entryPath(3),bytes=await readFile(file),position=bytes.indexOf(Buffer.from('\ufffd'));
      assert(position>=0);await writeFile(file,Buffer.concat([bytes.subarray(0,position),Buffer.from([0xff]),bytes.subarray(position+3)]));
    }
    if(mutation==='after-terminal')await writeFile(journal.entryPath(4),stableAlgorithmJSON({
      schema:'semantic-service-fence-entry/8',serviceId:'fenced-store',sessionId:'session',position:4,previous:terminal,
      command:{kind:'owner',generation:3,ownerId:'illegal',previous:next}}));
    await assert.rejects(journal.inspect());
    let calls=0;await assert.rejects(adapter(journal,next,()=>{calls++;return 7;})(['key',7],context()));assert.equal(calls,0);
  }
});

test('entry and byte exhaustion refuse new authority or admission without invalidating retained results',async t=>{
  const path=await directory(t),journal=new Journal({...options(path),maxEntries:2}),
    owner=await journal.advanceOwner({ownerId:'owner'});let calls=0;
  const store=adapter(journal,owner,()=>{calls++;return 7;});assert.equal(await store(['key',7],context()),7);
  await assert.rejects(store(['key',7],context('new')),code('journal-limit'));
  await assert.rejects(journal.terminate({owner,reason:'cancelled'}),code('journal-limit'));
  await assert.rejects(journal.advanceOwner({previous:owner,ownerId:'next'}),code('journal-limit'));
  assert.equal(await store(['key',7],context()),7);assert.equal(calls,1);
  assert.equal((await journal.inspect()).terminal,null,'capacity failure is never a terminal acknowledgement');
  const smallPath=await directory(t),small=new Journal({...options(smallPath),maxEntryBytes:512}),
    smallOwner=await small.advanceOwner({ownerId:'owner'});
  await assert.rejects(small.claim(action(context()),{owner:smallOwner}),code('journal-limit'));
  const logPath=await directory(t),log=new Journal({...options(logPath),maxEntryBytes:2000,maxLogBytes:2000}),
    logOwner=await log.advanceOwner({ownerId:'owner'});
  await log.claim(action(context()),{owner:logOwner});
  await assert.rejects(log.claim(action(context('second')),{owner:logOwner}),code('journal-limit'));
});

test('selected lifecycle propagates stale admission as a boundary failure without inventing guest completion',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),owner=await journal.advanceOwner({ownerId:'old'});
  let calls=0;const source='"use strict";function run(){return host.store("key",7);}',
    h=new Lifecycle({sessionId:'session',services:{'demo.store':adapter(journal,owner,()=>{calls++;return 7;})}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.store']});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside'});
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation==='demo.store');
  h.selected('call',encodeDetailedRecord({kind:'request',fields:{effect:'effect',operation:'demo.store',invocation:'call',
    arguments:[['str','key'],['num',7]],site:{start,end},payload:'["key",7]'}}));
  await journal.advanceOwner({previous:owner,ownerId:'next'});
  await assert.rejects(h.dispatch('call','effect'),code('stale-owner'));
  assert.equal(calls,0);assert.equal(h.intents.get('call/effect').status,'uncertain');
  assert.equal(h.timeline.filter(row=>row.kind==='result').length,0);
});


test('service recovery listing links exact admissions to independently read outcomes and preserves unknowns',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),
    oldOwner=await journal.advanceOwner({ownerId:'previous'}),
    owner=await journal.advanceOwner({previous:oldOwner,ownerId:'owner'}),
    settledAction=action(context('settled',11)),unknownAction=action(context('uncertain',13)),
    settledClaim=await journal.claim(settledAction,{owner}),
    unknownClaim=await journal.claim(unknownAction,{owner}),
    settledOutcome=outcome(settledAction,11);
  await journal.complete(settledAction,settledOutcome,settledClaim);
  const reason='bounded terminal fence after child settlement',
    terminal=await journal.terminate({owner,reason}),
    listing=await journal.inspectRecovery({owner,terminal,reason});
  assert.equal(listing.schema,'semantic-service-recovery-listing/8');
  assert.equal(listing.serviceId,'fenced-store');assert.equal(listing.sessionId,'session');
  assert.deepEqual(listing.head,terminal);assert.deepEqual(listing.terminal.receipt,terminal);
  assert.deepEqual(listing.owner.receipt,owner);assert.equal(listing.terminal.reason,reason);
  assert.equal(listing.allOutcomesKnown,false);
  const settled=listing.actions.find(row=>row.key===selectedServiceActionDigest(settledAction)||
    row.action.effectId==='settled');
  const unknown=listing.actions.find(row=>row.action.effectId==='uncertain');
  assert(settled&&unknown);assert.deepEqual(settled.action,settledAction);
  assert.deepEqual(settled.fenceClaimReceipt,(await journal.inspect()).admissions
    .find(row=>row.actionDigest===selectedServiceActionDigest(settledAction)).receipt);
  assert.deepEqual(settled.owner,owner);
  assert.equal(settled.outcome.status,'observed');
  assert.deepEqual(settled.outcome.record,settledOutcome);
  assert.equal(settled.outcome.digest,digest(stableAlgorithmJSON(settledOutcome)));
  assert.equal(settled.outcome.bytes,Buffer.byteLength(stableAlgorithmJSON(settledOutcome)));
  assert.deepEqual(unknown.action,unknownAction);
  assert.deepEqual(unknown.fenceClaimReceipt,(await journal.inspect()).admissions
    .find(row=>row.actionDigest===selectedServiceActionDigest(unknownAction)).receipt);
  assert.deepEqual(unknown.outcome,{schema:'semantic-service-outcome-readback/8',status:'unknown'},
    'a claim with no durable result remains explicitly unknown');
  assert.equal(listing.digest,digest(stableAlgorithmJSON(Object.fromEntries(
    Object.entries(listing).filter(([key])=>key!=='digest')))));
  await assert.rejects(journal.inspectRecovery({owner:oldOwner,terminal,reason}),
    /exact current owner, terminal fence and head/,
    'a prior owner receipt cannot substitute for the exact current terminal owner');
  await assert.rejects(journal.inspectRecovery({owner,terminal:owner,reason}),
    /exact current owner, terminal fence and head/);
  const changedReason='different terminal reason';
  await assert.rejects(journal.inspectRecovery({owner,terminal,reason:changedReason}),
    /exact current owner, terminal fence and head/);
  await journal.complete(unknownAction,outcome(unknownAction,13),unknownClaim);
  const retried=await journal.inspectRecovery({owner,terminal,reason});
  assert.equal(retried.allOutcomesKnown,true);
  assert.equal(retried.actions.find(row=>row.action.effectId==='uncertain').outcome.status,'observed',
    'a later exact outcome read becomes observable without re-executing the action');
});


test('service recovery listing rejects altered action chains and outcome bindings',async t=>{
  const actionPath=await directory(t),actionJournal=new Journal(options(actionPath)),
    owner=await actionJournal.advanceOwner({ownerId:'owner'}),
    selected=action(context('effect-action',17)),claim=await actionJournal.claim(selected,{owner}),
    reason='service reconciliation',
    terminal=await actionJournal.terminate({owner,reason}),
    admission=(await actionJournal.inspect()).admissions[0],
    entryPath=actionJournal.entryPath(admission.receipt.position),
    entry=JSON.parse(await readFile(entryPath,'utf8'));
  entry.command.claim.action.witness='substituted action witness';
  await writeFile(entryPath,stableAlgorithmJSON(entry));
  await assert.rejects(actionJournal.inspectRecovery({owner,terminal,reason}),
    /digest|predecessor|chain|action/i,
    'an action replacement cannot survive the retained fence chain');

  const outcomePath=await directory(t),outcomeJournal=new Journal(options(outcomePath)),
    outcomeOwner=await outcomeJournal.advanceOwner({ownerId:'owner'}),
    outcomeAction=action(context('effect-outcome',19)),
    outcomeClaim=await outcomeJournal.claim(outcomeAction,{owner:outcomeOwner}),
    outcomeTerminal=await outcomeJournal.terminate({owner:outcomeOwner,reason}),
    outcomeKey=selectedServiceActionKey(outcomeAction),
    outcomeFilename=join(outcomeJournal.scopeDirectory,'outcomes',outcomeKey+'.outcome.json');
  const tampered=outcome(outcomeAction,19);
  tampered.actionDigest='0'.repeat(64);
  await mkdir(join(outcomeJournal.scopeDirectory,'outcomes'),{recursive:true,mode:0o700});
  await writeFile(outcomeFilename,stableAlgorithmJSON(tampered),{mode:0o600});
  await assert.rejects(outcomeJournal.inspectRecovery({owner:outcomeOwner,
    terminal:outcomeTerminal,reason}),/outcome action identity|outcome/i,
    'an outcome bound to a different action is never recovery evidence');
  assert(claim&&outcomeClaim);
});

test('an outcome published during recovery inspection remains unknown in that read',async t=>{
  const path=await directory(t);
  class RacedJournal extends Journal{
    syncs=0;race=null;
    async _synchronize(){
      await super._synchronize();
      if(this.race&&++this.syncs===2){
        const {action,record}=this.race,key=selectedServiceActionKey(action),
          outcomeDirectory=join(this.scopeDirectory,'outcomes');
        await mkdir(outcomeDirectory,{recursive:true,mode:0o700});
        await writeFile(join(outcomeDirectory,key+'.outcome.json'),stableAlgorithmJSON(record),{mode:0o600});
        this.race=null;
      }
    }
  }
  const journal=new RacedJournal(options(path)),owner=await journal.advanceOwner({ownerId:'owner'}),
    selected=action(context('race',23)),claim=await journal.claim(selected,{owner}),
    reason='terminal reconciliation',terminal=await journal.terminate({owner,reason});
  journal.syncs=0;
  journal.race={action:selected,record:outcome(selected,23)};
  const first=await journal.inspectRecovery({owner,terminal,reason});
  assert.equal(first.allOutcomesKnown,false);
  assert.deepEqual(first.actions[0].outcome,{schema:'semantic-service-outcome-readback/8',status:'unknown'},
    'a result that appears after the read cannot change unknown into settled mid-snapshot');
  const next=await journal.inspectRecovery({owner,terminal,reason});
  assert.equal(next.allOutcomesKnown,true);
  assert.equal(next.actions[0].outcome.status,'observed');
  assert.deepEqual(next.actions[0].outcome.record,outcome(selected,23));
  assert(claim);
});


test('active service recovery listing is read-only, owner-bound and leaves missing outcomes unknown',async t=>{
  const path=await directory(t),journal=new Journal(options(path)),
    staleOwner=await journal.advanceOwner({ownerId:'old'}),
    owner=await journal.advanceOwner({previous:staleOwner,ownerId:'current'}),
    selected=action(context('active-unknown',29));
  await journal.claim(selected,{owner});
  await assert.rejects(journal.inspectActiveRecovery({owner:staleOwner}),
    /exact current owner and no terminal fence/);
  const listing=await journal.inspectActiveRecovery({owner});
  assert.equal(listing.schema,'semantic-service-active-recovery-listing/8');
  assert.deepEqual(listing.owner.receipt,owner);
  assert.equal(listing.terminal,null);
  assert.equal(listing.allOutcomesKnown,false);
  assert.deepEqual(listing.actions[0].action,selected);
  assert.deepEqual(listing.actions[0].outcome,{schema:'semantic-service-outcome-readback/8',status:'unknown'});
});

test('active recovery listing refuses admission, owner or terminal changes during outcome reads',async t=>{
  class RacedJournal extends Journal{
    syncs=0;race=null;
    async _synchronize(){
      await super._synchronize();
      if(this.race&&++this.syncs===2){
        const mutate=this.race;this.race=null;await mutate();
      }
    }
  }
  for(const mutation of ['admission','owner','terminal']){
    const path=await directory(t),journal=new RacedJournal(options(path)),
      owner=await journal.advanceOwner({ownerId:'owner'});
    if(mutation==='admission')await journal.claim(action(context('before-race',31)),{owner});
    const reason='active listing race';
    let terminal=null;
    journal.syncs=0;
    journal.race=async()=>{
      if(mutation==='admission')await journal.claim(action(context('during-race',37)),{owner});
      if(mutation==='owner')await journal.advanceOwner({previous:owner,ownerId:'successor'});
      if(mutation==='terminal')terminal=await journal.terminate({owner,reason});
    };
    await assert.rejects(journal.inspectActiveRecovery({owner}),
      /admission head, owner or action set changed during active recovery inspection/,
      mutation+' must be detected before a snapshot can be returned');
    if(mutation==='terminal'){
      assert(terminal,'the pre-read active owner had no terminal receipt');
      assert.equal((await journal.inspect()).terminal.reason,reason,
        'the race created an independently retained terminal fence');
    }
  }
});
