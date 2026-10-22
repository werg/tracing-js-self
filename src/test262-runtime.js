// A narrow Test262 execution profile. Test bodies are never rewritten or run
// by the host; this harness is itself guest source in the owned interpreter.
import { createRuntime } from './runtime.js';
import { parse, compile } from './frontend.js';
import { validateBundle } from './validation.js';
import { replayExact } from './replay.js';

export const TEST262_RUNTIME_PROFILE = 'bounded-scalar-test262/1';

// This deliberately does not pretend to be Test262's complete assert.js or
// sta.js. It implements only scalar SameValue/notSameValue, including NaN and
// signed zero; failures are guest throws, and every call is counted.
export const scalarHarnessSource = `
let __traceTest262Assertions = 0;
function __traceTest262SameValue(actual, expected) {
  if (actual === expected) {
    if (actual === 0) { return 1 / actual === 1 / expected; }
    return true;
  }
  return actual !== actual && expected !== expected;
}
function __traceTest262AssertSameValue(actual, expected, message) {
  __traceTest262Assertions += 1;
  if (!__traceTest262SameValue(actual, expected)) {
    throw 'Test262Error: assert.sameValue';
  }
}
function __traceTest262AssertNotSameValue(actual, expected, message) {
  __traceTest262Assertions += 1;
  if (__traceTest262SameValue(actual, expected)) {
    throw 'Test262Error: assert.notSameValue';
  }
}
let assert = {
  sameValue: __traceTest262AssertSameValue,
  notSameValue: __traceTest262AssertNotSameValue
};
`;

export class Test262RuntimeProfileError extends Error {
  constructor(message) { super(message); this.name = 'Test262RuntimeProfileError'; }
}

/** Parse only the metadata forms whose meaning this profile implements. */
export function parseRuntimeTest262Metadata(source) {
  if (typeof source !== 'string') throw new TypeError('Test262 source must be text');
  const match = /\/\*---\s*\r?\n([\s\S]*?)---\*\//.exec(source);
  if (!match) throw new Test262RuntimeProfileError('Missing Test262 metadata header');
  const metadata = match[1];
  if (metadata.split(/\r?\n/).some(line => line && !/^\s/.test(line) && !/^[A-Za-z][\w-]*:/.test(line)))
    throw new Test262RuntimeProfileError('Unsupported Test262 metadata line');
  const keys = [...metadata.matchAll(/^([A-Za-z][\w-]*):/gm)].map(x => x[1]);
  if (new Set(keys).size !== keys.length)
    throw new Test262RuntimeProfileError('Duplicate Test262 metadata key');
  const descriptive = new Set(['description', 'esid', 'es5id', 'es6id', 'info', 'author']);
  for (const key of keys) {
    if (!descriptive.has(key) && !['flags', 'features'].includes(key))
      throw new Test262RuntimeProfileError(`Unsupported Test262 metadata: ${key}`);
  }
  const list = key => {
    if (!keys.includes(key)) return [];
    const line = new RegExp(`^${key}:[ \\t]*\\[([^\\]\\r\\n]*)\\][ \\t]*$`, 'm').exec(metadata);
    if (!line) throw new Test262RuntimeProfileError(`Unsupported ${key} metadata format`);
    if (!line[1].trim()) return [];
    const items = line[1].split(',').map(value => value.trim());
    if (items.some(value => !/^[A-Za-z0-9_.-]+$/.test(value)) || new Set(items).size !== items.length)
      throw new Test262RuntimeProfileError(`Invalid ${key} metadata list`);
    return items;
  };
  const flags = list('flags');
  if (flags.some(flag => flag !== 'noStrict'))
    throw new Test262RuntimeProfileError(`Unsupported Test262 flags: ${flags.join(', ')}`);
  const features = list('features');
  if (features.some(feature => !['BigInt', 'exponentiation'].includes(feature)))
    throw new Test262RuntimeProfileError(`Unsupported Test262 features: ${features.join(', ')}`);
  return {
    flags, features, variant: 'non-strict-script',
    requestedVariants: flags.includes('noStrict') ? ['non-strict-script'] : ['non-strict-script', 'strict-script'],
    omittedVariants: flags.includes('noStrict') ? [] : ['strict-script']
  };
}

export function prepareRuntimeTest262Source(source) {
  return `${scalarHarnessSource}\n${source}`;
}

function checkHarnessNames(node) {
  if (!node || typeof node !== 'object') return;
  const names = node.type === 'Identifier' ? [node.name]
    : node.type === 'Variable' ? [node.id]
      : node.type === 'Function' ? [node.id, ...node.params] : [];
  if (names.some(name => name.startsWith('__traceTest262')))
    throw new Test262RuntimeProfileError('Test body accesses a reserved harness implementation name');
  if ((node.type === 'Variable' || node.type === 'Function') && node.id === 'assert')
    throw new Test262RuntimeProfileError('Test body replaces the scalar assertion harness');
  if (node.type === 'Assign' && (node.left.type === 'Identifier' && node.left.name === 'assert'
    || node.left.type === 'Member' && node.left.object.type === 'Identifier' && node.left.object.name === 'assert'))
    throw new Test262RuntimeProfileError('Test body replaces the scalar assertion harness');
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(checkHarnessNames);
    else if (value && typeof value === 'object') checkHarnessNames(value);
  }
}

function assertions(runtime) {
  const matches = Object.values(runtime.state.envs).flatMap(env =>
    Object.entries(env.bindings).filter(([name]) => name === '__traceTest262Assertions').map(([, cell]) => cell));
  if (matches.length !== 1 || matches[0].token?.value?.[0] !== 'num') return 0;
  return matches[0].token.value[1];
}

/**
 * Execute one unchanged official body with the declared guest harness, then
 * reconstruct and replay every sealed run. Unsupported modes remain gaps.
 * Passing the selected non-strict variant does not pass its strict variant.
 */
export function executeRuntimeTest262(source, { url = '<test262-runtime>', maxSteps = 20000,
  expectedAssertions = null, includeBundle = false } = {}) {
  let metadata;
  try { metadata = parseRuntimeTest262Metadata(source); }
  catch (error) {
    if (!(error instanceof Test262RuntimeProfileError)) throw error;
    return { status: 'unsupported', phase: 'metadata', reason: error.message };
  }
  // Inspect the entire body before starting: unsupported syntax cannot be
  // hidden in an unexecuted branch, and a helper never runs before preflight.
  try { const ast = parse(source); checkHarnessNames(ast); compile(ast); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof Test262RuntimeProfileError)) throw error;
    return { status: 'unsupported', phase: 'compile', reason: error.message, metadata };
  }

  const runtime = createRuntime({ maxSteps });
  const script = prepareRuntimeTest262Source(source);
  runtime.start(runtime.registerSource({ text: script, url }));
  let progress;
  try { progress = runtime.drive(); }
  catch (error) {
    return { status: 'failed', phase: 'execution', reason: error.message,
      metadata, assertionCount: assertions(runtime) };
  }
  const bundle = runtime.exportRun();
  let structure, replay;
  try {
    structure = validateBundle(bundle);
    replay = replayExact(bundle);
  } catch (error) {
    return { status: 'failed', phase: 'verification', reason: error.message, metadata,
      assertionCount: assertions(runtime), ...(includeBundle ? { bundle } : {}) };
  }
  const assertionCount = assertions(runtime);
  const result = {
    metadata, assertionCount, progress: progress.kind,
    trace: { eventCount: structure.eventCount, chunkCount: structure.chunkCount,
      reconstructed: structure.valid, replayed: replay.valid,
      externalAdapterCalls: replay.externalAdapterCalls },
    ...(includeBundle ? { bundle } : {})
  };
  if (progress.kind === 'unsupported')
    return { ...result, status: 'unsupported', phase: 'execution', reason: 'Guest operation outside the declared profile' };
  if (progress.kind !== 'terminated')
    return { ...result, status: 'failed', phase: 'execution', reason: `Guest run ended with ${progress.kind}` };
  if (Object.keys(bundle.effects).length)
    return { ...result, status: 'failed', phase: 'execution', reason: 'Scalar test attempted a host effect' };
  if (!Number.isSafeInteger(assertionCount) || assertionCount < 1)
    return { ...result, status: 'failed', phase: 'assertions', reason: 'No guest assertions executed' };
  if (expectedAssertions !== null && assertionCount !== expectedAssertions)
    return { ...result, status: 'failed', phase: 'assertions', reason: `Expected ${expectedAssertions} assertions, observed ${assertionCount}` };
  return { ...result, status: 'passed', phase: 'execution' };
}

export function summarizeRuntimeTest262(rows) {
  return {
    files: rows.length,
    executedVariants: rows.filter(row => row.trace?.replayed).length,
    passedVariants: rows.filter(row => row.status === 'passed').length,
    failedVariants: rows.filter(row => row.status === 'failed').length,
    unsupportedVariants: rows.filter(row => row.status === 'unsupported').length,
    omittedStrictVariants: rows.reduce((sum, row) => sum + (row.metadata?.omittedVariants.length ?? 0), 0),
    executedAssertions: rows.reduce((sum, row) => sum + (row.assertionCount ?? 0), 0)
  };
}
