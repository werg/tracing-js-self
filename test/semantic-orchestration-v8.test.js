import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {prepareV8OrchestrationCase,NativeV8ChildBridge} from '../src/semantic/orchestration-v8.js';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';

// These local process controls are explicitly transport-only. The separate
// qualification command runs the independent native recurrent runtime.
const source={id:'native-child-map',family:'native-child-map',
  source:'"use strict";function run(xs){return xs.map(x=>x*2);}',entry:'run',args:[[1,2,3]],fixture:{calls:[]}},
  verified=await verifyRegionTrainingCase(source),artifact=verified.exported;
assert(artifact,verified.reason);
const prepared=await prepareV8OrchestrationCase({id:source.id,artifact}),
  policy={origin:'engineering',checkpointIdentity:'a'.repeat(64),tokenizerIdentity:'b'.repeat(64),
    trainingIdentity:null,seed:17,generationSettings:{device:'cpu',maxTokens:512,maxFragments:16,effort:1},
    maxCoordinatorSelections:12,maxChildSelections:32,childBudget:64,maxActive:1};
const createRecord=bridge=>JSON.stringify({name:'track_create',arguments:{purpose:'Execute the original source',
  completion:'Return the exact child result',budget:64,capabilities:['text',...bridge.state.children[0].execution.capability_grants],
  execution:bridge.state.children[0].execution}});
const choose=async(bridge,name,args)=>{const selected=await bridge.selectCoordinator({controlledRecord:JSON.stringify({name,arguments:args})});
  return {selected,receipt:await bridge.commitCoordinator(selected)};};
async function rig(options={}){
  const directory=await mkdtemp(join(tmpdir(),'v8-child-bridge-')),path=join(directory,'original-artifact.json'),
    log=join(directory,'requests.jsonl'),selectors=[];
  await writeFile(path,JSON.stringify(artifact));
  const select=()=>{const value=createNativeV8ProcessSelector({command:process.execPath,
    args:[fileURLToPath(new URL('./fixtures/native-orchestration-v8-worker.mjs',import.meta.url)),path],
    env:{...process.env,V8_STUB_LOG:log,...(options.tamper?{V8_STUB_TAMPER:options.tamper}:{})},
    allowControlledOrchestration:options.allowControlled??true,timeoutMs:5000});selectors.push(value);return value;};
  return {directory,path,log,select,async close(){for(const value of selectors)value.close();await rm(directory,{recursive:true,force:true});}};
}
async function reserve(bridge){
  const selected=await bridge.selectCoordinator({controlledRecord:createRecord(bridge)}),receipt=await bridge.commitCoordinator(selected);
  return {selected,receipt};
}
async function finish(bridge,reservation){
  await bridge.bootstrap(reservation.receipt.track.address);
  await choose(bridge,'track_join',{address:bridge.state.track,completion_dependency:reservation.receipt.completion_dependency});
  while(bridge.harness.activation(bridge.invocationId).status!=='completed')await bridge.commitChild(await bridge.selectChild());
  const completed=await bridge.completeChild();
  await choose(bridge,'track_progress',{address:bridge.state.track,progress:JSON.stringify(completed.childCompletion.completion)});
  await choose(bridge,'track_complete',{address:bridge.state.track});
  return {completed,result:await bridge.result()};
}

test('source preparation independently checks original input and retains no future records in public authority',async()=>{
  const again=await prepareV8OrchestrationCase({id:source.id,artifact});assert.deepEqual(again,prepared);
  assert(prepared.initialPublic.timeline.every(row=>row.mode==='observed'));
  assert.equal(prepared.initialPublic.timeline.filter(row=>row.kind==='invocation').length,1);
  assert.equal(prepared.nativeAdmissionClaim,false);assert.equal(prepared.sourceAdmissionClaim,false);
  const changed=structuredClone(artifact);changed.public.timeline[1].fields.inputGraph.roots.arguments=[['num',999]];
  await assert.rejects(prepareV8OrchestrationCase({id:source.id,artifact:changed}),/differs|changed|input|projection/i);
  assert.throws(()=>new NativeV8ChildBridge({prepared:structuredClone(prepared),select:()=>{},policy}),/independent source recheck/);
});

test('source profile refuses host observations without dropping their checked original artifact',async()=>{
  const host=await verifyRegionTrainingCase(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0'));
  assert(host.exported,host.reason);
  await assert.rejects(prepareV8OrchestrationCase({id:'host',artifact:host.exported}),/host observations/);
});

test('transport-only bridge reserves, explicitly bootstraps, waits, commits exact guest records and collects complete lifecycle',async()=>{
  const env=await rig();try{
    const bridge=await NativeV8ChildBridge.open({prepared,policy,select:env.select()}),
      selected=await bridge.selectCoordinator({controlledRecord:createRecord(bridge)});
    assert.equal(bridge.state.children[0].track,null);
    await assert.rejects(bridge.bootstrap('track:1'),/pending/);
    const receipt=await bridge.commitCoordinator(selected);assert.equal(receipt.track.bootstrap_ready,false);
    await assert.rejects(bridge.selectChild(),/runnable/);
    assert.deepEqual(await bridge.commitCoordinator(selected),receipt,'lost coordinator reply is an immutable retry');
    const {completed,result}=await finish(bridge,{selected,receipt});
    assert.equal(result.nativeCoordinatorCompleted,true);assert.equal(result.publicCompleted,true);
    assert.equal(result.sourceCorrespondence,'exact-source-certified-projection');
    assert.equal(result.modelMeasurement,'engineering-only');assert.equal(result.productionExecutionClaim,false);
    assert.equal(result.nativeAdmissionClaim,false);assert.equal(result.tokenPacking,'unmeasured');
    assert.equal(result.hostDispatches,0);assert.equal(result.checkpoint.native.native.engineeringTransportStub,true);
    assert.equal(result.nativeMetrics.coordinatorAccepted,4);assert.equal(result.nativeMetrics.semanticallyAccepted,2);
    assert.deepEqual(await bridge.completeChild(),completed);
    const requests=(await readFile(env.log,'utf8')).trim().split('\n').map(JSON.parse);
    for(const request of requests.filter(row=>['open-orchestration','select-orchestration','select'].includes(row.op))){
      assert(!JSON.stringify(request).includes('sourceArtifact'));assert(!JSON.stringify(request).includes('referenceStatus'));
    }
    assert(!('contexts' in requests.find(row=>row.op==='open-orchestration')));
  }finally{await env.close();}
});

test('reserved and waiting source-bound transport checkpoints restore before continuing the child',async()=>{
  const env=await rig();try{
    let bridge=await NativeV8ChildBridge.open({prepared,policy,select:env.select()}),reservation=await reserve(bridge);
    const reserved=await bridge.checkpoint();bridge.select.close();
    bridge=await NativeV8ChildBridge.restore({prepared,policy,select:env.select(),checkpoint:reserved});
    assert.equal(bridge.state.children[0].track,reservation.receipt.track.address);
    assert.equal(bridge.state.tracks.find(row=>row.address===reservation.receipt.track.address).bootstrap_ready,false);
    await bridge.bootstrap();await choose(bridge,'track_join',{address:bridge.state.track,
      completion_dependency:reservation.receipt.completion_dependency});
    const waiting=await bridge.checkpoint();bridge.select.close();
    bridge=await NativeV8ChildBridge.restore({prepared,policy,select:env.select(),checkpoint:waiting});
    assert.equal(bridge.state.status,'waiting');assert.equal(bridge.coordinatorSelections,2);
    while(bridge.harness.activation(bridge.invocationId).status!=='completed')await bridge.commitChild(await bridge.selectChild());
    const complete=await bridge.completeChild();await choose(bridge,'track_progress',{address:bridge.state.track,
      progress:JSON.stringify(complete.childCompletion.completion)});
    await choose(bridge,'track_complete',{address:bridge.state.track});
    const result=await bridge.result();assert.equal(result.sourceCorrespondence,'exact-source-certified-projection');
    assert.equal(result.nativeMetrics.predictionAttempts,6);
  }finally{await env.close();}
});

test('rehashed checkpoint edits cannot substitute another original input or causal context',async()=>{
  const env=await rig();try{
    const bridge=await NativeV8ChildBridge.open({prepared,policy,select:env.select()});await reserve(bridge);
    const packet=await bridge.checkpoint();
    for(const change of [value=>{value.public.timeline[1].fields.triggerId='changed';},
      value=>{value.contexts.push({});},value=>{value.policy.childBudget++;},value=>{value.caseDigest='0'.repeat(64);},
      value=>{value.native.identity.checkpointIdentity='f'.repeat(64);},
      value=>{value.native.native.sessions[bridge.session].orchestration.childBudget++;}]){
      const modified=structuredClone(packet);change(modified);delete modified.digest;modified.digest=hashAlgorithmData(modified);
      await assert.rejects(NativeV8ChildBridge.restore({prepared,policy,select:env.select(),checkpoint:modified}),
        /source|policy|history|contexts/);
    }
  }finally{await env.close();}
});

test('transport refuses changed native child identity and coordinator context before acknowledging work',async()=>{
  for(const tamper of ['binding','context']){const env=await rig({tamper});try{
    if(tamper==='binding')await assert.rejects(NativeV8ChildBridge.open({prepared,policy,select:env.select()}),/source|input|grants/);
    else{const bridge=await NativeV8ChildBridge.open({prepared,policy,select:env.select()});
      await assert.rejects(bridge.selectCoordinator({controlledRecord:createRecord(bridge)}),/context/);
      assert.equal(bridge.select.metrics().coordinatorAccepted,0);}
  }finally{await env.close();}}
});

test('controlled coordinator input requires engineering opt-in and never enters actual-model requests',async()=>{
  const env=await rig({allowControlled:false});try{
    await assert.rejects(NativeV8ChildBridge.open({prepared,policy,select:env.select()}),/engineering authority/);
    const model={...policy,origin:'model'},bridge=await NativeV8ChildBridge.open({prepared,policy:model,select:env.select()});
    await assert.rejects(bridge.selectCoordinator({controlledRecord:'{}'}),/cannot receive controlled/);
    assert.equal(bridge.select.metrics().predictionAttempts,0);
  }finally{await env.close();}
});

test('cancellation wins over an unacknowledged coordinator candidate without a child reservation',async()=>{
  const env=await rig();try{
    const bridge=await NativeV8ChildBridge.open({prepared,policy,select:env.select()}),
      pending=await bridge.selectCoordinator({controlledRecord:createRecord(bridge)});
    const cancelled=await bridge.cancel('cancel before create acknowledgement');
    assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.children[0].track,null);
    await assert.rejects(bridge.commitCoordinator(pending),/original coordinator|unknown|pending/);
    assert.equal(bridge.select.metrics().coordinatorAccepted,0);
  }finally{await env.close();}
});

test('lost native coordinator acknowledgement remains unknown and blocks bridge checkpoints',async()=>{
  const env=await rig({tamper:'lost-ack'});try{
    const bridge=await NativeV8ChildBridge.open({prepared,policy,select:env.select()}),
      pending=await bridge.selectCoordinator({controlledRecord:createRecord(bridge)});
    await assert.rejects(bridge.commitCoordinator(pending),error=>error.acknowledgementUnknown===true);
    assert.equal(bridge.select.metrics().unknownAcknowledgements,1);
    await assert.rejects(bridge.checkpoint(),/uncertain/);
    assert.equal(bridge.harness.exportEpisode().timeline.filter(row=>row.mode==='generated').length,0);
  }finally{await env.close();}
});
