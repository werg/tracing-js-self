import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {verifyRegionTrainingCase,recheckRegionEvidence,projectRegionWitness} from '../src/semantic/compiler-v8.js';
import {verifySourceTrainingCaseV8,recheckSourceAdmissionV8,SOURCE_ADMISSION_CONTRACT_V8}
  from '../src/semantic/source-admission-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {SelectedExecutionLifecycleV8} from '../src/semantic/lifecycle-v8.js';
import {decodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {identityDigest} from '../src/semantic/source-identity.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';

const fixture={source:'"use strict";function run(x){let n=x+1;let reads=0;const object={};'+
  'Object.defineProperty(object,"value",{get(){reads++;return 20;}});'+
  'return n*2+object.value+reads;}',entry:'run',args:[3],family:'direct-source-v8-getter',fixture:{calls:[]}};
let certified,effectful;
test.before(async()=>{
  certified=await verifyRegionTrainingCase(fixture);
  assert(certified.exported,certified.reason);
  effectful=await verifyRegionTrainingCase(structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0')));
  assert(effectful.exported,effectful.reason);
});

test('V8 source certification emits direct detail and binds the V8 contract before compaction',async()=>{
  const source=certified.exported.sidecar.sourceArtifact;
  assert.equal(source.public.schema,'semantic-lifecycle/8');
  assert.equal(source.public.traceFormat,'semantic-trace/8');
  assert.equal(source.public.contextFormat,'semantic-context/8');
  assert.equal(source.sidecar.compiler.schema,'semantic-source-compiler/8');
  assert.equal(source.sidecar.identity.schema,'semantic-source-candidate-identity/8');
  assert.equal(source.sidecar.identity.execution.execution,'semantic-lifecycle/8');
  assert.equal(source.sidecar.identity.certification.schemaDigest,SOURCE_ADMISSION_CONTRACT_V8.digest);
  assert(source.public.timeline.some(row=>row.kind==='semantic'));
  for(const row of source.public.timeline.filter(row=>row.line))
    decodeDetailedRecord(row.line,{role:row.mode==='generated'?'generated':'observed'});
  assert.equal(SelectedExecutionLifecycleV8.replay(source).invocations.get('invocation1').controller.completion.value[1],29);
  const checked=await recheckRegionEvidence(JSON.parse(JSON.stringify(certified.exported)));
  assert.equal(checked.sourceValidated,true);
  assert.equal(checked.projectionValidated,true);
  assert.equal(checked.native.status,'untested');
});

test('direct source effects retain observed authority and restored continuation without dispatch',async()=>{
  const source=effectful.exported.sidecar.sourceArtifact;
  assert(source.public.timeline.some(row=>row.kind==='dispatch'));
  assert(source.public.timeline.filter(row=>row.kind==='result').every(row=>row.mode==='observed'&&row.line.startsWith('detail ')));
  assert.equal(source.sidecar.replay.nativeReplayDispatches,0);
  const rows=effectful.exported.public.timeline,cut=rows.findIndex(row=>row.kind==='result');
  assert(cut>0);
  const prefix={...effectful.exported.public,timeline:rows.slice(0,cut)};
  const original=RegionExecutionHarness.replay(prefix,{requireTerminal:false});
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(original.checkpoint())));
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(original.controller));
  const pending=[...restored.intents.values()].find(intent=>intent.status==='uncertain');
  assert(pending,'a dispatched operation has an uncertain physical outcome after restore');
  await assert.rejects(restored.dispatch(pending.invocationId,pending.effectId),/uncertain|reconcil/i);
  for(const row of rows.slice(cut)){
    if(row.mode==='observed')restored.importObserved(row);
    else restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  }
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(RegionExecutionHarness.replay(effectful.exported).controller));
  assert.equal((await recheckSourceAdmissionV8(source,{requireAdmitted:false})).effectsValidated,true);
});

test('legacy source schemas and coherently rehashed old contract identities cannot certify V8',async()=>{
  const source=certified.exported.sidecar.sourceArtifact;
  for(const change of [artifact=>{artifact.public.schema='semantic-execution/6';},
    artifact=>{artifact.public.traceFormat='semantic-trace/6';},
    artifact=>{artifact.sidecar.compiler.schema='semantic-effectful-compiler/5';}]){
    const forged=structuredClone(source);change(forged);
    assert.throws(()=>projectRegionWitness(forged),/direct V8 source detail/);
  }
  const forged=structuredClone(source);
  forged.sidecar.identity.execution.trace='semantic-trace/6';
  forged.sidecar.identityDigest=identityDigest(forged.sidecar.identity);
  await assert.rejects(recheckSourceAdmissionV8(forged,{requireAdmitted:false}),/immutable payload/);
  const changed=structuredClone(effectful.exported);
  changed.sidecar.sourceArtifact.sidecar.referenceInput.fixture.calls[0].result=900;
  changed.sidecar.sourceArtifactDigest=hashAlgorithmData(changed.sidecar.sourceArtifact);
  await assert.rejects(recheckRegionEvidence(changed),/inputs differ|evidence changed/);
});

test('source eligibility cannot bypass the final V8 native-admission authority',async()=>{
  let called=false;
  await assert.rejects(verifySourceTrainingCaseV8({...fixture,nativeConsumer:async()=>{called=true;return {admitted:true};}}),
    /Native admission belongs to the final representation gate/);
  assert.equal(called,false);
  await assert.rejects(recheckSourceAdmissionV8(certified.exported.sidecar.sourceArtifact),/Missing complete/);
});

test('complete V8 source certification, protocol projection and recheck run with the legacy stack unavailable',()=>{
  // Inspect the resolved URL, not just the importing spelling: ./format.js is
  // every bit as forbidden as ../training/format.js.
  const loader='export async function resolve(s,c,next){const r=await next(s,c);'+
    'if(/\\/(?:training\\/(?:format|trace-text|harness-v4|controller|render|effectful-compiler|effectful-admit|effectful-session|admission-identity)|semantic\\/detailed-v7)\\.js$/.test(new URL(r.url).pathname))'+
    'throw new Error("legacy dependency: "+r.url);return r;}';
  const compiler=new URL('../src/semantic/compiler-v8.js',import.meta.url).href;
  const projection=new URL('../src/semantic/effectful-teacher-v8.js',import.meta.url).href;
  const runtime=new URL('../src/runtime.js',import.meta.url).href;
  const script=`
    import assert from 'node:assert/strict';
    import {verifyRegionTrainingCase,recheckRegionEvidence} from ${JSON.stringify(compiler)};
    import {compileEffectfulRegionWitnessV8} from ${JSON.stringify(projection)};
    import {createRuntime} from ${JSON.stringify(runtime)};
    const fixtures=[${JSON.stringify(fixture)},${JSON.stringify(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0'))},
      {source:'"use strict";function run(){const x={valueOf(){return 3;}};return Number(x);}',entry:'run',family:'direct-protocol-absence',fixture:{calls:[]}}];
    for(const item of fixtures){const result=await verifyRegionTrainingCase(item);assert(result.exported,result.reason);
      assert.equal((await recheckRegionEvidence(result.exported)).sourceValidated,true);}
    const vm=createRuntime().startEntry({text:'"use strict";async function run(){const x=await Promise.resolve(7);return x+1;}',functionName:'run',allowAsync:true});
    vm.drive();const output=compileEffectfulRegionWitnessV8(vm.exportRun());
    assert.equal(output.exported.public.schema,'semantic-execution/8');
    assert(output.exported.public.timeline.filter(row=>row.mode==='generated').every(row=>row.fields.line.startsWith('detail ')));
  `;
  const result=spawnSync(process.execPath,['--no-warnings','--experimental-loader',
    'data:text/javascript,'+encodeURIComponent(loader),'--input-type=module','--eval',script],
    {encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message);
});
