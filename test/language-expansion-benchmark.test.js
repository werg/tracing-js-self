import test from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGE_EXPANSION_FAMILIES,LANGUAGE_EXPANSION_INTERACTIONS} from '../fixtures/language-expansion/benchmark.js';
import {expansionManifest,validateExpansionManifest,validateExpansionReferencePopulation,expansionRealSourceSlice,
  expansionFamilyRegistry,expansionInteractionCases,expansionCoveragePopulation} from '../src/semantic/expansion-benchmark.js';
import {encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';

const familyInputCount=LANGUAGE_EXPANSION_FAMILIES.reduce((sum,family)=>sum+family.inputs.length,0);
const familyExecutionCount=LANGUAGE_EXPANSION_FAMILIES.reduce((sum,family)=>
  sum+family.inputs.length*family.variants.length,0);
const negativeCount=LANGUAGE_EXPANSION_FAMILIES.reduce((sum,family)=>sum+family.negatives.length,0);

test('declared benchmark has semantic breadth and independent executable near misses',()=>{
  assert.ok(LANGUAGE_EXPANSION_FAMILIES.length>=20);assert.ok(LANGUAGE_EXPANSION_INTERACTIONS.length>=12);
  assert.ok(LANGUAGE_EXPANSION_FAMILIES.every(row=>row.variants.length>=3&&row.negatives.length>=2&&row.inputs.length>=8));
  const report=validateExpansionReferencePopulation();
  for(const family of report.families){
    for(const row of family.positiveReference)assert.equal(row.status,'passed',family.id+' input '+row.inputIndex+': '+JSON.stringify(row));
    for(const row of family.distinguishingPairs){assert.equal(row.status,'passed',family.id+' negative '+row.id+': '+JSON.stringify(row));
      assert.notEqual(row.normalizationSeparation.status,'failed',family.id+' false merge '+row.id);}
  }
  assert.equal(report.totals.positiveExecutions,familyExecutionCount);
  assert.equal(report.totals.distinguishingPassed,negativeCount);
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

test('interaction admission materializes mutable guest inputs from frozen declarations',()=>{
  const cases=expansionInteractionCases(),again=expansionInteractionCases();
  for(const id of ['iteration-break-finally','closure-alias-mutation']){
    const declared=LANGUAGE_EXPANSION_INTERACTIONS.find(row=>row.id===id),fixture=cases.find(row=>row.id===id);
    assert(Object.isFrozen(declared.args[0]));
    assert(!Object.isFrozen(fixture.args[0]));
    assert.deepEqual(fixture,declared);
    assert.doesNotThrow(()=>encodeGenerationTask({kind:'source',traceVersion:8,fixture}));
    fixture.args[0].changed=true;
    assert.equal(declared.args[0].changed,undefined);
    assert.equal(again.find(row=>row.id===id).args[0].changed,undefined);
  }
  assert.equal(cases.filter(row=>row.modules).length,LANGUAGE_EXPANSION_INTERACTIONS.filter(row=>row.modules).length);
});

test('run population retains exact source, input and module denominators before results',()=>{
  const all=expansionCoveragePopulation();
  const sourceInteractions=LANGUAGE_EXPANSION_INTERACTIONS.filter(row=>row.source),
    moduleInteractions=LANGUAGE_EXPANSION_INTERACTIONS.filter(row=>row.modules),real=expansionRealSourceSlice().cases;
  assert.equal(all.scripts.length,familyExecutionCount+sourceInteractions.length+real.length);
  assert.deepEqual(all.modules,moduleInteractions);
  const expectedIds=[];
  for(const family of LANGUAGE_EXPANSION_FAMILIES)for(const variant of family.variants)
    for(const [index,args]of family.inputs.entries()){
      const id=variant.id+'-input-'+index,fixture=all.scripts.find(row=>row.id===id);
      assert(fixture,id+': every declared variant/input pair is retained');expectedIds.push(id);
      assert.equal(fixture.source,variant.source);assert.equal(fixture.entry,family.entry);
      assert.equal(fixture.family,family.family);assert.deepEqual(fixture.args,args);
    }
  for(const fixture of [...sourceInteractions,...real]){
    assert.deepEqual(all.scripts.find(row=>row.id===fixture.id),fixture);expectedIds.push(fixture.id);
  }
  expectedIds.push(...moduleInteractions.map(row=>row.id));
  const actualIds=[...all.scripts,...all.modules].map(row=>row.id);
  assert.equal(new Set(actualIds).size,actualIds.length);
  assert.deepEqual(actualIds.sort(),expectedIds.sort());
  for(const fixture of [...all.scripts,...all.modules]){
    const encoded=encodeGenerationTask({kind:fixture.modules?'module':'source',traceVersion:8,fixture});
    assert.equal(encoded.fixture.source,fixture.source);
    assert.deepEqual(encoded.fixture.modules,fixture.modules);
    assert.equal(encoded.fixture.args,undefined);
    assert.equal(encoded.fixture.argsGraph.roots.length,fixture.args.length);
  }
  assert.equal(expansionCoveragePopulation({population:'families',allInputs:false}).scripts.length,
    LANGUAGE_EXPANSION_FAMILIES.reduce((sum,family)=>sum+family.variants.length,0));
  assert.equal(expansionCoveragePopulation({population:'families'}).modules.length,0);
  assert.deepEqual(expansionCoveragePopulation({population:'interactions'}).scripts,sourceInteractions);
  assert.deepEqual(expansionCoveragePopulation({population:'gallery'}).scripts,SEMANTIC_GALLERY_FIXTURES);
  assert.deepEqual(expansionCoveragePopulation({population:'real-source'}).scripts,real);
  assert.throws(()=>expansionCoveragePopulation({population:'successful-only'}),/Unknown/);
});

test('v8 reference reports check current /2 cores and preserve all executed distinguishing pairs',()=>{
  const report=validateExpansionReferencePopulation({traceVersion:8});
  assert.equal(report.normalizedCoreSchema,'semantic-algorithm/2');
  assert.equal(report.traceVersion,8);
  assert.equal(report.totals.positiveExecutions,familyExecutionCount);
  assert.equal(report.totals.positivePassed,familyInputCount);
  assert.equal(report.totals.distinguishingPassed,negativeCount);
  assert(report.families.find(row=>row.id==='array-map-affine').sourceRecognition.some(row=>row.status==='passed'));
  for(const family of report.families)for(const row of family.distinguishingPairs)
    assert.notEqual(row.normalizationSeparation.status,'failed',family.id+' false merge '+row.id);
  assert.throws(()=>validateExpansionReferencePopulation({traceVersion:6}),/supported trace version/);
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
