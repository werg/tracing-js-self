#!/usr/bin/env node
// Freeze before inference. Only the live public prefix reaches a selector;
// source artifacts are rechecked privately after each bounded rollout.
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareRegionExecutionCase,freezeRegionExecutionStudy,validateRegionExecutionStudy,
  runFrozenRegionExecutionStudy} from '../src/semantic/execution-study-v8.js';
import {createNativeV8PythonSelector} from '../src/semantic/native-process-v8.js';

const usage=`Usage:
  node tools/run-semantic-v8-experiment.mjs freeze --input CASES.json --out NEW_DIRECTORY
    --model-id ID --model-revision REVISION --settings SETTINGS.json
    --checkpoint HASH --tokenizer HASH [--origin model|engineering] [--seed NUMBER ...]
    [--training-identity HASH]
    [--max-predictions N] [--max-generated N] [--max-outstanding N]
    [--max-stale-retries N] [--timeout-ms N]
  node tools/run-semantic-v8-experiment.mjs run --study STUDY.json --cases CASES.json
    --out NEW_DIRECTORY (--selector-module MODULE.mjs | --megatoken REPOSITORY --served BUNDLE)
    [--python EXECUTABLE] [--case ID ...]

Input cases have {id, artifact} or {id, artifactPath}; artifact paths resolve from
the input file. Each artifact must contain source-qualified v8 public, contexts,
and sidecar evidence. An explicit fixture override may supply the environment.
Freeze writes study.json plus private-cases.json. Keep private-cases.json away
from model prompts. Native settings are exactly {device,maxTokens,maxFragments,effort};
effort is explicitly bounded from 1 through 6. The runtime must attest frozen settings.
A selector module exports createSelector(configuration), which receives only
model/settings/identities/limits, never cases, expected records or future replies.
Engineering fixture injections must declare --origin engineering. Reports never
count untested cases as successes or infer source success from a final value.
Ordinary V8 bundles require --training-identity equal to the exported serving
lineage digest. Null remains available only for bundles without ordinary V8 lineage.
`;
const [command,...argv]=process.argv.slice(2);
if(command==='--help'||command==='help'||!command){process.stdout.write(usage);process.exit(command?0:1);}
const allowed=command==='freeze'?new Set(['--input','--out','--model-id','--model-revision','--settings',
  '--checkpoint','--tokenizer','--training-identity','--origin','--seed','--max-predictions','--max-generated','--max-outstanding',
  '--max-stale-retries','--timeout-ms']):command==='run'?new Set(['--study','--cases','--out',
  '--selector-module','--megatoken','--served','--python','--case']):null;
if(!allowed)throw new Error(usage);
const options=new Map(),multiple=new Set(['--seed','--case']);
for(let index=0;index<argv.length;index+=2){const key=argv[index],value=argv[index+1];
  if(!allowed.has(key)||!value||value.startsWith('--')||options.has(key)&&!multiple.has(key))
    throw new Error('Unknown, repeated or missing experiment option '+key);
  if(multiple.has(key))options.set(key,[...(options.get(key)??[]),value]);else options.set(key,value);
}
const required=key=>{const value=options.get(key);if(!value)throw new Error('Required '+key);return value;};
const read=filename=>JSON.parse(readFileSync(resolve(filename),'utf8'));
const numeric=(key,fallback)=>options.has(key)?Number(options.get(key)):fallback;
const output=resolve(required('--out'));
const writeNew=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});

if(command==='freeze'){
  const filename=resolve(required('--input')),input=read(filename),inventory=Array.isArray(input)?input:input.cases??input.examples;
  if(!Array.isArray(inventory))throw new Error('Input must contain the complete case inventory');
  const cases=inventory.map(row=>prepareRegionExecutionCase({id:row.id,
    artifact:row.artifactPath?read(resolve(dirname(filename),row.artifactPath)):row.artifact??row.exported??row,
    fixture:row.fixture??null}));
  const study=freezeRegionExecutionStudy(cases,{model:{id:required('--model-id'),revision:required('--model-revision')},
    settings:read(required('--settings')),checkpointIdentity:required('--checkpoint'),tokenizerIdentity:required('--tokenizer'),
    trainingIdentity:options.get('--training-identity')??null,
    origin:options.get('--origin')??'model',seeds:(options.get('--seed')??['17']).map(Number),
    maxPredictions:numeric('--max-predictions',4096),maxGenerated:numeric('--max-generated',16384),
    maxOutstanding:numeric('--max-outstanding',64),maxStaleRetries:numeric('--max-stale-retries',8),
    timeoutMs:numeric('--timeout-ms',15000)});
  mkdirSync(output,{recursive:false});writeNew('study.json',study);writeNew('private-cases.json',cases);
  process.stdout.write(JSON.stringify({output,studyDigest:study.digest,declared:study.declared,status:study.status})+'\n');
}else{
  const study=read(required('--study')),input=read(required('--cases')),cases=Array.isArray(input)?input:input.cases;
  validateRegionExecutionStudy(study);
  const modulePath=options.get('--selector-module'),repository=options.get('--megatoken'),bundle=options.get('--served');
  if(Boolean(modulePath)===Boolean(repository)||repository&&!bundle||modulePath&&(bundle||options.has('--python')))
    throw new Error('Choose exactly one selector module or native repository with a served bundle');
  // Publish the unchanged denominator before any process startup or model call.
  let report=await runFrozenRegionExecutionStudy(study,{cases,select:()=>{},caseIds:[]}),select=null;
  mkdirSync(output,{recursive:false});writeNew('study.json',study);writeNew('report.json',report);
  const save=value=>{report=value;const temporary=join(output,'report.next.json');
    writeFileSync(temporary,JSON.stringify(value,null,2)+'\n');renameSync(temporary,join(output,'report.json'));};
  try{
    if(modulePath){
      const loaded=await import(pathToFileURL(resolve(modulePath)));
      if(typeof loaded.createSelector!=='function')throw new Error('Selector module must export createSelector(configuration)');
      select=await loaded.createSelector(structuredClone({model:study.model,settings:study.settings,
        checkpointIdentity:study.checkpointIdentity,tokenizerIdentity:study.tokenizerIdentity,
        trainingIdentity:study.trainingIdentity??null,
        origin:study.origin,limits:study.limits}));
    }else{
      const settings=study.settings;
      if(Object.keys(settings).sort().join(',')!=='device,effort,maxFragments,maxTokens'||
        typeof settings.device!=='string'||!settings.device||!Number.isSafeInteger(settings.effort)||
        settings.effort<1||settings.effort>6)
        throw new Error('Native settings must explicitly freeze device, maxTokens, maxFragments and effort 1..6');
      select=createNativeV8PythonSelector({python:options.get('--python')??'python3',
        megatokenRepository:resolve(repository),servedBundle:resolve(bundle),...settings,
        timeoutMs:study.limits.timeoutMs});
    }
    if(typeof select!=='function')throw new Error('Selector factory did not return a callable selector');
    report=await runFrozenRegionExecutionStudy(study,{cases,select,caseIds:options.get('--case')??null,onResult:save});
  }catch(error){report={...report,executionFailure:{category:error.category??error.name,message:String(error.message)}};
    process.exitCode=1;
  }finally{
    if(select){try{
      const cleanup=typeof select.shutdown==='function'?await select.shutdown():await select.close?.();
      report={...report,cleanup:{status:'completed',receipt:cleanup??null}};
    }catch(error){report={...report,cleanup:{status:'failed',message:String(error.message)}};process.exitCode=1;select.close?.();}}
    save(report);
  }
  process.stdout.write(JSON.stringify({output,studyDigest:study.digest,declared:report.declared,
    summary:report.summary,qualification:report.qualification})+'\n');
}
