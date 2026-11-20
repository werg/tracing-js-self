import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {ownedProtocolSourceObservations} from '../src/semantic/protocol-source-observations-v8.js';
const fixture=body=>({source:'"use strict";async function run(){'+body+'}',entry:'run',args:[],family:'promise-executor-source'});
const first='const a=2+3;const p=new Promise((resolve,reject)=>{resolve(3);reject(9);});const values=[await p];const b=a*2;return values[0]+b;';

test('source executors independently qualify first resolution, throws, captures, retained capabilities, adoption and joins',async()=>{
  for(const body of [first,
    'const p=new Promise((resolve,reject)=>{throw 9;});try{return await p;}catch(e){return e;}',
    'const p=new Promise(resolve=>{resolve(3);throw 9;});return await p;',
    'let done;const p=new Promise(resolve=>{done=resolve;});done(4);done(7);return await p;',
    'const p=new Promise(resolve=>resolve());return await p;',
    'const p=new Promise(resolve=>resolve(Promise.resolve(5)));return await Promise.all([p,p]);',
    'let done;const a=new Promise(resolve=>{done=resolve;});const b=new Promise(resolve=>resolve(a));done(7);return await b;',
    'let order="";const p=new Promise(resolve=>{order+="a";resolve(4);order+="b";});order+="c";return [await p,order];',
    'const p=new Promise(resolve=>resolve(Number("3")));return await p;'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
    const reference=result.exported.sidecar.sourceArtifact.sidecar.reference;
    assert.equal(reference.extensionAudit.status,'agreed');
    assert(reference.observations.extensions.some(row=>row.profile==='promise-executor-observations/1'));
    const replay=RegionExecutionHarness.replay(result.exported),restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(replay.checkpoint())));
    assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(replay.controller));
    if(body===first){assert.equal(replay.controller.completion.value[1],13);assert(result.regionCoverage.compactRegions>=2);}
  }
});
test('common v8 admission routes executors and rechecks each source/context authority',async()=>{
  const result=await verifyRegionTrainingCase(fixture(first));assert(result.exported,result.reason);
  assert.equal(result.profile,'promise-executors-source/1');
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
  const forged=structuredClone(result.exported);forged.contexts.at(-1).state.scheduler.ready++;
  await assert.rejects(recheckProtocolRegionEvidence(forged),/altered|changed|differs/);
});
test('checkpoint at the resolver call restores shared cells and rejects fabricated capability identity',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture(first));assert(result.exported,result.reason);
  const timeline=result.exported.public.timeline,cut=timeline.findIndex(row=>row.fields.line?.includes('"kind":"promise.resolver.call"'));
  assert(cut>0);
  const prefix={...result.exported.public,timeline:timeline.slice(0,cut)},h=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint()))),before=sharedRegionState(resumed.controller),
    record=decodeProtocolRecordV8(timeline[cut].fields.line);
  assert.throws(()=>resumed.select('invocation1',encodeProtocolRecordV8({...record,resolver:['ref','missing']})),/unallocated/);
  assert.deepEqual(sharedRegionState(resumed.controller),before);
  for(const row of timeline.slice(cut))resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(RegionExecutionHarness.replay(result.exported).controller));
});
test('independent observations retain ignored resolver calls even when the final scalar is unchanged',async()=>{
  const input=fixture('const p=new Promise((resolve,reject)=>{resolve(3);reject(9);});return await p;'),
    result=await verifyProtocolRegionTrainingCase(input);assert(result.exported,result.reason);
  const evidence=result.exported.sidecar.sourceArtifact.sidecar,original=evidence.reference.observations.extensions,
    archive=structuredClone(evidence.archive),call=archive.events.find(event=>event.operation==='call.enter'&&event.operands[0]?.[1]?.includes('executor.reject:'));
  assert(call);call.operands[0][1]=call.operands[0][1].replace('.reject:','.resolve:');
  const changed=ownedProtocolSourceObservations(archive,input.source).extensionObservations;
  assert.notDeepEqual(changed,original);
  assert.deepEqual(evidence.outcome.graph.roots.at(-1),['num',3]);
});
test('unsupported executor profiles remain source refusals, including thenables, async executors and self resolution',async()=>{
  for(const body of [
    'const p=new Promise(async resolve=>{resolve(3);});return await p;',
    'const p=new Promise(resolve=>resolve({then(done){done(3);}}));return await p;',
    'const p=new Promise(resolve=>resolve({x:3}));return await p;',
    'let done;const p=new Promise(resolve=>{done=resolve;});done(p);try{return await p;}catch(e){return 1;}',
    'const P=Promise;return await new P(resolve=>resolve(3));',
    'const p=new Promise(resolve=>{resolve(1);});await p;return await host.readAsync("counter");'
  ]){const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.exported,undefined,body);
    assert.notEqual(result.status,'locally_verified');}
});
