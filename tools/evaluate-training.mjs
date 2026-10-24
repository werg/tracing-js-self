#!/usr/bin/env node
// Exact selected-state evaluation: outcome and reasoning are independent
// metrics. A mathematical lie is never repaired from the teacher trajectory.
import {readFileSync,writeFileSync} from 'node:fs';
import {evaluateSelectedTrajectory} from '../src/training/rollout.js';

const argv=process.argv.slice(2);
const option=flag=>argv.includes(flag)?argv[argv.indexOf(flag)+1]:null;
const selected=option('--selected'),reference=option('--reference'),output=option('--output');
if(!selected||!reference)throw new Error(
  'Usage: npm run training:evaluate -- --selected selected.jsonl --reference verified.jsonl');
const lines=file=>readFileSync(file,'utf8').split('\n').filter(Boolean).map((line,i)=>{
  try{return JSON.parse(line);}
  catch(error){throw new Error('Malformed JSONL record at '+file+':'+(i+1),{cause:error});}
});
const actual=lines(selected),gold=lines(reference);
if(actual.length!==gold.length)throw new TypeError('Selected/reference episode counts differ');
const counts={episodes:actual.length,correct:0,incorrect:0,incomplete:0,invalid:0,
  correctWithWitnessViolation:0,witnessViolations:0,referenceTraceDifferences:0,
  observableMismatches:0,errors:[]};
let logicalRecords=0,physicalGroups=0,observedUtf8Bytes=0,generatedUtf8Bytes=0;
for(const [index,selectedEpisode] of actual.entries()){
  const referenceEpisode=gold[index];
  if(referenceEpisode?.public?.schema!=='semantic-execution/3'||
     referenceEpisode.sidecar?.schema!=='semantic-supervision/2'||
     referenceEpisode.sidecar?.referenceStatus!=='agreed')
    throw new Error('Missing independently verified v3 reference at line '+(index+1));
  const groups=selectedEpisode?.groups??selectedEpisode?.public?.groups;
  if(!Array.isArray(groups))throw new Error('Missing selected groups at line '+(index+1));
  const outcome=evaluateSelectedTrajectory({
    groups,referenceGroups:referenceEpisode.public.groups,
    referenceOutcome:referenceEpisode.sidecar.reference});
  const state=outcome.invalid?'invalid':outcome.correctness==='correct'?'correct':
    outcome.correctness==='incomplete'?'incomplete':'incorrect';
  counts[state]++;
  const violation=outcome.firstWitnessViolation;
  if(violation){counts.witnessViolations++;if(state==='correct')counts.correctWithWitnessViolation++;}
  if(outcome.firstReferenceTraceDifference)counts.referenceTraceDifferences++;
  if(outcome.observableMismatch)counts.observableMismatches++;
  if(state!=='correct'||violation)counts.errors.push({
    index,correctness:state,
    invalid:outcome.invalid,
    firstWitnessViolation:violation,
    firstReferenceTraceDifference:outcome.firstReferenceTraceDifference,
    observableMismatch:outcome.observableMismatch
  });
  logicalRecords+=outcome.logicalRecords??0;
  physicalGroups+=outcome.physicalGroups??groups.length;
  observedUtf8Bytes+=Buffer.byteLength(groups.filter(g=>g.mode==='observed')
    .flatMap(g=>g.events.map(e=>e.record)).join('\n'),'utf8');
  generatedUtf8Bytes+=Buffer.byteLength(groups.filter(g=>g.mode==='generated')
    .flatMap(g=>g.events.map(e=>e.record)).join('\n'),'utf8');
}
const report={schema:'semantic-evaluation/3',
  contract:{observableExecutionCorrectness:'selected completion and reachable graph',
    witnessConsistency:'independent typed primitive checker with no repair',
    artifactIntegrity:'reference demonstration independently validated on import'},
  mode:'actual-selected-records',counts,
  logicalRecords,physicalGroups,observedUtf8Bytes,generatedUtf8Bytes,
  modelTokens:null,modelCompute:null,
  modelTrainingMeasured:false};
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(counts.invalid||counts.incorrect||counts.incomplete)process.exitCode=1;
