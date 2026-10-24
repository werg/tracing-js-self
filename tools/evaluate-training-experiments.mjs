#!/usr/bin/env node
// Strict post-run aggregator. NEVER fabricates model predictions or accepts
// a teacher trace replay as evidence of model learning.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {evaluateActualModelExperiment,EXPERIMENT_CONDITIONS,EXPERIMENT_SEEDS}
  from '../src/training/experiment.js';
const args=process.argv.slice(2);
const option=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:null;
const manifest=option('--manifest'),references=option('--references'),
  directory=option('--runs'),output=option('--output');
if(!manifest||!references||!directory||!output)
  throw new Error('Usage: npm run training:experiment -- --manifest pinned.json '+
    '--references frozen-test.jsonl --runs actual-model-selected/ --output report.json');
function readJson(path){return JSON.parse(readFileSync(path,'utf8'));}
function readJsonl(path){return readFileSync(path,'utf8').split('\n')
  .filter(Boolean).map(JSON.parse);}
const inputs=readJson(manifest);
const cases=readJsonl(references);
const runs=[];
for(const condition of EXPERIMENT_CONDITIONS)
  for(const seed of EXPERIMENT_SEEDS){
    // The historical condition is evaluated only by an isolated pinned
    // historical runner; this v3 process never parses its old trace bytes.
    const path=join(directory,condition,String(seed)+'.json');
    runs.push(readJson(path));
  }
const result=evaluateActualModelExperiment({manifest:inputs,references:cases,runs});
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,conditions:result.runs.length,
  pairedFamilyIntervals:result.pairedFamilyIntervals.length,measured:true}));
