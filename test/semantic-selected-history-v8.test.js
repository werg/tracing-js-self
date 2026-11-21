// These supplied-decoder controls exercise durable orchestration and refusal
// boundaries. Actual model reconstruction remains a separate native gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {DurableHostIngressJournal,DurableHostIngressBroker} from '../src/storage/host-ingress-journal.js';
import {DurableHostIngressStore} from '../src/storage/host-ingress.js';
import {RegionSelectedModelDriver} from '../src/semantic/selected-execution-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {suppliedHistorySelector,historyTestPolicy as policy} from './helpers/supplied-native-history-v8.js';

const copy=structuredClone,seal=body=>({...body,digest:hashAlgorithmData(body)});
const line=(kind,fields)=>encodeDetailedRecord({kind,fields});
const site=(source,operation)=>{
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation===operation);return {start,end};
};
function begin(source,services={},realmPolicy='fresh'){
  const harness=new RegionExecutionHarness({sessionId:'history-session',services,automaticDelivery:true});
  harness.publishProgram({programId:'p',source,entry:'run',capabilities:[...new Set(
    analyzeSemanticProgram(source).sites.map(row=>row.operation).filter(value=>value?.startsWith('demo.')))]});
  harness.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside',realmPolicy});
  return harness;
}
async function until(predicate){
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('Expected execution boundary was not reached');
}
async function finish(driver,id='call'){
  const result=await driver.runInvocation(id);if(result.taskCompletion)await result.taskCompletion;
  await until(()=>!driver.running.size);return result;
}
async function fixture(t,streamId='history'){
  const directory=await mkdtemp(join(tmpdir(),'v8-selected-history-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,journal:new DurableSelectedHistoryJournal({directory,streamId})};
}
function returnChoice(request){
  const index=request.public.timeline.filter(row=>row.mode==='generated'&&
    row.fields.invocationId===request.context.invocationId).length;
  return index===0?line('return',{value:['num',1]}):line('end',{kind:'return'});
}
function rechain(rows){
  let receipt=null;
  rows=rows.map((row,index)=>{
    const entry={...copy(row),position:index+1,previous:receipt};
    const {digest,...body}=entry.checkpoint;entry.checkpoint=seal(body);
    receipt={schema:'semantic-selected-history-receipt/8',streamId:entry.streamId,position:entry.position,
      id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))};
    return entry;
  });
  return {rows,receipt};
}
function resealNative(packet){
  const {digest,...model}=packet.native.native;packet.native.native=seal(model);
  const {digest:outer,...transport}=packet.native;packet.native=seal(transport);
}
function resealBridge(packet){
  const {integrity,...body}=packet.bridge;packet.bridge={...body,integrity:hashAlgorithmData(body)};
}

test('an older recorded cut recovers later accepted and stale attempts with one host dispatch and no redispatch',async t=>{
  const {directory,journal}=await fixture(t);
  const source='"use strict";function run(){return host.readNumber("x");}';
  const records=[line('request',{effect:'read',operation:'demo.readNumber',invocation:'call',
    arguments:[['str','x']],site:site(source,'demo.readNumber'),payload:'["x"]'}),
    line('return',{value:['num',7]}),line('end',{kind:'return'})];
  let calls=0,resolveHost;
  const bridge=begin(source,{'demo.readNumber':()=>{calls++;return new Promise(resolve=>{resolveHost=resolve;});}});
  const choose=request=>{
    if(request.attempt===0)bridge.publishProgram({programId:'later',source:'"use strict";function run(){return 0;}',entry:'run'});
    return records[request.public.timeline.filter(row=>row.mode==='generated').length];
  };
  const driver=new RegionSelectedModelDriver({select:suppliedHistorySelector(choose),harness:bridge,...policy});
  const first=await driver.checkpointDurableHistory({journal});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});void running.catch(()=>{});
  await until(()=>calls===1);
  const second=await driver.checkpointDurableHistory({journal,previous:first.receipt});
  assert.deepEqual(second.checkpoint.attempts.map(row=>row.status),['stale','accepted']);
  assert.equal(second.checkpoint.bridge.public.timeline.at(-1).kind,'dispatch');
  const handoff=join(directory,'handoff.json');
  await writeFile(handoff,JSON.stringify({checkpoint:first.checkpoint,receipt:second.receipt,policy}));
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {readFile} from 'node:fs/promises';
    import {DurableSelectedHistoryJournal} from './src/storage/selected-history.js';
    import {RegionSelectedModelDriver} from './src/semantic/selected-execution-v8.js';
    import {suppliedHistorySelector} from './test/helpers/supplied-native-history-v8.js';
    const saved=JSON.parse(await readFile(process.argv[1],'utf8'));let calls=0;
    const select=suppliedHistorySelector(()=>{throw Error('Recovery generated a new candidate');});
    const driver=await RegionSelectedModelDriver.restoreLatest(saved.checkpoint,{select,policy:saved.policy,
      historyJournal:new DurableSelectedHistoryJournal({directory:process.argv[2],streamId:'history'}),
      historyReceipt:saved.receipt,harnessOptions:{services:{'demo.readNumber':()=>{calls++;return 99;}}}});
    const intent=driver.bridge.inner.intents.get('call/read');
    process.stdout.write(JSON.stringify({calls,status:intent.status,metrics:driver.metrics(),restores:select.controls().restoreCalls}));
    driver.close();
  `,handoff,directory],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const checked=JSON.parse(child.stdout);
  assert.equal(checked.calls,0);assert.equal(checked.status,'uncertain');assert.equal(checked.restores,1);
  assert.equal(checked.metrics.predictionAttempts,2);assert.equal(checked.metrics.staleRetries,1);
  abort.abort(new Error('simulated process loss'));await assert.rejects(running,/simulated process loss/);driver.close();
  const next=suppliedHistorySelector(request=>records[request.public.timeline.filter(row=>row.mode==='generated').length]);
  const restored=await RegionSelectedModelDriver.restoreLatest(first.checkpoint,{select:next,policy,
    historyJournal:new DurableSelectedHistoryJournal({directory,streamId:'history'}),historyReceipt:second.receipt,
    harnessOptions:{services:{'demo.readNumber':()=>{calls++;return 99;}}}});
  try{
    assert.deepEqual(restored.bridge.exportEpisode(),second.checkpoint.bridge.public);
    await assert.rejects(restored.bridge.dispatch('call','read'),/uncertain|reconcil|committed/);
    assert.equal(calls,1);
    restored.bridge.reconcile('call','read',{disposition:'fulfilled',value:7,evidenceId:'external-read-receipt'});
    const result=await finish(restored);assert.deepEqual(result.completion,{kind:'return',value:['num',7]});
    const third=await restored.checkpointDurableHistory({journal,previous:second.receipt});
    assert.equal(third.checkpoint.attempts.length,4);assert.equal(third.checkpoint.staleRetries,1);
    assert.deepEqual(third.checkpoint.attempts.slice(0,2),second.checkpoint.attempts);
    assert.equal(calls,1);
    const changed=await journal.readAll(third.receipt);
    changed[2].checkpoint.attempts[0].failure='rewritten stale rejection';
    const rewritten=rechain(changed),denied=suppliedHistorySelector(returnChoice);
    await assert.rejects(RegionSelectedModelDriver.restoreLatest(first.checkpoint,{select:denied,policy,
      historyJournal:{readAll:async()=>rewritten.rows},historyReceipt:rewritten.receipt}),/consumed driver attempts/);
    assert.equal(denied.controls().restoreCalls,0,'stale attempts are immutable consumed work too');
  }finally{restored.close();resolveHost(7);}
});

test('every recorded cut and all three consumed-attempt prefixes validate before native restore',async t=>{
  const {journal}=await fixture(t),driver=new RegionSelectedModelDriver({select:suppliedHistorySelector(returnChoice),
    harness:begin('"use strict";function run(){return 1;}'),...policy});
  const first=await driver.checkpointDurableHistory({journal});await finish(driver);
  const second=await driver.checkpointDurableHistory({journal,previous:first.receipt});
  driver.bridge.publishProgram({programId:'later',source:'"use strict";function run(){return 2;}',entry:'run'});
  const third=await driver.checkpointDurableHistory({journal,previous:second.receipt});driver.close();
  const original=await journal.readAll(third.receipt);
  const mutations=[
    ['driver evidence rewrite',rows=>{rows[2].checkpoint.attempts[0].generationMs++;}],
    ['transport evidence rewrite',rows=>{rows[2].checkpoint.native.attempts[0].changed=true;resealNative(rows[2].checkpoint);}],
    ['native evidence rewrite',rows=>{rows[2].checkpoint.native.native.attempts[0].generatedTokens++;resealNative(rows[2].checkpoint);}],
    ['driver budget rollback',rows=>{rows[2].checkpoint.attempts=[];}],
    ['native runtime cost rollback',rows=>{rows[2].checkpoint.native.runtimeMetrics.rpcCalls=0;resealNative(rows[2].checkpoint);}],
    ['causal context rewrite',rows=>{rows[2].checkpoint.contexts[0].visibleThrough++;}],
    ['native acknowledged prefix rollback',rows=>{const native=rows[2].checkpoint.native.native;
      native.sessions['history-session'].public.timeline.pop();resealNative(rows[2].checkpoint);}],
    ['native reconstruction omission',rows=>{rows[2].checkpoint.native.native.sessions['history-session'].replay=[];
      resealNative(rows[2].checkpoint);}],
    ['native completion rollback',rows=>{rows[2].checkpoint.native.native.sessions['history-session'].completed=[];
      resealNative(rows[2].checkpoint);}],
    ['policy substitution',rows=>{rows[2].checkpoint.policy.maxSelections++;}],
    ['invalid middle host continuation',rows=>{rows[1].checkpoint.bridge.regionCursor.active='invented';
      resealBridge(rows[1].checkpoint);}],
    ['invalid later host integrity',rows=>{rows[2].checkpoint.bridge.integrity='0'.repeat(64);}]
  ];
  for(const [name,mutate]of mutations){
    await t.test(name,async()=>{
      const changed=copy(original);mutate(changed);const {rows,receipt}=rechain(changed);
      const select=suppliedHistorySelector(returnChoice);
      await assert.rejects(RegionSelectedModelDriver.restoreLatest(first.checkpoint,{select,policy,
        historyJournal:{readAll:async()=>rows},historyReceipt:receipt}));
      assert.equal(select.controls().restoreCalls,0);
    });
  }
  for(const [name,rows]of [['omitted cut',original.slice(1)],['reordered cuts',[original[0],original[2],original[1]]]]){
    await t.test(name,async()=>{
      const select=suppliedHistorySelector(returnChoice);
      await assert.rejects(RegionSelectedModelDriver.restoreLatest(first.checkpoint,{select,policy,
        historyJournal:{readAll:async()=>rows},historyReceipt:third.receipt}));
      assert.equal(select.controls().restoreCalls,0);
    });
  }
  const denied=suppliedHistorySelector(returnChoice);
  await assert.rejects(RegionSelectedModelDriver.restoreLatest(first.checkpoint,{select:denied,
    policy:{...policy,maxSelections:17},historyJournal:journal,historyReceipt:third.receipt}),/externally expected/);
  assert.equal(denied.controls().restoreCalls,0);
  const next=suppliedHistorySelector(returnChoice),restored=await RegionSelectedModelDriver.restoreLatest(first.checkpoint,
    {select:next,policy,historyJournal:journal,historyReceipt:third.receipt});
  assert.equal(next.controls().restoreCalls,1);assert.equal(restored.metrics().predictionAttempts,2);restored.close();
});

test('a valid same-session branch or an unrecorded checkpoint cannot replace acknowledged history',async t=>{
  const {journal}=await fixture(t),driver=new RegionSelectedModelDriver({select:suppliedHistorySelector(returnChoice),
    harness:begin('"use strict";function run(){return 1;}'),...policy});
  await finish(driver);const first=await driver.checkpointDurableHistory({journal});
  const fork=await RegionSelectedModelDriver.restore(first.checkpoint,{select:suppliedHistorySelector(returnChoice),policy});
  driver.bridge.publishProgram({programId:'left',source:'"use strict";function run(){return 2;}',entry:'run'});
  const second=await driver.checkpointDurableHistory({journal,previous:first.receipt});
  fork.bridge.publishProgram({programId:'right',source:'"use strict";function run(){return 3;}',entry:'run'});
  const different=await fork.checkpoint();driver.close();fork.close();
  await assert.rejects(journal.append(different,{previous:second.receipt}),/public history.*exact extension/);
  const select=suppliedHistorySelector(returnChoice);
  await assert.rejects(RegionSelectedModelDriver.restoreLatest(different,{select,policy,historyJournal:journal,
    historyReceipt:second.receipt}),/absent/);
  assert.equal(select.controls().restoreCalls,0);
  const secondReader=suppliedHistorySelector(returnChoice);
  await assert.rejects(RegionSelectedModelDriver.restoreLatest(second.checkpoint,{select:secondReader,policy,
    historyJournal:journal,historyReceipt:first.receipt}),/absent/);
  assert.equal(secondReader.controls().restoreCalls,0,'an older head cannot authorize a later supplied checkpoint');
});

test('a later recorded observed boundary admits durable ingress but an unsaved later boundary still refuses',async t=>{
  const {directory,journal}=await fixture(t),ingressStore=new DurableHostIngressStore({directory}),
    ingressJournal=new DurableHostIngressJournal({directory,streamId:'arrivals'});
  const source='"use strict";function run(){return 1;}function handler(value){return value;}',bridge=begin(source,{},'retained');
  bridge.registerEventHandler({subscriptionId:'listener',programId:'p',realmId:'r',trackId:'t',entry:'handler'});
  const broker=new DurableHostIngressBroker({harness:bridge,journal:ingressJournal});
  const driver=new RegionSelectedModelDriver({select:suppliedHistorySelector(returnChoice),harness:bridge,...policy});
  await finish(driver);const first=await driver.checkpointDurableHistory({journal,ingressStore});
  const empty=await RegionSelectedModelDriver.restoreLatest(first.checkpoint,{select:suppliedHistorySelector(returnChoice),
    policy,historyJournal:journal,historyReceipt:first.receipt,harnessOptions:{ingressStore,ingressJournal}});
  assert.equal(empty.bridge.inner.hostIngressBroker??null,null,'no arrival head is adopted merely because a journal was supplied');
  empty.close();
  bridge.publishProgram({programId:'later',source:'"use strict";function run(){return 2;}',entry:'run'});
  await bridge.postEvent({subscriptionId:'listener',eventId:'one',args:[5],deliver:false});
  const second=await driver.checkpointDurableHistory({journal,previous:first.receipt,ingressStore});
  assert(second.checkpoint.bridge.ingress);assert.deepEqual(second.checkpoint.bridge.ingressLog,broker.receipt);
  const select=suppliedHistorySelector(returnChoice),restored=await RegionSelectedModelDriver.restoreLatest(first.checkpoint,
    {select,policy,historyJournal:journal,historyReceipt:second.receipt,harnessOptions:{ingressStore,ingressJournal}});
  assert.equal(select.controls().restoreCalls,1);
  assert.deepEqual(restored.bridge.exportEpisode(),second.checkpoint.bridge.public);
  assert.equal(restored.bridge.handlers.get('listener').queue.length,1);
  assert.equal(restored.bridge.handlers.get('listener').queue[0].eventId,'one');restored.close();
  bridge.publishProgram({programId:'unsaved',source:'"use strict";function run(){return 3;}',entry:'run'});
  await bridge.postEvent({subscriptionId:'listener',eventId:'two',args:[7],deliver:false});
  const denied=suppliedHistorySelector(returnChoice);
  await assert.rejects(RegionSelectedModelDriver.restoreLatest(first.checkpoint,{select:denied,policy,
    historyJournal:journal,historyReceipt:second.receipt,
    harnessOptions:{ingressStore,ingressJournal,ingressLogReceipt:broker.receipt}}),/later acknowledged public boundary/);
  assert.equal(denied.controls().restoreCalls,0);driver.close();
});

test('a later ingress head must extend the earlier recorded chain, not just increase its position',async t=>{
  const {directory,journal}=await fixture(t),ingressStore=new DurableHostIngressStore({directory});
  const source='"use strict";function run(){return 1;}function handler(value){return value;}';
  async function branch(name,events){
    const bridge=begin(source,{},'retained');
    bridge.registerEventHandler({subscriptionId:'listener',programId:'p',realmId:'r',trackId:'t',entry:'handler'});
    const ingressJournal=new DurableHostIngressJournal({directory:join(directory,name),streamId:'arrivals'});
    new DurableHostIngressBroker({harness:bridge,journal:ingressJournal});
    const driver=new RegionSelectedModelDriver({select:suppliedHistorySelector(returnChoice),harness:bridge,...policy});
    for(const [eventId,value]of events)await bridge.postEvent({subscriptionId:'listener',eventId,args:[value],deliver:false});
    const checkpoint=await driver.checkpoint({ingressStore});driver.close();return {checkpoint,ingressJournal};
  }
  const left=await branch('left',[['left',1]]),right=await branch('right',[['right',2],['later',3]]);
  const first=await journal.append(left.checkpoint),head=await journal.append(right.checkpoint,{previous:first});
  const select=suppliedHistorySelector(returnChoice),ingressJournal={
    append:async()=>{throw Error('Recovery appended host input');},
    readAll:receipt=>(receipt.id===left.checkpoint.bridge.ingressLog.id?left:right).ingressJournal.readAll(receipt)};
  await assert.rejects(RegionSelectedModelDriver.restoreLatest(left.checkpoint,{select,policy,
    historyJournal:journal,historyReceipt:head,harnessOptions:{ingressStore,ingressJournal}}),/earlier acknowledgement/);
  assert.equal(select.controls().restoreCalls,0);
  const rows=await journal.readAll(head);rows[1].checkpoint.bridge.ingressCursor=1;resealBridge(rows[1].checkpoint);
  const changed=rechain(rows),other=suppliedHistorySelector(returnChoice);
  await assert.rejects(RegionSelectedModelDriver.restoreLatest(left.checkpoint,{select:other,policy,
    historyJournal:{readAll:async()=>changed.rows},historyReceipt:changed.receipt,
    harnessOptions:{ingressStore,ingressJournal}}),/ingress cursor rolled back/);
  assert.equal(other.controls().restoreCalls,0);
});

test('a journal write failure or substituted acknowledgement never returns a successful durable cut',async()=>{
  const select=suppliedHistorySelector(returnChoice),driver=new RegionSelectedModelDriver({select,
    harness:begin('"use strict";function run(){return 1;}'),...policy});
  const original=driver.bridge.exportEpisode();
  await assert.rejects(driver.checkpointDurableHistory({journal:{readAll:async()=>[],
    append:async()=>{throw new Error('fsync failed');}}}),/fsync failed/);
  assert.deepEqual(driver.bridge.exportEpisode(),original);assert.equal(driver.attempts.length,0);
  let rows,receipt;
  const substituted={
    append:async checkpoint=>{
      checkpoint.native.runtimeMetrics.rpcCalls++;
      const {digest,...transport}=checkpoint.native;checkpoint.native=seal(transport);
      ({rows,receipt}=rechain([{schema:'semantic-selected-history-entry/8',streamId:'fake',position:1,previous:null,checkpoint}]));
      return receipt;
    },readAll:async()=>rows
  };
  await assert.rejects(driver.checkpointDurableHistory({journal:substituted}),/different complete checkpoint/);
  assert.deepEqual(driver.bridge.exportEpisode(),original);assert.equal(select.controls().restoreCalls,0);driver.close();
});

test('backend argument mutation cannot replace the separately captured expected history head',async t=>{
  const {journal}=await fixture(t),driver=new RegionSelectedModelDriver({select:suppliedHistorySelector(returnChoice),
    harness:begin('"use strict";function run(){return 1;}'),...policy});
  const first=await driver.checkpointDurableHistory({journal});await finish(driver);
  const mutating={
    readAll:async receipt=>{const saved=copy(receipt);receipt.id='0'.repeat(64);return journal.readAll(saved);},
    append:async(checkpoint,{previous})=>{const saved=copy(previous);previous.id='0'.repeat(64);
      return journal.append(checkpoint,{previous:saved});}
  };
  const second=await driver.checkpointDurableHistory({journal:mutating,previous:first.receipt});driver.close();
  const select=suppliedHistorySelector(returnChoice),restored=await RegionSelectedModelDriver.restoreLatest(first.checkpoint,
    {select,policy,historyJournal:mutating,historyReceipt:second.receipt});
  assert.equal(select.controls().restoreCalls,1);assert.equal(restored.metrics().predictionAttempts,2);restored.close();
  assert.notEqual(first.receipt.id,'0'.repeat(64));assert.notEqual(second.receipt.id,'0'.repeat(64));
});
