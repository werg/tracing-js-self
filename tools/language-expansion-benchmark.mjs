#!/usr/bin/env node
// A new output directory preserves prior population/result identities.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expansionManifest,expansionFamilyRegistry,validateExpansionReferencePopulation,
  expansionSourceCases,expansionRealSourceSlice} from '../src/semantic/expansion-benchmark.js';
import {LANGUAGE_EXPANSION_BENCHMARK} from '../fixtures/language-expansion/benchmark.js';
import {LANGUAGE_EXPANSION_COMPREHENSION_TASKSET as taskset} from '../fixtures/language-expansion/comprehension.js';
import {comprehensionTasksetDigest,scoreComprehensionResponses} from '../src/semantic/comprehension.js';
import {buildCapabilityLedger} from '../src/training/capability-ledger.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {verifyAlgorithmTrainingCase} from '../src/semantic/compiler.js';
import {auditFlatServingCosts} from '../src/semantic/serving-costs.js';
import {notationViews} from '../src/semantic/notation-experiment.js';
const allowed=new Set(['--out','--mode','--inputs','--population']),flags=new Map();
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  if(!allowed.has(key)||flags.has(key)||!value||value.startsWith('--'))throw new Error('Unknown, repeated or missing benchmark option '+key);
  flags.set(key,value);
}
if(!flags.has('--out'))throw new Error('Usage: node tools/language-expansion-benchmark.mjs --out NEW_DIRECTORY [--mode reference|coverage] [--inputs all|first] [--population all|families|interactions|real-source|gallery]');
const mode=flags.get('--mode')??'reference',inputs=flags.get('--inputs')??'all',population=flags.get('--population')??'all';
if(!['reference','coverage'].includes(mode)||!['all','first'].includes(inputs)||
  !['all','families','interactions','real-source','gallery'].includes(population))throw new Error('Invalid benchmark mode, inputs or population');
const output=resolve(flags.get('--out')),root=fileURLToPath(new URL('..',import.meta.url));
mkdirSync(dirname(output),{recursive:true});mkdirSync(output,{recursive:false});
const write=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceChanges=execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();
if(sourceChanges)throw new Error('Retained benchmark evidence requires a committed producer; commit source changes first');
const manifest=expansionManifest(),registry=expansionFamilyRegistry();
write('manifest.json',manifest);write('family-registry.json',registry);
write('comprehension-lock.json',{schema:'semantic-comprehension-lock/1',id:taskset.id,version:taskset.version,
  digest:comprehensionTasksetDigest(taskset),tasks:taskset.tasks.length,
  families:new Set(taskset.tasks.map(row=>row.family)).size,measurement:'unmeasured',
  responseCount:0,model:null,reason:'No external evaluator responses have been collected; reference answer keys are not model responses'});
const reference=validateExpansionReferencePopulation();write('reference-report.json',{producerRevision,...reference});
let coverage=null;
if(mode==='coverage'){
  let cases=population==='gallery'?SEMANTIC_GALLERY_FIXTURES:population==='real-source'?expansionRealSourceSlice().cases:
    expansionSourceCases({allInputs:inputs==='all',includeInteractions:population==='all'||population==='interactions',
      includeRealSource:population==='all'});
  if(population==='interactions')cases=cases.filter(row=>row.family.startsWith('interaction:'));
  const costs=[],notation=[],verifier=async fixture=>{
    const result=await verifyAlgorithmTrainingCase({...fixture,producerRevision});
    if(result.exported){
      const cost=await auditFlatServingCosts(result.exported);
      // Preserve exact serializer bytes separately, avoiding giant duplicate
      // prompt/definition fields inside the small aggregate coverage report.
      write('serving-'+fixture.id+'.json',cost);
      costs.push({id:fixture.id,representation:cost.representation,predictions:cost.predictions,
        bytes:cost.bytes,tokens:cost.tokens,measurement:cost.measurement});
      if(result.exported.public.representation==='algorithm'){
        const records=result.exported.public.timeline.filter(row=>row.mode==='generated'||row.kind==='observation')
          .filter(row=>typeof row.line==='string').map(row=>row.line);
        notation.push({id:fixture.id,...notationViews(records)});
      }
    }
    process.stderr.write(JSON.stringify({id:fixture.id,status:result.status})+'\n');return result;
  };
  coverage=await buildCapabilityLedger({producerRevision,cases,verifyCase:verifier,traceVersion:7,
    population:'expansion-v1:'+population+':inputs-'+inputs});
  write('coverage.json',coverage);write('serving-costs.json',{producerRevision,manifestDigest:manifest.digest,
    path:'actual-semantic-causal-lm/3',tokenStatus:'untested',rows:costs});
  write('notation.json',{producerRevision,manifestDigest:manifest.digest,arms:['canonical','formal','hybrid','prose'],
    scope:'Same certified operations and public facts; rendering does not change abstraction',tokenStatus:'untested',rows:notation});
}
const report={schema:'semantic-expansion-run/1',producerRevision,mode,population,inputs,manifestDigest:manifest.digest,
  registryDigest:registry.digest,families:manifest.families.length,interactionGroups:manifest.interactions.length,
  realSource:manifest.realSource,reference:reference.totals,
  moduleAdapters:LANGUAGE_EXPANSION_BENCHMARK.interactions.filter(row=>!row.source).map(row=>({id:row.id,
    profile:row.sourceProfile,status:'untested',reason:'This runner has no module-source adapter; strict script results cannot qualify module cells or asynchronous graphs'})),
  coverage:coverage?.coverage??null,comprehension:{tasks:taskset.tasks.length,status:scoreComprehensionResponses(taskset,[]).status},
  native:'untested',modelExecution:'untested',standardPromotion:'not-qualified'};
write('report.json',report);console.log(JSON.stringify({output,producerRevision,reference:reference.totals,
  families:report.families,interactions:report.interactionGroups,realSources:manifest.realSource.selectedDenominator,
  tasks:taskset.tasks.length,coverage:report.coverage}));
if(reference.totals.positivePassed!==reference.totals.positiveInputs||reference.totals.distinguishingPassed!==reference.totals.distinguishingPairs||
  reference.families.some(family=>family.distinguishingPairs.some(row=>row.normalizationSeparation.status==='failed')))process.exitCode=1;
