import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeWitness} from '../src/training/format.js';
import {evaluateActualModelExperiment,experimentCaseId,
  validateExperimentManifest,EXPERIMENT_CONDITIONS,EXPERIMENT_SEEDS}
  from '../src/training/experiment.js';

const record=(kind,fields)=>encodeWitness(kind,fields);
const group=(mode,record,index)=>({id:'m'+(index+1),mode,
  loss:mode==='observed'?'none':'semantic',events:[{track:'t0',record}]});
function witnessReference(){
  const groups=[
    group('observed',record('code',{entry:'run',
      source:'function run(){return 1;}',sites:[]}),0),
    group('observed',record('input',{graph:{roots:[],objects:[]}}),1),
    group('generated',record('return',{value:['num',1]}),2),
    group('generated',record('end',{kind:'return'}),3)
  ];
  return {public:{schema:'semantic-execution/3',traceFormat:'semantic-trace/3',
    contextFormat:'semantic-context/3',profile:'training-js/1',groups},
    sidecar:{referenceStatus:'agreed',split:'test',sourceLineage:'test-family',
      reference:{kind:'return',graph:{roots:[['num',1]],objects:[]}}}};
}
const sha=input=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
function fixture(){
  const ref=witnessReference(),caseId=experimentCaseId(ref);
  const manifest={schema:'semantic-learning-experiment/1',
    pinned:{tracerCommit:'a'.repeat(40),consumerCommit:'b'.repeat(40),
      historicalCommit:'c'.repeat(40),tokenizerSha256:'d'.repeat(64),
      initialCheckpointSha256:'e'.repeat(64),
      frozenCohortSha256:sha([caseId])},
    training:{architecture:{name:'pinned-model'},optimizer:{algorithm:'pinned'},
      budgets:{trainingTokens:4096,examples:1},hardware:{accelerator:'pinned'}},
    seeds:[...EXPERIMENT_SEEDS],conditions:[...EXPERIMENT_CONDITIONS],
    splits:{train:{sha256:'1'.repeat(64),families:['train-family']},
      validation:{sha256:'2'.repeat(64),families:['validation-family']},
      test:{sha256:'3'.repeat(64),families:['test-family']}}};
  const measured={generatedTokens:3,observedTokens:5,predictionGroups:2,
    latencyMilliseconds:11,computeFlops:120,peakMemoryBytes:2048};
  const runs=EXPERIMENT_CONDITIONS.flatMap(condition=>EXPERIMENT_SEEDS.map(seed=>({
    condition,seed,cases:[condition==='historical-v2'?
      {caseId,provenance:{source:'pinned-historical-runner',
        historicalCommit:'c'.repeat(40),evaluationReceiptSha256:'f'.repeat(64)},
      externalAdjudication:{correctness:'correct'},measurements:measured}:
      {caseId,provenance:{source:'free-running-model',
        checkpointSha256:'a'.repeat(64)},groups:ref.public.groups,
      measurements:measured}]
  })));
  return {manifest,references:[ref],runs};
}
test('three-seed frozen comparison produces paired family interval only from supplied selections',()=>{
  const task=fixture();
  assert.equal(validateExperimentManifest(task.manifest),true);
  const scored=evaluateActualModelExperiment(task);
  assert.equal(scored.runs.length,EXPERIMENT_CONDITIONS.length*3);
  assert(scored.runs.every(row=>row.correct===1&&row.cases===1));
  assert(scored.pairedFamilyIntervals.every(row=>row.difference===0));
  assert.equal(scored.provenance.includes('actual model'),false);
  assert.equal(scored.measured,true);
});
test('experiment evaluator rejects missing actual model seeds or incomplete common cohort',()=>{
  const task=fixture();
  task.runs.pop();
  assert.throws(()=>evaluateActualModelExperiment(task),/not all required real model runs/);
  const duplicate=fixture();
  duplicate.runs[0].cases[0].caseId='invented';
  assert.throws(()=>evaluateActualModelExperiment(duplicate),/cohort case/);
});
test('experiment manifest refuses missing pinned checkpoint and data family leakage',()=>{
  const missing=fixture();
  missing.manifest.pinned.initialCheckpointSha256='';
  assert.throws(()=>evaluateActualModelExperiment(missing),/pinned|digest/);
  const leaked=fixture();
  leaked.manifest.splits.validation.families=['test-family'];
  assert.throws(()=>evaluateActualModelExperiment(leaked),/family split leakage/);
});
test('historical version-two comparison must be independently adjudicated, never parsed as v3',()=>{
  const task=fixture();
  task.runs[0].cases[0].provenance.source='free-running-model';
  assert.throws(()=>evaluateActualModelExperiment(task),/historical baseline/);
});
test('selected model reports cannot omit real tokens, compute or signed source lineage',()=>{
  const task=fixture();
  task.runs[1].cases[0].measurements.computeFlops=null;
  assert.throws(()=>evaluateActualModelExperiment(task),/measured computeFlops/);
});

test('model selected trace cannot replace trusted observed code or input',()=>{
  const task=fixture();
  const selected=task.runs.find(run=>run.condition==='v3-fine'&&run.seed===17);
  selected.cases[0].groups[0].events[0].record=record('code',{
    entry:'run',source:'function run(){return 99;}',sites:[]});
  assert.throws(()=>evaluateActualModelExperiment(task),
    /changed its frozen observed source\/input context/);
});
