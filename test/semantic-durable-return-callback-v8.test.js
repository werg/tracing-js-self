import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {DurableHostIngressBroker} from '../src/semantic/host-ingress-journal-v8.js';
import {DurableHostIngressJournal} from '../src/storage/host-ingress-journal.js';
import {DurableHostIngressStore} from '../src/storage/host-ingress.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const source='"use strict";function run(){return host.natlangCall("x",null,handler);}function handler(value){return value;}';
const select=(h,id,kind,fields)=>h.select(id,{kind,fields});
const request={ownerInvocationId:'root',parentEffectId:'effect',closureId:'fn'};
const copy=value=>JSON.parse(JSON.stringify(value));
async function fixture(t,{prepareCallbackInput=null,programSource=source}={}){
  const directory=await mkdtemp(join(tmpdir(),'v8-return-callback-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let metadata,calls=0;
  const h=new RegionExecutionHarness({sessionId:'return-callback',automaticDelivery:false,prepareCallbackInput,
    services:{'natlang.call':(_args,meta)=>{metadata=meta;calls++;return new Promise(()=>{});}}});
  h.publishProgram({programId:'p',source:programSource,entry:'run',capabilities:['natlang.call']});
  h.admitInvocation({programId:'p',invocationId:'root',realmId:'realm',trackId:'worker',
    triggerId:'start',realmPolicy:'retained',completionPolicy:'await-returned-promise'});
  select(h,'root','allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]});
  select(h,'root','allocate',{name:'retained',kind:'object',properties:[{key:'value',value:['num',9]}]});
  const {start,end}=analyzeSemanticProgram(programSource).sites.find(row=>row.operation==='natlang.call');
  select(h,'root','request',{effect:'effect',operation:'natlang.call',invocation:'root',site:{start,end},
    arguments:[['str','x'],['null'],['ref','fn']],promise:'external',
    payload:JSON.stringify({schema:'owned-graph/1',roots:[['str','x'],['null'],['callback','fn']],objects:[]})});
  void h.dispatch('root','effect');
  for(let n=0;n<20&&!metadata;n++)await Promise.resolve();
  assert(metadata);h.sync();
  return {h,directory,journal:new DurableHostIngressJournal({directory,streamId:'callbacks'}),
    store:new DurableHostIngressStore({directory}),metadata,calls:()=>calls};
}
function releaseParent(h){
  select(h,'root','return',{value:['ref','external']});
}
function finish(h,id,kind='return',value=['num',17]){
  select(h,id,kind,{value});select(h,id,'end',{kind});
}
async function until(predicate){
  for(let n=0;n<1000;n++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('asynchronous boundary did not arrive');
}
const receiptFor=entry=>({schema:'semantic-host-ingress-log-receipt/8',streamId:entry.streamId,
  position:entry.position,id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))});

test('return callback captures receiver aliases before yielding and enters its queue only after readback',async t=>{
  const {h,journal}=await fixture(t);let release,writing=false;
  const broker=new DurableHostIngressBroker({harness:h,journal:{readAll:journal.readAll.bind(journal),
    append:async(...args)=>{writing=true;await new Promise(resolve=>{release=resolve;});return journal.append(...args);}}});
  const object={value:1};object.self=object;
  const before=h.exportEpisode(),pending=broker.receiveCallback({...request,invocationId:'child',
    args:[object,object,-0,NaN,7n],receiver:object});object.value=99;
  await until(()=>writing);
  assert.equal(h.inner.closureQueue.length,0);assert.equal(h.inner.nextIngressSequence,1);
  assert.deepEqual(h.exportEpisode(),before);assert.throws(()=>h.checkpoint(),/still being written/);
  assert.throws(()=>h.inner.cancelInvocation('root'),/await durable arrivals/);
  release();const ack=await pending;await broker.flush();
  assert.equal(ack.status,'buffered');assert.equal(ack.receipt.position,1);
  assert.deepEqual(h.exportEpisode(),before);
  const queued=h.inner.closureQueue[0];
  assert.deepEqual(queued.inputGraph.roots.slice(0,2),[queued.receiverValue,queued.receiverValue]);
  assert.deepEqual(queued.inputGraph.objects[0].properties.find(row=>row.key==='value').value,['num',1]);
  assert.deepEqual(queued.inputGraph.roots.slice(2),[['num','-0'],['num','NaN'],['bigint','7']]);
  assert.doesNotThrow(()=>h.checkpoint());
});

test('queued callback journal restores in a new process without publishing input or redispatching its parent',async t=>{
  const {h,journal,directory}=await fixture(t),checkpoint=h.checkpoint(),
    broker=new DurableHostIngressBroker({harness:h,journal}),object={secret:'private'};
  object.self=object;
  await broker.receiveCallback({...request,invocationId:'child',args:[object,object],receiver:object});
  await broker.flush();
  const path=join(directory,'restore.json');await writeFile(path,JSON.stringify({checkpoint,receipt:broker.receipt}));
  const script=`import {readFile} from 'node:fs/promises';
    import {RegionExecutionHarness as H} from ${JSON.stringify(new URL('../src/semantic/region-harness.js',import.meta.url).href)};
    import {DurableHostIngressJournal as J} from ${JSON.stringify(new URL('../src/storage/host-ingress-journal.js',import.meta.url).href)};
    const {checkpoint,receipt}=JSON.parse(await readFile(process.argv[1],'utf8'));let calls=0;
    const h=await H.restoreDurable(checkpoint,{ingressJournal:new J({directory:process.argv[2],streamId:'callbacks'}),
      ingressLogReceipt:receipt,services:{'natlang.call':()=>{calls++;}}});
    if(JSON.stringify(h.exportEpisode())!==JSON.stringify(checkpoint.public))throw Error('published private input');
    if(h.inner.closureQueue.length!==1||h.inner.completionWaiters.size!==0)throw Error('lost child or revived adapter');
    if(h.intents.get('root/effect').status!=='uncertain')throw Error('parent uncertainty lost');
    try{await h.dispatch('root','effect');throw Error('redispatched');}catch(error){if(!/uncertain/.test(error.message))throw error;}
    h.select('root',{kind:'return',fields:{value:['ref','external']}});
    h.inner.activateQueuedClosures('realm');h.sync();const c=h.invocations.get('child').controller;
    if(JSON.stringify(c.input.graph.roots)!==JSON.stringify([c.receiver,c.receiver]))throw Error('alias changed');
    h.select('child',{kind:'return',fields:{value:['num',17]}});h.select('child',{kind:'end',fields:{kind:'return'}});
    if(h.inner.callbackOutcome('child').completion.value[1]!==17||calls)throw Error('outcome or dispatch');
    if(h.intents.get('root/effect').status!=='uncertain')throw Error('guessed adapter result');
    h.reconcile('root','effect',{disposition:'fulfilled',value:17,evidenceId:'adapter-owned-recovery'});
    process.stdout.write('restored exactly one child without adapter redispatch');`;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',script,path,directory],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/exactly one child/);
});

test('queued and active saved callbacks restore exact return and throw while keeping the parent uncertain',async t=>{
  for(const kind of ['return','throw']){
    const {h,journal}=await fixture(t),broker=new DurableHostIngressBroker({harness:h,journal});
    await broker.receiveCallback({...request,invocationId:'child',args:[kind]});await broker.flush();
    let restored=await RegionExecutionHarness.restoreDurable(copy(h.checkpoint()),{
      ingressJournal:journal,ingressLogReceipt:broker.receipt});
    assert.equal(restored.inner.closureQueue.length,1);releaseParent(restored);
    restored.inner.activateQueuedClosures('realm');restored.sync();
    select(restored,'child',kind,{value:['ref','retained']});
    const active=copy(restored.checkpoint());
    restored=await RegionExecutionHarness.restoreDurable(active,{ingressJournal:journal,ingressLogReceipt:broker.receipt});
    assert.equal(restored.inner.closureQueue.length,0);assert.equal(restored.inner.completionWaiters.size,0);
    const count=restored.timeline.filter(row=>row.fields.invocationId==='child'&&row.mode==='generated').length;
    select(restored,'child','end',{kind});
    assert.equal(restored.timeline.filter(row=>row.fields.invocationId==='child'&&row.mode==='generated').length,count+1);
    assert.deepEqual(restored.inner.callbackOutcome('child'),{status:kind==='throw'?'rejected':'fulfilled',
      completion:{kind,value:['ref','retained']}});
    assert.equal(restored.intents.get('root/effect').status,'uncertain');
    const complete=await RegionExecutionHarness.restoreDurable(copy(restored.checkpoint()),{
      ingressJournal:journal,ingressLogReceipt:broker.receipt});
    assert.deepEqual(complete.inner.callbackOutcome('child'),restored.inner.callbackOutcome('child'));
  }
});

test('prepared retained callback inputs preserve exact identities and reject invalid receiver authority before mutation',async t=>{
  const {h,journal}=await fixture(t,{prepareCallbackInput:()=>({
    inputGraph:{roots:[['ref','retained']],objects:[]},receiverValue:['ref','retained']})});
  const broker=new DurableHostIngressBroker({harness:h,journal});
  await broker.receiveCallback({...request,invocationId:'child'});await broker.flush();
  const restored=await RegionExecutionHarness.restoreDurable(copy(h.checkpoint()),{
    ingressJournal:journal,ingressLogReceipt:broker.receipt});
  releaseParent(restored);restored.inner.activateQueuedClosures('realm');restored.sync();
  assert.deepEqual(restored.invocations.get('child').controller.receiver,['ref','retained']);
  assert.deepEqual(restored.invocations.get('child').controller.input.graph.roots,[['ref','retained']]);
  const before=h.exportEpisode(),sequence=h.inner.nextIngressSequence;
  h.inner.prepareCallbackInput=()=>({inputGraph:{roots:[],objects:[]},receiverValue:['ref','unknown']});
  assert.throws(()=>broker.receiveCallback({...request,invocationId:'bad'}),/receiver identity/);
  assert.equal(h.inner.nextIngressSequence,sequence);assert.deepEqual(h.exportEpisode(),before);
  assert.equal(broker.receipt.position,1);
});

test('callback and registered event queues share arrival order through private snapshot recovery',async t=>{
  const {h,journal,store}=await fixture(t);
  h.registerEventHandler({subscriptionId:'events',programId:'p',realmId:'realm',trackId:'worker',entry:'handler'});
  const broker=new DurableHostIngressBroker({harness:h,journal});
  await broker.receiveCallback({...request,invocationId:'first',args:[1],deliver:false});
  await h.postEvent({subscriptionId:'events',eventId:'second',args:[2],deliver:false});
  await broker.receiveCallback({...request,invocationId:'third',args:[3],deliver:false});await broker.flush();
  const checkpoint=await h.checkpointDurable({ingressStore:store});
  const restored=await RegionExecutionHarness.restoreDurable(copy(checkpoint),{ingressStore:store,
    ingressReceipt:checkpoint.ingress,ingressJournal:journal,ingressLogReceipt:broker.receipt});
  releaseParent(restored);assert.equal(restored.deliverReadyEvents('events'),null);
  restored.inner.activateQueuedClosures('realm');restored.sync();finish(restored,'first');
  assert.equal(restored.inner.activateQueuedClosures('realm'),null);
  assert.equal(restored.deliverReadyEvents('events').invocationId,'event1');finish(restored,'event1');
  restored.inner.activateQueuedClosures('realm');restored.sync();finish(restored,'third');
  assert.deepEqual(restored.timeline.filter(row=>row.kind==='invocation').map(row=>row.fields.invocationId),
    ['root','first','event1','third']);
});

test('callback recovery authenticates the whole saved queue before merging journal-only arrivals',async t=>{
  const {h,journal}=await fixture(t),checkpoint=copy(h.checkpoint()),
    broker=new DurableHostIngressBroker({harness:h,journal});
  await broker.receiveCallback({...request,invocationId:'first',args:[1],deliver:false});
  await broker.receiveCallback({...request,invocationId:'second',args:[2],deliver:false});await broker.flush();
  const queue=copy(h.inner.closureQueue);
  for(const rows of [[queue[1],queue[0]],[queue[0],queue[0]],
    [...queue,{...queue[1],invocationId:'unlogged',arrivalSequence:3}]]){
    const restored=RegionExecutionHarness.restore(checkpoint);
    restored.inner.closureQueue=copy(rows);restored.inner.nextIngressSequence=3;
    const before=copy(restored.inner.closureQueue),publicBefore=restored.exportEpisode();
    await assert.rejects(DurableHostIngressBroker.recover({harness:restored,journal,receipt:broker.receipt}),
      /unauthenticated|duplicate|reversed/);
    assert.deepEqual(restored.inner.closureQueue,before);assert.equal(restored.inner.nextIngressSequence,3);
    assert.deepEqual(restored.exportEpisode(),publicBefore);assert.equal(restored.inner.hostIngressBroker,undefined);
  }
  const partial=RegionExecutionHarness.restore(checkpoint);
  partial.inner.closureQueue=[copy(queue[1])];partial.inner.nextIngressSequence=3;
  await DurableHostIngressBroker.recover({harness:partial,journal,receipt:broker.receipt});
  assert.deepEqual(partial.inner.closureQueue,queue,'journal-only earlier arrival must precede saved later work');
  h.inner.closureQueue.reverse();assert.throws(()=>h.checkpoint(),/reverse durable arrival order/);
});

test('callback journal validates every owner and input before applying any recovered child',async t=>{
  const {h,journal}=await fixture(t),checkpoint=h.checkpoint(),broker=new DurableHostIngressBroker({harness:h,journal});
  await broker.receiveCallback({...request,invocationId:'first',args:[1],deliver:false});
  await broker.receiveCallback({...request,invocationId:'second',args:[2],deliver:false});await broker.flush();
  const rows=await journal.readAll(broker.receipt);
  for(const mutate of [
    row=>{row.arrival.binding.parentEffectId='other';},row=>{row.arrival.binding.closureId='retained';},
    row=>{row.arrival.binding.retainedIds.push('invented');},row=>{row.arrival.binding.effectDigest='0'.repeat(64);},
    row=>{row.arrival.prefixDigest='0'.repeat(64);},row=>{row.arrival.event.arrivalSequence=1;},
    row=>{row.arrival.event.receiverValue=['ref','unknown'];}
  ]){
    const changed=copy(rows);mutate(changed[1]);const receipt=receiptFor(changed[1]);
    const restored=RegionExecutionHarness.restore(copy(checkpoint)),before=restored.checkpoint();
    await assert.rejects(DurableHostIngressBroker.recover({harness:restored,receipt,
      journal:{append(){throw Error('write');},readAll:async()=>changed}}));
    assert.deepEqual(restored.checkpoint(),before);assert.equal(restored.inner.closureQueue.length,0);
  }
  // A graph altered after delivery must disagree with the public child input,
  // even if the embedding mistakenly supplies a freshly computed log receipt.
  releaseParent(h);h.inner.activateQueuedClosures('realm');h.sync();
  const changed=copy(rows);changed[0].arrival.event.inputGraph.roots[0]=['num',999];
  changed[1].previous=receiptFor(changed[0]);
  const publicOnly=RegionExecutionHarness.replay(h.exportEpisode(),{requireTerminal:false});
  publicOnly.inner.nextIngressSequence=h.inner.nextIngressSequence;
  await assert.rejects(DurableHostIngressBroker.recover({harness:publicOnly,receipt:receiptFor(changed[1]),
    journal:{append(){throw Error('write');},readAll:async()=>changed}}),/delivered callback differs/);
});

test('native callback dispatch automatically journals arrivals and never settles its parent from guest state alone',async t=>{
  const {h,journal,metadata,calls}=await fixture(t),broker=new DurableHostIngressBroker({harness:h,journal});
  const pending=metadata.invokeClosure('fn',[17],undefined);void pending.catch(()=>{});
  await broker.flush();assert.equal(broker.receipt.position,1);assert.equal(calls(),1);
  const child=h.inner.closureQueue[0].invocationId;releaseParent(h);h.inner.activateQueuedClosures('realm');h.sync();
  finish(h,child);assert.equal(await pending,17);
  assert.equal(h.intents.get('root/effect').status,'dispatched');
});

test('reentrant callback child work restores without repeating either external parent',async t=>{
  const programSource='"use strict";function run(){return host.natlangCall("x",null,handler);}'+
    'function handler(value){return host.natlangCall("x",null,handler);}';
  const {h,journal,calls}=await fixture(t,{programSource}),broker=new DurableHostIngressBroker({harness:h,journal});
  await broker.receiveCallback({...request,invocationId:'child',args:[1]});await broker.flush();
  releaseParent(h);h.inner.activateQueuedClosures('realm');h.sync();
  const {start,end}=analyzeSemanticProgram(programSource).sites.filter(row=>row.operation==='natlang.call').at(-1);
  select(h,'child','request',{effect:'nestedeffect',operation:'natlang.call',invocation:'child',site:{start,end},
    arguments:[['str','x'],['null'],['ref','fn']],promise:'nested',
    payload:JSON.stringify({schema:'owned-graph/1',roots:[['str','x'],['null'],['callback','fn']],objects:[]})});
  void h.dispatch('child','nestedeffect');
  await until(()=>h.intents.get('child/nestedeffect').status==='dispatched');h.sync();
  await broker.receiveCallback({ownerInvocationId:'child',parentEffectId:'nestedeffect',closureId:'fn',
    invocationId:'grandchild',args:[2]});await broker.flush();
  select(h,'child','return',{value:['ref','nested']});h.inner.activateQueuedClosures('realm');h.sync();
  select(h,'grandchild','return',{value:['ref','retained']});
  const restored=await RegionExecutionHarness.restoreDurable(copy(h.checkpoint()),{
    ingressJournal:journal,ingressLogReceipt:broker.receipt,services:{'natlang.call':()=>assert.fail('redispatch')}});
  assert.equal(restored.inner.completionWaiters.size,0);assert.equal(restored.inner.closureQueue.length,0);
  select(restored,'grandchild','end',{kind:'return'});
  assert.deepEqual(restored.inner.callbackOutcome('grandchild'),{status:'fulfilled',
    completion:{kind:'return',value:['ref','retained']}});
  assert.equal(restored.intents.get('root/effect').status,'uncertain');
  assert.equal(restored.intents.get('child/nestedeffect').status,'uncertain');
  restored.reconcile('child','nestedeffect',{disposition:'fulfilled',result:['ref','retained'],evidenceId:'nested-adapter-recovery'});
  select(restored,'child','end',{kind:'return'});
  assert.deepEqual(restored.inner.callbackOutcome('child'),{status:'fulfilled',
    completion:{kind:'return',value:['ref','retained']}});
  assert.equal(restored.intents.get('root/effect').status,'uncertain');
  restored.reconcile('root','effect',{disposition:'fulfilled',result:['ref','retained'],evidenceId:'root-adapter-recovery'});
  select(restored,'root','end',{kind:'return'});assert.equal(calls(),2);
  assert.deepEqual(restored.controller.completion,{kind:'return',value:['ref','retained']});
});

test('lost callback acknowledgement requires exact-byte retry and cannot reconstruct the native waiter',async t=>{
  const {h,journal}=await fixture(t),checkpoint=h.checkpoint();
  const broker=new DurableHostIngressBroker({harness:h,journal:{readAll:journal.readAll.bind(journal),
    append:async(...args)=>{await journal.append(...args);throw Error('acknowledgement lost');}}});
  await assert.rejects(broker.receiveCallback({...request,invocationId:'child',args:[17]}),/acknowledgement lost/);
  assert.equal(h.inner.closureQueue.length,0);assert.equal(broker.receipt,null);
  const inspected=await journal.inspectNext();assert(inspected);
  const receipt=await journal.append(inspected.entry.arrival,{previous:inspected.entry.previous});
  const restored=await RegionExecutionHarness.restoreDurable(copy(checkpoint),{
    ingressJournal:journal,ingressLogReceipt:receipt});
  assert.equal(restored.inner.closureQueue.length,1);assert.equal(restored.inner.completionWaiters.size,0);
  releaseParent(restored);restored.inner.activateQueuedClosures('realm');restored.sync();finish(restored,'child');
  assert.equal(restored.inner.callbackOutcome('child').completion.value[1],17);
  assert.equal(restored.intents.get('root/effect').status,'uncertain');
});

test('failed callback writes and conflicting duplicates publish no work; cancellation is retained without replay',async t=>{
  const failed=await fixture(t),broken=new DurableHostIngressBroker({harness:failed.h,
    journal:{append:async()=>{throw Error('disk unavailable');},readAll:async()=>[]}}),before=failed.h.exportEpisode();
  await assert.rejects(broken.receiveCallback({...request,invocationId:'failed'}),/disk unavailable/);
  assert.equal(failed.h.inner.closureQueue.length,0);assert.equal(failed.h.inner.nextIngressSequence,1);
  assert.deepEqual(failed.h.exportEpisode(),before);assert.throws(()=>failed.h.checkpoint(),/disk unavailable/);
  const {h,journal}=await fixture(t),broker=new DurableHostIngressBroker({harness:h,journal});
  const options={...request,invocationId:'child',args:[1],deliver:false},first=broker.receiveCallback(options);
  assert.equal(broker.receiveCallback(options),first);
  assert.throws(()=>broker.receiveCallback({...options,args:[2]}),/conflicting pending callback/);
  await first;await broker.flush();assert.equal((await broker.receiveCallback(options)).status,'duplicate');
  assert.throws(()=>broker.receiveCallback({...options,args:[3]}),/conflicting accepted callback/);
  h.inner.cancelInvocation('root');h.sync();
  const restored=await RegionExecutionHarness.restoreDurable(copy(h.checkpoint()),{
    ingressJournal:journal,ingressLogReceipt:broker.receipt});
  assert.equal(restored.inner.closureQueue.length,0);assert.equal(restored.invocations.has('child'),false);
  assert.equal(restored.intents.get('root/effect').status,'uncertain');
});
