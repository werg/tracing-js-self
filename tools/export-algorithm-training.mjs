#!/usr/bin/env node
// Export new semantic-trace/7 training examples from a JSONL stream of
// independently verified candidate packets. All refusals remain reviewable.
import {createReadStream,createWriteStream,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {semanticFamilyMembership,bindSemanticFamilySplit} from '../src/semantic/dataset-v7.js';
import {buildSemanticFamilyRegistry,semanticSplitIdentity} from '../src/semantic/family-registry.js';
import {buildCausalLmV7Examples,CAUSAL_LM_V7_BRIDGE_VERSION} from '../src/semantic/causal-lm-v7.js';
import {DETAILED_TRACE_VERSION} from '../src/semantic/detailed-v7.js';

const args=new Map(),holdoutFamilies=[],holdoutSources=[],holdoutCores=[];
const valued=new Set(['--input','--tokenizer-module','--max-context','--seed','--out']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(key==='--allow-local'){if(args.has(key))throw new TypeError('Repeated --allow-local');args.set(key,true);continue;}
  const repeated=key==='--holdout-family'||key==='--holdout-source'||key==='--holdout-core';
  if(!valued.has(key)&&!repeated)throw new TypeError('Unknown option '+key);
  const value=process.argv[++i];if(!value)throw new TypeError('Missing value for '+key);
  if(repeated){({ '--holdout-family':holdoutFamilies,'--holdout-source':holdoutSources,
    '--holdout-core':holdoutCores}[key]).push(value);continue;}
  if(args.has(key))throw new TypeError('Repeated option '+key);args.set(key,value);
}
for(const key of ['--input','--tokenizer-module','--max-context','--seed','--out'])
  if(!args.has(key))throw new TypeError('Usage: export-algorithm-training.mjs --input candidates.jsonl --tokenizer-module FILE --max-context N --seed N --out NEW_DIRECTORY [--allow-local] [--holdout-family NAME]');
const maxContextTokens=Number(args.get('--max-context')),seed=Number(args.get('--seed'));
if(!Number.isSafeInteger(maxContextTokens)||maxContextTokens<2||!Number.isSafeInteger(seed))
  throw new TypeError('Context budget must be positive and split seed must be a safe integer');
const inputPath=resolve(args.get('--input')),tokenizerPath=resolve(args.get('--tokenizer-module')),
  outputPath=resolve(args.get('--out'));
const {tokenizer,eosTokenId}=await import(pathToFileURL(tokenizerPath));
if(!tokenizer||typeof tokenizer.identity!=='string'||!/^[0-9a-f]{64}$/.test(tokenizer.identity)||
  typeof tokenizer.encode!=='function'||typeof tokenizer.decode!=='function'||
  !Number.isSafeInteger(eosTokenId)||eosTokenId<0)
  throw new TypeError('A real pinned lossless tokenizer and EOS token are required');

async function* candidateLines(){
  const input=createInterface({input:createReadStream(inputPath),crlfDelay:Infinity});let index=0;
  for await(const line of input){
    if(!line.trim())continue;
    let candidate;try{candidate=JSON.parse(line);}catch(error){
      yield {index:index++,candidate:null,parseError:error.message};continue;
    }
    yield {index:index++,candidate};
  }
}
const memberRows=[],unregistered=[];let candidateCount=0;
for await(const item of candidateLines()){
  candidateCount++;
  if(item.parseError){unregistered.push({index:item.index,reason:'invalid-jsonl',detail:item.parseError});continue;}
  const member=semanticFamilyMembership(item.candidate,item.index);
  if(!member.source||!member.entry||!member.family){unregistered.push({index:item.index,id:member.id,
    family:member.family,status:member.status,reason:member.reason??'source membership is incomplete'});continue;}
  const {id,family,source,entry,coreDigest,qualified,status,reason}=member;
  memberRows.push({index:item.index,id,family,source,entry,coreDigest,qualified,status,reason});
}
if(candidateCount===0)throw new TypeError('Input candidate stream is empty');
if(memberRows.length===0)throw new TypeError('No exact source memberships were available for the v7 family registry');
const registry=buildSemanticFamilyRegistry(memberRows,{seed,families:holdoutFamilies,
  sourceDigests:holdoutSources,coreDigests:holdoutCores});
const identityById=new Map(memberRows.map(row=>[row.id,semanticSplitIdentity(registry,row)]));

mkdirSync(outputPath,{recursive:false});
const streamNames=['train','validation','test','refusals','failures'];
const streams=Object.fromEntries(streamNames.map(name=>[name,{
  stream:createWriteStream(resolve(outputPath,name==='refusals'||name==='failures'?name+'.jsonl':name+'.jsonl'),{flags:'wx'}),
  hash:createHash('sha256'),bytes:0,rows:0,tokens:0,episodes:new Set()}]));
async function writeRow(name,row){
  const text=JSON.stringify(row)+'\n',bytes=Buffer.from(text,'utf8'),entry=streams[name];
  entry.hash.update(bytes);entry.bytes+=bytes.length;entry.rows++;
  if(!entry.stream.write(bytes))await once(entry.stream,'drain');
}
for(const row of unregistered)await writeRow('failures',row);

for await(const item of candidateLines()){
  if(item.parseError){await writeRow('failures',{index:item.index,status:'invalid-jsonl',reason:item.parseError});continue;}
  const candidate=item.candidate,member=semanticFamilyMembership(candidate,item.index);
  if(!member.source||!member.entry||!member.family){await writeRow('failures',{index:item.index,id:member.id,
    family:member.family,status:member.status,reason:member.reason??'source membership is incomplete'});continue;}
  const identity=identityById.get(member.id);
  if(!identity){await writeRow('failures',{index:item.index,id:member.id,status:'registry-member-mismatch',
    reason:'Candidate membership changed between inventory and export passes'});continue;}
  if(!member.qualified){await writeRow('failures',{index:item.index,id:member.id,family:member.family,
    split:identity.split,status:member.status,reason:member.reason??'candidate is not source-qualified'});continue;}
  try{
    const exported=bindSemanticFamilySplit(candidate,member,registry);
    const examples=await buildCausalLmV7Examples(exported,{tokenizer,eosTokenId,maxContextTokens,
      allowLocal:args.has('--allow-local'),expectedSplit:identity.split});
    const destination=streams[identity.split];destination.episodes.add(member.id);
    for(const row of examples){destination.tokens+=row.boundaries.targetTokens+1;await writeRow(identity.split,row);}
  }catch(error){await writeRow('refusals',{index:item.index,id:member.id,family:member.family,
    split:identity.split,category:error.category??'v7-export-refusal',reason:error.message});}
}
for(const entry of Object.values(streams))entry.stream.end();
await Promise.all(Object.values(streams).map(({stream})=>once(stream,'finish')));

const local=args.has('--allow-local'),totalExamples=streamNames.slice(0,3)
  .reduce((sum,name)=>sum+streams[name].rows,0);
const admitted=!local&&totalExamples>0&&streams.train.rows+streams.validation.rows+streams.test.rows===totalExamples;
const fileManifest=Object.fromEntries(streamNames.map(name=>[name,{file:name+'.jsonl',rows:streams[name].rows,
  bytes:streams[name].bytes,sha256:streams[name].hash.digest('hex'),
  ...(name==='train'||name==='validation'||name==='test'?{episodes:streams[name].episodes.size,
    generatedTokens:streams[name].tokens}:{})}]));
const registryBytes=JSON.stringify(registry,null,2)+'\n';
writeFileSync(resolve(outputPath,'family-registry.json'),registryBytes,{flag:'wx'});
const manifest={schema:'semantic-training-dataset/7',traceFormat:DETAILED_TRACE_VERSION,
  adapter:CAUSAL_LM_V7_BRIDGE_VERSION,inputCandidates:candidateCount,
  registeredSourceMembers:memberRows.length,registry:{file:'family-registry.json',digest:registry.digest,
    sha256:createHash('sha256').update(registryBytes).digest('hex'),components:registry.components.length,
    holdouts:registry.holdouts},tokenizerModuleSha256:createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex'),
  tokenizerIdentity:tokenizer.identity,eosTokenId,maxContextTokens,seed,allowLocal:local,admitted,
  optimizerSteps:0,learnedSuccess:null,unregisteredFailures:unregistered,
  files:fileManifest,scope:local?'candidate-local-diagnostic':'native-admitted-v7-training'};
writeFileSync(resolve(outputPath,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({output:outputPath,candidates:candidateCount,
  registered:memberRows.length,trainExamples:streams.train.rows,validationExamples:streams.validation.rows,
  testExamples:streams.test.rows,refusals:streams.refusals.rows,failures:streams.failures.rows,
  tokenizerIdentity:tokenizer.identity,admitted,optimizerSteps:0})+'\n');
