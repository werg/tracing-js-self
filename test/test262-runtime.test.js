import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRuntimeTest262, parseRuntimeTest262Metadata, prepareRuntimeTest262Source,
  scalarHarnessSource, summarizeRuntimeTest262 } from '../src/test262-runtime.js';

const fixture = (body, metadata = '') => `/*---\ndescription: focused harness regression\n${metadata}---*/\n${body}`;

test('runtime metadata admits only the explicit non-strict scalar profile', () => {
  assert.deepEqual(parseRuntimeTest262Metadata(fixture('assert.sameValue(1, 1);', 'features: [BigInt, exponentiation]\n')), {
    flags: [], features: ['BigInt', 'exponentiation'], variant: 'non-strict-script',
    requestedVariants: ['non-strict-script', 'strict-script'], omittedVariants: ['strict-script']
  });
  assert.deepEqual(parseRuntimeTest262Metadata(fixture('', 'flags: [noStrict]\n')).omittedVariants, []);
  for (const metadata of [
    'flags: [onlyStrict]\n', 'flags: [module]\n', 'flags: [async]\n', 'flags: [raw]\n',
    'flags:\n  - noStrict\n', 'includes: [assert.js]\n',
    'negative:\n  phase: runtime\n  type: TypeError\n', 'features: [Symbol]\n',
    'flags: [noStrict, noStrict]\n', 'flags: []\nflags: []\n', 'flags [module]\n'
  ]) assert.throws(() => parseRuntimeTest262Metadata(fixture('', metadata)), /Unsupported|Duplicate|Invalid/);
  assert.throws(() => parseRuntimeTest262Metadata('assert.sameValue(1, 1);'), /metadata/);
});

test('SameValue assertions execute as guest code and preserve special scalar values', () => {
  const source = fixture(`
    assert.sameValue(0 / 0, 0 / 0);
    assert.sameValue(-0, -0);
    assert.notSameValue(0, -0);
    assert.notSameValue(0 / 0, 1);
    assert.notSameValue(0n, 0);
    assert.sameValue(9007199254740993n + 2n, 9007199254740995n);
    assert.sameValue(true + null, 1);
    assert.sameValue('x' + 2, 'x2');
  `);
  const result = executeRuntimeTest262(source, { expectedAssertions: 8, includeBundle: true });
  assert.equal(result.status, 'passed', result.reason);
  assert.equal(result.assertionCount, 8);
  assert.equal(result.trace.reconstructed, true);
  assert.equal(result.trace.replayed, true);
  assert.equal(result.trace.externalAdapterCalls, 0);
  assert.equal(result.bundle.sources[0].text, `${scalarHarnessSource}\n${source}`);
  assert.equal(prepareRuntimeTest262Source(source).slice(scalarHarnessSource.length + 1), source,
    'the official body must remain byte-for-byte unchanged');
  assert(result.bundle.events.some(event => event.operation === 'call.enter'));
});

test('intentionally wrong assertions fail rather than turning execution into a parse-only pass', () => {
  for (const body of [
    'assert.sameValue(1, 2);', 'assert.sameValue(0, -0);',
    'assert.sameValue(0 / 0, 3);', 'assert.notSameValue(0 / 0, 0 / 0);',
    'assert.notSameValue(3n, 3n);'
  ]) {
    const result = executeRuntimeTest262(fixture(body));
    assert.equal(result.status, 'failed', body);
    assert.equal(result.assertionCount, 1, body);
    assert.equal(result.phase, 'execution', body);
    assert.equal(result.progress, 'runtime.failure', body);
    assert.equal(result.trace.reconstructed, true, body);
    assert.equal(result.trace.replayed, true, body);
  }
  assert.equal(executeRuntimeTest262(fixture('let x = 1;')).status, 'failed');
  assert.equal(executeRuntimeTest262(fixture('assert.sameValue(1, 1);'), { expectedAssertions: 2 }).status, 'failed');
});

test('each test gets a fresh machine and unsupported source does not run a prefix', () => {
  const first = executeRuntimeTest262(fixture('let local = 4; assert.sameValue(local, 4);'));
  assert.equal(first.status, 'passed', first.reason);
  const isolated = executeRuntimeTest262(fixture('assert.sameValue(local, 4);'));
  assert.equal(isolated.status, 'failed');
  const unsupported = executeRuntimeTest262(fixture('assert.sameValue(1, 1); let f = () => 2;'));
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.phase, 'compile');
  assert.equal(unsupported.assertionCount, undefined);
  const module = executeRuntimeTest262(fixture('assert.sameValue(1, 1);', 'flags: [module]\n'));
  assert.equal(module.status, 'unsupported');
  assert.equal(module.phase, 'metadata');
  for (const body of [
    '__traceTest262Assertions = 99;', 'let assert = 1;',
    'assert.sameValue = 1;', 'function __traceTest262SameValue(a, b) { return true; }'
  ]) {
    const collision = executeRuntimeTest262(fixture(body));
    assert.equal(collision.status, 'unsupported');
    assert.equal(collision.phase, 'compile');
  }
});

test('runtime report keeps failures, omitted strict variants and known gaps in its denominator', () => {
  assert.deepEqual(summarizeRuntimeTest262([
    { status: 'passed', assertionCount: 2, trace: { replayed: true }, metadata: { omittedVariants: ['strict-script'] } },
    { status: 'failed', assertionCount: 1, trace: { replayed: true }, metadata: { omittedVariants: [] } },
    { status: 'unsupported', metadata: { omittedVariants: ['strict-script'] } }
  ]), { files: 3, executedVariants: 2, passedVariants: 1, failedVariants: 1, unsupportedVariants: 1,
    omittedStrictVariants: 2, executedAssertions: 3 });
});
