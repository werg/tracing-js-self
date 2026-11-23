import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildSemanticRegionSupportCohortV8} from '../fixtures/semantic-regions/support-cohort.js';
import {buildRegionFamilyRegistry} from '../src/semantic/family-registry-v8.js';
import {encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST} from '../src/semantic/native-v8.js';
import {verifyV8ReleasePopulation,verifyV8ReleasePopulationDirectory} from '../tools/verify-v8-release-population.mjs';

const current=buildSemanticRegionSupportCohortV8(),revision='a'.repeat(40);
const resign=value=>{const {digest,...body}=value;value.digest=hashAlgorithmData(body);return value;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function candidate(){
  const cohort=structuredClone(current),registry=structuredClone(cohort.registry),
    selectedCaseIds=cohort.fixtures.map(fixture=>fixture.id),
    splitById=new Map(registry.components.flatMap(component=>component.sourceIds.map(id=>[id,component.split]))),
    population=resign({schema:'semantic-v8-qualification-population/1',producerRevision:revision,
      population:'se-support',inputs:'all',declared:64,selectedCaseIds,
      supportCohortDigest:cohort.digest,registryDigest:registry.digest,sourceCounts:cohort.sourceCounts,
      tasks:cohort.fixtures.map(fixture=>encodeGenerationTask({kind:'source',traceVersion:8,
        fixture:structuredClone(fixture),producerRevision:revision}))});
  const nativePolicy={schema:'semantic-native-policy/8',consumerRepository:'werg/megatoken',
    consumerRevision:'b'.repeat(40),contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,
    interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,tokenizerIdentity:'c'.repeat(64),tokenizerSha256:'d'.repeat(64)};
  const report={schema:'semantic-v8-qualification/1',producerRevision:revision,population:'se-support',
    inputs:'all',declared:64,selectedCaseIds:[...selectedCaseIds],preparationOnly:false,
    supportCohortDigest:cohort.digest,registryDigest:registry.digest,sourceCounts:structuredClone(cohort.sourceCounts),
    supportCohortArtifact:'support-cohort.json',familyRegistryArtifact:'family-registry.json',
    populationDigest:population.digest,contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,
    interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,nativePolicy,sourceQualified:64,nativeAdmitted:64,
    model:'untested',optimizerSteps:0,defaultPromotion:'not-qualified',
    rows:cohort.fixtures.map(fixture=>({id:fixture.id,sourceId:fixture.id,family:fixture.family,
      split:splitById.get(fixture.id),status:'admitted',source:'passed',native:'passed',
      sourceArtifact:fixture.id+'.source.json'}))};
  return {report,registry,cohort,population};
}

function reseal(value){
  resign(value.registry);value.cohort.registry=structuredClone(value.registry);resign(value.cohort);
  for(const target of [value.report,value.population]){
    target.supportCohortDigest=value.cohort.digest;target.registryDigest=value.registry.digest;
  }
  resign(value.population);value.report.populationDigest=value.population.digest;
}

test('release population derives exact current splits from every authored support source',()=>{
  const input=candidate(),snapshot=verifyV8ReleasePopulation(input);
  assert.equal(snapshot.populationCount,64);
  assert.equal(snapshot.producerRevision,revision);
  assert.deepEqual(snapshot.sourceIds,current.registry.sources.map(source=>source.id));
  assert.deepEqual(snapshot.splitCounts,current.sourceCounts);
  assert.equal(snapshot.trainSourceIds.length,current.sourceCounts.train);
  assert.equal(Object.values(snapshot.componentCounts).reduce((sum,count)=>sum+count,0),current.registry.components.length);
  assert.deepEqual(input,candidate(),'verification does not mutate the original retained observations');
});

test('release population refuses missing, extra, duplicate and substituted source rows',()=>{
  for(const change of [value=>value.report.rows.pop(),value=>value.report.rows.push({...value.report.rows[0],id:'foreign'}),
    value=>value.report.rows[1]={...value.report.rows[0]},value=>value.report.rows[0].sourceId='foreign',
    value=>value.report.rows[0].family='foreign']){
    const input=candidate();change(input);assert.throws(()=>verifyV8ReleasePopulation(input),/unique|membership/);
  }
});

test('release population refuses reduced or reordered selection even with a rehashed population',()=>{
  for(const reorder of [false,true]){
    const input=candidate();
    if(reorder)input.report.selectedCaseIds.reverse();else input.report.selectedCaseIds.pop();
    input.population.selectedCaseIds=[...input.report.selectedCaseIds];
    resign(input.population);input.report.populationDigest=input.population.digest;
    assert.throws(()=>verifyV8ReleasePopulation(input),/selection/);
  }
});

test('release population refuses a self-consistent replacement source registry and cohort',()=>{
  const input=candidate();input.cohort.fixtures[0].source+='\n// substituted original source\n';
  input.registry=buildRegionFamilyRegistry(input.cohort.fixtures.map(fixture=>({id:fixture.id,
    family:fixture.family,ancestors:fixture.ancestorIds??[],source:fixture.source,entry:fixture.entry})),{seed:17});
  reseal(input);
  assert.throws(()=>verifyV8ReleasePopulation(input),/current authored cohort/);
});

test('release population refuses missing or extra registry members after rehashing',()=>{
  for(const extra of [false,true]){
    const input=candidate();
    if(extra)input.registry.sources.push({...input.registry.sources[0],id:'foreign'});
    else input.registry.sources.pop();
    reseal(input);assert.throws(()=>verifyV8ReleasePopulation(input),/current authored cohort/);
  }
});

test('release population refuses rehashed split changes and balanced wrong row assignments',()=>{
  const input=candidate();input.registry.components[0].split=input.registry.components[0].split==='train'?'test':'train';reseal(input);
  assert.throws(()=>verifyV8ReleasePopulation(input),/current authored cohort/);
  const rows=candidate(),train=rows.report.rows.find(row=>row.split==='train'),
    validation=rows.report.rows.find(row=>row.split==='validation');
  [train.split,validation.split]=[validation.split,train.split];
  assert.throws(()=>verifyV8ReleasePopulation(rows),/row source membership or split/);
});

test('release population refuses historical split totals as a substitute for the current registry',()=>{
  const input=candidate(),stale={train:48,validation:12,test:4};
  if(JSON.stringify(stale)===JSON.stringify(current.sourceCounts)){stale.train+=4;stale.validation-=4;}
  input.report.sourceCounts=stale;input.population.sourceCounts=stale;
  resign(input.population);input.report.populationDigest=input.population.digest;
  assert.throws(()=>verifyV8ReleasePopulation(input),/reported split counts/);
});

test('release population binds actual inputs and teacher requests despite consistent rehashing',()=>{
  for(const change of [task=>task.fixture.argsGraph.roots[0]=['num',999],task=>task.fixture.orchestrationTeacher=true]){
    const input=candidate();change(input.population.tasks[0]);
    resign(input.population);input.report.populationDigest=input.population.digest;
    assert.throws(()=>verifyV8ReleasePopulation(input),/authored requests/);
  }
});

test('release population requires every recorded source and native pass without broader claims',()=>{
  for(const change of [value=>value.report.rows[0].native='failed',value=>value.report.rows[0].source='unsupported',
    value=>value.report.sourceQualified=63,value=>value.report.preparationOnly=true,
    value=>value.report.model='passed',value=>value.report.optimizerSteps=1,
    value=>value.report.nativePolicy.consumerRevision='HEAD',value=>value.report.nativePolicy.consumerRevision=['b'.repeat(40)],
    value=>value.report.producerRevision=[revision],value=>value.report.contractDigest='0'.repeat(64)]){
    const input=candidate();change(input);
    assert.throws(()=>verifyV8ReleasePopulation(input),/source|qualification|native revision|contractDigest/);
  }
});

function directory(t){
  const temporary=mkdtempSync(join(tmpdir(),'v8-release-population-'));
  t.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const root=join(temporary,'qualification');mkdirSync(root);
  const input=candidate(),originals={};input.report.artifacts={};
  for(const [key,name]of [['cohort','support-cohort.json'],['registry','family-registry.json'],['population','population.json']]){
    const bytes=JSON.stringify(input[key],null,2)+'\n';
    input.report.artifacts[name]=sha(bytes);writeFileSync(join(root,name),bytes);originals[name]=bytes;
  }
  originals['report.json']=JSON.stringify(input.report,null,2)+'\n';
  writeFileSync(join(root,'report.json'),originals['report.json']);
  return {temporary,root,input,originals};
}

test('release population CLI retains exact metadata byte hashes without changing original evidence',t=>{
  const {temporary,root,originals}=directory(t),output=join(temporary,'population-snapshot.json'),
    script=fileURLToPath(new URL('../tools/verify-v8-release-population.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,root,'--output',output],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const snapshot=JSON.parse(readFileSync(output));
  for(const [name,bytes]of Object.entries(originals)){
    assert.equal(snapshot.inputSha256[name],sha(bytes));
    assert.equal(snapshot.inputBytes[name],Buffer.byteLength(bytes));
    assert.equal(readFileSync(join(root,name),'utf8'),bytes);
  }
  assert.deepEqual(snapshot.splitCounts,current.sourceCounts);
  const repeated=spawnSync(process.execPath,[script,root,'--output',output],{encoding:'utf8'});
  assert.notEqual(repeated.status,0);assert.match(repeated.stderr,/EEXIST/);
});

test('release population directory verification rejects changed metadata bytes with stale report bindings',t=>{
  const {root}=directory(t);const file=join(root,'family-registry.json');
  writeFileSync(file,readFileSync(file,'utf8')+'\n');
  assert.throws(()=>verifyV8ReleasePopulationDirectory(root),/exact retained population bytes/);
});
