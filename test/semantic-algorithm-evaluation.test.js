import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AlgorithmExecutionHarness} from '../src/semantic/harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {evaluateTerm} from '../src/semantic/operations.js';
import {encodeAlgorithmRecord,decodeAlgorithmRecord} from '../src/semantic/trace-codec.js';
import {auditAlgorithmCosts,pairedDistribution,compareFrozenBaseline,
  compareSemanticRepresentations,evaluateNegativeFamilies} from '../src/semantic/evaluation.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {inspectSemanticEpisode} from '../src/training/semantic-trace-gallery.js';
import {buildSemanticAlgorithmContract} from '../tools/generate-semantic-algorithm-contract.mjs';

const source='"use strict";function run(a){return a+1;}';
const fixture={id:'increment',family:'increment/1',source,entry:'run',args:[4],fixture:{calls:[]}};
const byteLength=value=>Buffer.byteLength(value,'utf8');

function selectedPure(){
  const harness=new AlgorithmExecutionHarness({source,entry:'run',args:[4]}),contexts=[];
  while(!harness.controller.completion){
    const step=harness.controller.nextStep();contexts.push(harness.modelContext());
    const record=step.kind==='compute'?{...step,result:evaluateTerm(step.term,harness.controller.environment())}:
      {kind:step.kind,value:evaluateTerm(step.value,harness.controller.environment())};
    harness.select(encodeAlgorithmRecord(record));
  }
  return {episode:harness.exportEpisode(),contexts};
}

test('paired cost accounting partitions exact bytes and keeps tokens unavailable',async()=>{
  const {episode,contexts}=selectedPure();
  const costs=await auditAlgorithmCosts(episode,{contexts});
  const serialized=episode.timeline.map(row=>JSON.stringify(row)+'\n').join('');
  const generated=episode.timeline.filter(row=>row.mode==='generated').reduce((n,row)=>n+byteLength(row.line),0);
  assert.equal(costs.bytes.generated,generated);
  assert.equal(costs.bytes.generated+costs.bytes.observed+costs.bytes.framing,byteLength(serialized));
  assert.equal(costs.bytes.serializedTotal,byteLength(serialized));
  assert.equal(costs.tokens.status,'unavailable');
  for(const key of ['generated','observed','framing','serializedTotal'])assert.equal(costs.tokens[key],null);
  assert.equal(costs.serving.status,'measured-js-snapshots');
  assert.equal(costs.serving.boundaries,contexts.length);
  assert.equal(costs.serving.cumulativeBytes,contexts.reduce((n,row)=>n+byteLength(JSON.stringify(row)+'\n'),0));
  assert.equal(costs.serving.definitionPublications,1);
  assert.equal(costs.serving.definitionReferences,contexts.length-1);
  assert.equal(costs.serving.inputPublications,1);
  assert.equal(costs.serving.inputReferences,contexts.length-1);
  assert.equal(costs.serving.inputBytes,byteLength(JSON.stringify(contexts[0].inputGraph)));
  assert.equal(costs.serving.cacheRetrievalCost,null);
});

test('serving costs cannot be manufactured from missing contexts or unavailable definitions',async()=>{
  const {episode,contexts}=selectedPure();
  assert.equal((await auditAlgorithmCosts(episode)).serving.status,'unavailable');
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:contexts.slice(1)}),/each generated prediction/);
  const missing=structuredClone(contexts);delete missing[0].program;
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:missing}),/unavailable definition/);
  const forged=structuredClone(contexts);forged[0].program.definitionDigest='another';
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:forged}),/another definition/);
  await assert.rejects(auditAlgorithmCosts(episode,{tokenizer:{encode:()=>[1],decode:()=>''}}),/qualified/);
});

test('v7 context input references require an immutable previously published exact graph',async()=>{
  const {episode,contexts}=selectedPure();
  const missing=structuredClone(contexts);delete missing[0].inputGraph;
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:missing}),/unavailable input graph/);
  const mismatched=structuredClone(contexts);mismatched[0].inputGraph.roots[0]=['num',99];
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:mismatched}),/another input graph/);
  const unknown=structuredClone(contexts);unknown[1].input='unknown';
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:unknown}),/unavailable input graph/);
  const absent=structuredClone(contexts);delete absent[1].input;
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:absent}),/input identity missing/);
  const swapped=structuredClone(contexts);
  swapped[1].inputGraph={roots:[['num',99]],objects:[]};
  swapped[1].input=hashAlgorithmData(swapped[1].inputGraph);
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:swapped}),/changed its immutable input graph/);
  const old=structuredClone(contexts);old[1].schema='semantic-context/6';
  await assert.rejects(auditAlgorithmCosts(episode,{contexts:old}),/context version/);
});

test('cost audits reject role confusion instead of assigning it prediction loss',async()=>{
  const {episode}=selectedPure();
  const observed=structuredClone(episode);observed.timeline.push({mode:'observed',kind:'observation',line:'return 9'});
  await assert.rejects(auditAlgorithmCosts(observed),/observed input/);
  const generated=structuredClone(episode);generated.timeline.push({mode:'generated',kind:'semantic',
    line:'observe r0 as v0: fulfilled 9'});
  await assert.rejects(auditAlgorithmCosts(generated),/cannot be generated/);
});

test('frozen pairing rejects changed source, input and raw targets',()=>{
  const lines=['evaluate run(4) => 5','end return'];
  const frozen={id:'increment',source,sourceDigest:createHash('sha256').update(source).digest('hex'),
    invocationInputs:[{inputGraph:{roots:[['num',4]],objects:[]}}],metrics:{generatedTokens:null},
    records:lines.map(raw=>({targetMask:'generated',raw}))};
  const detailed={public:{traceFormat:'semantic-trace/6',timeline:lines.map(line=>({mode:'generated',line}))}};
  assert.equal(compareFrozenBaseline(frozen,fixture,detailed).status,'identical');
  assert.deepEqual(compareFrozenBaseline(frozen,{...fixture,args:[5]},detailed).mismatches,['inputs']);
  assert.deepEqual(compareFrozenBaseline(frozen,{...fixture,source:source+' '},detailed).mismatches,['source']);
  const changed=structuredClone(detailed);changed.public.timeline[0].line='evaluate run(4) => 6';
  assert.deepEqual(compareFrozenBaseline(frozen,fixture,changed).mismatches,['generated-targets']);
});

test('statistics retain missing denominators and signed paired deltas',()=>{
  assert.deepEqual(pairedDistribution([5,-2,0,null]),{cases:4,measured:3,total:3,median:0,p95:5});
  assert.deepEqual(pairedDistribution([null,null]),{cases:2,measured:0,total:null,median:null,p95:null});
  assert.equal(pairedDistribution([1,3]).median,2);
});

test('candidate contract is deterministic, checked in and rejects old formats and wrong roles',async()=>{
  const artifact=buildSemanticAlgorithmContract();
  assert.deepEqual(buildSemanticAlgorithmContract(),artifact);
  assert.equal(artifact.definition.versions.trace,'semantic-trace/7');
  assert.equal(artifact.definition.status,'candidate');
  const saved=JSON.parse(await readFile(new URL('../contracts/semantic-algorithm-v7.json',import.meta.url),'utf8'));
  assert.deepEqual(saved,artifact);
  for(const row of artifact.fixtures.canonical)assert.deepEqual(decodeAlgorithmRecord(row.line,{role:row.role}),row.record);
  for(const line of artifact.fixtures.invalid)assert.throws(()=>decodeAlgorithmRecord(line));
  for(const line of artifact.fixtures.invalidGenerated)assert.throws(()=>decodeAlgorithmRecord(line,{role:'generated'}));
  for(const line of artifact.fixtures.invalidObserved)assert.throws(()=>decodeAlgorithmRecord(line,{role:'observed'}));
});

test('negative recognition failures are distinguished from safe explicit refusals',async()=>{
  const negative=[{id:'unsafe',source,expect:'refused'}];
  const unsafe=await evaluateNegativeFamilies(negative,{recognize:()=>({})});
  assert.equal(unsafe.unsafeAdmissions,1);assert.equal(unsafe.failed,1);
  const crash=await evaluateNegativeFamilies(negative,{recognize:()=>{throw new Error('internal bug');}});
  assert.equal(crash.unsafeAdmissions,0);assert.equal(crash.failed,1);
  assert.equal(crash.rows[0].reason,'internal bug');
  const refused=await evaluateNegativeFamilies(negative,{recognize:()=>{
    const error=new TypeError('Unsupported semantic profile');error.category='unsupported.algorithm-profile';throw error;
  }});
  assert.equal(refused.passed,1);assert.equal(refused.falseMerges,0);
});

test('paired runner executes source verification, normalization and negative distinctions without claiming promotion',async()=>{
  const old=await verifyEffectfulTrainingCase(fixture);
  assert.equal(old.status,'locally_verified');
  const frozen=await inspectSemanticEpisode(old.exported,{id:fixture.id});
  const report=await compareSemanticRepresentations({baseline:{representation:'semantic-trace/6',cases:[frozen]},
    galleryFixtures:[fixture],families:[{id:'increment/1',domain:'One numeric input',inputTypes:['number'],
      description:'Add one',variants:[{id:'expression',entry:'run',source},
        {id:'renamed',entry:'run',source:'"use strict";function run(value){return value+1;}'}],cases:[[4]]}],
    negatives:[{id:'coincident-result',expect:'distinct',entry:'run',args:[2,2],
      left:'"use strict";function run(a,b){return a+b;}',
      right:'"use strict";function run(a,b){return a*b;}'},
    {id:'randomness',expect:'refused',source:'"use strict";function run(){const unused=Math.random();return 3;}'}]});
  assert.equal(report.gates.engineering.status,'passed',JSON.stringify(report.gates));
  assert.equal(report.totals.cases,3);assert.equal(report.families[0].convergence.converged,1);
  assert.equal(report.negatives.passed,2);assert.equal(report.negatives.falseMerges,0);
  assert.equal(report.gallery.rows[0].frozenBaseline.status,'identical');
  assert.equal(report.gates.native.status,'unavailable');
  assert.equal(report.gates.comprehension.status,'unmeasured');
  assert.equal(report.gates.promotion.status,'not-qualified');
  assert.equal(report.gates.learning.optimizerSteps,0);
});
