import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {SelectedIntentJournal} from '../src/training/intent-journal.js';
import {SelectedExecutionLifecycleV8 as Lifecycle} from '../src/semantic/lifecycle-v8.js';
import {RegionExecutionHarness as Region} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const source='"use strict";function run(){return host.store("key",7);}';
const copy=value=>JSON.parse(JSON.stringify(value));
const select=(h,kind,fields)=>h instanceof Region?h.select('call',{kind,fields}):
  h.selected('call',encodeDetailedRecord({kind,fields}));
function fixture(options={},H=Lifecycle){
  const h=new H({sessionId:'durable-actions',...options});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.store']});
  h.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside'});
  const {start,end}=analyzeSemanticProgram(source).sites.find(row=>row.operation==='demo.store');
  select(h,'request',{effect:'e',operation:'demo.store',invocation:'call',
    arguments:[['str','key'],['num',7]],site:{start,end},payload:'["key",7]'});
  return h;
}
async function journalFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'v8-actions-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,journal:new SelectedIntentJournal({directory})};
}
function wrap(journal,overrides){
  return {append:journal.append.bind(journal),claim:journal.claim.bind(journal),
    readIntent:journal.readIntent.bind(journal),...overrides};
}
function finish(h,value=7){
  select(h,'return',{value:['num',value]});select(h,'end',{kind:'return'});
}

test('a fresh process detects a later durable intent behind an older checkpoint without repeating the adapter',async t=>{
  const {directory,journal}=await journalFixture(t),effects=join(directory,'effects.jsonl'),
    packetFile=join(directory,'before.json');
  const h=fixture({journal,services:{'demo.store':async()=>{
    await appendFile(effects,'7\n');return 7;
  }}});
  await writeFile(packetFile,JSON.stringify(h.checkpoint()));
  await h.dispatch('call','e');
  const script=`
    import assert from 'node:assert/strict';
    import {readFile,appendFile} from 'node:fs/promises';
    import {SelectedExecutionLifecycleV8 as H} from ${JSON.stringify(new URL('../src/semantic/lifecycle-v8.js',import.meta.url).href)};
    import {SelectedIntentJournal as J} from ${JSON.stringify(new URL('../src/training/intent-journal.js',import.meta.url).href)};
    import {encodeDetailedRecord as encode} from ${JSON.stringify(new URL('../src/semantic/detail-v8.js',import.meta.url).href)};
    const h=H.restore(JSON.parse(await readFile(${JSON.stringify(packetFile)},'utf8')),
      {journal:new J({directory:${JSON.stringify(directory)}}),services:{'demo.store':async()=>{
        await appendFile(${JSON.stringify(effects)},'duplicate\\n');return 7;
      }}});
    let recommits=0;
    await assert.rejects(h.dispatch('call','e',{beforeDispatch:()=>{recommits++;}}),/Durable intent already exists/);
    assert.equal(recommits,0);assert.equal(h.intents.get('call/e').status,'uncertain');
    assert.equal(h.intents.get('call/e').attempts,1);
    const saved=H.restore(JSON.parse(JSON.stringify(h.checkpoint())));
    const actual=Number((await readFile(${JSON.stringify(effects)},'utf8')).trim());
    saved.reconcile('call','e',{disposition:'fulfilled',value:actual,evidenceId:'retained-service-output'});
    saved.selected('call',encode({kind:'return',fields:{value:['num',actual]}}));
    saved.selected('call',encode({kind:'end',fields:{kind:'return'}}));
    assert.deepEqual(H.replay(saved.exportEpisode()).timeline,saved.timeline);
    console.log(JSON.stringify({status:saved.intents.get('call/e').status,recommits,actual}));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{status:'settled',recommits:0,actual:7});
  assert.equal(await readFile(effects,'utf8'),'7\n');
});

test('atomic durable claims admit one adapter when two independent recoveries race',async t=>{
  const {journal}=await journalFixture(t),packet=copy(fixture().checkpoint());
  let readers=0,release,calls=0;
  const bothRead=new Promise(resolve=>{release=resolve;});
  const gated=wrap(journal,{readIntent:async(...args)=>{
    let result,error;try{result=await journal.readIntent(...args);}catch(cause){error=cause;}
    if(readers<2){readers++;if(readers===2)release();await bothRead;}
    if(error)throw error;return result;
  }});
  const services={'demo.store':()=>{calls++;return 7;}},a=Lifecycle.restore(packet,{journal:gated,services}),
    b=Lifecycle.restore(packet,{journal:gated,services});
  const results=await Promise.allSettled([a.dispatch('call','e'),b.dispatch('call','e')]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(results.filter(row=>row.status==='rejected').length,1);
  assert.equal(calls,1);
  const loser=[a,b].find(h=>h.intents.get('call/e').status==='uncertain');
  assert(loser);assert.equal(loser.timeline.filter(row=>row.kind==='dispatch').length,1);
  assert.equal(loser.timeline.filter(row=>row.kind==='result').length,0);
  loser.reconcile('call','e',{disposition:'fulfilled',value:7,evidenceId:'service-result'});
  for(const h of [a,b]){finish(h);assert.deepEqual(Lifecycle.replay(h.exportEpisode()).timeline,h.timeline);}
});

test('lost durable acknowledgement remains uncertain on retry and needs external evidence before another attempt',async t=>{
  const {journal}=await journalFixture(t);let calls=0;
  const h=fixture({journal:wrap(journal,{claim:async record=>{
    await journal.claim(record);throw Error('acknowledgement lost');
  }}),services:{'demo.store':()=>{calls++;return 7;}}});
  await assert.rejects(h.dispatch('call','e'),/acknowledgement lost/);
  assert.equal(calls,0);assert.equal(h.intents.get('call/e').attempts,0);
  assert.equal(h.intents.get('call/e').status,'committed');
  const restored=Lifecycle.restore(copy(h.checkpoint()),{journal,services:h.services});
  await assert.rejects(restored.dispatch('call','e'),/Durable intent already exists/);
  assert.equal(calls,0);assert.equal(restored.intents.get('call/e').status,'uncertain');
  restored.reconcile('call','e',{disposition:'not-dispatched',evidenceId:'adapter-not-invoked'});
  await restored.dispatch('call','e');finish(restored);
  assert.equal(calls,1);
  assert.deepEqual(restored.timeline.filter(row=>row.kind==='dispatch').map(row=>row.attempt),[1,2]);
  assert.deepEqual(Lifecycle.replay(restored.exportEpisode()).timeline,restored.timeline);
});

test('failures before durable publication do not spend a public dispatch attempt',async t=>{
  const {journal}=await journalFixture(t);let failOnce=true,calls=0;
  const h=fixture({journal:wrap(journal,{claim:record=>{
    if(failOnce){failOnce=false;throw Error('disk unavailable');}return journal.claim(record);
  }}),services:{'demo.store':()=>{calls++;return 7;}}});
  await assert.rejects(h.dispatch('call','e',{beforeDispatch:async()=>({})}),/receipt.*binding/);
  assert.equal(h.intents.get('call/e').attempts,0);
  await assert.rejects(h.dispatch('call','e'),/disk unavailable/);
  assert.equal(h.intents.get('call/e').attempts,0);assert.equal(calls,0);
  await h.dispatch('call','e');finish(h);
  assert.equal(calls,1);
  assert.deepEqual(h.timeline.filter(row=>row.kind==='dispatch').map(row=>row.attempt),[1]);
  assert.deepEqual(Lifecycle.replay(h.exportEpisode()).timeline,h.timeline);
});

test('durable recovery binds the complete request before changing history or calling an adapter',async t=>{
  const {journal}=await journalFixture(t);let calls=0;
  const h=fixture({journal,services:{'demo.store':()=>{calls++;return 7;}}}),before=copy(h.checkpoint()),
    intent=h.intents.get('call/e');
  await journal.append({schema:'semantic-action-intent/4',session:h.sessionId,key:'call/e',attempt:1,
    invocationId:'call',effectId:'e',operation:intent.operation,payload:intent.payload,
    payloadDigest:intent.payloadDigest,taskRevision:intent.taskRevision,witness:intent.witness+'forged'});
  await assert.rejects(h.dispatch('call','e'),/contradicts.*selected request/);
  assert.equal(calls,0);assert.deepEqual(copy(h.checkpoint()),before);
});

test('checkpoints wait for an unfinished durable claim, and cancellation cannot dispatch after the wait',async t=>{
  for(const H of [Lifecycle,Region]){
    const {journal}=await journalFixture(t);let release,started,calls=0;
    const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
    const h=fixture({journal:wrap(journal,{claim:async record=>{
      started();await gate;return journal.claim(record);
    }}),services:{'demo.store':()=>{calls++;return 7;}}},H),pending=h.dispatch('call','e');
    const rejected=assert.rejects(pending,/stopped/);
    await entered;
    assert.throws(()=>h.checkpoint(),/acknowledgement/i);
    const host=H===Region?h.inner:h;host.cancelInvocation('call',{reason:'stopped'});
    release();await rejected;
    assert.equal(calls,0);assert.equal(h.intents.get('call/e').attempts,0);
    const restored=H.restore(copy(h.checkpoint()));
    assert.equal(restored.intents.get('call/e').status,'cancelled');
    assert.deepEqual(H.replay(h.exportEpisode()).exportEpisode(),h.exportEpisode());
  }
});

test('append-only storage cannot claim durable recovery capability',()=>{
  assert.throws(()=>fixture({journal:{append:async()=>{}}}),/atomic claim.*readable intents/);
});
