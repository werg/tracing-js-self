#!/usr/bin/env node
// A new output directory preserves prior population/result identities.
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {expansionManifest,expansionFamilyRegistry,validateExpansionReferencePopulation,
  expansionSourceCases,expansionRealSourceSlice} from '../src/semantic/expansion-benchmark.js';
import {LANGUAGE_EXPANSION_BENCHMARK} from '../fixtures/language-expansion/benchmark.js';
import {LANGUAGE_EXPANSION_COMPREHENSION_TASKSET as taskset} from '../fixtures/language-expansion/comprehension.js';
import {comprehensionTasksetDigest,scoreComprehensionResponses} from '../src/semantic/comprehension.js';
import {buildCapabilityLedger} from '../src/training/capability-ledger.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {auditRegionServingCosts} from '../src/semantic/causal-lm-v8.js';
import {SEMANTIC_V8_DEFINITION} from '../src/semantic/contract-v8.js';
import {renderAlgorithmV8} from '../src/semantic/render-v8.js';
import {auditFlatServingCosts} from '../src/semantic/serving-costs.js';
import {notationViews} from '../src/semantic/notation-experiment.js';
import {runGenerationProcess} from '../src/corpus/generation-process.mjs';
const allowed=new Set(['--out','--mode','--inputs','--population','--trace-version','--tokenizer-module','--max-context-tokens','--worker-timeout-ms','--worker-memory-mb']),flags=new Map();
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  if(!allowed.has(key)||flags.has(key)||!value||value.startsWith('--'))throw new Error('Unknown, repeated or missing benchmark option '+key);
  flags.set(key,value);
}
if(!flags.has('--out'))throw new Error('Usage: node tools/language-expansion-benchmark.mjs --out NEW_DIRECTORY [--mode reference|coverage] [--inputs all|first] [--population all|families|interactions|real-source|gallery]');
const mode=flags.get('--mode')??'reference',inputs=flags.get('--inputs')??'all',population=flags.get('--population')??'all';
const traceVersion=Number(flags.get('--trace-version')??7),maxContextTokens=Number(flags.get('--max-context-tokens')??1048576);
const workerTimeoutMs=Number(flags.get('--worker-timeout-ms')??120000),workerMemoryMb=Number(flags.get('--worker-memory-mb')??768);
if(!['reference','coverage'].includes(mode)||!['all','first'].includes(inputs)||
  !['all','families','interactions','real-source','gallery'].includes(population)||![7,8].includes(traceVersion)||
  !Number.isSafeInteger(maxContextTokens)||maxContextTokens<2)throw new Error('Invalid benchmark mode, inputs, population, version or context budget');
const output=resolve(flags.get('--out')),root=fileURLToPath(new URL('..',import.meta.url));
mkdirSync(dirname(output),{recursive:true});mkdirSync(output,{recursive:false});
const write=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceChanges=execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();
if(sourceChanges)throw new Error('Retained benchmark evidence requires a committed producer; commit source changes first');
const tokenModule=flags.has('--tokenizer-module')?await import(pathToFileURL(resolve(flags.get('--tokenizer-module'))).href):null;
if(tokenModule&&(traceVersion!==8||!tokenModule.tokenizer||!Number.isSafeInteger(tokenModule.eosTokenId)))
  throw new Error('This runner requires an exact v8 tokenizer module with tokenizer and eosTokenId exports');
const manifest=expansionManifest(),registry=expansionFamilyRegistry();
try {
write('manifest.json',manifest);write('family-registry.json',registry);
write('comprehension-lock.json',{schema:'semantic-comprehension-lock/1',id:taskset.id,version:taskset.version,
  digest:comprehensionTasksetDigest(taskset),tasks:taskset.tasks.length,
  families:new Set(taskset.tasks.map(row=>row.family)).size,measurement:'unmeasured',
  responseCount:0,model:null,reason:'No external evaluator responses have been collected; reference answer keys are not model responses'});
const reference=validateExpansionReferencePopulation({traceVersion});write('reference-report.json',{producerRevision,...reference});
let coverage=null,moduleResults=[];
if(mode==='coverage'){
  let cases=population==='gallery'?SEMANTIC_GALLERY_FIXTURES:population==='real-source'?expansionRealSourceSlice().cases:
    expansionSourceCases({allInputs:inputs==='all',includeInteractions:population==='all'||population==='interactions',
      includeRealSource:population==='all'});
  if(population==='interactions')cases=cases.filter(row=>row.family.startsWith('interaction:'));
  const costs=[],notation=[],verifier=async fixture=>{
    const execution=await runGenerationProcess({kind:fixture.modules?'module':'source',fixture,traceVersion,producerRevision},
      {outputDirectory:join(output,'workers'),timeoutMs:workerTimeoutMs,memoryMb:workerMemoryMb});
    const result=execution.result;
    appendFileSync(join(output,'attempts.jsonl'),JSON.stringify({id:fixture.id,status:result.status,phase:result.phase??null,
      reason:result.reason??null,durationMs:execution.durationMs,peakRssBytes:execution.peakRssBytes,
      identityDigest:result.exported?.sidecar?.sourceArtifactDigest??result.exported?.sidecar?.identityDigest??null})+'\n');
    if(result.exported){
      let cost;
      try {cost=traceVersion===8?await auditRegionServingCosts(result.exported,{tokenizer:tokenModule?.tokenizer??null,
        eosTokenId:tokenModule?.eosTokenId??null,maxContextTokens}):await auditFlatServingCosts(result.exported);}
      catch(error){
        // A measurement limit cannot erase an independently qualified source.
        const limited=/context budget|example cap|record byte bound/i.test(error.message);
        cost={schema:'semantic-serving-cost-refusal/1',representation:result.exported.public.representation,
          status:limited?'resource_limited':'failed',reason:error.message,predictions:result.exported.contexts.length,
          bytes:null,tokens:null,measurement:{bytes:'untested',tokens:limited?'resource_limited':'failed'}};
        if(!limited)process.exitCode=1;
      }
      // Preserve exact serializer bytes separately, avoiding giant duplicate
      // prompt/definition fields inside the small aggregate coverage report.
      write('serving-'+fixture.id+'.json',cost);
      costs.push({id:fixture.id,sourceProfile:fixture.sourceProfile??'training-js/1',
        representation:cost.representation,status:cost.status??'passed',reason:cost.reason??null,predictions:cost.predictions,
        bytes:cost.bytes,tokens:cost.tokens,measurement:cost.measurement});
      if(result.exported.public.representation==='algorithm'){
        const records=result.exported.public.timeline.filter(row=>row.mode==='generated'||row.kind==='observation')
          .filter(row=>typeof row.line==='string').map(row=>row.line);
        notation.push({id:fixture.id,...notationViews(records)});
      }else if(traceVersion===8){
        const core=result.exported.public.timeline.find(row=>row.kind==='program')?.fields.regionProgram.algorithm;
        if(core)notation.push({id:fixture.id,core,arms:Object.fromEntries(['canonical','formal','hybrid','prose']
          .map(style=>[style,renderAlgorithmV8(core,{style})]))});
      }
    }
    process.stderr.write(JSON.stringify({id:fixture.id,status:result.status})+'\n');return result;
  };
  coverage=await buildCapabilityLedger({producerRevision,cases,verifyCase:verifier,traceVersion,
    contracts:traceVersion===8?Object.fromEntries(['execution','trace','context','continuation'].map(key=>[key,SEMANTIC_V8_DEFINITION[key]])):null,
    population:'expansion-v1:'+population+':inputs-'+inputs});
  if(['all','interactions'].includes(population))for(const fixture of LANGUAGE_EXPANSION_BENCHMARK.interactions.filter(row=>row.modules)){
    if(traceVersion!==8){moduleResults.push({id:fixture.id,profile:fixture.sourceProfile,status:'unsupported',
      reason:'The module source adapter publishes the versioned v8 region contract only',native:'untested'});continue;}
    const result=await verifier(fixture);
    moduleResults.push({id:fixture.id,profile:result.sourceProfile??fixture.sourceProfile,status:result.status,
      reason:result.reason??null,source:result.exported?'passed':result.status,
      regionCoverage:result.exported?.sidecar.regionCoverage??null,native:'untested'});
  }
  write('module-coverage.json',{producerRevision,traceVersion,declared:moduleResults.length,rows:moduleResults,
    scope:'Original module graphs are checked by the evaluated-module adapter, separately from strict script parsing'});
  write('coverage.json',coverage);write('serving-costs.json',{producerRevision,manifestDigest:manifest.digest,
    path:traceVersion===8?'actual-semantic-causal-lm/4':'actual-semantic-causal-lm/3',
    tokenStatus:!tokenModule?'untested':costs.some(row=>row.status==='failed')?'failed':
      costs.some(row=>row.status==='resource_limited')?'resource_limited':'passed',
    tokenizerEvidence:tokenModule?.tokenizerEvidence??null,rows:costs});
  write('notation.json',{producerRevision,manifestDigest:manifest.digest,arms:['canonical','formal','hybrid','prose'],
    scope:'Same certified operations and public facts; rendering does not change abstraction',tokenStatus:'untested',rows:notation});
}
const report={schema:'semantic-expansion-run/1',producerRevision,traceVersion,mode,population,inputs,manifestDigest:manifest.digest,
  workerBounds:{timeoutMs:workerTimeoutMs,memoryMb:workerMemoryMb},
  registryDigest:registry.digest,families:manifest.families.length,interactionGroups:manifest.interactions.length,
  realSource:manifest.realSource,reference:reference.totals,
  moduleAdapters:moduleResults.length?moduleResults:LANGUAGE_EXPANSION_BENCHMARK.interactions.filter(row=>!row.source).map(row=>({id:row.id,
    profile:row.sourceProfile,status:'untested',reason:'This run did not select the module interaction population'})),
  populationDenominators:{script:coverage?.coverage?.episodes?.declared??null,modules:moduleResults.length,
    declaredInteractionGroups:manifest.interactions.length},
  coverage:coverage?.coverage??null,comprehension:{tasks:taskset.tasks.length,status:scoreComprehensionResponses(taskset,[]).status},
  native:'untested',modelExecution:'untested',standardPromotion:'not-qualified'};
write('report.json',report);console.log(JSON.stringify({output,producerRevision,reference:reference.totals,
  families:report.families,interactions:report.interactionGroups,realSources:manifest.realSource.selectedDenominator,
  tasks:taskset.tasks.length,coverage:report.coverage}));
if(reference.totals.positivePassed!==reference.totals.positiveInputs||reference.totals.distinguishingPassed!==reference.totals.distinguishingPairs||
  reference.families.some(family=>family.distinguishingPairs.some(row=>row.normalizationSeparation.status==='failed')))process.exitCode=1;
} finally {if(tokenModule?.tokenizer?.close)await tokenModule.tokenizer.close();}
