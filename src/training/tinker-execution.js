// Readable execution training. Private teacher state never enters a live prompt.
import {createHash, randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {executeWithNativeServices} from '../host/native-driver.js';
import {hostOperation, HOST_METHODS, HOST_OPERATIONS} from '../host/operations.js';
import {encodeNativeGraph, decodeOwnedGraph} from '../host/graph-codec.js';
import {createFixtureBroker, canonicalFixturePlan} from './fixture-broker.js';
import {describeGraph, realizeGraph} from './graph.js';
import {inspectDataObject} from './data-graph-contract.js';
import {normalizeJournal} from '../semantic/normalize.js';
import {independentEffectfulReference} from '../semantic/source-reference.js';
import {compileBoundedTypeScript} from '../typescript.js';
import {decode} from '../values.js';

export const TINKER_EXECUTION_SCHEMA = 'readable-js-execution/1';
export const TINKER_TRACE_FORMATS = Object.freeze(['full', 'compact', 'actions-only']);
export const TINKER_REASONING_CHANNELS = Object.freeze(['thinking', 'text']);
const clone = structuredClone;
const demand = (condition, message) => { if (!condition) throw new TypeError(message); };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const own = Object.hasOwn;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const pointer = (path, key) => path + '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const setOwn = (object, key, value) => Object.defineProperty(object, key,
  {value, writable: true, configurable: true, enumerable: true});

function graphValue(value) {
  return Array.isArray(value) && ['undefined', 'null', 'bool', 'num', 'str', 'bigint', 'ref'].includes(value[0]);
}

export function ownedEffectfulOutcome(bundle) {
  const entryId = bundle.initialState.control.a0.activeFrameId;
  const entry = bundle.initialState.frames[entryId], frame = bundle.finalState.frames[entryId];
  demand(!entry?.asyncPromiseId || (frame?.asyncPromiseId === entry.asyncPromiseId &&
    ['completed', 'thrown'].includes(frame.status)), 'async root body has not completed');
  const root = entry?.asyncPromiseId ? {kind: 'return', value: ['promise', entry.asyncPromiseId]} :
    ['completed', 'thrown'].includes(frame?.status) && frame.completion?.value ?
      {kind: frame.completion.type, value: frame.completion.value.value} :
      bundle.finalState.control.a0.completion;
  demand(root, 'missing completed root outcome');
  let kind = root.kind, value = root.value;
  if (value?.[0] === 'promise') {
    const promise = bundle.finalState.promises[value[1]];
    demand(promise && promise.status !== 'pending', 'root returned an unsettled Promise');
    kind = promise.status === 'fulfilled' ? 'return' : 'throw'; value = promise.value?.value;
  }
  demand(graphValue(value), 'completion is outside the declared data boundary');
  return {kind, graph: describeGraph(realizeGraph(bundle.finalState.heap,
    [...bundle.entrySpec.arguments, value], {exceptionProfile: true}))};
}

export function assistantVisibleText(message) {
  const content = typeof message === 'string' ? message : message?.content ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('');
  return '';
}

export function assistantThinkingText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'thinking').map(part => part.thinking ?? '').join('\n');
}

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

const SYSTEM = `Execute the supplied JavaScript program accurately. End each turn with one JSON action in a \`\`\`json code fence (or bare JSON when no prose precedes it):
- External call: {"type":"call","operation":"name","arguments":[...]}
- Final completion: {"type":"complete","kind":"return"|"throw","arguments":[final input args],"value":resultOrError}

Rules:
- Request every external read, write, clock, console, or native function call in order; never invent observations.
- Final "arguments" must reflect all input mutations and aliases. Standard Error throws use {"name":"TypeError","message":"..."}.
- Special JS values: {"$js":"undefined"|"NaN"|"-0"|"Infinity"|"-Infinity"}, {"$js":"bigint","value":"123"}, {"$js":"ref","path":"/arguments/0"} (paths rooted at {arguments,value} for completions or at the array for call args), {"$js":"array","length":3,"entries":{"1":2}} for sparse arrays, {"$js":"object","nullPrototype":true,"entries":{...}} for null-prototype or $js-keyed objects.`;

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
  const usesMathRandom = /\bMath\.random\b/.test(prepared.source);
  const parts = [
    'Execute this JavaScript program:',
    '```javascript\n' + prepared.source + '\n```',
    'Entry: ' + prepared.entry + ' with arguments ' + JSON.stringify(encodeReadable(prepared.args)),
  ];
  if (usesMathRandom) {
    parts.push('Math.random() uses uint32 seed ' + prepared.randomSeed +
      ' with state=(Math.imul(state,1664525)+1013904223)>>>0; return state/4294967296.');
  }
  if (operations.length) parts.push('External operations: ' + JSON.stringify(operations));
  if (prepared.nativeBindings.length) {
    parts.push('Native functions: ' + JSON.stringify(prepared.nativeBindings.map(({name, kind, description}) =>
      ({name, kind, ...(description ? {description} : {})}))));
  }
  return [{role: 'system', content: SYSTEM}, {role: 'user', content: parts.join('\n')}];
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

function traceFormat(options = {}) {
  const value = options.traceFormat ?? 'full';
  demand(TINKER_TRACE_FORMATS.includes(value), 'traceFormat must be full, compact, or actions-only');
  return value;
}

function reasoningChannel(options = {}) {
  const value = options.reasoningChannel ?? 'thinking';
  demand(TINKER_REASONING_CHANNELS.includes(value), 'reasoningChannel must be thinking or text');
  return value;
}

function sourceNodes(source) {
  const nodes = new Map();
  function visit(node, owner = null) {
    if (!node || typeof node !== 'object') return;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type))
      owner = node.id?.name ?? (node.type === 'ArrowFunctionExpression' ? 'callback' : 'anonymous');
    if (typeof node.type === 'string' && Number.isInteger(node.start) && Number.isInteger(node.end))
      nodes.set(node.start + ':' + node.end, {node, owner});
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, owner));
      else if (value && typeof value === 'object') visit(value, owner);
    }
  }
  visit(parse(source, {ecmaVersion: 'latest', sourceType: 'script'}));
  return nodes;
}

const sourceText = (source, node) => node ? source.slice(node.start, node.end).replace(/\s+/g, ' ').trim() : '';
const isReference = token => Array.isArray(token) && token[0] === 'ref';

/** Describe only this event's source and recorded scalar/write values in a
 * concise, natural scratchpad format without duplicating branch/write steps
 * or inspecting the future heap. */
function traceLines(row, source, nodes, format, entryName) {
  if (format === 'actions-only' || !row.source || !['value', 'branch', 'return', 'throw', 'write'].includes(row.op)) return [];
  const code = sourceText(source, row.source), {node, owner} = nodes.get(row.source.start + ':' + row.source.end) ?? {};
  if (!code || code.length > 512) return [];
  const value = scalarText(row.result);
  if (row.op === 'branch') {
    // result/decision is a VM jump decision, which can invert the condition.
    // test is the actual JavaScript condition evaluated at this event.
    const condition = scalarText(row.test ?? row.operands?.[0]);
    const path = ['then', 'else'].includes(row.path) ? ' (' + row.path + ')' : '';
    return ['branch ' + code + (condition === null ? '' : ' => ' + condition) + path];
  }
  const lines = [];
  const operand = node?.type === 'VariableDeclarator' ? node.init : node?.type === 'AssignmentExpression' ? node.right : null;
  const referenceText = expression => expression && ['Identifier', 'MemberExpression'].includes(expression.type) ?
    sourceText(source, expression) : 'object';
  let coveredByWrite = false;
  for (const write of row.writes ?? []) {
    if (write.kind === 'property') {
      const target = node?.type === 'AssignmentExpression' ? node.left :
        ['UpdateExpression', 'UnaryExpression'].includes(node?.type) ? node.argument : null;
      if (format === 'compact' && !target && ['ArrayExpression', 'ObjectExpression', 'Literal', 'Property', 'SpreadElement'].includes(node?.type)) continue;
      const name = target ? sourceText(source, target) : JSON.stringify(write.key) + ' in ' + code;
      if (write.present === false) { lines.push('delete ' + name); coveredByWrite = true; }
      else {
        const written = scalarText(write.value);
        if (written !== null) { lines.push(name + ' = ' + written); coveredByWrite = true; }
        else if (isReference(write.value)) { lines.push(name + ' -> ' + referenceText(operand)); coveredByWrite = true; }
      }
    } else if (write.kind === 'cell' && /^[A-Za-z_$][\w$]*$/.test(write.key)) {
      const written = scalarText(write.value);
      if (written !== null) { lines.push(write.key + ' = ' + written); coveredByWrite = true; }
      else if (isReference(write.value)) { lines.push(write.key + ' -> ' + referenceText(operand)); coveredByWrite = true; }
    }
  }
  if (['return', 'throw'].includes(row.op)) {
    const scope = owner && owner !== entryName ? ' (' + owner + ')' : '';
    if (isReference(row.result)) lines.push(row.op + scope + ' -> ' + referenceText(node?.argument));
    else if (value !== null) lines.push(row.op + scope + ' ' + value);
    return lines;
  }
  if (format === 'full' && value !== null && !coveredByWrite) lines.unshift(code + ' => ' + value);
  return lines;
}

function appendTraceLines(trace, added, row, source) {
  if (!added.length) return;
  // When a branch immediately follows the evaluation of its own condition
  // (`i<xs.length => true` -> `branch i<xs.length => true (then)`), drop the
  // redundant preceding scalar evaluation line.
  if (row.op === 'branch' && trace.length) {
    const code = sourceText(source, row.source);
    const cond = scalarText(row.test ?? row.operands?.[0]);
    if (cond !== null && trace.at(-1) === code + ' => ' + cond) trace.pop();
  }
  for (const line of added) {
    if (trace.at(-1) !== line) trace.push(line);
  }
}

function assistantMessage(action, trace, channel) {
  const actionBlock = '```json\n' + JSON.stringify(action) + '\n```';
  if (channel === 'thinking') {
    if (!trace.length) return {role: 'assistant', content: actionBlock};
    return {role: 'assistant', content: [
      {type: 'thinking', thinking: trace.join('\n')},
      {type: 'text', text: actionBlock},
    ]};
  }
  return {role: 'assistant', content: (trace.length ? trace.join('\n') + '\n' : '') + actionBlock};
}

function observation(operation, status, value) {
  return {role: 'user', content: 'External observation for ' + operation + ': ' +
    JSON.stringify({status, value: encodeReadable(value)})};
}

/** Converts canonical journal events into causal readable turns, using source
 * text and values rather than event IDs, heap IDs, hashes, or controller state. */
export function readableMessagesFromJournal(bundle, prepared, options = {}) {
  const format = traceFormat(options), channel = reasoningChannel(options);
  const nodes = format === 'actions-only' ? null : sourceNodes(prepared.source);
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
      messages.push(assistantMessage({type: 'call', operation: call.operation, arguments: encodeReadable(call.arguments)}, trace, channel));
      trace = []; pending = {effect: row.effect, call: receipt.call, operation: call.operation};
    } else if (row.op === 'observe' && row.effect) {
      demand(pending && row.effect === pending.effect, 'Observation without its pending request');
      const receipt = settlements.get(pending.call);
      demand(receipt, 'Missing external settlement');
      messages.push(observation(pending.operation, receipt.status, graphRoots(receipt.result)[0])); pending = null;
    } else {
      if (row.source?.end <= prepared.source.length)
        appendTraceLines(trace, traceLines(row, prepared.source, nodes, format, prepared.entry), row, prepared.source);
    }
  }
  demand(pending === null && called === dispatches.length, 'Incomplete readable episode');
  const roots = graphRoots(prepared.outcome.graph), value = roots.pop();
  const completion = encodeReadable({arguments: roots, value});
  messages.push(assistantMessage({type: 'complete', kind: prepared.outcome.kind,
    arguments: completion.arguments, value: completion.value}, trace, channel));
  return messages;
}

export async function exportTinkerExample(input, options = {}) {
  const format = traceFormat(options), channel = reasoningChannel(options);
  const prepared = await prepareTinkerTask(input);
  const messages = readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat: format, reasoningChannel: channel});
  const traceAudit = await auditTeacherConversation(prepared, messages, {traceFormat: format, reasoningChannel: channel});
  return {schema: TINKER_EXECUTION_SCHEMA, id: prepared.id, family: prepared.family, sourceHash: prepared.sourceHash,
    task: prepared.task, messages,
    metadata: {...clone(input.metadata ?? {}),
      ...(input.features ? {features: clone(input.features)} : {}), ...(input.tier !== undefined ? {tier: input.tier} : {}),
      sourceVerified: true, teacher: 'owned-runtime+native-reference', traceFormat: format, reasoningChannel: channel, traceAudit,
      traceRenderer: 'causal-event-source', referenceNarrationScope: 'event-source-aliases-without-final-heap-inference',
      externalObservationsTrainable: false, runtimeIdentifiersInTargets: false,
      externalCalls: prepared.fixture.calls.length, profile: 'sequential-data-execution',
      exceptionProfile: 'declared-error/name-message/1', optimizerSteps: 0}};
}

/** Replay all teacher actions through a fresh student boundary and match every
 * observation byte-for-byte. Canonical comparison additionally establishes
 * that narration came only from the causal event renderer for the named
 * format and reasoning channel. */
export async function auditTeacherConversation(prepared, messages, options = {}) {
  const format = traceFormat(options), channel = reasoningChannel(options);
  demand(Array.isArray(messages), 'Teacher conversation must be an array');
  demand(isDeepStrictEqual(messages.slice(0, 2), initialMessages(prepared)), 'Teacher initial prompt differs from live prompt');
  demand(isDeepStrictEqual(messages, readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat: format, reasoningChannel: channel})),
    'Teacher narration or observations differ from causal source events');
  const session = createTinkerSession(prepared);
  let index = 2, calls = 0, narrationLines = 0, assistantBytes = 0, observationBytes = 0;
  try {
    while (index < messages.length) {
      const message = messages[index++];
      demand(message.role === 'assistant' && (typeof message.content === 'string' || Array.isArray(message.content)), 'Expected a teacher action');
      const visible = assistantVisibleText(message);
      const thinking = assistantThinkingText(message);
      const action = parseStudentAction(visible);
      const fence = visible.indexOf('```');
      const prose = fence < 0 ? '' : visible.slice(0, fence).trim();
      const narration = [thinking.trim(), prose].filter(Boolean).join('\n');
      if (narration) narrationLines += narration.split('\n').length;
      assistantBytes += Buffer.byteLength(visible) + Buffer.byteLength(thinking);
      const next = await session.step(visible, 0);
      demand(!next.done || next.grade.success, 'Teacher replay failed complete execution');
      if (action.type === 'call') calls++;
      for (const obs of next.messages) {
        demand(isDeepStrictEqual(messages[index++], obs), 'Teacher observation differs from the actual environment');
        observationBytes += Buffer.byteLength(obs.content);
      }
      demand(!next.done || index === messages.length, 'Teacher conversation continues after completion');
    }
    demand(session.grade().success, 'Teacher conversation never completed');
    if (format === 'actions-only') demand(narrationLines === 0, 'Removed teacher narration remains in the input');
    return {replayVerified: true, canonicalCausalNarration: true, observationsMatched: true,
      traceFormat: format, reasoningChannel: channel, messages: messages.length, calls, narrationLines, assistantBytes, observationBytes};
  } finally { session.close(); }
}

function validateActionObject(action) {
  demand(plain(action), 'Expected a JSON action object');
  if (action.type === 'call') {
    const fields = Object.keys(action).sort().join(',');
    demand(fields === 'arguments,operation,type' && typeof action.operation === 'string', 'Invalid external call action');
    return action;
  }
  if (action.type === 'complete') {
    const keys = Object.keys(action).sort();
    const allowed = keys.join(',') === 'arguments,kind,type,value' || keys.join(',') === 'kind,type,value';
    demand(allowed && ['return', 'throw'].includes(action.kind), 'Invalid completion action');
    return own(action, 'arguments') ? action : {...action, arguments: []};
  }
  throw new TypeError('Unknown action type');
}

export function parseStudentAction(input) {
  const text = typeof input === 'string' ? input : assistantVisibleText(input);
  demand(typeof text === 'string' && text.length <= 1048576, 'Invalid action text');
  const trimmed = text.trim();
  // Match fenced json or unfenced-language blocks; ignore non-action code fences (e.g. ```js ...```) in reasoning prose.
  const fenced = [...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g)];
  const actionFences = [];
  for (const match of fenced) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (plain(parsed) && typeof parsed.type === 'string') actionFences.push({match, parsed});
    } catch { /* Non-JSON prose code block; ignore. */ }
  }
  if (actionFences.length) {
    demand(actionFences.length === 1, 'Expected exactly one action fence');
    const {match, parsed} = actionFences[0];
    const trailing = trimmed.slice(match.index + match[0].length).trim();
    demand(trailing.length === 0 || /^[.!?]+$/.test(trailing), 'Action fence must end the turn');
    return validateActionObject(parsed);
  }
  if (fenced.length) {
    // There was a json/plain fence at the end that failed JSON parsing.
    const last = fenced.at(-1);
    const trailing = trimmed.slice(last.index + last[0].length).trim();
    demand(trailing.length === 0 || /^[.!?]+$/.test(trailing), 'Action fence must end the turn');
    let parsed;
    try { parsed = JSON.parse(last[1].trim()); } catch { throw new TypeError('Expected one JSON action'); }
    return validateActionObject(parsed);
  }
  let action;
  try { action = JSON.parse(trimmed); } catch { throw new TypeError('Expected one JSON action'); }
  return validateActionObject(action);
}

/** Live student state has no teacher trace continuation. A rejected request
 * ends the rollout without disclosing the expected next operation or result. */
export function createTinkerSession(prepared) {
  const broker = createFixtureBroker(prepared.fixture);
  let done = false, completed = false, success = false, reason = 'incomplete', failureCategory = 'incomplete', generatedTokens = 0, calls = 0, turns = 0;
  const maxTurns = prepared.task.maxTurns ?? 256;
  demand(Number.isSafeInteger(maxTurns) && maxTurns > 0 && maxTurns <= 4096, 'Invalid rollout turn limit');
  const count = total => {
    demand(Number.isSafeInteger(total) && total >= generatedTokens, 'Generated token count must be cumulative and monotonic');
    generatedTokens = total;
  };
  const grade = total => {
    if (total !== undefined) count(total);
    return {success: done && success, reward: done && success ? 1 / (1 + generatedTokens / 1000) : 0,
      reason, failureCategory, generatedTokens, externalCalls: calls, complete: completed};
  };
  const reject = (why, category = why) => { done = true; success = false; reason = why; failureCategory = category;
    broker.abort(); return {messages: [], done, grade: grade()}; };
  return {
    messages: initialMessages(prepared),
    async step(text, total = generatedTokens) {
      count(total);
      if (done) return {messages: [], done, grade: grade()};
      if (++turns > maxTurns) return reject('turn-limit');
      let action;
      try { action = parseStudentAction(text); } catch { return reject('invalid-action', 'malformed-action'); }
      if (action.type === 'complete') {
        try {
          const result = decodeReadable({arguments: action.arguments, value: action.value});
          demand(Array.isArray(result.arguments) && result.arguments.length === prepared.args.length, 'Input argument arity changed');
          const actual = {kind: action.kind, graph: describeGraph([...result.arguments, result.value])};
          if (calls !== prepared.fixture.calls.length) return reject('incomplete-or-invalid-completion', 'missing-external-effects');
          const effects = broker.finish();
          completed = true;
          done = true; success = isDeepStrictEqual(actual, prepared.outcome) && isDeepStrictEqual(effects, prepared.effects);
          reason = success ? 'verified-complete-execution' : 'outcome-mismatch';
          failureCategory = null;
          if (!success) {
            const expected = graphRoots(prepared.outcome.graph), value = expected.pop();
            if (actual.kind !== prepared.outcome.kind) failureCategory = 'wrong-completion-kind';
            else if (!isDeepStrictEqual(describeGraph(result.arguments), describeGraph(expected))) {
              failureCategory = result.arguments.every((arg, i) => isDeepStrictEqual(describeGraph([arg]), describeGraph([expected[i]]))) ?
                'alias-mismatch' : 'mutation-mismatch';
            } else if (!isDeepStrictEqual(describeGraph([result.value]), describeGraph([value])))
              failureCategory = action.kind === 'throw' ? 'wrong-exception' : 'wrong-return';
            else if (!isDeepStrictEqual(actual.graph, prepared.outcome.graph)) failureCategory = 'alias-mismatch';
            else failureCategory = 'effect-mismatch';
          }
          return {messages: [], done, grade: grade()};
        } catch { return reject('incomplete-or-invalid-completion', 'invalid-completion'); }
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
      } catch { return reject('external-request-mismatch', 'incorrect-external-request'); }
    },
    grade,
    close() { broker.abort(); done = true; }
  };
}
