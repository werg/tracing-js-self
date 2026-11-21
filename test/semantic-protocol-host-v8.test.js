import test from 'node:test';
import assert from 'node:assert/strict';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {prepareRegionFamilyRegistry,bindRegionFamilySplit} from '../src/semantic/dataset-v8.js';
import {verifyRegionDatasetBinding} from '../src/semantic/family-registry-v8.js';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const fixtures=HOST_PROTOCOL_FIXTURES_V8,artifacts=new Map();
async function artifact(index){
  if(!artifacts.has(index)){
    const result=await verifyRegionTrainingCase(fixtures[index]);
    assert.ok(result.exported,result.reason);artifacts.set(index,result.exported);
  }
  return artifacts.get(index);
}
function prefix(artifact,cut,options={}){
  return RegionExecutionHarness.replay({...artifact.public,timeline:artifact.public.timeline.slice(0,cut)},
    {requireTerminal:false,...options});
}
function apply(harness,row){
  return row.mode==='observed'?harness.importObserved(row):
    harness.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
}

test('mixed source certification checks original host/callback outcomes and all current public contexts',async()=>{
  for(let index=0;index<fixtures.length;index++){
    const data=await artifact(index),checked=await recheckRegionEvidence(data);
    assert.equal(checked.sourceValidated,true);assert.equal(checked.native.admitted,false);
    let context=0;const live=new RegionExecutionHarness({sessionId:'protocol-host-source',automaticDelivery:false});
    live.inner.replaying=true; // Explicit observed rows own callback retirement during replay.
    for(const row of data.public.timeline){
      if(row.mode==='generated')assert.deepEqual(live.modelContext(row.fields.invocationId),data.contexts[context++]);
      apply(live,row);
    }
    assert.equal(context,data.contexts.length);
    assert.equal(live.controller.completion.value[1],[12,7,0,6][index]);
    const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(live.checkpoint())));
    for(const [id,{controller}]of live.invocations)
      assert.deepEqual(sharedRegionState(restored.invocations.get(id).controller),sharedRegionState(controller));
    for(const {controller,realmId}of restored.invocations.values()){
      assert.equal(controller.heap,restored.realms.get(realmId).heap);
      assert.equal(controller.locals,restored.realms.get(realmId).locals);
    }
  }
});
test('mixed observed imports reject a forged result without changing public state or live services',async()=>{
  const data=await artifact(0),cut=data.public.timeline.findIndex(row=>row.kind==='result');
  const service=()=>7,live=prefix(data,cut,{services:{'demo.readAsync':service}}),before=live.checkpoint();
  const forged=structuredClone(data.public.timeline[cut]);forged.fields.result=['num',99];
  assert.throws(()=>live.importObserved(forged),/disagree|changed|differ/);
  assert.deepEqual(live.checkpoint(),before);
  assert.equal(live.inner.services['demo.readAsync'],service);
  live.importObserved(data.public.timeline[cut]);
  assert.equal(live.inner.services['demo.readAsync'],service);
});
test('mixed restore preserves future host bindings, policy and acknowledged uncertainty without redispatch',async()=>{
  const data=await artifact(0),dispatch=data.public.timeline.findIndex(row=>row.kind==='dispatch');
  let calls=0,release;const service=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const live=prefix(data,dispatch,{services:{'demo.readAsync':service},maxGenerated:300,maxOutstanding:3});
  live.inner.automaticDelivery=false;
  const {invocationId,effectId}=data.public.timeline[dispatch].fields;
  const running=live.dispatch(invocationId,effectId);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  const packet=JSON.parse(JSON.stringify(live.checkpoint())),
    restored=RegionExecutionHarness.restore(packet,{services:{'demo.readAsync':service}});
  assert.equal(restored.inner.maxGenerated,300);assert.equal(restored.inner.maxOutstanding,3);
  assert.equal(restored.inner.automaticDelivery,false);
  assert.equal(restored.inner.intents.get(invocationId+'/'+effectId).status,'uncertain');
  await assert.rejects(restored.dispatch(invocationId,effectId),/uncertain|reconcil|already/);
  assert.equal(calls,1);
  release(7);await running;
  assert.equal(live.inner.services['demo.readAsync'],service);
  assert.equal(live.inner.intents.get(invocationId+'/'+effectId).status,'settled');
});
test('mixed checkpoints reject rehashed join ownership and keep the first future effect executable',async()=>{
  const data=await artifact(0),cut=data.public.timeline.findIndex(row=>row.kind==='semantic'&&row.fields.line.includes('"kind":"request"'));
  let calls=0;const service=()=>{calls++;return 7;};
  const before=prefix(data,cut,{maxGenerated:400,maxOutstanding:2});before.inner.automaticDelivery=false;
  const packet=JSON.parse(JSON.stringify(before.checkpoint())),forged=structuredClone(packet);
  const joined=forged.selected.invocations[0][1].state.heap.find(([,node])=>node.join);
  joined[1].join.owner='forged';const {integrity,...body}=forged;forged.integrity=hashAlgorithmData(body);
  assert.throws(()=>RegionExecutionHarness.restore(forged),/public shared state/);
  const restored=RegionExecutionHarness.restore(packet,{services:{'demo.readAsync':service}});
  apply(restored,data.public.timeline[cut]);
  const request=data.public.timeline.slice(cut).find(row=>row.kind==='dispatch');
  await restored.dispatch(request.fields.invocationId,request.fields.effectId);
  assert.equal(calls,1);assert.equal(restored.inner.maxOutstanding,2);
});
test('mixed callback restore refuses unjournaled arrivals and recovers only existing subscriptions',async()=>{
  const data=await artifact(1),cut=data.public.timeline.findIndex(row=>row.kind==='event'),live=prefix(data,cut);
  const [subscriptionId]=live.handlers.keys(),packet=JSON.parse(JSON.stringify(live.checkpoint()));
  live.postEvent({subscriptionId,eventId:'queued1',args:[9],deliver:false});
  assert.throws(()=>live.checkpoint(),/unjournaled native arrivals/);
  const restored=RegionExecutionHarness.restore(packet);
  assert.equal(restored.handlers.get(subscriptionId).state,'lost');
  let attaches=0;restored.inner.reattachSubscription(subscriptionId,{evidenceId:'test-existing-handle',attach(){attaches++;}});
  assert.equal(attaches,1);assert.equal(restored.handlers.get(subscriptionId).state,'active');
  assert.equal(restored.exportEpisode().timeline.filter(row=>row.kind==='handler').length,1);
});
test('direct mixed source identity survives ordinary family binding and rejects relabelled proof',async()=>{
  const data=await artifact(0),prepared=prepareRegionFamilyRegistry([data],{seed:17}),
    bound=bindRegionFamilySplit(data,prepared.members[0],prepared.registry);
  assert.equal(verifyRegionDatasetBinding(bound).valid,true);
  assert.equal(bound.sidecar.datasetBinding.sourceArtifactDigest,null);
  assert.equal(bound.sidecar.datasetBinding.sourceIdentityDigest,data.sidecar.identityDigest);
  assert.equal((await recheckRegionEvidence(bound)).source.identityValidated,true);
  const forged=structuredClone(bound);forged.sidecar.sourceAdmission.split='test';
  await assert.rejects(recheckRegionEvidence(forged),/identity|split/);
  const changed=structuredClone(bound);changed.sidecar.identityDigest='0'.repeat(64);
  assert.throws(()=>verifyRegionDatasetBinding(changed),/binding/);
});
test('clean producer recheck binds direct host identity and rejects missing or altered identity',async()=>{
  const data=await artifact(0),folder=await mkdtemp(join(tmpdir(),'native-host-recheck-')),
    input=join(folder,'source.json'),root=resolve('.'),revision=execFileSync('git',['rev-parse','HEAD'],
      {cwd:root,encoding:'utf8'}).trim(),tool=resolve('tools/recheck-semantic-native-source.mjs');
  const check=()=>JSON.parse(execFileSync('node',[tool,'--producer-root',root,'--producer-revision',revision,
    '--input',input],{cwd:root,encoding:'utf8'}));
  try{
    await writeFile(input,JSON.stringify(data));
    const receipt=check();
    assert.equal(receipt.sourceValidated,true);
    assert.equal(receipt.sourceArtifactDigest,null);
    assert.equal(receipt.sourceIdentityDigest,data.sidecar.identityDigest);
    assert.equal(receipt.identityValidated,true);
    for(const mutation of ['missing','changed']){
      const forged=structuredClone(data);
      if(mutation==='missing'){
        delete forged.sidecar.identity;delete forged.sidecar.identityDigest;
      }else forged.sidecar.identityDigest='0'.repeat(64);
      await writeFile(input,JSON.stringify(forged));
      assert.throws(check,/Native source recheck|Candidate identity evidence changed/);
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});
