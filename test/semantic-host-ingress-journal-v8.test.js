import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {DurableHostIngressBroker,validateHostIngressLogChain} from '../src/semantic/host-ingress-journal-v8.js';
import {DurableHostIngressJournal} from '../src/storage/host-ingress-journal.js';
import {DurableHostIngressStore} from '../src/storage/host-ingress.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const record=(kind,fields)=>({kind,fields});
const source='"use strict";function run(){return;}function handler(value){return value;}';
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'v8-arrival-journal-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const h=new RegionExecutionHarness({sessionId:'durable-arrivals',automaticDelivery:false});
  h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'t',realmId:'r',triggerId:'outside',realmPolicy:'retained'});
  for(const subscriptionId of ['later','earlier'])h.registerEventHandler({subscriptionId,programId:'p',
    realmId:'r',trackId:'t',entry:'handler'});
  h.select('root',record('return',{value:['undefined']}));
  const journal=new DurableHostIngressJournal({directory,streamId:'events'});
  return {h,directory,journal,store:new DurableHostIngressStore({directory})};
}
const finish=(h,id,value=['undefined'])=>{
  h.select(id,record('return',{value}));h.select(id,record('end',{kind:'return'}));
};
async function until(predicate){
  for(let i=0;i<1000;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('expected asynchronous boundary');
}
function resealEntry(entry){return {schema:'semantic-host-ingress-log-receipt/8',streamId:entry.streamId,
  position:entry.position,id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))};}

test('arrival acknowledgement waits for durable bytes and snapshots caller graphs before yielding',async t=>{
  const {h,journal}=await fixture(t);let release,writing=false;
  const gated={readAll:journal.readAll.bind(journal),append:async(...args)=>{
    writing=true;await new Promise(resolve=>{release=resolve;});return journal.append(...args);
  }};
  const broker=new DurableHostIngressBroker({harness:h,journal:gated});
  const object={value:3};object.self=object;
  const before=h.modelContext('root'),promise=h.postEvent({subscriptionId:'earlier',eventId:'first',
    args:[object,object,-0,NaN,3n],deliver:false});
  object.value=99;await until(()=>writing);
  assert.equal(h.handlers.get('earlier').queue.length,0);assert.equal(h.inner.nextIngressSequence,1);
  assert.equal(h.handlers.get('earlier').seen.size,0);assert.deepEqual(h.modelContext('root'),before);
  assert.throws(()=>h.checkpoint(),/still being written/);
  release();const result=await promise;await broker.flush();
  assert.equal(result.status,'buffered');assert.equal(result.receipt.position,1);
  const args=h.handlers.get('earlier').queue[0].args;
  assert.equal(args[0].value,3);assert.equal(args[0],args[1]);assert.equal(args[0].self,args[0]);
  assert(Object.is(args[2],-0));assert(Number.isNaN(args[3]));assert.equal(args[4],3n);
  assert.deepEqual(h.modelContext('root'),before);
});

test('concurrent registered arrivals retain global order and reject conflicting duplicates before writing',async t=>{
  const {h,journal}=await fixture(t),broker=new DurableHostIngressBroker({harness:h,journal});
  const first=h.postEvent({subscriptionId:'earlier',eventId:'one',args:[1],deliver:false});
  assert.equal(h.postEvent({subscriptionId:'earlier',eventId:'one',args:[1],deliver:false}),first);
  assert.throws(()=>h.postEvent({subscriptionId:'earlier',eventId:'one',args:[2],deliver:false}),/conflicting pending/);
  const second=h.postEvent({subscriptionId:'later',eventId:'two',args:[2],deliver:false});
  await Promise.all([first,second]);await broker.flush();
  const rows=await journal.readAll(broker.receipt);
  assert.deepEqual(rows.map(row=>row.arrival.event.arrivalSequence),[1,2]);
  h.select('root',record('end',{kind:'return'}));
  assert.equal(h.deliverReadyEvents('later'),null);
  assert.equal(h.deliverReadyEvents('earlier').triggerId,'event:earlier:one');finish(h,'event1',['num',1]);
  assert.equal(h.deliverReadyEvents('later').triggerId,'event:later:two');finish(h,'event2',['num',2]);
  assert.equal((await h.postEvent({subscriptionId:'later',eventId:'two',args:[2]})).status,'duplicate');
  assert.throws(()=>h.postEvent({subscriptionId:'later',eventId:'two',args:[99]}),/conflicting accepted duplicate/);
  assert.equal(broker.receipt.position,2);
});

test('fresh-process recovery imports arrivals beyond the saved checkpoint without public observations or redispatch',async t=>{
  const {h,journal,directory}=await fixture(t),checkpoint=h.checkpoint();
  const broker=new DurableHostIngressBroker({harness:h,journal});
  const object={private:'future input'};object.self=object;
  await h.postEvent({subscriptionId:'earlier',eventId:'one',args:[object,object,-0,NaN,7n],deliver:false});
  await h.postEvent({subscriptionId:'later',eventId:'two',args:[2],deliver:false});await broker.flush();
  const path=join(directory,'restore.json');await writeFile(path,JSON.stringify({checkpoint,receipt:broker.receipt}));
  const script=`import {readFile} from 'node:fs/promises';
    import {RegionExecutionHarness as H} from ${JSON.stringify(new URL('../src/semantic/region-harness.js',import.meta.url).href)};
    import {DurableHostIngressJournal as J} from ${JSON.stringify(new URL('../src/storage/host-ingress-journal.js',import.meta.url).href)};
    const {checkpoint,receipt}=JSON.parse(await readFile(process.argv[1],'utf8'));
    const h=await H.restoreDurable(checkpoint,{ingressJournal:new J({directory:process.argv[2],streamId:'events'}),
      ingressLogReceipt:receipt,services:{'demo.listen':()=>{throw Error('redispatched');}}});
    const a=h.handlers.get('earlier').queue[0].args;
    if(a[0]!==a[1]||a[0].self!==a[0]||!Object.is(a[2],-0)||!Number.isNaN(a[3])||a[4]!==7n)throw Error('graph changed');
    if(JSON.stringify(h.modelContext('root')).includes('future input'))throw Error('private arrival leaked');
    if(JSON.stringify(h.exportEpisode())!==JSON.stringify(checkpoint.public))throw Error('public history changed');
    if(h.inner.nextIngressSequence!==3)throw Error('order cursor changed');
    h.select('root',{kind:'end',fields:{kind:'return'}});
    if(h.deliverReadyEvents('later')!==null)throw Error('arrival order bypass');
    if(h.deliverReadyEvents('earlier').triggerId!=='event:earlier:one')throw Error('lost arrival');
    process.stdout.write('restored two later arrivals without dispatch');`;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',script,path,directory],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/restored two later arrivals/);
});

test('journal recovery reconciles delivered and privately checkpointed arrivals without duplication',async t=>{
  const {h,journal,store}=await fixture(t),broker=new DurableHostIngressBroker({harness:h,journal});
  h.select('root',record('end',{kind:'return'}));
  await h.postEvent({subscriptionId:'earlier',eventId:'one',args:[{value:1}]});finish(h,'event1');
  await h.postEvent({subscriptionId:'later',eventId:'two',args:[2],deliver:false});await broker.flush();
  const checkpoint=await h.checkpointDurable({ingressStore:store});
  const restored=await RegionExecutionHarness.restoreDurable(checkpoint,{ingressStore:store,
    ingressReceipt:checkpoint.ingress,ingressJournal:journal,ingressLogReceipt:broker.receipt});
  assert.equal(restored.handlers.get('earlier').queue.length,0);
  assert.equal(restored.handlers.get('later').queue.length,1);
  assert.throws(()=>RegionExecutionHarness.restore(checkpoint),/independently read durable ingress journal/);
  const firstReceipt=(await journal.readAll(broker.receipt))[1].previous;
  await assert.rejects(RegionExecutionHarness.restoreDurable(checkpoint,{ingressStore:store,
    ingressReceipt:checkpoint.ingress,ingressJournal:journal,ingressLogReceipt:firstReceipt}),/predates|substitutes/);
  assert.deepEqual(restored.exportEpisode(),h.exportEpisode());
  assert.equal(restored.deliverReadyEvents('later').invocationId,'event2');finish(restored,'event2',['num',2]);
  assert.equal(restored.deliverReadyEvents('later'),null);
});

test('stale public boundaries, substituted owners and omitted tail entries refuse without queue mutation',async t=>{
  const {h,journal}=await fixture(t),checkpoint=h.checkpoint();
  h.select('root',record('end',{kind:'return'}));
  const broker=new DurableHostIngressBroker({harness:h,journal});
  await h.postEvent({subscriptionId:'earlier',eventId:'one',args:[1],deliver:false});await broker.flush();
  const restored=RegionExecutionHarness.restore(checkpoint),before=restored.checkpoint();
  await assert.rejects(DurableHostIngressBroker.recover({harness:restored,journal,receipt:broker.receipt}),/later acknowledged/);
  assert.deepEqual(restored.checkpoint(),before);
  const rows=await journal.readAll(broker.receipt),changed=structuredClone(rows[0]);
  changed.arrival.binding.entry='run';const receipt=resealEntry(changed);
  const fresh=RegionExecutionHarness.restore(checkpoint);
  const fake={append:journal.append.bind(journal),readAll:async()=>[changed]};
  await assert.rejects(DurableHostIngressBroker.recover({harness:fresh,journal:fake,receipt}),/boundary|source-owned/);
  assert.throws(()=>validateHostIngressLogChain([],broker.receipt),/incomplete/);
  assert.throws(()=>validateHostIngressLogChain([changed],broker.receipt),/retained receipt/);
});

test('owner retirement waits for pending durable arrivals and later closes record their discard',async t=>{
  const {h,journal,store}=await fixture(t);let release,writing=false;
  const broker=new DurableHostIngressBroker({harness:h,journal:{readAll:journal.readAll.bind(journal),
    append:async(...args)=>{writing=true;await new Promise(resolve=>{release=resolve;});return journal.append(...args);}}});
  const posted=h.postEvent({subscriptionId:'earlier',eventId:'one',args:[1],deliver:false});
  await until(()=>writing);const before=h.exportEpisode();
  assert.throws(()=>h.closeEventHandler('earlier'),/await durable arrivals/);
  assert.throws(()=>h.inner.cancelInvocation('root'),/await durable arrivals/);
  assert.throws(()=>h.inner.closeRealm('r'),/await durable arrivals/);
  assert.deepEqual(h.exportEpisode(),before,'retirement refusal must not mutate public state');
  release();await posted;await broker.flush();
  h.closeEventHandler('earlier');
  assert.deepEqual(h.exportEpisode().timeline.at(-1).fields.discarded,['one']);
  const checkpoint=await h.checkpointDurable({ingressStore:store});
  const restored=await RegionExecutionHarness.restoreDurable(checkpoint,{ingressJournal:journal,ingressLogReceipt:broker.receipt});
  assert.equal(restored.handlers.get('earlier').state,'closed');
  assert.equal(restored.handlers.get('earlier').queue.length,0);
});

test('failed storage accepts nothing and a lost acknowledgement has explicit idempotent recovery',async t=>{
  const other=await fixture(t),failed=new DurableHostIngressBroker({harness:other.h,journal:{
    readAll:other.journal.readAll.bind(other.journal),append:async()=>{throw Error('disk failed');}}});
  await assert.rejects(other.h.postEvent({subscriptionId:'earlier',eventId:'one',args:[1]}),/disk failed/);
  assert.equal(other.h.handlers.get('earlier').seen.size,0);assert.equal(failed.receipt,null);
  await assert.rejects(failed.flush(),/disk failed/);
  const {h,journal}=await fixture(t),checkpoint=h.checkpoint();
  const broker=new DurableHostIngressBroker({harness:h,journal:{readAll:journal.readAll.bind(journal),
    append:async(...args)=>{await journal.append(...args);throw Error('acknowledgement lost');}}});
  await assert.rejects(h.postEvent({subscriptionId:'earlier',eventId:'one',args:[7],deliver:false}),/acknowledgement lost/);
  assert.equal(broker.receipt,null);assert.equal(h.handlers.get('earlier').queue.length,0);
  const candidate=await journal.inspectNext();
  assert.equal(candidate.entry.arrival.event.eventId,'one');
  assert.equal(RegionExecutionHarness.restore(checkpoint).handlers.get('earlier').queue.length,0,
    'unselected tail bytes do not authorize automatic recovery');
  const wrong=structuredClone(candidate.entry.arrival);wrong.event.eventId='different';
  await assert.rejects(journal.append(wrong),/digest|size|competing/);
  const acknowledged=await journal.append(candidate.entry.arrival);
  assert.deepEqual(acknowledged,candidate.receipt);
  assert.equal(await journal.inspectNext({previous:acknowledged}),null);
  const restored=await RegionExecutionHarness.restoreDurable(checkpoint,{ingressJournal:journal,ingressLogReceipt:acknowledged});
  assert.equal(restored.handlers.get('earlier').queue.length,1);
  assert.equal(restored.handlers.get('earlier').queue[0].args[0],7);
});

test('immutable journal refuses competing writers, corrupted entries, symlinks and resource overflow',async t=>{
  const {h,journal,directory}=await fixture(t),broker=new DurableHostIngressBroker({harness:h,journal});
  await h.postEvent({subscriptionId:'earlier',eventId:'one',args:[1],deliver:false});await broker.flush();
  const [entry]=await journal.readAll(broker.receipt);
  assert.deepEqual(await journal.append(entry.arrival),broker.receipt,'identical retry is idempotent');
  const changed=structuredClone(entry.arrival);changed.event.eventId='other';
  await assert.rejects(journal.append(changed),/digest mismatch|size|competing/);
  const tiny=new DurableHostIngressJournal({directory,streamId:'tiny',maxBytes:32});
  await assert.rejects(tiny.append(entry.arrival),/byte bound/);
  const bounded=new DurableHostIngressJournal({directory,streamId:'events',maxEntries:1});
  changed.event.arrivalSequence=2;
  await assert.rejects(bounded.append(changed,{previous:broker.receipt}),/position exceeds/);
  await writeFile(journal.entryPath(1),'{}');await assert.rejects(journal.readAll(broker.receipt),/size|digest/);
  await rm(journal.entryPath(1));const target=join(directory,'external.json');
  await writeFile(target,stableAlgorithmJSON(entry));await symlink(target,journal.entryPath(1));
  await assert.rejects(journal.readAll(broker.receipt),/ELOOP|symbolic link/i);
});

test('registered native notifications preserve void returns and reserve unique IDs before durable writes finish',async t=>{
  const {directory,journal}=await fixture(t),returns=[];
  const nativeSource='"use strict";function run(){return host.listen("tick",handler);}function handler(value){return value;}';
  const h=new RegionExecutionHarness({sessionId:'native-arrivals',automaticDelivery:false,
    services:{'demo.listen':(_,meta)=>{
      const notify=meta.callback(1);returns.push(notify(1),notify(2));return meta.subscriptionId(1);
    }}});
  h.publishProgram({programId:'p',source:nativeSource,entry:'run',capabilities:['demo.listen']});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'t',realmId:'r',triggerId:'outside',realmPolicy:'retained'});
  h.select('root',record('allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}));
  const {start,end}=analyzeSemanticProgram(nativeSource).sites.find(row=>row.operation==='demo.listen');
  h.select('root',record('request',{effect:'listen',operation:'demo.listen',invocation:'root',
    arguments:[['str','tick'],['ref','fn']],site:{start,end},payload:'["tick",{"$ownedCallback":"fn"}]',promise:'listen'}));
  const broker=new DurableHostIngressBroker({harness:h,journal});
  await h.dispatch('root','listen');await broker.flush();
  assert.deepEqual(returns,[undefined,undefined]);
  assert.deepEqual(h.handlers.get('callback1').queue.map(row=>row.eventId),['callbackevent1','callbackevent2']);
  const checkpoint=await h.checkpointDurable({ingressStore:new DurableHostIngressStore({directory})});
  const restored=await RegionExecutionHarness.restoreDurable(checkpoint,{
    ingressStore:new DurableHostIngressStore({directory}),ingressReceipt:checkpoint.ingress,
    ingressJournal:journal,ingressLogReceipt:broker.receipt});
  assert.equal(restored.handlers.get('callback1').queue.length,2);
  assert.equal(restored.exportEpisode().timeline.filter(row=>row.kind==='dispatch').length,1);
});
