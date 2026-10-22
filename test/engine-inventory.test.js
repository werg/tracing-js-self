import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { discoverEngineInventory, formatEngineInventory, reconcileEngineInventory,
  validateInventoryStructure, verifyEngineInventory } from '../src/engine-inventory.js';

const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
function file(path, text) {
  const bytes = Buffer.from(text);
  return { path, bytes, mode: '100644',
    gitBlobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
}
function fixture() {
  const upstream = { commit, tree, files: [
    file('src/abstract-ops/conversion.mts', [
      '/** https://tc39.es/ecma262/#sec-tonumber */',
      'export function* ToNumber(value: Value) {',
      "  const intrinsic = '%Number%';",
      '}',
      'export function overloaded(value: number): number;',
      'export function overloaded(value: string): string;',
      'export function overloaded(value: unknown) { return value; }',
      '',
    ].join('\n')),
    file('src/intrinsics/Number.mts', [
      '/** https://tc39.es/ecma262/#sec-number-constructor */',
      "realm.Intrinsics['%Number%'] = constructor;",
      "realm.Intrinsics['%Number.prototype%'] = prototype;",
      '// https://tc39.es/proposal-example/#sec-proposal-feature',
      '',
    ].join('\n')),
  ] };
  const inventory = discoverEngineInventory(upstream);
  for (const group of ['sources', 'declarations', 'clauses', 'intrinsics']) {
    for (const row of inventory[group]) row.coverage.ownership = 'unowned';
  }
  return { upstream, inventory };
}

test('inventory records exact source objects, overloads, proposals and intrinsic occurrences', () => {
  const { upstream, inventory } = fixture();
  assert.equal(inventory.sources.length, 2);
  assert.equal(inventory.declarations.length, 4, 'overload declarations remain visible in the denominator');
  assert.equal(inventory.declarations[0].generator, true);
  assert.equal(inventory.clauses.length, 3);
  assert.equal(inventory.intrinsics.length, 2);
  assert.deepEqual(inventory.intrinsics.find(row => row.id === '%Number%').locations,
    ['src/abstract-ops/conversion.mts:3', 'src/intrinsics/Number.mts:2']);
  assert.deepEqual(JSON.parse(formatEngineInventory(inventory)), inventory);
  const result = verifyEngineInventory(inventory, upstream);
  assert.equal(result.upstreamVerified, true);
  assert.equal(result.completeEcma262, false);
  assert.equal(result.counts.declarations.untested, 4);
});

test('source audit rejects altered bytes, files, revision pins and omitted discoveries', () => {
  const { upstream, inventory } = fixture();
  const tamperedBytes = structuredClone(upstream);
  tamperedBytes.files[0].bytes = Buffer.from('export function Fake() {}');
  assert.throws(() => verifyEngineInventory(inventory, tamperedBytes), /blob mismatch/);
  const missing = structuredClone(inventory);
  missing.declarations.pop();
  assert.throws(() => verifyEngineInventory(missing, upstream), /discovery mismatch in declarations/);
  const added = structuredClone(upstream);
  added.files.push(file('src/abstract-ops/new.mts', 'export function NewOperation() {}\n'));
  assert.throws(() => verifyEngineInventory(inventory, added), /discovery mismatch in sources/);
  assert.throws(() => verifyEngineInventory(inventory, { ...upstream, tree: 'c'.repeat(40) }), /commit\/tree mismatch/);
  assert.throws(() => validateInventoryStructure(inventory, { expectedCommit: 'd'.repeat(40) }), /profile commit mismatch/);
  assert.throws(() => discoverEngineInventory({ ...upstream,
    files: [file('src/../outside.mts', '')] }), /source path/);
  assert.throws(() => discoverEngineInventory({ ...upstream,
    files: [...upstream.files, upstream.files[0]] }), /duplicate source path/);
});

test('new or changed discovery candidates require explicit reclassification', () => {
  const { upstream, inventory } = fixture();
  assert.throws(() => validateInventoryStructure(discoverEngineInventory(upstream)), /unclassified/);
  const changed = { ...upstream, files: [...upstream.files,
    file('src/runtime-semantics/new.mts', 'export function* NewOperation() {}\n')] };
  const candidate = reconcileEngineInventory(inventory, discoverEngineInventory(changed));
  assert.equal(candidate.sources[0].coverage.ownership, 'unowned');
  assert.equal(candidate.declarations.at(-1).coverage.ownership, 'unclassified');
  assert.throws(() => validateInventoryStructure(candidate), /unclassified/);
  const modified = structuredClone(upstream);
  modified.files[0] = file(modified.files[0].path, Buffer.from(modified.files[0].bytes).toString() + '// changed\n');
  const changedSource = reconcileEngineInventory(inventory, discoverEngineInventory(modified));
  assert.equal(changedSource.sources[0].coverage.ownership, 'unclassified', 'changed content invalidates its prior source classification');
  assert.equal(changedSource.declarations[0].coverage.ownership, 'unclassified', 'unchanged declaration locations do not hide a changed function body');
  assert.equal(changedSource.clauses.find(row => row.id.endsWith('#sec-tonumber')).coverage.ownership, 'unclassified');
  assert.equal(changedSource.intrinsics.find(row => row.id === '%Number%').coverage.ownership, 'unclassified');
});

test('partial ownership needs an explicit bounded mapping and cannot manufacture test passes', () => {
  const { upstream, inventory } = fixture();
  const row = inventory.declarations[0];
  row.coverage = { ownership: 'partial-owned', execution: 'untested', mapping: 'primitive-only/1' };
  assert.throws(() => validateInventoryStructure(inventory), /unknown ownership mapping/);
  inventory.mappings.push({ id: 'primitive-only/1', ownership: 'partial-owned',
    domain: 'Primitive inputs only', limitations: ['Objects are unsupported'],
    implementation: ['src/spec-operations.js'], entries: [{ group: 'declarations', id: row.id }] });
  assert.equal(verifyEngineInventory(inventory, upstream).counts.declarations.partialOwned, 1);
  const falselyPassed = structuredClone(inventory);
  falselyPassed.declarations[0].coverage.execution = 'passed';
  assert.throws(() => validateInventoryStructure(falselyPassed), /unsupported execution evidence/);
  const complete = structuredClone(inventory);
  complete.declarations[0].coverage.ownership = 'complete';
  assert.throws(() => validateInventoryStructure(complete), /unclassified/);
  inventory.mappings[0].entries = [{ group: 'declarations', id: 'absent' }];
  assert.throws(() => validateInventoryStructure(inventory), /unresolved/);
});

test('classification audit rejects duplicate entries and unknown extractor rules', () => {
  const { inventory } = fixture();
  const duplicate = structuredClone(inventory);
  duplicate.clauses.push(duplicate.clauses[0]);
  assert.throws(() => validateInventoryStructure(duplicate), /duplicate clauses entry/);
  const extractor = structuredClone(inventory);
  extractor.extraction.version++;
  assert.throws(() => validateInventoryStructure(extractor), /extraction rules/);
  const omitted = structuredClone(inventory);
  delete omitted.intrinsics[0].coverage;
  assert.throws(() => validateInventoryStructure(omitted), /unclassified/);
});

test('checked-in inventory is classified against the authoritative engine pin', () => {
  const inventory = JSON.parse(readFileSync(new URL('../coverage/engine262-inventory.json', import.meta.url), 'utf8'));
  const profile = JSON.parse(readFileSync(new URL('../profiles/targets.lock.json', import.meta.url), 'utf8'));
  const result = validateInventoryStructure(inventory, { expectedCommit: profile.referenceEngine.upstreamCommit });
  assert.equal(result.upstreamVerified, false, 'offline classification checks do not imply source-byte verification');
  assert.equal(result.counts.sources.total, 377);
  assert.equal(result.counts.declarations.total, 2028);
  assert.equal(result.counts.clauses.total, 1845);
  assert.equal(result.counts.intrinsics.total, 157);
  for (const count of Object.values(result.counts)) assert.equal(count.unclassified, 0);
});
