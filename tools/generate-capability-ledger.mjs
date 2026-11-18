#!/usr/bin/env node
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCapabilityLedger} from '../src/training/capability-ledger.js';
import {loadNativeSettings,createNativeConsumer} from '../src/corpus/native-admission-client.mjs';

const flags=new Map(),valued=new Set(['--out','--megatoken','--tokenizer','--python','--native-policy']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(flags.has(key)||!valued.has(key)&&key!=='--require-native')throw new Error('Unknown or repeated option '+key);
  if(key==='--require-native')flags.set(key,true);
  else {const value=process.argv[++i];if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);flags.set(key,value);}
}
if(!flags.has('--out'))throw new Error('Usage: node tools/generate-capability-ledger.mjs --out report.json [--megatoken DIR --tokenizer FILE --python PYTHON]');
const output=resolve(flags.get('--out')),root=fileURLToPath(new URL('..',import.meta.url));
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const requested=['--megatoken','--tokenizer','--native-policy'].some(key=>flags.has(key));
const native=loadNativeSettings({megatoken:flags.get('--megatoken'),tokenizer:flags.get('--tokenizer'),
  python:flags.get('--python')??'python3',temporaryDirectory:output+'.native',
  policyFile:requested?(flags.get('--native-policy')??resolve(root,'contracts/native-admission-policy-v5.json')):undefined});
if(flags.has('--require-native')&&!native)throw new Error('--require-native needs a pinned native consumer');
const report=await buildCapabilityLedger({producerRevision,nativeConsumer:createNativeConsumer(native),nativePolicy:native?.policy??null});
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,totals:report.totals,optimizerSteps:0,learnedSuccess:null}));
