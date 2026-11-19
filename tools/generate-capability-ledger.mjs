#!/usr/bin/env node
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCapabilityLedger,CAPABILITY_CASES} from '../src/training/capability-ledger.js';
import {loadNativeSettings,createNativeConsumer} from '../src/corpus/native-admission-client.mjs';
import {loadNativeV7Settings,createNativeV7Consumer} from '../src/corpus/native-admission-v7.mjs';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';

const flags=new Map(),valued=new Set(['--out','--cases','--megatoken','--tokenizer','--python','--native-policy','--version','--population']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(flags.has(key)||!valued.has(key)&&key!=='--require-native')throw new Error('Unknown or repeated option '+key);
  if(key==='--require-native')flags.set(key,true);
  else {const value=process.argv[++i];if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);flags.set(key,value);}
}
if(!flags.has('--out'))throw new Error('Usage: node tools/generate-capability-ledger.mjs --out report.json [--version 7|6] [--population capabilities|gallery] [--cases id,id] [--megatoken DIR --tokenizer FILE --python PYTHON --native-policy FILE] [--require-native]');
const output=resolve(flags.get('--out')),root=fileURLToPath(new URL('..',import.meta.url));
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const traceVersion=Number(flags.get('--version')??7),population=flags.get('--population')??'capabilities';
if(![6,7].includes(traceVersion))throw new Error('--version must be 6 or 7; v8 requires its actual compiler adapter');
if(!['capabilities','gallery'].includes(population))throw new Error('--population must be capabilities or gallery');
const cases=population==='gallery'?SEMANTIC_GALLERY_FIXTURES:CAPABILITY_CASES;
const selected=flags.has('--cases')?flags.get('--cases').split(','):cases.map(row=>row.id);
if(new Set(selected).size!==selected.length||selected.some(id=>!cases.some(row=>row.id===id)))
  throw new Error('Capability case IDs must be known and unique');
const requested=['--megatoken','--tokenizer','--native-policy'].some(key=>flags.has(key));
const nativeOptions={megatoken:flags.get('--megatoken'),tokenizer:flags.get('--tokenizer'),
  python:flags.get('--python')??'python3',temporaryDirectory:output+'.native',
  policyFile:requested?(flags.get('--native-policy')??resolve(root,traceVersion===6?'contracts/native-admission-policy-v6.json':'contracts/semantic-native-policy-v7.json')):undefined};
const native=requested?(traceVersion===6?loadNativeSettings(nativeOptions):loadNativeV7Settings(nativeOptions)):null;
if(flags.has('--require-native')&&!native)throw new Error('--require-native needs a pinned native consumer');
const report=await buildCapabilityLedger({producerRevision,traceVersion,population,
  cases:cases.filter(row=>selected.includes(row.id)),
  nativeConsumer:native?(traceVersion===6?createNativeConsumer(native):createNativeV7Consumer(native)):null,
  nativePolicy:native?.policy??null});
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,totals:report.totals,optimizerSteps:0,learnedSuccess:null}));
if(report.totals.nativeAdmission.failed)process.exitCode=1;
