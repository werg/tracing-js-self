#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {openQualificationProgress} from '../src/corpus/qualification-progress.mjs';
import {readQualificationCostInputs,summarizeQualificationCosts} from '../src/semantic/qualification-costs-v8.js';
import {auditRegionServingCosts} from '../src/semantic/causal-lm-v8.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST,validateV8NativeReceipt} from '../src/semantic/native-v8.js';

const valued=new Set(['--qualification','--out','--tokenizer-module','--max-context-tokens']),flags=new Map();
for(let index=2;index<process.argv.length;index++){
  const key=process.argv[index];
  if(flags.has(key)||!valued.has(key)&&key!=='--resume')throw new Error('Unknown or duplicate cost option '+key);
  if(key==='--resume')flags.set(key,true);
  else{const value=process.argv[++index];if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);flags.set(key,value);}
}
if(!flags.has('--qualification')||!flags.has('--out'))throw new Error('Usage: node tools/measure-semantic-v8.mjs --qualification DIRECTORY --out DIRECTORY [--tokenizer-module MODULE] [--max-context-tokens COUNT] [--resume]');
const root=fileURLToPath(new URL('..',import.meta.url)),input=readQualificationCostInputs(flags.get('--qualification')),
  {report:qualification}=input,output=resolve(flags.get('--out')),
  maxContextTokens=Number(flags.get('--max-context-tokens')??1048576),
  producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!Number.isSafeInteger(maxContextTokens)||maxContextTokens<2)throw new Error('Invalid flat context budget');
if(qualification.producerRevision!==producerRevision||
  execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())
  throw new Error('Cost measurement requires the same clean, committed producer as source qualification');
for(const [key,value] of Object.entries({contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST}))
  if(qualification[key]!==value)throw new Error('Qualification differs from current '+key);
const tokenModule=flags.has('--tokenizer-module')?await import(pathToFileURL(resolve(flags.get('--tokenizer-module'))).href):null;
let progress;
try{
  if(tokenModule&&(!tokenModule.tokenizer||!Number.isSafeInteger(tokenModule.eosTokenId)))
    throw new Error('The exact tokenizer module must provide tokenizer and eosTokenId');
  progress=openQualificationProgress(output,{schema:'semantic-v8-cost-progress/1',producerRevision,
    qualificationReportSha256:input.reportSha256,populationDigest:qualification.populationDigest,
    tokenizerEvidence:tokenModule?.tokenizerEvidence??null,tokenizerIdentity:tokenModule?.tokenizer?.identity??null,
    eosTokenId:tokenModule?.eosTokenId??null,maxContextTokens},{resume:flags.has('--resume')});
  const artifacts={},rows=[];
  for(const source of qualification.rows){
    const task={id:source.id,qualificationReportSha256:input.reportSha256},cached=progress.cached(source.id,task);
    if(cached){rows.push(cached.row);Object.assign(artifacts,cached.artifacts);
      process.stderr.write(JSON.stringify({id:source.id,status:cached.row.status,resumed:true})+'\n');continue;}
    const row={id:source.id,source:source.source,sourceReason:source.reason,native:source.native,
      sourceProfile:source.sourceProfile,executionProfile:source.executionProfile??null,
      protocolExtensions:structuredClone(source.protocolExtensions??[]),regionCoverage:source.regionCoverage??null,
      status:'source-unqualified',cost:null,nativePacking:null,durationMs:0,peakRssBytes:null};
    const started=performance.now(),names=[];
    if(source.source==='passed'){
      const exported=input.readArtifact(source.sourceArtifact);
      if(source.native==='passed'){
        const receipt=input.readArtifact(source.id+'.native.json');
        validateV8NativeReceipt(exported,receipt,qualification.nativePolicy);
        if(!Number.isSafeInteger(receipt.framing?.physicalRecords)||receipt.framing.physicalRecords<1||
          !Number.isSafeInteger(receipt.framing.terminalTokens)||receipt.framing.terminalTokens<0)
          throw new Error('Missing exact native physical record counts for '+source.id);
        row.nativePacking={status:'passed',generatedTokens:receipt.counts.generatedTokens,
          observedTokens:receipt.counts.observedTokens,terminalTokens:receipt.framing.terminalTokens,
          physicalRecords:receipt.framing.physicalRecords,logicalRecords:receipt.counts.records,
          nativeTrainingDigest:receipt.nativeTrainingDigest};
      }
      let costs;
      try{
        costs=await auditRegionServingCosts(exported,{tokenizer:tokenModule?.tokenizer??null,
          eosTokenId:tokenModule?.eosTokenId??null,maxContextTokens});
        row.status='measured';row.cost={status:'passed',predictions:costs.predictions,
          bytes:costs.bytes,tokens:costs.tokens,measurement:costs.measurement,
          detailedTokens:tokenModule?costs.rows.filter(item=>item.detail).reduce((n,item)=>n+item.generatedTokens,0):null};
      }catch(error){
        const limited=/context budget|example cap|record byte bound/i.test(error.message);
        row.status=limited?'resource_limited':'measurement-failed';
        costs={schema:'semantic-serving-cost-refusal/1',status:row.status,reason:error.message};
        row.cost={status:row.status,reason:error.message};if(!limited)process.exitCode=1;
      }
      const name='serving-'+source.id+'.json';artifacts[name]=progress.save(name,costs);names.push(name);row.cost.artifact=name;
    }else if(source.sourceResult)input.readArtifact(source.sourceResult);
    row.durationMs=performance.now()-started;
    progress.complete(source.id,task,row,names);rows.push(row);
    process.stderr.write(JSON.stringify({id:source.id,status:row.status})+'\n');
  }
  const report={schema:'semantic-v8-population-costs/1',producerRevision,population:qualification.population,inputs:qualification.inputs,
    qualification:{reportSha256:input.reportSha256,populationDigest:qualification.populationDigest,
      contractDigest:qualification.contractDigest,fixtureDigest:qualification.fixtureDigest,
      interoperabilityDigest:qualification.interoperabilityDigest,nativePolicy:qualification.nativePolicy},
    progressDigest:progress.digest,tokenizerEvidence:tokenModule?.tokenizerEvidence??null,
    serializer:'semantic-causal-lm/4',maxContextTokens,artifactDigestEncoding:'sha256 of exact UTF-8 file bytes',
    summary:summarizeQualificationCosts(rows,{tokenizer:Boolean(tokenModule)}),rows,artifacts};
  progress.save('report.json',report);
  console.log(JSON.stringify({output,producerRevision,summary:report.summary}));
  if(rows.some(row=>row.cost?.status==='measurement-failed'))process.exitCode=1;
}finally{
  progress?.close();const meter=tokenModule?.tokenizer;if(meter?.close)await meter.close();
}
