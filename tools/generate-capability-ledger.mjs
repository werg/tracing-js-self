#!/usr/bin/env node
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildCapabilityLedger,CAPABILITY_CASES} from '../src/training/capability-ledger.js';
import {loadNativeSettings,createNativeConsumer} from '../src/corpus/native-admission-client.mjs';

const options=new Map(),allowed=new Set(['--out','--cases','--megatoken','--python','--tokenizer','--native-policy']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=process.argv[++i];
  if(!allowed.has(key)||options.has(key)||!value||value.startsWith('--'))throw new Error('Unknown, repeated or missing capability option '+key);
  options.set(key,value);
}
if(!options.has('--out'))throw new Error('Usage: node tools/generate-capability-ledger.mjs --out report.json [--cases id,id] [--megatoken DIR --python PYTHON --tokenizer FILE --native-policy FILE]');
const output=resolve(options.get('--out'));
const producerRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const selected=options.has('--cases')?options.get('--cases').split(','):CAPABILITY_CASES.map(row=>row.id);
if(new Set(selected).size!==selected.length||selected.some(id=>!CAPABILITY_CASES.some(row=>row.id===id)))
  throw new Error('Capability case IDs must be known and unique');
const native=loadNativeSettings({megatoken:options.get('--megatoken'),python:options.get('--python')??'python3',
  tokenizer:options.get('--tokenizer'),policyFile:options.get('--native-policy'),temporaryDirectory:output+'.native'});
const report=await buildCapabilityLedger({producerRevision,cases:CAPABILITY_CASES.filter(row=>selected.includes(row.id)),
  nativeConsumer:createNativeConsumer(native),nativePolicy:native?.policy??null});
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,totals:report.totals,optimizerSteps:0,learnedSuccess:null}));
if(report.totals.nativeAdmission.failed)process.exitCode=1;
