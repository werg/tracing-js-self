#!/usr/bin/env node
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {regionQualificationPopulation} from '../fixtures/semantic-regions/qualification.js';
import {loadNativeV8Settings,createNativeV8Consumer} from '../src/corpus/native-admission-v8.mjs';
import {encodeGenerationTask,runGenerationProcess} from '../src/corpus/generation-process.mjs';
import {admitRegionEvidence} from '../src/semantic/compiler-v8.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST} from '../src/semantic/native-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const valued=new Set(['--out','--megatoken','--tokenizer','--python','--native-policy','--population','--inputs','--cases','--worker-timeout-ms','--worker-memory-mb']),flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];if(flags.has(key)||!valued.has(key)&&key!=='--prepare-only')throw new Error('Unknown or duplicate option '+key);
  if(key==='--prepare-only')flags.set(key,true);
  else {const value=process.argv[++i];if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);flags.set(key,value);}
}
if(!flags.has('--out'))throw new Error('Usage: node tools/qualify-semantic-v8.mjs --out NEW_DIRECTORY [--population interoperability|all|families|gallery|interactions|real-source] [--inputs all|first] [--prepare-only | --megatoken DIR --tokenizer FILE --python PYTHON --native-policy FILE]');
const root=fileURLToPath(new URL('..',import.meta.url)),output=resolve(flags.get('--out')),
  population=flags.get('--population')??'interoperability',inputs=flags.get('--inputs')??'all',
  prepareOnly=flags.get('--prepare-only')===true;
if(!['all','first'].includes(inputs))throw new Error('Unknown qualification input selection');
const selected=regionQualificationPopulation({population,allInputs:inputs==='all'});
let fixtures=[...selected.scripts,...selected.modules];
if(new Set(fixtures.map(row=>row.id)).size!==fixtures.length)throw new Error('Duplicate qualification case identity');
if(flags.has('--cases')){const ids=flags.get('--cases').split(',');
  if(new Set(ids).size!==ids.length||ids.some(id=>!fixtures.some(row=>row.id===id)))throw new Error('Unknown or duplicate qualification case');
  fixtures=fixtures.filter(row=>ids.includes(row.id));}
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())
  throw new Error('Qualification requires a committed producer');
const settings=prepareOnly?null:loadNativeV8Settings({megatoken:flags.get('--megatoken'),tokenizer:flags.get('--tokenizer'),
  python:flags.get('--python')??'python3',policyFile:flags.get('--native-policy')??join(root,'contracts/semantic-native-policy-v8.json'),
  temporaryDirectory:join(output,'native')});
const nativeConsumer=settings?createNativeV8Consumer(settings):null;
mkdirSync(output,{recursive:false});const rows=[],artifacts={};
const save=(name,value)=>{writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});artifacts[name]=hashAlgorithmData(value);};
const taskFor=fixture=>({kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision});
const inventory={schema:'semantic-v8-qualification-population/1',producerRevision,population,inputs,
  declared:fixtures.length,tasks:fixtures.map(fixture=>encodeGenerationTask(taskFor(fixture)))};
const populationDigest=hashAlgorithmData(inventory);
save('population.json',{...inventory,digest:populationDigest});
for(const fixture of fixtures){
  const execution=await runGenerationProcess(taskFor(fixture),
    {outputDirectory:join(output,'workers'),timeoutMs:Number(flags.get('--worker-timeout-ms')??120000),
      memoryMb:Number(flags.get('--worker-memory-mb')??768)});
  const result=execution.result,row={id:fixture.id,family:fixture.family??fixture.id,status:result.status,
    reason:result.reason??null,sourceProfile:result.sourceProfile??'training-js/1',
    source:result.exported?'passed':result.status,native:'untested',durationMs:execution.durationMs,peakRssBytes:execution.peakRssBytes};
  if(result.exported){
    save(fixture.id+'.source.json',result.exported);row.sourceArtifact=fixture.id+'.source.json';
    row.regionCoverage=result.exported.sidecar.regionCoverage;
    if(nativeConsumer){try{
      const admission=await admitRegionEvidence(result.exported,{nativePolicy:settings.policy,nativeConsumer});
      save(fixture.id+'.admitted.json',admission.exported);save(fixture.id+'.native.json',admission.native);
      row.native='passed';row.status='admitted';row.nativeReceipt=admission.native;
    }catch(error){row.native=error.disposition??(/timeout|limit/i.test(error.message)?'resource_limited':'failed');
      row.nativeReason=error.message;row.status='native-'+row.native;}}
  }else{save(fixture.id+'.result.json',result);row.sourceResult=fixture.id+'.result.json';}
  rows.push(row);appendFileSync(join(output,'attempts.jsonl'),JSON.stringify(row)+'\n');
  process.stderr.write(JSON.stringify({id:row.id,status:row.status,native:row.native})+'\n');
}
const report={schema:'semantic-v8-qualification/1',producerRevision,population,inputs,populationDigest,declared:fixtures.length,
  contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,nativePolicy:settings?.policy??null,
  preparationOnly:prepareOnly,rows,artifacts,sourceQualified:rows.filter(row=>row.source==='passed').length,
  nativeAdmitted:rows.filter(row=>row.native==='passed').length,model:'untested',optimizerSteps:0,
  defaultPromotion:'not-qualified',scope:'Source and native engineering qualification; no model-learning or native-serving success claim'};
save('report.json',report);console.log(JSON.stringify({output,producerRevision,sourceQualified:report.sourceQualified,
  nativeAdmitted:report.nativeAdmitted,declared:report.declared}));
if(!prepareOnly&&rows.some(row=>row.native!=='passed'))process.exitCode=1;
