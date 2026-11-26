#!/usr/bin/env node
// Automated OSS JavaScript/TypeScript execution harvester.
// Pulls real, messy, multi-function MIT/Apache npm packages & GitHub unit tests,
// tree-shakes self-contained call graphs per export with esbuild, records real
// inputs and real multi-turn side-effect tool calls, and verifies 100% of
// admitted tasks through prepareTinkerTask() (owned VM === native Node oracle).

import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parseArgs, types} from 'node:util';
import vm from 'node:vm';
import {parse} from 'acorn';
import ts from 'typescript';
import {prepareTinkerTask, readableMessagesFromJournal, encodeReadable,
  assistantVisibleText, assistantThinkingText} from '../src/training/tinker-execution.js';
import {createLiveFetchRecorder, sourceUsesGlobalFetch, VM_FETCH_RUNTIME_SCRIPT} from '../src/training/tinker-http-fetch.js';
import {nearCloneHash, executionInputSignature} from '../src/training/tinker-benchmark.js';
import {failureCategory} from '../src/training/tinker-verification.js';

// Arbitrary probed OSS functions may schedule detached rejected promises inside Node's microtask queue.
process.on('unhandledRejection', () => {});

const stripTmpComments = code => code.replace(/^\s*\/\/ (?:\.\.\/)+\S+\r?\n/gm, '');

const BOOLEAN_CLI_FLAGS = new Set(['clone-tests', 'skip-npm', 'prefer-unit-tests', 'unit-tests-only']);

export function parseHarvesterArgs(argv = process.argv.slice(2)) {
  const normalized = [];
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2) {
      const name = arg.slice(2, eq);
      const val = arg.slice(eq + 1);
      if (BOOLEAN_CLI_FLAGS.has(name)) {
        if (val === 'false' || val === '0') { normalized.push('--no-' + name); continue; }
        if (val === 'true' || val === '1') { normalized.push('--' + name); continue; }
      }
    }
    normalized.push(arg);
  }
  const {values: v} = parseArgs({
    args: normalized,
    allowNegative: true,
    options: {
      'env-dir': {type: 'string', default: '/tmp/tinker-harvest-env'},
      'repos-dir': {type: 'string', default: '/tmp/tinker-harvest-repos'},
      'local-repos': {type: 'string'},
      'output-dir': {type: 'string', default: 'runs/tinker-harvest'},
      mode: {type: 'string', default: 'owned'},
      jobs: {type: 'string', default: '4'},
      'max-per-fn': {type: 'string', default: '3'},
      'max-per-repo': {type: 'string', default: '30'},
      'clone-tests': {type: 'boolean', default: true},
      'skip-npm': {type: 'boolean', default: false},
      'prefer-unit-tests': {type: 'boolean', default: true},
      'unit-tests-only': {type: 'boolean', default: false},
      'min-source-chars': {type: 'string', default: '0'},
      'min-trace-lines': {type: 'string', default: '0'},
      limit: {type: 'string'},
    },
  });
  return {
    values: v,
    envDir: resolve(v['env-dir']),
    reposDir: resolve(v['repos-dir']),
    localReposDir: v['local-repos'] ? resolve(v['local-repos']) : null,
    outputDir: resolve(v['output-dir']),
    harvestMode: v.mode === 'native' ? 'native' : 'owned',
    jobs: Math.max(1, Math.min(8, Number(v.jobs) || 4)),
    maxPerFn: Math.max(1, Math.min(12, Number(v['max-per-fn']) || 3)),
    maxPerRepo: Math.max(1, Math.min(200, Number(v['max-per-repo']) || 30)),
    preferUnitTests: Boolean(v['prefer-unit-tests']),
    unitTestsOnly: Boolean(v['unit-tests-only']),
    minSourceChars: Math.max(0, Number(v['min-source-chars']) || 0),
    minTraceLines: Math.max(0, Number(v['min-trace-lines']) || 0),
    limit: v.limit ? Number(v.limit) : null,
  };
}

let values = {
  'clone-tests': true,
  'skip-npm': false,
  'prefer-unit-tests': true,
  'unit-tests-only': false,
};
let envDir = resolve('/tmp/tinker-harvest-env');
let reposDir = resolve('/tmp/tinker-harvest-repos');
let localReposDir = null;
let outputDir = resolve('runs/tinker-harvest');
let harvestMode = 'owned';
let jobs = 4;
let maxPerFn = 3;
let maxPerRepo = 30;
let preferUnitTests = true;
let unitTestsOnly = false;
let minSourceChars = 0;
let minTraceLines = 0;
let limit = null;

const esbuildCache = new Map();
function getEsbuild(dir = envDir) {
  const key = resolve(dir);
  if (esbuildCache.has(key)) return esbuildCache.get(key);
  let loaded = null;
  const envPkg = join(key, 'package.json');
  if (existsSync(envPkg)) {
    try { loaded = createRequire(envPkg)('esbuild'); } catch {}
  }
  if (!loaded) {
    try { loaded = createRequire(import.meta.url)('esbuild'); } catch {}
  }
  esbuildCache.set(key, loaded);
  return loaded;
}

function getReq(dir = envDir) {
  return createRequire(join(dir, 'package.json'));
}

const sha256 = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

function packageDir(pkgName) {
  return join(envDir, 'node_modules', pkgName);
}

function readPkgMeta(pkgName) {
  const pkgDir = packageDir(pkgName);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  return {
    pkgDir,
    pkgName,
    version: pkgJson.version ?? 'unknown',
    license: typeof pkgJson.license === 'string' ? pkgJson.license : (pkgJson.license?.type ?? 'unknown'),
    repository: typeof pkgJson.repository === 'string' ? pkgJson.repository : (pkgJson.repository?.url ?? null),
    pkgJson,
  };
}

function resolvePackageEntry(pkgDir, pkgJson) {
  const exp = pkgJson.exports;
  const pick = node => {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return null;
    return pick(node.import) ?? pick(node.module) ?? pick(node.default) ?? pick(node.require) ?? pick(node.node);
  };
  const rel = (exp && typeof exp === 'object' && '.' in exp ? pick(exp['.']) : pick(exp))
    ?? pkgJson.module ?? pkgJson.main ?? 'index.js';
  const candidate = resolve(pkgDir, rel);
  if (existsSync(candidate)) return candidate;
  if (existsSync(candidate + '.js')) return candidate + '.js';
  if (existsSync(join(candidate, 'index.js'))) return join(candidate, 'index.js');
  return getReq().resolve(pkgJson.name);
}

// --- 1. Tree-shaken per-export bundling via esbuild (zero CJS boilerplate!) ---
const bundleCache = new Map();
function bundleExport(pkgName, exportName = null, subpath = null) {
  const esbuild = getEsbuild();
  if (!esbuild) return {error: 'esbuild unavailable'};
  const key = `${pkgName}|${exportName ?? '*'}|${subpath ?? ''}`;
  if (bundleCache.has(key)) return bundleCache.get(key);
  try {
    const meta = readPkgMeta(pkgName);
    const entryPath = subpath ? resolve(meta.pkgDir, subpath) : resolvePackageEntry(meta.pkgDir, meta.pkgJson);
    const importSpec = entryPath;
    let stdinCode;
    if (!exportName) {
      stdinCode = `import * as __m from ${JSON.stringify(importSpec)}; __harvestTarget = __m;`;
    } else if (exportName === 'default') {
      stdinCode = `import __d from ${JSON.stringify(importSpec)}; __harvestTarget = __d;`;
    } else {
      stdinCode = `import { ${exportName} as __f } from ${JSON.stringify(importSpec)}; __harvestTarget = __f;`;
    }
    const built = esbuild.buildSync({
      stdin: {contents: stdinCode, resolveDir: meta.pkgDir, loader: 'js'},
      bundle: true,
      treeShaking: true,
      write: false,
      format: 'iife',
      platform: 'neutral',
      target: 'es2022',
      mainFields: ['module', 'main'],
      conditions: ['import', 'default', 'require'],
      define: {
        'process.env.NODE_ENV': '"production"',
        'process.env.NODE_DEBUG': 'undefined',
        'process.env.DEBUG': 'undefined',
        'process': 'undefined',
      },
      logLevel: 'silent',
    });
    const code = built.outputFiles[0].text;
    const info = {
      ...meta,
      subpath: subpath ?? relative(meta.pkgDir, entryPath),
      exportName: exportName ?? 'module',
      code,
      directTarget: true,
    };
    bundleCache.set(key, info);
    return info;
  } catch (err) {
    // Fallback: bundle entry directly (handles CJS modules without named ESM exports)
    if (exportName && exportName !== 'default') {
      const whole = bundleWholeEntry(pkgName, subpath);
      if (!whole.error) {
        const info = {...whole, exportName, wholeModule: true};
        bundleCache.set(key, info);
        return info;
      }
    }
    const fail = {error: String(err.message)};
    bundleCache.set(key, fail);
    return fail;
  }
}

function bundleWholeEntry(pkgName, subpath = null) {
  const esbuild = getEsbuild();
  if (!esbuild) return {error: 'esbuild unavailable'};
  const key = `WHOLE|${pkgName}|${subpath ?? ''}`;
  if (bundleCache.has(key)) return bundleCache.get(key);
  try {
    const meta = readPkgMeta(pkgName);
    const entryPath = subpath ? resolve(meta.pkgDir, subpath) : resolvePackageEntry(meta.pkgDir, meta.pkgJson);
    const built = esbuild.buildSync({
      entryPoints: [entryPath],
      bundle: true,
      treeShaking: true,
      write: false,
      format: 'iife',
      globalName: '__harvestBox',
      platform: 'neutral',
      target: 'es2022',
      mainFields: ['module', 'main'],
      conditions: ['import', 'default', 'require'],
      define: {
        'process.env.NODE_ENV': '"production"',
        'process.env.NODE_DEBUG': 'undefined',
        'process.env.DEBUG': 'undefined',
        'process': 'undefined',
      },
      logLevel: 'silent',
    });
    const info = {...meta, subpath: subpath ?? relative(meta.pkgDir, entryPath), code: built.outputFiles[0].text, wholeModule: true};
    bundleCache.set(key, info);
    return info;
  } catch (err) {
    const fail = {error: String(err.message)};
    bundleCache.set(key, fail);
    return fail;
  }
}

function safeErrorDescriptor(err) {
  if (err === null || typeof err !== 'object') {
    return {errorName: typeof err, errorMessage: String(err)};
  }
  if (types.isProxy(err)) {
    return {errorName: 'ProxyError', errorMessage: ''};
  }
  let errorName = 'Error';
  let errorMessage = '';
  try {
    const proto = Object.getPrototypeOf(err);
    const nameDesc = Object.getOwnPropertyDescriptor(err, 'name') ??
      (proto && !types.isProxy(proto) ? Object.getOwnPropertyDescriptor(proto, 'name') : null);
    if (nameDesc && Object.hasOwn(nameDesc, 'value') && typeof nameDesc.value === 'string') {
      errorName = nameDesc.value;
    }
    const msgDesc = Object.getOwnPropertyDescriptor(err, 'message');
    if (msgDesc && Object.hasOwn(msgDesc, 'value') && typeof msgDesc.value === 'string') {
      errorMessage = msgDesc.value;
    }
  } catch {}
  return {errorName, errorMessage};
}

function buildProbeContext(sampleArgs, recordedCalls, mode, {fetchTimeoutMs = 4000, maxBodyBytes = 48 * 1024, enableFetch = false} = {}) {
  const baseEnv = {__args: structuredClone(sampleArgs)};
  if (mode === 'native') {
    Object.assign(baseEnv, {URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone});
    baseEnv.console = Object.fromEntries(['log', 'info', 'warn', 'error'].map(lvl => [lvl, (...xs) => {
      if (recordedCalls.length <= 24) {
        const msg = xs.length ? xs[0] : undefined;
        recordedCalls.push({operation: 'platform.console.' + lvl, arguments: [encodeReadable(msg)], status: 'fulfilled', result: {$js: 'undefined'}});
      }
    }]));
    let clockMs = 1700000100000;
    baseEnv.__recDateNow = () => {
      const v = clockMs;
      clockMs += 37;
      if (recordedCalls.length <= 24) recordedCalls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: v});
      return v;
    };
    baseEnv.__recRandom = () => {
      const v = Math.round(Math.random() * 1e6) / 1e6;
      if (recordedCalls.length <= 24) recordedCalls.push({operation: 'platform.random', arguments: [], status: 'fulfilled', result: v});
      return v;
    };
    if (enableFetch) {
      const {liveFetch} = createLiveFetchRecorder(recordedCalls, {
        timeoutMs: fetchTimeoutMs,
        maxBodyBytes,
        encodeReadable,
      });
      baseEnv.__platformFetch = liveFetch;
    }
  }
  const ctx = vm.createContext(baseEnv);
  if (mode === 'native' && enableFetch) {
    new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(ctx, {timeout: 200});
  }
  return ctx;
}

function buildProbeScript(bundle, fnName, mode) {
  const patchPreamble = mode === 'native'
    ? 'Date.now = __recDateNow; Math.random = __recRandom;\n'
    : '';
  const load = bundle.directTarget
    ? `let __harvestTarget;\n${bundle.code}\nconst __fn = __harvestTarget;`
    : `${bundle.code}\nconst __fn = ${!bundle.wholeModule
      ? '(__harvestBox.default ?? __harvestBox)'
      : (fnName === 'default'
        ? '(typeof __harvestBox === "function" ? __harvestBox : (__harvestBox.default ?? __harvestBox))'
        : `(__harvestBox[${JSON.stringify(fnName)}] ?? __harvestBox.default?.[${JSON.stringify(fnName)}])`)};`;
  return new vm.Script(`(() => {\n${patchPreamble}${load}\nif (typeof __fn !== "function") throw new TypeError("__HARVEST_NOT_FN__");\nconst __out = __fn(...__args);\nif (__out && typeof __out.catch === "function") { __out.catch(() => {}); return Promise.resolve(__out); }\nreturn __out;\n})()`);
}

function probeExportSafely(bundle, fnName, sampleArgs, {mode = harvestMode} = {}) {
  const recordedCalls = [];
  const ctx = buildProbeContext(sampleArgs, recordedCalls, mode);
  const script = buildProbeScript(bundle, fnName, mode);
  try {
    const value = script.runInContext(ctx, {timeout: 100});
    if (recordedCalls.length > 24) throw new RangeError('Too many external calls');
    if (value && typeof value === 'object' && typeof value.then === 'function') {
      return {kind: 'promise', value, recordedCalls};
    }
    return {kind: 'return', value, recordedCalls};
  } catch (err) {
    if (err && (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || err.message === '__HARVEST_NOT_FN__' || err.message === 'Too many external calls')) {
      throw err;
    }
    if (recordedCalls.length > 24) throw new RangeError('Too many external calls');
    const {errorName, errorMessage} = safeErrorDescriptor(err);
    return {kind: 'throw', error: err, errorName, errorMessage, recordedCalls};
  }
}

export async function probeExportSafelyAsync(
  bundle,
  fnName,
  sampleArgs,
  {mode = harvestMode, timeoutMs = 4000, maxBodyBytes = 48 * 1024} = {},
) {
  const recordedCalls = [];
  const ctx = buildProbeContext(sampleArgs, recordedCalls, mode, {
    fetchTimeoutMs: timeoutMs,
    maxBodyBytes,
    enableFetch: mode === 'native',
  });
  const script = buildProbeScript(bundle, fnName, mode);
  try {
    let value = script.runInContext(ctx, {timeout: 200});
    if (value && typeof value === 'object' && typeof value.then === 'function') {
      let timer = null;
      value = await Promise.race([
        value,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('__HARVEST_ASYNC_TIMEOUT__')), timeoutMs + 2000);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }
    if (recordedCalls.length > 24) throw new RangeError('Too many external calls');
    return {kind: 'return', value, recordedCalls};
  } catch (err) {
    if (err && (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || err.message === '__HARVEST_NOT_FN__' || err.message === '__HARVEST_ASYNC_TIMEOUT__' || err.message === 'Too many external calls')) {
      throw err;
    }
    if (recordedCalls.length > 24) throw new RangeError('Too many external calls');
    const {errorName, errorMessage} = safeErrorDescriptor(err);
    return {kind: 'throw', error: err, errorName, errorMessage, recordedCalls};
  }
}

const isSkippedProbeName = (name, mode = harvestMode) => (mode === 'native'
  ? /^(?:sleep|delay|defer|debounce|throttle|retry|parallel|noop|identity|memo|memoize|proxied|tryit|guard|chain|compose|pipe|curry|partial|partob|promisify|all|any|race)$/i
  : /^(?:sleep|delay|defer|debounce|throttle|retry|parallel|random|uid|draw|shuffle|sample|noop|identity|memo|memoize|proxied|tryit|guard|chain|compose|pipe|curry|partial|partob|promisify|all|any|race)$/i
).test(name);

// --- 1b. Bundle an arbitrary local JS/TS file (from cloned/DGX GitHub repos) ---
function bundleLocalFile(repoMeta, absFile, exportName = null) {
  const esbuild = getEsbuild();
  if (!esbuild) return {error: 'esbuild unavailable'};
  const rel = relative(repoMeta.pkgDir, absFile);
  const key = `LOCAL|${repoMeta.pkgName}|${rel}|${exportName ?? '*'}`;
  if (bundleCache.has(key)) return bundleCache.get(key);
  const commonOpts = {
    bundle: true,
    treeShaking: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default', 'require'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NODE_DEBUG': 'undefined',
      'process.env.DEBUG': 'undefined',
      'process': 'undefined',
    },
    logLevel: 'silent',
  };
  try {
    let built;
    let wholeModule = false;
    let directTarget = false;
    if (!exportName) {
      built = esbuild.buildSync({entryPoints: [absFile], globalName: '__harvestBox', ...commonOpts});
      wholeModule = true;
    } else if (exportName === 'default') {
      const stdinCode = `import __d from ${JSON.stringify(absFile)}; __harvestTarget = __d;`;
      built = esbuild.buildSync({stdin: {contents: stdinCode, resolveDir: repoMeta.pkgDir, loader: 'ts'}, ...commonOpts});
      directTarget = true;
    } else {
      const stdinCode = `import { ${exportName} as __f } from ${JSON.stringify(absFile)}; __harvestTarget = __f;`;
      built = esbuild.buildSync({stdin: {contents: stdinCode, resolveDir: repoMeta.pkgDir, loader: 'ts'}, ...commonOpts});
      directTarget = true;
    }
    const info = {...repoMeta, subpath: rel, exportName: exportName ?? 'module', code: stripTmpComments(built.outputFiles[0].text), wholeModule, directTarget};
    bundleCache.set(key, info);
    return info;
  } catch (err) {
    if (exportName && exportName !== 'default') {
      const whole = bundleLocalFile(repoMeta, absFile, null);
      if (!whole.error) {
        const info = {...whole, exportName, wholeModule: true};
        bundleCache.set(key, info);
        return info;
      }
    }
    const fail = {error: String(err.message)};
    bundleCache.set(key, fail);
    return fail;
  }
}

function collectSourceAndTestFiles(dir, out = {code: [], tests: []}, rootDir = dir) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const n = entry.name;
    if (n.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', 'docs', 'examples', 'example', 'demo', 'demos', 'bench', 'benchmarks', 'fixtures', 'vendor', 'website'].includes(n)) continue;
    const p = join(dir, n);
    if (entry.isDirectory()) {
      collectSourceAndTestFiles(p, out, rootDir);
    } else if (/\.(?:c|m)?[jt]s$/i.test(n) && !n.endsWith('.d.ts') && !/\.config\.|\.eslintrc|\.prettierrc/.test(n)) {
      const sz = statSync(p).size;
      if (sz === 0 || sz > 256 * 1024) continue;
      const rel = relative(rootDir, p).replace(/\\/g, '/');
      if (/(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]s$/i.test(rel)) out.tests.push(p);
      else out.code.push(p);
    }
  }
  if (dir === rootDir) {
    out.code.sort();
    out.tests.sort((a, b) => {
      const ta = /\.(?:test|spec)\.[cm]?[jt]s$/i.test(a) ? 0 : 1;
      const tb = /\.(?:test|spec)\.[cm]?[jt]s$/i.test(b) ? 0 : 1;
      return ta - tb || a.localeCompare(b);
    });
  }
  return out;
}

const IGNORED_MEMBER_RECEIVERS = new Set([
  'assert', 'expect', 'should', 't', 'test', 'it', 'describe', 'suite',
  'chai', 'jest', 'vi', 'vitest', 'sinon', 'mock', 'console', 'Math', 'JSON',
  'Object', 'Array', 'Number', 'String', 'Boolean', 'Promise', 'Reflect',
  'Buffer', 'process', 'Date', 'RegExp', 'Error', 'Map', 'Set', 'Symbol',
]);
const ASSERTION_HELPER_CALLS = new Set([
  'assert', 'expect', 'should', 'describe', 'it', 'test', 'before', 'after',
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'suite', 'mock',
]);
const EACH_ROOTS = new Set(['test', 'it', 'describe', 'suite']);
const EACH_MODIFIERS = new Set(['skip', 'only', 'concurrent', 'todo', 'sequential']);

const parsedTestAstCache = new Map();
const jsonFixtureCache = new Map();

function transpileTsForTests(text, file, targetEnvDir = envDir) {
  const esbuild = getEsbuild(targetEnvDir);
  if (esbuild) {
    try {
      return esbuild.transformSync(text, {loader: file.endsWith('x') ? 'tsx' : 'ts', target: 'es2022', logLevel: 'silent'}).code;
    } catch {}
  }
  try {
    return ts.transpileModule(text, {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve},
    }).outputText;
  } catch {
    return null;
  }
}

function getParsedTestAst(file, targetEnvDir = envDir) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const cached = parsedTestAstCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.ast;
  }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  if (/\.[cm]?tsx?$/i.test(file)) {
    text = transpileTsForTests(text, file, targetEnvDir);
    if (text === null) return null;
  }
  let ast = null;
  try { ast = parse(text, {ecmaVersion: 'latest', sourceType: 'module'}); }
  catch { try { ast = parse(text, {ecmaVersion: 'latest', sourceType: 'script'}); } catch { return null; } }
  parsedTestAstCache.set(file, {mtimeMs: st.mtimeMs, size: st.size, ast});
  return ast;
}

function loadLocalJsonFixture(repoDir, fileDir, spec) {
  if (typeof spec !== 'string' || (!spec.startsWith('./') && !spec.startsWith('../'))) return {ok: false};
  const absRepo = resolve(repoDir);
  const repoPrefix = absRepo.endsWith(sep) ? absRepo : absRepo + sep;
  const base = resolve(fileDir, spec);
  const candidates = base.endsWith('.json') ? [base] : [base + '.json', join(base, 'index.json')];
  for (const cand of candidates) {
    if (cand !== absRepo && !cand.startsWith(repoPrefix)) continue;
    if (!existsSync(cand)) continue;
    try {
      const st = statSync(cand);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      const cacheKey = `${cand}|${st.mtimeMs}|${st.size}`;
      if (jsonFixtureCache.has(cacheKey)) {
        return {ok: true, value: structuredClone(jsonFixtureCache.get(cacheKey))};
      }
      const parsed = JSON.parse(readFileSync(cand, 'utf8'));
      jsonFixtureCache.set(cacheKey, parsed);
      return {ok: true, value: structuredClone(parsed)};
    } catch {}
  }
  return {ok: false};
}

function bindPattern(pattern, value, env, ctx) {
  if (!pattern || typeof pattern !== 'object') return;
  if (pattern.type === 'Identifier') {
    if (pattern.name !== '__proto__') env.set(pattern.name, value === undefined ? undefined : structuredClone(value));
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    let resolved = value;
    if (resolved === undefined) {
      const def = evalStaticAst(pattern.right, env, ctx);
      if (!def.ok) return;
      resolved = def.value;
    }
    bindPattern(pattern.left, resolved, env, ctx);
    return;
  }
  if (pattern.type === 'ArrayPattern' && Array.isArray(value)) {
    for (let i = 0; i < pattern.elements.length; i++) {
      const el = pattern.elements[i];
      if (!el) continue;
      if (el.type === 'RestElement') {
        bindPattern(el.argument, value.slice(i), env, ctx);
        break;
      }
      bindPattern(el, value[i], env, ctx);
    }
    return;
  }
  if (pattern.type === 'ObjectPattern' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const used = new Set();
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement') {
        const rest = {};
        for (const [k, v] of Object.entries(value)) {
          if (!used.has(k) && k !== '__proto__') rest[k] = v;
        }
        bindPattern(prop.argument, rest, env, ctx);
      } else if (prop.type === 'Property') {
        let k = null;
        if (!prop.computed) {
          k = prop.key.type === 'Identifier' ? prop.key.name : (prop.key.type === 'Literal' ? String(prop.key.value) : null);
        } else {
          const kr = evalStaticAst(prop.key, env, ctx);
          if (kr.ok && (typeof kr.value === 'string' || typeof kr.value === 'number')) k = String(kr.value);
        }
        if (k === null || k === '__proto__') continue;
        used.add(k);
        bindPattern(prop.value, Object.hasOwn(value, k) ? value[k] : undefined, env, ctx);
      }
    }
  }
}

function isEachHelperCallee(callee) {
  if (!callee || callee.type !== 'CallExpression' || !callee.arguments.length) return false;
  const mem = callee.callee;
  if (!mem || mem.type !== 'MemberExpression' || mem.computed || mem.property?.name !== 'each') return false;
  let cur = mem.object;
  while (cur && cur.type === 'MemberExpression' && !cur.computed && cur.property?.type === 'Identifier') {
    if (!EACH_MODIFIERS.has(cur.property.name)) return false;
    cur = cur.object;
  }
  return cur?.type === 'Identifier' && EACH_ROOTS.has(cur.name);
}

function memberChainRoot(node) {
  let cur = node;
  while (cur && cur.type === 'MemberExpression') cur = cur.object;
  return cur;
}

function resolveTargetFnName(callee, exportSet, localAliases, aliasSet, namespaceAliases) {
  if (!callee) return null;
  if (callee.type === 'Identifier') {
    if (exportSet.has(callee.name)) return callee.name;
    if (localAliases.has(callee.name)) return localAliases.get(callee.name);
    if (aliasSet.has(callee.name) && exportSet.has('default')) return 'default';
    return null;
  }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
    const propName = callee.property.name;
    if (!exportSet.has(propName)) return null;
    const root = memberChainRoot(callee.object);
    if (!root || root.type !== 'Identifier') return null;
    if (IGNORED_MEMBER_RECEIVERS.has(root.name)) return null;
    if (callee.object.type === 'Identifier' && namespaceAliases.has(callee.object.name)) return propName;
    return propName;
  }
  return null;
}

function isCompatibleDefaultImport(spec, repoDir, fileDir, options = {}) {
  if (typeof spec !== 'string' || !spec.length) return false;
  const {targetFile = null, pkgName = null, aliasSet = null} = options;
  const isRel = spec.startsWith('./') || spec.startsWith('../');
  if (!isRel) {
    if (pkgName && (spec === pkgName || spec.startsWith(pkgName + '/'))) return true;
    if (aliasSet && aliasSet.has(spec)) return true;
    return false;
  }
  if (!targetFile) return true;
  const stripExt = p => p.replace(/\.(?:[cm]?[jt]sx?)$/i, '').replace(/\/index$/i, '');
  const resolvedSpec = stripExt(resolve(fileDir, spec));
  const resolvedTarget = stripExt(resolve(repoDir, targetFile));
  if (resolvedSpec === resolvedTarget || basename(resolvedSpec) === basename(resolvedTarget)) return true;
  // Allow barrel / package entry imports (e.g. '../src/index.js', '../../lib/marked.esm.js', '..')
  if (/^(?:\.\.?\/)+$/.test(spec) || /(?:^|\/)(?:index|main)(?:\.[cm]?[jt]s)?$/i.test(spec) ||
      (aliasSet && aliasSet.has(basename(resolvedSpec).replace(/\.(?:esm|cjs|umd|min)$/i, '')))) {
    return true;
  }
  return false;
}

export function extractTestCallsFromFiles(repoDir, testFiles, exportNames, aliases = [], options = {}) {
  const byFn = new Map();
  const exportSet = new Set(exportNames);
  const aliasSet = new Set(aliases.filter(Boolean));
  const maxFiles = options.maxFiles ?? 300;
  const maxCallsPerFn = options.maxCallsPerFn ?? 30;
  const targetEnvDir = options.envDir ?? envDir;
  const importFilterOpts = {targetFile: options.targetFile ?? null, pkgName: options.pkgName ?? null, aliasSet};

  for (const file of testFiles.slice(0, maxFiles)) {
    const ast = getParsedTestAst(file, targetEnvDir);
    if (!ast) continue;
    const fileDir = dirname(file);
    const relFile = relative(repoDir, file);
    const localAliases = new Map();
    const namespaceAliases = new Set();
    const ctx = {repoDir, fileDir, helperDepth: 0, activeHelpers: new Set()};

    function recordCall(fnName, args) {
      if (!fnName || !args.length || args.length > 8) return;
      let sig;
      try {
        sig = JSON.stringify(encodeReadable(args));
      } catch {
        return;
      }
      if (!sig || sig.length > 3000) return;
      if (!byFn.has(fnName)) byFn.set(fnName, []);
      const list = byFn.get(fnName);
      if (list.length < maxCallsPerFn && !list.some(x => x.sig === sig)) {
        list.push({args, sig, file: relFile});
      }
    }

    function evalCallArguments(argNodes, env) {
      const out = [];
      for (const arg of argNodes) {
        if (arg.type === 'SpreadElement') {
          const r = evalStaticAst(arg.argument, env, ctx);
          if (!r.ok || !Array.isArray(r.value) || out.length + r.value.length > 8) return null;
          out.push(...r.value);
        } else {
          const r = evalStaticAst(arg, env, ctx);
          if (!r.ok) return null;
          out.push(r.value);
        }
      }
      return out.length >= 1 && out.length <= 8 ? out : null;
    }

    function hoistDeclarations(stmts, helpers) {
      for (const st of stmts) {
        if (st?.type === 'FunctionDeclaration' && st.id?.name) {
          helpers.set(st.id.name, st);
        }
      }
    }

    function scanStatements(stmts, env, helpers) {
      const blockEnv = new Map(env);
      const blockHelpers = new Map(helpers);
      hoistDeclarations(stmts, blockHelpers);
      for (const st of stmts) {
        scanNode(st, blockEnv, blockHelpers);
      }
    }

    function scanNode(node, env, helpers) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) scanNode(item, env, helpers);
        return;
      }
      if (typeof node.type !== 'string') return;

      switch (node.type) {
        case 'Program':
        case 'BlockStatement':
          scanStatements(node.body, env, helpers);
          return;

        case 'ImportDeclaration': {
          const src = node.source?.value;
          const jsonFix = loadLocalJsonFixture(repoDir, fileDir, src);
          if (jsonFix.ok) {
            for (const spec of node.specifiers ?? []) {
              if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
                env.set(spec.local.name, structuredClone(jsonFix.value));
              } else if (spec.type === 'ImportSpecifier' && spec.imported?.type === 'Identifier' &&
                  jsonFix.value && typeof jsonFix.value === 'object' && Object.hasOwn(jsonFix.value, spec.imported.name)) {
                env.set(spec.local.name, structuredClone(jsonFix.value[spec.imported.name]));
              }
            }
            return;
          }
          const isLocalModule = isCompatibleDefaultImport(src, repoDir, fileDir, importFilterOpts);
          for (const spec of node.specifiers ?? []) {
            if (spec.type === 'ImportDefaultSpecifier' && exportSet.has('default') && isLocalModule) {
              localAliases.set(spec.local.name, 'default');
            } else if (spec.type === 'ImportNamespaceSpecifier' && (!src || src.startsWith('.') || src === options.pkgName)) {
              namespaceAliases.add(spec.local.name);
            } else if (spec.type === 'ImportSpecifier' && spec.imported?.type === 'Identifier' && exportSet.has(spec.imported.name) &&
                (!src || src.startsWith('.') || src === options.pkgName || (aliasSet && aliasSet.has(src)))) {
              localAliases.set(spec.local.name, spec.imported.name);
            }
          }
          return;
        }

        case 'VariableDeclaration': {
          for (const decl of node.declarations) {
            if (!decl.init) continue;
            if (decl.init.type === 'CallExpression' && decl.init.callee?.type === 'Identifier' &&
                decl.init.callee.name === 'require' && decl.init.arguments.length === 1 &&
                decl.init.arguments[0].type === 'Literal' && typeof decl.init.arguments[0].value === 'string') {
              const reqSpec = decl.init.arguments[0].value;
              const jsonFix = loadLocalJsonFixture(repoDir, fileDir, reqSpec);
              if (jsonFix.ok) {
                bindPattern(decl.id, jsonFix.value, env, ctx);
                continue;
              }
              const isLocalDefault = isCompatibleDefaultImport(reqSpec, repoDir, fileDir, importFilterOpts);
              const isLocalPkg = reqSpec.startsWith('.') || reqSpec === options.pkgName || aliasSet.has(reqSpec);
              if (!isLocalPkg) continue;
              if (decl.id?.type === 'Identifier') {
                namespaceAliases.add(decl.id.name);
                if (exportSet.has('default') && isLocalDefault) localAliases.set(decl.id.name, 'default');
                continue;
              }
              if (decl.id?.type === 'ObjectPattern') {
                for (const prop of decl.id.properties) {
                  if (prop.type === 'Property' && prop.key?.type === 'Identifier' && prop.value?.type === 'Identifier' &&
                      exportSet.has(prop.key.name)) {
                    localAliases.set(prop.value.name, prop.key.name);
                  }
                }
                continue;
              }
            }
            if (decl.id?.type === 'Identifier' &&
                (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
              helpers.set(decl.id.name, decl.init);
              continue;
            }
            if (decl.id?.type === 'ObjectPattern' && decl.init.type === 'Identifier' && namespaceAliases.has(decl.init.name)) {
              for (const prop of decl.id.properties) {
                if (prop.type === 'Property' && prop.key?.type === 'Identifier' && prop.value?.type === 'Identifier' &&
                    exportSet.has(prop.key.name)) {
                  localAliases.set(prop.value.name, prop.key.name);
                }
              }
              continue;
            }
            const r = evalStaticAst(decl.init, env, ctx);
            if (r.ok) {
              bindPattern(decl.id, r.value, env, ctx);
            } else {
              scanNode(decl.init, env, helpers);
            }
          }
          return;
        }

        case 'AssignmentExpression': {
          if (node.operator === '=' && node.left?.type === 'Identifier') {
            const r = evalStaticAst(node.right, env, ctx);
            if (r.ok) {
              env.set(node.left.name, r.value);
              return;
            }
          }
          scanNode(node.right, env, helpers);
          return;
        }

        case 'FunctionDeclaration':
          if (node.id?.name) helpers.set(node.id.name, node);
          // Do not eagerly walk uncalled helper definitions unless they aren't helpers (no params) or look like tests.
          if (!node.params?.length) {
            scanNode(node.body, new Map(env), new Map(helpers));
          }
          return;

        case 'ArrowFunctionExpression':
        case 'FunctionExpression':
          scanNode(node.body, new Map(env), new Map(helpers));
          return;

        case 'ForOfStatement': {
          const iterRes = evalStaticAst(node.right, env, ctx);
          if (iterRes.ok && Array.isArray(iterRes.value)) {
            const lhs = node.left?.type === 'VariableDeclaration' ? node.left.declarations[0]?.id : node.left;
            for (const item of iterRes.value.slice(0, 64)) {
              const loopEnv = new Map(env);
              if (lhs) bindPattern(lhs, item, loopEnv, ctx);
              scanNode(node.body, loopEnv, new Map(helpers));
            }
            return;
          }
          scanNode(node.right, env, helpers);
          scanNode(node.body, new Map(env), new Map(helpers));
          return;
        }

        case 'CallExpression': {
          // 1) test.each / it.each / describe.each
          if (isEachHelperCallee(node.callee)) {
            const tableRes = evalStaticAst(node.callee.arguments[0], env, ctx);
            const cb = node.arguments.find(a => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
            if (tableRes.ok && Array.isArray(tableRes.value) && cb) {
              for (const row of tableRes.value.slice(0, 64)) {
                const cbEnv = new Map(env);
                if (Array.isArray(row)) {
                  if (cb.params.length === 1) {
                    const p0 = cb.params[0];
                    if (p0?.type === 'ArrayPattern') {
                      bindPattern(p0, (row.length === 1 && Array.isArray(row[0])) ? row[0] : row, cbEnv, ctx);
                    } else if (p0?.type === 'ObjectPattern') {
                      bindPattern(p0, row.length === 1 ? row[0] : row, cbEnv, ctx);
                    } else if (p0) {
                      bindPattern(p0, row[0], cbEnv, ctx);
                    }
                  } else {
                    for (let i = 0; i < cb.params.length; i++) bindPattern(cb.params[i], row[i], cbEnv, ctx);
                  }
                } else if (cb.params.length > 0) {
                  bindPattern(cb.params[0], row, cbEnv, ctx);
                }
                scanNode(cb.body, cbEnv, new Map(helpers));
              }
              return;
            }
          }

          // 2) [...].forEach((...) => ...)
          if (node.callee.type === 'MemberExpression' && !node.callee.computed &&
              node.callee.property?.type === 'Identifier' && node.callee.property.name === 'forEach') {
            const arrRes = evalStaticAst(node.callee.object, env, ctx);
            const cb = node.arguments[0];
            if (arrRes.ok && Array.isArray(arrRes.value) && cb &&
                (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')) {
              const limitCount = Math.min(arrRes.value.length, 64);
              for (let i = 0; i < limitCount; i++) {
                const cbEnv = new Map(env);
                if (cb.params[0]) bindPattern(cb.params[0], arrRes.value[i], cbEnv, ctx);
                if (cb.params[1]) bindPattern(cb.params[1], i, cbEnv, ctx);
                if (cb.params[2]) bindPattern(cb.params[2], arrRes.value, cbEnv, ctx);
                scanNode(cb.body, cbEnv, new Map(helpers));
              }
              return;
            }
          }

          // 3) fn.apply(thisArg, argsArray) / fn.call(thisArg, ...args)
          if (node.callee.type === 'MemberExpression' && !node.callee.computed &&
              node.callee.property?.type === 'Identifier') {
            const method = node.callee.property.name;
            if (method === 'apply' && node.arguments.length >= 2) {
              const target = resolveTargetFnName(node.callee.object, exportSet, localAliases, aliasSet, namespaceAliases);
              if (target) {
                const arrRes = evalStaticAst(node.arguments[1], env, ctx);
                if (arrRes.ok && Array.isArray(arrRes.value)) recordCall(target, arrRes.value);
              }
            } else if (method === 'call' && node.arguments.length >= 2) {
              const target = resolveTargetFnName(node.callee.object, exportSet, localAliases, aliasSet, namespaceAliases);
              if (target) {
                const args = evalCallArguments(node.arguments.slice(1), env);
                if (args) recordCall(target, args);
              }
            }
          }

          // 4) Direct or module-member target call
          const fnName = resolveTargetFnName(node.callee, exportSet, localAliases, aliasSet, namespaceAliases);
          if (fnName) {
            const args = evalCallArguments(node.arguments, env);
            if (args) recordCall(fnName, args);
          } else if (node.callee.type === 'Identifier' && helpers.has(node.callee.name) &&
              !ASSERTION_HELPER_CALLS.has(node.callee.name) && ctx.helperDepth < 2 &&
              !ctx.activeHelpers.has(node.callee.name)) {
            // 5) Local test helper call inline expansion (depth-bounded)
            const helperNode = helpers.get(node.callee.name);
            const helperArgs = evalCallArguments(node.arguments, env);
            if (helperNode && helperArgs) {
              const helperEnv = new Map(env);
              for (let i = 0; i < (helperNode.params?.length ?? 0); i++) {
                bindPattern(helperNode.params[i], helperArgs[i], helperEnv, ctx);
              }
              ctx.helperDepth++;
              ctx.activeHelpers.add(node.callee.name);
              try {
                scanNode(helperNode.body, helperEnv, helpers);
              } finally {
                ctx.activeHelpers.delete(node.callee.name);
                ctx.helperDepth--;
              }
            }
          }

          // Always descend into callee (for chained expect(fn(...)).toEqual(...)) and arguments (for assert.*(fn(...), ...))
          scanNode(node.callee, env, helpers);
          for (const arg of node.arguments) scanNode(arg, env, helpers);
          return;
        }

        default: {
          for (const [k, val] of Object.entries(node)) {
            if (k === 'start' || k === 'end' || k === 'loc' || k === 'raw') continue;
            if (Array.isArray(val)) val.forEach(c => scanNode(c, env, helpers));
            else if (val && typeof val === 'object' && typeof val.type === 'string') scanNode(val, env, helpers);
          }
        }
      }
    }

    scanNode(ast, new Map(), new Map());
  }
  return byFn;
}

export function collectLocalRepoCandidates(rootDir, options = {}) {
  const effMaxPerFn = options.maxPerFn ?? maxPerFn;
  const effMaxPerRepo = options.maxPerRepo ?? maxPerRepo;
  const effMode = options.mode ?? harvestMode;
  const effPreferUnitTests = options.preferUnitTests ?? preferUnitTests;
  const effUnitTestsOnly = options.unitTestsOnly ?? unitTestsOnly;
  const effEnvDir = options.envDir ?? envDir;

  const candidates = [];
  const repoEntries = readdirSync(rootDir, {withFileTypes: true}).filter(d => {
    try {
      return d.isDirectory() || (d.isSymbolicLink() && statSync(join(rootDir, d.name)).isDirectory());
    } catch {
      return false;
    }
  }).sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of repoEntries) {
    const repoDir = join(rootDir, ent.name);
    const pkgPath = join(repoDir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkgJson;
    try { pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { continue; }
    const repoSlug = ent.name.replace(/__/g, '/');
    const repoMeta = {
      pkgDir: repoDir,
      pkgName: pkgJson.name || repoSlug,
      version: pkgJson.version ?? 'HEAD',
      license: typeof pkgJson.license === 'string' ? pkgJson.license : (pkgJson.license?.type ?? 'unknown'),
      repository: repoSlug,
      pkgJson,
    };
    const {code: codeFiles, tests: testFiles} = collectSourceAndTestFiles(repoDir);
    // Prioritize src/lib/index files and inspect up to 60 files so unit-tested modules aren't truncated early
    const rankedCode = [...codeFiles].sort((a, b) => {
      const score = f => {
        const r = relative(repoDir, f);
        if (/^(?:src\/|lib\/)?index\.[cm]?[jt]s$/.test(r)) return 0;
        if (/^(?:src|lib)\//.test(r)) return 1;
        return 2;
      };
      return score(a) - score(b) || a.localeCompare(b);
    }).slice(0, 60);

    const repoFnSeen = new Set();
    const shortName = (pkgJson.name || repoSlug.split('/').pop() || '').replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9_$]/g, '');
    const targets = [];

    for (const file of rankedCode) {
      const whole = bundleLocalFile(repoMeta, file, null);
      if (whole.error || whole.code.length > 90000) continue;
      let mod;
      try {
        const ctx = vm.createContext({});
        mod = new vm.Script(`(() => {\n${whole.code}\nreturn __harvestBox;\n})()`).runInContext(ctx, {timeout: 100});
      } catch { continue; }
      const isNonClassFn = fn => {
        if (typeof fn !== 'function') return false;
        try {
          return !/^class[\s{]/.test(Function.prototype.toString.call(fn));
        } catch {
          return true;
        }
      };
      const fnNames = [];
      try {
        if (isNonClassFn(mod)) fnNames.push('default');
        if (mod && typeof mod === 'object') {
          if (isNonClassFn(mod.default)) fnNames.push('default');
          for (const k of Object.keys(mod).sort()) {
            try {
              if (k !== 'default' && !k.startsWith('_') && isNonClassFn(mod[k])) fnNames.push(k);
            } catch {}
          }
        }
      } catch { continue; }
      const usableFns = fnNames.filter(n => !isSkippedProbeName(n, effMode) && !repoFnSeen.has(`${relative(repoDir, file)}#${n}`)).slice(0, 40);
      if (!usableFns.length) continue;

      const relFile = relative(repoDir, file);
      const testCalls = testFiles.length
        ? extractTestCallsFromFiles(repoDir, testFiles, usableFns, [shortName], {envDir: effEnvDir, targetFile: relFile, pkgName: repoMeta.pkgName})
        : new Map();
      for (const fnName of usableFns) {
        repoFnSeen.add(`${relative(repoDir, file)}#${fnName}`);
        const entries = [...(testCalls.get(fnName) ?? [])].sort((a, b2) => b2.sig.length - a.sig.length);
        if (effUnitTestsOnly && !entries.length) continue;
        targets.push({file, fnName, entries, kept: 0, seenOut: new Set(), bundle: null, bundleFailed: false});
      }
    }

    function getTargetBundle(target) {
      if (target.bundleFailed) return null;
      if (target.bundle) return target.bundle;
      const b = bundleLocalFile(repoMeta, target.file, target.fnName);
      if (b.error || b.code.length > 70000) {
        target.bundleFailed = true;
        return null;
      }
      target.bundle = b;
      return b;
    }

    let repoAdded = 0;

    function tryAddTargetCandidate(target, args, origin, testFile = null) {
      if (repoAdded >= effMaxPerRepo) return false;
      const b = getTargetBundle(target);
      if (!b) return false;
      let res;
      try {
        res = probeExportSafely(b, target.fnName, args, {mode: effMode});
      } catch {
        return false;
      }
      if (res.kind === 'promise') return false;
      let outKey;
      if (res.kind === 'throw') {
        if (origin !== 'dgx-oss-unit-test') return false;
        if (res.errorName === 'ReferenceError' && /\bis not defined\b/.test(res.errorMessage)) return false;
        if (res.errorName === 'TypeError' &&
            /cannot be invoked without 'new'|is not a constructor|Cannot read propert|Cannot set propert|Cannot destructure|is not a function/i.test(res.errorMessage)) {
          return false;
        }
        outKey = `throw:${res.errorName}:${res.errorMessage}`;
      } else {
        const v = res.value;
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return false;
        try {
          outKey = JSON.stringify(encodeReadable(v));
        } catch {
          return false;
        }
      }
      if (target.seenOut.has(outKey) && target.kept >= 1) return false;
      target.seenOut.add(outKey);
      candidates.push(buildDirectTask({
        bundle: b, fnName: target.fnName, args, index: target.kept++,
        origin, testFile, recordedCalls: res.recordedCalls, mode: effMode,
        extraFeatures: [
          'dgx-repo',
          ...(origin === 'dgx-oss-unit-test' ? ['unit-test-input'] : []),
          ...(res.recordedCalls.length ? ['external', 'platform'] : []),
        ],
      }));
      repoAdded++;
      return true;
    }

    if (effPreferUnitTests || effUnitTestsOnly) {
      // Pass 1: schedule all real unit-test inputs ahead of synthetic probes across the whole repo
      const unitTargets = targets.filter(t => t.entries.length > 0).map(t => ({target: t, cursor: 0}));
      let madeProgress = true;
      while (madeProgress && repoAdded < effMaxPerRepo) {
        madeProgress = false;
        for (const state of unitTargets) {
          if (repoAdded >= effMaxPerRepo) break;
          if (state.target.kept >= effMaxPerFn) continue;
          while (state.cursor < state.target.entries.length) {
            const entry = state.target.entries[state.cursor++];
            if (tryAddTargetCandidate(state.target, entry.args, 'dgx-oss-unit-test', entry.file)) {
              madeProgress = true;
              break;
            }
          }
        }
      }
      // Pass 2: fallback synthetic probes only if unit tests didn't saturate maxPerRepo
      if (!effUnitTestsOnly && repoAdded < effMaxPerRepo) {
        const synthCap = Math.min(2, effMaxPerFn);
        for (const target of targets) {
          if (repoAdded >= effMaxPerRepo) break;
          if (target.kept >= synthCap) continue;
          for (const sampleArgs of TYPED_INPUT_BANK) {
            if (target.kept >= synthCap || repoAdded >= effMaxPerRepo) break;
            tryAddTargetCandidate(target, sampleArgs, 'dgx-oss-repo', null);
          }
        }
      }
    } else {
      // Non-prioritized interleaved mode (--no-prefer-unit-tests): synthetic probes then unit tests per function
      const synthCap = Math.min(2, effMaxPerFn);
      for (const target of targets) {
        if (repoAdded >= effMaxPerRepo) break;
        for (const sampleArgs of TYPED_INPUT_BANK) {
          if (target.kept >= synthCap || repoAdded >= effMaxPerRepo) break;
          tryAddTargetCandidate(target, sampleArgs, 'dgx-oss-repo', null);
        }
        for (const entry of target.entries) {
          if (target.kept >= effMaxPerFn || repoAdded >= effMaxPerRepo) break;
          tryAddTargetCandidate(target, entry.args, 'dgx-oss-unit-test', entry.file);
        }
      }
    }

    if (repoAdded > 0) {
      process.stderr.write(`harvest-local: ${repoSlug}: ${repoAdded} calls (tests=${testFiles.length}, code=${codeFiles.length})\n`);
    }
  }
  return candidates;
}

export async function collectLocalAsyncFetchCandidates(rootDir, options = {}) {
  const effMaxPerFn = options.maxPerFn ?? maxPerFn;
  const effMaxPerRepo = options.maxPerRepo ?? maxPerRepo;
  const effMode = options.mode ?? harvestMode;
  const effEnvDir = options.envDir ?? envDir;
  const effTimeoutMs = options.timeoutMs ?? 4000;
  if (effMode !== 'native') return [];

  const candidates = [];
  const repoEntries = readdirSync(rootDir, {withFileTypes: true}).filter(d => {
    try {
      return d.isDirectory() || (d.isSymbolicLink() && statSync(join(rootDir, d.name)).isDirectory());
    } catch {
      return false;
    }
  }).sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of repoEntries) {
    const repoDir = join(rootDir, ent.name);
    const pkgPath = join(repoDir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkgJson;
    try { pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { continue; }
    const repoSlug = ent.name.replace(/__/g, '/');
    const repoMeta = {
      pkgDir: repoDir,
      pkgName: pkgJson.name || repoSlug,
      version: pkgJson.version ?? 'HEAD',
      license: typeof pkgJson.license === 'string' ? pkgJson.license : (pkgJson.license?.type ?? 'unknown'),
      repository: repoSlug,
      pkgJson,
    };
    const {code: codeFiles, tests: testFiles} = collectSourceAndTestFiles(repoDir);
    if (!testFiles.length) continue;
    const shortName = (pkgJson.name || repoSlug.split('/').pop() || '').replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9_$]/g, '');
    let repoAdded = 0;

    for (const file of codeFiles) {
      if (repoAdded >= effMaxPerRepo) break;
      const whole = bundleLocalFile(repoMeta, file, null);
      if (whole.error || whole.code.length > 90000 || !/\bfetch\b/.test(whole.code)) continue;
      let mod;
      try {
        const ctx = vm.createContext({});
        mod = new vm.Script(`(() => {\n${whole.code}\nreturn __harvestBox;\n})()`).runInContext(ctx, {timeout: 100});
      } catch { continue; }
      const fnNames = [];
      try {
        if (typeof mod === 'function') fnNames.push('default');
        if (mod && typeof mod === 'object') {
          if (typeof mod.default === 'function') fnNames.push('default');
          for (const k of Object.keys(mod).sort()) {
            try { if (k !== 'default' && !k.startsWith('_') && typeof mod[k] === 'function') fnNames.push(k); } catch {}
          }
        }
      } catch { continue; }
      if (!fnNames.length) continue;
      const relFile = relative(repoDir, file);
      const testCalls = extractTestCallsFromFiles(repoDir, testFiles, fnNames, [shortName], {envDir: effEnvDir, targetFile: relFile, pkgName: repoMeta.pkgName});
      for (const fnName of fnNames) {
        if (repoAdded >= effMaxPerRepo) break;
        const entries = testCalls.get(fnName) ?? [];
        if (!entries.length) continue;
        const b = bundleLocalFile(repoMeta, file, fnName);
        if (b.error || b.code.length > 70000 || !sourceUsesGlobalFetch(b.code)) continue;
        let kept = 0;
        const seenOut = new Set();
        for (const entry of entries) {
          if (kept >= effMaxPerFn || repoAdded >= effMaxPerRepo) break;
          let res;
          try {
            res = await probeExportSafelyAsync(b, fnName, entry.args, {mode: 'native', timeoutMs: effTimeoutMs});
          } catch { continue; }
          if (!res.recordedCalls.some(c => c.operation === 'http.request')) continue;
          let outKey;
          if (res.kind === 'throw') {
            if (res.errorName === 'ReferenceError' && /\bis not defined\b/.test(res.errorMessage)) continue;
            outKey = `throw:${res.errorName}:${res.errorMessage}`;
          } else {
            if (res.value === undefined || typeof res.value === 'function' || typeof res.value === 'symbol') continue;
            try { outKey = JSON.stringify(encodeReadable(res.value)); } catch { continue; }
          }
          if (seenOut.has(outKey) && kept >= 1) continue;
          seenOut.add(outKey);
          candidates.push(buildDirectTask({
            bundle: b, fnName, args: entry.args, index: kept++,
            origin: 'dgx-oss-unit-test', testFile: entry.file, recordedCalls: res.recordedCalls, mode: 'native',
            isAsync: true,
            extraFeatures: ['dgx-repo', 'unit-test-input', 'external', 'http', 'http.request'],
          }));
          repoAdded++;
        }
      }
    }
  }
  return candidates;
}

// --- 2. Extract static JS literal calls from real OSS GitHub test suites ---
export function evalStaticAst(node, env = null, ctx = null, depth = 0) {
  if (!node || depth > 20) return {ok: false};
  if (node.type === 'Literal') {
    if (node.regex || node.bigint) return {ok: false};
    return {ok: true, value: node.value};
  }
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return {ok: true, value: undefined};
    if (node.name === 'NaN') return {ok: true, value: NaN};
    if (node.name === 'Infinity') return {ok: true, value: Infinity};
    if (env && env.has(node.name)) {
      const val = env.get(node.name);
      return {ok: true, value: val === undefined ? undefined : structuredClone(val)};
    }
    return {ok: false};
  }
  if (node.type === 'UnaryExpression') {
    if (node.operator === 'void') {
      evalStaticAst(node.argument, env, ctx, depth + 1);
      return {ok: true, value: undefined};
    }
    if (node.operator === 'typeof') {
      const inner = evalStaticAst(node.argument, env, ctx, depth + 1);
      if (!inner.ok) return {ok: false};
      return {ok: true, value: typeof inner.value};
    }
    if (['-', '+', '!'].includes(node.operator)) {
      const inner = evalStaticAst(node.argument, env, ctx, depth + 1);
      if (!inner.ok) return {ok: false};
      const v = node.operator === '-' ? -inner.value : node.operator === '+' ? +inner.value : !inner.value;
      return {ok: true, value: v};
    }
    return {ok: false};
  }
  if (node.type === 'TemplateLiteral') {
    let str = node.quasis[0]?.value?.cooked ?? '';
    for (let i = 0; i < node.expressions.length; i++) {
      const r = evalStaticAst(node.expressions[i], env, ctx, depth + 1);
      if (!r.ok) return {ok: false};
      if (r.value !== null && typeof r.value === 'object') return {ok: false};
      str += String(r.value) + (node.quasis[i + 1]?.value?.cooked ?? '');
    }
    return {ok: true, value: str};
  }
  if (node.type === 'ArrayExpression') {
    const out = [];
    for (const el of node.elements) {
      if (!el) return {ok: false};
      if (el.type === 'SpreadElement') {
        const r = evalStaticAst(el.argument, env, ctx, depth + 1);
        if (!r.ok || !Array.isArray(r.value) || out.length + r.value.length > 256) return {ok: false};
        out.push(...r.value);
      } else {
        const r = evalStaticAst(el, env, ctx, depth + 1);
        if (!r.ok) return {ok: false};
        out.push(r.value);
      }
      if (out.length > 256) return {ok: false};
    }
    return {ok: true, value: out};
  }
  if (node.type === 'ObjectExpression') {
    const out = {};
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') {
        const r = evalStaticAst(prop.argument, env, ctx, depth + 1);
        if (!r.ok || r.value === null || typeof r.value !== 'object' || Array.isArray(r.value)) return {ok: false};
        for (const [k, v] of Object.entries(r.value)) {
          if (k !== '__proto__') out[k] = v;
        }
        continue;
      }
      if (prop.type !== 'Property' || prop.kind !== 'init') return {ok: false};
      let k = null;
      if (!prop.computed) {
        k = prop.key.type === 'Identifier' ? prop.key.name : (prop.key.type === 'Literal' ? String(prop.key.value) : null);
      } else {
        const kr = evalStaticAst(prop.key, env, ctx, depth + 1);
        if (kr.ok && (typeof kr.value === 'string' || typeof kr.value === 'number')) k = String(kr.value);
      }
      if (k === null || k === '__proto__') return {ok: false};
      const r = evalStaticAst(prop.value, env, ctx, depth + 1);
      if (!r.ok) return {ok: false};
      out[k] = r.value;
    }
    return {ok: true, value: out};
  }
  if (node.type === 'MemberExpression' && !node.optional) {
    const obj = evalStaticAst(node.object, env, ctx, depth + 1);
    if (!obj.ok) return {ok: false};
    let key = null;
    if (!node.computed && node.property.type === 'Identifier') {
      key = node.property.name;
    } else {
      const kr = evalStaticAst(node.property, env, ctx, depth + 1);
      if (!kr.ok || (typeof kr.value !== 'string' && typeof kr.value !== 'number')) return {ok: false};
      key = String(kr.value);
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return {ok: false};
    if (typeof obj.value === 'string' && key === 'length') return {ok: true, value: obj.value.length};
    if (obj.value !== null && typeof obj.value === 'object') {
      if (Array.isArray(obj.value) && key === 'length') return {ok: true, value: obj.value.length};
      if (Object.hasOwn(obj.value, key)) {
        const v = obj.value[key];
        return {ok: true, value: v === undefined ? undefined : structuredClone(v)};
      }
    }
    return {ok: false};
  }
  if (node.type === 'BinaryExpression') {
    const l = evalStaticAst(node.left, env, ctx, depth + 1);
    const r = evalStaticAst(node.right, env, ctx, depth + 1);
    if (!l.ok || !r.ok) return {ok: false};
    const a = l.value, b = r.value;
    const isPrim = v => v === null || ['undefined', 'boolean', 'number', 'string'].includes(typeof v);
    if (!isPrim(a) || !isPrim(b)) return {ok: false};
    switch (node.operator) {
      case '+': return (typeof a === 'string' || typeof a === 'number') && (typeof b === 'string' || typeof b === 'number') ? {ok: true, value: a + b} : {ok: false};
      case '-': return typeof a === 'number' && typeof b === 'number' ? {ok: true, value: a - b} : {ok: false};
      case '*': return typeof a === 'number' && typeof b === 'number' ? {ok: true, value: a * b} : {ok: false};
      case '/': return typeof a === 'number' && typeof b === 'number' ? {ok: true, value: a / b} : {ok: false};
      case '%': return typeof a === 'number' && typeof b === 'number' ? {ok: true, value: a % b} : {ok: false};
      case '===': return {ok: true, value: a === b};
      case '!==': return {ok: true, value: a !== b};
      case '==': return {ok: true, value: a == b};
      case '!=': return {ok: true, value: a != b};
      case '<': return {ok: true, value: a < b};
      case '<=': return {ok: true, value: a <= b};
      case '>': return {ok: true, value: a > b};
      case '>=': return {ok: true, value: a >= b};
      default: return {ok: false};
    }
  }
  if (node.type === 'LogicalExpression') {
    const l = evalStaticAst(node.left, env, ctx, depth + 1);
    if (!l.ok) return {ok: false};
    if (node.operator === '&&') return l.value ? evalStaticAst(node.right, env, ctx, depth + 1) : l;
    if (node.operator === '||') return l.value ? l : evalStaticAst(node.right, env, ctx, depth + 1);
    if (node.operator === '??') return (l.value !== null && l.value !== undefined) ? l : evalStaticAst(node.right, env, ctx, depth + 1);
    return {ok: false};
  }
  if (node.type === 'ConditionalExpression') {
    const t = evalStaticAst(node.test, env, ctx, depth + 1);
    if (!t.ok) return {ok: false};
    return evalStaticAst(t.value ? node.consequent : node.alternate, env, ctx, depth + 1);
  }
  if (node.type === 'CallExpression') {
    if (ctx?.repoDir && ctx?.fileDir && node.callee?.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) {
      const arg = evalStaticAst(node.arguments[0], env, ctx, depth + 1);
      if (arg.ok && typeof arg.value === 'string') return loadLocalJsonFixture(ctx.repoDir, ctx.fileDir, arg.value);
    }
    if (node.callee?.type === 'MemberExpression' && !node.callee.computed && node.callee.property?.type === 'Identifier') {
      const prop = node.callee.property.name;
      if (node.callee.object?.type === 'Identifier') {
        const objName = node.callee.object.name;
        if (objName === 'JSON' && prop === 'parse' && node.arguments.length === 1) {
          const arg = evalStaticAst(node.arguments[0], env, ctx, depth + 1);
          if (arg.ok && typeof arg.value === 'string') {
            try { return {ok: true, value: JSON.parse(arg.value)}; } catch { return {ok: false}; }
          }
        }
        if (objName === 'Object' && ['keys', 'values', 'entries'].includes(prop) && node.arguments.length === 1) {
          const arg = evalStaticAst(node.arguments[0], env, ctx, depth + 1);
          if (arg.ok && arg.value !== null && typeof arg.value === 'object') {
            return {ok: true, value: Object[prop](arg.value)};
          }
        }
      }
      const recv = evalStaticAst(node.callee.object, env, ctx, depth + 1);
      if (recv.ok && typeof recv.value === 'string' && prop === 'repeat' && node.arguments.length === 1) {
        const cnt = evalStaticAst(node.arguments[0], env, ctx, depth + 1);
        if (cnt.ok && Number.isInteger(cnt.value) && cnt.value >= 0 && cnt.value <= 128 && recv.value.length * cnt.value <= 1024) {
          return {ok: true, value: recv.value.repeat(cnt.value)};
        }
      }
      if (recv.ok && Array.isArray(recv.value) && prop === 'concat') {
        const rest = [];
        for (const a of node.arguments) {
          const ar = evalStaticAst(a, env, ctx, depth + 1);
          if (!ar.ok) return {ok: false};
          rest.push(ar.value);
        }
        return {ok: true, value: recv.value.concat(...rest)};
      }
      if (recv.ok && Array.isArray(recv.value) && prop === 'slice') {
        const sArgs = [];
        for (const a of node.arguments) {
          const ar = evalStaticAst(a, env, ctx, depth + 1);
          if (!ar.ok || typeof ar.value !== 'number') return {ok: false};
          sArgs.push(ar.value);
        }
        return {ok: true, value: recv.value.slice(...sArgs)};
      }
    }
  }
  return {ok: false};
}

function collectJsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(p, out);
    else if (/\.(?:c|m)?[jt]s$/i.test(entry.name) && !entry.name.endsWith('.d.ts') && statSync(p).size < 512 * 1024) out.push(p);
  }
  return out;
}

function harvestTestCallsFromRepo(repoUrl, slug, exportNames, aliases = []) {
  const dir = join(reposDir, slug);
  if (!existsSync(dir)) {
    try {
      execFileSync('git', ['clone', '--depth', '1', '--quiet', repoUrl, dir], {timeout: 30000, stdio: 'pipe'});
    } catch {
      return new Map();
    }
  }
  const testDirs = ['test', 'tests', '__tests__', 'spec'].map(d => join(dir, d)).filter(existsSync);
  const files = testDirs.length ? testDirs.flatMap(d => collectJsFiles(d)) : collectJsFiles(dir).filter(f => /test|spec/i.test(f));
  return extractTestCallsFromFiles(dir, files, exportNames, [slug, ...aliases], {maxCallsPerFn: 40});
}

// --- 3. Build runnable task around a tree-shaken real OSS bundle ---
function buildDirectTask({bundle, fnName, args, index, origin, testFile = null, recordedCalls = [], extraFeatures = [], mode = harvestMode, isAsync = false}) {
  const params = args.map((_, i) => 'a' + i).join(', ');
  const runPrefix = isAsync ? 'async function run' : 'function run';
  const callPrefix = isAsync ? 'await ' : '';
  let source;
  if (bundle.directTarget) {
    source = `"use strict";\nfunction __loadMod() {\nlet __harvestTarget;\n${bundle.code}\nreturn __harvestTarget;\n}\n${runPrefix}(${params}) {\n  const __fn = __loadMod();\n  return ${callPrefix}__fn(${params});\n}\n`;
  } else {
    const access = !bundle.wholeModule
      ? '(__box.default ?? __box)'
      : (fnName === 'default'
        ? '(typeof __box === "function" ? __box : (__box.default ?? __box))'
        : `(__box[${JSON.stringify(fnName)}] ?? __box.default?.[${JSON.stringify(fnName)}])`);
    source = `"use strict";\nfunction __loadMod() {\n${bundle.code}\nreturn __harvestBox;\n}\n${runPrefix}(${params}) {\n  const __box = __loadMod();\n  return ${callPrefix}${access}(${params});\n}\n`;
  }
  const family = `oss:${bundle.pkgName}/${bundle.subpath}#${fnName}`;
  const id = `oss-${bundle.pkgName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${fnName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${index}-${sha256([family, args, recordedCalls]).slice(0, 8)}`;
  const usesToolRandom = mode === 'native' && (recordedCalls.some(c => c.operation === 'platform.random') || /\bMath\.random\b/.test(source));
  return {
    id, family, source, entry: 'run', args: encodeReadable(args),
    ...(mode === 'native' ? {executionMode: 'native'} : {}),
    ...(usesToolRandom ? {randomMode: 'tool'} : {}),
    fixture: {calls: recordedCalls}, randomSeed: 17, maxSteps: 100000, timeoutMs: 10000,
    metadata: {
      sourceOrigin: origin,
      executionMode: mode,
      package: bundle.pkgName,
      version: bundle.version,
      license: bundle.license,
      repository: bundle.repository,
      upstreamSymbol: fnName,
      testFile,
      tier: recordedCalls.length ? 5 : 4,
      template: family,
      lineage: [family, `oss-pkg:${bundle.pkgName}:${bundle.subpath}#${fnName}`],
      features: [...new Set(['real-oss', ...(mode === 'native' ? ['native-v8'] : []), ...extraFeatures])],
      inputVariant: index,
      evaluationRole: 'generalization',
      agentTaskSuccessVerified: false,
    },
  };
}

// --- 4. Real messy side-effectful OSS drivers (natively recording exact tool calls) ---
async function buildRecordedEffectfulTask({pkgName, exportName = null, subpath = null, driverName, driverCode, args, nativeBindings = [], toolImpls = {}, index, features = []}) {
  const bundle = exportName ? bundleExport(pkgName, exportName, subpath) : bundleWholeEntry(pkgName, subpath);
  if (bundle.error) return null;
  const wrappedDriver = driverCode.replace(/\{/, '{\n  const __harvestMod = __loadMod();');
  const source = bundle.directTarget
    ? `"use strict";\nfunction __loadMod() {\nlet __harvestTarget;\n${bundle.code}\nreturn __harvestTarget;\n}\n${wrappedDriver}\n`
    : `"use strict";\nfunction __loadMod() {\n${bundle.code}\nreturn __harvestBox;\n}\n${wrappedDriver}\n`;
  const recordedCalls = [];
  const env = {};
  for (const b of nativeBindings) {
    const impl = toolImpls[b.name];
    env[b.name] = (...callArgs) => {
      const clonedArgs = structuredClone(callArgs);
      if (b.kind === 'promise') {
        return Promise.resolve().then(() => impl(...clonedArgs)).then(
          res => {
            recordedCalls.push({operation: 'natlang.call', arguments: [b.name, {$js: 'undefined'}, encodeReadable(clonedArgs)], status: 'fulfilled', result: encodeReadable(res)});
            return structuredClone(res);
          },
          err => {
            const val = typeof err === 'string' ? err : (err?.message ?? String(err));
            recordedCalls.push({operation: 'natlang.call', arguments: [b.name, {$js: 'undefined'}, encodeReadable(clonedArgs)], status: 'rejected', result: encodeReadable(val)});
            throw val;
          },
        );
      }
      try {
        const res = impl(...clonedArgs);
        recordedCalls.push({operation: 'natlang.callSync', arguments: [b.name, {$js: 'undefined'}, encodeReadable(clonedArgs)], status: 'fulfilled', result: encodeReadable(res)});
        return structuredClone(res);
      } catch (err) {
        const val = typeof err === 'string' ? err : (err?.message ?? String(err));
        recordedCalls.push({operation: 'natlang.callSync', arguments: [b.name, {$js: 'undefined'}, encodeReadable(clonedArgs)], status: 'rejected', result: encodeReadable(val)});
        throw val;
      }
    };
  }
  let clockIdx = 0;
  const clocks = toolImpls.__clocks ?? [1700000100, 1700000125, 1700000160, 1700000210, 1700000300];
  const fakeDate = {
    now: () => {
      const v = clocks[clockIdx++ % clocks.length];
      recordedCalls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: v});
      return v;
    },
  };
  const fakeConsole = Object.fromEntries(['log', 'info', 'warn', 'error'].map(lvl => [lvl, msg => {
    recordedCalls.push({operation: 'platform.console.' + lvl, arguments: [encodeReadable(msg)], status: 'fulfilled', result: {$js: 'undefined'}});
  }]));
  const fakeHost = {
    readText: async p => {
      const res = toolImpls.readText(p);
      recordedCalls.push({operation: 'fs.readText', arguments: [p], status: res.rejected ? 'rejected' : 'fulfilled', result: encodeReadable(res.value)});
      if (res.rejected) throw res.value;
      return res.value;
    },
    writeText: async (p, text) => {
      recordedCalls.push({operation: 'fs.writeText', arguments: [p, text], status: 'fulfilled', result: {$js: 'undefined'}});
    },
    store: (k, v) => {
      recordedCalls.push({operation: 'demo.store', arguments: [k, encodeReadable(v)], status: 'fulfilled', result: {$js: 'undefined'}});
    },
    readAsync: async k => {
      const res = toolImpls.readAsync(k);
      recordedCalls.push({operation: 'demo.readAsync', arguments: [k], status: res.rejected ? 'rejected' : 'fulfilled', result: encodeReadable(res.value)});
      if (res.rejected) throw res.value;
      return res.value;
    },
    httpGet: async url => {
      const res = toolImpls.httpGet(url);
      recordedCalls.push({operation: 'http.get', arguments: [url], status: res.rejected ? 'rejected' : 'fulfilled', result: encodeReadable(res.value)});
      if (res.rejected) throw res.value;
      return res.value;
    },
  };
  try {
    const paramNames = ['host', 'console', 'Date', ...nativeBindings.map(b => b.name)];
    const fn = new Function(...paramNames, `${source}\nreturn run;`);
    const runFn = fn(fakeHost, fakeConsole, fakeDate, ...nativeBindings.map(b => env[b.name]));
    await runFn(...structuredClone(args));
  } catch {
    // Throwing executions are valid JS completions too.
  }
  const family = `oss-effectful:${pkgName}/${driverName}`;
  const id = `oss-eff-${pkgName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${driverName}-${index}-${sha256([family, args, recordedCalls]).slice(0, 8)}`;
  return {
    id, family, source, entry: 'run', args: encodeReadable(args),
    ...(harvestMode === 'native' ? {executionMode: 'native'} : {}),
    nativeBindings,
    fixture: {calls: recordedCalls}, randomSeed: 17, maxSteps: 100000, timeoutMs: 10000,
    metadata: {
      sourceOrigin: 'oss-effectful',
      executionMode: harvestMode,
      package: pkgName,
      version: bundle.version,
      license: bundle.license,
      repository: bundle.repository,
      upstreamSymbol: driverName,
      tier: 5,
      template: family,
      lineage: [family, `oss-eff-pkg:${pkgName}#${driverName}`],
      features: [...new Set(['real-oss', 'external', 'sequential', ...(harvestMode === 'native' ? ['native-v8'] : []), ...features])],
      inputVariant: index,
      evaluationRole: 'generalization',
      agentTaskSuccessVerified: false,
    },
  };
}

// --- 5. Domain-typed input bank for automatic export probing ---
export const TYPED_INPUT_BANK = [
  // Mixed negative/float/zero/duplicate numeric arrays
  [[0, -3.5, 12, 0, -3.5, 42.25, -0.5, 7]],
  [[-10, 0, 10, -10, 3.14, 0, 99, -1]],
  [[3, 1, 4, 1, 5, 9, 2, 6]],
  [[0, -1, 2.5, 2.5, -0.25, 8], 3],
  [[10, -2, 0, 10, 4, 7], 2],
  [[1, 2, 3, 4], [3, 4, 5, 6, 0, -1]],
  [[10, 20, 30], [1, 2, 3]],
  // Nested & heterogeneous arrays
  [[[1, [2, [3, -4.5]], 0, [5, [6]]]]],
  [[['alpha', 0], ['beta-1', -2.5], ['gamma_ü', 3], ['alpha', 0]]],
  [[[1, 2], [3, 4], [5, 6]]],
  // Multi-key record arrays (with null/empty/unicode fields)
  [[{id: 1, tag: 'x-1', val: 10.5, active: true}, {id: 2, tag: 'y_2', val: -3, active: false}, {id: 3, tag: 'x-1', val: 0, active: true}, {id: 4, tag: '', val: null, active: true}]],
  [[{name: 'café', score: 2.5, role: 'admin'}, {name: 'alpha', score: -1, role: 'user'}, {name: 'delta', score: 2.5, role: 'admin'}], 'score'],
  // Nested objects with null, empty, unicode, boolean, numeric, and array fields
  [{id: 'usr_01', title: 'Café & Crème — v2', empty: '', nil: null, zero: 0, flag: false, tags: ['core', 'edge-case', ''], meta: {retries: 2, ratio: 0.75, nested: {ok: true, note: 'line1\nline2'}}}],
  [{a: 1, b: {c: 0, d: ['', 'x', null], e: {deep: -4.5}}, f: 'héllo', g: null, h: false}],
  [{user: {name: 'Alice', roles: ['admin', 'ops'], prefs: {theme: 'dark', pageSize: 25}}, count: 0, active: false}, ['user', 'active']],
  [{a: 1, b: 2, c: 3, d: 4}, ['a', 'c']],
  [{a: 1, b: {x: 1, y: 2, z: null}, items: ['p', 'q']}, {b: {y: 9, w: '', extra: false}, c: 4, items: ['r']}],
  [{a: 1, b: 2, c: {d: 3}}, {a: 1, b: 9, c: {d: 3, e: 4}}],
  [{cfg: {host: 'api.example.com', port: 8443, tls: {enabled: true, alpn: ['h2', 'http/1.1']}}}, 'cfg.tls.alpn'],
  [{a: {b: 1, c: ''}}, 'a.b.c', 99],
  [{a: {b: 1}}, 'a.c', 7],
  // Gnarly punctuation/whitespace/multiline/unicode strings
  ['  --hello_world.v2 (draft)!\n\tsecond line: café / naïve  '],
  ['foo--bar__baz.qux/123?a=1&b=two%20three#frag'],
  ['# Heading\n\n- item *one* & `two`\n- [x] done — café\n'],
  ['<div class="box" data-id="42">Hello, <b>world</b>!</div>'],
  ['M 10,20 L 30.5 -40.25 C 1,2 3,4 5,6 Z'],
  ['helloWorldFooBar_v2'],
  ['kitten-v1', 'sitting-v2'],
  ['1.2.3-beta.1+build.9', '1.10.0'],
  ['  line one,\nline two; line three!  ', 16],
  ['/api/v2/users//42?sort=-created_at&limit=10', '/'],
  // Numbers & ranges (negative, float, zero)
  [-12.5, 7],
  [42, 7],
  [0, 10, 2],
  [5, 0, 3],
  [-5, 0, 10],
  [3, 8],
  [[255, 128, 64]],
  [[120, 50, 50]],
];

// --- 6. Multi-export modern ESM libraries (each export tree-shaken cleanly!) ---
const ESM_LIBRARY_PACKAGES = [
  'es-toolkit',
  'radash',
  'radashi',
  'rambda',
  'simple-statistics',
  'd3-array',
  'd3-color',
  'd3-interpolate',
  'd3-scale',
  'd3-hierarchy',
  'defu',
  'pathe',
  'ufo',
  'scule',
  'ohash',
  'destr',
  'mri',
  'compare-versions',
  'fastest-levenshtein',
  'dequal',
  'fast-deep-equal',
  'klona',
  'dlv',
  'dset',
  'dot-prop',
  'object-path',
  'json-pointer',
  'fast-json-patch',
  'diff',
  'just-diff',
  'just-diff-apply',
  'just-clone',
  'just-flatten-it',
  'just-group-by',
  'just-merge',
  'just-pick',
  'just-omit',
  'just-kebab-case',
  'just-camel-case',
  'just-truncate',
  'just-zip-it',
  'just-unique',
  'deepmerge',
  'change-case',
  'semver',
  'ini',
  'qs',
  'minimatch',
  'marked',
  'js-yaml',
  'bytes',
  'flat',
];

const REPO_TEST_HARVEST_SPECS = [
  {pkg: 'compare-versions', repo: 'https://github.com/omichelsen/compare-versions.git', exports: ['compareVersions', 'compare', 'satisfies', 'validate', 'validateStrict']},
  {pkg: 'deepmerge', repo: 'https://github.com/TehShrike/deepmerge.git', exports: ['default', 'all'], aliases: ['merge', 'deepmerge']},
  {pkg: 'dset', repo: 'https://github.com/lukeed/dset.git', exports: ['dset', 'default'], aliases: ['dset']},
  {pkg: 'dlv', repo: 'https://github.com/developit/dlv.git', exports: ['default'], aliases: ['dlv']},
  {pkg: 'klona', repo: 'https://github.com/lukeed/klona.git', exports: ['klona']},
  {pkg: 'dequal', repo: 'https://github.com/lukeed/dequal.git', exports: ['dequal']},
  {pkg: 'ini', repo: 'https://github.com/npm/ini.git', exports: ['parse', 'stringify', 'decode', 'encode', 'safe', 'unsafe']},
  {pkg: 'bytes', repo: 'https://github.com/visionmedia/bytes.js.git', exports: ['parse', 'format', 'default'], aliases: ['bytes']},
  {pkg: 'flat', repo: 'https://github.com/hughsk/flat.git', exports: ['flatten', 'unflatten', 'default'], aliases: ['flatten', 'flat']},
];

// --- 7. Real messy side-effectful OSS workflows (12 real npm packages!) ---
async function collectEffectfulOssCandidates() {
  const out = [];

  // 7a. p-reduce, p-waterfall, p-series, p-times, p-pipe, p-whilst, p-forever, p-reflect (all real async OSS orchestrators!)
  for (let i = 0; i < 6; i++) {
    const items = [[2, 5, 8], [1, 4, 7, 10], [3, 6], [9, 2, 11, 4], [5], [10, 20, 30]][i];

    const tReduce = await buildRecordedEffectfulTask({
      pkgName: 'p-reduce', exportName: 'default', driverName: 'reduce-via-tool', index: i,
      nativeBindings: [{name: 'score_step', kind: 'promise', description: 'Compute next score given accumulator and item'}],
      driverCode: `async function run(items, init) {
  const pReduce = __harvestMod.default ?? __harvestMod;
  return await pReduce(items, async (acc, item) => await score_step(acc, item), init);
}`,
      args: [items, i * 2],
      toolImpls: {score_step: (acc, x) => acc + x * 2},
      features: ['promise', 'loop'],
    });
    if (tReduce) out.push(tReduce);

    const tWaterfall = await buildRecordedEffectfulTask({
      pkgName: 'p-waterfall', exportName: 'default', driverName: 'waterfall-pipeline', index: i,
      nativeBindings: [
        {name: 'fetch_seed', kind: 'promise', description: 'Load initial numeric seed for key'},
        {name: 'transform_val', kind: 'promise', description: 'Transform intermediate value with named stage'},
        {name: 'persist_val', kind: 'promise', description: 'Persist final computed result'},
      ],
      driverCode: `async function run(key, bonus) {
  const pWaterfall = __harvestMod.default ?? __harvestMod;
  return await pWaterfall([
    async () => await fetch_seed(key),
    async (v) => await transform_val('scale', v + bonus),
    async (v) => await persist_val(key, v),
  ]);
}`,
      args: ['k' + i, i + 1],
      toolImpls: {
        fetch_seed: k => (k.charCodeAt(1) - 47) * 5,
        transform_val: (_stage, v) => v * 3 - 1,
        persist_val: (k, v) => ({key: k, stored: v}),
      },
      features: ['promise', 'pipeline'],
    });
    if (tWaterfall) out.push(tWaterfall);

    const tSeries = await buildRecordedEffectfulTask({
      pkgName: 'p-series', exportName: 'default', driverName: 'series-jobs', index: i,
      nativeBindings: [{name: 'exec_job', kind: 'promise', description: 'Execute one named sequential job'}],
      driverCode: `async function run(names) {
  const pSeries = __harvestMod.default ?? __harvestMod;
  const tasks = names.map(name => async () => await exec_job(name));
  return await pSeries(tasks);
}`,
      args: [items.map(n => 'job-' + n)],
      toolImpls: {exec_job: name => 'done:' + name},
      features: ['promise', 'loop'],
    });
    if (tSeries) out.push(tSeries);

    const tTimes = await buildRecordedEffectfulTask({
      pkgName: 'p-times', exportName: 'default', driverName: 'times-batch', index: i,
      nativeBindings: [{name: 'poll_slot', kind: 'promise', description: 'Poll one indexed worker slot'}],
      driverCode: `async function run(count, prefix) {
  const pTimes = __harvestMod.default ?? __harvestMod;
  return await pTimes(count, async (idx) => await poll_slot(prefix, idx), {concurrency: 1});
}`,
      args: [(i % 4) + 2, 's' + i],
      toolImpls: {poll_slot: (p, idx) => p + '#' + (idx * 10 + 1)},
      features: ['promise', 'loop'],
    });
    if (tTimes) out.push(tTimes);

    const tPipe = await buildRecordedEffectfulTask({
      pkgName: 'p-pipe', exportName: 'default', driverName: 'pipe-stages', index: i,
      nativeBindings: [
        {name: 'lookup_rate', kind: 'promise', description: 'Fetch multiplier rate for currency'},
        {name: 'apply_fee', kind: 'promise', description: 'Apply fee policy to converted amount'},
      ],
      driverCode: `async function run(amount, currency) {
  const pPipe = __harvestMod.default ?? __harvestMod;
  const pipeline = pPipe(
    async (amt) => amt * (await lookup_rate(currency)),
    async (converted) => await apply_fee(currency, converted),
    (finalAmt) => ({currency, total: finalAmt}),
  );
  return await pipeline(amount);
}`,
      args: [(i + 1) * 10, ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'][i]],
      toolImpls: {
        lookup_rate: c => ({USD: 1, EUR: 2, GBP: 3, JPY: 4, CAD: 2, AUD: 3})[c],
        apply_fee: (_c, v) => v + 5,
      },
      features: ['promise', 'pipeline'],
    });
    if (tPipe) out.push(tPipe);

    const tWhilst = await buildRecordedEffectfulTask({
      pkgName: 'p-whilst', exportName: 'default', driverName: 'cursor-whilst', index: i,
      nativeBindings: [{name: 'next_batch', kind: 'promise', description: 'Fetch next page of numbers by cursor'}],
      driverCode: `async function run(startCursor) {
  const pWhilst = __harvestMod.default ?? __harvestMod;
  let cursor = startCursor;
  const collected = [];
  await pWhilst(
    () => cursor !== null,
    async () => {
      const page = await next_batch(cursor);
      for (let k = 0; k < page.items.length; k++) collected.push(page.items[k]);
      cursor = page.next;
    },
  );
  return {count: collected.length, collected};
}`,
      args: ['c0'],
      toolImpls: {
        next_batch: c => {
          const pages = {
            c0: {items: [i + 1, i + 2], next: i % 2 === 0 ? 'c1' : null},
            c1: {items: [i + 10], next: i >= 4 ? 'c2' : null},
            c2: {items: [99, 100], next: null},
          };
          return pages[c];
        },
      },
      features: ['promise', 'loop'],
    });
    if (tWhilst) out.push(tWhilst);
  }

  // 7b. Real mitt + nanoevents event dispatchers driving native tool sinks
  for (let i = 0; i < 6; i++) {
    const actions = [
      [{type: 'ADD', n: 5}, {type: 'ADD', n: 3}],
      [{type: 'ADD', n: 10}, {type: 'SUB', n: 4}, {type: 'RESET'}],
      [{type: 'ADD', n: 2}, {type: 'SUB', n: 5}, {type: 'ADD', n: 9}],
      [{type: 'SUB', n: 3}, {type: 'ADD', n: 9}],
      [{type: 'ADD', n: 1}, {type: 'ADD', n: 2}, {type: 'RESET'}, {type: 'ADD', n: 7}],
      [{type: 'RESET'}, {type: 'ADD', n: 8}],
    ][i];

    const tMitt = await buildRecordedEffectfulTask({
      pkgName: 'mitt', exportName: 'default', driverName: 'event-bus-dispatch', index: i,
      nativeBindings: [{name: 'sink_emit', kind: 'synchronous', description: 'Deliver event payload to external sink'}],
      driverCode: `function run(actions) {
  const mitt = __harvestMod.default ?? __harvestMod;
  const bus = mitt();
  let total = 0;
  const onAdd = ev => { total += ev.n; sink_emit('add', total); };
  bus.on('ADD', onAdd);
  bus.on('SUB', ev => { total -= ev.n; sink_emit('sub', total); });
  bus.on('RESET', () => { total = 0; bus.off('ADD', onAdd); console.info('reset'); });
  for (let i = 0; i < actions.length; i++) bus.emit(actions[i].type, actions[i]);
  return total;
}`,
      args: [actions],
      toolImpls: {sink_emit: (kind, val) => kind + ':' + val},
      features: ['loop', 'closure', 'platform'],
    });
    if (tMitt) out.push(tMitt);

    const tNano = await buildRecordedEffectfulTask({
      pkgName: 'nanoevents', exportName: 'createNanoEvents', driverName: 'nano-event-stream', index: i,
      nativeBindings: [{name: 'record_metric', kind: 'synchronous', description: 'Record event metric to telemetry backend'}],
      driverCode: `function run(actions) {
  const createNanoEvents = __harvestMod.default ?? __harvestMod;
  const emitter = createNanoEvents();
  let acc = 0;
  const unbind = emitter.on('ADD', n => { acc += n; record_metric('add', acc); });
  emitter.on('SUB', n => { acc -= n; record_metric('sub', acc); });
  emitter.on('RESET', () => { acc = 0; unbind(); console.log('unbound'); });
  for (let i = 0; i < actions.length; i++) emitter.emit(actions[i].type, actions[i].n ?? 0);
  return acc;
}`,
      args: [actions],
      toolImpls: {record_metric: (k, v) => ({k, v})},
      features: ['loop', 'closure', 'platform'],
    });
    if (tNano) out.push(tNano);
  }

  // 7c. Real radash async `tryit` + `reduce` + `retry` (without setTimeout) + `radix3` router + `fast-json-patch` + `compare-versions`
  for (let i = 0; i < 6; i++) {
    const tRadix = await buildRecordedEffectfulTask({
      pkgName: 'radix3', exportName: 'createRouter', driverName: 'radix-route-dispatch', index: i,
      nativeBindings: [
        {name: 'load_user', kind: 'promise', description: 'Load user record by ID'},
        {name: 'load_item', kind: 'promise', description: 'Load item record by category and ID'},
      ],
      driverCode: `async function run(paths) {
  const createRouter = __harvestMod.default ?? __harvestMod;
  const router = createRouter();
  router.insert('/users/:id', {kind: 'user'});
  router.insert('/shop/:cat/:id', {kind: 'item'});
  const responses = [];
  for (let i = 0; i < paths.length; i++) {
    const hit = router.lookup(paths[i]);
    if (!hit) { console.warn('404:' + paths[i]); responses.push({status: 404, path: paths[i]}); continue; }
    if (hit.kind === 'user') responses.push({status: 200, data: await load_user(hit.params.id)});
    else responses.push({status: 200, data: await load_item(hit.params.cat, hit.params.id)});
  }
  return responses;
}`,
      args: [[
        ['/users/42', '/shop/books/7'],
        ['/users/1', '/missing', '/shop/games/9'],
        ['/shop/music/3'],
        ['/nope', '/users/88'],
        ['/users/5', '/users/6', '/shop/art/2'],
        ['/shop/tech/10', '/404'],
      ][i]],
      toolImpls: {
        load_user: id => ({userId: id, active: true}),
        load_item: (cat, id) => ({cat, itemId: id}),
      },
      features: ['promise', 'loop', 'branch', 'platform'],
    });
    if (tRadix) out.push(tRadix);

    const tPatch = await buildRecordedEffectfulTask({
      pkgName: 'fast-json-patch', exportName: 'applyPatch', driverName: 'json-patch-sync', index: i,
      nativeBindings: [
        {name: 'load_doc', kind: 'promise', description: 'Load JSON document by ID'},
        {name: 'save_doc', kind: 'promise', description: 'Persist patched JSON document'},
      ],
      driverCode: `async function run(docId, patchOps) {
  const applyPatch = __harvestMod.default ?? __harvestMod;
  const doc = await load_doc(docId);
  const res = applyPatch(doc, patchOps, false, false);
  await save_doc(docId, res.newDocument);
  return res.newDocument;
}`,
      args: [
        ['d0', [{op: 'replace', path: '/count', value: 5}]],
        ['d1', [{op: 'add', path: '/tags/-', value: 'v2'}, {op: 'replace', path: '/active', value: true}]],
        ['d2', [{op: 'remove', path: '/legacy'}, {op: 'add', path: '/meta/ok', value: 1}]],
        ['d3', [{op: 'move', from: '/a', path: '/b'}]],
        ['d4', [{op: 'copy', from: '/title', path: '/backup'}]],
        ['d5', [{op: 'replace', path: '/nested/x', value: 42}, {op: 'add', path: '/nested/y', value: 99}]],
      ][i],
      toolImpls: {
        load_doc: id => ({
          d0: {count: 1, name: 'x'},
          d1: {tags: ['v1'], active: false},
          d2: {legacy: true, meta: {}},
          d3: {a: 10, b: 0},
          d4: {title: 'hello'},
          d5: {nested: {x: 1}},
        })[id],
        save_doc: (id, doc) => ({id, saved: true, keys: Object.keys(doc).length}),
      },
      features: ['promise', 'object', 'mutation'],
    });
    if (tPatch) out.push(tPatch);

    const tVer = await buildRecordedEffectfulTask({
      pkgName: 'compare-versions', exportName: 'satisfies', driverName: 'release-policy-gate', index: i,
      driverCode: `async function run(url, range) {
  const satisfies = __harvestMod.default ?? __harvestMod;
  const raw = await host.httpGet(url);
  const candidates = raw.split(',');
  const matching = [];
  for (let i = 0; i < candidates.length; i++) {
    if (satisfies(candidates[i], range)) matching.push(candidates[i]);
  }
  host.store('matched', matching.length);
  console.info('matched:' + matching.length);
  return matching;
}`,
      args: [
        ['https://rel.test/0', '^1.2.0'],
        ['https://rel.test/1', '>=2.0.0'],
        ['https://rel.test/2', '~1.4.0'],
        ['https://rel.test/3', '^3.0.0'],
        ['https://rel.test/4', '<2.0.0'],
        ['https://rel.test/5', '^0.5.0'],
      ][i],
      toolImpls: {
        httpGet: () => ({value: ['1.0.0,1.2.5,1.9.0,2.0.0', '1.9.0,2.0.0,2.3.1', '1.3.9,1.4.0,1.4.8,1.5.0', '1.0.0,2.0.0', '0.9.0,1.5.0,2.1.0', '0.4.9,0.5.0,0.5.3,0.6.0'][i]}),
      },
      features: ['http', 'platform', 'loop'],
    });
    if (tVer) out.push(tVer);

    const tTryit = await buildRecordedEffectfulTask({
      pkgName: 'radash', exportName: 'tryit', driverName: 'tryit-fallback-chain', index: i,
      nativeBindings: [
        {name: 'primary_read', kind: 'promise', description: 'Read record from primary store'},
        {name: 'replica_read', kind: 'promise', description: 'Fallback read from replica store'},
      ],
      driverCode: `async function run(key) {
  const tryit = __harvestMod.default ?? __harvestMod;
  const safePrimary = tryit(primary_read);
  const safeReplica = tryit(replica_read);
  const [err1, val1] = await safePrimary(key);
  if (!err1) return {source: 'primary', value: val1};
  console.warn('primary-fail:' + key);
  const [err2, val2] = await safeReplica(key);
  if (!err2) return {source: 'replica', value: val2};
  console.error('both-fail:' + key);
  return {source: 'none', value: null};
}`,
      args: ['k' + i],
      toolImpls: {
        primary_read: k => { if (i % 2 === 1) throw 'p-down'; return 'p:' + k; },
        replica_read: k => { if (i === 5) throw 'r-down'; return 'r:' + k; },
      },
      features: ['promise', 'exception', 'branch', 'platform'],
    });
    if (tTryit) out.push(tTryit);

    // 7d. Real hookable async lifecycle hooks + p-props + heap-js priority scheduler + quick-lru cache-aside
    const tHook = await buildRecordedEffectfulTask({
      pkgName: 'hookable', exportName: 'createHooks', driverName: 'lifecycle-hooks-pipeline', index: i,
      nativeBindings: [
        {name: 'audit_hook', kind: 'promise', description: 'Record lifecycle hook event'},
        {name: 'publish_artifact', kind: 'promise', description: 'Publish final build artifact'},
      ],
      driverCode: `async function run(name, ver) {
  const createHooks = __harvestMod.default ?? __harvestMod;
  const hooks = createHooks();
  const ctx = {name, ver, steps: []};
  hooks.hook('build:before', async (c) => { c.steps.push('before'); await audit_hook('before', c.name); });
  hooks.hook('build:done', async (c) => { c.steps.push('done'); c.url = await publish_artifact(c.name, c.ver); });
  await hooks.callHook('build:before', ctx);
  ctx.steps.push('compile');
  await hooks.callHook('build:done', ctx);
  return ctx;
}`,
      args: ['app-' + i, '1.' + i + '.0'],
      toolImpls: {
        audit_hook: (phase, name) => phase + ':' + name,
        publish_artifact: (name, ver) => 'https://cdn.test/' + name + '@' + ver,
      },
      features: ['promise', 'object', 'mutation'],
    });
    if (tHook) out.push(tHook);

    const tProps = await buildRecordedEffectfulTask({
      pkgName: 'p-props', exportName: 'default', driverName: 'props-sequential-loader', index: i,
      nativeBindings: [{name: 'load_field', kind: 'promise', description: 'Load a named field value'}],
      driverCode: `async function run(prefix) {
  const pProps = __harvestMod.default ?? __harvestMod;
  return await pProps({
    user: () => load_field(prefix + ':user'),
    quota: () => load_field(prefix + ':quota'),
    plan: () => load_field(prefix + ':plan'),
  }, {concurrency: 1});
}`,
      args: ['acct' + i],
      toolImpls: {load_field: k => k + '=' + (i * 7 + k.length)},
      features: ['promise', 'object'],
    });
    if (tProps) out.push(tProps);

    const tHeap = await buildRecordedEffectfulTask({
      pkgName: 'heap-js', exportName: 'Heap', driverName: 'heap-job-executor', index: i,
      nativeBindings: [{name: 'run_task', kind: 'promise', description: 'Execute one prioritized task'}],
      driverCode: `async function run(jobs) {
  const Heap = __harvestMod.default ?? __harvestMod;
  const pq = new Heap((a, b) => a.p - b.p);
  for (let k = 0; k < jobs.length; k++) pq.push(jobs[k]);
  const done = [];
  while (pq.length > 0) {
    const cur = pq.pop();
    const res = await run_task(cur.id, cur.p);
    done.push(res);
  }
  return done;
}`,
      args: [[
        [{id: 'b', p: 3}, {id: 'a', p: 1}, {id: 'c', p: 2}],
        [{id: 'x', p: 5}, {id: 'y', p: 1}, {id: 'z', p: 4}, {id: 'w', p: 2}],
        [{id: 'j1', p: 2}, {id: 'j2', p: 1}],
        [{id: 'm', p: 9}, {id: 'n', p: 3}, {id: 'o', p: 6}],
        [{id: 'p1', p: 4}, {id: 'p2', p: 1}, {id: 'p3', p: 3}, {id: 'p4', p: 2}],
        [{id: 'solo', p: 0}],
      ][i]],
      toolImpls: {run_task: (id, p) => id + '@' + p},
      features: ['promise', 'loop', 'class'],
    });
    if (tHeap) out.push(tHeap);

    const tLru = await buildRecordedEffectfulTask({
      pkgName: 'quick-lru', exportName: 'default', driverName: 'quick-lru-cache-aside', index: i,
      nativeBindings: [{name: 'db_fetch', kind: 'promise', description: 'Fetch record from backing database on cache miss'}],
      driverCode: `async function run(maxSize, keys) {
  const QuickLRU = __harvestMod.default ?? __harvestMod;
  const cache = new QuickLRU({maxSize});
  const values = [];
  let hits = 0, misses = 0;
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    if (cache.has(key)) { hits++; values.push(cache.get(key)); }
    else { misses++; const v = await db_fetch(key); cache.set(key, v); values.push(v); }
  }
  return {hits, misses, values};
}`,
      args: [
        [2, ['a', 'b', 'a', 'c', 'b']],
        [2, ['x', 'x', 'y', 'z', 'x']],
        [3, ['k1', 'k2', 'k3', 'k1', 'k4', 'k2']],
        [1, ['a', 'b', 'a']],
        [2, ['p', 'q', 'r', 'q', 'p']],
        [3, ['u1', 'u2', 'u1', 'u3', 'u2']],
      ][i],
      toolImpls: {db_fetch: k => 'val:' + k},
      features: ['promise', 'loop', 'branch', 'class'],
    });
    if (tLru) out.push(tLru);
  }

  return out;
}

// --- 8. Discover exports and assemble all candidates ---
async function collectAllCandidates() {
  const candidates = [];

  if (!values['skip-npm']) {
    // A. Automated per-export harvesting across all modern ESM/utility libraries (skipped in --unit-tests-only)
    if (!unitTestsOnly) {
      for (const pkgName of ESM_LIBRARY_PACKAGES) {
        const whole = bundleWholeEntry(pkgName);
        if (whole.error) {
          process.stderr.write(`harvest: skip ${pkgName}: ${whole.error.slice(0, 100)}\n`);
          continue;
        }
        let mod;
        try { mod = new Function(`${whole.code}\nreturn __harvestBox;`)(); } catch { continue; }
        const fnNames = [];
        try {
          if (typeof mod === 'function') fnNames.push('default');
          if (mod && typeof mod === 'object') {
            if (typeof mod.default === 'function') fnNames.push('default');
            for (const k of Object.keys(mod).sort()) {
              try {
                if (k !== 'default' && !k.startsWith('_') && typeof mod[k] === 'function') fnNames.push(k);
              } catch {}
            }
          }
        } catch { continue; }
        let pkgAdded = 0;
        const capped = fnNames.filter(name => !isSkippedProbeName(name, harvestMode)).slice(0, 150);
        for (const fnName of capped) {
          const b = bundleExport(pkgName, fnName);
          if (b.error) continue;
          let kept = 0;
          const seenOut = new Set();
          for (const sampleArgs of TYPED_INPUT_BANK) {
            if (kept >= Math.min(2, maxPerFn)) break;
            try {
              const res = probeExportSafely(b, fnName, sampleArgs, {mode: harvestMode});
              if (res.kind !== 'return') continue;
              const v = res.value;
              if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
              const enc = encodeReadable(v);
              const outKey = JSON.stringify(enc);
              if (seenOut.has(outKey) && kept >= 1) continue;
              seenOut.add(outKey);
              candidates.push(buildDirectTask({bundle: b, fnName, args: sampleArgs, index: kept++, origin: 'oss-esm-library', recordedCalls: res.recordedCalls,
                extraFeatures: res.recordedCalls.length ? ['external', 'platform'] : []}));
              pkgAdded++;
            } catch {}
          }
        }
        process.stderr.write(`harvest: ${pkgName}: ${pkgAdded} calls across ${capped.length} exported functions\n`);
      }
    }

    // B. Real GitHub unit-test AST harvesting (with per-export tree shaking!)
    if (values['clone-tests']) {
      const unitCandidates = [];
      for (const spec of REPO_TEST_HARVEST_SPECS) {
        const callsByFn = harvestTestCallsFromRepo(spec.repo, spec.pkg, spec.exports, spec.aliases ?? []);
        let added = 0;
        for (const [fnName, entries] of callsByFn) {
          const b = bundleExport(spec.pkg, fnName);
          if (b.error) continue;
          const sorted = [...entries].sort((a, b2) => b2.sig.length - a.sig.length);
          const picks = sorted.length <= maxPerFn ? sorted
            : Array.from({length: maxPerFn}, (_, k) => sorted[Math.floor(k * (sorted.length - 1) / (maxPerFn - 1))]);
          picks.forEach((entry, idx) => {
            unitCandidates.push(buildDirectTask({
              bundle: b, fnName, args: entry.args, index: idx,
              origin: 'oss-unit-test', testFile: entry.file, extraFeatures: ['unit-test-input'],
            }));
            added++;
          });
        }
        process.stderr.write(`harvest-tests: ${spec.pkg}: ${added} unit-test calls from ${callsByFn.size} fns\n`);
      }
      if (preferUnitTests) candidates.unshift(...unitCandidates);
      else candidates.push(...unitCandidates);
    }

    // C. Real messy side-effectful OSS workflows (skipped in --unit-tests-only)
    if (!unitTestsOnly) {
      const eff = await collectEffectfulOssCandidates();
      process.stderr.write(`harvest: oss-effectful: ${eff.length} recorded multi-turn OSS workflows\n`);
      candidates.push(...eff);
    }
  }

  // D. Local / DGX GitHub repositories (raw JS & TS source + unit tests!)
  if (localReposDir && existsSync(localReposDir)) {
    const localCands = collectLocalRepoCandidates(localReposDir, {
      maxPerFn, maxPerRepo, mode: harvestMode, preferUnitTests, unitTestsOnly, envDir,
    });
    const asyncFetchCands = harvestMode === 'native'
      ? await collectLocalAsyncFetchCandidates(localReposDir, {
          maxPerFn, maxPerRepo, mode: harvestMode, envDir,
        })
      : [];
    const combinedLocal = [...localCands, ...asyncFetchCands];
    process.stderr.write(`harvest: local-repos: ${combinedLocal.length} calls from ${localReposDir}\n`);
    if (preferUnitTests) {
      const isUt = t => (t.metadata?.features ?? []).includes('unit-test-input');
      const localUnit = combinedLocal.filter(isUt);
      const localOther = combinedLocal.filter(t => !isUt(t));
      candidates.unshift(...localUnit);
      candidates.push(...localOther);
    } else {
      candidates.push(...combinedLocal);
    }
  }

  return limit ? candidates.slice(0, limit) : candidates;
}

function isTypeErrorOutcome(outcome) {
  if (!outcome || outcome.kind !== 'throw') return false;
  const root = outcome.graph?.roots?.at(-1);
  if (!Array.isArray(root) || root[0] !== 'ref') return false;
  const obj = outcome.graph?.objects?.find(o => o.id === root[1]);
  return Boolean(obj?.properties?.some(([k, v]) => k === 'name' && Array.isArray(v) && v[0] === 'str' && v[1] === 'TypeError'));
}

// --- 9. Parallel qualification through prepareTinkerTask() (owned === native) ---
export async function qualify(task, options = {}) {
  const effMinSourceChars = options.minSourceChars ?? minSourceChars;
  const effMinTraceLines = options.minTraceLines ?? minTraceLines;
  const t0 = performance.now();
  try {
    if (effMinSourceChars > 0 && task.source.length < effMinSourceChars) {
      return {status: 'refused', category: 'source-too-short', reason: `source ${task.source.length} chars < ${effMinSourceChars}`, id: task.id, pkg: task.metadata.package, origin: task.metadata.sourceOrigin};
    }
    const prepared = await prepareTinkerTask(task, {traceFormat: 'compact'});
    const messages = readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat: 'compact', reasoningChannel: 'thinking'});
    const traceChars = messages.filter(m => m.role === 'assistant')
      .reduce((n, m) => n + assistantVisibleText(m).length + assistantThinkingText(m).length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
    const allTraceLines = messages.filter(m => m.role === 'assistant')
      .flatMap(m => {
        const thinking = assistantThinkingText(m).trim();
        return thinking ? thinking.split('\n') : [];
      });
    const traceLines = allTraceLines.length;
    const firstTraceLine = allTraceLines[0] ?? '';
    const isUnitTest = (task.metadata?.features ?? []).includes('unit-test-input') ||
      task.metadata?.sourceOrigin === 'oss-unit-test' ||
      task.metadata?.sourceOrigin === 'dgx-oss-unit-test';
    const isUnitTestException = isUnitTest && prepared.outcome.kind === 'throw';

    if (!isUnitTest && (/\bTypeError\b/.test(firstTraceLine) || (traceLines <= 1 && isTypeErrorOutcome(prepared.outcome)))) {
      return {status: 'refused', category: 'immediate-type-error', reason: `synthetic probe immediate TypeError (${firstTraceLine || 'throw'})`, id: task.id, pkg: task.metadata.package, origin: task.metadata.sourceOrigin};
    }
    if (effMinTraceLines > 0 && traceLines < effMinTraceLines && !isUnitTestException) {
      return {status: 'refused', category: 'trace-too-short', reason: `compact trace ${traceLines} lines < ${effMinTraceLines}`, id: task.id, pkg: task.metadata.package, origin: task.metadata.sourceOrigin};
    }
    if (traceChars > 80000) {
      return {status: 'refused', category: 'trace-too-long', reason: `compact trace ${traceChars} chars > 80000`, id: task.id, pkg: task.metadata.package, origin: task.metadata.sourceOrigin};
    }
    let cloneHash = null;
    try { cloneHash = nearCloneHash(prepared.source); } catch {}
    const enriched = {
      ...prepared.task,
      metadata: {
        ...task.metadata,
        ...(cloneHash ? {lineage: [...new Set([...task.metadata.lineage, 'near-clone:' + cloneHash])]} : {}),
        sourceChars: prepared.source.length,
        traceChars,
        traceLines,
        externalCalls: prepared.fixture.calls.length,
        completeKind: prepared.outcome.kind,
      },
    };
    return {status: 'admitted', elapsedMs: Math.round(performance.now() - t0), id: task.id, pkg: task.metadata.package, origin: task.metadata.sourceOrigin, traceChars, traceLines, externalCalls: prepared.fixture.calls.length, completeKind: prepared.outcome.kind, task: enriched};
  } catch (err) {
    return {status: 'refused', elapsedMs: Math.round(performance.now() - t0), category: failureCategory(err), reason: String(err.message).slice(0, 200), id: task.id, pkg: task.metadata.package, origin: task.metadata.sourceOrigin};
  }
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({length: Math.min(jobs, items.length)}, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx]);
      done++;
      if (done % 50 === 0 || done === items.length) {
        const ok = results.filter(r => r?.status === 'admitted').length;
        process.stderr.write(`qualify: ${done}/${items.length} (admitted=${ok})\n`);
      }
    }
  }));
  return results;
}

export async function runHarvester(argv = process.argv.slice(2)) {
  const parsed = parseHarvesterArgs(argv);
  values = parsed.values;
  envDir = parsed.envDir;
  reposDir = parsed.reposDir;
  localReposDir = parsed.localReposDir;
  outputDir = parsed.outputDir;
  harvestMode = parsed.harvestMode;
  jobs = parsed.jobs;
  maxPerFn = parsed.maxPerFn;
  maxPerRepo = parsed.maxPerRepo;
  preferUnitTests = parsed.preferUnitTests;
  unitTestsOnly = parsed.unitTestsOnly;
  minSourceChars = parsed.minSourceChars;
  minTraceLines = parsed.minTraceLines;
  limit = parsed.limit;

  mkdirSync(outputDir, {recursive: true});
  mkdirSync(reposDir, {recursive: true});

  const started = new Date().toISOString();
  const candidates = await collectAllCandidates();
  process.stderr.write(`harvest: qualifying ${candidates.length} real OSS candidates with ${jobs} workers...\n`);
  const records = await runPool(candidates, qualify);

  const seenSig = new Set();
  const admitted = [];
  for (const r of records) {
    if (r.status !== 'admitted') continue;
    const sig = executionInputSignature(r.task);
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);
    admitted.push(r.task);
  }

  const byPkg = {}, byOrigin = {}, refusals = {}, refusalSamples = {};
  for (const r of records) {
    byPkg[r.pkg] ??= {candidates: 0, admitted: 0};
    byPkg[r.pkg].candidates++;
    if (r.status === 'admitted') byPkg[r.pkg].admitted++;
    byOrigin[r.origin] ??= {candidates: 0, admitted: 0};
    byOrigin[r.origin].candidates++;
    if (r.status === 'admitted') byOrigin[r.origin].admitted++;
    if (r.status !== 'admitted') {
      const key = r.category + ': ' + r.reason.replace(/\d+/g, 'N').slice(0, 80);
      refusals[key] = (refusals[key] ?? 0) + 1;
      refusalSamples[key] ??= r.id;
    }
  }
  const traceLens = admitted.map(t => t.metadata.traceChars).sort((a, b) => a - b);
  const traceLineArr = admitted.map(t => t.metadata.traceLines).sort((a, b) => a - b);
  const effectful = admitted.filter(t => (t.fixture?.calls?.length ?? 0) > 0).length;
  const census = {
    started, finished: new Date().toISOString(),
    totalCandidates: candidates.length,
    admittedUnique: admitted.length,
    families: new Set(admitted.map(t => t.family)).size,
    packagesAdmitted: Object.values(byPkg).filter(v => v.admitted > 0).length,
    effectfulAdmitted: effectful,
    traceChars: traceLens.length ? {min: traceLens[0], median: traceLens[Math.floor(traceLens.length / 2)], p90: traceLens[Math.floor(traceLens.length * 0.9)], max: traceLens.at(-1)} : null,
    traceLines: traceLineArr.length ? {min: traceLineArr[0], median: traceLineArr[Math.floor(traceLineArr.length / 2)], p90: traceLineArr[Math.floor(traceLineArr.length * 0.9)], max: traceLineArr.at(-1), mean: +(traceLineArr.reduce((a, b) => a + b, 0) / traceLineArr.length).toFixed(2)} : null,
    byOrigin,
    byPackage: byPkg,
    topRefusals: Object.entries(refusals).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([reason, count]) => ({reason, count, example: refusalSamples[reason]})),
  };

  writeFileSync(join(outputDir, 'harvested.jsonl'), admitted.map(r => JSON.stringify(r)).join('\n') + (admitted.length ? '\n' : ''));
  writeFileSync(join(outputDir, 'census.json'), JSON.stringify(census, null, 2) + '\n');
  console.log(JSON.stringify(census, null, 2));
  return census;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runHarvester();
}
