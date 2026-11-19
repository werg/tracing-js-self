import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {regionQualificationPopulation} from '../fixtures/semantic-regions/qualification.js';
import {encodeGenerationTask,decodeGenerationTask} from '../src/corpus/generation-process.mjs';

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
  assert.equal(selected.scripts.length,declared.cases.length+3);
  for(const row of declared.cases)assert.deepEqual(selected.scripts.find(fixture=>fixture.id===row.id),row.fixture);
  const first=selected.scripts.find(row=>row.id==='ordered-map');
  first.args[0].push(99);
  assert.deepEqual(regionQualificationPopulation().scripts.find(row=>row.id==='ordered-map').args,[[2,3,4]]);
  assert.equal(regionQualificationPopulation({population:'gallery'}).scripts.length,11);
  assert.throws(()=>regionQualificationPopulation({population:'unknown'}),/Unknown/);
});
