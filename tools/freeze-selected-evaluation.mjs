#!/usr/bin/env node
// Prepare the independently checked declaration consumed by Megatoken's freeze
// command. Whole source families retain the corpus split fixed before expansion.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {controlledEvaluationCase} from '../src/training/selected-evaluation.js';
const [directory,output,...options]=process.argv.slice(2);
if(!directory||!output||options.some(option=>option!=='--common-support'))
  throw new Error('Usage: freeze-selected-evaluation.mjs CORPUS_DIRECTORY DECLARATION.json [--common-support]');
const commonSupport=options.includes('--common-support');
const manifest=JSON.parse(readFileSync(join(resolve(directory),'manifest.json'),'utf8'));
const candidates=manifest.cases.filter(item=>item.path&&['test','validation'].includes(item.split)).map(item=>{
  const episode=JSON.parse(readFileSync(join(resolve(directory),item.path),'utf8'));
  return controlledEvaluationCase(episode,{id:item.id,family:item.family,split:item.split});
});
// Freeze each external source task once. Explicit and compact certified action
// plans share the exact source, input, fixture, expectation, family and split.
// They are injected only for controlled engineering runs; actual model prefixes
// contain neither plan nor expected outcome.
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const grouped=new Map();
for(const candidate of candidates){
  const request=structuredClone(candidate.request);
  delete request.controlledSelectionsByRepresentation;
  const key=digest({family:candidate.family,split:candidate.split,request});
  const existing=grouped.get(key);
  if(!existing){grouped.set(key,candidate);continue;}
  if(!isDeepStrictEqual(existing.expected,candidate.expected))
    throw new Error('Source-identical representations disagree on independently checked outcome');
  for(const [representation,plan] of Object.entries(candidate.request.controlledSelectionsByRepresentation)){
    if(existing.request.controlledSelectionsByRepresentation[representation])continue;
    existing.request.controlledSelectionsByRepresentation[representation]=plan;
  }
  existing.referenceReceipt.requestDigest=digest(existing.request);
}
const cases=[...grouped.values()].filter(item=>{
  const pure=Boolean(item.request.program&&item.request.invocation&&
    !item.request.program.capabilities.length&&!item.request.fixture.calls.length);
  return commonSupport?pure:!pure;
});
if(!cases.length)throw new Error('No independently verified held-out source families');
if(cases.some(item=>!item.request.controlledSelectionsByRepresentation.explicit))
  throw new Error('The engineering cohort needs an explicit certified plan for every source task');
writeFileSync(output,JSON.stringify({cases,name:commonSupport?'common-support':'effectful-tracks-events',
  thresholds:{wholeTaskSuccess:0.9,traceValid:1},
  historical_baseline:commonSupport?{
    sourceRunbook:'https://github.com/werg/tracing-js-self/blob/e31ae33d3ce4a7258d64393c7982445d40c0b297/docs/SEMANTIC_V3_MODEL_EXPERIMENTS.md',
    conditions:['historical-v2','v3-fine','v3-fused','v3-expr-2','v3-expr-4','v3-expr-8','v3-collections','v3-outcome-only'],
    seeds:[17,29,43]}:null,
  historical_baseline_pending:commonSupport},null,2)+'\n');
process.stdout.write(JSON.stringify({cases:cases.length,families:[...new Set(cases.map(c=>c.family))]})+'\n');
