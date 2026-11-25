// Independent audit of the bounded data/serial-observation profile.
// Deliberately does not import the production fixture broker or graph codecs.
import vm from 'node:vm';
import {isDeepStrictEqual} from 'node:util';

const own = Object.hasOwn;
const pointer = (path, key) => path + '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const put = (object, key, value) => Object.defineProperty(object, key, {value, enumerable: true, writable: true, configurable: true});

export function independentDecode(input) {
  const paths = new Map(), refs = [], visited = new Set();
  function read(value, path = '') {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && own(value, '$js')) {
      switch (value.$js) {
        case 'undefined': return undefined;
        case 'NaN': return NaN;
        case '-0': return -0;
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
        case 'bigint': return BigInt(value.value);
        case 'ref': { const marker = {}; refs.push([marker, value.path]); return marker; }
        case 'array': {
          if (!Number.isSafeInteger(value.length) || value.length < 0 || value.length > 100000) throw Error('Invalid independent array length');
          const result = new Array(value.length); paths.set(path, result);
          for (const [key, child] of Object.entries(value.entries)) put(result, key, read(child, pointer(path, key)));
          return result;
        }
        case 'object': {
          const result = value.nullPrototype ? Object.create(null) : {}; paths.set(path, result);
          for (const [key, child] of Object.entries(value.entries)) put(result, key, read(child, pointer(path, key)));
          return result;
        }
        default: throw Error('Unsupported independent value tag');
      }
    }
    const result = Array.isArray(value) ? [] : {}; paths.set(path, result);
    for (const [key, child] of Object.entries(value)) put(result, key, read(child, pointer(path, key)));
    return result;
  }
  const result = read(input), targets = new Map(refs.map(([marker, path]) => {
    if (!paths.has(path)) throw Error('Invalid independent reference');
    return [marker, paths.get(path)];
  }));
  function resolve(value) {
    if (targets.has(value)) return targets.get(value);
    if (!value || typeof value !== 'object' || visited.has(value)) return value;
    visited.add(value);
    for (const key of Object.keys(value)) put(value, key, resolve(value[key]));
    return value;
  }
  return resolve(result);
}

// Structural snapshot, including holes, null prototypes, cycles, and aliases.
// Node ordinals are assigned by our traversal, not copied from production IDs.
export function independentGraph(values) {
  const nodes = [], seen = new Map();
  function token(value) {
    if (value === null) return ['null'];
    if (typeof value === 'number') return ['number', Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value)];
    if (typeof value === 'undefined') return ['undefined'];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value !== 'object') throw Error('Independent oracle only accepts data values');
    if (seen.has(value)) return ['reference', seen.get(value)];
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null) throw Error('Independent oracle rejects exotic prototypes');
    const id = nodes.length; seen.set(value, id);
    const node = {kind: array ? 'array' : 'object', nullPrototype: proto === null, properties: []};
    if (array) node.length = value.length;
    nodes.push(node);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length) throw Error('Independent oracle rejects symbol properties');
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!own(descriptor, 'value')) throw Error('Independent oracle rejects accessors');
      node.properties.push([key, token(descriptor.value)]);
    }
    return ['reference', id];
  }
  return {roots: values.map(token), nodes};
}

function completionValue(value, kind) {
  if (kind === 'throw' && Object.prototype.toString.call(value) === '[object Error]') return {name: String(value.name), message: String(value.message)};
  return value;
}

export function independentAction(text) {
  const trimmed = text.trim(), match = /```(?:json)?\s*\n([^]*?)\n```\s*$/.exec(trimmed);
  const action = JSON.parse(match ? match[1] : trimmed);
  if (!action || !['call', 'complete'].includes(action.type)) throw Error('Invalid independent action');
  return action;
}

/** Only trusted, bounded generated/pinned source is accepted by this audit.
 * vm limits accidental runaway computation; it is not an untrusted-code sandbox.
 * An independent outcome always requires a fresh execution, never cached labels.
 */
export async function independentNativeExecution(task, {timeoutMs = 1500} = {}) {
  if (task.language && task.language !== 'js') throw Error('Independent boundary audit requires already-lowered JavaScript');
  if (task.inputGraph || task.freshRandomCalls) throw Error('Independent boundary audit requires frozen readable inputs');
  const args = independentDecode(task.args ?? []), calls = task.fixture?.calls ?? [], observations = [];
  let next = 0, fixtureFailure = null, randomState = task.randomSeed ?? 17;
  const invoke = (operation, actual, promise = false) => {
    const expected = calls[next++];
    const graph = independentGraph(actual);
    if (!expected || expected.operation !== operation ||
        !isDeepStrictEqual(graph, independentGraph(independentDecode(expected.arguments ?? [])))) {
      fixtureFailure = Error('Independent native request differs from frozen fixture');
      throw fixtureFailure;
    }
    const value = independentDecode(expected.result);
    observations.push({operation, arguments: graph, status: expected.status ?? 'fulfilled', result: independentGraph([value])});
    if (expected.status === 'rejected') {
      if (promise) return Promise.reject(value);
      throw value;
    }
    return promise ? Promise.resolve(value) : value;
  };
  const host = {
    readNumber: (...xs) => invoke('demo.readNumber', xs),
    readAsync: (...xs) => invoke('demo.readAsync', xs, true),
    store: (...xs) => invoke('demo.store', xs),
    natlangCallSync: (...xs) => invoke('natlang.callSync', xs),
    natlangCall: (...xs) => invoke('natlang.call', xs, true),
  };
  // Match only the explicitly implemented observation capabilities. Unsupported
  // protocols fail closed, rather than turning into an invented response.
  const math = Object.create(Math);
  math.random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  const environment = {host, __independentArgs: args, Math: math,
    Date: {now: () => invoke('platform.dateNow', [])}, console: Object.fromEntries(
      ['log', 'info', 'warn', 'error'].map(name => [name, (...xs) => invoke('platform.console.' + name, xs)]))};
  for (const binding of task.nativeBindings ?? []) environment[binding.name] = (...xs) =>
    invoke(binding.kind === 'promise' ? 'natlang.call' : 'natlang.callSync', [binding.name, undefined, xs], binding.kind === 'promise');
  const context = vm.createContext(environment, {codeGeneration: {strings: false, wasm: false}});
  let value, kind = 'return', timer;
  try {
    const result = new vm.Script('"use strict";\n' + task.source + '\n;' + (task.entry ?? 'run') + '(...__independentArgs);')
      .runInContext(context, {timeout: timeoutMs});
    value = await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Independent native timeout')), timeoutMs); })]);
  } catch (error) { kind = 'throw'; value = error; }
  finally { clearTimeout(timer); }
  if (fixtureFailure) throw fixtureFailure;
  if (next !== calls.length) throw Error('Independent native execution left unused observations');
  if (kind === 'throw' && /Independent native timeout|Script execution timed out/.test(String(value))) throw value;
  return {schema: 'independent-js-data-observations/1', profile: 'plain-data+serial-demo-platform-native/1',
    kind, completion: independentGraph([...args, completionValue(value, kind)]), observations};
}

export function independentTranscriptMatches(native, texts, task) {
  try {
    const actions = texts.map(independentAction), complete = actions.at(-1);
    if (!complete || complete.type !== 'complete' || actions.slice(0, -1).some(a => a.type !== 'call')) return false;
    if (complete.kind !== native.kind) return false;
    const result = independentDecode({arguments: complete.arguments, value: complete.value});
    if (!Array.isArray(result.arguments) || !isDeepStrictEqual(
      independentGraph([...result.arguments, result.value]), native.completion)) return false;
    const requests = actions.slice(0, -1);
    if (requests.length !== native.observations.length) return false;
    return requests.every((action, i) => {
      const args = independentDecode(action.arguments), binding = (task.nativeBindings ?? []).find(b => b.name === action.operation);
      const operation = binding ? (binding.kind === 'promise' ? 'natlang.call' : 'natlang.callSync') : action.operation;
      const actual = binding ? [binding.name, undefined, args] : args;
      return operation === native.observations[i].operation && isDeepStrictEqual(independentGraph(actual), native.observations[i].arguments);
    });
  } catch { return false; }
}

// Audit the displayed observations as well as requests/completion. This catches
// a shared production renderer/codec defect even if its final outcome happens
// to remain correct. Initial public instructions are audited elsewhere.
export function independentConversationMatches(native,messages,task) {
  try {
    if(messages[0]?.role!=='system'||messages[1]?.role!=='user')return false;
    const texts=[];let observation=0,completed=false;
    for(let i=2;i<messages.length;i++){
      const message=messages[i];if(completed||message.role!=='assistant')return false;
      texts.push(message.content);const action=independentAction(message.content);
      if(action.type==='complete'){completed=true;continue;}
      const response=messages[++i],expected=native.observations[observation++];
      const prefix='External observation for '+action.operation+': ';
      if(!expected||response?.role!=='user'||!response.content.startsWith(prefix))return false;
      const payload=JSON.parse(response.content.slice(prefix.length));
      if(Object.keys(payload).sort().join(',')!=='status,value'||payload.status!==expected.status||
        !isDeepStrictEqual(independentGraph([independentDecode(payload.value)]),expected.result))return false;
    }
    return completed&&observation===native.observations.length&&independentTranscriptMatches(native,texts,task);
  }catch{return false;}
}
