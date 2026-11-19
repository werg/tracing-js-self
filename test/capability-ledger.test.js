import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCapabilityLedger,CAPABILITY_CASES} from '../src/training/capability-ledger.js';
import {readFileSync} from 'node:fs';

test('capability ladder preserves untested stages and exact attempted denominators',async()=>{
  const report=await buildCapabilityLedger({traceVersion:6,cases:CAPABILITY_CASES.filter(row=>
    ['scalar-arithmetic','class-declaration','object-create-descriptors'].includes(row.id))});
  const byId=Object.fromEntries(report.rows.map(row=>[row.id,row]));
  assert.equal(byId['scalar-arithmetic'].stages.independentIntermediate,'passed');
  assert.equal(byId['scalar-arithmetic'].stages.nativeAdmission,'untested');
  assert.equal(byId['class-declaration'].stages.frontend,'passed');
  assert.equal(byId['class-declaration'].stages.ownedEvaluation,'passed');
  assert.equal(byId['class-declaration'].stages.v6ProjectionAndPublicReplay,'unsupported');
  assert.match(byId['class-declaration'].reason,/class\/private state/);
  assert.equal(byId['object-create-descriptors'].stages.frontend,'passed');
  assert.equal(byId['object-create-descriptors'].stages.ownedEvaluation,'unsupported');
  for(const counts of Object.values(report.totals)){
    assert.equal(counts.total,3);
    assert.equal(counts.attempted,counts.passed+counts.failed+counts.unsupported+counts.resource_limited);
    assert.equal(counts.total,counts.attempted+counts.untested);
  }
  assert.equal(report.totals.modelEvaluation.untested,3);
});

test('capability ladder executes a configured native gate and retains its failure separately',async()=>{
  let attempts=0;
  const nativePolicy=JSON.parse(readFileSync(new URL('../contracts/native-admission-policy-v6.json',import.meta.url),'utf8'));
  const report=await buildCapabilityLedger({traceVersion:6,producerRevision:'a'.repeat(40),nativePolicy,
    cases:CAPABILITY_CASES.filter(row=>['scalar-arithmetic','class-declaration'].includes(row.id)),
    nativeConsumer:async()=>{attempts++;throw new Error('native fixture deliberately rejected');}});
  assert.equal(attempts,1);
  const row=report.rows.find(row=>row.id==='scalar-arithmetic');
  assert.equal(row.stages.independentOutcome,'passed');
  assert.equal(row.stages.independentIntermediate,'passed');
  assert.equal(row.stages.nativeAdmission,'failed');
  assert.match(row.reason,/deliberately rejected/);
  assert.equal(report.totals.nativeAdmission.attempted,1);
  assert.equal(report.totals.nativeAdmission.untested,1);
  assert.equal(report.totals.modelEvaluation.untested,2);
});

test('primitive numeric conversions and caught BigInt errors have independent positive probes',async()=>{
  const ids=['primitive-number-conversion','primitive-bigint-conversion','primitive-string-conversion','invalid-bigint-catch-and-throw'];
  const report=await buildCapabilityLedger({traceVersion:6,cases:CAPABILITY_CASES.filter(row=>ids.includes(row.id))});
  assert.equal(report.rows.length,ids.length);
  for(const row of report.rows){
    assert.equal(row.disposition,'locally_verified',row.id+': '+row.reason);
    for(const stage of ['frontend','ownedEvaluation','independentOutcome','independentIntermediate','v6ProjectionAndPublicReplay'])
      assert.equal(row.stages[stage],'passed',row.id+': '+stage);
    assert.equal(row.stages.nativeAdmission,'untested');
    assert.equal(row.stages.modelEvaluation,'untested');
  }
});

test('v7 ladder measures compact and detailed separately without native or model claims',async()=>{
  const report=await buildCapabilityLedger({producerRevision:'b'.repeat(40),cases:CAPABILITY_CASES.filter(row=>
    ['scalar-arithmetic','alias-preserving-mutation','class-declaration'].includes(row.id))});
  assert.equal(report.schema,'semantic-capability-ledger/3');
  assert.equal(report.contracts.trace,'semantic-trace/7');
  const byId=Object.fromEntries(report.rows.map(row=>[row.id,row]));
  assert.equal(byId['scalar-arithmetic'].stages.compactRecognition,'passed');
  assert.equal(byId['scalar-arithmetic'].stages.detailedFallback,'untested');
  assert.equal(byId['alias-preserving-mutation'].stages.compactRecognition,'unsupported');
  assert.equal(byId['alias-preserving-mutation'].stages.detailedFallback,'passed');
  assert.equal(report.coverage.episodes.wholeCompact,1);
  assert.equal(report.coverage.episodes.whollyDetailed,1);
  assert.equal(report.coverage.regions.unmeasuredEpisodes,1);
  assert.equal(report.coverage.tokens.detailedShare,null);
  assert.equal(report.totals.modelComprehension.untested,3);
  assert.equal(report.totals.nativeAdmission.untested,3);
  assert.equal(report.totals.normalizationConvergence.untested,3);
  assert.match(report.populationDigest,/^[a-f0-9]{64}$/);
});

test('v8 coverage cannot be manufactured by relabeling a v7 artifact',async()=>{
  await assert.rejects(buildCapabilityLedger({traceVersion:8,cases:[]}),/real compiler/);
  await assert.rejects(buildCapabilityLedger({traceVersion:8,
    contracts:{execution:'semantic-execution/8',trace:'semantic-trace/8'},
    cases:[CAPABILITY_CASES[0]],verifyCase:async fixture=>{
      const {verifyAlgorithmTrainingCase}=await import('../src/semantic/compiler.js');
      return verifyAlgorithmTrainingCase(fixture);
    }}),/declared execution\/trace/);
});

test('v8 ledger uses real shared-region projection and retains source agreement across local refusal',async()=>{
  const {verifyRegionTrainingCase}=await import('../src/semantic/compiler-v8.js');
  const contracts={execution:'semantic-execution/8',trace:'semantic-trace/8',context:'semantic-context/8',continuation:'semantic-continuation/8'};
  const report=await buildCapabilityLedger({traceVersion:8,contracts,verifyCase:verifyRegionTrainingCase,
    cases:[CAPABILITY_CASES[0]]});
  assert.equal(report.rows[0].stages.compactRecognition,'passed');
  assert.equal(report.rows[0].stages.independentIntermediate,'passed');
  assert.equal(report.rows[0].stages.nativeAdmission,'untested');
  assert.equal(report.rows[0].regions.compact,1);
  const refused=await buildCapabilityLedger({traceVersion:8,contracts,cases:[CAPABILITY_CASES[0]],
    verifyCase:async()=>({status:'unsupported',phase:'projection',sourceStatus:'locally_verified',reason:'deliberate local refusal'})});
  assert.equal(refused.rows[0].stages.independentOutcome,'passed');
  assert.equal(refused.rows[0].stages.independentIntermediate,'passed');
  assert.equal(refused.rows[0].stages.projectionAndPublicReplay,'unsupported');
});

test('v8 protocol detail contributes to the same byte denominator as the actual serving path',async()=>{
  const {verifyRegionTrainingCase}=await import('../src/semantic/compiler-v8.js');
  const {auditRegionServingCosts}=await import('../src/semantic/causal-lm-v8.js');
  const contracts={execution:'semantic-execution/8',trace:'semantic-trace/8'};
  const fixture={id:'protocol-bytes',family:'protocol-bytes',sourceProfile:'training-js/1',entry:'run',args:[],fixture:{calls:[]},
    source:'"use strict";function run(){const key=Symbol("key");const object={};object[key]=3;return object[key];}'};
  const verified=await verifyRegionTrainingCase(fixture);
  assert(verified.exported,verified.reason);
  assert(verified.exported.public.timeline.some(row=>row.kind==='protocol'));
  const costs=await auditRegionServingCosts(verified.exported);
  const report=await buildCapabilityLedger({traceVersion:8,contracts,cases:[fixture],verifyCase:async()=>verified});
  assert.equal(report.rows[0].executionProfile,verified.exported.sidecar.protocolProfile);
  assert.equal(report.rows[0].publicCost.generatedBytes,costs.bytes.generated);
  assert.equal(report.rows[0].publicCost.detailedBytes,costs.bytes.detailed);
  assert.equal(report.rows[0].publicCost.detailedByteShare,1);
  assert.equal(report.rows[0].publicCost.generatedTokens,null);
});

test('progress includes frontend refusals exactly once in declared population order',async()=>{
  const calls=[],progress=[],cases=[
    {id:'refused',source:'"use strict";with({}){}',entry:'run',args:[],fixture:{calls:[]}},
    {...CAPABILITY_CASES[0],id:'accepted'},
    {...CAPABILITY_CASES[0],id:'verifier-failed'}
  ];
  const report=await buildCapabilityLedger({cases,verifyCase:async fixture=>{
    calls.push(fixture.id);
    if(fixture.id==='verifier-failed')throw new Error('deliberate source verification failure');
    return {status:'unsupported',phase:'projection',reason:'outside profile'};
  },onProgress:async(row,{fixture,result})=>{
    progress.push({id:row.id,fixtureId:fixture.id,disposition:row.disposition,result:result?.status??null});
  }});
  assert.deepEqual(calls,['accepted','verifier-failed']);
  assert.deepEqual(progress.map(row=>row.id),cases.map(row=>row.id));
  assert.deepEqual(progress.map(row=>row.fixtureId),cases.map(row=>row.id));
  assert.deepEqual(progress.map(row=>row.disposition),report.rows.map(row=>row.disposition));
  assert.equal(progress[0].result,null);
  assert.equal(progress[2].result,'failed');
});
