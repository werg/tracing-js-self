// Readable execution training. Private teacher state never enters a live prompt.
import {createHash, randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {executeWithNativeServices} from '../host/native-driver.js';
import {hostOperation, HOST_METHODS, HOST_OPERATIONS} from '../host/operations.js';
import {encodeNativeGraph, decodeOwnedGraph} from '../host/graph-codec.js';
import {createFixtureBroker, canonicalFixturePlan} from './fixture-broker.js';
import {ownedEffectfulOutcome} from './effectful-compiler.js';
import {describeGraph} from './graph.js';
import {inspectDataObject} from './data-graph-contract.js';
import {normalizeJournal} from '../semantic/normalize.js';
import {independentEffectfulReference} from '../semantic/source-reference.js';
import {compileBoundedTypeScript} from '../typescript.js';
import {decode} from '../values.js';

export const TINKER_EXECUTION_SCHEMA = 'readable-js-execution/1';
const clone = structuredClone;
const demand = (condition, message) => { if (!condition) throw new TypeError(message); };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const own = Object.hasOwn;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const pointer = (path, key) => path + '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const setOwn = (object, key, value) => Object.defineProperty(object, key,
  {value, writable: true, configurable: true, enumerable: true});

/** JSON with readable JavaScript scalar tags and semantic paths for aliases.
 * Paths name argument/property locations, never owned-runtime object handles. */
export function encodeReadable(value) {
  const seen = new WeakMap();
  let nodes = 0;
  function visit(item, path, depth) {
    demand(depth <= 64 && ++nodes <= 16384, 'Readable value budget exceeded');
    if (item === undefined) return {$js: 'undefined'};
    if (typeof item === 'number') {
      if (Number.isNaN(item)) return {$js: 'NaN'};
      if (Object.is(item, -0)) return {$js: '-0'};
      if (!Number.isFinite(item)) return {$js: item > 0 ? 'Infinity' : '-Infinity'};
      return item;
    }
    if (typeof item === 'bigint') return {$js: 'bigint', value: String(item)};
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    demand(typeof item === 'object', 'Only data values cross the training boundary');
    if (seen.has(item)) return {$js: 'ref', path: seen.get(item)};
    seen.set(item, path);
    const {kind, prototype, descriptors} = inspectDataObject(item);
    if (kind === 'array') {
      const length = descriptors.get('length').value;
      const dense = descriptors.size === length + 1 && Array.from({length}, (_, i) => descriptors.has(String(i))).every(Boolean);
      if (dense) return Array.from({length}, (_, i) => visit(descriptors.get(String(i)).value, pointer(path, i), depth + 1));
      const entries = {};
      for (const [key, desc] of descriptors) if (key !== 'length')
        setOwn(entries, key, visit(desc.value, pointer(path, key), depth + 1));
      return {$js: 'array', length, entries};
    }
    const result = {};
    for (const [key, desc] of descriptors) setOwn(result, key, visit(desc.value, pointer(path, key), depth + 1));
    return prototype === null || descriptors.has('$js') ? {$js: 'object', nullPrototype: prototype === null, entries: result} : result;
  }
  return visit(value, '', 0);
}

export function decodeReadable(value) {
  const locations = new Map(), references = [];
  let nodes = 0;
  function visit(item, path, depth) {
    demand(depth <= 64 && ++nodes <= 16384, 'Readable value budget exceeded');
    if (item === null || ['string', 'boolean', 'number', 'undefined', 'bigint'].includes(typeof item)) return item;
    demand(plain(item) || Array.isArray(item), 'Expected a JSON data value');
    if (plain(item) && own(item, '$js')) {
      const tag = item.$js;
      const scalars = {undefined: undefined, NaN: NaN, '-0': -0, Infinity: Infinity, '-Infinity': -Infinity};
      if (own(scalars, tag)) {
        demand(Object.keys(item).length === 1, 'Unexpected JavaScript scalar fields');
        return scalars[tag];
      }
      if (tag === 'bigint') {
        demand(Object.keys(item).length === 2 && typeof item.value === 'string' && /^(0|-?[1-9][0-9]*)$/.test(item.value), 'Invalid bigint');
        return BigInt(item.value);
      }
      if (tag === 'ref') {
        demand(Object.keys(item).length === 2 && typeof item.path === 'string', 'Invalid reference path');
        const marker = {}; references.push({marker, path: item.path}); return marker;
      }
      if (tag === 'array') {
        demand(Object.keys(item).length === 3 && Number.isSafeInteger(item.length) && item.length >= 0 && item.length <= 4096 && plain(item.entries), 'Invalid sparse array');
        const output = new Array(item.length); locations.set(path, output);
        for (const [key, child] of Object.entries(item.entries)) {
          demand(key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) < item.length), 'Array property outside length');
          setOwn(output, key, visit(child, pointer(path, key), depth + 1));
        }
        return output;
      }
      if (tag === 'object') {
        demand(Object.keys(item).length === 3 && typeof item.nullPrototype === 'boolean' && plain(item.entries), 'Invalid escaped object');
        const output = item.nullPrototype ? Object.create(null) : {}; locations.set(path, output);
        for (const [key, child] of Object.entries(item.entries)) setOwn(output, key, visit(child, pointer(path, key), depth + 1));
        return output;
      }
      throw new TypeError('Unknown JavaScript value tag');
    }
    const output = Array.isArray(item) ? [] : {}; locations.set(path, output);
    for (const [key, child] of Object.entries(item)) setOwn(output, key, visit(child, pointer(path, key), depth + 1));
    return output;
  }
  const root = visit(value, '', 0), replacements = new Map();
  for (const {marker, path} of references) {
    demand(locations.has(path), 'Reference must identify an existing data object');
    replacements.set(marker, locations.get(path));
  }
  const visited = new WeakSet();
  function fix(item) {
    if (replacements.has(item)) return replacements.get(item);
    if (!item || typeof item !== 'object' || visited.has(item)) return item;
    visited.add(item);
    for (const key of Object.keys(item)) setOwn(item, key, fix(item[key]));
    return item;
  }
  return fix(root);
}

function graphRoots(graph) {
  const objects = new Map(graph.objects.map(node => [node.id,
    node.kind === 'array' ? [] : node.prototype === null ? Object.create(null) : {}]));
  const visit = token => token[0] === 'ref' ? objects.get(token[1]) : decode(token);
  for (const node of graph.objects) {
    const output = objects.get(node.id);
    for (const property of node.properties) {
      const [key, value] = Array.isArray(property) ? property : [property.key, property.value];
      if (key === 'length' && node.kind === 'array') output.length = visit(value);
      else setOwn(output, key, visit(value));
    }
  }
  return graph.roots.map(visit);
}

export function normalizedSourceHash(source) {
  const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
  const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ?
    Object.fromEntries(Object.entries(value).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key)).map(([key, item]) => [key, clean(item)])) :
    typeof value === 'bigint' ? String(value) + 'n' : value;
  return hash(clean(ast));
}

const SYSTEM = `You execute the supplied JavaScript program, using your own reasoning and the observations that arrive.
You may write a readable trace. End each assistant turn with exactly one JSON action, optionally in a json code fence.
When writing prose, put the final action in a json code fence. Bare JSON is allowed only when the entire turn is that one object.
To call the external environment: {"type":"call","operation":"operation name","arguments":[evaluated arguments]}.
To finish: {"type":"complete","kind":"return" or "throw","arguments":[final input argument values],"value":result or exception}.
Final arguments include all mutations. For a standard Error exception, report {"name":"TypeError","message":"..."}.
External reads, writes, clocks, console output, and supplied native functions require real calls. Never invent their observations.
You may shorten or omit internal reasoning, but must complete the execution and every externally visible operation.
Values are ordinary JSON, with {"$js":"undefined"}, {"$js":"NaN"}, {"$js":"-0"}, {"$js":"Infinity"}, {"$js":"-Infinity"}, and {"$js":"bigint","value":"123"} for JavaScript scalars.
Aliased or cyclic objects use {"$js":"ref","path":"/arguments/0"}; completion paths refer to locations in the final {arguments,value} object, not runtime identifiers. For input or external-call argument arrays, paths are rooted at that array (for example /0). Sparse arrays use {"$js":"array","length":3,"entries":{"1":2}}. Objects containing a $js key or null prototype use {"$js":"object","nullPrototype":false,"entries":{...}}.
Math.random() is deterministic internal computation using the declared uint32 seed and recurrence state=(Math.imul(state,1664525)+1013904223)>>>0; return state/4294967296. Fresh randomness is available only through a supplied native callable. All generated tokens count, including reasoning and formatting.`;

function normalizeTask(input) {
  demand(plain(input), 'Task must be an object');
  demand(typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 256, 'Task id required');
  demand(typeof input.family === 'string' && input.family.length > 0, 'Source family required');
  demand(typeof input.source === 'string' && input.source.length > 0 && input.source.length <= 262144, 'Bounded source required');
  const entry = input.entry ?? 'run';
  demand(/^[A-Za-z_$][\w$]*$/.test(entry), 'Entry must be an identifier');
  const args = input.inputGraph ? decodeOwnedGraph(JSON.stringify(input.inputGraph)) : decodeReadable(input.args ?? []);
  demand(Array.isArray(args) && args.length <= 32, 'At most 32 input arguments are supported');
  const language = input.language ?? 'js';
  demand(['js', 'ts'].includes(language), 'Language must be js or ts');
  let source = language === 'ts' ? compileBoundedTypeScript(input.source, {path: input.path ?? 'training.ts'}).javascript : input.source;
  const randomSeed = input.randomSeed ?? 17;
  demand(Number.isInteger(randomSeed) && randomSeed >= 0 && randomSeed <= 0xffffffff, 'randomSeed must be uint32');
  const nativeBindings = clone(input.nativeBindings ?? []), names = new Set();
  demand(Array.isArray(nativeBindings) && nativeBindings.length <= 32, 'Invalid native binding list');
  for (const binding of nativeBindings) {
    demand(plain(binding) && /^[A-Za-z_$][\w$]*$/.test(binding.name) && !names.has(binding.name) &&
      ['synchronous', 'promise'].includes(binding.kind ?? 'synchronous'), 'Invalid native binding');
    names.add(binding.name); binding.kind ??= 'synchronous';
  }
  const calls = clone(input.fixture?.calls ?? []);
  demand(Array.isArray(calls) && calls.length <= 1024, 'Bounded fixture calls required');
  const freshCount = input.freshRandomCalls ?? 0;
  demand(Number.isSafeInteger(freshCount) && freshCount >= 0 && freshCount <= 128, 'Invalid freshRandomCalls');
  if (freshCount) {
    if (!names.has('freshRandom')) { nativeBindings.push({name: 'freshRandom', kind: 'synchronous', description: 'Fresh random number in [0,1)'}); names.add('freshRandom'); }
    for (let i = 0; i < freshCount; i++) calls.push({operation: 'natlang.callSync', arguments: ['freshRandom', {$js: 'undefined'}, []],
      result: randomBytes(6).readUIntBE(0, 6) / 281474976710656});
  }
  const decodedCalls = calls.map(call => {
    demand(plain(call) && !call.callbacks && call.resultFromCallback === undefined, 'Callback fixtures require a separate execution profile');
    const spec = hostOperation(call.operation);
    demand(spec.callbackLifetime !== 'subscription', 'Subscription fixtures require a separate execution profile');
    const args = call.argumentGraph ? graphRoots(call.argumentGraph) : decodeReadable(call.arguments ?? []);
    demand(Array.isArray(args), 'External arguments must be an array');
    return {...call, arguments: args, result: call.resultGraph ? graphRoots(call.resultGraph)[0] : decodeReadable(call.result)};
  });
  const fixture = canonicalFixturePlan({calls: decodedCalls, settlementOrder: input.fixture?.settlementOrder ?? null});
  if (fixture.settlementOrder !== null) {
    const sequential = fixture.calls.flatMap((call, index) => hostOperation(call.operation).kind === 'promise' ? [index] : []);
    demand(isDeepStrictEqual(fixture.settlementOrder, sequential), 'Out-of-order concurrent observations require a separate execution profile');
  }
  const parsedSource = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
  for (const declaration of parsedSource.body) if (declaration.type === 'FunctionDeclaration')
    demand(!names.has(declaration.id.name), 'Native binding shadows a source function');
  if (parsedSource.body[0]?.directive !== 'use strict') source = '"use strict";\n' + source;
  const sourceHash = normalizedSourceHash(source);
  const preamble = nativeBindings.map(binding => 'function ' + binding.name + '(...args){return host.' +
    (binding.kind === 'promise' ? 'natlangCall' : 'natlangCallSync') + '(' + JSON.stringify(binding.name) + ',undefined,args);}').join('\n');
  // Preserve the single strict directive accepted by the owned entry profile;
  // hoisted native wrappers come after the user's source and its prologue.
  const executableSource = source + '\n' + preamble;
  const maxSteps = input.maxSteps ?? 100000, timeoutMs = input.timeoutMs ?? 10000;
  demand(Number.isSafeInteger(maxSteps) && maxSteps > 0 && maxSteps <= 1000000, 'Invalid teacher step limit');
  demand(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'Invalid teacher timeout');
  const task = {...clone(input), entry, language, randomSeed, nativeBindings, args: encodeReadable(args), freshRandomCalls: 0,
    fixture: {calls: decodedCalls.map(call => ({operation: call.operation, arguments: encodeReadable(call.arguments),
      status: call.status ?? 'fulfilled', result: encodeReadable(call.result)})), settlementOrder: fixture.settlementOrder}, maxSteps, timeoutMs};
  return {id: input.id, family: input.family, sourceHash, source, executableSource, entry, args, fixture, nativeBindings, randomSeed, maxSteps, timeoutMs, task};
}

function publicOperation(prepared, operation, args) {
  if (['natlang.call', 'natlang.callSync'].includes(operation)) {
    const binding = prepared.nativeBindings.find(item => item.name === args[0] &&
      (item.kind === 'promise' ? 'natlang.call' : 'natlang.callSync') === operation);
    if (binding && args[1] === undefined && Array.isArray(args[2])) return {operation: binding.name, arguments: args[2]};
  }
  return {operation, arguments: args};
}

function privateOperation(prepared, operation, args) {
  const binding = prepared.nativeBindings.find(item => item.name === operation);
  return binding ? {operation: binding.kind === 'promise' ? 'natlang.call' : 'natlang.callSync', arguments: [binding.name, undefined, args]} :
    {operation, arguments: args};
}

function initialMessages(prepared) {
  // Derive available names only from public source/bindings, never the private
  // expected call inventory (which could reveal which branch will execute).
  const names = new Set(prepared.nativeBindings.map(binding => binding.name));
  for (const match of prepared.source.matchAll(/\bhost\.([A-Za-z_$][\w$]*)/g)) {
    const operation = HOST_METHODS[match[1]] ?? 'demo.' + match[1];
    if (own(HOST_OPERATIONS, operation)) names.add(operation);
  }
  if (/\bDate\.now\b/.test(prepared.source)) names.add('platform.dateNow');
  for (const match of prepared.source.matchAll(/\bconsole\.(log|info|warn|error)\b/g)) names.add('platform.console.' + match[1]);
  const operations = [...names].sort();
  return [{role: 'system', content: SYSTEM}, {role: 'user', content:
    'Execute this JavaScript program.\n```javascript\n' + prepared.source + '\n```\n' +
    'Call: ' + prepared.entry + '(' + JSON.stringify(encodeReadable(prepared.args)) + ' spread as arguments).\n' +
    'Input arguments: ' + JSON.stringify(encodeReadable(prepared.args)) + '\n' +
    'Deterministic Math.random seed: ' + prepared.randomSeed + '\n' +
    'Granted external operations: ' + JSON.stringify(operations) + '\n' +
    (prepared.nativeBindings.length ? 'Supplied native functions: ' + JSON.stringify(prepared.nativeBindings.map(({name, kind, description}) => ({name, kind, ...(description ? {description} : {})}))) + '\n' : '') +
    'Predict the complete return or exception and all input mutations. Request external observations when needed.'}];
}

/** Execute trusted dataset source on the existing CPU host boundary and compare
 * the complete result/effects to a separate native Node reference. */
export async function prepareTinkerTask(input) {
  const prepared = normalizeTask(input), broker = createFixtureBroker(prepared.fixture), abort = new AbortController();
  const timer = setTimeout(() => { const error = new Error('Teacher execution timed out'); broker.abort(error); abort.abort(error); }, prepared.timeoutMs);
  try {
    const run = await executeWithNativeServices({entry: {text: prepared.executableSource, functionName: prepared.entry, args: prepared.args},
      services: broker.services, maxSteps: prepared.maxSteps, randomSeed: prepared.randomSeed, signal: abort.signal});
    const outcome = ownedEffectfulOutcome(run.bundle), effects = broker.finish();
    const reference = await independentEffectfulReference({source: prepared.executableSource, entry: prepared.entry,
      inputGraph: encodeNativeGraph(prepared.args), fixture: prepared.fixture, randomSeed: prepared.randomSeed}, {timeoutMs: prepared.timeoutMs});
    demand(reference.callbackFailures.length === 0 && (reference.unhandledRejections ?? []).length === 0, 'Unsettled guest failures cannot be admitted');
    demand(isDeepStrictEqual(outcome, reference.outcome) && isDeepStrictEqual(effects, reference.effects), 'Owned execution and native reference disagree');
    const result = {...prepared, bundle: run.bundle, outcome, effects};
    // Check that this conversation profile can preserve the entire episode before admission.
    readableMessagesFromJournal(run.bundle, result);
    return result;
  } finally { clearTimeout(timer); broker.abort(); }
}

function scalarText(token) {
  if (!Array.isArray(token) || !['undefined', 'null', 'bool', 'str', 'num', 'bigint'].includes(token[0])) return null;
  try { return JSON.stringify(encodeReadable(decode(token))); } catch { return null; }
}

function traceLine(row, source) {
  if (!row.source || !['value', 'branch', 'return', 'throw', 'write'].includes(row.op)) return null;
  const code = source.slice(row.source.start, row.source.end).replace(/\s+/g, ' ').trim();
  if (!code || code.length > 512) return null;
  const value = scalarText(row.result);
  if (row.op === 'branch') return 'Branch ' + code + (value === null ? '.' : ' evaluates to ' + value + '.');
  return value === null ? null : code + ' => ' + value;
}

function actionText(action, trace = []) { return (trace.length ? trace.join('\n') + '\n' : '') + '```json\n' + JSON.stringify(action) + '\n```'; }
function observation(operation, status, value) {
  return {role: 'user', content: 'External observation for ' + operation + ': ' +
    JSON.stringify({status, value: encodeReadable(value)})};
}

/** Converts canonical journal events into causal readable turns, using source
 * text and values rather than event IDs, heap IDs, hashes, or controller state. */
export function readableMessagesFromJournal(bundle, prepared) {
  const messages = initialMessages(prepared), rows = normalizeJournal(bundle).events;
  const dispatches = prepared.effects.filter(row => row.kind === 'dispatch');
  const settlements = new Map(prepared.effects.filter(row => row.kind === 'settlement').map(row => [row.call, row]));
  let called = 0, pending = null, trace = [];
  for (const row of rows) {
    if (row.op === 'request') {
      demand(pending === null, 'Concurrent requests require a separate execution profile');
      const receipt = dispatches[called++];
      demand(receipt && receipt.operation === row.operation, 'Journal request/receipt mismatch');
      const call = publicOperation(prepared, receipt.operation, graphRoots(receipt.arguments));
      messages.push({role: 'assistant', content: actionText({type: 'call', operation: call.operation, arguments: encodeReadable(call.arguments)}, trace)});
      trace = []; pending = {effect: row.effect, call: receipt.call, operation: call.operation};
    } else if (row.op === 'observe' && row.effect) {
      demand(pending && row.effect === pending.effect, 'Observation without its pending request');
      const receipt = settlements.get(pending.call);
      demand(receipt, 'Missing external settlement');
      messages.push(observation(pending.operation, receipt.status, graphRoots(receipt.result)[0])); pending = null;
    } else {
      // Appended host-call wrapper internals are bookkeeping, not targets.
      const line = row.source?.end <= prepared.source.length ? traceLine(row, prepared.source) : null;
      if (line) trace.push(line);
    }
  }
  demand(pending === null && called === dispatches.length, 'Incomplete readable episode');
  const roots = graphRoots(prepared.outcome.graph), value = roots.pop();
  const completion = encodeReadable({arguments: roots, value});
  messages.push({role: 'assistant', content: actionText({type: 'complete', kind: prepared.outcome.kind,
    arguments: completion.arguments, value: completion.value}, trace)});
  return messages;
}

export async function exportTinkerExample(input) {
  const prepared = await prepareTinkerTask(input);
  return {schema: TINKER_EXECUTION_SCHEMA, id: prepared.id, family: prepared.family, sourceHash: prepared.sourceHash,
    task: prepared.task, messages: readableMessagesFromJournal(prepared.bundle, prepared),
    metadata: {sourceVerified: true, teacher: 'owned-runtime+native-reference',
      externalObservationsTrainable: false, runtimeIdentifiersInTargets: false,
      externalCalls: prepared.fixture.calls.length, profile: 'sequential-data-execution',
      exceptionProfile: 'declared-error/name-message/1', optimizerSteps: 0}};
}

export function parseStudentAction(text) {
  demand(typeof text === 'string' && text.length <= 1048576, 'Invalid action text');
  const trimmed = text.trim(), fenced = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  let payload = trimmed;
  if (fenced.length) {
    demand(fenced.length === 1, 'Expected exactly one action fence');
    const last = fenced.at(-1);
    demand(last.index + last[0].length === trimmed.length, 'Action fence must end the turn');
    payload = last[1];
  }
  let action;
  try { action = JSON.parse(payload); } catch { throw new TypeError('Expected one JSON action'); }
  demand(plain(action), 'Expected a JSON action object');
  const fields = Object.keys(action).sort().join(',');
  if (action.type === 'call') demand(fields === 'arguments,operation,type' && typeof action.operation === 'string', 'Invalid external call action');
  else if (action.type === 'complete') demand(fields === 'arguments,kind,type,value' && ['return', 'throw'].includes(action.kind), 'Invalid completion action');
  else throw new TypeError('Unknown action type');
  return action;
}

/** Live student state has no teacher trace continuation. A rejected request
 * ends the rollout without disclosing the expected next operation or result. */
export function createTinkerSession(prepared) {
  const broker = createFixtureBroker(prepared.fixture);
  let done = false, completed = false, success = false, reason = 'incomplete', generatedTokens = 0, calls = 0, turns = 0;
  const maxTurns = prepared.task.maxTurns ?? 256;
  demand(Number.isSafeInteger(maxTurns) && maxTurns > 0 && maxTurns <= 4096, 'Invalid rollout turn limit');
  const count = total => {
    demand(Number.isSafeInteger(total) && total >= generatedTokens, 'Generated token count must be cumulative and monotonic');
    generatedTokens = total;
  };
  const grade = total => {
    if (total !== undefined) count(total);
    return {success: done && success, reward: done && success ? 1 / (1 + generatedTokens / 1000) : 0,
      reason, generatedTokens, externalCalls: calls, complete: completed};
  };
  const reject = why => { done = true; success = false; reason = why; broker.abort(); return {messages: [], done, grade: grade()}; };
  return {
    messages: initialMessages(prepared),
    async step(text, total = generatedTokens) {
      count(total);
      if (done) return {messages: [], done, grade: grade()};
      if (++turns > maxTurns) return reject('turn-limit');
      let action;
      try { action = parseStudentAction(text); } catch { return reject('invalid-action'); }
      if (action.type === 'complete') {
        try {
          const result = decodeReadable({arguments: action.arguments, value: action.value});
          demand(Array.isArray(result.arguments) && result.arguments.length === prepared.args.length, 'Input argument arity changed');
          const actual = {kind: action.kind, graph: describeGraph([...result.arguments, result.value])};
          const effects = broker.finish();
          completed = true;
          done = true; success = isDeepStrictEqual(actual, prepared.outcome) && isDeepStrictEqual(effects, prepared.effects);
          reason = success ? 'verified-complete-execution' : 'outcome-mismatch';
          return {messages: [], done, grade: grade()};
        } catch { return reject('incomplete-or-invalid-completion'); }
      }
      try {
        const args = decodeReadable(action.arguments);
        demand(Array.isArray(args), 'Call arguments must be an array');
        const request = privateOperation(prepared, action.operation, args);
        const expected = prepared.fixture.calls[calls];
        // No counterfactual fixture result may be exposed to a different request.
        demand(expected && expected.operation === request.operation &&
          isDeepStrictEqual(encodeNativeGraph(request.arguments), expected.argumentGraph), 'External request mismatch');
        let status = 'fulfilled', value;
        try { value = await broker.invoke(request.operation, request.arguments); }
        catch (error) {
          demand(expected.status === 'rejected', 'Environment infrastructure failure');
          status = 'rejected'; value = error;
        }
        calls++;
        return {messages: [observation(action.operation, status, value)], done: false};
      } catch { return reject('external-request-mismatch'); }
    },
    grade,
    close() { broker.abort(); done = true; }
  };
}
