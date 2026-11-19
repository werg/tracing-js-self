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
  assert.equal(byId['class-declaration'].stages.frontend,'unsupported');
  assert.equal(byId['class-declaration'].stages.ownedEvaluation,'untested');
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
