import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {regionQualificationPopulation} from '../fixtures/semantic-regions/qualification.js';
import {encodeGenerationTask,decodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';

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
  assert.equal(selected.scripts.length,44);
  assert.equal(selected.modules.length,3);
  assert.equal(new Set([...selected.scripts,...selected.modules].map(row=>row.id)).size,47);
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
