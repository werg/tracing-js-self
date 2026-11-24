import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {encodeProtocolRecordV8,decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';

const mixed='"use strict";async function run(){const a=2+3;const p=await Promise.all([Promise.resolve(1),Promise.resolve(2)]);const b=a*2;return p[0]+p[1]+b;}';
const rejected='"use strict";async function run(){let cleaned=0;try{await Promise.all([Promise.resolve(1),Promise.reject(2)]);}catch(error){return [error,cleaned];}finally{cleaned++;}}';
const fixture=source=>({source,entry:'run',args:[],family:'promise-joins-source'});

test('source Promise joins preserve current-event allocations, duplicate dependencies, settlement and cleanup',async()=>{
  for(const source of [mixed,rejected,
    '"use strict";async function run(){return await Promise.all([]);}',
    '"use strict";async function run(){return await Promise.all([1,2,3]);}',
    '"use strict";async function run(){const p=Promise.resolve(3);return await Promise.all([p,p]);}',
    '"use strict";async function run(){return await Promise.race([Promise.resolve(1),Promise.resolve(2)]);}',
    '"use strict";async function run(){const p=Promise.resolve(2).then(x=>x+1);return await Promise.all([p,Promise.resolve(4)]);}'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(source));assert(result.exported,result.reason);
    assert.deepEqual(result.exported.sidecar.protocolExtensions,source===mixed?
      ['primitive-conversion-source/1','promise-adoption/1','promise-executor/1','promise-join/1','promise-object-source/1']:
      [...(source===rejected?['ordinary-completions-source/1']:[]),
        'promise-adoption/1','promise-executor/1','promise-join/1','promise-object-source/1']);
    const replay=RegionExecutionHarness.replay(result.exported),restored=RegionExecutionHarness.restore(replay.checkpoint());
    assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(replay.controller));
    const records=result.exported.public.timeline.filter(row=>row.kind==='protocol').map(row=>decodeProtocolRecordV8(row.fields.line));
    // The mixed source has computed accesses, but both indices stay scalar.
    // Declaring the source component must not invent a guest continuation.
    assert(!records.some(record=>record.kind.startsWith('conversion.')));
    for(const record of records.filter(row=>row.kind==='promise.join'&&row.inputs.length)){
      assert.equal(record.output,null);assert.equal(record.error,null);
    }
    if(source===mixed){assert.equal(result.regionCoverage.compactRegions,2);assert.equal(replay.controller.completion.value[1],13);}
  }
});
test('Promise join projection routes through common admission and independently rechecks exact contexts',async()=>{
  const result=await verifyRegionTrainingCase(fixture(rejected));assert(result.exported,result.reason);
  assert.equal(result.profile,'composed-protocol-source/1');
  const audit=await recheckProtocolRegionEvidence(result.exported);assert.equal(audit.sourceValidated,true);
  const changed=structuredClone(result.exported);changed.contexts.at(-1).state.scheduler.ready++;
  await assert.rejects(recheckProtocolRegionEvidence(changed),/altered|changed|differs/);
});
test('join checkpoint resumes the exact suspended FIFO state and rejects false steps transactionally',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture(mixed));assert(result.exported,result.reason);
  const timeline=result.exported.public.timeline,cut=timeline.findIndex(row=>row.fields.line?.includes('"kind":"promise.join.step"'));
  assert(cut>0);
  const prefix={...result.exported.public,timeline:timeline.slice(0,cut)},
    original=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(original.checkpoint())));
  assert.equal(resumed.controller.stack.length,0);
  const before=sharedRegionState(resumed.controller),record=decodeProtocolRecordV8(timeline[cut].fields.line);
  const join=decodeProtocolRecordV8(timeline.find(row=>row.kind==='protocol').fields.line);
  assert.throws(()=>resumed.select('invocation1',encodeProtocolRecordV8({...record,job:join.jobs[1]})),/FIFO|guard|linkage/);
  assert.deepEqual(sharedRegionState(resumed.controller),before);
  assert.throws(()=>resumed.select('invocation1',encodeDetailedRecord({kind:'job',fields:{action:'dispatch',job:record.job,owner:'invocation1'}},{role:'generated'})),/guard/);
  assert.deepEqual(sharedRegionState(resumed.controller),before);
  assert.throws(()=>resumed.importObserved({mode:'observed',kind:'result',fields:{}}),/canonical detail record/);
  for(const row of timeline.slice(cut))resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  const complete=RegionExecutionHarness.replay(result.exported);
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(complete.controller));
});
test('Promise source extension keeps external effects and unsupported thenable resolving state unqualified',async()=>{
  for(const source of [
    '"use strict";async function run(){const p=new Promise(resolve=>resolve({then(done){done(1);}}));return await Promise.all([p]);}',
    '"use strict";async function run(){await Promise.all([Promise.resolve(1)]);return await host.readAsync("counter");}'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(source));assert.equal(result.exported,undefined);
    assert.match(result.reason,/resolver|unrepresentable|protocol|host|capabilit|Unknown|Undefined|initialized/i);
  }
});

test('allSettled source admits mixed, empty, duplicate and mutable snapshots with independent original execution',async()=>{
  for(const source of [
    '"use strict";async function run(){return await Promise.allSettled([Promise.resolve(2),Promise.reject(7),undefined]);}',
    '"use strict";async function run(){const rows=await Promise.allSettled([]);rows.push(7);return rows;}',
    '"use strict";async function run(){const p=Promise.resolve({x:2});const rows=await Promise.allSettled([p,p]);return [rows[0]===rows[1],rows[0].value===rows[1].value,rows];}',
    '"use strict";async function run(){const rows=await Promise.allSettled([Promise.resolve(2)]);rows[0].status="changed";return rows;}',
    '"use strict";async function run(){const p=new Promise(resolve=>resolve(3));return await Promise.all([Promise.allSettled([p,Promise.reject(4)]),Promise.resolve(5)]);}'
  ]){
    const result=await verifyRegionTrainingCase(fixture(source));assert(result.exported,result.reason);
    const checked=await recheckRegionEvidence(result.exported);assert.equal(checked.sourceValidated,true);
    const complete=RegionExecutionHarness.replay(result.exported),timeline=result.exported.public.timeline;
    const cuts=timeline.flatMap((row,index)=>row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='promise.join.step'?[index]:[]);
    for(const cut of cuts){
      const prefix=RegionExecutionHarness.replay({...result.exported.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
        restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint())));
      for(const row of timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
      assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(complete.controller));
    }
  }
});
