// Descriptor-only, effect-free boundary inspection for JavaScript/TypeScript values.
// Never enumerate by reading guest values, coercing keys, invoking getters/Proxy traps, or calling toJSON.
import {types} from 'node:util';
import {isSymbolPropertyKey} from '../property-keys.js';
import {isProxy} from '#owned-proxy-check';

export const TYPED_ARRAY_CTORS = Object.freeze({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
});

export const TYPED_ARRAY_NAMES = new Set(Object.keys(TYPED_ARRAY_CTORS));

const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTagGet = Object.getOwnPropertyDescriptor(typedArrayProto, Symbol.toStringTag).get;
const typedArrayBufferGet = Object.getOwnPropertyDescriptor(typedArrayProto, 'buffer').get;
const typedArrayByteOffsetGet = Object.getOwnPropertyDescriptor(typedArrayProto, 'byteOffset').get;
const typedArrayByteLengthGet = Object.getOwnPropertyDescriptor(typedArrayProto, 'byteLength').get;
const dateGetTime = Date.prototype.getTime;
const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;
const regExpSourceGet = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
const REGEXP_FLAG_GETTERS = Object.freeze([
  ['d', Object.getOwnPropertyDescriptor(RegExp.prototype, 'hasIndices')?.get],
  ['g', Object.getOwnPropertyDescriptor(RegExp.prototype, 'global')?.get],
  ['i', Object.getOwnPropertyDescriptor(RegExp.prototype, 'ignoreCase')?.get],
  ['m', Object.getOwnPropertyDescriptor(RegExp.prototype, 'multiline')?.get],
  ['s', Object.getOwnPropertyDescriptor(RegExp.prototype, 'dotAll')?.get],
  ['u', Object.getOwnPropertyDescriptor(RegExp.prototype, 'unicode')?.get],
  ['v', Object.getOwnPropertyDescriptor(RegExp.prototype, 'unicodeSets')?.get],
  ['y', Object.getOwnPropertyDescriptor(RegExp.prototype, 'sticky')?.get],
]);

function ordinaryPrototype(proto, kind) {
  if (kind === 'array') {
    if (proto === Array.prototype) return true;
    // Reference execution runs in a separate vm realm.
    return Array.isArray(proto) &&
      !isProxy(proto) &&
      Object.getOwnPropertyDescriptor(
        Object.getOwnPropertyDescriptor(proto, 'constructor')?.value ?? {}, 'prototype',
      )?.value === proto;
  }
  if (proto === Object.prototype) return true;
  return proto !== null && !isProxy(proto) && Object.getPrototypeOf(proto) === null &&
    Object.getOwnPropertyDescriptor(proto, 'constructor')?.value?.name === 'Object' &&
    Object.getOwnPropertyDescriptor(
      Object.getOwnPropertyDescriptor(proto, 'constructor').value, 'prototype',
    )?.value === proto;
}

function hasHostileBuiltInSlot(value) {
  return types.isPromise(value) || types.isArrayBuffer(value) ||
    types.isSharedArrayBuffer(value) || types.isDataView(value) ||
    types.isWeakMap(value) || types.isWeakSet(value) ||
    types.isBoxedPrimitive(value) || types.isGeneratorObject(value) ||
    types.isModuleNamespaceObject(value) ||
    (typeof types.isWeakRef === 'function' && types.isWeakRef(value));
}

function hasBuiltinSlotOtherThanPlain(value) {
  return hasHostileBuiltInSlot(value) || types.isDate(value) || types.isRegExp(value) ||
    types.isMap(value) || types.isSet(value) || types.isTypedArray(value) ||
    types.isNativeError(value);
}

function assertPrototypeChainProxyFree(proto) {
  const seen = new Set();
  for (let cur = proto; cur !== null; cur = Object.getPrototypeOf(cur)) {
    if (isProxy(cur)) throw new TypeError('Unsupported observable boundary: Proxy prototype');
    if (seen.has(cur)) break;
    seen.add(cur);
  }
}

function isErrorPrototypeChain(proto) {
  const seen = new Set();
  for (let cur = proto; cur !== null; cur = Object.getPrototypeOf(cur)) {
    if (isProxy(cur)) throw new TypeError('Unsupported observable boundary: Proxy prototype');
    if (seen.has(cur)) break;
    seen.add(cur);
    if (cur === Error.prototype) return true;
    // Cross-realm Error.prototype (vm context)
    if (Object.getPrototypeOf(cur) === Object.prototype || (Object.getPrototypeOf(cur) !== null && Object.getPrototypeOf(Object.getPrototypeOf(cur)) === null)) {
      const ctorDesc = Object.getOwnPropertyDescriptor(cur, 'constructor');
      if (ctorDesc && Object.hasOwn(ctorDesc, 'value') && typeof ctorDesc.value === 'function') {
        const nameDesc = Object.getOwnPropertyDescriptor(ctorDesc.value, 'name');
        const protoDesc = Object.getOwnPropertyDescriptor(ctorDesc.value, 'prototype');
        if (nameDesc && Object.hasOwn(nameDesc, 'value') && nameDesc.value === 'Error' &&
            protoDesc && Object.hasOwn(protoDesc, 'value') && protoDesc.value === cur) {
          return true;
        }
      }
    }
  }
  return false;
}

export function isErrorInstance(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return false;
  if (types.isNativeError(value)) return true;
  return isErrorPrototypeChain(Object.getPrototypeOf(value));
}

function safePrimitiveString(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return String(val);
  return '';
}

function safeDataPropertyLookup(obj, propName) {
  const seen = new Set();
  for (let cur = obj; cur !== null; cur = Object.getPrototypeOf(cur)) {
    if (isProxy(cur)) throw new TypeError('Unsupported observable boundary: Proxy prototype');
    if (seen.has(cur)) break;
    seen.add(cur);
    const d = Object.getOwnPropertyDescriptor(cur, propName);
    if (d) {
      if (!Object.hasOwn(d, 'value')) {
        throw new TypeError(`Unsupported exception boundary: ${propName} accessor`);
      }
      return {found: true, value: d.value};
    }
  }
  return {found: false, value: undefined};
}

export function extractSafeErrorFields(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError('Unsupported exception boundary: expected Error object');
  }
  const nameLookup = safeDataPropertyLookup(value, 'name');
  let name = nameLookup.found ? safePrimitiveString(nameLookup.value) : '';
  if (!name) {
    const ctorLookup = safeDataPropertyLookup(Object.getPrototypeOf(value), 'constructor');
    if (ctorLookup.found && typeof ctorLookup.value === 'function') {
      const ctorNameDesc = Object.getOwnPropertyDescriptor(ctorLookup.value, 'name');
      if (ctorNameDesc && Object.hasOwn(ctorNameDesc, 'value') && typeof ctorNameDesc.value === 'string' && ctorNameDesc.value) {
        name = ctorNameDesc.value;
      }
    }
  }
  const msgLookup = safeDataPropertyLookup(value, 'message');
  const message = msgLookup.found ? safePrimitiveString(msgLookup.value) : '';
  return {name: name || 'Error', message};
}

function readInstanceClassName(proto) {
  assertPrototypeChainProxyFree(proto);
  const ctorDesc = Object.getOwnPropertyDescriptor(proto, 'constructor');
  if (ctorDesc && Object.hasOwn(ctorDesc, 'value') && typeof ctorDesc.value === 'function') {
    const nameDesc = Object.getOwnPropertyDescriptor(ctorDesc.value, 'name');
    if (nameDesc && Object.hasOwn(nameDesc, 'value') && typeof nameDesc.value === 'string' && nameDesc.value.length > 0) {
      return nameDesc.value;
    }
  }
  return 'Object';
}

export function createDecodedInstance(className) {
  const safeName = typeof className === 'string' && className.length > 0 ? className : 'Object';
  const proto = Object.create(Object.prototype);
  const ctor = function () {};
  Object.defineProperty(ctor, 'name', {value: safeName, writable: false, enumerable: false, configurable: true});
  Object.defineProperty(ctor, 'prototype', {value: proto, writable: false, enumerable: false, configurable: false});
  Object.defineProperty(proto, 'constructor', {value: ctor, writable: true, enumerable: false, configurable: true});
  return Object.create(proto);
}

export function decodeTypedArray(type, b64) {
  const Ctor = Object.hasOwn(TYPED_ARRAY_CTORS, type) ? TYPED_ARRAY_CTORS[type] : null;
  if (!Ctor) throw new TypeError(`Unsupported TypedArray type: ${String(type)}`);
  if (typeof b64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
    throw new TypeError('Invalid TypedArray base64 payload');
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
    throw new TypeError(`Invalid byte length for ${type}`);
  }
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Ctor(ab);
}

function inspectPlainDescriptors(value, kind) {
  const keys = Reflect.ownKeys(value), descriptors = new Map();
  for (const key of keys) {
    if (typeof key !== 'string' || key === '__proto__')
      throw new TypeError('Unsupported observable boundary: property key');
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value'))
      throw new TypeError('Unsupported observable boundary: accessor');
    if (kind === 'array' && key === 'length') {
      if (d.enumerable || d.configurable ||
         !Number.isSafeInteger(d.value) || d.value < 0 || d.value > 4294967295)
        throw new TypeError('Unsupported observable boundary: array length descriptor');
    } else if (!d.enumerable)
      throw new TypeError('Unsupported observable boundary: property descriptor');
    descriptors.set(key, d);
  }
  if (kind === 'array' && !descriptors.has('length'))
    throw new TypeError('Unsupported observable boundary: missing array length');
  return descriptors;
}

export function inspectDataObject(value) {
  if (value === null || typeof value !== 'object' || isProxy(value))
    throw new TypeError('Unsupported observable boundary: expected plain data object');
  if (hasBuiltinSlotOtherThanPlain(value))
    throw new TypeError('Unsupported observable boundary: custom prototype');
  const kind = Array.isArray(value) ? 'array' : 'object';
  const proto = Object.getPrototypeOf(value);
  if (!ordinaryPrototype(proto, kind) && !(kind === 'object' && proto === null))
    throw new TypeError('Unsupported observable boundary: custom prototype');
  const descriptors = inspectPlainDescriptors(value, kind);
  return {kind, prototype: proto === null ? null : 'ordinary', descriptors, extensible: Object.isExtensible(value)};
}

/** Descriptor-only, effect-free inspection for all observable JS boundary values:
 * plain objects/arrays (including frozen/sealed), Date, RegExp, Map, Set, TypedArrays,
 * Error subclasses, and plain-data class instances. Rejects Proxies, symbols, accessors, and functions. */
export function inspectObservableValue(value, {allowErrors = true} = {}) {
  if (value === null || typeof value !== 'object' || isProxy(value))
    throw new TypeError('Unsupported observable boundary: expected plain data object');
  if (hasHostileBuiltInSlot(value))
    throw new TypeError('Unsupported observable boundary: unsupported built-in object');

  if (isErrorInstance(value)) {
    if (!allowErrors) throw new TypeError('Unsupported observable boundary: Error object');
    return {kind: 'error', ...extractSafeErrorFields(value)};
  }

  if (types.isDate(value)) {
    assertPrototypeChainProxyFree(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__')
        throw new TypeError('Unsupported observable boundary: property key');
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !Object.hasOwn(d, 'value'))
        throw new TypeError('Unsupported observable boundary: accessor');
    }
    return {kind: 'date', ms: dateGetTime.call(value)};
  }

  if (types.isRegExp(value)) {
    assertPrototypeChainProxyFree(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'lastIndex')
        throw new TypeError('Unsupported observable boundary: RegExp extension');
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !Object.hasOwn(d, 'value'))
        throw new TypeError('Unsupported observable boundary: accessor');
    }
    const source = regExpSourceGet.call(value);
    let flags = '';
    for (const [ch, getter] of REGEXP_FLAG_GETTERS) {
      if (typeof getter === 'function' && getter.call(value)) flags += ch;
    }
    return {kind: 'regexp', source, flags};
  }

  if (types.isMap(value)) {
    assertPrototypeChainProxyFree(Object.getPrototypeOf(value));
    if (Reflect.ownKeys(value).length > 0)
      throw new TypeError('Unsupported observable boundary: Map extension');
    return {kind: 'map', entries: [...mapEntries.call(value)]};
  }

  if (types.isSet(value)) {
    assertPrototypeChainProxyFree(Object.getPrototypeOf(value));
    if (Reflect.ownKeys(value).length > 0)
      throw new TypeError('Unsupported observable boundary: Set extension');
    return {kind: 'set', items: [...setValues.call(value)]};
  }

  if (types.isTypedArray(value)) {
    assertPrototypeChainProxyFree(Object.getPrototypeOf(value));
    const type = typedArrayTagGet.call(value);
    if (!TYPED_ARRAY_NAMES.has(type))
      throw new TypeError(`Unsupported observable boundary: TypedArray ${String(type)}`);
    const byteLength = typedArrayByteLengthGet.call(value);
    const byteOffset = typedArrayByteOffsetGet.call(value);
    const buffer = typedArrayBufferGet.call(value);
    const expectedLen = byteLength / TYPED_ARRAY_CTORS[type].BYTES_PER_ELEMENT;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedLen)
      throw new TypeError('Unsupported observable boundary: TypedArray extension');
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== String(i))
        throw new TypeError('Unsupported observable boundary: TypedArray property key');
    }
    const b64 = Buffer.from(buffer, byteOffset, byteLength).toString('base64');
    return {kind: 'typedarray', type, b64};
  }

  const isArr = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (isArr) {
    if (!ordinaryPrototype(proto, 'array'))
      throw new TypeError('Unsupported observable boundary: array subclass');
    const descriptors = inspectPlainDescriptors(value, 'array');
    return {kind: 'array', prototype: 'ordinary', descriptors, extensible: Object.isExtensible(value)};
  }
  if (ordinaryPrototype(proto, 'object') || proto === null) {
    const descriptors = inspectPlainDescriptors(value, 'object');
    return {kind: 'object', prototype: proto === null ? null : 'ordinary', descriptors, extensible: Object.isExtensible(value)};
  }

  const className = readInstanceClassName(proto);
  const descriptors = inspectPlainDescriptors(value, 'object');
  return {kind: 'instance', className, descriptors, extensible: Object.isExtensible(value)};
}

// Owned entities use a separate descriptor representation. An accessor or
// custom prototype must never be flattened by the graph reconstruction.
export function inspectOwnedDataEntity(entity) {
  if (!entity || !['array', 'object'].includes(entity.kind))
    throw new TypeError('Unsupported observable boundary: non-data identity');
  if (Object.keys(entity.properties ?? {}).some(isSymbolPropertyKey))
    throw new TypeError('Unsupported observable boundary: owned symbol property transport');
  if (Object.keys(entity.accessors ?? {}).length)
    throw new TypeError('Unsupported observable boundary: owned accessor');
  if (entity.kind === 'array' && entity.prototype !== undefined &&
     entity.prototype !== 'Array.prototype')
    throw new TypeError('Unsupported observable boundary: array prototype');
  if (entity.kind === 'object' && entity.prototype !== undefined &&
     entity.prototype !== null && entity.prototype !== 'Object.prototype')
    throw new TypeError('Unsupported observable boundary: object prototype');
  return entity.prototype === null ? null : 'ordinary';
}
