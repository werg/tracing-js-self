import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCapabilityLedger,CAPABILITY_CASES} from '../src/training/capability-ledger.js';

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
