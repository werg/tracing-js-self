// Scores supplied responses against a frozen task set. It does not manufacture
// reader responses, run a language model, or equate renderer tests with learning.
import {createHash} from 'node:crypto';
import {stableAlgorithmJSON,isAlgorithmDataRecord,assertAlgorithmDataArray} from './ir.js';
import {decodeAlgorithmRecord} from './trace-codec.js';

export const COMPREHENSION_TASKSET_VERSION='semantic-comprehension-taskset/1';
export const COMPREHENSION_SCORE_VERSION='semantic-comprehension-score/1';
const copy=value=>structuredClone(value),id=/^[a-z][a-z0-9-]*$/;

export function validateComprehensionTaskset(taskset){
  if(!isAlgorithmDataRecord(taskset)||taskset.schema!==COMPREHENSION_TASKSET_VERSION||
    !id.test(taskset.id)||!Number.isSafeInteger(taskset.version)||taskset.version<1||
    typeof taskset.profile!=='string'||typeof taskset.purpose!=='string'||taskset.measurement!=='unmeasured')
    throw new TypeError('A predeclared comprehension task set is required');
  assertAlgorithmDataArray(taskset.tasks,'comprehension tasks');
  if(!taskset.tasks.length||taskset.tasks.length>256)throw new TypeError('Comprehension task budget');
  const seen=new Set();
  for(const task of taskset.tasks){
    if(!isAlgorithmDataRecord(task)||!id.test(task.id)||seen.has(task.id)||
      !id.test(task.family)||!id.test(task.category)||
      !['trace-to-description','description-to-operation'].includes(task.direction)||
      !isAlgorithmDataRecord(task.stimulus)||!['trace','description'].includes(task.stimulus.kind)||
      typeof task.stimulus.text!=='string'||!task.stimulus.text||typeof task.question!=='string'||!task.question||
      typeof task.rationale!=='string'||!task.rationale)throw new TypeError('Comprehension task identity or meaning');
    seen.add(task.id);assertAlgorithmDataArray(task.choices,'answer choices');
    assertAlgorithmDataArray(task.paraphrases,'independent paraphrases');
    if(task.choices.length<2||task.choices.length>5||new Set(task.choices.map(choice=>choice.id)).size!==task.choices.length||
      task.choices.some(choice=>!isAlgorithmDataRecord(choice)||!id.test(choice.id)||typeof choice.text!=='string'||!choice.text)||
      !task.choices.some(choice=>choice.id===task.answer)||task.paraphrases.length<2||
      task.paraphrases.some(text=>typeof text!=='string'||!text))throw new TypeError('Comprehension answers or paraphrases');
    if(task.stimulus.kind==='trace')task.stimulus.text.split('\n').forEach(line=>decodeAlgorithmRecord(line));
  }
  stableAlgorithmJSON(taskset);return true;
}
export function comprehensionTasksetDigest(taskset){validateComprehensionTaskset(taskset);
  return createHash('sha256').update(stableAlgorithmJSON(taskset)).digest('hex');}

/** Answer keys, rationales and known-correct paraphrases never enter a survey. */
export function publicComprehensionTasks(taskset){
  validateComprehensionTaskset(taskset);
  return {schema:'semantic-comprehension-survey/1',taskset:taskset.id,version:taskset.version,
    tasksetDigest:comprehensionTasksetDigest(taskset),profile:taskset.profile,
    tasks:taskset.tasks.map(({answer,rationale,paraphrases,...task})=>copy(task))};
}
function times(values){
  const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;
  return {status:n?'reported':'unavailable',reported:n,medianMs:n?
    n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2:null,
    p95Ms:n?sorted[Math.ceil(n*0.95)-1]:null,totalMs:n?sorted.reduce((a,b)=>a+b,0):null};
}
export function scoreComprehensionResponses(taskset,responses,{evaluator=null}={}){
  validateComprehensionTaskset(taskset);assertAlgorithmDataArray(responses,'comprehension responses');
  if(evaluator!==null&&(!isAlgorithmDataRecord(evaluator)||!['human','model','fixture'].includes(evaluator.kind)||
    typeof evaluator.id!=='string'||!evaluator.id))throw new TypeError('Reported evaluator identity');
  const known=new Map(taskset.tasks.map(task=>[task.id,task])),provided=new Map();
  for(const response of responses){
    if(!isAlgorithmDataRecord(response)||Object.keys(response).some(key=>!['taskId','choiceId','elapsedMs'].includes(key))||
      !known.has(response.taskId)||provided.has(response.taskId)||
      !known.get(response.taskId).choices.some(choice=>choice.id===response.choiceId)||
      Object.hasOwn(response,'elapsedMs')&&(!Number.isFinite(response.elapsedMs)||response.elapsedMs<0))
      throw new TypeError('Unknown, duplicate, or malformed comprehension response');
    provided.set(response.taskId,response);
  }
  const rows=taskset.tasks.map(task=>{
    const response=provided.get(task.id);
    return {taskId:task.id,family:task.family,category:task.category,direction:task.direction,
      status:!response?'unanswered':response.choiceId===task.answer?'correct':'incorrect',
      choiceId:response?.choiceId??null,expected:task.answer,rationale:task.rationale,
      elapsedMs:response?.elapsedMs??null};
  });
  const correct=rows.filter(row=>row.status==='correct').length,answered=provided.size,total=rows.length;
  const byCategory=Object.fromEntries([...new Set(rows.map(row=>row.category))].map(category=>{
    const selected=rows.filter(row=>row.category===category);
    return [category,{tasks:selected.length,answered:selected.filter(row=>row.status!=='unanswered').length,
      correct:selected.filter(row=>row.status==='correct').length}];
  }));
  return {schema:COMPREHENSION_SCORE_VERSION,taskset:taskset.id,version:taskset.version,
    tasksetDigest:comprehensionTasksetDigest(taskset),status:answered===0?'unmeasured':answered===total?'complete':'partial',
    reportedEvaluator:copy(evaluator),evidence:'Scored supplied responses; evaluator identity and timing are reported, not independently authenticated.',
    counts:{tasks:total,answered,correct,incorrect:answered-correct,unanswered:total-answered},
    accuracy:{attempted:answered?correct/answered:null,allDeclaredTasks:answered?correct/total:null,
      denominator:'allDeclaredTasks retains every predeclared task; unanswered items count as incorrect once any responses are supplied'},
    timing:times(rows.filter(row=>row.elapsedMs!==null).map(row=>row.elapsedMs)),byCategory,rows,
    qualification:{nativeAdmission:false,learningClaim:false,
      readerStudy:evaluator?.kind==='human'?'supplied-human-responses-not-independently-verified':'not-a-reader-study'}};
}
