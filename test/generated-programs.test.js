import test from 'node:test';
import assert from 'node:assert/strict';
import {generatedProgramCases} from '../src/corpus/generated-programs.mjs';
import {trainingCandidateTasks,candidateSourceInventory} from '../src/corpus/training-candidates.mjs';
import {buildSourceRegistry,frozenSplitIdentity} from '../src/corpus/source-registry.mjs';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

test('bounded grammar uses separate seeds and keeps input/literal expansion in stable families',()=>{
  const rows=generatedProgramCases({families:8,perFamily:4});
  assert.equal(rows.length,32);assert.equal(new Set(rows.map(row=>row.family)).size,8);
  assert.deepEqual(rows,generatedProgramCases({families:8,perFamily:4}));
  const changed=generatedProgramCases({families:8,perFamily:4,inputSeed:90});
  assert.deepEqual(rows.map(row=>row.source),changed.map(row=>row.source));
  assert.notDeepEqual(rows.map(row=>row.args),changed.map(row=>row.args));
  assert.ok(rows.every(row=>row.provenance.astNodes<=160&&row.args[0].length<=7));
  assert.ok(rows.every(row=>row.provenance.expectedOutcome===null));
});
test('cross-stream registry joins a renamed authored source with a generated variant',()=>{
  const authored=trainingCandidateTasks('engineering'),generated=trainingCandidateTasks('generated-v1',{generatedFamilies:4,perFamily:2});
  const duplicate={kind:'source',fixture:{...authored[0].fixture,id:'copied-real-helper',family:'utility:renamed-counter'}};
  const registry=buildSourceRegistry(candidateSourceInventory([...authored,...generated,duplicate]));
  assert.equal(frozenSplitIdentity(registry,'async-counter').componentId,
    frozenSplitIdentity(registry,'utility:renamed-counter').componentId);
  assert.ok(registry.diagnostics.independentComponents<registry.diagnostics.sourceFamilies);
});
test('generated boundary, alias and planned exception programs pass independent v5 gates',async()=>{
  const cases=generatedProgramCases({families:12,perFamily:4}),selected=[];
  for(const predicate of [row=>row.args[0].length===0,row=>row.provenance.choice.alias&&row.args[0].length>1,
    row=>row.provenance.choice.exception&&row.provenance.choice.predicate==='all'&&row.args[0].length>row.args[1]]){
    const row=cases.find(predicate);assert.ok(row);selected.push(row);
  }
  let throws=0;
  for(const row of selected){const result=await verifyEffectfulTrainingCase(row);
    assert.equal(result.status,'locally_verified',row.id+': '+result.reason);
    if(result.exported.sidecar.reference.outcome.kind==='throw')throws++;}
  assert.ok(throws>=1);
});
