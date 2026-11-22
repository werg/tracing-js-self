// Supplied-decoder durability controls. These do not claim learned selections.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,open,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {RegionSelectedModelDriver as Driver} from '../src/semantic/selected-execution-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
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
async function until(predicate){
  for(let i=0;i<400;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('Expected automatic history boundary was not reached');
}
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
  await driver.terminalCancellation;
  assert.equal(calls,0);assert.equal(driver.attempts.length,1);
  await assert.rejects(driver.checkpoint());
  const entries=await f.journal.readAll(f.head());
  assert.equal(f.head().position,4);
  assert.deepEqual(entries.slice(-2).map(row=>row.terminal.phase),['requested','closed']);
  assert.equal(entries.at(-1).terminal.snapshot.attempts[0].status,'accepted');
});

test('a lost acknowledgement of the active checkpoint cannot be followed by guessed terminal authority',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred(),saved=deferred();let calls=0,cancellations=0;
  const selector=suppliedHistorySelector(choice(host)),cancel=selector.cancel;
  selector.cancel=async request=>{cancellations++;return cancel(request);};
  const driver=new Driver({select:selector,harness:begin(host,{'demo.store':()=>{calls++;return 7;}}),...policy});
  t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:async request=>{
    if(request.receipt.position===2){reached.resolve();await resume.promise;}
    const receipt=await f.acknowledge(request);
    if(receipt.position===2){saved.resolve();throw Error('Active cut acknowledgement was lost');}
    return receipt;
  }});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during uncertain active cut'));
  await assert.rejects(running,/Cancelled during uncertain active cut/);
  resume.resolve();await saved.promise;
  await assert.rejects(driver.terminalCancellation,/previous automatic history acknowledgement is uncertain/);
  assert.equal(calls,0);assert.equal(cancellations,0);
  assert.equal(driver.historyReceipt.position,1);assert.equal(f.head().position,2);
  assert.equal((await f.journal.readAll(f.head())).some(row=>Object.hasOwn(row,'terminal')),false);
  assert.equal(driver.attempts[0].status,'accepted','The returned native commit stays accepted despite lost storage ack');
});

test('cancellation waits for an in-flight native commit and preserves a late positive acknowledgement',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred(),closed=deferred();let calls=0,cancellations=0;
  const select=suppliedHistorySelector(choice(host)),commit=select.commit;
  select.commit=async request=>{reached.resolve();await resume.promise;return commit(request);};
  select.cancel=async input=>{cancellations++;closed.resolve();return {schema:'semantic-native-close/8',
    closed:true,session:input.session,reason:input.reason};};
  const driver=new Driver({select,harness:begin(host,{'demo.store':()=>{calls++;return 7;}}),...policy});
  t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during native commit'));
  await assert.rejects(running,/Cancelled during native commit/);
  assert.equal(cancellations,0,'Cancellation must not race the native commit');
  assert.equal(driver.attempts[0].status,'acknowledging');
  await until(()=>driver.historyReceipt?.position===2||driver.terminalCancellationError);
  assert.equal(driver.historyReceipt?.position,2,driver.terminalCancellationError?.stack);
  assert.equal(f.head().position,2,'The durable request revokes the older active cut before waiting for commit');
  resume.resolve();await closed.promise;
  const disposition=await driver.terminalCancellation;
  assert.equal(cancellations,1);assert.equal(calls,0);
  assert.equal(driver.attempts[0].status,'accepted');assert.equal(driver.attempts[0].commitReceipt.committed,true);
  assert.equal(select.controls().attempts[0].status,'accepted');
  assert.equal(disposition.phase,'closed');assert.equal(f.head().position,3);
  const entries=await f.journal.readAll(f.head());
  assert.deepEqual(entries.slice(-2).map(row=>row.terminal.phase),['requested','closed']);
  assert.equal(entries.at(-2).terminal.snapshot.attempts[0].status,'acknowledging');
  assert.equal(entries.at(-1).terminal.snapshot.attempts[0].status,'accepted');
});

test('a late unknown native commit remains unknown in the terminal suffix and never dispatches',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred(),closed=deferred();let calls=0;
  const selector=suppliedHistorySelector(choice(host));
  selector.commit=async request=>{reached.resolve();await resume.promise;const error=Error('Native commit reply lost');
    error.acknowledgementUnknown=true;throw error;};
  selector.cancel=async input=>{closed.resolve();return {schema:'semantic-native-close/8',
    closed:true,session:input.session,reason:input.reason};};
  const driver=new Driver({select:selector,harness:begin(host,{'demo.store':()=>{calls++;return 7;}}),...policy});
  t.after(()=>driver.close());await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during unresolved native commit'));
  await assert.rejects(running,/Cancelled during unresolved native commit/);
  await until(()=>driver.historyReceipt?.position===2||driver.terminalCancellationError);
  assert.equal(driver.historyReceipt.position,2);
  resume.resolve();await closed.promise;const disposition=await driver.terminalCancellation;
  assert.equal(disposition.phase,'closed');assert.equal(calls,0);
  assert.equal(driver.attempts[0].status,'acknowledgement-unknown');
  assert.equal(Object.hasOwn(driver.attempts[0],'commitReceipt'),false);
  const entries=await f.journal.readAll(f.head()),terminal=entries.at(-1).terminal;
  assert.deepEqual(entries.slice(-2).map(row=>row.terminal.phase),['requested','closed']);
  assert.equal(terminal.snapshot.attempts[0].status,'acknowledgement-unknown');
  assert.equal(terminal.snapshot.attempts[0].failure,'Native commit reply lost');
  assert.equal(terminal.snapshot.nativeMetrics.attempts[0].status,'decoded',
    'The selector metrics keep their own unacknowledged state instead of fabricating acceptance');
});

test('cancellation waits for a pending original selection and retains its actual bytes without committing it',async t=>{
  const f=await fixture(t),reached=deferred(),resume=deferred(),closed=deferred();let cancellations=0;
  const regular=choice(),select=suppliedHistorySelector(async request=>{
    reached.resolve();await resume.promise;return regular(request);
  });
  select.cancel=async input=>{cancellations++;closed.resolve();return {schema:'semantic-native-close/8',
    closed:true,session:input.session,reason:input.reason};};
  const driver=new Driver({select,harness:begin(),...policy});t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during original selection'));
  await assert.rejects(running,/Cancelled during original selection/);assert.equal(cancellations,0);
  await until(()=>driver.historyReceipt?.position===2||driver.terminalCancellationError);
  assert.equal(driver.historyReceipt?.position,2,driver.terminalCancellationError?.stack);
  assert.equal(f.head().position,2,'The request is independently acknowledged while selection is still pending');
  resume.resolve();await closed.promise;
  await driver.terminalCancellation;
  assert.equal(cancellations,1);assert.equal(driver.attempts[0].status,'rejected');
  assert.equal(driver.attempts[0].record,line('return',{value:['num',7]}));
  assert.equal(driver.attempts[0].provenanceValidated,true);assert.equal(driver.contexts.length,0);
  assert.equal(f.head().position,3);
  const entries=await f.journal.readAll(f.head());
  assert.deepEqual(entries.slice(-2).map(row=>row.terminal.phase),['requested','closed']);
  assert.equal(entries.at(-2).terminal.snapshot.attempts[0].status,'submitted');
  assert.equal(entries.at(-1).terminal.snapshot.attempts[0].status,'rejected');
});

test('cancellation cannot close native state before a consumed stale attempt is rejected',async t=>{
  const f=await fixture(t),bridge=begin(),reached=deferred(),resume=deferred(),closed=deferred();
  let cancellations=0;
  const regular=choice(),select=suppliedHistorySelector(request=>{
    bridge.publishProgram({programId:'later',source:plain,entry:'run'});return regular(request);
  }),reject=select.reject;
  select.reject=async request=>{reached.resolve();await resume.promise;return reject(request);};
  select.cancel=async input=>{cancellations++;closed.resolve();return {schema:'semantic-native-close/8',
    closed:true,session:input.session,reason:input.reason};};
  const driver=new Driver({select,harness:bridge,...policy});t.after(()=>driver.close());
  await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const abort=new AbortController(),running=driver.runInvocation('call',{signal:abort.signal});
  await reached.promise;abort.abort(new Error('Cancelled during stale rejection'));
  await assert.rejects(running,/Cancelled during stale rejection/);assert.equal(cancellations,0);
  await until(()=>driver.historyReceipt?.position===2||driver.terminalCancellationError);
  assert.equal(driver.historyReceipt?.position,2,driver.terminalCancellationError?.stack);
  assert.equal(f.head().position,2,'The terminal request is recorded before the native rejection settles');
  resume.resolve();await closed.promise;await driver.terminalCancellation;
  assert.equal(cancellations,1);assert.equal(driver.attempts[0].status,'stale');
  assert.equal(select.controls().attempts[0].status,'rejected');
  assert.equal(driver.metrics().staleRetries,1);assert.equal(f.head().position,3);
  const entries=await f.journal.readAll(f.head());
  assert.deepEqual(entries.slice(-2).map(row=>row.terminal.phase),['requested','closed']);
});

test('lost terminal-head acknowledgement cannot close, and a fresh process returns the retained request disposition',async t=>{
  const f=await fixture(t);let cancellations=0;
  const selector=suppliedHistorySelector(choice());
  selector.cancel=async input=>{cancellations++;return {schema:'semantic-native-close/8',
    closed:true,session:input.session,reason:input.reason};};
  const driver=new Driver({select:selector,harness:begin(),...policy});t.after(()=>driver.close());
  const first=await driver.enableDurableHistory({journal:f.journal,acknowledge:async request=>{
    const receipt=await f.acknowledge(request);
    if(request.receipt.position===2)throw Error('Lost terminal head acknowledgement');
    return receipt;
  }});
  await assert.rejects(driver.select.cancel(driver.prefix('call')),/Lost terminal head acknowledgement/);
  assert.equal(cancellations,0,'An uncertain terminal request cannot authorize native close');
  assert.equal(driver.historyReceipt.position,1,'The failed writer never adopts a guessed head');
  const retainedHead=f.head();assert.equal(retainedHead.position,2);
  const next=suppliedHistorySelector(choice()),restored=await Driver.restoreLatest(first.checkpoint,{select:next,policy,
    historyJournal:new DurableSelectedHistoryJournal({directory:f.directory,streamId:'automatic'}),
    historyReceipt:retainedHead});
  assert.equal(restored.schema,'semantic-selected-terminal-disposition/1');
  assert.equal(restored.phase,'requested');assert.equal(next.controls().restoreCalls,0);

  const input=join(f.directory,'terminal-restore.json'),policyPath=join(f.directory,'terminal-policy.json'),
    childResultPath=join(f.directory,'terminal-restore-result.json');
  await writeFile(input,JSON.stringify({checkpoint:first.checkpoint,receipt:first.receipt}));
  await writeFile(policyPath,JSON.stringify(policy));
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/qualify-v8-terminal-history.mjs',
    import.meta.url)),'--terminal-restore-child',input,f.path,f.directory,'automatic',policyPath,
    'requested',childResultPath],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const childResult=JSON.parse(await readFile(childResultPath,'utf8'));
  assert.equal(childResult.disposition.phase,'requested');
  assert.equal(childResult.olderPacketPosition,1);
  assert.equal(childResult.nativeRestoreCalls,0);
  assert.equal(childResult.nativeSamplingCalls,0);
  assert.equal(childResult.hostServiceLookups,0);

  const rows=await f.journal.readAll(retainedHead),omitted=suppliedHistorySelector(choice());
  await assert.rejects(Driver.restoreLatest(first.checkpoint,{select:omitted,policy,
    historyJournal:{readLatest:async()=>rows.slice(0,1)},historyReceipt:retainedHead}),/incomplete acknowledged chain/);
  assert.equal(omitted.controls().restoreCalls,0,'An omitted terminal suffix is refused before native state opens');
  const forged=suppliedHistorySelector(choice()),base=rows.at(-1),event={...base.terminal,phase:'closed',
    closeReceipt:{schema:'forged-close/8',closed:true,session:base.terminal.session,
      reason:base.terminal.reason}},
    entry={schema:'semantic-selected-history-entry/8',streamId:'automatic',position:3,previous:retainedHead,
      checkpoint:base.checkpoint,terminal:event},bytes=Buffer.byteLength(stableAlgorithmJSON(entry)),
    head={schema:'semantic-selected-history-receipt/8',streamId:'automatic',position:3,
      id:hashAlgorithmData(entry),bytes};
  await assert.rejects(Driver.restoreLatest(first.checkpoint,{select:forged,policy,
    historyJournal:{readLatest:async()=>[...rows,entry]},historyReceipt:head}),/native close receipt/);
  assert.equal(forged.controls().restoreCalls,0,'A forged close receipt cannot open native state');
});

test('consumer-shaped native close reason is retained and malformed close evidence is rejected before native restore',async t=>{
  const f=await fixture(t),driver=new Driver({select:suppliedHistorySelector(choice()),
    harness:begin(),...policy});
  t.after(()=>driver.close());
  const first=await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge}),
    reason='consumer-shaped cancellation with authoritative reason';
  const closed=await driver.select.cancel({...driver.prefix('call'),reason});
  assert.equal(closed.phase,'closed');
  const entries=await f.journal.readAll(f.head()),saved=entries.at(-1);
  assert.deepEqual(saved.terminal.closeReceipt,{schema:'semantic-native-close/8',closed:true,
    session:'automatic-history',reason});
  assert.equal(saved.terminal.reason,reason);
  const recovered=suppliedHistorySelector(choice()),disposition=await Driver.restoreLatest(first.checkpoint,
    {select:recovered,policy,historyJournal:f.journal,historyReceipt:f.head()});
  assert.equal(disposition.phase,'closed');
  assert.equal(disposition.closeReceipt.reason,reason);
  assert.equal(recovered.controls().restoreCalls,0);

  const closeReceipt=saved.terminal.closeReceipt,
    invalid=[
      {...closeReceipt,extension:'unbound'},
      {...closeReceipt,reason:17},
      {...closeReceipt,reason:'different terminal reason'},
      {...closeReceipt,closed:1},
      {...closeReceipt,session:17},
      {schema:closeReceipt.schema,closed:closeReceipt.closed,session:closeReceipt.session}
    ];
  for(const candidate of invalid){
    const terminal={...saved.terminal,closeReceipt:candidate},
      badEntry={...saved,terminal},
      receipt={schema:'semantic-selected-history-receipt/8',streamId:saved.streamId,
        position:saved.position,id:hashAlgorithmData(badEntry),
        bytes:Buffer.byteLength(stableAlgorithmJSON(badEntry))},
      selector=suppliedHistorySelector(choice());
    await assert.rejects(Driver.restoreLatest(first.checkpoint,{select:selector,policy,
      historyJournal:{readLatest:async()=>[...entries.slice(0,-1),badEntry]},historyReceipt:receipt}),
      /native close receipt/);
    assert.equal(selector.controls().restoreCalls,0,'Invalid close evidence cannot open native state');
  }
});

test('native close failure is retained as unknown without a positive close receipt',async t=>{
  const f=await fixture(t),selector=suppliedHistorySelector(choice());let cancellations=0;
  selector.cancel=async()=>{cancellations++;throw Error('Native close reply was lost');};
  const driver=new Driver({select:selector,harness:begin(),...policy});t.after(()=>driver.close());
  const first=await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const result=await driver.select.cancel(driver.prefix('call'));
  assert.equal(result.phase,'unknown');assert.equal(result.failure,'Native close reply was lost');
  assert.equal(cancellations,1);assert.equal(f.head().position,3);
  const entries=await f.journal.readAll(f.head());
  assert.deepEqual(entries.slice(-2).map(row=>row.terminal.phase),['requested','unknown']);
  assert.equal(Object.hasOwn(entries.at(-1).terminal,'closeReceipt'),false);
  const next=suppliedHistorySelector(choice()),restored=await Driver.restoreLatest(first.checkpoint,{select:next,policy,
    historyJournal:f.journal,historyReceipt:f.head()});
  assert.equal(restored.phase,'unknown');assert.equal(next.controls().restoreCalls,0);
});

test('terminal recovery retains anchored native costs and original attempt bytes even under a rehashed head',async t=>{
  const f=await fixture(t),selector=suppliedHistorySelector(choice()),
    driver=new Driver({select:selector,harness:begin(),...policy});
  t.after(()=>driver.close());
  const first=await driver.enableDurableHistory({journal:f.journal,acknowledge:f.acknowledge});
  const chosen=await driver.select(driver.prefix('call'));
  driver.harness.selected('call',chosen.record);
  await driver.onCommitted({invocationId:'call',...chosen});
  await driver.select.cancel({context:{invocationId:'call'},reason:'retain consumed native costs'});
  const original=await f.journal.readAll(f.head()),fresh=suppliedHistorySelector(choice());
  const positive=await Driver.restoreLatest(first.checkpoint,{select:fresh,policy,
    historyJournal:f.journal,historyReceipt:f.head()});
  assert.equal(positive.phase,'closed');assert.equal(fresh.controls().restoreCalls,0);
  assert(original.at(-1).checkpoint.native.runtimeMetrics.rpcCalls>0);
  for(const [label,change,message]of [
    ['missing native metrics',snapshot=>{snapshot.nativeMetrics=null;},/native metrics/],
    ['rolled-back native costs',snapshot=>{snapshot.nativeMetrics.runtime.rpcCalls=0;},/cost accounting/],
    ['changed original native bytes',snapshot=>{snapshot.nativeMetrics.attempts[0].record='substituted';},
      /original native attempts/]
  ])await t.test(label,async()=>{
    const entries=copy(original);let head=null;
    for(const entry of entries){
      entry.previous=copy(head);
      if(entry.terminal){
        change(entry.terminal.snapshot);
        entry.terminal.snapshotDigest=hashAlgorithmData(entry.terminal.snapshot);
      }
      head={schema:'semantic-selected-history-receipt/8',streamId:entry.streamId,position:entry.position,
        id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))};
    }
    const select=suppliedHistorySelector(()=>{throw Error('Invalid terminal history cannot sample');});
    await assert.rejects(Driver.restoreLatest(first.checkpoint,{select,policy,
      historyJournal:{readLatest:async()=>entries},historyReceipt:head}),message);
    assert.equal(select.controls().restoreCalls,0,'Invalid terminal evidence cannot open native state');
  });
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
