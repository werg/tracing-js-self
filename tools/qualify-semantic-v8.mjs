#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {regionQualificationPopulation} from '../fixtures/semantic-regions/qualification.js';
import {loadNativeV8Settings,createNativeV8Consumer} from '../src/corpus/native-admission-v8.mjs';
import {encodeGenerationTask,runGenerationProcess} from '../src/corpus/generation-process.mjs';
import {admitRegionEvidence} from '../src/semantic/compiler-v8.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST} from '../src/semantic/native-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {openQualificationProgress,mapQualificationCases,selectQualificationCaseIds} from '../src/corpus/qualification-progress.mjs';
import {qualificationProfiles} from '../src/semantic/qualification-costs-v8.js';

const valued=new Set(['--out','--megatoken','--tokenizer','--python','--native-policy','--population','--inputs','--cases','--worker-timeout-ms','--worker-memory-mb','--native-timeout-ms','--workers']),flags=new Map();
const boolean=new Set(['--prepare-only','--resume']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];if(flags.has(key)||!valued.has(key)&&!boolean.has(key))throw new Error('Unknown or duplicate option '+key);
  if(boolean.has(key))flags.set(key,true);
  else {const value=process.argv[++i];if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);flags.set(key,value);}
}
if(!flags.has('--out'))throw new Error('Usage: node tools/qualify-semantic-v8.mjs --out DIRECTORY [--resume] [--workers 1..16] [--population interoperability|all|families|gallery|interactions|real-source] [--inputs all|first] [--cases ID,ID] [--prepare-only | --megatoken DIR --tokenizer FILE --python PYTHON --native-policy FILE]');
const root=fileURLToPath(new URL('..',import.meta.url)),output=resolve(flags.get('--out')),
  population=flags.get('--population')??'interoperability',inputs=flags.get('--inputs')??'all',
  prepareOnly=flags.get('--prepare-only')===true,workers=Number(flags.get('--workers')??1),
  bounds={timeoutMs:Number(flags.get('--worker-timeout-ms')??120000),memoryMb:Number(flags.get('--worker-memory-mb')??768)},
  nativeTimeoutMs=Number(flags.get('--native-timeout-ms')??120000);
if(!['all','first'].includes(inputs))throw new Error('Unknown qualification input selection');
if(!Number.isSafeInteger(workers)||workers<1||workers>16||!Number.isSafeInteger(bounds.timeoutMs)||bounds.timeoutMs<10||bounds.timeoutMs>3600000||
  !Number.isSafeInteger(bounds.memoryMb)||bounds.memoryMb<64||bounds.memoryMb>8192||
  !Number.isSafeInteger(nativeTimeoutMs)||nativeTimeoutMs<10||nativeTimeoutMs>3600000)throw new Error('Invalid qualification worker or resource bounds');
const selected=regionQualificationPopulation({population,allInputs:inputs==='all'});
const fixtures=[...selected.scripts,...selected.modules],
  selectedCaseIds=selectQualificationCaseIds(fixtures,flags.has('--cases')?flags.get('--cases').split(','):null),
  selectedIds=new Set(selectedCaseIds);
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())
  throw new Error('Qualification requires a committed producer');
const settings=prepareOnly?null:loadNativeV8Settings({megatoken:flags.get('--megatoken'),tokenizer:flags.get('--tokenizer'),
  python:flags.get('--python')??'python3',policyFile:flags.get('--native-policy')??join(root,'contracts/semantic-native-policy-v8.json'),
  timeoutMs:nativeTimeoutMs,temporaryDirectory:join(output,'native')});
const nativeConsumer=settings?createNativeV8Consumer(settings):null;
const taskFor=fixture=>({kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision});
const inventory={schema:'semantic-v8-qualification-population/1',producerRevision,population,inputs,
  declared:fixtures.length,selectedCaseIds,tasks:fixtures.map(fixture=>encodeGenerationTask(taskFor(fixture)))};
const populationDigest=hashAlgorithmData(inventory);
const progress=openQualificationProgress(output,{schema:'semantic-v8-qualification-progress/1',populationDigest,producerRevision,
  contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,
  prepareOnly,nativePolicy:settings?.policy??null,workers,bounds,nativeTimeoutMs,
  environment:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}},{resume:flags.has('--resume')});
const artifacts={};
const save=(name,value)=>{artifacts[name]=progress.save(name,value);};
try{
save('population.json',{...inventory,digest:populationDigest});
// This is a materialized progress view. The locked, hash-linked journal is the
// authority on resume, so a torn view cannot drop or duplicate a completed case.
atomicWrite(join(output,'attempts.jsonl'),'');
const rows=await mapQualificationCases(fixtures,workers,async fixture=>{
  const task=encodeGenerationTask(taskFor(fixture)),cached=progress.cached(fixture.id,task);
  if(cached){Object.assign(artifacts,cached.artifacts);
    appendFileSync(join(output,'attempts.jsonl'),JSON.stringify(cached.row)+'\n');
    process.stderr.write(JSON.stringify({id:fixture.id,status:cached.row.status,native:cached.row.native,resumed:true})+'\n');
    return cached.row;}
  const names=[];
  const saveCase=(name,value)=>{save(name,value);names.push(name);};
  const execution=selectedIds.has(fixture.id)?await runGenerationProcess(taskFor(fixture),
    {outputDirectory:join(output,'workers'),...bounds}):{
      result:{status:'untested',reason:'Not selected by --cases; retained in the declared population',
        sourceProfile:fixture.sourceProfile??'training-js/1'},durationMs:0,peakRssBytes:null};
  const result=execution.result,row={id:fixture.id,family:fixture.family??fixture.id,status:result.status,
    reason:result.reason??null,...qualificationProfiles(result),
    source:result.exported?'passed':result.status,native:'untested',durationMs:execution.durationMs,peakRssBytes:execution.peakRssBytes};
  if(result.exported){
    saveCase(fixture.id+'.source.json',result.exported);row.sourceArtifact=fixture.id+'.source.json';
    row.regionCoverage=result.exported.sidecar.regionCoverage;
    if(nativeConsumer){try{
      const admission=await admitRegionEvidence(result.exported,{nativePolicy:settings.policy,nativeConsumer});
      saveCase(fixture.id+'.admitted.json',admission.exported);saveCase(fixture.id+'.native.json',admission.native);
      row.native='passed';row.status='admitted';row.nativeReceipt=admission.native;
    }catch(error){row.native=error.disposition??(/timeout|limit|deadline/i.test(error.message)?'resource_limited':'failed');
      row.nativeReason=error.message;row.status='native-'+row.native;}}
  }else{saveCase(fixture.id+'.result.json',result);row.sourceResult=fixture.id+'.result.json';}
  progress.complete(fixture.id,task,row,names);
  appendFileSync(join(output,'attempts.jsonl'),JSON.stringify(row)+'\n');
  process.stderr.write(JSON.stringify({id:row.id,status:row.status,native:row.native})+'\n');
  return row;
});
const report={schema:'semantic-v8-qualification/1',producerRevision,population,inputs,populationDigest,declared:fixtures.length,selectedCaseIds,
  contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,nativePolicy:settings?.policy??null,
  progressDigest:progress.digest,workers,workerBounds:bounds,nativeTimeoutMs,artifactDigestEncoding:'sha256 of exact UTF-8 file bytes',
  preparationOnly:prepareOnly,rows,artifacts,sourceQualified:rows.filter(row=>row.source==='passed').length,
  nativeAdmitted:rows.filter(row=>row.native==='passed').length,model:'untested',optimizerSteps:0,
  defaultPromotion:'not-qualified',scope:'Source and native engineering qualification; no model-learning or native-serving success claim'};
save('report.json',report);console.log(JSON.stringify({output,producerRevision,sourceQualified:report.sourceQualified,
  nativeAdmitted:report.nativeAdmitted,declared:report.declared}));
if(!prepareOnly&&rows.some(row=>row.native!=='passed'))process.exitCode=1;
}finally{progress.close();}
