import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableFencedSelectedServiceJournal as Journal} from '../src/storage/selected-service-fence-journal.js';
import {SelectedServiceAdmissionCoordinator as Coordinator} from '../src/storage/selected-service-coordinator.js';

const sessionId='coordinated-session',reason='Stop selected work';
async function fixture(t,Second=Journal){
  const directory=await mkdtemp(join(tmpdir(),'v8-service-coordinator-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const services=[];
  for(const [index,serviceId]of ['alpha','beta'].entries()){
    const Type=index?Second:Journal,journal=new Type({directory,serviceId,sessionId}),
      owner=structuredClone(await journal.advanceOwner({ownerId:'worker'}));
    services.push({journal,owner});
  }
  return {directory,services,coordinator:new Coordinator({sessionId,services})};
}

test('coordinator fences the complete declared set and verifies it in independently reopened journals',async t=>{
  const {directory,services,coordinator}=await fixture(t),
    fence=await coordinator.terminate({sessionId,reason});
  await assert.rejects(coordinator.assertActive(),/terminal/);
  assert.deepEqual(fence.services.map(row=>row.serviceId),['alpha','beta']);
  const reopened=new Coordinator({sessionId,services:services.map(({journal,owner})=>({owner,
    journal:new Journal({directory,sessionId,serviceId:journal.serviceId})}))});
  assert.deepEqual(await reopened.verify(JSON.parse(JSON.stringify(fence))),fence);
  assert.deepEqual(await reopened.terminate({sessionId,reason}),fence);
  for(const {journal,owner}of services)
    await assert.rejects(journal.advanceOwner({previous:owner,ownerId:'successor'}),
      error=>error.code==='session-terminal');
});

test('partial service fencing stays partial on I/O failure and exact retry finishes without reopening',async t=>{
  class Unavailable extends Journal{
    unavailable=false;
    async _synchronize(){if(this.unavailable)throw Error('service sync unavailable');return super._synchronize();}
  }
  const {services,coordinator}=await fixture(t,Unavailable),[first,second]=services;
  second.journal.unavailable=true;
  await assert.rejects(coordinator.terminate({sessionId,reason}),/sync unavailable/);
  assert.equal((await first.journal.inspect()).terminal.reason,reason);
  await assert.rejects(coordinator.terminate({sessionId,reason}),/sync unavailable/);
  await assert.rejects(first.journal.advanceOwner({previous:first.owner,ownerId:'retry'}),
    error=>error.code==='session-terminal');
  second.journal.unavailable=false;
  const fence=await coordinator.terminate({sessionId,reason});
  assert.deepEqual(fence.services.map(row=>row.terminal.position),[2,2]);
  assert.deepEqual(await coordinator.verify(fence),fence);
});

test('new ownership refuses stale coordinated shutdown even when an earlier service is already fenced',async t=>{
  const {services,coordinator}=await fixture(t),[first,second]=services;
  assert.deepEqual(await coordinator.assertActive(),coordinator.policy);
  await second.journal.advanceOwner({previous:second.owner,ownerId:'successor'});
  await assert.rejects(coordinator.assertActive(),/different owner/);
  await assert.rejects(coordinator.terminate({sessionId,reason}),error=>error.code==='stale-owner');
  assert.equal((await first.journal.inspect()).terminal.reason,reason);
  assert.equal((await second.journal.inspect()).terminal,null);
});

test('recovered service proof refuses changed scope, owner, receipt, reason and missing members',async t=>{
  const {coordinator}=await fixture(t),fence=await coordinator.terminate({sessionId,reason});
  const mutations={
    session:value=>{value.sessionId='other';},
    reason:value=>{value.reason='different';},
    missing:value=>{value.services.pop();},
    duplicate:value=>{value.services[1]=structuredClone(value.services[0]);},
    reordered:value=>{value.services.reverse();},
    owner:value=>{value.services[0].owner.id='f'.repeat(64);},
    terminal:value=>{value.services[0].terminal.id='e'.repeat(64);},
    extra:value=>{value.extra=true;}
  };
  for(const [name,mutate]of Object.entries(mutations))await t.test(name,async()=>{
    const changed=structuredClone(fence);mutate(changed);await assert.rejects(coordinator.verify(changed));
  });
});

test('service set and owner snapshots cannot be changed by the caller after construction',async t=>{
  const {services,coordinator}=await fixture(t);
  services[0].owner.id='0'.repeat(64);services.reverse();services.pop();
  assert.throws(()=>coordinator.policy.serviceIds.push('third'));
  assert.deepEqual((await coordinator.terminate({sessionId,reason})).services.map(row=>row.serviceId),['alpha','beta']);
});

test('invalid coordinated policy is rejected before writing any service terminal entry',async t=>{
  const {services}=await fixture(t);
  assert.throws(()=>new Coordinator({sessionId,services:[services[0],services[0]]}),/sorted set/);
  assert.throws(()=>new Coordinator({sessionId:'other',services}),/scoped journal/);
  assert.throws(()=>new Coordinator({sessionId,services:[]}),/bounded service/);
  const coordinator=new Coordinator({sessionId,services});
  await assert.rejects(coordinator.terminate({sessionId:'other',reason}),/exact session/);
  await assert.rejects(coordinator.terminate({sessionId,reason:'😀'.repeat(1025)}),/bounded terminal reason/);
  for(const {journal}of services)assert.equal((await journal.inspect()).terminal,null);
});
