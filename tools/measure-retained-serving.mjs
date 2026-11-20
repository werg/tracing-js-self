#!/usr/bin/env node
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {openQualificationProgress} from '../src/corpus/qualification-progress.mjs';
import {readRetainedServingInputs,meterRetainedServingCase,summarizeRetainedServingCosts} from '../src/semantic/retained-serving-costs.js';
import {validateAlgorithmTokenizerEvidence} from '../src/semantic/tokenizer.js';

const valued=new Set(['--baseline','--out','--population','--tokenizer-module','--max-context-tokens']),flags=new Map();
for(let index=2;index<process.argv.length;index++){
  const key=process.argv[index];
  if(flags.has(key)||!valued.has(key)&&key!=='--resume')throw new Error('Unknown or duplicate retained-cost option '+key);
  if(key==='--resume')flags.set(key,true);
  else{const value=process.argv[++index];if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);flags.set(key,value);}
}
if(!['--baseline','--out','--tokenizer-module'].every(key=>flags.has(key)))
  throw new Error('Usage: node tools/measure-retained-serving.mjs --baseline DIRECTORY --out DIRECTORY --tokenizer-module MODULE [--population all|gallery|real|interactions] [--resume]');
const root=fileURLToPath(new URL('..',import.meta.url)),output=resolve(flags.get('--out')),
  population=flags.get('--population')??'all',input=readRetainedServingInputs(flags.get('--baseline'),{population}),
  maxContextTokens=Number(flags.get('--max-context-tokens')??1048576),
  meterProducerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!Number.isSafeInteger(maxContextTokens)||maxContextTokens<2)throw new Error('Invalid flat context budget');
if(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())
  throw new Error('Retained token measurement requires a clean, committed meter implementation');
const tokenModule=await import(pathToFileURL(resolve(flags.get('--tokenizer-module'))).href);
let progress;
try{
  validateAlgorithmTokenizerEvidence(tokenModule.tokenizerEvidence,tokenModule.tokenizerPolicy);
  if(tokenModule.tokenizer?.identity!==tokenModule.tokenizerEvidence.identity.fingerprint||
    !Number.isSafeInteger(tokenModule.eosTokenId)||tokenModule.eosTokenId<0)
    throw new Error('Exact tokenizer and EOS differ from their evidence');
  progress=openQualificationProgress(output,{schema:'semantic-retained-cost-progress/1',meterProducerRevision,
    baselineSummarySha256:input.summarySha256,population,tokenizerEvidence:tokenModule.tokenizerEvidence,
    eosTokenId:tokenModule.eosTokenId,maxContextTokens},{resume:flags.has('--resume')});
  const rows=[],artifacts={};
  for(const group of input.populations)for(const source of group.rows){
    const key=group.id+'-'+source.id,task={population:group.id,id:source.id,baselineSummarySha256:input.summarySha256},
      cached=progress.cached(key,task);
    if(cached){rows.push(cached.row);Object.assign(artifacts,cached.artifacts);
      process.stderr.write(JSON.stringify({population:group.id,id:source.id,status:cached.row.status,resumed:true})+'\n');continue;}
    const row={population:group.id,id:source.id,sourceDigest:source.sourceDigest,sourceDisposition:source.disposition,
      sourceReason:source.reason??null,servingArtifact:source.servingArtifact,sourceIdentity:null,
      status:'serializer-not-retained',cost:null},names=[];
    if(source.servingArtifact){
      const retained=group.readArtifact(source.servingArtifact.name);let measured;
      try{
        measured=await meterRetainedServingCase(retained,{tokenizer:tokenModule.tokenizer,
          eosTokenId:tokenModule.eosTokenId,maxContextTokens});
        if(measured.sourceIdentity.sourceDigest!==source.sourceDigest)throw new Error('Retained source differs from its coverage identity');
        row.status='measured';row.sourceIdentity=measured.sourceIdentity;
        row.cost={status:'passed',predictions:measured.predictions,bytes:measured.bytes,tokens:measured.tokens};
      }catch(error){
        row.status=/context budget/i.test(error.message)?'resource_limited':'measurement-failed';
        measured={schema:'semantic-retained-cost-refusal/1',status:row.status,reason:error.message};
        row.cost={status:row.status,reason:error.message};
      }
      const name='tokens-'+key+'.json';artifacts[name]=progress.save(name,measured);names.push(name);row.cost.artifact=name;
    }
    progress.complete(key,task,row,names);rows.push(row);
    process.stderr.write(JSON.stringify({population:group.id,id:source.id,status:row.status})+'\n');
  }
  const interactionDeclared=input.summary.populations.find(row=>row.id==='interactions')?.coverage?.episodes?.declared??0,
    report={schema:'semantic-retained-population-token-costs/1',meterProducerRevision,
      baseline:{producerRevision:input.summary.producerRevision,summarySha256:input.summarySha256,
        manifestDigest:input.summary.manifestDigest,registryDigest:input.summary.registryDigest,
        populations:input.populations.map(group=>({id:group.id,populationDigest:group.coverage.populationDigest,
          contracts:group.coverage.contracts,archive:group.archive}))},
      tokenizerEvidence:tokenModule.tokenizerEvidence,eosTokenId:tokenModule.eosTokenId,maxContextTokens,
      serializer:'actual-semantic-causal-lm/3',measurement:'retrospective-exact-tokenization-of-retained-bytes',
      summary:summarizeRetainedServingCosts(rows),
      populations:Object.fromEntries(input.populations.map(group=>[group.id,summarizeRetainedServingCosts(rows.filter(row=>row.population===group.id))])),
      unavailableBaselines:[{population:'families',declared:input.summary.reference?.positiveExecutions??null,tokenMeasured:0,
        reason:'The frozen family reference executions did not retain source-qualified serializer costs.'},
      {population:'modules',declared:input.summary.interactionsDeclared-interactionDeclared,tokenMeasured:0,
        reason:'The historical strict-script serializer run excluded the separately declared module interactions.'}],
      scope:'The original producer, source outcomes and serializer bytes are unchanged. The current pinned codec measures those exact bytes; this is no new source, native or model qualification.',
      model:{status:'unmeasured',nextStep:null,completedExecution:null,latencyMs:null},nativeServing:{status:'unmeasured'},
      defaultPromotion:'not-qualified',artifactDigestEncoding:'sha256 of exact UTF-8 file bytes',rows,artifacts};
  progress.save('report.json',report);console.log(JSON.stringify({output,baseline:report.baseline,summary:report.summary,populations:report.populations}));
  if(rows.some(row=>row.status==='measurement-failed'))process.exitCode=1;
}finally{progress?.close();if(tokenModule.tokenizer?.close)await tokenModule.tokenizer.close();}
