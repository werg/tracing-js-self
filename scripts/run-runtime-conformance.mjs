#!/usr/bin/env node
// Exact, byte-verified official bodies executed by the owned bounded machine.
// Only the selected non-strict scalar harness profile is claimed.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { verifySuiteFile } from '../src/test262-baseline.js';
import { createSpecOracle } from '../src/spec-oracle.js';
import { TEST262_RUNTIME_PROFILE, executeRuntimeTest262, prepareRuntimeTest262Source,
  summarizeRuntimeTest262 } from '../src/test262-runtime.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/targets.lock.json', import.meta.url), 'utf8'));
const slice = JSON.parse(readFileSync(new URL('../coverage/test262-runtime.lock.json', import.meta.url), 'utf8'));
assert.equal(slice.schema, 'test262-runtime-slice/1');
assert.equal(slice.profile, TEST262_RUNTIME_PROFILE);
assert.equal(slice.suiteCommit, profile.conformanceSuiteRevisions.test262);
assert.match(slice.suiteCommit, /^[0-9a-f]{40}$/);
assert(slice.tests.length > 0, 'Empty Test262 execution slice');
assert.equal(new Set(slice.tests.map(entry => entry.path)).size, slice.tests.length, 'Duplicate Test262 file');

const options = { root: null, output: null, oracle: false };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--oracle') { options.oracle = true; continue; }
  const key = arg === '--suite-root' || arg === '--root' ? 'root' : arg === '--output' ? 'output' : null;
  if (!key || !args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error('Usage: node scripts/run-runtime-conformance.mjs [--suite-root path/to/test262] [--output report.json] [--oracle]');
  if (options[key] !== null) throw new Error(`Duplicate option ${arg}`);
  options[key] = args[++index];
}

let oracle = null, oracleInfo = null;
if (options.oracle) {
  const pkg = JSON.parse(readFileSync(new URL('../node_modules/@engine262/engine262/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, profile.referenceEngine.npmVersion, 'Unpinned engine262 package');
  oracle = await createSpecOracle();
  oracleInfo = { name: 'engine262', revision: profile.referenceEngine.upstreamCommit,
    packageVersion: pkg.version, traceAuthority: false };
}

async function getTest(path) {
  if (options.root) return readFile(join(resolve(options.root), path));
  const response = await fetch(`https://raw.githubusercontent.com/tc39/test262/${slice.suiteCommit}/${path}`,
    { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Cannot fetch pinned fixture ${path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) throw new Error(`Oversized Test262 fixture: ${path}`);
  return bytes;
}

const rows = [];
for (const entry of slice.tests) {
  assert(['passed', 'unsupported'].includes(entry.expectedStatus), `Invalid baseline status for ${entry.path}`);
  if (entry.expectedStatus === 'passed')
    assert(Number.isSafeInteger(entry.expectedAssertions) && entry.expectedAssertions > 0, 'Missing assertion count pin');
  // Validate the pinned path before using it for a local read or network fetch.
  assert.match(entry.path, /^test\/language\/[a-zA-Z0-9_./-]+\.js$/);
  assert(!entry.path.split('/').some(part => part === '.' || part === '..'), 'Invalid Test262 path');
  const bytes = await getTest(entry.path);
  verifySuiteFile(entry, bytes);
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const row = { path: entry.path, gitBlobSha: entry.gitBlobSha,
    ...executeRuntimeTest262(source, { url: entry.path, expectedAssertions: entry.expectedAssertions ?? null }),
    ...(entry.gap ? { declaredGap: entry.gap } : {}) };
  if (row.status === 'passed' && oracle) {
    const result = oracle.evaluateScalar(prepareRuntimeTest262Source(source), {
      url: entry.path, resultExpression: '__traceTest262Assertions'
    });
    assert.deepEqual(result, ['num', row.assertionCount], `Reference assertion count mismatch for ${entry.path}`);
    row.referencePassed = true;
  }
  row.matchesBaseline = row.status === entry.expectedStatus;
  rows.push(row);
}
const summary = summarizeRuntimeTest262(rows);
const report = {
  schema: 'test262-runtime-report/1',
  evidence: 'Unchanged official bodies executed as non-strict scripts with the declared guest scalar harness; each sealed run reconstructed and replayed. Not the complete official harness, strict-mode conformance, or a full Test262 pass count.',
  profile: TEST262_RUNTIME_PROFILE,
  suite: { repository: 'tc39/test262', commit: slice.suiteCommit, files: rows.length,
    source: 'pinned-commit-and-verified-git-blobs' },
  harness: { implementation: 'src/test262-runtime.js', operations: ['assert.sameValue', 'assert.notSameValue'],
    valueDomain: 'primitives without Symbol', guestExecuted: true,
    officialHarness: false, strictVariantsExecuted: false },
  oracle: oracleInfo, summary, rows
};
if (options.output) {
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(resolve(options.output), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ suite: report.suite, summary, oracle: oracleInfo,
  gaps: rows.filter(row => row.status !== 'passed').map(row => ({ path: row.path, status: row.status, reason: row.reason })),
  baselineChanges: rows.filter(row => !row.matchesBaseline).map(row => row.path) }, null, 2));
assert.equal(summary.failedVariants, 0, 'Test262 execution failure');
assert(rows.every(row => row.matchesBaseline), 'Pinned runtime execution baseline changed; inspect and explicitly update the ledger');
