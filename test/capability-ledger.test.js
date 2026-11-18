import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCapabilityLedger,CAPABILITY_CASES} from '../src/training/capability-ledger.js';
import {readFileSync} from 'node:fs';

test('capability ladder preserves untested stages and exact attempted denominators',async()=>{
  const report=await buildCapabilityLedger({cases:CAPABILITY_CASES.filter(row=>
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
  const nativePolicy=JSON.parse(readFileSync(new URL('../contracts/native-admission-policy-v5.json',import.meta.url),'utf8'));
  const report=await buildCapabilityLedger({producerRevision:'a'.repeat(40),nativePolicy,
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
