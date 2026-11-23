#!/usr/bin/env node
// Current authored cohort membership is authority for the release population.
// Journal custody and source/native receipt checks remain separate required gates.
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {buildSemanticRegionSupportCohortV8} from '../fixtures/semantic-regions/support-cohort.js';
import {encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {REGION_DATASET_SPLITS} from '../src/semantic/family-registry-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST,
  validateV8NativePolicy} from '../src/semantic/native-v8.js';

const require=(condition,message)=>{if(!condition)throw new Error('V8 release population: '+message);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const REVISION=/^[a-f0-9]{40}$/;
const FILES=Object.freeze({report:'report.json',registry:'family-registry.json',
  cohort:'support-cohort.json',population:'population.json'});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function verifyV8ReleasePopulation({report,registry,cohort,population}){
  require(record(report)&&report.schema==='semantic-v8-qualification/1'&&typeof report.producerRevision==='string'&&
    REVISION.test(report.producerRevision??''),'qualification report identity is missing');
  const current=buildSemanticRegionSupportCohortV8(),count=current.fixtures.length;
  require(count===64&&current.fixtureCount===count&&current.registry.sources.length===count,
    'the release requires the complete authored 64-source support cohort');
  require(isDeepStrictEqual(cohort,current),'retained cohort differs from the current authored cohort');
  require(isDeepStrictEqual(registry,current.registry),'registry differs from the current authored cohort');
  const caseIds=current.fixtures.map(fixture=>fixture.id),sourceIds=registry.sources.map(source=>source.id),
    splitById=new Map(registry.components.flatMap(component=>
      component.sourceIds.map(id=>[id,component.split]))),
    splitCounts=Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,
      sourceIds.filter(id=>splitById.get(id)===split).length])),
    componentCounts=Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,
      registry.components.filter(component=>component.split===split).length]));
  require(new Set(caseIds).size===count&&new Set(sourceIds).size===count&&splitById.size===count&&
    caseIds.every(id=>sourceIds.includes(id))&&isDeepStrictEqual(splitCounts,current.sourceCounts),
    'authored source membership or derived splits are incomplete');
  require(report.population==='se-support'&&report.inputs==='all'&&report.declared===count&&
    report.preparationOnly===false&&report.sourceQualified===count&&report.nativeAdmitted===count,
    'complete support source/native qualification is required');
  require(isDeepStrictEqual(report.selectedCaseIds,caseIds),
    'selection must retain every authored support case in its original order');
  require(report.supportCohortDigest===current.digest&&report.registryDigest===registry.digest&&
    report.supportCohortArtifact===FILES.cohort&&report.familyRegistryArtifact===FILES.registry,
    'report cohort and registry identities differ from the authored population');
  require(isDeepStrictEqual(report.sourceCounts,splitCounts),
    'reported split counts differ from the authenticated current registry');
  require(Array.isArray(report.rows)&&report.rows.length===count&&
    isDeepStrictEqual(report.rows.map(row=>row?.id),caseIds)&&
    new Set(report.rows.map(row=>row?.sourceId)).size===count,
    'report must contain every unique case and physical source exactly once');
  for(const [index,row] of report.rows.entries()){
    const fixture=current.fixtures[index];
    require(row.sourceId===fixture.id&&row.family===fixture.family&&row.split===splitById.get(fixture.id),
      'row source membership or split differs from the authenticated registry: '+fixture.id);
    require(row.status==='admitted'&&row.source==='passed'&&row.native==='passed'&&
      row.sourceArtifact===fixture.id+'.source.json',
      'every selected source requires its recorded source/native pass: '+fixture.id);
  }
  for(const [key,digest] of [['contractDigest',V8_CONTRACT_DIGEST],['fixtureDigest',V8_FIXTURE_DIGEST],
    ['interoperabilityDigest',V8_INTEROPERABILITY_DIGEST]])
    require(report[key]===digest,'report differs from the current '+key);
  require(record(report.nativePolicy)&&typeof report.nativePolicy.consumerRevision==='string'&&
    REVISION.test(report.nativePolicy.consumerRevision),
    'qualification must retain its exact native revision');
  validateV8NativePolicy(report.nativePolicy);
  require(report.model==='untested'&&report.optimizerSteps===0&&report.defaultPromotion==='not-qualified',
    'source population evidence cannot claim model or default qualification');

  // Rebuild requests too: unchanged source text does not authorize changed
  // inputs, callback fixtures, repeated calls, or an added/removed teacher.
  const expected={schema:'semantic-v8-qualification-population/1',producerRevision:report.producerRevision,
    population:'se-support',inputs:'all',declared:count,selectedCaseIds:caseIds,
    supportCohortDigest:current.digest,registryDigest:registry.digest,sourceCounts:splitCounts,
    tasks:current.fixtures.map(fixture=>encodeGenerationTask({kind:'source',traceVersion:8,
      fixture:structuredClone(fixture),producerRevision:report.producerRevision}))};
  const populationDigest=hashAlgorithmData(expected);
  require(isDeepStrictEqual(population,{...expected,digest:populationDigest})&&
    report.populationDigest===populationDigest,
    'frozen tasks or population identity differ from the current authored requests');
  return {schema:'semantic-v8-release-population/1',status:'verified',producerRevision:report.producerRevision,
    populationCount:count,cohortDigest:current.digest,registryDigest:registry.digest,populationDigest,
    sourceIds,selectedCaseIds:caseIds,trainSourceIds:sourceIds.filter(id=>splitById.get(id)==='train'),
    splitCounts,componentCounts,
    scope:'Current authored population and recorded dispositions; journal and independent source/native receipt verification remain separate required gates'};
}

export function verifyV8ReleasePopulationDirectory(directory){
  const root=resolve(directory),data={},inputSha256={},inputBytes={};
  require(lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink(),
    'qualification root must be a regular directory');
  for(const [key,name] of Object.entries(FILES)){
    const path=join(root,name),before=lstatSync(path);
    require(before.isFile()&&!before.isSymbolicLink()&&before.size<=64*1024*1024,
      'qualification metadata must be a bounded regular file: '+name);
    const bytes=readFileSync(path),after=lstatSync(path);
    require(bytes.length===before.size&&['dev','ino','size','mtimeMs','ctimeMs'].every(field=>
      before[field]===after[field]),'qualification metadata changed while reading: '+name);
    data[key]=JSON.parse(bytes);inputSha256[name]=sha(bytes);inputBytes[name]=bytes.length;
  }
  const result=verifyV8ReleasePopulation(data);
  require(record(data.report.artifacts)&&[FILES.registry,FILES.cohort,FILES.population].every(name=>
    data.report.artifacts[name]===inputSha256[name]),'report does not bind the exact retained population bytes');
  return {...result,inputSha256,inputBytes};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [directory,flag,output,...extra]=process.argv.slice(2);
  require(directory&&flag==='--output'&&output&&!extra.length,
    'usage: node tools/verify-v8-release-population.mjs QUALIFICATION_DIRECTORY --output NEW_FILE');
  const root=resolve(directory),target=resolve(output),location=relative(root,target);
  require(location==='..'||location.startsWith('..'+sep)||isAbsolute(location),
    'snapshot output must be outside the original qualification directory');
  const result=verifyV8ReleasePopulationDirectory(root);
  writeFileSync(target,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:result.status,producerRevision:result.producerRevision,
    populationCount:result.populationCount,registryDigest:result.registryDigest,
    splitCounts:result.splitCounts,componentCounts:result.componentCounts,output:target}));
}
