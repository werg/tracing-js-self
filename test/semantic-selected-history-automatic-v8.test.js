// Supplied-decoder durability controls. These do not claim learned selections.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,open,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {RegionSelectedModelDriver as Driver} from '../src/semantic/selected-execution-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {historyTestPolicy as policy,suppliedHistorySelector} from './helpers/supplied-native-history-v8.js';

const copy=structuredClone,line=(kind,fields)=>encodeDetailedRecord({kind,fields});
const plain='"use strict";function run(){return 7;}',
  host='"use strict";function run(){return host.store("key",7);}';
function begin(source=plain,services={}){
  const bridge=new RegionExecutionHarness({sessionId:'automatic-history',services,automaticDelivery:true});
  bridge.publishProgram({programId:'p',source,entry:'run',capabilities:source===host?['demo.store']:[]});
  bridge.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside'});
  return bridge;
}
function choice(source=plain){
  const records=[line('return',{value:['num',7]}),line('end',{kind:'return'})];
  if(source===host){
    const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation==='demo.store');
    records.unshift(line('request',{effect:'write',operation:'demo.store',invocation:'call',
      arguments:[['str','key'],['num',7]],site:{start,end},payload:'["key",7]'}));
  }
  return request=>records[request.public.timeline.filter(row=>row.mode==='generated').length];
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function finish(driver){
  const result=await driver.runInvocation('call');if(result.taskCompletion)await result.taskCompletion;
  await Promise.all([...driver.running.values()].map(row=>row.task));return result;
}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'v8-automatic-history-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new DurableSelectedHistoryJournal({directory,streamId:'automatic'}),path=join(directory,'trusted-head.json');
  let head=null;
  // This test's independently owned head is an atomic, fsynced file. The driver
  // receives only the acknowledgement capability, never reads an inferred head.
  const acknowledge=async({receipt,previous})=>{
    assert.deepEqual(previous,head);
    const next=join(directory,'head-next.json'),file=await open(next,'wx',0o600);
    try{await file.writeFile(JSON.stringify(receipt));await file.sync();}finally{await file.close();}
    await rename(next,path);const parent=await open(directory,'r');
    try{await parent.sync();}finally{await parent.close();}
    head=copy(receipt);return copy(head);
  };
  return {directory,journal,path,acknowledge,head:()=>copy(head)};
}

test('automatic history waits for a durable acknowledged head before dispatch and retains completed recovery',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred();let calls=0;
  const selector=suppliedHistorySelector(choice(host)),driver=new Driver({select:selector,
    harness:begin(host,{'demo.store':()=>{calls++;return 7;}}),...policy});
  t.after(()=>driver.close());
  const first=await driver.enableDurableHistory({journal:f.journal,acknowledge:async request=>{
    if(request.receipt.position===2){reached.resolve();await resume.promise;}
    return f.acknowledge(request);
  }});
  const task=finish(driver);await reached.promise;
  assert.equal(calls,0,'The model acknowledgement alone cannot authorize dispatch');
  assert.equal(driver.attempts[0].status,'accepted');assert.equal(driver.historyReceipt.position,1);
  resume.resolve();await task;
  assert.equal(calls,1);assert.equal(driver.historyReceipt.position,5);
  assert.deepEqual(JSON.parse(await readFile(f.path,'utf8')),driver.historyReceipt);
  const entries=await f.journal.readAll(driver.historyReceipt);
  assert.deepEqual(entries.map(row=>row.checkpoint.attempts.length),[0,1,2,3,3]);
  assert.deepEqual(entries.at(-1).checkpoint.attempts,driver.attempts);
  const fresh=suppliedHistorySelector(()=>{throw Error('Completed work must not be selected again');});
  const restored=await Driver.restoreLatest(first.checkpoint,{select:fresh,policy,historyJournal:f.journal,
    historyReceipt:f.head(),harnessOptions:{services:{'demo.store':()=>{calls++;return 8;}}}});
  t.after(()=>restored.close());
  await restored.enableDurableHistory({journal:f.journal,previous:f.head(),acknowledge:f.acknowledge});
  await finish(restored);
  assert.equal(calls,1);assert.equal(restored.metrics().predictionAttempts,3);
  assert.equal(restored.historyReceipt.position,7);
});

test('automatic history stops on append, independent-read or head-acknowledgement failure before external work',async t=>{
  for(const boundary of ['append','read','acknowledge','wrong-head'])await t.test(boundary,async t=>{
    const f=await fixture(t);let calls=0,acknowledgements=0;
    const journal={append:async(checkpoint,options)=>{
      if(boundary==='append'&&options.previous)throw Error('Injected append failure');
      return f.journal.append(checkpoint,options);
    },readAll:async receipt=>{
      const rows=await f.journal.readAll(receipt);
      if(boundary==='read'&&receipt.position===2)rows.at(-1).checkpoint.attempts[0].record='substituted';
      return rows;
    }};
    const driver=new Driver({select:suppliedHistorySelector(choice(host)),
      harness:begin(host,{'demo.store':()=>{calls++;return 7;}}),...policy});
    t.after(()=>driver.close());
    await driver.enableDurableHistory({journal,acknowledge:async request=>{
      acknowledgements++;
      if(request.receipt.position===2){
        if(boundary==='acknowledge')throw Error('Injected acknowledgement failure');
        if(boundary==='wrong-head')return {...request.receipt,id:'f'.repeat(64)};
      }
      return f.acknowledge(request);
    }});
    await assert.rejects(finish(driver));
    assert.equal(calls,0);assert.equal(driver.attempts.length,1);
    assert.equal(driver.historyReceipt.position,1);assert.equal(f.head().position,1);
    assert.equal(acknowledgements,['append','read'].includes(boundary)?1:2);
    assert.equal(driver.attempts[0].status,'accepted','A storage error must not erase the actual model acknowledgement');
    await assert.rejects(driver.checkpoint(),'A failed writer cannot continue from uncertain durability');
  });
});

test('a lost head acknowledgement leaves an independently recoverable accepted request with no dispatch',async t=>{
  const f=await fixture(t);let calls=0;
  const driver=new Driver({select:suppliedHistorySelector(choice(host)),
    harness:begin(host,{'demo.store':()=>{calls++;return 7;}}),...policy});
  t.after(()=>driver.close());
  const first=await driver.enableDurableHistory({journal:f.journal,acknowledge:async request=>{
    const receipt=await f.acknowledge(request);
    if(receipt.position===2)throw Error('Lost acknowledgement after durable head commit');
    return receipt;
  }});
  await assert.rejects(finish(driver),/Lost acknowledgement/);
  assert.equal(calls,0);assert.equal(driver.historyReceipt.position,1);assert.equal(f.head().position,2);
  const restored=await Driver.restoreLatest(first.checkpoint,{select:suppliedHistorySelector(choice(host)),
    policy,historyJournal:f.journal,historyReceipt:JSON.parse(await readFile(f.path,'utf8'))});
  t.after(()=>restored.close());
  assert.equal(restored.attempts.length,1);assert.equal(restored.attempts[0].status,'accepted');
  assert.equal(restored.bridge.exportEpisode().timeline.filter(row=>row.kind==='dispatch').length,0);
});

test('cancellation during a pending durable acknowledgement cannot dispatch after that acknowledgement arrives',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred(),acknowledged=deferred();let calls=0;
  const driver=new Driver({select:suppliedHistorySelector(choice(host)),harness:begin(host,{
    'demo.store':()=>{calls++;return 7;}}),...policy});t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:async request=>{
    if(request.receipt.position===2){reached.resolve();await resume.promise;}
    const result=await f.acknowledge(request);
    if(result.position===2)acknowledged.resolve();return result;
  }});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled while saving'));
  await assert.rejects(running,/Cancelled while saving/);
  assert.equal(calls,0);resume.resolve();await acknowledged.promise;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0);assert.equal(driver.attempts.length,1);
  await assert.rejects(driver.checkpoint());
  // The separately retained head covers the accepted pre-cancellation cut.
  // This mechanism does not invent a durable cancellation after that cut.
  assert.equal(f.head().position,2);
});

test('cancellation waits for an in-flight native commit and preserves a late positive acknowledgement',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred(),closed=deferred();let calls=0,cancellations=0;
  const select=suppliedHistorySelector(choice(host)),commit=select.commit;
  select.commit=async request=>{reached.resolve();await resume.promise;return commit(request);};
  select.cancel=async()=>{cancellations++;closed.resolve();return {closed:true};};
  const driver=new Driver({select,harness:begin(host,{'demo.store':()=>{calls++;return 7;}}),...policy});
  t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during native commit'));
  await assert.rejects(running,/Cancelled during native commit/);
  assert.equal(cancellations,0,'Cancellation must not race the native commit');
  assert.equal(driver.attempts[0].status,'acknowledgement-unknown');
  resume.resolve();await closed.promise;
  assert.equal(cancellations,1);assert.equal(calls,0);
  assert.equal(driver.attempts[0].status,'accepted');assert.equal(driver.attempts[0].commitReceipt.committed,true);
  assert.equal(select.controls().attempts[0].status,'accepted');
  assert.equal(f.head().position,1,'The later cancelled continuation is not falsely called durable');
});

test('cancellation waits for a pending original selection and retains its actual bytes without committing it',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred(),closed=deferred();let cancellations=0;
  const regular=choice(),select=suppliedHistorySelector(async request=>{
    reached.resolve();await resume.promise;return regular(request);
  });
  select.cancel=async()=>{cancellations++;closed.resolve();return {closed:true};};
  const driver=new Driver({select,harness:begin(),...policy});t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during original selection'));
  await assert.rejects(running,/Cancelled during original selection/);assert.equal(cancellations,0);
  resume.resolve();await closed.promise;
  assert.equal(cancellations,1);assert.equal(driver.attempts[0].status,'rejected');
  assert.equal(driver.attempts[0].record,line('return',{value:['num',7]}));
  assert.equal(driver.attempts[0].provenanceValidated,true);assert.equal(driver.contexts.length,0);
  assert.equal(f.head().position,1);
});

test('cancellation cannot close native state before a consumed stale attempt is rejected',async t=>{
  const f=await fixture(t),bridge=begin(),reached=deferred(),resume=deferred(),closed=deferred();
  let cancellations=0;
  const regular=choice(),select=suppliedHistorySelector(request=>{
    bridge.publishProgram({programId:'later',source:plain,entry:'run'});return regular(request);
  }),reject=select.reject;
  select.reject=async request=>{reached.resolve();await resume.promise;return reject(request);};
  select.cancel=async()=>{cancellations++;closed.resolve();return {closed:true};};
  const driver=new Driver({select,harness:bridge,...policy});t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during stale rejection'));
  await assert.rejects(running,/Cancelled during stale rejection/);assert.equal(cancellations,0);
  resume.resolve();await closed.promise;
  assert.equal(cancellations,1);assert.equal(driver.attempts[0].status,'stale');
  assert.equal(select.controls().attempts[0].status,'rejected');
  assert.equal(driver.metrics().staleRetries,1);assert.equal(f.head().position,1);
});

test('consumed stale attempts are acknowledged durably before another prediction is requested',async t=>{
  const f=await fixture(t),bridge=begin(),regular=choice();let driver;
  const selector=suppliedHistorySelector(request=>{
    if(request.attempt===0)bridge.publishProgram({programId:'later',source:plain,entry:'run'});
    else assert.equal(driver.historyReceipt.position,request.attempt+1);
    return regular(request);
  });
  driver=new Driver({select:selector,harness:bridge,...policy});t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  await finish(driver);
  const entries=await f.journal.readAll(f.head());
  assert.deepEqual(entries[1].checkpoint.attempts.map(row=>row.status),['stale']);
  assert.equal(entries[1].checkpoint.staleRetries,1);
  assert.deepEqual(entries.at(-1).checkpoint.attempts.map(row=>row.status),['stale','accepted','accepted']);
});

test('manual flushing saves later observed state and capability arguments cannot mutate the retained head',async t=>{
  const f=await fixture(t),driver=new Driver({select:suppliedHistorySelector(choice()),harness:begin(),...policy});
  t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:async request=>{
    const result=await f.acknowledge(request);request.receipt.position=100;
    if(request.previous)request.previous.position=99;return result;
  }});
  driver.bridge.publishProgram({programId:'later',source:plain,entry:'run'});
  const cut=await driver.flushDurableHistory();
  assert.equal(cut.receipt.position,2);assert.equal(driver.historyReceipt.position,2);
  assert.equal(cut.checkpoint.bridge.public.timeline.at(-1).fields.programId,'later');
  const exposed=driver.historyReceipt;exposed.position=77;assert.equal(driver.historyReceipt.position,2);
  await assert.rejects(driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge}),/already enabled/);
  await assert.rejects(driver.checkpointDurableHistory({journal:f.journal,previous:f.head()}),/automatic/);
});

test('automatic storage bounds stop execution and are never bypassed by returning a successful model record',async t=>{
  const f=await fixture(t);let calls=0;
  const journal=new DurableSelectedHistoryJournal({directory:f.directory,streamId:'bounded',maxEntries:1});
  const driver=new Driver({select:suppliedHistorySelector(choice(host)),harness:begin(host,{
    'demo.store':()=>{calls++;return 7;}}),...policy});t.after(()=>driver.close());
  await driver.enableDurableHistory({journal,acknowledge:async({receipt})=>receipt});
  await assert.rejects(finish(driver),/bound/);assert.equal(calls,0);
  assert.equal(driver.historyReceipt.position,1);assert.equal(driver.attempts.length,1);
});
