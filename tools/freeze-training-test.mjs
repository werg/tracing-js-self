#!/usr/bin/env node
// Freeze an independently verified held-out common cohort BEFORE model tuning.
import {readFileSync,writeFileSync} from 'node:fs';
import {freezeExperimentCohort} from '../src/training/experiment.js';

const args=process.argv.slice(2);
const argument=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:null;
const source=argument('--references'),output=argument('--output');
if(!source||!output)
  throw new Error('Usage: npm run training:freeze -- --references verified-test.jsonl --output frozen-cohort.json');
const references=readFileSync(source,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const frozen=freezeExperimentCohort(references);
writeFileSync(output,JSON.stringify(frozen,null,2)+'\n');
console.log(JSON.stringify({output,sha256:frozen.cohortSha256,
  sources:frozen.families.length,cases:frozen.cases.length}));
