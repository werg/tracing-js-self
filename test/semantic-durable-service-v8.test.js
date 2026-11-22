import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {SelectedExecutionLifecycleV8 as Lifecycle} from '../src/semantic/lifecycle-v8.js';
import {RegionExecutionHarness as Region} from '../src/semantic/region-harness.js';
import {SelectedIntentJournal} from '../src/training/intent-journal.js';
import {DurableSelectedServiceJournal} from '../src/storage/selected-service-journal.js';
import {createDurableSelectedService,SelectedServiceBoundaryError,selectedServiceActionKey,
  selectedServiceActionDigest} from '../src/host/selected-service.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const source='"use strict";function run(){return host.store("key",7);}';
const copy=value=>JSON.parse(JSON.stringify(value));
const digest=value=>createHash('sha256').update(value).digest('hex');
const select=(h,kind,fields)=>h instanceof Region?h.select('call',{kind,fields}):
  h.selected('call',encodeDetailedRecord({kind,fields}));
function fixture(options={},H=Lifecycle){
  const h=new H({sessionId:'durable-service',...options});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.store']});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside'});
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation==='demo.store');
  select(h,'request',{effect:'e',operation:'demo.store',invocation:'call',arguments:[['str','key'],['num',7]],
    site:{start,end},payload:'["key",7]'});
  return h;
}
async function directory(t){
  const path=await mkdtemp(join(tmpdir(),'v8-service-'));t.after(()=>rm(path,{recursive:true,force:true}));
  return path;
}
function wrap(journal,overrides){return {claim:journal.claim.bind(journal),read:journal.read.bind(journal),
  complete:journal.complete.bind(journal),...overrides};}
function service(journal,implementation){return createDurableSelectedService({serviceId:'controlled-store',
  operation:'demo.store',journal,service:implementation});}
function context(value=7){
  const payload=JSON.stringify(['key',value]),selectedAction={sessionId:'durable-service',invocationId:'call',
    effectId:'e',operation:'demo.store',idempotencyKey:'durable-service/call/e',payload,
    payloadDigest:digest(payload),taskRevision:1,witness:'request e'};
  return {...selectedAction,selectedAction};
}
function action(c=context()){return {schema:'semantic-service-action/8',serviceId:'controlled-store',...c.selectedAction};}
const boundary=error=>error instanceof SelectedServiceBoundaryError;
function child(t,configuration,worker='./fixtures/durable-selected-service-worker.mjs'){
  const proc=fork(new URL(worker,import.meta.url),
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

test('two independent service workers race one atomic execution claim',async t=>{
  const path=await directory(t);await writeFile(join(path,'before.json'),JSON.stringify(fixture().checkpoint()));
  const workers=['one','two'].map(role=>child(t,{directory:path,role,mode:'race-service'}));
  await Promise.all(workers.map(worker=>worker.phase('ready')));
  for(const worker of workers)worker.proc.send('start');
  const winner=await Promise.any(workers.map((worker,index)=>worker.phase('effect-recorded').then(()=>index))),
    loser=1-winner;
  assert.deepEqual(await workers[loser].phase('finished'),
    {phase:'finished',status:'uncertain',code:'outcome-unknown',results:0});
  workers[winner].proc.send('continue');
  assert.deepEqual(await workers[winner].phase('finished'),
    {phase:'finished',status:'settled',results:1,replay:true});
  assert.deepEqual((await Promise.all(workers.map(worker=>worker.exit))).map(row=>row.code),[0,0]);
  assert.equal(await readFile(join(path,'effects.jsonl'),'utf8'),['one','two'][winner]+'\n');
});

test('a successor may reach the service before the paused old producer without executing twice',async t=>{
  const path=await directory(t);await writeFile(join(path,'before.json'),JSON.stringify(fixture().checkpoint()));
  const old=child(t,{directory:path,role:'old',mode:'pause-producer-claim'});
  await old.phase('producer-claimed');
  const successor=child(t,{directory:path,role:'successor',mode:'recover'});
  assert.deepEqual(await successor.phase('finished'),{phase:'finished',status:'settled',results:1,replay:true});
  assert.equal((await successor.exit).code,0);
  old.proc.send('continue');
  assert.deepEqual(await old.phase('finished'),{phase:'finished',status:'settled',results:1,replay:true});
  assert.equal((await old.exit).code,0);
  assert.equal(await readFile(join(path,'effects.jsonl'),'utf8'),'successor\n');
});

test('a paused service claimant fences a successor and its later durable outcome survives a fresh process',async t=>{
  const path=await directory(t);await writeFile(join(path,'before.json'),JSON.stringify(fixture().checkpoint()));
  const old=child(t,{directory:path,role:'old',mode:'pause-service-claim'});
  await old.phase('service-claimed');
  const successor=child(t,{directory:path,role:'successor',mode:'recover'});
  assert.deepEqual(await successor.phase('finished'),{phase:'finished',status:'uncertain',code:'outcome-unknown',results:0});
  assert.equal((await successor.exit).code,0);
  await assert.rejects(readFile(join(path,'effects.jsonl')),{code:'ENOENT'});
  old.proc.send('continue');await old.phase('finished');assert.equal((await old.exit).code,0);
  const restored=child(t,{directory:path,role:'restored',mode:'recover',packetName:'successor.json'});
  assert.deepEqual(await restored.phase('finished'),{phase:'finished',status:'settled',results:1,replay:true});
  assert.equal((await restored.exit).code,0);
  assert.equal(await readFile(join(path,'effects.jsonl'),'utf8'),'old\n');
});

test('service process death after its external effect leaves an unknown result and forbids another execution',async t=>{
  const path=await directory(t);await writeFile(join(path,'before.json'),JSON.stringify(fixture().checkpoint()));
  const old=child(t,{directory:path,role:'old',mode:'crash-after-effect'});
  assert.equal((await old.exit).code,17);
  for(const role of ['successor','third']){
    const next=child(t,{directory:path,role,mode:'recover',
      packetName:role==='third'?'successor.json':'before.json'});
    assert.deepEqual(await next.phase('finished'),{phase:'finished',status:'uncertain',code:'outcome-unknown',results:0});
    assert.equal((await next.exit).code,0);
  }
  assert.equal(await readFile(join(path,'effects.jsonl'),'utf8'),'old\n');
});

test('claim publication and acknowledgement failures stop before the service and never become guest results',async t=>{
  for(const afterPublication of [false,true]){
    const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
    const adapter=service(wrap(journal,{claim:async request=>{
      if(afterPublication)await journal.claim(request);throw Error('claim acknowledgement unavailable');
    }}),()=>{calls++;return 7;});
    const h=fixture({services:{'demo.store':adapter}});
    await assert.rejects(h.dispatch('call','e'),boundary);
    assert.equal(h.intents.get('call/e').status,'uncertain');
    assert.equal(h.timeline.filter(row=>row.kind==='result').length,0);assert.equal(calls,0);
    const restored=Lifecycle.restore(copy(h.checkpoint()),{services:{'demo.store':service(journal,()=>{calls++;return 7;})}});
    restored.reconcile('call','e',{disposition:'not-dispatched',evidenceId:'controlled-retry'});
    if(afterPublication){
      await assert.rejects(restored.dispatch('call','e'),error=>boundary(error)&&error.code==='outcome-unknown');
      assert.equal(calls,0);
    }else{await restored.dispatch('call','e');assert.equal(calls,1);}
  }
});

test('a lost outcome acknowledgement recovers exact durable bytes while an unpublished outcome remains unknown',async t=>{
  for(const afterPublication of [false,true])for(const H of [Lifecycle,Region]){
    const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
    const adapter=service(wrap(journal,{complete:async(...args)=>{
      if(afterPublication)await journal.complete(...args);throw Error('outcome acknowledgement unavailable');
    }}),()=>{calls++;return 7;});
    const h=fixture({services:{'demo.store':adapter}},H);
    await assert.rejects(h.dispatch('call','e'),boundary);
    assert.equal(h.intents.get('call/e').status,'uncertain');assert.equal(calls,1);
    const restored=H.restore(copy(h.checkpoint()),{services:{'demo.store':service(journal,()=>{calls++;return 8;})}});
    const core=H===Region?restored.inner:restored;
    core.reconcile('call','e',{disposition:'not-dispatched',evidenceId:'controlled-retry'});
    if(afterPublication){
      await restored.dispatch('call','e');assert.deepEqual(restored.intents.get('call/e').result.result,['num',7]);
      select(restored,'return',{value:['num',7]});select(restored,'end',{kind:'return'});
      assert.deepEqual(H.replay(restored.exportEpisode()).exportEpisode(),restored.exportEpisode());
    }else await assert.rejects(restored.dispatch('call','e'),error=>boundary(error)&&error.code==='outcome-unknown');
    assert.equal(calls,1);
  }
});

test('a concurrent outcome read must synchronize after the outcome link even when the duplicate claim was durable earlier',async t=>{
  for(const fenced of [false,true]){
    const path=await directory(t),worker=child(t,{directory:path,fenced},'./fixtures/selected-service-outcome-sync-worker.mjs');
    assert.deepEqual(await worker.phase('finished'),{
      phase:'finished',observed:{status:'refused',code:'service-unavailable',causeCode:'EIO'},
      published:{status:'refused',code:'service-unavailable',causeCode:'EIO'},
      readerSynchronizations:1,recovered:7,calls:1
    });
    assert.equal((await worker.exit).code,0);
  }
});

test('different request bytes or caller idempotency keys cannot mint another right for one logical action',async t=>{
  const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
  const adapter=service(journal,()=>{calls++;return 7;});
  assert.equal(await adapter(['key',7],context()),7);
  for(const changed of [context(8),(()=>{const c=context();
    c.idempotencyKey=c.selectedAction.idempotencyKey='different-key';return c;})()]){
    await assert.rejects(adapter(JSON.parse(changed.payload),changed),boundary);
  }
  const changedOperation=createDurableSelectedService({serviceId:'controlled-store',operation:'demo.readNumber',journal,
    service:()=>{calls++;return 8;}}),c=context();
  c.operation=c.selectedAction.operation='demo.readNumber';
  c.payload=c.selectedAction.payload='["key"]';c.payloadDigest=c.selectedAction.payloadDigest=digest(c.payload);
  await assert.rejects(changedOperation(['key'],c),boundary);
  assert.equal(calls,1);
});

test('bound arguments and hook-free request records are checked before any durable service claim',async t=>{
  const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0,reads=0;
  const adapter=service(journal,()=>{calls++;return 7;});
  await assert.rejects(adapter(['other',7],context()),boundary);
  const c=context();Object.defineProperty(c.selectedAction,'payload',{enumerable:true,get(){reads++;return '["key",7]';}});
  await assert.rejects(adapter(['key',7],c),boundary);
  assert.equal(reads,0);assert.equal(calls,0);assert.deepEqual(await readdir(path),[]);
});

test('array-shaped identities cannot be coerced into service or logical action names',async t=>{
  const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
  const options={serviceId:'controlled-store',operation:'demo.store',journal,service:()=>{calls++;return 7;}};
  assert.throws(()=>createDurableSelectedService({...options,serviceId:['controlled-store']}),/service ID/);
  assert.throws(()=>createDurableSelectedService({...options,operation:['demo.store']}),/operation must be a string/);
  for(const key of ['serviceId','sessionId','invocationId','effectId','operation']){
    const a=action();a[key]=[a[key]];
    await assert.rejects(journal.claim(a),/identity|operation must be a string/);
  }
  for(const key of ['sessionId','invocationId','effectId']){
    const c=context();c[key]=c.selectedAction[key]=[c[key]];
    await assert.rejects(createDurableSelectedService(options)(['key',7],c),boundary);
  }
  assert.equal(calls,0);assert.deepEqual(await readdir(path),[]);
});

test('claims and outcomes require exact byte-bound acknowledgements before proceeding',async t=>{
  for(const stage of ['claim','complete'])for(const field of ['digest','bytes','kind','extra']){
    const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
    const adapter=service(wrap(journal,{[stage]:async(...args)=>{
      const receipt=await journal[stage](...args);
      return {...receipt,[field]:field==='bytes'?receipt.bytes+1:field==='digest'?'0'.repeat(64):'changed'};
    }}),()=>{calls++;return 7;});
    const h=fixture({services:{'demo.store':adapter}});
    await assert.rejects(h.dispatch('call','e'),boundary);
    assert.equal(h.intents.get('call/e').status,'uncertain');
    assert.equal(h.timeline.filter(row=>row.kind==='result').length,0);
    assert.equal(calls,stage==='claim'?0:1);
  }
});

test('durable scalar outcomes preserve negative zero, nonfinite values, bigint and undefined after restart',async t=>{
  for(const value of [undefined,null,true,'original',-0,NaN,Infinity,-Infinity,1234567890123456789n]){
    const path=await directory(t);let calls=0;
    const first=service(new DurableSelectedServiceJournal({directory:path}),()=>{calls++;return value;});
    assert(Object.is(await first(['key',7],context()),value));
    const next=service(new DurableSelectedServiceJournal({directory:path}),()=>{calls++;return 'wrong';});
    assert(Object.is(await next(['key',7],context()),value));assert.equal(calls,1);
  }
});

test('original synchronous adapter throws and promise rejections keep their error origin on recovery',async t=>{
  for(const asynchronous of [false,true]){
    const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
    const adapter=service(journal,()=>{calls++;
      if(asynchronous)return Promise.reject(new Error('original failure'));throw new Error('original failure');});
    const initial=fixture().checkpoint();
    for(const h of [Lifecycle.restore(initial,{services:{'demo.store':adapter}}),
      Lifecycle.restore(initial,{services:{'demo.store':service(new DurableSelectedServiceJournal({directory:path}),
        ()=>{calls++;return 7;})}})]){
      await h.dispatch('call','e');
      const result=h.timeline.find(row=>row.kind==='result');
      assert.equal(result.status,'rejected');assert.equal(result.errorOrigin,asynchronous?'adapter-rejection':'adapter-throw');
      assert.deepEqual(result.result,['str','original failure']);
      assert.deepEqual(Lifecycle.replay(h.exportEpisode(),{requireTerminal:false}).timeline,h.timeline);
    }
    assert.equal(calls,1);
  }
});

test('callback and live-resource operations cannot claim durable scalar recovery',()=>{
  for(const operation of ['demo.listen','demo.withCallback','demo.unlisten','natlang.call','natlang.writeCell',
    'http.request','fs.openRead','dom.query'])assert.throws(()=>createDurableSelectedService({
      serviceId:'bounded',operation,journal:{claim(){},read(){},complete(){}},service(){}}),
    /callback-free, invocation-scoped scalar/);
});

test('a claimant cannot publish a different action, reuse a serialized receipt or overwrite an outcome',async t=>{
  const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path}),a=action();
  const receipt=await journal.claim(a),outcome={schema:'semantic-service-outcome/8',actionDigest:selectedServiceActionDigest(a),
    status:'fulfilled',result:['num',7],errorOrigin:null};
  await assert.rejects(journal.complete(a,outcome,copy(receipt)),/original acknowledged service claimant/);
  const different=action(context(8));
  await assert.rejects(journal.complete(different,{...outcome,actionDigest:selectedServiceActionDigest(different)},receipt),
    /original acknowledged service claimant/);
  await journal.complete(a,outcome,receipt);
  await assert.rejects(journal.complete(a,{...outcome,result:['num',8]},receipt),/original acknowledged service claimant/);
  assert.deepEqual((await journal.read(a)).outcome,outcome);
});

test('substituted, extended, noncanonical, malformed UTF-8 and symlinked retained outcomes fail closed',async t=>{
  for(const mutation of ['binding','extra','canonical','utf8','symlink']){
    const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
    const adapter=service(journal,()=>{calls++;return mutation==='utf8'?'\ufffd':7;});await adapter(['key',7],context());
    const filename=journal.path(selectedServiceActionKey(action()),'outcome'),original=JSON.parse(await readFile(filename,'utf8'));
    if(mutation==='binding')await writeFile(filename,stableAlgorithmJSON({...original,actionDigest:'0'.repeat(64)}));
    if(mutation==='extra')await writeFile(filename,stableAlgorithmJSON({...original,unbound:true}));
    if(mutation==='canonical')await writeFile(filename,JSON.stringify(original,null,2));
    if(mutation==='utf8'){
      const bytes=await readFile(filename),position=bytes.indexOf(Buffer.from('\ufffd'));
      assert(position>=0);await writeFile(filename,Buffer.concat([
        bytes.subarray(0,position),Buffer.from([0xff]),bytes.subarray(position+3)]));
    }
    if(mutation==='symlink'){
      await rm(filename);const target=join(path,'replacement.json');await writeFile(target,stableAlgorithmJSON(original));
      await symlink(target,filename);
    }
    await assert.rejects(adapter(['key',7],context()),boundary);assert.equal(calls,1);
  }
});

test('unsupported service outcomes or cancellation after claiming cannot release the execution right',async t=>{
  for(const scenario of ['unsupported-result','aborted']){
    const path=await directory(t),journal=new DurableSelectedServiceJournal({directory:path});let calls=0;
    const adapter=service(journal,()=>{calls++;return {};});const c=context();
    if(scenario==='aborted'){const controller=new AbortController();controller.abort();c.signal=controller.signal;}
    await assert.rejects(adapter(['key',7],c),boundary);
    await assert.rejects(service(journal,()=>{calls++;return 7;})(['key',7],context()),
      error=>boundary(error)&&error.code==='outcome-unknown');
    assert.equal(calls,scenario==='aborted'?0:1);
  }
});
