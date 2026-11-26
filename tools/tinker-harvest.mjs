#!/usr/bin/env node
// Automated OSS JavaScript/TypeScript execution harvester.
// Pulls real, messy, multi-function MIT/Apache npm packages & GitHub unit tests,
// tree-shakes self-contained call graphs per export with esbuild, records real
// inputs and real multi-turn side-effect tool calls, and verifies 100% of
// admitted tasks through prepareTinkerTask() (owned VM === native Node oracle).

import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, relative, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import vm from 'node:vm';
import {parse} from 'acorn';
import {prepareTinkerTask, readableMessagesFromJournal, encodeReadable,
  assistantVisibleText, assistantThinkingText} from '../src/training/tinker-execution.js';
import {nearCloneHash, executionInputSignature} from '../src/training/tinker-benchmark.js';
import {failureCategory} from '../src/training/tinker-verification.js';

// Arbitrary probed OSS functions may schedule detached rejected promises inside Node's microtask queue.
process.on('unhandledRejection', () => {});

const stripTmpComments = code => code.replace(/^\s*\/\/ (?:\.\.\/)+\S+\r?\n/gm, '');

const {values} = parseArgs({options: {
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
  limit: {type: 'string'},
}});

const envDir = resolve(values['env-dir']);
const reposDir = resolve(values['repos-dir']);
const localReposDir = values['local-repos'] ? resolve(values['local-repos']) : null;
const outputDir = resolve(values['output-dir']);
const harvestMode = values.mode === 'native' ? 'native' : 'owned';
const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));
const maxPerFn = Math.max(1, Math.min(12, Number(values['max-per-fn']) || 3));
const maxPerRepo = Math.max(1, Math.min(200, Number(values['max-per-repo']) || 30));
const limit = values.limit ? Number(values.limit) : null;

mkdirSync(outputDir, {recursive: true});
mkdirSync(reposDir, {recursive: true});

const req = createRequire(join(envDir, 'package.json'));
const esbuild = req('esbuild');
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
  return req.resolve(pkgJson.name);
}

// --- 1. Tree-shaken per-export bundling via esbuild (zero CJS boilerplate!) ---
const bundleCache = new Map();
function bundleExport(pkgName, exportName = null, subpath = null) {
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

function probeExportSafely(bundle, fnName, sampleArgs) {
  const recordedCalls = [];
  const baseEnv = {__args: structuredClone(sampleArgs)};
  if (harvestMode === 'native') {
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
  }
  const ctx = vm.createContext(baseEnv);
  const patchPreamble = harvestMode === 'native'
    ? 'Date.now = __recDateNow; Math.random = __recRandom;\n'
    : '';
  const load = bundle.directTarget
    ? `let __harvestTarget;\n${bundle.code}\nconst __fn = __harvestTarget;`
    : `${bundle.code}\nconst __fn = ${!bundle.wholeModule
      ? '(__harvestBox.default ?? __harvestBox)'
      : (fnName === 'default'
        ? '(typeof __harvestBox === "function" ? __harvestBox : (__harvestBox.default ?? __harvestBox))'
        : `(__harvestBox[${JSON.stringify(fnName)}] ?? __harvestBox.default?.[${JSON.stringify(fnName)}])`)};`;
  const script = new vm.Script(`(() => {\n${patchPreamble}${load}\nif (typeof __fn !== "function") throw new TypeError("not-fn");\nconst __out = __fn(...__args);\nif (__out && typeof __out.catch === "function") { __out.catch(() => {}); return undefined; }\nreturn __out;\n})()`);
  const value = script.runInContext(ctx, {timeout: 100});
  if (recordedCalls.length > 24) throw new RangeError('Too many external calls');
  return {value, recordedCalls};
}

const SKIP_PROBE_NAMES = harvestMode === 'native'
  ? /^(?:sleep|delay|defer|debounce|throttle|retry|parallel|noop|identity|memo|memoize|proxied|tryit|guard|chain|compose|pipe|curry|partial|partob|promisify|all|any|race)$/i
  : /^(?:sleep|delay|defer|debounce|throttle|retry|parallel|random|uid|draw|shuffle|sample|noop|identity|memo|memoize|proxied|tryit|guard|chain|compose|pipe|curry|partial|partob|promisify|all|any|race)$/i;

// --- 1b. Bundle an arbitrary local JS/TS file (from cloned/DGX GitHub repos) ---
function bundleLocalFile(repoMeta, absFile, exportName = null) {
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

function collectSourceAndTestFiles(dir, out = {code: [], tests: []}) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const n = entry.name;
    if (n.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', 'docs', 'examples', 'example', 'demo', 'demos', 'bench', 'benchmarks', 'fixtures', 'vendor', 'website'].includes(n)) continue;
    const p = join(dir, n);
    if (entry.isDirectory()) {
      collectSourceAndTestFiles(p, out);
    } else if (/\.(?:c|m)?[jt]s$/.test(n) && !n.endsWith('.d.ts') && !/\.config\.|\.eslintrc|\.prettierrc/.test(n)) {
      const sz = statSync(p).size;
      if (sz === 0 || sz > 256 * 1024) continue;
      if (/(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]s$/i.test(p)) out.tests.push(p);
      else out.code.push(p);
    }
  }
  return out;
}

function extractTestCallsFromFiles(repoDir, testFiles, exportNames, aliases = []) {
  const byFn = new Map();
  const exportSet = new Set(exportNames);
  const aliasSet = new Set(aliases);
  for (const file of testFiles.slice(0, 60)) {
    let text = readFileSync(file, 'utf8');
    if (/\.ts$/.test(file)) {
      try {
        text = esbuild.transformSync(text, {loader: 'ts', target: 'es2022', logLevel: 'silent'}).code;
      } catch {
        continue;
      }
    }
    let ast;
    try { ast = parse(text, {ecmaVersion: 'latest', sourceType: 'module'}); }
    catch { try { ast = parse(text, {ecmaVersion: 'latest', sourceType: 'script'}); } catch { continue; } }
    // Collect simple static const/let bindings in the file so calls like fn(fixture) resolve!
    const env = new Map();
    walkAst(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
        const r = evalStaticAst(node.init, env);
        if (r.ok && !env.has(node.id.name)) env.set(node.id.name, r.value);
      }
    });
    walkAst(ast, node => {
      if (node.type !== 'CallExpression' || !node.arguments.length || node.arguments.length > 6) return;
      let fnName = null;
      if (node.callee.type === 'Identifier') {
        if (exportSet.has(node.callee.name)) fnName = node.callee.name;
        else if (aliasSet.has(node.callee.name) && exportSet.has('default')) fnName = 'default';
      } else if (node.callee.type === 'MemberExpression' && !node.callee.computed &&
          node.callee.property.type === 'Identifier' && exportSet.has(node.callee.property.name)) {
        fnName = node.callee.property.name;
      }
      if (!fnName) return;
      const args = [];
      for (const arg of node.arguments) {
        const r = evalStaticAst(arg, env);
        if (!r.ok) return;
        args.push(r.value);
      }
      if (!byFn.has(fnName)) byFn.set(fnName, []);
      const list = byFn.get(fnName);
      const sig = JSON.stringify(args);
      if (sig.length <= 2000 && list.length < 30 && !list.some(x => x.sig === sig)) {
        list.push({args, sig, file: relative(repoDir, file)});
      }
    });
  }
  return byFn;
}

function collectLocalRepoCandidates(rootDir) {
  const candidates = [];
  const repoEntries = readdirSync(rootDir, {withFileTypes: true}).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
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
    // Prioritize src/lib/index files and keep file count bounded per repo
    const rankedCode = [...codeFiles].sort((a, b) => {
      const score = f => {
        const r = relative(repoDir, f);
        if (/^(?:src\/)?index\.[cm]?[jt]s$/.test(r)) return 0;
        if (/^(?:src|lib)\//.test(r)) return 1;
        return 2;
      };
      return score(a) - score(b) || a.localeCompare(b);
    }).slice(0, 20);

    let repoAdded = 0;
    const repoFnSeen = new Set();
    for (const file of rankedCode) {
      if (repoAdded >= maxPerRepo) break;
      const whole = bundleLocalFile(repoMeta, file, null);
      if (whole.error || whole.code.length > 90000) continue;
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
            try {
              if (k !== 'default' && !k.startsWith('_') && typeof mod[k] === 'function') fnNames.push(k);
            } catch {}
          }
        }
      } catch { continue; }
      const usableFns = fnNames.filter(n => !SKIP_PROBE_NAMES.test(n) && !repoFnSeen.has(`${relative(repoDir, file)}#${n}`)).slice(0, 40);
      if (!usableFns.length) continue;

      const shortName = (pkgJson.name || repoSlug.split('/').pop() || '').replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9_$]/g, '');
      const testCalls = testFiles.length ? extractTestCallsFromFiles(repoDir, testFiles, usableFns, [shortName]) : new Map();

      for (const fnName of usableFns) {
        if (repoAdded >= maxPerRepo) break;
        const b = bundleLocalFile(repoMeta, file, fnName);
        if (b.error || b.code.length > 70000) continue;
        repoFnSeen.add(`${relative(repoDir, file)}#${fnName}`);

        let kept = 0;
        const seenOut = new Set();
        // 1) Prefer real unit-test inputs from the repo's own test suite
        const entries = testCalls.get(fnName) ?? [];
        const sorted = [...entries].sort((a, b2) => b2.sig.length - a.sig.length);
        for (const entry of sorted) {
          if (kept >= maxPerFn || repoAdded >= maxPerRepo) break;
          try {
            const {value: res, recordedCalls} = probeExportSafely(b, fnName, entry.args);
            if (res === undefined || typeof res === 'function' || typeof res === 'symbol') continue;
            if (res && typeof res === 'object' && typeof res.then === 'function') continue;
            const outKey = JSON.stringify(encodeReadable(res));
            if (seenOut.has(outKey) && kept >= 1) continue;
            seenOut.add(outKey);
            candidates.push(buildDirectTask({
              bundle: b, fnName, args: entry.args, index: kept++,
              origin: 'dgx-oss-unit-test', testFile: entry.file, recordedCalls,
              extraFeatures: ['dgx-repo', 'unit-test-input', ...(recordedCalls.length ? ['external', 'platform'] : [])],
            }));
            repoAdded++;
          } catch {}
        }
        // 2) Fallback: typed probing if test suite didn't yield enough calls
        for (const sampleArgs of TYPED_INPUT_BANK) {
          if (kept >= Math.min(2, maxPerFn) || repoAdded >= maxPerRepo) break;
          try {
            const {value: res, recordedCalls} = probeExportSafely(b, fnName, sampleArgs);
            if (res === undefined || typeof res === 'function' || typeof res === 'symbol') continue;
            if (res && typeof res === 'object' && typeof res.then === 'function') continue;
            const outKey = JSON.stringify(encodeReadable(res));
            if (seenOut.has(outKey) && kept >= 1) continue;
            seenOut.add(outKey);
            candidates.push(buildDirectTask({
              bundle: b, fnName, args: sampleArgs, index: kept++,
              origin: 'dgx-oss-repo', recordedCalls,
              extraFeatures: ['dgx-repo', ...(recordedCalls.length ? ['external', 'platform'] : [])],
            }));
            repoAdded++;
          } catch {}
        }
      }
    }
    if (repoAdded > 0) {
      process.stderr.write(`harvest-local: ${repoSlug}: ${repoAdded} calls (tests=${testFiles.length}, code=${codeFiles.length})\n`);
    }
  }
  return candidates;
}

// --- 2. Extract static JS literal calls from real OSS GitHub test suites ---
function evalStaticAst(node, env = null) {
  if (!node) return {ok: false};
  if (node.type === 'Literal') {
    if (node.regex || node.bigint) return {ok: false};
    return {ok: true, value: node.value};
  }
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return {ok: true, value: undefined};
    if (node.name === 'NaN') return {ok: true, value: NaN};
    if (node.name === 'Infinity') return {ok: true, value: Infinity};
    if (env && env.has(node.name)) return {ok: true, value: structuredClone(env.get(node.name))};
    return {ok: false};
  }
  if (node.type === 'UnaryExpression' && ['-', '+', '!'].includes(node.operator)) {
    const inner = evalStaticAst(node.argument, env);
    if (!inner.ok) return {ok: false};
    const v = node.operator === '-' ? -inner.value : node.operator === '+' ? +inner.value : !inner.value;
    return {ok: true, value: v};
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return {ok: true, value: node.quasis.map(q => q.value.cooked).join('')};
  }
  if (node.type === 'ArrayExpression') {
    const out = [];
    for (const el of node.elements) {
      if (!el) return {ok: false};
      const r = evalStaticAst(el, env);
      if (!r.ok) return {ok: false};
      out.push(r.value);
    }
    return {ok: true, value: out};
  }
  if (node.type === 'ObjectExpression') {
    const out = {};
    for (const prop of node.properties) {
      if (prop.type !== 'Property' || prop.computed || prop.kind !== 'init') return {ok: false};
      const k = prop.key.type === 'Identifier' ? prop.key.name : (prop.key.type === 'Literal' ? String(prop.key.value) : null);
      if (k === null || k === '__proto__') return {ok: false};
      const r = evalStaticAst(prop.value, env);
      if (!r.ok) return {ok: false};
      out[k] = r.value;
    }
    return {ok: true, value: out};
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = evalStaticAst(node.left, env), r = evalStaticAst(node.right, env);
    if (l.ok && r.ok && (typeof l.value === 'string' || typeof l.value === 'number')) return {ok: true, value: l.value + r.value};
  }
  return {ok: false};
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const val of Object.values(node)) {
    if (Array.isArray(val)) val.forEach(c => walkAst(c, visit));
    else if (val && typeof val === 'object' && typeof val.type === 'string') walkAst(val, visit);
  }
}

function collectJsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(p, out);
    else if (/\.(?:c|m)?js$/.test(entry.name) && statSync(p).size < 512 * 1024) out.push(p);
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
  const byFn = new Map();
  const exportSet = new Set(exportNames);
  const aliasSet = new Set([slug, ...aliases]);
  for (const file of files) {
    let ast;
    const text = readFileSync(file, 'utf8');
    try { ast = parse(text, {ecmaVersion: 'latest', sourceType: 'module'}); }
    catch { try { ast = parse(text, {ecmaVersion: 'latest', sourceType: 'script'}); } catch { continue; } }
    walkAst(ast, node => {
      if (node.type !== 'CallExpression' || !node.arguments.length || node.arguments.length > 6) return;
      let fnName = null;
      if (node.callee.type === 'Identifier') {
        if (exportSet.has(node.callee.name)) fnName = node.callee.name;
        else if (aliasSet.has(node.callee.name) && exportSet.has('default')) fnName = 'default';
      } else if (node.callee.type === 'MemberExpression' && !node.callee.computed &&
          node.callee.property.type === 'Identifier' && exportSet.has(node.callee.property.name)) {
        fnName = node.callee.property.name;
      }
      if (!fnName) return;
      const args = [];
      for (const arg of node.arguments) {
        const r = evalStaticAst(arg);
        if (!r.ok) return;
        args.push(r.value);
      }
      if (!byFn.has(fnName)) byFn.set(fnName, []);
      const list = byFn.get(fnName);
      const sig = JSON.stringify(args);
      if (list.length < 40 && !list.some(x => x.sig === sig)) list.push({args, sig, file: relative(dir, file)});
    });
  }
  return byFn;
}

// --- 3. Build runnable task around a tree-shaken real OSS bundle ---
function buildDirectTask({bundle, fnName, args, index, origin, testFile = null, recordedCalls = [], extraFeatures = []}) {
  const params = args.map((_, i) => 'a' + i).join(', ');
  let source;
  if (bundle.directTarget) {
    source = `"use strict";\nfunction __loadMod() {\nlet __harvestTarget;\n${bundle.code}\nreturn __harvestTarget;\n}\nfunction run(${params}) {\n  const __fn = __loadMod();\n  return __fn(${params});\n}\n`;
  } else {
    const access = !bundle.wholeModule
      ? '(__box.default ?? __box)'
      : (fnName === 'default'
        ? '(typeof __box === "function" ? __box : (__box.default ?? __box))'
        : `(__box[${JSON.stringify(fnName)}] ?? __box.default?.[${JSON.stringify(fnName)}])`);
    source = `"use strict";\nfunction __loadMod() {\n${bundle.code}\nreturn __harvestBox;\n}\nfunction run(${params}) {\n  const __box = __loadMod();\n  return ${access}(${params});\n}\n`;
  }
  const family = `oss:${bundle.pkgName}/${bundle.subpath}#${fnName}`;
  const id = `oss-${bundle.pkgName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${fnName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${index}-${sha256([family, args, recordedCalls]).slice(0, 8)}`;
  const usesToolRandom = harvestMode === 'native' && (recordedCalls.some(c => c.operation === 'platform.random') || /\bMath\.random\b/.test(source));
  return {
    id, family, source, entry: 'run', args: encodeReadable(args),
    ...(harvestMode === 'native' ? {executionMode: 'native'} : {}),
    ...(usesToolRandom ? {randomMode: 'tool'} : {}),
    fixture: {calls: recordedCalls}, randomSeed: 17, maxSteps: 100000, timeoutMs: 10000,
    metadata: {
      sourceOrigin: origin,
      executionMode: harvestMode,
      package: bundle.pkgName,
      version: bundle.version,
      license: bundle.license,
      repository: bundle.repository,
      upstreamSymbol: fnName,
      testFile,
      tier: recordedCalls.length ? 5 : 4,
      template: family,
      lineage: [family, `oss-pkg:${bundle.pkgName}:${bundle.subpath}#${fnName}`],
      features: [...new Set(['real-oss', ...(harvestMode === 'native' ? ['native-v8'] : []), ...extraFeatures])],
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
const TYPED_INPUT_BANK = [
  // Arrays of numbers
  [[3, 1, 4, 1, 5, 9, 2, 6]],
  [[-5, 0, 12, -3, 7, 2]],
  [[1, 2, 3, 4, 5, 6], 2],
  [[1, 2, 3, 4, 5], 3],
  [[1, 2, 3, 4], [3, 4, 5, 6]],
  [[10, 20, 30], [1, 2, 3]],
  // Nested arrays
  [[[1, [2, [3, 4]], 5]]],
  [[[1, 2], [3, 4], [5, 6]]],
  [[['a', 1], ['b', 2], ['c', 3]]],
  // Arrays of objects
  [[{id: 1, tag: 'x', val: 10}, {id: 2, tag: 'y', val: 25}, {id: 3, tag: 'x', val: 5}]],
  [[{name: 'b', n: 2}, {name: 'a', n: 1}, {name: 'c', n: 3}], 'n'],
  // Objects
  [{a: 1, b: {c: 2, d: [3, 4]}, e: 'hi', f: null}],
  [{a: 1, b: 2, c: 3, d: 4}, ['a', 'c']],
  [{a: 1, b: {x: 1, y: 2}}, {b: {y: 9, z: 3}, c: 4}],
  [{a: 1, b: 2, c: {d: 3}}, {a: 1, b: 9, c: {d: 3, e: 4}}],
  [{a: {b: {c: 42}}}, 'a.b.c'],
  [{a: {b: 1}}, 'a.b.c', 99],
  [{a: {b: 1}}, 'a.c', 7],
  // Strings
  ['helloWorldFooBar'],
  ['  the-quick_brown fox  '],
  ['kitten', 'sitting'],
  ['abcdef', 'azced'],
  ['1.2.3', '1.10.0'],
  ['2.0.0-alpha.1', '2.0.0'],
  ['hello world from javascript', 14],
  ['foo/bar/baz', '/'],
  // Numbers & ranges
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
    // A. Automated per-export harvesting across all modern ESM/utility libraries
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
      const capped = fnNames.filter(name => !SKIP_PROBE_NAMES.test(name)).slice(0, 150);
      for (const fnName of capped) {
        const b = bundleExport(pkgName, fnName);
        if (b.error) continue;
        let kept = 0;
        const seenOut = new Set();
        for (const sampleArgs of TYPED_INPUT_BANK) {
          if (kept >= Math.min(2, maxPerFn)) break;
          try {
            const {value: res, recordedCalls} = probeExportSafely(b, fnName, sampleArgs);
            if (res === undefined || typeof res === 'function' || typeof res === 'symbol') continue;
            if (res && typeof res === 'object' && typeof res.then === 'function') continue;
            const enc = encodeReadable(res);
            const outKey = JSON.stringify(enc);
            if (seenOut.has(outKey) && kept >= 1) continue;
            seenOut.add(outKey);
            candidates.push(buildDirectTask({bundle: b, fnName, args: sampleArgs, index: kept++, origin: 'oss-esm-library', recordedCalls,
              extraFeatures: recordedCalls.length ? ['external', 'platform'] : []}));
            pkgAdded++;
          } catch {}
        }
      }
      process.stderr.write(`harvest: ${pkgName}: ${pkgAdded} calls across ${capped.length} exported functions\n`);
    }

    // B. Real GitHub unit-test AST harvesting (with per-export tree shaking!)
    if (values['clone-tests']) {
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
            candidates.push(buildDirectTask({
              bundle: b, fnName, args: entry.args, index: idx,
              origin: 'oss-unit-test', testFile: entry.file, extraFeatures: ['unit-test-input'],
            }));
            added++;
          });
        }
        process.stderr.write(`harvest-tests: ${spec.pkg}: ${added} unit-test calls from ${callsByFn.size} fns\n`);
      }
    }

    // C. Real messy side-effectful OSS workflows
    const eff = await collectEffectfulOssCandidates();
    process.stderr.write(`harvest: oss-effectful: ${eff.length} recorded multi-turn OSS workflows\n`);
    candidates.push(...eff);
  }

  // D. Local / DGX GitHub repositories (raw JS & TS source + unit tests!)
  if (localReposDir && existsSync(localReposDir)) {
    const localCands = collectLocalRepoCandidates(localReposDir);
    process.stderr.write(`harvest: local-repos: ${localCands.length} calls from ${localReposDir}\n`);
    candidates.push(...localCands);
  }

  return limit ? candidates.slice(0, limit) : candidates;
}

// --- 9. Parallel qualification through prepareTinkerTask() (owned === native) ---
async function qualify(task) {
  const t0 = performance.now();
  try {
    const prepared = await prepareTinkerTask(task);
    const messages = readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat: prepared.bundle ? 'compact' : 'actions-only', reasoningChannel: 'thinking'});
    const traceChars = messages.filter(m => m.role === 'assistant')
      .reduce((n, m) => n + assistantVisibleText(m).length + assistantThinkingText(m).length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
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
        externalCalls: prepared.fixture.calls.length,
        completeKind: prepared.outcome.kind,
      },
    };
    return {status: 'admitted', elapsedMs: Math.round(performance.now() - t0), id: task.id, pkg: task.metadata.package, origin: task.metadata.sourceOrigin, traceChars, externalCalls: prepared.fixture.calls.length, completeKind: prepared.outcome.kind, task: enriched};
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
const effectful = admitted.filter(t => (t.fixture?.calls?.length ?? 0) > 0).length;
const census = {
  started, finished: new Date().toISOString(),
  totalCandidates: candidates.length,
  admittedUnique: admitted.length,
  families: new Set(admitted.map(t => t.family)).size,
  packagesAdmitted: Object.values(byPkg).filter(v => v.admitted > 0).length,
  effectfulAdmitted: effectful,
  traceChars: traceLens.length ? {min: traceLens[0], median: traceLens[Math.floor(traceLens.length / 2)], p90: traceLens[Math.floor(traceLens.length * 0.9)], max: traceLens.at(-1)} : null,
  byOrigin,
  byPackage: byPkg,
  topRefusals: Object.entries(refusals).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([reason, count]) => ({reason, count, example: refusalSamples[reason]})),
};

writeFileSync(join(outputDir, 'harvested.jsonl'), admitted.map(r => JSON.stringify(r)).join('\n') + (admitted.length ? '\n' : ''));
writeFileSync(join(outputDir, 'census.json'), JSON.stringify(census, null, 2) + '\n');
console.log(JSON.stringify(census, null, 2));
