// Freeze model/settings/prompts, sample design and accuracy margins before any
// response collection. One task receives one notation per evaluator cohort.
import {publicComprehensionTasks,comprehensionTasksetDigest,scoreComprehensionResponses} from './comprehension.js';
import {hashAlgorithmData} from './program.js';
import {NOTATION_ARMS,renderNotationRecord} from './notation-experiment.js';
import {decodeAlgorithmRecord} from './trace-codec.js';
import {AlgorithmExecutionHarness} from './harness.js';
const HASH=/^[a-f0-9]{64}$/;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function freezeComprehensionStudy(taskset,{id='language-expansion-pilot',model,settings,prompt,
    examples=[],cohort=0,seed=17,noninferiorityMargin=null,phase='pilot',maxPredictions=128}={}){
  if(!model||typeof model.id!=='string'||!model.id||typeof model.revision!=='string'||!model.revision||
    !settings||typeof settings!=='object'||typeof prompt!=='string'||!prompt||
    !Array.isArray(examples)||!Number.isSafeInteger(cohort)||cohort<0||cohort>3||
    !Number.isSafeInteger(seed)||!['pilot','confirmatory'].includes(phase)||
    !Number.isSafeInteger(maxPredictions)||maxPredictions<1||maxPredictions>4096||
    noninferiorityMargin!==null&&(!Number.isFinite(noninferiorityMargin)||noninferiorityMargin<=0||noninferiorityMargin>=1)||
    phase==='confirmatory'&&noninferiorityMargin===null)throw new TypeError('Predeclared study model, settings, design and margin are required');
  const survey=publicComprehensionTasks(taskset),ordered=[...survey.tasks].sort((a,b)=>
    hashAlgorithmData(seed+':'+a.id).localeCompare(hashAlgorithmData(seed+':'+b.id)));
  const assignments=ordered.map((task,index)=>{
    const arm=NOTATION_ARMS[(index+cohort)%NOTATION_ARMS.length];
    const offset=(index+cohort)%task.choices.length;
    const choices=[...task.choices.slice(offset),...task.choices.slice(0,offset)];
    const stimulus=task.stimulus.kind==='trace'?{kind:'trace',text:task.stimulus.text.split('\n').map(line=>
      renderNotationRecord(decodeAlgorithmRecord(line),{arm})).join('\n')}:structuredClone(task.stimulus);
    return {taskId:task.id,family:task.family,arm:task.stimulus.kind==='trace'?arm:'description-only',
      scheduledArm:arm,notationStatus:task.stimulus.kind==='trace'?'available':'requires-certified-trace-stimulus',
      question:task.question,stimulus,choices};
  });
  const body={schema:'semantic-comprehension-study/1',id,tasksetDigest:comprehensionTasksetDigest(taskset),
    model:structuredClone(model),settings:structuredClone(settings),prompt,examples:structuredClone(examples),
    seed,cohort,phase,noninferiorityMargin,maxPredictions,assignments,
    design:{oneRenderingPerTaskPerEvaluator:true,optionOrder:'counterbalanced deterministic rotation',
      familyHoldout:'family/lineage components must be split before any training export',
      notationComparison:'Only certified trace stimuli compare notation. Description-only tasks test semantic understanding without asserting compact format coverage.',
      granularity:'Fixed within a notation comparison; separate experiment required to compare region sizes'},
    status:'frozen-unmeasured'};
  return freeze({...body,digest:hashAlgorithmData(body)});
}
function verifyStudy(study,taskset){
  const {digest,...body}=study??{};
  if(study?.schema!=='semantic-comprehension-study/1'||!HASH.test(digest??'')||hashAlgorithmData(body)!==digest||
    study.tasksetDigest!==comprehensionTasksetDigest(taskset))throw new TypeError('Study definition or taskset changed');
}
export function wilsonInterval(correct,total){
  if(!Number.isSafeInteger(correct)||!Number.isSafeInteger(total)||correct<0||correct>total)throw new TypeError('Invalid accuracy counts');
  if(total===0)return {lower:null,upper:null,level:0.95};
  const z=1.959963984540054,p=correct/total,z2=z*z,center=(p+z2/(2*total))/(1+z2/total),
    radius=z*Math.sqrt(p*(1-p)/total+z2/(4*total*total))/(1+z2/total);
  return {lower:Math.max(0,center-radius),upper:Math.min(1,center+radius),level:0.95};
}
export function scoreFrozenComprehensionStudy(taskset,study,responseArtifact){
  verifyStudy(study,taskset);
  if(responseArtifact?.schema!=='semantic-comprehension-responses/1'||responseArtifact.studyDigest!==study.digest||
    hashAlgorithmData(responseArtifact.model)!==hashAlgorithmData(study.model)||
    hashAlgorithmData(responseArtifact.settings)!==hashAlgorithmData(study.settings)||
    !Array.isArray(responseArtifact.responses))throw new TypeError('Responses do not bind the frozen model/settings/study');
  const score=scoreComprehensionResponses(taskset,responseArtifact.responses,{evaluator:{kind:'model',
    id:study.model.id+'@'+study.model.revision}});
  const answers=new Map(score.rows.map(row=>[row.taskId,row]));
  const byArm=Object.fromEntries([...NOTATION_ARMS,'description-only'].map(arm=>{
    const assignments=study.assignments.filter(row=>row.arm===arm),rows=assignments.map(row=>answers.get(row.taskId)),
      answered=rows.filter(row=>row.status!=='unanswered').length,correct=rows.filter(row=>row.status==='correct').length;
    return [arm,{declared:rows.length,answered,correct,accuracy:answered?correct/answered:null,
      confidence:wilsonInterval(correct,answered)}];
  }));
  return {...score,schema:'semantic-comprehension-study-score/1',studyDigest:study.digest,byArm,
    confidence:wilsonInterval(score.counts.correct,score.counts.answered),
    qualification:{...score.qualification,standardPromotion:false,noninferiority:'untested',
      reason:'A pilot or one cohort is not a powered paired noninferiority study; actual model execution and serving costs remain independent gates'}};
}

/** Score supplied next-step/full trace generations by the real selected
 * controller. These are model candidates, never teacher repair or replay. */
export function scoreSelectedAlgorithmExecution({source,entry='run',args=[],lines,maxPredictions=128}={}){
  if(!Array.isArray(lines)||lines.some(line=>typeof line!=='string')||!Number.isSafeInteger(maxPredictions)||maxPredictions<1)
    throw new TypeError('Supplied trace lines and a fixed prediction budget are required');
  const harness=new AlgorithmExecutionHarness({source,entry,args});let accepted=0;
  for(const line of lines){
    if(accepted>=maxPredictions)return {status:'resource_limited',accepted,completed:false,reason:'Prediction budget exhausted'};
    try{
      const selected=harness.select(line);
      if(!selected.claim.consistent)return {status:'failed',accepted,completed:false,reason:selected.claim.reason??'False selected claim'};
      accepted++;
    }catch(error){return {status:'failed',accepted,completed:false,reason:error.message};}
  }
  const completion=harness.controller.completion;
  return {status:completion?'passed':'incomplete',accepted,completed:!!completion,completion:completion??null,
    nextStepCorrect:accepted>0,qualification:'Causal selected execution of supplied candidate lines; external observations require the effectful experiment harness'};
}
