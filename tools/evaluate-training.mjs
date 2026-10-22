#!/usr/bin/env node
// Evaluate actual model-selected (not gold) semantic groups against held-out
// reference bundles after committing them to the owned serving controller.
// Teacher traces are accepted as diagnostics, never as evidence of model learning.
import {readFileSync,writeFileSync} from 'node:fs';
import {evaluateSelectedTrajectory} from '../src/training/rollout.js';

const argv=process.argv.slice(2);
const option=(flag)=>argv.includes(flag)?argv[argv.indexOf(flag)+1]:null;
const selected=option('--selected'),reference=option('--reference'),output=option('--output');
if(!selected || !reference)
  throw new Error('Usage: evaluate-training --selected model-groups.jsonl --reference verified.jsonl [--output report.json]');

const lines=file=>readFileSync(file,'utf8').split('\n').filter(Boolean).map((text,i)=>{
  try{return JSON.parse(text);}
  catch(error){throw new Error('Invalid JSONL line '+(i+1)+' in '+file,{cause:error});}
});
const actual=lines(selected),gold=lines(reference);
if(actual.length!==gold.length)throw new Error('Selected/reference episodes must align exactly');
const counts={episodes:actual.length,correct:0,incorrect:0,incomplete:0,
  invalid:0,firstDivergences:{},errors:[]};
let generated=0,sourceBytes=0,traceBytes=0;
for(let i=0;i<actual.length;i++) {
  const target=gold[i];
  if(target?.sidecar?.referenceStatus!=='agreed')
    throw new Error('Unverified reference at line '+(i+1));
  const groups=actual[i]?.groups??actual[i]?.public?.groups;
  const expected=target.public.groups;
  if(!Array.isArray(groups))throw new Error('No selected groups at line '+(i+1));
  // Public, parsed model-selected bytes are the only controller inputs.
  const result=evaluateSelectedTrajectory({
    groups,referenceGroups:expected,referenceOutcome:target.sidecar.reference?.outcome
  });
  const key=result.invalid?'invalid':result.correctness==='correct'?'correct':
    result.correctness==='incomplete'?'incomplete':'incorrect';
  counts[key]++;
  const category=result.invalid?.category??result.firstDivergence?.category??null;
  if(category)counts.firstDivergences[category]=(counts.firstDivergences[category]??0)+1;
  if(key!=='correct')counts.errors.push({index:i,kind:key,
    boundary:result.invalid?.index??result.firstDivergence?.index??null,
    category});
  generated+=result.generatedGroups;
  sourceBytes+=Buffer.byteLength(groups.filter(g=>g.mode==='observed')
    .map(g=>g.events[0].record).join('\n'),'utf8');
  traceBytes+=Buffer.byteLength(groups.filter(g=>g.mode==='generated')
    .map(g=>g.events[0].record).join('\n'),'utf8');
}
const report={schema:'semantic-evaluation/1',mode:'selected-generated-trajectory',
  provenance:'actual selected groups; reference consulted only after commit',
  counts,generatedGroups:generated,observedUtf8Bytes:sourceBytes,
  generatedUtf8Bytes:traceBytes,
  limits:'No model compute/time metrics measured in this offline validator'};
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(counts.invalid || counts.incorrect || counts.incomplete)process.exitCode=1;
