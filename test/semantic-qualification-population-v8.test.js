import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {regionQualificationPopulation,regionQualificationFixtures,sharedProtocolQualificationFixtures,
  moduleQualificationFixtures} from '../fixtures/semantic-regions/qualification.js';
import {expansionCoveragePopulation} from '../src/semantic/expansion-benchmark.js';
import {encodeGenerationTask,decodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';
import {RETURN_CALLBACK_FIXTURES} from '../fixtures/semantic-regions/return-callbacks.js';
import {PRIMITIVE_CONVERSION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion.js';
import {PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion-composition.js';

const adoptionSourceIds=['source-promise-adoption-executor','source-promise-adoption-async-return',
  'source-promise-adoption-reaction-return'];

test('native qualification retains every declared family input, script and module interaction',()=>{
  const population=regionQualificationPopulation({population:'all'});
  assert.deepEqual(population,expansionCoveragePopulation({population:'all',allInputs:true}));
  const cases=[...population.scripts,...population.modules];
  assert.equal(new Set(cases.map(row=>row.id)).size,cases.length);
  for(const fixture of cases){
    const task={kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision:'frozen-test'};
    const restored=decodeGenerationTask(JSON.parse(JSON.stringify(encodeGenerationTask(task))));
    assert.deepEqual(restored.fixture.args,fixture.args??[]);
    assert.equal(restored.fixture.id,fixture.id);
  }
});

test('interoperability includes all source goldens and returns fresh mutable guest inputs',()=>{
  const declared=JSON.parse(readFileSync(new URL('./fixtures/semantic-protocol-region-v8.json',import.meta.url),'utf8'));
  const selected=regionQualificationPopulation();
  const conversion=[...PRIMITIVE_CONVERSION_FIXTURES,...PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES]
    .filter(fixture=>!fixture.boundary);
  const expected=[...regionQualificationFixtures(),...declared.cases.map(row=>row.fixture),
    ...HOST_PROTOCOL_FIXTURES_V8,...sharedProtocolQualificationFixtures(),
    ...RETURN_CALLBACK_FIXTURES.map(({expected,callbacks,...fixture})=>({
      ...fixture,id:fixture.family.replace(/-source$/,'')})),...conversion];
  assert.deepEqual(selected.scripts,expected,'every currently declared source, input and provenance is retained');
  assert.deepEqual(selected.modules,moduleQualificationFixtures());
  assert.equal(new Set([...selected.scripts,...selected.modules].map(row=>row.id)).size,
    expected.length+selected.modules.length);
  assert.deepEqual(selected.scripts.filter(row=>row.family==='promise-adoption-source').map(row=>row.id),
    adoptionSourceIds);
  for(const fixture of selected.modules){
    const task={kind:'module',traceVersion:8,fixture,producerRevision:'frozen-test'};
    assert.deepEqual(decodeGenerationTask(JSON.parse(JSON.stringify(encodeGenerationTask(task)))).fixture,fixture);
  }
  for(const row of declared.cases)assert.deepEqual(selected.scripts.find(fixture=>fixture.id===row.id),row.fixture);
  for(const fixture of HOST_PROTOCOL_FIXTURES_V8)
    assert.deepEqual(selected.scripts.find(row=>row.id===fixture.id),fixture);
  for(const fixture of selected.scripts.filter(row=>row.id.startsWith('return-callback-'))){
    const task={kind:'source',traceVersion:8,fixture,producerRevision:'frozen-test'},
      restored=decodeGenerationTask(JSON.parse(JSON.stringify(encodeGenerationTask(task))));
    assert.equal(restored.fixture.source,fixture.source);
    assert.equal(restored.fixture.id,fixture.id);
    assert.deepEqual(restored.fixture.args,fixture.args);
  }
  assert.equal(new Set(selected.scripts.map(row=>row.id)).size,selected.scripts.length);
  for(const id of ['number-callback-cleanup','custom-iterator-close','iterable-binding-close',
    'promise-number-proxy-memory-join','promise-map-iterator','map-callback-finally-throw','map-generator-yield',
    'map-generator-iterator-close','map-sparse-live-mutation','promise-map-sparse-truncate',
    'promise-allsettled-mixed-aliases','promise-allsettled-nested-executor','promise-allsettled-empty-mutation',
    'return-callback-receiver-alias','return-callback-throw','return-callback-async','return-callback-reentrant-host'])
    assert.ok(selected.scripts.some(fixture=>fixture.id===id),id+' remains in recurring qualification');
  const first=selected.scripts.find(row=>row.id==='ordered-map');
  first.args[0].push(99);
  assert.deepEqual(regionQualificationPopulation().scripts.find(row=>row.id==='ordered-map').args,[[2,3,4]]);
  selected.modules[0].modules['leaf.js']='export let n=99;';
  assert.equal(regionQualificationPopulation().modules[0].modules['leaf.js'],'export let n=2;export function bump(){n+=3;}');
  assert.deepEqual(regionQualificationPopulation({population:'gallery'}),
    expansionCoveragePopulation({population:'gallery'}));
  assert.throws(()=>regionQualificationPopulation({population:'unknown'}),/Unknown/);
});

test('complete ordinary inventory preserves cyclic callback inputs through durable JSON',()=>{
  const population=regionQualificationPopulation(),fixtures=[...population.scripts,...population.modules];
  assert.throws(()=>JSON.stringify(fixtures),/circular/);
  const frozen=JSON.parse(JSON.stringify(fixtures.map(fixture=>encodeGenerationTask({
    kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision:'frozen-test'}))));
  assert.equal(frozen.length,fixtures.length);
  assert.deepEqual(frozen.map(task=>task.fixture.id),fixtures.map(fixture=>fixture.id));
  for(const [index,task]of frozen.entries()){
    const restored=decodeGenerationTask(task).fixture,original=fixtures[index];
    assert.deepEqual(restored.args,original.args??[]);
    assert.equal(restored.source,original.source);
    assert.deepEqual(restored.modules,original.modules);
    // Fixture responses and callback arguments use the same canonical graph
    // contract as the worker path, including aliases, cycles and special scalars.
    assert.deepEqual(encodeGenerationTask({...task,fixture:restored}),task);
  }
});

test('conversion qualification includes every declared positive and retains explicit candidate refusals',()=>{
  const population=regionQualificationPopulation(),fixtures=[...population.scripts,...population.modules];
  const inventory=[...PRIMITIVE_CONVERSION_FIXTURES,...PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES];
  const positives=inventory.filter(fixture=>!fixture.boundary),refusals=inventory.filter(fixture=>fixture.boundary);
  assert(positives.length>0);assert(refusals.length>0);
  const positiveIds=new Set(positives.map(fixture=>fixture.id));
  assert.deepEqual(population.scripts.filter(fixture=>positiveIds.has(fixture.id)),positives);
  for(const fixture of refusals)assert.ok(!fixtures.some(row=>row.id===fixture.id),fixture.id);
  const firstId=positives[0].id;
  population.scripts.find(fixture=>fixture.id===firstId).fixture.calls.push({});
  assert.deepEqual(regionQualificationPopulation().scripts.find(fixture=>fixture.id===firstId).fixture.calls,[]);
});
