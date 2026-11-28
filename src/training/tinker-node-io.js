// Shared Node/JS external I/O interception, live-capture recording, deterministic replay,
// and public AST tool scanning for native V8 execution and harvesting.
import {isDeepStrictEqual} from 'node:util';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeUrl from 'node:url';
import nodeCrypto from 'node:crypto';
import nodeChildProcess from 'node:child_process';
import {parse} from 'acorn';
import {hostOperation, HOST_OPERATIONS} from '../host/operations.js';
import {describeGraph, realizeGraph} from './graph.js';

export const WORKSPACE_CWD = '/workspace';

export const NODE_BUILTIN_EXTERNALS = Object.freeze([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'path',
  'node:path',
  'url',
  'node:url',
  'crypto',
  'node:crypto',
  'child_process',
  'node:child_process',
  'buffer',
  'node:buffer',
  'process',
  'node:process',
  'events',
  'node:events',
  'stream',
  'node:stream',
  'stream/promises',
  'node:stream/promises',
]);

export const NODE_IO_OPERATIONS = Object.freeze({
  'fs.readText': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation fs.readText (1 argument: [path]). Returns UTF-8 string content.',
  }),
  'fs.readBytes': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation fs.readBytes (1 argument: [path]). Returns Uint8Array bytes.',
  }),
  'fs.writeText': Object.freeze({
    kind: 'synchronous',
    arity: 2,
    description: 'Invoke JS external operation fs.writeText (2 arguments: [path, text]). Writes UTF-8 text and returns undefined.',
  }),
  'fs.writeBytes': Object.freeze({
    kind: 'synchronous',
    arity: 2,
    description: 'Invoke JS external operation fs.writeBytes (2 arguments: [path, bytes]). Writes Uint8Array bytes and returns undefined.',
  }),
  'fs.mkdir': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation fs.mkdir (1 argument: [path]). Creates directory path and returns undefined.',
  }),
  'fs.unlink': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation fs.unlink (1 argument: [path]). Removes file or directory path and returns undefined.',
  }),
  'fs.rename': Object.freeze({
    kind: 'synchronous',
    arity: 2,
    description: 'Invoke JS external operation fs.rename (2 arguments: [oldPath, newPath]). Renames/moves path and returns undefined.',
  }),
  'fs.exists': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation fs.exists (1 argument: [path]). Returns boolean.',
  }),
  'fs.readdir': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation fs.readdir (1 argument: [path]). Returns array of entry names.',
  }),
  'fs.stat': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation fs.stat (1 argument: [path]). Returns {"isFile":boolean,"isDirectory":boolean,"size":number}.',
  }),
  'env.get': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation env.get (1 argument: [name]). Returns environment variable string or null/undefined.',
  }),
  'env.cwd': Object.freeze({
    kind: 'synchronous',
    arity: 0,
    description: 'Invoke JS external operation env.cwd (0 arguments: []). Returns current working directory string.',
  }),
  'shell.exec': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation shell.exec (1 argument: [{"command":string,"args":string[]}]). Returns {"stdout":string,"stderr":string,"status":number}.',
  }),
  'platform.uuid': Object.freeze({
    kind: 'synchronous',
    arity: 0,
    description: 'Invoke JS external operation platform.uuid (0 arguments: []). Returns a UUID string.',
  }),
  'platform.randomBytes': Object.freeze({
    kind: 'synchronous',
    arity: 1,
    description: 'Invoke JS external operation platform.randomBytes (1 argument: [size]). Returns Uint8Array of random bytes.',
  }),
});

export function resolveOperationSpec(operation, {nativeMode = true} = {}) {
  if (nativeMode && Object.hasOwn(NODE_IO_OPERATIONS, operation)) {
    return NODE_IO_OPERATIONS[operation];
  }
  return hostOperation(operation);
}

export function normalizePathArg(rawPath) {
  if (typeof rawPath === 'string') return rawPath;
  if (rawPath && typeof rawPath === 'object' && typeof rawPath.href === 'string' && rawPath.protocol === 'file:') {
    return nodeUrl.fileURLToPath(rawPath);
  }
  if (Buffer.isBuffer(rawPath)) return rawPath.toString('utf8');
  return String(rawPath);
}

export function makeDeterministicPathModule(cwd = WORKSPACE_CWD) {
  const posix = nodePath.posix;
  const resolveAnchored = (...paths) => {
    const strPaths = paths.map(p => String(p));
    let resolved = '';
    let resolvedAbsolute = false;
    for (let i = strPaths.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      const part = i >= 0 ? strPaths[i] : cwd;
      if (!part) continue;
      resolved = part + '/' + resolved;
      resolvedAbsolute = part.startsWith('/');
    }
    const normalized = posix.normalize(resolved);
    if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1);
    return normalized || '/';
  };
  const relativeAnchored = (from, to) => posix.relative(resolveAnchored(from), resolveAnchored(to));
  const anchoredPosix = {
    ...posix,
    resolve: resolveAnchored,
    relative: relativeAnchored,
  };
  return {
    ...anchoredPosix,
    posix: anchoredPosix,
    win32: nodePath.win32,
  };
}

export function makePureCryptoBindings() {
  return {
    createHash: nodeCrypto.createHash.bind(nodeCrypto),
    createHmac: nodeCrypto.createHmac.bind(nodeCrypto),
    timingSafeEqual: nodeCrypto.timingSafeEqual.bind(nodeCrypto),
    pbkdf2Sync: nodeCrypto.pbkdf2Sync.bind(nodeCrypto),
    scryptSync: nodeCrypto.scryptSync.bind(nodeCrypto),
    hkdfSync: nodeCrypto.hkdfSync.bind(nodeCrypto),
    constants: nodeCrypto.constants,
  };
}

export function makePureUrlModule() {
  return {
    URL,
    URLSearchParams,
    fileURLToPath: nodeUrl.fileURLToPath,
    pathToFileURL: nodeUrl.pathToFileURL,
    format: nodeUrl.format,
    parse: nodeUrl.parse,
    resolve: nodeUrl.resolve,
  };
}

/** VM-side Node I/O runtime bound to host globalThis.__platformNodeIo.
 * Provides require(), process (with Proxy process.env), Buffer, crypto, fs, fs/promises, path, url, child_process. */
export const VM_NODE_IO_RUNTIME_SCRIPT = `(function(){
  const io = globalThis.__platformNodeIo;
  const HostBuffer = io.Buffer;
  const statMeta = new WeakMap();

  class Stats {
    constructor(data) {
      const info = data && typeof data === 'object' ? data : {};
      this.size = Number(info.size ?? 0);
      statMeta.set(this, {
        isFile: Boolean(info.isFile),
        isDirectory: Boolean(info.isDirectory),
        isSymbolicLink: Boolean(info.isSymbolicLink),
      });
    }
    isFile() { return Boolean(statMeta.get(this)?.isFile); }
    isDirectory() { return Boolean(statMeta.get(this)?.isDirectory); }
    isSymbolicLink() { return Boolean(statMeta.get(this)?.isSymbolicLink); }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
  }

  function toVmError(err) {
    if (err instanceof Error) return err;
    const msg = (err && typeof err === 'object' && 'message' in err) ? String(err.message) : String(err);
    const name = (err && typeof err === 'object' && typeof err.name === 'string' && err.name) ? err.name : 'Error';
    const e = new Error(msg);
    if (name !== 'Error') e.name = name;
    if (err && typeof err === 'object' && typeof err.code === 'string') e.code = err.code;
    else if (/^ENOENT\\b/.test(msg)) e.code = 'ENOENT';
    if (err && typeof err === 'object' && typeof err.status === 'number') e.status = err.status;
    if (err && typeof err === 'object' && err.stdout !== undefined) e.stdout = err.stdout;
    if (err && typeof err === 'object' && err.stderr !== undefined) e.stderr = err.stderr;
    return e;
  }

  function callSync(fn, ...args) {
    try { return fn(...args); }
    catch (err) { throw toVmError(err); }
  }

  async function callAsync(fn, ...args) {
    try { return await fn(...args); }
    catch (err) { throw toVmError(err); }
  }

  function extractEncoding(opts) {
    if (opts === undefined || opts === null) return null;
    if (typeof opts === 'string') return opts;
    if (typeof opts === 'object' && opts.encoding != null) return String(opts.encoding);
    return null;
  }

  function isUtf8Encoding(enc) {
    if (!enc) return false;
    const norm = String(enc).toLowerCase();
    return norm === 'utf8' || norm === 'utf-8';
  }

  function toNodeBuffer(val) {
    if (HostBuffer.isBuffer(val)) return val;
    if (ArrayBuffer.isView(val)) return HostBuffer.from(val.buffer, val.byteOffset, val.byteLength);
    if (val instanceof ArrayBuffer) return HostBuffer.from(val);
    if (typeof val === 'string') return HostBuffer.from(val, 'base64');
    return HostBuffer.from(val ?? []);
  }

  function isBinaryData(data) {
    return HostBuffer.isBuffer(data) || ArrayBuffer.isView(data) || data instanceof ArrayBuffer;
  }

  function toUint8Array(data) {
    if (data instanceof Uint8Array && !HostBuffer.isBuffer(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data.slice(0));
    }
    const buf = toNodeBuffer(data);
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }

  function encodeWritePayload(data, opts) {
    if (typeof data === 'string') return data;
    const enc = extractEncoding(opts);
    if (ArrayBuffer.isView(data)) {
      return HostBuffer.from(data.buffer, data.byteOffset, data.byteLength).toString(enc || 'utf8');
    }
    if (data instanceof ArrayBuffer) {
      return HostBuffer.from(data).toString(enc || 'utf8');
    }
    return String(data);
  }

  function encodeExecStream(text, opts) {
    const enc = extractEncoding(opts);
    if (enc && enc !== 'buffer') {
      return HostBuffer.from(text, 'utf8').toString(enc);
    }
    return HostBuffer.from(text, 'utf8');
  }

  function buildExecPayload(command, args, opts) {
    const payload = {command: String(command), args};
    if (opts && typeof opts === 'object') {
      if (opts.cwd !== undefined && opts.cwd !== null) {
        payload.cwd = io.normalizePath(opts.cwd);
      }
      if (opts.env !== undefined && opts.env !== null && typeof opts.env === 'object') {
        const plainEnv = {};
        for (const key of Object.keys(opts.env)) {
          const v = opts.env[key];
          if (v !== undefined) plainEnv[key] = String(v);
        }
        payload.env = plainEnv;
      }
      if (opts.input !== undefined && opts.input !== null) {
        payload.input = typeof opts.input === 'string'
          ? opts.input
          : toNodeBuffer(opts.input).toString(extractEncoding(opts) || 'utf8');
      }
    }
    return payload;
  }

  function wrapExecResult(res, cmd, opts) {
    const info = res && typeof res === 'object' ? res : {stdout: '', stderr: '', status: 0};
    const stdoutText = String(info.stdout ?? '');
    const stderrText = String(info.stderr ?? '');
    const status = typeof info.status === 'number' ? info.status : 0;
    const outPayload = encodeExecStream(stdoutText, opts);
    if (status !== 0) {
      const err = new Error('Command failed: ' + cmd + ' (status ' + status + ')');
      err.status = status;
      err.stdout = outPayload;
      err.stderr = stderrText;
      throw err;
    }
    return outPayload;
  }

  function isEnoentError(err) {
    if (!err || typeof err !== 'object') return false;
    if (err.code === 'ENOENT') return true;
    return /^ENOENT\\b/.test(String(err.message ?? ''));
  }

  const fsConstants = Object.freeze({
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
  });

  const fsPromises = {
    constants: fsConstants,
    async readFile(path, opts) {
      const p = io.normalizePath(path);
      const enc = extractEncoding(opts);
      if (isUtf8Encoding(enc)) return await callAsync(io.fsReadTextAsync, p);
      const raw = await callAsync(io.fsReadBytesAsync, p);
      const buf = toNodeBuffer(raw);
      return enc ? buf.toString(enc) : buf;
    },
    async writeFile(path, data, opts) {
      const p = io.normalizePath(path);
      if (isBinaryData(data) && !extractEncoding(opts)) {
        return await callAsync(io.fsWriteBytesAsync, p, toUint8Array(data));
      }
      return await callAsync(io.fsWriteTextAsync, p, encodeWritePayload(data, opts));
    },
    async appendFile(path, data, opts) {
      const p = io.normalizePath(path);
      const exists = Boolean(await callAsync(io.fsExistsAsync, p));
      if (isBinaryData(data) && !extractEncoding(opts)) {
        const nextBytes = toNodeBuffer(data);
        const combined = exists
          ? HostBuffer.concat([toNodeBuffer(await callAsync(io.fsReadBytesAsync, p)), nextBytes])
          : nextBytes;
        return await callAsync(io.fsWriteBytesAsync, p, toUint8Array(combined));
      }
      const chunk = encodeWritePayload(data, opts);
      const prev = exists ? String((await callAsync(io.fsReadTextAsync, p)) ?? '') : '';
      return await callAsync(io.fsWriteTextAsync, p, prev + chunk);
    },
    async mkdir(path, _opts) {
      const p = io.normalizePath(path);
      return await callAsync(io.fsMkdirAsync, p);
    },
    async unlink(path) {
      const p = io.normalizePath(path);
      return await callAsync(io.fsUnlinkAsync, p);
    },
    async rm(path, opts) {
      const p = io.normalizePath(path);
      try {
        return await callAsync(io.fsUnlinkAsync, p);
      } catch (err) {
        if (opts && typeof opts === 'object' && opts.force && isEnoentError(err)) return undefined;
        throw err;
      }
    },
    async rmdir(path, opts) {
      return await fsPromises.rm(path, opts);
    },
    async rename(oldPath, newPath) {
      return await callAsync(io.fsRenameAsync, io.normalizePath(oldPath), io.normalizePath(newPath));
    },
    async copyFile(src, dest, _mode) {
      const raw = await callAsync(io.fsReadBytesAsync, io.normalizePath(src));
      return await callAsync(io.fsWriteBytesAsync, io.normalizePath(dest), toUint8Array(raw));
    },
    async access(path, _mode) {
      const p = io.normalizePath(path);
      const ok = Boolean(await callAsync(io.fsExistsAsync, p));
      if (!ok) {
        const err = new Error('ENOENT: no such file or directory, access ' + JSON.stringify(p));
        err.code = 'ENOENT';
        throw err;
      }
      return undefined;
    },
    async readdir(path) {
      return await callAsync(io.fsReaddirAsync, io.normalizePath(path));
    },
    async stat(path) {
      return new Stats(await callAsync(io.fsStatAsync, io.normalizePath(path)));
    },
    async lstat(path) {
      return new Stats(await callAsync(io.fsStatAsync, io.normalizePath(path)));
    },
  };

  const fsModule = {
    constants: fsConstants,
    readFileSync(path, opts) {
      const p = io.normalizePath(path);
      const enc = extractEncoding(opts);
      if (isUtf8Encoding(enc)) return callSync(io.fsReadText, p);
      const buf = toNodeBuffer(callSync(io.fsReadBytes, p));
      return enc ? buf.toString(enc) : buf;
    },
    writeFileSync(path, data, opts) {
      const p = io.normalizePath(path);
      if (isBinaryData(data) && !extractEncoding(opts)) {
        return callSync(io.fsWriteBytes, p, toUint8Array(data));
      }
      return callSync(io.fsWriteText, p, encodeWritePayload(data, opts));
    },
    appendFileSync(path, data, opts) {
      const p = io.normalizePath(path);
      const exists = Boolean(callSync(io.fsExists, p));
      if (isBinaryData(data) && !extractEncoding(opts)) {
        const nextBytes = toNodeBuffer(data);
        const combined = exists
          ? HostBuffer.concat([toNodeBuffer(callSync(io.fsReadBytes, p)), nextBytes])
          : nextBytes;
        return callSync(io.fsWriteBytes, p, toUint8Array(combined));
      }
      const chunk = encodeWritePayload(data, opts);
      const prev = exists ? String(callSync(io.fsReadText, p) ?? '') : '';
      return callSync(io.fsWriteText, p, prev + chunk);
    },
    mkdirSync(path, _opts) {
      return callSync(io.fsMkdir, io.normalizePath(path));
    },
    unlinkSync(path) {
      return callSync(io.fsUnlink, io.normalizePath(path));
    },
    rmSync(path, opts) {
      const p = io.normalizePath(path);
      try {
        return callSync(io.fsUnlink, p);
      } catch (err) {
        if (opts && typeof opts === 'object' && opts.force && isEnoentError(err)) return undefined;
        throw err;
      }
    },
    rmdirSync(path, opts) {
      return fsModule.rmSync(path, opts);
    },
    renameSync(oldPath, newPath) {
      return callSync(io.fsRename, io.normalizePath(oldPath), io.normalizePath(newPath));
    },
    copyFileSync(src, dest, _mode) {
      const raw = callSync(io.fsReadBytes, io.normalizePath(src));
      return callSync(io.fsWriteBytes, io.normalizePath(dest), toUint8Array(raw));
    },
    accessSync(path, _mode) {
      const p = io.normalizePath(path);
      const ok = Boolean(callSync(io.fsExists, p));
      if (!ok) {
        const err = new Error('ENOENT: no such file or directory, access ' + JSON.stringify(p));
        err.code = 'ENOENT';
        throw err;
      }
      return undefined;
    },
    existsSync(path) {
      return Boolean(callSync(io.fsExists, io.normalizePath(path)));
    },
    readdirSync(path) {
      return callSync(io.fsReaddir, io.normalizePath(path));
    },
    statSync(path) {
      return new Stats(callSync(io.fsStat, io.normalizePath(path)));
    },
    lstatSync(path) {
      return new Stats(callSync(io.fsStat, io.normalizePath(path)));
    },
    promises: fsPromises,
  };

  const envTarget = {};
  const envProxy = new Proxy(envTarget, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (Object.hasOwn(target, prop)) return target[prop];
      if (prop in Object.prototype) return Reflect.get(target, prop, receiver);
      const val = callSync(io.envGet, String(prop));
      return val === null || val === undefined ? undefined : String(val);
    },
    has(target, prop) {
      if (typeof prop === 'symbol') return Reflect.has(target, prop);
      if (Object.hasOwn(target, prop)) return true;
      if (prop in Object.prototype) return true;
      const val = callSync(io.envGet, String(prop));
      return val !== null && val !== undefined;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (Object.hasOwn(target, prop)) return Object.getOwnPropertyDescriptor(target, prop);
      if (prop in Object.prototype) return undefined;
      const val = callSync(io.envGet, String(prop));
      if (val === null || val === undefined) return undefined;
      return {value: String(val), writable: true, enumerable: true, configurable: true};
    },
    set(target, prop, val) {
      if (typeof prop === 'symbol') return false;
      target[prop] = String(val);
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      return true;
    },
  });

  const processModule = {
    env: envProxy,
    cwd() { return io.cwd; },
    platform: io.platform,
    version: io.version,
    versions: {node: String(io.version || 'v22.0.0').replace(/^v/, '')},
    argv: ['node', 'script.js'],
  };

  const childProcessModule = {
    execFileSync(cmd, args, opts) {
      let normArgs = [];
      let normOpts = opts;
      if (Array.isArray(args)) {
        normArgs = args.map(String);
      } else if (args && typeof args === 'object') {
        normOpts = args;
      }
      const payload = buildExecPayload(cmd, normArgs, normOpts);
      const res = callSync(io.shellExec, payload, false);
      return wrapExecResult(res, String(cmd), normOpts);
    },
    execSync(cmd, opts) {
      const payload = buildExecPayload(cmd, [], opts);
      const res = callSync(io.shellExec, payload, true);
      return wrapExecResult(res, String(cmd), opts);
    },
    spawnSync(cmd, args, opts) {
      let normArgs = [];
      let normOpts = opts;
      if (Array.isArray(args)) {
        normArgs = args.map(String);
      } else if (args && typeof args === 'object') {
        normOpts = args;
      }
      const payload = buildExecPayload(cmd, normArgs, normOpts);
      const isShell = Boolean(normOpts && typeof normOpts === 'object' && normOpts.shell);
      try {
        const res = callSync(io.shellExec, payload, isShell);
        const info = res && typeof res === 'object' ? res : {stdout: '', stderr: '', status: 0};
        const stdoutVal = encodeExecStream(String(info.stdout ?? ''), normOpts);
        const stderrVal = encodeExecStream(String(info.stderr ?? ''), normOpts);
        const status = typeof info.status === 'number' ? info.status : 0;
        return {
          pid: 1,
          output: [null, stdoutVal, stderrVal],
          stdout: stdoutVal,
          stderr: stderrVal,
          status,
          signal: null,
          error: undefined,
        };
      } catch (err) {
        return {
          pid: 0,
          output: [null, null, null],
          stdout: null,
          stderr: null,
          status: null,
          signal: null,
          error: toVmError(err),
        };
      }
    },
  };

  const cryptoModule = {
    ...io.pureCrypto,
    randomUUID() {
      return String(callSync(io.uuid));
    },
    randomBytes(size, cb) {
      const n = Number(size);
      if (!Number.isSafeInteger(n) || n < 0 || n > 1048576) {
        const err = new RangeError('Invalid randomBytes size');
        if (typeof cb === 'function') { queueMicrotask(() => cb(err)); return undefined; }
        throw err;
      }
      if (typeof cb === 'function') {
        let buf;
        try { buf = toNodeBuffer(callSync(io.randomBytes, n)); }
        catch (err) { queueMicrotask(() => cb(toVmError(err))); return undefined; }
        queueMicrotask(() => cb(null, buf));
        return undefined;
      }
      return toNodeBuffer(callSync(io.randomBytes, n));
    },
    randomFillSync(buffer, offset = 0, size) {
      if (!ArrayBuffer.isView(buffer)) {
        throw new TypeError('The "buffer" argument must be an instance of ArrayBufferView');
      }
      const bpe = buffer.BYTES_PER_ELEMENT || 1;
      const totalElems = buffer.byteLength / bpe;
      const startElem = offset === undefined ? 0 : Number(offset);
      if (!Number.isSafeInteger(startElem) || startElem < 0 || startElem > totalElems) {
        throw new RangeError('Invalid offset for randomFillSync');
      }
      const elemCount = size === undefined ? (totalElems - startElem) : Number(size);
      if (!Number.isSafeInteger(elemCount) || elemCount < 0 || startElem + elemCount > totalElems) {
        throw new RangeError('Invalid size for randomFillSync');
      }
      const byteLen = elemCount * bpe;
      if (byteLen > 0) {
        const rand = cryptoModule.randomBytes(byteLen);
        new Uint8Array(buffer.buffer, buffer.byteOffset + startElem * bpe, byteLen).set(rand);
      }
      return buffer;
    },
    randomFill(buffer, offset, size, cb) {
      if (typeof offset === 'function') { cb = offset; offset = 0; size = undefined; }
      else if (typeof size === 'function') { cb = size; size = undefined; }
      try {
        const filled = cryptoModule.randomFillSync(buffer, offset, size);
        queueMicrotask(() => cb(null, filled));
      } catch (err) {
        queueMicrotask(() => cb(toVmError(err)));
      }
    },
  };

  // ==================== EventEmitter (events / node:events) ====================
  class EventEmitter {
    constructor() {
      this._events = new Map();
      this._maxListeners = 10;
    }
    setMaxListeners(n) {
      this._maxListeners = Number(n);
      return this;
    }
    getMaxListeners() {
      return this._maxListeners;
    }
    _getList(event) {
      if (!this._events) this._events = new Map();
      let list = this._events.get(event);
      if (!list) {
        list = [];
        this._events.set(event, list);
      }
      return list;
    }
    on(event, listener) {
      if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type Function');
      this._getList(event).push(listener);
      return this;
    }
    addListener(event, listener) {
      return this.on(event, listener);
    }
    prependListener(event, listener) {
      if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type Function');
      this._getList(event).unshift(listener);
      return this;
    }
    once(event, listener) {
      if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type Function');
      const wrapped = (...args) => {
        this.removeListener(event, wrapped);
        return listener.apply(this, args);
      };
      wrapped.listener = listener;
      return this.on(event, wrapped);
    }
    prependOnceListener(event, listener) {
      if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type Function');
      const wrapped = (...args) => {
        this.removeListener(event, wrapped);
        return listener.apply(this, args);
      };
      wrapped.listener = listener;
      return this.prependListener(event, wrapped);
    }
    removeListener(event, listener) {
      if (!this._events) return this;
      const list = this._events.get(event);
      if (!list) return this;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          list.splice(i, 1);
          break;
        }
      }
      if (list.length === 0) this._events.delete(event);
      return this;
    }
    off(event, listener) {
      return this.removeListener(event, listener);
    }
    removeAllListeners(event) {
      if (!this._events) return this;
      if (arguments.length === 0 || event === undefined) {
        this._events.clear();
      } else {
        this._events.delete(event);
      }
      return this;
    }
    emit(event, ...args) {
      const list = this._events ? this._events.get(event) : null;
      if (!list || list.length === 0) {
        if (event === 'error') {
          const err = args[0];
          throw err instanceof Error ? err : new Error('Unhandled error event: ' + String(err));
        }
        return false;
      }
      const snapshot = list.slice();
      for (const fn of snapshot) {
        fn.apply(this, args);
      }
      return true;
    }
    listeners(event) {
      const list = this._events ? this._events.get(event) : null;
      return list ? list.map(fn => fn.listener || fn) : [];
    }
    rawListeners(event) {
      const list = this._events ? this._events.get(event) : null;
      return list ? list.slice() : [];
    }
    listenerCount(event) {
      const list = this._events ? this._events.get(event) : null;
      return list ? list.length : 0;
    }
    eventNames() {
      return this._events ? Array.from(this._events.keys()) : [];
    }
  }
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.default = EventEmitter;
  EventEmitter.once = function oncePromise(emitter, event) {
    return new Promise((resolve, reject) => {
      const onEvent = (...args) => {
        if (event !== 'error') emitter.removeListener('error', onError);
        resolve(args);
      };
      const onError = err => {
        emitter.removeListener(event, onEvent);
        reject(err);
      };
      emitter.once(event, onEvent);
      if (event !== 'error') emitter.once('error', onError);
    });
  };

  // ==================== Lightweight In-Memory Streams (stream / node:stream) ====================
  class Stream extends EventEmitter {
    pipe(dest, opts) {
      const shouldEnd = !(opts && opts.end === false);
      const onData = chunk => { dest.write(chunk); };
      const onEnd = () => { if (shouldEnd && typeof dest.end === 'function') dest.end(); };
      dest.emit('pipe', this);
      this.once('end', onEnd);
      this.on('data', onData);
      if (this.readableEnded && shouldEnd && typeof dest.end === 'function' && !dest.writableEnded) {
        dest.end();
      }
      return dest;
    }
  }

  class Readable extends Stream {
    constructor(opts = {}) {
      super();
      this._objectMode = Boolean(opts.objectMode);
      this._encoding = opts.encoding || null;
      this._buffer = [];
      this._ended = false;
      this._endEmitted = false;
      this._flowing = false;
      this._reading = false;
      this.destroyed = false;
      this.readableEnded = false;
      if (typeof opts.read === 'function') this._read = opts.read;
    }
    _read(_size) {}
    setEncoding(enc) {
      this._encoding = String(enc);
      return this;
    }
    _formatChunk(chunk) {
      if (this._objectMode || chunk === null || chunk === undefined) return chunk;
      if (this._encoding) {
        return typeof chunk === 'string' ? chunk : toNodeBuffer(chunk).toString(this._encoding);
      }
      return typeof chunk === 'string' ? HostBuffer.from(chunk, 'utf8') : chunk;
    }
    push(chunk, encoding) {
      if (this.destroyed) return false;
      if (chunk === null) {
        this._ended = true;
        this._drainIfFlowing();
        return false;
      }
      let item = chunk;
      if (!this._objectMode && typeof chunk === 'string' && !this._encoding) {
        item = HostBuffer.from(chunk, encoding || 'utf8');
      } else {
        item = this._formatChunk(chunk);
      }
      this._buffer.push(item);
      this._drainIfFlowing();
      return true;
    }
    _drainIfFlowing() {
      if (!this._flowing || this.destroyed) return;
      while (this._buffer.length > 0 && this._flowing && !this.destroyed) {
        const next = this._buffer.shift();
        this.emit('data', next);
      }
      if (this._ended && this._buffer.length === 0 && !this._endEmitted && !this.destroyed) {
        this._endEmitted = true;
        this.readableEnded = true;
        this.emit('end');
      }
    }
    _triggerRead(size = 16384) {
      if (this._ended || this._reading || this.destroyed) return;
      this._reading = true;
      try {
        this._read(size);
      } finally {
        this._reading = false;
      }
    }
    read(size) {
      if (this._buffer.length === 0 && !this._ended) {
        this._triggerRead(size);
      }
      if (this._buffer.length === 0) {
        if (this._ended && !this._endEmitted) {
          this._endEmitted = true;
          this.readableEnded = true;
          this.emit('end');
        }
        return null;
      }
      const chunk = this._buffer.shift();
      if (this._ended && this._buffer.length === 0 && !this._endEmitted) {
        this._endEmitted = true;
        this.readableEnded = true;
        this.emit('end');
      }
      return chunk;
    }
    on(event, listener) {
      super.on(event, listener);
      if (event === 'data') {
        this.resume();
      }
      return this;
    }
    resume() {
      this._flowing = true;
      if (this._buffer.length === 0 && !this._ended) this._triggerRead();
      this._drainIfFlowing();
      return this;
    }
    pause() {
      this._flowing = false;
      return this;
    }
    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      this._buffer.length = 0;
      if (err) this.emit('error', err);
      this.emit('close');
      return this;
    }
    async *[Symbol.asyncIterator]() {
      const chunks = [];
      let done = Boolean(this.readableEnded);
      let err = null;
      let wake = null;
      const notify = () => { if (wake) { const fn = wake; wake = null; fn(); } };
      this.once('end', () => { done = true; notify(); });
      this.once('error', e => { err = e; done = true; notify(); });
      this.on('data', c => { chunks.push(c); notify(); });
      if (this.readableEnded) done = true;
      while (true) {
        while (chunks.length > 0) yield chunks.shift();
        if (err) throw err;
        if (done) return;
        await new Promise(resolve => { wake = resolve; });
      }
    }
    static from(iterable, opts = {}) {
      const objectMode = opts.objectMode !== undefined ? Boolean(opts.objectMode) : true;
      const readable = new Readable({...opts, objectMode});
      if (iterable && typeof iterable[Symbol.iterator] === 'function') {
        for (const item of iterable) readable.push(item);
        readable.push(null);
      } else if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
        (async () => {
          try {
            for await (const item of iterable) readable.push(item);
            readable.push(null);
          } catch (err) {
            readable.destroy(err);
          }
        })();
      } else {
        throw new TypeError('Readable.from expects an iterable');
      }
      return readable;
    }
  }

  class Writable extends Stream {
    constructor(opts = {}) {
      super();
      this._objectMode = Boolean(opts.objectMode);
      this._decodeStrings = opts.decodeStrings !== false;
      this.writableEnded = false;
      this.writableFinished = false;
      this.destroyed = false;
      if (typeof opts.write === 'function') this._write = opts.write;
      if (typeof opts.final === 'function') this._final = opts.final;
    }
    _write(_chunk, _enc, cb) { cb(); }
    write(chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = 'utf8'; }
      const enc = typeof encoding === 'string' ? encoding : 'utf8';
      const payload = (!this._objectMode && this._decodeStrings && typeof chunk === 'string')
        ? HostBuffer.from(chunk, enc)
        : chunk;
      let errOut = null;
      this._write(payload, enc, err => {
        if (err) {
          errOut = err;
          if (typeof cb === 'function') cb(err);
          else this.emit('error', err);
        } else if (typeof cb === 'function') {
          cb();
        }
      });
      return !errOut;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (chunk !== undefined && chunk !== null) {
        this.write(chunk, encoding);
      }
      if (this.writableEnded) {
        if (typeof cb === 'function') cb();
        return this;
      }
      this.writableEnded = true;
      const done = err => {
        if (err) {
          if (typeof cb === 'function') cb(err);
          else this.emit('error', err);
          return;
        }
        this.writableFinished = true;
        this.emit('finish');
        if (typeof cb === 'function') cb();
      };
      if (typeof this._final === 'function') {
        this._final(done);
      } else {
        done();
      }
      return this;
    }
    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      if (err) this.emit('error', err);
      this.emit('close');
      return this;
    }
  }

  class Duplex extends Readable {
    constructor(opts = {}) {
      super(opts);
      this._writableObjectMode = Boolean(opts.writableObjectMode ?? opts.objectMode);
      this._decodeStrings = opts.decodeStrings !== false;
      this.writableEnded = false;
      this.writableFinished = false;
      if (typeof opts.write === 'function') this._write = opts.write;
      if (typeof opts.final === 'function') this._final = opts.final;
    }
    _write(_chunk, _enc, cb) { cb(); }
    write(chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = 'utf8'; }
      const enc = typeof encoding === 'string' ? encoding : 'utf8';
      const payload = (!this._writableObjectMode && this._decodeStrings && typeof chunk === 'string')
        ? HostBuffer.from(chunk, enc)
        : chunk;
      let errOut = null;
      this._write(payload, enc, err => {
        if (err) {
          errOut = err;
          if (typeof cb === 'function') cb(err);
          else this.emit('error', err);
        } else if (typeof cb === 'function') {
          cb();
        }
      });
      return !errOut;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      if (this.writableEnded) {
        if (typeof cb === 'function') cb();
        return this;
      }
      this.writableEnded = true;
      const done = err => {
        if (err) {
          if (typeof cb === 'function') cb(err);
          else this.emit('error', err);
          return;
        }
        this.writableFinished = true;
        this.emit('finish');
        if (typeof cb === 'function') cb();
      };
      if (typeof this._final === 'function') this._final(done);
      else done();
      return this;
    }
  }

  class Transform extends Duplex {
    constructor(opts = {}) {
      super(opts);
      if (typeof opts.transform === 'function') this._transform = opts.transform;
      if (typeof opts.flush === 'function') this._flush = opts.flush;
    }
    _transform(chunk, _enc, cb) {
      cb(null, chunk);
    }
    _write(chunk, enc, cb) {
      this._transform(chunk, enc, (err, data) => {
        if (err) { cb(err); return; }
        if (data !== undefined && data !== null) this.push(data);
        cb();
      });
    }
    _final(cb) {
      if (typeof this._flush === 'function') {
        this._flush((err, data) => {
          if (err) { cb(err); return; }
          if (data !== undefined && data !== null) this.push(data);
          this.push(null);
          cb();
        });
      } else {
        this.push(null);
        cb();
      }
    }
  }

  class PassThrough extends Transform {
    _transform(chunk, _enc, cb) {
      cb(null, chunk);
    }
  }

  function pipeline(...args) {
    let cb = null;
    if (args.length > 0 && typeof args[args.length - 1] === 'function') {
      cb = args.pop();
    }
    const streams = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    if (streams.length < 2) {
      const err = new TypeError('pipeline requires at least 2 streams');
      if (cb) { cb(err); return undefined; }
      throw err;
    }
    let settled = false;
    const finish = err => {
      if (settled) return;
      settled = true;
      if (cb) cb(err || null);
      else if (err) throw err;
    };
    const last = streams[streams.length - 1];
    for (const s of streams) {
      if (s && typeof s.once === 'function') s.once('error', finish);
    }
    if (last && typeof last.once === 'function') {
      last.once('finish', () => finish(null));
      last.once('end', () => finish(null));
    }
    for (let i = 0; i < streams.length - 1; i++) {
      streams[i].pipe(streams[i + 1]);
    }
    if (!settled && (last.writableFinished || last.readableEnded)) {
      finish(null);
    }
    return last;
  }

  function pipelineAsync(...args) {
    return new Promise((resolve, reject) => {
      pipeline(...args, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function finished(stream, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    let done = false;
    const onceDone = err => {
      if (done) return;
      done = true;
      if (typeof cb === 'function') cb(err || null);
    };
    if (stream.writableFinished || stream.readableEnded) {
      queueMicrotask(() => onceDone(null));
      return () => {};
    }
    stream.once('finish', () => onceDone(null));
    stream.once('end', () => onceDone(null));
    stream.once('error', err => onceDone(err));
    return () => { done = true; };
  }

  function finishedAsync(stream, opts) {
    return new Promise((resolve, reject) => {
      finished(stream, opts || {}, err => (err ? reject(err) : resolve()));
    });
  }

  const streamPromisesModule = {pipeline: pipelineAsync, finished: finishedAsync};
  const streamModule = {
    Stream,
    Readable,
    Writable,
    Duplex,
    Transform,
    PassThrough,
    pipeline,
    finished,
    promises: streamPromisesModule,
    default: Stream,
  };

  // ==================== Global AbortController & AbortSignal ====================
  function makeAbortError(message, name) {
    const err = new Error(message || 'This operation was aborted');
    err.name = name || 'AbortError';
    return err;
  }

  class AbortSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      this._listeners = new Map();
    }
    addEventListener(type, listener, opts) {
      if (typeof listener !== 'function' && (!listener || typeof listener.handleEvent !== 'function')) return;
      const t = String(type);
      const once = Boolean(opts && typeof opts === 'object' && opts.once);
      let list = this._listeners.get(t);
      if (!list) {
        list = [];
        this._listeners.set(t, list);
      }
      if (!list.some(e => e.listener === listener)) {
        list.push({listener, once});
      }
    }
    removeEventListener(type, listener) {
      const list = this._listeners.get(String(type));
      if (!list) return;
      const idx = list.findIndex(e => e.listener === listener);
      if (idx >= 0) list.splice(idx, 1);
    }
    dispatchEvent(event) {
      const ev = event && typeof event === 'object' ? event : {type: String(event)};
      ev.target = this;
      ev.currentTarget = this;
      if (ev.type === 'abort' && typeof this.onabort === 'function') {
        this.onabort.call(this, ev);
      }
      const list = this._listeners.get(ev.type);
      if (list && list.length) {
        const snapshot = list.slice();
        for (const entry of snapshot) {
          if (entry.once) this.removeEventListener(ev.type, entry.listener);
          if (typeof entry.listener === 'function') entry.listener.call(this, ev);
          else if (typeof entry.listener.handleEvent === 'function') entry.listener.handleEvent(ev);
        }
      }
      return true;
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason;
    }
    _triggerAbort(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason !== undefined ? reason : makeAbortError('This operation was aborted', 'AbortError');
      this.dispatchEvent({type: 'abort', bubbles: false, cancelable: false});
    }
    static abort(reason) {
      const sig = new AbortSignal();
      sig.aborted = true;
      sig.reason = reason !== undefined ? reason : makeAbortError('This operation was aborted', 'AbortError');
      return sig;
    }
    static timeout(milliseconds) {
      const ms = Number(milliseconds);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError('AbortSignal.timeout requires a non-negative finite number');
      }
      const sig = new AbortSignal();
      const fire = () => sig._triggerAbort(makeAbortError('The operation was aborted due to timeout', 'TimeoutError'));
      if (typeof globalThis.setTimeout === 'function') {
        globalThis.setTimeout(fire, ms);
      } else if (ms === 0) {
        queueMicrotask(fire);
      }
      return sig;
    }
    static any(signals) {
      const list = Array.from(signals || []);
      const composite = new AbortSignal();
      for (const s of list) {
        if (s && s.aborted) {
          composite.aborted = true;
          composite.reason = s.reason;
          return composite;
        }
      }
      for (const s of list) {
        if (s && typeof s.addEventListener === 'function') {
          s.addEventListener('abort', () => composite._triggerAbort(s.reason), {once: true});
        }
      }
      return composite;
    }
  }

  class AbortController {
    constructor() {
      this.signal = new AbortSignal();
    }
    abort(reason) {
      this.signal._triggerAbort(reason);
    }
  }

  const bufferModule = {Buffer: HostBuffer};
  const pathModule = io.purePath;
  const urlModule = io.pureUrl;

  const MODULES = Object.create(null);
  MODULES['fs'] = fsModule;
  MODULES['node:fs'] = fsModule;
  MODULES['fs/promises'] = fsPromises;
  MODULES['node:fs/promises'] = fsPromises;
  MODULES['path'] = pathModule;
  MODULES['node:path'] = pathModule;
  MODULES['url'] = urlModule;
  MODULES['node:url'] = urlModule;
  MODULES['crypto'] = cryptoModule;
  MODULES['node:crypto'] = cryptoModule;
  MODULES['child_process'] = childProcessModule;
  MODULES['node:child_process'] = childProcessModule;
  MODULES['buffer'] = bufferModule;
  MODULES['node:buffer'] = bufferModule;
  MODULES['process'] = processModule;
  MODULES['node:process'] = processModule;
  MODULES['events'] = EventEmitter;
  MODULES['node:events'] = EventEmitter;
  MODULES['stream'] = streamModule;
  MODULES['node:stream'] = streamModule;
  MODULES['stream/promises'] = streamPromisesModule;
  MODULES['node:stream/promises'] = streamPromisesModule;

  function vmRequire(id) {
    const key = String(id);
    if (Object.hasOwn(MODULES, key)) return MODULES[key];
    throw new Error('Cannot find module ' + JSON.stringify(key));
  }

  globalThis.Buffer = HostBuffer;
  globalThis.process = processModule;
  globalThis.require = vmRequire;
  globalThis.AbortController = AbortController;
  globalThis.AbortSignal = AbortSignal;
  globalThis.crypto = {
    randomUUID: cryptoModule.randomUUID,
    getRandomValues(typedArray) {
      if (!ArrayBuffer.isView(typedArray)) throw new TypeError('Expected TypedArray');
      const buf = cryptoModule.randomBytes(typedArray.byteLength);
      new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).set(buf);
      return typedArray;
    },
  };
})();`;

/** Create VM host binding object backed by deterministic fixture broker (for offline replay). */
export function createReplayNodeIoBridge(broker) {
  const invokeSync = (op, args) => broker.invokeSync(op, args);
  const invokeAsync = (op, args) => broker.invokeAsync(op, args);
  return {
    Buffer,
    cwd: WORKSPACE_CWD,
    platform: process.platform,
    version: process.version,
    purePath: makeDeterministicPathModule(WORKSPACE_CWD),
    pureUrl: makePureUrlModule(),
    pureCrypto: makePureCryptoBindings(),
    normalizePath: normalizePathArg,
    fsReadText: p => invokeSync('fs.readText', [p]),
    fsReadTextAsync: p => invokeAsync('fs.readText', [p]),
    fsReadBytes: p => invokeSync('fs.readBytes', [p]),
    fsReadBytesAsync: p => invokeAsync('fs.readBytes', [p]),
    fsWriteText: (p, text) => invokeSync('fs.writeText', [p, text]),
    fsWriteTextAsync: (p, text) => invokeAsync('fs.writeText', [p, text]),
    fsWriteBytes: (p, bytes) => invokeSync('fs.writeBytes', [p, bytes]),
    fsWriteBytesAsync: (p, bytes) => invokeAsync('fs.writeBytes', [p, bytes]),
    fsMkdir: p => invokeSync('fs.mkdir', [p]),
    fsMkdirAsync: p => invokeAsync('fs.mkdir', [p]),
    fsUnlink: p => invokeSync('fs.unlink', [p]),
    fsUnlinkAsync: p => invokeAsync('fs.unlink', [p]),
    fsRename: (oldP, newP) => invokeSync('fs.rename', [oldP, newP]),
    fsRenameAsync: (oldP, newP) => invokeAsync('fs.rename', [oldP, newP]),
    fsExists: p => invokeSync('fs.exists', [p]),
    fsExistsAsync: p => invokeAsync('fs.exists', [p]),
    fsReaddir: p => invokeSync('fs.readdir', [p]),
    fsReaddirAsync: p => invokeAsync('fs.readdir', [p]),
    fsStat: p => invokeSync('fs.stat', [p]),
    fsStatAsync: p => invokeAsync('fs.stat', [p]),
    envGet: name => invokeSync('env.get', [name]),
    shellExec: (req, _isShell) => invokeSync('shell.exec', [req]),
    uuid: () => invokeSync('platform.uuid', []),
    randomBytes: size => invokeSync('platform.randomBytes', [size]),
  };
}

/** Create VM host binding object that executes live Node I/O inside an isolated workDir and records fixture.calls. */
export function createLiveNodeIoRecorder(
  recordedCalls,
  {
    workDir,
    readRoots = [],
    env = null,
    timeoutMs = 4000,
    maxCalls = 64,
    encodeReadable = x => x,
  } = {},
) {
  const absWorkDir = nodePath.resolve(workDir);
  const workPrefix = absWorkDir.endsWith(nodePath.sep) ? absWorkDir : absWorkDir + nodePath.sep;
  const resolvedReadRoots = readRoots.map(r => nodePath.resolve(r));

  function resolveLivePath(rawPath, {allowReadFallback = false} = {}) {
    const p = normalizePathArg(rawPath);
    let candidate;
    let relInsideWorkspace = null;
    if (p === WORKSPACE_CWD) {
      candidate = absWorkDir;
      relInsideWorkspace = '.';
    } else if (p.startsWith(WORKSPACE_CWD + '/')) {
      relInsideWorkspace = p.slice(WORKSPACE_CWD.length + 1);
      candidate = nodePath.resolve(absWorkDir, relInsideWorkspace);
    } else if (!nodePath.isAbsolute(p)) {
      relInsideWorkspace = p;
      candidate = nodePath.resolve(absWorkDir, p);
    } else {
      candidate = nodePath.resolve(p);
    }

    const inWorkDir = candidate === absWorkDir || candidate.startsWith(workPrefix);
    if (inWorkDir) {
      if (!allowReadFallback || nodeFs.existsSync(candidate) || relInsideWorkspace === null) {
        return {pathStr: p, hostPath: candidate};
      }
      for (const root of resolvedReadRoots) {
        const alt = nodePath.resolve(root, relInsideWorkspace);
        const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
        if ((alt === root || alt.startsWith(prefix)) && nodeFs.existsSync(alt)) {
          return {pathStr: p, hostPath: alt};
        }
      }
      return {pathStr: p, hostPath: candidate};
    }
    if (allowReadFallback) {
      for (const root of resolvedReadRoots) {
        const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
        if (candidate === root || candidate.startsWith(prefix)) {
          return {pathStr: p, hostPath: candidate};
        }
      }
    }
    throw Object.assign(new Error(`ENOENT: no such file or directory: ${p}`), {name: 'Error', code: 'ENOENT'});
  }

  function recordAndRun(operation, callArgs, fn) {
    if (recordedCalls.length >= maxCalls) {
      throw new RangeError('Too many external calls');
    }
    try {
      const result = fn();
      recordedCalls.push({
        operation,
        arguments: encodeReadable(callArgs),
        status: 'fulfilled',
        result: encodeReadable(result),
      });
      return result;
    } catch (err) {
      const errPayload = {
        name: String(err?.name || 'Error'),
        message: String(err?.message ?? err),
      };
      recordedCalls.push({
        operation,
        arguments: encodeReadable(callArgs),
        status: 'rejected',
        result: errPayload,
      });
      throw errPayload;
    }
  }

  async function recordAndRunAsync(operation, callArgs, fn) {
    if (recordedCalls.length >= maxCalls) {
      throw new RangeError('Too many external calls');
    }
    try {
      const result = await fn();
      recordedCalls.push({
        operation,
        arguments: encodeReadable(callArgs),
        status: 'fulfilled',
        result: encodeReadable(result),
      });
      return result;
    } catch (err) {
      const errPayload = {
        name: String(err?.name || 'Error'),
        message: String(err?.message ?? err),
      };
      recordedCalls.push({
        operation,
        arguments: encodeReadable(callArgs),
        status: 'rejected',
        result: errPayload,
      });
      throw errPayload;
    }
  }

  const readTextSync = p => recordAndRun('fs.readText', [p], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
    return nodeFs.readFileSync(hostPath, 'utf8');
  });
  const readBytesSync = p => recordAndRun('fs.readBytes', [p], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
    const buf = nodeFs.readFileSync(hostPath);
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  });
  const writeTextSync = (p, text) => recordAndRun('fs.writeText', [p, text], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
    nodeFs.writeFileSync(hostPath, text, 'utf8');
    return undefined;
  });
  const writeBytesSync = (p, bytes) => recordAndRun('fs.writeBytes', [p, bytes], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
    nodeFs.writeFileSync(hostPath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return undefined;
  });
  const mkdirSync = p => recordAndRun('fs.mkdir', [p], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
    nodeFs.mkdirSync(hostPath, {recursive: true});
    return undefined;
  });
  const unlinkSync = p => recordAndRun('fs.unlink', [p], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
    nodeFs.rmSync(hostPath, {recursive: true, force: false});
    return undefined;
  });
  const renameSync = (oldP, newP) => recordAndRun('fs.rename', [oldP, newP], () => {
    const {hostPath: srcHost} = resolveLivePath(oldP, {allowReadFallback: false});
    const {hostPath: dstHost} = resolveLivePath(newP, {allowReadFallback: false});
    nodeFs.renameSync(srcHost, dstHost);
    return undefined;
  });
  const existsSync = p => recordAndRun('fs.exists', [p], () => {
    try {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
      return nodeFs.existsSync(hostPath);
    } catch {
      return false;
    }
  });
  const readdirSync = p => recordAndRun('fs.readdir', [p], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
    return nodeFs.readdirSync(hostPath).sort();
  });
  const statSync = p => recordAndRun('fs.stat', [p], () => {
    const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
    const st = nodeFs.statSync(hostPath);
    return {isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size};
  });

  const envSource = env ?? process.env;
  const envGet = name => recordAndRun('env.get', [name], () => (
    Object.hasOwn(envSource, name) ? envSource[name] : undefined
  ));

  const shellExec = (req, isShell) => recordAndRun('shell.exec', [req], () => {
    const cmd = String(req?.command ?? '');
    const args = Array.isArray(req?.args) ? req.args.map(String) : [];
    const execCwd = req?.cwd !== undefined ? resolveLivePath(req.cwd, {allowReadFallback: true}).hostPath : absWorkDir;
    const execEnv = req?.env && typeof req.env === 'object' ? {...envSource, ...req.env} : envSource;
    const execOpts = {
      cwd: execCwd,
      encoding: 'utf8',
      timeout: Math.min(timeoutMs, 3000),
      stdio: [req?.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: execEnv,
      ...(req?.input !== undefined ? {input: String(req.input)} : {}),
    };
    const stdout = isShell
      ? nodeChildProcess.execSync(cmd, execOpts)
      : nodeChildProcess.execFileSync(cmd, args, execOpts);
    return {stdout: String(stdout ?? ''), stderr: '', status: 0};
  });

  const uuid = () => recordAndRun('platform.uuid', [], () => nodeCrypto.randomUUID());
  const randomBytes = size => recordAndRun('platform.randomBytes', [size], () => {
    const buf = nodeCrypto.randomBytes(size);
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  });

  return {
    Buffer,
    cwd: WORKSPACE_CWD,
    platform: process.platform,
    version: process.version,
    purePath: makeDeterministicPathModule(WORKSPACE_CWD),
    pureUrl: makePureUrlModule(),
    pureCrypto: makePureCryptoBindings(),
    normalizePath: normalizePathArg,
    fsReadText: readTextSync,
    fsReadTextAsync: p => recordAndRunAsync('fs.readText', [p], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
      return await nodeFs.promises.readFile(hostPath, 'utf8');
    }),
    fsReadBytes: readBytesSync,
    fsReadBytesAsync: p => recordAndRunAsync('fs.readBytes', [p], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
      const buf = await nodeFs.promises.readFile(hostPath);
      return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }),
    fsWriteText: writeTextSync,
    fsWriteTextAsync: (p, text) => recordAndRunAsync('fs.writeText', [p, text], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
      await nodeFs.promises.writeFile(hostPath, text, 'utf8');
      return undefined;
    }),
    fsWriteBytes: writeBytesSync,
    fsWriteBytesAsync: (p, bytes) => recordAndRunAsync('fs.writeBytes', [p, bytes], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
      await nodeFs.promises.writeFile(hostPath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return undefined;
    }),
    fsMkdir: mkdirSync,
    fsMkdirAsync: p => recordAndRunAsync('fs.mkdir', [p], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
      await nodeFs.promises.mkdir(hostPath, {recursive: true});
      return undefined;
    }),
    fsUnlink: unlinkSync,
    fsUnlinkAsync: p => recordAndRunAsync('fs.unlink', [p], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: false});
      await nodeFs.promises.rm(hostPath, {recursive: true, force: false});
      return undefined;
    }),
    fsRename: renameSync,
    fsRenameAsync: (oldP, newP) => recordAndRunAsync('fs.rename', [oldP, newP], async () => {
      const {hostPath: srcHost} = resolveLivePath(oldP, {allowReadFallback: false});
      const {hostPath: dstHost} = resolveLivePath(newP, {allowReadFallback: false});
      await nodeFs.promises.rename(srcHost, dstHost);
      return undefined;
    }),
    fsExists: existsSync,
    fsExistsAsync: p => recordAndRunAsync('fs.exists', [p], async () => {
      try {
        const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
        return nodeFs.existsSync(hostPath);
      } catch {
        return false;
      }
    }),
    fsReaddir: readdirSync,
    fsReaddirAsync: p => recordAndRunAsync('fs.readdir', [p], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
      const list = await nodeFs.promises.readdir(hostPath);
      return [...list].sort();
    }),
    fsStat: statSync,
    fsStatAsync: p => recordAndRunAsync('fs.stat', [p], async () => {
      const {hostPath} = resolveLivePath(p, {allowReadFallback: true});
      const st = await nodeFs.promises.stat(hostPath);
      return {isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size};
    }),
    envGet,
    shellExec,
    uuid,
    randomBytes,
  };
}

/** Canonical fixture plan and replay broker supporting rich JS types and Node I/O operations. */
export function canonicalNativeFixturePlan({calls = [], settlementOrder = null} = {}) {
  if (!Array.isArray(calls)) throw new TypeError('Fixture calls must be an array');
  return {
    calls: calls.map(call => ({
      operation: call.operation,
      status: call.status ?? 'fulfilled',
      argumentGraph: call.argumentGraph ?? describeGraph(call.arguments ?? []),
      ...(call.resultFromCallback !== undefined
        ? {resultFromCallback: call.resultFromCallback}
        : {resultGraph: call.resultGraph ?? describeGraph([call.result])}),
    })),
    settlementOrder,
  };
}

export function createNativeFixtureBroker({calls = [], settlementOrder = null} = {}) {
  if (!Array.isArray(calls) || calls.length > 1024) throw new TypeError('Invalid bounded effect fixture');
  const expected = calls.map(call => {
    resolveOperationSpec(call.operation, {nativeMode: true});
    return {
      ...call,
      argumentGraph: call.argumentGraph ?? describeGraph(call.arguments ?? []),
      resultGraph: call.resultGraph ?? describeGraph([call.result]),
    };
  });
  if (settlementOrder !== null) {
    if (!Array.isArray(settlementOrder) ||
        settlementOrder.some((idx, pos) => !Number.isSafeInteger(idx) || idx < 0 || idx >= expected.length || (pos > 0 && idx <= settlementOrder[pos - 1]))) {
      throw new TypeError('Out-of-order concurrent observations require a separate execution profile');
    }
  }
  const receipts = [];
  const pending = new Set();
  let called = 0;
  let aborted = null;

  function checkCall(operation, args) {
    if (aborted) throw aborted;
    const index = called++;
    const call = expected[index];
    const observed = describeGraph(args);
    if (!call || call.operation !== operation || !isDeepStrictEqual(observed, call.argumentGraph)) {
      throw new Error('Fixture request mismatch at ' + index + ': ' + operation);
    }
    receipts.push({kind: 'dispatch', call: index, operation, arguments: observed});
    return {index, call};
  }

  function resolveValue(call) {
    const status = call.status ?? 'fulfilled';
    if (!['fulfilled', 'rejected'].includes(status)) throw new TypeError('Invalid fixture outcome');
    const value = realizeGraph(call.resultGraph)[0];
    return {status, value};
  }

  function invokeSync(operation, args) {
    const {index, call} = checkCall(operation, args);
    const {status, value} = resolveValue(call);
    receipts.push({kind: 'settlement', call: index, status, result: describeGraph([value])});
    if (status === 'rejected') throw value;
    return value;
  }

  function invokeAsync(operation, args) {
    const {index, call} = checkCall(operation, args);
    pending.add(index);
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        pending.delete(index);
        if (aborted) {
          reject(aborted);
          return;
        }
        try {
          const {status, value} = resolveValue(call);
          receipts.push({kind: 'settlement', call: index, status, result: describeGraph([value])});
          if (status === 'rejected') reject(value);
          else resolve(value);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  function invoke(operation, args) {
    const spec = resolveOperationSpec(operation, {nativeMode: true});
    return spec.kind === 'promise' ? invokeAsync(operation, args) : invokeSync(operation, args);
  }

  return {
    invokeSync,
    invokeAsync,
    invoke,
    receipts,
    finish() {
      if (called !== expected.length || pending.size > 0) {
        throw new Error('Fixture has missing calls or unresolved outcomes');
      }
      return structuredClone(receipts);
    },
    abort(error = new Error('Fixture cancelled')) {
      aborted = error;
      pending.clear();
    },
  };
}

/** Detect Node I/O tool operations strictly from public JS AST (NEVER from fixture). */
export function scanPublicSourceNodeIoTools(source) {
  let ast;
  try {
    ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
  } catch {
    try {
      ast = parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
    } catch {
      return new Set();
    }
  }

  const tools = new Set();
  const moduleAliases = new Map(); // varName -> 'fs' | 'fs/promises' | 'child_process' | 'crypto' | 'process'
  const directFnAliases = new Map(); // varName -> {mod, member}

  function normalizeModuleId(raw) {
    if (typeof raw !== 'string') return null;
    if (raw === 'fs' || raw === 'node:fs') return 'fs';
    if (raw === 'fs/promises' || raw === 'node:fs/promises') return 'fs/promises';
    if (raw === 'child_process' || raw === 'node:child_process') return 'child_process';
    if (raw === 'crypto' || raw === 'node:crypto') return 'crypto';
    if (raw === 'process' || raw === 'node:process') return 'process';
    return null;
  }

  function unwrapRequireCall(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' &&
        (node.callee.name === 'require' || node.callee.name === '__require') &&
        node.arguments.length === 1 && node.arguments[0]?.type === 'Literal') {
      return normalizeModuleId(node.arguments[0].value);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' &&
        (node.callee.name === '__toESM' || node.callee.name === '__importDefault' || node.callee.name === '__importStar') &&
        node.arguments.length >= 1) {
      return unwrapRequireCall(node.arguments[0]);
    }
    return null;
  }

  function extractLiteralString(node) {
    return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
  }

  function isExplicitBinaryArg(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' &&
        /^(Uint8Array|Int8Array|Uint16Array|Int16Array|Uint32Array|Int32Array|ArrayBuffer|DataView)$/.test(node.callee.name)) {
      return true;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && !node.callee.computed &&
        node.callee.object?.type === 'Identifier' &&
        (node.callee.object.name === 'Buffer' || node.callee.object.name === 'Uint8Array') &&
        node.callee.property?.type === 'Identifier' &&
        ['from', 'alloc', 'allocUnsafe', 'concat', 'of'].includes(node.callee.property.name)) {
      return true;
    }
    return false;
  }

  function hasExplicitStringEncodingArg(argNode) {
    if (!argNode) return false;
    if (argNode.type === 'Literal' && typeof argNode.value === 'string') return true;
    if (argNode.type === 'ObjectExpression') {
      const encProp = argNode.properties.find(p => p.type === 'Property' && !p.computed && p.key?.type === 'Identifier' && p.key.name === 'encoding');
      if (encProp && encProp.value?.type === 'Literal' && typeof encProp.value.value === 'string') return true;
    }
    return false;
  }

  function classifyWriteFileCall(callNode) {
    if (callNode && Array.isArray(callNode.arguments) && callNode.arguments.length >= 2) {
      const dataArg = callNode.arguments[1];
      const optsArg = callNode.arguments[2];
      if (!hasExplicitStringEncodingArg(optsArg) && isExplicitBinaryArg(dataArg)) {
        tools.add('fs.writeBytes');
        return;
      }
    }
    tools.add('fs.writeText');
  }

  function classifyAppendFileCall(callNode) {
    tools.add('fs.exists');
    if (callNode && Array.isArray(callNode.arguments) && callNode.arguments.length >= 2) {
      const dataArg = callNode.arguments[1];
      const optsArg = callNode.arguments[2];
      if (!hasExplicitStringEncodingArg(optsArg) && isExplicitBinaryArg(dataArg)) {
        tools.add('fs.readBytes');
        tools.add('fs.writeBytes');
        return;
      }
    }
    tools.add('fs.readText');
    tools.add('fs.writeText');
  }

  function classifyReadFileCall(callNode) {
    if (!callNode || !Array.isArray(callNode.arguments)) {
      tools.add('fs.readText');
      tools.add('fs.readBytes');
      return;
    }
    if (callNode.arguments.length <= 1) {
      tools.add('fs.readBytes');
      return;
    }
    const arg2 = callNode.arguments[1];
    if (arg2?.type === 'Literal') {
      if (arg2.value === null || arg2.value === undefined) {
        tools.add('fs.readBytes');
        return;
      }
      if (typeof arg2.value === 'string') {
        const lower = arg2.value.toLowerCase();
        tools.add(lower === 'utf8' || lower === 'utf-8' ? 'fs.readText' : 'fs.readBytes');
        return;
      }
    }
    if (arg2?.type === 'Identifier' && arg2.name === 'undefined') {
      tools.add('fs.readBytes');
      return;
    }
    if (arg2?.type === 'ObjectExpression') {
      const encProp = arg2.properties.find(p => p.type === 'Property' && !p.computed && p.key?.type === 'Identifier' && p.key.name === 'encoding');
      if (!encProp) {
        tools.add('fs.readBytes');
        return;
      }
      const lit = extractLiteralString(encProp.value);
      if (lit !== null) {
        const lower = lit.toLowerCase();
        tools.add(lower === 'utf8' || lower === 'utf-8' ? 'fs.readText' : 'fs.readBytes');
        return;
      }
      if (encProp.value?.type === 'Literal' && encProp.value.value === null) {
        tools.add('fs.readBytes');
        return;
      }
    }
    tools.add('fs.readText');
    tools.add('fs.readBytes');
  }

  function recordModuleMember(mod, member, callNode = null) {
    if (mod === 'fs' || mod === 'fs/promises') {
      if (member === 'readFileSync' || member === 'readFile') {
        classifyReadFileCall(callNode);
      } else if (member === 'writeFileSync' || member === 'writeFile') {
        classifyWriteFileCall(callNode);
      } else if (member === 'appendFileSync' || member === 'appendFile') {
        classifyAppendFileCall(callNode);
      } else if (member === 'mkdirSync' || member === 'mkdir') {
        tools.add('fs.mkdir');
      } else if (member === 'unlinkSync' || member === 'unlink' || member === 'rmSync' || member === 'rm' || member === 'rmdirSync' || member === 'rmdir') {
        tools.add('fs.unlink');
      } else if (member === 'renameSync' || member === 'rename') {
        tools.add('fs.rename');
      } else if (member === 'copyFileSync' || member === 'copyFile') {
        tools.add('fs.readBytes');
        tools.add('fs.writeBytes');
      } else if (member === 'existsSync' || member === 'accessSync' || member === 'access') {
        tools.add('fs.exists');
      } else if (member === 'readdirSync' || member === 'readdir') {
        tools.add('fs.readdir');
      } else if (member === 'statSync' || member === 'lstatSync' || member === 'stat' || member === 'lstat') {
        tools.add('fs.stat');
      }
    } else if (mod === 'child_process') {
      if (member === 'execFileSync' || member === 'execSync' || member === 'spawnSync') {
        tools.add('shell.exec');
      }
    } else if (mod === 'crypto') {
      if (member === 'randomUUID') tools.add('platform.uuid');
      else if (member === 'randomBytes' || member === 'randomFillSync' || member === 'randomFill') tools.add('platform.randomBytes');
    } else if (mod === 'process') {
      if (member === 'env') tools.add('env.get');
    }
  }

  function resolveModuleTarget(node, shadowed = null) {
    if (!node || typeof node !== 'object') return null;
    const directMod = unwrapRequireCall(node);
    if (directMod) return directMod;
    if (node.type === 'Identifier' && moduleAliases.has(node.name) && !(shadowed && shadowed.has(node.name))) {
      return moduleAliases.get(node.name);
    }
    if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier') {
      const parentMod = resolveModuleTarget(node.object, shadowed);
      if (parentMod === 'fs' && node.property.name === 'promises') return 'fs/promises';
      if (parentMod && node.property.name === 'default') return parentMod;
    }
    return null;
  }

  // Pass 1: collect top-level & local require/import module aliases + destructurings
  function collectBindings(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collectBindings(item);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration') {
      const mod = normalizeModuleId(node.source?.value);
      if (mod) {
        for (const spec of node.specifiers ?? []) {
          if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
            moduleAliases.set(spec.local.name, mod);
          } else if (spec.type === 'ImportSpecifier' && spec.imported?.type === 'Identifier') {
            if (mod === 'fs' && spec.imported.name === 'promises') {
              moduleAliases.set(spec.local.name, 'fs/promises');
            } else {
              directFnAliases.set(spec.local.name, {mod, member: spec.imported.name});
            }
          }
        }
      }
    } else if (node.type === 'VariableDeclarator' && node.init) {
      let mod = unwrapRequireCall(node.init);
      if (!mod && node.init.type === 'MemberExpression' && !node.init.computed && node.init.property?.type === 'Identifier') {
        const base = unwrapRequireCall(node.init.object) ?? (node.init.object?.type === 'Identifier' ? moduleAliases.get(node.init.object.name) : null);
        if (base === 'fs' && node.init.property.name === 'promises') mod = 'fs/promises';
      }
      if (mod) {
        if (node.id?.type === 'Identifier') {
          moduleAliases.set(node.id.name, mod);
        } else if (node.id?.type === 'ObjectPattern') {
          for (const prop of node.id.properties ?? []) {
            if (prop.type === 'Property' && !prop.computed && prop.key?.type === 'Identifier' && prop.value?.type === 'Identifier') {
              if (mod === 'fs' && prop.key.name === 'promises') {
                moduleAliases.set(prop.value.name, 'fs/promises');
              } else {
                directFnAliases.set(prop.value.name, {mod, member: prop.key.name});
              }
            }
          }
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'raw') continue;
      if (v && typeof v === 'object') collectBindings(v);
    }
  }
  collectBindings(ast);

  function addDeclaredIds(target, pat) {
    if (!pat || typeof pat !== 'object') return;
    if (pat.type === 'Identifier') target.add(pat.name);
    else if (pat.type === 'AssignmentPattern') addDeclaredIds(target, pat.left);
    else if (pat.type === 'RestElement') addDeclaredIds(target, pat.argument);
    else if (pat.type === 'ArrayPattern') pat.elements?.forEach(e => addDeclaredIds(target, e));
    else if (pat.type === 'ObjectPattern') pat.properties?.forEach(p => addDeclaredIds(target, p.type === 'Property' ? p.value : p.argument));
  }

  function unwrapSequenceCallee(node) {
    if (node?.type === 'SequenceExpression' && node.expressions.length > 0) {
      return node.expressions.at(-1);
    }
    return node;
  }

  function visitPattern(pat, shadowed) {
    if (!pat || typeof pat !== 'object') return;
    if (pat.type === 'AssignmentPattern') {
      visit(pat.right, pat, shadowed);
      visitPattern(pat.left, shadowed);
    } else if (pat.type === 'RestElement') {
      visitPattern(pat.argument, shadowed);
    } else if (pat.type === 'ArrayPattern') {
      for (const el of pat.elements ?? []) {
        if (el) visitPattern(el, shadowed);
      }
    } else if (pat.type === 'ObjectPattern') {
      for (const prop of pat.properties ?? []) {
        if (prop.type === 'RestElement') {
          visitPattern(prop.argument, shadowed);
        } else if (prop.type === 'Property') {
          if (prop.computed) visit(prop.key, prop, shadowed);
          visitPattern(prop.value, shadowed);
        }
      }
    }
  }

  function visit(node, parent, shadowed) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, shadowed);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration') return;
    if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern' || node.type === 'RestElement' && (parent?.type === 'ObjectPattern' || parent?.type === 'ArrayPattern')) {
      visitPattern(node, shadowed);
      return;
    }

    const nextShadowed = new Set(shadowed);
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      for (const st of node.body ?? []) {
        if (st.type === 'FunctionDeclaration' && st.id?.name) nextShadowed.add(st.id.name);
        else if (st.type === 'VariableDeclaration') {
          for (const decl of st.declarations ?? []) {
            if (!unwrapRequireCall(decl.init) &&
                !(decl.init?.type === 'MemberExpression' && unwrapRequireCall(decl.init.object))) {
              addDeclaredIds(nextShadowed, decl.id);
            }
          }
        }
      }
    } else if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      if (node.id?.name) nextShadowed.add(node.id.name);
      for (const p of node.params ?? []) addDeclaredIds(nextShadowed, p);
      for (const p of node.params ?? []) visitPattern(p, nextShadowed);
      visit(node.body, node, nextShadowed);
      return;
    } else if (node.type === 'CatchClause') {
      if (node.param) {
        addDeclaredIds(nextShadowed, node.param);
        visitPattern(node.param, nextShadowed);
      }
      visit(node.body, node, nextShadowed);
      return;
    }

    if (node.type === 'CallExpression') {
      const callee = unwrapSequenceCallee(node.callee);
      if (callee?.type === 'Identifier' && directFnAliases.has(callee.name) && !nextShadowed.has(callee.name)) {
        const {mod, member} = directFnAliases.get(callee.name);
        recordModuleMember(mod, member, node);
      } else if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
        const mod = resolveModuleTarget(callee.object, nextShadowed);
        if (mod) {
          recordModuleMember(mod, callee.property.name, node);
        } else if (callee.object?.type === 'Identifier' && callee.object.name === 'crypto' && !nextShadowed.has('crypto')) {
          recordModuleMember('crypto', callee.property.name, node);
        } else if (callee.object?.type === 'MemberExpression' && !callee.object.computed &&
            callee.object.object?.type === 'Identifier' && callee.object.object.name === 'globalThis' &&
            callee.object.property?.type === 'Identifier' && callee.object.property.name === 'crypto') {
          recordModuleMember('crypto', callee.property.name, node);
        }
      }
    } else if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier') {
      const isGlobalProcess = node.object?.type === 'Identifier' && node.object.name === 'process' && !nextShadowed.has('process');
      const isGlobalThisProcess = node.object?.type === 'MemberExpression' && !node.object.computed &&
        node.object.object?.type === 'Identifier' && node.object.object.name === 'globalThis' &&
        node.object.property?.type === 'Identifier' && node.object.property.name === 'process';
      if ((isGlobalProcess || isGlobalThisProcess) && node.property.name === 'env') {
        tools.add('env.get');
      } else {
        const mod = resolveModuleTarget(node.object, nextShadowed);
        if (mod && !(parent?.type === 'CallExpression' && unwrapSequenceCallee(parent.callee) === node)) {
          recordModuleMember(mod, node.property.name, null);
        }
      }
    } else if (node.type === 'Identifier' && directFnAliases.has(node.name) && !nextShadowed.has(node.name)) {
      const isNonRef =
        (parent?.type === 'VariableDeclarator' && parent.id === node) ||
        (parent?.type === 'Property' && !parent.computed && parent.key === node && (!parent.shorthand || parent.value !== node)) ||
        (parent?.type === 'MemberExpression' && !parent.computed && parent.property === node) ||
        (parent?.type === 'MethodDefinition' && !parent.computed && parent.key === node) ||
        (parent?.type === 'PropertyDefinition' && !parent.computed && parent.key === node) ||
        (parent?.type === 'LabeledStatement' && parent.label === node) ||
        (parent?.type === 'CallExpression' && unwrapSequenceCallee(parent.callee) === node);
      if (!isNonRef) {
        const {mod, member} = directFnAliases.get(node.name);
        recordModuleMember(mod, member, null);
      }
    }

    for (const [key, val] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'raw') continue;
      if (node.type === 'VariableDeclarator' && key === 'id' && val?.type === 'Identifier') continue;
      if (val && typeof val === 'object') visit(val, node, nextShadowed);
    }
  }

  visit(ast, null, new Set());
  return tools;
}
