import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRuntimeTest262, parseRuntimeTest262Metadata, prepareRuntimeTest262Source,
  scalarHarnessSource, summarizeRuntimeTest262,executeRuntimeTest262Variants } from '../src/test262-runtime.js';
import {Runtime} from '../src/runtime.js';

const fixture = (body, metadata = '') => `/*---\ndescription: focused harness regression\n${metadata}---*/\n${body}`;

test('runtime metadata keeps exact scalar-profile modes and missing harness capabilities', () => {
  assert.deepEqual(parseRuntimeTest262Metadata(fixture('assert.sameValue(1, 1);', 'features: [BigInt, exponentiation]\n')), {
    flags: [], features: ['BigInt', 'exponentiation'], variant: 'non-strict-script',
    requestedVariants: ['non-strict-script', 'strict-script'], omittedVariants: ['strict-script']
  });
  assert.deepEqual(parseRuntimeTest262Metadata(fixture('', 'flags: [noStrict]\n')).omittedVariants, []);
  assert.equal(parseRuntimeTest262Metadata(fixture('', 'flags: [onlyStrict]\n')).variant,'strict-script');
  assert.deepEqual(parseRuntimeTest262Metadata(fixture('', 'flags:\n  - noStrict\n')).requestedVariants,['non-strict-script']);
  for (const metadata of [
    'flags: [module]\n', 'flags: [async]\n', 'flags: [raw]\n',
    'includes: [assert.js]\n', 'features: [Symbol]\n',
    'flags: [noStrict, noStrict]\n', 'flags: []\nflags: []\n', 'flags [module]\n'
  ]) assert.throws(() => parseRuntimeTest262Metadata(fixture('', metadata)), /Unsupported|Duplicate|Invalid|Malformed/);
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
  ]), { files: 3, variants:3, executedVariants: 2, passedVariants: 1, failedVariants: 1, unsupportedVariants: 1,
    resourceLimitedVariants:0,infrastructureErrorVariants:0,
    omittedStrictVariants: 2, executedAssertions: 3 });
});

test('strict and sloppy variants execute as separate original scripts',()=>{
  const source=fixture('let x=3;assert.sameValue(x,3);');
  const rows=executeRuntimeTest262Variants(source,{includeBundle:true});
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.metadata.variant),['non-strict-script','strict-script']);
  for(const row of rows){
    assert.equal(row.status,'passed',row.reason);
    assert.equal(row.assertionCount,1);
    assert(row.bundle.sources[0].text.endsWith(source));
    assert.deepEqual(row.metadata.omittedVariants,[]);
  }
  assert(rows[1].bundle.sources[0].text.startsWith('"use strict";\n'));
  const summary=summarizeRuntimeTest262(rows);
  assert.equal(summary.files,1);
  assert.equal(summary.variants,2);
  assert.equal(summary.executedVariants,2);
  assert.equal(summary.omittedStrictVariants,0);
});

test('the scalar harness cannot suppress an original strict directive or strict early errors',()=>{
  const source=fixture('"use strict";function check(){return this===undefined;}assert.sameValue(check(),true);','flags: [noStrict]\n');
  const result=executeRuntimeTest262(source,{includeBundle:true});
  assert.equal(result.status,'passed',result.reason);
  assert(result.bundle.sources[0].text.startsWith('"use strict";\n'));
  const invalid=executeRuntimeTest262(fixture('let eval=1;assert.sameValue(eval,1);','flags: [onlyStrict]\n'));
  assert.equal(invalid.status,'failed');
  assert.equal(invalid.phase,'parse');
  assert.equal(invalid.executionPerformed,false);
});

test('parse negatives never run source and cannot be satisfied by bounded compiler refusals',()=>{
  const metadata='negative:\n  phase: parse\n  type: SyntaxError\n';
  const parsed=executeRuntimeTest262(fixture('let = ;',metadata));
  assert.equal(parsed.status,'passed');
  assert.equal(parsed.phase,'parse');
  assert.equal(parsed.executionPerformed,false);
  assert.equal(parsed.assertionCount,0);
  const unsupportedButValid=executeRuntimeTest262(fixture('const f=()=>1;',metadata));
  assert.equal(unsupportedButValid.status,'failed');
  assert.equal(unsupportedButValid.phase,'parse');
  assert.match(unsupportedButValid.reason,/parsed successfully/);
});

test('runtime negatives require a verified guest Error completion with the correct type',()=>{
  const metadata='features: [BigInt]\nnegative:\n  phase: runtime\n  type: TypeError\n';
  const result=executeRuntimeTest262(fixture('let value=1n+1;',metadata));
  assert.equal(result.status,'passed',result.reason);
  assert.equal(result.trace.replayed,true);
  assert.equal(result.completion.type,'throw');
  assert.equal(result.completion.errorType,'TypeError');
  for(const source of ['throw "TypeError";','let value=1n/0n;','assert.sameValue(1,1);'])
    assert.equal(executeRuntimeTest262(fixture(source,metadata)).status,'failed',source);
  const unsupported=executeRuntimeTest262(fixture('function f(){}let value=f+1;',metadata));
  assert.equal(unsupported.status,'unsupported');
});

test('resource exhaustion and broken verification never count as guest negative successes',t=>{
  const limited=executeRuntimeTest262(fixture('while(true){}'),{maxSteps:12});
  assert.equal(limited.status,'resource_limited');
  assert.match(limited.reason,/Driver safety limit/);
  const original=Runtime.prototype.exportRun;
  t.mock.method(Runtime.prototype,'exportRun',function(){const bundle=original.call(this);bundle.manifest.schema='invalid';return bundle;});
  const broken=executeRuntimeTest262(fixture('let value=1n+1;',
    'negative:\n  phase: runtime\n  type: TypeError\n'));
  assert.equal(broken.status,'infrastructure_error');
  assert.equal(broken.phase,'verification');
});
