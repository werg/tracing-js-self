import test from 'node:test';
import assert from 'node:assert/strict';
import {learningCase,diverseSubset} from '../tools/freeze-learning-experiment.mjs';
import {buildSourceRegistry,frozenSplitIdentity} from '../src/corpus/source-registry.mjs';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

test('frozen learning requests exclude teacher selections and keep expected outcomes private',async()=>{
  const source='"use strict";function run(x){return x+1;}',family='frozen-learning-source';
  const registry=buildSourceRegistry([{id:'source',family,source,project:'held-out-project'}],
    {holdoutProjects:['held-out-project']});
  const splitIdentity=frozenSplitIdentity(registry,family);
  const checked=await verifyEffectfulTrainingCase({source,entry:'run',args:[7],fixture:{calls:[]},
    family,splitIdentity,seed:17});
  assert.equal(checked.status,'locally_verified');
  // Isolated shape fixture only. The CLI obtains these claims from a fresh
  // source/native-binding recheck in the exact immutable producer checkout.
  const side=checked.exported.sidecar;
  side.admission='admitted';side.nativeAdmission={admitted:true,generatedTokens:10};
  const sourceReceipt={identityValidated:true,identityDigest:side.identityDigest,
    producerRevision:side.producerRevision,sourceValidated:true,journalValidated:true,
    replayValidated:true,effectsValidated:true,episodeDigest:'fixture'};
  const frozen=learningCase(checked.exported,{path:'/fixture.json',fileSha256:'f'.repeat(64),sourceReceipt});
  assert.equal(frozen.split,'test');
  assert.equal(frozen.sourceCluster,splitIdentity.componentId);
  assert(frozen.slices.includes('upstream-project'));
  assert(frozen.slices.includes('pure-selected'));
  assert(frozen.expected.completion);
  assert.equal(frozen.envelope.request.controlledSelectionsByRepresentation,undefined);
  assert.equal(frozen.envelope.expected,undefined);
  assert.equal(frozen.envelope.request.expected,undefined);
  assert.equal(frozen.envelope.caseId,frozen.id);
  assert.throws(()=>learningCase(checked.exported,{sourceReceipt:{...sourceReceipt,identityDigest:'changed'}}),/Fresh source/);
  side.admission='locally_verified';
  assert.throws(()=>learningCase(checked.exported,{sourceReceipt}),/actual native admission/);
});

test('frozen admission selection covers components before repeated variants',()=>{
  const rows=[{id:'a0',sourceCluster:'a'},{id:'a1',sourceCluster:'a'},
    {id:'a2',sourceCluster:'a'},{id:'b0',sourceCluster:'b'},{id:'c0',sourceCluster:'c'}];
  assert.deepEqual(diverseSubset(rows,3).map(row=>row.id),['a0','b0','c0']);
  assert.deepEqual(diverseSubset(rows,4).map(row=>row.id),['a0','b0','c0','a1']);
  assert.deepEqual(diverseSubset([...rows].reverse(),3),diverseSubset(rows,3));
});

test('reserved known-source inputs and fixtures retain train components and separate slice labels',async()=>{
  const {scenarioIdentity,selectAuxiliaryCases}=await import('../tools/freeze-learning-experiment.mjs');
  const request={program:{source:'"use strict";async function run(x){return await host.readAsync(x);}',entry:'run'},
    invocation:{inputGraph:{roots:[['str','key']],objects:[]},receiverValue:['undefined'],
      completionPolicy:'await-returned-promise',realmPolicy:'fresh'},
    fixture:{calls:[{operation:'demo.readAsync',arguments:['key'],result:7},
      {operation:'demo.readAsync',arguments:['other'],result:8}],settlementOrder:[0,1]}};
  const base={id:'optimized',family:'family',sourceCluster:'component:source',split:'train',
    scenario:scenarioIdentity(request),slices:['new-source','effects']};
  const candidate=(id,change)=>{const modified=structuredClone(request);change(modified);
    return {...base,id,scenario:scenarioIdentity(modified),envelope:{request:modified}};};
  const duplicate=candidate('duplicate',()=>{});
  const input=candidate('new-input',r=>{r.invocation.inputGraph.roots=[['str','new-key']];});
  const observation=candidate('new-observation',r=>{r.fixture.calls[0].result=99;});
  const schedule=candidate('new-schedule',r=>{r.fixture.settlementOrder=[1,0];});
  const wrapper=candidate('new-wrapper',r=>{r.program.source='"use strict";function run(x){return x+1;}';});
  const heldout={...input,id:'heldout',split:'test'};
  const result=selectAuxiliaryCases([duplicate,input,observation,schedule,wrapper,heldout],[base],10);
  assert.equal(result.available,3);
  assert.deepEqual(result.selected.map(row=>row.auxiliarySlices),[
    ['new-inputs-known-source'],['different-observations'],['different-schedules']]);
  for(const row of result.selected){
    assert.equal(row.split,'train');assert.equal(row.sourceCluster,base.sourceCluster);
    assert.equal(row.matchedTrainingId,'optimized');assert(!row.slices.includes('new-source'));
  }
  assert.equal(selectAuxiliaryCases([input],[base,input],10).available,0);
});
