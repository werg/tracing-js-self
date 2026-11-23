#!/usr/bin/env node
// Run from the clean recorded producer. This checks retained evidence and
// original bytes; it performs no guest execution or native replay.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const flags=new Map();
for(let index=2;index<process.argv.length;index+=2){
  const name=process.argv[index],value=process.argv[index+1];
  assert(['--suite-root','--retained-root'].includes(name)&&value&&!flags.has(name),'input verification arguments');
  flags.set(name,value);
}
assert(flags.has('--suite-root'),'--suite-root is required');
const suite=resolve(flags.get('--suite-root')),retained=resolve(flags.get('--retained-root')??dirname(fileURLToPath(import.meta.url))),
  baseline=resolve(dirname(fileURLToPath(import.meta.url)),'../issue61-baseline'),read=path=>JSON.parse(readFileSync(path,'utf8')),
  catalog=read(join(retained,'selected-catalog.json')),selection=read(join(retained,'selected-report.json')),
  prior=read(join(baseline,'selected-catalog.json')),priorSelection=read(join(baseline,'selected-report.json')),
  report=selection.report,revision=catalog.fullCatalog.suiteRevision,
  sha=bytes=>createHash('sha256').update(bytes).digest('hex'),
  git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const {prepareOfficialTest262Variant}=await import(pathToFileURL(resolve('src/conformance/test262-runner.js')));
const {verifyTest262ImplementationFiles}=await import(pathToFileURL(resolve('src/conformance/test262-campaign.js')));
const {conformanceDigest}=await import(pathToFileURL(resolve('src/conformance/test262-catalog.js')));
assert.equal(git(process.cwd(),'rev-parse','HEAD'),report.campaign.implementation.producerRevision);
assert.equal(git(process.cwd(),'status','--porcelain','--untracked-files=all'),'');
assert.equal(git(suite,'rev-parse','HEAD'),revision);
assert.equal(git(suite,'status','--porcelain','--untracked-files=all'),'');
verifyTest262ImplementationFiles(report.campaign.implementation);
assert.equal(selection.fullCatalogDigest,'67799da9e7d4dd08333fe38a75b7d738d9fd14ffc40a2e17d4d00254781a47de');
assert.equal(selection.projection.fullPopulation,103360);
assert.equal(catalog.variants.length,40);assert.equal(catalog.files.length,25);
assert.deepEqual(catalog.files,prior.files);
const identities=rows=>rows.map(({id,path,mode,sourceDigest,gitBlobSha,metadata,harness,dependencies})=>
  ({id,path,mode,sourceDigest,gitBlobSha,metadata,harness,dependencies}));
assert.deepEqual(identities(catalog.variants),identities(prior.variants));
assert.deepEqual(report.runPolicy,priorSelection.report.runPolicy);
assert.deepEqual(report.profile.resourcePolicy,priorSelection.report.profile.resourcePolicy);
assert.equal(readFileSync(join(retained,'selected-paths.txt'),'utf8'),readFileSync(join(baseline,'selected-paths.txt'),'utf8'));
const files=new Map();
for(const file of catalog.files){
  const bytes=readFileSync(join(suite,file.path)),original=execFileSync('git',['-C',suite,'show',revision+':'+file.path],{maxBuffer:4*1024*1024});
  assert(bytes.equals(original),file.path+' differs from pinned Git bytes');
  assert.equal(bytes.length,file.bytes);assert.equal(sha(bytes),file.sha256);
  assert.equal(createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),file.gitBlobSha);
  files.set(file.path,bytes);
}
const variants=new Map(catalog.variants.map(row=>[row.id,row])),modes=new Map();let attempts=0,ownedTraces=0;
for(const row of report.campaign.rows){
  const variant=variants.get(row.id);assert(variant&&row.selected);
  assert.equal(row.path,variant.path);assert.equal(row.mode,variant.mode);
  const seen=modes.get(row.path)??new Set();assert(!seen.has(row.mode));seen.add(row.mode);modes.set(row.path,seen);
  assert.equal(sha(files.get(variant.path)),variant.sourceDigest);
  for(const harness of variant.harness)assert.equal(sha(files.get(harness.path)),harness.sha256);
  assert.equal(row.attempts.length,3);
  const sources=Object.fromEntries([variant.path,...variant.harness.map(file=>file.path)].map(path=>[path,files.get(path)])),
    prepared=prepareOfficialTest262Variant({variant,profile:report.profile,suiteRevision:revision,sources});
  for(const attempt of row.attempts){
    attempts++;assert.equal(attempt.status,'passed');assert.equal(row.stages[attempt.stage].status,'passed');
    assert.equal(conformanceDigest(attempt.evidence),attempt.evidenceDigest);
    if(attempt.stage==='parseStatic')assert.equal(attempt.evidence.sourceDigest,variant.sourceDigest);
    else assert.equal(attempt.evidence.caseId,row.id);
    if(attempt.stage==='ownedExecution'){
      const trace=attempt.evidence.trace;
      assert.equal(trace.structurallyValidated,true);assert.equal(trace.exactlyReplayed,true);
      const expected=[...prepared.harness.map(file=>({path:file.path,sha256:sha(file.text)})),
        {path:variant.path,sha256:sha(prepared.code)}];
      assert.equal(trace.sourceCount,expected.length);assert.deepEqual(trace.sourceDigests,expected);ownedTraces++;
    }
  }
}
assert.equal(modes.size,20);for(const seen of modes.values())assert.deepEqual([...seen].sort(),['sloppy','strict']);
assert.equal(attempts,120);assert.equal(ownedTraces,40);
for(const [name,identity]of Object.entries(read(join(retained,'observation.json')).artifacts)){
  const bytes=readFileSync(join(retained,name));assert.equal(bytes.length,identity.bytes);assert.equal(sha(bytes),identity.sha256);
}
console.log(JSON.stringify({valid:true,exactOriginalFiles:files.size,testPaths:modes.size,strictSloppyVariants:variants.size,
  retainedAttempts:attempts,sourceAndHarnessMatchPinnedGitBytes:true,selectedVariantAndFileIdentitiesEqualBaseline:true,
  ownedPreparedSourceDigestsVerified:ownedTraces,strictModePreparation:'The original runner adds only its declared strict variant preparation.',
  retainedEvidenceAndArtifactIdentitiesValid:true,producerClean:true,test262Clean:true,guestExecutions:0,nativeReplayExecuted:false}));
