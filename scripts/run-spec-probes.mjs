#!/usr/bin/env node
// Independent scalar-observation smoke tests. engine262 is NOT a tracing backend.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRuntime } from '../src/runtime.js';
import { validateBundle } from '../src/validation.js';
import { replayExact } from '../src/replay.js';
import { createSpecOracle } from '../src/spec-oracle.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/targets.lock.json', import.meta.url), 'utf8'));
const suite = JSON.parse(readFileSync(new URL('../coverage/spec-probes.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../node_modules/@engine262/engine262/package.json', import.meta.url), 'utf8'));
assert.equal(pkg.version, profile.referenceEngine.npmVersion, 'Unpinned engine262');
assert.equal(suite.schema, 'bounded-spec-differential-probes/1');
const oracle = await createSpecOracle();

let count = 0;
for (const { id, source, expected } of suite.cases) {
  const reference = oracle.evaluateScalar(source, { url:`probe:${id}` });
  assert.deepEqual(reference, expected, `Reference disagrees with pinned expected result for ${id}`);
  const runtime = createRuntime().start(source);
  assert.equal(runtime.drive().kind,'terminated', `Bounded interpreter did not terminate for ${id}`);
  const records = Object.values(runtime.state.envs).flatMap(env =>
    Object.entries(env.bindings).filter(([name])=>name==='result').map(([,cell])=>cell)
  );
  assert.equal(records.length,1,`Expected exactly one result binding for ${id}`);
  assert.deepEqual(records[0].token.value,expected,`Bounded result disagrees with reference for ${id}`);
  const archive = JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(Object.keys(archive.effects).length,0,`Pure probe dispatched a host effect for ${id}`);
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  count++;
}
console.log(JSON.stringify({schema:'spec-reference-probes/1',oracle:pkg.version,
  cases:count,passed:count,evidence:'matching scalar results plus independently reconstructible bounded trace; NOT full conformance'},null,2));
