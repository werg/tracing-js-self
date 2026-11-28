// Readable execution training. Private teacher state never enters a live prompt.
import {createHash, randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {executeWithNativeServices} from '../host/native-driver.js';
import {hostOperation, HOST_METHODS, HOST_OPERATIONS} from '../host/operations.js';
import {encodeNativeGraph, decodeOwnedGraph} from '../host/graph-codec.js';
import {createFixtureBroker, canonicalFixturePlan} from './fixture-broker.js';
import {describeGraph, realizeGraph} from './graph.js';
import {
  inspectDataObject,
  inspectObservableValue,
  createDecodedInstance,
  decodeTypedArray,
} from './data-graph-contract.js';
import {normalizeJournal} from '../semantic/normalize.js';
import {independentEffectfulReference} from '../semantic/source-reference.js';
import {compileBoundedTypeScript} from '../typescript.js';
import {decode} from '../values.js';
import {sourceUsesGlobalFetch} from './tinker-http-fetch.js';
import {
  NODE_IO_OPERATIONS,
  resolveOperationSpec,
  canonicalNativeFixturePlan,
  scanPublicSourceNodeIoTools,
} from './tinker-node-io.js';
import {normalizeCodebaseSpec, codebaseSourceHash, renderRepoManifest,
  serveCodeLoad, codeLoadResultBytes, transpileSingleModuleToCjs} from './tinker-codebase.js';
import {BROWSER_TOOL_DESCRIPTIONS, DEFAULT_BROWSER_HTML, DEFAULT_BROWSER_URL, scanPublicSourceBrowserTools} from './tinker-browser-dom.js';

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

/** JSON with readable JavaScript scalar/built-in tags and semantic paths for aliases.
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
    const info = inspectObservableValue(item, {allowErrors: true});
    if (info.kind === 'error') {
      return {name: info.name, message: info.message};
    }
    if (info.kind === 'date') {
      return {$js: 'date', ms: Number.isNaN(info.ms) ? {$js: 'NaN'} : info.ms};
    }
    if (info.kind === 'regexp') {
      return {$js: 'regexp', source: info.source, flags: info.flags};
    }
    if (info.kind === 'typedarray') {
      return {$js: 'typedarray', type: info.type, b64: info.b64};
    }
    if (info.kind === 'map') {
      const entries = info.entries.map(([k, v], idx) => [
        visit(k, pointer(pointer(pointer(path, 'entries'), idx), 0), depth + 1),
        visit(v, pointer(pointer(pointer(path, 'entries'), idx), 1), depth + 1),
      ]);
      return {$js: 'map', entries};
    }
    if (info.kind === 'set') {
      const items = info.items.map((el, idx) =>
        visit(el, pointer(pointer(path, 'items'), idx), depth + 1),
      );
      return {$js: 'set', items};
    }
    if (info.kind === 'instance') {
      const props = {};
      for (const [key, desc] of info.descriptors) {
        setOwn(props, key, visit(desc.value, pointer(pointer(path, 'props'), key), depth + 1));
      }
      return {$js: 'instance', class: info.className, props};
    }
    const {kind, prototype, descriptors} = info;
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
  const locations = new Map(), references = [], pendingMaps = [], pendingSets = [];
  const atomicObjects = new WeakSet();
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
      if (tag === 'date') {
        demand(Object.keys(item).length === 2, 'Invalid date');
        let ms;
        if (plain(item.ms) && own(item.ms, '$js') && item.ms.$js === 'NaN' && Object.keys(item.ms).length === 1) {
          ms = NaN;
        } else {
          demand(typeof item.ms === 'number' && Number.isFinite(item.ms) && Math.abs(item.ms) <= 8.64e15, 'Invalid date timestamp');
          ms = item.ms;
        }
        const output = new Date(ms);
        locations.set(path, output);
        atomicObjects.add(output);
        return output;
      }
      if (tag === 'regexp') {
        demand(Object.keys(item).length === 3 && typeof item.source === 'string' && typeof item.flags === 'string', 'Invalid regexp');
        const output = new RegExp(item.source, item.flags);
        locations.set(path, output);
        atomicObjects.add(output);
        return output;
      }
      if (tag === 'typedarray') {
        demand(Object.keys(item).length === 3 && typeof item.type === 'string' && typeof item.b64 === 'string', 'Invalid typedarray');
        const output = decodeTypedArray(item.type, item.b64);
        locations.set(path, output);
        atomicObjects.add(output);
        return output;
      }
      if (tag === 'map') {
        demand(Object.keys(item).length === 2 && Array.isArray(item.entries), 'Invalid map');
        const output = new Map();
        locations.set(path, output);
        atomicObjects.add(output);
        const pairs = [];
        pendingMaps.push({map: output, pairs});
        for (let idx = 0; idx < item.entries.length; idx++) {
          const entry = item.entries[idx];
          demand(Array.isArray(entry) && entry.length === 2, 'Invalid map entry');
          pairs.push([
            visit(entry[0], pointer(pointer(pointer(path, 'entries'), idx), 0), depth + 1),
            visit(entry[1], pointer(pointer(pointer(path, 'entries'), idx), 1), depth + 1),
          ]);
        }
        return output;
      }
      if (tag === 'set') {
        demand(Object.keys(item).length === 2 && Array.isArray(item.items), 'Invalid set');
        const output = new Set();
        locations.set(path, output);
        atomicObjects.add(output);
        const items = [];
        pendingSets.push({set: output, items});
        for (let idx = 0; idx < item.items.length; idx++) {
          items.push(visit(item.items[idx], pointer(pointer(path, 'items'), idx), depth + 1));
        }
        return output;
      }
      if (tag === 'instance') {
        demand(Object.keys(item).length === 3 && typeof item.class === 'string' && item.class.length > 0 && plain(item.props), 'Invalid class instance');
        const output = createDecodedInstance(item.class);
        locations.set(path, output);
        for (const [key, child] of Object.entries(item.props)) {
          demand(key !== '__proto__', 'Invalid class instance property');
          setOwn(output, key, visit(child, pointer(pointer(path, 'props'), key), depth + 1));
        }
        return output;
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
    if (replacements.has(item)) return fix(replacements.get(item));
    if (!item || typeof item !== 'object' || atomicObjects.has(item) || visited.has(item)) return item;
    visited.add(item);
    for (const key of Object.keys(item)) setOwn(item, key, fix(item[key]));
    return item;
  }
  const resolvedRoot = fix(root);
  for (const {map, pairs} of pendingMaps) {
    for (const [k, v] of pairs) map.set(fix(k), fix(v));
  }
  for (const {set, items} of pendingSets) {
    for (const el of items) set.add(fix(el));
  }
  return resolvedRoot;
}

function graphRoots(graph) {
  return realizeGraph(graph);
}

export function normalizedSourceHash(source) {
  const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
  const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ?
    Object.fromEntries(Object.entries(value).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key)).map(([key, item]) => [key, clean(item)])) :
    typeof value === 'bigint' ? String(value) + 'n' : value;
  return hash(clean(ast));
}

const SYSTEM = `Execute the supplied JavaScript program directly and accurately.
- Never invoke undeclared tools or attempt to run the program via an external shell or interpreter.
- When execution finishes, end with one JSON completion in a \`\`\`json code fence (or bare JSON):
  {"type":"complete","kind":"return"|"throw","arguments":[final input args],"value":resultOrError}
- Final "arguments" must reflect all input mutations and aliases. Error throws/values use {"name":"ErrorName","message":"..."}.
- Special JS values: {"$js":"undefined"|"NaN"|"-0"|"Infinity"|"-Infinity"}, {"$js":"bigint","value":"123"}, {"$js":"date","ms":1700000000000}, {"$js":"regexp","source":"abc","flags":"gi"}, {"$js":"map","entries":[[k,v],...]}, {"$js":"set","items":[...]}, {"$js":"typedarray","type":"Uint8Array","b64":"..."}, {"$js":"instance","class":"Name","props":{...}}, {"$js":"ref","path":"/arguments/0"} (paths rooted at {arguments,value} for completions or at the arguments array for tool calls), {"$js":"array","length":3,"entries":{"1":2}} for sparse arrays, {"$js":"object","nullPrototype":true,"entries":{...}} for null-prototype or $js-keyed objects.`;

function buildSystemPrompt(operations, prepared) {
  const extra = [];
  if (operations.length) {
    extra.push('- Only invoke tools explicitly declared in tool_declare with {"arguments":[...]} in exact execution order for external calls made by the program; never invent observations.');
  }
  if (operations.includes('http.request')) {
    extra.push('- For fetch(url, init), invoke http.request with {"arguments":[url, method, headersObject, bodyOrNull]}.');
  }
  const nodeHints = [];
  if (operations.some(op => op.startsWith('fs.'))) {
    nodeHints.push('fs read/write/exists/readdir/stat invoke fs.readText/fs.readBytes/fs.writeText/fs.exists/fs.readdir/fs.stat');
  }
  if (operations.includes('env.get')) {
    nodeHints.push('process.env[k] invokes env.get([k])');
  }
  if (operations.includes('shell.exec')) {
    nodeHints.push('execFileSync/execSync invoke shell.exec([{"command":...,"args":[...]}])');
  }
  if (operations.includes('platform.uuid') || operations.includes('platform.randomBytes')) {
    nodeHints.push('crypto.randomUUID()/randomBytes(n) invoke platform.uuid([])/platform.randomBytes([n])');
  }
  if (nodeHints.length) {
    extra.push('- Node I/O calls: ' + nodeHints.join('; ') + '.');
  }
  if (operations.some(op => op.startsWith('browser.'))) {
    extra.push('- Browser I/O calls (localStorage/sessionStorage/alert/confirm/prompt) invoke the declared browser.* tools in execution order.');
  }
  if (prepared.files || operations.includes('code.load')) {
    extra.push('- For unloaded repository files, invoke code.load with {"arguments":[...]} on demand (whole file for small files, symbol snippet or line range for large files; you may batch multiple requests).');
  }
  return extra.length ? SYSTEM + '\n' + extra.join('\n') : SYSTEM;
}

function normalizeTask(input) {
  demand(plain(input), 'Task must be an object');
  demand(typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 256, 'Task id required');
  demand(typeof input.family === 'string' && input.family.length > 0, 'Source family required');
  const hasFiles = input.files !== undefined && input.files !== null;
  const codebase = hasFiles ? normalizeCodebaseSpec(input) : null;
  if (!hasFiles) {
    demand(typeof input.source === 'string' && input.source.length > 0 && input.source.length <= 262144, 'Bounded source required');
  }
  const entry = input.entry ?? 'run';
  demand(/^[A-Za-z_$][\w$]*$/.test(entry), 'Entry must be an identifier');
  const environment = input.environment ?? null;
  demand(environment === null || environment === 'browser', 'environment must be omitted or "browser"');
  const executionMode = input.executionMode ?? (hasFiles || environment === 'browser' ? 'native' : 'owned');
  demand(['owned', 'native'].includes(executionMode), 'executionMode must be owned or native');
  if (hasFiles) demand(executionMode === 'native', 'Multi-file tasks require executionMode: "native"');
  demand(environment !== 'browser' || executionMode === 'native', 'Browser environment requires executionMode "native"');
  const initialUrl = environment === 'browser' ? (input.initialUrl ?? DEFAULT_BROWSER_URL) : undefined;
  const initialHtml = environment === 'browser' ? (input.initialHtml ?? DEFAULT_BROWSER_HTML) : undefined;
  if (environment === 'browser') {
    demand(typeof initialUrl === 'string' && initialUrl.length > 0 && initialUrl.length <= 4096, 'Invalid browser initialUrl');
    demand(typeof initialHtml === 'string' && initialHtml.length <= 131072, 'Invalid browser initialHtml');
  }
  const args = input.inputGraph
    ? (executionMode === 'native' ? realizeGraph(input.inputGraph) : decodeOwnedGraph(JSON.stringify(input.inputGraph)))
    : decodeReadable(input.args ?? []);
  demand(Array.isArray(args) && args.length <= 32, 'At most 32 input arguments are supported');
  const language = input.language ?? (hasFiles && /\.(?:ts|tsx|mts|cts)$/i.test(codebase.entryFile) ? 'ts' : 'js');
  demand(['js', 'ts'].includes(language), 'Language must be js or ts');
  let source = hasFiles
    ? codebase.files[codebase.entryFile]
    : (language === 'ts' ? compileBoundedTypeScript(input.source, {path: input.path ?? 'training.ts'}).javascript : input.source);
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
  const isNative = executionMode === 'native';
  const decodedCalls = calls.map(call => {
    demand(plain(call) && !call.callbacks && call.resultFromCallback === undefined, 'Callback fixtures require a separate execution profile');
    const spec = resolveOperationSpec(call.operation, {nativeMode: isNative});
    demand(spec.callbackLifetime !== 'subscription', 'Subscription fixtures require a separate execution profile');
    const callArgs = call.argumentGraph ? graphRoots(call.argumentGraph) : decodeReadable(call.arguments ?? []);
    demand(Array.isArray(callArgs), 'External arguments must be an array');
    return {...call, arguments: callArgs, result: call.resultGraph ? graphRoots(call.resultGraph)[0] : decodeReadable(call.result)};
  });
  const fixture = isNative
    ? canonicalNativeFixturePlan({calls: decodedCalls, settlementOrder: input.fixture?.settlementOrder ?? null})
    : canonicalFixturePlan({calls: decodedCalls, settlementOrder: input.fixture?.settlementOrder ?? null});
  if (fixture.settlementOrder !== null) {
    if (isNative) {
      const ok = Array.isArray(fixture.settlementOrder) &&
        fixture.settlementOrder.every((idx, pos) => Number.isSafeInteger(idx) && idx >= 0 && idx < fixture.calls.length && (pos === 0 || idx > fixture.settlementOrder[pos - 1]));
      demand(ok, 'Out-of-order concurrent observations require a separate execution profile');
    } else {
      const sequential = fixture.calls.flatMap((call, index) => hostOperation(call.operation).kind === 'promise' ? [index] : []);
      demand(isDeepStrictEqual(fixture.settlementOrder, sequential), 'Out-of-order concurrent observations require a separate execution profile');
    }
  }
  let sourceHash, executableSource;
  if (hasFiles) {
    sourceHash = codebaseSourceHash(codebase.files, codebase.entryFile, entry);
    executableSource = source;
  } else {
    const parsedSource = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
    for (const declaration of parsedSource.body) if (declaration.type === 'FunctionDeclaration')
      demand(!names.has(declaration.id.name), 'Native binding shadows a source function');
    if (parsedSource.body[0]?.directive !== 'use strict') source = '"use strict";\n' + source;
    sourceHash = normalizedSourceHash(source);
    const preamble = nativeBindings.map(binding => 'function ' + binding.name + '(...args){return host.' +
      (binding.kind === 'promise' ? 'natlangCall' : 'natlangCallSync') + '(' + JSON.stringify(binding.name) + ',undefined,args);}').join('\n');
    executableSource = source + '\n' + preamble;
  }
  const randomMode = input.randomMode ?? 'seeded';
  demand(['seeded', 'tool'].includes(randomMode), 'randomMode must be seeded or tool');
  const maxSteps = input.maxSteps ?? 100000, timeoutMs = input.timeoutMs ?? 10000;
  demand(Number.isSafeInteger(maxSteps) && maxSteps > 0 && maxSteps <= 1000000, 'Invalid teacher step limit');
  demand(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'Invalid teacher timeout');
  const task = {...clone(input), ...(hasFiles ? {source, files: codebase.files, entryFile: codebase.entryFile,
    initialLoadedFiles: codebase.initialLoadedFiles} : {}), entry, language, ...(executionMode !== 'owned' ? {executionMode} : {}),
    ...(environment ? {environment, initialUrl, initialHtml} : {}),
    ...(randomMode !== 'seeded' ? {randomMode} : {}), randomSeed, nativeBindings, args: encodeReadable(args), freshRandomCalls: 0,
    fixture: {calls: decodedCalls.map(call => ({operation: call.operation, arguments: encodeReadable(call.arguments),
      status: call.status ?? 'fulfilled', result: encodeReadable(call.result)})), settlementOrder: fixture.settlementOrder}, maxSteps, timeoutMs};
  return {id: input.id, family: input.family, sourceHash, source, executableSource, entry, args, fixture, nativeBindings,
    ...(hasFiles ? {files: codebase.files, entryFile: codebase.entryFile, initialLoadedFiles: codebase.initialLoadedFiles} : {}),
    environment, initialUrl, initialHtml, executionMode, randomMode, randomSeed, maxSteps, timeoutMs, task};
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

const scanUnitsCache = new WeakMap();

function publicScanUnits(prepared) {
  if (!prepared.files) return [prepared.source];
  const cached = scanUnitsCache.get(prepared.files);
  if (cached) return cached;
  const units = [];
  for (const relPath of Object.keys(prepared.files).sort()) {
    if (relPath.toLowerCase().endsWith('.json')) continue;
    const raw = prepared.files[relPath];
    if (/\.(?:ts|tsx|mts|cts)$/i.test(relPath)) {
      try {
        units.push(transpileSingleModuleToCjs(raw, relPath));
        continue;
      } catch {
        // Fall through to raw source if transpilation fails during scanning.
      }
    }
    units.push(raw);
  }
  scanUnitsCache.set(prepared.files, units);
  return units;
}

function toolDeclaration(operation, prepared) {
  if (operation === 'code.load') {
    return {
      type: 'function',
      function: {
        name: 'code.load',
        description: 'Load source code on demand from unloaded repository files. Pass {"arguments":[req1, ...]} where each request is {"path":"rel/path.js"} (whole file), {"path":"rel/path.js","symbol":"name"} (symbol snippet with imports and top-level consts), or {"path":"rel/path.js","startLine":1,"endLine":50} (1-based inclusive line range). Batch multiple requests in one call when helpful.',
        parameters: {
          type: 'object',
          properties: {
            arguments: {
              type: 'array',
              description: 'Ordered list of code.load request objects ({path}, {path, symbol}, or {path, startLine, endLine}).',
            },
          },
          required: ['arguments'],
        },
      },
    };
  }
  const binding = prepared.nativeBindings.find(item => item.name === operation);
  const nodeIoSpec = own(NODE_IO_OPERATIONS, operation) ? NODE_IO_OPERATIONS[operation] : null;
  const spec = own(HOST_OPERATIONS, operation) ? HOST_OPERATIONS[operation] : null;
  const arity = spec ? spec.arity : null;
  const fetchHint = operation === 'http.request' && (prepared.environment === 'browser' || publicScanUnits(prepared).some(sourceUsesGlobalFetch))
    ? 'Invoke JS external operation http.request (promise, 4 arguments: [url, method, headersObject, bodyOrNull]).'
    : null;
  const browserHint = own(BROWSER_TOOL_DESCRIPTIONS, operation) ? BROWSER_TOOL_DESCRIPTIONS[operation] : null;
  const description = binding?.description ?? fetchHint ?? browserHint ?? nodeIoSpec?.description ?? (spec
    ? `Invoke JS external operation ${operation} (${spec.kind}, ${arity} argument${arity === 1 ? '' : 's'}).`
    : `Invoke JS external operation ${operation}.`);
  return {
    type: 'function',
    function: {
      name: operation,
      description,
      parameters: {
        type: 'object',
        properties: {
          arguments: {
            type: 'array',
            description: `Ordered JS arguments passed to ${operation}.`,
          },
        },
        required: ['arguments'],
      },
    },
  };
}

function initialMessages(prepared) {
  // Derive available tools only from public source/bindings, never the private
  // expected call inventory (which could reveal which branch will execute).
  const scanUnits = publicScanUnits(prepared);
  const names = new Set(prepared.nativeBindings.map(binding => binding.name));
  if (prepared.files) names.add('code.load');
  let usesMathRandom = false;
  for (const unit of scanUnits) {
    for (const match of unit.matchAll(/\bhost\.([A-Za-z_$][\w$]*)/g)) {
      const operation = HOST_METHODS[match[1]] ?? 'demo.' + match[1];
      if (own(HOST_OPERATIONS, operation)) names.add(operation);
    }
    if (/\bDate\.now\b/.test(unit)) names.add('platform.dateNow');
    for (const match of unit.matchAll(/\bconsole\.(log|info|warn|error)\b/g)) names.add('platform.console.' + match[1]);
    if (/\bMath\.random\b/.test(unit)) usesMathRandom = true;
    if (sourceUsesGlobalFetch(unit)) names.add('http.request');
    for (const op of scanPublicSourceNodeIoTools(unit)) names.add(op);
    if (prepared.environment === 'browser') {
      for (const op of scanPublicSourceBrowserTools(unit)) names.add(op);
    }
  }
  if (usesMathRandom && prepared.randomMode === 'tool') names.add('platform.random');
  const operations = [...names].sort();
  let parts;
  if (prepared.files) {
    parts = [
      'Execute this multi-file JavaScript/TypeScript program. Use code.load to inspect unloaded files or symbols on demand.',
      renderRepoManifest(prepared.files, prepared.entryFile, prepared.initialLoadedFiles),
    ];
    for (const relPath of prepared.initialLoadedFiles) {
      const fenceLang = /\.(?:ts|tsx|mts|cts)$/i.test(relPath) ? 'typescript' : 'javascript';
      parts.push('File: ' + relPath + '\n```' + fenceLang + '\n' + prepared.files[relPath] + '\n```');
    }
    parts.push('Entry: ' + prepared.entry + ' in ' + prepared.entryFile + ' with arguments ' + JSON.stringify(encodeReadable(prepared.args)));
  } else {
    parts = [
      'Execute this JavaScript program:',
      '```javascript\n' + prepared.source + '\n```',
      'Entry: ' + prepared.entry + ' with arguments ' + JSON.stringify(encodeReadable(prepared.args)),
    ];
  }
  if (prepared.environment === 'browser') {
    parts.push('Initial URL: ' + prepared.initialUrl);
    parts.push('Initial DOM:\n```html\n' + prepared.initialHtml + '\n```');
  }
  if (usesMathRandom) {
    if (prepared.randomMode === 'tool') {
      parts.push('Math.random() is non-deterministic: invoke the platform.random tool with {"arguments":[]} for each Math.random() call.');
    } else {
      parts.push('Math.random() uses uint32 seed ' + prepared.randomSeed +
        ' with state=(Math.imul(state,1664525)+1013904223)>>>0; return state/4294967296.');
    }
  }
  const systemPrompt = buildSystemPrompt(operations, prepared);
  const messages = [{role: 'system', content: systemPrompt}];
  if (operations.length) {
    const tools = operations.map(op => toolDeclaration(op, prepared));
    messages.push({role: 'tool_declare', content: JSON.stringify(tools)});
  }
  messages.push({role: 'user', content: parts.join('\n')});
  return messages;
}

/** Execute trusted dataset source on the existing CPU host boundary and compare
 * the complete result/effects to a separate native Node reference.
 * In executionMode === 'native', execute directly in real Node/V8 without the
 * bounded owned-interpreter subset restriction. */
export async function prepareTinkerTask(input, options = {}) {
  const prepared = normalizeTask(input);
  if (prepared.executionMode === 'native') {
    const format = options.traceFormat ? traceFormat(options) : 'actions-only';
    const baseRefInput = {source: prepared.executableSource, entry: prepared.entry,
      ...(prepared.files ? {files: prepared.files, entryFile: prepared.entryFile,
        initialLoadedFiles: prepared.initialLoadedFiles, nativeBindings: prepared.nativeBindings} : {}),
      inputGraph: describeGraph(prepared.args), fixture: prepared.fixture,
      randomSeed: prepared.randomMode === 'tool' ? null : prepared.randomSeed,
      randomMode: prepared.randomMode, executionMode: 'native',
      ...(prepared.environment ? {environment: prepared.environment, initialHtml: prepared.initialHtml, initialUrl: prepared.initialUrl} : {})};
    let reference, traceTurns = null;
    if (format !== 'actions-only') {
      try {
        reference = await independentEffectfulReference(
          {...baseRefInput, mode: 'trace', traceSourceLength: prepared.source.length},
          {timeoutMs: prepared.timeoutMs},
        );
        traceTurns = Array.isArray(reference.traceTurns) ? reference.traceTurns : null;
      } catch (error) {
        if (!['reference_instrumentation_unsupported', 'reference_resource_limit'].includes(error?.category)) throw error;
        reference = await independentEffectfulReference(baseRefInput, {timeoutMs: prepared.timeoutMs});
        traceTurns = null;
      }
    } else {
      reference = await independentEffectfulReference(baseRefInput, {timeoutMs: prepared.timeoutMs});
    }
    demand(reference.callbackFailures.length === 0 && (reference.unhandledRejections ?? []).length === 0, 'Unsettled guest failures cannot be admitted');
    const turnEvents = Array.isArray(reference.turnEvents) ? reference.turnEvents : null;
    const result = {...prepared, bundle: null, outcome: reference.outcome, effects: reference.effects, traceTurns,
      ...(turnEvents ? {turnEvents} : {})};
    readableMessagesFromJournal(null, result, {traceFormat: format});
    return result;
  }
  const broker = createFixtureBroker(prepared.fixture), abort = new AbortController();
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
      if (format === 'compact' && !target && ['ArrayExpression', 'ObjectExpression', 'Literal', 'Property', 'SpreadElement', 'Identifier'].includes(node?.type)) continue;
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
  // (`i<xs.length => true` -> `branch i<xs.length => true (then)`), or follows
  // a pathless short-circuit sub-branch on the same span, drop the redundant line.
  if (row.op === 'branch' && trace.length) {
    const code = sourceText(source, row.source);
    const cond = scalarText(row.test ?? row.operands?.[0]);
    if (cond !== null && trace.at(-1) === code + ' => ' + cond) trace.pop();
    else if (['then', 'else'].includes(row.path) && trace.at(-1).startsWith('branch ' + code + ' => ') &&
      !trace.at(-1).endsWith(' (then)') && !trace.at(-1).endsWith(' (else)')) trace.pop();
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

function assistantToolCallMessage(operation, args, trace, channel, callId) {
  const tool_calls = [{
    type: 'function',
    id: callId,
    function: {name: operation, arguments: JSON.stringify({arguments: args})},
  }];
  if (channel === 'thinking') {
    if (!trace.length) return {role: 'assistant', content: '', tool_calls};
    return {role: 'assistant', content: [{type: 'thinking', thinking: trace.join('\n')}], tool_calls};
  }
  return {role: 'assistant', content: trace.join('\n'), tool_calls};
}

function observation(operation, status, value, toolCallId = null) {
  return {
    role: 'tool',
    ...(toolCallId ? {tool_call_id: toolCallId} : {}),
    name: operation,
    content: JSON.stringify({status, value: encodeReadable(value)}),
  };
}

/** Converts canonical journal events into causal readable turns, using source
 * text and values rather than event IDs, heap IDs, hashes, or controller state. */
export function readableMessagesFromJournal(bundle, prepared, options = {}) {
  const format = traceFormat(options), channel = reasoningChannel(options);
  const messages = initialMessages(prepared);
  const dispatches = prepared.effects.filter(row => row.kind === 'dispatch');
  const settlements = new Map(prepared.effects.filter(row => row.kind === 'settlement').map(row => [row.call, row]));
  if (bundle === null) {
    // Native V8 execution mode: emit exact recorded external tool-call sequence (and causal
    // code.load turns for multi-file tasks) plus final completion, attaching causal per-turn
    // native compact trace lines when available and requested.
    const turns = format !== 'actions-only' && Array.isArray(prepared.traceTurns) ? prepared.traceTurns : null;
    if (prepared.files && Array.isArray(prepared.turnEvents)) {
      let emittedDispatches = 0;
      for (let index = 0; index < prepared.turnEvents.length; index++) {
        const event = prepared.turnEvents[index];
        const callId = 'call_' + (index + 1);
        if (event.kind === 'code.load') {
          messages.push(assistantToolCallMessage('code.load', event.arguments, turns?.[index] ?? [], channel, callId));
          const loadResults = serveCodeLoad(prepared.files, event.arguments);
          messages.push(observation('code.load', 'fulfilled', loadResults, callId));
        } else {
          const receipt = dispatches[event.dispatchIndex];
          demand(receipt, 'Missing external dispatch for turn event');
          emittedDispatches++;
          const call = publicOperation(prepared, receipt.operation, graphRoots(receipt.arguments));
          messages.push(assistantToolCallMessage(call.operation, encodeReadable(call.arguments), turns?.[index] ?? [], channel, callId));
          const settlement = settlements.get(receipt.call);
          demand(settlement, 'Missing external settlement');
          messages.push(observation(call.operation, settlement.status, graphRoots(settlement.result)[0], callId));
        }
      }
      demand(emittedDispatches === dispatches.length, 'Multi-file turnEvents/dispatch count mismatch');
      const roots = graphRoots(prepared.outcome.graph), value = roots.pop();
      const completion = encodeReadable({arguments: roots, value});
      messages.push(assistantMessage({type: 'complete', kind: prepared.outcome.kind,
        arguments: completion.arguments, value: completion.value}, turns?.[prepared.turnEvents.length] ?? [], channel));
      return messages;
    }
    for (let index = 0; index < dispatches.length; index++) {
      const receipt = dispatches[index];
      const call = publicOperation(prepared, receipt.operation, graphRoots(receipt.arguments));
      const callId = 'call_' + (index + 1);
      messages.push(assistantToolCallMessage(call.operation, encodeReadable(call.arguments), turns?.[index] ?? [], channel, callId));
      const settlement = settlements.get(receipt.call);
      demand(settlement, 'Missing external settlement');
      messages.push(observation(call.operation, settlement.status, graphRoots(settlement.result)[0], callId));
    }
    const roots = graphRoots(prepared.outcome.graph), value = roots.pop();
    const completion = encodeReadable({arguments: roots, value});
    messages.push(assistantMessage({type: 'complete', kind: prepared.outcome.kind,
      arguments: completion.arguments, value: completion.value}, turns?.[dispatches.length] ?? [], channel));
    return messages;
  }
  const nodes = format === 'actions-only' ? null : sourceNodes(prepared.source);
  const rows = normalizeJournal(bundle).events;
  let called = 0, pending = null, trace = [];
  for (const row of rows) {
    if (row.op === 'request') {
      demand(pending === null, 'Concurrent requests require a separate execution profile');
      const receipt = dispatches[called++];
      demand(receipt && receipt.operation === row.operation, 'Journal request/receipt mismatch');
      const call = publicOperation(prepared, receipt.operation, graphRoots(receipt.arguments));
      const callId = 'call_' + called;
      messages.push(assistantToolCallMessage(call.operation, encodeReadable(call.arguments), trace, channel, callId));
      trace = []; pending = {effect: row.effect, call: receipt.call, operation: call.operation, callId};
    } else if (row.op === 'observe' && row.effect) {
      demand(pending && row.effect === pending.effect, 'Observation without its pending request');
      const receipt = settlements.get(pending.call);
      demand(receipt, 'Missing external settlement');
      messages.push(observation(pending.operation, receipt.status, graphRoots(receipt.result)[0], pending.callId)); pending = null;
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
  const prepared = await prepareTinkerTask(input, {traceFormat: format});
  const messages = readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat: format, reasoningChannel: channel});
  const traceAudit = await auditTeacherConversation(prepared, messages, {traceFormat: format, reasoningChannel: channel});
  return {schema: TINKER_EXECUTION_SCHEMA, id: prepared.id, family: prepared.family, sourceHash: prepared.sourceHash,
    task: prepared.task, messages,
    metadata: {...clone(input.metadata ?? {}),
      ...(input.features ? {features: clone(input.features)} : {}), ...(input.tier !== undefined ? {tier: input.tier} : {}),
      sourceVerified: true, teacher: prepared.executionMode === 'native' ? 'native-v8-reference' : 'owned-runtime+native-reference', traceFormat: format, reasoningChannel: channel, traceAudit,
      traceRenderer: 'causal-event-source', referenceNarrationScope: 'event-source-aliases-without-final-heap-inference',
      externalObservationsTrainable: false, runtimeIdentifiersInTargets: false,
      externalCalls: prepared.fixture.calls.length,
      ...(prepared.files ? {codeLoadCalls: (prepared.turnEvents ?? []).filter(e => e.kind === 'code.load').length,
        fileCount: Object.keys(prepared.files).length, entryFile: prepared.entryFile} : {}),
      profile: 'sequential-data-execution',
      exceptionProfile: 'declared-error/name-message/1', optimizerSteps: 0}};
}

/** Replay all teacher actions through a fresh student boundary and match every
 * observation byte-for-byte. Canonical comparison additionally establishes
 * that narration came only from the causal event renderer for the named
 * format and reasoning channel. */
export async function auditTeacherConversation(prepared, messages, options = {}) {
  const format = traceFormat(options), channel = reasoningChannel(options);
  demand(Array.isArray(messages), 'Teacher conversation must be an array');
  const initial = initialMessages(prepared);
  demand(isDeepStrictEqual(messages.slice(0, initial.length), initial), 'Teacher initial prompt differs from live prompt');
  demand(isDeepStrictEqual(messages, readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat: format, reasoningChannel: channel})),
    'Teacher narration or observations differ from causal source events');
  const session = createTinkerSession(prepared);
  let index = initial.length, calls = 0, narrationLines = 0, assistantBytes = 0, observationBytes = 0;
  try {
    while (index < messages.length) {
      const message = messages[index++];
      demand(message.role === 'assistant' && (typeof message.content === 'string' || Array.isArray(message.content)), 'Expected a teacher action');
      const visible = assistantVisibleText(message);
      const thinking = assistantThinkingText(message);
      const action = parseStudentAction(message);
      const fence = visible.indexOf('```');
      const prose = Array.isArray(message.tool_calls) && message.tool_calls.length
        ? visible.trim()
        : (fence < 0 ? '' : visible.slice(0, fence).trim());
      const narration = [thinking.trim(), prose].filter(Boolean).join('\n');
      if (narration) narrationLines += narration.split('\n').length;
      assistantBytes += Buffer.byteLength(visible) + Buffer.byteLength(thinking) +
        (message.tool_calls ? Buffer.byteLength(JSON.stringify(message.tool_calls)) : 0);
      const next = await session.step(message, 0);
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

function parseToolCall(tc) {
  const fn = tc?.function;
  demand(fn && typeof fn.name === 'string' && fn.name.length > 0, 'Invalid tool call function');
  let rawArgs = fn.arguments;
  if (typeof rawArgs === 'string') {
    const trimmedArgs = rawArgs.trim();
    rawArgs = trimmedArgs ? JSON.parse(trimmedArgs) : {};
  }
  let args;
  if (Array.isArray(rawArgs)) args = rawArgs;
  else if (plain(rawArgs) && Array.isArray(rawArgs.arguments) && Object.keys(rawArgs).length === 1) args = rawArgs.arguments;
  else if (fn.name === 'code.load' && plain(rawArgs) && plain(rawArgs.arguments) && Object.keys(rawArgs).length === 1) args = [rawArgs.arguments];
  else if (plain(rawArgs) && Object.keys(rawArgs).length === 0) args = [];
  else throw new TypeError('Invalid tool call arguments');
  const toolCallId = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : null;
  return {type: 'call', operation: fn.name, arguments: args, ...(toolCallId ? {toolCallId} : {})};
}

export function parseStudentAction(input) {
  if (input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.tool_calls) && input.tool_calls.length > 0) {
    if (input.tool_calls.length === 1) return parseToolCall(input.tool_calls[0]);
    return {type: 'calls', calls: input.tool_calls.map(parseToolCall)};
  }
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

const PURE_COMMUTATIVE_READ_OPS = new Set([
  'env.get', 'env.has', 'env.list', 'env.keys', 'env.cwd',
  'fs.exists', 'fs.stat', 'fs.isFile', 'fs.isDir', 'fs.listdir', 'fs.readdir', 'fs.list',
  'fs.readText', 'fs.readBytes',
  'kv_get', 'kv.get', 'kv.has', 'kv.list', 'kv.keys',
  'browser.storageGet', 'browser.storage.getItem', 'browser.storage.length', 'browser.storage.key',
  'http.get',
]);

const HTTP_METHOD_CHECKED_OPS = new Set(['http.request', 'browser.fetch']);
const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD']);

function extractHttpRequestMethod(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  const first = args[0];
  if (plain(first)) {
    if (!own(first, 'method') || first.method === undefined || first.method === null) return 'GET';
    if (typeof first.method === 'string') {
      const method = first.method.trim().toUpperCase();
      return method.length > 0 ? method : null;
    }
    return null;
  }
  if (typeof first === 'string') {
    if (args.length === 1) return 'GET';
    const second = args[1];
    if (second === undefined || second === null) return 'GET';
    if (typeof second === 'string') {
      const method = second.trim().toUpperCase();
      return method.length > 0 ? method : null;
    }
    if (plain(second)) {
      if (!own(second, 'method') || second.method === undefined || second.method === null) return 'GET';
      if (typeof second.method === 'string') {
        const method = second.method.trim().toUpperCase();
        return method.length > 0 ? method : null;
      }
      return null;
    }
    return null;
  }
  return null;
}

function isReadOnlySqliteSelect(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const first = args[0];
  let sql = null;
  if (typeof first === 'string') sql = first;
  else if (plain(first)) {
    if (typeof first.sql === 'string') sql = first.sql;
    else if (typeof first.query === 'string') sql = first.query;
  }
  if (typeof sql !== 'string') return false;
  let rest = sql;
  while (true) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      rest = nl < 0 ? '' : trimmed.slice(nl + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/', 2);
      if (end < 0) return false;
      rest = trimmed.slice(end + 2);
    } else {
      rest = trimmed;
      break;
    }
  }
  const body = rest.replace(/;+\s*$/, '');
  return /^SELECT\b/i.test(body) && !body.includes(';');
}

/** Return true iff (operation, args) is a pure/commutative read that may
 * reorder freely within its causal epoch before the next mutating/nondeterministic barrier.
 * Unknown operations conservatively default to strict barriers (false). */
export function isCommutativeReadCall(operation, args = []) {
  if (typeof operation !== 'string') return false;
  if (PURE_COMMUTATIVE_READ_OPS.has(operation)) return true;
  if (HTTP_METHOD_CHECKED_OPS.has(operation)) {
    const method = extractHttpRequestMethod(args);
    return method !== null && READ_ONLY_HTTP_METHODS.has(method);
  }
  if (operation === 'sqlite3.query') {
    return isReadOnlySqliteSelect(args);
  }
  return false;
}

function expectedFixtureCallIsRead(call, isNative) {
  if (PURE_COMMUTATIVE_READ_OPS.has(call.operation)) return true;
  if (HTTP_METHOD_CHECKED_OPS.has(call.operation) || call.operation === 'sqlite3.query') {
    const decodedArgs = call.arguments !== undefined
      ? call.arguments
      : (isNative ? realizeGraph(call.argumentGraph) : decodeOwnedGraph(JSON.stringify(call.argumentGraph)));
    return isCommutativeReadCall(call.operation, decodedArgs);
  }
  return false;
}

function normalizeHttpHeadersArg(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return value;
}

function normalizeHttpBodyArg(value) {
  return value === undefined || value === null ? '' : value;
}

function expectedArgumentsMatch(operation, callArgs, encodedArgs, candidate, isNative) {
  if (isDeepStrictEqual(encodedArgs, candidate.argumentGraph)) return true;
  if ((operation === 'http.request' || operation === 'browser.fetch') && Array.isArray(callArgs) && callArgs.length === 4) {
    const expectedArgs = candidate.arguments !== undefined
      ? candidate.arguments
      : (isNative ? realizeGraph(candidate.argumentGraph) : decodeOwnedGraph(JSON.stringify(candidate.argumentGraph)));
    if (!Array.isArray(expectedArgs) || expectedArgs.length !== 4) return false;
    if (!isDeepStrictEqual(callArgs[0], expectedArgs[0])) return false;
    const actualMethod = typeof callArgs[1] === 'string' ? callArgs[1].trim().toUpperCase() : callArgs[1];
    const expectedMethod = typeof expectedArgs[1] === 'string' ? expectedArgs[1].trim().toUpperCase() : expectedArgs[1];
    if (!isDeepStrictEqual(actualMethod, expectedMethod)) return false;
    const actualHeaders = normalizeHttpHeadersArg(callArgs[2]);
    const expectedHeaders = normalizeHttpHeadersArg(expectedArgs[2]);
    if (!isDeepStrictEqual(actualHeaders, expectedHeaders)) return false;
    const actualBody = normalizeHttpBodyArg(callArgs[3]);
    const expectedBody = normalizeHttpBodyArg(expectedArgs[3]);
    return isDeepStrictEqual(actualBody, expectedBody);
  }
  return false;
}

/** Live student state has no teacher trace continuation. A rejected request
 * ends the rollout without disclosing the expected next operation or result.
 * Independent pure reads within the current causal epoch (before the next barrier)
 * may execute in any order, while barriers and cross-epoch ordering remain strict. */
export function createTinkerSession(prepared) {
  const isNative = prepared.executionMode === 'native';
  const expectedCalls = prepared.fixture.calls;
  const expectedExternalCalls = expectedCalls.length;
  for (const call of expectedCalls) {
    resolveOperationSpec(call.operation, {nativeMode: isNative});
  }
  const expectedIsRead = expectedCalls.map(call => expectedFixtureCallIsRead(call, isNative));
  const consumed = new Array(expectedExternalCalls).fill(false);
  const recordedDispatches = new Array(expectedExternalCalls);
  const recordedSettlements = new Array(expectedExternalCalls);
  let epochStart = 0;
  let done = false, completed = false, success = false, reason = 'incomplete', failureCategory = 'incomplete',
    generatedTokens = 0, calls = 0, turns = 0, codeLoadCalls = 0, codeLoadBytes = 0;
  const maxTurns = prepared.task.maxTurns ?? 256;
  demand(Number.isSafeInteger(maxTurns) && maxTurns > 0 && maxTurns <= 4096, 'Invalid rollout turn limit');
  const count = total => {
    demand(Number.isSafeInteger(total) && total >= generatedTokens, 'Generated token count must be cumulative and monotonic');
    generatedTokens = total;
  };
  const grade = total => {
    if (total !== undefined) count(total);
    return {success: done && success, reward: done && success ? 1 / (1 + generatedTokens / 1000) : 0,
      reason, failureCategory, generatedTokens, externalCalls: calls,
      matchedExternalCalls: calls, expectedExternalCalls, complete: completed,
      ...(prepared.files ? {codeLoadCalls, codeLoadBytes} : {})};
  };
  const reject = (why, category = why) => { done = true; success = false; reason = why; failureCategory = category;
    return {messages: [], done, grade: grade()}; };
  function matchExpectedCall(operation, callArgs, encodedArgs) {
    if (epochStart >= expectedExternalCalls) return -1;
    if (expectedIsRead[epochStart]) {
      // Unconsumed pure reads remain in the current epoch: barrier calls cannot bypass them.
      if (!isCommutativeReadCall(operation, callArgs)) return -1;
      let epochEnd = epochStart;
      while (epochEnd < expectedExternalCalls && expectedIsRead[epochEnd]) epochEnd++;
      // Scan in ascending index order so duplicate identical reads observe FIFO causal order.
      for (let idx = epochStart; idx < epochEnd; idx++) {
        if (consumed[idx]) continue;
        const candidate = expectedCalls[idx];
        if (candidate.operation === operation && expectedArgumentsMatch(operation, callArgs, encodedArgs, candidate, isNative)) {
          return idx;
        }
      }
      return -1;
    }
    const barrier = expectedCalls[epochStart];
    if (barrier.operation === operation && expectedArgumentsMatch(operation, callArgs, encodedArgs, barrier, isNative)) {
      return epochStart;
    }
    return -1;
  }
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
          if (calls !== expectedExternalCalls || epochStart !== expectedExternalCalls) {
            return reject('incomplete-or-invalid-completion', 'missing-external-effects');
          }
          const expectedEffects = Array.isArray(prepared.effects) ? prepared.effects : [];
          const expectedDispatches = expectedEffects.filter(e => e.kind === 'dispatch').sort((a, b) => a.call - b.call);
          const expectedSettlements = expectedEffects.filter(e => e.kind === 'settlement').sort((a, b) => a.call - b.call);
          const effectsOk = expectedEffects.length === expectedExternalCalls * 2 &&
            isDeepStrictEqual(recordedDispatches, expectedDispatches) &&
            isDeepStrictEqual(recordedSettlements, expectedSettlements);
          completed = true;
          done = true; success = isDeepStrictEqual(actual, prepared.outcome) && effectsOk;
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
        const batch = action.type === 'calls' ? action.calls : [action];
        const observations = [];
        for (const item of batch) {
          if (prepared.files && item.operation === 'code.load') {
            const args = decodeReadable(item.arguments);
            const loadResults = serveCodeLoad(prepared.files, args);
            codeLoadCalls++;
            codeLoadBytes += codeLoadResultBytes(loadResults);
            const toolCallId = item.toolCallId ?? ('code_load_' + codeLoadCalls);
            observations.push(observation('code.load', 'fulfilled', loadResults, toolCallId));
            continue;
          }
          const args = decodeReadable(item.arguments);
          demand(Array.isArray(args), 'Call arguments must be an array');
          const request = privateOperation(prepared, item.operation, args);
          // No counterfactual fixture result may be exposed to a different request.
          const encodedArgs = isNative ? describeGraph(request.arguments) : encodeNativeGraph(request.arguments);
          const matchedIdx = matchExpectedCall(request.operation, request.arguments, encodedArgs);
          demand(matchedIdx >= 0, 'External request mismatch');
          const expected = expectedCalls[matchedIdx];
          const status = expected.status ?? 'fulfilled';
          demand(status === 'fulfilled' || status === 'rejected', 'Invalid fixture outcome');
          const value = isNative
            ? realizeGraph(expected.resultGraph)[0]
            : decodeOwnedGraph(JSON.stringify(expected.resultGraph))[0];
          const encodedResult = isNative ? describeGraph([value]) : encodeNativeGraph([value]);
          consumed[matchedIdx] = true;
          while (epochStart < expectedExternalCalls && consumed[epochStart]) epochStart++;
          recordedDispatches[matchedIdx] = {kind: 'dispatch', call: matchedIdx, operation: request.operation, arguments: expected.argumentGraph};
          recordedSettlements[matchedIdx] = {kind: 'settlement', call: matchedIdx, status, result: encodedResult};
          calls++;
          const toolCallId = item.toolCallId ?? ('call_' + calls);
          observations.push(observation(item.operation, status, value, toolCallId));
        }
        return {messages: observations, done: false};
      } catch { return reject('external-request-mismatch', 'incorrect-external-request'); }
    },
    grade,
    close() { done = true; }
  };
}
