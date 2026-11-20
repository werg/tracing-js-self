#!/usr/bin/env node
// Meter immutable committed source/native artifacts while their population is
// still running. Final reports bind the completed original qualification hash.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {setTimeout as wait} from 'node:timers/promises';

const [producerPath,qualifiedPath,outputPath]=process.argv.slice(2);
assert(producerPath&&qualifiedPath&&outputPath,'PRODUCER QUALIFICATION NEW_OUTPUT');
const root=resolve(producerPath),qualified=resolve(qualifiedPath),output=resolve(outputPath);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>JSON.parse(readFileSync(path));
const load=path=>import(pathToFileURL(join(root,path)));
const revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(execFileSync('git',['-C',root,'status','--porcelain=v1','--untracked-files=all'],{encoding:'utf8'}).trim(),'');
const {hashAlgorithmData}=await load('src/semantic/program.js');
const {identityHash,atomicWrite}=await load('src/corpus/campaign-store.mjs');
const {openQualificationProgress}=await load('src/corpus/qualification-progress.mjs');
const {readQualificationCostInputs,summarizeQualificationCosts}=await load('src/semantic/qualification-costs-v8.js');
const {auditRegionServingCosts}=await load('src/semantic/causal-lm-v8.js');
const {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST,validateV8NativeReceipt}=await load('src/semantic/native-v8.js');
const meter=await load('tools/semantic-v8-tokenizer-adapter.mjs');
const progressRoot=join(qualified,'progress'),headerBytes=readFileSync(join(progressRoot,'campaign.json')),
  header=JSON.parse(headerBytes),populationBytes=readFileSync(join(qualified,'population.json')),
  {digest:populationDigest,...population}=JSON.parse(populationBytes);
assert.equal(header.schema,'semantic-generation-campaign/1');
assert.equal(header.identityDigest,identityHash(header.identity));
assert.equal(populationDigest,hashAlgorithmData(population));
assert.equal(header.identity.populationDigest,populationDigest);
assert.equal(header.identity.producerRevision,revision);
assert.equal(population.producerRevision,revision);
assert.equal(population.declared,population.tasks.length);
const policy=read(join(root,'contracts/semantic-native-policy-v8.json'));
assert.deepEqual(header.identity.nativePolicy,policy);
for(const [key,value] of Object.entries({contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST}))
  assert.equal(header.identity[key],value);
const tasks=new Map(population.tasks.map(task=>[task.fixture.id,task]));
assert.equal(tasks.size,population.declared);
assert(!existsSync(output),'New cost evidence output required');mkdirSync(output);
const maxContextTokens=1048576,stream=openQualificationProgress(join(output,'stream'),{
  schema:'semantic-v8-committed-artifact-cost-progress/1',producerRevision:revision,
  qualificationCampaignDigest:header.identityDigest,populationDigest,
  tokenizerEvidence:meter.tokenizerEvidence,tokenizerIdentity:meter.tokenizer.identity,
  eosTokenId:meter.eosTokenId,maxContextTokens});
const startedAt=new Date().toISOString(),completed=new Map(),seen=new Map();
let journalPrefix=Buffer.alloc(0),previous=null,finalProgress;
const sourceEvidence=[];
function saveStatus(status,extra={}){
  atomicWrite(join(output,'stream-run.json'),JSON.stringify({schema:'semantic-v8-committed-cost-run/1',status,
    startedAt,updatedAt:new Date().toISOString(),producerRevision:revision,consumerRevision:policy.consumerRevision,
    qualificationCampaignDigest:header.identityDigest,populationDigest,declared:population.declared,
    measured:completed.size,nativeMeterWorkers:1,sourceAdmissionsPerformed:0,nativeAdmissionsPerformed:0,
    scope:'Actual production-tokenizer measurement of original immutable committed artifacts. Native packing is validated from their original receipts. No new source/native admission is created; final costs bind the complete original report.',...extra},null,2)+'\n');
}
function object(ref){
  assert.match(ref.path,/^objects\/(candidates|results)\/[a-f0-9]{64}\.json(?:\.gz)?$/);
  assert.equal(ref.format,undefined,'These qualification task/result envelopes contain no registry indirection');
  const bytes=readFileSync(join(progressRoot,ref.path));
  assert.equal(bytes.length,ref.bytes);assert.equal(sha(bytes),ref.sha256);
  const raw=ref.encoding==='gzip'?gunzipSync(bytes):bytes;
  assert.equal(raw.length,ref.uncompressedBytes);assert.equal(sha(raw),ref.contentSha256);
  return JSON.parse(raw);
}
function committedEntries(){
  assert.equal(sha(readFileSync(join(progressRoot,'campaign.json'))),sha(headerBytes));
  assert.equal(sha(readFileSync(join(qualified,'population.json'))),sha(populationBytes));
  const bytes=readFileSync(join(progressRoot,'campaign.jsonl')),end=bytes.lastIndexOf(10)+1;
  assert(bytes.length>=journalPrefix.length);
  assert.deepEqual(bytes.subarray(0,journalPrefix.length),journalPrefix,'Committed journal bytes changed');
  const fresh=bytes.subarray(journalPrefix.length,end).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  journalPrefix=bytes.subarray(0,end);
  return fresh.map(entry=>{
    const {entryDigest,...payload}=entry;
    assert.equal(entry.schema,'semantic-generation-entry/1');assert.equal(entry.campaignDigest,header.identityDigest);
    assert.equal(entry.previous,previous);assert.equal(identityHash(payload),entryDigest);previous=entryDigest;
    assert.equal(entry.attempt,1,'Qualification task may be committed only once in this fresh run');
    assert(!seen.has(entry.id));seen.set(entry.id,entryDigest);
    const candidate=object(entry.candidate),result=object(entry.result);
    assert.equal(entry.candidateDigest,identityHash({campaign:header.identityDigest,candidate}));
    assert.deepEqual(candidate,tasks.get(entry.id));
    assert.equal(result.status,entry.status);assert.equal(result.row.id,entry.id);
    assert.equal(entry.public,null);assert.equal(entry.private,null);
    return {entry,result};
  });
}
function artifact(name,digests){
  assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  assert.match(digests[name],/^[a-f0-9]{64}$/);
  const bytes=readFileSync(join(qualified,name));assert.equal(sha(bytes),digests[name]);return JSON.parse(bytes);
}
async function measure({entry,result}){
  const source=result.row;
  const row={id:source.id,source:source.source,sourceReason:source.reason,native:source.native,
    sourceProfile:source.sourceProfile,executionProfile:source.executionProfile??null,
    protocolExtensions:structuredClone(source.protocolExtensions??[]),regionCoverage:source.regionCoverage??null,
    status:'source-unqualified',cost:null,nativePacking:null,durationMs:0,peakRssBytes:null};
  const start=performance.now(),names=[];
  if(source.source==='passed'){
    const exported=artifact(source.sourceArtifact,result.artifacts);
    if(source.native==='passed'){
      const receipt=artifact(source.id+'.native.json',result.artifacts);
      assert.deepEqual(receipt,source.nativeReceipt);
      validateV8NativeReceipt(exported,receipt,policy);
      assert.equal(receipt.sourceVerification.producerRevision,revision);
      assert.equal(receipt.sourceVerification.artifactSha256,sha(JSON.stringify(exported)+'\n'));
      assert(Number.isSafeInteger(receipt.framing?.physicalRecords)&&receipt.framing.physicalRecords>=1);
      assert(Number.isSafeInteger(receipt.framing.terminalTokens)&&receipt.framing.terminalTokens>=0);
      row.nativePacking={status:'passed',generatedTokens:receipt.counts.generatedTokens,
        observedTokens:receipt.counts.observedTokens,terminalTokens:receipt.framing.terminalTokens,
        physicalRecords:receipt.framing.physicalRecords,logicalRecords:receipt.counts.records,
        nativeTrainingDigest:receipt.nativeTrainingDigest};
    }
    let costs;
    try{
      costs=await auditRegionServingCosts(exported,{tokenizer:meter.tokenizer,eosTokenId:meter.eosTokenId,maxContextTokens});
      row.status='measured';row.cost={status:'passed',predictions:costs.predictions,bytes:costs.bytes,
        tokens:costs.tokens,measurement:costs.measurement,
        detailedTokens:costs.rows.filter(item=>item.detail).reduce((n,item)=>n+item.generatedTokens,0)};
    }catch(error){
      const limited=/context budget|example cap|record byte bound/i.test(error.message);
      row.status=limited?'resource_limited':'measurement-failed';
      costs={schema:'semantic-serving-cost-refusal/1',status:row.status,reason:error.message};
      row.cost={status:row.status,reason:error.message};
    }
    const name='serving-'+source.id+'.json';stream.save(name,costs);names.push(name);row.cost.artifact=name;
  }else if(source.sourceResult)artifact(source.sourceResult,result.artifacts);
  row.durationMs=performance.now()-start;
  const task={id:source.id,qualificationEntryDigest:entry.entryDigest,sourceArtifacts:result.artifacts};
  const recorded=stream.complete(source.id,task,row,names);
  completed.set(source.id,{row,source,sourceArtifacts:result.artifacts,artifacts:recorded.artifacts});
  sourceEvidence.push({id:source.id,qualificationEntryDigest:entry.entryDigest,
    qualificationResult:entry.result,sourceArtifacts:result.artifacts,costArtifacts:recorded.artifacts});
  saveStatus('running');
  console.log(JSON.stringify({id:source.id,status:row.status,completed:completed.size,declared:population.declared}));
}
try{
  saveStatus('running');
  while(completed.size<population.declared){
    const entries=committedEntries();
    for(const entry of entries)await measure(entry);
    if(!entries.length)await wait(2000);
  }
  while(!existsSync(join(qualified,'report.json')))await wait(1000);
  const input=readQualificationCostInputs(qualified),qualification=input.report;
  assert.equal(qualification.producerRevision,revision);assert.equal(qualification.populationDigest,populationDigest);
  assert.deepEqual(qualification.nativePolicy,policy);
  assert.equal(qualification.declared,completed.size);
  const rows=[],artifacts={};
  finalProgress=openQualificationProgress(join(output,'costs'),{schema:'semantic-v8-cost-progress/1',producerRevision:revision,
    qualificationReportSha256:input.reportSha256,populationDigest,
    tokenizerEvidence:meter.tokenizerEvidence,tokenizerIdentity:meter.tokenizer.identity,
    eosTokenId:meter.eosTokenId,maxContextTokens});
  for(const source of qualification.rows){
    const retained=completed.get(source.id);assert(retained);assert.deepEqual(retained.source,source);
    for(const [name,digest] of Object.entries(retained.sourceArtifacts)){
      assert.equal(qualification.artifacts[name],digest);input.readArtifact(name);
    }
    const names=Object.keys(retained.artifacts);
    for(const name of names){
      const bytes=readFileSync(join(output,'stream',name));assert.equal(sha(bytes),retained.artifacts[name]);
      artifacts[name]=finalProgress.save(name,JSON.parse(bytes));assert.equal(artifacts[name],retained.artifacts[name]);
    }
    finalProgress.complete(source.id,{id:source.id,qualificationReportSha256:input.reportSha256},retained.row,names);
    rows.push(retained.row);
  }
  const report={schema:'semantic-v8-population-costs/1',producerRevision:revision,population:qualification.population,inputs:qualification.inputs,
    qualification:{reportSha256:input.reportSha256,populationDigest,contractDigest:qualification.contractDigest,
      fixtureDigest:qualification.fixtureDigest,interoperabilityDigest:qualification.interoperabilityDigest,nativePolicy:policy},
    progressDigest:finalProgress.digest,tokenizerEvidence:meter.tokenizerEvidence,serializer:'semantic-causal-lm/4',
    maxContextTokens,artifactDigestEncoding:'sha256 of exact UTF-8 file bytes',
    summary:summarizeQualificationCosts(rows,{tokenizer:true}),rows,artifacts};
  finalProgress.save('report.json',report);
  atomicWrite(join(output,'source-bindings.json'),JSON.stringify({schema:'semantic-v8-stream-cost-bindings/1',
    qualificationReportSha256:input.reportSha256,populationDigest,entries:sourceEvidence,
    finalQualificationRowsExactlyEqual:true,sourceAdmissionsPerformed:0,nativeAdmissionsPerformed:0},null,2)+'\n');
  saveStatus(rows.every(row=>row.cost?.status==='passed')?'passed':'failed',{
    finishedAt:new Date().toISOString(),qualificationReportSha256:input.reportSha256,
    finalReportSha256:sha(readFileSync(join(output,'costs/report.json'))),normalCostSchema:true,
    everyCommittedSourceRowRechecked:true,finalProgressDigest:finalProgress.digest});
  assert(rows.every(row=>row.cost?.status==='passed'),'All declared cost measurements must pass');
}catch(error){saveStatus('failed',{failure:error.stack??String(error)});throw error;}
finally{stream.close();finalProgress?.close();await meter.tokenizer.close();}
