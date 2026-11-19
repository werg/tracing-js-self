#!/usr/bin/env node
// The complete source inventory is frozen before examples or artifacts are
// written. Missing native admission is an explicit per-source export refusal.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {exportRegionDatasetJSONL} from '../src/semantic/dataset-v8.js';

const argv=process.argv.slice(2);
if(argv.includes('--help')||argv.includes('-h')){
  process.stdout.write('Usage: node tools/export-semantic-v8.mjs --input CANDIDATES.jsonl '+
    '--tokenizer-module MODULE.mjs --max-context N --seed N --out NEW_DIRECTORY '+
    '[--native-module MODULE.mjs] [--allow-local] [--max-examples N] '+
    '[--holdout-family NAME] [--holdout-source SHA256] [--holdout-core SHA256]\n\n'+
    'The tokenizer module exports tokenizer and eosTokenId. The optional native module exports '+
    'nativePolicy and nativeConsumer. Production exports require independent v8 native admission; '+
    'missing or invalid receipts remain disposition rows. --allow-local creates an explicitly '+
    'unadmitted diagnostic corpus. The output includes complete source-bound artifacts, exact '+
    'causal examples, all dispositions, the immutable v8 family registry, and a final manifest. '+
    'Malformed nonblank input lines and source refusals remain in the original denominator.\n');
  process.exit(0);
}
const valued=new Set(['--input','--tokenizer-module','--max-context','--seed','--out','--native-module','--max-examples']);
const args=new Map(),holdouts={families:[],sourceDigests:[],coreDigests:[]};
const repeated={'--holdout-family':'families','--holdout-source':'sourceDigests','--holdout-core':'coreDigests'};
for(let index=0;index<argv.length;index++){
  const key=argv[index];
  if(key==='--allow-local'){
    if(args.has(key))throw new TypeError('Repeated option '+key);args.set(key,true);continue;
  }
  if(!valued.has(key)&&!Object.hasOwn(repeated,key))throw new TypeError('Unknown option '+key);
  const value=argv[++index];if(!value||value.startsWith('--'))throw new TypeError('Missing value for '+key);
  if(Object.hasOwn(repeated,key)){holdouts[repeated[key]].push(value);continue;}
  if(args.has(key))throw new TypeError('Repeated option '+key);args.set(key,value);
}
for(const key of ['--input','--tokenizer-module','--max-context','--seed','--out'])
  if(!args.has(key))throw new TypeError('Missing '+key+'; use --help for the complete command');
const seed=Number(args.get('--seed')),maxContextTokens=Number(args.get('--max-context')),
  maxExamplesPerEpisode=args.has('--max-examples')?Number(args.get('--max-examples')):4096;
if(!Number.isSafeInteger(seed)||!Number.isSafeInteger(maxContextTokens)||maxContextTokens<2||
  !Number.isSafeInteger(maxExamplesPerEpisode)||maxExamplesPerEpisode<1)
  throw new TypeError('A safe integer seed and positive context/episode budgets are required');
const tokenizerModule=await import(pathToFileURL(resolve(args.get('--tokenizer-module'))));
const {tokenizer,eosTokenId}=tokenizerModule;
let nativeModule=null;
try{
  if(args.has('--native-module'))nativeModule=await import(pathToFileURL(resolve(args.get('--native-module'))));
  const input=createInterface({input:createReadStream(resolve(args.get('--input'))),crlfDelay:Infinity});
  const candidates=[];let physicalLine=0;
  for await(const line of input){
    physicalLine++;if(!line.trim())continue;
    if(candidates.length>=20000)throw new RangeError('V8 dataset inventory exceeds 20000 input candidates');
    if(Buffer.byteLength(line,'utf8')>268435456)throw new RangeError('Input candidate exceeds the 256 MiB transport bound');
    try{candidates.push(JSON.parse(line));}
    catch(error){candidates.push({id:'input-line:'+physicalLine,status:'invalid-jsonl',phase:'inventory',
      category:'invalid-jsonl',reason:'Line '+physicalLine+': '+String(error.message)});}
  }
  const options={tokenizer,eosTokenId,maxContextTokens,maxExamplesPerEpisode,seed,
    tokenizerEvidence:tokenizerModule.tokenizerEvidence,
    allowLocal:args.has('--allow-local'),outputDirectory:resolve(args.get('--out')),
    nativePolicy:nativeModule?.nativePolicy??null,nativeConsumer:nativeModule?.nativeConsumer??null};
  for(const [key,values] of Object.entries(holdouts))if(values.length)options[key]=values;
  const result=await exportRegionDatasetJSONL(candidates,options);
  process.stdout.write(JSON.stringify({output:result.directory,inputCandidates:result.manifest.inputCandidates,
    dispositions:result.manifest.dispositions,examples:result.manifest.examples,
    registryDigest:result.manifest.registryDigest,tokenizerIdentity:result.manifest.tokenizerIdentity,
    admitted:result.manifest.admitted,optimizerSteps:0,learningClaim:null})+'\n');
}finally{
  if(typeof tokenizer?.close==='function')await tokenizer.close();
  if(typeof nativeModule?.close==='function')await nativeModule.close();
}
