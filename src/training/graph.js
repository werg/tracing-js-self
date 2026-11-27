// Identity-preserving boundary for training values and owned graphs.
// No user getter, toJSON, coercion hook, or guest code is invoked.
import {
  inspectDataObject,
  inspectOwnedDataEntity,
  inspectObservableValue,
  isErrorInstance,
  extractSafeErrorFields,
  createDecodedInstance,
  decodeTypedArray,
} from './data-graph-contract.js';
import {ownedExceptionFields} from './owned-exception-profile.js';
import {encode, decode, token} from '../values.js';
import {stringPropertyKey, stringPropertyName} from '../property-keys.js';

export function importGraph(state, roots, allocate, {maxNodes = 256, maxProperties = 4096} = {}) {
  if (!Array.isArray(roots)) throw new TypeError('Entry arguments must be an array');
  const seen = new WeakMap();
  let properties = 0, nodes = 0;
  function visit(value) {
    if (value === null || typeof value !== 'object') return encode(value);
    if (seen.has(value)) return ['ref', seen.get(value)];
    const {kind, prototype, descriptors, extensible} = inspectDataObject(value);
    const array = kind === 'array';
    if (++nodes > maxNodes) throw new RangeError('Entry graph node limit');
    const id = allocate('obj');
    seen.set(value, id);
    const dataAttributes = {};
    let hasCustomAttrs = false;
    const entity = {
      id, kind,
      ...(prototype === null ? {prototype: null} : {}),
      ...(extensible === false ? {extensible: false} : {}),
      properties: {},
      propertyVersions: {}, shapeVersion: 0, version: 0,
    };
    state.heap[id] = entity;
    if (array && descriptors.get('length').value > maxProperties)
      throw new RangeError('Entry array limit');
    for (const [key, descriptor] of descriptors) {
      if (++properties > maxProperties) throw new RangeError('Entry property limit');
      const propKey = stringPropertyKey(key);
      if (array && key === 'length') {
        entity.properties.length = token(encode(value.length));
      } else {
        entity.properties[propKey] = token(visit(descriptor.value));
      }
      if (!descriptor.writable || !descriptor.configurable) {
        dataAttributes[propKey] = {
          writable: Boolean(descriptor.writable),
          enumerable: Boolean(descriptor.enumerable),
          configurable: Boolean(descriptor.configurable),
        };
        hasCustomAttrs = true;
      }
      entity.propertyVersions[propKey] = 0;
    }
    if (hasCustomAttrs) entity.dataAttributes = dataAttributes;
    // Absent array indices are holes. Present undefined entries remain own
    // properties, including across cyclic and aliased imported graphs.
    return ['ref', id];
  }
  return roots.map(visit);
}

function realizeDescribeGraph(graph) {
  if (!graph || !Array.isArray(graph.roots) || !Array.isArray(graph.objects)) {
    throw new TypeError('Invalid described graph envelope');
  }
  const nodesById = new Map();
  const allocated = new Map();
  for (const node of graph.objects) {
    nodesById.set(node.id, node);
    let obj;
    if (node.kind === 'array') {
      const lenEntry = node.properties.find(p => (Array.isArray(p) ? p[0] : p.key) === 'length');
      const len = lenEntry ? decode(Array.isArray(lenEntry) ? lenEntry[1] : lenEntry.value) : 0;
      obj = new Array(len);
    } else if (node.kind === 'date') {
      obj = new Date(decode(node.ms));
    } else if (node.kind === 'regexp') {
      obj = new RegExp(node.source, node.flags);
    } else if (node.kind === 'typedarray') {
      obj = decodeTypedArray(node.type, node.b64);
    } else if (node.kind === 'map') {
      obj = new Map();
    } else if (node.kind === 'set') {
      obj = new Set();
    } else if (node.kind === 'instance') {
      obj = createDecodedInstance(node.className);
    } else if (node.kind === 'object') {
      obj = node.prototype === null ? Object.create(null) : {};
    } else {
      throw new TypeError(`Unsupported graph node kind: ${String(node.kind)}`);
    }
    allocated.set(node.id, obj);
  }
  const visit = value => {
    if (!Array.isArray(value)) return decode(value);
    if (value[0] === 'ref') {
      if (!allocated.has(value[1])) throw new TypeError(`Unresolved graph reference: ${String(value[1])}`);
      return allocated.get(value[1]);
    }
    return decode(value);
  };
  for (const node of graph.objects) {
    const output = allocated.get(node.id);
    if (node.kind === 'map') {
      for (const [kTok, vTok] of node.entries) {
        output.set(visit(kTok), visit(vTok));
      }
      continue;
    }
    if (node.kind === 'set') {
      for (const itemTok of node.items) {
        output.add(visit(itemTok));
      }
      continue;
    }
    if (node.kind === 'date' || node.kind === 'regexp' || node.kind === 'typedarray') {
      continue;
    }
    for (const property of node.properties) {
      const [key, valTok] = Array.isArray(property) ? property : [property.key, property.value];
      if (node.kind === 'array' && key === 'length') continue;
      Object.defineProperty(output, key, {
        value: visit(valTok),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }
  return graph.roots.map(visit);
}

export function realizeGraph(heapOrGraph, roots, {exceptionProfile = false} = {}) {
  if (roots === undefined && heapOrGraph && Array.isArray(heapOrGraph.roots) && Array.isArray(heapOrGraph.objects)) {
    return realizeDescribeGraph(heapOrGraph);
  }
  const heap = heapOrGraph;
  const seen = new Map();
  function visit(value) {
    if (value[0] !== 'ref') return decode(value);
    const id = value[1];
    if (seen.has(id)) return seen.get(id);
    const entity = heap[id], exception = exceptionProfile ? ownedExceptionFields(entity) : null;
    if (exception) {
      const result = {}; seen.set(id, result);
      for (const {key, value} of exception) {
        Object.defineProperty(result, key, {value: visit(value), writable: true, configurable: true, enumerable: true});
      }
      return result;
    }
    if (entity?.kind === 'date') {
      const d = new Date(decode(entity.ms));
      seen.set(id, d);
      return d;
    }
    if (entity?.kind === 'regexp') {
      const r = new RegExp(entity.source, entity.flags);
      seen.set(id, r);
      return r;
    }
    if (entity?.kind === 'typedarray') {
      const ta = decodeTypedArray(entity.type, entity.b64);
      seen.set(id, ta);
      return ta;
    }
    if (entity?.kind === 'map') {
      const m = new Map();
      seen.set(id, m);
      for (const [kTok, vTok] of entity.entries ?? []) m.set(visit(kTok), visit(vTok));
      return m;
    }
    if (entity?.kind === 'set') {
      const s = new Set();
      seen.set(id, s);
      for (const itemTok of entity.items ?? []) s.add(visit(itemTok));
      return s;
    }
    if (entity?.kind === 'instance') {
      const inst = createDecodedInstance(entity.className);
      seen.set(id, inst);
      for (const [key, record] of Object.entries(entity.properties ?? {})) {
        Object.defineProperty(inst, stringPropertyName(key), {
          value: visit(record.value), writable: true, configurable: true, enumerable: true,
        });
      }
      return inst;
    }
    inspectOwnedDataEntity(entity);
    const result = entity.kind === 'array' ? new Array(decode(entity.properties.length.value)) :
      entity.prototype === null ? Object.create(null) : {};
    seen.set(id, result);
    for (const [key, record] of Object.entries(entity.properties)) {
      if (entity.kind === 'array' && key === 'length') continue;
      Object.defineProperty(result, stringPropertyName(key), {
        value: visit(record.value), writable: true, configurable: true, enumerable: true,
      });
    }
    return result;
  }
  return roots.map(visit);
}

// Used for independently comparing values, aliases, cycles, property absence,
// -0/NaN/Infinity, array length, built-ins, and instances without relying on JSON structural equality.
export function describeGraph(roots, {allowErrors = true} = {}) {
  const seen = new WeakMap(), objects = [];
  function visit(v) {
    if (v === null || typeof v !== 'object') return encode(v);
    if (seen.has(v)) return ['ref', seen.get(v)];
    const id = 'o' + objects.length;
    seen.set(v, id);
    const info = inspectObservableValue(v, {allowErrors});
    if (info.kind === 'error') {
      objects.push({id, kind: 'object', properties: [['name', ['str', info.name]], ['message', ['str', info.message]]]});
      return ['ref', id];
    }
    if (info.kind === 'date') {
      objects.push({id, kind: 'date', ms: encode(info.ms)});
      return ['ref', id];
    }
    if (info.kind === 'regexp') {
      objects.push({id, kind: 'regexp', source: info.source, flags: info.flags});
      return ['ref', id];
    }
    if (info.kind === 'typedarray') {
      objects.push({id, kind: 'typedarray', type: info.type, b64: info.b64});
      return ['ref', id];
    }
    if (info.kind === 'map') {
      const record = {id, kind: 'map', entries: []};
      objects.push(record);
      for (const [k, val] of info.entries) {
        record.entries.push([visit(k), visit(val)]);
      }
      return ['ref', id];
    }
    if (info.kind === 'set') {
      const record = {id, kind: 'set', items: []};
      objects.push(record);
      for (const item of info.items) {
        record.items.push(visit(item));
      }
      return ['ref', id];
    }
    if (info.kind === 'instance') {
      const record = {id, kind: 'instance', className: info.className, properties: []};
      objects.push(record);
      for (const [key, desc] of info.descriptors) {
        record.properties.push([key, visit(desc.value)]);
      }
      return ['ref', id];
    }
    const record = {id, kind: info.kind, ...(info.prototype === null ? {prototype: null} : {}), properties: []};
    objects.push(record);
    for (const [key, desc] of info.descriptors) {
      record.properties.push([key, visit(desc.value)]);
    }
    return ['ref', id];
  }
  return {roots: roots.map(visit), objects};
}

/** Completion graph encoder allowing any Error subclass/frozen/extended Error at throw & value boundaries. */
export function describeCompletionGraph(args, value, kind) {
  if (kind === 'throw' && isErrorInstance(value)) {
    return describeGraph([...args, extractSafeErrorFields(value)]);
  }
  return describeGraph([...args, value]);
}

/** Initial model graph with the *same* identities used by the owned journal.
 * Unlike an independent reference comparison, this must never renumber o1 as o0. */
export function describeOwnedGraph(heap, roots, {maxNodes = 256} = {}) {
  const seen = new Set(), objects = [];
  function visit(value) {
    if (!Array.isArray(value)) throw new TypeError('Invalid guest value in input graph');
    if (value[0] !== 'ref') return structuredClone(value);
    const id = value[1];
    if (seen.has(id)) return ['ref', id];
    const entity = heap[id];
    const prototype = inspectOwnedDataEntity(entity);
    if (seen.size >= maxNodes) throw new RangeError('Training graph node limit');
    seen.add(id);
    const record = {
      id, kind: entity.kind, ...(prototype === null ? {prototype: null} : {}),
      shapeVersion: entity.shapeVersion ?? 0, properties: [],
    };
    objects.push(record);
    for (const [key, entry] of Object.entries(entity.properties)) {
      record.properties.push({
        key: stringPropertyName(key), value: visit(entry.value),
        version: entity.propertyVersions?.[key] ?? 0,
      });
    }
    return ['ref', id];
  }
  return {roots: roots.map(visit), objects};
}
