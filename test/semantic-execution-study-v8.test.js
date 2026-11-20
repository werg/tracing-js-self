import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';
import {runSelectedRegionExecution} from '../src/semantic/selected-execution-v8.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {prepareRegionExecutionCase,freezeRegionExecutionStudy,validateRegionExecutionStudy,
  scoreSelectedRegionExecution,runFrozenRegionExecutionStudy} from '../src/semantic/execution-study-v8.js';

const pins={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64)},
  configuration={...pins,origin:'engineering',model:{id:'explicit-record-fixture',revision:'test-only'},
    settings:{selection:'explicit-fixture-injection'},seeds:[17],maxPredictions:32};
const cases=await Promise.all([3,7].map(async(value,index)=>{
  const verified=await verifyRegionTrainingCase({id:'increment-'+index,family:'v8-experiment-'+index,
    source:'"use strict";function run(x){return x+1;}',entry:'run',args:[value],fixture:{calls:[]}});
  assert(verified.exported,verified.reason);
  return prepareRegionExecutionCase({id:verified.id,artifact:verified.exported});
}));

// This selector deliberately injects the certified records to exercise only
// the experiment plumbing. Its origin is always engineering, never a model.
function engineeringSelector(items=cases){
  const calls=[],completed=[],cancelled=[];
  const select=async request=>{
    calls.push(structuredClone(request));
    assert.deepEqual(Object.keys(request).sort(),['attempt','context','contexts','public','session']);
    assert(!JSON.stringify(request).includes('expectedArtifact'));
    assert(!JSON.stringify(request).includes('sourceArtifact'));
    const item=items.find(row=>row.request.initialPublic.timeline[0].fields.session===request.session);
    assert(item,'known explicit engineering fixture');
    const selected=request.public.timeline.filter(row=>row.mode==='generated').length;
    return {record:item.expectedArtifact.public.timeline.filter(row=>row.mode==='generated')[selected].fields.line,
      selection:{origin:'engineering-injected'}};
  };
  select.initialize=async identity=>identity;
  select.commit=async()=>({committed:true});
  select.complete=async request=>{completed.push(request);return {completed:true};};
  select.cancel=async request=>{cancelled.push(request);return {cancelled:true};};
  return {select,calls,completed,cancelled};
}

test('freeze binds complete source/input inventory, model settings, seeds and every execution bound',()=>{
  const study=freezeRegionExecutionStudy(cases,configuration);
  assert.equal(study.declared,2);assert.equal(validateRegionExecutionStudy(study),true);
  assert(Object.isFrozen(study.settings));assert(Object.isFrozen(study.cases[0].request.initialPublic.timeline));
  assert(!Object.hasOwn(study.cases[0],'expectedArtifact'));
  assert(study.cases[0].request.initialPublic.timeline.every(row=>row.mode==='observed'));
  assert(!JSON.stringify(study).includes('sourceArtifact'));
  for(const mutate of [row=>{row.settings.temperature=1;},row=>{row.limits.maxPredictions++;},
    row=>{row.seeds.push(18);},row=>{row.cases.pop();}]){
    const changed=structuredClone(study);mutate(changed);
    assert.throws(()=>validateRegionExecutionStudy(changed),/changed after freeze/);
  }
  const changed=structuredClone(cases);changed[0].expectedArtifact.contexts[0].visibleThrough++;
  assert.throws(()=>freezeRegionExecutionStudy(changed,configuration),/source or environment changed/);
  assert.throws(()=>freezeRegionExecutionStudy([cases[0],cases[0]],configuration),/distinct case/);
});

test('private source scoring follows emissions and distinguishes exact source success from public completion',async()=>{
  const adapter=engineeringSelector(),raw=await runSelectedRegionExecution({...cases[0].request,
    select:adapter.select,...pins,origin:'engineering'});
  assert.equal(raw.publicCompleted,true);assert.equal(raw.sourceValidated,false);
  assert.equal(adapter.completed.length,1);assert.equal(adapter.cancelled.at(-1).reason,'completed');
  const scored=await scoreSelectedRegionExecution(raw,cases[0].expectedArtifact);
  assert.equal(scored.sourceValidated,true);assert.equal(scored.completedExecution,true);
  assert.equal(scored.sourceStatus,'passed-exact-projection');
  assert.equal(scored.qualification.modelMeasurement,'engineering-only');
  assert.equal(scored.nextStep.correct,raw.attempts.length);
  assert.deepEqual(scored.attempts,raw.attempts,'scoring never repairs original selected bytes');
  const changed=structuredClone(raw);changed.attempts[0].record+=' ';
  await assert.rejects(scoreSelectedRegionExecution(changed,cases[0].expectedArtifact),/emission evidence changed/);
  const invalidSource=structuredClone(cases[0].expectedArtifact);
  invalidSource.sidecar.sourceArtifact.sidecar.referenceStatus='not-checked';
  await assert.rejects(scoreSelectedRegionExecution(raw,invalidSource),/evidence|source/);
});

test('private scorer independently rechecks selected protocol-source projections through their own authority',async()=>{
  const protocols=JSON.parse(await readFile(new URL('./fixtures/semantic-protocol-source-v8.json',import.meta.url))),
    fixture=protocols.cases.find(row=>row.id==='source-symbol-getter-arithmetic'),
    verified=await verifyRegionTrainingCase({...fixture,family:'v8-study-protocol-source',fixture:{calls:[]}});
  assert(verified.exported,verified.reason);
  assert.equal(verified.exported.sidecar.schema,'semantic-protocol-region-evidence/1');
  const item=prepareRegionExecutionCase({id:fixture.id,artifact:verified.exported}),adapter=engineeringSelector([item]),
    study=freezeRegionExecutionStudy([item],configuration),
    report=await runFrozenRegionExecutionStudy(study,{cases:[item],select:adapter.select});
  assert.equal(report.summary.completedExecution,1);assert.equal(report.summary.sourceValidated,1);
  assert.equal(report.rows[0].result.sourceEvidence.sourceValidated,true);
  assert.equal(report.rows[0].result.sourceStatus,'passed-exact-projection');
  assert.equal(report.qualification.modelMeasurement,'engineering-only');
});

test('a causal callback completion with a different public schedule remains source-unqualified',async()=>{
  const fixture=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='callback-captured-write'),
    verified=await verifyRegionTrainingCase(fixture),
    item=prepareRegionExecutionCase({id:fixture.id,artifact:verified.exported}),adapter=engineeringSelector([item]);
  delete adapter.select.commit;delete adapter.select.complete;delete adapter.select.cancel;
  const raw=await runSelectedRegionExecution({...item.request,select:adapter.select,...pins,origin:'engineering'});
  assert.equal(raw.publicCompleted,true);assert.deepEqual(raw.completion,{kind:'return',value:['num',7]});
  assert.equal(raw.effects.filter(row=>row.kind==='callback').length,2);
  assert(raw.costs.staleRetries>0);assert.equal(raw.costs.predictionAttempts,raw.attempts.length);
  assert.equal(raw.costs.accepted+raw.costs.rejected,raw.costs.predictionAttempts);
  const scored=await scoreSelectedRegionExecution(raw,item.expectedArtifact);
  assert.equal(scored.sourceStatus,'unqualified-projection');assert.equal(scored.sourceValidated,false);
  assert.equal(scored.completedExecution,false);assert.equal(scored.sourceEvidence.sourceValidated,true);
  assert.deepEqual(scored.attempts,raw.attempts);assert.deepEqual(scored.costs,raw.costs);
});

test('equal final values and alternative public decompositions remain source-unqualified',async()=>{
  for(const value of [4,999]){
    const records=[encodeDetailedRecord({kind:'return',fields:{value:['num',value]}},{role:'generated'}),
      encodeDetailedRecord({kind:'end',fields:{kind:'return'}},{role:'generated'})];
    const select=async()=>({record:records.shift(),selection:{origin:'engineering-injected'}});
    select.initialize=async identity=>identity;
    const raw=await runSelectedRegionExecution({...cases[0].request,select,...pins,origin:'engineering'}),
      result=await scoreSelectedRegionExecution(raw,cases[0].expectedArtifact);
    assert.equal(result.publicCompleted,true);assert.equal(result.publicAccepted,true);
    assert.equal(result.sourceValidated,false);assert.equal(result.completedExecution,false);
    assert.equal(result.sourceStatus,'unqualified-projection');
    assert.equal(result.nextStep.rows[0].status,'different-canonical-record');
    assert.equal(result.nextStep.rows[1].status,'unqualified-boundary');
    assert.deepEqual(result.completion,{kind:'return',value:['num',value]});
  }
});

test('frozen evaluation keeps untested seeds and cases in the denominator and retains failures and costs',async()=>{
  const study=freezeRegionExecutionStudy(cases,{...configuration,seeds:[17,23]}),adapter=engineeringSelector(),snapshots=[];
  const report=await runFrozenRegionExecutionStudy(study,{cases,select:adapter.select,caseIds:[cases[0].id],
    onResult:row=>{snapshots.push(row);}});
  assert.equal(report.declared,4);assert.equal(report.summary.attempted,2);assert.equal(report.summary.untested,2);
  assert.equal(report.summary.completedExecution,2);assert.equal(report.summary.sourceValidated,2);
  assert.equal(report.summary.completedExecutionRate,0.5);assert.equal(report.summary.rateDenominator,4);
  assert.equal(report.summary.predictionAttempts,adapter.calls.length);
  assert.equal(report.summary.unknownGenerationCostAttempts,adapter.calls.length);
  assert.equal(report.qualification.modelMeasurement,'engineering-only');
  assert.equal(snapshots[0].summary.untested,4);assert.equal(snapshots.length,3);
  assert.equal(adapter.cancelled.length,2,'each seed releases its native session before the next initialize');
  const malformed='detail original invalid model bytes',select=async()=>({record:malformed});
  select.initialize=async identity=>identity;
  const failed=await runFrozenRegionExecutionStudy(study,{cases,select,caseIds:[cases[0].id]});
  assert.equal(failed.summary.attempted,2);assert.equal(failed.summary.untested,2);
  assert.equal(failed.summary.completedExecution,0);assert.equal(failed.summary.predictionAttempts,2);
  assert.equal(failed.rows[0].result.attempts[0].record,malformed);
  assert.equal(failed.rows[0].status,'failed');assert(failed.rows[0].result.failure);
  const altered=structuredClone(cases);altered[0].request.fixture.calls.push({operation:'demo.counter.get'});
  await assert.rejects(runFrozenRegionExecutionStudy(study,{cases:altered,select}),/differs from the frozen study/);
});

test('unmeasured model study cannot claim actual selection, and cleanup failures remain unsuccessful',async()=>{
  const frozen=freezeRegionExecutionStudy(cases,{...configuration,origin:'model'});
  const untouched=await runFrozenRegionExecutionStudy(frozen,{cases,select:()=>{},caseIds:[]});
  assert.equal(untouched.summary.untested,2);assert.equal(untouched.qualification.modelMeasurement,'unmeasured');
  const adapter=engineeringSelector();adapter.select.cancel=async()=>{throw new Error('native session cleanup failed');};
  const raw=await runSelectedRegionExecution({...cases[0].request,select:adapter.select,...pins,origin:'engineering'});
  assert.equal(raw.publicCompleted,false);assert.equal(raw.sourceValidated,false);
  assert.equal(raw.status,'failed');assert.match(raw.cleanupFailure.message,/cleanup failed/);
});

test('experiment CLI freezes separate private artifacts and persists denominator and startup failures',async()=>{
  const directory=await mkdtemp(resolve('../semantic-v8-cli-test-')),
    invoke=promisify(execFile),cli=resolve('tools/run-semantic-v8-experiment.mjs');
  try{
    const input=join(directory,'input.json'),settings=join(directory,'settings.json'),
      frozen=join(directory,'frozen'),output=join(directory,'measured'),modulePath=join(directory,'selector.mjs');
    await writeFile(input,JSON.stringify(cases.map(row=>({id:row.id,artifact:row.expectedArtifact}))));
    await writeFile(settings,JSON.stringify(configuration.settings));
    await invoke(process.execPath,[cli,'freeze','--input',input,'--out',frozen,
      '--model-id',configuration.model.id,'--model-revision',configuration.model.revision,
      '--settings',settings,'--checkpoint',pins.checkpointIdentity,'--tokenizer',pins.tokenizerIdentity,
      '--origin','engineering','--seed','17','--seed','23'],{timeout:30000});
    const study=JSON.parse(await readFile(join(frozen,'study.json'),'utf8'));
    assert.equal(study.declared,4);assert(!JSON.stringify(study).includes('sourceArtifact'));
    await writeFile(modulePath,`const records=${JSON.stringify(cases[0].expectedArtifact.public.timeline
      .filter(row=>row.mode==='generated').map(row=>row.fields.line))};
export function createSelector(config){
  if('cases' in config || 'expectedArtifact' in config || 'request' in config)throw new Error('private input leaked');
  let index=0;const select=async()=>({record:records[index++],selection:{origin:'engineering-injected'}});
  select.initialize=async identity=>{index=0;return identity};return select;
}\n`);
    await invoke(process.execPath,[cli,'run','--study',join(frozen,'study.json'),
      '--cases',join(frozen,'private-cases.json'),'--out',output,'--selector-module',modulePath,
      '--case',cases[0].id],{timeout:30000});
    const report=JSON.parse(await readFile(join(output,'report.json'),'utf8'));
    assert.equal(report.summary.completedExecution,2,JSON.stringify(report.rows.map(row=>({
      status:row.status,failure:row.failure,runFailure:row.result?.failure,sourceStatus:row.result?.sourceStatus}))));
    assert.equal(report.summary.untested,2);
    assert.equal(report.summary.completedExecutionRate,0.5);
    assert.equal(report.qualification.modelMeasurement,'engineering-only');
    const broken=join(directory,'broken.mjs'),failed=join(directory,'failed');
    await writeFile(broken,'export function createSelector(){throw new Error("fixture startup unavailable")}\n');
    await assert.rejects(invoke(process.execPath,[cli,'run','--study',join(frozen,'study.json'),
      '--cases',join(frozen,'private-cases.json'),'--out',failed,'--selector-module',broken],{timeout:30000}));
    const failure=JSON.parse(await readFile(join(failed,'report.json'),'utf8'));
    assert.equal(failure.declared,4);assert.equal(failure.summary.untested,4);
    assert.match(failure.executionFailure.message,/startup unavailable/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
