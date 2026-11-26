// Shared JS fetch() -> http.request interception helpers for native worker replay and live harvesting.
import {parse} from 'acorn';

export const DEFAULT_FETCH_TIMEOUT_MS = 4000;
export const MAX_FETCH_BODY_BYTES = 48 * 1024;

function isArrayBufferLike(value) {
  if (!value || typeof value !== 'object') return false;
  if (ArrayBuffer.isView(value)) return true;
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

function bytesToUtf8OrBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return {body: new TextDecoder('utf-8', {fatal: true}).decode(view), bodyEncoding: 'utf-8'};
  } catch {
    return {body: Buffer.from(view).toString('base64'), bodyEncoding: 'base64'};
  }
}

/** Normalize JS fetch(input, init) into canonical 4-arg [url, method, headers, body] for http.request. */
export function normalizeFetchRequest(input, init = {}) {
  const opts = init && typeof init === 'object' ? init : {};
  let url = '';
  let inputMethod = null;
  let inputHeaders = null;
  let inputBody;

  if (typeof input === 'string') {
    url = input;
  } else if (input && typeof input === 'object') {
    if (typeof input.href === 'string' && typeof input.origin === 'string') {
      url = input.href;
    } else if (typeof input.url === 'string') {
      url = input.url;
      inputMethod = input.method ?? null;
      inputHeaders = input.headers ?? null;
      inputBody = input.body;
    } else {
      url = String(input);
    }
  } else {
    url = String(input);
  }

  const method = String(opts.method ?? inputMethod ?? 'GET').toUpperCase();

  const headersObj = {};
  const collectHeaders = src => {
    if (!src || typeof src !== 'object') return;
    if (typeof src.entries === 'function') {
      for (const [k, v] of src.entries()) headersObj[String(k).toLowerCase()] = String(v);
      return;
    }
    if (Array.isArray(src)) {
      for (const entry of src) {
        if (Array.isArray(entry) && entry.length >= 2) {
          headersObj[String(entry[0]).toLowerCase()] = String(entry[1]);
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== null) headersObj[String(k).toLowerCase()] = String(v);
    }
  };
  collectHeaders(inputHeaders);
  collectHeaders(opts.headers);

  const sortedHeaders = Object.fromEntries(
    Object.keys(headersObj).sort().map(k => [k, headersObj[k]]),
  );

  const rawBody = opts.body !== undefined ? opts.body : inputBody;
  let body = null;
  if (rawBody !== undefined && rawBody !== null) {
    if (typeof rawBody === 'string') {
      body = rawBody;
    } else if (Object.prototype.toString.call(rawBody) === '[object URLSearchParams]' && typeof rawBody.toString === 'function') {
      body = rawBody.toString();
      if (!Object.hasOwn(sortedHeaders, 'content-type')) {
        sortedHeaders['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      }
    } else if (isArrayBufferLike(rawBody)) {
      const view = ArrayBuffer.isView(rawBody)
        ? new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
        : new Uint8Array(rawBody);
      body = bytesToUtf8OrBase64(view).body;
    } else {
      body = String(rawBody);
    }
  }

  const finalHeaders = Object.fromEntries(
    Object.keys(sortedHeaders).sort().map(k => [k, sortedHeaders[k]]),
  );
  return [url, method, finalHeaders, body];
}

/** VM-side Web Fetch API runtime script bound to host __platformFetch(input, init). */
export const VM_FETCH_RUNTIME_SCRIPT = `(function(){
  class Headers {
    constructor(init) {
      this._map = new Map();
      if (!init) return;
      if (typeof init.entries === 'function') {
        for (const [k, v] of init.entries()) this.append(k, v);
      } else if (Array.isArray(init)) {
        for (const entry of init) {
          if (Array.isArray(entry) && entry.length >= 2) this.append(entry[0], entry[1]);
        }
      } else if (typeof init === 'object') {
        for (const [k, v] of Object.entries(init)) {
          if (v !== undefined && v !== null) this.set(k, v);
        }
      }
    }
    _norm(name) { return String(name).toLowerCase(); }
    get(name) { const k = this._norm(name); return this._map.has(k) ? this._map.get(k) : null; }
    has(name) { return this._map.has(this._norm(name)); }
    set(name, value) { this._map.set(this._norm(name), String(value)); }
    append(name, value) {
      const k = this._norm(name);
      const prev = this._map.get(k);
      this._map.set(k, prev === undefined ? String(value) : prev + ', ' + String(value));
    }
    delete(name) { this._map.delete(this._norm(name)); }
    *entries() { for (const pair of this._map.entries()) yield pair; }
    *keys() { for (const k of this._map.keys()) yield k; }
    *values() { for (const v of this._map.values()) yield v; }
    forEach(cb, thisArg) { for (const [k, v] of this._map.entries()) cb.call(thisArg, v, k, this); }
    [Symbol.iterator]() { return this.entries(); }
  }

  function decodePayloadBytes(body, bodyEncoding) {
    if (bodyEncoding === 'base64') {
      const bin = atob(String(body || ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(String(body ?? ''));
  }

  function decodePayloadText(body, bodyEncoding) {
    if (bodyEncoding === 'base64') {
      return new TextDecoder('utf-8').decode(decodePayloadBytes(body, bodyEncoding));
    }
    return String(body ?? '');
  }

  class Response {
    constructor(payload, fallbackUrl) {
      const data = payload && typeof payload === 'object' ? payload : {status: 200, statusText: 'OK', url: fallbackUrl, headers: {}, body: String(payload ?? '')};
      this.status = Number(data.status ?? 200);
      this.statusText = String(data.statusText ?? '');
      this.ok = this.status >= 200 && this.status < 300;
      this.url = String(data.url ?? fallbackUrl ?? '');
      this.headers = new Headers(data.headers ?? {});
      this.bodyUsed = false;
      this._rawBody = data.body ?? '';
      this._bodyEncoding = data.bodyEncoding ?? 'utf-8';
      this._fallbackUrl = fallbackUrl ?? '';
    }
    clone() {
      return new Response({
        status: this.status,
        statusText: this.statusText,
        url: this.url,
        headers: Object.fromEntries(this.headers.entries()),
        body: this._rawBody,
        bodyEncoding: this._bodyEncoding,
      }, this._fallbackUrl);
    }
    text() {
      this.bodyUsed = true;
      return Promise.resolve(decodePayloadText(this._rawBody, this._bodyEncoding));
    }
    json() {
      this.bodyUsed = true;
      return Promise.resolve().then(() => JSON.parse(decodePayloadText(this._rawBody, this._bodyEncoding)));
    }
    arrayBuffer() {
      this.bodyUsed = true;
      const bytes = decodePayloadBytes(this._rawBody, this._bodyEncoding);
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    bytes() {
      this.bodyUsed = true;
      return Promise.resolve(decodePayloadBytes(this._rawBody, this._bodyEncoding));
    }
  }

  globalThis.Headers = Headers;
  globalThis.Response = Response;
  globalThis.fetch = async function fetch(input, init) {
    let payload;
    try {
      payload = await globalThis.__platformFetch(input, init);
    } catch (err) {
      const msg = (err && typeof err === 'object' && 'message' in err) ? String(err.message) : String(err);
      const name = (err && typeof err === 'object' && typeof err.name === 'string') ? err.name : 'TypeError';
      if (name === 'Error') throw new Error(msg);
      throw new TypeError(msg);
    }
    const url = typeof input === 'string' ? input : (input && typeof input === 'object' && 'url' in input ? String(input.url) : String(input));
    return new Response(payload, url);
  };
})();`;

/** Live-capture fetch wrapper that executes one real HTTP request and records http.request into recordedCalls. */
export function createLiveFetchRecorder(
  recordedCalls,
  {timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, maxBodyBytes = MAX_FETCH_BODY_BYTES, encodeReadable = x => x} = {},
) {
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function') {
    throw new Error('Global fetch() is unavailable in this Node runtime');
  }

  async function readBoundedBytes(realResp) {
    if (!realResp.body || typeof realResp.body.getReader !== 'function') {
      const buf = new Uint8Array(await realResp.arrayBuffer());
      return buf.byteLength > maxBodyBytes ? buf.subarray(0, maxBodyBytes) : buf;
    }
    const reader = realResp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (total < maxBodyBytes) {
        const {done, value} = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const remaining = maxBodyBytes - total;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          try { await reader.cancel(); } catch {}
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  async function liveFetch(input, init) {
    const [reqUrl, method, headersObj, bodyVal] = normalizeFetchRequest(input, init);
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([init.signal, timeoutSig])
      : timeoutSig;
    const reqInit = {
      method,
      headers: headersObj,
      signal,
      ...(bodyVal !== null ? {body: bodyVal} : {}),
    };
    try {
      const realResp = await realFetch(reqUrl, reqInit);
      const rawBytes = await readBoundedBytes(realResp);
      const respHeaders = Object.fromEntries(
        [...realResp.headers.entries()].map(([k, v]) => [String(k).toLowerCase(), String(v)]),
      );
      const {body, bodyEncoding} = bytesToUtf8OrBase64(rawBytes);
      const resultPayload = {
        status: Number(realResp.status),
        statusText: String(realResp.statusText ?? ''),
        url: String(realResp.url || reqUrl),
        headers: respHeaders,
        body,
        ...(bodyEncoding === 'base64' ? {bodyEncoding: 'base64'} : {}),
      };
      recordedCalls.push({
        operation: 'http.request',
        arguments: encodeReadable([reqUrl, method, headersObj, bodyVal]),
        status: 'fulfilled',
        result: encodeReadable(resultPayload),
      });
      return resultPayload;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const name = err?.name === 'Error' ? 'Error' : 'TypeError';
      const errPayload = {name, message: msg};
      recordedCalls.push({
        operation: 'http.request',
        arguments: encodeReadable([reqUrl, method, headersObj, bodyVal]),
        status: 'rejected',
        result: errPayload,
      });
      throw errPayload;
    }
  }

  return {liveFetch};
}

/** Detect free global `fetch` / `globalThis.fetch` references strictly from public JS AST. */
export function sourceUsesGlobalFetch(source) {
  let ast;
  try {
    ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
  } catch {
    try {
      ast = parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
    } catch {
      return /(?:^|[^.\w$])(?:globalThis\.)?fetch\s*\(/.test(source);
    }
  }

  function hasDeclaredFetch(scopeNode) {
    if (!scopeNode || typeof scopeNode !== 'object') return false;
    if (scopeNode.type === 'FunctionDeclaration' && scopeNode.id?.name === 'fetch') return true;
    return false;
  }

  let found = false;
  function visit(node, parent, shadowed) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, shadowed);
      return;
    }
    if (typeof node.type !== 'string') return;

    let nextShadowed = shadowed;
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      for (const st of node.body ?? []) {
        if (hasDeclaredFetch(st)) { nextShadowed = true; break; }
      }
    } else if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      const params = node.params ?? [];
      const shadows = (node.id?.name === 'fetch') || params.some(p => p?.type === 'Identifier' && p.name === 'fetch');
      if (shadows) nextShadowed = true;
    }

    if (node.type === 'MemberExpression' && !node.computed &&
        node.object?.type === 'Identifier' && node.object.name === 'globalThis' &&
        node.property?.type === 'Identifier' && node.property.name === 'fetch') {
      found = true;
      return;
    }

    if (!nextShadowed && node.type === 'Identifier' && node.name === 'fetch') {
      const isNonRef =
        (parent?.type === 'MemberExpression' && !parent.computed && parent.property === node) ||
        (parent?.type === 'Property' && !parent.computed && parent.key === node) ||
        (parent?.type === 'MethodDefinition' && !parent.computed && parent.key === node) ||
        (parent?.type === 'FunctionDeclaration' && parent.id === node) ||
        (parent?.type === 'FunctionExpression' && parent.id === node) ||
        (parent?.type === 'VariableDeclarator' && parent.id === node);
      if (!isNonRef) {
        found = true;
        return;
      }
    }

    for (const [key, val] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'raw') continue;
      if (val && typeof val === 'object') visit(val, node, nextShadowed);
    }
  }

  visit(ast, null, false);
  return found;
}
