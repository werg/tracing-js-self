import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {decodeOwnedGraph} from '../src/host/graph-codec.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {verifyRegionModuleTrainingCase,verifyModuleSchedulerInputEvidence,recheckModuleRegionEvidence} from '../src/semantic/module-v8.js';
import {verifyProtocolRegionTrainingCase,projectProtocolRegionWitness} from '../src/semantic/protocol-source-v8.js';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {moduleSchedulerSourceFixture} from './fixtures/semantic-module-scheduler-source-v8.js';

let artifact,checked;
const copy=structuredClone;
function input(){const side=artifact.sidecar.sourceArtifact.sidecar;return {source:side.referenceInput.source,entry:side.referenceInput.entry,
  args:decodeOwnedGraph(JSON.stringify(side.referenceInput.inputGraph)),moduleSchedulerPlan:copy(side.moduleSchedulerPlan),
  provenance:copy(side.sourceProvenance.upstream)};}
function rehash(value){const {digest,...body}=value;value.digest=hashAlgorithmData(body);return value;}

test('explicit original module source evidence survives fresh source, projection and replay checks',async()=>{
  const result=await verifyRegionModuleTrainingCase(copy(moduleSchedulerSourceFixture));
  assert(result.exported,result.reason);assert.equal(result.moduleReference,'passed');assert.equal(result.moduleCorrespondence,'passed');
  // Shared Promise state publishes the intrinsic identity/capture and both
  // observable then reads in addition to the scheduler's existing records.
  artifact=result.exported;assert.equal(artifact.contexts.length,724);
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.compiler.moduleSchedulerOwnership.ownedEventCount,10);
  checked=await recheckRegionEvidence(artifact);
  assert(checked.sourceValidated&&checked.projectionValidated&&checked.replayValidated);
  assert.equal(checked.native.admitted,false);assert.equal(artifact.sidecar.optimizerSteps,0);
});

test('default module admission retains its existing refusal',async()=>{
  const request={...copy(moduleSchedulerSourceFixture),experimentalSchedulerPlan:false};
  const result=await verifyRegionModuleTrainingCase(request);
  assert.equal(result.category,'unsupported.module-scheduler-projection');assert(!result.exported);
});

test('a raw scheduler plan cannot replace original module source evidence',async()=>{
  const source=input(),result=await verifyProtocolRegionTrainingCase({source:source.source,entry:source.entry,args:source.args,
    family:'forged-module-input',projectionOptions:{moduleSchedulerPlan:source.moduleSchedulerPlan}});
  assert(!result.exported);assert.match(result.reason,/original module evidence/);
  const missing=await verifyProtocolRegionTrainingCase({source:source.source,entry:source.entry,args:source.args,
    family:'stripped-module-plan',provenance:source.provenance});
  assert(!missing.exported);assert.match(missing.reason,/requires its bound source plan/);
});

test('rehashing a changed dependency/TLA plan cannot acquire source authority',async()=>{
  const source=input();source.moduleSchedulerPlan.modulePlan.modules[0].hasTLA=false;
  rehash(source.moduleSchedulerPlan.modulePlan);rehash(source.moduleSchedulerPlan);
  await assert.rejects(verifyModuleSchedulerInputEvidence(source),/fresh original-module relink/);
});

test('changed original source cannot reuse a previously linked program',async()=>{
  const source=input();source.provenance.moduleEvidence.request.modules['right.js']='await 0;export const x=99;';
  await assert.rejects(verifyModuleSchedulerInputEvidence(source),/fresh original-module relink/);
});

test('a forged original ESM outcome is independently rerun',async()=>{
  const source=input();source.provenance.moduleEvidence.reference.outcome.kind='throw';
  await assert.rejects(verifyModuleSchedulerInputEvidence(source),/fresh original ESM/);
});

test('published module plans cannot be removed or switched independently of private source proof',async()=>{
  for(const mutate of [program=>{delete program.moduleSchedulerPlan;},program=>{program.moduleSchedulerPlan.digest='0'.repeat(64);}]){
    const altered=copy(artifact),program=altered.public.timeline.find(row=>row.kind==='program').fields.regionProgram;
    mutate(program);await assert.rejects(recheckModuleRegionEvidence(altered),/scheduler plan differs/);
  }
  const altered=copy(artifact);delete altered.sidecar.sourceArtifact.sidecar.sourceProvenance.upstream.moduleEvidence.request.experimentalSchedulerPlan;
  await assert.rejects(recheckModuleRegionEvidence(altered),/no explicit source request/);
});

test('logical initialization still requires its freshly rebuilt source certificate',()=>{
  const altered=copy(artifact.sidecar.sourceArtifact),first=altered.sidecar.compiler.claims[0];
  assert.equal(first.record.kind,'module.scheduler.initialize');first.certificate.planDigest='0'.repeat(64);
  assert.throws(()=>projectProtocolRegionWitness(altered),/source target or projection certificate changed/);
});

test('experimental source entry remains a bounded scalar single-call profile',async()=>{
  for(const extra of [{args:[{}]},{calls:[{exportName:'run',args:[]}]},{experimentalNamespacePlan:true}]){
    const result=await verifyRegionModuleTrainingCase({...copy(moduleSchedulerSourceFixture),...extra});
    assert(!result.exported);assert.equal(result.phase,'module-link');
  }
});

after(()=>{
  const summary={schema:'bound-module-source-admission-controls/1',sourceCases:artifact?1:0,
    contexts:artifact?.contexts.length??0,sourceValidated:checked?.sourceValidated===true,
    projectionValidated:checked?.projectionValidated===true,replayValidated:checked?.replayValidated===true,
    nativeAdmission:false,productionPopulationChanged:false,optimizerUpdates:0};
  if(process.env.BOUND_MODULE_ADMISSION_EVIDENCE)writeFileSync(process.env.BOUND_MODULE_ADMISSION_EVIDENCE,JSON.stringify({summary,artifact}));
  console.log('BOUND_MODULE_ADMISSION_CONTROLS_JSON '+JSON.stringify(summary));
});
