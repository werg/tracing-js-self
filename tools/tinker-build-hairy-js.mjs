#!/usr/bin/env node
// Build and verify 80 hairy, realistic JS execution tasks directly on top of
// real open-source codebases extracted on disk, bundled via esbuild (<= 38K chars
// per task), auto-recorded for multi-turn side effects, and 100% verified via
// exportTinkerExample(..., {traceFormat: 'compact'}) + auditTeacherConversation().

import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import vm from 'node:vm';
import {
  assistantThinkingText,
  encodeReadable,
  exportTinkerExample,
} from '../src/training/tinker-execution.js';
import {nearCloneHash} from '../src/training/tinker-benchmark.js';

process.on('unhandledRejection', () => {});

const DEFAULT_OUTPUT = '/home/werg/tracing-js-self/runs/hairy-real-js-tasks/tasks.jsonl';
const MAX_SOURCE_CHARS = 38000;
const MIN_TRACE_LINES = 8;
const MAX_APPROX_TOKENS = 60000;

const {values} = parseArgs({
  options: {
    output: {type: 'string', short: 'o', default: DEFAULT_OUTPUT},
    jobs: {type: 'string', default: '4'},
    limit: {type: 'string'},
    'export-examples': {type: 'boolean', default: false},
    help: {type: 'boolean', short: 'h'},
  },
});

if (values.help) {
  console.log(`Usage: node tools/tinker-build-hairy-js.mjs [options]
  -o, --output <path>   Output JSONL path (default: ${DEFAULT_OUTPUT})
  --jobs <n>            Parallel verification workers (default: 4)
  --limit <n>           Build only the first N tasks
  --export-examples     Write full exported conversations instead of task objects`);
  process.exit(0);
}

const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));
const limit = values.limit ? Math.max(1, Number(values.limit)) : null;

const req = createRequire('/tmp/tinker-harvest-env/package.json');
const esbuild = req('esbuild');
const sha256 = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const stripTmpComments = code => code.replace(/^\s*\/\/ (?:\.\.\/)+\S+\r?\n/gm, '');

const STUB_POSTCSS = {
  path: 'export default { resolve: x => x, relative: (_a, b) => b };',
  fs: 'export default {};',
  url: 'export const fileURLToPath = u => u; export const pathToFileURL = p => new URL("file://" + p);',
  'nanoid/non-secure': 'export const nanoid = () => "id";',
  picocolors: 'export default new Proxy({}, { get: () => s => s });',
  'source-map-js': 'export class SourceMapGenerator {} export class SourceMapConsumer {}',
};

const LIB_SPECS = {
  diffStructured: {
    pkg: 'diff',
    version: '9.0.0',
    license: 'BSD-3-Clause',
    repository: 'https://github.com/kpdecker/jsdiff.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/diff',
    stdin: 'import {diffWords, diffLines, diffJson, diffChars} from "./libesm/index.js"; __harvestTarget = {diffWords, diffLines, diffJson, diffChars};',
    minify: true,
  },
  diffPatch: {
    pkg: 'diff',
    version: '9.0.0',
    license: 'BSD-3-Clause',
    repository: 'https://github.com/kpdecker/jsdiff.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/diff',
    stdin: 'import {createPatch, applyPatch, parsePatch} from "./libesm/index.js"; __harvestTarget = {createPatch, applyPatch, parsePatch};',
    minify: true,
  },
  fastJsonPatch: {
    pkg: 'fast-json-patch',
    version: '3.1.2',
    license: 'MIT',
    repository: 'https://github.com/Starcounter-Jack/JSON-Patch.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/fast-json-patch',
    stdin: 'import {compare, applyPatch, validate} from "./index.mjs"; __harvestTarget = {compare, applyPatch, validate};',
  },
  marked: {
    pkg: 'marked',
    version: '18.3.0',
    license: 'MIT',
    repository: 'https://github.com/markedjs/marked.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/markedjs__marked',
    stdin: 'import {_Lexer} from "./src/Lexer.ts"; import {_Parser} from "./src/Parser.ts"; __harvestTarget = {Lexer: _Lexer, Parser: _Parser};',
    loader: 'ts',
    minify: true,
    minifyId: true,
  },
  graphql: {
    pkg: 'graphql',
    version: '16.14.0',
    license: 'MIT',
    repository: 'https://github.com/graphql/graphql-js.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2b/graphql__graphql-js',
    stdin: 'import {parse} from "./src/language/parser.ts"; import {visit} from "./src/language/visitor.ts"; __harvestTarget = {parse, visit};',
    loader: 'ts',
    minify: true,
    minifyId: true,
  },
  postcss: {
    pkg: 'postcss',
    version: '8.5.14',
    license: 'MIT',
    repository: 'https://github.com/postcss/postcss.git',
    resolveDir: '/tmp/tinker-harvest-dgx-part2/postcss__postcss',
    stdin: 'import parse from "./lib/parse.js"; import stringify from "./lib/stringify.js"; __harvestTarget = {parse, stringify};',
    minify: true,
    minifyId: true,
    stubs: STUB_POSTCSS,
  },
  yargsParser: {
    pkg: 'yargs-parser',
    version: '22.0.0',
    license: 'ISC',
    repository: 'https://github.com/yargs/yargs-parser.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/yargs-parser',
    stdin: 'import parser from "./browser.js"; __harvestTarget = parser;',
    minify: true,
  },
  semver: {
    pkg: 'semver',
    version: '7.8.6',
    license: 'ISC',
    repository: 'https://github.com/npm/node-semver.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/semver',
    stdin: 'const satisfies = require("./functions/satisfies"); const rsort = require("./functions/rsort"); const maxSatisfying = require("./ranges/max-satisfying"); const minSatisfying = require("./ranges/min-satisfying"); const inc = require("./functions/inc"); __harvestTarget = {satisfies, rsort, maxSatisfying, minSatisfying, inc};',
    minify: true,
  },
  acornWalk: {
    pkg: 'acorn-walk',
    version: '8.3.4',
    license: 'MIT',
    repository: 'https://github.com/acornjs/acorn.git',
    resolveDir: '/tmp/tinker-harvest-dgx/acornjs__acorn',
    stdin: 'import * as walk from "./acorn-walk/src/index.js"; __harvestTarget = walk;',
  },
  immer: {
    pkg: 'immer',
    version: '10.0.3-beta',
    license: 'MIT',
    repository: 'https://github.com/immerjs/immer.git',
    resolveDir: '/tmp/tinker-harvest-dgx/immerjs__immer',
    stdin: 'import {produce, produceWithPatches, applyPatches, enablePatches, setAutoFreeze, current} from "./src/immer.ts"; __harvestTarget = {produce, produceWithPatches, applyPatches, enablePatches, setAutoFreeze, current};',
    loader: 'ts',
    minify: true,
  },
  mutative: {
    pkg: 'mutative',
    version: '1.3.0',
    license: 'MIT',
    repository: 'https://github.com/unadlib/mutative.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2b/unadlib__mutative',
    stdin: 'import {create, apply, current} from "./src/index.ts"; __harvestTarget = {create, apply, current};',
    loader: 'ts',
    minify: true,
    define: {__DEV__: 'false'},
  },
  d3Array: {
    pkg: 'd3-array',
    version: '3.2.4',
    license: 'ISC',
    repository: 'https://github.com/d3/d3-array.git',
    resolveDir: '/tmp/tinker-harvest-dgx/d3__d3-array',
    stdin: 'import {fsum, fcumsum} from "./src/fsum.js"; import {blur, blur2} from "./src/blur.js"; import transpose from "./src/transpose.js"; import group, {rollup} from "./src/group.js"; import bin from "./src/bin.js"; __harvestTarget = {fsum, fcumsum, blur, blur2, transpose, group, rollup, bin};',
    nodePaths: ['/tmp/tinker-harvest-env/node_modules'],
  },
  esToolkit: {
    pkg: 'es-toolkit',
    version: '1.53.2',
    license: 'MIT',
    repository: 'https://github.com/toss/es-toolkit.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/es-toolkit',
    stdin: 'import {merge, cloneDeep, groupBy, partition, orderBy, uniqBy, pick, omit} from "./dist/index.mjs"; __harvestTarget = {merge, cloneDeep, groupBy, partition, orderBy, uniqBy, pick, omit};',
  },
  quickLru: {
    pkg: 'quick-lru',
    version: '8.0.0',
    license: 'MIT',
    repository: 'https://github.com/sindresorhus/quick-lru.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/quick-lru',
    stdin: 'import QuickLRU from "./index.js"; __harvestTarget = QuickLRU;',
  },
  asyncValidator: {
    pkg: 'async-validator',
    version: '4.2.5',
    license: 'MIT',
    repository: 'https://github.com/yiminghe/async-validator.git',
    resolveDir: '/tmp/tinker-harvest-dgx/yiminghe__async-validator',
    stdin: 'import Schema from "./src/index.ts"; __harvestTarget = Schema;',
    loader: 'ts',
    minify: true,
  },
  validator: {
    pkg: 'validator',
    version: '13.15.35',
    license: 'MIT',
    repository: 'https://github.com/validatorjs/validator.js.git',
    resolveDir: '/tmp/tinker-harvest-dgx/validatorjs__validator.js',
    stdin: 'import isEmail from "./src/lib/isEmail.js"; import normalizeEmail from "./src/lib/normalizeEmail.js"; import isURL from "./src/lib/isURL.js"; import isIP from "./src/lib/isIP.js"; import isUUID from "./src/lib/isUUID.js"; import isISO8601 from "./src/lib/isISO8601.js"; import isSemVer from "./src/lib/isSemVer.js"; import isJWT from "./src/lib/isJWT.js"; import isJSON from "./src/lib/isJSON.js"; import escape from "./src/lib/escape.js"; __harvestTarget = {isEmail, normalizeEmail, isURL, isIP, isUUID, isISO8601, isSemVer, isJWT, isJSON, escape};',
  },
  mustache: {
    pkg: 'mustache',
    version: '4.2.0',
    license: 'MIT',
    repository: 'https://github.com/janl/mustache.js.git',
    resolveDir: '/tmp/tinker-harvest-dgx/janl__mustache.js',
    stdin: 'import Mustache from "./mustache.js"; __harvestTarget = Mustache;',
  },
  i18next: {
    pkg: 'i18next',
    version: '26.1.0',
    license: 'MIT',
    repository: 'https://github.com/i18next/i18next.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/i18next__i18next',
    stdin: 'import Interpolator from "./src/Interpolator.js"; import PluralResolver from "./src/PluralResolver.js"; import LanguageUtils from "./src/LanguageUtils.js"; __harvestTarget = {Interpolator, PluralResolver, LanguageUtils};',
  },
  nunjucks: {
    pkg: 'nunjucks',
    version: '3.2.4',
    license: 'BSD-2-Clause',
    repository: 'https://github.com/mozilla/nunjucks.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/mozilla__nunjucks',
    stdin: 'const lexer = require("./nunjucks/src/lexer"); const filters = require("./nunjucks/src/filters"); __harvestTarget = {lexer, filters};',
    minify: true,
  },
  simpleStatistics: {
    pkg: 'simple-statistics',
    version: '8.0.0',
    license: 'ISC',
    repository: 'https://github.com/simple-statistics/simple-statistics.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/simple-statistics',
    stdin: 'import {mean, median, standardDeviation, medianAbsoluteDeviation, zScore, interquartileRange, linearRegression} from "./dist/simple-statistics.mjs"; __harvestTarget = {mean, median, standardDeviation, medianAbsoluteDeviation, zScore, interquartileRange, linearRegression};',
  },
};

const bundleCache = new Map();
async function buildLibBundle(specKey) {
  if (bundleCache.has(specKey)) return bundleCache.get(specKey);
  const spec = LIB_SPECS[specKey];
  const stub = spec.stubs ?? {};
  const plugin = {
    name: 'stub',
    setup(build) {
      build.onResolve({filter: /.*/}, args => {
        if (Object.hasOwn(stub, args.path)) return {path: args.path, namespace: 'stub'};
        return null;
      });
      build.onLoad({filter: /.*/, namespace: 'stub'}, args => ({contents: stub[args.path], loader: 'js'}));
    },
  };
  const built = await esbuild.build({
    stdin: {contents: spec.stdin, resolveDir: spec.resolveDir, loader: spec.loader ?? 'js'},
    bundle: true,
    treeShaking: true,
    minifyWhitespace: !!spec.minify,
    minifySyntax: !!spec.minify,
    minifyIdentifiers: !!spec.minifyId,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default', 'require'],
    nodePaths: spec.nodePaths ?? [],
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NODE_DEBUG': 'undefined',
      'process.env.DEBUG': 'undefined',
      process: '{"env":{}}',
      ...(spec.define ?? {}),
    },
    plugins: Object.keys(stub).length ? [plugin] : [],
    logLevel: 'silent',
  });
  const code = stripTmpComments(built.outputFiles[0].text).trim();
  const res = {...spec, code};
  bundleCache.set(specKey, res);
  return res;
}

// Auto-record every external observation in an isolated vm context that matches
// tools/effectful-reference-worker.mjs (codeGeneration: false, same globals).
async function recordTaskExecution({source, args, nativeBindings = [], toolImpls = {}, usesRandomTool = false}) {
  const recordedCalls = [];
  const nextOrReject = (impl, callArgs, opName) => {
    const res = impl(...callArgs);
    if (res && typeof res === 'object' && res.__reject !== undefined) {
      recordedCalls.push({
        operation: opName,
        arguments: encodeReadable(callArgs),
        status: 'rejected',
        result: encodeReadable(res.__reject),
      });
      return {rejected: true, value: res.__reject};
    }
    recordedCalls.push({
      operation: opName,
      arguments: encodeReadable(callArgs),
      status: 'fulfilled',
      result: encodeReadable(res),
    });
    return {rejected: false, value: structuredClone(res)};
  };

  let clockIdx = 0;
  const clocks = toolImpls.__clocks ?? [1700000100, 1700000112, 1700000129, 1700000155, 1700000190];
  let randIdx = 0;
  const randoms = toolImpls.__randoms ?? [0.17, 0.83, 0.42, 0.65, 0.09, 0.91];

  const host = Object.create(null);
  host.readText = path => Promise.resolve().then(() => {
    const outcome = nextOrReject(toolImpls.readText, [path], 'fs.readText');
    if (outcome.rejected) throw outcome.value;
    return outcome.value;
  });
  host.writeText = (path, text) => Promise.resolve().then(() => {
    recordedCalls.push({
      operation: 'fs.writeText',
      arguments: encodeReadable([path, text]),
      status: 'fulfilled',
      result: {$js: 'undefined'},
    });
    if (toolImpls.writeText) toolImpls.writeText(path, text);
  });
  host.httpGet = url => Promise.resolve().then(() => {
    const outcome = nextOrReject(toolImpls.httpGet, [url], 'http.get');
    if (outcome.rejected) throw outcome.value;
    return outcome.value;
  });
  host.httpRequest = (url, method, headers, body) => Promise.resolve().then(() => {
    const outcome = nextOrReject(toolImpls.httpRequest, [url, method, headers, body], 'http.request');
    if (outcome.rejected) throw outcome.value;
    return outcome.value;
  });
  host.httpPost = (url, body) => Promise.resolve().then(() => {
    const outcome = nextOrReject(toolImpls.httpPost, [url, body], 'http.post');
    if (outcome.rejected) throw outcome.value;
    return outcome.value;
  });

  const bindingEnv = {};
  for (const b of nativeBindings) {
    const impl = toolImpls[b.name];
    bindingEnv[b.name] = (...callArgs) => {
      const cloned = structuredClone(callArgs);
      if (b.kind === 'promise') {
        return Promise.resolve().then(() => {
          const res = impl(...cloned);
          if (res && typeof res === 'object' && res.__reject !== undefined) {
            recordedCalls.push({
              operation: 'natlang.call',
              arguments: encodeReadable([b.name, undefined, cloned]),
              status: 'rejected',
              result: encodeReadable(res.__reject),
            });
            throw res.__reject;
          }
          recordedCalls.push({
            operation: 'natlang.call',
            arguments: encodeReadable([b.name, undefined, cloned]),
            status: 'fulfilled',
            result: encodeReadable(res),
          });
          return structuredClone(res);
        });
      }
      const res = impl(...cloned);
      recordedCalls.push({
        operation: 'natlang.callSync',
        arguments: encodeReadable([b.name, undefined, cloned]),
        status: 'fulfilled',
        result: encodeReadable(res),
      });
      return structuredClone(res);
    };
  }

  const ctx = vm.createContext({
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    structuredClone,
    host,
    ...bindingEnv,
    __args: structuredClone(args),
    __result: undefined,
    __platformDateNow: () => {
      const v = clockIdx < clocks.length
        ? clocks[clockIdx]
        : clocks[clocks.length - 1] + (clockIdx - clocks.length + 1) * 5;
      clockIdx++;
      recordedCalls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: v});
      return v;
    },
    __platformRandom: () => {
      const v = randoms[randIdx++ % randoms.length];
      recordedCalls.push({operation: 'platform.random', arguments: [], status: 'fulfilled', result: v});
      return v;
    },
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(lvl => [lvl, (...xs) => {
      const msg = xs.length ? xs[0] : undefined;
      recordedCalls.push({
        operation: 'platform.console.' + lvl,
        arguments: encodeReadable([msg]),
        status: 'fulfilled',
        result: {$js: 'undefined'},
      });
    }])),
  }, {codeGeneration: {strings: false, wasm: false}});

  if (/\bDate\.now\b/.test(source)) {
    new vm.Script('Date.now = __platformDateNow;').runInContext(ctx, {timeout: 200});
  }
  if (usesRandomTool || /\bMath\.random\b/.test(source)) {
    new vm.Script('Math.random = __platformRandom;').runInContext(ctx, {timeout: 200});
  }

  try {
    const val = new vm.Script(`${source}\n__result = run.apply(undefined, __args);`).runInContext(ctx, {timeout: 2000});
    if (val && typeof val.then === 'function') await val;
  } catch {
    // Throwing executions are valid JS completions.
  }
  return recordedCalls;
}

function buildTemplates() {
  return [
    // =========================================================================
    // 1. diff: diff-structured (Cat 1: diffWords, diffLines, diffJson, diffChars + Date.now)
    // =========================================================================
    {
      name: 'diff-structured',
      lib: 'diffStructured',
      category: 'diff-patching',
      features: ['diff', 'unicode', 'json', 'platform', 'deadline'],
      driver: `function run(mode, left, right, opts) {
  const {diffWords, diffLines, diffJson, diffChars} = __loadMod();
  const t0 = Date.now();
  let raw = null;
  if (mode === 'json') raw = diffJson(left, right, opts);
  else if (mode === 'words') raw = diffWords(left, right, opts);
  else if (mode === 'lines') raw = diffLines(left, right, opts);
  else if (mode === 'chars') raw = diffChars(left, right, opts);
  else throw new TypeError('unknown diff mode: ' + mode);
  const elapsed = Date.now() - t0;
  if (!raw) {
    console.warn('diff-timeout:' + mode + ':' + elapsed);
    return {mode, timedOut: true, elapsed, hunks: []};
  }
  let added = 0, removed = 0;
  const hunks = [];
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i];
    if (part.added) added += part.count;
    else if (part.removed) removed += part.count;
    hunks.push({
      op: part.added ? '+' : part.removed ? '-' : '=',
      count: part.count,
      value: part.value,
    });
  }
  return {mode, timedOut: false, elapsed, added, removed, hunks};
}`,
      cases: [
        {
          args: [
            'json',
            {z: 1, meta: {tags: ['alpha', 'beta'], flag: true, empty: null}, a: [10, 20.5, 30]},
            {a: [10, 20.5, 31], meta: {flag: false, tags: ['alpha', 'gamma'], extra: 'café'}, z: 1},
            {undefinedReplacement: null},
          ],
          toolImpls: {__clocks: [1000, 1002, 1004, 1006, 1008, 1010, 1012, 1014, 1016, 1018, 1020]},
        },
        {
          args: [
            'words',
            'Café naïve résumé — v1.0 (alpha); price: $12.50!',
            'CAFE Naive resume — v2.0 (beta); price: $12.50?',
            {ignoreCase: true},
          ],
          toolImpls: {__clocks: [2000, 2003, 2006, 2009, 2012, 2015, 2018, 2021, 2024, 2027, 2030]},
        },
        {
          args: [
            'lines',
            'header\r\n  alpha = 1\r\n\r\nbeta = 2\r\nfooter',
            'header\n  alpha = 1\n\nbeta = 3\nfooter\n',
            {newlineIsToken: true},
          ],
          toolImpls: {__clocks: [3000, 3002, 3004, 3006, 3008, 3010, 3012, 3014]},
        },
        {
          args: [
            'chars',
            '🚀alpha—βeta😀gamma',
            '🚀alpha—δeta✨gamma',
            {timeout: 15},
          ],
          toolImpls: {__clocks: [4000, 4004, 4010, 4018, 4025, 4035]},
        },
      ],
    },

    // =========================================================================
    // 2. diff: diff-patch-effectful (Cat 1 & Cat 5: fs.readText, Date.now, console, fs.writeText)
    // =========================================================================
    {
      name: 'diff-patch-effectful',
      lib: 'diffPatch',
      category: 'diff-patching',
      features: ['diff', 'fs', 'platform', 'external', 'sequential', 'exception'],
      driver: `async function run(spec) {
  const {createPatch, applyPatch, parsePatch} = __loadMod();
  const t0 = Date.now();
  let oldText, newText, targetText;
  try {
    oldText = await host.readText(spec.oldPath);
  } catch (err) {
    console.warn('read-fallback:' + spec.oldPath + ':' + String(err));
    if (!spec.fallbackOldPath) {
      return {ok: false, stage: 'read', error: String(err)};
    }
    oldText = await host.readText(spec.fallbackOldPath);
  }
  newText = await host.readText(spec.newPath);
  targetText = await host.readText(spec.targetPath);
  const patch = createPatch(spec.fileLabel, oldText, newText, 'base', 'next', {context: 1});
  const parsed = parsePatch(patch);
  const patched = applyPatch(targetText, patch, {fuzzFactor: spec.fuzzFactor});
  const elapsed = Date.now() - t0;
  if (patched === false) {
    console.warn('patch-conflict:' + spec.fileLabel + ':' + elapsed);
    await host.writeText(spec.outPath + '.rej', patch);
    return {ok: false, stage: 'apply', hunks: parsed[0].hunks.length, elapsed};
  }
  console.info('patch-applied:' + spec.fileLabel + ':hunks=' + parsed[0].hunks.length + ':ms=' + elapsed);
  await host.writeText(spec.outPath, patched);
  return {ok: true, hunks: parsed[0].hunks.length, elapsed, patched};
}`,
      cases: [
        {
          args: [{oldPath: 'cfg/v1.ini', newPath: 'cfg/v2.ini', targetPath: 'cfg/live.ini', outPath: 'cfg/out.ini', fileLabel: 'cfg.ini', fuzzFactor: 0}],
          toolImpls: {
            __clocks: [5000, 5004, 5008, 5012, 5016, 5020, 5024, 5028],
            readText: p => ({
              'cfg/v1.ini': 'mode=dev\nport=3000\nworkers=2\nlog=info\n',
              'cfg/v2.ini': 'mode=prod\nport=3000\nworkers=8\nlog=warn\n',
              'cfg/live.ini': 'mode=dev\nport=3000\nworkers=2\nlog=info\n',
            }[p]),
          },
        },
        {
          args: [{oldPath: 'app/a.txt', newPath: 'app/b.txt', targetPath: 'app/shifted.txt', outPath: 'app/out.txt', fileLabel: 'app.txt', fuzzFactor: 1}],
          toolImpls: {
            __clocks: [6000, 6003, 6006, 6009, 6012, 6015, 6018],
            readText: p => ({
              'app/a.txt': 'line0\nalpha = 1\nbeta = 2\nline3\n',
              'app/b.txt': 'line0\nalpha = 1\nbeta = 99\nline3\n',
              'app/shifted.txt': 'banner\nline0\nalpha = 1\nbeta = 2\nline3\n',
            }[p]),
          },
        },
        {
          args: [{oldPath: 'doc/v1.md', newPath: 'doc/v2.md', targetPath: 'doc/diverged.md', outPath: 'doc/out.md', fileLabel: 'doc.md', fuzzFactor: 0}],
          toolImpls: {
            __clocks: [7000, 7005, 7010, 7015, 7020, 7025, 7030],
            readText: p => ({
              'doc/v1.md': 'title: old\nbody: same\nend\n',
              'doc/v2.md': 'title: new\nbody: same\nend\n',
              'doc/diverged.md': 'title: other\nbody: totally-different\nend\n',
            }[p]),
          },
        },
        {
          args: [{oldPath: 'missing.txt', fallbackOldPath: 'base.txt', newPath: 'next.txt', targetPath: 'base.txt', outPath: 'out.txt', fileLabel: 'fallback.txt', fuzzFactor: 0}],
          toolImpls: {
            __clocks: [8000, 8004, 8008, 8012, 8016, 8020, 8024],
            readText: p => {
              if (p === 'missing.txt') return {__reject: 'ENOENT: missing.txt'};
              if (p === 'base.txt') return 'k=1\nv=old\n';
              return 'k=1\nv=new\n';
            },
          },
        },
      ],
    },

    // =========================================================================
    // 3. fast-json-patch: json-patch-rfc6902 (Cat 1 & Cat 3: RFC6902, ~0/~1 escaping, aliasing)
    // =========================================================================
    {
      name: 'json-patch-rfc6902',
      lib: 'fastJsonPatch',
      category: 'diff-patching',
      features: ['diff', 'patch', 'mutation', 'alias', 'exception'],
      driver: `function run(doc, targetDoc, extraOps, mutateInPlace) {
  const {compare, applyPatch, validate} = __loadMod();
  const generated = compare(doc, targetDoc);
  const ops = generated.concat(extraOps);
  const validationErr = validate(ops, doc);
  if (validationErr) {
    return {
      ok: false,
      errorName: validationErr.name,
      index: validationErr.index,
      generatedCount: generated.length,
    };
  }
  const applied = applyPatch(doc, ops, true, mutateInPlace);
  return {
    ok: true,
    generatedCount: generated.length,
    totalOps: ops.length,
    aliasedInput: applied.newDocument === doc,
    result: applied.newDocument,
  };
}`,
      cases: [
        {
          args: [
            {routes: {'/v1/users': {rate: 10}, 'tilde~key': {on: true}}, list: ['a', 'b', 'c']},
            {routes: {'/v1/users': {rate: 25}, 'tilde~key': {on: false}}, list: ['a', 'c']},
            [
              {op: 'test', path: '/routes/~1v1~1users/rate', value: 25},
              {op: 'copy', from: '/routes/tilde~0key', path: '/routes/backup~0key'},
              {op: 'add', path: '/list/1', value: 'inserted'},
            ],
            true,
          ],
        },
        {
          args: [
            {cfg: {nested: {x: 1, y: 2}}, items: [{id: 1}, {id: 2}]},
            {cfg: {nested: {x: 1, y: 9, z: 3}}, items: [{id: 2}, {id: 1}]},
            [{op: 'move', from: '/items/0', path: '/items/-'}],
            false,
          ],
        },
        {
          args: [
            {flags: {a: true, b: false}, counts: [0, 0]},
            {flags: {a: true, b: false}, counts: [0, 5]},
            [{op: 'replace', path: '/flags/b', value: true}, {op: 'remove', path: '/flags/a'}],
            true,
          ],
        },
        {
          args: [
            {meta: {rev: 2, owner: 'ops'}},
            {meta: {rev: 3, owner: 'ops'}},
            [{op: 'test', path: '/meta/rev', value: 99}, {op: 'replace', path: '/meta/owner', value: 'bad'}],
            false,
          ],
        },
      ],
    },

    // =========================================================================
    // 4. marked: marked-pipeline (Cat 2 & Cat 5: fs.readText, console.log, fs.writeText)
    // =========================================================================
    {
      name: 'marked-pipeline',
      lib: 'marked',
      category: 'parsing-compilation',
      features: ['parsing', 'markdown', 'fs', 'platform', 'external', 'sequential'],
      driver: `async function run(mdPath, outHtmlPath, opts) {
  const {Lexer, Parser} = __loadMod();
  const t0 = Date.now();
  const raw = await host.readText(mdPath);
  const lexer = new Lexer({gfm: Boolean(opts.gfm), breaks: Boolean(opts.breaks)});
  const tokens = lexer.lex(raw);
  let headings = 0, tables = 0, codeBlocks = 0, tasks = 0;
  function walk(list) {
    for (let i = 0; i < list.length; i++) {
      const tok = list[i];
      if (tok.type === 'heading') headings++;
      else if (tok.type === 'table') tables++;
      else if (tok.type === 'code') codeBlocks++;
      else if (tok.type === 'list') {
        for (let j = 0; j < tok.items.length; j++) {
          if (tok.items[j].task) tasks++;
          if (tok.items[j].tokens) walk(tok.items[j].tokens);
        }
      }
      if (tok.tokens) walk(tok.tokens);
    }
  }
  walk(tokens);
  const parser = new Parser({gfm: Boolean(opts.gfm), breaks: Boolean(opts.breaks)});
  const html = parser.parse(tokens);
  const elapsed = Date.now() - t0;
  console.log('marked:h=' + headings + ',t=' + tables + ',c=' + codeBlocks + ',task=' + tasks + ',ms=' + elapsed);
  await host.writeText(outHtmlPath, html);
  return {headings, tables, codeBlocks, tasks, elapsed, htmlLength: html.length, html};
}`,
      cases: [
        {
          args: ['docs/spec.md', 'dist/spec.html', {gfm: true, breaks: false}],
          toolImpls: {
            readText: () => '# API Spec\n\n| Endpoint | Status | Notes |\n|:---|:---:|---:|\n| `/v1/a\\|b` | **OK** | 200 |\n| `/v1/c` | `ERR` | 500 |\n',
          },
        },
        {
          args: ['docs/guide.md', 'dist/guide.html', {gfm: true, breaks: true}],
          toolImpls: {
            readText: () => '## Setup\n\n~~~~markdown\n~~~js\nconst x = 1;\n~~~\n~~~~\n\nLine 1\nLine 2\n',
          },
        },
        {
          args: ['docs/tasks.md', 'dist/tasks.html', {gfm: true, breaks: false}],
          toolImpls: {
            readText: () => '# Sprint Café\n\n- [x] Parse *nested* `code`\n- [ ] Check [link](https://ex.test/a?x=1&y=2)\n  - [x] Subtask 🚀\n\n> Quoted **note** here\n',
          },
        },
        {
          args: ['docs/escape.md', 'dist/escape.html', {gfm: true, breaks: false}],
          toolImpls: {
            readText: () => '### Edge \\*Escapes\\*\n\nUse ~~old~~ and **bold _mix_** with `a < b & c > d`.\n\n1. First\n2. Second\n',
          },
        },
      ],
    },

    // =========================================================================
    // 5. graphql-js: graphql-ast-transform (Cat 2: GraphQL parsing, AST visitor, GraphQLError)
    // =========================================================================
    {
      name: 'graphql-ast-transform',
      lib: 'graphql',
      category: 'parsing-compilation',
      features: ['parsing', 'ast', 'graphql', 'exception'],
      driver: `function run(queryStr, stripSet) {
  const {parse, visit} = __loadMod();
  let ast;
  try {
    ast = parse(queryStr);
  } catch (err) {
    return {
      ok: false,
      errorName: err.name,
      message: err.message,
      locations: err.locations ?? [],
    };
  }
  const fields = [];
  const fragments = [];
  const variables = [];
  const directives = [];
  let maxDepth = 0;
  let depth = 0;
  const banned = new Set(stripSet);
  const transformed = visit(ast, {
    SelectionSet: {
      enter() { depth++; if (depth > maxDepth) maxDepth = depth; },
      leave() { depth--; },
    },
    VariableDefinition(node) {
      variables.push({
        name: node.variable.name.value,
        hasDefault: node.defaultValue != null,
      });
    },
    FragmentDefinition(node) {
      fragments.push({name: node.name.value, on: node.typeCondition.name.value});
    },
    Directive(node) {
      directives.push(node.name.value);
    },
    Field: {
      enter(node) {
        if (banned.has(node.name.value)) return null;
        fields.push((node.alias ? node.alias.value + ':' : '') + node.name.value);
      },
    },
  });
  return {
    ok: true,
    definitions: transformed.definitions.length,
    maxDepth,
    variables,
    fragments,
    directives,
    fields,
  };
}`,
      cases: [
        {
          args: [
            'query GetUser($id: ID!, $limit: Int = 10) { primary: user(id: $id) { id name email @include(if: true) ...UserFields } } fragment UserFields on User { role legacyBio }',
            ['legacyBio'],
          ],
        },
        {
          args: [
            'mutation UpdateItem($input: ItemInput = {qty: 2}) { updateItem(input: $input) { ok item { id title ... on Book { isbn } } } }',
            [],
          ],
        },
        {
          args: [
            'query Search($q: String!) { search(q: $q, note: """multi\nline "quoted" text""") { __typename ... on Node { id } } }',
            ['__typename'],
          ],
        },
        {
          args: [
            'query Broken($x: Int { user { id } }',
            [],
          ],
        },
      ],
    },

    // =========================================================================
    // 6. postcss: postcss-css-transform (Cat 2: CSS AST parse, walk, mutate, stringify)
    // =========================================================================
    {
      name: 'postcss-css-transform',
      lib: 'postcss',
      category: 'parsing-compilation',
      features: ['parsing', 'ast', 'css', 'mutation', 'exception'],
      driver: `function run(cssText, varOverrides, classPrefix) {
  const {parse, stringify} = __loadMod();
  let root;
  try {
    root = parse(cssText);
  } catch (err) {
    return {ok: false, errorName: err.name, reason: err.reason, line: err.line};
  }
  let rules = 0, atRules = 0, decls = 0, rewritten = 0;
  root.walkAtRules(() => { atRules++; });
  root.walkRules(rule => {
    rules++;
    if (classPrefix && rule.selector.includes('.')) {
      rule.selector = rule.selector.replace(/\\.([a-zA-Z_-][\\w-]*)/g, '.' + classPrefix + '$1');
    }
  });
  root.walkDecls(decl => {
    decls++;
    if (Object.hasOwn(varOverrides, decl.prop)) {
      decl.value = varOverrides[decl.prop];
      rewritten++;
    }
  });
  let css = '';
  stringify(root, chunk => { css += chunk; });
  return {ok: true, rules, atRules, decls, rewritten, css};
}`,
      cases: [
        {
          args: [
            ':root { --gap: 8px; --fg: #111; } @media (min-width: 700px) { .card > .title { margin: calc(var(--gap) * 2); color: var(--fg); } }',
            {'--gap': '12px'},
            'ui-',
          ],
        },
        {
          args: [
            '/* header comment */ @supports (display: grid) { .grid:is(.open, .active) { display: grid !important; gap: 4px; } }',
            {gap: '10px'},
            'app-',
          ],
        },
        {
          args: [
            '.btn\\:hover { padding: 4px 8px; --bg: "red"; } .btn\\:hover { --bg: "blue"; }',
            {'--bg': '"green"'},
            '',
          ],
        },
        {
          args: [
            '.broken { color: red; /* missing close brace */',
            {},
            '',
          ],
        },
      ],
    },

    // =========================================================================
    // 7. yargs-parser: yargs-cli-parser (Cat 2: CLI flag clusters, negation, dot-notation, --)
    // =========================================================================
    {
      name: 'yargs-cli-parser',
      lib: 'yargsParser',
      category: 'parsing-compilation',
      features: ['parsing', 'cli', 'object', 'array'],
      driver: `function run(argv, cfg) {
  const parser = __loadMod();
  const detailed = parser.detailed(argv, cfg);
  return {
    argv: detailed.argv,
    error: detailed.error ? String(detailed.error) : null,
    aliases: detailed.aliases,
    newAliases: detailed.newAliases,
  };
}`,
      cases: [
        {
          args: [
            ['-vvvq', '--no-color', '--max-jobs=12', 'build', 'src/index.ts'],
            {count: ['v'], boolean: ['q', 'color'], alias: {v: 'verbose', q: 'quiet'}, number: ['max-jobs']},
          ],
        },
        {
          args: [
            ['--db.host=localhost', '--db.port', '5432', '--db.tags', 'ro', '--db.tags', 'eu', '--dryRun'],
            {array: ['db.tags'], number: ['db.port'], boolean: ['dryRun'], configuration: {'dot-notation': true, 'camel-case-expansion': true}},
          ],
        },
        {
          args: [
            ['--tag', 'a=1', 'b=2', '--out', 'café.json', '--', '--raw-flag', 'pos'],
            {nargs: {tag: 2}, string: ['out'], configuration: {'populate--': true}},
          ],
        },
        {
          args: [
            ['--count', 'not-a-num', '--flag=false', '-abc', 'val'],
            {number: ['count'], boolean: ['flag'], alias: {a: 'alpha'}},
          ],
        },
      ],
    },

    // =========================================================================
    // 8. semver: semver-lockfile-resolver (Cat 2 & Cat 5: kv_get, Date.now, console.warn, fs.writeText)
    // =========================================================================
    {
      name: 'semver-lockfile-resolver',
      lib: 'semver',
      category: 'parsing-compilation',
      features: ['parsing', 'semver', 'native-bindings', 'platform', 'fs', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Lookup available version list for a package key, or null.'},
      ],
      driver: `async function run(deps, lockPath, allowPrerelease) {
  const {satisfies, rsort, maxSatisfying, minSatisfying, inc} = __loadMod();
  const resolved = {};
  const warnings = [];
  const t0 = Date.now();
  for (let i = 0; i < deps.length; i++) {
    const dep = deps[i];
    const versions = await kv_get('pkg:' + dep.name);
    if (!versions || !versions.length) {
      warnings.push('missing:' + dep.name);
      console.warn('semver-missing:' + dep.name);
      resolved[dep.name] = null;
      continue;
    }
    const sorted = rsort(versions.slice());
    const picked = dep.preferLowest
      ? minSatisfying(sorted, dep.range, {includePrerelease: allowPrerelease})
      : maxSatisfying(sorted, dep.range, {includePrerelease: allowPrerelease});
    if (!picked) {
      const candidate = inc(sorted[0], 'prerelease', 'rc');
      warnings.push('unsatisfied:' + dep.name + ':next=' + candidate);
      console.warn('semver-unsatisfied:' + dep.name + ':' + dep.range);
      resolved[dep.name] = {version: null, fallback: candidate, latest: sorted[0]};
      continue;
    }
    resolved[dep.name] = {
      version: picked,
      exactMatch: satisfies(picked, dep.range, {includePrerelease: allowPrerelease}),
      highestAvailable: sorted[0],
    };
  }
  const stamp = Date.now();
  const lock = {generatedAt: stamp, elapsedMs: stamp - t0, resolved, warnings};
  await host.writeText(lockPath, JSON.stringify(lock));
  return lock;
}`,
      cases: [
        {
          args: [
            [{name: 'core', range: '^0.2.3', preferLowest: false}, {name: 'cli', range: '~1.4.0-alpha.1', preferLowest: false}],
            'lock-0.json',
            true,
          ],
          toolImpls: {
            __clocks: [10000, 10045],
            kv_get: k => ({
              'pkg:core': ['0.2.1', '0.2.3', '0.2.9', '0.3.0'],
              'pkg:cli': ['1.4.0-alpha.1', '1.4.0-alpha.beta', '1.4.0-rc.1', '1.4.0', '1.5.0'],
            }[k] ?? null),
          },
        },
        {
          args: [
            [{name: 'sdk', range: '1.0.0-alpha <1.0.0 || >=2.0.0', preferLowest: true}, {name: 'util', range: '^2.0.0', preferLowest: false}],
            'lock-1.json',
            true,
          ],
          toolImpls: {
            __clocks: [20000, 20030],
            kv_get: k => ({
              'pkg:sdk': ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0', '2.1.0+build.7'],
              'pkg:util': ['1.9.0', '2.0.0-rc.1'],
            }[k] ?? null),
          },
        },
        {
          args: [
            [{name: 'web', range: '>=1.2.0 <2.0.0', preferLowest: false}, {name: 'ghost', range: '^1.0.0', preferLowest: false}],
            'lock-2.json',
            false,
          ],
          toolImpls: {
            __clocks: [30000, 30018],
            kv_get: k => ({
              'pkg:web': ['1.2.0', '1.5.0-beta.1', '1.4.9+meta', '2.0.0'],
            }[k] ?? null),
          },
        },
        {
          args: [
            [{name: 'parser', range: '^1.0.0 || ^2.0.0', preferLowest: true}, {name: 'lint', range: '~3.1.0', preferLowest: false}],
            'lock-3.json',
            false,
          ],
          toolImpls: {
            __clocks: [40000, 40022],
            kv_get: k => ({
              'pkg:parser': ['1.0.0-rc.1', '1.0.5', '2.3.0', '3.0.0'],
              'pkg:lint': ['3.0.9', '3.1.0', '3.1.4', '3.2.0'],
            }[k] ?? null),
          },
        },
      ],
    },

    // =========================================================================
    // 9. acorn-walk: acorn-ast-analyzer (Cat 2: ESTree AST walk, destructuring, scope)
    // =========================================================================
    {
      name: 'acorn-ast-analyzer',
      lib: 'acornWalk',
      category: 'parsing-compilation',
      features: ['parsing', 'ast', 'scope', 'closure'],
      driver: `function run(ast, probePos) {
  const walk = __loadMod();
  const decls = [];
  const reads = [];
  const calls = [];
  let maxTryDepth = 0;
  walk.ancestor(ast, {
    VariablePattern(node, _state, ancestors) {
      let fnDepth = 0;
      for (let i = 0; i < ancestors.length; i++) {
        const t = ancestors[i].type;
        if (t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression') fnDepth++;
      }
      decls.push({name: node.name, fnDepth});
    },
    Identifier(node, _state, ancestors) {
      let tryDepth = 0;
      for (let i = 0; i < ancestors.length; i++) {
        if (ancestors[i].type === 'TryStatement') tryDepth++;
      }
      if (tryDepth > maxTryDepth) maxTryDepth = tryDepth;
      reads.push(node.name);
    },
    CallExpression(node) {
      const callee = node.callee.type === 'Identifier' ? node.callee.name : 'member';
      calls.push({callee, argc: node.arguments.length});
    },
  });
  const hit = walk.findNodeAt(ast, probePos, probePos);
  return {
    decls,
    reads,
    calls,
    maxTryDepth,
    hitType: hit ? hit.node.type : null,
  };
}`,
      cases: [
        {
          args: [
            {
              type: 'Program', start: 0, end: 90,
              body: [{
                type: 'FunctionDeclaration', start: 0, end: 90,
                id: {type: 'Identifier', name: 'f', start: 9, end: 10},
                params: [{
                  type: 'ObjectPattern', start: 11, end: 27,
                  properties: [{
                    type: 'Property', kind: 'init', shorthand: false, computed: false, start: 12, end: 26,
                    key: {type: 'Identifier', name: 'a', start: 12, end: 13},
                    value: {
                      type: 'AssignmentPattern', start: 12, end: 26,
                      left: {type: 'Identifier', name: 'a', start: 12, end: 13},
                      right: {type: 'Identifier', name: 'fallback', start: 16, end: 24},
                    },
                  }],
                }],
                body: {
                  type: 'BlockStatement', start: 29, end: 90,
                  body: [{
                    type: 'ReturnStatement', start: 31, end: 88,
                    argument: {
                      type: 'ArrowFunctionExpression', start: 38, end: 87,
                      params: [{type: 'RestElement', start: 39, end: 46, argument: {type: 'Identifier', name: 'xs', start: 42, end: 44}}],
                      body: {
                        type: 'CallExpression', start: 51, end: 87,
                        callee: {type: 'Identifier', name: 'combine', start: 51, end: 58},
                        arguments: [
                          {type: 'Identifier', name: 'a', start: 59, end: 60},
                          {type: 'Identifier', name: 'xs', start: 62, end: 64},
                        ],
                      },
                    },
                  }],
                },
              }],
            },
            55,
          ],
        },
        {
          args: [
            {
              type: 'Program', start: 0, end: 80,
              body: [{
                type: 'TryStatement', start: 0, end: 80,
                block: {
                  type: 'BlockStatement', start: 4, end: 40,
                  body: [{
                    type: 'VariableDeclaration', kind: 'const', start: 6, end: 35,
                    declarations: [{
                      type: 'VariableDeclarator', start: 12, end: 34,
                      id: {
                        type: 'ArrayPattern', start: 12, end: 20,
                        elements: [
                          {type: 'Identifier', name: 'head', start: 13, end: 17},
                          {type: 'Identifier', name: 'tail', start: 18, end: 19},
                        ],
                      },
                      init: {
                        type: 'CallExpression', start: 23, end: 34,
                        callee: {type: 'Identifier', name: 'load', start: 23, end: 27},
                        arguments: [{type: 'Identifier', name: 'src', start: 28, end: 31}],
                      },
                    }],
                  }],
                },
                handler: {
                  type: 'CatchClause', start: 41, end: 65,
                  param: {type: 'Identifier', name: 'err', start: 48, end: 51},
                  body: {
                    type: 'BlockStatement', start: 53, end: 65,
                    body: [{
                      type: 'ExpressionStatement', start: 55, end: 63,
                      expression: {
                        type: 'CallExpression', start: 55, end: 63,
                        callee: {type: 'Identifier', name: 'log', start: 55, end: 58},
                        arguments: [{type: 'Identifier', name: 'err', start: 59, end: 62}],
                      },
                    }],
                  },
                },
                finalizer: null,
              }],
            },
            25,
          ],
        },
        {
          args: [
            {
              type: 'Program', start: 0, end: 70,
              body: [{
                type: 'ForOfStatement', start: 0, end: 70,
                left: {
                  type: 'VariableDeclaration', kind: 'const', start: 5, end: 16,
                  declarations: [{
                    type: 'VariableDeclarator', start: 11, end: 16,
                    id: {type: 'Identifier', name: 'item', start: 11, end: 15},
                    init: null,
                  }],
                },
                right: {type: 'Identifier', name: 'items', start: 20, end: 25},
                body: {
                  type: 'BlockStatement', start: 27, end: 70,
                  body: [{
                    type: 'ExpressionStatement', start: 29, end: 68,
                    expression: {
                      type: 'CallExpression', start: 29, end: 68,
                      callee: {
                        type: 'MemberExpression', computed: true, start: 29, end: 50,
                        object: {type: 'Identifier', name: 'handlers', start: 29, end: 37},
                        property: {type: 'Identifier', name: 'key', start: 38, end: 41},
                      },
                      arguments: [{type: 'Identifier', name: 'item', start: 51, end: 55}],
                    },
                  }],
                },
              }],
            },
            33,
          ],
        },
        {
          args: [
            {
              type: 'Program', start: 0, end: 60,
              body: [{
                type: 'VariableDeclaration', kind: 'let', start: 0, end: 50,
                declarations: [{
                  type: 'VariableDeclarator', start: 4, end: 49,
                  id: {type: 'Identifier', name: 'out', start: 4, end: 7},
                  init: {
                    type: 'ChainExpression', start: 10, end: 49,
                    expression: {
                      type: 'CallExpression', optional: true, start: 10, end: 49,
                      callee: {
                        type: 'MemberExpression', optional: false, computed: false, start: 10, end: 40,
                        object: {type: 'Identifier', name: 'svc', start: 10, end: 13},
                        property: {type: 'Identifier', name: 'fetch', start: 14, end: 19},
                      },
                      arguments: [{type: 'Identifier', name: 'arg', start: 41, end: 44}],
                    },
                  },
                }],
              }],
            },
            41,
          ],
        },
      ],
    },

    // =========================================================================
    // 10. immer: immer-structural-sharing (Cat 3: nested trees, structural sharing, inverse patches, aliasing)
    // =========================================================================
    {
      name: 'immer-structural-sharing',
      lib: 'immer',
      category: 'state-aliasing',
      features: ['state', 'immutable', 'structural-sharing', 'alias', 'patch'],
      driver: `function run(state, ops, rollbackCount) {
  const {produceWithPatches, applyPatches, enablePatches, setAutoFreeze, current} = __loadMod();
  enablePatches();
  setAutoFreeze(false);
  const origPreserved = state.preserved;
  let midSnapshot = null;
  const [next, patches, inversePatches] = produceWithPatches(state, draft => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === 'set') {
        let cur = draft;
        for (let k = 0; k < op.path.length - 1; k++) cur = cur[op.path[k]];
        cur[op.path[op.path.length - 1]] = op.val;
      } else if (op.type === 'push') {
        draft.active.items.push(op.val);
      } else if (op.type === 'splice') {
        draft.active.items.splice(op.idx, op.del, ...op.add);
      } else if (op.type === 'alias') {
        draft.mirror = draft.active;
        draft.mirror.count += op.delta;
      } else if (op.type === 'delete') {
        delete draft.active.meta[op.key];
      }
    }
    midSnapshot = current(draft.active);
  });
  const rolledBack = rollbackCount > 0
    ? applyPatches(next, inversePatches.slice(0, rollbackCount))
    : next;
  return {
    preservedShared: next.preserved === origPreserved,
    rootChanged: next !== state,
    mirrorAliased: next.mirror === next.active,
    patchCount: patches.length,
    midCount: midSnapshot.count,
    rolledBack,
  };
}`,
      cases: [
        {
          args: [
            {preserved: {cfg: {v: 1}}, active: {count: 10, items: ['a', 'b'], meta: {tag: 'x'}}, mirror: null},
            [{type: 'push', val: 'c'}, {type: 'alias', delta: 5}],
            0,
          ],
        },
        {
          args: [
            {preserved: {deep: [1, 2]}, active: {count: 3, items: [10, 20, 30], meta: {old: 1, keep: 2}}, mirror: null},
            [{type: 'splice', idx: 1, del: 1, add: [99, 100]}, {type: 'delete', key: 'old'}, {type: 'set', path: ['active', 'count'], val: 7}],
            1,
          ],
        },
        {
          args: [
            {preserved: {ok: true}, active: {count: 0, items: [], meta: {env: 'dev'}}, mirror: null},
            [{type: 'set', path: ['active', 'meta', 'env'], val: 'prod'}, {type: 'push', val: 'x'}, {type: 'push', val: 'y'}],
            2,
          ],
        },
        {
          args: [
            {preserved: {id: 'p1'}, active: {count: 4, items: ['k'], meta: {a: 1, b: 2}}, mirror: null},
            [{type: 'alias', delta: -4}, {type: 'delete', key: 'a'}, {type: 'splice', idx: 0, del: 1, add: ['z']}],
            0,
          ],
        },
      ],
    },

    // =========================================================================
    // 11. mutative: mutative-effectful-store (Cat 3 & Cat 5: kv_get, kv_set conflict retry, Date.now, console.warn)
    // =========================================================================
    {
      name: 'mutative-effectful-store',
      lib: 'mutative',
      category: 'state-aliasing',
      features: ['state', 'immutable', 'patch', 'native-bindings', 'platform', 'external', 'sequential', 'exception'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load versioned document {ver, state} from store.'},
        {name: 'kv_set', kind: 'promise', description: 'Compare-and-set document {ver, state, updatedAt}; rejects on conflict.'},
      ],
      driver: `async function run(docKey, ops, maxRetries) {
  const {create, apply, current} = __loadMod();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const rec = await kv_get(docKey);
    const baseState = JSON.parse(JSON.stringify(rec.state));
    const [next, patches, inverse] = create(baseState, draft => {
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (op.op === 'inc') draft.counters[op.key] = (draft.counters[op.key] ?? 0) + op.by;
        else if (op.op === 'append') draft.log.push(op.entry);
        else if (op.op === 'tag') draft.tags[op.key] = op.val;
      }
    }, {enablePatches: true});
    const ts = Date.now();
    try {
      await kv_set(docKey, {ver: rec.ver + 1, state: next, updatedAt: ts});
      console.info('cas-ok:' + docKey + ':v' + (rec.ver + 1));
      const reverted = apply(next, inverse);
      return {
        ok: true,
        attempts: attempt + 1,
        ver: rec.ver + 1,
        patchCount: patches.length,
        revertedMatchesOrig: JSON.stringify(reverted) === JSON.stringify(baseState),
        state: current(next),
      };
    } catch (err) {
      console.warn('cas-conflict:' + docKey + ':try=' + attempt + ':' + String(err));
    }
  }
  console.error('cas-exhausted:' + docKey);
  return {ok: false, attempts: maxRetries + 1, error: 'conflict-exhausted'};
}`,
      cases: [
        {
          args: ['doc:a', [{op: 'inc', key: 'hits', by: 3}, {op: 'append', entry: 'ok'}], 2],
          toolImpls: {
            __clocks: [11000],
            kv_get: () => ({ver: 1, state: {counters: {hits: 10}, log: ['init'], tags: {}}}),
            kv_set: () => true,
          },
        },
        {
          args: ['doc:b', [{op: 'inc', key: 'orders', by: 1}, {op: 'tag', key: 'tier', val: 'gold'}], 2],
          toolImpls: (() => {
            let calls = 0;
            return {
              __clocks: [21000, 21050],
              kv_get: () => (calls++ === 0
                ? {ver: 4, state: {counters: {orders: 2}, log: [], tags: {tier: 'silver'}}}
                : {ver: 5, state: {counters: {orders: 5}, log: ['concurrent'], tags: {tier: 'silver'}}}),
              kv_set: (_k, doc) => (doc.ver === 5 ? {__reject: 'stale-version'} : true),
            };
          })(),
        },
        {
          args: ['doc:c', [{op: 'append', entry: 'step1'}, {op: 'inc', key: 'err', by: 2}], 1],
          toolImpls: {
            __clocks: [31000, 31025],
            kv_get: () => ({ver: 8, state: {counters: {}, log: [], tags: {}}}),
            kv_set: () => ({__reject: 'cas-mismatch'}),
          },
        },
        {
          args: ['doc:d', [{op: 'tag', key: 'region', val: 'eu'}, {op: 'inc', key: 'q', by: -2}, {op: 'append', entry: 'done'}], 1],
          toolImpls: (() => {
            let calls = 0;
            return {
              __clocks: [41000, 41015],
              kv_get: () => (calls++ === 0
                ? {ver: 2, state: {counters: {q: 9}, log: ['start'], tags: {region: 'us'}}}
                : {ver: 3, state: {counters: {q: 12}, log: ['start', 'sync'], tags: {region: 'us'}}}),
              kv_set: (_k, doc) => (doc.ver === 3 ? {__reject: 'conflict'} : true),
            };
          })(),
        },
      ],
    },

    // =========================================================================
    // 12. d3-array: d3-array-precision-aliasing (Cat 3: Shewchuk fsum, in-place blur2 aliasing, jagged transpose, rollup/bin)
    // =========================================================================
    {
      name: 'd3-array-precision-aliasing',
      lib: 'd3Array',
      category: 'state-aliasing',
      features: ['float-precision', 'mutation', 'alias', 'array', 'map'],
      driver: `function run(spec) {
  const {fsum, fcumsum, blur, blur2, transpose, rollup, bin} = __loadMod();
  if (spec.mode === 'fsum') {
    let naive = 0;
    for (let i = 0; i < spec.values.length; i++) naive += spec.values[i];
    const exact = fsum(spec.values);
    const prefix = Array.from(fcumsum(spec.values));
    return {naive, exact, prefix};
  }
  if (spec.mode === 'blur2') {
    const grid = {data: spec.data, width: spec.width, height: spec.height};
    blur2(grid, spec.rx, spec.ry);
    const rounded = [];
    for (let i = 0; i < spec.data.length; i++) rounded.push(Math.round(spec.data[i] * 1000) / 1000);
    return {aliased: spec.aliasRef === spec.data, rounded};
  }
  if (spec.mode === 'blur1d') {
    blur(spec.values, spec.r);
    const rounded = [];
    for (let i = 0; i < spec.values.length; i++) rounded.push(Math.round(spec.values[i] * 1000) / 1000);
    return {aliased: spec.aliasRef === spec.values, rounded};
  }
  if (spec.mode === 'transpose_rollup') {
    const t = transpose(spec.matrix);
    const grouped = rollup(spec.records, vs => fsum(vs.map(x => x.v)), d => d.grp);
    const bins = bin().value(d => d.v).thresholds(spec.thresholds)(spec.records).map(b => ({x0: b.x0, x1: b.x1, len: b.length}));
    return {transposed: t, sameCellAlias: t[0][0] === spec.matrix[0][0], totals: Object.fromEntries(grouped), bins};
  }
  throw new TypeError('bad d3-array mode');
}`,
      cases: [
        {
          args: [{mode: 'fsum', values: [1, 1e100, 1, -1e100, 0.1, 0.2, -0.3]}],
        },
        {
          args: (() => {
            const arr = [0, 0, 0, 0, 9, 0, 0, 0, 0];
            return [{mode: 'blur2', data: arr, aliasRef: arr, width: 3, height: 3, rx: 1, ry: 1}];
          })(),
        },
        {
          args: (() => {
            const arr = [0, 10, 0, 0, 10, 0];
            return [{mode: 'blur1d', values: arr, aliasRef: arr, r: 1}];
          })(),
        },
        {
          args: (() => {
            const shared = {tag: 's'};
            return [{
              mode: 'transpose_rollup',
              matrix: [[shared, {tag: 'b'}, {tag: 'c'}], [{tag: 'd'}, {tag: 'e'}]],
              records: [{grp: 'a', v: 1}, {grp: 'b', v: 1e100}, {grp: 'a', v: 2.5}, {grp: 'b', v: -1e100}, {grp: 'b', v: 4}],
              thresholds: [0, 3, 10],
            }];
          })(),
        },
      ],
    },

    // =========================================================================
    // 13. es-toolkit: es-toolkit-nested-state (Cat 3: merge mutation, cloneDeep cycles, orderBy, partition)
    // =========================================================================
    {
      name: 'es-toolkit-nested-state',
      lib: 'esToolkit',
      category: 'state-aliasing',
      features: ['state', 'mutation', 'alias', 'cycle', 'array', 'object'],
      driver: `function run(baseObj, patchObj, records) {
  const {merge, cloneDeep, groupBy, partition, orderBy, uniqBy, pick, omit} = __loadMod();
  const origShared = baseObj.shared;
  const snapshot = cloneDeep(baseObj);
  const merged = merge(baseObj, patchObj);
  const uniq = uniqBy(records, r => r.id);
  const sorted = orderBy(uniq, ['score', 'id'], ['desc', 'asc']);
  const [passing, failing] = partition(sorted, r => r.score >= 50);
  const byTeam = groupBy(passing, r => r.team);
  const summary = {};
  const teams = Object.keys(byTeam).sort();
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    summary[t] = byTeam[t].map(r => omit(pick(r, ['id', 'score', 'team']), ['team']));
  }
  return {
    mutatedInPlace: merged === baseObj,
    sharedStillAliased: merged.shared === origShared,
    snapshotIsolated: snapshot.shared !== baseObj.shared,
    snapshotCyclicPreserved: snapshot.self === snapshot,
    failCount: failing.length,
    summary,
  };
}`,
      cases: [
        {
          args: (() => {
            const base = {shared: {a: 1, b: 2}, tags: ['x', 'y']};
            base.self = base;
            return [
              base,
              {shared: {b: 9, c: 3}, tags: ['z']},
              [{id: 2, team: 'red', score: 80}, {id: 1, team: 'red', score: 80}, {id: 2, team: 'blue', score: 10}, {id: 3, team: 'blue', score: 45}],
            ];
          })(),
        },
        {
          args: [
            {shared: {nested: {k: 1}, arr: [1, 2, 3]}, extra: true},
            {shared: {nested: {k: 2, m: 4}, arr: [9]}},
            [{id: 'b', team: 'ops', score: 50}, {id: 'a', team: 'ops', score: 50}, {id: 'c', team: 'ml', score: 95}],
          ],
        },
        {
          args: (() => {
            const base = {shared: {mode: 'v1', flags: {a: 1}}};
            base.self = base;
            return [
              base,
              {shared: {flags: {b: 2}}},
              [{id: 'x', team: 'qa', score: 49}, {id: 'y', team: 'qa', score: 12}],
            ];
          })(),
        },
        {
          args: [
            {shared: {café: 1, '🚀': 2}},
            {shared: {'🚀': 5, ok: true}},
            [{id: 'u1', team: 'core', score: 77}, {id: 'u2', team: 'core', score: 77}, {id: 'u1', team: 'alt', score: 10}],
          ],
        },
      ],
    },

    // =========================================================================
    // 14. quick-lru: quick-lru-ttl-readthrough (Cat 3 & Cat 5: Date.now TTL, onEviction, kv_get/kv_set)
    // =========================================================================
    {
      name: 'quick-lru-ttl-readthrough',
      lib: 'quickLru',
      category: 'state-aliasing',
      features: ['state', 'cache', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Read fallback value for key from backing KV store, or null.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist key/value pair to backing KV store.'},
      ],
      driver: `async function run(maxSize, maxAge, ops) {
  const QuickLRU = __loadMod();
  const evicted = [];
  const lru = new QuickLRU({
    maxSize,
    maxAge,
    onEviction: (k, v) => {
      evicted.push({k, v});
      console.info('evict:' + k);
    },
  });
  const out = [];
  let hits = 0, misses = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'set') {
      await kv_set(op.k, op.v);
      lru.set(op.k, op.v, op.ttl ? {maxAge: op.ttl} : undefined);
      out.push({op: 'set', k: op.k, size: lru.size});
    } else if (op.type === 'get') {
      if (lru.has(op.k)) {
        hits++;
        out.push({op: 'get', k: op.k, hit: true, v: lru.get(op.k)});
      } else {
        misses++;
        const remote = await kv_get(op.k);
        if (remote !== null) lru.set(op.k, remote);
        out.push({op: 'get', k: op.k, hit: false, v: remote});
      }
    }
  }
  return {hits, misses, finalSize: lru.size, evicted, out};
}`,
      cases: [
        {
          args: [2, 100, [{type: 'set', k: 'a', v: 1}, {type: 'set', k: 'b', v: 2}, {type: 'get', k: 'a'}, {type: 'set', k: 'c', v: 3}, {type: 'get', k: 'b'}]],
          toolImpls: {
            __clocks: [1000, 1005, 1010, 1015, 1020, 1025, 1030, 1035, 1040],
            kv_set: () => true,
            kv_get: k => 'db:' + k,
          },
        },
        {
          args: [2, 30, [{type: 'set', k: 'x', v: 10}, {type: 'get', k: 'x'}, {type: 'get', k: 'x'}]],
          toolImpls: {
            __clocks: [2000, 2010, 2010, 2045, 2045, 2050],
            kv_set: () => true,
            kv_get: () => 99,
          },
        },
        {
          args: [2, 500, [{type: 'get', k: 'm'}, {type: 'set', k: 'n', v: 7, ttl: 20}, {type: 'get', k: 'n'}, {type: 'get', k: 'm'}]],
          toolImpls: {
            __clocks: [3000, 3035, 3035, 3040, 3040, 3045],
            kv_set: () => true,
            kv_get: k => (k === 'm' ? null : 'fresh:' + k),
          },
        },
        {
          args: [1, 200, [{type: 'set', k: 'p', v: 'v1'}, {type: 'set', k: 'q', v: 'v2'}, {type: 'set', k: 'r', v: 'v3'}, {type: 'get', k: 'r'}]],
          toolImpls: {
            __clocks: [4000, 4002, 4004, 4006, 4008, 4010, 4012, 4014],
            kv_set: () => true,
            kv_get: () => null,
          },
        },
      ],
    },

    // =========================================================================
    // 15. async-validator: async-validator-http-ingest (Cat 4 & Cat 5: http.request, console.warn, Date.now, kv_set)
    // =========================================================================
    {
      name: 'async-validator-http-ingest',
      lib: 'asyncValidator',
      category: 'validation-templating',
      features: ['validation', 'schema', 'http', 'native-bindings', 'platform', 'external', 'sequential', 'exception'],
      nativeBindings: [
        {name: 'kv_set', kind: 'promise', description: 'Store validated record with timestamp.'},
      ],
      driver: `async function run(endpoint, batchIds, descriptor) {
  const Schema = __loadMod();
  const validator = new Schema(descriptor);
  const stored = [];
  const rejected = [];
  for (let i = 0; i < batchIds.length; i++) {
    const id = batchIds[i];
    let raw;
    try {
      raw = await host.httpRequest(endpoint + '/' + id, 'GET', '{"accept":"application/json"}', '');
    } catch (err) {
      console.warn('fetch-fail:' + id + ':' + String(err));
      rejected.push({id, stage: 'http', error: String(err)});
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (err) {
      console.warn('json-fail:' + id);
      rejected.push({id, stage: 'json', error: String(err)});
      continue;
    }
    try {
      await validator.validate(rec);
    } catch (err) {
      const fields = (err.errors ?? []).map(e => e.field).sort();
      console.warn('invalid:' + id + ':' + fields.join(','));
      rejected.push({id, stage: 'schema', fields});
      continue;
    }
    const ts = Date.now();
    await kv_set('valid:' + id, {rec, ts});
    stored.push({id, ts});
  }
  return {stored, rejected};
}`,
      cases: [
        {
          args: [
            'https://ingest.test/users',
            ['u1', 'u2', 'u3'],
            {
              email: {type: 'email', required: true},
              age: {type: 'integer', min: 18, max: 120},
              role: {type: 'enum', enum: ['admin', 'member']},
            },
          ],
          toolImpls: {
            __clocks: [50000, 50010],
            httpRequest: url => ({
              'https://ingest.test/users/u1': '{"email":"ada@ex.org","age":29,"role":"admin"}',
              'https://ingest.test/users/u2': '{"email":"bad-mail","age":15,"role":"guest"}',
              'https://ingest.test/users/u3': '{"email":"bob@ex.org","age":41,"role":"member"}',
            }[url]),
            kv_set: () => true,
          },
        },
        {
          args: [
            'https://ingest.test/orders',
            ['o1', 'o2'],
            {
              sku: {type: 'string', required: true, pattern: '^[A-Z]{2}-[0-9]{3}$'},
              items: {type: 'array', min: 1, defaultField: {type: 'integer', min: 1}},
            },
          ],
          toolImpls: {
            __clocks: [60000],
            httpRequest: url => (url.endsWith('o1')
              ? '{"sku":"AB-102","items":[1,3]}'
              : '{"sku":"bad","items":[0,-1]}'),
            kv_set: () => true,
          },
        },
        {
          args: [
            'https://ingest.test/events',
            ['e1', 'e2', 'e3'],
            {
              src: {type: 'url', required: true},
              meta: {type: 'object', required: true, fields: {trace: {type: 'string', len: 6, required: true}}},
            },
          ],
          toolImpls: {
            __clocks: [70000],
            httpRequest: url => {
              if (url.endsWith('e1')) return {__reject: 'HTTP 503'};
              if (url.endsWith('e2')) return '{bad-json';
              return '{"src":"https://ok.test/a","meta":{"trace":"abc123"}}';
            },
            kv_set: () => true,
          },
        },
        {
          args: [
            'https://ingest.test/hooks',
            ['h1', 'h2'],
            {
              name: {type: 'string', min: 3, max: 12, required: true},
              active: {type: 'boolean', required: true},
            },
          ],
          toolImpls: {
            __clocks: [80000, 80025],
            httpRequest: url => (url.endsWith('h1')
              ? '{"name":"webhook_1","active":true}'
              : '{"name":"x","active":"yes"}'),
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 16. validator: validator-payload-sanitizer (Cat 4: Unicode/IDN, IPv6, JWT, ISO8601, XSS escape)
    // =========================================================================
    {
      name: 'validator-payload-sanitizer',
      lib: 'validator',
      category: 'validation-templating',
      features: ['validation', 'unicode', 'escaping', 'security'],
      driver: `function run(records) {
  const v = __loadMod();
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    out.push({
      emailOk: v.isEmail(r.email),
      normalizedEmail: v.normalizeEmail(r.email),
      urlOk: v.isURL(r.url, {require_protocol: true}),
      ipV: v.isIP(r.ip, 4) ? 4 : v.isIP(r.ip, 6) ? 6 : 0,
      uuidOk: v.isUUID(r.uuid, 4),
      dateOk: v.isISO8601(r.date, {strict: true}),
      semverOk: v.isSemVer(r.ver),
      jwtOk: v.isJWT(r.jwt),
      jsonOk: v.isJSON(r.json),
      safeBio: v.escape(r.bio),
    });
  }
  return out;
}`,
      cases: [
        {
          args: [[{
            email: 'Foo.Bar+tag@gmail.com',
            url: 'https://sub.example.co.uk:8443/p?q=1',
            ip: '2001:db8::1',
            uuid: '550e8400-e29b-41d4-a716-446655440000',
            date: '2024-02-29',
            ver: '1.2.3-alpha.1+exp.sha',
            jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
            json: '{"k":[1,true]}',
            bio: '<script>alert("x&y")</script>',
          }]],
        },
        {
          args: [[{
            email: 'user@münchen.de',
            url: 'http://localhost:3000/bad spaces',
            ip: '192.168.0.256',
            uuid: '550e8400-e29b-11d4-a716-446655440000',
            date: '2025-02-29',
            ver: 'v1.2.3',
            jwt: 'not.a.jwt!',
            json: '{bad}',
            bio: "O'Reilly & Co \"dev\"",
          }]],
        },
        {
          args: [[{
            email: 'ada.lovelace@googlemail.com',
            url: 'example.com/no-proto',
            ip: '10.0.42.7',
            uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            date: '2026-11-26T12:30:00Z',
            ver: '2.0.0',
            jwt: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
            json: 'null',
            bio: 'a < b && c > d',
          }]],
        },
        {
          args: [[{
            email: 'invalid@@example.com',
            url: 'https://[2001:db8::1]/api',
            ip: 'fe80::1ff:fe23:4567:890a',
            uuid: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
            date: '2024-04-31',
            ver: '0.1.0-rc.2',
            jwt: 'abc.def',
            json: '{"ok":1}',
            bio: '`template` / path',
          }]],
        },
      ],
    },

    // =========================================================================
    // 17. mustache: mustache-render-pipeline (Cat 4 & Cat 5: fs.readText, console.log, fs.writeText)
    // =========================================================================
    {
      name: 'mustache-render-pipeline',
      lib: 'mustache',
      category: 'validation-templating',
      features: ['templating', 'escaping', 'fs', 'platform', 'external', 'sequential'],
      driver: `async function run(spec) {
  const Mustache = __loadMod();
  const tmpl = await host.readText(spec.tmplPath);
  const rawData = await host.readText(spec.dataPath);
  const data = JSON.parse(rawData);
  const partials = {};
  for (let i = 0; i < spec.partialNames.length; i++) {
    const name = spec.partialNames[i];
    partials[name] = await host.readText('partials/' + name + '.mustache');
  }
  const tokens = Mustache.parse(tmpl);
  const html = Mustache.render(tmpl, data, partials);
  console.log('mustache:tokens=' + tokens.length + ',bytes=' + html.length);
  await host.writeText(spec.outPath, html);
  return {tokenCount: tokens.length, byteLength: html.length, html};
}`,
      cases: [
        {
          args: [{tmplPath: 't/users.mustache', dataPath: 'd/users.json', partialNames: ['badge'], outPath: 'out/users.html'}],
          toolImpls: {
            readText: p => ({
              't/users.mustache': '<ul>{{#users}}<li>{{name}} {{>badge}} ({{{raw}}})</li>{{/users}}{{^users}}<li>empty</li>{{/users}}</ul>',
              'd/users.json': '{"users":[{"name":"Ada & Bob","role":"<admin>","raw":"<b>ok</b>"}]}',
              'partials/badge.mustache': '[{{role}}]',
            }[p]),
          },
        },
        {
          args: [{tmplPath: 't/empty.mustache', dataPath: 'd/empty.json', partialNames: [], outPath: 'out/empty.html'}],
          toolImpls: {
            readText: p => ({
              't/empty.mustache': '{{#items}}<span>{{.}}</span>{{/items}}{{^items}}<p>none for {{org.name}}</p>{{/items}}',
              'd/empty.json': '{"items":[],"org":{"name":"Acme <Corp>"}}',
            }[p]),
          },
        },
        {
          args: [{tmplPath: 't/delim.mustache', dataPath: 'd/delim.json', partialNames: [], outPath: 'out/delim.html'}],
          toolImpls: {
            readText: p => ({
              't/delim.mustache': '{{=<% %>=}}<dl><%#rows%><dt><%k%></dt><dd><%&v%></dd><%/rows%></dl><%={{ }}=%>{{tail}}',
              'd/delim.json': '{"rows":[{"k":"a&b","v":"<i>1</i>"}],"tail":"fin"}',
            }[p]),
          },
        },
        {
          args: [{tmplPath: 't/nested.mustache', dataPath: 'd/nested.json', partialNames: ['row', 'empty'], outPath: 'out/nested.html'}],
          toolImpls: {
            readText: p => ({
              't/nested.mustache': '{{#groups}}<h2>{{title}}</h2>{{#entries}}{{>row}}{{/entries}}{{^entries}}{{>empty}}{{/entries}}{{/groups}}',
              'd/nested.json': '{"title":"Top","groups":[{"title":"G1","entries":[{"id":1},{"id":2}]},{"title":"G2","entries":[]}]}',
              'partials/row.mustache': '[{{id}}:{{title}}]',
              'partials/empty.mustache': '(none in {{title}})',
            }[p]),
          },
        },
      ],
    },

    // =========================================================================
    // 18. i18next: i18next-locale-engine (Cat 4: Unicode plurals for pl/ar/de/en, nested vars, escaping)
    // =========================================================================
    {
      name: 'i18next-locale-engine',
      lib: 'i18next',
      category: 'validation-templating',
      features: ['i18n', 'unicode', 'pluralization', 'escaping'],
      driver: `function run(catalog, requests) {
  const {Interpolator, PluralResolver, LanguageUtils} = __loadMod();
  const lu = new LanguageUtils({fallbackLng: 'en'});
  const pr = new PluralResolver(lu, {simplifyPluralSuffix: true});
  const interp = new Interpolator({escapeValue: true});
  const results = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const langs = lu.toResolveHierarchy(req.lng);
    const suffix = pr.getSuffix(req.lng, req.count);
    let chosenLng = null;
    let template = null;
    for (let j = 0; j < langs.length; j++) {
      const code = langs[j];
      const dict = catalog[code];
      if (!dict) continue;
      if (suffix && Object.hasOwn(dict, req.key + suffix)) {
        chosenLng = code;
        template = dict[req.key + suffix];
        break;
      }
      if (Object.hasOwn(dict, req.key + '_other')) {
        chosenLng = code;
        template = dict[req.key + '_other'];
        break;
      }
      if (Object.hasOwn(dict, req.key)) {
        chosenLng = code;
        template = dict[req.key];
        break;
      }
    }
    const rendered = template === null
      ? req.key
      : interp.interpolate(template, {...req.vars, count: req.count}, chosenLng, {});
    results.push({lng: req.lng, chosenLng, suffix, rendered});
  }
  return results;
}`,
      cases: [
        {
          args: [
            {
              pl: {
                msg_one: '{{user.name}}: {{count}} wiadomość',
                msg_few: '{{user.name}}: {{count}} wiadomości',
                msg_many: '{{user.name}}: {{count}} wiadomości (dużo)',
              },
            },
            [
              {lng: 'pl', key: 'msg', count: 1, vars: {user: {name: 'Zofia'}}},
              {lng: 'pl', key: 'msg', count: 2, vars: {user: {name: 'Zofia'}}},
              {lng: 'pl', key: 'msg', count: 5, vars: {user: {name: 'Zofia'}}},
              {lng: 'pl', key: 'msg', count: 22, vars: {user: {name: 'Zofia'}}},
            ],
          ],
        },
        {
          args: [
            {
              ar: {
                item_zero: 'لا عناصر',
                item_one: 'عنصر واحد',
                item_two: 'عنصران',
                item_few: '{{count}} عناصر',
                item_many: '{{count}} عنصراً',
                item_other: '{{count}} عنصر',
              },
            },
            [
              {lng: 'ar', key: 'item', count: 0, vars: {}},
              {lng: 'ar', key: 'item', count: 1, vars: {}},
              {lng: 'ar', key: 'item', count: 2, vars: {}},
              {lng: 'ar', key: 'item', count: 5, vars: {}},
              {lng: 'ar', key: 'item', count: 15, vars: {}},
              {lng: 'ar', key: 'item', count: 100, vars: {}},
            ],
          ],
        },
        {
          args: [
            {
              en: {
                alert: 'Hi {{user.name}}, raw={{- user.badge}}, escaped={{user.badge}}',
              },
            },
            [
              {lng: 'de-AT', key: 'alert', count: 1, vars: {user: {name: 'O<K>', badge: '<b>VIP</b>'}}},
            ],
          ],
        },
        {
          args: [
            {
              de: {file_one: '{{count}} Datei', file_other: '{{count}} Dateien'},
              en: {fallbackOnly: 'English default: {{tag}}'},
            },
            [
              {lng: 'de-CH', key: 'file', count: 1, vars: {}},
              {lng: 'de-CH', key: 'file', count: 3, vars: {}},
              {lng: 'de-CH', key: 'fallbackOnly', count: 0, vars: {tag: 'v2'}},
              {lng: 'de-CH', key: 'missingKey', count: 0, vars: {}},
            ],
          ],
        },
      ],
    },

    // =========================================================================
    // 19. nunjucks: nunjucks-lex-filters (Cat 4: lexer + filters + randomMode: 'tool')
    // =========================================================================
    {
      name: 'nunjucks-lex-filters',
      lib: 'nunjucks',
      category: 'validation-templating',
      randomMode: 'tool',
      features: ['templating', 'parsing', 'filters', 'random', 'platform'],
      driver: `function run(template, records, pickFrom) {
  const {lexer, filters} = __loadMod();
  const stream = lexer.lex(template);
  const tokenTypes = [];
  let tok;
  while ((tok = stream.nextToken())) {
    if (tok.type !== lexer.TOKEN_WHITESPACE) tokenTypes.push(tok.type);
  }
  const sortedDict = filters.dictsort(records.meta);
  const batched = filters.batch(records.items, 2, records.pad);
  const grouped = filters.groupby.call({env: {opts: {throwOnUndefined: false}}}, records.rows, 'role');
  const summaryText = filters.truncate(
    filters.striptags(records.html, false),
    records.maxLen,
    false,
    '...'
  );
  const words = filters.wordcount(summaryText);
  const sampled = pickFrom.length ? filters.random(pickFrom) : null;
  return {tokenTypes, sortedDict, batched, grouped, summaryText, words, sampled};
}`,
      cases: [
        {
          args: [
            '{%- for u in users -%}{{ u.name | title }}{%- endfor -%}',
            {meta: {z: 3, a: 1, m: 2}, items: [1, 2, 3, 4, 5], pad: 0, rows: [{role: 'dev', n: 'A'}, {role: 'ops', n: 'B'}, {role: 'dev', n: 'C'}], html: '<p>Hello <b>nunjucks</b> world today</p>', maxLen: 22},
            ['alpha', 'beta', 'gamma'],
          ],
          toolImpls: {__randoms: [0.45]},
        },
        {
          args: [
            '{% macro pill(txt) %}{% raw %}{{literal}}{% endraw %}{{ txt | escape }}{% endmacro %}',
            {meta: {b: '2', a: '1'}, items: ['x', 'y', 'z'], pad: '-', rows: [{role: 'qa', n: 'Q1'}], html: '<div>One  two   three four</div>', maxLen: 40},
            ['solo'],
          ],
          toolImpls: {__randoms: [0.12]},
        },
        {
          args: [
            '{# comment #}{% if a and not b %}{{ c | default("none") }}{% endif %}',
            {meta: {k2: 20, k1: 10}, items: [10, 20, 30, 40], pad: null, rows: [{role: 'sec', n: 'S1'}, {role: 'sec', n: 'S2'}], html: '<a href="#">Click</a> now please', maxLen: 15},
            ['r1', 'r2', 'r3', 'r4'],
          ],
          toolImpls: {__randoms: [0.89]},
        },
        {
          args: [
            '{{ items | join(", ") | upper }}',
            {meta: {}, items: [7], pad: 9, rows: [], html: 'Plain text sentence', maxLen: 50},
            ['pickA', 'pickB'],
          ],
          toolImpls: {__randoms: [0.01]},
        },
      ],
    },

    // =========================================================================
    // 20. simple-statistics: simple-statistics-anomaly-stream (Cat 5: http.get, Math.random tool, Date.now, console.warn, fs.writeText)
    // =========================================================================
    {
      name: 'simple-statistics-anomaly-stream',
      lib: 'simpleStatistics',
      category: 'effectful-workflows',
      randomMode: 'tool',
      features: ['statistics', 'float-precision', 'http', 'random', 'platform', 'fs', 'external', 'sequential', 'exception'],
      driver: `async function run(batchUrls, sampleRate, zThresh, alertPath) {
  const ss = __loadMod();
  const batchReports = [];
  const alerts = [];
  for (let i = 0; i < batchUrls.length; i++) {
    const url = batchUrls[i];
    let payload;
    try {
      payload = JSON.parse(await host.httpGet(url));
    } catch (err) {
      console.warn('batch-fetch-err:' + i + ':' + String(err));
      batchReports.push({url, ok: false, error: String(err)});
      continue;
    }
    const vals = payload.values;
    const ts = Date.now();
    const roll = Math.random();
    const audited = roll < sampleRate;
    const avg = ss.mean(vals);
    const med = ss.median(vals);
    const sd = ss.standardDeviation(vals);
    const mad = ss.medianAbsoluteDeviation(vals);
    const iqr = ss.interquartileRange(vals);
    const points = vals.map((v, idx) => [idx, v]);
    const reg = vals.length >= 2 ? ss.linearRegression(points) : {m: 0, b: avg};
    const batchAlerts = [];
    if (sd > 0) {
      for (let j = 0; j < vals.length; j++) {
        const z = ss.zScore(vals[j], avg, sd);
        if (Math.abs(z) >= zThresh) {
          const zRound = Math.round(z * 1000) / 1000;
          batchAlerts.push({idx: j, val: vals[j], z: zRound});
          alerts.push({batch: i, idx: j, val: vals[j], z: zRound});
          console.warn('anomaly:b=' + i + ':idx=' + j + ':z=' + zRound);
        }
      }
    }
    batchReports.push({
      url,
      ok: true,
      ts,
      audited,
      mean: Math.round(avg * 1000) / 1000,
      median: med,
      sd: Math.round(sd * 1000) / 1000,
      mad,
      iqr,
      slope: Math.round(reg.m * 1000) / 1000,
      alerts: batchAlerts,
    });
  }
  const summary = {batches: batchReports.length, totalAlerts: alerts.length, batchReports};
  await host.writeText(alertPath, JSON.stringify(summary));
  return summary;
}`,
      cases: [
        {
          args: [['https://metrics.test/b0', 'https://metrics.test/b1'], 0.5, 1.8, 'alerts/r0.json'],
          toolImpls: {
            __clocks: [90000, 90020],
            __randoms: [0.21, 0.78],
            httpGet: u => (u.endsWith('b0')
              ? '{"values":[10,12,11,10,45]}'
              : '{"values":[5,5,5,5]}'),
          },
        },
        {
          args: [['https://metrics.test/c0', 'https://metrics.test/c1'], 0.3, 1.5, 'alerts/r1.json'],
          toolImpls: {
            __clocks: [91000, 91040],
            __randoms: [0.15, 0.92],
            httpGet: u => (u.endsWith('c0')
              ? '{"values":[-5,-4,-6,-5,20,-5]}'
              : '{"values":[1.5,2.5,3.5,4.5]}'),
          },
        },
        {
          args: [['https://metrics.test/d0', 'https://metrics.test/d1', 'https://metrics.test/d2'], 0.6, 1.7, 'alerts/r2.json'],
          toolImpls: {
            __clocks: [92000, 92030],
            __randoms: [0.59, 0.61],
            httpGet: u => {
              if (u.endsWith('d1')) return {__reject: '502 Bad Gateway'};
              if (u.endsWith('d0')) return '{"values":[100,102,99,101,150]}';
              return '{"values":[10,20,30,40,50]}';
            },
          },
        },
        {
          args: [['https://metrics.test/e0', 'https://metrics.test/e1'], 0.4, 1.6, 'alerts/r3.json'],
          toolImpls: {
            __clocks: [93000, 93015],
            __randoms: [0.4, 0.05],
            httpGet: u => (u.endsWith('e0')
              ? '{"values":[0.1,0.2,0.15,0.12,-4.0]}'
              : '{"values":[8,8,9,8,8]}'),
          },
        },
      ],
    },
  ];
}

async function main() {
  const templates = buildTemplates();
  const candidates = [];

  for (const tpl of templates) {
    const bundle = await buildLibBundle(tpl.lib);
    const wrappedDriver = tpl.driver.replace(/\{/, '{\n  const __loadMod = () => __harvestTarget;');
    const source = `"use strict";\nlet __harvestTarget;\n${bundle.code}\n${wrappedDriver}\n`;
    if (source.length > MAX_SOURCE_CHARS) {
      throw new Error(`${tpl.name} bundled source length ${source.length} exceeds ${MAX_SOURCE_CHARS}`);
    }
    const family = `hairy-real:${bundle.pkg}/${tpl.name}`;
    const cloneHash = nearCloneHash(source);
    const usesMathRandom = tpl.randomMode === 'tool' || /\bMath\.random\b/.test(source);

    for (let i = 0; i < tpl.cases.length; i++) {
      const c = tpl.cases[i];
      const encodedArgs = encodeReadable(structuredClone(c.args));
      const fixtureCalls = await recordTaskExecution({
        source,
        args: c.args,
        nativeBindings: tpl.nativeBindings ?? [],
        toolImpls: c.toolImpls ?? {},
        usesRandomTool: usesMathRandom,
      });
      const id = `hairy-js-${tpl.name}-${i}-${sha256([family, encodedArgs, fixtureCalls]).slice(0, 8)}`;
      const features = [
        ...new Set([
          'hairy-real',
          'native-v8',
          'real-oss',
          ...(tpl.features ?? []),
          ...(fixtureCalls.length ? ['external', 'sequential'] : []),
        ]),
      ].sort();
      candidates.push({
        id,
        family,
        source,
        entry: 'run',
        args: encodedArgs,
        executionMode: 'native',
        ...(usesMathRandom ? {randomMode: 'tool'} : {}),
        ...(tpl.nativeBindings ? {nativeBindings: structuredClone(tpl.nativeBindings)} : {}),
        fixture: {calls: fixtureCalls},
        randomSeed: 17,
        maxSteps: 100000,
        timeoutMs: 10000,
        metadata: {
          sourceOrigin: 'hairy-real-codebase',
          category: tpl.category,
          executionMode: 'native',
          package: bundle.pkg,
          version: bundle.version,
          license: bundle.license,
          repository: bundle.repository,
          tier: 5,
          template: family,
          lineage: [family, `hairy-real-pkg:${bundle.pkg}:${tpl.name}`, `near-clone:${cloneHash}`],
          features,
          externalCalls: fixtureCalls.length,
          inputVariant: i,
          evaluationRole: 'generalization',
          agentTaskSuccessVerified: false,
        },
      });
    }
  }

  const selected = limit ? candidates.slice(0, limit) : candidates;
  const results = new Array(selected.length);
  let next = 0;
  let failures = 0;

  await Promise.all(
    Array.from({length: Math.min(jobs, selected.length)}, async () => {
      while (next < selected.length) {
        const idx = next++;
        const task = selected[idx];
        try {
          if (task.source.length > MAX_SOURCE_CHARS) {
            throw new Error(`source ${task.source.length} > ${MAX_SOURCE_CHARS}`);
          }
          const exported = await exportTinkerExample(task, {traceFormat: 'compact'});
          if (!exported.metadata.traceAudit?.replayVerified) {
            throw new Error('traceAudit.replayVerified is false');
          }
          const lastMsg = exported.messages.at(-1);
          const lastText = Array.isArray(lastMsg?.content)
            ? lastMsg.content.find(c => c.type === 'text')?.text ?? ''
            : String(lastMsg?.content ?? '');
          const fenceMatch = lastText.match(/```json\n([\s\S]*?)\n```/);
          const completion = fenceMatch ? JSON.parse(fenceMatch[1]) : null;
          if (!completion || completion.kind !== 'return') {
            throw new Error(`unexpected completion kind: ${completion?.kind ?? 'missing'}`);
          }
          const traceLines = exported.messages
            .filter(m => m.role === 'assistant')
            .reduce((n, m) => {
              const t = assistantThinkingText(m).trim();
              return n + (t ? t.split('\n').length : 0);
            }, 0);
          if (traceLines < MIN_TRACE_LINES) {
            throw new Error(`compact trace ${traceLines} lines < ${MIN_TRACE_LINES}`);
          }
          const episodeChars = JSON.stringify(exported.messages).length;
          const approxTokens = Math.ceil(episodeChars / 3);
          if (approxTokens > MAX_APPROX_TOKENS) {
            throw new Error(`approx tokens ${approxTokens} > ${MAX_APPROX_TOKENS}`);
          }
          const enrichedTask = {
            ...exported.task,
            metadata: {
              ...exported.task.metadata,
              sourceChars: exported.task.source.length,
              traceLines,
              narrationLines: exported.metadata.traceAudit.narrationLines,
              assistantBytes: exported.metadata.traceAudit.assistantBytes,
              observationBytes: exported.metadata.traceAudit.observationBytes,
              episodeChars,
              approxTokens,
              externalCalls: exported.metadata.externalCalls,
            },
          };
          results[idx] = {ok: true, task: enrichedTask, exported};
        } catch (err) {
          failures++;
          results[idx] = {ok: false, id: task.id, family: task.family, error: String(err?.message ?? err)};
          process.stderr.write(`FAIL ${task.id}: ${err?.message ?? err}\n`);
        }
      }
    }),
  );

  const ok = results.filter(r => r?.ok);
  const srcLens = ok.map(r => r.task.metadata.sourceChars).sort((a, b) => a - b);
  const traceLens = ok.map(r => r.task.metadata.traceLines).sort((a, b) => a - b);
  const epChars = ok.map(r => r.task.metadata.episodeChars).sort((a, b) => a - b);
  const extCalls = ok.map(r => r.task.metadata.externalCalls);
  const effectfulTasks = ok.filter(r => r.task.metadata.externalCalls > 0);

  const summary = {
    totalCandidates: selected.length,
    verified: ok.length,
    failed: failures,
    families: new Set(ok.map(r => r.task.family)).size,
    distinctLibraries: new Set(ok.map(r => r.task.metadata.package)).size,
    effectfulCount: effectfulTasks.length,
    effectfulFamilies: new Set(effectfulTasks.map(r => r.task.family)).size,
    sourceChars: srcLens.length ? {min: srcLens[0], median: srcLens[Math.floor(srcLens.length / 2)], max: srcLens.at(-1)} : null,
    traceLines: traceLens.length ? {min: traceLens[0], median: traceLens[Math.floor(traceLens.length / 2)], max: traceLens.at(-1)} : null,
    episodeChars: epChars.length ? {min: epChars[0], median: epChars[Math.floor(epChars.length / 2)], max: epChars.at(-1)} : null,
    externalCallsRange: effectfulTasks.length
      ? {min: Math.min(...effectfulTasks.map(r => r.task.metadata.externalCalls)), max: Math.max(...extCalls)}
      : null,
  };

  if (failures > 0) {
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  const outPath = resolve(values.output);
  mkdirSync(dirname(outPath), {recursive: true});
  const rows = values['export-examples'] ? ok.map(r => r.exported) : ok.map(r => r.task);
  writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  summary.output = outPath;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
