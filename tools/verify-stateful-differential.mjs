#!/usr/bin/env node
// Trusted, source-pinned native V8 vs independently written queue model.
// This is opt-in diagnostics, never owned bytecode or training admission.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import Queue from '../corpus/stateful/upstream/yocto-queue/index.js';
import {upstream,pinnedSha256} from '../corpus/stateful/cases.mjs';
import {compareQueueHistory,generateQueueSequences,shrinkStatefulMismatch}
 from '../src/corpus/stateful-differential.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
const argv=process.argv.slice(2);
const opt=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1];};
const seed=Number(opt('--seed','42')),count=Number(opt('--count','256')),
 maxCommands=Number(opt('--max-commands','64')),
 output=resolve(opt('--output','corpus/out/queue-stateful-differential.json'));
const source=upstream['yocto-queue'];
const original=readFileSync(resolve('corpus/stateful/upstream',source.path));
if(sha(original)!==pinnedSha256['yocto-queue'])
 throw new Error('Pinned yocto-queue source hash mismatch');
const cases=generateQueueSequences({seed,count,maxCommands});
const disagreements=[];let commandExecutions=0;
for(const sample of cases){
 const result=compareQueueHistory(sample.commands,Queue);
 commandExecutions+=sample.commands.length;
 if(!result.agreed){
  const shrink=await shrinkStatefulMismatch(sample.commands,commands=>({
   reproduced:!compareQueueHistory(commands,Queue).agreed,
   signature:'observable-queue-model-mismatch'
  }),{maxEvaluations:128});
  disagreements.push({id:sample.id,commands:sample.commands,
    native:result.native,reference:result.reference,shrink});
 }
}
const report={schema:'pinned-queue-stateful-fuzz/1',
 authority:'source-pinned-native-v8-vs-explicit-array-model',
 admitted:false,verifiedOwned:false,source:{...source,sha256:pinnedSha256['yocto-queue']},
 settings:{seed,count,maxCommands},uniqueSequences:cases.length,
 attemptedCommands:commandExecutions,agreed:cases.length-disagreements.length,
 disagreed:disagreements.length,disagreements,
 limitations:[
  'The array model verifies observable queue state, not arbitrary JS interpreter events.',
  'Shrinking requires a trusted independent oracle and does not create owned traces.',
  'Actual concurrent workers, complex host effects and training admission are out of scope.'
 ]};
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:output,sequences:cases.length,
 commandExecutions,disagreed:disagreements.length,admitted:false}));
if(disagreements.length)process.exitCode=1;
