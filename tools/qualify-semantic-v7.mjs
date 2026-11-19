#!/usr/bin/env node
// Fresh paired v7 admission and a complete immutable source-family inventory.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {verifyAlgorithmTrainingCase,admitAlgorithmEvidence} from '../src/semantic/compiler.js';
import {prepareSemanticFamilyRegistry,bindSemanticFamilySplit} from '../src/semantic/dataset-v7.js';
import {loadNativeV7Settings,createNativeV7Consumer} from '../src/corpus/native-admission-v7.mjs';

if(process.argv.includes('--help')){
  process.stdout.write('Usage: node tools/qualify-semantic-v7.mjs --out NEW_DIRECTORY --megatoken CHECKOUT --python PYTHON --tokenizer TOKENIZER.json --native-policy POLICY.json [--seed 17] [--max-positions 8192] [--max-history 1024] [--holdout-family NAME] [--holdout-source SHA256] [--holdout-core SHA256]\n');
  process.exit(0);
}
const allowed=new Set(['--out','--megatoken','--python','--tokenizer','--native-policy','--seed','--max-positions','--max-history']);
const args=new Map();
const holdouts={'--holdout-family':[],'--holdout-source':[],'--holdout-core':[]};
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  if(Object.hasOwn(holdouts,key)){
    if(!value||value.startsWith('--'))throw new Error('Missing holdout value');
    holdouts[key].push(value);continue;
  }
  if(!allowed.has(key)||!value||value.startsWith('--')||args.has(key))throw new Error('Unknown, repeated or incomplete v7 admission option: '+key);
  args.set(key,value);
}
for(const key of ['--out','--megatoken','--python','--tokenizer','--native-policy'])
  if(!args.has(key))throw new Error('Required v7 admission option: '+key);
const seed=Number(args.get('--seed')??17),maxPositions=Number(args.get('--max-positions')??8192),
  maxHistory=Number(args.get('--max-history')??1024);
if(!Number.isSafeInteger(seed)||!Number.isSafeInteger(maxPositions)||maxPositions<1||
  !Number.isSafeInteger(maxHistory)||maxHistory<1)throw new Error('Explicit integer split/context budgets are required');
const output=resolve(args.get('--out'));
mkdirSync(output,{recursive:false});
const settings=loadNativeV7Settings({megatoken:args.get('--megatoken'),python:args.get('--python'),
  tokenizer:args.get('--tokenizer'),policyFile:args.get('--native-policy'),temporaryDirectory:join(output,'temporary')});
const consumer=createNativeV7Consumer(settings,{maxPositions,maxHistory});
const producerRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const candidates=[];
for(const fixture of SEMANTIC_GALLERY_FIXTURES){
  const result=await verifyAlgorithmTrainingCase({...structuredClone(fixture),producerRevision});
  candidates.push({...result,id:fixture.id,source:fixture.source,entry:fixture.entry,family:fixture.family});
}
const prepared=prepareSemanticFamilyRegistry(candidates,{seed,families:holdouts['--holdout-family'],
  sourceDigests:holdouts['--holdout-source'],coreDigests:holdouts['--holdout-core']});
writeFileSync(join(output,'family-registry.json'),JSON.stringify(prepared.registry,null,2)+'\n',{flag:'wx'});
const admissions=[],refusals=[];
for(const member of prepared.members){
  try{
    if(!member.qualified)throw new Error(member.reason??'Source is not qualified');
    const bound=bindSemanticFamilySplit(member.candidate,member,prepared.registry);
    const result=await admitAlgorithmEvidence(bound,{nativeConsumer:consumer,nativePolicy:settings.policy});
    admissions.push({id:member.id,status:'admitted',exported:result.exported});
    process.stderr.write(JSON.stringify({source:member.id,representation:bound.public.representation,status:'admitted'})+'\n');
  }catch(error){
    refusals.push({id:member.id,family:member.family,status:'refused',reason:error.message});
    process.stderr.write(JSON.stringify(refusals.at(-1))+'\n');
  }
}
writeFileSync(join(output,'admitted.jsonl'),admissions.map(row=>JSON.stringify(row)+'\n').join(''),{flag:'wx'});
writeFileSync(join(output,'refusals.jsonl'),refusals.map(row=>JSON.stringify(row)+'\n').join(''),{flag:'wx'});
const report={schema:'semantic-v7-integration/1',producerRevision,consumerRevision:settings.policy.consumerRevision,
  tokenizerIdentity:settings.policy.tokenizerIdentity,registryDigest:prepared.registry.digest,
  attempted:candidates.length,admitted:admissions.length,refused:refusals.length,
  representations:Object.fromEntries(['algorithm','detailed'].map(kind=>[kind,admissions.filter(row=>row.exported.public.representation===kind).length])),
  splits:Object.fromEntries(['train','validation','test'].map(split=>[split,admissions.filter(row=>row.exported.sidecar.split===split).length])),
  maxPositions,maxHistory,optimizerSteps:0,learningClaim:null};
writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify(report)+'\n');
if(refusals.length||!admissions.length)process.exitCode=1;
