#!/usr/bin/env node
// Build and verify Wave 2 of hairy, realistic JS/TS execution tasks directly on
// top of 32+ real open-source libraries cached on disk (ZERO overlap with Wave 1),
// bundled via esbuild (8–35 KB per task), auto-recorded for multi-turn side effects,
// and 100% verified via exportTinkerExample(..., {traceFormat: 'compact', reasoningChannel: 'thinking'})
// + auditTinkerSupervision().

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import vm from 'node:vm';
import {
  assistantThinkingText,
  encodeReadable,
  exportTinkerExample,
} from '../src/training/tinker-execution.js';
import {auditTinkerSupervision} from '../src/training/tinker-supervision.js';
import {nearCloneHash} from '../src/training/tinker-benchmark.js';
import {compileBoundedTypeScript} from '../src/typescript.js';

process.on('unhandledRejection', () => {});

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(__dirname, '../runs/hairy-real-js-wave2/tasks.jsonl');
const WAVE1_PATH = '/home/werg/tracing-js-self/runs/hairy-real-js-tasks/tasks.jsonl';
const MIN_SOURCE_CHARS = 8000;
const MAX_SOURCE_CHARS = 35840;
const MIN_TRACE_LINES = 100;
const MAX_TRACE_LINES = 600;
const MAX_APPROX_TOKENS = 28000;

const WAVE1_FAMILIES = new Set([
  'hairy-real:acorn-walk/acorn-ast-analyzer',
  'hairy-real:async-validator/async-validator-http-ingest',
  'hairy-real:d3-array/d3-array-precision-aliasing',
  'hairy-real:diff/diff-patch-effectful',
  'hairy-real:diff/diff-structured',
  'hairy-real:es-toolkit/es-toolkit-nested-state',
  'hairy-real:fast-json-patch/json-patch-rfc6902',
  'hairy-real:graphql/graphql-ast-transform',
  'hairy-real:i18next/i18next-locale-engine',
  'hairy-real:immer/immer-structural-sharing',
  'hairy-real:marked/marked-pipeline',
  'hairy-real:mustache/mustache-render-pipeline',
  'hairy-real:mutative/mutative-effectful-store',
  'hairy-real:nunjucks/nunjucks-lex-filters',
  'hairy-real:postcss/postcss-css-transform',
  'hairy-real:quick-lru/quick-lru-ttl-readthrough',
  'hairy-real:semver/semver-lockfile-resolver',
  'hairy-real:simple-statistics/simple-statistics-anomaly-stream',
  'hairy-real:validator/validator-payload-sanitizer',
  'hairy-real:yargs-parser/yargs-cli-parser',
]);

const WAVE1_PACKAGES = new Set([
  'acorn-walk', 'async-validator', 'd3-array', 'diff', 'es-toolkit',
  'fast-json-patch', 'graphql', 'i18next', 'immer', 'marked', 'mustache',
  'mutative', 'nunjucks', 'postcss', 'quick-lru', 'semver',
  'simple-statistics', 'validator', 'yargs-parser',
]);

const {values} = parseArgs({
  allowNegative: true,
  options: {
    output: {type: 'string', short: 'o', default: DEFAULT_OUTPUT},
    jobs: {type: 'string', default: '4'},
    limit: {type: 'string'},
    'export-examples': {type: 'boolean', default: false},
    'export-examples-path': {type: 'string'},
    audit: {type: 'boolean', default: true},
    'allow-over-600-lines': {type: 'boolean', default: false},
    'max-approx-tokens': {type: 'string'},
    help: {type: 'boolean', short: 'h'},
  },
});

if (values.help) {
  console.log(`Usage: node tools/tinker-build-hairy-js-wave2.mjs [options]
  -o, --output <path>            Output JSONL path (default: ${DEFAULT_OUTPUT})
  --jobs <n>                     Parallel verification workers (default: 4)
  --limit <n>                    Build only the first N tasks
  --export-examples              Write full exported conversations to --output
  --export-examples-path <path>  Also write exported compact conversations JSONL
  --no-audit                     Skip full auditTinkerSupervision pass`);
  process.exit(0);
}

const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));
const limit = values.limit ? Math.max(1, Number(values.limit)) : null;

const req = createRequire('/tmp/tinker-harvest-env/package.json');
const esbuild = req('esbuild');
const sha256 = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const stripTmpComments = code => code.replace(/^\s*\/\/ (?:\.\.\/)+\S+\r?\n/gm, '');

const STUB_EMPTY_NODE = {
  fs: 'export default {};',
  path: 'export default {};',
  os: 'export default {};',
  crypto: 'export default {};',
  url: 'export default {};',
};

const LIB_SPECS = {
  cborgVarint: {
    pkg: 'cborg',
    version: '4.5.8',
    license: 'Apache-2.0',
    repository: 'https://github.com/rvagg/cborg.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/orbitdb__orbitdb/node_modules',
    stdin: 'import {encode, decode} from "./cborg/cborg.js"; import * as varint from "./uint8-varint/src/index.js"; __harvestTarget = {encode, decode, varint};',
    minify: true,
    minifyId: true,
  },
  msgpack: {
    pkg: '@msgpack/msgpack',
    version: '2.8.0',
    license: 'ISC',
    repository: 'https://github.com/msgpack/msgpack-javascript.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/peers__peerjs/node_modules/@msgpack/msgpack',
    stdin: 'import {encode, decode} from "./dist.es5+esm/index.mjs"; __harvestTarget = {encode, decode};',
    minify: true,
    minifyId: true,
  },
  protobufRw: {
    pkg: 'protobufjs',
    version: '8.2.1',
    license: 'BSD-3-Clause',
    repository: 'https://github.com/protobufjs/protobuf.js.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/protobufjs__protobuf.js',
    stdin: 'const Reader = require("./src/reader.js"); const Writer = require("./src/writer.js"); __harvestTarget = {Reader, Writer};',
    minify: true,
    minifyId: true,
  },
  fflate: {
    pkg: 'fflate',
    version: '0.8.2',
    license: 'MIT',
    repository: 'https://github.com/101arrowz/fflate.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/vrtmrz__obsidian-livesync/node_modules/fflate',
    stdin: 'import {zlibSync, unzlibSync, gzipSync, gunzipSync, strToU8, strFromU8} from "./esm/browser.js"; __harvestTarget = {zlibSync, unzlibSync, gzipSync, gunzipSync, strToU8, strFromU8};',
    minify: false,
  },
  lzString: {
    pkg: 'lz-string',
    version: '1.5.0',
    license: 'MIT',
    repository: 'https://github.com/pieroxy/lz-string.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/testing-library__dom-testing-library/node_modules/lz-string',
    stdin: 'const LZ = require("./libs/lz-string.js"); __harvestTarget = LZ;',
    minify: false,
  },
  ramdaLens: {
    pkg: 'ramda',
    version: '0.32.0',
    license: 'MIT',
    repository: 'https://github.com/ramda/ramda.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/ramda',
    stdin: 'import {lensPath, view, set, over, evolve, mergeDeepWith, groupBy, sortWith, ascend, descend, prop} from "./es/index.js"; __harvestTarget = {lensPath, view, set, over, evolve, mergeDeepWith, groupBy, sortWith, ascend, descend, prop};',
    minify: true,
    minifyId: true,
  },
  toml: {
    pkg: 'toml',
    version: '3.0.0',
    license: 'MIT',
    repository: 'https://github.com/BinaryMuse/toml-node.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/smartcontractkit__solana-starter-kit/node_modules/toml',
    stdin: 'const toml = require("./index.js"); __harvestTarget = toml;',
    minify: true,
    minifyId: true,
  },
  papaparse: {
    pkg: 'papaparse',
    version: '5.7.1',
    license: 'MIT',
    repository: 'https://github.com/mholt/PapaParse.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2b/minbrowser__min/node_modules/papaparse',
    stdin: 'const Papa = require("./papaparse.js"); __harvestTarget = Papa;',
    minify: true,
    minifyId: true,
    stubs: {stream: 'export class Transform {}'},
  },
  dotenvIni: {
    pkg: 'dotenv',
    version: '18.0.10',
    license: 'BSD-2-Clause',
    repository: 'https://github.com/motdotla/dotenv.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules',
    stdin: 'const dotenv = require("./dotenv/dist/index.cjs"); const ini = require("./ini/lib/ini.js"); __harvestTarget = {dotenv, ini};',
    minify: false,
    stubs: STUB_EMPTY_NODE,
  },
  toon: {
    pkg: '@toon-format/toon',
    version: '2.2.0',
    license: 'MIT',
    repository: 'https://github.com/toon-format/toon.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2b/toon-format__toon/packages/toon/src',
    stdin: 'import {encode, decode} from "./index.ts"; __harvestTarget = {encode, decode};',
    loader: 'ts',
    minify: true,
    minifyId: true,
  },
  htmPangu: {
    pkg: 'htm',
    version: '3.1.1',
    license: 'Apache-2.0',
    repository: 'https://github.com/developit/htm.git',
    resolveDir: '/tmp/tinker-harvest-dgx',
    stdin: 'import htm from "./developit__htm/src/index.mjs"; import {pangu} from "./vinta__pangu.js/src/shared/index.ts"; __harvestTarget = {htm, pangu};',
    loader: 'ts',
    minify: false,
  },
  honoRouter: {
    pkg: 'hono',
    version: '4.12.18',
    license: 'MIT',
    repository: 'https://github.com/honojs/hono.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2b/honojs__hono/src/router',
    stdin: 'import {RegExpRouter} from "./reg-exp-router/index.ts"; import {TrieRouter} from "./trie-router/index.ts"; import {SmartRouter} from "./smart-router/index.ts"; __harvestTarget = {RegExpRouter, TrieRouter, SmartRouter};',
    loader: 'ts',
    minify: true,
  },
  ufo: {
    pkg: 'ufo',
    version: '1.6.4',
    license: 'MIT',
    repository: 'https://github.com/unjs/ufo.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/ufo',
    stdin: 'import * as ufo from "./dist/index.mjs"; __harvestTarget = ufo;',
    minify: false,
  },
  ittyCookie: {
    pkg: 'itty-router',
    version: '5.0.24',
    license: 'MIT',
    repository: 'https://github.com/kwhitley/itty-router.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules',
    stdin: 'import * as itty from "./itty-router/index.mjs"; import * as cookie from "./cookie/dist/index.js"; __harvestTarget = {itty, cookie};',
    minify: false,
  },
  picomatch: {
    pkg: 'picomatch',
    version: '4.0.7',
    license: 'MIT',
    repository: 'https://github.com/micromatch/picomatch.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/egoist__tsup/node_modules/picomatch',
    stdin: 'const pm = require("./index.js"); __harvestTarget = pm;',
    minify: true,
    minifyId: true,
  },
  superstruct: {
    pkg: 'superstruct',
    version: '0.15.5',
    license: 'MIT',
    repository: 'https://github.com/ianstormtaylor/superstruct.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/smartcontractkit__solana-starter-kit/node_modules/superstruct',
    stdin: 'import * as s from "./lib/index.es.js"; __harvestTarget = s;',
    minify: false,
  },
  tsPattern: {
    pkg: 'ts-pattern',
    version: '5.9.0',
    license: 'MIT',
    repository: 'https://github.com/gvergnaud/ts-pattern.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2b/gvergnaud__ts-pattern/src',
    stdin: 'import {match, P} from "./index.ts"; __harvestTarget = {match, P};',
    loader: 'ts',
    minify: true,
    minifyId: true,
  },
  mnemonistTrie: {
    pkg: 'mnemonist',
    version: '0.40.8',
    license: 'MIT',
    repository: 'https://github.com/yomguithereal/mnemonist.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/mnemonist',
    stdin: 'import TrieMap from "./trie-map.js"; import SymSpell from "./symspell.js"; __harvestTarget = {TrieMap, SymSpell};',
    minify: false,
  },
  mnemonistInterval: {
    pkg: 'mnemonist',
    version: '0.40.8',
    license: 'MIT',
    repository: 'https://github.com/yomguithereal/mnemonist.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/mnemonist',
    stdin: 'import StaticIntervalTree from "./static-interval-tree.js"; import SuffixArray from "./suffix-array.js"; __harvestTarget = {StaticIntervalTree, SuffixArray};',
    minify: false,
  },
  mnemonistGraph: {
    pkg: 'mnemonist',
    version: '0.40.8',
    license: 'MIT',
    repository: 'https://github.com/yomguithereal/mnemonist.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/mnemonist',
    stdin: 'import StaticDisjointSet from "./static-disjoint-set.js"; import FibonacciHeap from "./fibonacci-heap.js"; __harvestTarget = {StaticDisjointSet, FibonacciHeap};',
    minify: false,
  },
  lruCache: {
    pkg: 'lru-cache',
    version: '11.5.3',
    license: 'BlueOak-1.0.0',
    repository: 'https://github.com/isaacs/node-lru-cache.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/lru-cache',
    stdin: 'import {LRUCache} from "./dist/esm/index.js"; __harvestTarget = LRUCache;',
    minify: true,
  },
  heapJs: {
    pkg: 'heap-js',
    version: '3.0.0',
    license: 'BSD-3-Clause',
    repository: 'https://github.com/ignlg/heap-js.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/heap-js',
    stdin: 'import {Heap} from "./dist/heap-js.es5.js"; __harvestTarget = Heap;',
    minify: true,
    minifyId: true,
  },
  d3Hierarchy: {
    pkg: 'd3-hierarchy',
    version: '3.1.3',
    license: 'ISC',
    repository: 'https://github.com/d3/d3-hierarchy.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/d3-hierarchy',
    stdin: 'import * as h from "./dist/d3-hierarchy.mjs"; __harvestTarget = h;',
    minify: true,
  },
  dayjs: {
    pkg: 'dayjs',
    version: '1.11.0-dev',
    license: 'MIT',
    repository: 'https://github.com/iamkun/dayjs.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2b/iamkun__dayjs/src',
    stdin: 'import dayjs from "./index.js"; import utc from "./plugin/utc/index.js"; import isBetween from "./plugin/isBetween/index.js"; __harvestTarget = {dayjs, utc, isBetween};',
    minify: true,
  },
  d3TimeFormat: {
    pkg: 'd3-time-format',
    version: '4.1.1',
    license: 'ISC',
    repository: 'https://github.com/d3/d3-time-format.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules',
    stdin: 'import * as t from "./d3-time/dist/d3-time.mjs"; import * as tf from "./d3-time-format/dist/d3-time-format.mjs"; __harvestTarget = {...t, ...tf};',
    minify: true,
  },
  tinycolor2: {
    pkg: 'tinycolor2',
    version: '1.6.0',
    license: 'MIT',
    repository: 'https://github.com/bgrins/TinyColor.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/tinycolor2',
    stdin: 'import tinycolor from "./esm/tinycolor.js"; __harvestTarget = tinycolor;',
    minify: true,
  },
  bignumber: {
    pkg: 'bignumber.js',
    version: '9.2.1',
    license: 'MIT',
    repository: 'https://github.com/MikeMcl/bignumber.js.git',
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/smartcontractkit__solana-starter-kit/node_modules/bignumber.js',
    stdin: 'import BigNumber from "./bignumber.mjs"; __harvestTarget = BigNumber;',
    minify: true,
  },
  fractionJs: {
    pkg: 'fraction.js',
    version: '5.3.4',
    license: 'MIT',
    repository: 'https://github.com/rawify/Fraction.js.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/fraction.js',
    stdin: 'import Fraction from "./dist/fraction.mjs"; __harvestTarget = Fraction;',
    minify: false,
  },
  complexJs: {
    pkg: 'complex.js',
    version: '2.4.3',
    license: 'MIT',
    repository: 'https://github.com/rawify/Complex.js.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/complex.js',
    stdin: 'import Complex from "./dist/complex.mjs"; __harvestTarget = Complex;',
    minify: false,
  },
  d3Color: {
    pkg: 'd3-color',
    version: '3.1.1',
    license: 'ISC',
    repository: 'https://github.com/d3/d3-color.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules',
    stdin: 'import {color, cubehelix, hcl, hsl, lab, lch, rgb} from "./d3-color/dist/d3-color.mjs"; import {interpolateHcl, interpolateLab, interpolateRgb, quantize} from "./d3-interpolate/dist/d3-interpolate.mjs"; __harvestTarget = {color, cubehelix, hcl, hsl, lab, lch, rgb, interpolateHcl, interpolateLab, interpolateRgb, quantize};',
    minify: false,
  },
  deepmergeKlona: {
    pkg: 'deepmerge',
    version: '4.3.1',
    license: 'MIT',
    repository: 'https://github.com/TehShrike/deepmerge.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules',
    stdin: 'import deepmerge from "./deepmerge/dist/cjs.js"; import {klona} from "./klona/full/index.mjs"; import {dequal} from "./dequal/dist/index.mjs"; __harvestTarget = {deepmerge, klona, dequal};',
    minify: false,
  },
  redux: {
    pkg: 'redux',
    version: '5.0.1',
    license: 'MIT',
    repository: 'https://github.com/reduxjs/redux.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules/redux',
    stdin: 'import * as redux from "./dist/redux.legacy-esm.js"; __harvestTarget = redux;',
    minify: false,
  },
  normalizr: {
    pkg: 'normalizr',
    version: '3.6.2',
    license: 'MIT',
    repository: 'https://github.com/paularmstrong/normalizr.git',
    resolveDir: '/tmp/tinker-harvest-dgx/paularmstrong__normalizr',
    stdin: 'import {normalize, denormalize, schema} from "./src/index.js"; __harvestTarget = {normalize, denormalize, schema};',
    minify: false,
  },
  justDiff: {
    pkg: 'just-diff',
    version: '6.0.2',
    license: 'MIT',
    repository: 'https://github.com/angus-c/just.git',
    resolveDir: '/tmp/tinker-harvest-env/node_modules',
    stdin: 'const {diff} = require("./just-diff/index.cjs"); const {diffApply} = require("./just-diff-apply/index.cjs"); const clone = require("./just-clone/index.cjs"); __harvestTarget = {diff, diffApply, clone};',
    minify: false,
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
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser', 'import', 'default', 'require'],
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
async function recordTaskExecution({
  source,
  args,
  language = 'js',
  nativeBindings = [],
  toolImpls = {},
  usesRandomTool = false,
  randomSeed = 17,
}) {
  const execSource = language === 'ts'
    ? compileBoundedTypeScript(source, {path: 'training.ts'}).javascript
    : source;

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
    if (toolImpls.writeText) {
      const outcome = nextOrReject(toolImpls.writeText, [path, text], 'fs.writeText');
      if (outcome.rejected) throw outcome.value;
      return outcome.value;
    }
    recordedCalls.push({
      operation: 'fs.writeText',
      arguments: encodeReadable([path, text]),
      status: 'fulfilled',
      result: {$js: 'undefined'},
    });
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
      const encodedArgs = encodeReadable([b.name, undefined, callArgs]);
      const cloned = structuredClone(callArgs);
      if (b.kind === 'promise') {
        return Promise.resolve().then(() => {
          const res = impl(...cloned);
          if (res && typeof res === 'object' && res.__reject !== undefined) {
            recordedCalls.push({
              operation: 'natlang.call',
              arguments: encodedArgs,
              status: 'rejected',
              result: encodeReadable(res.__reject),
            });
            throw res.__reject;
          }
          recordedCalls.push({
            operation: 'natlang.call',
            arguments: encodedArgs,
            status: 'fulfilled',
            result: encodeReadable(res),
          });
          return structuredClone(res);
        });
      }
      const res = impl(...cloned);
      if (res && typeof res === 'object' && res.__reject !== undefined) {
        recordedCalls.push({
          operation: 'natlang.callSync',
          arguments: encodedArgs,
          status: 'rejected',
          result: encodeReadable(res.__reject),
        });
        throw res.__reject;
      }
      recordedCalls.push({
        operation: 'natlang.callSync',
        arguments: encodedArgs,
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

  if (/\bDate\.now\b/.test(execSource)) {
    new vm.Script('Date.now = __platformDateNow;').runInContext(ctx, {timeout: 200});
  }
  if (usesRandomTool || /\bMath\.random\b/.test(execSource)) {
    if (usesRandomTool) {
      new vm.Script('Math.random = __platformRandom;').runInContext(ctx, {timeout: 200});
    } else {
      ctx.__trainingRandomSeed = randomSeed;
      new vm.Script('(function(){let s=__trainingRandomSeed>>>0;Math.random=function(){s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};})();').runInContext(ctx, {timeout: 200});
    }
  }

  try {
    const val = new vm.Script(`${execSource}\n__result = run.apply(undefined, __args);`).runInContext(ctx, {timeout: 3000});
    if (val && typeof val.then === 'function') await val;
  } catch {
    // Throwing guest executions are valid JS completions.
  }
  return recordedCalls;
}

function buildTemplates() {
  return [
    // =========================================================================
    // 1. cborg + uint8-varint (Effectful: Date.now, kv_get, emit_metric, console.warn, fs.writeText)
    //    Variants 0 & 1 share identical args to test causal prefix / zero future leakage!
    // =========================================================================
    {
      name: 'cborg-varint-codec',
      lib: 'cborgVarint',
      category: 'binary-codecs',
      features: ['binary', 'codec', 'cbor', 'varint', 'native-bindings', 'platform', 'fs', 'external', 'sequential', 'exception'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load base64-encoded varint+CBOR frame by key.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Emit synchronous telemetry counter/gauge.'},
      ],
      driver: `async function run(frameKeys, outPath, reencode) {
  const {encode, decode, varint} = __loadMod();
  const tStart = Date.now();
  const decodedFrames = [];
  let totalBytes = 0;
  for (let i = 0; i < frameKeys.length; i++) {
    const key = frameKeys[i];
    let b64;
    try {
      b64 = await kv_get(key);
    } catch (err) {
      console.warn('kv-miss:' + key + ':' + String(err));
      emit_metric('cbor.kv_error', {key});
      decodedFrames.push({key, ok: false, stage: 'kv'});
      continue;
    }
    const tStep = Date.now();
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j);
    const declaredLen = varint.decode(bytes, 0);
    const hdrLen = varint.encodingLength(declaredLen);
    const body = bytes.slice(hdrLen, hdrLen + declaredLen);
    let payload;
    try {
      payload = decode(body);
    } catch (err) {
      console.warn('cbor-bad:' + key);
      decodedFrames.push({key, ok: false, stage: 'decode', ts: tStep});
      continue;
    }
    let outLen = body.length;
    if (reencode && i === 0) {
      const reencoded = encode({ok: true});
      const prefix = new Uint8Array(varint.encodingLength(reencoded.length) + reencoded.length);
      varint.encode(reencoded.length, prefix, 0);
      prefix.set(reencoded, varint.encodingLength(reencoded.length));
      outLen = prefix.length;
    }
    totalBytes += outLen;
    emit_metric('cbor.frame_ok', {key, bytes: outLen});
    decodedFrames.push({key, ok: true, declaredLen, outLen, payload, ts: tStep});
  }
  const tEnd = Date.now();
  const report = {elapsedMs: tEnd - tStart, totalBytes, frames: decodedFrames};
  await host.writeText(outPath, JSON.stringify(report));
  return report;
}`,
      cases: (() => {
        const encodeCborFrame = (obj) => {
          const enc = v => {
            if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24) return [v];
            if (typeof v === 'number' && Number.isInteger(v) && v >= 24 && v < 256) return [24, v];
            if (typeof v === 'number' && Number.isInteger(v) && v >= 256 && v < 65536) return [25, v >> 8, v & 255];
            if (v === true) return [0xf5];
            if (v === false) return [0xf4];
            if (v === null) return [0xf6];
            if (typeof v === 'string') {
              const u = Buffer.from(v, 'utf8');
              const hdr = u.length < 24 ? [0x60 | u.length] : [0x78, u.length];
              return [...hdr, ...u];
            }
            if (Array.isArray(v)) {
              const hdr = v.length < 24 ? [0x80 | v.length] : [0x98, v.length];
              return [...hdr, ...v.flatMap(enc)];
            }
            const ks = Object.keys(v);
            const hdr = ks.length < 24 ? [0xa0 | ks.length] : [0xb8, ks.length];
            return [...hdr, ...ks.flatMap(k => [...enc(k), ...enc(v[k])])];
          };
          const body = enc(obj);
          const vi = [];
          let n = body.length;
          while (n >= 0x80) { vi.push((n & 0x7f) | 0x80); n >>>= 7; }
          vi.push(n);
          return Buffer.from([...vi, ...body]).toString('base64');
        };
        const fA = encodeCborFrame({id: 1});
        const fB = encodeCborFrame({ok: true});
        const fBad = Buffer.from([3, 0xff, 0xff, 0xff]).toString('base64');
        return [
          {
            args: [['frm:0'], 'out/cbor-0.json', false],
            toolImpls: {
              __clocks: [10000, 10012, 10045],
              kv_get: () => fA,
              emit_metric: () => true,
            },
          },
          {
            // Identical args to case 0 -> causal divergence test!
            args: [['frm:0'], 'out/cbor-0.json', false],
            toolImpls: {
              __clocks: [10000, 10018, 10040],
              kv_get: () => ({__reject: 'kv-timeout'}),
              emit_metric: () => true,
            },
          },
          {
            args: [['frm:2', 'frm:3'], 'out/cbor-2.json', false],
            toolImpls: {
              __clocks: [20000, 20010, 20020, 20030],
              kv_get: k => ({'frm:2': encodeCborFrame(1), 'frm:3': encodeCborFrame(2)}[k]),
              emit_metric: () => true,
            },
          },
          {
            args: [['frm:4'], 'out/cbor-3.json', false],
            toolImpls: {
              __clocks: [30000, 30007, 30019],
              kv_get: () => encodeCborFrame('東京'),
              emit_metric: () => true,
            },
          },
        ];
      })(),
    },

    // =========================================================================
    // 2. @msgpack/msgpack (Effectful: Date.now, http.request, emit_metric, console.warn, kv_set)
    // =========================================================================
    {
      name: 'msgpack-rpc-frame',
      lib: 'msgpack',
      category: 'binary-codecs',
      features: ['binary', 'codec', 'msgpack', 'http', 'native-bindings', 'platform', 'external', 'sequential', 'exception'],
      nativeBindings: [
        {name: 'emit_metric', kind: 'synchronous', description: 'Record synchronous RPC metric.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist decoded RPC envelope.'},
      ],
      driver: `async function run(endpoint, rpcIds) {
  const {encode, decode} = __loadMod();
  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < rpcIds.length; i++) {
    const id = rpcIds[i];
    let b64;
    try {
      b64 = await host.httpRequest(endpoint + '/' + id, 'GET', '{"accept":"application/msgpack-b64"}', '');
    } catch (err) {
      console.warn('rpc-http-err:' + id);
      emit_metric('msgpack.http_fail', {id});
      results.push({id, ok: false, error: String(err)});
      continue;
    }
    const raw = atob(b64);
    const buf = new Uint8Array(raw.length);
    for (let j = 0; j < raw.length; j++) buf[j] = raw.charCodeAt(j);
    let msg;
    try {
      msg = decode(buf);
    } catch (err) {
      console.warn('rpc-decode-err:' + id);
      results.push({id, ok: false, error: 'decode-error'});
      continue;
    }
    const packed = i === 0 && rpcIds.length === 1 && !msg ? encode({ack: id}) : null;
    emit_metric('msgpack.ack_bytes', {id, len: packed ? packed.length : 0});
    results.push({id, ok: true, msg, packedLen: packed ? packed.length : 0});
  }
  const doneAt = Date.now();
  await kv_set('rpc:batch', {count: results.length, doneAt, results});
  return {elapsedMs: doneAt - t0, results};
}`,
      cases: (() => {
        // Minimal deterministic msgpack encoder for test fixtures
        const mp = v => {
          if (v === null) return [0xc0];
          if (v === false) return [0xc2];
          if (v === true) return [0xc3];
          if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 128) return [v];
          if (typeof v === 'number' && Number.isInteger(v) && v >= -32 && v < 0) return [v & 0xff];
          if (typeof v === 'string') {
            const u = Buffer.from(v, 'utf8');
            return u.length < 32 ? [0xa0 | u.length, ...u] : [0xd9, u.length, ...u];
          }
          if (Array.isArray(v)) return [0x90 | v.length, ...v.flatMap(mp)];
          const ks = Object.keys(v);
          return [0x80 | ks.length, ...ks.flatMap(k => [...mp(k), ...mp(v[k])])];
        };
        const b64 = v => Buffer.from(mp(v)).toString('base64');
        return [
          {
            args: ['https://rpc.test/frames', ['r1', 'r2']],
            toolImpls: {
              __clocks: [40000, 40005, 40020],
              httpRequest: u => (u.endsWith('r1') ? b64(1) : b64('🚀')),
              emit_metric: () => true,
              kv_set: () => true,
            },
          },
          {
            args: ['https://rpc.test/frames', ['r3', 'r4']],
            toolImpls: {
              __clocks: [41000, 41009, 41022],
              httpRequest: u => (u.endsWith('r3') ? {__reject: '503 Unavailable'} : b64({op: 'ok', v: -5})),
              emit_metric: () => true,
              kv_set: () => true,
            },
          },
          {
            args: ['https://rpc.test/frames', ['r5', 'r6']],
            toolImpls: {
              __clocks: [42000, 42010, 42025],
              httpRequest: u => (u.endsWith('r5') ? Buffer.from([0xc1]).toString('base64') : b64({ok: true, q: null})),
              emit_metric: () => true,
              kv_set: () => true,
            },
          },
          {
            args: ['https://rpc.test/frames', ['r7']],
            toolImpls: {
              __clocks: [43000, 43030],
              httpRequest: () => b64({ok: true, u: 'café'}),
              emit_metric: () => true,
              kv_set: () => true,
            },
          },
        ];
      })(),
    },

    // =========================================================================
    // 3. protobufjs Reader/Writer (Pure + zigzag + submessages + uncaught RangeError)
    // =========================================================================
    {
      name: 'protobuf-wire-codec',
      lib: 'protobufRw',
      category: 'binary-codecs',
      features: ['binary', 'codec', 'protobuf', 'varint', 'unicode', 'exception'],
      driver: `function run(records, truncateAt) {
  const {Reader, Writer} = __loadMod();
  const rootWriter = Writer.create();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const sub = rootWriter.uint32(10).fork();
    sub.uint32(8).sint32(rec.delta);
    sub.uint32(18).string(rec.label);
    if (rec.flag) sub.uint32(24).bool(true);
    for (let j = 0; j < rec.nums.length; j++) {
      sub.uint32(32).uint32(rec.nums[j]);
    }
    sub.ldelim();
  }
  let buf = rootWriter.finish();
  if (truncateAt > 0 && truncateAt < buf.length) {
    buf = buf.slice(0, truncateAt);
  }
  const reader = Reader.create(buf);
  const decoded = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wire = tag & 7;
    if (fieldNo !== 1 || wire !== 2) throw new TypeError('unexpected wire tag: ' + tag);
    const end = reader.uint32() + reader.pos;
    if (end > reader.len) throw new RangeError('truncated submessage past buffer len ' + reader.len);
    const item = {delta: 0, label: '', flag: false, nums: []};
    while (reader.pos < end) {
      const ftag = reader.uint32();
      const fn = ftag >>> 3;
      if (fn === 1) item.delta = reader.sint32();
      else if (fn === 2) item.label = reader.string();
      else if (fn === 3) item.flag = reader.bool();
      else if (fn === 4) item.nums.push(reader.uint32());
      else reader.skipType(ftag & 7);
    }
    decoded.push(item);
  }
  return {wireBytes: buf.length, decoded};
}`,
      cases: [
        {args: [[{delta: -42, label: 'café🚀', flag: true, nums: [1, 128, 16384]}, {delta: 999, label: 'beta', flag: false, nums: [0, 7]}], 0]},
        {args: [[{delta: -1, label: 'Zażółć', flag: false, nums: [300, 65535]}], 0]},
        {args: [[{delta: 0, label: '東京', flag: true, nums: []}], 0]},
        {args: [[{delta: -150, label: 'truncated-frame', flag: true, nums: [10, 20, 30]}], 6], expectThrow: true}, // uncaught RangeError!
      ],
    },

    // =========================================================================
    // 4. fflate (Effectful: Date.now, fs.readText with rejection fallback, console.info/warn, kv_set, fs.writeText)
    // =========================================================================
    {
      name: 'fflate-zlib-archive',
      lib: 'fflate',
      category: 'binary-codecs',
      features: ['binary', 'compression', 'zlib', 'fs', 'native-bindings', 'platform', 'external', 'sequential', 'exception'],
      nativeBindings: [
        {name: 'kv_set', kind: 'promise', description: 'Store archive checksum index.'},
      ],
      driver: `async function run(paths, fallbackPath, outPath, useGzip) {
  const {zlibSync, unzlibSync, gzipSync, gunzipSync, strToU8, strFromU8} = __loadMod();
  const t0 = Date.now();
  const entries = [];
  for (let i = 0; i < paths.length; i++) {
    let text;
    try {
      text = await host.readText(paths[i]);
    } catch (err) {
      console.warn('read-miss:' + paths[i]);
      text = await host.readText(fallbackPath);
    }
    const raw = strToU8(text);
    const comp = useGzip ? gzipSync(raw, {level: 0}) : zlibSync(raw, {level: 0});
    const round = i === 0 ? strFromU8(useGzip ? gunzipSync(comp) : unzlibSync(comp)) : text;
    const tMid = Date.now();
    console.info('packed:' + paths[i] + ':raw=' + raw.length + ':z=' + comp.length);
    entries.push({path: paths[i], rawLen: raw.length, compLen: comp.length, verified: round === text, ts: tMid});
  }
  const tEnd = Date.now();
  await kv_set('archive:idx', {count: entries.length, ts: tEnd});
  await host.writeText(outPath, JSON.stringify({elapsedMs: tEnd - t0, entries}));
  return {elapsedMs: tEnd - t0, entries};
}`,
      cases: [
        {
          args: [['a.log'], 'fallback.log', 'archive/0.json', false],
          toolImpls: {
            __clocks: [1000, 1004, 1015],
            readText: () => 'INFO a=1\n',
            kv_set: () => true,
          },
        },
        {
          args: [['missing.log'], 'default.log', 'archive/1.json', true],
          toolImpls: {
            __clocks: [2000, 2006, 2018],
            readText: p => (p === 'missing.log' ? {__reject: 'ENOENT'} : 'FALLBACK\n'),
            kv_set: () => true,
          },
        },
        {
          args: [['x.txt'], 'fallback.txt', 'archive/2.json', false],
          toolImpls: {
            __clocks: [3000, 3005, 3011],
            readText: () => 'hi 東京\n',
            kv_set: () => true,
          },
        },
        {
          args: [['m1.txt', 'm2.txt'], 'fb.txt', 'archive/3.json', false],
          toolImpls: {
            __clocks: [4000, 4003, 4007, 4012],
            readText: p => (p === 'm2.txt' ? {__reject: 'EACCES'} : 'ok\n'),
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 5. lz-string (Pure + in-place mutation + $js ref aliasing + Unicode surrogates + SyntaxError throw)
    // =========================================================================
    {
      name: 'lz-string-chunk-store',
      lib: 'lzString',
      category: 'binary-codecs',
      features: ['compression', 'unicode', 'mutation', 'alias', 'exception'],
      driver: `function run(store, mirror, text, corruptB64) {
  const LZ = __loadMod();
  if (corruptB64 !== null) {
    const res = LZ.decompressFromBase64(corruptB64);
    if (!res || res !== text) throw new SyntaxError('corrupt lz-string payload');
  }
  const b64 = LZ.compressToBase64(text);
  const utf16 = LZ.compressToUTF16(text);
  const uri = LZ.compressToEncodedURIComponent(text);
  const backB64 = LZ.decompressFromBase64(b64);
  const backUtf16 = LZ.decompressFromUTF16(utf16);
  const backUri = LZ.decompressFromEncodedURIComponent(uri);
  store.chunks.push({b64Len: b64.length, utf16Len: utf16.length, uriLen: uri.length});
  store.last = backUtf16;
  return {
    aliased: store === mirror,
    roundtripOk: backB64 === text && backUtf16 === text && backUri === text,
    chunkCount: store.chunks.length,
    uriPreview: uri.slice(0, 24),
  };
}`,
      cases: (() => {
        const mk = (txt, corrupt = null) => {
          const store = {chunks: [], last: null};
          return [store, store, txt, corrupt];
        };
        return [
          {args: mk('Café naïve résumé — 🚀✨ alpha/alpha/alpha')},
          {args: mk('東京大阪京都 — repeated repeated repeated data 12345')},
          {args: [{chunks: [{b64Len: 2}], last: 'prev'}, {chunks: [], last: null}, 'مصر العربية — hello world hello world', null]},
          {args: mk('expected-text', '@@@INVALID@@@'), expectThrow: true}, // uncaught SyntaxError!
        ];
      })(),
    },

    // =========================================================================
    // 6. ramda (Effectful: Date.now, fs.readText, kv_get fallback, emit_metric, console.warn, kv_set, fs.writeText)
    // =========================================================================
    {
      name: 'ramda-lens-pipeline',
      lib: 'ramdaLens',
      category: 'state-aliasing',
      features: ['functional', 'lens', 'immutable', 'fs', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load fallback policy profile.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Emit lens transform telemetry.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist updated profile snapshot.'},
      ],
      driver: `async function run(profilePath, overrideKey, outPath) {
  const {lensPath, view, set, over, evolve, mergeDeepWith, sortWith, ascend, descend, prop} = __loadMod();
  const t0 = Date.now();
  let base;
  try {
    base = JSON.parse(await host.readText(profilePath));
  } catch (err) {
    console.warn('ramda-read-miss:' + profilePath);
    base = await kv_get(overrideKey);
  }
  const quotaLens = lensPath(['limits', 'maxQps']);
  const origQps = view(quotaLens, base);
  const bumped = over(quotaLens, x => x + 25, base);
  const patch = await kv_get(overrideKey);
  const merged = mergeDeepWith((l, r) => (typeof l === 'number' && typeof r === 'number' ? l + r : r), bumped, patch || {});
  const evolved = evolve({limits: {burst: b => (b || 0) * 2}}, merged);
  const ordered = sortWith([descend(prop('score')), ascend(prop('id'))], evolved.nodes || []);
  const finalDoc = set(lensPath(['nodes']), ordered, evolved);
  const tMid = Date.now();
  emit_metric('ramda.lens_ok', {origQps, nextQps: view(quotaLens, finalDoc)});
  await kv_set('ramda:last', {qps: view(quotaLens, finalDoc), ts: tMid});
  await host.writeText(outPath, JSON.stringify(finalDoc));
  return {elapsedMs: Date.now() - t0, origQps, nextQps: view(quotaLens, finalDoc), finalDoc};
}`,
      cases: [
        {
          args: ['cfg/p0.json', 'prof:ov0', 'out/p0.json'],
          toolImpls: {
            __clocks: [5000, 5007, 5013],
            readText: () => '{"limits":{"maxQps":100,"burst":5},"nodes":[{"id":"b","score":10},{"id":"a","score":30}]}',
            kv_get: () => ({limits: {maxQps: 15}}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          // Identical args to case 0 -> causal divergence test!
          args: ['cfg/p0.json', 'prof:ov0', 'out/p0.json'],
          toolImpls: {
            __clocks: [5000, 5009, 5016],
            readText: () => ({__reject: 'ENOENT'}),
            kv_get: () => ({limits: {maxQps: 40, burst: 3}, nodes: [{id: 'z', score: 5}, {id: 'a', score: 20}]}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['cfg/p2.json', 'prof:ov2', 'out/p2.json'],
          toolImpls: {
            __clocks: [7000, 7004, 7010],
            readText: () => '{"limits":{"maxQps":50,"burst":4},"nodes":[{"id":"x","score":7}]}',
            kv_get: () => null,
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['cfg/p3.json', 'prof:ov3', 'out/p3.json'],
          toolImpls: {
            __clocks: [8000, 8005, 8011],
            readText: () => '{"limits":{"maxQps":200,"burst":1},"nodes":[{"id":"m1","score":50}]}',
            kv_get: () => ({limits: {burst: 9}}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 7. toml (Effectful: Date.now, fs.readText, kv_get, emit_metric, console.warn, fs.writeText)
    //    Variants 0 & 1 share identical args for causal prefix / zero future leakage audit!
    // =========================================================================
    {
      name: 'toml-config-cascade',
      lib: 'toml',
      category: 'parsers-formats',
      features: ['toml', 'parsing', 'fs', 'native-bindings', 'platform', 'external', 'sequential', 'exception'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load fallback TOML config override string.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Record synchronous TOML parser metric.'},
      ],
      driver: `async function run(basePath, overrideKey, outPath) {
  const toml = __loadMod();
  const t0 = Date.now();
  let baseText;
  try {
    baseText = await host.readText(basePath);
  } catch (err) {
    console.warn('toml-base-miss:' + basePath);
    baseText = await kv_get(overrideKey);
  }
  let parsed;
  try {
    parsed = toml.parse(baseText);
  } catch (err) {
    emit_metric('toml.syntax_err', {line: err.line ?? 0});
    console.warn('toml-syntax:' + String(err.line) + ':' + String(err.column));
    return {ok: false, line: err.line ?? null, column: err.column ?? null};
  }
  const tMid = Date.now();
  const overrideRaw = await kv_get(overrideKey);
  const overrideCfg = overrideRaw ? JSON.parse(overrideRaw) : {};
  const merged = {...parsed, ...overrideCfg};
  emit_metric('toml.merged', {keys: Object.keys(merged).length});
  const tEnd = Date.now();
  await host.writeText(outPath, JSON.stringify({merged, elapsedMs: tEnd - t0, midTs: tMid}));
  return {ok: true, elapsedMs: tEnd - t0, merged};
}`,
      cases: [
        {
          args: ['cfg/app.toml', 'toml:override', 'out/app.json'],
          toolImpls: {
            __clocks: [10000, 10005, 10011],
            readText: () => 'title = "Service"\n[server]\nhost = "127.0.0.1"\nports = [8000, 8001]\n[[routes]]\npath = "/api"\n',
            kv_get: () => '{"env":"prod","port":443}',
            emit_metric: () => true,
          },
        },
        {
          // Identical args to case 0 -> causal divergence test!
          args: ['cfg/app.toml', 'toml:override', 'out/app.json'],
          toolImpls: {
            __clocks: [10000, 10008],
            readText: () => ({__reject: 'EIO: disk read failed'}),
            kv_get: () => 'bad_key = [1, 2\n',
            emit_metric: () => true,
          },
        },
        {
          args: ['cfg/edge.toml', 'toml:edge', 'out/edge.json'],
          toolImpls: {
            __clocks: [20000, 20006, 20014],
            readText: () => 'flag = true\nratio = 1.5e2\n[meta."a.b"]\nnote = "café"\n',
            kv_get: () => '',
            emit_metric: () => true,
          },
        },
        {
          args: ['cfg/tables.toml', 'toml:tables', 'out/tables.json'],
          toolImpls: {
            __clocks: [30000, 30004, 30009],
            readText: () => '[[products]]\nname = "Hammer"\nsku = 738594937\n[[products]]\nname = "Nail"\n',
            kv_get: () => '{"owner":"ops"}',
            emit_metric: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 8. papaparse (Effectful: Date.now, http.get, console.warn, emit_metric, fs.writeText)
    // =========================================================================
    {
      name: 'papaparse-csv-etl',
      lib: 'papaparse',
      category: 'parsers-formats',
      features: ['csv', 'parsing', 'http', 'native-bindings', 'platform', 'fs', 'external', 'sequential'],
      nativeBindings: [
        {name: 'emit_metric', kind: 'synchronous', description: 'Record CSV ETL row counters.'},
      ],
      driver: `async function run(csvUrls, outPath, delim) {
  const Papa = __loadMod();
  const t0 = Date.now();
  const cleanRows = [];
  let errorCount = 0;
  let fetchErrors = 0;
  for (let u = 0; u < csvUrls.length; u++) {
    let csvText;
    try {
      csvText = await host.httpGet(csvUrls[u]);
    } catch (err) {
      console.warn('csv-fetch-err:' + String(err));
      emit_metric('csv.fetch_fail', {url: csvUrls[u]});
      fetchErrors++;
      continue;
    }
    const parsed = Papa.parse(csvText, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      delimiter: delim || '',
    });
    errorCount += parsed.errors.length;
    for (let i = 0; i < parsed.data.length; i++) {
      const r = parsed.data[i];
      if (r && r.qty > 0) cleanRows.push({sku: r.sku, total: Math.round(r.qty * r.price * 100) / 100});
    }
  }
  const tMid = Date.now();
  if (errorCount) console.warn('csv-parse-warns:' + errorCount);
  emit_metric('csv.rows', {kept: cleanRows.length, errs: errorCount, fetchErrors});
  const outCsv = Papa.unparse(cleanRows);
  await host.writeText(outPath, outCsv);
  const tEnd = Date.now();
  return {ok: fetchErrors === 0, elapsedMs: tEnd - t0, midTs: tMid, errorCount, fetchErrors, cleanRows, outCsv};
}`,
      cases: [
        {
          args: [['https://data.test/orders.csv'], 'out/orders.csv', ','],
          toolImpls: {
            __clocks: [50000, 50006, 50012],
            httpGet: () => 'sku,qty,price\n"A,1",2,12.50\n"B""2",0,9.00\n"C-3",3,4.25\n',
            emit_metric: () => true,
          },
        },
        {
          args: [['https://data.test/semi.csv'], 'out/semi.csv', ';'],
          toolImpls: {
            __clocks: [51000, 51005, 51010],
            httpGet: () => 'sku;qty;price\nX1;4;1.5\nBAD;1\n',
            emit_metric: () => true,
          },
        },
        {
          args: [['https://data.test/part1.csv', 'https://data.test/down.csv'], 'out/down.csv', ','],
          toolImpls: {
            __clocks: [52000, 52005, 52010],
            httpGet: u => (u.endsWith('down.csv') ? {__reject: 'HTTP 502 Bad Gateway'} : 'sku,qty,price\nP1,2,7.5\nP2,0,4\n'),
            emit_metric: () => true,
          },
        },
        {
          args: [['https://data.test/unicode.tsv'], 'out/unicode.csv', '\t'],
          toolImpls: {
            __clocks: [53000, 53004, 53009],
            httpGet: () => 'sku\tqty\tprice\ncafé\t2\t5.5\n🚀\t-1\t9\nZ\t1\t10.125\n',
            emit_metric: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 9. dotenv + ini (Effectful: Date.now, fs.readText, kv_get, console.warn, kv_set)
    // =========================================================================
    {
      name: 'dotenv-ini-overlay',
      lib: 'dotenvIni',
      category: 'parsers-formats',
      features: ['env', 'ini', 'parsing', 'fs', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load remote INI overlay text.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist merged environment snapshot.'},
      ],
      driver: `async function run(envPath, iniPath, overlayKey) {
  const {dotenv, ini} = __loadMod();
  const t0 = Date.now();
  const envRaw = await host.readText(envPath);
  const envObj = dotenv.parse(envRaw);
  let iniRaw;
  try {
    iniRaw = await host.readText(iniPath);
  } catch (err) {
    console.warn('ini-local-miss:' + iniPath);
    iniRaw = await kv_get(overlayKey);
  }
  const tMid = Date.now();
  const parsedIni = ini.parse(iniRaw);
  const safeIni = {};
  const keys = Object.keys(parsedIni);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k !== '__proto__') safeIni[k] = parsedIni[k];
  }
  const serialized = ini.stringify(safeIni, {section: 'app'});
  const tEnd = Date.now();
  await kv_set('cfg:merged', {envObj, safeIni, ts: tEnd});
  return {elapsedMs: tEnd - t0, midTs: tMid, envObj, safeIni, serialized};
}`,
      cases: [
        {
          args: ['.env', 'cfg/prod.ini', 'ini:prod'],
          toolImpls: {
            __clocks: [60000, 60004, 60009],
            readText: p => (p === '.env' ? 'PORT=8080\n' : 'mode=prod\n[db]\nhost=127.0.0.1\n'),
            kv_get: () => '',
            kv_set: () => true,
          },
        },
        {
          args: ['.env.stg', 'missing.ini', 'ini:stg'],
          toolImpls: {
            __clocks: [61000, 61005, 61012],
            readText: p => (p === '.env.stg' ? 'API_KEY=\'secret\'\n' : {__reject: 'ENOENT'}),
            kv_get: () => '[cache]\nttl=120\n',
            kv_set: () => true,
          },
        },
        {
          args: ['.env.dev', 'cfg/dev.ini', 'ini:dev'],
          toolImpls: {
            __clocks: [62000, 62003, 62007],
            readText: p => (p === '.env.dev' ? 'DEBUG=1\nGREETING="café 🚀"\n' : 'a.b=1\na.c=false\n'),
            kv_get: () => '',
            kv_set: () => true,
          },
        },
        {
          args: ['.env.sec', 'cfg/sec.ini', 'ini:sec'],
          toolImpls: {
            __clocks: [63000, 63006, 63011],
            readText: p => (p === '.env.sec' ? 'HOST=example.org # inline\n' : '[auth]\n__proto__.polluted=1\nuser=ada\n'),
            kv_get: () => '',
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 10. @toon-format/toon (Pure + TypeScript language: 'ts' + tabular array codec + SyntaxError throw)
    // =========================================================================
    {
      name: 'toon-codec-router',
      lib: 'toon',
      language: 'ts',
      category: 'parsers-formats',
      features: ['ts', 'toon', 'codec', 'serialization', 'unicode', 'exception'],
      driver: `function run(payload: Record<string, unknown>, rawOverride: string | null, strictMode: boolean) {
  const {encode, decode} = __loadMod();
  const encoded: string = encode(payload);
  const target: string = rawOverride !== null ? rawOverride : encoded;
  let decoded;
  try {
    decoded = decode(target, {strict: strictMode});
  } catch (err) {
    throw new SyntaxError(String((err as Error).message || err));
  }
  return {encoded, decoded, lineCount: encoded.split('\\n').length};
}`,
      cases: [
        {
          args: [
            {users: [{id: 1, name: 'Ada', role: 'admin'}, {id: 2, name: 'Bob', role: 'user'}, {id: 3, name: 'Zofia', role: 'ops'}], meta: {ver: 2}},
            null,
            true,
          ],
        },
        {
          args: [
            {events: [{ts: 100, tag: 'café'}, {ts: 200, tag: '🚀'}], flags: [true, false, null]},
            null,
            true,
          ],
        },
        {
          args: [
            {ok: true},
            'items[2]{sku,qty}:\n  A1,5\n  B2,12',
            true,
          ],
        },
        {
          args: [
            {ok: true},
            'items[3]{sku,qty}:\n  A1,5\n  B2,12',
            true,
          ],
          expectThrow: true, // throws SyntaxError on length mismatch in strict mode!
        },
      ],
    },

    // =========================================================================
    // 11. htm + pangu (Pure + JSX-like template AST + CJK/ASCII spacing + template cache)
    // =========================================================================
    {
      name: 'htm-pangu-sanitizer',
      lib: 'htmPangu',
      category: 'parsers-formats',
      features: ['html', 'jsx', 'ast', 'unicode', 'cjk'],
      driver: `function run(title, items) {
  const {htm, pangu} = __loadMod();
  function h(type, props, ...children) {
    const flat = [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (Array.isArray(c)) {
        for (let j = 0; j < c.length; j++) flat.push(c[j]);
      } else if (c !== null && c !== undefined && c !== false) {
        flat.push(typeof c === 'string' ? pangu.spacingText(c) : c);
      }
    }
    return {type, props: props || {}, children: flat};
  }
  const html = htm.bind(h);
  const renderedItems = items.map(it => html\`<li data-id=\${it.id}><b>\${it.label}</b>: \${it.note}</li>\`);
  return html\`<section class="panel"><h1>\${title}</h1><ul>\${renderedItems}</ul></section>\`;
}`,
      cases: [
        {args: ['测试Node.js版本v22', [{id: 1, label: 'CPU使用率', note: '达到85%阈值'}, {id: 2, label: 'Memory内存', note: 'OK'}]]},
        {args: ['Hello世界123', [{id: 'a', label: 'API接口', note: '返回200状态'}]]},
        {args: ['東京Tokyo案内', [{id: 10, label: 'Café咖啡', note: 'Price价格$12'}]]},
        {args: ['Empty列表', []]},
      ],
    },

    // =========================================================================
    // 12. hono routers (Effectful: Date.now, kv_get, http.request, Math.random canary, emit_metric, console.warn, kv_set)
    //     Variants 0 & 1 share identical args for causal prefix / zero future leakage audit!
    // =========================================================================
    {
      name: 'hono-smart-router',
      lib: 'honoRouter',
      category: 'routing-patterns',
      randomMode: 'tool',
      features: ['routing', 'http', 'native-bindings', 'random', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load route table array.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Record synchronous routing telemetry.'},
        {name: 'kv_set', kind: 'promise', description: 'Store routing audit log.'},
      ],
      driver: `async function run(tableKey, requests, canaryPct) {
  const {RegExpRouter, TrieRouter, SmartRouter} = __loadMod();
  const t0 = Date.now();
  const routes = await kv_get(tableKey);
  const router = new SmartRouter({routers: [new RegExpRouter(), new TrieRouter()]});
  for (let i = 0; i < routes.length; i++) {
    router.add(routes[i].method, routes[i].path, routes[i].target);
  }
  const log = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const matched = router.match(req.method, req.url);
    const hits = matched[0] || [];
    if (!hits.length) {
      console.warn('route-404:' + req.method + ':' + req.url);
      emit_metric('router.miss', {url: req.url});
      log.push({url: req.url, status: 404});
      continue;
    }
    const [target, params] = hits[0];
    const canary = Math.random() < canaryPct;
    const upstream = canary ? target + '/canary' : target;
    let body;
    try {
      body = await host.httpRequest(upstream, req.method, '{}', '');
    } catch (err) {
      console.warn('upstream-err:' + upstream);
      body = await host.httpRequest(target + '/fallback', 'GET', '{}', '');
    }
    const ts = Date.now();
    emit_metric('router.hit', {target, canary});
    log.push({url: req.url, target, params, canary, body, ts});
  }
  await kv_set('router:audit', {elapsedMs: Date.now() - t0, log});
  return {elapsedMs: Date.now() - t0, log};
}`,
      cases: [
        {
          args: ['routes:v1', [{method: 'GET', url: '/users/42'}, {method: 'POST', url: '/orders/new'}], 0.5],
          toolImpls: {
            __clocks: [10000, 10005, 10011, 10018],
            __randoms: [0.25, 0.75],
            kv_get: () => [
              {method: 'GET', path: '/users/:id{[0-9]+}', target: 'https://svc.test/users'},
              {method: 'POST', path: '/orders/:action', target: 'https://svc.test/orders'},
            ],
            httpRequest: u => (u.includes('canary') ? 'canary-ok' : 'primary-ok'),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          // Identical args to case 0 -> causal divergence test!
          args: ['routes:v1', [{method: 'GET', url: '/users/42'}, {method: 'POST', url: '/orders/new'}], 0.5],
          toolImpls: {
            __clocks: [10000, 10009, 10020],
            __randoms: [0.10],
            kv_get: () => [{method: 'GET', path: '/users/:id{[0-9]+}', target: 'https://svc.test/users'}],
            httpRequest: u => (u.includes('canary') ? {__reject: '502 Bad Gateway'} : 'fallback-ok'),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['routes:v2', [{method: 'GET', url: '/files/a/b/c.txt'}, {method: 'DELETE', url: '/files/a'}], 0.2],
          toolImpls: {
            __clocks: [20000, 20004, 20008],
            __randoms: [0.88],
            kv_get: () => [{method: 'GET', path: '/files/*', target: 'https://cdn.test/files'}],
            httpRequest: () => 'file-bytes',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['routes:v3', [{method: 'GET', url: '/api/v1/items/abc'}], 0.9],
          toolImpls: {
            __clocks: [30000, 30007, 30014],
            __randoms: [0.33],
            kv_get: () => [{method: 'GET', path: '/api/:ver/items/:slug', target: 'https://api.test'}],
            httpRequest: () => 'item-json',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 13. ufo (Pure + URL parsing, query param arrays, encoding, joinURL, resolveURL, TypeError)
    // =========================================================================
    {
      name: 'ufo-url-canonicalizer',
      lib: 'ufo',
      category: 'routing-patterns',
      features: ['url', 'parsing', 'unicode', 'exception'],
      driver: `function run(baseUrl, relPaths, extraQuery) {
  const ufo = __loadMod();
  const out = [];
  for (let i = 0; i < relPaths.length; i++) {
    if (relPaths[i].startsWith('bad://')) {
      throw new TypeError('disallowed scheme in path: ' + relPaths[i]);
    }
    const joined = ufo.joinURL(baseUrl, relPaths[i]);
    const withQ = ufo.withQuery(joined, extraQuery);
    const cleaned = ufo.withoutTrailingSlash(withQ, true);
    const parsed = ufo.parseURL(cleaned);
    const query = ufo.parseQuery(parsed.search);
    out.push({
      cleaned,
      host: parsed.host,
      pathname: parsed.pathname,
      query,
      sameOrigin: ufo.isSamePath('/api/v1', '/api/v1/'),
    });
  }
  return out;
}`,
      cases: [
        {args: ['https://example.org/api//', ['v1/users/', '../v2/items?sort=asc&tag=a&tag=b'], {page: '2', q: 'café 🚀'}]},
        {args: ['https://[2001:db8::1]:8443/base', ['sub/path/', 'other?k=1&k=2'], {token: 'x+y/z='}]},
        {args: ['http://münchen.example/root/', ['./docs//intro/', '#frag'], {lang: 'de'}]},
        {args: ['https://api.test/v1', ['ok/one', 'ok/two', 'bad://reject'], {x: '1'}], expectThrow: true}, // uncaught TypeError after non-trivial work!
      ],
    },

    // =========================================================================
    // 14. itty-router + cookie (Effectful: Date.now, http.get, console.info/warn, emit_metric, kv_set)
    // =========================================================================
    {
      name: 'itty-cookie-gateway',
      lib: 'ittyCookie',
      category: 'routing-patterns',
      features: ['routing', 'cookie', 'http', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'emit_metric', kind: 'synchronous', description: 'Record gateway metric.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist gateway session audit.'},
      ],
      driver: `async function run(requests) {
  const {itty, cookie} = __loadMod();
  const t0 = Date.now();
  const router = itty.Router();
  router.get('/session/:sid', async (req) => {
    const cookies = cookie.parseCookie(req.cookieHeader || '');
    let profile;
    try {
      profile = JSON.parse(await host.httpGet('https://auth.test/u/' + req.params.sid));
    } catch (err) {
      console.warn('auth-err:' + req.params.sid);
      return {status: 502, sid: req.params.sid, theme: cookies.theme || 'light'};
    }
    const setHdr = cookie.stringifySetCookie({
      name: 'sid',
      value: req.params.sid,
      httpOnly: true,
      path: '/',
      maxAge: 3600,
      sameSite: 'lax',
    });
    emit_metric('gw.session_ok', {sid: req.params.sid});
    return {status: 200, user: profile.user, theme: cookies.theme || 'light', setHdr};
  });
  router.all('*', () => ({status: 404}));
  const responses = [];
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const res = await router.fetch({method: r.method, url: r.url, cookieHeader: r.cookieHeader});
    console.info('gw:' + r.method + ':' + res.status);
    responses.push({...res, ts: Date.now()});
  }
  await kv_set('gw:responses', responses);
  return {elapsedMs: Date.now() - t0, responses};
}`,
      cases: [
        {
          args: [[{method: 'GET', url: 'https://gw.test/session/s10', cookieHeader: 'theme=dark; locale=pl'}, {method: 'POST', url: 'https://gw.test/unknown', cookieHeader: ''}]],
          toolImpls: {
            __clocks: [1000, 1004, 1009, 1015],
            httpGet: () => '{"user":"ada"}',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: [[{method: 'GET', url: 'https://gw.test/session/s20', cookieHeader: 'theme=sepia'}, {method: 'GET', url: 'https://gw.test/session/s21', cookieHeader: ''}]],
          toolImpls: {
            __clocks: [2000, 2005, 2011, 2018],
            httpGet: u => (u.endsWith('s20') ? {__reject: 'auth-timeout'} : '{"user":"bob"}'),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: [[{method: 'GET', url: 'https://gw.test/session/café', cookieHeader: 'theme=hc; empty='}]],
          toolImpls: {
            __clocks: [3000, 3006, 3012],
            httpGet: () => '{"user":"zofia"}',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: [[{method: 'GET', url: 'https://gw.test/nope', cookieHeader: ''}, {method: 'GET', url: 'https://gw.test/session/s99', cookieHeader: 'a=1; theme=nord'}]],
          toolImpls: {
            __clocks: [4000, 4003, 4008, 4014],
            httpGet: () => '{"user":"ops"}',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 15. picomatch (Effectful: Date.now, fs.readText, console.warn, emit_metric, fs.writeText)
    // =========================================================================
    {
      name: 'picomatch-acl-scanner',
      lib: 'picomatch',
      category: 'routing-patterns',
      features: ['glob', 'parsing', 'fs', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'emit_metric', kind: 'synchronous', description: 'Record ACL match stats.'},
      ],
      driver: `async function run(rulesPath, paths, outPath) {
  const pm = __loadMod();
  const t0 = Date.now();
  let rawRules;
  try {
    rawRules = await host.readText(rulesPath);
  } catch (err) {
    console.warn('acl-fallback:' + rulesPath);
    rawRules = 'src/**/*.ts\\n!src/**/*.spec.ts\\n';
  }
  const patterns = rawRules.split('\\n').map(s => s.trim()).filter(Boolean);
  const allow = [];
  const deny = [];
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    if (p.startsWith('!')) deny.push(pm(p.slice(1), {dot: true}));
    else allow.push(pm(p, {dot: true}));
  }
  const tMid = Date.now();
  const baseInfo = pm.scan(patterns[0]).base;
  const scanned = [];
  let allowedCount = 0;
  for (let i = 0; i < paths.length; i++) {
    const file = paths[i];
    const isAllow = allow.some(fn => fn(file));
    const isDeny = deny.some(fn => fn(file));
    const ok = isAllow && !isDeny;
    if (ok) allowedCount++;
    scanned.push({file, ok, base: baseInfo});
  }
  emit_metric('acl.scan', {total: paths.length, allowed: allowedCount});
  const tEnd = Date.now();
  await host.writeText(outPath, JSON.stringify({elapsedMs: tEnd - t0, midTs: tMid, scanned}));
  return {elapsedMs: tEnd - t0, allowedCount, scanned};
}`,
      cases: [
        {
          args: ['acl/main.rules', ['src/index.ts', 'src/index.spec.ts'], 'out/acl0.json'],
          toolImpls: {
            __clocks: [10000, 10004, 10009],
            readText: () => 'src/**/*.ts\n!src/**/*.spec.ts\n',
            emit_metric: () => true,
          },
        },
        {
          args: ['acl/missing.rules', ['src/app.ts', 'src/app.spec.ts'], 'out/acl1.json'],
          toolImpls: {
            __clocks: [11000, 11005, 11011],
            readText: () => ({__reject: 'ENOENT'}),
            emit_metric: () => true,
          },
        },
        {
          args: ['acl/ext.rules', ['lib/a.js', 'lib/a.min.js'], 'out/acl2.json'],
          toolImpls: {
            __clocks: [12000, 12003, 12008],
            readText: () => 'lib/**/!(*.min).js\n',
            emit_metric: () => true,
          },
        },
        {
          args: ['acl/uni.rules', ['docs/café.md', 'docs/tmp/a.md'], 'out/acl3.json'],
          toolImpls: {
            __clocks: [13000, 13004, 13010],
            readText: () => 'docs/**/*.md\n!docs/tmp/**\n',
            emit_metric: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 16. superstruct (Effectful: Date.now, http.request, kv_get, console.warn, emit_metric, kv_set)
    //     Variants 0 & 1 share identical args for causal prefix / zero future leakage audit!
    // =========================================================================
    {
      name: 'superstruct-webhook-guard',
      lib: 'superstruct',
      category: 'validation-schemas',
      features: ['validation', 'schema', 'http', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Check idempotency key in store.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Record webhook validation metric.'},
        {name: 'kv_set', kind: 'promise', description: 'Store validated webhook event.'},
      ],
      driver: `async function run(endpoint, eventIds) {
  const s = __loadMod();
  const t0 = Date.now();
  const EventStruct = s.object({
    id: s.size(s.string(), 2, 24),
    kind: s.enums(['invoice.paid', 'refund.created', 'user.updated']),
    amount: s.defaulted(s.number(), 0),
  });
  const accepted = [];
  const rejected = [];
  for (let i = 0; i < eventIds.length; i++) {
    const eid = eventIds[i];
    const seen = await kv_get('idem:' + eid);
    if (seen) {
      console.warn('dup-event:' + eid);
      emit_metric('webhook.dup', {eid});
      rejected.push({eid, stage: 'dup'});
      continue;
    }
    let raw;
    try {
      raw = await host.httpRequest(endpoint + '/' + eid, 'GET', '{}', '');
    } catch (err) {
      console.warn('webhook-http-err:' + eid);
      rejected.push({eid, stage: 'http'});
      continue;
    }
    const parsed = JSON.parse(raw);
    const [err, val] = s.validate(parsed, EventStruct, {coerce: true});
    if (err) {
      const paths = err.failures().map(f => f.path.join('.'));
      console.warn('webhook-invalid:' + eid + ':' + paths.join(','));
      emit_metric('webhook.invalid', {eid, count: paths.length});
      rejected.push({eid, stage: 'schema', paths});
      continue;
    }
    const ts = Date.now();
    await kv_set('idem:' + eid, {val, ts});
    accepted.push({eid, val, ts});
  }
  return {elapsedMs: Date.now() - t0, accepted, rejected};
}`,
      cases: [
        {
          args: ['https://hooks.test/ev', ['e1', 'e2']],
          toolImpls: {
            __clocks: [70000, 70006, 70013],
            kv_get: () => null,
            httpRequest: u => (u.endsWith('e1')
              ? '{"id":"ev_1","kind":"invoice.paid","amount":199}'
              : '{"id":"x","kind":"bad","amount":-5}'),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          // Identical args to case 0 -> causal divergence test!
          args: ['https://hooks.test/ev', ['e1', 'e2']],
          toolImpls: {
            __clocks: [70000, 70010],
            kv_get: k => (k === 'idem:e1' ? {already: true} : null),
            httpRequest: () => ({__reject: '504 Gateway Timeout'}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['https://hooks.test/ev', ['e3', 'e4']],
          toolImpls: {
            __clocks: [71000, 71005, 71011, 71019],
            kv_get: () => null,
            httpRequest: u => (u.endsWith('e3')
              ? '{"id":"ev_3","kind":"refund.created"}'
              : '{"id":"ev_4","kind":"user.updated"}'),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['https://hooks.test/ev', ['e5']],
          toolImpls: {
            __clocks: [72000, 72009],
            kv_get: () => null,
            httpRequest: () => '{"id":"ev_5","kind":"invoice.paid","amount":-1}',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 17. ts-pattern (Pure + TypeScript language: 'ts' + P.select + exhaustive Error throw)
    // =========================================================================
    {
      name: 'ts-pattern-state-machine',
      lib: 'tsPattern',
      language: 'ts',
      category: 'validation-schemas',
      features: ['ts', 'pattern-matching', 'state', 'exception'],
      driver: `function run(events: Array<{type: string; [k: string]: unknown}>) {
  const {match, P} = __loadMod();
  const state: {balance: number; status: string; notes: string[]} = {balance: 0, status: 'init', notes: []};
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    let delta: number;
    try {
      delta = match(ev)
        .with({type: 'open', initial: P.number}, (e) => {
          state.status = 'open';
          return e.initial;
        })
        .with({type: 'credit', amount: P.when((n: unknown) => typeof n === 'number' && n > 0)}, (e) => {
          state.notes.push('cr:' + String(e.amount));
          return e.amount as number;
        })
        .with({type: 'debit', amount: P.select('amt')}, ({amt}) => {
          state.notes.push('db:' + String(amt));
          return -(amt as number);
        })
        .with({type: 'close'}, () => {
          state.status = 'closed';
          return 0;
        })
        .exhaustive();
    } catch (err) {
      throw new TypeError(String((err as Error).message || err));
    }
    state.balance += delta;
  }
  return state;
}`,
      cases: [
        {args: [[{type: 'open', initial: 100}, {type: 'credit', amount: 50}, {type: 'debit', amount: 30}, {type: 'close'}]]},
        {args: [[{type: 'open', initial: 0}, {type: 'credit', amount: 25}, {type: 'credit', amount: 75}, {type: 'debit', amount: 40}]]},
        {args: [[{type: 'open', initial: 500}, {type: 'debit', amount: 125}, {type: 'close'}]]},
        {args: [[{type: 'open', initial: 10}, {type: 'unknown_op', amount: 5}]], expectThrow: true}, // throws TypeError!
      ],
    },

    // =========================================================================
    // 18. mnemonist TrieMap + SymSpell (Effectful: Date.now, fs.readText, kv_get, emit_metric, kv_set)
    // =========================================================================
    {
      name: 'mnemonist-trie-symspell',
      lib: 'mnemonistTrie',
      category: 'data-structures',
      features: ['trie', 'symspell', 'fuzzy-search', 'fs', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load fallback dictionary terms.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Emit search latency/hits metric.'},
        {name: 'kv_set', kind: 'promise', description: 'Cache search suggestions.'},
      ],
      driver: `async function run(dictPath, queries) {
  const {TrieMap, SymSpell} = __loadMod();
  const t0 = Date.now();
  let raw;
  try {
    raw = await host.readText(dictPath);
  } catch (err) {
    console.warn('dict-miss:' + dictPath);
    raw = await kv_get('dict:fallback');
  }
  const words = raw.split(/\\s+/).filter(Boolean);
  const trie = new TrieMap();
  const sym = new SymSpell({maxDistance: 1});
  for (let i = 0; i < words.length; i++) {
    trie.set(words[i], i + 1);
    sym.add(words[i]);
  }
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const prefixHits = trie.find(q).map(x => x[0]).sort();
    const fuzzyHits = sym.search(q).map(x => ({term: x.term, dist: x.distance}));
    out.push({q, prefixHits, fuzzyHits});
  }
  const tBuilt = Date.now();
  emit_metric('trie.queries', {count: queries.length, buildMs: tBuilt - t0});
  const tEnd = Date.now();
  await kv_set('trie:last', {elapsedMs: tEnd - t0, out});
  return {elapsedMs: tEnd - t0, out};
}`,
      cases: [
        {
          args: ['dict/cmds.txt', ['comp']],
          toolImpls: {
            __clocks: [1000, 1005, 1009],
            readText: () => 'compile complete',
            kv_get: () => '',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['dict/missing.txt', ['helo']],
          toolImpls: {
            __clocks: [2000, 2006, 2012],
            readText: () => ({__reject: 'ENOENT'}),
            kv_get: () => 'hello help',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['dict/tags.txt', ['alp']],
          toolImpls: {
            __clocks: [3000, 3004, 3008],
            readText: () => 'alpha alpine beta',
            kv_get: () => '',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['dict/geo.txt', ['tok']],
          toolImpls: {
            __clocks: [4000, 4003, 4007],
            readText: () => 'tokyo toronto paris',
            kv_get: () => '',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 19. mnemonist StaticIntervalTree + SuffixArray (Pure + complex DS)
    // =========================================================================
    {
      name: 'mnemonist-interval-suffix',
      lib: 'mnemonistInterval',
      category: 'data-structures',
      features: ['interval-tree', 'suffix-array', 'algorithms', 'array'],
      driver: `function run(intervals, point, windowRange, text, pattern) {
  const {StaticIntervalTree, SuffixArray} = __loadMod();
  const tree = StaticIntervalTree.from(intervals);
  const atPoint = tree.intervalsContainingPoint(point).map(x => x[2]).sort();
  const inWindow = tree.intervalsOverlappingInterval(windowRange).map(x => x[2]).sort();
  const sa = new SuffixArray(text);
  const arr = Array.from(sa.array);
  const matches = [];
  for (let i = 0; i < arr.length; i++) {
    const pos = arr[i];
    if (text.startsWith(pattern, pos)) matches.push(pos);
  }
  matches.sort((a, b) => a - b);
  return {atPoint, inWindow, saLength: arr.length, matches};
}`,
      cases: [
        {args: [[[1, 5, 'a'], [3, 8, 'b'], [6, 12, 'c'], [10, 15, 'd']], 4, [7, 11], 'abracadabra$', 'abra']},
        {args: [[[0, 10, 'r0'], [5, 15, 'r1'], [12, 20, 'r2']], 10, [0, 4], 'banana$', 'ana']},
        {args: [[[2, 4, 'x'], [8, 9, 'y']], 6, [5, 7], 'mississippi$', 'issi']},
        {args: [[[-10, 0, 'neg'], [-2, 3, 'mix'], [3, 5, 'pos']], 0, [-1, 4], 'café-café$', 'café']},
      ],
    },

    // =========================================================================
    // 20. mnemonist StaticDisjointSet + FibonacciHeap (Effectful: Date.now, http.get, emit_metric, console.info, fs.writeText)
    // =========================================================================
    {
      name: 'mnemonist-dsu-fibheap',
      lib: 'mnemonistGraph',
      category: 'data-structures',
      features: ['graph', 'disjoint-set', 'heap', 'http', 'native-bindings', 'platform', 'fs', 'external', 'sequential'],
      nativeBindings: [
        {name: 'emit_metric', kind: 'synchronous', description: 'Record MST edge count and total weight.'},
      ],
      driver: `async function run(graphUrl, outPath) {
  const {StaticDisjointSet, FibonacciHeap} = __loadMod();
  const t0 = Date.now();
  const raw = await host.httpGet(graphUrl);
  const spec = JSON.parse(raw);
  const dsu = new StaticDisjointSet(spec.nodes);
  const heap = new FibonacciHeap((a, b) => a.w - b.w);
  for (let i = 0; i < spec.edges.length; i++) {
    heap.push(spec.edges[i]);
  }
  const tMid = Date.now();
  const mst = [];
  let totalWeight = 0;
  while (heap.size) {
    const e = heap.pop();
    if (!dsu.connected(e.u, e.v)) {
      dsu.union(e.u, e.v);
      mst.push(e);
      totalWeight += e.w;
    }
  }
  emit_metric('mst.done', {edges: mst.length, weight: totalWeight});
  console.info('mst:edges=' + mst.length + ':w=' + totalWeight);
  const tEnd = Date.now();
  const out = {elapsedMs: tEnd - t0, midTs: tMid, mst, totalWeight, comp01: dsu.connected(0, 1)};
  await host.writeText(outPath, JSON.stringify(out));
  return out;
}`,
      cases: [
        {
          args: ['https://graph.test/g0', 'out/mst0.json'],
          toolImpls: {
            __clocks: [1000, 1005, 1012],
            httpGet: () => '{"nodes":4,"edges":[{"u":0,"v":1,"w":4},{"u":0,"v":2,"w":1},{"u":2,"v":1,"w":2},{"u":1,"v":3,"w":5},{"u":2,"v":3,"w":3}]}',
            emit_metric: () => true,
          },
        },
        {
          args: ['https://graph.test/g1', 'out/mst1.json'],
          toolImpls: {
            __clocks: [2000, 2004, 2009],
            httpGet: () => '{"nodes":5,"edges":[{"u":0,"v":1,"w":10},{"u":2,"v":3,"w":1},{"u":3,"v":4,"w":2},{"u":0,"v":2,"w":7}]}',
            emit_metric: () => true,
          },
        },
        {
          args: ['https://graph.test/g2', 'out/mst2.json'],
          toolImpls: {
            __clocks: [3000, 3006, 3013],
            httpGet: () => '{"nodes":3,"edges":[{"u":0,"v":1,"w":3},{"u":1,"v":2,"w":3},{"u":0,"v":2,"w":1}]}',
            emit_metric: () => true,
          },
        },
        {
          args: ['https://graph.test/g3', 'out/mst3.json'],
          toolImpls: {
            __clocks: [4000, 4004, 4010],
            httpGet: () => '{"nodes":4,"edges":[{"u":2,"v":3,"w":2},{"u":0,"v":2,"w":6}]}',
            emit_metric: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 21. lru-cache (Effectful: Date.now inside lib+driver, kv_get, Math.random, console.warn, emit_metric, kv_set)
    //     Variants 0 & 1 share identical args for causal prefix / zero future leakage audit!
    // =========================================================================
    {
      name: 'lru-cache-fetch-coalesce',
      lib: 'lruCache',
      category: 'data-structures',
      randomMode: 'tool',
      features: ['cache', 'lru', 'native-bindings', 'random', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load backing entry for cache miss.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Emit cache hit/miss telemetry.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist cache eviction summary.'},
      ],
      driver: `async function run(maxSize, ttlMs, ops) {
  const LRUCache = __loadMod();
  const evicted = [];
  const cache = new LRUCache({
    maxSize,
    ttl: ttlMs,
    ttlResolution: 0,
    sizeCalculation: val => String(val).length,
    dispose: (_v, k, reason) => {
      evicted.push({k, reason});
    },
  });
  const trace = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'set') {
      cache.set(op.k, op.v);
      trace.push({op: 'set', k: op.k, size: cache.calculatedSize});
    } else {
      const hit = cache.get(op.k);
      if (hit !== undefined) {
        emit_metric('lru.hit', {k: op.k});
        trace.push({op: 'get', k: op.k, hit: true, v: hit});
      } else {
        const jitter = Math.random();
        let val;
        try {
          val = await kv_get(op.k);
        } catch (err) {
          console.warn('lru-kv-err:' + op.k);
          val = 'stale-fallback';
        }
        if (val !== null) cache.set(op.k, val);
        emit_metric('lru.miss', {k: op.k, jitter});
        trace.push({op: 'get', k: op.k, hit: false, v: val});
      }
    }
  }
  await kv_set('lru:summary', {size: cache.size, evicted, ts: Date.now()});
  return {size: cache.size, evicted, trace};
}`,
      cases: [
        {
          args: [8, 50, [{type: 'set', k: 'a', v: '1234'}, {type: 'set', k: 'b', v: '56789'}, {type: 'get', k: 'a'}, {type: 'get', k: 'b'}]],
          toolImpls: {
            __clocks: [1000, 1005, 1010, 1015, 1020, 1025, 1030, 1035],
            __randoms: [0.33, 0.77],
            kv_get: k => 'db:' + k,
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          // Identical args to case 0 -> causal divergence test!
          args: [8, 50, [{type: 'set', k: 'a', v: '1234'}, {type: 'set', k: 'b', v: '56789'}, {type: 'get', k: 'a'}, {type: 'get', k: 'b'}]],
          toolImpls: {
            __clocks: [1000, 1005, 1010, 1015, 1020, 1025, 1030, 1035],
            __randoms: [0.81, 0.12],
            kv_get: k => (k === 'a' ? {__reject: 'kv-unavailable'} : 'db:' + k),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: [10, 20, [{type: 'set', k: 'x', v: 'abcd'}, {type: 'get', k: 'x'}, {type: 'get', k: 'x'}]],
          toolImpls: {
            __clocks: [2000, 2005, 2040, 2045, 2050, 2055],
            __randoms: [0.55],
            kv_get: () => 'fresh-x',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: [6, 100, [{type: 'get', k: 'm'}, {type: 'set', k: 'n', v: 'hi'}, {type: 'get', k: 'n'}]],
          toolImpls: {
            __clocks: [3000, 3005, 3010, 3015, 3020],
            __randoms: [0.19],
            kv_get: () => null,
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 22. heap-js (Effectful: Date.now, kv_get, http.post with retry, console.warn, emit_metric, kv_set)
    // =========================================================================
    {
      name: 'heap-priority-dispatcher',
      lib: 'heapJs',
      category: 'data-structures',
      features: ['heap', 'priority-queue', 'http', 'native-bindings', 'platform', 'external', 'sequential', 'exception'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load pending priority jobs.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Record synchronous job dispatch metric.'},
        {name: 'kv_set', kind: 'promise', description: 'Save remaining/completed jobs.'},
      ],
      driver: `async function run(queueKey, dispatchUrl, maxJobs) {
  const Heap = __loadMod();
  const t0 = Date.now();
  const jobs = await kv_get(queueKey);
  const pq = new Heap((a, b) => a.prio !== b.prio ? a.prio - b.prio : a.id.localeCompare(b.id));
  pq.init(jobs);
  const done = [];
  const dead = [];
  let steps = 0;
  while (pq.length > 0 && steps < maxJobs) {
    steps++;
    const job = pq.pop();
    const now = Date.now();
    if (job.deadline < now) {
      console.warn('job-expired:' + job.id);
      dead.push({id: job.id, reason: 'expired'});
      continue;
    }
    try {
      await host.httpPost(dispatchUrl, JSON.stringify({id: job.id, prio: job.prio}));
      emit_metric('job.sent', {id: job.id});
      done.push(job.id);
    } catch (err) {
      console.warn('job-retry:' + job.id);
      if ((job.retries ?? 0) < 1) {
        pq.push({...job, prio: job.prio + 5, retries: (job.retries ?? 0) + 1});
      } else {
        dead.push({id: job.id, reason: 'http-fail'});
      }
    }
  }
  const remaining = pq.toArray().map(j => j.id);
  await kv_set('queue:done', {done, dead, remaining, ts: Date.now()});
  return {elapsedMs: Date.now() - t0, done, dead, remaining};
}`,
      cases: [
        {
          args: ['q:0', 'https://worker.test/run', 4],
          toolImpls: {
            __clocks: [1000, 1005, 1010, 1015, 1020],
            kv_get: () => [{id: 'j2', prio: 2, deadline: 5000}, {id: 'j1', prio: 1, deadline: 5000}, {id: 'j3', prio: 3, deadline: 900}],
            httpPost: () => 'accepted',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['q:1', 'https://worker.test/run', 4],
          toolImpls: {
            __clocks: [2000, 2005, 2010, 2015, 2020],
            kv_get: () => [{id: 'a', prio: 1, deadline: 5000}, {id: 'b', prio: 2, deadline: 5000}],
            httpPost: (_u, body) => (body.includes('"a"') && !body.includes('"prio":6') ? {__reject: '503'} : 'ok'),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['q:2', 'https://worker.test/run', 2],
          toolImpls: {
            __clocks: [3000, 3005, 3010, 3015],
            kv_get: () => [{id: 't3', prio: 3, deadline: 9000}, {id: 't1', prio: 1, deadline: 9000}, {id: 't2', prio: 1, deadline: 9000}],
            httpPost: () => 'ok',
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['q:3', 'https://worker.test/run', 4],
          toolImpls: {
            __clocks: [4000, 4005, 4010, 4015, 4020],
            kv_get: () => [{id: 'w1', prio: 1, deadline: 9000}, {id: 'w2', prio: 2, deadline: 3000}, {id: 'x', prio: 3, deadline: 9000, retries: 1}],
            httpPost: (_u, body) => (body.includes('"x"') ? {__reject: '500'} : 'ok'),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 23. d3-hierarchy (Pure + stratify, sum, sort, treemap tiling, cycle TypeError throw)
    // =========================================================================
    {
      name: 'd3-treemap-rollup',
      lib: 'd3Hierarchy',
      category: 'data-structures',
      features: ['hierarchy', 'tree', 'treemap', 'float-precision', 'exception'],
      driver: `function run(rows, width, height) {
  const h = __loadMod();
  const root = h.stratify()
    .id(d => d.id)
    .parentId(d => d.parent)(rows);
  root.sum(d => d.val || 0)
      .sort((a, b) => (b.value - a.value) || a.id.localeCompare(b.id));
  h.treemap().size([width, height]).padding(1)(root);
  return root.descendants().map(n => ({
    id: n.id,
    depth: n.depth,
    value: n.value,
    x0: Math.round(n.x0 * 100) / 100,
    y0: Math.round(n.y0 * 100) / 100,
    x1: Math.round(n.x1 * 100) / 100,
    y1: Math.round(n.y1 * 100) / 100,
  }));
}`,
      cases: [
        {args: [[{id: 'root', parent: null, val: 0}, {id: 'a', parent: 'root', val: 30}, {id: 'b', parent: 'root', val: 70}], 100, 50]},
        {args: [[{id: 'top', parent: '', val: 0}, {id: 'x', parent: 'top', val: 0}, {id: 'y', parent: 'top', val: 40}, {id: 'x1', parent: 'x', val: 35}, {id: 'x2', parent: 'x', val: 25}], 200, 100]},
        {args: [[{id: 'r', parent: null, val: 10}, {id: 'c1', parent: 'r', val: 20}, {id: 'c2', parent: 'r', val: 20}], 120, 80]},
        {args: [[{id: 'root', parent: null, val: 0}, {id: 'g1', parent: 'root', val: 10}, {id: 'g2', parent: 'root', val: 20}, {id: 'a', parent: 'b', val: 1}, {id: 'b', parent: 'a', val: 1}], 100, 100], expectThrow: true}, // throws Error("cycle")!
      ],
    },

    // =========================================================================
    // 24. dayjs (Effectful: Date.now, kv_get, console.info/warn, emit_metric, fs.writeText)
    // =========================================================================
    {
      name: 'dayjs-utc-scheduler',
      lib: 'dayjs',
      category: 'time-color-math',
      features: ['datetime', 'duration', 'native-bindings', 'platform', 'fs', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load schedule definitions.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Record scheduled window status.'},
      ],
      driver: `async function run(schedKey, outPath) {
  const {dayjs, utc, isBetween} = __loadMod();
  dayjs.extend(utc);
  dayjs.extend(isBetween);
  const nowMs = Date.now();
  let specs;
  try {
    specs = await kv_get(schedKey);
  } catch (err) {
    console.warn('sched-fallback:' + schedKey);
    specs = [{id: 'fb', anchor: '2024-01-31T00:00:00Z', addMonths: 1, ttlMin: 90}];
  }
  const now = dayjs.utc(nowMs);
  const windows = [];
  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i];
    const start = dayjs.utc(sp.anchor).add(sp.addMonths ?? 0, 'month');
    const ttlMin = sp.ttlMin ?? 60;
    const end = start.add(ttlMin, 'minute');
    const active = now.isBetween(start, end, null, '[]');
    console.info('win:' + sp.id + ':active=' + active);
    emit_metric('sched.window', {id: sp.id, active});
    windows.push({id: sp.id, start: start.toISOString(), end: end.toISOString(), hours: ttlMin / 60, active});
  }
  const tEnd = Date.now();
  await host.writeText(outPath, JSON.stringify({checkedAt: tEnd, windows}));
  return {checkedAt: tEnd, windows};
}`,
      cases: [
        {
          args: ['sched:0', 'out/sched0.json'],
          toolImpls: {
            __clocks: [1709204400000, 1709204405000], // 2024-02-29T11:00:00Z
            kv_get: () => [{id: 'leap', anchor: '2024-01-31T10:00:00Z', addMonths: 1, ttlMin: 120}],
            emit_metric: () => true,
          },
        },
        {
          args: ['sched:1', 'out/sched1.json'],
          toolImpls: {
            __clocks: [1709204400000, 1709204409000],
            kv_get: () => ({__reject: 'kv-offline'}),
            emit_metric: () => true,
          },
        },
        {
          args: ['sched:2', 'out/sched2.json'],
          toolImpls: {
            __clocks: [1740740400000, 1740740402000], // 2025-02-28T11:00:00Z (non-leap year!)
            kv_get: () => [{id: 'nonleap', anchor: '2025-01-31T10:30:00Z', addMonths: 1, ttlMin: 90}],
            emit_metric: () => true,
          },
        },
        {
          args: ['sched:3', 'out/sched3.json'],
          toolImpls: {
            __clocks: [1700000000000, 1700000010000],
            kv_get: () => [{id: 'y2k', anchor: '2023-11-14T22:00:00Z', addMonths: 0, ttlMin: 45}],
            emit_metric: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 25. d3-time + d3-time-format (Pure + UTC parsing/formatting + interval buckets)
    // =========================================================================
    {
      name: 'd3-time-buckets',
      lib: 'd3TimeFormat',
      category: 'time-color-math',
      features: ['datetime', 'parsing', 'bucketing', 'array'],
      driver: `function run(events, stepHours) {
  const {utcParse, utcFormat, utcHour} = __loadMod();
  const pIso = utcParse('%Y-%m-%dT%H:%M:%SZ');
  const pShort = utcParse('%Y-%m-%d %H:%M');
  const fmt = utcFormat('%Y-%m-%dT%H:%M');
  const parsed = [];
  for (let i = 0; i < events.length; i++) {
    const dt = pIso(events[i].ts) || pShort(events[i].ts);
    parsed.push({raw: events[i].ts, valid: Boolean(dt), ms: dt ? dt.getTime() : null, v: events[i].v});
  }
  const validDates = parsed.filter(x => x.valid).map(x => new Date(x.ms));
  if (!validDates.length) return {parsed, buckets: []};
  const minMs = Math.min(...validDates.map(d => d.getTime()));
  const maxMs = Math.max(...validDates.map(d => d.getTime()));
  const start = utcHour.floor(new Date(minMs));
  const stop = utcHour.offset(utcHour.floor(new Date(maxMs)), stepHours);
  const ticks = utcHour.every(stepHours).range(start, stop);
  const buckets = ticks.map((t, idx) => {
    const lo = t.getTime();
    const hi = idx + 1 < ticks.length ? ticks[idx + 1].getTime() : stop.getTime();
    let sum = 0;
    for (let j = 0; j < parsed.length; j++) {
      if (parsed[j].valid && parsed[j].ms >= lo && parsed[j].ms < hi) sum += parsed[j].v;
    }
    return {label: fmt(t), sum};
  });
  return {parsed, buckets};
}`,
      cases: [
        {args: [[{ts: '2024-02-28T23:30:00Z', v: 4}, {ts: '2024-02-29 01:15', v: 6}, {ts: '2024-02-29T02:45:00Z', v: 3}], 2]},
        {args: [[{ts: '2025-12-31T22:10:00Z', v: 10}, {ts: '2026-01-01 00:05', v: 5}, {ts: 'bad-date', v: 99}], 2]},
        {args: [[{ts: 'bad-1', v: 1}, {ts: 'bad-2', v: 2}], 1]},
        {args: [[{ts: '2024-06-01T00:00:00Z', v: 2}, {ts: '2024-06-01T01:59:00Z', v: 8}], 1]},
      ],
    },

    // =========================================================================
    // 26. tinycolor2 (Effectful: Date.now, fs.readText, console.warn, emit_metric, fs.writeText)
    // =========================================================================
    {
      name: 'tinycolor-wcag-theme',
      lib: 'tinycolor2',
      category: 'time-color-math',
      features: ['color', 'wcag', 'fs', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'emit_metric', kind: 'synchronous', description: 'Record WCAG contrast compliance telemetry.'},
      ],
      driver: `async function run(themePath, outPath) {
  const tinycolor = __loadMod();
  const t0 = Date.now();
  const theme = JSON.parse(await host.readText(themePath));
  const bg = tinycolor(theme.bg);
  const tMid = Date.now();
  const pairs = [];
  let fixed = 0;
  for (let i = 0; i < theme.fgs.length; i++) {
    const rawFg = theme.fgs[i];
    const fg = tinycolor(rawFg);
    if (!fg.isValid()) {
      console.warn('invalid-color:' + rawFg);
      pairs.push({rawFg, valid: false});
      continue;
    }
    const ratio = Math.round(tinycolor.readability(bg, fg) * 100) / 100;
    const ok = tinycolor.isReadable(bg, fg, {level: 'AA', size: 'small'});
    let adjusted = fg.toHexString();
    if (!ok) {
      fixed++;
      const best = tinycolor.mostReadable(bg, [fg.toHexString(), fg.clone().darken(25).toHexString(), fg.clone().lighten(25).toHexString(), '#000000', '#ffffff'], {includeFallbackColors: true});
      adjusted = best.toHexString();
    }
    pairs.push({rawFg, valid: true, ratio, ok, adjusted, hsl: fg.toHslString()});
  }
  emit_metric('theme.wcag', {total: theme.fgs.length, fixed});
  const tEnd = Date.now();
  await host.writeText(outPath, JSON.stringify({bg: bg.toHexString(), isDark: bg.isDark(), pairs, elapsedMs: tEnd - t0, midTs: tMid}));
  return {bg: bg.toHexString(), isDark: bg.isDark(), fixed, pairs, elapsedMs: tEnd - t0};
}`,
      cases: [
        {
          args: ['theme/dark.json', 'out/dark.json'],
          toolImpls: {
            __clocks: [1000, 1004, 1009],
            readText: () => '{"bg":"#1a1b26","fgs":["#c0caf5","#3b4261","notacolor"]}',
            emit_metric: () => true,
          },
        },
        {
          args: ['theme/light.json', 'out/light.json'],
          toolImpls: {
            __clocks: [2000, 2005, 2011],
            readText: () => '{"bg":"rgb(250, 250, 250)","fgs":["hsl(210, 90%, 40%)","#dddddd"]}',
            emit_metric: () => true,
          },
        },
        {
          args: ['theme/brand.json', 'out/brand.json'],
          toolImpls: {
            __clocks: [3000, 3003, 3007],
            readText: () => '{"bg":"rebeccapurple","fgs":["#ffffff","gold","#8844aa"]}',
            emit_metric: () => true,
          },
        },
        {
          args: ['theme/alpha.json', 'out/alpha.json'],
          toolImpls: {
            __clocks: [4000, 4004, 4009],
            readText: () => '{"bg":"#0f172a","fgs":["rgba(255, 255, 255, 0.9)","hsv(180, 60%, 70%)"]}',
            emit_metric: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 27. bignumber.js (Effectful: Date.now, http.get with rejection fallback to kv_get, console.warn, emit_metric, kv_set)
    // =========================================================================
    {
      name: 'bignumber-ledger-reconcile',
      lib: 'bignumber',
      category: 'time-color-math',
      features: ['financial', 'arbitrary-precision', 'float-precision', 'http', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load cached FX rate fallback.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Emit reconciliation discrepancy metric.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist reconciled ledger.'},
      ],
      driver: `async function run(fxUrl, invoices, feeRateStr) {
  const BigNumber = __loadMod();
  BigNumber.config({DECIMAL_PLACES: 8, ROUNDING_MODE: BigNumber.ROUND_HALF_EVEN});
  const t0 = Date.now();
  let rates;
  try {
    rates = JSON.parse(await host.httpGet(fxUrl));
  } catch (err) {
    console.warn('fx-fallback:' + fxUrl);
    rates = await kv_get('fx:cached');
  }
  const tRates = Date.now();
  const feeRate = new BigNumber(feeRateStr);
  let totalNet = new BigNumber(0);
  let totalFee = new BigNumber(0);
  const rows = [];
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    const rate = new BigNumber(rates[inv.ccy]);
    const grossUsd = new BigNumber(inv.amount).times(rate).dp(2);
    const fee = grossUsd.times(feeRate).dp(2);
    totalFee = totalFee.plus(fee);
    totalNet = totalNet.plus(grossUsd.minus(fee));
    rows.push({id: inv.id, grossUsd: grossUsd.toString(), fee: fee.toString()});
  }
  emit_metric('ledger.reconciled', {rows: rows.length, net: totalNet.toString()});
  const tEnd = Date.now();
  await kv_set('ledger:last', {totalNet: totalNet.toString(), totalFee: totalFee.toString(), ts: tEnd});
  return {elapsedMs: tEnd - t0, rateTs: tRates, totalFee: totalFee.toString(), totalNet: totalNet.toString(), rows};
}`,
      cases: [
        {
          args: ['https://fx.test/live', [{id: 'inv1', ccy: 'EUR', amount: '1234.56'}], '0.029'],
          toolImpls: {
            __clocks: [10000, 10004, 10010],
            httpGet: () => '{"EUR":"1.0875"}',
            kv_get: () => ({}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['https://fx.test/down', [{id: 'inv3', ccy: 'GBP', amount: '999999999.12'}], '0.015'],
          toolImpls: {
            __clocks: [20000, 20006, 20013],
            httpGet: () => ({__reject: '503 Service Unavailable'}),
            kv_get: () => ({GBP: '1.2650'}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['https://fx.test/banker', [{id: 'b1', ccy: 'USD', amount: '10.005'}], '0.5'],
          toolImpls: {
            __clocks: [30000, 30003, 30008],
            httpGet: () => '{"USD":"1"}',
            kv_get: () => ({}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
        {
          args: ['https://fx.test/chf', [{id: 'c1', ccy: 'CHF', amount: '200'}], '0.1'],
          toolImpls: {
            __clocks: [40000, 40005, 40011],
            httpGet: () => '{"CHF":"1.5"}',
            kv_get: () => ({}),
            emit_metric: () => true,
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 28. fraction.js (Pure + BigInt rationals, continued fractions, -0, division-by-zero throw)
    // =========================================================================
    {
      name: 'fraction-exact-rational',
      lib: 'fractionJs',
      category: 'time-color-math',
      features: ['math', 'rational', 'bigint', 'float-precision', 'exception'],
      driver: `function run(exprs) {
  const Fraction = __loadMod();
  let acc = new Fraction(0n, 1n);
  const steps = [];
  for (let i = 0; i < exprs.length; i++) {
    const e = exprs[i];
    const val = new Fraction(e.num, e.den);
    if (e.op === 'add') acc = acc.add(val);
    else if (e.op === 'mul') acc = acc.mul(val);
    else if (e.op === 'div') acc = acc.div(val);
    else throw new TypeError('unknown op: ' + e.op);
    steps.push({frac: acc.toFraction(), cf: acc.toContinued().map(x => Number(x))});
  }
  return {
    sign: Number(acc.s),
    numerator: acc.n,
    denominator: acc.d,
    recurring: acc.toString(),
    steps,
  };
}`,
      cases: [
        {args: [[{op: 'add', num: 1n, den: 3n}, {op: 'add', num: 1n, den: 6n}, {op: 'div', num: 7n, den: 12n}]]},
        {args: [[{op: 'add', num: '0.1', den: undefined}, {op: 'add', num: '0.2', den: undefined}, {op: 'mul', num: -3n, den: 10n}]]},
        {args: [[{op: 'add', num: 355n, den: 113n}, {op: 'mul', num: 2n, den: 5n}]]},
        {args: [[{op: 'add', num: 1n, den: 2n}, {op: 'div', num: 0n, den: 1n}]], expectThrow: true}, // throws DivisionByZero / Error!
      ],
    },

    // =========================================================================
    // 29. complex.js (Pure + phasor transforms, roots, log/exp, NaN/Infinity edge cases, RangeError)
    // =========================================================================
    {
      name: 'complex-phasor-transforms',
      lib: 'complexJs',
      category: 'time-color-math',
      features: ['math', 'complex', 'float-precision', 'exception'],
      driver: `function run(points, power, checkUnit) {
  const Complex = __loadMod();
  const out = [];
  let sum = new Complex(0, 0);
  for (let i = 0; i < points.length; i++) {
    const z = new Complex(points[i].re, points[i].im);
    if (checkUnit && Math.abs(z.abs()) < 1e-12) {
      throw new RangeError('zero-magnitude phasor at index ' + i);
    }
    const p = z.pow(power);
    sum = sum.add(p);
    out.push({
      re: Math.round(p.re * 1e6) / 1e6,
      im: Math.round(p.im * 1e6) / 1e6,
      abs: Math.round(p.abs() * 1e6) / 1e6,
      arg: Math.round(p.arg() * 1e6) / 1e6,
    });
  }
  return {
    out,
    sumRe: Math.round(sum.re * 1e6) / 1e6,
    sumIm: Math.round(sum.im * 1e6) / 1e6,
  };
}`,
      cases: [
        {args: [[{re: 0, im: 1}, {re: 1, im: 1}, {re: -1, im: 0}], 2, false]},
        {args: [[{re: 3, im: 4}, {re: -2, im: 5}], -1, true]},
        {args: [[{re: 1, im: 0}, {re: 0, im: -1}, {re: 0.5, im: 0.8660254}], 3, false]},
        {args: [[{re: 1, im: 2}, {re: 0, im: 0}], 2, true], expectThrow: true}, // uncaught RangeError!
      ],
    },

    // =========================================================================
    // 30. d3-color + d3-interpolate (Pure + Lab/HCL/Cubehelix perceptual ramp)
    // =========================================================================
    {
      name: 'd3-color-perceptual-ramp',
      lib: 'd3Color',
      category: 'time-color-math',
      features: ['color', 'interpolation', 'float-precision'],
      driver: `function run(startColor, endColor, space, steps) {
  const {color, lab, hcl, rgb, interpolateLab, interpolateHcl, interpolateRgb, quantize} = __loadMod();
  const c0 = color(startColor);
  const c1 = color(endColor);
  const interp = space === 'lab' ? interpolateLab(c0, c1)
    : space === 'hcl' ? interpolateHcl(c0, c1)
    : interpolateRgb(c0, c1);
  const ramp = quantize(interp, steps);
  return ramp.map(s => {
    const r = rgb(s);
    const l = lab(r);
    const h = hcl(r);
    return {
      hex: r.formatHex(),
      lStar: Math.round(l.l * 100) / 100,
      chroma: Math.round(h.c * 100) / 100,
    };
  });
}`,
      cases: [
        {args: ['#ff4500', '#1e90ff', 'lab', 5]},
        {args: ['rebeccapurple', 'gold', 'hcl', 4]},
        {args: ['rgb(20, 40, 60)', 'hsl(150, 80%, 50%)', 'rgb', 5]},
        {args: ['cubehelix(300, 0.5, 0.4)', '#ffffff', 'lab', 4]},
      ],
    },

    // =========================================================================
    // 31. deepmerge + klona + dequal (Pure + extreme aliasing/mutation/cycles/Map/Set/TypedArray/null-proto/$js)
    // =========================================================================
    {
      name: 'deepmerge-alias-overlay',
      lib: 'deepmergeKlona',
      category: 'state-aliasing',
      features: ['state', 'merge', 'mutation', 'alias', 'cycle', 'map', 'set', 'typed-array'],
      driver: `function run(baseCfg, overlayCfg, extraTag) {
  const {deepmerge, klona, dequal} = __loadMod();
  const cyclicSnap = structuredClone(baseCfg);
  const cleanBase = {items: baseCfg.items, meta: baseCfg.meta};
  const snapshot = klona(cleanBase);
  // Exercise klona + dequal on Map, Set, Uint8Array, RegExp internally
  const m1 = new Map([['a', new Set([1, 2])], ['b', new Uint8Array([10, 20, 30])]]);
  const m2 = klona(m1);
  m2.get('a').add(3);
  const mapEqualAfterMut = dequal(m1, m2);

  const mergeById = (dest, src) => {
    const out = dest.slice();
    for (let i = 0; i < src.length; i++) {
      const idx = out.findIndex(x => x.id === src[i].id);
      if (idx >= 0) out[idx] = deepmerge(out[idx], src[i]);
      else out.push(src[i]);
    }
    return out;
  };
  const merged = deepmerge(cleanBase, overlayCfg, {arrayMerge: mergeById});
  // Mutate baseCfg.meta in-place so caller sees mutation + alias checks!
  baseCfg.meta.tags.push(extraTag);
  const nullProto = Object.create(null);
  nullProto.mergedCount = merged.items.length;
  nullProto.snapshotEqualBeforeMut = dequal(snapshot.items, baseCfg.items);
  return {
    snapshotCyclePreserved: cyclicSnap.self ? cyclicSnap.self === cyclicSnap : false,
    aliasedMirrorPreserved: baseCfg.mirror === baseCfg.meta,
    mapEqualAfterMut,
    merged,
    summary: nullProto,
  };
}`,
      cases: [
        {
          args: (() => {
            const meta = {env: 'prod', tags: ['v1']};
            const base = {items: [{id: 1, w: 10}, {id: 2, w: 20}], meta, mirror: meta};
            base.self = base;
            return [base, {items: [{id: 2, w: 99}, {id: 3, w: 30}], meta: {region: 'eu'}}, 'live'];
          })(),
        },
        {
          args: (() => {
            const meta = {env: 'dev', tags: ['a', 'b']};
            const base = {items: [{id: 'k1', nested: {ok: true}}], meta, mirror: meta};
            base.self = base;
            return [base, {items: [{id: 'k1', nested: {extra: 2}}], meta: {owner: 'café'}}, '🚀'];
          })(),
        },
        {
          args: (() => {
            const meta = {env: 'stg', tags: []};
            const base = {items: [], meta, mirror: {env: 'other'}};
            return [base, {items: [{id: 9, active: false}]}, 'seeded'];
          })(),
        },
        {
          args: (() => {
            const meta = {env: 'qa', tags: ['x']};
            const base = {items: [{id: 1, flags: {a: true}}], meta, mirror: meta};
            base.self = base;
            return [base, {items: [{id: 1, flags: {b: false}}]}, 'final'];
          })(),
        },
      ],
    },

    // =========================================================================
    // 32. redux (Effectful: Date.now, kv_get, Math.random, http.post, console.info/warn, emit_metric, kv_set)
    // =========================================================================
    {
      name: 'redux-effectful-saga',
      lib: 'redux',
      category: 'state-aliasing',
      randomMode: 'tool',
      features: ['state', 'redux', 'http', 'native-bindings', 'random', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Hydrate initial Redux state.'},
        {name: 'emit_metric', kind: 'synchronous', description: 'Emit action transition metric.'},
        {name: 'kv_set', kind: 'promise', description: 'Persist final Redux store snapshot.'},
      ],
      driver: `async function run(stateKey, actions, checkpointUrl) {
  const {createStore, combineReducers, applyMiddleware} = __loadMod();
  const t0 = Date.now();
  const initial = await kv_get(stateKey);
  const counter = (state = initial.count ?? 0, action) => {
    if (action.type === 'INC') return state + (action.by ?? 1);
    if (action.type === 'DEC') return Math.max(0, state - (action.by ?? 1));
    return state;
  };
  const log = (state = initial.log ?? [], action) => {
    if (action.type === 'INC' || action.type === 'DEC') {
      return state.concat([{type: action.type, roll: action.roll}]);
    }
    return state;
  };
  const auditMw = storeAPI => next => action => {
    const res = next(action);
    emit_metric('redux.action', {type: action.type, count: storeAPI.getState().counter});
    return res;
  };
  const store = createStore(combineReducers({counter, log}), applyMiddleware(auditMw));
  const transitions = [];
  store.subscribe(() => {
    transitions.push(store.getState().counter);
  });
  for (let i = 0; i < actions.length; i++) {
    const roll = Math.random();
    store.dispatch({...actions[i], roll});
  }
  const finalState = store.getState();
  const tMid = Date.now();
  let posted = true;
  try {
    await host.httpPost(checkpointUrl, JSON.stringify(finalState));
  } catch (err) {
    console.warn('checkpoint-fail:' + String(err));
    posted = false;
  }
  await kv_set(stateKey, {count: finalState.counter, log: finalState.log, ts: Date.now()});
  return {elapsedMs: Date.now() - t0, midTs: tMid, posted, transitions, finalState};
}`,
      cases: [
        {
          args: ['redux:0', [{type: 'INC', by: 5}, {type: 'DEC', by: 2}], 'https://ckpt.test/0'],
          toolImpls: {
            __clocks: [1000, 1005, 1010, 1015],
            __randoms: [0.11, 0.89],
            kv_get: () => ({count: 10, log: []}),
            emit_metric: () => true,
            httpPost: () => 'ok',
            kv_set: () => true,
          },
        },
        {
          args: ['redux:1', [{type: 'DEC', by: 10}, {type: 'INC', by: 3}], 'https://ckpt.test/1'],
          toolImpls: {
            __clocks: [2000, 2006, 2011, 2018],
            __randoms: [0.42, 0.65],
            kv_get: () => ({count: 4, log: [{type: 'INIT', roll: 0}]}),
            emit_metric: () => true,
            httpPost: () => ({__reject: '503'}),
            kv_set: () => true,
          },
        },
        {
          args: ['redux:2', [{type: 'INC', by: 1}, {type: 'DEC', by: 1}], 'https://ckpt.test/2'],
          toolImpls: {
            __clocks: [3000, 3004, 3009, 3014],
            __randoms: [0.05, 0.95],
            kv_get: () => ({count: 0, log: []}),
            emit_metric: () => true,
            httpPost: () => 'ok',
            kv_set: () => true,
          },
        },
        {
          args: ['redux:3', [{type: 'NOOP'}, {type: 'INC', by: 7}], 'https://ckpt.test/3'],
          toolImpls: {
            __clocks: [4000, 4003, 4008, 4012],
            __randoms: [0.22, 0.78],
            kv_get: () => ({count: 20, log: []}),
            emit_metric: () => true,
            httpPost: () => 'ok',
            kv_set: () => true,
          },
        },
      ],
    },

    // =========================================================================
    // 33. normalizr (Pure + circular entity references + in-place normalized table mutation + denormalize aliasing)
    // =========================================================================
    {
      name: 'normalizr-entity-graph',
      lib: 'normalizr',
      category: 'state-aliasing',
      features: ['normalization', 'graph', 'alias', 'mutation', 'cycle'],
      driver: `function run(feed, mutateUserId, newName) {
  const {normalize, denormalize, schema} = __loadMod();
  const user = new schema.Entity('users', {}, {
    mergeStrategy: (a, b) => ({...a, ...b, merged: true}),
  });
  const comment = new schema.Entity('comments', {commenter: user});
  const article = new schema.Entity('articles', {
    author: user,
    comments: [comment],
  });
  const normalized = normalize(feed, [article]);
  if (normalized.entities.users && normalized.entities.users[mutateUserId]) {
    normalized.entities.users[mutateUserId].name = newName;
  }
  const rebuilt = denormalize(normalized.result, [article], normalized.entities);
  const sharedAuthorAliased = rebuilt.length >= 2 && rebuilt[0].author === rebuilt[1].author;
  return {
    resultIds: normalized.result,
    userCount: Object.keys(normalized.entities.users || {}).length,
    sharedAuthorAliased,
    rebuilt,
  };
}`,
      cases: [
        {
          args: [
            [
              {id: 'a1', title: 'One', author: {id: 'u1', name: 'Ada'}, comments: [{id: 'c1', body: 'hi', commenter: {id: 'u2', name: 'Bob'}}]},
              {id: 'a2', title: 'Two', author: {id: 'u1', name: 'Ada', role: 'lead'}, comments: []},
            ],
            'u1',
            'Ada Lovelace',
          ],
        },
        {
          args: [
            [
              {id: 10, title: 'Café', author: {id: 7, name: 'Zofia'}, comments: [{id: 100, body: '🚀', commenter: {id: 7, name: 'Zofia'}}]},
            ],
            7,
            'Zofia-v2',
          ],
        },
        {
          args: [
            [
              {id: 'p1', title: 'A', author: {id: 'u9', name: 'N'}, comments: []},
              {id: 'p2', title: 'B', author: {id: 'u8', name: 'M'}, comments: [{id: 'c9', body: 'ok', commenter: {id: 'u9', name: 'N'}}]},
            ],
            'u9',
            'Renamed',
          ],
        },
        {
          args: [
            [
              {id: 'n1', title: 'Alpha', author: {id: 'u1', name: 'Ada'}, comments: [{id: 'c1', body: 'hi', commenter: {id: 'u2', name: 'Bob'}}]},
              {id: 'n2', title: 'Beta', author: {id: 'u2', name: 'Bob'}, comments: []},
            ],
            'missing',
            'X',
          ],
        },
      ],
    },

    // =========================================================================
    // 34. just-diff + just-diff-apply + just-clone (Effectful: Date.now, fs.readText, kv_get, console.warn, kv_set, fs.writeText)
    //     Variants 0 & 1 share identical args for causal prefix / zero future leakage audit!
    // =========================================================================
    {
      name: 'just-diff-rollback',
      lib: 'justDiff',
      category: 'state-aliasing',
      features: ['diff', 'patch', 'mutation', 'fs', 'native-bindings', 'platform', 'external', 'sequential'],
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Load policy maxVersion limit.'},
        {name: 'kv_set', kind: 'promise', description: 'Store patch audit outcome.'},
      ],
      driver: `async function run(basePath, targetPath, fallbackTargetPath, outPath) {
  const {diff, diffApply, clone} = __loadMod();
  const t0 = Date.now();
  const baseObj = JSON.parse(await host.readText(basePath));
  let targetObj;
  try {
    targetObj = JSON.parse(await host.readText(targetPath));
  } catch (err) {
    console.warn('target-read-err:' + targetPath);
    targetObj = JSON.parse(await host.readText(fallbackTargetPath));
  }
  const policy = await kv_get('policy:patch');
  const tMid = Date.now();
  const ops = diff(baseObj, targetObj);
  const working = clone(baseObj);
  diffApply(working, ops);
  if (working.version > policy.maxVersion) {
    console.warn('policy-rollback:v=' + working.version);
    await kv_set('patch:audit', {rolledBack: true, opsCount: ops.length, ts: Date.now()});
    return {ok: false, rolledBack: true, opsCount: ops.length, revertedTo: baseObj.version};
  }
  await kv_set('patch:audit', {rolledBack: false, opsCount: ops.length, ts: Date.now()});
  await host.writeText(outPath, JSON.stringify({ops, working}));
  return {ok: true, elapsedMs: Date.now() - t0, midTs: tMid, opsCount: ops.length, working};
}`,
      cases: [
        {
          args: ['cfg/base.json', 'cfg/next.json', 'cfg/fb.json', 'out/applied.json'],
          toolImpls: {
            __clocks: [10000, 10004, 10009, 10015],
            readText: p => (p === 'cfg/base.json' ? '{"version":2,"limits":{"rps":10},"tags":["a","b"]}' : '{"version":3,"limits":{"rps":50},"tags":["a","c","d"]}'),
            kv_get: () => ({maxVersion: 5}),
            kv_set: () => true,
          },
        },
        {
          // Identical args to case 0 -> causal divergence test!
          args: ['cfg/base.json', 'cfg/next.json', 'cfg/fb.json', 'out/applied.json'],
          toolImpls: {
            __clocks: [10000, 10007, 10012],
            readText: p => (p === 'cfg/base.json' ? '{"version":2,"limits":{"rps":10},"tags":["a","b"]}' : '{"version":9,"limits":{"rps":999},"tags":[]}'),
            kv_get: () => ({maxVersion: 5}),
            kv_set: () => true,
          },
        },
        {
          args: ['cfg/v1.json', 'cfg/missing.json', 'cfg/fb.json', 'out/v1.json'],
          toolImpls: {
            __clocks: [20000, 20005, 20010],
            readText: p => (p === 'cfg/v1.json' ? '{"version":1,"limits":{"rps":5}}' : p === 'cfg/fb.json' ? '{"version":2,"limits":{"rps":15}}' : {__reject: 'ENOENT'}),
            kv_get: () => ({maxVersion: 5}),
            kv_set: () => true,
          },
        },
        {
          args: ['cfg/s1.json', 'cfg/s2.json', 'cfg/fb.json', 'out/s.json'],
          toolImpls: {
            __clocks: [30000, 30005, 30011, 30017],
            readText: p => (p === 'cfg/s1.json' ? '{"version":1,"nested":{"a":1,"b":2}}' : '{"version":2,"nested":{"a":1,"c":3}}'),
            kv_get: () => ({maxVersion: 10}),
            kv_set: () => true,
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
    const family = `hairy-real:${bundle.pkg}/${tpl.name}`;
    if (WAVE1_FAMILIES.has(family)) {
      throw new Error(`Family collision with Wave 1: ${family}`);
    }
    if (WAVE1_PACKAGES.has(bundle.pkg)) {
      throw new Error(`Package collision with Wave 1: ${bundle.pkg}`);
    }

    const source = `"use strict";\nlet __harvestTarget;\n${bundle.code}\nconst __loadMod = () => __harvestTarget;\n${tpl.driver}\n`;
    if (source.length < MIN_SOURCE_CHARS || source.length > MAX_SOURCE_CHARS) {
      throw new Error(`${tpl.name} source length ${source.length} outside [${MIN_SOURCE_CHARS}, ${MAX_SOURCE_CHARS}]`);
    }
    const language = tpl.language ?? 'js';
    const jsForHash = language === 'ts'
      ? compileBoundedTypeScript(source, {path: 'training.ts'}).javascript
      : source;
    const cloneHash = nearCloneHash(jsForHash);
    const usesMathRandom = tpl.randomMode === 'tool' || /\bMath\.random\b/.test(source);

    for (let i = 0; i < tpl.cases.length; i++) {
      const c = tpl.cases[i];
      const encodedArgs = encodeReadable(structuredClone(c.args));
      const fixtureCalls = await recordTaskExecution({
        source,
        args: c.args,
        language,
        nativeBindings: tpl.nativeBindings ?? [],
        toolImpls: c.toolImpls ?? {},
        usesRandomTool: usesMathRandom,
      });
      const id = `hairy-js2-${tpl.name}-${i}-${sha256([family, encodedArgs, fixtureCalls]).slice(0, 8)}`;
      const features = [
        ...new Set([
          'hairy-real',
          'hairy-real-wave2',
          'native-v8',
          'real-oss',
          ...(language === 'ts' ? ['ts'] : []),
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
        language,
        executionMode: 'native',
        tier: 5,
        ...(usesMathRandom ? {randomMode: 'tool'} : {}),
        ...(tpl.nativeBindings ? {nativeBindings: structuredClone(tpl.nativeBindings)} : {}),
        fixture: {calls: fixtureCalls},
        randomSeed: 17,
        maxSteps: 100000,
        timeoutMs: 10000,
        metadata: {
          sourceOrigin: 'hairy-real-codebase-wave2',
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
        _expectThrow: Boolean(c.expectThrow),
      });
    }
  }

  // Verify zero family overlap against Wave 1 JSONL if present
  if (existsSync(WAVE1_PATH)) {
    const w1Families = new Set(
      readFileSync(WAVE1_PATH, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l).family),
    );
    for (const c of candidates) {
      if (w1Families.has(c.family)) {
        throw new Error(`Family collision with ${WAVE1_PATH}: ${c.family}`);
      }
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
        const rawTask = selected[idx];
        const {_expectThrow, ...task} = rawTask;
        try {
          if (task.source.length < MIN_SOURCE_CHARS || task.source.length > MAX_SOURCE_CHARS) {
            throw new Error(`source ${task.source.length} outside [${MIN_SOURCE_CHARS}, ${MAX_SOURCE_CHARS}]`);
          }
          const exported = await exportTinkerExample(task, {
            traceFormat: 'compact',
            reasoningChannel: 'thinking',
          });
          if (!exported.metadata.traceAudit?.replayVerified) {
            throw new Error('traceAudit.replayVerified is false');
          }
          if (!exported.metadata.traceAudit?.canonicalCausalNarration) {
            throw new Error('traceAudit.canonicalCausalNarration is false');
          }
          const lastMsg = exported.messages.at(-1);
          const lastText = Array.isArray(lastMsg?.content)
            ? lastMsg.content.find(c => c.type === 'text')?.text ?? ''
            : String(lastMsg?.content ?? '');
          const fenceMatch = lastText.match(/```json\n([\s\S]*?)\n```/);
          const completion = fenceMatch ? JSON.parse(fenceMatch[1]) : null;
          const expectedKind = _expectThrow ? 'throw' : 'return';
          if (!completion || completion.kind !== expectedKind) {
            throw new Error(`unexpected completion kind: ${completion?.kind ?? 'missing'} (expected ${expectedKind})`);
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
          if (!values['allow-over-600-lines'] && traceLines > MAX_TRACE_LINES) {
            throw new Error(`compact trace ${traceLines} lines > ${MAX_TRACE_LINES}`);
          }
          const episodeChars = JSON.stringify(exported.messages).length;
          const approxTokens = Math.ceil(episodeChars / 2.4);
          const tokenCap = values['max-approx-tokens'] ? Number(values['max-approx-tokens']) : MAX_APPROX_TOKENS;
          if (approxTokens > tokenCap) {
            throw new Error(`approx tokens ${approxTokens} > ${tokenCap}`);
          }
          const enrichedTask = {
            ...exported.task,
            tier: 5,
            metadata: {
              ...exported.task.metadata,
              tier: 5,
              sourceChars: exported.task.source.length,
              traceLines,
              narrationLines: exported.metadata.traceAudit.narrationLines,
              assistantBytes: exported.metadata.traceAudit.assistantBytes,
              observationBytes: exported.metadata.traceAudit.observationBytes,
              episodeChars,
              approxTokens,
              externalCalls: exported.metadata.externalCalls,
              completeKind: completion.kind,
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

  let auditSummary = null;
  if (failures === 0 && values.audit && ok.length > 0) {
    const auditResult = await auditTinkerSupervision(
      ok.map(r => r.exported),
      {formats: ['compact'], samplePerFeature: 1000, seed: 17},
    );
    if (!auditResult.valid || !auditResult.success || !auditResult.allReplayed) {
      throw new Error(`auditTinkerSupervision failed: ${JSON.stringify(auditResult.failures)}`);
    }
    auditSummary = {
      valid: auditResult.valid,
      allReplayed: auditResult.allReplayed,
      sampleTasks: auditResult.sampleTasks,
      causalPairs: auditResult.causalPairs.length,
      causalDivergencesChecked: auditResult.causalDivergencesChecked,
    };
  }

  const srcLens = ok.map(r => r.task.metadata.sourceChars).sort((a, b) => a - b);
  const traceLens = ok.map(r => r.task.metadata.traceLines).sort((a, b) => a - b);
  const epChars = ok.map(r => r.task.metadata.episodeChars).sort((a, b) => a - b);
  const extCalls = ok.map(r => r.task.metadata.externalCalls);
  const effectfulTasks = ok.filter(r => r.task.metadata.externalCalls > 0);
  const throwTasks = ok.filter(r => r.task.metadata.completeKind === 'throw');
  const tsTasks = ok.filter(r => r.task.language === 'ts');

  const summary = {
    totalCandidates: selected.length,
    verified: ok.length,
    failed: failures,
    families: new Set(ok.map(r => r.task.family)).size,
    distinctPackages: new Set(ok.map(r => r.task.metadata.package)).size,
    effectfulCount: effectfulTasks.length,
    effectfulFamilies: new Set(effectfulTasks.map(r => r.task.family)).size,
    throwCount: throwTasks.length,
    tsCount: tsTasks.length,
    sourceChars: srcLens.length ? {min: srcLens[0], median: srcLens[Math.floor(srcLens.length / 2)], max: srcLens.at(-1)} : null,
    traceLines: traceLens.length ? {min: traceLens[0], median: traceLens[Math.floor(traceLens.length / 2)], max: traceLens.at(-1)} : null,
    episodeChars: epChars.length ? {min: epChars[0], median: epChars[Math.floor(epChars.length / 2)], max: epChars.at(-1)} : null,
    externalCallsRange: effectfulTasks.length
      ? {min: Math.min(...effectfulTasks.map(r => r.task.metadata.externalCalls)), max: Math.max(...extCalls)}
      : null,
    audit: auditSummary,
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

  if (values['export-examples-path']) {
    const expPath = resolve(values['export-examples-path']);
    mkdirSync(dirname(expPath), {recursive: true});
    writeFileSync(expPath, ok.map(r => JSON.stringify(r.exported)).join('\n') + '\n');
    summary.exportedExamplesOutput = expPath;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
