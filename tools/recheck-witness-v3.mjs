#!/usr/bin/env node
// Post-serialization, locally independent verification for version-three
// demonstrations. Replays private archive and reruns trusted V8 reference.
import {readFileSync} from 'node:fs';
import {validateWitnessTrainingExport} from '../src/training/export-v3.js';

const path=process.argv[2];
if(!path)throw new TypeError('Usage: node tools/recheck-witness-v3.mjs <jsonl>');
const lines=readFileSync(path,'utf8').split('\n').filter(Boolean);
const errors=[];
for(const [index,line] of lines.entries()){
  try{
    const exported=JSON.parse(line);
    validateWitnessTrainingExport(exported);
  }catch(error){errors.push({index,reason:error.message});}
}
const result={schema:'semantic-recheck/3',count:lines.length,
  verified:lines.length-errors.length,refused:errors.length,errors,
  admission:'locally_verified_only'};
console.log(JSON.stringify(result));
if(errors.length||!lines.length)process.exitCode=1;
