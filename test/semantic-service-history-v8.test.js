// Real service/history journals with supplied model-shaped snapshots. These
// controls establish durable ordering, not learned model or native admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {DurableFencedSelectedServiceJournal as Journal} from '../src/storage/selected-service-fence-journal.js';
import {SelectedServiceAdmissionCoordinator as Coordinator} from '../src/storage/selected-service-coordinator.js';
import {RegionSelectedModelDriver as Driver} from '../src/semantic/selected-execution-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {historyTestPolicy as basePolicy,suppliedHistorySelector} from './helpers/supplied-native-history-v8.js';

const sessionId='service-history',reason='Stop selected work',copy=structuredClone;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,Second=Journal,{acknowledge=null}={}){
  const directory=await mkdtemp(join(tmpdir(),'v8-service-history-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const services=[];
  for(const [index,serviceId]of ['alpha','beta'].entries()){
    const Type=index?Second:Journal,journal=new Type({directory,serviceId,sessionId});
    services.push({journal,owner:await journal.advanceOwner({ownerId:'worker'})});
  }
  const coordinator=new Coordinator({sessionId,services}),policy={...basePolicy,serviceAdmission:copy(coordinator.policy)},
    history=new DurableSelectedHistoryJournal({directory,streamId:'history'}),
    select=suppliedHistorySelector(()=>{throw Error('No new model output is authorized');});
  let head=null,nativeCloses=0;
  const cancel=select.cancel;select.cancel=async request=>{nativeCloses++;return cancel(request);};
  const harness=new RegionExecutionHarness({sessionId,automaticDelivery:true});
  harness.publishProgram({programId:'p',source:'"use strict";function run(){return 7;}',entry:'run'});
  harness.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside'});
  const driver=new Driver({select,harness,...policy,serviceAdmissionCoordinator:coordinator});
  t.after(()=>driver.close());
  const first=await driver.enableDurableHistory({journal:history,acknowledge:async request=>{
    assert.deepEqual(request.previous,head);head=copy(request.receipt);
    if(acknowledge)await acknowledge(request);return copy(head);
  }});
  const restore=(extra={})=>Driver.restoreLatest(first.checkpoint,{select:suppliedHistorySelector(()=>''),policy,
    historyJournal:history,historyReceipt:copy(head),serviceAdmissionCoordinator:coordinator,...extra});
  return {directory,services,coordinator,policy,history,select,driver,first,restore,
    head:()=>copy(head),nativeCloses:()=>nativeCloses};
}
const cancelFor=(f,why)=>f.driver.select.cancel({...f.driver.prefix('call'),reason:why});
const cancel=f=>cancelFor(f,reason);

test('driver waits for every service fence before terminal history and native close',async t=>{
  const reached=deferred(),resume=deferred();
  class Paused extends Journal{
    async _publishEntry(entry){
      if(entry.command.kind==='terminal'){reached.resolve();await resume.promise;}
      return super._publishEntry(entry);
    }
  }
  const f=await fixture(t,Paused),task=cancel(f);await reached.promise;
  assert.equal(f.head().position,1);assert.equal(f.nativeCloses(),0);
  assert.equal((await f.services[0].journal.inspect()).terminal.reason,reason);
  assert.equal((await f.services[1].journal.inspect()).terminal,null);
  resume.resolve();const result=await task;
  assert.equal(result.phase,'closed');assert.equal(f.nativeCloses(),1);assert.equal(f.head().position,3);
  const rows=await f.history.readAll(f.head());
  assert.deepEqual(rows.slice(1).map(row=>row.terminal.phase),['requested','closed']);
  for(const row of rows.slice(1))assert.deepEqual(row.terminal.serviceAdmission,result.serviceAdmission);
  const next=suppliedHistorySelector(()=>''),reopened=new Coordinator({sessionId,
    services:f.services.map(({journal,owner})=>({owner,journal:new Journal({directory:f.directory,
      sessionId,serviceId:journal.serviceId})}))});
  assert.deepEqual(await f.restore({select:next,serviceAdmissionCoordinator:reopened}),result);
  assert.equal(next.controls().restoreCalls,0);
});

test('partial fence failure cannot publish terminal history or reopen native state; exact live retry completes',async t=>{
  class Broken extends Journal{
    unavailable=false;
    async _synchronize(){if(this.unavailable)throw Error('service sync unavailable');return super._synchronize();}
  }
  const f=await fixture(t,Broken),second=f.services[1].journal;second.unavailable=true;
  await assert.rejects(cancel(f),/sync unavailable/);
  assert.equal(f.head().position,1);assert.equal(f.nativeCloses(),0);
  const next=suppliedHistorySelector(()=>''),nativeBefore=next.controls().restoreCalls;
  await assert.rejects(f.restore({select:next}),/terminal|sync unavailable/);
  assert.equal(next.controls().restoreCalls,nativeBefore);
  await assert.rejects(f.driver.retryServiceAdmissionCancellation(),/sync unavailable/);
  second.unavailable=false;
  const result=await f.driver.retryServiceAdmissionCancellation();
  assert.equal(result.phase,'closed');assert.equal(result.reason,reason);assert.equal(f.nativeCloses(),1);
  assert.deepEqual(result.serviceAdmission.services.map(row=>row.terminal.position),[2,2]);
  assert.throws(()=>f.driver.retryServiceAdmissionCancellation(),/only an unacknowledged service fence/);
});

test('terminal cancellation bounds UTF-8 reason bytes and carries the normalized reason through retry',async t=>{
  class Broken extends Journal{
    unavailable=false;
    async _synchronize(){if(this.unavailable)throw Error('service sync unavailable');return super._synchronize();}
  }
  const f=await fixture(t,Broken),second=f.services[1].journal,emojiReason='😀'.repeat(1025),
    normalizedEmojiReason='😀'.repeat(1024);
  second.unavailable=true;
  await assert.rejects(cancelFor(f,emojiReason),/service sync unavailable/);
  assert.equal((await f.services[0].journal.inspect()).terminal.reason,normalizedEmojiReason);
  await assert.rejects(f.driver.retryServiceAdmissionCancellation(),/service sync unavailable/);
  second.unavailable=false;
  const result=await f.driver.retryServiceAdmissionCancellation();
  assert.equal(result.phase,'closed');assert.equal(result.reason,normalizedEmojiReason);
  assert.equal(Buffer.byteLength(result.reason),4096);
  assert.equal(result.closeReceipt.reason,normalizedEmojiReason);
  assert.equal(result.serviceAdmission.reason,normalizedEmojiReason);
  const rows=await f.history.readAll(f.head());
  for(const row of rows.slice(1)){
    assert.equal(row.terminal.reason,normalizedEmojiReason);
    assert.equal(row.terminal.serviceAdmission.reason,normalizedEmojiReason);
  }
  for(const {journal}of f.services)
    assert.equal((await journal.inspect()).terminal.reason,normalizedEmojiReason);

  // 4095 ASCII bytes leave one byte in the limit; the four-byte code point
  // must be omitted whole instead of being split at that final byte.
  const boundary=await fixture(t),crossingReason='x'.repeat(4095)+'😀',
    normalizedBoundary='x'.repeat(4095),boundaryResult=await cancelFor(boundary,crossingReason);
  assert.equal(boundaryResult.phase,'closed');assert.equal(boundaryResult.reason,normalizedBoundary);
  assert.equal(Buffer.byteLength(boundaryResult.reason),4095);
  assert.equal(boundaryResult.closeReceipt.reason,normalizedBoundary);
  assert.equal(boundaryResult.serviceAdmission.reason,normalizedBoundary);
  const boundaryRows=await boundary.history.readAll(boundary.head());
  for(const row of boundaryRows.slice(1)){
    assert.equal(row.terminal.reason,normalizedBoundary);
    assert.equal(row.terminal.serviceAdmission.reason,normalizedBoundary);
  }
});

test('lost terminal-head acknowledgement retains service fences and cannot use the service-failure retry',async t=>{
  const f=await fixture(t,Journal,{acknowledge:request=>{
    if(request.receipt.position===2)throw Error('lost history acknowledgement');
  }});
  await assert.rejects(cancel(f),/lost history acknowledgement/);
  assert.equal(f.nativeCloses(),0);assert.equal(f.driver.historyReceipt.position,1);assert.equal(f.head().position,2);
  assert.throws(()=>f.driver.retryServiceAdmissionCancellation(),/only an unacknowledged service fence/);
  const restored=await f.restore();assert.equal(restored.phase,'requested');
  assert.deepEqual(restored.serviceAdmission.services.map(row=>row.serviceId),['alpha','beta']);
});

test('terminal recovery requires independent live service authority before acknowledging a disposition',async t=>{
  const f=await fixture(t);await cancel(f);
  await assert.rejects(f.restore({serviceAdmissionCoordinator:null}),/independently owned coordinator/);
  const missing=new Coordinator({sessionId,services:[f.services[0]]});
  await assert.rejects(f.restore({serviceAdmissionCoordinator:missing}),/policy changed/);
  const coordinator={policy:f.coordinator.policy,terminate:()=>{},assertActive:()=>{},
    verify:async()=>{throw Error('independent journal unavailable');}};
  const next=suppliedHistorySelector(()=>'' );
  await assert.rejects(f.restore({select:next,serviceAdmissionCoordinator:coordinator}),/journal unavailable/);
  assert.equal(next.controls().restoreCalls,0);
});

test('rehashed forged service receipts still refuse against actual service logs',async t=>{
  const f=await fixture(t);await cancel(f);
  const rows=copy(await f.history.readAll(f.head()));let previous=null;
  for(const row of rows){
    if(row.terminal)row.terminal.serviceAdmission.services[0].terminal.id='f'.repeat(64);
    row.previous=previous;
    previous={schema:'semantic-selected-history-receipt/8',streamId:row.streamId,position:row.position,
      id:hashAlgorithmData(row),bytes:Buffer.byteLength(stableAlgorithmJSON(row))};
  }
  await assert.rejects(f.restore({historyJournal:{readLatest:async()=>rows},historyReceipt:previous}),
    /independent service journal/);
});

test('missing service proof is rejected even when the full history chain is rehashed',async t=>{
  const f=await fixture(t);await cancel(f);
  const rows=copy(await f.history.readAll(f.head()));let previous=null;
  for(const row of rows){
    if(row.terminal)delete row.terminal.serviceAdmission;
    row.previous=previous;
    previous={schema:'semantic-selected-history-receipt/8',streamId:row.streamId,position:row.position,
      id:hashAlgorithmData(row),bytes:Buffer.byteLength(stableAlgorithmJSON(row))};
  }
  await assert.rejects(f.restore({historyJournal:{readLatest:async()=>rows},historyReceipt:previous}),/fields|serviceAdmission/);
});
