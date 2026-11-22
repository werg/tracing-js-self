// Supplied-decoder recovery controls, not learned-model or source admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,appendFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {DurableHostIngressStore} from '../src/storage/host-ingress.js';
import {DurableHostIngressJournal,DurableHostIngressBroker} from '../src/storage/host-ingress-journal.js';
import {RegionSelectedModelDriver as Driver} from '../src/semantic/selected-execution-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {historyTestPolicy as policy,suppliedHistorySelector as suppliedSelector} from './helpers/supplied-native-history-v8.js';
const source='"use strict";function run(){return 1;}';
const line=(kind,fields)=>encodeDetailedRecord({kind,fields});
const seal=body=>({...body,digest:hashAlgorithmData(body)});
const site=(source,operation)=>{const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation===operation);return {start,end};};
const choose=request=>request.public.timeline.filter(row=>row.mode==='generated'&&row.fields.invocationId===request.context.invocationId).length===0?
  line('return',{value:['num',1]}):line('end',{kind:'return'});
function begin(source,services={},realmPolicy='fresh'){
  const harness=new RegionExecutionHarness({services,automaticDelivery:true});
  harness.publishProgram({programId:'p',source,entry:'run',capabilities:[...new Set(
    analyzeSemanticProgram(source).sites.map(row=>row.operation).filter(value=>value?.startsWith('demo.')))]});
  harness.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside',realmPolicy});return harness;
}
async function until(predicate){
  for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('Expected execution boundary was not reached');
}
async function finish(driver,id){const result=await driver.runInvocation(id);if(result.taskCompletion)await result.taskCompletion;
  await until(()=>!driver.running.size);return result;}
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'v8-selected-history-tail-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,historyJournal:new DurableSelectedHistoryJournal({directory,streamId:'driver'})};}

test('even a single authenticated cut rejects malformed native costs before opening model state',async t=>{
  const driver=new Driver({select:suppliedSelector(choose),harness:begin(source),...policy});
  await finish(driver,'call');const original=await driver.checkpoint();driver.close();
  for(const [field,value]of [['rpcCalls',-1],['rpcCalls',1.5],['rpcCalls',true],
    ['computeSeconds',-1],['computeSeconds','0'],['computeSeconds',false],
    ['peakMemoryBytes',-1],['peakMemoryBytes',null]])await t.test(field+'='+JSON.stringify(value),async()=>{
      const packet=structuredClone(original);packet.native.runtimeMetrics[field]=value;
      let {digest,...body}=packet.native;packet.native=seal(body);({digest,...body}=packet);
      const altered=seal(body),next=suppliedSelector(choose);
      await assert.rejects(Driver.restore(altered,{select:next,policy}),/cost accounting/);
      assert.equal(next.controls().restoreCalls,0);
      const entry={schema:'semantic-selected-history-entry/8',streamId:'driver',position:1,previous:null,checkpoint:altered};
      const receipt={schema:'semantic-selected-history-receipt/8',streamId:'driver',position:1,
        id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))};
      const other=suppliedSelector(choose);
      await assert.rejects(Driver.restoreLatest(altered,{select:other,policy,
        historyJournal:{readLatest:async()=>[entry]},historyReceipt:receipt}),/cost accounting/);
      assert.equal(other.controls().restoreCalls,0);
    });
});

test('restoration refuses checkpoint accessors without executing them',async()=>{
  const driver=new Driver({select:suppliedSelector(choose),harness:begin(source),...policy});
  const original=await driver.checkpoint();driver.close();
  for(const mode of ['restore','restoreLatest']){
    const packet=structuredClone(original);let reads=0;
    Object.defineProperty(packet,'native',{enumerable:true,get(){reads++;return original.native;}});
    const next=suppliedSelector(choose);
    await assert.rejects(Driver[mode](packet,{select:next,policy,
      historyJournal:{readLatest:async()=>{throw Error('should refuse before storage reads');}},historyReceipt:{}}));
    assert.equal(reads,0);assert.equal(next.controls().restoreCalls,0);
  }
});

test('an active driver refuses cancelled native-session authority before opening model state',async()=>{
  const driver=new Driver({select:suppliedSelector(choose),harness:begin(source),...policy});
  const original=await driver.checkpoint();driver.close();
  const session=original.bridge.public.timeline[0].fields.session;
  for(const closedSessions of [{[session]:null},{unrelated:null},[],null]){
    const packet=structuredClone(original);packet.native.native.closedSessions=closedSessions;
    let {digest,...body}=packet.native.native;packet.native.native=seal(body);
    ({digest,...body}=packet.native);packet.native=seal(body);
    ({digest,...body}=packet);const altered=seal(body),next=suppliedSelector(choose);
    await assert.rejects(Driver.restore(altered,{select:next,policy}),/closed native session/);
    assert.equal(next.controls().restoreCalls,0);
  }
});

test('fresh-process recovery selects the later acknowledged cut without repeating a completed host effect',async t=>{
  const {directory,historyJournal}=await fixture(t),effects=join(directory,'effects.txt');
  const hostSource='"use strict";function run(){return host.store("key",7);}';
  const records=[line('request',{effect:'write',operation:'demo.store',invocation:'call',
    arguments:[['str','key'],['num',7]],site:site(hostSource,'demo.store'),payload:'["key",7]'}),
    line('return',{value:['num',7]}),line('end',{kind:'return'})];
  const driver=new Driver({select:suppliedSelector(request=>records[request.public.timeline.filter(
    row=>row.mode==='generated').length]),harness:begin(hostSource,{'demo.store':async()=>{
      await appendFile(effects,'stored\n');return 7;
    }}),...policy});
  const first=await driver.checkpointDurableHistory({journal:historyJournal});
  await finish(driver,'call');
  const latest=await driver.checkpointDurableHistory({journal:historyJournal,previous:first.receipt});
  const input=join(directory,'restore.json');
  await writeFile(input,JSON.stringify({packet:first.checkpoint,head:latest.receipt,policy}));
  const recover=()=>spawnSync(process.execPath,['--input-type=module','--eval',`
    import assert from 'node:assert/strict';
    import {readFile,appendFile} from 'node:fs/promises';
    import {DurableSelectedHistoryJournal as Journal} from './src/storage/selected-history.js';
    import {RegionSelectedModelDriver as Driver} from './src/semantic/selected-execution-v8.js';
    import {suppliedHistorySelector as suppliedSelector} from './test/helpers/supplied-native-history-v8.js';
    const data=JSON.parse(await readFile(process.argv[1],'utf8'));
    const select=suppliedSelector(()=>{throw Error('completed output must not be regenerated');});
    const driver=await Driver.restoreLatest(data.packet,{select,policy:data.policy,
      historyJournal:new Journal({directory:process.argv[2],streamId:'driver'}),historyReceipt:data.head,
      harnessOptions:{services:{'demo.store':async()=>{await appendFile(process.argv[3],'duplicate\\n');return 7;}}}});
    const result=await driver.runInvocation('call');
    if(result.taskCompletion)await result.taskCompletion;
    assert.deepEqual(result.completion,{kind:'return',value:['num',7]});
    const packet=await driver.checkpoint();
    process.stdout.write(JSON.stringify({packet,metrics:driver.metrics(),restores:select.controls().restoreCalls}));
    driver.close();
  `,input,directory,effects],{cwd:process.cwd(),encoding:'utf8'});
  const child=recover();
  assert.equal(child.status,0,child.stderr);
  const recovered=JSON.parse(child.stdout);
  assert.deepEqual(recovered.packet.bridge.public,latest.checkpoint.bridge.public);
  assert.deepEqual(recovered.packet.attempts,latest.checkpoint.attempts);
  assert.equal(recovered.metrics.predictionAttempts,3);assert.equal(recovered.restores,1);
  assert.equal(await readFile(effects,'utf8'),'stored\n');
  // A later durable file is not authority to adopt a new head. Its existence
  // nevertheless prevents replaying the stale acknowledged prefix.
  driver.bridge.publishProgram({programId:'unacknowledged',source,entry:'run'});
  await driver.checkpointDurableHistory({journal:historyJournal,previous:latest.receipt});driver.close();
  const refused=recover();
  assert.equal(refused.status,1);
  assert.match(refused.stderr,/later durable history.*stale history recovery/);
  assert.equal(await readFile(effects,'utf8'),'stored\n');
});

test('an authenticated later cut restores its private callback snapshot before model state opens',async t=>{
  const {directory,historyJournal}=await fixture(t),ingressStore=new DurableHostIngressStore({directory});
  const callbackSource=source+'function handler(value){return value;}';
  const bridge=begin(callbackSource,{},'retained');
  bridge.registerEventHandler({subscriptionId:'listener',programId:'p',realmId:'r',trackId:'t',entry:'handler'});
  const driver=new Driver({select:suppliedSelector(choose),harness:bridge,...policy});
  await finish(driver,'call');const first=await driver.checkpointDurableHistory({journal:historyJournal});
  bridge.postEvent({subscriptionId:'listener',eventId:'saved-arrival',args:[1],deliver:false});
  const latest=await driver.checkpointDurableHistory({journal:historyJournal,previous:first.receipt,ingressStore});driver.close();
  const denied=suppliedSelector(choose);
  await assert.rejects(Driver.restoreLatest(first.checkpoint,{select:denied,policy,historyJournal,
    historyReceipt:latest.receipt}),/durable ingress storage/);
  assert.equal(denied.controls().restoreCalls,0);
  const next=suppliedSelector(choose),restored=await Driver.restoreLatest(first.checkpoint,{select:next,policy,
    historyJournal,historyReceipt:latest.receipt,harnessOptions:{ingressStore}});
  try{
    assert.equal(restored.bridge.handlers.get('listener').state,'lost');
    assert.equal(restored.metrics().predictionAttempts,2);
    restored.bridge.deliverReadyEvents('listener');
    await until(()=>restored.bridge.invocations.get('event1')?.status==='completed');
    await until(()=>!restored.running.size);
    assert.equal(restored.metrics().predictionAttempts,4);
    const saved=await restored.checkpointDurableHistory({journal:historyJournal,previous:latest.receipt,ingressStore});
    assert.equal(saved.checkpoint.bridge.ingress,undefined);
  }finally{restored.close();}
});

test('history validates each recorded ingress head and then admits an independently retained later input tail',async t=>{
  const {directory,historyJournal}=await fixture(t),ingressJournal=new DurableHostIngressJournal({directory,streamId:'inputs'});
  const bridge=begin(source+'function handler(value){return value;}',{},'retained');
  bridge.registerEventHandler({subscriptionId:'listener',programId:'p',realmId:'r',trackId:'t',entry:'handler'});
  const driver=new Driver({select:suppliedSelector(choose),harness:bridge,...policy});
  await finish(driver,'call');const first=await driver.checkpointDurableHistory({journal:historyJournal});
  const broker=new DurableHostIngressBroker({harness:bridge,journal:ingressJournal});
  await bridge.postEvent({subscriptionId:'listener',eventId:'at-cut',args:[1],deliver:false});await broker.flush();
  bridge.deliverReadyEvents('listener');
  await until(()=>bridge.invocations.get('event1')?.status==='completed');await until(()=>!driver.running.size);
  const latest=await driver.checkpointDurableHistory({journal:historyJournal,previous:first.receipt});
  await bridge.postEvent({subscriptionId:'listener',eventId:'later-tail',args:[1],deliver:false});await broker.flush();
  const inputHead=broker.receipt;driver.close();
  const next=suppliedSelector(choose),restored=await Driver.restoreLatest(first.checkpoint,{select:next,policy,
    historyJournal,historyReceipt:latest.receipt,harnessOptions:{ingressJournal,ingressLogReceipt:inputHead}});
  try{
    assert.equal(restored.metrics().predictionAttempts,4);
    assert.deepEqual(restored.bridge.exportEpisode(),latest.checkpoint.bridge.public);
    restored.bridge.deliverReadyEvents('listener');
    await until(()=>restored.bridge.invocations.get('event2')?.status==='completed');await until(()=>!restored.running.size);
    assert.equal(restored.metrics().predictionAttempts,6);
    assert.equal(restored.bridge.handlers.get('listener').seen.size,2);
  }finally{restored.close();}
});
