#!/usr/bin/env node
// Select a diverse subset of locally verified owned Exercism episodes.
// This does not execute arbitrary guests or add training-admitted examples.
import {createReadStream,writeFileSync,mkdirSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve,dirname} from 'node:path';
import {profileOwnedEpisode,selectNovelEpisodes}
 from '../src/corpus/coverage-selection.mjs';
const argv=process.argv.slice(2);
const arg=x=>{const i=argv.indexOf('--'+x);return i===-1?null:argv[i+1];};
const input=arg('input'),output=arg('output'),limit=Number(arg('limit')??128);
if(!input||!output)throw new Error('Require --input and --output');
if(!Number.isSafeInteger(limit)||limit<1||limit>5000)
 throw new Error('Invalid --limit');
const profiles=[],refusals={};
for await(const line of createInterface({input:createReadStream(resolve(input)),
 crlfDelay:Infinity})){
 if(!line.trim())continue;
 if(profiles.length>=10000)throw new Error('Too many verified episode rows');
 const row=JSON.parse(line);
 // Unexpected evidence is not silently discarded: all supplied records must
 // be independently rechecked before producing a selection report.
 try{profiles.push(profileOwnedEpisode(row));}
 catch(error){
  const reason=String(error.message).slice(0,180);
  refusals[reason]=(refusals[reason]??0)+1;
 }
}
if(!profiles.length)throw new Error('No independently verified owned episodes');
const result=selectNovelEpisodes(profiles,{limit});
result.evidenceRefusals=refusals;
result.inputRows=profiles.length+Object.values(refusals).reduce((a,b)=>a+b,0);
mkdirSync(dirname(resolve(output)),{recursive:true});
writeFileSync(resolve(output),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({inputRows:result.inputRows,verified:profiles.length,
 selected:result.selectedCount,distinctPaths:result.distinctPaths,
 distinctFamilies:result.distinctFamilies,refusals}));
