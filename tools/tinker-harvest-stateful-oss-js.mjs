#!/usr/bin/env node
/**
 * Messy Real-World Stateful-I/O JS/TS OSS Harvester.
 *
 * Clones (or reuses cached) real open-source JS/TS repositories into
 * `/tmp/stateful-oss-cache/js`, loads their REAL source files (JS & TypeScript)
 * into our virtual multi-file codebase (`code.load`), executes real OSS library
 * APIs against realistic seeded workspaces (virtual FS trees, `.env`, YAML/TOML/
 * JSONC/INI configs, local deterministic HTTP server for `fetch()`, `process.env`,
 * `child_process.execFileSync`/`execSync`, `console.*`, `Date.now()`, `crypto`),
 * captures genuine external I/O via `createLiveNodeIoRecorder` +
 * `createLiveFetchRecorder`, and verifies EVERY admitted task 2x independently
 * through `exportTinkerExample` + `createTinkerSession` live replay, plus
 * causal-prefix pair auditing and zero-leakage auditing against `realexecbench-v1`.
 */
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, parseArgs} from 'node:util';
import vm from 'node:vm';

import {
  createTinkerSession,
  encodeReadable,
  exportTinkerExample,
  prepareTinkerTask,
} from '../src/training/tinker-execution.js';
import {
  executeVirtualCodebaseInContext,
  normalizeRepoPath,
} from '../src/training/tinker-codebase.js';
import {
  createLiveNodeIoRecorder,
  VM_NODE_IO_RUNTIME_SCRIPT,
  WORKSPACE_CWD,
} from '../src/training/tinker-node-io.js';
import {
  createLiveFetchRecorder,
  VM_FETCH_RUNTIME_SCRIPT,
} from '../src/training/tinker-http-fetch.js';

process.on('unhandledRejection', () => {});

const DEFAULT_CACHE_DIR = '/tmp/stateful-oss-cache/js';
const DEFAULT_BENCHMARK_JSONL = '/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl';
const DEFAULT_BENCHMARK_MANIFEST = '/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json';
const SAFE_CONTEXT_CHARS = 215_000; // ~54K tokens conservative guard (<= 65,472 tokens)
const MAX_TURN_CHARS = 70_000; // ~17.5K tokens conservative guard (<= 20,000 tokens)

const JS_OSS_REPOS = {
  motdotla__dotenv: 'https://github.com/motdotla/dotenv.git',
  kaelzhang__node_ignore: 'https://github.com/kaelzhang/node-ignore.git',
  micromatch__picomatch: 'https://github.com/micromatch/picomatch.git',
  cacjs__cac: 'https://github.com/cacjs/cac.git',
  'tj__commander.js': 'https://github.com/tj/commander.js.git',
  lukeed__mri: 'https://github.com/lukeed/mri.git',
  minimistjs__minimist: 'https://github.com/minimistjs/minimist.git',
  npm__ini: 'https://github.com/npm/ini.git',
  eemeli__yaml: 'https://github.com/eemeli/yaml.git',
  'nodeca__js-yaml': 'https://github.com/nodeca/js-yaml.git',
  markedjs__marked: 'https://github.com/markedjs/marked.git',
  'microsoft__node-jsonc-parser': 'https://github.com/microsoft/node-jsonc-parser.git',
  kpdecker__jsdiff: 'https://github.com/kpdecker/jsdiff.git',
  lukeed__kleur: 'https://github.com/lukeed/kleur.git',
  developit__redaxios: 'https://github.com/developit/redaxios.git',
  unjs__confbox: 'https://github.com/unjs/confbox.git',
  'sindresorhus__dot-prop': 'https://github.com/sindresorhus/dot-prop.git',
  typicode__lowdb: 'https://github.com/typicode/lowdb.git',
  moment__luxon: 'https://github.com/moment/luxon.git',
  krisk__Fuse: 'https://github.com/krisk/Fuse.git',
  sindresorhus__ky: 'https://github.com/sindresorhus/ky.git',
  'd3__d3-array': 'https://github.com/d3/d3-array.git',
  'beatgammit__base64-js': 'https://github.com/beatgammit/base64-js.git',
};

// Map canonical repo dir name when cache dir uses hyphens vs underscores
function resolveRepoDir(cacheDir, repoKey) {
  const direct = join(cacheDir, repoKey);
  if (existsSync(direct)) return direct;
  const hyphen = join(cacheDir, repoKey.replaceAll('_', '-'));
  if (existsSync(hyphen)) return hyphen;
  const special = repoKey === 'kaelzhang__node_ignore' ? join(cacheDir, 'kaelzhang__node-ignore') : null;
  if (special && existsSync(special)) return special;
  return direct;
}

function ensureRepoCloned(cacheDir, repoKey, url) {
  const dir = resolveRepoDir(cacheDir, repoKey);
  if (existsSync(dir) && readdirSync(dir).length > 0) return dir;
  mkdirSync(cacheDir, {recursive: true});
  if (existsSync(dir)) rmSync(dir, {recursive: true, force: true});
  execFileSync('git', ['clone', '--depth', '1', '--quiet', url, dir], {
    stdio: 'pipe',
    timeout: 60_000,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
  });
  return dir;
}

const NODE_BUILTINS = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'path', 'node:path', 'url', 'node:url',
  'crypto', 'node:crypto', 'child_process', 'node:child_process',
  'buffer', 'node:buffer', 'process', 'node:process',
]);

/**
 * Rewrite bare Node built-in require()/import statements in a virtual multi-file
 * JS/TS module to `const __require = globalThis.require; __require('...')` so:
 * 1) `executeVirtualCodebaseInContext` (whose `localRequire` only resolves relative paths)
 *    delegates Node built-ins cleanly to `VM_NODE_IO_RUNTIME_SCRIPT`, and
 * 2) `scanPublicSourceNodeIoTools` (which recognizes `__require('fs')` etc.) declares
 *    every external Node I/O tool automatically without editing shared runtime files.
 */
function rewriteNodeBuiltins(code) {
  let out = code;
  let needsRequireBinding = false;
  let needsOsShim = false;

  // Replace require('os') / require('node:os') with deterministic inline shim
  const osReqRe = /\brequire\s*\(\s*['"](?:node:)?os['"]\s*\)/g;
  if (osReqRe.test(out)) {
    out = out.replace(osReqRe, '__nodeOsShim');
    needsOsShim = true;
  }
  const osImportDefaultRe = /^\s*import\s+(\w+)\s+from\s+['"](?:node:)?os['"]\s*;?/gm;
  if (osImportDefaultRe.test(out)) {
    out = out.replace(osImportDefaultRe, 'const $1 = __nodeOsShim;');
    needsOsShim = true;
  }
  const osImportNamedRe = /^\s*import\s*\{([^}]+)\}\s*from\s+['"](?:node:)?os['"]\s*;?/gm;
  if (osImportNamedRe.test(out)) {
    out = out.replace(osImportNamedRe, 'const {$1} = __nodeOsShim;');
    needsOsShim = true;
  }

  // Replace require('fs') / require('node:fs') / etc. -> __require('...')
  out = out.replace(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (full, q, mod) => {
    if (NODE_BUILTINS.has(mod)) {
      needsRequireBinding = true;
      return `__require(${q}${mod}${q})`;
    }
    return full;
  });

  // Replace ESM imports of supported Node built-ins
  // import * as fs from 'node:fs'
  out = out.replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s+(['"])([^'"]+)\2\s*;?/gm, (full, name, q, mod) => {
    if (!NODE_BUILTINS.has(mod)) return full;
    needsRequireBinding = true;
    return `const ${name} = __require(${q}${mod}${q});`;
  });
  // import fs from 'node:fs'
  out = out.replace(/^\s*import\s+(\w+)\s+from\s+(['"])([^'"]+)\2\s*;?/gm, (full, name, q, mod) => {
    if (!NODE_BUILTINS.has(mod)) return full;
    needsRequireBinding = true;
    return `const ${name} = __require(${q}${mod}${q});`;
  });
  // import { a, b as c } from 'node:fs'
  out = out.replace(/^\s*import\s*\{([^}]+)\}\s*from\s+(['"])([^'"]+)\2\s*;?/gm, (full, spec, q, mod) => {
    if (!NODE_BUILTINS.has(mod)) return full;
    needsRequireBinding = true;
    const binding = spec.replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2');
    return `const {${binding}} = __require(${q}${mod}${q});`;
  });

  const prefix = [];
  if (needsRequireBinding && !/\bconst\s+__require\b/.test(out)) {
    prefix.push('const __require = globalThis.require;');
  }
  if (needsOsShim && !/\bconst\s+__nodeOsShim\b/.test(out)) {
    prefix.push('const __nodeOsShim = { homedir: () => "/home/user", platform: () => "linux", EOL: "\\n", tmpdir: () => "/tmp" };');
  }
  if (prefix.length) {
    // Preserve leading 'use strict' directive if present
    const strictMatch = out.match(/^(\s*['"]use strict['"];?\s*\n)/);
    if (strictMatch) {
      out = strictMatch[1] + prefix.join('\n') + '\n' + out.slice(strictMatch[1].length);
    } else {
      out = prefix.join('\n') + '\n' + out;
    }
  }
  return out;
}

function collectJsFiles(repoDir, relSubpaths, {prefix = '', maxFileBytes = 200_000, renameMjsToJs = false, excludeRe = /(?:\.test\.|\.spec\.|\.d\.ts$|__tests__|benchmark|example|cli\.)/i} = {}) {
  const files = {};
  const normCode = (rel, raw) => {
    if (rel.endsWith('.json')) return raw;
    let out = rewriteNodeBuiltins(raw);
    if (renameMjsToJs) out = out.replace(/(['"])(\.\.?\/[^'"]+)\.mjs\1/g, '$1$2.js$1');
    return out;
  };
  const mapRel = rel => (renameMjsToJs && rel.endsWith('.mjs') ? rel.slice(0, -4) + '.js' : rel);
  const addFile = (absPath, baseRoot) => {
    const rel = relative(baseRoot, absPath).replaceAll('\\', '/');
    if (excludeRe && excludeRe.test(rel)) return;
    if (!/\.(?:js|mjs|cjs|ts|json)$/i.test(rel)) return;
    const st = statSync(absPath);
    if (st.size === 0 || st.size > maxFileBytes) return;
    const raw = readFileSync(absPath, 'utf8');
    if (raw.includes('\0')) return;
    const mapped = mapRel(rel);
    const targetRel = normalizeRepoPath(prefix ? `${prefix}/${mapped}` : mapped);
    files[targetRel] = normCode(rel, raw);
  };

  const walk = (dir, baseRoot) => {
    for (const ent of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (['node_modules', 'test', 'tests', '__tests__', 'dist', 'build', 'docs', 'examples', 'bench', 'benchmark'].includes(ent.name)) continue;
        walk(full, baseRoot);
      } else if (ent.isFile()) {
        addFile(full, baseRoot);
      }
    }
  };

  for (const sub of relSubpaths) {
    const abs = join(repoDir, sub);
    if (!existsSync(abs)) throw new Error(`Missing source path: ${abs}`);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, dirname(abs));
    } else {
      const rel = relative(repoDir, abs).replaceAll('\\', '/');
      const raw = readFileSync(abs, 'utf8');
      const mapped = mapRel(rel);
      const targetRel = normalizeRepoPath(prefix ? `${prefix}/${mapped}` : mapped);
      files[targetRel] = normCode(rel, raw);
    }
  }
  if (!Object.keys(files).length) throw new Error(`No JS/TS files collected from ${repoDir}`);
  return files;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function isPreexportedRow(item) {
  return (
    Array.isArray(item?.messages) &&
    item.messages.length > 0 &&
    typeof item.sourceHash === 'string' &&
    item.task && typeof item.task === 'object'
  );
}

function loadForbiddenBenchmark(benchmarkJsonl, benchmarkManifest) {
  const forbidden = {
    ids: new Set(),
    families: new Set(),
    sourceHashes: new Set(),
    splitComponents: new Set(),
    repos: new Set(),
  };
  if (existsSync(benchmarkJsonl)) {
    for (const line of readFileSync(benchmarkJsonl, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (typeof row.id === 'string') forbidden.ids.add(row.id);
      if (typeof row.family === 'string') forbidden.families.add(row.family);
      if (typeof row.sourceHash === 'string') forbidden.sourceHashes.add(row.sourceHash);
      if (typeof row.split_component === 'string') forbidden.splitComponents.add(row.split_component);
      const repo = row.metadata?.repo;
      if (typeof repo === 'string' && repo) {
        forbidden.repos.add(repo.toLowerCase());
        if (repo.includes('__')) forbidden.repos.add(repo.split('__')[1].toLowerCase());
      }
    }
  }
  if (existsSync(benchmarkManifest)) {
    const m = JSON.parse(readFileSync(benchmarkManifest, 'utf8'));
    for (const ids of Object.values(m.task_ids_by_track ?? {})) {
      for (const tid of ids) if (typeof tid === 'string') forbidden.ids.add(tid);
    }
  }
  return forbidden;
}

// ---------------------------------------------------------------------------
// Deterministic local HTTP server
// ---------------------------------------------------------------------------
function createDeterministicHttpServer() {
  let routes = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const route = routes[req.url];
      if (!route) {
        const body = JSON.stringify({error: 'not_found'});
        res.writeHead(404, {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)});
        res.end(body);
        return;
      }
      const {status = 200, headers = {'content-type': 'application/json'}, body = ''} = route;
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      res.writeHead(status, {...headers, 'content-length': buf.length});
      res.end(buf);
    });
  });

  return {
    async start() {
      await new Promise(res => server.listen(0, '127.0.0.1', res));
      return server.address().port;
    },
    setRoutes(nextRoutes) {
      routes = nextRoutes ?? {};
    },
    async stop() {
      await new Promise(res => server.close(res));
    },
  };
}

// ---------------------------------------------------------------------------
// Live-capture multi-file Node I/O + fetch + console + Date.now probe
// ---------------------------------------------------------------------------
function seedWorkspaceDir(workDir, worldFiles = {}, {initGit = false, postGitWrites = null} = {}) {
  const writeMap = map => {
    for (const [rel, content] of Object.entries(map ?? {})) {
      const target = join(workDir, rel);
      mkdirSync(dirname(target), {recursive: true});
      writeFileSync(target, content, typeof content === 'string' ? 'utf8' : undefined);
    }
  };
  writeMap(worldFiles);
  if (initGit) {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    };
    execFileSync('git', ['init', '-q'], {cwd: workDir, env: gitEnv, stdio: 'pipe'});
    execFileSync('git', ['add', '-f', '.'], {cwd: workDir, env: gitEnv, stdio: 'pipe'});
    execFileSync('git', ['commit', '-q', '-m', 'initial'], {cwd: workDir, env: gitEnv, stdio: 'pipe'});
    if (postGitWrites) writeMap(postGitWrites);
  }
}

async function runLiveJsCapture({files, entryFile, entry, args, worldFiles, worldEnv, initGit = false, postGitWrites = null}) {
  const workDir = mkdtempSync(join(tmpdir(), 'stateful-oss-js-'));
  try {
    seedWorkspaceDir(workDir, worldFiles, {initGit, postGitWrites});
    const recordedCalls = [];
    const codeLoadEvents = [];
    let clockMs = 1710000000000;
    let uuidIdx = 0;

    const liveIo = createLiveNodeIoRecorder(recordedCalls, {
      workDir,
      env: {...(worldEnv ?? {})},
      timeoutMs: 4000,
      maxCalls: 64,
      encodeReadable,
    });
    // Make uuid & randomBytes deterministic across capture runs
    liveIo.uuid = () => {
      const hex = String(++uuidIdx).padStart(12, '0');
      const u = `11112222-3333-4444-8555-${hex}`;
      recordedCalls.push({operation: 'platform.uuid', arguments: [], status: 'fulfilled', result: u});
      return u;
    };
    const {liveFetch} = createLiveFetchRecorder(recordedCalls, {timeoutMs: 4000, encodeReadable});

    const context = vm.createContext({
      URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, Buffer,
      __platformNodeIo: liveIo,
      __platformFetch: liveFetch,
      queueMicrotask: cb => queueMicrotask(cb),
      console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...xs) => {
        recordedCalls.push({
          operation: 'platform.console.' + level,
          arguments: encodeReadable(xs),
          status: 'fulfilled',
          result: {$js: 'undefined'},
        });
      }])),
    }, {codeGeneration: {strings: false, wasm: false}});

    new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 3000});
    new vm.Script(VM_NODE_IO_RUNTIME_SCRIPT).runInContext(context, {timeout: 3000});
    context.__recDateNow = () => {
      const v = clockMs;
      clockMs += 1000;
      recordedCalls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: v});
      return v;
    };
    new vm.Script('Date.now = __recDateNow;').runInContext(context, {timeout: 1000});
    new vm.Script(`(function(){let state=17>>>0;
      Math.random=function(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};})()`)
      .runInContext(context, {timeout: 1000});

    const clonedArgs = structuredClone(args);
    const execRes = await executeVirtualCodebaseInContext({
      context,
      files,
      entryFile,
      entry,
      initialLoadedFiles: [entryFile],
      args: clonedArgs,
      timeoutMs: 5000,
      traceMode: false,
      onCodeLoadEvent(req) {
        codeLoadEvents.push(req);
      },
      setTraceActive() {},
    });

    if (execRes.kind === 'throw') {
      return {ok: false, error: `Guest threw: ${execRes.value?.name ?? 'Error'}: ${execRes.value?.message ?? String(execRes.value)}`};
    }
    return {
      ok: true,
      recordedCalls,
      codeLoadEvents,
      outcome: encodeReadable({arguments: clonedArgs, value: execRes.value}),
    };
  } catch (err) {
    return {ok: false, error: String(err?.message ?? err)};
  } finally {
    rmSync(workDir, {recursive: true, force: true});
  }
}

function extractDeclaredAndUsedTools(messages) {
  const declared = new Set();
  const used = [];
  for (const msg of messages) {
    if (msg.role === 'tool_declare') {
      try {
        for (const item of JSON.parse(msg.content)) {
          if (item?.function?.name) declared.add(item.function.name);
        }
      } catch {}
    } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.function?.name) used.push(tc.function.name);
      }
    }
  }
  return {declared, used};
}

function auditCausalPrefixPair(left, right) {
  const prefixLen = left.findIndex(m => m.role === 'user') + 1;
  const rightPrefixLen = right.findIndex(m => m.role === 'user') + 1;
  if (prefixLen <= 0 || prefixLen !== rightPrefixLen || !isDeepStrictEqual(left.slice(0, prefixLen), right.slice(0, prefixLen))) {
    throw new Error('Causal pair public prompts differ');
  }
  const obsOf = msgs => msgs.map((m, i) => [i, m]).filter(([i, m]) => i >= prefixLen && (m.role === 'tool' || m.role === 'user'));
  const ao = obsOf(left);
  const bo = obsOf(right);
  let div = -1;
  for (let i = 0; i < ao.length; i++) {
    if (i >= bo.length || !isDeepStrictEqual(ao[i][1], bo[i][1])) {
      div = i;
      break;
    }
  }
  if (div < 0) {
    throw new Error('Counterfactual pair observations did not diverge');
  }
  if (div >= bo.length) {
    throw new Error('Counterfactual pair observation length mismatch before divergence');
  }
  const ai = ao[div][0];
  const bi = bo[div][0];
  if (ai !== bi || !isDeepStrictEqual(left.slice(0, ai), right.slice(0, bi))) {
    throw new Error('Future observation altered an earlier model-visible prefix');
  }
  return {passed: true, testedDivergence: true, divergenceObservation: div, identicalPrefixMessages: ai};
}

async function verifyTask2x(task, traceFormat = 'compact') {
  let fmt = traceFormat;
  let ex1 = await exportTinkerExample(task, {traceFormat: fmt, reasoningChannel: 'thinking'});
  let ex2 = await exportTinkerExample(task, {traceFormat: fmt, reasoningChannel: 'thinking'});
  if (!isDeepStrictEqual(ex1.messages, ex2.messages)) {
    throw new Error('Non-deterministic messages across 2x export');
  }
  if (ex1.sourceHash !== ex2.sourceHash) {
    throw new Error('Non-deterministic sourceHash across 2x export');
  }
  if (!isPreexportedRow(ex1)) {
    throw new Error('Failed _is_preexported_row schema check');
  }
  const extCalls = Number(ex1.metadata?.externalCalls ?? 0);
  if (extCalls < 1) {
    throw new Error('Task has 0 non-code.load external I/O calls');
  }

  let msgJson = JSON.stringify(ex1.messages);
  let maxTurnChars = Math.max(...ex1.messages.map(m => JSON.stringify(m).length));
  if ((msgJson.length > SAFE_CONTEXT_CHARS || maxTurnChars > MAX_TURN_CHARS) && fmt === 'compact') {
    fmt = 'actions-only';
    ex1 = await exportTinkerExample(task, {traceFormat: fmt, reasoningChannel: 'thinking'});
    ex2 = await exportTinkerExample(task, {traceFormat: fmt, reasoningChannel: 'thinking'});
    if (!isDeepStrictEqual(ex1.messages, ex2.messages)) {
      throw new Error('Non-deterministic messages across 2x export (actions-only)');
    }
    msgJson = JSON.stringify(ex1.messages);
    maxTurnChars = Math.max(...ex1.messages.map(m => JSON.stringify(m).length));
  }

  const {declared, used} = extractDeclaredAndUsedTools(ex1.messages);
  const undeclared = used.filter(op => !declared.has(op));
  if (undeclared.length > 0) {
    throw new Error(`Undeclared tools invoked: ${[...new Set(undeclared)].join(', ')}`);
  }

  if (msgJson.length > SAFE_CONTEXT_CHARS) {
    throw new Error(`Context size exceeded: ${msgJson.length} chars > ${SAFE_CONTEXT_CHARS}`);
  }
  if (maxTurnChars > MAX_TURN_CHARS) {
    throw new Error(`Max turn size exceeded: ${maxTurnChars} chars > ${MAX_TURN_CHARS}`);
  }

  // Independent live session replay verification
  const prepared = await prepareTinkerTask(task, {traceFormat: fmt});
  const session = createTinkerSession(prepared);
  try {
    for (const msg of ex1.messages) {
      if (msg.role === 'assistant') {
        const step = await session.step(msg, 0);
        if (step.done && !step.grade.success) {
          throw new Error(`Live session replay failed: ${JSON.stringify(step.grade)}`);
        }
      }
    }
    const grade = session.grade();
    if (!grade.success || grade.externalCalls !== extCalls) {
      throw new Error(`Live session replay grade mismatch: ${JSON.stringify(grade)}`);
    }
  } finally {
    session.close();
  }

  const nonClOps = used.filter(op => op !== 'code.load');
  ex1.metadata.episodeChars = msgJson.length;
  ex1.metadata.maxTurnChars = maxTurnChars;
  ex1.metadata.externalOps = [...new Set(nonClOps)].sort();
  ex1.metadata.verified2x = true;
  return ex1;
}

// ---------------------------------------------------------------------------
// Scenario definitions across 20+ REAL JS/TS OSS repositories
// ---------------------------------------------------------------------------
function buildJsScenarios(cacheDir, port, errors) {
  const scenarios = [];
  const baseUrl = `http://127.0.0.1:${port}`;

  const loadPkg = (repoKey, relSubpaths, opts = {}) => {
    try {
      const repoDir = ensureRepoCloned(cacheDir, repoKey, JS_OSS_REPOS[repoKey]);
      return collectJsFiles(repoDir, relSubpaths, opts);
    } catch (err) {
      errors.push({repo: repoKey, stage: 'load_pkg', error: String(err?.message ?? err)});
      return null;
    }
  };

  const addPair = (repo, slug, pkgFiles, entryFile, entryCode, entryFn, args, worldA, worldB, extraFeatures = []) => {
    const files = {...pkgFiles, [entryFile]: rewriteNodeBuiltins(entryCode)};
    const pairId = `stateful-oss-js:${repo}:${slug}`;
    scenarios.push({
      kind: 'pair',
      repo,
      slug,
      pairId,
      files,
      entryFile,
      entry: entryFn,
      args,
      variants: [
        {suffix: worldA.label, ...worldA},
        {suffix: worldB.label, ...worldB},
      ],
      features: ['real-oss-stateful-io', 'causal-pair', 'multi-file', 'code-load', ...extraFeatures],
    });
  };

  const addSingle = (repo, slug, pkgFiles, entryFile, entryCode, entryFn, args, world, extraFeatures = []) => {
    const files = {...pkgFiles, [entryFile]: rewriteNodeBuiltins(entryCode)};
    scenarios.push({
      kind: 'single',
      repo,
      slug,
      files,
      entryFile,
      entry: entryFn,
      args,
      variants: [{suffix: world.label, ...world}],
      features: ['real-oss-stateful-io', 'multi-file', 'code-load', ...extraFeatures],
    });
  };

  // 1. motdotla/dotenv
  let pkg = loadPkg('motdotla__dotenv', ['lib/main.js', 'lib/config-options.js']);
  if (pkg) {
    addPair(
      'motdotla__dotenv',
      'dotenv_config_loader',
      pkg,
      'app_env.js',
      `const fs = require('fs');
const dotenv = require('./lib/main.js');

function run(envPath, outPath) {
  const exists = fs.existsSync(envPath);
  const envBag = {};
  let parsed = {};
  if (exists) {
    const res = dotenv.config({ path: envPath, processEnv: envBag, quiet: true });
    parsed = res.parsed || {};
    console.info('loaded dotenv keys:', Object.keys(parsed).length);
  } else {
    console.warn('dotenv missing:', envPath);
  }
  const nodeEnv = process.env.NODE_ENV || envBag.NODE_ENV || 'development';
  const port = Number(process.env.PORT || envBag.PORT || 3000);
  const summary = { exists, nodeEnv, port, keys: Object.keys(parsed).sort() };
  fs.writeFileSync(outPath, JSON.stringify(summary), 'utf8');
  return summary;
}
module.exports = { run };
`,
      'run',
      ['/workspace/.env', '/workspace/env_summary.json'],
      {
        label: 'dotenv_present',
        files: {'.env': 'NODE_ENV=production\nPORT=8443\nAPI_KEY=live-99\n'},
        env: {},
      },
      {
        label: 'dotenv_missing_env_override',
        files: {'README.md': 'no env'},
        env: {NODE_ENV: 'staging', PORT: '4100'},
      },
      ['fs-io', 'env-io', 'console'],
    );
    addPair(
      'motdotla__dotenv',
      'dotenv_parse_and_diff',
      pkg,
      'env_diff.js',
      `const fs = require('fs');
const dotenv = require('./lib/main.js');

function run(samplePath, actualPath) {
  const sample = dotenv.parse(fs.readFileSync(samplePath, 'utf8'));
  const actual = fs.existsSync(actualPath) ? dotenv.parse(fs.readFileSync(actualPath, 'utf8')) : {};
  const missing = Object.keys(sample).filter(k => !(k in actual) && process.env[k] === undefined).sort();
  return { required: Object.keys(sample).sort(), missing, ok: missing.length === 0 };
}
module.exports = { run };
`,
      'run',
      ['/workspace/.env.example', '/workspace/.env'],
      {
        label: 'all_vars_satisfied',
        files: {
          '.env.example': 'DB_URL=\nREDIS_URL=\nSECRET=\n',
          '.env': 'DB_URL=pg://a\nREDIS_URL=redis://b\n',
        },
        env: {SECRET: 'from-env'},
      },
      {
        label: 'missing_required_vars',
        files: {
          '.env.example': 'DB_URL=\nREDIS_URL=\nSECRET=\n',
          '.env': 'DB_URL=pg://a\n',
        },
        env: {},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 2. kaelzhang/node-ignore
  pkg = loadPkg('kaelzhang__node_ignore', ['index.js']);
  if (pkg) {
    addPair(
      'kaelzhang__node-ignore',
      'gitignore_workspace_scan',
      pkg,
      'scan_ignore.js',
      `const fs = require('fs');
const ignore = require('./index.js');

function walk(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = dir + '/' + name;
    const rel = prefix ? prefix + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

function run(rootDir, outPath) {
  const ig = ignore();
  const giPath = rootDir + '/.gitignore';
  if (fs.existsSync(giPath)) {
    ig.add(fs.readFileSync(giPath, 'utf8'));
  }
  const all = walk(rootDir).filter(p => p !== '.gitignore');
  const kept = ig.filter(all);
  const ignored = all.filter(p => ig.ignores(p));
  const res = { kept, ignored };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
module.exports = { run };
`,
      'run',
      ['/workspace/repo', '/workspace/scan.json'],
      {
        label: 'with_gitignore',
        files: {
          'repo/.gitignore': '*.log\ndist/\n!dist/keep.txt\n',
          'repo/index.js': 'export const x = 1;',
          'repo/error.log': 'boom',
          'repo/dist/app.js': 'bundled',
          'repo/dist/keep.txt': 'ok',
        },
        env: {},
      },
      {
        label: 'without_gitignore',
        files: {
          'repo/index.js': 'export const x = 1;',
          'repo/error.log': 'boom',
          'repo/dist/app.js': 'bundled',
        },
        env: {},
      },
      ['fs-io'],
    );
  }

  // 3. micromatch/picomatch
  pkg = loadPkg('micromatch__picomatch', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'micromatch__picomatch',
      'glob_artifact_collector',
      pkg,
      'glob_collect.js',
      `const fs = require('fs');
const picomatch = require('./index.js');

function run(dirPath, outPath) {
  const pattern = process.env.GLOB_PATTERN || '*.ts';
  const isMatch = picomatch(pattern);
  const entries = fs.readdirSync(dirPath).sort();
  const matched = [];
  let totalBytes = 0;
  for (const name of entries) {
    if (!isMatch(name)) continue;
    const st = fs.statSync(dirPath + '/' + name);
    if (st.isFile()) {
      matched.push({ name, size: st.size });
      totalBytes += st.size;
    }
  }
  const res = { pattern, count: matched.length, totalBytes, matched };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
module.exports = { run };
`,
      'run',
      ['/workspace/src', '/workspace/matched.json'],
      {
        label: 'ts_pattern',
        files: {
          'src/app.ts': 'export const a = 1;',
          'src/util.ts': 'export const b = 22;',
          'src/readme.md': '# hi',
        },
        env: {GLOB_PATTERN: '*.ts'},
      },
      {
        label: 'md_pattern',
        files: {
          'src/app.ts': 'export const a = 1;',
          'src/util.ts': 'export const b = 22;',
          'src/readme.md': '# hi',
        },
        env: {GLOB_PATTERN: '*.md'},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 4. cacjs/cac (TypeScript multi-file CLI!)
  pkg = loadPkg('cacjs__cac', ['src']);
  if (pkg) {
    addPair(
      'cacjs__cac',
      'ts_cli_config_runner',
      pkg,
      'cli_entry.ts',
      `import * as fs from 'node:fs';
import { cac } from './src/index.ts';

export function run(argv: string[]) {
  const cli = cac('deployer');
  cli.option('--config <path>', 'Config file', { default: '/workspace/deploy.json' });
  cli.option('--dry-run', 'Dry run mode');
  const parsed = cli.parse(['node', 'deployer', ...argv], { run: false });
  const cfgPath: string = parsed.options.config;
  const exists = fs.existsSync(cfgPath);
  const cfg = exists ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { region: 'us-east-1', replicas: 1 };
  const targetEnv = process.env.DEPLOY_TARGET || 'staging';
  const dryRun = Boolean(parsed.options.dryRun);
  const plan = { targetEnv, region: cfg.region, replicas: cfg.replicas, dryRun, fromDisk: exists };
  if (!dryRun) {
    fs.writeFileSync('/workspace/last-plan.json', JSON.stringify(plan), 'utf8');
    console.info('wrote deploy plan for', targetEnv);
  }
  return plan;
}
`,
      'run',
      [['--config', '/workspace/deploy.json']],
      {
        label: 'config_present_prod',
        files: {'deploy.json': JSON.stringify({region: 'eu-central-1', replicas: 6})},
        env: {DEPLOY_TARGET: 'production'},
      },
      {
        label: 'config_missing_staging',
        files: {'.keep': ''},
        env: {DEPLOY_TARGET: 'staging'},
      },
      ['typescript', 'fs-io', 'env-io', 'console'],
    );
  }

  // 5. tj/commander.js
  pkg = loadPkg('tj__commander.js', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'tj__commander.js',
      'commander_build_cli',
      pkg,
      'cmd_app.js',
      `const fs = require('fs');
const { Command } = require('./index.js');

function run(argv) {
  const program = new Command();
  program
    .exitOverride()
    .option('-i, --input <file>', 'input file', '/workspace/in.json')
    .option('-o, --output <file>', 'output file', '/workspace/out.json')
    .option('--min <n>', 'minimum score', '10');
  program.parse(argv, { from: 'user' });
  const opts = program.opts();
  const minScore = Number(process.env.OVERRIDE_MIN || opts.min);
  const rows = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
  const kept = rows.filter(r => r.score >= minScore);
  fs.writeFileSync(opts.output, JSON.stringify({ minScore, kept }), 'utf8');
  return { minScore, total: rows.length, keptCount: kept.length };
}
module.exports = { run };
`,
      'run',
      [['-i', '/workspace/in.json', '-o', '/workspace/out.json', '--min', '20']],
      {
        label: 'env_raises_threshold',
        files: {'in.json': JSON.stringify([{id: 1, score: 25}, {id: 2, score: 85}, {id: 3, score: 12}])},
        env: {OVERRIDE_MIN: '50'},
      },
      {
        label: 'cli_default_threshold',
        files: {'in.json': JSON.stringify([{id: 1, score: 25}, {id: 2, score: 85}, {id: 3, score: 12}])},
        env: {},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 6. lukeed/mri
  pkg = loadPkg('lukeed__mri', ['src/index.js']);
  if (pkg) {
    addPair(
      'lukeed__mri',
      'mri_flags_and_fs_merge',
      pkg,
      'mri_cli.js',
      `const fs = require('fs');
const mriMod = require('./src/index.js');
const mri = mriMod.default || mriMod;

function run(argv) {
  const flags = mri(argv, { boolean: ['strict'], default: { config: '/workspace/mri.json', workers: 2 } });
  const fileCfg = fs.existsSync(flags.config) ? JSON.parse(fs.readFileSync(flags.config, 'utf8')) : {};
  const merged = {
    workers: Number(process.env.WORKERS || fileCfg.workers || flags.workers),
    strict: Boolean(flags.strict || fileCfg.strict),
    targets: flags._,
  };
  fs.writeFileSync('/workspace/mri_resolved.json', JSON.stringify(merged), 'utf8');
  return merged;
}
module.exports = { run };
`,
      'run',
      [['src/a.js', 'src/b.js', '--config', '/workspace/mri.json']],
      {
        label: 'disk_config_strict',
        files: {'mri.json': JSON.stringify({workers: 8, strict: true})},
        env: {},
      },
      {
        label: 'env_workers_no_disk',
        files: {'.keep': ''},
        env: {WORKERS: '16'},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 7. minimistjs/minimist
  pkg = loadPkg('minimistjs__minimist', ['index.js']);
  if (pkg) {
    addPair(
      'minimistjs__minimist',
      'minimist_git_release_cli',
      pkg,
      'release_cli.js',
      `const fs = require('fs');
const cp = require('child_process');
const minimist = require('./index.js');

function run(argv) {
  const args = minimist(argv, { string: ['manifest'], boolean: ['check-clean'] });
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  let dirty = [];
  if (args['check-clean']) {
    const out = cp.execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
    dirty = out.split('\\n').map(s => s.trim()).filter(Boolean);
  }
  const canRelease = dirty.length === 0;
  if (!canRelease) console.warn('dirty worktree blocks release');
  return { name: manifest.name, version: manifest.version, canRelease, dirtyCount: dirty.length };
}
module.exports = { run };
`,
      'run',
      [['--manifest', '/workspace/pkg.json', '--check-clean']],
      {
        label: 'clean_worktree_release',
        files: {'pkg.json': JSON.stringify({name: 'sdk', version: '2.0.0'})},
        initGit: true,
        env: {},
      },
      {
        label: 'dirty_worktree_blocked',
        files: {'pkg.json': JSON.stringify({name: 'sdk', version: '2.0.0'})},
        postGitWrites: {'scratch.txt': 'uncommitted'},
        initGit: true,
        env: {},
      },
      ['fs-io', 'shell-exec', 'console'],
    );
  }

  // 8. npm/ini
  pkg = loadPkg('npm__ini', ['lib/ini.js']);
  if (pkg) {
    addPair(
      'npm__ini',
      'npmrc_registry_patcher',
      pkg,
      'npmrc_tool.js',
      `const fs = require('fs');
const ini = require('./lib/ini.js');

function run(rcPath, outPath) {
  const cfg = fs.existsSync(rcPath) ? ini.parse(fs.readFileSync(rcPath, 'utf8')) : {};
  const registry = process.env.NPM_REGISTRY || cfg.registry || 'https://registry.npmjs.org/';
  cfg.registry = registry;
  if (process.env.NPM_TOKEN) {
    cfg['//registry.acme.io/:_authToken'] = process.env.NPM_TOKEN;
  }
  fs.writeFileSync(outPath, ini.stringify(cfg), 'utf8');
  return { registry, hasToken: Boolean(process.env.NPM_TOKEN), keys: Object.keys(cfg).sort() };
}
module.exports = { run };
`,
      'run',
      ['/workspace/.npmrc', '/workspace/.npmrc.out'],
      {
        label: 'private_registry_with_token',
        files: {'.npmrc': 'save-exact=true\nregistry=https://registry.npmjs.org/\n'},
        env: {NPM_REGISTRY: 'https://registry.acme.io/', NPM_TOKEN: 'npm_tok_77'},
      },
      {
        label: 'default_public_registry',
        files: {'.npmrc': 'save-exact=true\n'},
        env: {},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 9. eemeli/yaml (TypeScript multi-file YAML!)
  pkg = loadPkg('eemeli__yaml', ['src'], {excludeRe: /(?:\.test\.|\.spec\.|cli\.ts|doc\/createNode\.ts\.bak)/i});
  if (pkg) {
    addPair(
      'eemeli__yaml',
      'ts_yaml_service_overlay',
      pkg,
      'yaml_merge.ts',
      `import * as fs from 'node:fs';
import { parse, stringify } from './src/index.ts';

export function run(basePath: string, overridePath: string, outPath: string) {
  const base = parse(fs.readFileSync(basePath, 'utf8')) as Record<string, any>;
  const hasOverride = fs.existsSync(overridePath);
  if (hasOverride) {
    const ov = parse(fs.readFileSync(overridePath, 'utf8')) as Record<string, any>;
    Object.assign(base.service, ov.service || {});
  }
  if (process.env.REPLICAS) {
    base.service.replicas = Number(process.env.REPLICAS);
  }
  fs.writeFileSync(outPath, stringify(base), 'utf8');
  return { hasOverride, name: base.service.name, replicas: base.service.replicas, port: base.service.port };
}
`,
      'run',
      ['/workspace/base.yaml', '/workspace/override.yaml', '/workspace/final.yaml'],
      {
        label: 'override_plus_env_replicas',
        files: {
          'base.yaml': 'service:\n  name: search\n  port: 8080\n  replicas: 2\n',
          'override.yaml': 'service:\n  port: 9090\n',
        },
        env: {REPLICAS: '6'},
      },
      {
        label: 'base_only',
        files: {
          'base.yaml': 'service:\n  name: search\n  port: 8080\n  replicas: 2\n',
        },
        env: {},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 10. nodeca/js-yaml
  pkg = loadPkg('nodeca__js-yaml', ['src']);
  if (pkg) {
    addPair(
      'nodeca__js-yaml',
      'jsyaml_pipeline_validator',
      pkg,
      'ci_validate.ts',
      `import * as fs from 'node:fs';
import { load, dump } from './src/index.ts';

export function run(workflowDir: string, outPath: string) {
  const files = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml')).sort();
  const jobs: Array<{ file: string; name: string; jobCount: number; jobNames: string[] }> = [];
  for (const f of files) {
    const doc = load(fs.readFileSync(workflowDir + '/' + f, 'utf8')) as any;
    const jobNames = Object.keys(doc.jobs || {}).sort();
    jobs.push({ file: f, name: doc.name, jobCount: jobNames.length, jobNames });
  }
  const totalJobs = jobs.reduce((s, x) => s + x.jobCount, 0);
  fs.writeFileSync(outPath, dump({ totalJobs, workflows: jobs }), 'utf8');
  return { workflowCount: files.length, totalJobs };
}
`,
      'run',
      ['/workspace/workflows', '/workspace/ci_index.yml'],
      {
        label: 'two_workflows',
        files: {
          'workflows/ci.yml': 'name: CI\njobs:\n  lint:\n    runs-on: ubuntu\n  test:\n    runs-on: ubuntu\n',
          'workflows/deploy.yml': 'name: Deploy\njobs:\n  ship:\n    runs-on: ubuntu\n',
        },
        env: {},
      },
      {
        label: 'single_workflow',
        files: {
          'workflows/ci.yml': 'name: CI\njobs:\n  lint:\n    runs-on: ubuntu\n',
        },
        env: {},
      },
      ['fs-io'],
    );
  }

  // 11. markedjs/marked (TypeScript multi-file Markdown!)
  pkg = loadPkg('markedjs__marked', ['src']);
  if (pkg) {
    addPair(
      'markedjs__marked',
      'ts_marked_docs_compiler',
      pkg,
      'build_md.ts',
      `import * as fs from 'node:fs';
import { marked } from './src/marked.ts';

export function run(docsDir: string, outDir: string) {
  const includeDrafts = process.env.INCLUDE_DRAFTS === '1';
  const built: Array<{name: string; bytes: number}> = [];
  for (const file of fs.readdirSync(docsDir).sort()) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(docsDir + '/' + file, 'utf8');
    if (!includeDrafts && raw.startsWith('<!-- draft -->')) {
      console.info('skipping draft', file);
      continue;
    }
    const html = marked.parse(raw, { async: false }) as string;
    const outName = file.replace(/\\.md$/, '.html');
    fs.writeFileSync(outDir + '/' + outName, html, 'utf8');
    built.push({ name: outName, bytes: html.length });
  }
  return { includeDrafts, count: built.length, built };
}
`,
      'run',
      ['/workspace/docs', '/workspace/dist'],
      {
        label: 'skip_drafts',
        files: {
          'docs/index.md': '# Home\n\nWelcome to **Docs**.\n',
          'docs/wip.md': '<!-- draft -->\n# WIP\n',
          'dist/.keep': '',
        },
        env: {INCLUDE_DRAFTS: '0'},
      },
      {
        label: 'include_drafts',
        files: {
          'docs/index.md': '# Home\n\nWelcome to **Docs**.\n',
          'docs/wip.md': '<!-- draft -->\n# WIP\n',
          'dist/.keep': '',
        },
        env: {INCLUDE_DRAFTS: '1'},
      },
      ['typescript', 'fs-io', 'env-io', 'console'],
    );
  }

  // 12. microsoft/node-jsonc-parser (TypeScript multi-file JSONC!)
  pkg = loadPkg('microsoft__node-jsonc-parser', ['src']);
  if (pkg) {
    addPair(
      'microsoft__node-jsonc-parser',
      'ts_tsconfig_jsonc_editor',
      pkg,
      'edit_tsconfig.ts',
      `import * as fs from 'node:fs';
import { applyEdits, modify, parse } from './src/main.ts';

export function run(tsconfigPath: string) {
  const text = fs.readFileSync(tsconfigPath, 'utf8');
  const parsed = parse(text);
  const wantStrict = process.env.STRICT_TS === '1';
  const curStrict = Boolean(parsed?.compilerOptions?.strict);
  if (curStrict !== wantStrict) {
    const edits = modify(text, ['compilerOptions', 'strict'], wantStrict, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    const updated = applyEdits(text, edits);
    fs.writeFileSync(tsconfigPath, updated, 'utf8');
    return { changed: true, strict: wantStrict, keptComment: updated.includes('// strictness') };
  }
  return { changed: false, strict: curStrict, keptComment: text.includes('// strictness') };
}
`,
      'run',
      ['/workspace/tsconfig.json'],
      {
        label: 'enable_strict_preserving_comments',
        files: {
          'tsconfig.json': '{\n  // strictness\n  "compilerOptions": {\n    "target": "ES2022",\n    "strict": false\n  }\n}\n',
        },
        env: {STRICT_TS: '1'},
      },
      {
        label: 'already_disabled_noop',
        files: {
          'tsconfig.json': '{\n  // strictness\n  "compilerOptions": {\n    "target": "ES2022",\n    "strict": false\n  }\n}\n',
        },
        env: {STRICT_TS: '0'},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 13. kpdecker/jsdiff (TypeScript multi-file diff/patch!)
  pkg = loadPkg('kpdecker__jsdiff', ['src']);
  if (pkg) {
    addPair(
      'kpdecker__jsdiff',
      'ts_unified_patch_writer',
      pkg,
      'make_patch.ts',
      `import * as fs from 'node:fs';
import { createTwoFilesPatch, diffLines } from './src/index.ts';

export function run(oldPath: string, newPath: string, patchPath: string) {
  const oldTxt = fs.readFileSync(oldPath, 'utf8');
  const newTxt = fs.readFileSync(newPath, 'utf8');
  const parts = diffLines(oldTxt, newTxt);
  const added = parts.filter(p => p.added).reduce((s, p) => s + (p.count || 0), 0);
  const removed = parts.filter(p => p.removed).reduce((s, p) => s + (p.count || 0), 0);
  if (added === 0 && removed === 0) {
    return { changed: false, added: 0, removed: 0 };
  }
  const patch = createTwoFilesPatch(oldPath, newPath, oldTxt, newTxt);
  fs.writeFileSync(patchPath, patch, 'utf8');
  return { changed: true, added, removed, patchBytes: patch.length };
}
`,
      'run',
      ['/workspace/v1.txt', '/workspace/v2.txt', '/workspace/changes.patch'],
      {
        label: 'files_differ_emit_patch',
        files: {
          'v1.txt': 'port=8080\nworkers=2\nlog=info\n',
          'v2.txt': 'port=8080\nworkers=8\nlog=warn\nmetrics=true\n',
        },
        env: {},
      },
      {
        label: 'files_identical_noop',
        files: {
          'v1.txt': 'port=8080\nworkers=2\n',
          'v2.txt': 'port=8080\nworkers=2\n',
        },
        env: {},
      },
      ['typescript', 'fs-io'],
    );
  }

  // 14. lukeed/kleur (process.env.NO_COLOR / FORCE_COLOR + console + FS!)
  pkg = loadPkg('lukeed__kleur', ['index.mjs', 'colors.mjs'], {renameMjsToJs: true});
  if (pkg) {
    addPair(
      'lukeed__kleur',
      'ansi_status_reporter',
      pkg,
      'status_fmt.js',
      `import * as fs from 'node:fs';
import kleur from './index.js';

export function run(reportPath, outPath) {
  kleur.enabled = !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0';
  const items = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const lines = items.map(it =>
    it.ok ? kleur.green('PASS ' + it.name) : kleur.red('FAIL ' + it.name)
  );
  const rendered = lines.join('\\n') + '\\n';
  fs.writeFileSync(outPath, rendered, 'utf8');
  console.log(rendered.trim());
  return { colorEnabled: kleur.enabled, hasAnsi: rendered.includes('\\x1b['), failed: items.filter(i => !i.ok).length };
}
`,
      'run',
      ['/workspace/checks.json', '/workspace/checks.out'],
      {
        label: 'ansi_enabled',
        files: {'checks.json': JSON.stringify([{name: 'lint', ok: true}, {name: 'e2e', ok: false}])},
        env: {FORCE_COLOR: '1'},
      },
      {
        label: 'no_color_plain',
        files: {'checks.json': JSON.stringify([{name: 'lint', ok: true}, {name: 'e2e', ok: false}])},
        env: {NO_COLOR: '1'},
      },
      ['fs-io', 'env-io', 'console'],
    );
  }

  // 15. developit/redaxios (REAL fetch() HTTP client + FS cache + env!)
  pkg = loadPkg('developit__redaxios', ['src/index.js']);
  if (pkg) {
    addPair(
      'developit__redaxios',
      'redaxios_http_cache_sync',
      pkg,
      'api_sync.js',
      `const fs = require('fs');
const redaxios = require('./src/index.js');
const axios = redaxios.default || redaxios;

async function run(endpoint, cachePath) {
  const token = process.env.API_TOKEN || '';
  try {
    const resp = await axios.get(endpoint, {
      headers: token ? { authorization: 'Bearer ' + token } : {},
      fetch: globalThis.fetch,
    });
    const out = { source: 'http', status: resp.status, data: resp.data };
    fs.writeFileSync(cachePath, JSON.stringify(out), 'utf8');
    return out;
  } catch (err) {
    console.warn('http failed, checking cache:', err.status || err.message);
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return { ...cached, source: 'cache' };
    }
    return { source: 'error', status: err.status || 500 };
  }
}
module.exports = { run };
`,
      'run',
      [`${baseUrl}/v1/flags`, '/workspace/flags_cache.json'],
      {
        label: 'http_200_live_and_cached',
        files: {'.keep': ''},
        env: {API_TOKEN: 'sec-token-42'},
        httpRoutes: {'/v1/flags': {status: 200, body: JSON.stringify({beta: true, limit: 500})}},
      },
      {
        label: 'http_503_cache_hit',
        files: {'flags_cache.json': JSON.stringify({source: 'http', status: 200, data: {beta: false, limit: 100}})},
        env: {API_TOKEN: 'sec-token-42'},
        httpRoutes: {'/v1/flags': {status: 503, body: JSON.stringify({error: 'unavailable'})}},
      },
      ['http-io', 'fs-io', 'env-io', 'console'],
    );
  }

  // 16. unjs/confbox (TypeScript multi-format config: TOML/YAML/JSON5/INI!)
  pkg = loadPkg('unjs__confbox', ['src']);
  if (pkg) {
    addPair(
      'unjs__confbox',
      'ts_confbox_toml_to_yaml',
      pkg,
      'convert_cfg.ts',
      `import * as fs from 'node:fs';
import { parseTOML, stringifyYAML } from './src/index.ts';

export function run(tomlPath: string, yamlOutPath: string) {
  const doc = parseTOML(fs.readFileSync(tomlPath, 'utf8')) as Record<string, any>;
  const envName = process.env.APP_ENV || 'dev';
  doc.runtime = { env: envName, debug: envName !== 'prod' };
  const yml = stringifyYAML(doc);
  fs.writeFileSync(yamlOutPath, yml, 'utf8');
  return { env: envName, keys: Object.keys(doc).sort(), debug: doc.runtime.debug };
}
`,
      'run',
      ['/workspace/config.toml', '/workspace/config.yaml'],
      {
        label: 'prod_env_convert',
        files: {'config.toml': '[server]\nhost = "0.0.0.0"\nport = 8080\n'},
        env: {APP_ENV: 'prod'},
      },
      {
        label: 'dev_env_convert',
        files: {'config.toml': '[server]\nhost = "0.0.0.0"\nport = 8080\n'},
        env: {APP_ENV: 'dev'},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
    addPair(
      'unjs__confbox',
      'ts_confbox_json5_merge',
      pkg,
      'json5_cfg.ts',
      `import * as fs from 'node:fs';
import { parseJSON5, stringifyJSONC } from './src/index.ts';

export function run(cfgPath: string, outPath: string) {
  const cfg = parseJSON5(fs.readFileSync(cfgPath, 'utf8')) as Record<string, any>;
  const feature = process.env.ENABLE_FEATURE;
  if (feature) {
    cfg.features = cfg.features || {};
    cfg.features[feature] = true;
  }
  fs.writeFileSync(outPath, stringifyJSONC(cfg), 'utf8');
  return { name: cfg.name, features: Object.keys(cfg.features || {}).sort() };
}
`,
      'run',
      ['/workspace/app.json5', '/workspace/app.out.json'],
      {
        label: 'feature_injected',
        files: {'app.json5': '{\n  // app settings\n  name: "portal",\n  features: { search: true, },\n}\n'},
        env: {ENABLE_FEATURE: 'billing'},
      },
      {
        label: 'no_feature_override',
        files: {'app.json5': '{\n  // app settings\n  name: "portal",\n  features: { search: true, },\n}\n'},
        env: {},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 17. sindresorhus/dot-prop
  pkg = loadPkg('sindresorhus__dot-prop', ['index.js']);
  if (pkg) {
    addPair(
      'sindresorhus__dot-prop',
      'nested_config_patcher',
      pkg,
      'patch_cfg.js',
      `import * as fs from 'node:fs';
import { getProperty, setProperty } from './index.js';

export function run(cfgPath, keyPath, fallbackVal) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const prev = getProperty(cfg, keyPath);
  const override = process.env.PATCH_VALUE;
  const nextVal = override !== undefined ? override : (prev !== undefined ? prev : fallbackVal);
  setProperty(cfg, keyPath, nextVal);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return { prev: prev ?? null, nextVal };
}
`,
      'run',
      ['/workspace/settings.json', 'db.pool.mode', 'auto'],
      {
        label: 'env_overrides_existing',
        files: {'settings.json': JSON.stringify({db: {pool: {mode: 'static', max: 10}}})},
        env: {PATCH_VALUE: 'elastic'},
      },
      {
        label: 'fallback_fills_missing',
        files: {'settings.json': JSON.stringify({db: {host: 'localhost'}})},
        env: {},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 18. typicode/lowdb (TypeScript multi-file LowSync + FS JSON persistence!)
  pkg = loadPkg('typicode__lowdb', ['src/core/Low.ts', 'src/adapters/Memory.ts']);
  if (pkg) {
    addPair(
      'typicode__lowdb',
      'ts_lowdb_json_store',
      pkg,
      'lowdb_app.ts',
      `import * as fs from 'node:fs';
import { LowSync, type SyncAdapter } from './src/core/Low.ts';

class FsJsonAdapter<T> implements SyncAdapter<T> {
  file: string;
  constructor(file: string) { this.file = file; }
  read(): T | null {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
  }
  write(data: T): void {
    fs.writeFileSync(this.file, JSON.stringify(data), 'utf8');
  }
}

export function run(dbPath: string, title: string) {
  const db = new LowSync<{ posts: Array<{ id: number; title: string }> }>(new FsJsonAdapter(dbPath), { posts: [] });
  db.read();
  const exists = db.data.posts.some(p => p.title === title);
  if (!exists) {
    db.data.posts.push({ id: db.data.posts.length + 1, title });
    db.write();
  }
  return { inserted: !exists, count: db.data.posts.length, titles: db.data.posts.map(p => p.title) };
}
`,
      'run',
      ['/workspace/db.json', 'Launch Post'],
      {
        label: 'new_db_inserts_post',
        files: {'.keep': ''},
        env: {},
      },
      {
        label: 'existing_post_deduped',
        files: {'db.json': JSON.stringify({posts: [{id: 1, title: 'Launch Post'}, {id: 2, title: 'Update'}]})},
        env: {},
      },
      ['typescript', 'fs-io'],
    );
  }

  // 19. moment/luxon (Multi-file DateTime + Date.now() + FS certificate/token expiry audit!)
  pkg = loadPkg('moment__luxon', ['src']);
  if (pkg) {
    addPair(
      'moment__luxon',
      'luxon_cert_expiry_audit',
      pkg,
      'cert_audit.js',
      `import * as fs from 'node:fs';
import { DateTime } from './src/luxon.js';

export function run(certsPath, outPath) {
  const nowMs = Date.now();
  const now = DateTime.fromMillis(nowMs, { zone: 'utc' });
  const warnDays = Number(process.env.WARN_DAYS || 30);
  const certs = JSON.parse(fs.readFileSync(certsPath, 'utf8'));
  const expiring = [];
  for (const c of certs) {
    const exp = DateTime.fromISO(c.expiresAt, { zone: 'utc' });
    const daysLeft = Math.floor(exp.diff(now, 'days').days);
    if (daysLeft <= warnDays) {
      expiring.push({ domain: c.domain, daysLeft });
      console.warn('cert expiring soon:', c.domain, daysLeft);
    }
  }
  const res = { warnDays, checked: certs.length, expiring };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`,
      'run',
      ['/workspace/certs.json', '/workspace/cert_report.json'],
      {
        label: 'one_cert_expiring_soon',
        files: {
          'certs.json': JSON.stringify([
            {domain: 'api.acme.io', expiresAt: '2024-03-20T00:00:00Z'},
            {domain: 'www.acme.io', expiresAt: '2025-01-01T00:00:00Z'},
          ]),
        },
        env: {WARN_DAYS: '30'},
      },
      {
        label: 'all_certs_fresh',
        files: {
          'certs.json': JSON.stringify([
            {domain: 'api.acme.io', expiresAt: '2025-06-01T00:00:00Z'},
            {domain: 'www.acme.io', expiresAt: '2025-01-01T00:00:00Z'},
          ]),
        },
        env: {WARN_DAYS: '30'},
      },
      ['fs-io', 'env-io', 'time-io', 'console'],
    );
  }

  // 20. krisk/Fuse (TypeScript multi-file fuzzy search over FS catalog!)
  pkg = loadPkg('krisk__Fuse', ['src']);
  if (pkg) {
    addPair(
      'krisk__Fuse',
      'ts_fuse_catalog_search',
      pkg,
      'search_docs.ts',
      `import * as fs from 'node:fs';
import Fuse from './src/entry.ts';

export function run(catalogPath: string, query: string, outPath: string) {
  const docs = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const threshold = Number(process.env.FUZZY_THRESHOLD || '0.4');
  const fuse = new Fuse(docs, { keys: ['title', 'tags'], threshold });
  const hits = fuse.search(query).map(r => r.item.id);
  const res = { query, threshold, hits };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`,
      'run',
      ['/workspace/catalog.json', 'kubernets', '/workspace/search_out.json'],
      {
        label: 'fuzzy_match_found',
        files: {
          'catalog.json': JSON.stringify([
            {id: 'doc-1', title: 'Kubernetes Deployment Guide', tags: ['k8s', 'infra']},
            {id: 'doc-2', title: 'SQLite Indexing Notes', tags: ['db', 'sql']},
          ]),
        },
        env: {FUZZY_THRESHOLD: '0.4'},
      },
      {
        label: 'strict_threshold_no_match',
        files: {
          'catalog.json': JSON.stringify([
            {id: 'doc-1', title: 'Kubernetes Deployment Guide', tags: ['k8s', 'infra']},
            {id: 'doc-2', title: 'SQLite Indexing Notes', tags: ['db', 'sql']},
          ]),
        },
        env: {FUZZY_THRESHOLD: '0.05'},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 21. Extra rich JS/TS stateful pairs across our real OSS repos (shell.exec, http.request, crypto uuid/randomBytes, async fs/promises!)
  // 21a. eemeli/yaml + fetch() remote YAML policy fetcher
  pkg = loadPkg('eemeli__yaml', ['src'], {excludeRe: /(?:\.test\.|\.spec\.|cli\.ts)/i});
  if (pkg) {
    addPair(
      'eemeli__yaml',
      'ts_remote_yaml_policy_fetch',
      pkg,
      'fetch_policy.ts',
      `import * as fs from 'node:fs';
import { parse } from './src/index.ts';

export async function run(url: string, fallbackPath: string) {
  const resp = await fetch(url, { headers: { accept: 'application/yaml' } });
  let text: string;
  let source: string;
  if (resp.ok) {
    text = await resp.text();
    source = 'remote';
    fs.writeFileSync(fallbackPath, text, 'utf8');
  } else {
    console.warn('remote policy status:', resp.status);
    text = fs.readFileSync(fallbackPath, 'utf8');
    source = 'disk-fallback';
  }
  const policy = parse(text) as Record<string, any>;
  return { source, version: policy.version, allowCount: (policy.allow || []).length };
}
`,
      'run',
      [`${baseUrl}/policy.yaml`, '/workspace/policy_cache.yaml'],
      {
        label: 'remote_200_updated',
        files: {'policy_cache.yaml': 'version: 1\nallow:\n  - read\n'},
        env: {},
        httpRoutes: {'/policy.yaml': {status: 200, headers: {'content-type': 'application/yaml'}, body: 'version: 2\nallow:\n  - read\n  - write\n  - admin\n'}},
      },
      {
        label: 'remote_502_fallback',
        files: {'policy_cache.yaml': 'version: 1\nallow:\n  - read\n'},
        env: {},
        httpRoutes: {'/policy.yaml': {status: 502, headers: {'content-type': 'text/plain'}, body: 'bad gateway'}},
      },
      ['typescript', 'http-io', 'fs-io', 'console'],
    );
  }

  // 21b. markedjs/marked + fetch() remote markdown + crypto.randomUUID() build ID!
  pkg = loadPkg('markedjs__marked', ['src']);
  if (pkg) {
    addPair(
      'markedjs__marked',
      'ts_remote_md_render_uuid',
      pkg,
      'remote_render.ts',
      `import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { marked } from './src/marked.ts';

export async function run(url: string, outPath: string) {
  const buildId = crypto.randomUUID();
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error('fetch failed', resp.status);
    return { ok: false, status: resp.status, buildId };
  }
  const md = await resp.text();
  const html = marked.parse(md, { async: false }) as string;
  fs.writeFileSync(outPath, '<!-- ' + buildId + ' -->\\n' + html, 'utf8');
  return { ok: true, buildId, htmlLen: html.length };
}
`,
      'run',
      [`${baseUrl}/release.md`, '/workspace/release.html'],
      {
        label: 'http_200_rendered',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/release.md': {status: 200, headers: {'content-type': 'text/markdown'}, body: '# Release 4.0\n\n- Fast builds\n'}},
      },
      {
        label: 'http_404_aborted',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/release.md': {status: 404, headers: {'content-type': 'text/plain'}, body: 'not found'}},
      },
      ['typescript', 'http-io', 'fs-io', 'uuid-io', 'console'],
    );
  }

  // 21c. microsoft/node-jsonc-parser + fs/promises async multi-file config scanner
  pkg = loadPkg('microsoft__node-jsonc-parser', ['src']);
  if (pkg) {
    addPair(
      'microsoft__node-jsonc-parser',
      'ts_async_vscode_settings_audit',
      pkg,
      'audit_vscode.ts',
      `import * as fsp from 'node:fs/promises';
import { parse } from './src/main.ts';

export async function run(dirPath: string, outPath: string) {
  const entries = (await fsp.readdir(dirPath)).filter(f => f.endsWith('.json')).sort();
  const report: Record<string, any> = {};
  for (const name of entries) {
    const raw = await fsp.readFile(dirPath + '/' + name, 'utf8');
    const obj = parse(raw);
    report[name] = { keys: Object.keys(obj || {}).sort(), tabSize: obj?.['editor.tabSize'] ?? null };
  }
  await fsp.writeFile(outPath, JSON.stringify(report), 'utf8');
  return { files: entries, report };
}
`,
      'run',
      ['/workspace/.vscode', '/workspace/vscode_audit.json'],
      {
        label: 'two_settings_files',
        files: {
          '.vscode/settings.json': '{\n  // tabs\n  "editor.tabSize": 2,\n  "files.trimTrailingWhitespace": true\n}\n',
          '.vscode/launch.json': '{\n  "version": "0.2.0"\n}\n',
        },
        env: {},
      },
      {
        label: 'single_settings_file',
        files: {
          '.vscode/settings.json': '{\n  "editor.tabSize": 4\n}\n',
        },
        env: {},
      },
      ['typescript', 'fs-io', 'async'],
    );
  }

  // 21d. kpdecker/jsdiff + child_process git show vs working copy patch
  pkg = loadPkg('kpdecker__jsdiff', ['src']);
  if (pkg) {
    addPair(
      'kpdecker__jsdiff',
      'ts_git_head_vs_workdir_diff',
      pkg,
      'git_diff_tool.ts',
      `import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { diffLines } from './src/index.ts';

export function run(relFile: string) {
  const headText = cp.execFileSync('git', ['show', 'HEAD:' + relFile], { encoding: 'utf8' });
  const curText = fs.readFileSync('/workspace/' + relFile, 'utf8');
  const changes = diffLines(headText, curText);
  const added = changes.filter(c => c.added).reduce((s, c) => s + (c.count || 0), 0);
  const removed = changes.filter(c => c.removed).reduce((s, c) => s + (c.count || 0), 0);
  return { file: relFile, modified: added > 0 || removed > 0, added, removed };
}
`,
      'run',
      ['config.txt'],
      {
        label: 'modified_lines_detected',
        files: {'config.txt': 'a=1\nb=2\nc=3\n'},
        postGitWrites: {'config.txt': 'a=1\nb=20\nc=3\nd=4\n'},
        initGit: true,
        env: {},
      },
      {
        label: 'unmodified_clean',
        files: {'config.txt': 'a=1\nb=2\nc=3\n'},
        initGit: true,
        env: {},
      },
      ['typescript', 'fs-io', 'shell-exec'],
    );
  }

  // 21e. kaelzhang/node-ignore + child_process git ls-files leak detector
  pkg = loadPkg('kaelzhang__node_ignore', ['index.js']);
  if (pkg) {
    addPair(
      'kaelzhang__node-ignore',
      'git_ls_files_ignore_audit',
      pkg,
      'git_ignore_audit.js',
      `const fs = require('fs');
const cp = require('child_process');
const ignore = require('./index.js');

function run() {
  const ig = ignore().add(fs.readFileSync('/workspace/.gitignore', 'utf8'));
  const tracked = cp.execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\\n').map(s => s.trim()).filter(Boolean);
  const leaked = tracked.filter(f => f !== '.gitignore' && ig.ignores(f)).sort();
  if (leaked.length) console.warn('leaked tracked files:', leaked.join(','));
  return { trackedCount: tracked.length, leaked };
}
module.exports = { run };
`,
      'run',
      [],
      {
        label: 'leaked_env_tracked',
        files: {
          '.gitignore': '*.key\n*.log\n',
          'app.js': 'export const ok = 1;',
          'prod.key': 'SECRET',
        },
        initGit: true,
        env: {},
      },
      {
        label: 'clean_tracked_tree',
        files: {
          '.gitignore': '*.key\n*.log\n',
          'app.js': 'export const ok = 1;',
        },
        initGit: true,
        env: {},
      },
      ['fs-io', 'shell-exec', 'console'],
    );
  }

  // 21f. typicode/lowdb + http webhook sync + Date.now()
  pkg = loadPkg('typicode__lowdb', ['src/core/Low.ts', 'src/adapters/Memory.ts']);
  if (pkg) {
    addPair(
      'typicode__lowdb',
      'ts_lowdb_remote_sync',
      pkg,
      'lowdb_sync.ts',
      `import * as fs from 'node:fs';
import { LowSync, type SyncAdapter } from './src/core/Low.ts';

class FsJsonAdapter<T> implements SyncAdapter<T> {
  file: string;
  constructor(file: string) { this.file = file; }
  read(): T | null {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
  }
  write(data: T): void {
    fs.writeFileSync(this.file, JSON.stringify(data), 'utf8');
  }
}

export async function run(dbPath: string, apiUrl: string) {
  const db = new LowSync<{ syncedAt: number; items: string[] }>(new FsJsonAdapter(dbPath), { syncedAt: 0, items: [] });
  db.read();
  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    return { updated: false, count: db.data.items.length, syncedAt: db.data.syncedAt };
  }
  const incoming = (await resp.json()) as { items: string[] };
  for (const item of incoming.items) {
    if (!db.data.items.includes(item)) db.data.items.push(item);
  }
  db.data.syncedAt = Date.now();
  db.write();
  return { updated: true, count: db.data.items.length, items: db.data.items, syncedAt: db.data.syncedAt };
}
`,
      'run',
      ['/workspace/items.json', `${baseUrl}/items`],
      {
        label: 'remote_200_merges_items',
        files: {'items.json': JSON.stringify({syncedAt: 100, items: ['alpha']})},
        env: {},
        httpRoutes: {'/items': {status: 200, body: JSON.stringify({items: ['alpha', 'beta', 'gamma']})}},
      },
      {
        label: 'remote_500_keeps_local',
        files: {'items.json': JSON.stringify({syncedAt: 100, items: ['alpha']})},
        env: {},
        httpRoutes: {'/items': {status: 500, body: JSON.stringify({error: 'err'})}},
      },
      ['typescript', 'fs-io', 'http-io', 'time-io'],
    );
  }

  // 21g. unjs/confbox + fs.readFileSync binary/utf8 + ini/toml/yaml detector
  pkg = loadPkg('unjs__confbox', ['src']);
  if (pkg) {
    addPair(
      'unjs__confbox',
      'ts_confbox_auto_format_loader',
      pkg,
      'auto_load.ts',
      `import * as fs from 'node:fs';
import { parseINI, parseTOML, parseYAML } from './src/index.ts';

export function run(dirPath: string) {
  const entries = fs.readdirSync(dirPath).sort();
  for (const name of ['app.toml', 'app.yaml', 'app.ini']) {
    if (!entries.includes(name)) continue;
    const raw = fs.readFileSync(dirPath + '/' + name, 'utf8');
    const parsed = name.endsWith('.toml') ? parseTOML(raw) : name.endsWith('.yaml') ? parseYAML(raw) : parseINI(raw);
    return { format: name.split('.').pop(), file: name, parsed };
  }
  return { format: 'none', file: null, parsed: {} };
}
`,
      'run',
      ['/workspace/cfg'],
      {
        label: 'toml_preferred',
        files: {
          'cfg/app.toml': 'name = "svc"\nport = 8080\n',
          'cfg/app.ini': 'name=old\nport=3000\n',
        },
        env: {},
      },
      {
        label: 'ini_fallback',
        files: {
          'cfg/app.ini': 'name=legacy\nport=3000\n',
        },
        env: {},
      },
      ['typescript', 'fs-io'],
    );
  }

  // 21h. motdotla/dotenv + crypto.randomUUID() session env file generator
  pkg = loadPkg('motdotla__dotenv', ['lib/main.js', 'lib/config-options.js']);
  if (pkg) {
    addPair(
      'motdotla__dotenv',
      'dotenv_session_bootstrap',
      pkg,
      'session_env.js',
      `const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('./lib/main.js');

function run(envPath) {
  const parsed = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
  let sessionId = parsed.SESSION_ID || process.env.SESSION_ID;
  let generated = false;
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    generated = true;
    const content = Object.entries({ ...parsed, SESSION_ID: sessionId }).map(([k, v]) => k + '=' + v).join('\\n') + '\\n';
    fs.writeFileSync(envPath, content, 'utf8');
  }
  return { sessionId, generated, app: parsed.APP_NAME || 'default' };
}
module.exports = { run };
`,
      'run',
      ['/workspace/.env.session'],
      {
        label: 'existing_session_reused',
        files: {'.env.session': 'APP_NAME=billing\nSESSION_ID=fixed-sess-1\n'},
        env: {},
      },
      {
        label: 'missing_session_generated',
        files: {'.env.session': 'APP_NAME=billing\n'},
        env: {},
      },
      ['fs-io', 'env-io', 'uuid-io'],
    );
  }

  // 21i. nodeca/js-yaml + fetch() OpenAPI spec sync + endpoint counter
  pkg = loadPkg('nodeca__js-yaml', ['src']);
  if (pkg) {
    addPair(
      'nodeca__js-yaml',
      'openapi_yaml_remote_diff',
      pkg,
      'openapi_sync.ts',
      `import * as fs from 'node:fs';
import { load, dump } from './src/index.ts';

export async function run(specUrl: string, localPath: string) {
  const localDoc = load(fs.readFileSync(localPath, 'utf8')) as any;
  const resp = await fetch(specUrl);
  const remoteDoc = load(await resp.text()) as any;
  const localPaths = Object.keys(localDoc.paths || {}).sort();
  const remotePaths = Object.keys(remoteDoc.paths || {}).sort();
  const added = remotePaths.filter(p => !localPaths.includes(p));
  if (added.length > 0) {
    fs.writeFileSync(localPath, dump(remoteDoc), 'utf8');
  }
  return { updated: added.length > 0, added, total: remotePaths.length };
}
`,
      'run',
      [`${baseUrl}/openapi.yaml`, '/workspace/openapi.yaml'],
      {
        label: 'new_endpoint_added',
        files: {'openapi.yaml': 'openapi: 3.0.0\npaths:\n  /health: {}\n'},
        env: {},
        httpRoutes: {'/openapi.yaml': {status: 200, headers: {'content-type': 'application/yaml'}, body: 'openapi: 3.0.0\npaths:\n  /health: {}\n  /metrics: {}\n'}},
      },
      {
        label: 'already_up_to_date',
        files: {'openapi.yaml': 'openapi: 3.0.0\npaths:\n  /health: {}\n'},
        env: {},
        httpRoutes: {'/openapi.yaml': {status: 200, headers: {'content-type': 'application/yaml'}, body: 'openapi: 3.0.0\npaths:\n  /health: {}\n'}},
      },
      ['fs-io', 'http-io'],
    );
  }

  // 21j. npm/ini + fs.readdirSync multi-profile gitconfig merger
  pkg = loadPkg('npm__ini', ['lib/ini.js']);
  if (pkg) {
    addPair(
      'npm__ini',
      'gitconfig_dir_merge',
      pkg,
      'merge_ini.js',
      `const fs = require('fs');
const ini = require('./lib/ini.js');

function run(dirPath, outPath) {
  const merged = {};
  for (const name of fs.readdirSync(dirPath).filter(f => f.endsWith('.ini')).sort()) {
    const part = ini.parse(fs.readFileSync(dirPath + '/' + name, 'utf8'));
    for (const [k, v] of Object.entries(part)) {
      if (v && typeof v === 'object' && merged[k] && typeof merged[k] === 'object') {
        Object.assign(merged[k], v);
      } else {
        merged[k] = v;
      }
    }
  }
  fs.writeFileSync(outPath, ini.stringify(merged), 'utf8');
  return { sections: Object.keys(merged).sort(), user: merged.user || {} };
}
module.exports = { run };
`,
      'run',
      ['/workspace/ini.d', '/workspace/merged.ini'],
      {
        label: 'override_layer_present',
        files: {
          'ini.d/01-base.ini': '[user]\nname=Alice\nemail=alice@old.io\n',
          'ini.d/02-corp.ini': '[user]\nemail=alice@corp.io\n[core]\neditor=vim\n',
        },
        env: {},
      },
      {
        label: 'base_layer_only',
        files: {
          'ini.d/01-base.ini': '[user]\nname=Alice\nemail=alice@old.io\n',
        },
        env: {},
      },
      ['fs-io'],
    );
  }

  // 21k. micromatch/picomatch + fs.statSync recursive size budget check
  pkg = loadPkg('micromatch__picomatch', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'micromatch__picomatch',
      'asset_budget_checker',
      pkg,
      'budget_check.js',
      `const fs = require('fs');
const picomatch = require('./index.js');

function run(assetsDir, pattern) {
  const maxBytes = Number(process.env.MAX_BUNDLE_BYTES || 50);
  const matcher = picomatch(pattern);
  let total = 0;
  const matched = [];
  for (const name of fs.readdirSync(assetsDir).sort()) {
    if (!matcher(name)) continue;
    const st = fs.statSync(assetsDir + '/' + name);
    if (st.isFile()) {
      total += st.size;
      matched.push(name);
    }
  }
  const overBudget = total > maxBytes;
  if (overBudget) console.error('bundle over budget:', total, '>', maxBytes);
  return { matched, total, maxBytes, overBudget };
}
module.exports = { run };
`,
      'run',
      ['/workspace/assets', '*.{js,css}'],
      {
        label: 'over_budget_error',
        files: {
          'assets/app.js': 'console.log("hello world from bundle");',
          'assets/style.css': 'body { margin: 0; padding: 0; }',
          'assets/logo.svg': '<svg></svg>',
        },
        env: {MAX_BUNDLE_BYTES: '40'},
      },
      {
        label: 'within_budget_ok',
        files: {
          'assets/app.js': 'console.log("hi");',
          'assets/style.css': 'body{}',
          'assets/logo.svg': '<svg></svg>',
        },
        env: {MAX_BUNDLE_BYTES: '100'},
      },
      ['fs-io', 'env-io', 'console'],
    );
  }

  // 21l. cacjs/cac + child_process git branch guard CLI
  pkg = loadPkg('cacjs__cac', ['src']);
  if (pkg) {
    addPair(
      'cacjs__cac',
      'ts_cac_branch_guard',
      pkg,
      'branch_guard.ts',
      `import * as cp from 'node:child_process';
import { cac } from './src/index.ts';

export function run(argv: string[]) {
  const cli = cac('guard');
  cli.option('--allow <branches>', 'Comma-separated allowed branches', { default: 'main,master' });
  const parsed = cli.parse(['node', 'guard', ...argv], { run: false });
  const allowed = String(process.env.ALLOWED_BRANCHES || parsed.options.allow).split(',').map(s => s.trim());
  const branch = cp.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  const ok = allowed.includes(branch);
  if (!ok) console.error('blocked branch:', branch);
  return { branch, allowed, ok };
}
`,
      'run',
      [['--allow', 'main,master']],
      {
        label: 'branch_allowed',
        files: {'README.md': '# repo\n'},
        initGit: true,
        env: {},
      },
      {
        label: 'env_restricts_branch',
        files: {'README.md': '# repo\n'},
        initGit: true,
        env: {ALLOWED_BRANCHES: 'release-prod'},
      },
      ['typescript', 'shell-exec', 'env-io', 'console'],
    );
  }

  // 21m. tj/commander.js + fs/promises + fetch() health probe CLI
  pkg = loadPkg('tj__commander.js', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'tj__commander.js',
      'commander_http_probe_cli',
      pkg,
      'probe_cli.js',
      `const fs = require('fs');
const { Command } = require('./index.js');

async function run(argv) {
  const cmd = new Command();
  cmd.exitOverride()
    .option('-u, --url <url>', 'target url')
    .option('-o, --out <file>', 'output file', '/workspace/probe.json');
  cmd.parse(argv, { from: 'user' });
  const opts = cmd.opts();
  const resp = await fetch(opts.url);
  const body = await resp.json();
  const result = { ok: resp.ok, status: resp.status, service: body.service || 'unknown' };
  fs.writeFileSync(opts.out, JSON.stringify(result), 'utf8');
  return result;
}
module.exports = { run };
`,
      'run',
      [['-u', `${baseUrl}/status`, '-o', '/workspace/probe.json']],
      {
        label: 'status_200_healthy',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/status': {status: 200, body: JSON.stringify({service: 'gateway', ok: true})}},
      },
      {
        label: 'status_503_unhealthy',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/status': {status: 503, body: JSON.stringify({service: 'gateway', ok: false})}},
      },
      ['http-io', 'fs-io'],
    );
  }

  // 21n. moment/luxon + fs + Date.now() TTL cache validator
  pkg = loadPkg('moment__luxon', ['src']);
  if (pkg) {
    addPair(
      'moment__luxon',
      'luxon_ttl_cache_guard',
      pkg,
      'ttl_cache.js',
      `import * as fs from 'node:fs';
import { DateTime } from './src/luxon.js';

export function run(cachePath, ttlMinutes) {
  const now = DateTime.fromMillis(Date.now(), { zone: 'utc' });
  if (!fs.existsSync(cachePath)) {
    return { hit: false, reason: 'missing' };
  }
  const entry = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const written = DateTime.fromISO(entry.writtenAt, { zone: 'utc' });
  const ageMin = Math.floor(now.diff(written, 'minutes').minutes);
  const fresh = ageMin <= ttlMinutes;
  return { hit: fresh, ageMin, value: fresh ? entry.value : null };
}
`,
      'run',
      ['/workspace/cache.json', 60],
      {
        label: 'cache_fresh_hit',
        files: {'cache.json': JSON.stringify({writtenAt: '2024-03-09T15:40:00Z', value: {rate: 1.08}})},
        env: {},
      },
      {
        label: 'cache_expired_miss',
        files: {'cache.json': JSON.stringify({writtenAt: '2024-03-08T10:00:00Z', value: {rate: 1.08}})},
        env: {},
      },
      ['fs-io', 'time-io'],
    );
  }

  // 21o. sindresorhus/dot-prop + fs.readdirSync multi-tenant config audit
  pkg = loadPkg('sindresorhus__dot-prop', ['index.js']);
  if (pkg) {
    addPair(
      'sindresorhus__dot-prop',
      'tenant_quota_audit',
      pkg,
      'quota_audit.js',
      `import * as fs from 'node:fs';
import { getProperty } from './index.js';

export function run(tenantsDir, outPath) {
  const cap = Number(process.env.GLOBAL_MAX_QPS || 100);
  const flagged = [];
  for (const f of fs.readdirSync(tenantsDir).filter(x => x.endsWith('.json')).sort()) {
    const cfg = JSON.parse(fs.readFileSync(tenantsDir + '/' + f, 'utf8'));
    const qps = Number(getProperty(cfg, 'limits.api.qps', 0));
    if (qps > cap) flagged.push({ file: f, qps });
  }
  const res = { cap, flaggedCount: flagged.length, flagged };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`,
      'run',
      ['/workspace/tenants', '/workspace/quota_report.json'],
      {
        label: 'strict_cap_flags_tenant',
        files: {
          'tenants/acme.json': JSON.stringify({limits: {api: {qps: 250}}}),
          'tenants/beta.json': JSON.stringify({limits: {api: {qps: 40}}}),
        },
        env: {GLOBAL_MAX_QPS: '100'},
      },
      {
        label: 'high_cap_all_ok',
        files: {
          'tenants/acme.json': JSON.stringify({limits: {api: {qps: 250}}}),
          'tenants/beta.json': JSON.stringify({limits: {api: {qps: 40}}}),
        },
        env: {GLOBAL_MAX_QPS: '500'},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 21p. developit/redaxios POST telemetry + crypto.randomUUID()
  pkg = loadPkg('developit__redaxios', ['src/index.js']);
  if (pkg) {
    addPair(
      'developit__redaxios',
      'redaxios_post_events',
      pkg,
      'post_events.js',
      `const fs = require('fs');
const crypto = require('crypto');
const redaxios = require('./src/index.js');
const axios = redaxios.default || redaxios;

async function run(eventsPath, ingestUrl) {
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  if (events.length === 0) return { sent: false, count: 0 };
  const batchId = crypto.randomUUID();
  const resp = await axios.post(ingestUrl, { batchId, events }, { fetch: globalThis.fetch });
  return { sent: true, batchId, count: events.length, accepted: resp.data.accepted };
}
module.exports = { run };
`,
      'run',
      ['/workspace/events.json', `${baseUrl}/ingest`],
      {
        label: 'nonempty_batch_posted',
        files: {'events.json': JSON.stringify([{type: 'click'}, {type: 'submit'}])},
        env: {},
        httpRoutes: {'/ingest': {status: 200, body: JSON.stringify({accepted: 2})}},
      },
      {
        label: 'empty_queue_skipped',
        files: {'events.json': JSON.stringify([])},
        env: {},
        httpRoutes: {'/ingest': {status: 200, body: JSON.stringify({accepted: 0})}},
      },
      ['fs-io', 'http-io', 'uuid-io'],
    );
  }

  // 21q. krisk/Fuse + fs.readdirSync multi-file markdown title fuzzy search
  pkg = loadPkg('krisk__Fuse', ['src']);
  if (pkg) {
    addPair(
      'krisk__Fuse',
      'ts_fuse_dir_notes_search',
      pkg,
      'search_notes.ts',
      `import * as fs from 'node:fs';
import Fuse from './src/entry.ts';

export function run(notesDir: string, query: string) {
  const docs: Array<{ file: string; heading: string }> = [];
  for (const name of fs.readdirSync(notesDir).filter(f => f.endsWith('.md')).sort()) {
    const firstLine = fs.readFileSync(notesDir + '/' + name, 'utf8').split('\\n')[0].replace(/^#+\\s*/, '');
    docs.push({ file: name, heading: firstLine });
  }
  const fuse = new Fuse(docs, { keys: ['heading'], threshold: 0.4 });
  const matches = fuse.search(query).map(r => r.item.file);
  return { indexed: docs.length, matches };
}
`,
      'run',
      ['/workspace/notes', 'authentcation'],
      {
        label: 'auth_note_present',
        files: {
          'notes/01-auth.md': '# Authentication Flow\nDetails...',
          'notes/02-cache.md': '# Redis Caching\nDetails...',
        },
        env: {},
      },
      {
        label: 'only_unrelated_notes',
        files: {
          'notes/02-cache.md': '# Redis Caching\nDetails...',
          'notes/03-metrics.md': '# Prometheus Metrics\nDetails...',
        },
        env: {},
      },
      ['typescript', 'fs-io'],
    );
  }

  // 21r. lukeed/mri + child_process + fs binary readBytes checksum CLI
  pkg = loadPkg('lukeed__mri', ['src/index.js']);
  if (pkg) {
    addPair(
      'lukeed__mri',
      'mri_artifact_sha256_verify',
      pkg,
      'verify_sha.js',
      `const fs = require('fs');
const crypto = require('crypto');
const mriMod = require('./src/index.js');
const mri = mriMod.default || mriMod;

function run(argv) {
  const opts = mri(argv, { string: ['file', 'expected'] });
  const buf = fs.readFileSync(opts.file);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  const expected = process.env.EXPECTED_SHA || opts.expected || '';
  const match = actual === expected;
  if (!match) console.error('checksum mismatch for', opts.file);
  return { file: opts.file, bytes: buf.length, match, shaPrefix: actual.slice(0, 12) };
}
module.exports = { run };
`,
      'run',
      [['--file', '/workspace/artifact.bin']],
      {
        label: 'checksum_matches',
        files: {'artifact.bin': 'release-payload-v1'},
        env: {EXPECTED_SHA: createHash('sha256').update('release-payload-v1').digest('hex')},
      },
      {
        label: 'checksum_tampered_mismatch',
        files: {'artifact.bin': 'tampered-payload'},
        env: {EXPECTED_SHA: createHash('sha256').update('release-payload-v1').digest('hex')},
      },
      ['fs-io', 'env-io', 'console'],
    );
  }

  // 21s. lukeed/kleur + fs + env build summary logger
  pkg = loadPkg('lukeed__kleur', ['index.mjs', 'colors.mjs'], {renameMjsToJs: true});
  if (pkg) {
    addPair(
      'lukeed__kleur',
      'kleur_ci_banner_writer',
      pkg,
      'ci_banner.js',
      `import * as fs from 'node:fs';
import kleur from './index.js';

export function run(metaPath, outPath) {
  kleur.enabled = process.env.CI_COLOR === '1';
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const badge = meta.passed ? kleur.bold().green('OK') : kleur.bold().red('FAIL');
  const banner = badge + ' ' + meta.suite + ' (' + meta.tests + ' tests)';
  fs.writeFileSync(outPath, banner, 'utf8');
  return { color: kleur.enabled, passed: meta.passed, banner };
}
`,
      'run',
      ['/workspace/ci.json', '/workspace/banner.txt'],
      {
        label: 'colored_pass',
        files: {'ci.json': JSON.stringify({suite: 'unit', tests: 48, passed: true})},
        env: {CI_COLOR: '1'},
      },
      {
        label: 'plain_fail',
        files: {'ci.json': JSON.stringify({suite: 'unit', tests: 48, passed: false})},
        env: {CI_COLOR: '0'},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 21t. minimistjs/minimist + fs + env scaffold template generator
  pkg = loadPkg('minimistjs__minimist', ['index.js']);
  if (pkg) {
    addPair(
      'minimistjs__minimist',
      'minimist_scaffold_writer',
      pkg,
      'scaffold.js',
      `const fs = require('fs');
const minimist = require('./index.js');

function run(argv) {
  const args = minimist(argv, { string: ['name', 'out'], boolean: ['force'] });
  const target = args.out;
  const exists = fs.existsSync(target);
  const force = Boolean(args.force || process.env.SCAFFOLD_FORCE === '1');
  if (exists && !force) {
    console.warn('target exists, skipping:', target);
    return { written: false, target };
  }
  const pkgJson = { name: args.name, version: '0.1.0', private: true };
  fs.writeFileSync(target, JSON.stringify(pkgJson, null, 2), 'utf8');
  return { written: true, target, overwritten: exists };
}
module.exports = { run };
`,
      'run',
      [['--name', 'my-app', '--out', '/workspace/package.json']],
      {
        label: 'skip_existing_without_force',
        files: {'package.json': '{"name":"existing"}'},
        env: {},
      },
      {
        label: 'force_env_overwrites',
        files: {'package.json': '{"name":"existing"}'},
        env: {SCAFFOLD_FORCE: '1'},
      },
      ['fs-io', 'env-io', 'console'],
    );
  }

  // 21u-21z: Extra pairs across top repos to guarantee >= 120 verified JS/TS tasks!
  // 21u. eemeli/yaml + fs.readdirSync multi-service port conflict checker
  pkg = loadPkg('eemeli__yaml', ['src'], {excludeRe: /(?:\.test\.|\.spec\.|cli\.ts)/i});
  if (pkg) {
    addPair(
      'eemeli__yaml',
      'ts_yaml_port_conflict_check',
      pkg,
      'port_check.ts',
      `import * as fs from 'node:fs';
import { parse } from './src/index.ts';

export function run(dirPath: string, outPath: string) {
  const seen = new Map<number, string>();
  const conflicts: Array<{ port: number; a: string; b: string }> = [];
  for (const name of fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml')).sort()) {
    const doc = parse(fs.readFileSync(dirPath + '/' + name, 'utf8')) as { name: string; port: number };
    if (seen.has(doc.port)) {
      conflicts.push({ port: doc.port, a: seen.get(doc.port)!, b: doc.name });
      console.error('port conflict', doc.port, seen.get(doc.port), doc.name);
    } else {
      seen.set(doc.port, doc.name);
    }
  }
  const res = { ok: conflicts.length === 0, conflicts };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`,
      'run',
      ['/workspace/services', '/workspace/ports.json'],
      {
        label: 'conflict_detected',
        files: {
          'services/api.yaml': 'name: api\nport: 8080\n',
          'services/worker.yaml': 'name: worker\nport: 8080\n',
        },
        env: {},
      },
      {
        label: 'distinct_ports_ok',
        files: {
          'services/api.yaml': 'name: api\nport: 8080\n',
          'services/worker.yaml': 'name: worker\nport: 8081\n',
        },
        env: {},
      },
      ['typescript', 'fs-io', 'console'],
    );
  }

  // 21v. microsoft/node-jsonc-parser + fs + env feature toggles
  pkg = loadPkg('microsoft__node-jsonc-parser', ['src']);
  if (pkg) {
    addPair(
      'microsoft__node-jsonc-parser',
      'ts_jsonc_env_overlay',
      pkg,
      'jsonc_overlay.ts',
      `import * as fs from 'node:fs';
import { parse } from './src/main.ts';

export function run(cfgPath: string, outPath: string) {
  const cfg = parse(fs.readFileSync(cfgPath, 'utf8'));
  const region = process.env.REGION || 'us';
  const endpoint = cfg.regions?.[region] || cfg.defaultEndpoint;
  const res = { region, endpoint, timeoutMs: cfg.timeoutMs };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`,
      'run',
      ['/workspace/endpoints.jsonc', '/workspace/endpoint.json'],
      {
        label: 'eu_region_hit',
        files: {'endpoints.jsonc': '{\n  // regional routing\n  "defaultEndpoint": "https://us.api.io",\n  "timeoutMs": 3000,\n  "regions": { "eu": "https://eu.api.io" }\n}\n'},
        env: {REGION: 'eu'},
      },
      {
        label: 'apac_default_fallback',
        files: {'endpoints.jsonc': '{\n  // regional routing\n  "defaultEndpoint": "https://us.api.io",\n  "timeoutMs": 3000,\n  "regions": { "eu": "https://eu.api.io" }\n}\n'},
        env: {REGION: 'apac'},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 21w. markedjs/marked + fs.existsSync header/footer layout composer
  pkg = loadPkg('markedjs__marked', ['src']);
  if (pkg) {
    addPair(
      'markedjs__marked',
      'ts_marked_layout_wrap',
      pkg,
      'layout_md.ts',
      `import * as fs from 'node:fs';
import { marked } from './src/marked.ts';

export function run(mdPath: string, headerPath: string, outPath: string) {
  const body = marked.parse(fs.readFileSync(mdPath, 'utf8'), { async: false }) as string;
  const hasHeader = fs.existsSync(headerPath);
  const header = hasHeader ? fs.readFileSync(headerPath, 'utf8') : '<header>Default</header>';
  const full = header + '\\n' + body;
  fs.writeFileSync(outPath, full, 'utf8');
  return { hasHeader, bytes: full.length };
}
`,
      'run',
      ['/workspace/page.md', '/workspace/header.html', '/workspace/page.html'],
      {
        label: 'custom_header_present',
        files: {
          'page.md': '## FAQ\n\nAnswer here.\n',
          'header.html': '<header>Acme Docs</header>',
        },
        env: {},
      },
      {
        label: 'default_header_used',
        files: {
          'page.md': '## FAQ\n\nAnswer here.\n',
        },
        env: {},
      },
      ['typescript', 'fs-io'],
    );
  }

  // 21x. typicode/lowdb + crypto.randomUUID() + env audit trail
  pkg = loadPkg('typicode__lowdb', ['src/core/Low.ts', 'src/adapters/Memory.ts']);
  if (pkg) {
    addPair(
      'typicode__lowdb',
      'ts_lowdb_task_queue',
      pkg,
      'task_queue.ts',
      `import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { LowSync, type SyncAdapter } from './src/core/Low.ts';

class FsJsonAdapter<T> implements SyncAdapter<T> {
  file: string;
  constructor(file: string) { this.file = file; }
  read(): T | null {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
  }
  write(data: T): void {
    fs.writeFileSync(this.file, JSON.stringify(data), 'utf8');
  }
}

export function run(dbPath: string, kind: string) {
  const db = new LowSync<{ jobs: Array<{ id: string; kind: string; status: string }> }>(new FsJsonAdapter(dbPath), { jobs: [] });
  db.read();
  const maxQueue = Number(process.env.MAX_QUEUE || 2);
  const pending = db.data.jobs.filter(j => j.status === 'pending').length;
  if (pending >= maxQueue) {
    console.warn('queue full:', pending);
    return { enqueued: false, pending };
  }
  const id = crypto.randomUUID();
  db.data.jobs.push({ id, kind, status: 'pending' });
  db.write();
  return { enqueued: true, id, pending: pending + 1 };
}
`,
      'run',
      ['/workspace/queue.json', 'reindex'],
      {
        label: 'queue_accepts_job',
        files: {'queue.json': JSON.stringify({jobs: [{id: 'j0', kind: 'email', status: 'pending'}]})},
        env: {MAX_QUEUE: '3'},
      },
      {
        label: 'queue_full_rejects',
        files: {'queue.json': JSON.stringify({jobs: [{id: 'j0', kind: 'email', status: 'pending'}, {id: 'j1', kind: 'sync', status: 'pending'}]})},
        env: {MAX_QUEUE: '2'},
      },
      ['typescript', 'fs-io', 'env-io', 'uuid-io', 'console'],
    );
  }

  // 21y. unjs/confbox + ini + env write-back
  pkg = loadPkg('unjs__confbox', ['src']);
  if (pkg) {
    addPair(
      'unjs__confbox',
      'ts_confbox_ini_patch',
      pkg,
      'ini_patch.ts',
      `import * as fs from 'node:fs';
import { parseINI, stringifyINI } from './src/index.ts';

export function run(iniPath: string) {
  const data = parseINI(fs.readFileSync(iniPath, 'utf8')) as Record<string, any>;
  const mode = process.env.CACHE_MODE || 'memory';
  data.cache = data.cache || {};
  data.cache.mode = mode;
  fs.writeFileSync(iniPath, stringifyINI(data), 'utf8');
  return { mode, sections: Object.keys(data).sort() };
}
`,
      'run',
      ['/workspace/cache.ini'],
      {
        label: 'redis_mode_set',
        files: {'cache.ini': '[cache]\nmode=memory\nttl=60\n'},
        env: {CACHE_MODE: 'redis'},
      },
      {
        label: 'default_memory_mode',
        files: {'cache.ini': '[cache]\nttl=60\n'},
        env: {},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 21z. kpdecker/jsdiff + fs/promises async 2-file compare
  pkg = loadPkg('kpdecker__jsdiff', ['src']);
  if (pkg) {
    addPair(
      'kpdecker__jsdiff',
      'ts_async_json_diff',
      pkg,
      'json_diff.ts',
      `import * as fsp from 'node:fs/promises';
import { diffJson } from './src/index.ts';

export async function run(aPath: string, bPath: string, outPath: string) {
  const a = JSON.parse(await fsp.readFile(aPath, 'utf8'));
  const b = JSON.parse(await fsp.readFile(bPath, 'utf8'));
  const parts = diffJson(a, b);
  const changed = parts.some(p => p.added || p.removed);
  const summary = { changed, chunks: parts.length };
  await fsp.writeFile(outPath, JSON.stringify(summary), 'utf8');
  return summary;
}
`,
      'run',
      ['/workspace/a.json', '/workspace/b.json', '/workspace/diff.json'],
      {
        label: 'json_changed',
        files: {
          'a.json': JSON.stringify({host: 'a', port: 80, tls: false}),
          'b.json': JSON.stringify({host: 'a', port: 443, tls: true}),
        },
        env: {},
      },
      {
        label: 'json_equal',
        files: {
          'a.json': JSON.stringify({host: 'a', port: 80}),
          'b.json': JSON.stringify({port: 80, host: 'a'}),
        },
        env: {},
      },
      ['typescript', 'fs-io', 'async'],
    );
  }

  // Additional 12 pairs across diverse repos to push JS/TS well past 110+ tasks!
  // 22. motdotla/dotenv + fs.readdirSync multi-env validator
  pkg = loadPkg('motdotla__dotenv', ['lib/main.js', 'lib/config-options.js']);
  if (pkg) {
    addPair(
      'motdotla__dotenv',
      'dotenv_dir_key_matrix',
      pkg,
      'env_matrix.js',
      `const fs = require('fs');
const dotenv = require('./lib/main.js');

function run(dirPath, requiredKey) {
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.env')).sort();
  const missingIn = [];
  for (const f of files) {
    const parsed = dotenv.parse(fs.readFileSync(dirPath + '/' + f, 'utf8'));
    if (!parsed[requiredKey]) missingIn.push(f);
  }
  return { files, missingIn, ok: missingIn.length === 0 };
}
module.exports = { run };
`,
      'run',
      ['/workspace/envs', 'SENTRY_DSN'],
      {
        label: 'one_env_missing_dsn',
        files: {
          'envs/dev.env': 'SENTRY_DSN=https://dev\n',
          'envs/prod.env': 'LOG_LEVEL=info\n',
        },
        env: {},
      },
      {
        label: 'all_envs_have_dsn',
        files: {
          'envs/dev.env': 'SENTRY_DSN=https://dev\n',
          'envs/prod.env': 'SENTRY_DSN=https://prod\n',
        },
        env: {},
      },
      ['fs-io'],
    );
  }

  // 23. kaelzhang/node-ignore + env extra patterns
  pkg = loadPkg('kaelzhang__node_ignore', ['index.js']);
  if (pkg) {
    addPair(
      'kaelzhang__node-ignore',
      'ignore_with_env_extra_rules',
      pkg,
      'env_ignore.js',
      `const fs = require('fs');
const ignore = require('./index.js');

function run(dirPath) {
  const ig = ignore().add(fs.readFileSync(dirPath + '/.ignore', 'utf8'));
  const extra = process.env.EXTRA_IGNORE;
  if (extra) ig.add(extra.split(','));
  const entries = fs.readdirSync(dirPath).filter(f => f !== '.ignore').sort();
  return { kept: ig.filter(entries), ignored: entries.filter(f => ig.ignores(f)) };
}
module.exports = { run };
`,
      'run',
      ['/workspace/proj'],
      {
        label: 'extra_env_ignores_maps',
        files: {'proj/.ignore': '*.tmp\n', 'proj/a.js': '1', 'proj/a.js.map': '2', 'proj/x.tmp': '3'},
        env: {EXTRA_IGNORE: '*.map'},
      },
      {
        label: 'no_extra_keeps_maps',
        files: {'proj/.ignore': '*.tmp\n', 'proj/a.js': '1', 'proj/a.js.map': '2', 'proj/x.tmp': '3'},
        env: {},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 24. nodeca/js-yaml + env + crypto.randomUUID() release record
  pkg = loadPkg('nodeca__js-yaml', ['src']);
  if (pkg) {
    addPair(
      'nodeca__js-yaml',
      'jsyaml_deploy_ticket',
      pkg,
      'deploy_ticket.ts',
      `import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { load, dump } from './src/index.ts';

export function run(specPath: string, outPath: string) {
  const spec = load(fs.readFileSync(specPath, 'utf8')) as any;
  const dryRun = process.env.DRY_RUN === '1';
  const ticket = {
    id: crypto.randomUUID(),
    app: spec.app,
    version: spec.version,
    dryRun,
  };
  if (!dryRun) {
    fs.writeFileSync(outPath, dump(ticket), 'utf8');
  }
  return ticket;
}
`,
      'run',
      ['/workspace/spec.yaml', '/workspace/ticket.yaml'],
      {
        label: 'live_ticket_written',
        files: {'spec.yaml': 'app: billing\nversion: 3.1.0\n'},
        env: {DRY_RUN: '0'},
      },
      {
        label: 'dry_run_not_written',
        files: {'spec.yaml': 'app: billing\nversion: 3.1.0\n'},
        env: {DRY_RUN: '1'},
      },
      ['fs-io', 'env-io', 'uuid-io'],
    );
  }

  // 25. npm/ini + fetch() remote ini sync
  pkg = loadPkg('npm__ini', ['lib/ini.js']);
  if (pkg) {
    addPair(
      'npm__ini',
      'ini_remote_sync',
      pkg,
      'ini_remote.js',
      `const fs = require('fs');
const ini = require('./lib/ini.js');

async function run(url, localPath) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const local = ini.parse(fs.readFileSync(localPath, 'utf8'));
    return { source: 'local', host: local.server.host };
  }
  const text = await resp.text();
  const parsed = ini.parse(text);
  fs.writeFileSync(localPath, ini.stringify(parsed), 'utf8');
  return { source: 'remote', host: parsed.server.host };
}
module.exports = { run };
`,
      'run',
      [`${baseUrl}/server.ini`, '/workspace/server.ini'],
      {
        label: 'remote_200_overrides',
        files: {'server.ini': '[server]\nhost=local.dev\n'},
        env: {},
        httpRoutes: {'/server.ini': {status: 200, headers: {'content-type': 'text/plain'}, body: '[server]\nhost=edge.prod\n'}},
      },
      {
        label: 'remote_503_keeps_local',
        files: {'server.ini': '[server]\nhost=local.dev\n'},
        env: {},
        httpRoutes: {'/server.ini': {status: 503, headers: {'content-type': 'text/plain'}, body: 'down'}},
      },
      ['http-io', 'fs-io'],
    );
  }

  // 26. cacjs/cac + fs/promises async linter config check
  pkg = loadPkg('cacjs__cac', ['src']);
  if (pkg) {
    addPair(
      'cacjs__cac',
      'ts_cac_async_stats',
      pkg,
      'stat_cli.ts',
      `import * as fsp from 'node:fs/promises';
import { cac } from './src/index.ts';

export async function run(argv: string[]) {
  const cli = cac('sizer');
  cli.option('--dir <dir>', 'target directory', { default: '/workspace/data' });
  const parsed = cli.parse(['node', 'sizer', ...argv], { run: false });
  const dir: string = parsed.options.dir;
  const names = (await fsp.readdir(dir)).sort();
  let total = 0;
  for (const n of names) {
    const st = await fsp.stat(dir + '/' + n);
    if (st.isFile()) total += st.size;
  }
  return { dir, fileCount: names.length, totalBytes: total };
}
`,
      'run',
      [['--dir', '/workspace/data']],
      {
        label: 'two_data_files',
        files: {'data/a.txt': 'hello', 'data/b.txt': 'world!'},
        env: {},
      },
      {
        label: 'single_small_file',
        files: {'data/a.txt': 'hi'},
        env: {},
      },
      ['typescript', 'fs-io', 'async'],
    );
  }

  // 27. tj/commander.js + Date.now() + crypto.randomUUID() audit log CLI
  pkg = loadPkg('tj__commander.js', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'tj__commander.js',
      'commander_audit_append',
      pkg,
      'audit_cli.js',
      `const fs = require('fs');
const crypto = require('crypto');
const { Command } = require('./index.js');

function run(argv) {
  const cmd = new Command();
  cmd.exitOverride().option('-f, --file <path>', 'log file').option('-m, --msg <text>', 'message');
  cmd.parse(argv, { from: 'user' });
  const opts = cmd.opts();
  const existing = fs.existsSync(opts.file) ? JSON.parse(fs.readFileSync(opts.file, 'utf8')) : [];
  const entry = { id: crypto.randomUUID(), ts: Date.now(), actor: process.env.ACTOR || 'system', msg: opts.msg };
  existing.push(entry);
  fs.writeFileSync(opts.file, JSON.stringify(existing), 'utf8');
  return { count: existing.length, actor: entry.actor, id: entry.id };
}
module.exports = { run };
`,
      'run',
      [['-f', '/workspace/audit.json', '-m', 'deploy_complete']],
      {
        label: 'append_with_actor',
        files: {'audit.json': JSON.stringify([{id: 'old', ts: 1, actor: 'ci', msg: 'init'}])},
        env: {ACTOR: 'release-bot'},
      },
      {
        label: 'create_new_default_actor',
        files: {'.keep': ''},
        env: {},
      },
      ['fs-io', 'env-io', 'time-io', 'uuid-io'],
    );
  }

  // 28. moment/luxon + child_process git log timestamp check
  pkg = loadPkg('moment__luxon', ['src']);
  if (pkg) {
    addPair(
      'moment__luxon',
      'luxon_schedule_window',
      pkg,
      'sched_window.js',
      `import * as fs from 'node:fs';
import { DateTime } from './src/luxon.js';

export function run(winPath) {
  const now = DateTime.fromMillis(Date.now(), { zone: 'utc' });
  const win = JSON.parse(fs.readFileSync(winPath, 'utf8'));
  const start = DateTime.fromISO(win.start, { zone: 'utc' });
  const end = DateTime.fromISO(win.end, { zone: 'utc' });
  const inWindow = now >= start && now <= end;
  const override = process.env.FORCE_DEPLOY === '1';
  return { inWindow, allowed: !inWindow || override, override };
}
`,
      'run',
      ['/workspace/freeze.json'],
      {
        label: 'inside_freeze_blocked',
        files: {'freeze.json': JSON.stringify({start: '2024-03-09T00:00:00Z', end: '2024-03-10T00:00:00Z'})},
        env: {},
      },
      {
        label: 'inside_freeze_force_allowed',
        files: {'freeze.json': JSON.stringify({start: '2024-03-09T00:00:00Z', end: '2024-03-10T00:00:00Z'})},
        env: {FORCE_DEPLOY: '1'},
      },
      ['fs-io', 'env-io', 'time-io'],
    );
  }

  // 29. sindresorhus/dot-prop + fetch() remote feature flag merge
  pkg = loadPkg('sindresorhus__dot-prop', ['index.js']);
  if (pkg) {
    addPair(
      'sindresorhus__dot-prop',
      'dotprop_remote_override',
      pkg,
      'remote_dot.js',
      `import * as fs from 'node:fs';
import { getProperty, setProperty } from './index.js';

export async function run(cfgPath, url) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const resp = await fetch(url);
  if (resp.ok) {
    const patch = await resp.json();
    for (const [path, val] of Object.entries(patch)) {
      setProperty(cfg, path, val);
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');
  }
  return { retries: getProperty(cfg, 'http.retries'), timeout: getProperty(cfg, 'http.timeout') };
}
`,
      'run',
      ['/workspace/client.json', `${baseUrl}/overrides`],
      {
        label: 'remote_200_patched',
        files: {'client.json': JSON.stringify({http: {retries: 1, timeout: 1000}})},
        env: {},
        httpRoutes: {'/overrides': {status: 200, body: JSON.stringify({'http.retries': 5, 'http.timeout': 4000})}},
      },
      {
        label: 'remote_404_unchanged',
        files: {'client.json': JSON.stringify({http: {retries: 1, timeout: 1000}})},
        env: {},
        httpRoutes: {'/overrides': {status: 404, body: JSON.stringify({error: 'none'})}},
      },
      ['fs-io', 'http-io'],
    );
  }

  // 30. lukeed/mri + fs.readdirSync + console
  pkg = loadPkg('lukeed__mri', ['src/index.js']);
  if (pkg) {
    addPair(
      'lukeed__mri',
      'mri_ext_counter_cli',
      pkg,
      'ext_count.js',
      `const fs = require('fs');
const mriMod = require('./src/index.js');
const mri = mriMod.default || mriMod;

function run(argv) {
  const opts = mri(argv, { default: { dir: '/workspace/files', ext: '.js' } });
  const ext = process.env.FILTER_EXT || opts.ext;
  const all = fs.readdirSync(opts.dir).sort();
  const matched = all.filter(f => f.endsWith(ext));
  console.info('matched', matched.length, 'of', all.length);
  return { ext, total: all.length, matched };
}
module.exports = { run };
`,
      'run',
      [['--dir', '/workspace/files', '--ext', '.js']],
      {
        label: 'default_js_filter',
        files: {'files/a.js': '1', 'files/b.ts': '2', 'files/c.js': '3'},
        env: {},
      },
      {
        label: 'env_ts_filter',
        files: {'files/a.js': '1', 'files/b.ts': '2', 'files/c.js': '3'},
        env: {FILTER_EXT: '.ts'},
      },
      ['fs-io', 'env-io', 'console'],
    );
  }

  // 31. minimistjs/minimist + fetch() + fs JSON download
  pkg = loadPkg('minimistjs__minimist', ['index.js']);
  if (pkg) {
    addPair(
      'minimistjs__minimist',
      'minimist_http_fetch_cli',
      pkg,
      'fetch_cli.js',
      `const fs = require('fs');
const minimist = require('./index.js');

async function run(argv) {
  const args = minimist(argv, { string: ['url', 'out'] });
  const resp = await fetch(args.url);
  if (!resp.ok) return { saved: false, status: resp.status };
  const data = await resp.json();
  fs.writeFileSync(args.out, JSON.stringify(data), 'utf8');
  return { saved: true, keys: Object.keys(data).sort() };
}
module.exports = { run };
`,
      'run',
      [['--url', `${baseUrl}/meta`, '--out', '/workspace/meta.json']],
      {
        label: 'http_200_saved',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/meta': {status: 200, body: JSON.stringify({version: '5.1', sha: 'abc123'})}},
      },
      {
        label: 'http_500_not_saved',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/meta': {status: 500, body: JSON.stringify({error: 'boom'})}},
      },
      ['http-io', 'fs-io'],
    );
  }

  // 32. lukeed/kleur + child_process git status colorizer
  pkg = loadPkg('lukeed__kleur', ['index.mjs', 'colors.mjs'], {renameMjsToJs: true});
  if (pkg) {
    addPair(
      'lukeed__kleur',
      'kleur_git_status_summary',
      pkg,
      'git_color.js',
      `import * as cp from 'node:child_process';
import kleur from './index.js';

export function run() {
  kleur.enabled = !process.env.NO_COLOR;
  const out = cp.execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
  const lines = out.split('\\n').map(s => s.trim()).filter(Boolean);
  const label = lines.length === 0 ? kleur.green('CLEAN') : kleur.yellow('DIRTY:' + lines.length);
  console.log(label);
  return { clean: lines.length === 0, count: lines.length, label };
}
`,
      'run',
      [],
      {
        label: 'clean_green',
        files: {'index.js': 'export const a = 1;'},
        initGit: true,
        env: {},
      },
      {
        label: 'dirty_no_color',
        files: {'index.js': 'export const a = 1;'},
        postGitWrites: {'extra.js': 'export const b = 2;'},
        initGit: true,
        env: {NO_COLOR: '1'},
      },
      ['shell-exec', 'env-io', 'console'],
    );
  }

  // 33. micromatch/picomatch + fs/promises async matcher
  pkg = loadPkg('micromatch__picomatch', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'micromatch__picomatch',
      'picomatch_async_filter',
      pkg,
      'async_glob.js',
      `const fsp = require('fs/promises');
const picomatch = require('./index.js');

async function run(dirPath, glob) {
  const isMatch = picomatch(glob);
  const entries = (await fsp.readdir(dirPath)).sort();
  const kept = entries.filter(e => isMatch(e));
  return { glob, total: entries.length, kept };
}
module.exports = { run };
`,
      'run',
      ['/workspace/tests', '*.test.js'],
      {
        label: 'two_test_files',
        files: {'tests/a.test.js': '1', 'tests/b.test.js': '2', 'tests/helper.js': '3'},
        env: {},
      },
      {
        label: 'zero_test_files',
        files: {'tests/helper.js': '3', 'tests/fixture.json': '{}'},
        env: {},
      },
      ['fs-io', 'async'],
    );
  }

  // 34. developit/redaxios + env base url + retry once on 503
  pkg = loadPkg('developit__redaxios', ['src/index.js']);
  if (pkg) {
    addPair(
      'developit__redaxios',
      'redaxios_env_endpoint_client',
      pkg,
      'env_client.js',
      `const redaxios = require('./src/index.js');
const axios = redaxios.default || redaxios;

async function run(baseUrl) {
  const path = process.env.HEALTH_PATH || '/healthz';
  const resp = await axios.get(baseUrl + path, { fetch: globalThis.fetch });
  return { path, status: resp.status, ok: Boolean(resp.data.ok) };
}
module.exports = { run };
`,
      'run',
      [baseUrl],
      {
        label: 'default_healthz',
        files: {},
        env: {},
        httpRoutes: {'/healthz': {status: 200, body: JSON.stringify({ok: true})}},
      },
      {
        label: 'env_readyz',
        files: {},
        env: {HEALTH_PATH: '/readyz'},
        httpRoutes: {'/readyz': {status: 200, body: JSON.stringify({ok: false})}},
      },
      ['http-io', 'env-io'],
    );
  }

  // 35. krisk/Fuse + fetch() remote docs search
  pkg = loadPkg('krisk__Fuse', ['src']);
  if (pkg) {
    addPair(
      'krisk__Fuse',
      'ts_fuse_remote_index',
      pkg,
      'remote_search.ts',
      `import * as fs from 'node:fs';
import Fuse from './src/entry.ts';

export async function run(indexUrl: string, query: string, outPath: string) {
  const resp = await fetch(indexUrl);
  const docs = (await resp.json()) as Array<{ id: string; title: string }>;
  const fuse = new Fuse(docs, { keys: ['title'], threshold: 0.35 });
  const ids = fuse.search(query).map(r => r.item.id);
  fs.writeFileSync(outPath, JSON.stringify({ query, ids }), 'utf8');
  return { count: ids.length, ids };
}
`,
      'run',
      [`${baseUrl}/docs.json`, 'observability', '/workspace/hits.json'],
      {
        label: 'match_found_remote',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {
          '/docs.json': {
            status: 200,
            body: JSON.stringify([
              {id: 'd1', title: 'Observability and Tracing'},
              {id: 'd2', title: 'Billing Invoices'},
            ]),
          },
        },
      },
      {
        label: 'no_match_remote',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {
          '/docs.json': {
            status: 200,
            body: JSON.stringify([
              {id: 'd2', title: 'Billing Invoices'},
              {id: 'd3', title: 'Frontend Routing'},
            ]),
          },
        },
      },
      ['typescript', 'http-io', 'fs-io'],
    );
  }

  // 36-50: Add 15 more high-signal pairs across our real OSS repos (hitting ~120-130 JS/TS tasks!)
  // 36. markedjs/marked + fs.statSync size-limited render
  pkg = loadPkg('markedjs__marked', ['src']);
  if (pkg) {
    addPair(
      'markedjs__marked',
      'ts_marked_size_guard',
      pkg,
      'size_guard_md.ts',
      `import * as fs from 'node:fs';
import { marked } from './src/marked.ts';

export function run(mdPath: string) {
  const st = fs.statSync(mdPath);
  const limit = Number(process.env.MAX_MD_BYTES || 100);
  if (st.size > limit) {
    console.warn('markdown too large:', st.size);
    return { rendered: false, size: st.size, limit };
  }
  const html = marked.parse(fs.readFileSync(mdPath, 'utf8'), { async: false }) as string;
  return { rendered: true, size: st.size, html };
}
`,
      'run',
      ['/workspace/post.md'],
      {
        label: 'within_limit_rendered',
        files: {'post.md': '# Hi\n\nShort post.\n'},
        env: {MAX_MD_BYTES: '100'},
      },
      {
        label: 'exceeds_limit_rejected',
        files: {'post.md': '# Hi\n\n' + 'long content '.repeat(12) + '\n'},
        env: {MAX_MD_BYTES: '50'},
      },
      ['typescript', 'fs-io', 'env-io', 'console'],
    );
  }

  // 37. unjs/confbox + fetch() remote TOML config
  pkg = loadPkg('unjs__confbox', ['src']);
  if (pkg) {
    addPair(
      'unjs__confbox',
      'ts_confbox_remote_toml',
      pkg,
      'remote_toml.ts',
      `import * as fs from 'node:fs';
import { parseTOML, stringifyJSON } from './src/index.ts';

export async function run(url: string, outPath: string) {
  const resp = await fetch(url);
  if (!resp.ok) return { ok: false, status: resp.status };
  const parsed = parseTOML(await resp.text()) as Record<string, any>;
  fs.writeFileSync(outPath, stringifyJSON(parsed), 'utf8');
  return { ok: true, sections: Object.keys(parsed).sort() };
}
`,
      'run',
      [`${baseUrl}/app.toml`, '/workspace/app.json'],
      {
        label: 'toml_200_converted',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/app.toml': {status: 200, headers: {'content-type': 'text/plain'}, body: '[app]\nname = "edge"\n[db]\npool = 4\n'}},
      },
      {
        label: 'toml_404_error',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/app.toml': {status: 404, headers: {'content-type': 'text/plain'}, body: 'missing'}},
      },
      ['typescript', 'http-io', 'fs-io'],
    );
  }

  // 38. microsoft/node-jsonc-parser + crypto.randomUUID() + Date.now() snapshot
  pkg = loadPkg('microsoft__node-jsonc-parser', ['src']);
  if (pkg) {
    addPair(
      'microsoft__node-jsonc-parser',
      'ts_jsonc_snapshot_stamp',
      pkg,
      'stamp_jsonc.ts',
      `import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { parse } from './src/main.ts';

export function run(inPath: string, outPath: string) {
  const cfg = parse(fs.readFileSync(inPath, 'utf8'));
  const snap = { id: crypto.randomUUID(), ts: Date.now(), env: process.env.ENV || 'dev', cfg };
  fs.writeFileSync(outPath, JSON.stringify(snap), 'utf8');
  return { id: snap.id, env: snap.env, keys: Object.keys(cfg || {}).sort() };
}
`,
      'run',
      ['/workspace/in.jsonc', '/workspace/snap.json'],
      {
        label: 'prod_snapshot',
        files: {'in.jsonc': '{\n  // prod\n  "workers": 8,\n  "cache": true\n}\n'},
        env: {ENV: 'prod'},
      },
      {
        label: 'dev_snapshot',
        files: {'in.jsonc': '{\n  // dev\n  "workers": 1\n}\n'},
        env: {},
      },
      ['typescript', 'fs-io', 'env-io', 'time-io', 'uuid-io'],
    );
  }

  // 39. typicode/lowdb + env quota filter + Date.now()
  pkg = loadPkg('typicode__lowdb', ['src/core/Low.ts', 'src/adapters/Memory.ts']);
  if (pkg) {
    addPair(
      'typicode__lowdb',
      'ts_lowdb_prune_expired',
      pkg,
      'prune_db.ts',
      `import * as fs from 'node:fs';
import { LowSync, type SyncAdapter } from './src/core/Low.ts';

class FsJsonAdapter<T> implements SyncAdapter<T> {
  file: string;
  constructor(file: string) { this.file = file; }
  read(): T | null {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
  }
  write(data: T): void {
    fs.writeFileSync(this.file, JSON.stringify(data), 'utf8');
  }
}

export function run(dbPath: string) {
  const now = Date.now();
  const db = new LowSync<{ tokens: Array<{ id: string; exp: number }> }>(new FsJsonAdapter(dbPath), { tokens: [] });
  db.read();
  const before = db.data.tokens.length;
  db.data.tokens = db.data.tokens.filter(t => t.exp > now);
  const removed = before - db.data.tokens.length;
  if (removed > 0) db.write();
  return { before, after: db.data.tokens.length, removed };
}
`,
      'run',
      ['/workspace/tokens.json'],
      {
        label: 'prunes_two_expired',
        files: {
          'tokens.json': JSON.stringify({
            tokens: [
              {id: 't1', exp: 1700000000000},
              {id: 't2', exp: 1705000000000},
              {id: 't3', exp: 1900000000000},
            ],
          }),
        },
        env: {},
      },
      {
        label: 'none_expired_noop',
        files: {
          'tokens.json': JSON.stringify({
            tokens: [{id: 't3', exp: 1900000000000}],
          }),
        },
        env: {},
      },
      ['typescript', 'fs-io', 'time-io'],
    );
  }

  // 40. eemeli/yaml + child_process git tag stamp
  pkg = loadPkg('eemeli__yaml', ['src'], {excludeRe: /(?:\.test\.|\.spec\.|cli\.ts)/i});
  if (pkg) {
    addPair(
      'eemeli__yaml',
      'ts_yaml_git_manifest',
      pkg,
      'git_yaml.ts',
      `import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { parse, stringify } from './src/index.ts';

export function run(manifestPath: string) {
  const doc = parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  const status = cp.execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim();
  doc.clean = status.length === 0;
  fs.writeFileSync(manifestPath, stringify(doc), 'utf8');
  return { name: doc.name, clean: doc.clean };
}
`,
      'run',
      ['/workspace/chart.yaml'],
      {
        label: 'clean_chart',
        files: {'chart.yaml': 'name: web\nversion: 1.0.0\n'},
        initGit: true,
        env: {},
      },
      {
        label: 'dirty_chart',
        files: {'chart.yaml': 'name: web\nversion: 1.0.0\n'},
        postGitWrites: {'extra.txt': 'untracked'},
        initGit: true,
        env: {},
      },
      ['typescript', 'fs-io', 'shell-exec'],
    );
  }

  // 41. kpdecker/jsdiff + env ignoreCase toggle
  pkg = loadPkg('kpdecker__jsdiff', ['src']);
  if (pkg) {
    addPair(
      'kpdecker__jsdiff',
      'ts_word_diff_env_case',
      pkg,
      'word_diff.ts',
      `import * as fs from 'node:fs';
import { diffWords } from './src/index.ts';

export function run(aPath: string, bPath: string) {
  const ignoreCase = process.env.DIFF_IGNORE_CASE === '1';
  const a = fs.readFileSync(aPath, 'utf8');
  const b = fs.readFileSync(bPath, 'utf8');
  const parts = diffWords(a, b, { ignoreCase });
  const changed = parts.some(p => p.added || p.removed);
  return { ignoreCase, changed, parts: parts.length };
}
`,
      'run',
      ['/workspace/a.txt', '/workspace/b.txt'],
      {
        label: 'case_sensitive_differs',
        files: {'a.txt': 'Hello World', 'b.txt': 'hello world'},
        env: {DIFF_IGNORE_CASE: '0'},
      },
      {
        label: 'case_insensitive_equal',
        files: {'a.txt': 'Hello World', 'b.txt': 'hello world'},
        env: {DIFF_IGNORE_CASE: '1'},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 42. nodeca/js-yaml + fs.existsSync default config seeder
  pkg = loadPkg('nodeca__js-yaml', ['src']);
  if (pkg) {
    addPair(
      'nodeca__js-yaml',
      'jsyaml_bootstrap_config',
      pkg,
      'boot_yaml.ts',
      `import * as fs from 'node:fs';
import { load, dump } from './src/index.ts';

export function run(cfgPath: string) {
  if (fs.existsSync(cfgPath)) {
    const cfg = load(fs.readFileSync(cfgPath, 'utf8'));
    return { seeded: false, cfg };
  }
  const defaults = { env: process.env.APP_ENV || 'dev', port: 3000 };
  fs.writeFileSync(cfgPath, dump(defaults), 'utf8');
  return { seeded: true, cfg: defaults };
}
`,
      'run',
      ['/workspace/app.yaml'],
      {
        label: 'disk_config_loaded',
        files: {'app.yaml': 'env: prod\nport: 8443\n'},
        env: {},
      },
      {
        label: 'missing_seeded_from_env',
        files: {'.keep': ''},
        env: {APP_ENV: 'staging'},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 43. npm/ini + crypto.randomBytes() token seeder
  pkg = loadPkg('npm__ini', ['lib/ini.js']);
  if (pkg) {
    addPair(
      'npm__ini',
      'ini_secret_token_seeder',
      pkg,
      'ini_token.js',
      `const fs = require('fs');
const crypto = require('crypto');
const ini = require('./lib/ini.js');

function run(iniPath) {
  const cfg = ini.parse(fs.readFileSync(iniPath, 'utf8'));
  if (!cfg.auth || !cfg.auth.token) {
    cfg.auth = cfg.auth || {};
    cfg.auth.token = crypto.randomUUID();
    fs.writeFileSync(iniPath, ini.stringify(cfg), 'utf8');
    return { rotated: true, token: cfg.auth.token };
  }
  return { rotated: false, token: cfg.auth.token };
}
module.exports = { run };
`,
      'run',
      ['/workspace/creds.ini'],
      {
        label: 'missing_token_generated',
        files: {'creds.ini': '[auth]\nuser=svc\n'},
        env: {},
      },
      {
        label: 'existing_token_preserved',
        files: {'creds.ini': '[auth]\nuser=svc\ntoken=tok-existing-1\n'},
        env: {},
      },
      ['fs-io', 'uuid-io'],
    );
  }

  // 44. sindresorhus/dot-prop + fs/promises async multi-key extractor
  pkg = loadPkg('sindresorhus__dot-prop', ['index.js']);
  if (pkg) {
    addPair(
      'sindresorhus__dot-prop',
      'dotprop_async_extract',
      pkg,
      'extract_dot.js',
      `import * as fsp from 'node:fs/promises';
import { getProperty } from './index.js';

export async function run(filePath, paths) {
  const data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  const out = {};
  for (const p of paths) {
    out[p] = getProperty(data, p, null);
  }
  return out;
}
`,
      'run',
      ['/workspace/pkg.json', ['name', 'config.port', 'config.tls']],
      {
        label: 'all_paths_present',
        files: {'pkg.json': JSON.stringify({name: 'api', config: {port: 8080, tls: true}})},
        env: {},
      },
      {
        label: 'nested_paths_missing',
        files: {'pkg.json': JSON.stringify({name: 'api'})},
        env: {},
      },
      ['fs-io', 'async'],
    );
  }

  // 45. moment/luxon + fetch() remote timestamp skew checker
  pkg = loadPkg('moment__luxon', ['src']);
  if (pkg) {
    addPair(
      'moment__luxon',
      'luxon_clock_skew_check',
      pkg,
      'clock_skew.js',
      `import { DateTime } from './src/luxon.js';

export async function run(timeUrl, maxSkewSec) {
  const local = DateTime.fromMillis(Date.now(), { zone: 'utc' });
  const resp = await fetch(timeUrl);
  const { iso } = await resp.json();
  const remote = DateTime.fromISO(iso, { zone: 'utc' });
  const skewSec = Math.abs(Math.round(remote.diff(local, 'seconds').seconds));
  const ok = skewSec <= maxSkewSec;
  if (!ok) console.warn('clock skew exceeded:', skewSec);
  return { skewSec, ok };
}
`,
      'run',
      [`${baseUrl}/time`, 10],
      {
        label: 'within_skew_ok',
        files: {},
        env: {},
        httpRoutes: {'/time': {status: 200, body: JSON.stringify({iso: '2024-03-09T16:00:03Z'})}},
      },
      {
        label: 'large_skew_warn',
        files: {},
        env: {},
        httpRoutes: {'/time': {status: 200, body: JSON.stringify({iso: '2024-03-09T16:05:00Z'})}},
      },
      ['http-io', 'time-io', 'console'],
    );
  }

  // 46. tj/commander.js + fs.statSync file info CLI
  pkg = loadPkg('tj__commander.js', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'tj__commander.js',
      'commander_stat_cli',
      pkg,
      'stat_cmd.js',
      `const fs = require('fs');
const { Command } = require('./index.js');

function run(argv) {
  const cmd = new Command();
  cmd.exitOverride().option('-p, --path <p>', 'target path');
  cmd.parse(argv, { from: 'user' });
  const target = cmd.opts().path;
  if (!fs.existsSync(target)) return { exists: false };
  const st = fs.statSync(target);
  return { exists: true, isFile: st.isFile(), isDir: st.isDirectory(), size: st.size };
}
module.exports = { run };
`,
      'run',
      [['-p', '/workspace/target.dat']],
      {
        label: 'file_exists_stat',
        files: {'target.dat': '0123456789abcdef'},
        env: {},
      },
      {
        label: 'file_missing',
        files: {'.keep': ''},
        env: {},
      },
      ['fs-io'],
    );
  }

  // 47. cacjs/cac + fetch() webhook notify CLI
  pkg = loadPkg('cacjs__cac', ['src']);
  if (pkg) {
    addPair(
      'cacjs__cac',
      'ts_cac_notify_cli',
      pkg,
      'notify_cli.ts',
      `import { cac } from './src/index.ts';

export async function run(argv: string[]) {
  const cli = cac('notify');
  cli.option('--url <url>', 'webhook url');
  cli.option('--msg <msg>', 'message');
  const parsed = cli.parse(['node', 'notify', ...argv], { run: false });
  const token = process.env.HOOK_TOKEN || '';
  const resp = await fetch(parsed.options.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) },
    body: JSON.stringify({ msg: parsed.options.msg }),
  });
  return { ok: resp.ok, status: resp.status, authed: Boolean(token) };
}
`,
      'run',
      [['--url', `${baseUrl}/hook`, '--msg', 'release-done']],
      {
        label: 'hook_200_authed',
        files: {},
        env: {HOOK_TOKEN: 'sec-1'},
        httpRoutes: {'/hook': {status: 200, body: JSON.stringify({ok: true})}},
      },
      {
        label: 'hook_401_unauthed',
        files: {},
        env: {},
        httpRoutes: {'/hook': {status: 401, body: JSON.stringify({error: 'unauth'})}},
      },
      ['typescript', 'http-io', 'env-io'],
    );
  }

  // 48. motdotla/dotenv + fetch() remote secret hydrate
  pkg = loadPkg('motdotla__dotenv', ['lib/main.js', 'lib/config-options.js']);
  if (pkg) {
    addPair(
      'motdotla__dotenv',
      'dotenv_remote_hydrate',
      pkg,
      'hydrate_env.js',
      `const fs = require('fs');
const dotenv = require('./lib/main.js');

async function run(envPath, secretsUrl) {
  const local = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  const resp = await fetch(secretsUrl);
  if (resp.ok) {
    const remote = await resp.json();
    Object.assign(local, remote);
    const out = Object.keys(local).sort().map(k => k + '=' + local[k]).join('\\n') + '\\n';
    fs.writeFileSync(envPath, out, 'utf8');
    return { hydrated: true, keys: Object.keys(local).sort() };
  }
  return { hydrated: false, keys: Object.keys(local).sort() };
}
module.exports = { run };
`,
      'run',
      ['/workspace/.env', `${baseUrl}/secrets`],
      {
        label: 'secrets_200_merged',
        files: {'.env': 'APP=web\n'},
        env: {},
        httpRoutes: {'/secrets': {status: 200, body: JSON.stringify({JWT_KEY: 'k99'})}},
      },
      {
        label: 'secrets_403_skipped',
        files: {'.env': 'APP=web\n'},
        env: {},
        httpRoutes: {'/secrets': {status: 403, body: JSON.stringify({error: 'denied'})}},
      },
      ['fs-io', 'http-io'],
    );
  }

  // 49. kaelzhang/node-ignore + fs/promises async dir filter
  pkg = loadPkg('kaelzhang__node_ignore', ['index.js']);
  if (pkg) {
    addPair(
      'kaelzhang__node-ignore',
      'ignore_async_packager',
      pkg,
      'async_pack.js',
      `const fsp = require('fs/promises');
const ignore = require('./index.js');

async function run(dirPath, outPath) {
  const rules = await fsp.readFile(dirPath + '/.npmignore', 'utf8');
  const ig = ignore().add(rules);
  const all = (await fsp.readdir(dirPath)).filter(f => f !== '.npmignore').sort();
  const packed = ig.filter(all);
  await fsp.writeFile(outPath, JSON.stringify({ packed }), 'utf8');
  return { total: all.length, packed };
}
module.exports = { run };
`,
      'run',
      ['/workspace/pkg', '/workspace/pack.json'],
      {
        label: 'excludes_tests_and_docs',
        files: {'pkg/.npmignore': '*.test.js\nREADME.md\n', 'pkg/index.js': '1', 'pkg/a.test.js': '2', 'pkg/README.md': '3'},
        env: {},
      },
      {
        label: 'minimal_ignore',
        files: {'pkg/.npmignore': '*.tmp\n', 'pkg/index.js': '1', 'pkg/a.test.js': '2', 'pkg/README.md': '3'},
        env: {},
      },
      ['fs-io', 'async'],
    );
  }

  // 50. krisk/Fuse + env limit cap + console
  pkg = loadPkg('krisk__Fuse', ['src']);
  if (pkg) {
    addPair(
      'krisk__Fuse',
      'ts_fuse_top_k_env',
      pkg,
      'topk_search.ts',
      `import * as fs from 'node:fs';
import Fuse from './src/entry.ts';

export function run(path: string, query: string) {
  const items = JSON.parse(fs.readFileSync(path, 'utf8'));
  const limit = Number(process.env.SEARCH_LIMIT || '2');
  const fuse = new Fuse(items, { keys: ['name'], threshold: 0.45 });
  const hits = fuse.search(query, { limit }).map(r => r.item.name);
  console.info('search hits:', hits.length);
  return { limit, hits };
}
`,
      'run',
      ['/workspace/services.json', 'pay'],
      {
        label: 'limit_1_top_hit',
        files: {'services.json': JSON.stringify([{name: 'payments-api'}, {name: 'payout-worker'}, {name: 'payroll-sync'}])},
        env: {SEARCH_LIMIT: '1'},
      },
      {
        label: 'limit_3_all_hits',
        files: {'services.json': JSON.stringify([{name: 'payments-api'}, {name: 'payout-worker'}, {name: 'payroll-sync'}])},
        env: {SEARCH_LIMIT: '3'},
      },
      ['typescript', 'fs-io', 'env-io', 'console'],
    );
  }

  // 51. lukeed/kleur + fs.existsSync + console
  pkg = loadPkg('lukeed__kleur', ['index.mjs', 'colors.mjs'], {renameMjsToJs: true});
  if (pkg) {
    addPair(
      'lukeed__kleur',
      'kleur_log_level_formatter',
      pkg,
      'fmt_logs.js',
      `import * as fs from 'node:fs';
import kleur from './index.js';

export function run(logPath) {
  kleur.enabled = !process.env.NO_COLOR;
  const rows = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const out = rows.map(r => r.level === 'ERR' ? kleur.red(r.msg) : kleur.cyan(r.msg));
  return { color: kleur.enabled, lines: out };
}
`,
      'run',
      ['/workspace/events.json'],
      {
        label: 'color_on',
        files: {'events.json': JSON.stringify([{level: 'INFO', msg: 'boot'}, {level: 'ERR', msg: 'timeout'}])},
        env: {},
      },
      {
        label: 'color_off',
        files: {'events.json': JSON.stringify([{level: 'INFO', msg: 'boot'}, {level: 'ERR', msg: 'timeout'}])},
        env: {NO_COLOR: '1'},
      },
      ['fs-io', 'env-io'],
    );
  }

  // 52. minimistjs/minimist + fs/promises async merge
  pkg = loadPkg('minimistjs__minimist', ['index.js']);
  if (pkg) {
    addPair(
      'minimistjs__minimist',
      'minimist_async_json_concat',
      pkg,
      'concat_json.js',
      `const fsp = require('fs/promises');
const minimist = require('./index.js');

async function run(argv) {
  const args = minimist(argv, { string: ['out'] });
  const merged = [];
  for (const file of args._) {
    const arr = JSON.parse(await fsp.readFile(file, 'utf8'));
    merged.push(...arr);
  }
  await fsp.writeFile(args.out, JSON.stringify(merged), 'utf8');
  return { count: merged.length, items: merged };
}
module.exports = { run };
`,
      'run',
      [['/workspace/p1.json', '/workspace/p2.json', '--out', '/workspace/all.json']],
      {
        label: 'four_items_total',
        files: {'p1.json': JSON.stringify([1, 2]), 'p2.json': JSON.stringify([3, 4])},
        env: {},
      },
      {
        label: 'one_item_total',
        files: {'p1.json': JSON.stringify([9]), 'p2.json': JSON.stringify([])},
        env: {},
      },
      ['fs-io', 'async'],
    );
  }

  // 53. lukeed/mri + Date.now() + fs build stamp
  pkg = loadPkg('lukeed__mri', ['src/index.js']);
  if (pkg) {
    addPair(
      'lukeed__mri',
      'mri_build_stamp_cli',
      pkg,
      'stamp_cli.js',
      `const fs = require('fs');
const mriMod = require('./src/index.js');
const mri = mriMod.default || mriMod;

function run(argv) {
  const opts = mri(argv, { default: { out: '/workspace/build.json', channel: 'stable' } });
  const channel = process.env.CHANNEL || opts.channel;
  const stamp = { channel, ts: Date.now(), sha: process.env.GIT_SHA || 'local' };
  fs.writeFileSync(opts.out, JSON.stringify(stamp), 'utf8');
  return stamp;
}
module.exports = { run };
`,
      'run',
      [['--out', '/workspace/build.json']],
      {
        label: 'ci_canary_sha',
        files: {'.keep': ''},
        env: {CHANNEL: 'canary', GIT_SHA: 'deadbeef'},
      },
      {
        label: 'local_stable_default',
        files: {'.keep': ''},
        env: {},
      },
      ['fs-io', 'env-io', 'time-io'],
    );
  }

  // 54. micromatch/picomatch + child_process git diff file matcher
  pkg = loadPkg('micromatch__picomatch', ['index.js', 'lib']);
  if (pkg) {
    addPair(
      'micromatch__picomatch',
      'picomatch_git_changed_scope',
      pkg,
      'changed_scope.js',
      `const cp = require('child_process');
const picomatch = require('./index.js');

function run(pattern) {
  const isMatch = picomatch(pattern);
  const out = cp.execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const files = out.split('\\n').filter(l => l.length >= 4).map(l => l.slice(3).trim());
  const matched = files.filter(f => isMatch(f)).sort();
  return { pattern, changed: files.sort(), matched, shouldRun: matched.length > 0 };
}
module.exports = { run };
`,
      'run',
      ['packages/web/**'],
      {
        label: 'web_file_changed_triggers',
        files: {'packages/web/app.js': '1', 'packages/api/srv.js': '1'},
        postGitWrites: {'packages/web/app.js': '2'},
        initGit: true,
        env: {},
      },
      {
        label: 'only_api_changed_skips',
        files: {'packages/web/app.js': '1', 'packages/api/srv.js': '1'},
        postGitWrites: {'packages/api/srv.js': '2'},
        initGit: true,
        env: {},
      },
      ['shell-exec'],
    );
  }

  // 55. developit/redaxios + env timeout/header + fs write
  pkg = loadPkg('developit__redaxios', ['src/index.js']);
  if (pkg) {
    addPair(
      'developit__redaxios',
      'redaxios_catalog_snapshot',
      pkg,
      'snap_catalog.js',
      `const fs = require('fs');
const redaxios = require('./src/index.js');
const axios = redaxios.default || redaxios;

async function run(url, outPath) {
  const resp = await axios.get(url, { fetch: globalThis.fetch });
  const items = resp.data.items || [];
  const active = items.filter(i => i.active);
  fs.writeFileSync(outPath, JSON.stringify(active), 'utf8');
  return { total: items.length, activeCount: active.length };
}
module.exports = { run };
`,
      'run',
      [`${baseUrl}/catalog`, '/workspace/active.json'],
      {
        label: 'two_active_items',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/catalog': {status: 200, body: JSON.stringify({items: [{id: 1, active: true}, {id: 2, active: false}, {id: 3, active: true}]})}},
      },
      {
        label: 'zero_active_items',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/catalog': {status: 200, body: JSON.stringify({items: [{id: 2, active: false}]})}},
      },
      ['http-io', 'fs-io'],
    );
  }

  // 56. markedjs/marked + env base prefix + fs/promises async
  pkg = loadPkg('markedjs__marked', ['src']);
  if (pkg) {
    addPair(
      'markedjs__marked',
      'ts_marked_async_render',
      pkg,
      'async_md.ts',
      `import * as fsp from 'node:fs/promises';
import { marked } from './src/marked.ts';

export async function run(inPath: string, outPath: string) {
  const src = await fsp.readFile(inPath, 'utf8');
  const title = process.env.DOC_TITLE || 'Doc';
  const body = marked.parse(src, { async: false }) as string;
  const html = '<title>' + title + '</title>' + body;
  await fsp.writeFile(outPath, html, 'utf8');
  return { title, hasHeading: body.includes('<h1'), bytes: html.length };
}
`,
      'run',
      ['/workspace/in.md', '/workspace/out.html'],
      {
        label: 'custom_title_h1',
        files: {'in.md': '# Hello\n\nParagraph.\n'},
        env: {DOC_TITLE: 'Handbook'},
      },
      {
        label: 'default_title_no_h1',
        files: {'in.md': 'Just text.\n'},
        env: {},
      },
      ['typescript', 'fs-io', 'env-io', 'async'],
    );
  }

  // 57. npm/ini + fs.existsSync + console
  pkg = loadPkg('npm__ini', ['lib/ini.js']);
  if (pkg) {
    addPair(
      'npm__ini',
      'ini_env_feature_check',
      pkg,
      'ini_feat.js',
      `const fs = require('fs');
const ini = require('./lib/ini.js');

function run(path) {
  const cfg = ini.parse(fs.readFileSync(path, 'utf8'));
  const enabled = cfg.features?.beta === true || process.env.FORCE_BETA === '1';
  if (enabled) console.info('beta enabled');
  return { enabled, rawBeta: Boolean(cfg.features?.beta) };
}
module.exports = { run };
`,
      'run',
      ['/workspace/feat.ini'],
      {
        label: 'forced_by_env',
        files: {'feat.ini': '[features]\nbeta=false\n'},
        env: {FORCE_BETA: '1'},
      },
      {
        label: 'disabled_both',
        files: {'feat.ini': '[features]\nbeta=false\n'},
        env: {},
      },
      ['fs-io', 'env-io', 'console'],
    );
  }

  // 58. unjs/confbox + fs/promises async YAML->JSON
  pkg = loadPkg('unjs__confbox', ['src']);
  if (pkg) {
    addPair(
      'unjs__confbox',
      'ts_confbox_async_yaml_json',
      pkg,
      'async_yaml.ts',
      `import * as fsp from 'node:fs/promises';
import { parseYAML, stringifyJSON } from './src/index.ts';

export async function run(inPath: string, outPath: string) {
  const doc = parseYAML(await fsp.readFile(inPath, 'utf8')) as Record<string, any>;
  await fsp.writeFile(outPath, stringifyJSON(doc), 'utf8');
  return { keys: Object.keys(doc).sort(), count: Object.keys(doc).length };
}
`,
      'run',
      ['/workspace/in.yaml', '/workspace/out.json'],
      {
        label: 'three_keys_yaml',
        files: {'in.yaml': 'name: svc\nport: 8080\ntls: true\n'},
        env: {},
      },
      {
        label: 'one_key_yaml',
        files: {'in.yaml': 'name: minimal\n'},
        env: {},
      },
      ['typescript', 'fs-io', 'async'],
    );
  }

  // 59. sindresorhus/dot-prop + crypto.randomUUID() + fs
  pkg = loadPkg('sindresorhus__dot-prop', ['index.js']);
  if (pkg) {
    addPair(
      'sindresorhus__dot-prop',
      'dotprop_trace_id_stamp',
      pkg,
      'trace_stamp.js',
      `import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { getProperty, setProperty } from './index.js';

export function run(reqPath, outPath) {
  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  let traceId = getProperty(req, 'meta.traceId');
  let generated = false;
  if (!traceId) {
    traceId = crypto.randomUUID();
    generated = true;
    setProperty(req, 'meta.traceId', traceId);
  }
  fs.writeFileSync(outPath, JSON.stringify(req), 'utf8');
  return { traceId, generated };
}
`,
      'run',
      ['/workspace/req.json', '/workspace/req_stamped.json'],
      {
        label: 'missing_trace_generated',
        files: {'req.json': JSON.stringify({action: 'charge', amount: 42})},
        env: {},
      },
      {
        label: 'existing_trace_preserved',
        files: {'req.json': JSON.stringify({action: 'charge', meta: {traceId: 'tr-existing-9'}})},
        env: {},
      },
      ['fs-io', 'uuid-io'],
    );
  }

  // 60. nodeca/js-yaml + fs.statSync + env
  pkg = loadPkg('nodeca__js-yaml', ['src']);
  if (pkg) {
    addPair(
      'nodeca__js-yaml',
      'jsyaml_inventory_count',
      pkg,
      'inv_yaml.ts',
      `import * as fs from 'node:fs';
import { load } from './src/index.ts';

export function run(invPath: string) {
  const doc = load(fs.readFileSync(invPath, 'utf8')) as any;
  const group = process.env.HOST_GROUP || 'web';
  const hosts = (doc.groups && doc.groups[group]) || [];
  return { group, count: hosts.length, hosts };
}
`,
      'run',
      ['/workspace/hosts.yaml'],
      {
        label: 'web_group',
        files: {'hosts.yaml': 'groups:\n  web:\n    - w1\n    - w2\n  db:\n    - d1\n'},
        env: {HOST_GROUP: 'web'},
      },
      {
        label: 'db_group',
        files: {'hosts.yaml': 'groups:\n  web:\n    - w1\n    - w2\n  db:\n    - d1\n'},
        env: {HOST_GROUP: 'db'},
      },
      ['typescript', 'fs-io', 'env-io'],
    );
  }

  // 61. d3/d3-array (REAL multi-file stats & quantile analytics over FS telemetry!)
  pkg = loadPkg('d3__d3-array', ['src']);
  if (pkg) {
    addPair(
      'd3__d3-array',
      'd3_latency_sla_report',
      pkg,
      'sla_stats.js',
      `import * as fs from 'node:fs';
import { mean, quantile, max } from './src/index.js';

export function run(metricsPath, outPath) {
  const samples = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const slaMs = Number(process.env.P95_SLA_MS || 200);
  const p95 = quantile(samples, 0.95);
  const avg = Math.round(mean(samples) * 100) / 100;
  const peak = max(samples);
  const breached = p95 > slaMs;
  if (breached) console.warn('SLA breach p95=', p95, 'limit=', slaMs);
  const res = { slaMs, avg, p95, peak, breached };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`,
      'run',
      ['/workspace/latencies.json', '/workspace/sla.json'],
      {
        label: 'sla_breached',
        files: {'latencies.json': JSON.stringify([40, 55, 60, 75, 110, 260, 310])},
        env: {P95_SLA_MS: '200'},
      },
      {
        label: 'sla_healthy',
        files: {'latencies.json': JSON.stringify([40, 55, 60, 75, 90, 110, 130])},
        env: {P95_SLA_MS: '200'},
      },
      ['fs-io', 'env-io', 'console'],
    );
    addPair(
      'd3__d3-array',
      'd3_remote_sales_rollup',
      pkg,
      'sales_rollup.js',
      `import * as fs from 'node:fs';
import { rollup, sum } from './src/index.js';

export async function run(apiUrl, outPath) {
  const resp = await fetch(apiUrl);
  const rows = await resp.json();
  const byRegion = Object.fromEntries(rollup(rows, v => sum(v, d => d.amount), d => d.region));
  fs.writeFileSync(outPath, JSON.stringify(byRegion), 'utf8');
  return { regions: Object.keys(byRegion).sort(), totals: byRegion };
}
`,
      'run',
      [`${baseUrl}/sales`, '/workspace/sales_rollup.json'],
      {
        label: 'two_regions',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/sales': {status: 200, body: JSON.stringify([{region: 'us', amount: 120}, {region: 'eu', amount: 80}, {region: 'us', amount: 30}])}},
      },
      {
        label: 'three_regions',
        files: {'.keep': ''},
        env: {},
        httpRoutes: {'/sales': {status: 200, body: JSON.stringify([{region: 'us', amount: 50}, {region: 'eu', amount: 40}, {region: 'apac', amount: 90}])}},
      },
      ['http-io', 'fs-io'],
    );
  }

  // 62. beatgammit/base64-js (REAL binary fs.readBytes -> base64 encode/decode!)
  pkg = loadPkg('beatgammit__base64-js', ['index.js']);
  if (pkg) {
    addPair(
      'beatgammit__base64-js',
      'base64_binary_envelope',
      pkg,
      'b64_pack.js',
      `const fs = require('fs');
const b64 = require('./index.js');

function run(binPath, outPath) {
  const raw = fs.readFileSync(binPath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const encoded = b64.fromByteArray(bytes);
  const decoded = b64.toByteArray(encoded);
  const res = { bytes: bytes.length, encoded, roundtripOk: decoded.length === bytes.length };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
module.exports = { run };
`,
      'run',
      ['/workspace/blob.bin', '/workspace/blob.b64.json'],
      {
        label: 'short_binary_header',
        files: {'blob.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])},
        env: {},
      },
      {
        label: 'longer_binary_payload',
        files: {'blob.bin': Buffer.from([0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x10, 0x20, 0x30])},
        env: {},
      },
      ['fs-io'],
    );
  }

  return scenarios;
}

async function harvestJsStatefulOss({cacheDir, outputDir, benchmarkJsonl, benchmarkManifest, resume = false}) {
  const out = resolve(outputDir);
  mkdirSync(out, {recursive: true});
  const tasksPath = join(out, 'tasks.jsonl');
  const errorsPath = join(out, 'errors.jsonl');
  const reportPath = join(out, 'report.json');

  const forbidden = loadForbiddenBenchmark(benchmarkJsonl, benchmarkManifest);
  const existingById = new Map();
  if (resume && existsSync(tasksPath)) {
    for (const line of readFileSync(tasksPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.id) existingById.set(row.id, row);
    }
  }

  const errors = [];
  const httpServer = createDeterministicHttpServer();
  const port = await httpServer.start();

  const admitted = [...existingById.values()];
  const seenIds = new Set(existingById.keys());
  let pairGroupsVerified = 0;

  try {
    const scenarios = buildJsScenarios(cacheDir, port, errors);
    for (const scen of scenarios) {
      const repo = scen.repo;
      const slug = scen.slug;
      const repoShort = repo.includes('__') ? repo.split('__')[1].toLowerCase() : repo.toLowerCase();
      if (forbidden.repos.has(repo.toLowerCase()) || forbidden.repos.has(repoShort)) {
        errors.push({repo, slug, error: 'repo forbidden by benchmark'});
        continue;
      }

      const variantRows = [];
      let scenOk = true;

      for (const variant of scen.variants) {
        const taskId = `stateful-oss-js-${repo.replaceAll('__', '-').replaceAll('.', '-')}-${slug}-${variant.suffix}`;
        if (seenIds.has(taskId)) {
          scenOk = false;
          break;
        }
        if (forbidden.ids.has(taskId)) {
          errors.push({repo, slug, taskId, error: 'id collision with benchmark'});
          scenOk = false;
          break;
        }

        httpServer.setRoutes(variant.httpRoutes ?? {});
        try {
          const probe = await runLiveJsCapture({
            files: scen.files,
            entryFile: scen.entryFile,
            entry: scen.entry,
            args: scen.args,
            worldFiles: variant.files ?? {},
            worldEnv: variant.env ?? {},
            initGit: Boolean(variant.initGit),
            postGitWrites: variant.postGitWrites ?? null,
          });
          if (!probe.ok) throw new Error(`live probe failed: ${probe.error}`);
          if (!probe.recordedCalls.length) throw new Error('live probe recorded 0 external I/O calls');

          const isTs = /\.(?:ts|tsx|mts|cts)$/i.test(scen.entryFile);
          const family = `stateful-oss-js/${repo}/${slug}`;
          const splitComponent = sha256(`stateful-oss-js:${repo}:${slug}`);
          if (forbidden.families.has(family) || forbidden.splitComponents.has(splitComponent)) {
            throw new Error('family/split_component collision with benchmark');
          }

          const task = {
            id: taskId,
            family,
            language: isTs ? 'ts' : 'js',
            executionMode: 'native',
            files: scen.files,
            entryFile: scen.entryFile,
            entry: scen.entry,
            initialLoadedFiles: [scen.entryFile],
            args: encodeReadable(scen.args),
            fixture: {calls: probe.recordedCalls},
            randomSeed: 17,
            tier: 5,
            features: [...scen.features],
            metadata: {
              repo,
              scenario: slug,
              variant: variant.suffix,
              real_oss: true,
              stateful_io: true,
              ...(scen.kind === 'pair' ? {pair_id: scen.pairId} : {}),
            },
          };

          const exported = await verifyTask2x(task);
          if (forbidden.sourceHashes.has(exported.sourceHash)) {
            throw new Error('sourceHash collision with benchmark');
          }
          exported.split_component = splitComponent;
          if (scen.kind === 'pair') exported.pair_id = scen.pairId;
          variantRows.push(exported);
        } catch (err) {
          errors.push({repo, slug, variant: variant.suffix, taskId, error: String(err?.message ?? err)});
          scenOk = false;
          break;
        }
      }

      if (!scenOk || !variantRows.length) continue;

      if (scen.kind === 'pair') {
        if (variantRows.length !== 2) continue;
        const fmtA = variantRows[0].metadata?.traceFormat ?? 'compact';
        const fmtB = variantRows[1].metadata?.traceFormat ?? 'compact';
        if (fmtA !== fmtB) {
          try {
            const alignedA = await verifyTask2x(variantRows[0].task, 'actions-only');
            const alignedB = await verifyTask2x(variantRows[1].task, 'actions-only');
            alignedA.split_component = variantRows[0].split_component;
            alignedB.split_component = variantRows[1].split_component;
            alignedA.pair_id = scen.pairId;
            alignedB.pair_id = scen.pairId;
            variantRows[0] = alignedA;
            variantRows[1] = alignedB;
          } catch (err) {
            errors.push({repo, slug, stage: 'pair_align', error: String(err?.message ?? err)});
            continue;
          }
        }
        try {
          const pairAudit = auditCausalPrefixPair(variantRows[0].messages, variantRows[1].messages);
          variantRows[0].metadata.causalPairAudit = pairAudit;
          variantRows[1].metadata.causalPairAudit = pairAudit;
          pairGroupsVerified++;
        } catch (err) {
          errors.push({repo, slug, stage: 'causal_pair_audit', error: String(err?.message ?? err)});
          continue;
        }
      }

      for (const row of variantRows) {
        admitted.push(row);
        seenIds.add(row.id);
      }
    }
  } finally {
    await httpServer.stop();
  }

  writeFileSync(tasksPath, admitted.map(r => JSON.stringify(r)).join('\n') + (admitted.length ? '\n' : ''));
  writeFileSync(errorsPath, errors.map(e => JSON.stringify(e)).join('\n') + (errors.length ? '\n' : ''));

  const opCounts = {};
  const reposSeen = new Set();
  let multifileCount = 0;
  for (const row of admitted) {
    if (row.metadata?.repo) reposSeen.add(row.metadata.repo);
    if (row.task?.files) multifileCount++;
    for (const call of row.task?.fixture?.calls ?? []) {
      const op = call.operation ?? 'unknown';
      opCounts[op] = (opCounts[op] ?? 0) + 1;
    }
  }

  const report = {
    harvester: 'tinker-harvest-stateful-oss-js',
    total_tasks: admitted.length,
    distinct_repos: reposSeen.size,
    repos: [...reposSeen].sort(),
    multifile_tasks: multifileCount,
    causal_pair_groups: pairGroupsVerified,
    causal_pair_tasks: admitted.filter(r => Boolean(r.pair_id)).length,
    external_op_call_counts: Object.fromEntries(Object.entries(opCounts).sort((a, b) => a[0].localeCompare(b[0]))),
    errors_count: errors.length,
    tasks_path: tasksPath,
    errors_path: errorsPath,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function main() {
  const {values} = parseArgs({
    options: {
      'cache-dir': {type: 'string', default: DEFAULT_CACHE_DIR},
      'output-dir': {type: 'string', default: 'runs/stateful-oss-harvest/js'},
      'benchmark-jsonl': {type: 'string', default: DEFAULT_BENCHMARK_JSONL},
      'benchmark-manifest': {type: 'string', default: DEFAULT_BENCHMARK_MANIFEST},
      resume: {type: 'boolean', default: false},
    },
  });
  const report = await harvestJsStatefulOss({
    cacheDir: values['cache-dir'],
    outputDir: values['output-dir'],
    benchmarkJsonl: values['benchmark-jsonl'],
    benchmarkManifest: values['benchmark-manifest'],
    resume: Boolean(values.resume),
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
