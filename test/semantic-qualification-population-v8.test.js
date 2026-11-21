import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {regionQualificationPopulation} from '../fixtures/semantic-regions/qualification.js';
import {encodeGenerationTask,decodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';
import {PRIMITIVE_CONVERSION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion.js';
import {PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion-composition.js';

test('native qualification retains every frozen family input, script and module interaction',()=>{
  const population=regionQualificationPopulation({population:'all'});
  assert.equal(population.scripts.length,663);
  assert.equal(population.modules.length,2);
  const cases=[...population.scripts,...population.modules];
  assert.equal(new Set(cases.map(row=>row.id)).size,665);
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
  assert.equal(selected.scripts.length,63);
  assert.equal(selected.modules.length,3);
  assert.equal(new Set([...selected.scripts,...selected.modules].map(row=>row.id)).size,66);
  assert.deepEqual(selected.modules.map(row=>row.id),['module-namespace-shadow-live',
    'module-scoped-var-isolation','module-destructured-live-cells']);
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
  assert.equal(regionQualificationPopulation({population:'gallery'}).scripts.length,11);
  assert.throws(()=>regionQualificationPopulation({population:'unknown'}),/Unknown/);
});

test('complete ordinary inventory preserves cyclic callback inputs through durable JSON',()=>{
  const population=regionQualificationPopulation(),fixtures=[...population.scripts,...population.modules];
  assert.throws(()=>JSON.stringify(fixtures),/circular/);
  const frozen=JSON.parse(JSON.stringify(fixtures.map(fixture=>encodeGenerationTask({
    kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision:'frozen-test'}))));
  assert.equal(frozen.length,66);
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

test('conversion qualification extends the original 47 unchanged and retains five explicit candidate refusals',()=>{
  const population=regionQualificationPopulation(),fixtures=[...population.scripts,...population.modules];
  const original=fixtures.filter(fixture=>!fixture.family.startsWith('primitive-conversion:'));
  assert.equal(original.length,47);
  // A byte-level receipt covers the complete original ordered fixture inputs,
  // including cyclic arguments, rather than just the selected case names.
  const encoded=original.map(fixture=>encodeGenerationTask({kind:fixture.modules?'module':'source',
    traceVersion:8,fixture,producerRevision:'frozen-test'}));
  assert.equal(createHash('sha256').update(JSON.stringify(encoded)).digest('hex'),
    '60fd28bdbb54bc4e144414422a8ff23caa036a573191d64857baa6cb6d6a6ae8');
  const inventory=[...PRIMITIVE_CONVERSION_FIXTURES,...PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES];
  assert.equal(inventory.length,24);
  const positives=inventory.filter(fixture=>!fixture.boundary),refusals=inventory.filter(fixture=>fixture.boundary);
  assert.equal(positives.length,19);
  assert.equal(refusals.length,5);
  assert.deepEqual(population.scripts.slice(44),positives);
  for(const fixture of refusals)assert.ok(!fixtures.some(row=>row.id===fixture.id),fixture.id);
  population.scripts[44].fixture.calls.push({});
  assert.deepEqual(regionQualificationPopulation().scripts[44].fixture.calls,[]);
});
