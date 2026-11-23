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
const reactionHelper='let pending;await Promise.resolve(1).then(x=>{pending=new Promise(resolve=>{function helper(){return x+2;}resolve(helper());});});return await pending;';

test('source executors independently qualify first resolution, throws, captures, retained capabilities and joins',async()=>{
  for(const body of [first,
    'const p=new Promise((resolve,reject)=>{throw 9;});try{return await p;}catch(e){return e;}',
    'let done,fail;const p=new Promise((resolve,reject)=>{done=resolve;fail=reject;throw 9;});done(4);fail(7);try{return await p;}catch(e){return e;}',
    'const p=new Promise(resolve=>{resolve(3);throw 9;});return await p;',
    'let done;const p=new Promise(resolve=>{done=resolve;});done(4);done(7);return await p;',
    'const p=new Promise(resolve=>resolve());return await p;',
    'const p=new Promise(resolve=>resolve(5));return await Promise.all([p,p]);',
    'const p=new Promise(resolve=>{resolve(3);resolve(Promise.resolve(5));});return await p;',
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
test('executor, async and reaction Promise adoption qualify their explicit FIFO jobs',async()=>{
  for(const body of [
    'const p=new Promise(resolve=>resolve(Promise.resolve(5)));return await p;',
    'let done;const a=new Promise(resolve=>{done=resolve;});const b=new Promise(resolve=>resolve(a));done(7);return await b;',
    'let order="";const p=new Promise(resolve=>resolve(Promise.resolve(1)));p.then(()=>{order+="p";});Promise.resolve().then(()=>{order+="q";}).then(()=>{order+="r";});await p;return order;',
    'return new Promise(resolve=>resolve(3));',
    'let order="";const p=Promise.resolve(1).then(x=>new Promise(resolve=>resolve(x)));p.then(()=>{order+="p";});Promise.resolve().then(()=>{order+="a";}).then(()=>{order+="b";}).then(()=>{order+="c";});await p;return order;'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));
    assert(result.exported,result.reason);
    const kinds=result.exported.public.timeline.filter(row=>row.kind==='protocol')
      .map(row=>decodeProtocolRecordV8(row.fields.line).kind);
    for(const kind of ['promise.adopt.enqueue','promise.adopt.enter','promise.adopt.forward'])assert(kinds.includes(kind));
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  }
});
test('executor helpers retain receiver and captures across synchronous returns, throws and reaction jobs',async()=>{
  for(const body of [
    'let total=1;const p=new Promise(resolve=>{function f(){total+=2;return total;}resolve(f());});total+=4;return [await p,total];',
    'const o={x:3,m(){const read=()=>this.x;return new Promise(resolve=>resolve(read()));}};return await o.m();',
    'const o={m(){let done;const p=new Promise(resolve=>{done=resolve;});done(3);return p;}};return await o.m();',
    'const p=new Promise(resolve=>{function fail(){throw 7;}fail();});try{return await p;}catch(e){return e;}',
    'const p=new Promise(resolve=>{function fail(){throw 7;}try{fail();}catch(e){resolve(e);}});return await p;',
    'const p=new Promise(resolve=>{function fail(){throw 7;}resolve(3);fail();});return await p;',
    reactionHelper,
    'let pending;await Promise.resolve(1).then(x=>{pending=new Promise(resolve=>{throw x+2;});});try{return await pending;}catch(e){return e+1;}',
    'let done;const p=new Promise(resolve=>{done=resolve;});Promise.resolve(2).then(x=>done(x+1));return await p;',
    'const p=new Promise(resolve=>resolve(1));function fail(){throw 7;}fail();return await p;'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
    const replay=RegionExecutionHarness.replay(result.exported),restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(replay.checkpoint())));
    assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(replay.controller));
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  }
  const source='"use strict";function run(){function make(){return new Promise(resolve=>resolve(4));}return make();}',
    result=await verifyProtocolRegionTrainingCase({source,entry:'run',args:[],family:'executor-sync-helper'});
  assert(result.exported,result.reason);
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion.value,['num',4]);
});
test('checkpoint inside a reaction executor helper restores the same job and nested call scopes',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture(reactionHelper));assert(result.exported,result.reason);
  const timeline=result.exported.public.timeline,
    cut=timeline.findIndex(row=>row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='call')+1;
  assert(cut>0);
  const prefix=RegionExecutionHarness.replay({...result.exported.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
    resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint()))),controller=resumed.controller,
    executor=controller.protocol.promiseExecutors.executors[0],before=sharedRegionState(controller);
  assert(controller.activeJob);assert.equal(controller.protocol.callFrames.length,2);
  assert.equal(controller.stack.at(-2),executor.child);
  assert.throws(()=>resumed.select('invocation1',encodeProtocolRecordV8({kind:'promise.executor.finish',promise:executor.promise,
    invocation:executor.child,completion:{kind:'return',value:['undefined']}})),/active call/);
  assert.deepEqual(sharedRegionState(controller),before);
  for(const row of timeline.slice(cut))resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(RegionExecutionHarness.replay(result.exported).controller));
});
test('reaction and ordinary executor receivers remain distinct across a nested checkpoint',async()=>{
  const body='const o={x:5,m(){return Promise.resolve(1).then(()=>{const p=new Promise(function(resolve){resolve(this===undefined?5:9);});return this.x;});}};return await o.m();',
    result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const timeline=result.exported.public.timeline,
    cut=timeline.findIndex(row=>row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='promise.executor.enter')+1;
  assert(cut>0);
  const prefix=RegionExecutionHarness.replay({...result.exported.public,timeline:timeline.slice(0,cut)},{requireTerminal:false}),
    resumed=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(prefix.checkpoint()))),controller=resumed.controller,
    job=controller.jobs.get(controller.activeJob),lexical=controller.heap.get(job.closure).lexicalReceiver;
  assert.equal(lexical[0],'ref');assert.deepEqual(job.priorReceiver,['undefined']);
  assert.deepEqual(controller.receiver,['undefined']);
  assert.deepEqual(controller.protocol.callFrames.at(-1).priorReceiver,lexical);
  for(const row of timeline.slice(cut)){
    resumed.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    if(row.kind==='protocol'&&decodeProtocolRecordV8(row.fields.line).kind==='promise.executor.finish')
      assert.deepEqual(resumed.controller.receiver,lexical);
  }
  assert.deepEqual(resumed.controller.receiver,['undefined']);assert.deepEqual(resumed.controller.completion.value,['num',5]);
  assert.deepEqual(sharedRegionState(resumed.controller),sharedRegionState(RegionExecutionHarness.replay(result.exported).controller));
});
test('a deferred parameter arrow retains its lexical receiver and forward capture when used by an executor',async()=>{
  const body='const o={x:5,m(f=()=>this.x+later,later=3){return new Promise(resolve=>resolve(f()));}};return await o.m();',
    result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const replay=RegionExecutionHarness.replay(result.exported),closures=[...replay.controller.heap.values()].filter(node=>node.kind==='closure'),
    arrow=closures.find(node=>node.captures.some(row=>row.binding==='later'));
  assert(arrow);assert.equal(arrow.functionKind,'arrow');assert.equal(arrow.lexicalReceiver[0],'ref');
  assert.deepEqual(replay.controller.heap.get(arrow.lexicalReceiver[1]).properties.get('x'),['num',5]);
  assert.deepEqual(replay.controller.locals.get(arrow.captures.find(row=>row.binding==='later').cell),['num',3]);
  assert.deepEqual(replay.controller.completion.value,['num',8]);
  assert.deepEqual(sharedRegionState(RegionExecutionHarness.restore(JSON.parse(JSON.stringify(replay.checkpoint()))).controller),sharedRegionState(replay.controller));
});
test('common v8 admission routes executors and rechecks each source/context authority',async()=>{
  const result=await verifyRegionTrainingCase(fixture(first));assert(result.exported,result.reason);
  // Computed array access selects the conversion-capable source composition,
  // while its scalar index needs no guest conversion continuation.
  assert.equal(result.profile,'composed-protocol-source/1');
  assert.deepEqual(result.exported.sidecar.protocolExtensions,['primitive-conversion-source/1','promise-adoption/1','promise-executor/1','promise-object-source/1']);
  assert(!result.exported.public.timeline.filter(row=>row.kind==='protocol')
    .map(row=>decodeProtocolRecordV8(row.fields.line)).some(record=>record.kind.startsWith('conversion.')));
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
