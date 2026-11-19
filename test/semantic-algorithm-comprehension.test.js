import test from 'node:test';
import assert from 'node:assert/strict';
import {SEMANTIC_COMPREHENSION_TASKSET as taskset} from '../fixtures/semantic-equivalence/comprehension.js';
import {validateComprehensionTaskset,publicComprehensionTasks,scoreComprehensionResponses,
  comprehensionTasksetDigest} from '../src/semantic/comprehension.js';

test('predeclared source-free tasks cover meaning, dependencies, conditions, effects and wrong paraphrases',()=>{
  assert(validateComprehensionTaskset(taskset));assert.equal(taskset.tasks.length,12);
  for(const category of ['algorithm','counterfactual','data-flow','paraphrase-rejection','effect-order',
    'causal-boundary','condition','mutation-and-alias','observation-meaning','claim-checking'])
    assert(taskset.tasks.some(task=>task.category===category),category);
  assert(taskset.tasks.every(task=>task.paraphrases.length>=2));
  assert.match(comprehensionTasksetDigest(taskset),/^[a-f0-9]{64}$/);
});

test('survey projection does not expose answer keys or scoring rationales',()=>{
  const survey=publicComprehensionTasks(taskset);
  assert.equal(survey.tasksetDigest,comprehensionTasksetDigest(taskset));
  for(const task of survey.tasks)for(const secret of ['answer','rationale','paraphrases'])assert.equal(Object.hasOwn(task,secret),false);
  survey.tasks[0].choices[0].text='changed';assert.notEqual(survey.tasks[0].choices[0].text,taskset.tasks[0].choices[0].text);
});

test('missing responses stay in the declared denominator and missing timing stays unavailable',()=>{
  const empty=scoreComprehensionResponses(taskset,[]);
  assert.equal(empty.status,'unmeasured');assert.equal(empty.accuracy.allDeclaredTasks,null);
  assert.equal(empty.timing.status,'unavailable');assert.equal(empty.counts.unanswered,12);
  const partial=scoreComprehensionResponses(taskset,[{taskId:'fold-algorithm',choiceId:'ordered'}]);
  assert.equal(partial.status,'partial');assert.equal(partial.accuracy.attempted,1);
  assert.equal(partial.accuracy.allDeclaredTasks,1/12);assert.equal(partial.counts.unanswered,11);
  assert.equal(partial.timing.medianMs,null);
});

test('incorrect paraphrases and changed effect order are scored as wrong even with plausible answers',()=>{
  const report=scoreComprehensionResponses(taskset,[
    {taskId:'arithmetic-wrong-paraphrase',choiceId:'sums-first',elapsedMs:12},
    {taskId:'counter-effect-order',choiceId:'store-first',elapsedMs:20},
    {taskId:'completion-versus-undefined',choiceId:'different-status',elapsedMs:16}
  ],{evaluator:{kind:'fixture',id:'scorer-regression'}});
  assert.equal(report.counts.correct,1);assert.equal(report.counts.incorrect,2);
  assert.equal(report.accuracy.allDeclaredTasks,1/12);assert.equal(report.timing.medianMs,16);
  assert.equal(report.timing.p95Ms,20);assert.equal(report.qualification.readerStudy,'not-a-reader-study');
  assert.equal(report.qualification.learningClaim,false);
});

test('duplicate and unknown tasks cannot inflate comprehension accuracy',()=>{
  for(const responses of [
    [{taskId:'unknown',choiceId:'ordered'}],
    [{taskId:'fold-algorithm',choiceId:'unknown'}],
    [{taskId:'fold-algorithm',choiceId:'ordered'},{taskId:'fold-algorithm',choiceId:'ordered'}],
    [{taskId:'fold-algorithm',choiceId:'ordered',elapsedMs:-1}],
    [{taskId:'fold-algorithm',choiceId:'ordered',elapsedMs:NaN}]
  ])assert.throws(()=>scoreComprehensionResponses(taskset,responses));
});
