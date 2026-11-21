// A narrow Test262 execution profile. Test bodies are never rewritten or run
// by the host; this harness is itself guest source in the owned interpreter.
import { createRuntime } from './runtime.js';
import { parse, compile } from './frontend.js';
import { validateBundle } from './validation.js';
import { replayExact } from './replay.js';
import {parse as parseSyntax} from 'acorn';
import {parseTest262Header,conformanceDigest} from './conformance/test262-catalog.js';

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
export function parseRuntimeTest262Metadata(source, {mode=null} = {}) {
  if (typeof source !== 'string') throw new TypeError('Test262 source must be text');
  let header;
  try { header = parseTest262Header(source); }
  catch (error) { throw new Test262RuntimeProfileError(error.message); }
  const {flags,features,includes,negative}=header;
  if (flags.some(flag => !['noStrict','onlyStrict','generated'].includes(flag)))
    throw new Test262RuntimeProfileError(`Unsupported Test262 flags: ${flags.join(', ')}`);
  if(includes.length)throw new Test262RuntimeProfileError('Unsupported official harness includes in the scalar profile');
  if (features.some(feature => !['BigInt', 'exponentiation'].includes(feature)))
    throw new Test262RuntimeProfileError(`Unsupported Test262 features: ${features.join(', ')}`);
  if(negative&&!['parse','runtime'].includes(negative.phase))
    throw new Test262RuntimeProfileError('Unsupported Test262 negative phase: '+negative.phase);
  const requestedVariants=flags.includes('noStrict')?['non-strict-script']:
    flags.includes('onlyStrict')?['strict-script']:['non-strict-script','strict-script'];
  const variant=mode??requestedVariants[0];
  if(!requestedVariants.includes(variant))throw new Test262RuntimeProfileError('Unsupported requested Test262 variant: '+variant);
  return {
    flags, features, variant,requestedVariants,
    omittedVariants:requestedVariants.filter(item=>item!==variant),...(negative?{negative}:{})
  };
}

export function prepareRuntimeTest262Source(source, {mode='non-strict-script'} = {}) {
  if(!['non-strict-script','strict-script'].includes(mode))throw new TypeError('Invalid scalar Test262 source mode');
  // The separately supplied scalar harness must not suppress a test's own
  // directive prologue when concatenated. Preserve the original bytes as a suffix.
  const ast=parse(source);
  let strict=mode==='strict-script';
  for(const statement of ast.body){
    if(statement.type!=='Expression'||statement.expr.type!=='Literal'||
      statement.expr.value[0]!=='str'||statement.expr.parenthesized)break;
    if(['"use strict"',"'use strict'"].includes(statement.expr.raw))strict=true;
  }
  return `${strict?'"use strict";\n':''}${scalarHarnessSource}\n${source}`;
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
  if (node.type === 'Member' && node.object?.type === 'Identifier' &&
      node.object.name === 'assert' &&
      (node.property?.type !== 'Literal' ||
       !['sameValue', 'notSameValue'].includes(node.property.value?.[1])))
    throw new Test262RuntimeProfileError('Test body requires an unavailable assert helper');
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
function executeRuntimeTest262Variant(source, { url = '<test262-runtime>', maxSteps = 20000,
  expectedAssertions = null, includeBundle = false, mode=null } = {}) {
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1)throw new TypeError('Test262 step budget must be a positive integer');
  let metadata;
  try { metadata = parseRuntimeTest262Metadata(source,{mode}); }
  catch (error) {
    if (!(error instanceof Test262RuntimeProfileError)) throw error;
    return { status: 'unsupported', phase: 'metadata', reason: error.message };
  }
  // A bounded-parser refusal cannot satisfy an official parse-negative test.
  // Acorn checks the unchanged original script under the requested strictness
  // first; only a real grammar/early-error result can match a parse expectation.
  const syntaxSource=(metadata.variant==='strict-script'?'"use strict";\n':'')+source;
  try{parseSyntax(syntaxSource,{ecmaVersion:2026,sourceType:'script'});}
  catch(error){
    if(!(error instanceof SyntaxError))throw error;
    return {status:metadata.negative?.phase==='parse'&&metadata.negative.type==='SyntaxError'?'passed':'failed',
      phase:'parse',reason:error.message,errorType:'SyntaxError',metadata,assertionCount:0,
      parser:'acorn/8.15.0:ecmaVersion=2026',executionPerformed:false};
  }
  if(metadata.negative?.phase==='parse')return {status:'failed',phase:'parse',metadata,assertionCount:0,
    reason:'Expected parse error but original source parsed successfully',executionPerformed:false};
  // Inspect the entire body before starting: unsupported syntax cannot be
  // hidden in an unexecuted branch, and a helper never runs before preflight.
  try { const ast = parse(source); checkHarnessNames(ast); compile(ast); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof Test262RuntimeProfileError)) throw error;
    return { status: 'unsupported', phase: 'compile', reason: error.message, metadata };
  }

  const runtime = createRuntime({ maxSteps });
  const script = prepareRuntimeTest262Source(source,{mode:metadata.variant});
  runtime.start(runtime.registerSource({ text: script, url }));
  let progress;
  try { progress = runtime.drive(); }
  catch (error) {
    return { status: /^Driver safety limit \(\d+ steps\)/.test(error.message)?'resource_limited':'infrastructure_error',
      phase: 'execution', reason: error.message,
      metadata, assertionCount: assertions(runtime) };
  }
  const bundle = runtime.exportRun();
  let structure, replay;
  try {
    structure = validateBundle(bundle);
    replay = replayExact(bundle);
  } catch (error) {
    return { status: 'infrastructure_error', phase: 'verification', reason: error.message, metadata,
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
  if(progress.kind==='runtime.failure'&&metadata.negative?.phase==='runtime'){
    const completion=bundle.finalState.control.a0.failure?.completion;
    return {...result,status:completion?.type==='throw'&&completion.errorType===metadata.negative.type?'passed':'failed',
      phase:'execution',errorType:completion?.errorType??null,completion,
      reason:'Compared verified owned guest completion with the declared runtime error type'};
  }
  if (progress.kind !== 'terminated')
    return { ...result, status: 'failed', phase: 'execution', reason: `Guest run ended with ${progress.kind}` };
  if(metadata.negative)return {...result,status:'failed',phase:'execution',reason:'Expected runtime error but execution completed'};
  if (Object.keys(bundle.effects).length)
    return { ...result, status: 'failed', phase: 'execution', reason: 'Scalar test attempted a host effect' };
  if (!Number.isSafeInteger(assertionCount) || assertionCount < 1)
    return { ...result, status: 'failed', phase: 'assertions', reason: 'No guest assertions executed' };
  if (expectedAssertions !== null && assertionCount !== expectedAssertions)
    return { ...result, status: 'failed', phase: 'assertions', reason: `Expected ${expectedAssertions} assertions, observed ${assertionCount}` };
  return { ...result, status: 'passed', phase: 'execution' };
}

export function executeRuntimeTest262(source,options={}){
  return {sourceDigest:conformanceDigest(source),...executeRuntimeTest262Variant(source,options)};
}

/** Execute each requested strict/sloppy variant in a new owned machine.
 * The official full harness, async/module/agent hooks remain separate gaps. */
export function executeRuntimeTest262Variants(source,options={}){
  let metadata;
  try{metadata=parseRuntimeTest262Metadata(source);}
  catch(error){
    if(!(error instanceof Test262RuntimeProfileError))throw error;
    return [{status:'unsupported',phase:'metadata',reason:error.message}];
  }
  return metadata.requestedVariants.map(mode=>{
    const result=executeRuntimeTest262(source,{...options,mode});
    return {...result,metadata:{...result.metadata,omittedVariants:[]}};
  });
}

export function summarizeRuntimeTest262(rows) {
  return {
    files: new Set(rows.map((row,index)=>row.sourceDigest??'unknown-source:'+index)).size,
    variants: rows.length,
    executedVariants: rows.filter(row => row.trace?.replayed).length,
    passedVariants: rows.filter(row => row.status === 'passed').length,
    failedVariants: rows.filter(row => row.status === 'failed').length,
    resourceLimitedVariants: rows.filter(row => row.status === 'resource_limited').length,
    infrastructureErrorVariants: rows.filter(row => row.status === 'infrastructure_error').length,
    unsupportedVariants: rows.filter(row => row.status === 'unsupported').length,
    omittedStrictVariants: rows.reduce((sum, row) => sum + (row.metadata?.omittedVariants.length ?? 0), 0),
    executedAssertions: rows.reduce((sum, row) => sum + (row.assertionCount ?? 0), 0)
  };
}
