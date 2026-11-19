import test from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGE_EXPANSION_COMPREHENSION_TASKSET as taskset} from '../fixtures/language-expansion/comprehension.js';
import {validateComprehensionTaskset,publicComprehensionTasks,scoreComprehensionResponses} from '../src/semantic/comprehension.js';
import {freezeComprehensionStudy,scoreFrozenComprehensionStudy,scoreSelectedAlgorithmExecution} from '../src/semantic/comprehension-study.js';
const options={model:{id:'test-only',revision:'frozen-fixture'},settings:{temperature:0,maxOutputTokens:256},
  prompt:'Choose the correct supplied outcome.',seed:17};

test('expansion declares more than 200 source-free tasks without fabricated model results',()=>{
  assert.equal(validateComprehensionTaskset(taskset),true);
  assert.ok(taskset.tasks.length>=200&&taskset.tasks.length<=256);
  assert.ok(new Set(taskset.tasks.map(row=>row.family)).size>=20);
  const survey=publicComprehensionTasks(taskset);
  for(const task of survey.tasks){assert.equal(task.answer,undefined);assert.equal(task.rationale,undefined);assert.equal(task.source,undefined);}
  assert.equal(scoreComprehensionResponses(taskset,[]).status,'unmeasured');
});

test('study freezes pins and counterbalances renderings without showing a task twice',()=>{
  const first=freezeComprehensionStudy(taskset,{...options,cohort:0}),second=freezeComprehensionStudy(taskset,{...options,cohort:1});
  assert.ok(Object.isFrozen(first));assert.equal(first.assignments.length,new Set(first.assignments.map(row=>row.taskId)).size);
  for(let i=0;i<first.assignments.length;i++){
    assert.equal(first.assignments[i].taskId,second.assignments[i].taskId);
    assert.notEqual(first.assignments[i].scheduledArm,second.assignments[i].scheduledArm);
    if(first.assignments[i].arm==='description-only')assert.equal(first.assignments[i].notationStatus,'requires-certified-trace-stimulus');
  }
  assert.throws(()=>freezeComprehensionStudy(taskset,{...options,phase:'confirmatory'}),/margin/);
  const responses={schema:'semantic-comprehension-responses/1',studyDigest:first.digest,model:first.model,settings:first.settings,responses:[]};
  const score=scoreFrozenComprehensionStudy(taskset,first,responses);
  assert.equal(score.status,'unmeasured');assert.equal(score.qualification.standardPromotion,false);
  assert.throws(()=>scoreFrozenComprehensionStudy(taskset,first,{...responses,model:{id:'another',revision:'weights'}}),/frozen/);
});

test('next-step and full execution scoring checks external candidates without correction',()=>{
  const request={source:'"use strict";function run(x){return x+1;}',args:[4]};
  assert.equal(scoreSelectedAlgorithmExecution({...request,lines:['v0 = add($a0, 1) => 5','return 5']}).completed,true);
  const wrong=scoreSelectedAlgorithmExecution({...request,lines:['v0 = add($a0, 1) => 6','return 5']});
  assert.equal(wrong.completed,false);assert.equal(wrong.status,'failed');
  assert.equal(scoreSelectedAlgorithmExecution({...request,lines:['v0 = add($a0, 1) => 5']}).status,'incomplete');
});
