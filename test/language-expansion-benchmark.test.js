import test from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGE_EXPANSION_FAMILIES,LANGUAGE_EXPANSION_INTERACTIONS} from '../fixtures/language-expansion/benchmark.js';
import {expansionManifest,validateExpansionManifest,validateExpansionReferencePopulation,expansionRealSourceSlice,
  expansionFamilyRegistry} from '../src/semantic/expansion-benchmark.js';

test('frozen benchmark has semantic breadth and independent executable near misses',()=>{
  assert.ok(LANGUAGE_EXPANSION_FAMILIES.length>=20);assert.ok(LANGUAGE_EXPANSION_INTERACTIONS.length>=12);
  assert.ok(LANGUAGE_EXPANSION_FAMILIES.every(row=>row.variants.length>=3&&row.negatives.length>=2&&row.inputs.length>=8));
  const report=validateExpansionReferencePopulation();
  for(const family of report.families){
    for(const row of family.positiveReference)assert.equal(row.status,'passed',family.id+' input '+row.inputIndex+': '+JSON.stringify(row));
    for(const row of family.distinguishingPairs){assert.equal(row.status,'passed',family.id+' negative '+row.id+': '+JSON.stringify(row));
      assert.notEqual(row.normalizationSeparation.status,'failed',family.id+' false merge '+row.id);}
  }
  assert.equal(report.totals.positiveExecutions,624);assert.equal(report.totals.distinguishingPassed,52);
});

test('real-source strata retain refusal candidates and original TS provenance',()=>{
  const slice=expansionRealSourceSlice();assert.ok(slice.inventoryDenominator>slice.cases.length);
  assert.equal(slice.strata.length,4);assert.ok(slice.cases.length>=20);
  assert.equal(slice.cases.length,new Set(slice.cases.map(row=>row.family)).size);
  assert.ok(slice.cases.some(row=>row.provenance.transform.typescript));
  const manifest=expansionManifest();assert.equal(validateExpansionManifest(manifest),true);
  const changed=structuredClone(manifest);changed.families[0].inputs[0].roots[0]=['num',7];
  assert.throws(()=>validateExpansionManifest(changed),/Frozen/);
});

test('source variants, negative relatives and transpiled source lineages cannot split',()=>{
  const registry=expansionFamilyRegistry();
  const family=registry.components.find(row=>row.members.includes('expansion:nullish-default'));
  assert.ok(family);assert.equal(family.sourceIds.length>=5,true);
  for(const row of LANGUAGE_EXPANSION_FAMILIES){
    const components=registry.components.filter(component=>component.members.includes(row.family));
    assert.equal(components.length,1,row.id);
    for(const variant of row.variants)assert.ok(components[0].sourceIds.includes(variant.id));
  }
});
