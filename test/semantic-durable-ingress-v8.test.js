import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {SelectedExecutionLifecycleV8} from '../src/semantic/lifecycle-v8.js';
import {DurableHostIngressStore} from '../src/storage/host-ingress.js';
import {capturePendingIngress,validatePendingIngressSnapshot} from '../src/semantic/pending-ingress-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';

const source='"use strict";function run(){return host.listen("tick",handler);}function handler(value){return value;}';
const record=(kind,fields)=>({kind,fields});
const seal=packet=>{const {integrity,...body}=packet;return {...body,integrity:hashAlgorithmData(body)};};
const resealCore=packet=>{
  const {integrity,...body}=packet;
  return {...body,integrity:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'v8-private-ingress-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new DurableHostIngressStore({directory});let calls=0;
  const h=new RegionExecutionHarness({sessionId:'ingress-test',automaticDelivery:false,
    services:{'demo.listen':(_,meta)=>{calls++;return meta.subscriptionId(1);}}});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.listen']});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'t',realmId:'r',triggerId:'outside',realmPolicy:'retained'});
  h.select('root',record('allocate',{name:'fn',kind:'closure',code:'handler',captures:[],properties:[]}));
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation==='demo.listen');
  h.select('root',record('request',{effect:'listen',operation:'demo.listen',invocation:'root',
    arguments:[['str','tick'],['ref','fn']],site:{start,end},payload:'["tick",{"$ownedCallback":"fn"}]',promise:'listen'}));
  await h.dispatch('root','listen');
  h.select('root',record('return',{value:['undefined']}));h.select('root',record('end',{kind:'return'}));
  return {h,store,directory,calls:()=>calls};
}
function finish(h,id,value){
  h.select(id,record('return',{value:['num',value]}));h.select(id,record('end',{kind:'return'}));
}

const orderedSource='"use strict";function run(){return;}function handler(value){return;}';
function orderedRegionHarness({sessionId='ingress-order',automaticDelivery=true}={}){
  const h=new RegionExecutionHarness({sessionId,automaticDelivery});
  h.publishProgram({programId:'ordered',source:orderedSource,entry:'run'});
  h.admitInvocation({programId:'ordered',invocationId:'root',trackId:'order-track',realmId:'order-realm',
    triggerId:'outside',realmPolicy:'retained'});
  // Deliberately register the later-arriving listener first.
  h.registerEventHandler({subscriptionId:'callback2',programId:'ordered',realmId:'order-realm',
    trackId:'order-track',entry:'handler'});
  h.registerEventHandler({subscriptionId:'callback1',programId:'ordered',realmId:'order-realm',
    trackId:'order-track',entry:'handler'});
  return h;
}
function beginOrderedArrivals(h){
  h.select('root',record('return',{value:['undefined']}));
  const before=h.modelContext('root');
  h.postEvent({subscriptionId:'callback1',eventId:'first-arrival',args:['private-first'],deliver:false});
  h.postEvent({subscriptionId:'callback2',eventId:'second-arrival',args:['private-second'],deliver:false});
  assert.deepEqual(h.modelContext('root'),before,'queued private arrivals must not affect model context');
  return before;
}
function finishOrderedCallbacks(h){
  h.select('root',record('end',{kind:'return'}));
  h.select('event1',record('return',{value:['undefined']}));
  h.select('event1',record('end',{kind:'return'}));
  h.select('event2',record('return',{value:['undefined']}));
  h.select('event2',record('end',{kind:'return'}));
  return h.exportEpisode().timeline.filter(row=>row.kind==='event').map(row=>row.fields.eventId);
}

test('retained realm delivery follows global arrival order before and after durable restore',async t=>{
  const h=orderedRegionHarness(),before=beginOrderedArrivals(h);
  const directory=await mkdtemp(join(tmpdir(),'v8-ingress-order-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new DurableHostIngressStore({directory});
  const packet=JSON.parse(JSON.stringify(await h.checkpointDurable({ingressStore:store})));
  const snapshot=await store.get(packet.ingress);
  assert.deepEqual(snapshot.queues.map(row=>row.events.map(event=>event.arrivalSequence)),[[2],[1]]);
  assert.equal(snapshot.nextIngressSequence,3);
  const duplicateOrder=structuredClone(snapshot);
  duplicateOrder.queues[0].events[0].arrivalSequence=duplicateOrder.queues[1].events[0].arrivalSequence;
  assert.throws(()=>validatePendingIngressSnapshot(duplicateOrder),/order/);
  const malformedOrder=structuredClone(snapshot);
  malformedOrder.queues[0].events[0].arrivalSequence=0;
  assert.throws(()=>validatePendingIngressSnapshot(malformedOrder),/order/);
  assert(!JSON.stringify(h.modelContext('root')).includes('private-first'));
  const restored=await RegionExecutionHarness.restoreDurable(packet,{
    ingressStore:new DurableHostIngressStore({directory}),ingressReceipt:packet.ingress
  });
  assert.deepEqual(restored.modelContext('root'),before);
  assert(!JSON.stringify(restored.modelContext('root')).includes('private-second'));
  assert.deepEqual(finishOrderedCallbacks(restored),['first-arrival','second-arrival']);
  // The same queue rule applies in the process that accepted the arrivals.
  assert.deepEqual(finishOrderedCallbacks(h),['first-arrival','second-arrival']);
});

test('explicit delivery cannot bypass an earlier listener and core checkpoints validate order',()=>{
  const core=new SelectedExecutionLifecycleV8({sessionId:'core-ingress-order',automaticDelivery:false});
  core.publishProgram({programId:'ordered',source:orderedSource,entry:'run'});
  core.admitInvocation({programId:'ordered',invocationId:'root',trackId:'t',realmId:'r',triggerId:'outside',
    realmPolicy:'retained'});
  core.registerEventHandler({subscriptionId:'callback2',programId:'ordered',realmId:'r',trackId:'t',entry:'handler'});
  core.registerEventHandler({subscriptionId:'callback1',programId:'ordered',realmId:'r',trackId:'t',entry:'handler',queueLimit:1});
  core.selected('root',core.encodeRecord('return',{value:['undefined']}));
  core.selected('root',core.encodeRecord('end',{kind:'return'}));
  core.postEvent({subscriptionId:'callback1',eventId:'first',args:[1],deliver:false});
  core.postEvent({subscriptionId:'callback1',eventId:'first',args:[99],deliver:false});
  assert.equal(core.nextIngressSequence,2,'a duplicate does not consume an arrival sequence');
  assert.throws(()=>core.postEvent({subscriptionId:'callback1',eventId:'overflow',args:[3],deliver:false}),/overflow/);
  assert.equal(core.nextIngressSequence,2,'an overflow does not consume an arrival sequence');
  core.postEvent({subscriptionId:'callback2',eventId:'second',args:[2],deliver:false});
  assert.equal(core.deliverReadyEvents('callback2'),null,'later listener cannot bypass the earlier one');
  const checkpoint=core.checkpoint();
  assert.equal(core.deliverReadyEvents('callback1').triggerId,'event:callback1:first');
  core.selected('event1',core.encodeRecord('return',{value:['undefined']}));
  core.selected('event1',core.encodeRecord('end',{kind:'return'}));
  assert.equal(core.deliverReadyEvents('callback2').triggerId,'event:callback2:second');
  const restored=SelectedExecutionLifecycleV8.restore(checkpoint);
  assert.equal(restored.nextIngressSequence,3);
  assert.equal(restored.deliverReadyEvents('callback1'),null,
    'generic restore retains the lost-handler durable-only gate');
  const duplicate=structuredClone(checkpoint);
  duplicate.handlers.find(row=>row[0]==='callback1')[1].queue[0].arrivalSequence=2;
  assert.throws(()=>SelectedExecutionLifecycleV8.restore(resealCore(duplicate)),/arrival order/);
  const malformed=structuredClone(checkpoint);
  malformed.handlers.find(row=>row[0]==='callback1')[1].queue[0].arrivalSequence=0;
  assert.throws(()=>SelectedExecutionLifecycleV8.restore(resealCore(malformed)),/arrival order/);
});

test('closing an earlier queued listener releases the next arrival',()=>{
  const h=orderedRegionHarness();
  h.select('root',record('return',{value:['undefined']}));
  h.postEvent({subscriptionId:'callback1',eventId:'discarded-first',args:[1],deliver:false});
  h.postEvent({subscriptionId:'callback2',eventId:'eligible-second',args:[2],deliver:false});
  h.closeEventHandler('callback1');
  h.select('root',record('end',{kind:'return'}));
  assert.deepEqual(h.exportEpisode().timeline.filter(row=>row.kind==='event').map(row=>row.fields.eventId),
    ['eligible-second']);
});

test('a pending retained listener does not block an independent realm',()=>{
  const core=new SelectedExecutionLifecycleV8({sessionId:'independent-ingress',automaticDelivery:false});
  core.publishProgram({programId:'ordered',source:orderedSource,entry:'run'});
  for(const [invocationId,realmId,trackId] of [['root-a','realm-a','track-a'],['root-b','realm-b','track-b']])
    core.admitInvocation({programId:'ordered',invocationId,trackId,realmId,triggerId:invocationId,
      realmPolicy:'retained'});
  core.registerEventHandler({subscriptionId:'callback-a',programId:'ordered',realmId:'realm-a',
    trackId:'track-a',entry:'handler'});
  core.registerEventHandler({subscriptionId:'callback-b',programId:'ordered',realmId:'realm-b',
    trackId:'track-b',entry:'handler'});
  for(const invocationId of ['root-a','root-b']){
    core.selected(invocationId,core.encodeRecord('return',{value:['undefined']}));
    core.selected(invocationId,core.encodeRecord('end',{kind:'return'}));
  }
  core.postEvent({subscriptionId:'callback-a',eventId:'earlier-other-realm',args:[1],deliver:false});
  core.postEvent({subscriptionId:'callback-b',eventId:'later-this-realm',args:[2],deliver:false});
  const delivered=core.deliverReadyEvents('callback-b');
  assert.equal(delivered.triggerId,'event:callback-b:later-this-realm');
});

test('durable queued callbacks stay private, restore once, and never register their host again',async t=>{
  const {h,store,directory,calls}=await fixture(t),before=h.modelContext('root');
  h.postEvent({subscriptionId:'callback1',eventId:'queued-one',args:[7],deliver:false});
  h.postEvent({subscriptionId:'callback1',eventId:'queued-two',args:[9],deliver:false});
  assert.deepEqual(h.modelContext('root'),before,'private arrivals must not alter the causal model prefix');
  assert.throws(()=>h.checkpoint(),/unjournaled native arrivals/);
  const packet=JSON.parse(JSON.stringify(await h.checkpointDurable({ingressStore:store})));
  assert(packet.ingress);assert(!JSON.stringify(packet).includes('queued-one'));
  assert.throws(()=>RegionExecutionHarness.restore(packet),/independently read durable ingress/);
  const restored=await RegionExecutionHarness.restoreDurable(packet,{ingressReceipt:packet.ingress,ingressStore:new DurableHostIngressStore({directory}),
    services:{'demo.listen':()=>{throw new Error('registration must not repeat');}}});
  assert.equal(restored.handlers.get('callback1').state,'lost');
  assert.deepEqual(restored.modelContext('root'),before);
  assert.equal(restored.deliverReadyEvents('callback1').invocationId,'event1');
  assert.deepEqual(restored.invocations.get('event1').controller.input.graph.roots[0],['num',7]);
  finish(restored,'event1',7);
  assert.equal(restored.deliverReadyEvents('callback1').invocationId,'event2');finish(restored,'event2',9);
  assert.equal(restored.deliverReadyEvents('callback1'),null);
  assert.equal(restored.exportEpisode().timeline.filter(row=>row.kind==='event').length,2);
  assert.equal(calls(),1);
  let receive;restored.inner.reattachSubscription('callback1',{evidenceId:'same-external-listener',attach:fn=>{receive=fn;}});
  assert.equal(receive('queued-one',[7]).status,'duplicate');
  assert.equal(restored.exportEpisode().timeline.filter(row=>row.kind==='handler').length,1);
  assert.deepEqual(RegionExecutionHarness.replay(restored.exportEpisode()).exportEpisode(),restored.exportEpisode());
});

test('fresh-process restore preserves private graph identities, special values and FIFO order',async t=>{
  const {h,store,directory}=await fixture(t);
  const object={marker:'not-model-visible'};object.self=object;
  h.postEvent({subscriptionId:'callback1',eventId:'graph',args:[object,object,-0,NaN,5n],deliver:false});
  const packet=await h.checkpointDurable({ingressStore:store}),path=join(directory,'checkpoint.json');
  await writeFile(path,JSON.stringify(packet));
  const script=`import {readFile} from 'node:fs/promises';
    import {RegionExecutionHarness as H} from ${JSON.stringify(new URL('../src/semantic/region-harness.js',import.meta.url).href)};
    import {DurableHostIngressStore as S} from ${JSON.stringify(new URL('../src/storage/host-ingress.js',import.meta.url).href)};
    const h=await H.restoreDurable(JSON.parse(await readFile(process.argv[1],'utf8')),{ingressStore:new S({directory:process.argv[2]}),ingressReceipt:JSON.parse(await readFile(process.argv[1],'utf8')).ingress});
    const args=h.handlers.get('callback1').queue[0].args;
    if(args[0]!==args[1]||args[0].self!==args[0]||!Object.is(args[2],-0)||!Number.isNaN(args[3])||args[4]!==5n)throw Error('graph changed');
    if(JSON.stringify(h.modelContext('root')).includes('not-model-visible'))throw Error('private input leaked');
    h.deliverReadyEvents('callback1');
    if(!JSON.stringify(h.modelContext('event1')).includes('not-model-visible'))throw Error('delivered input absent');
    process.stdout.write('restored-with-zero-dispatches');`;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',script,path,directory],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'restored-with-zero-dispatches');
});

test('durable queue snapshots bind source owners, exact public history and immutable storage',async t=>{
  const {h,store}=await fixture(t);
  h.postEvent({subscriptionId:'callback1',eventId:'one',args:[7],deliver:false});
  const packet=await h.checkpointDurable({ingressStore:store});
  for(const mutate of [p=>{delete p.ingress;},p=>{p.ingress.id='a'.repeat(64);},p=>{p.ingress.bytes++;},
    p=>{p.public.timeline[0].fields.session='other';}]){
    const forged=structuredClone(packet);mutate(forged);
    await assert.rejects(RegionExecutionHarness.restoreDurable(seal(forged),{ingressStore:store,ingressReceipt:packet.ingress}));
  }
  const snapshot=await store.get(packet.ingress);snapshot.queues[0].binding.entry='run';
  const forged=seal({...packet,ingress:await store.put(snapshot)});
  await assert.rejects(RegionExecutionHarness.restoreDurable(forged,{ingressStore:store,ingressReceipt:forged.ingress}),/source-owned handler/);
  await writeFile(store.objectPath(packet.ingress.id),'{}');
  await assert.rejects(RegionExecutionHarness.restoreDurable(packet,{ingressStore:store,ingressReceipt:packet.ingress}),/digest mismatch/);
});

test('failed or stale durable writes leave all arrivals queued and the original prefix untouched',async t=>{
  const {h,store}=await fixture(t);
  h.postEvent({subscriptionId:'callback1',eventId:'one',args:[7],deliver:false});
  const before=h.exportEpisode();
  await assert.rejects(h.checkpointDurable({ingressStore:{put:async()=>{throw Error('disk failed');},get:store.get.bind(store)}}),/disk failed/);
  assert.equal(h.handlers.get('callback1').queue.length,1);
  const changing={get:store.get.bind(store),put:async snapshot=>{
    const receipt=await store.put(snapshot);
    h.postEvent({subscriptionId:'callback1',eventId:'two',args:[8],deliver:false});return receipt;
  }};
  await assert.rejects(h.checkpointDurable({ingressStore:changing}),/differs from the current callback boundary/);
  assert.equal(h.handlers.get('callback1').queue.length,2);assert.deepEqual(h.exportEpisode(),before);
  const latest=await h.checkpointDurable({ingressStore:store});
  const restored=await RegionExecutionHarness.restoreDurable(latest,{ingressStore:store,ingressReceipt:latest.ingress});
  assert.deepEqual(restored.handlers.get('callback1').queue.map(row=>row.eventId),['one','two']);
});

test('mixed Promise/host continuations retain the same private ingress boundary',async t=>{
  const {store}=await fixture(t),verified=await verifyRegionTrainingCase(HOST_PROTOCOL_FIXTURES_V8[1]);
  assert(verified.exported,verified.reason);
  const data=verified.exported.public,cut=data.timeline.findIndex(row=>row.kind==='event');
  const h=RegionExecutionHarness.replay({...data,timeline:data.timeline.slice(0,cut)},{requireTerminal:false});
  assert(h.hasProtocol());const [subscriptionId]=h.handlers.keys(),before=h.modelContext(h.controller.rootInvocation);
  h.postEvent({subscriptionId,eventId:'pending-protocol',args:[3],deliver:false});
  const packet=await h.checkpointDurable({ingressStore:store});
  const restored=await RegionExecutionHarness.restoreDurable(packet,{ingressStore:store,ingressReceipt:packet.ingress});
  assert(restored.hasProtocol());assert.deepEqual(restored.modelContext(restored.controller.rootInvocation),before);
  assert.equal(restored.handlers.get(subscriptionId).queue[0].args[0],3);
  assert.equal(restored.controller.heap,restored.realms.get(restored.invocations.get(restored.controller.rootInvocation).realmId).heap);
});

test('return-value callback inputs remain private and explicitly await a separate recovery contract',async t=>{
  const {h}=await fixture(t);
  h.admitInvocation({programId:'p',invocationId:'next',trackId:'t',realmId:'r',triggerId:'next',realmPolicy:'retained'});
  const before=h.modelContext('next');
  h.inner.enqueueClosure({ownerInvocationId:'next',closureId:'fn',args:[{private:'hidden'}],receiver:{secret:5}});
  assert.deepEqual(h.modelContext('next'),before);
  assert.throws(()=>capturePendingIngress(h),/return-value callbacks/);
  assert.throws(()=>h.checkpoint(),/unjournaled native arrivals/);
});

test('private storage enforces byte bounds, canonical bytes and no-follow reads',async t=>{
  const {h,store,directory}=await fixture(t);
  h.postEvent({subscriptionId:'callback1',eventId:'one',args:[7],deliver:false});
  const snapshot=capturePendingIngress(h),receipt=await store.put(snapshot);
  assert.deepEqual(await store.put(snapshot),receipt);
  await assert.rejects(new DurableHostIngressStore({directory,maxBytes:2}).put(snapshot),/byte bound/);
  const target=store.objectPath(receipt.id),replacement=join(directory,'replacement.json');
  await writeFile(replacement,JSON.stringify(snapshot));await rm(target);await symlink(replacement,target);
  await assert.rejects(store.get(receipt),/ELOOP|symbolic link/i);
});
