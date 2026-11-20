import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {readRetainedServingInputs,retainedServingSourceIdentity,meterRetainedServingCase,
  summarizeRetainedServingCosts} from '../src/semantic/retained-serving-costs.js';

const source='"use strict";function run(x){return x;}',input={roots:[['str','café']],objects:[]},
  sha=value=>createHash('sha256').update(value).digest('hex'),
  tokenizer={identity:'c'.repeat(64),encode:async text=>[...Buffer.from(text)],decode:async ids=>Buffer.from(ids).toString('utf8')};
function serving({detailed=false}={}){
  const representation=detailed?'detailed':'algorithm',program={source,entry:'run'},
    context={schema:'semantic-context/7',representation,...(detailed?
      {prefix:{...program,invocationId:'invocation1',committed:[{kind:'invocation',invocationId:'invocation1',inputGraph:input}]}}:
      {program,inputGraph:input})},
    prompt='Predict one complete semantic-trace/7 record from this public execution context.\n'+JSON.stringify(context)+'\nNext record:\n',
    target='return ["str","café"]',promptBytes=Buffer.byteLength(prompt),targetBytes=Buffer.byteLength(target);
  return {schema:'semantic-flat-serving-costs/1',path:'actual-semantic-causal-lm/3',byteMeasurement:'passed',representation,
    episodeDigest:'d'.repeat(64),contextsDigest:'e'.repeat(64),predictions:1,
    bytes:{generated:targetBytes,detailed:detailed?targetBytes:0,cumulativeContext:promptBytes,peakContext:promptBytes},
    rows:[{prediction:0,invocationId:'invocation1',visibleThrough:0,prompt,target,
      promptSha256:hashAlgorithmData(prompt),targetSha256:hashAlgorithmData(target),promptBytes,targetBytes,detail:detailed}]};
}
function retained(t){
  const directory=mkdtempSync(join(tmpdir(),'retained-cost-')),members=join(directory,'members');mkdirSync(members);
  t.after(()=>rmSync(directory,{force:true,recursive:true}));
  const producerRevision='a'.repeat(40),manifestDigest='b'.repeat(64),registryDigest='f'.repeat(64),
    coverage={schema:'semantic-capability-ledger/3',producerRevision,populationDigest:'1'.repeat(64),
      coverage:{episodes:{declared:2}},rows:[{id:'present',sourceDigest:hashAlgorithmData(source),disposition:'locally_verified'},
        {id:'refused',sourceDigest:hashAlgorithmData(source),disposition:'frontend-refused'}]},
    files={'coverage.json':coverage,'report.json':{producerRevision,manifestDigest,registryDigest},
      'serving-costs.json':{producerRevision,manifestDigest,rows:[{id:'present'}]},'serving-present.json':serving()};
  const entries=Object.entries(files).map(([name,value])=>{const bytes=JSON.stringify(value)+'\n';writeFileSync(join(members,name),bytes);return {name,sha256:sha(bytes)};});
  const archive=join(directory,'gallery.tar.xz');execFileSync('tar',['-cJf',archive,'-C',members,...entries.map(row=>row.name)]);
  const bytes=readFileSync(archive),summary={schema:'semantic-expansion-retained-evidence/1',producerRevision,manifestDigest,registryDigest,
    archives:[{file:'gallery.tar.xz',sha256:sha(bytes),compressedBytes:bytes.length,files:entries}],
    populations:[{id:'gallery',coverage:{episodes:{declared:2}},costs:{measuredCases:1}}]};
  const save=()=>writeFileSync(join(directory,'summary.json'),JSON.stringify(summary)+'\n');save();
  return {directory,archive,summary,save};
}

test('retrospective measurement preserves source identity exact token segments and generated-only loss',async()=>{
  for(const detailed of [false,true]){
    const baseline=serving({detailed}),result=await meterRetainedServingCase(baseline,{tokenizer,eosTokenId:1000}),row=result.rows[0];
    assert.deepEqual(await tokenizer.decode(row.promptIds),baseline.rows[0].prompt);
    assert.deepEqual(await tokenizer.decode(row.targetIds),baseline.rows[0].target);
    assert.deepEqual(row.terminalIds,[1000]);assert.equal(row.totalTokens,row.promptTokens+row.generatedTokens+1);
    assert.deepEqual(row.lossMaskRuns,[{value:0,count:row.promptIds.length},{value:1,count:row.targetIds.length+1}]);
    assert.equal(row.promptUtf8Sha256,sha(baseline.rows[0].prompt));
    assert.equal(row.promptUtf8Sha256,baseline.rows[0].promptSha256);
    assert.equal(result.sourceIdentity.sourceDigest,hashAlgorithmData(source));
    assert.equal(result.sourceIdentity.initialInputGraphDigest,hashAlgorithmData(input));
    assert.equal(result.tokens.detailedShare,detailed?1:0);assert.equal(result.model.status,'unmeasured');
    assert.equal(result.nativeServing.status,'unmeasured');
  }
});

test('retained measurement rejects rewritten bytes wrong old hashes lossy tokenization EOS and truncation',async()=>{
  for(const mutate of [row=>{row.prompt+='changed';},row=>{row.targetSha256=sha(JSON.stringify(row.target));},row=>{row.detail=true;}]){
    const report=serving();mutate(report.rows[0]);
    await assert.rejects(()=>meterRetainedServingCase(report,{tokenizer,eosTokenId:1000}),/original byte digest differs/);
  }
  const report=serving();report.bytes.generated++;
  await assert.rejects(()=>meterRetainedServingCase(report,{tokenizer,eosTokenId:1000}),/byte totals differ/);
  await assert.rejects(()=>meterRetainedServingCase(serving(),{tokenizer:{...tokenizer,decode:async()=>'wrong'},eosTokenId:1000}),/exact serializer bytes/);
  await assert.rejects(()=>meterRetainedServingCase(serving(),{tokenizer,eosTokenId:10}),/injects EOS/);
  await assert.rejects(()=>meterRetainedServingCase(serving(),{tokenizer,eosTokenId:1000,maxContextTokens:2}),/context budget/);
  const changed=serving();changed.rows[0].prompt='different framing';
  assert.throws(()=>retainedServingSourceIdentity(changed),/framing changed/);
});

test('retained archive reader binds original members producer and all declared source dispositions',t=>{
  const {directory,archive,summary,save}=retained(t),input=readRetainedServingInputs(directory);
  assert.equal(input.populations[0].rows.length,2);
  assert.equal(input.populations[0].rows[1].servingArtifact,null);
  assert.equal(input.populations[0].readArtifact('serving-present.json').predictions,1);
  assert.throws(()=>input.populations[0].readArtifact('../outside.json'),/unsafe/);
  summary.populations[0].coverage.episodes.declared=1;save();
  assert.throws(()=>readRetainedServingInputs(directory),/denominator differs/);
  summary.populations[0].coverage.episodes.declared=2;
  summary.archives[0].files.find(row=>row.name==='serving-present.json').sha256='0'.repeat(64);save();
  assert.throws(()=>readRetainedServingInputs(directory).populations[0].readArtifact('serving-present.json'),/artifact bytes changed/);
  writeFileSync(archive,Buffer.concat([readFileSync(archive),Buffer.from('changed')]));
  assert.throws(()=>readRetainedServingInputs(directory),/archive bytes changed/);
});

test('retained summary keeps missing serializers and failed measurements in its original denominator',async()=>{
  const cost=await meterRetainedServingCase(serving(),{tokenizer,eosTokenId:1000}),summary=summarizeRetainedServingCosts([
    {sourceDisposition:'locally_verified',servingArtifact:{},cost},
    {sourceDisposition:'locally_verified',servingArtifact:{},cost:{status:'resource_limited'}},
    {sourceDisposition:'frontend-refused',servingArtifact:null,cost:null}]);
  assert.equal(summary.declared,3);assert.equal(summary.serializerRetained,2);assert.equal(summary.tokenMeasured,1);
  assert.equal(summary.unmeasured,2);assert.equal(summary.tokens.total,cost.tokens.total);
  assert.deepEqual(summary.sourceDispositions,{locally_verified:2,'frontend-refused':1});
});
