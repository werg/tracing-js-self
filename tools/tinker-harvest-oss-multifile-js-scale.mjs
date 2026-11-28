#!/usr/bin/env node
// Scalable, fault-tolerant Real-World OSS Multi-File JS/TS Repo Harvester (v2).
//
// Shallow-clones a curated, diverse catalog of 100+ real-world pure-JS/TS
// multi-file GitHub repositories (with strong TypeScript representation and
// strict zero-overlap with RealExecBench v1 & Stage 10 dedup), builds realistic
// multi-file codebases (5–200 files, targeting 8K–56K approx tokens) preserving
// real distractor modules, and harvests audited, 2x deterministic, pre-exported
// execution tasks via three modes:
//   - Mode A (real-test): Real unit-test / example call-site extraction
//   - Mode B (api-probe): Cross-file public API probes across domains
//   - Mode C (oss-mutation-pair): Real-world 1-line AST-mutation counterfactual
//     pairs in an executed internal helper file, producing genuinely different
//     verified outcomes for the exact same entrypoint and arguments.

import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, join, posix as pathPosix, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, parseArgs} from 'node:util';
import vm from 'node:vm';
import {parse as acornParse} from 'acorn';
import ts from 'typescript';
import {
  assistantThinkingText,
  assistantVisibleText,
  encodeReadable,
  exportTinkerExample,
} from '../src/training/tinker-execution.js';
import {
  analyzeSourceFile,
  executeVirtualCodebaseInContext,
  MAX_CODEBASE_FILE_BYTES,
  MAX_CODEBASE_FILES,
  MAX_CODEBASE_TOTAL_BYTES,
  normalizeRepoPath,
  resolveVirtualModulePath,
  transpileSingleModuleToCjs,
} from '../src/training/tinker-codebase.js';
import {
  createReplayNodeIoBridge,
  VM_NODE_IO_RUNTIME_SCRIPT,
} from '../src/training/tinker-node-io.js';
import {extractTestCallsFromFiles} from './tinker-harvest.mjs';

process.on('unhandledRejection', () => {});

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_REALEXEC_BM = '/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl';
const DEFAULT_REALEXEC_MAN = '/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json';
const DEFAULT_STAGE10_JSONL = '/home/werg/tracing-js-self/runs/messy-v8-stage10/stage10-merged.jsonl';
const DEFAULT_CACHE_DIR = '/tmp/oss-js-scale-cache';
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, 'runs/oss-multifile-js-scale');

export const MAX_CONTEXT_TOKENS = 65472;
export const SAFE_MAX_CONTEXT_TOKENS = 58000;
export const MAX_TURN_TOKENS = 20000;
export const SAFE_MAX_TURN_TOKENS = 16000;
export const MAX_ASSISTANT_TURNS = 40;
export const TARGET_MIN_CODEBASE_BYTES = 28 * 1024; // ~8K tokens
export const TARGET_MAX_CODEBASE_BYTES = 196 * 1024; // ~56K tokens
export const HARD_MAX_PACKAGE_BYTES = Math.min(MAX_CODEBASE_TOTAL_BYTES, 1024 * 1024);
export const HARD_MAX_SINGLE_FILE_BYTES = Math.min(MAX_CODEBASE_FILE_BYTES, 128 * 1024);
export const MIN_SINGLE_FILE_BYTES = 20;

const JS_RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private',
  'protected', 'public', 'await', 'arguments', 'eval',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', '.vscode', '.idea', 'dist', 'build', 'out',
  'coverage', 'test', 'tests', '__tests__', '__mocks__', '__snapshots__', 'spec',
  'specs', 'docs', 'doc', 'examples', 'example', 'demo', 'demos', 'bench',
  'benchmark', 'benchmarks', 'fixtures', 'fixture', 'scripts', 'bin', 'types',
  'typings', 'website', 'site', 'public', 'static', 'assets', 'vendor',
  'third_party', '.next', '.nuxt', '.cache', 'tmp', 'temp', 'cjs', 'esm', 'umd',
  'browser', 'playground', 'stories', 'e2e', 'integration', 'locales', 'i18n',
]);

const TEST_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'examples', 'example',
]);

const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/i;
const TS_EXT_RE = /\.(?:ts|tsx|mts|cts)$/i;
const SKIP_FILE_RE = /(?:\.d\.ts$|\.d\.mts$|\.d\.cts$|\.test\.|\.spec\.|\.min\.|\.bundle\.|\.config\.|config\.js$|config\.ts$|rollup|webpack|vite\.|jest\.|vitest\.|babel\.|eslint|prettier|gulpfile|gruntfile|\.bench\.|\.stories\.)/i;

// ==================== Curated Diverse Real-World OSS Catalog ====================
// 105+ brand-new, popular, permissively-licensed, pure-JS/TS multi-file repos
// spanning 25+ domains (>60% TypeScript), zero overlap with RealExecBench v1
// and deduplicated from existing Stage 10 multi-file repos.
export const OSS_REPO_CATALOG = [
  // --- Parsers / Lexers / YAML / TOML / JSON5 / JSONC / SQL / CSS / AST ---
  {slug: 'eemeli__yaml', github: 'eemeli/yaml', domain: 'yaml', lang: 'ts', license: 'ISC'},
  {slug: 'squirrelchat__smol-toml', github: 'squirrelchat/smol-toml', domain: 'toml', lang: 'ts', license: 'MIT'},
  {slug: 'json5__json5', github: 'json5/json5', domain: 'json5', lang: 'js', license: 'MIT'},
  {slug: 'microsoft__jsonc-parser', github: 'microsoft/node-jsonc-parser', domain: 'jsonc', lang: 'ts', license: 'MIT'},
  {slug: 'hjson__hjson-js', github: 'hjson/hjson-js', domain: 'json5', lang: 'js', license: 'MIT'},
  {slug: 'sql-formatter-org__sql-formatter', github: 'sql-formatter-org/sql-formatter', domain: 'sql', lang: 'ts', license: 'MIT'},
  {slug: 'meriyah__meriyah', github: 'meriyah/meriyah', domain: 'js-parser', lang: 'ts', license: 'ISC'},
  {slug: 'fb55__css-what', github: 'fb55/css-what', domain: 'css', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'fb55__nth-check', github: 'fb55/nth-check', domain: 'css', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'thysultan__stylis', github: 'thysultan/stylis', domain: 'css', lang: 'js', license: 'MIT'},
  {slug: 'Rich-Harris__magic-string', github: 'Rich-Harris/magic-string', domain: 'string-ast', lang: 'js', license: 'MIT'},
  {slug: 'Rich-Harris__devalue', github: 'Rich-Harris/devalue', domain: 'serialize', lang: 'js', license: 'MIT'},
  {slug: 'EricSmekens__jsep', github: 'EricSmekens/jsep', domain: 'expr', lang: 'js', license: 'MIT'},
  {slug: 'silentmatt__expr-eval', github: 'silentmatt/expr-eval', domain: 'expr', lang: 'js', license: 'MIT'},
  {slug: 'showdownjs__showdown', github: 'showdownjs/showdown', domain: 'markdown', lang: 'js', license: 'MIT'},
  {slug: 'dcastil__tailwind-merge', github: 'dcastil/tailwind-merge', domain: 'css', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__knitwork', github: 'unjs/knitwork', domain: 'codegen', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__confbox', github: 'unjs/confbox', domain: 'yaml', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__cookie-es', github: 'unjs/cookie-es', domain: 'http', lang: 'ts', license: 'MIT'},
  {slug: 'vanillaes__csv', github: 'vanillaes/csv', domain: 'csv', lang: 'js', license: 'MIT'},
  {slug: 'jridgewell__gen-mapping', github: 'jridgewell/gen-mapping', domain: 'sourcemap', lang: 'ts', license: 'MIT'},
  {slug: 'mozilla__source-map', github: 'mozilla/source-map', domain: 'sourcemap', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'terser__terser', github: 'terser/terser', domain: 'js-parser', lang: 'js', license: 'BSD-2-Clause'},
  {slug: 'mishoo__UglifyJS', github: 'mishoo/UglifyJS', domain: 'js-parser', lang: 'js', license: 'BSD-2-Clause'},
  {slug: 'markdown-it__mdurl', github: 'markdown-it/mdurl', domain: 'url', lang: 'js', license: 'MIT'},
  {slug: 'markdown-it__linkify-it', github: 'markdown-it/linkify-it', domain: 'url', lang: 'js', license: 'MIT'},

  // --- Validators / Schemas / Type Guards ---
  {slug: 'colinhacks__zod', github: 'colinhacks/zod', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'fabian-hiller__valibot', github: 'fabian-hiller/valibot', domain: 'schema', lang: 'ts', license: 'MIT', subpath: 'library'},
  {slug: 'sinclairzx81__typebox', github: 'sinclairzx81/typebox', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'ianstormtaylor__superstruct', github: 'ianstormtaylor/superstruct', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'badrap__valita', github: 'badrap/valita', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'tdegrunt__jsonschema', github: 'tdegrunt/jsonschema', domain: 'schema', lang: 'js', license: 'MIT'},
  {slug: 'cfworker__cfworker', github: 'cfworker/cfworker', domain: 'schema', lang: 'ts', license: 'MIT', subpath: 'packages/json-schema'},
  {slug: 'sindresorhus__is', github: 'sindresorhus/is', domain: 'validator', lang: 'ts', license: 'MIT'},

  // --- Cron / Glob / Router / Path / URL / Template Engines ---
  {slug: 'Hexagon__croner', github: 'Hexagon/croner', domain: 'cron', lang: 'ts', license: 'MIT'},
  {slug: 'harrisiirak__cron-parser', github: 'harrisiirak/cron-parser', domain: 'cron', lang: 'ts', license: 'MIT'},
  {slug: 'bradymholt__cRonstrue', github: 'bradymholt/cRonstrue', domain: 'cron', lang: 'ts', license: 'MIT'},
  {slug: 'micromatch__picomatch', github: 'micromatch/picomatch', domain: 'glob', lang: 'js', license: 'MIT'},
  {slug: 'isaacs__minimatch', github: 'isaacs/minimatch', domain: 'glob', lang: 'ts', license: 'ISC'},
  {slug: 'jonschlinkert__braces', github: 'jonschlinkert/braces', domain: 'glob', lang: 'js', license: 'MIT'},
  {slug: 'pillarjs__path-to-regexp', github: 'pillarjs/path-to-regexp', domain: 'router', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__radix3', github: 'unjs/radix3', domain: 'router', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__rou3', github: 'unjs/rou3', domain: 'router', lang: 'ts', license: 'MIT'},
  {slug: 'eta-dev__eta', github: 'eta-dev/eta', domain: 'template', lang: 'ts', license: 'MIT'},
  {slug: 'squirrellyjs__squirrelly', github: 'squirrellyjs/squirrelly', domain: 'template', lang: 'ts', license: 'MIT'},
  {slug: 'harttle__liquidjs', github: 'harttle/liquidjs', domain: 'template', lang: 'ts', license: 'MIT'},
  {slug: 'ljharb__qs', github: 'ljharb/qs', domain: 'query', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'medialize__URI-js', github: 'medialize/URI.js', domain: 'url', lang: 'js', license: 'MIT'},
  {slug: 'faisalman__ua-parser-js', github: 'faisalman/ua-parser-js', domain: 'ua', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__negotiator', github: 'jshttp/negotiator', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'messageformat__messageformat', github: 'messageformat/messageformat', domain: 'i18n', lang: 'ts', license: 'MIT', subpath: 'packages/parser'},

  // --- State Machines / Reactive Signals / UI State / Functional ---
  {slug: 'statelyai__xstate', github: 'statelyai/xstate', domain: 'state-machine', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'pmndrs__zustand', github: 'pmndrs/zustand', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'pmndrs__valtio', github: 'pmndrs/valtio', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'preactjs__signals', github: 'preactjs/signals', domain: 'reactive', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'preactjs__preact', github: 'preactjs/preact', domain: 'vdom', lang: 'js', license: 'MIT'},
  {slug: 'nanostores__nanostores', github: 'nanostores/nanostores', domain: 'state', lang: 'js', license: 'MIT'},
  {slug: 'mobxjs__mobx', github: 'mobxjs/mobx', domain: 'reactive', lang: 'ts', license: 'MIT', subpath: 'packages/mobx'},
  {slug: 'remeda__remeda', github: 'remeda/remeda', domain: 'functional', lang: 'ts', license: 'MIT', subpath: 'packages/remeda'},
  {slug: 'ramda__ramda', github: 'ramda/ramda', domain: 'functional', lang: 'js', license: 'MIT'},
  {slug: 'gcanti__fp-ts', github: 'gcanti/fp-ts', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'supermacro__neverthrow', github: 'supermacro/neverthrow', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'jashkenas__underscore', github: 'jashkenas/underscore', domain: 'functional', lang: 'js', license: 'MIT'},
  {slug: 'lodash__lodash', github: 'lodash/lodash', domain: 'functional', lang: 'js', license: 'MIT'},
  {slug: 'TanStack__table', github: 'TanStack/table', domain: 'table', lang: 'ts', license: 'MIT', subpath: 'packages/table-core'},
  {slug: 'floating-ui__floating-ui', github: 'floating-ui/floating-ui', domain: 'geo', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'react-hook-form__react-hook-form', github: 'react-hook-form/react-hook-form', domain: 'state', lang: 'ts', license: 'MIT'},

  // --- Date / Time / Math / Money / Color / Geo / Graph / Data Structures ---
  {slug: 'date-fns__date-fns', github: 'date-fns/date-fns', domain: 'date', lang: 'ts', license: 'MIT'},
  {slug: 'iamkun__dayjs', github: 'iamkun/dayjs', domain: 'date', lang: 'js', license: 'MIT'},
  {slug: 'js-joda__js-joda', github: 'js-joda/js-joda', domain: 'date', lang: 'js', license: 'BSD-3-Clause', subpath: 'packages/core'},
  {slug: 'dinerojs__dinero-js', github: 'dinerojs/dinero.js', domain: 'money', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'toji__gl-matrix', github: 'toji/gl-matrix', domain: 'math', lang: 'js', license: 'MIT'},
  {slug: 'josdejong__mathjs', github: 'josdejong/mathjs', domain: 'math', lang: 'js', license: 'Apache-2.0'},
  {slug: 'indutny__bn-js', github: 'indutny/bn.js', domain: 'math', lang: 'js', license: 'MIT'},
  {slug: 'd3__d3-format', github: 'd3/d3-format', domain: 'format', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-quadtree', github: 'd3/d3-quadtree', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-polygon', github: 'd3/d3-polygon', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-path', github: 'd3/d3-path', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-time', github: 'd3/d3-time', domain: 'date', lang: 'js', license: 'ISC'},
  {slug: 'omgovich__colord', github: 'omgovich/colord', domain: 'color', lang: 'ts', license: 'MIT'},
  {slug: 'Evercoder__culori', github: 'Evercoder/culori', domain: 'color', lang: 'js', license: 'MIT'},
  {slug: 'color-js__color-js', github: 'color-js/color.js', domain: 'color', lang: 'js', license: 'MIT'},
  {slug: 'graphology__graphology', github: 'graphology/graphology', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'dagrejs__graphlib', github: 'dagrejs/graphlib', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'Yomguithereal__mnemonist', github: 'Yomguithereal/mnemonist', domain: 'datastructures', lang: 'js', license: 'MIT'},
  {slug: 'isaacs__node-lru-cache', github: 'isaacs/node-lru-cache', domain: 'datastructures', lang: 'ts', license: 'ISC'},
  {slug: 'qiao__PathFinding-js', github: 'qiao/PathFinding.js', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'trekhleb__javascript-algorithms', github: 'trekhleb/javascript-algorithms', domain: 'algorithms', lang: 'js', license: 'MIT'},
  {slug: 'lucaong__minisearch', github: 'lucaong/minisearch', domain: 'search', lang: 'ts', license: 'MIT'},
  {slug: 'oramasearch__orama', github: 'oramasearch/orama', domain: 'search', lang: 'ts', license: 'Apache-2.0', subpath: 'packages/orama'},

  // --- Encoding / Compression / Crypto / Diff / Patch / CLI / String / Utilities ---
  {slug: 'paulmillr__noble-hashes', github: 'paulmillr/noble-hashes', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__noble-ciphers', github: 'paulmillr/noble-ciphers', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__scure-base', github: 'paulmillr/scure-base', domain: 'encoding', lang: 'ts', license: 'MIT'},
  {slug: 'brix__crypto-js', github: 'brix/crypto-js', domain: 'crypto', lang: 'js', license: 'MIT'},
  {slug: 'nodeca__pako', github: 'nodeca/pako', domain: 'compression', lang: 'js', license: 'MIT'},
  {slug: '101arrowz__fflate', github: '101arrowz/fflate', domain: 'compression', lang: 'ts', license: 'MIT'},
  {slug: 'pieroxy__lz-string', github: 'pieroxy/lz-string', domain: 'compression', lang: 'ts', license: 'MIT'},
  {slug: 'msgpack__msgpack-javascript', github: 'msgpack/msgpack-javascript', domain: 'encoding', lang: 'ts', license: 'ISC'},
  {slug: 'kriszyp__msgpackr', github: 'kriszyp/msgpackr', domain: 'encoding', lang: 'js', license: 'MIT'},
  {slug: 'kriszyp__cbor-x', github: 'kriszyp/cbor-x', domain: 'encoding', lang: 'js', license: 'MIT'},
  {slug: 'woltapp__blurhash', github: 'woltapp/blurhash', domain: 'encoding', lang: 'ts', license: 'MIT', subpath: 'TypeScript'},
  {slug: 'benjamine__jsondiffpatch', github: 'benjamine/jsondiffpatch', domain: 'diff', lang: 'ts', license: 'MIT', subpath: 'packages/jsondiffpatch'},
  {slug: 'fiduswriter__diffDOM', github: 'fiduswriter/diffDOM', domain: 'diff', lang: 'ts', license: 'LGPL-3.0'},
  {slug: 'privatenumber__cleye', github: 'privatenumber/cleye', domain: 'cli', lang: 'ts', license: 'MIT'},
  {slug: 'planttheidea__fast-equals', github: 'planttheidea/fast-equals', domain: 'utility', lang: 'ts', license: 'MIT'},
  {slug: 'planttheidea__fast-copy', github: 'planttheidea/fast-copy', domain: 'utility', lang: 'ts', license: 'MIT'},
  {slug: 'panzerdp__voca', github: 'panzerdp/voca', domain: 'string', lang: 'js', license: 'MIT'},
  {slug: 'epeli__underscore-string', github: 'epeli/underscore.string', domain: 'string', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__p-queue', github: 'sindresorhus/p-queue', domain: 'async', lang: 'ts', license: 'MIT'},
  {slug: 'zxing-js__library', github: 'zxing-js/library', domain: 'encoding', lang: 'ts', license: 'MIT'},
  {slug: 'soldair__node-qrcode', github: 'soldair/node-qrcode', domain: 'encoding', lang: 'js', license: 'MIT'},
  {slug: 'js-temporal__temporal-polyfill', github: 'js-temporal/temporal-polyfill', domain: 'date', lang: 'ts', license: 'MIT', subpath: 'packages/temporal-polyfill'},
  {slug: 'unjs__unctx', github: 'unjs/unctx', domain: 'async', lang: 'ts', license: 'MIT'},
  {slug: 'andreasonny83__unique-names-generator', github: 'andreasonny83/unique-names-generator', domain: 'string', lang: 'ts', license: 'MIT'},
  {slug: 'typestack__class-transformer', github: 'typestack/class-transformer', domain: 'utility', lang: 'ts', license: 'MIT'},
  {slug: 'm93a__filtrex', github: 'm93a/filtrex', domain: 'expr', lang: 'ts', license: 'MIT'},

  // --- Wave 2 Catalog Expansion (Pure JS/TS multi-file repos across 20+ domains) ---
  {slug: 'nodeca__js-yaml', github: 'nodeca/js-yaml', domain: 'yaml', lang: 'js', license: 'MIT'},
  {slug: 'iarna__iarna-toml', github: 'iarna/iarna-toml', domain: 'toml', lang: 'js', license: 'ISC'},
  {slug: 'fb55__entities', github: 'fb55/entities', domain: 'encoding', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'b-studios__js-sdsl', github: 'js-sdsl/js-sdsl', domain: 'datastructures', lang: 'ts', license: 'MIT'},
  {slug: 'antfu__utils', github: 'antfu/utils', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'supercharge__strings', github: 'supercharge/strings', domain: 'string', lang: 'ts', license: 'MIT'},
  {slug: 'supercharge__collections', github: 'supercharge/collections', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'gigobyte__purify', github: 'gigobyte/purify', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'true-myth__true-myth', github: 'true-myth/true-myth', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'jkbrzt__rrule', github: 'jkbrzt/rrule', domain: 'date', lang: 'ts', license: 'BSD-3-Clause'},
  {slug: 'spencermountain__spacetime', github: 'spencermountain/spacetime', domain: 'date', lang: 'js', license: 'MIT'},
  {slug: 'spencermountain__wtf_wikipedia', github: 'spencermountain/wtf_wikipedia', domain: 'markdown', lang: 'js', license: 'MIT'},
  {slug: 'mapbox__geojson-vt', github: 'mapbox/geojson-vt', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'w8r__martinez', github: 'w8r/martinez', domain: 'geo', lang: 'js', license: 'MIT'},
  {slug: 'mfogel__polygon-clipping', github: 'mfogel/polygon-clipping', domain: 'geo', lang: 'js', license: 'MIT'},
  {slug: 'piqnt__planck-js', github: 'piqnt/planck.js', domain: 'geo', lang: 'ts', license: 'MIT'},
  {slug: 'davidfig__intersects', github: 'davidfig/intersects', domain: 'geo', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__binary-search-tree', github: 'datastructures-js/binary-search-tree', domain: 'datastructures', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__heap', github: 'datastructures-js/heap', domain: 'datastructures', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__graph', github: 'datastructures-js/graph', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__trie', github: 'datastructures-js/trie', domain: 'datastructures', lang: 'js', license: 'MIT'},
  {slug: 'mljs__matrix', github: 'mljs/matrix', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'jstat__jstat', github: 'jstat/jstat', domain: 'math', lang: 'js', license: 'MIT'},
  {slug: 'd3__d3-dsv', github: 'd3/d3-dsv', domain: 'csv', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-ease', github: 'd3/d3-ease', domain: 'math', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-random', github: 'd3/d3-random', domain: 'math', lang: 'js', license: 'ISC'},
  {slug: 'rsuite__schema-typed', github: 'rsuite/schema-typed', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'streamich__json-joy', github: 'streamich/json-joy', domain: 'encoding', lang: 'ts', license: 'Apache-2.0'},
  {slug: 'kwhitley__itty-router', github: 'kwhitley/itty-router', domain: 'router', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__untyped', github: 'unjs/untyped', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__magic-regexp', github: 'unjs/magic-regexp', domain: 'glob', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__consola', github: 'unjs/consola', domain: 'cli', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__mlly', github: 'unjs/mlly', domain: 'js-parser', lang: 'ts', license: 'MIT'},
  {slug: 'TanStack__store', github: 'TanStack/store', domain: 'state', lang: 'ts', license: 'MIT', subpath: 'packages/store'},
  {slug: 'fastify__fast-uri', github: 'fastify/fast-uri', domain: 'url', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'mixmark-io__turndown', github: 'mixmark-io/turndown', domain: 'markdown', lang: 'js', license: 'MIT'},
  {slug: 'peggyjs__peggy', github: 'peggyjs/peggy', domain: 'js-parser', lang: 'js', license: 'MIT'},
  {slug: 'chevrotain__chevrotain', github: 'chevrotain/chevrotain', domain: 'js-parser', lang: 'ts', license: 'Apache-2.0', subpath: 'packages/chevrotain'},
  {slug: 'kysely-org__kysely', github: 'kysely-org/kysely', domain: 'sql', lang: 'ts', license: 'MIT'},
  {slug: 'hiddentao__squel', github: 'hiddentao/squel', domain: 'sql', lang: 'js', license: 'MIT'},
  {slug: 'niieani__hashids-js', github: 'niieani/hashids.js', domain: 'encoding', lang: 'ts', license: 'MIT'},
  {slug: 'ecrmnn__collect-js', github: 'ecrmnn/collect.js', domain: 'functional', lang: 'js', license: 'MIT'},
  {slug: 'foliojs__restructure', github: 'foliojs/restructure', domain: 'encoding', lang: 'js', license: 'MIT'},
  {slug: 'indutny__hash-js', github: 'indutny/hash.js', domain: 'crypto', lang: 'js', license: 'MIT'},
  {slug: 'node-cron__node-cron', github: 'node-cron/node-cron', domain: 'cron', lang: 'ts', license: 'ISC'},
  {slug: 'panva__jose', github: 'panva/jose', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'mde__ejs', github: 'mde/ejs', domain: 'template', lang: 'js', license: 'Apache-2.0'},
  {slug: 'vuejs__petite-vue', github: 'vuejs/petite-vue', domain: 'reactive', lang: 'ts', license: 'MIT'},
];

// ==================== Helpers ====================

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function slugify(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

function estimateTokens(chars, ratio = 3.2) {
  return Math.ceil(chars / ratio);
}

function estimateMessageTokens(msg) {
  let chars = 0;
  if (typeof msg.content === 'string') {
    chars += msg.content.length;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === 'thinking') chars += String(part.thinking ?? '').length;
      else if (part?.type === 'text') chars += String(part.text ?? '').length;
      else chars += JSON.stringify(part ?? '').length;
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    chars += JSON.stringify(msg.tool_calls).length;
  }
  return estimateTokens(chars, 3.2);
}

function normalizeRepoTokens(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return [];
  const out = new Set([s]);
  // Handle owner__repo or owner/repo
  const parts = s.split(/__|\/|:/).filter(Boolean);
  for (const p of parts) {
    if (p.length >= 3) out.add(p);
    const cleaned = p.replace(/\.js$|-js$/, '');
    if (cleaned.length >= 3) out.add(cleaned);
  }
  return [...out];
}

// ==================== Reference / Forbidden Set Loading ====================

export function loadAuditReferenceSets({
  realExecBmPath = DEFAULT_REALEXEC_BM,
  realExecManPath = DEFAULT_REALEXEC_MAN,
  stage10Path = DEFAULT_STAGE10_JSONL,
} = {}) {
  const forbidden = {
    ids: new Set(),
    families: new Set(),
    sourceHashes: new Set(),
    splitComponents: new Set(),
    repos: new Set(),
    repoNamesNormalized: new Set(),
  };

  if (realExecBmPath && existsSync(realExecBmPath)) {
    for (const line of readFileSync(realExecBmPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.id) forbidden.ids.add(String(row.id));
      if (row.task_id) forbidden.ids.add(String(row.task_id));
      if (row.task?.id) forbidden.ids.add(String(row.task.id));
      if (row.family) forbidden.families.add(String(row.family));
      if (row.task?.family) forbidden.families.add(String(row.task.family));
      if (row.sourceHash) forbidden.sourceHashes.add(String(row.sourceHash));
      if (row.split_component) forbidden.splitComponents.add(String(row.split_component));

      const rawRepo = row.metadata?.repo ?? row.task?.metadata?.repo ?? null;
      if (rawRepo) {
        forbidden.repos.add(String(rawRepo).toLowerCase());
        for (const tok of normalizeRepoTokens(rawRepo)) forbidden.repoNamesNormalized.add(tok);
      }
      // Also parse repo names out of oss: / multifile-js/ / lc65k-oss/ / hairy-real: families
      const fam = String(row.family ?? '');
      const famMatch = fam.match(/^(?:oss:|hairy-real:|multifile-js\/|lc65k-oss\/)([^/:#]+)/i);
      if (famMatch) {
        forbidden.repos.add(famMatch[1].toLowerCase());
        for (const tok of normalizeRepoTokens(famMatch[1])) forbidden.repoNamesNormalized.add(tok);
      }
    }
  }

  if (realExecManPath && existsSync(realExecManPath)) {
    try {
      const man = JSON.parse(readFileSync(realExecManPath, 'utf8'));
      for (const list of Object.values(man.task_ids_by_track ?? {})) {
        for (const tid of list) forbidden.ids.add(String(tid));
      }
    } catch {}
  }

  const stage10 = {
    ids: new Set(),
    sourceHashes: new Set(),
  };
  if (stage10Path && existsSync(stage10Path)) {
    for (const line of readFileSync(stage10Path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.id) stage10.ids.add(String(row.id));
      if (row.task_id) stage10.ids.add(String(row.task_id));
      if (row.task?.id) stage10.ids.add(String(row.task.id));
      if (row.sourceHash) stage10.sourceHashes.add(String(row.sourceHash));
    }
  }

  return {forbidden, stage10};
}

export function isRepoForbidden(repoEntry, forbidden) {
  const candidates = [
    repoEntry.slug.toLowerCase(),
    repoEntry.github.toLowerCase(),
    repoEntry.github.split('/')[1]?.toLowerCase() ?? '',
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (forbidden.repos.has(c) || forbidden.repoNamesNormalized.has(c)) return true;
    const stripped = c.replace(/\.js$|-js$/, '');
    if (stripped.length >= 3 && forbidden.repoNamesNormalized.has(stripped)) return true;
  }
  return false;
}

// ==================== Fault-Tolerant Shallow Cloning ====================

function runGitClone(url, destDir, timeoutMs = 40000) {
  return new Promise(resolvePromise => {
    const attempt = (args, onFail) => {
      let settled = false;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ok: true});
      };
      const finishFail = msg => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onFail(msg);
      };

      const child = spawn('git', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
        env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo'},
      });
      let stderr = '';
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        try { child.stderr?.destroy(); } catch {}
        finishFail('git-clone-timeout');
      }, timeoutMs);
      child.stderr.on('data', d => {
        if (stderr.length < 500) stderr += d.toString().slice(0, 500 - stderr.length);
      });
      child.on('error', err => finishFail(String(err?.message ?? err)));
      child.on('exit', code => {
        if (code === 0) finishOk();
        else finishFail(`git-exit-${code}: ${stderr.trim().slice(0, 240)}`);
      });
    };

    try { rmSync(destDir, {recursive: true, force: true}); } catch {}
    attempt(
      ['clone', '--depth', '1', '--single-branch', '--no-tags', url, destDir],
      err1 => {
        try { rmSync(destDir, {recursive: true, force: true}); } catch {}
        resolvePromise({ok: false, error: err1});
      },
    );
  });
}

async function ensureRepoCloned(repoEntry, cacheDir, errorLogFn) {
  mkdirSync(cacheDir, {recursive: true});
  const destDir = join(cacheDir, repoEntry.slug);
  if (existsSync(join(destDir, '.git'))) {
    // Check non-empty working tree
    try {
      const entries = readdirSync(destDir).filter(e => e !== '.git');
      if (entries.length > 0) return {ok: true, dir: destDir, cached: true};
    } catch {}
  }
  const url = `https://github.com/${repoEntry.github}.git`;
  const res = await runGitClone(url, destDir, 45000);
  if (!res.ok) {
    errorLogFn({stage: 'clone', repo: repoEntry.slug, github: repoEntry.github, error: res.error});
    return {ok: false, error: res.error};
  }
  return {ok: true, dir: destDir, cached: false};
}

async function cloneBatchWithConcurrency(repoEntries, cacheDir, concurrency, errorLogFn) {
  const results = new Map();
  let cursor = 0;
  const workers = Array.from({length: Math.max(1, concurrency)}, async () => {
    while (cursor < repoEntries.length) {
      const idx = cursor++;
      const entry = repoEntries[idx];
      const res = await ensureRepoCloned(entry, cacheDir, errorLogFn);
      results.set(entry.slug, res);
    }
  });
  await Promise.all(workers);
  return results;
}

// ==================== Source Walking & Static Import Analysis ====================

/** Extract runtime module specifiers from JS/TS source, ignoring TypeScript
 * `import type` and `export type` statements (which are erased during transpile). */
export function extractRuntimeSpecifiers(code, relPath = 'file.js') {
  const specs = new Set();
  if (TS_EXT_RE.test(relPath)) {
    try {
      const scriptKind = relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, false, scriptKind);
      const visit = node => {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          const isTypeOnly = Boolean(clause?.isTypeOnly);
          let hasValueBindings = !clause; // side-effect import `import './polyfill'`
          if (clause && !isTypeOnly) {
            if (clause.name) hasValueBindings = true;
            if (clause.namedBindings) {
              if (ts.isNamespaceImport(clause.namedBindings)) {
                hasValueBindings = true;
              } else if (ts.isNamedImports(clause.namedBindings)) {
                hasValueBindings = clause.namedBindings.elements.some(el => !el.isTypeOnly);
              }
            }
          }
          if (hasValueBindings && ts.isStringLiteral(node.moduleSpecifier)) {
            specs.add(node.moduleSpecifier.text);
          }
        } else if (ts.isExportDeclaration(node)) {
          if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            let hasValue = !node.exportClause; // `export * from './x'`
            if (node.exportClause) {
              if (ts.isNamespaceExport(node.exportClause)) hasValue = true;
              else if (ts.isNamedExports(node.exportClause)) {
                hasValue = node.exportClause.elements.some(el => !el.isTypeOnly);
              }
            }
            if (hasValue) specs.add(node.moduleSpecifier.text);
          }
        } else if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          node.arguments.length >= 1 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          specs.add(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return [...specs];
    } catch {
      // Fallback to regex below
    }
  }

  // Strip single-line / block comments lightly before regex for JS files
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  const importRe = /(?:^|[;\n])\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
  const requireRe = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  for (const m of stripped.matchAll(importRe)) specs.add(m[1]);
  for (const m of stripped.matchAll(requireRe)) specs.add(m[1]);
  return [...specs];
}

function walkSourceFiles(rootDir, maxDepth = 6, maxFiles = 320) {
  const results = [];
  function visit(dir, depth) {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
          visit(join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        if (!SOURCE_EXT_RE.test(entry.name) || SKIP_FILE_RE.test(entry.name)) continue;
        const abs = join(dir, entry.name);
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size < MIN_SINGLE_FILE_BYTES || st.size > HARD_MAX_SINGLE_FILE_BYTES) continue;
        results.push(abs);
      }
    }
  }
  visit(rootDir, 0);
  return results;
}

function walkTestFiles(repoDir, subpath = null, maxFiles = 120) {
  const baseDir = subpath ? join(repoDir, subpath) : repoDir;
  const roots = [baseDir];
  if (subpath) roots.push(repoDir);
  const found = new Set();

  function visit(dir, depth, insideTestDir) {
    if (depth > 5 || found.size >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.size >= maxFiles) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        const isTest = insideTestDir || TEST_DIR_NAMES.has(entry.name.toLowerCase());
        if (isTest || depth < 2) visit(abs, depth + 1, isTest);
      } else if (entry.isFile()) {
        if (!SOURCE_EXT_RE.test(entry.name) || /\.d\.[cm]?ts$/i.test(entry.name)) continue;
        const looksTest = insideTestDir || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name);
        if (!looksTest) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size < 30 || st.size > 256 * 1024) continue;
        found.add(abs);
      }
    }
  }
  for (const r of roots) {
    if (existsSync(r)) visit(r, 0, false);
  }
  return [...found];
}

function collectCandidateRoots(repoDir, subpath = null) {
  const candidates = [];
  const seen = new Set();
  const tryRoot = dir => {
    const abs = resolve(dir);
    if (seen.has(abs) || !existsSync(abs)) return;
    try {
      if (statSync(abs).isDirectory()) {
        seen.add(abs);
        candidates.push(abs);
      }
    } catch {}
  };

  const base = subpath && existsSync(join(repoDir, subpath)) ? join(repoDir, subpath) : repoDir;
  tryRoot(join(base, 'src'));
  tryRoot(join(base, 'lib'));
  tryRoot(join(base, 'source'));
  tryRoot(base);

  if (!subpath) {
    const packagesDir = join(repoDir, 'packages');
    if (existsSync(packagesDir)) {
      try {
        for (const entry of readdirSync(packagesDir, {withFileTypes: true}).slice(0, 10)) {
          if (!entry.isDirectory()) continue;
          const pDir = join(packagesDir, entry.name);
          if (existsSync(join(pDir, 'src'))) tryRoot(join(pDir, 'src'));
          else if (existsSync(join(pDir, 'lib'))) tryRoot(join(pDir, 'lib'));
          else tryRoot(pDir);
        }
      } catch {}
    }
  }
  return candidates;
}

/** Build clean multi-file codebases (minFiles..maxFiles) targeting 8K–56K approx
 * tokens (~28KB–196KB) while preserving real distractor files from the same repo. */
export function buildMultiFilePackagesV2(repoDir, {
  subpath = null,
  minFiles = 5,
  maxFiles = 180,
  targetMinBytes = TARGET_MIN_CODEBASE_BYTES,
  targetMaxBytes = TARGET_MAX_CODEBASE_BYTES,
  maxPackages = 8,
} = {}) {
  const clampedMaxFiles = Math.min(MAX_CODEBASE_FILES - 16, Math.max(minFiles, maxFiles));
  const packages = [];
  const seenFileSets = new Set();

  // Also gather repo-wide extra real source files (for realistic distractors if a
  // candidate root is small) without ever synthesizing fake files.
  const repoWideAbs = walkSourceFiles(subpath && existsSync(join(repoDir, subpath)) ? join(repoDir, subpath) : repoDir, 5, 260);
  const repoWideFiles = {};
  for (const abs of repoWideAbs) {
    const relRaw = relative(repoDir, abs).replaceAll('\\', '/');
    let norm;
    try { norm = normalizeRepoPath(relRaw); } catch { continue; }
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    repoWideFiles[norm] = content;
  }

  for (const root of collectCandidateRoots(repoDir, subpath)) {
    const absFiles = walkSourceFiles(root, 6, 600);
    if (absFiles.length < 2) continue;

    const allFiles = {};
    for (const abs of absFiles) {
      const relRaw = relative(repoDir, abs).replaceAll('\\', '/');
      let norm;
      try { norm = normalizeRepoPath(relRaw); } catch { continue; }
      let content;
      try { content = readFileSync(abs, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      allFiles[norm] = content;
    }

    const allPaths = Object.keys(allFiles).sort();
    if (allPaths.length < 2) continue;

    // Build local dependency graph with TS `import type` awareness.
    const deps = new Map();
    const hasExternalDep = new Map();
    for (const relPath of allPaths) {
      const specs = extractRuntimeSpecifiers(allFiles[relPath], relPath);
      const localDeps = [];
      let ext = false;
      for (const spec of specs) {
        if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
          const resolved = resolveVirtualModulePath(allFiles, relPath, spec);
          if (resolved) localDeps.push(resolved);
          else ext = true;
        } else {
          // Allow pure Node builtins that VM_NODE_IO_RUNTIME_SCRIPT provides?
          // Note: tinker-codebase's localRequire only resolves relative modules, so any
          // bare specifier fails localRequire. Treat bare specifiers as external.
          ext = true;
        }
      }
      deps.set(relPath, localDeps);
      hasExternalDep.set(relPath, ext);
    }

    const computeClosure = start => {
      const visited = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift();
        if (hasExternalDep.get(cur)) return null;
        for (const nxt of deps.get(cur) ?? []) {
          if (!visited.has(nxt)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      }
      return visited;
    };

    const entryCandidates = allPaths
      .filter(p => (deps.get(p)?.length ?? 0) > 0 && !hasExternalDep.get(p))
      .map(p => ({path: p, closure: computeClosure(p)}))
      .filter(c => c.closure && c.closure.size >= 2 && c.closure.size <= clampedMaxFiles)
      .sort((a, b) => {
        const aIdx = /(?:^|\/)(?:index|main)\.[^/]+$/i.test(a.path) ? 0 : 1;
        const bIdx = /(?:^|\/)(?:index|main)\.[^/]+$/i.test(b.path) ? 0 : 1;
        const aTs = TS_EXT_RE.test(a.path) ? 0 : 1;
        const bTs = TS_EXT_RE.test(b.path) ? 0 : 1;
        // Prefer index/main files, TS files, and richer closures (up to 60 files)
        const aRich = Math.min(a.closure.size, 60);
        const bRich = Math.min(b.closure.size, 60);
        return (aIdx - bIdx) || (aTs - bTs) || (bRich - aRich) || a.path.localeCompare(b.path);
      });

    for (const {path: entryFile, closure} of entryCandidates.slice(0, 18)) {
      const selectedPaths = [...closure].sort();
      let totalBytes = selectedPaths.reduce((s, p) => s + Buffer.byteLength(allFiles[p], 'utf8'), 0);
      if (totalBytes > HARD_MAX_PACKAGE_BYTES) continue;

      const selectedSet = new Set(selectedPaths);
      const entryDir = pathPosix.dirname(entryFile);

      // Pool of real distractor files from same root first, then repo-wide real files
      const pool = {...repoWideFiles, ...allFiles};
      const distractors = Object.keys(pool)
        .filter(p => !selectedSet.has(p))
        .sort((a, b) => {
          const aInRoot = Object.hasOwn(allFiles, a) ? 0 : 1;
          const bInRoot = Object.hasOwn(allFiles, b) ? 0 : 1;
          const aSame = pathPosix.dirname(a) === entryDir ? 0 : 1;
          const bSame = pathPosix.dirname(b) === entryDir ? 0 : 1;
          return (aInRoot - bInRoot) || (aSame - bSame) || a.localeCompare(b);
        });

      // Add real distractors until we reach >= minFiles AND target byte band (~28KB–196KB)
      for (const distPath of distractors) {
        if (selectedPaths.length >= clampedMaxFiles) break;
        const b = Buffer.byteLength(pool[distPath], 'utf8');
        if (totalBytes + b > HARD_MAX_PACKAGE_BYTES) continue;
        // Stop adding once we have enough files AND are well inside target token band
        if (selectedPaths.length >= Math.max(minFiles, closure.size + 8) && totalBytes >= targetMinBytes) {
          if (totalBytes + b > targetMaxBytes) break;
          // Add up to ~120KB / 90 files for rich realistic repo navigation
          if (totalBytes >= 120 * 1024 || selectedPaths.length >= 90) break;
        }
        selectedPaths.push(distPath);
        selectedSet.add(distPath);
        totalBytes += b;
      }

      if (selectedPaths.length < minFiles) continue;
      selectedPaths.sort();
      const files = {};
      for (const p of selectedPaths) files[p] = pool[p];

      const key = entryFile + '|' + selectedPaths.join(',');
      if (seenFileSets.has(key)) continue;
      seenFileSets.add(key);

      packages.push({
        files,
        entryFile,
        closureSize: closure.size,
        distractorCount: selectedPaths.length - closure.size,
        totalBytes,
        codebaseApproxTokens: estimateTokens(totalBytes, 3.5),
      });
      if (packages.length >= maxPackages) break;
    }
    if (packages.length >= maxPackages) break;
  }

  return packages;
}

// ==================== Live Export Discovery (Handles Barrel `export *`) ====================

function createProbeVmContext({recordedCalls, onOverflow, timeoutMs = 250}) {
  let clockMs = 1700000100000;
  let randState = 17 >>> 0;
  const nodeIoAdapter = {
    invokeSync(op, args) {
      if (op === 'env.get') {
        const key = String(args[0] ?? '');
        const val = key === 'NODE_ENV' ? 'production' : null;
        if (recordedCalls.length >= 16) { onOverflow(); return val; }
        recordedCalls.push({
          operation: 'env.get',
          arguments: encodeReadable([key]),
          status: 'fulfilled',
          result: encodeReadable(val),
        });
        return val;
      }
      if (op === 'platform.uuid') {
        const val = '00000000-0000-4000-8000-000000000017';
        if (recordedCalls.length >= 16) { onOverflow(); return val; }
        recordedCalls.push({
          operation: 'platform.uuid',
          arguments: [],
          status: 'fulfilled',
          result: encodeReadable(val),
        });
        return val;
      }
      if (op === 'platform.randomBytes') {
        const n = Math.min(64, Math.max(0, Number(args[0]) || 0));
        const buf = Buffer.alloc(n);
        for (let i = 0; i < n; i++) {
          randState = (Math.imul(randState, 1664525) + 1013904223) >>> 0;
          buf[i] = (randState >>> 24) & 0xff;
        }
        const b64 = buf.toString('base64');
        if (recordedCalls.length >= 16) { onOverflow(); return b64; }
        recordedCalls.push({
          operation: 'platform.randomBytes',
          arguments: encodeReadable([n]),
          status: 'fulfilled',
          result: encodeReadable(b64),
        });
        return b64;
      }
      onOverflow();
      throw new Error('Unsupported node IO op in OSS probe: ' + op);
    },
    invokeAsync(op) {
      onOverflow();
      return Promise.reject(new Error('Unsupported async node IO op in OSS probe: ' + op));
    },
  };

  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, Buffer,
    __platformNodeIo: createReplayNodeIoBridge(nodeIoAdapter),
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(lvl => [lvl, (...xs) => {
      if (recordedCalls.length >= 16) { onOverflow(); return; }
      try {
        recordedCalls.push({
          operation: 'platform.console.' + lvl,
          arguments: encodeReadable(xs),
          status: 'fulfilled',
          result: {$js: 'undefined'},
        });
      } catch {
        onOverflow();
      }
    }])),
    queueMicrotask: cb => queueMicrotask(cb),
  }, {codeGeneration: {strings: false, wasm: false}});

  new vm.Script(VM_NODE_IO_RUNTIME_SCRIPT).runInContext(context, {timeout: timeoutMs});
  context.__recDateNow = () => {
    const v = clockMs;
    clockMs += 37;
    if (recordedCalls.length >= 16) { onOverflow(); return v; }
    recordedCalls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: v});
    return v;
  };
  new vm.Script('Date.now = __recDateNow;').runInContext(context, {timeout: 100});
  new vm.Script(`(function(){let state=17>>>0;
    Math.random=function(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};})()`)
    .runInContext(context, {timeout: 100});

  return context;
}

/** Discover callable top-level exported functions from `entryFile`, including
 * TypeScript/ESM barrel `export * from './...'` re-exports! */
export function discoverCallableExports(files, entryFile, {timeoutMs = 500} = {}) {
  const names = new Set();
  // 1. Static AST symbols from entryFile
  try {
    const entryInfo = analyzeSourceFile(files[entryFile], entryFile);
    for (const sym of entryInfo.symbols.values()) {
      if (sym.exported && (sym.kind === 'function' || sym.kind === 'export') &&
          /^[A-Za-z_$][\w$]*$/.test(sym.name) && !JS_RESERVED_WORDS.has(sym.name)) {
        names.add(sym.name);
      }
    }
  } catch {}

  // 2. Live CJS module bootstrap inside sandboxed VM to capture `export *` barrels!
  const recordedCalls = [];
  let overflow = false;
  let bootstrapError = null;
  try {
    const context = createProbeVmContext({recordedCalls, onOverflow: () => { overflow = true; }, timeoutMs});
    const moduleCache = new Map();
    const loadMod = relPath => {
      if (moduleCache.has(relPath)) return moduleCache.get(relPath).exports;
      const cjsCode = transpileSingleModuleToCjs(files[relPath], relPath);
      const mod = {exports: {}, id: relPath, filename: relPath, loaded: false};
      moduleCache.set(relPath, mod);
      const localReq = spec => {
        const resolved = resolveVirtualModulePath(files, relPath, spec);
        if (!resolved) throw new Error(`Cannot find virtual module '${spec}' from '${relPath}'`);
        return loadMod(resolved);
      };
      const wrapper = new vm.Script(
        `(function(exports, require, module, __filename, __dirname) {\n${cjsCode}\n})`,
        {filename: relPath},
      ).runInContext(context, {timeout: timeoutMs});
      const dir = pathPosix.dirname(relPath);
      wrapper(mod.exports, localReq, mod, relPath, dir === '.' ? '' : dir);
      mod.loaded = true;
      return mod.exports;
    };
    const entryExports = loadMod(entryFile);
    if (entryExports && (typeof entryExports === 'object' || typeof entryExports === 'function')) {
      for (const key of Object.keys(entryExports)) {
        if (!/^[A-Za-z_$][\w$]*$/.test(key) || JS_RESERVED_WORDS.has(key)) continue;
        let val;
        try { val = entryExports[key]; } catch { continue; }
        if (typeof val === 'function') {
          // Skip obvious ES6 class declarations (calling without `new` throws TypeError)
          const src = Function.prototype.toString.call(val);
          if (/^\s*class\b/.test(src)) continue;
          names.add(key);
        }
      }
      if (typeof entryExports === 'function' && entryExports.name &&
          /^[A-Za-z_$][\w$]*$/.test(entryExports.name) && !JS_RESERVED_WORDS.has(entryExports.name)) {
        const src = Function.prototype.toString.call(entryExports);
        if (!/^\s*class\b/.test(src)) names.add(entryExports.name);
      }
    }
  } catch (err) {
    bootstrapError = String(err?.message ?? err);
  }

  return {exports: [...names], bootstrapError, overflow};
}

// ==================== Mode A: Real Unit-Test & README Call Extraction ====================

function extractReadmeCalls(repoDir, exportNames) {
  const byFn = new Map();
  const exportSet = new Set(exportNames);
  const readmeCandidates = ['README.md', 'readme.md', 'Readme.md'];
  for (const name of readmeCandidates) {
    const p = join(repoDir, name);
    if (!existsSync(p)) continue;
    let md;
    try { md = readFileSync(p, 'utf8'); } catch { continue; }
    const fenceRe = /```(?:js|javascript|ts|typescript|mjs)?\s*\n([\s\S]*?)```/gi;
    for (const m of md.matchAll(fenceRe)) {
      const snippet = m[1];
      if (snippet.length > 8000) continue;
      let jsCode = snippet;
      try {
        jsCode = ts.transpileModule(snippet, {
          compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
        }).outputText;
      } catch {}
      let ast;
      try { ast = acornParse(jsCode, {ecmaVersion: 'latest', sourceType: 'module'}); }
      catch {
        try { ast = acornParse(jsCode, {ecmaVersion: 'latest', sourceType: 'script'}); }
        catch { continue; }
      }
      const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression') {
          let fnName = null;
          if (node.callee?.type === 'Identifier' && exportSet.has(node.callee.name)) {
            fnName = node.callee.name;
          } else if (node.callee?.type === 'MemberExpression' && !node.callee.computed &&
              node.callee.property?.type === 'Identifier' && exportSet.has(node.callee.property.name)) {
            fnName = node.callee.property.name;
          }
          if (fnName && node.arguments.length >= 1 && node.arguments.length <= 5) {
            const evalLit = n => {
              if (!n) return {ok: false};
              if (n.type === 'Literal') return {ok: true, value: n.value};
              if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument?.type === 'Literal' && typeof n.argument.value === 'number') {
                return {ok: true, value: -n.argument.value};
              }
              if (n.type === 'TemplateLiteral' && n.expressions.length === 0) {
                return {ok: true, value: n.quasis[0]?.value?.cooked ?? ''};
              }
              if (n.type === 'ArrayExpression' && n.elements.length <= 12) {
                const arr = [];
                for (const el of n.elements) {
                  const r = evalLit(el);
                  if (!r.ok) return {ok: false};
                  arr.push(r.value);
                }
                return {ok: true, value: arr};
              }
              if (n.type === 'ObjectExpression' && n.properties.length <= 10) {
                const obj = {};
                for (const prop of n.properties) {
                  if (prop.type !== 'Property' || prop.computed) return {ok: false};
                  const k = prop.key?.type === 'Identifier' ? prop.key.name
                    : (prop.key?.type === 'Literal' ? String(prop.key.value) : null);
                  if (!k) return {ok: false};
                  const r = evalLit(prop.value);
                  if (!r.ok) return {ok: false};
                  obj[k] = r.value;
                }
                return {ok: true, value: obj};
              }
              return {ok: false};
            };
            const args = [];
            let allOk = true;
            for (const a of node.arguments) {
              const r = evalLit(a);
              if (!r.ok) { allOk = false; break; }
              args.push(r.value);
            }
            if (allOk) {
              try {
                const sig = JSON.stringify(encodeReadable(args));
                if (sig.length <= 2000) {
                  if (!byFn.has(fnName)) byFn.set(fnName, []);
                  const list = byFn.get(fnName);
                  if (list.length < 12 && !list.some(x => x.sig === sig)) {
                    list.push({args, sig, file: name, source: 'readme'});
                  }
                }
              } catch {}
            }
          }
        }
        for (const v of Object.values(node)) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') walk(v);
        }
      };
      walk(ast);
    }
  }
  return byFn;
}

function collectRealTestArgs(repoDir, repoEntry, exportNames, entryFile) {
  const byFn = new Map();
  if (!exportNames.length) return byFn;
  const testFiles = walkTestFiles(repoDir, repoEntry.subpath, 120);
  const pkgName = repoEntry.github.split('/')[1] ?? repoEntry.slug;
  const aliases = [
    pkgName,
    pkgName.replace(/\.js$|-js$/i, ''),
    basename(entryFile).replace(/\.[^.]+$/, ''),
  ];

  if (testFiles.length > 0) {
    try {
      const extracted = extractTestCallsFromFiles(repoDir, testFiles, exportNames, aliases, {
        maxFiles: 100,
        maxCallsPerFn: 20,
        pkgName,
      });
      for (const [fn, calls] of extracted.entries()) {
        byFn.set(fn, calls.map(c => ({...c, source: 'unit-test'})));
      }
    } catch {}
  }

  // Supplement with README code fence examples for functions missing test extractions
  try {
    const readmeCalls = extractReadmeCalls(repoDir, exportNames);
    for (const [fn, calls] of readmeCalls.entries()) {
      const existing = byFn.get(fn) ?? [];
      for (const c of calls) {
        if (existing.length < 20 && !existing.some(x => x.sig === c.sig)) {
          existing.push(c);
        }
      }
      if (existing.length) byFn.set(fn, existing);
    }
  } catch {}

  return byFn;
}

// ==================== Mode B: Rich Domain-Aware Public API Probes ====================

function generateDomainProbes(fnName, domain) {
  const lower = fnName.toLowerCase();
  const candidates = [];

  const domainBanks = {
    yaml: [
      ['name: service\nversion: 2\nenabled: true\ntags:\n  - prod\n  - edge\nconfig:\n  retries: 3\n  timeout: 1500\n'],
      ['- id: 1\n  role: admin\n- id: 2\n  role: viewer\n'],
      [{service: 'api', replicas: 3, flags: ['v2', 'canary'], limits: {cpu: 2, mem: '4Gi'}}],
    ],
    toml: [
      ['title = "Service Config"\n[server]\nhost = "127.0.0.1"\nport = 8080\nfeatures = ["auth", "metrics"]\n'],
      [{title: 'App', server: {host: 'localhost', port: 3000}, debug: false}],
    ],
    json5: [
      ['{\n  // comment\n  unquoted: \'single\', trailing: [1, 2, 3,], hex: 0x1a,\n}'],
      [{name: 'widget', count: 4, nested: {active: true}}],
    ],
    jsonc: [
      ['{\n  // header comment\n  "name": "app",\n  /* block */\n  "ports": [80, 443]\n}'],
      ['{"a": 1, "b": [2, 3]}', ['b', 1]],
    ],
    sql: [
      ['SELECT u.id, u.name, COUNT(o.id) AS orders FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE u.active = 1 GROUP BY u.id ORDER BY orders DESC LIMIT 10;'],
      ['SELECT a, b FROM items WHERE price >= 10 AND status IN (\'open\', \'pending\')'],
    ],
    'js-parser': [
      ['function sum(xs) { let total = 0; for (const x of xs) total += x; return total; }'],
      ['export const add = (a, b) => a + b * 2;'],
      ['const cfg = { ok: true, count: 1 + 2 * 3, items: [1, 2] };'],
    ],
    css: [
      ['main > ul.nav li:nth-child(2n+1) > a[href^="https"]:hover'],
      ['.card { color: #224466; padding: 8px 16px; display: flex; }'],
      ['2n+1'],
      ['px-2 py-1 bg-red-500 p-4 bg-blue-600'],
      ['text-sm font-bold', 'text-lg text-gray-800'],
    ],
    expr: [
      ['(2 + 3) * 4 - 6 / 2'],
      ['price * qty - discount'],
      ['a > 5 && b <= 10 || c == 3'],
    ],
    markdown: [
      ['# Release Notes\n\nParagraph with *italic*, **bold**, and `code`.\n\n- First item\n- Second item\n'],
    ],
    csv: [
      ['name,role,score\nalice,admin,98\nbob,"lead, dev",87\n'],
      [[['name', 'score'], ['alice', '98'], ['bob', '87']]],
    ],
    cron: [
      ['*/15 9-17 * * 1-5'],
      ['0 0 1 * *'],
      ['30 4 * * 1-5'],
    ],
    glob: [
      ['src/**/*.ts'],
      ['src/{a,b}/file.{js,ts}'],
      ['src/utils/math.ts', 'src/**/*.ts'],
      ['a/{b,c}/{1..3}.js'],
    ],
    router: [
      ['/users/:id/posts/:postId'],
      ['/api/v1/items/:slug?'],
      ['/files/*path'],
    ],
    template: [
      ['Hello <%= it.name %>! Count: <%= it.count + 1 %>', {name: 'Ada', count: 4}],
      ['Hello {{name}}! Items: {{count}}', {name: 'Ada', count: 3}],
      ['{% for x in items %}{{ x }},{% endfor %}', {items: ['a', 'b', 'c']}],
    ],
    query: [
      ['a=1&b[c]=two&b[d][0]=x&b[d][1]=y&flag=true'],
      [{filter: {status: 'open', tags: ['v1', 'v2']}, page: 2}],
    ],
    url: [
      ['https://user:pass@example.com:8443/api/v2/items?sort=asc&limit=10#top'],
      ['Check https://example.org/docs and mailto:dev@example.org today.'],
      ['hello world & more?x=1'],
    ],
    http: [
      ['session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'],
      ['text/html,application/xhtml+xml;q=0.9,application/json;q=0.8'],
      ['en-US,en;q=0.9,fr;q=0.5'],
    ],
    ua: [
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'],
    ],
    date: [
      [new Date('2025-11-27T10:30:00Z')],
      [new Date('2025-11-27T10:30:00Z'), 5],
      [new Date('2025-11-27T10:30:00Z'), new Date('2025-01-15T08:00:00Z')],
      ['2025-11-27T10:30:00Z'],
      ['2025-03-15', '2025-11-27'],
    ],
    color: [
      ['#3b82f6'],
      ['rgb(59, 130, 246)'],
      ['hsl(217, 91%, 60%)'],
      [{r: 59, g: 130, b: 246}],
    ],
    math: [
      [[1, 2, 3], [4, 5, 6]],
      [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]],
      [12, 18],
      ['2 * (3 + 4)^2'],
    ],
    format: [
      ['.2f'],
      ['+,.2%'],
      ['$,.2f'],
    ],
    geo: [
      [[[0, 0], [4, 0], [4, 3], [0, 3]]],
      [[[0, 0], [2, 0], [1, 2]], [1, 1]],
    ],
    crypto: [
      [new Uint8Array([104, 101, 108, 108, 111])],
      ['hello world'],
      ['secret-key', 'message-payload'],
    ],
    encoding: [
      [new Uint8Array([1, 2, 3, 4, 5, 255])],
      [{name: 'alice', scores: [10, 20, 30], active: true}],
      ['Hello, World! 12345'],
    ],
    compression: [
      ['The quick brown fox jumps over the lazy dog. '.repeat(4)],
      [new Uint8Array([65, 66, 67, 65, 66, 67, 65, 66, 67, 68, 69])],
    ],
    diff: [
      [{a: 1, b: [1, 2, 3], c: {x: 'old'}}, {a: 1, b: [1, 4, 3], c: {x: 'new', y: 2}}],
    ],
    cli: [
      [['--port', '8080', '-v', '--tag', 'alpha', '--tag', 'beta', 'serve']],
    ],
    functional: [
      [[3, 1, 4, 1, 5, 9, 2, 6]],
      [[1, 2, 3, 4, 5], 2],
      [[{id: 1, group: 'a', v: 10}, {id: 2, group: 'b', v: 20}, {id: 3, group: 'a', v: 30}]],
      [{a: 1, b: {x: 2}}, {b: {y: 3}, c: 4}],
    ],
    string: [
      ['HelloWorld_foo-bar 123'],
      ['  The Quick Brown Fox  ', 12],
      ['alpha_beta_gamma'],
    ],
    serialize: [
      [{id: 1, tags: ['a', 'b'], when: new Date('2025-11-27T00:00:00Z'), nested: {ok: true}}],
    ],
    schema: [
      [{name: 'alice', age: 30, active: true}],
    ],
    utility: [
      [{a: 1, b: [2, {c: 3}]}, {a: 1, b: [2, {c: 3}]}],
      [{a: 1, b: [2, {c: 3}]}, {a: 1, b: [2, {c: 4}]}],
      [{x: 1, nested: {arr: [1, 2, 3], flag: true}}],
    ],
    i18n: [
      ['You have {count, plural, =0 {no messages} one {# message} other {# messages}}.'],
    ],
  };

  if (domain && domainBanks[domain]) {
    candidates.push(...domainBanks[domain]);
  }

  // Function-name-specific probes
  if (/stringify|serialize|format|encode|compress|dump|pack|render|compile/.test(lower)) {
    candidates.push(
      [{a: 1, b: 'two', list: [1, 2, 3]}],
      ['hello world'],
      [[1, 2, 3, 4]],
    );
  }
  if (/parse|decode|decompress|unpack|lex|token|scan|split|extract/.test(lower)) {
    candidates.push(
      ['{"a":1,"b":[2,3]}'],
      ['key: value\nlist:\n  - one\n  - two\n'],
      ['a=1&b=two&c=3'],
      ['1 + 2 * 3'],
      ['foo/bar/baz.ts'],
    );
  }
  if (/equal|same|match|compare|diff|patch|merge|assign|clone|copy/.test(lower)) {
    candidates.push(
      [{a: 1, b: [2, 3]}, {a: 1, b: [2, 4]}],
      [{a: 1, b: {c: 2}}, {b: {d: 3}, e: 4}],
      ['src/a/b.ts', 'src/**/*.ts'],
    );
  }
  if (/chunk|zip|uniq|group|sort|flatten|partition|slice|take|drop|pick|omit|map|filter|reduce|pipe|sum|mean|clamp|range/.test(lower)) {
    candidates.push(
      [[1, 2, 3, 4, 5, 6], 2],
      [[3, 1, 4, 1, 5, 9]],
      [{a: 1, b: 2, c: 3}, ['a', 'c']],
      [1, 10, 2],
    );
  }
  if (/date|day|month|year|week|hour|minute|second|time|iso|format|add|sub|diff/.test(lower)) {
    candidates.push(
      [new Date('2025-11-27T10:30:00Z')],
      [new Date('2025-11-27T10:30:00Z'), 3],
      [new Date('2025-11-27T10:30:00Z'), new Date('2025-11-20T10:30:00Z')],
    );
  }
  if (/color|rgb|hsl|hex|hsv|lab|cmyk|lch/.test(lower)) {
    candidates.push(['#3b82f6'], ['rgb(12, 34, 56)'], [{r: 12, g: 34, b: 56}]);
  }

  // General fallback probes
  candidates.push(
    ['hello-world_123'],
    ['foo', 'bar'],
    [42],
    [3, 7],
    [[1, 2, 3, 4]],
    [['alpha', 'beta', 'gamma']],
    [{a: 1, b: 'two', nested: {c: true}}],
    [true],
    [],
  );

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const args of candidates) {
    let k;
    try { k = JSON.stringify(encodeReadable(args)); } catch { continue; }
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(args);
    }
  }
  return unique;
}

// ==================== Fast In-Memory Cross-File Probe ====================

export async function probeMultiFileCall(files, entryFile, entry, args, {
  timeoutMs = 300,
  compiledCache = null,
  allowThrow = false,
} = {}) {
  const codeLoadEvents = [];
  const recordedCalls = [];
  let overflow = false;

  let context;
  try {
    context = createProbeVmContext({recordedCalls, onOverflow: () => { overflow = true; }, timeoutMs});
  } catch (err) {
    return {bootstrapError: String(err?.message ?? err)};
  }

  let clonedArgs;
  try { clonedArgs = structuredClone(args); } catch { return null; }

  let res;
  let timer;
  try {
    const execPromise = executeVirtualCodebaseInContext({
      context,
      files,
      entryFile,
      entry,
      initialLoadedFiles: [entryFile],
      args: clonedArgs,
      timeoutMs,
      traceMode: false,
      compiledCache,
      onCodeLoadEvent(req) {
        codeLoadEvents.push(req);
      },
      setTraceActive() {},
    });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe-async-timeout')), timeoutMs);
    });
    res = await Promise.race([execPromise, timeoutPromise]);
  } catch (err) {
    return {bootstrapError: String(err?.message ?? err)};
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (overflow || codeLoadEvents.length === 0) return null;
  if (res.kind === 'throw' && !allowThrow) return null;

  let encodedOutcome;
  try {
    encodedOutcome = encodeReadable({kind: res.kind, arguments: clonedArgs, value: res.value});
  } catch {
    return null;
  }

  if (res.kind === 'return') {
    const inputChanged = JSON.stringify(encodeReadable(args)) !== JSON.stringify(encodedOutcome.arguments);
    const trivialValue = res.value === undefined || res.value === null || res.value === '';
    if (trivialValue && !inputChanged && recordedCalls.length === 0) return null;
  } else {
    // Only admit clean Error throws with meaningful message
    if (!encodedOutcome.value || typeof encodedOutcome.value !== 'object' || !encodedOutcome.value.name) {
      return null;
    }
  }

  const outBytes = Buffer.byteLength(JSON.stringify(encodedOutcome), 'utf8');
  if (outBytes > 10240) return null;

  return {
    kind: res.kind,
    codeLoadEvents,
    recordedCalls,
    encodedOutcome,
    outcomeSignature: sha256(JSON.stringify(encodedOutcome)).slice(0, 20),
  };
}

// ==================== Mode C: Real-World 1-Line AST Mutation Generator ====================

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function getLineText(text, lineNum) {
  const lines = text.split('\n');
  return lines[lineNum - 1] ?? '';
}

const BINARY_OP_FLIPS = {
  '<': '<=',
  '<=': '<',
  '>': '>=',
  '>=': '>',
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
  '+': '-',
  '-': '+',
  '&&': '||',
  '||': '&&',
};

/** Generate candidate syntax-valid 1-line AST mutations in `source` (JS or TS).
 * Prioritizes lines inside `preferredLineRanges` (e.g. symbol-loaded spans). */
export function generateAst1LineMutations(source, relPath, {
  preferredLineRanges = [],
  maxCandidates = 18,
} = {}) {
  const rawCandidates = [];
  const seenEdits = new Set();

  const pushCandidate = (start, end, replacement, kind) => {
    if (start < 0 || end <= start || end > source.length) return;
    const origSlice = source.slice(start, end);
    if (origSlice.includes('\n') || replacement.includes('\n')) return;
    if (origSlice === replacement) return;
    const line = lineNumberAt(source, start);
    const key = `${line}:${start}:${end}:${replacement}`;
    if (seenEdits.has(key)) return;
    seenEdits.add(key);

    const mutated = source.slice(0, start) + replacement + source.slice(end);
    const beforeLine = getLineText(source, line);
    const afterLine = getLineText(mutated, line);
    if (beforeLine === afterLine) return;

    const inPreferred = preferredLineRanges.length === 0 ||
      preferredLineRanges.some(([s, e]) => line >= s && line <= e);

    rawCandidates.push({
      start,
      end,
      replacement,
      kind,
      line,
      beforeLine: beforeLine.trim().slice(0, 160),
      afterLine: afterLine.trim().slice(0, 160),
      mutated,
      priority: (inPreferred ? 0 : 10) +
        (kind.startsWith('binary-cmp') ? 0 : kind.startsWith('arith') ? 1 : kind.startsWith('guard') ? 2 : 3),
    });
  };

  // Use TypeScript compiler AST for both JS and TS — uniform, exact spans, handles all modern syntax!
  let sf;
  try {
    const scriptKind = relPath.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : TS_EXT_RE.test(relPath)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
    sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, scriptKind);
  } catch {
    return [];
  }

  // Avoid mutating loop update increments (which could cause infinite loops) or type nodes
  function isInsideForIncrementor(node) {
    let cur = node.parent;
    while (cur) {
      if (ts.isForStatement(cur) && cur.incrementor && node.pos >= cur.incrementor.pos && node.end <= cur.incrementor.end) {
        return true;
      }
      if (ts.isTypeNode(cur) || ts.isInterfaceDeclaration(cur) || ts.isTypeAliasDeclaration(cur)) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  function isInsideFunctionBody(node) {
    let cur = node.parent;
    while (cur) {
      if (ts.isFunctionLike(cur)) return true;
      cur = cur.parent;
    }
    return false;
  }

  const visit = node => {
    if (rawCandidates.length >= maxCandidates * 4) return;
    if (isInsideFunctionBody(node) && !isInsideForIncrementor(node)) {
      if (ts.isBinaryExpression(node)) {
        const opToken = node.operatorToken;
        const opStart = opToken.getStart(sf);
        const opEnd = opToken.getEnd();
        const opText = source.slice(opStart, opEnd);
        if (Object.hasOwn(BINARY_OP_FLIPS, opText)) {
          // Avoid flipping `+` on string literals (less semantic) or `===` inside loop condition `i !== len` that could loop infinitely
          const inLoopCond = (() => {
            let p = node.parent;
            while (p) {
              if ((ts.isForStatement(p) && p.condition && node.pos >= p.condition.pos && node.end <= p.condition.end) ||
                  (ts.isWhileStatement(p) && node.pos >= p.expression.pos && node.end <= p.expression.end)) {
                return true;
              }
              p = p.parent;
            }
            return false;
          })();
          if (!inLoopCond || ['<', '<=', '>', '>='].includes(opText)) {
            const kind = ['<', '<=', '>', '>='].includes(opText)
              ? 'binary-cmp'
              : ['===', '!==', '==', '!='].includes(opText)
                ? 'binary-eq'
                : ['+', '-'].includes(opText)
                  ? 'arith-op'
                  : 'logic-op';
            pushCandidate(opStart, opEnd, BINARY_OP_FLIPS[opText], kind);
          }
        }
      } else if (ts.isNumericLiteral(node)) {
        const start = node.getStart(sf);
        const end = node.getEnd();
        const txt = source.slice(start, end);
        if (/^\d+$/.test(txt)) {
          const val = Number(txt);
          if (Number.isSafeInteger(val) && val >= 0 && val <= 64) {
            const nextVal = val === 0 ? 1 : val === 1 ? 2 : val - 1;
            pushCandidate(start, end, String(nextVal), 'arith-const');
          }
        }
      } else if (ts.isIfStatement(node)) {
        const exprStart = node.expression.getStart(sf);
        const exprEnd = node.expression.getEnd();
        const exprTxt = source.slice(exprStart, exprEnd);
        if (exprTxt.length >= 2 && exprTxt.length <= 60 && !exprTxt.includes('\n')) {
          pushCandidate(exprStart, exprEnd, `!(${exprTxt})`, 'guard-negate');
        }
      } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
        const start = node.getStart(sf);
        const end = node.getEnd();
        const repl = node.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true';
        pushCandidate(start, end, repl, 'bool-flip');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  rawCandidates.sort((a, b) => (a.priority - b.priority) || (a.line - b.line));

  // Verify syntax/transpile validity before returning
  const valid = [];
  for (const cand of rawCandidates) {
    if (valid.length >= maxCandidates) break;
    try {
      const cjs = transpileSingleModuleToCjs(cand.mutated, relPath);
      acornParse(cjs, {ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true});
      valid.push(cand);
    } catch {}
  }
  return valid;
}

async function findMutationVariant(pkg, entry, probeArgs, baseHit) {
  // Choose unloaded internal files touched during base execution
  const touchedFiles = [];
  const seen = new Set();
  for (const ev of baseHit.codeLoadEvents) {
    if (!ev.path || ev.path === pkg.entryFile || ev.path.endsWith('.json')) continue;
    if (!seen.has(ev.path)) {
      seen.add(ev.path);
      touchedFiles.push(ev.path);
    }
  }
  if (!touchedFiles.length) return null;

  for (const targetFile of touchedFiles.slice(0, 4)) {
    const src = pkg.files[targetFile];
    if (!src) continue;
    // Prefer line ranges of symbol-loaded functions in targetFile
    const preferredLineRanges = [];
    const info = analyzeSourceFile(src, targetFile);
    for (const ev of baseHit.codeLoadEvents) {
      if (ev.path === targetFile && ev.symbol && info.symbols.has(ev.symbol)) {
        const sym = info.symbols.get(ev.symbol);
        preferredLineRanges.push([sym.startLine, sym.endLine]);
      }
    }

    const candidates = generateAst1LineMutations(src, targetFile, {
      preferredLineRanges,
      maxCandidates: 14,
    });
    for (const cand of candidates) {
      const mutatedFiles = {...pkg.files, [targetFile]: cand.mutated};
      const mutHit = await probeMultiFileCall(mutatedFiles, pkg.entryFile, entry, probeArgs, {
        timeoutMs: 250,
        allowThrow: true,
      });
      if (!mutHit || mutHit.bootstrapError) continue;
      if (mutHit.codeLoadEvents.length < 1) continue;
      if (mutHit.outcomeSignature === baseHit.outcomeSignature) continue;
      return {
        mutatedFiles,
        mutHit,
        mutation: {
          file: targetFile,
          line: cand.line,
          kind: cand.kind,
          beforeLine: cand.beforeLine,
          afterLine: cand.afterLine,
          baseOutcomeKind: baseHit.kind,
          mutatedOutcomeKind: mutHit.kind,
        },
      };
    }
  }
  return null;
}

// ==================== 2x Deterministic Verification & Pre-Export ====================

export async function verifyAndExportTask2x(task, {
  traceFormat = 'compact',
  reasoningChannel = 'thinking',
  splitComponent,
  pairId = null,
} = {}) {
  const opts = {traceFormat, reasoningChannel};
  // Run Pass 1 and Pass 2 in parallel across two independent reference worker processes,
  // each also running live createTinkerSession replay via auditTeacherConversation.
  const [run1, run2] = await Promise.all([
    exportTinkerExample(task, opts),
    exportTinkerExample(task, opts),
  ]);

  if (run1.sourceHash !== run2.sourceHash) {
    throw new Error(`Non-deterministic sourceHash on ${task.id}`);
  }
  if (!isDeepStrictEqual(run1.messages, run2.messages)) {
    throw new Error(`Non-deterministic messages across 2x runs on ${task.id}`);
  }
  if (!isDeepStrictEqual(run1.metadata.traceAudit, run2.metadata.traceAudit)) {
    throw new Error(`Non-deterministic traceAudit across 2x runs on ${task.id}`);
  }
  if (!run1.metadata.traceAudit?.replayVerified ||
      !run1.metadata.traceAudit?.canonicalCausalNarration ||
      !run1.metadata.traceAudit?.observationsMatched) {
    throw new Error(`traceAudit verification flags failed on ${task.id}`);
  }
  const codeLoadCalls = run1.metadata?.codeLoadCalls ?? 0;
  if (codeLoadCalls < 1) {
    throw new Error(`codeLoadCalls=${codeLoadCalls} < 1 on ${task.id}`);
  }

  // Validate pre-exported schema invariants (`_is_preexported_row`)
  if (!Array.isArray(run1.messages) || run1.messages.length === 0) {
    throw new Error(`Empty messages on ${task.id}`);
  }
  if (typeof run1.sourceHash !== 'string' || !run1.sourceHash) {
    throw new Error(`Missing sourceHash on ${task.id}`);
  }
  if (!run1.task || typeof run1.task !== 'object') {
    throw new Error(`Missing task object on ${task.id}`);
  }

  // Token & turn bounds
  const assistantMsgs = run1.messages.filter(m => m.role === 'assistant');
  const assistantTurns = assistantMsgs.length;
  if (assistantTurns > MAX_ASSISTANT_TURNS) {
    throw new Error(`assistantTurns ${assistantTurns} > ${MAX_ASSISTANT_TURNS}`);
  }
  const perTurnTokens = assistantMsgs.map(estimateMessageTokens);
  const maxAssistantTurnTokens = Math.max(0, ...perTurnTokens);
  if (maxAssistantTurnTokens > SAFE_MAX_TURN_TOKENS) {
    throw new Error(`maxAssistantTurnTokens ${maxAssistantTurnTokens} > ${SAFE_MAX_TURN_TOKENS}`);
  }
  const episodeChars = JSON.stringify(run1.messages).length;
  const approxTokens = estimateTokens(episodeChars, 3.2);
  if (approxTokens > SAFE_MAX_CONTEXT_TOKENS) {
    throw new Error(`approxTokens ${approxTokens} > ${SAFE_MAX_CONTEXT_TOKENS}`);
  }

  const fileEntries = Object.entries(run1.task.files ?? {});
  const codebaseChars = fileEntries.reduce((s, [, c]) => s + c.length, 0);
  const codebaseApproxTokens = estimateTokens(codebaseChars, 3.5);

  const row = {
    ...run1,
    split: 'train',
    split_component: splitComponent,
    ...(pairId ? {pair_id: pairId} : {}),
    metadata: {
      ...run1.metadata,
      ...(pairId ? {pair_id: pairId} : {}),
      deterministic2xVerified: true,
      codebaseChars,
      codebaseApproxTokens,
      episodeChars,
      approxTokens,
      assistantTurns,
      maxAssistantTurnTokens,
    },
  };
  return row;
}

// ==================== Zero-Leakage & Comprehensive Audit ====================

export function auditHarvestedDataset(rows, {forbidden, stage10, catalogStats = null} = {}) {
  const realExecOverlaps = {
    task_id: [],
    family: [],
    sourceHash: [],
    split_component: [],
    repo: [],
  };
  const stage10Overlaps = {
    task_id: [],
    sourceHash: [],
  };
  const seenIds = new Set();
  const duplicateIds = [];

  const byRepo = {};
  const byLanguage = {js: 0, ts: 0};
  const reposByLanguage = {js: new Set(), ts: new Set()};
  const byMode = {'real-test': 0, 'api-probe': 0, 'oss-mutation-pair': 0};
  const pairGroups = new Map();
  let mutationPairTasks = 0;
  let mutatedVariants = 0;
  let baseVariants = 0;
  let validPreexported = 0;
  let verified2x = 0;
  let withinContextBudget = 0;
  let withinTurnBudget = 0;

  const episodeTokens = [];
  const turnTokens = [];
  const fileCounts = [];
  const codebaseTokens = [];
  const codeLoadCounts = [];
  const loadedUnloadedCounts = [];

  for (const row of rows) {
    const tid = String(row.id ?? '');
    if (seenIds.has(tid)) duplicateIds.push(tid);
    seenIds.add(tid);

    if (forbidden.ids.has(tid)) realExecOverlaps.task_id.push(tid);
    if (forbidden.families.has(String(row.family ?? ''))) realExecOverlaps.family.push(row.family);
    if (forbidden.sourceHashes.has(String(row.sourceHash ?? ''))) realExecOverlaps.sourceHash.push(row.sourceHash);
    if (forbidden.splitComponents.has(String(row.split_component ?? ''))) realExecOverlaps.split_component.push(row.split_component);

    const repo = String(row.metadata?.repo ?? row.task?.metadata?.repo ?? '');
    const repoLower = repo.toLowerCase();
    const repoBase = (repoLower.split('__')[1] ?? repoLower).replace(/\.js$|-js$/, '');
    if (forbidden.repos.has(repoLower) || forbidden.repoNamesNormalized.has(repoLower) ||
        (repoBase.length >= 3 && forbidden.repoNamesNormalized.has(repoBase))) {
      realExecOverlaps.repo.push(repo);
    }

    if (stage10.ids.has(tid)) stage10Overlaps.task_id.push(tid);
    if (stage10.sourceHashes.has(String(row.sourceHash ?? ''))) stage10Overlaps.sourceHash.push(row.sourceHash);

    const isPreexported = Array.isArray(row.messages) && row.messages.length > 0 &&
      typeof row.sourceHash === 'string' && row.sourceHash.length > 0 &&
      row.task && typeof row.task === 'object' &&
      typeof row.split_component === 'string' && row.split_component.length > 0;
    if (isPreexported) validPreexported++;
    if (row.metadata?.deterministic2xVerified && row.metadata?.traceAudit?.replayVerified) verified2x++;

    const lang = row.task?.language === 'ts' ? 'ts' : 'js';
    byLanguage[lang]++;
    if (repo) reposByLanguage[lang].add(repo);

    const mode = row.metadata?.harvestMode ?? 'api-probe';
    if (Object.hasOwn(byMode, mode)) byMode[mode]++;
    if (row.pair_id) {
      mutationPairTasks++;
      if (!pairGroups.has(row.pair_id)) pairGroups.set(row.pair_id, []);
      pairGroups.get(row.pair_id).push(tid);
      if (row.metadata?.mutationVariant === 'mutated') mutatedVariants++;
      else baseVariants++;
    }

    const epTok = row.metadata?.approxTokens ?? estimateTokens(JSON.stringify(row.messages).length, 3.2);
    const maxTurnTok = row.metadata?.maxAssistantTurnTokens ??
      Math.max(0, ...row.messages.filter(m => m.role === 'assistant').map(estimateMessageTokens));
    episodeTokens.push(epTok);
    turnTokens.push(maxTurnTok);
    if (epTok <= MAX_CONTEXT_TOKENS) withinContextBudget++;
    if (maxTurnTok <= MAX_TURN_TOKENS) withinTurnBudget++;

    const fc = row.metadata?.fileCount ?? Object.keys(row.task?.files ?? {}).length;
    fileCounts.push(fc);
    const cbTok = row.metadata?.codebaseApproxTokens ??
      estimateTokens(Object.values(row.task?.files ?? {}).reduce((s, c) => s + c.length, 0), 3.5);
    codebaseTokens.push(cbTok);
    codeLoadCounts.push(row.metadata?.codeLoadCalls ?? 0);
    loadedUnloadedCounts.push(row.metadata?.loadedFileCount ?? 0);

    if (!byRepo[repo]) {
      byRepo[repo] = {
        tasks: 0,
        language: lang,
        domain: row.metadata?.domain ?? 'unknown',
        realTestTasks: 0,
        apiProbeTasks: 0,
        mutationPairTasks: 0,
        fileCountMin: Infinity,
        fileCountMax: 0,
      };
    }
    const rs = byRepo[repo];
    rs.tasks++;
    if (mode === 'real-test') rs.realTestTasks++;
    else if (mode === 'api-probe') rs.apiProbeTasks++;
    if (row.pair_id) rs.mutationPairTasks++;
    rs.fileCountMin = Math.min(rs.fileCountMin, fc);
    rs.fileCountMax = Math.max(rs.fileCountMax, fc);
  }

  const pct = (arr, q) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  };
  const statsOf = arr => arr.length ? {
    min: Math.min(...arr),
    p50: pct(arr, 0.5),
    p90: pct(arr, 0.9),
    max: Math.max(...arr),
    mean: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10,
  } : {min: 0, p50: 0, p90: 0, max: 0, mean: 0};

  const completePairs = [...pairGroups.values()].filter(g => g.length === 2).length;
  const distinctRepos = Object.keys(byRepo).length;
  const tsReposCount = reposByLanguage.ts.size;
  const jsReposCount = reposByLanguage.js.size;

  const zeroLeakagePassed =
    realExecOverlaps.task_id.length === 0 &&
    realExecOverlaps.family.length === 0 &&
    realExecOverlaps.sourceHash.length === 0 &&
    realExecOverlaps.split_component.length === 0 &&
    realExecOverlaps.repo.length === 0;

  const stage10DedupPassed =
    stage10Overlaps.task_id.length === 0 &&
    stage10Overlaps.sourceHash.length === 0;

  return {
    schema: 'oss-multifile-js-scale-audit/2',
    generated_at: new Date().toISOString(),
    totals: {
      tasks: rows.length,
      distinct_repos: distinctRepos,
      ts_repos: tsReposCount,
      js_repos: jsReposCount,
      ts_repo_ratio: distinctRepos ? Math.round((tsReposCount / distinctRepos) * 1000) / 1000 : 0,
      by_language: byLanguage,
      by_harvest_mode: byMode,
      mutation_pairs_complete: completePairs,
      mutation_pair_tasks: mutationPairTasks,
      mutation_base_variants: baseVariants,
      mutation_mutated_variants: mutatedVariants,
      duplicate_ids: duplicateIds.length,
    },
    distributions: {
      episode_approx_tokens: statsOf(episodeTokens),
      max_assistant_turn_tokens: statsOf(turnTokens),
      codebase_approx_tokens: statsOf(codebaseTokens),
      file_count: statsOf(fileCounts),
      code_load_calls: statsOf(codeLoadCounts),
      loaded_unloaded_files: statsOf(loadedUnloadedCounts),
    },
    checks: {
      zero_leakage_realexecbench: {
        passed: zeroLeakagePassed,
        overlap_counts: {
          task_id: realExecOverlaps.task_id.length,
          family: realExecOverlaps.family.length,
          sourceHash: realExecOverlaps.sourceHash.length,
          split_component: realExecOverlaps.split_component.length,
          repo: realExecOverlaps.repo.length,
        },
        overlaps: realExecOverlaps,
      },
      stage10_dedup: {
        passed: stage10DedupPassed,
        overlap_counts: {
          task_id: stage10Overlaps.task_id.length,
          sourceHash: stage10Overlaps.sourceHash.length,
        },
      },
      preexported_schema: {
        passed: validPreexported === rows.length && duplicateIds.length === 0,
        valid_rows: validPreexported,
        total_rows: rows.length,
      },
      determinism_2x: {
        passed: verified2x === rows.length,
        verified_rows: verified2x,
        total_rows: rows.length,
      },
      token_bounds: {
        passed: withinContextBudget === rows.length && withinTurnBudget === rows.length,
        max_context_limit: MAX_CONTEXT_TOKENS,
        max_turn_limit: MAX_TURN_TOKENS,
        within_context_budget: withinContextBudget,
        within_turn_budget: withinTurnBudget,
      },
    },
    ...(catalogStats ? {catalog_stats: catalogStats} : {}),
    by_repo: byRepo,
  };
}

// ==================== Main Repo Harvesting Pipeline ====================

export async function harvestSingleRepo({
  repoEntry,
  repoDir,
  forbidden,
  stage10,
  usedIds,
  usedHashes,
  maxPerRepo = 8,
  maxPerFn = 2,
  minFiles = 5,
  maxFiles = 180,
  maxPairsPerRepo = 2,
  enableMutations = true,
  repoTimeoutMs = 95_000,
  errorLogFn = () => {},
}) {
  const deadline = Date.now() + repoTimeoutMs;
  const rows = [];
  const packages = buildMultiFilePackagesV2(repoDir, {
    subpath: repoEntry.subpath ?? null,
    minFiles,
    maxFiles,
    maxPackages: 6,
  });
  if (!packages.length) {
    errorLogFn({stage: 'package', repo: repoEntry.slug, error: 'no-valid-multifile-packages'});
    return rows;
  }

  const splitComponent = sha256(`oss-multifile-v2:${repoEntry.slug}`);
  if (forbidden.splitComponents.has(splitComponent)) {
    errorLogFn({stage: 'forbidden', repo: repoEntry.slug, error: 'split-component-collision'});
    return rows;
  }

  let repoPairs = 0;
  let seq = 0;

  for (const pkg of packages) {
    if (rows.length >= maxPerRepo || Date.now() > deadline) break;

    const {exports: exportFns, bootstrapError} = discoverCallableExports(pkg.files, pkg.entryFile);
    if (!exportFns.length) {
      if (bootstrapError) {
        errorLogFn({stage: 'bootstrap', repo: repoEntry.slug, entryFile: pkg.entryFile, error: bootstrapError.slice(0, 240)});
      }
      continue;
    }

    // Mode A: real test calls from the repo's own test suite + README
    const realTestMap = collectRealTestArgs(repoDir, repoEntry, exportFns, pkg.entryFile);

    // Rank functions with extracted real test calls FIRST!
    const rankedFns = [...exportFns].sort((a, b) => {
      const aHas = (realTestMap.get(a)?.length ?? 0) > 0 ? 0 : 1;
      const bHas = (realTestMap.get(b)?.length ?? 0) > 0 ? 0 : 1;
      return (aHas - bHas) || a.localeCompare(b);
    });

    const pkgCache = {analysisCache: new Map(), cjsCache: new Map()};
    let pkgFatal = false;

    for (const fnName of rankedFns.slice(0, 32)) {
      if (pkgFatal || rows.length >= maxPerRepo || Date.now() > deadline) break;
      let fnTasks = 0;
      const seenOutcomeSigs = new Set();

      // Build ordered probe list: Mode A (real-test) first, then Mode B (domain api-probe)
      const probeQueue = [];
      const seenArgSigs = new Set();
      for (const tc of (realTestMap.get(fnName) ?? []).slice(0, 12)) {
        if (!seenArgSigs.has(tc.sig)) {
          seenArgSigs.add(tc.sig);
          probeQueue.push({args: tc.args, mode: 'real-test', testFile: tc.file, testSource: tc.source});
        }
      }
      for (const apiArgs of generateDomainProbes(fnName, repoEntry.domain)) {
        let sig;
        try { sig = JSON.stringify(encodeReadable(apiArgs)); } catch { continue; }
        if (!seenArgSigs.has(sig)) {
          seenArgSigs.add(sig);
          probeQueue.push({args: apiArgs, mode: 'api-probe', testFile: null, testSource: null});
        }
      }

      // First pass: prefer calls touching >= 2 unloaded files; second pass allows >= 1 unloaded file
      const acceptedHits = [];
      for (const probe of probeQueue) {
        if (acceptedHits.length >= maxPerFn * 2) break;
        const hit = await probeMultiFileCall(pkg.files, pkg.entryFile, fnName, probe.args, {
          compiledCache: pkgCache,
          timeoutMs: 300,
        });
        if (hit?.bootstrapError) {
          if (/Cannot find virtual module|SyntaxError|ReferenceError/.test(hit.bootstrapError)) {
            pkgFatal = true;
          }
          break;
        }
        if (!hit) continue;
        if (seenOutcomeSigs.has(hit.outcomeSignature)) continue;
        seenOutcomeSigs.add(hit.outcomeSignature);
        const loadedPaths = new Set(hit.codeLoadEvents.map(e => e.path).filter(Boolean));
        acceptedHits.push({probe, hit, loadedPaths});
      }

      // Prioritize hits with >= 2 unloaded files and real-test provenance
      acceptedHits.sort((a, b) => {
        const aMulti = a.loadedPaths.size >= 2 ? 0 : 1;
        const bMulti = b.loadedPaths.size >= 2 ? 0 : 1;
        const aReal = a.probe.mode === 'real-test' ? 0 : 1;
        const bReal = b.probe.mode === 'real-test' ? 0 : 1;
        return (aMulti - bMulti) || (aReal - bReal) || (b.loadedPaths.size - a.loadedPaths.size);
      });

      for (const {probe, hit, loadedPaths} of acceptedHits) {
        if (fnTasks >= maxPerFn || rows.length >= maxPerRepo) break;

        const isTs = TS_EXT_RE.test(pkg.entryFile) || Object.keys(pkg.files).some(p => TS_EXT_RE.test(p));
        const hasSymbolLoad = hit.codeLoadEvents.some(e => Boolean(e.symbol));
        const hasWholeFileLoad = hit.codeLoadEvents.some(e => !e.symbol);
        seq++;

        const baseId = `oss2-${slugify(repoEntry.slug)}-${slugify(fnName)}-${seq}`;
        const family = `oss-multifile-v2/${repoEntry.slug}/${pkg.entryFile}`;

        if (usedIds.has(baseId) || forbidden.ids.has(baseId) || stage10.ids.has(baseId) || forbidden.families.has(family)) {
          continue;
        }

        // Check if we should try Mode C (1-line AST mutation counterfactual pair) on this task
        let pairVariant = null;
        if (enableMutations && repoPairs < maxPairsPerRepo && rows.length + 2 <= maxPerRepo) {
          try {
            pairVariant = await findMutationVariant(pkg, fnName, probe.args, hit);
          } catch {}
        }

        const pairId = pairVariant ? `oss-mut-pair:${repoEntry.slug}:${slugify(fnName)}:${seq}` : null;

        const makeTask = ({id, filesMap, callHit, isMutated, mutationInfo}) => ({
          id,
          family,
          language: isTs ? 'ts' : 'js',
          executionMode: 'native',
          files: filesMap,
          entryFile: pkg.entryFile,
          entry: fnName,
          initialLoadedFiles: [pkg.entryFile],
          args: encodeReadable(probe.args),
          fixture: {calls: callHit.recordedCalls},
          randomSeed: 17,
          timeoutMs: 20000,
          tier: (callHit.codeLoadEvents.length >= 2 || isMutated || callHit.recordedCalls.length > 0) ? 5 : 4,
          features: [
            'multi-file',
            'code-load',
            'native-v8',
            'oss-scale-v2',
            probe.mode,
            ...(isTs ? ['typescript'] : ['javascript']),
            ...(hasSymbolLoad ? ['symbol-load'] : []),
            ...(hasWholeFileLoad ? ['whole-file-load'] : []),
            ...(pkg.distractorCount > 0 ? ['distractor-files'] : []),
            ...(callHit.recordedCalls.length > 0 ? ['effectful'] : []),
            ...(pairId ? ['causal-pair', 'oss-mutation-pair', isMutated ? 'mutated-variant' : 'base-variant'] : []),
          ],
          metadata: {
            repo: repoEntry.slug,
            github: repoEntry.github,
            domain: repoEntry.domain,
            license: repoEntry.license,
            harvestMode: isMutated ? 'oss-mutation-pair' : probe.mode,
            ...(probe.testFile ? {testFile: probe.testFile, testSource: probe.testSource} : {}),
            fileCount: Object.keys(filesMap).length,
            closureSize: pkg.closureSize,
            loadedFileCount: new Set(callHit.codeLoadEvents.map(e => e.path).filter(Boolean)).size,
            totalExecutedFiles: 1 + new Set(callHit.codeLoadEvents.map(e => e.path).filter(Boolean)).size,
            distractorFiles: pkg.distractorCount,
            ...(pairId ? {pair_id: pairId, mutationVariant: isMutated ? 'mutated' : 'base'} : {}),
            ...(mutationInfo ? {mutation: mutationInfo} : {}),
          },
        });

        const baseTask = makeTask({
          id: baseId,
          filesMap: pkg.files,
          callHit: hit,
          isMutated: false,
          mutationInfo: pairVariant ? pairVariant.mutation : null,
        });

        let exportedBase;
        try {
          exportedBase = await verifyAndExportTask2x(baseTask, {
            splitComponent,
            pairId,
          });
        } catch (err) {
          errorLogFn({stage: 'export-base', repo: repoEntry.slug, id: baseId, error: String(err?.message ?? err).slice(0, 240)});
          continue;
        }

        // Reject if sourceHash collides with RealExecBench or Stage 10 (note: multiple
        // distinct args on the same codebase share sourceHash within our harvest, which is
        // valid, so we only block collisions against EXTERNAL forbidden/stage10 hashes!)
        if (forbidden.sourceHashes.has(exportedBase.sourceHash) || stage10.sourceHashes.has(exportedBase.sourceHash)) {
          errorLogFn({stage: 'dedup', repo: repoEntry.slug, id: baseId, error: 'external-sourceHash-collision'});
          continue;
        }

        if (pairVariant && pairId) {
          const mutId = `${baseId}-mut`;
          const mutTask = makeTask({
            id: mutId,
            filesMap: pairVariant.mutatedFiles,
            callHit: pairVariant.mutHit,
            isMutated: true,
            mutationInfo: pairVariant.mutation,
          });
          let exportedMut = null;
          try {
            exportedMut = await verifyAndExportTask2x(mutTask, {
              splitComponent,
              pairId,
            });
            if (forbidden.sourceHashes.has(exportedMut.sourceHash) ||
                stage10.sourceHashes.has(exportedMut.sourceHash) ||
                exportedMut.sourceHash === exportedBase.sourceHash) {
              exportedMut = null;
            }
          } catch (err) {
            errorLogFn({stage: 'export-mut', repo: repoEntry.slug, id: mutId, error: String(err?.message ?? err).slice(0, 240)});
            exportedMut = null;
          }

          if (exportedMut) {
            rows.push(exportedBase, exportedMut);
            usedIds.add(baseId);
            usedIds.add(mutId);
            usedHashes.add(exportedBase.sourceHash);
            usedHashes.add(exportedMut.sourceHash);
            repoPairs++;
            fnTasks++;
            continue;
          } else {
            // Strip pair metadata from base if mutation variant failed 2x export, then emit base alone
            delete exportedBase.pair_id;
            delete exportedBase.metadata.pair_id;
            delete exportedBase.metadata.mutationVariant;
            delete exportedBase.metadata.mutation;
            if (Array.isArray(exportedBase.metadata.features)) {
              exportedBase.metadata.features = exportedBase.metadata.features.filter(
                f => !['causal-pair', 'oss-mutation-pair', 'base-variant'].includes(f),
              );
            }
            if (Array.isArray(exportedBase.task?.features)) {
              exportedBase.task.features = exportedBase.task.features.filter(
                f => !['causal-pair', 'oss-mutation-pair', 'base-variant'].includes(f),
              );
            }
            if (exportedBase.task?.metadata) {
              delete exportedBase.task.metadata.pair_id;
              delete exportedBase.task.metadata.mutationVariant;
              delete exportedBase.task.metadata.mutation;
            }
          }
        }

        rows.push(exportedBase);
        usedIds.add(baseId);
        usedHashes.add(exportedBase.sourceHash);
        fnTasks++;
      }
    }
  }

  return rows;
}

// ==================== CLI Orchestrator (Resumable & Fault-Tolerant) ====================

async function main() {
  const {values} = parseArgs({
    options: {
      'output-dir': {type: 'string', default: DEFAULT_OUTPUT_DIR},
      'cache-dir': {type: 'string', default: DEFAULT_CACHE_DIR},
      'realexec-bm': {type: 'string', default: DEFAULT_REALEXEC_BM},
      'realexec-man': {type: 'string', default: DEFAULT_REALEXEC_MAN},
      'stage10-jsonl': {type: 'string', default: DEFAULT_STAGE10_JSONL},
      'max-repos': {type: 'string', default: '200'},
      'max-tasks': {type: 'string', default: '560'},
      'max-per-repo': {type: 'string', default: '8'},
      'max-per-fn': {type: 'string', default: '2'},
      'max-pairs-per-repo': {type: 'string', default: '2'},
      'min-files': {type: 'string', default: '5'},
      'max-files': {type: 'string', default: '180'},
      'clone-concurrency': {type: 'string', default: '8'},
      'repo-concurrency': {type: 'string', default: '6'},
      'repo-timeout-ms': {type: 'string', default: '95000'},
      'repos': {type: 'string', default: ''},
      'resume': {type: 'boolean', default: true},
      'no-resume': {type: 'boolean', default: false},
      'no-mutations': {type: 'boolean', default: false},
    },
  });

  const outputDir = resolve(values['output-dir']);
  const cacheDir = resolve(values['cache-dir']);
  mkdirSync(outputDir, {recursive: true});
  mkdirSync(cacheDir, {recursive: true});

  const tasksPath = join(outputDir, 'tasks.jsonl');
  const errorsPath = join(outputDir, 'errors.jsonl');
  const progressPath = join(outputDir, 'progress.json');
  const auditPath = join(outputDir, 'audit.json');

  const resume = values['no-resume'] ? false : Boolean(values['resume']);
  const enableMutations = !Boolean(values['no-mutations']);
  const maxRepos = Math.max(1, Number(values['max-repos']) || 120);
  const maxTasks = Math.max(1, Number(values['max-tasks']) || 560);
  const maxPerRepo = Math.max(1, Number(values['max-per-repo']) || 7);
  const maxPerFn = Math.max(1, Number(values['max-per-fn']) || 2);
  const maxPairsPerRepo = Math.max(0, Number(values['max-pairs-per-repo']) || 2);
  const minFiles = Math.max(2, Number(values['min-files']) || 5);
  const maxFiles = Math.max(minFiles, Number(values['max-files']) || 180);
  const cloneConcurrency = Math.max(1, Number(values['clone-concurrency']) || 8);
  const repoConcurrency = Math.max(1, Number(values['repo-concurrency']) || 6);
  const repoTimeoutMs = Math.max(15000, Number(values['repo-timeout-ms']) || 95000);

  const errorLogFn = entry => {
    try {
      appendFileSync(errorsPath, JSON.stringify({ts: new Date().toISOString(), ...entry}) + '\n');
    } catch {}
  };

  // Load forbidden (RealExecBench v1) + dedup (Stage 10) sets
  const {forbidden, stage10} = loadAuditReferenceSets({
    realExecBmPath: values['realexec-bm'],
    realExecManPath: values['realexec-man'],
    stage10Path: values['stage10-jsonl'],
  });

  console.error(`[init] RealExecBench forbidden: ${forbidden.ids.size} ids, ${forbidden.families.size} families, ${forbidden.sourceHashes.size} hashes, ${forbidden.repos.size} repos`);
  console.error(`[init] Stage10 dedup: ${stage10.ids.size} ids, ${stage10.sourceHashes.size} hashes`);

  // Filter catalog
  let catalog = OSS_REPO_CATALOG.filter(entry => !isRepoForbidden(entry, forbidden));
  if (values.repos) {
    const wanted = new Set(values.repos.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    catalog = catalog.filter(e => wanted.has(e.slug.toLowerCase()) || wanted.has(e.github.toLowerCase()));
  }
  catalog = catalog.slice(0, maxRepos);

  // Resume state
  const existingRows = [];
  const usedIds = new Set();
  const usedHashes = new Set();
  const completedRepos = new Set();

  if (resume && existsSync(tasksPath)) {
    for (const line of readFileSync(tasksPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        existingRows.push(r);
        if (r.id) usedIds.add(r.id);
        if (r.sourceHash) usedHashes.add(r.sourceHash);
      } catch {}
    }
    if (existsSync(progressPath)) {
      try {
        const p = JSON.parse(readFileSync(progressPath, 'utf8'));
        for (const s of p.completedRepos ?? []) completedRepos.add(s);
      } catch {}
    }
    console.error(`[resume] Loaded ${existingRows.length} existing tasks across ${completedRepos.size} completed repos`);
  } else {
    writeFileSync(tasksPath, '');
    writeFileSync(errorsPath, '');
    writeFileSync(progressPath, JSON.stringify({completedRepos: []}, null, 2) + '\n');
  }

  const remainingCatalog = catalog.filter(e => !completedRepos.has(e.slug));
  console.error(`[clone] Preparing ${remainingCatalog.length} repos (concurrency=${cloneConcurrency}, cache=${cacheDir})...`);
  const cloneResults = await cloneBatchWithConcurrency(remainingCatalog, cacheDir, cloneConcurrency, errorLogFn);

  const clonedOk = [...cloneResults.values()].filter(r => r.ok).length;
  console.error(`[clone] Ready: ${clonedOk}/${remainingCatalog.length} repos cloned/cached`);

  const allRows = [...existingRows];
  let reposAttempted = completedRepos.size;
  let cursor = 0;

  const harvestWorker = async () => {
    while (cursor < remainingCatalog.length) {
      if (allRows.length >= maxTasks) break;
      const idx = cursor++;
      const repoEntry = remainingCatalog[idx];
      const cRes = cloneResults.get(repoEntry.slug);
      if (!cRes?.ok) {
        completedRepos.add(repoEntry.slug);
        writeFileSync(progressPath, JSON.stringify({completedRepos: [...completedRepos]}, null, 2) + '\n');
        continue;
      }

      const budgetLeft = maxTasks - allRows.length;
      if (budgetLeft <= 0) break;
      const repoCap = Math.min(maxPerRepo, budgetLeft);
      let repoRows = [];
      try {
        repoRows = await harvestSingleRepo({
          repoEntry,
          repoDir: cRes.dir,
          forbidden,
          stage10,
          usedIds,
          usedHashes,
          maxPerRepo: repoCap,
          maxPerFn,
          minFiles,
          maxFiles,
          maxPairsPerRepo,
          enableMutations,
          repoTimeoutMs,
          errorLogFn,
        });
      } catch (err) {
        errorLogFn({stage: 'repo-crash', repo: repoEntry.slug, error: String(err?.message ?? err).slice(0, 300)});
        repoRows = [];
      }

      // Trim cleanly if concurrent workers pushed us over maxTasks (never split a pair!)
      const remaining = maxTasks - allRows.length;
      if (remaining <= 0) {
        repoRows = [];
      } else if (repoRows.length > remaining) {
        const kept = [];
        for (let i = 0; i < repoRows.length; i++) {
          const r = repoRows[i];
          if (r.pair_id && repoRows[i + 1]?.pair_id === r.pair_id) {
            if (kept.length + 2 <= remaining) kept.push(r, repoRows[i + 1]);
            i++;
          } else if (kept.length + 1 <= remaining) {
            kept.push(r);
          }
        }
        repoRows = kept;
      }

      if (repoRows.length > 0) {
        appendFileSync(tasksPath, repoRows.map(r => JSON.stringify(r)).join('\n') + '\n');
        allRows.push(...repoRows);
      }
      reposAttempted++;
      completedRepos.add(repoEntry.slug);
      writeFileSync(progressPath, JSON.stringify({completedRepos: [...completedRepos]}, null, 2) + '\n');

      const pairCount = repoRows.filter(r => r.pair_id).length / 2;
      const realCount = repoRows.filter(r => r.metadata?.harvestMode === 'real-test').length;
      console.error(
        `[${reposAttempted}/${catalog.length}] ${repoEntry.slug} (${repoEntry.lang}/${repoEntry.domain}): ` +
        `+${repoRows.length} tasks (real-test=${realCount}, mut-pairs=${pairCount}) | total=${allRows.length}`,
      );
    }
  };

  console.error(`[harvest] Starting ${repoConcurrency} concurrent repo workers (maxPerRepo=${maxPerRepo}, maxTasks=${maxTasks})...`);
  await Promise.all(Array.from({length: Math.min(repoConcurrency, Math.max(1, remainingCatalog.length))}, () => harvestWorker()));

  // Final post-hoc zero-leakage & integrity audit over the written tasks.jsonl
  const finalRows = readFileSync(tasksPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));

  const audit = auditHarvestedDataset(finalRows, {
    forbidden,
    stage10,
    catalogStats: {
      catalog_total: OSS_REPO_CATALOG.length,
      catalog_selected: catalog.length,
      repos_completed: completedRepos.size,
      cloned_ok_this_run: clonedOk,
    },
  });
  writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');

  console.log(JSON.stringify({
    tasksPath,
    auditPath,
    totals: audit.totals,
    distributions: audit.distributions,
    checks: {
      zero_leakage_realexecbench: audit.checks.zero_leakage_realexecbench.passed,
      stage10_dedup: audit.checks.stage10_dedup.passed,
      preexported_schema: audit.checks.preexported_schema.passed,
      determinism_2x: audit.checks.determinism_2x.passed,
      token_bounds: audit.checks.token_bounds.passed,
    },
  }, null, 2));

  if (!audit.checks.zero_leakage_realexecbench.passed ||
      !audit.checks.stage10_dedup.passed ||
      !audit.checks.preexported_schema.passed ||
      !audit.checks.determinism_2x.passed ||
      !audit.checks.token_bounds.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
