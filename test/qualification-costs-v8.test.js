import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readQualificationCostInputs,summarizeQualificationCosts} from '../src/semantic/qualification-costs-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'qualification-costs-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const artifacts={},save=(name,value)=>{const bytes=JSON.stringify(value)+'\n';writeFileSync(join(directory,name),bytes);
    artifacts[name]=createHash('sha256').update(bytes).digest('hex');};
  const population={producerRevision:'a'.repeat(40),population:'families',inputs:'all',declared:2,
    tasks:[{fixture:{id:'passed'}},{fixture:{id:'refused'}}]},digest=hashAlgorithmData(population);
  save('population.json',{...population,digest});save('passed.source.json',{public:{exact:'source'}});
  save('refused.result.json',{status:'unsupported'});
  const report={schema:'semantic-v8-qualification/1',producerRevision:population.producerRevision,population:'families',
    inputs:'all',declared:2,populationDigest:digest,sourceQualified:1,nativeAdmitted:0,
    artifactDigestEncoding:'sha256 of exact UTF-8 file bytes',artifacts,
    rows:[{id:'passed',source:'passed',native:'untested',sourceArtifact:'passed.source.json'},
      {id:'refused',source:'unsupported',native:'untested',sourceResult:'refused.result.json'}]};
  save('report.json',report);return {directory,report,save};
}

test('cost reuse binds retained bytes and every declared source, including refusals',t=>{
  const {directory,report,save}=fixture(t),input=readQualificationCostInputs(directory);
  assert.equal(input.report.rows.length,2);assert.equal(input.population.tasks.length,2);
  assert.deepEqual(input.readArtifact('passed.source.json'),{public:{exact:'source'}});
  assert.throws(()=>input.readArtifact('../report.json'),/unsafe/);
  writeFileSync(join(directory,'passed.source.json'),'{"public":{"exact":"changed"}}');
  assert.throws(()=>input.readArtifact('passed.source.json'),/bytes changed/);
  save('report.json',{...report,rows:report.rows.slice(0,1),declared:1});
  assert.throws(()=>readQualificationCostInputs(directory),/denominator changed/);
  save('report.json',{...report,rows:[...report.rows].reverse()});
  assert.throws(()=>readQualificationCostInputs(directory),/source order/);
  save('report.json',{...report,sourceQualified:2});
  assert.throws(()=>readQualificationCostInputs(directory),/totals changed/);
});

test('cost reports reject changed frozen task bytes even after an outer checksum update',t=>{
  const {directory,report,save}=fixture(t),population=JSON.parse(readFileSync(join(directory,'population.json')));
  population.tasks[0].fixture.source='different';save('population.json',population);save('report.json',report);
  assert.throws(()=>readQualificationCostInputs(directory),/population digest changed/);
});

test('summary weights detail by measured tokens and keeps source and cost failures in denominators',()=>{
  const coverage={compactRegions:1,detailedRegions:2,compactRecords:1,detailedRecords:3};
  const cost=(generated,detailed)=>({status:'passed',bytes:{generated,detailed,cumulativeContext:100,peakContext:50},
    tokens:{generated,terminal:4,observedAndContext:100,total:generated+104,peakContext:50},detailedTokens:detailed});
  const rows=[
    {id:'small',source:'passed',regionCoverage:coverage,cost:cost(10,5),nativePacking:{status:'passed',
      generatedTokens:10,observedTokens:40,terminalTokens:0,physicalRecords:6,logicalRecords:4}},
    {id:'large',source:'passed',regionCoverage:coverage,cost:cost(90,9)},
    {id:'limited',source:'passed',regionCoverage:coverage,cost:{status:'resource_limited'}},
    {id:'refused',source:'unsupported',cost:null},
    {id:'not-selected',source:'untested',cost:null}];
  const result=summarizeQualificationCosts(rows,{tokenizer:true});
  assert.equal(result.declared,5);assert.equal(result.sourceQualified,3);
  assert.deepEqual(result.sourceDispositions,{passed:3,unsupported:1,untested:1});
  assert.equal(result.regionCoverage.unmeasuredEpisodes,2);assert.equal(result.flat.unmeasured,3);
  assert.deepEqual(result.flat.dispositions,{passed:2,resource_limited:1});
  assert.equal(result.flat.tokenMeasurement,'partial');assert.equal(result.flat.tokens.detailedShare,0.14);
  assert.equal(result.flat.tokens.total,308);assert.equal(result.nativePacking.physicalRecords,6);
  assert.equal(result.nativePacking.unmeasuredEpisodes,4);
  assert.equal(result.nativeServing.status,'unmeasured');assert.equal(result.defaultPromotion,'not-qualified');
  const bytesOnly=summarizeQualificationCosts(rows.map(row=>({...row,
    cost:row.cost?.status==='passed'?{...row.cost,tokens:{total:null},detailedTokens:null}:row.cost})));
  assert.equal(bytesOnly.flat.tokens,null);assert.equal(bytesOnly.flat.tokenMeasurement,'untested');
  assert.equal(summarizeQualificationCosts([{source:'unsupported'}],{tokenizer:true}).flat.tokenMeasurement,'untested');
});
