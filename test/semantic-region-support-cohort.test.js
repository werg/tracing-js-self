import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticRecipeFamilies,SEMANTIC_TASK_TEMPLATES} from '../src/training/recipe-fixtures.js';
import {buildRegionFamilyRegistry,verifyRegionFamilyRegistry,REGION_DATASET_SPLITS} from '../src/semantic/family-registry-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {canonicalFixturePlan} from '../src/training/fixture-broker.js';
import {decodeOwnedGraph,encodeNativeGraph} from '../src/host/graph-codec.js';
import {decodeGenerationTask,encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {buildSemanticRegionSupportCohortV8,SEMANTIC_REGION_SUPPORT_COHORT_SEED,
  SEMANTIC_REGION_SUPPORT_VARIANTS} from '../fixtures/semantic-regions/support-cohort.js';

const resign=registry=>{
  const {digest,...body}=registry;
  registry.digest=hashAlgorithmData(body);
  return registry;
};

test('fixed support cohort keeps all 16 templates and four declared variants before execution',()=>{
  const cohort=buildSemanticRegionSupportCohortV8(),recipes=semanticRecipeFamilies(),
    sourceById=new Map(cohort.registry.sources.map(source=>[source.id,source])),
    componentById=new Map(cohort.registry.components.flatMap(component=>
      component.sourceIds.map(id=>[id,component])));
  assert.equal(cohort.seed,SEMANTIC_REGION_SUPPORT_COHORT_SEED);
  assert.equal(cohort.seed,17);
  assert.equal(cohort.templateCount,16);
  assert.equal(cohort.templateCount,SEMANTIC_TASK_TEMPLATES.length);
  assert.equal(cohort.fixtureCount,64);
  assert.equal(cohort.fixtures.length,64);
  assert.equal(cohort.registry.sources.length,64);
  assert.equal(cohort.registry.diagnostics.sourceMembers,64);
  assert.deepEqual(cohort.variants,SEMANTIC_REGION_SUPPORT_VARIANTS);
  assert.deepEqual(new Set(cohort.fixtures.map(fixture=>fixture.family)),
    new Set(recipes.map(family=>family.family)));
  assert.equal(cohort.registry.diagnostics.declaredFamilies,16);
  assert.equal(cohort.registry.diagnostics.exactSourceVariants,48,
    'pure and child-teacher are the exact duplicate source variant in each template');
  assert.equal(verifyRegionFamilyRegistry(cohort.registry).valid,true);

  for(const family of recipes){
    const group=cohort.fixtures.filter(fixture=>fixture.supportCohort.template===family.template);
    assert.equal(group.length,4,family.template);
    assert.deepEqual(group.map(fixture=>fixture.supportCohort.variant),[
      'pure','callbacks-recovery','repeated-2calls','child-teacher'
    ]);
    const [pure,callbacks,repeated,child]=group;
    assert.deepEqual(group.map(fixture=>fixture.ancestorIds),
      Array.from({length:4},()=>['source-template:'+family.template]));
    for(const fixture of group){
      assert.match(fixture.id,/^se-support-[a-z0-9-]+$/,'IDs are stable, filename-safe labels');
      assert.equal(fixture.family,family.family);
      const source=sourceById.get(fixture.id);
      assert.ok(source,fixture.id);
      assert.equal(source.family,family.family);
      assert.deepEqual(source.ancestors,['source-template:'+family.template]);
      assert.equal(source.source,fixture.source);
      assert.equal(source.entry,fixture.entry);
      assert.equal(componentById.get(fixture.id).split,
        componentById.get(pure.id).split,'same-family variants inherit one frozen split');
    }
    assert.equal(callbacks.supportCohort.variant,'callbacks-recovery');
    assert.deepEqual(repeated.sessionCases,family.repeated.cases,
      'the original two repeated source calls and their original ancestry are retained');
    assert.equal(repeated.source,family.repeated.cases[0].source);
    assert.equal(repeated.entry,family.repeated.cases[0].entry);
    assert.deepEqual(repeated.ancestorIds,family.repeated.cases[0].ancestorIds);
    assert.equal(child.orchestrationTeacher,true);
    assert.equal(child.source,pure.source);
    assert.equal(child.entry,pure.entry);
    assert.equal(sourceById.get(child.id).sourceDigest,sourceById.get(pure.id).sourceDigest);
    assert.equal(sourceById.get(child.id).coreDigest,sourceById.get(pure.id).coreDigest);
    assert.notEqual(sourceById.get(pure.id).coreDigest,null,
      'the pure/child duplicate has a source-derived normalized core');
    assert.equal(componentById.get(child.id).id,componentById.get(pure.id).id,
      'the exact source/core edge keeps the pure and child members together');
    assert.deepEqual(pure.fixture,{calls:[]});
  }

  const observedCounts=Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,0]));
  for(const source of cohort.registry.sources)observedCounts[componentById.get(source.id).split]++;
  assert.deepEqual(cohort.sourceCounts,observedCounts);
  assert.equal(Object.values(cohort.sourceCounts).reduce((sum,count)=>sum+count,0),64);
  const {digest,...body}=cohort;
  assert.equal(digest,hashAlgorithmData(body),'cohort digest binds every fixture and the full registry');
  assert.ok(Object.isFrozen(cohort)&&Object.isFrozen(cohort.fixtures)&&Object.isFrozen(cohort.registry));
  assert.throws(()=>{cohort.fixtures[0].id='changed';},TypeError);
});

test('support registry rejects changed split, membership and source-derived core relations',()=>{
  const cohort=buildSemanticRegionSupportCohortV8();
  const changedSplit=structuredClone(cohort.registry);
  changedSplit.components[0].split=changedSplit.components[0].split==='train'?'test':'train';
  resign(changedSplit);
  assert.throws(()=>verifyRegionFamilyRegistry(changedSplit),/split/);

  const missingMember=structuredClone(cohort.registry);
  missingMember.sources.pop();
  resign(missingMember);
  assert.throws(()=>verifyRegionFamilyRegistry(missingMember),/membership|source relation/);

  const changedCore=structuredClone(cohort.registry);
  changedCore.sources.find(source=>source.id.endsWith('-pure')).coreDigest='0'.repeat(64);
  resign(changedCore);
  assert.throws(()=>verifyRegionFamilyRegistry(changedCore),/core/);

  const duplicatedInput=cohort.fixtures.map(fixture=>({id:fixture.id,family:fixture.family,
    ancestors:fixture.ancestorIds,source:fixture.source,entry:fixture.entry}));
  assert.deepEqual(buildRegionFamilyRegistry(duplicatedInput,{seed:17}),cohort.registry,
    'the complete fixed inventory deterministically reconstructs the frozen registry');
});

test('support-only mutable materialization round-trips all 64 authored fixtures',()=>{
  const cohort=buildSemanticRegionSupportCohortV8(),recipes=semanticRecipeFamilies(),
    recipeByTemplate=new Map(recipes.map(family=>[family.template,family]));
  const authoredFixture=fixture=>{
    const family=recipeByTemplate.get(fixture.supportCohort.template);
    switch(fixture.supportCohort.variant){
      case 'pure':return structuredClone(family.pure);
      case 'callbacks-recovery':return structuredClone(family.callbacks);
      case 'repeated-2calls':{
        const first=family.repeated.cases[0];
        return {...structuredClone(first),source:first.source,entry:first.entry,
          ancestorIds:structuredClone(first.ancestorIds),sessionCases:structuredClone(family.repeated.cases)};
      }
      case 'child-teacher':return {...structuredClone(family.pure),orchestrationTeacher:true};
      default:assert.fail('unknown support variant');
    }
  };
  const expectedDecoded=fixture=>{
    const {args,cases,sessionCases,...data}=fixture;
    return {...data,args:decodeOwnedGraph(JSON.stringify(encodeNativeGraph(args??[]))),
      ...(data.fixture?{fixture:canonicalFixturePlan(data.fixture)}:{}),
      ...(cases?{cases:cases.map(expectedDecoded)}:{}),
      ...(sessionCases?{sessionCases:sessionCases.map(expectedDecoded)}:{})};
  };

  for(const original of cohort.fixtures){
    const expected=authoredFixture(original),actual=structuredClone(original);
    delete expected.id;
    delete actual.id;
    delete actual.supportCohort;
    assert.deepEqual(actual,expected,`${original.id}: cohort inventory retains the original recipe values`);

    const task={kind:'source',traceVersion:8,producerRevision:'fixture-test',fixture:structuredClone(original)};
    const decoded=decodeGenerationTask(JSON.parse(JSON.stringify(encodeGenerationTask(task))));
    assert.deepEqual(decoded.fixture,expectedDecoded(structuredClone(original)),
      `${original.id}: mutable support-boundary materialization survives canonical task encoding`);
  }
  assert.equal(cohort.fixtures.length,64);
  assert.equal(cohort.registry.sources.length,64);
  assert.deepEqual(cohort.sourceCounts,{train:48,validation:12,test:4});
  assert.equal(cohort.digest,buildSemanticRegionSupportCohortV8().digest,
    'encoding operates on worker copies and leaves the frozen inventory identity unchanged');
});

test('generic generation encoding still refuses genuinely frozen guest values',()=>{
  const frozenArgs=Object.freeze([Object.freeze({input:1})]);
  const fixture=Object.freeze({id:'frozen-guest',source:'function run(x){return x;}',args:frozenArgs,
    fixture:Object.freeze({calls:Object.freeze([])})});
  assert.throws(()=>encodeGenerationTask({kind:'source',traceVersion:8,fixture}),
    /nonextensible object/);
});
