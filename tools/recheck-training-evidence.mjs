#!/usr/bin/env node
// Recompute independent local evidence after JSONL round-trip. Trusted local
// fixture files only; Node vm is not a security sandbox for submitted code.
import {readFileSync} from 'node:fs';
import {recheckIndependentTrainingEvidence} from '../src/training/admit.js';
const filename=process.argv[2];
if(!filename||process.argv.length!==3)
  throw new TypeError('Usage: node tools/recheck-training-evidence.mjs <trusted-local-corpus.jsonl>');
const rows=readFileSync(filename,'utf8').trim().split('\n').filter(Boolean);
if(!rows.length)throw new TypeError('No local candidates provided');
const failures=[];
for(const [index,line] of rows.entries()){
  try{
    const evidence=recheckIndependentTrainingEvidence(JSON.parse(line));
    if(!evidence.valid)failures.push({index,reason:evidence.reason});
  }catch(error){failures.push({index,reason:String(error.message)});}
}
const report={schema:'training-local-evidence-recheck/1',
  checked:rows.length,locallyVerified:rows.length-failures.length,
  failed:failures.length,admitted:0,failures};
process.stdout.write(JSON.stringify(report)+'\n');
if(failures.length)process.exitCode=1;
