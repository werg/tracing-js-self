#!/usr/bin/env node
/**
 * Real-World OSS Wave 3 Harvester (JS & TypeScript — Pure Multi-File + Stateful-I/O + Browser-DOM).
 *
 * Strictly zero-overlap with RealExecBench v1 (5 axes: id, family, sourceHash,
 * split_component, repo) AND strictly zero-overlap with Stage 10 OSS merged
 * corpus (id, sourceHash, repo).
 *
 * Engines:
 *   1. Stateful-I/O & Browser-DOM Real OSS Engine (35+ brand-new GitHub JS/TS repos):
 *      - Real OSS libraries executed with genuine external I/O (fs, env, http.request,
 *        shell.exec, console, Date.now, crypto.randomUUID) and Browser-DOM
 *        (localStorage/sessionStorage, confirm/prompt, fetch, DOM tree, history)
 *      - World-state causal counterfactual pairs verified with auditCausalPrefixPair
 *   2. Pure Multi-File Real OSS Engine (140+ brand-new GitHub JS/TS repos, >=60% TS):
 *      - Mode A (real-test): Real unit-test & README call-site extraction
 *      - Mode B (api-probe): Domain-aware cross-file public API probes
 *      - Mode C (oss-mutation-pair): Real-world 1-line AST mutation counterfactual pairs
 *
 * Every admitted task is verified 2x independently via exportTinkerExample AND
 * explicit live createTinkerSession step-by-step replay, enforcing 100% identical
 * sourceHash & messages, _is_preexported_row compatibility, and token budgets
 * (<= 64,500 episode tokens, <= 19,500 max turn tokens).
 */

import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  appendFileSync,
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
import {tmpdir} from 'node:os';
import {basename, dirname, join, posix as pathPosix, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, parseArgs} from 'node:util';
import vm from 'node:vm';
import {parse as acornParse} from 'acorn';
import ts from 'typescript';

import {
  createTinkerSession,
  encodeReadable,
  exportTinkerExample,
  prepareTinkerTask,
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
  createLiveNodeIoRecorder,
  createReplayNodeIoBridge,
  VM_NODE_IO_RUNTIME_SCRIPT,
} from '../src/training/tinker-node-io.js';
import {
  createLiveFetchRecorder,
  normalizeFetchRequest,
  VM_FETCH_RUNTIME_SCRIPT,
} from '../src/training/tinker-http-fetch.js';
import {
  DEFAULT_BROWSER_HTML,
  DEFAULT_BROWSER_URL,
  VM_BROWSER_DOM_RUNTIME_SCRIPT,
} from '../src/training/tinker-browser-dom.js';
import {extractTestCallsFromFiles} from './tinker-harvest.mjs';

process.on('unhandledRejection', () => {});

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_REALEXEC_BM = '/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl';
const DEFAULT_REALEXEC_MAN = '/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json';
const DEFAULT_STAGE10_JSONL = '/home/werg/tracing-js-self/runs/messy-v8-stage10/stage10-oss-merged.jsonl';
const DEFAULT_CACHE_DIR = '/tmp/oss-js-wave3-cache';
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, 'runs/oss-js-wave3');

export const MAX_CONTEXT_TOKENS = 64500;
export const SAFE_MAX_CONTEXT_TOKENS = 58000;
export const MAX_TURN_TOKENS = 19500;
export const SAFE_MAX_TURN_TOKENS = 16500;
export const MAX_ASSISTANT_TURNS = 64;
export const TARGET_MIN_CODEBASE_BYTES = 35 * 1024; // ~10K tokens
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
  'third_party', '.next', '.nuxt', '.cache', 'tmp', 'temp', 'cjs', 'umd',
  'playground', 'stories', 'e2e', 'integration', 'locales',
]);

const TEST_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'examples', 'example',
]);

const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/i;
const TS_EXT_RE = /\.(?:ts|tsx|mts|cts)$/i;
const SKIP_FILE_RE = /(?:\.d\.ts$|\.d\.mts$|\.d\.cts$|\.test\.|\.spec\.|\.min\.|\.bundle\.|\.config\.|rollup|webpack|vite\.|jest\.|vitest\.|babel\.|eslint|prettier|gulpfile|gruntfile|\.bench\.|\.stories\.|tsup\.|tsdown\.)/i;

const NODE_BUILTINS = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'path', 'node:path', 'url', 'node:url',
  'crypto', 'node:crypto', 'child_process', 'node:child_process',
  'buffer', 'node:buffer', 'process', 'node:process',
]);

// ==================== Brand-New Curated Wave 3 OSS Catalog (175+ Repos, >=64% TS) ====================
// Every repo vetted for zero overlap with RealExecBench v1 AND Stage 10 OSS merged.
export const WAVE3_PURE_CATALOG = [
  // --- TypeScript Schema / Validators / Decoders / Functional ---
  {slug: 'colinhacks__zod', github: 'colinhacks/zod', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'pelotom__runtypes', github: 'pelotom/runtypes', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'nvie__decoders', github: 'nvie/decoders', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'badrap__valita', github: 'badrap/valita', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'gcanti__io-ts', github: 'gcanti/io-ts', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'sindresorhus__is', github: 'sindresorhus/is', domain: 'validator', lang: 'ts', license: 'MIT'},
  {slug: 'sindresorhus__ow', github: 'sindresorhus/ow', domain: 'validator', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__untyped', github: 'unjs/untyped', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'arktypeio__arktype', github: 'arktypeio/arktype', domain: 'schema', lang: 'ts', license: 'MIT', subpath: 'ark/type'},
  {slug: 'vinejs__vine', github: 'vinejs/vine', domain: 'validator', lang: 'ts', license: 'MIT'},
  {slug: 'sapphiredev__shapeshift', github: 'sapphiredev/shapeshift', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'gcanti__monocle-ts', github: 'gcanti/monocle-ts', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'gcanti__newtype-ts', github: 'gcanti/newtype-ts', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'supermacro__neverthrow', github: 'supermacro/neverthrow', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'supercharge__strings', github: 'supercharge/strings', domain: 'string', lang: 'ts', license: 'MIT'},
  {slug: 'supercharge__collections', github: 'supercharge/collections', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'decs__typeschema', github: 'decs/typeschema', domain: 'schema', lang: 'ts', license: 'MIT'},
  {slug: 'sideway__joi', github: 'sideway/joi', domain: 'schema', lang: 'js', license: 'BSD-3-Clause'},

  // --- TypeScript State Managers / Reactive / Routers / UI Core / Table ---
  {slug: 'pmndrs__zustand', github: 'pmndrs/zustand', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'pmndrs__valtio', github: 'pmndrs/valtio', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'statelyai__xstate', github: 'statelyai/xstate', domain: 'state-machine', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'preactjs__signals', github: 'preactjs/signals', domain: 'reactive', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'mobxjs__mobx', github: 'mobxjs/mobx', domain: 'reactive', lang: 'ts', license: 'MIT', subpath: 'packages/mobx'},
  {slug: 'artalar__reatom', github: 'artalar/reatom', domain: 'state', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'vuejs__petite-vue', github: 'vuejs/petite-vue', domain: 'reactive', lang: 'ts', license: 'MIT'},
  {slug: 'maverick-js__signals', github: 'maverick-js/signals', domain: 'reactive', lang: 'ts', license: 'MIT'},
  {slug: 'stackblitz__alien-signals', github: 'stackblitz/alien-signals', domain: 'reactive', lang: 'ts', license: 'MIT'},
  {slug: 'tnfe__limu', github: 'tnfe/limu', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'TanStack__table', github: 'TanStack/table', domain: 'table', lang: 'ts', license: 'MIT', subpath: 'packages/table-core'},
  {slug: 'TanStack__virtual', github: 'TanStack/virtual', domain: 'table', lang: 'ts', license: 'MIT', subpath: 'packages/virtual-core'},
  {slug: 'TanStack__form', github: 'TanStack/form', domain: 'state', lang: 'ts', license: 'MIT', subpath: 'packages/form-core'},
  {slug: 'floating-ui__floating-ui', github: 'floating-ui/floating-ui', domain: 'geo', lang: 'ts', license: 'MIT', subpath: 'packages/core'},
  {slug: 'react-hook-form__react-hook-form', github: 'react-hook-form/react-hook-form', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'remix-run__history', github: 'remix-run/history', domain: 'router', lang: 'ts', license: 'MIT', subpath: 'packages/history'},
  {slug: 'molefrog__wouter', github: 'molefrog/wouter', domain: 'router', lang: 'ts', license: 'ISC'},
  {slug: 'pillarjs__path-to-regexp', github: 'pillarjs/path-to-regexp', domain: 'router', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__h3', github: 'unjs/h3', domain: 'router', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__unhead', github: 'unjs/unhead', domain: 'vdom', lang: 'ts', license: 'MIT', subpath: 'packages/unhead'},
  {slug: 'nanojsx__nano', github: 'nanojsx/nano', domain: 'vdom', lang: 'ts', license: 'MIT'},
  {slug: 'developit__mitt', github: 'developit/mitt', domain: 'events', lang: 'ts', license: 'MIT'},
  {slug: 'formkit__tempo', github: 'formkit/tempo', domain: 'date', lang: 'ts', license: 'MIT'},
  {slug: 'natemoo-re__ultrahtml', github: 'natemoo-re/ultrahtml', domain: 'html', lang: 'ts', license: 'MIT'},
  {slug: 'redom__redom', github: 'redom/redom', domain: 'vdom', lang: 'js', license: 'MIT', subpath: 'esm'},
  {slug: 'patrick-steele-idem__morphdom', github: 'patrick-steele-idem/morphdom', domain: 'vdom', lang: 'js', license: 'MIT'},
  {slug: 'delvedor__find-my-way', github: 'delvedor/find-my-way', domain: 'router', lang: 'js', license: 'MIT'},
  {slug: 'developit__unistore', github: 'developit/unistore', domain: 'state', lang: 'js', license: 'MIT'},

  // --- Parsers / Compilers / AST / HTML / XML / CSS / SQL / Markdown / Template / Expr ---
  {slug: 'fb55__htmlparser2', github: 'fb55/htmlparser2', domain: 'html', lang: 'ts', license: 'MIT'},
  {slug: 'fb55__domhandler', github: 'fb55/domhandler', domain: 'html', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'fb55__domutils', github: 'fb55/domutils', domain: 'html', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'fb55__css-select', github: 'fb55/css-select', domain: 'css', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'fb55__nth-check', github: 'fb55/nth-check', domain: 'css', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'taoqf__node-html-parser', github: 'taoqf/node-html-parser', domain: 'html', lang: 'ts', license: 'MIT'},
  {slug: 'inikulin__parse5', github: 'inikulin/parse5', domain: 'html', lang: 'ts', license: 'MIT', subpath: 'packages/parse5'},
  {slug: 'oozcitak__xmlbuilder2', github: 'oozcitak/xmlbuilder2', domain: 'xml', lang: 'ts', license: 'MIT'},
  {slug: 'dcastil__tailwind-merge', github: 'dcastil/tailwind-merge', domain: 'css', lang: 'ts', license: 'MIT', subpath: 'packages/tailwind-merge'},
  {slug: 'Rich-Harris__magic-string', github: 'Rich-Harris/magic-string', domain: 'string-ast', lang: 'ts', license: 'MIT'},
  {slug: 'Rich-Harris__estree-walker', github: 'Rich-Harris/estree-walker', domain: 'ast', lang: 'ts', license: 'MIT'},
  {slug: 'Rich-Harris__locate-character', github: 'Rich-Harris/locate-character', domain: 'string-ast', lang: 'ts', license: 'MIT'},
  {slug: 'jridgewell__gen-mapping', github: 'jridgewell/gen-mapping', domain: 'sourcemap', lang: 'ts', license: 'MIT'},
  {slug: 'jridgewell__trace-mapping', github: 'jridgewell/trace-mapping', domain: 'sourcemap', lang: 'ts', license: 'MIT'},
  {slug: 'jridgewell__sourcemap-codec', github: 'jridgewell/sourcemap-codec', domain: 'sourcemap', lang: 'ts', license: 'MIT'},
  {slug: 'jridgewell__resolve-uri', github: 'jridgewell/resolve-uri', domain: 'url', lang: 'ts', license: 'MIT'},
  {slug: 'eta-dev__eta', github: 'eta-dev/eta', domain: 'template', lang: 'ts', license: 'MIT'},
  {slug: 'squirrellyjs__squirrelly', github: 'squirrellyjs/squirrelly', domain: 'template', lang: 'ts', license: 'MIT'},
  {slug: 'm93a__filtrex', github: 'm93a/filtrex', domain: 'expr', lang: 'ts', license: 'MIT'},
  {slug: 'C2FO__fast-csv', github: 'C2FO/fast-csv', domain: 'csv', lang: 'ts', license: 'MIT', subpath: 'packages/parse'},
  {slug: 'kysely-org__kysely', github: 'kysely-org/kysely', domain: 'sql', lang: 'ts', license: 'MIT'},
  {slug: 'oguimbal__pgsql-ast-parser', github: 'oguimbal/pgsql-ast-parser', domain: 'sql', lang: 'ts', license: 'Apache-2.0'},
  {slug: 'chevrotain__chevrotain', github: 'chevrotain/chevrotain', domain: 'parser', lang: 'ts', license: 'Apache-2.0', subpath: 'packages/chevrotain'},
  {slug: 'jquery__esprima', github: 'jquery/esprima', domain: 'js-parser', lang: 'ts', license: 'BSD-2-Clause'},
  {slug: 'unjs__mlly', github: 'unjs/mlly', domain: 'js-parser', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__magic-regexp', github: 'unjs/magic-regexp', domain: 'glob', lang: 'ts', license: 'MIT'},
  {slug: 'NaturalIntelligence__fast-xml-parser', github: 'NaturalIntelligence/fast-xml-parser', domain: 'xml', lang: 'js', license: 'MIT'},
  {slug: 'nashwaan__xml-js', github: 'nashwaan/xml-js', domain: 'xml', lang: 'js', license: 'MIT'},
  {slug: 'TobiasNickel__tXml', github: 'TobiasNickel/tXml', domain: 'xml', lang: 'js', license: 'MIT'},
  {slug: 'csstree__csstree', github: 'csstree/csstree', domain: 'css', lang: 'js', license: 'MIT'},
  {slug: 'markdown-it__markdown-it', github: 'markdown-it/markdown-it', domain: 'markdown', lang: 'js', license: 'MIT'},
  {slug: 'markdown-it__mdurl', github: 'markdown-it/mdurl', domain: 'url', lang: 'js', license: 'MIT'},
  {slug: 'markdown-it__linkify-it', github: 'markdown-it/linkify-it', domain: 'url', lang: 'js', license: 'MIT'},
  {slug: 'showdownjs__showdown', github: 'showdownjs/showdown', domain: 'markdown', lang: 'js', license: 'MIT'},
  {slug: 'mixmark-io__turndown', github: 'mixmark-io/turndown', domain: 'markdown', lang: 'js', license: 'MIT'},
  {slug: 'mde__ejs', github: 'mde/ejs', domain: 'template', lang: 'js', license: 'Apache-2.0'},
  {slug: 'EricSmekens__jsep', github: 'EricSmekens/jsep', domain: 'expr', lang: 'js', license: 'MIT'},
  {slug: 'silentmatt__expr-eval', github: 'silentmatt/expr-eval', domain: 'expr', lang: 'js', license: 'MIT'},
  {slug: 'TomFrost__Jexl', github: 'TomFrost/Jexl', domain: 'expr', lang: 'js', license: 'MIT'},
  {slug: 'jmespath__jmespath-js', github: 'jmespath/jmespath.js', domain: 'expr', lang: 'js', license: 'Apache-2.0'},
  {slug: 'hjson__hjson-js', github: 'hjson/hjson-js', domain: 'json5', lang: 'js', license: 'MIT'},
  {slug: 'iarna__iarna-toml', github: 'iarna/iarna-toml', domain: 'toml', lang: 'js', license: 'ISC'},
  {slug: 'vanillaes__csv', github: 'vanillaes/csv', domain: 'csv', lang: 'js', license: 'MIT'},
  {slug: 'hiddentao__squel', github: 'hiddentao/squel', domain: 'sql', lang: 'js', license: 'MIT'},
  {slug: 'peggyjs__peggy', github: 'peggyjs/peggy', domain: 'parser', lang: 'js', license: 'MIT'},
  {slug: 'jneen__parsimmon', github: 'jneen/parsimmon', domain: 'parser', lang: 'js', license: 'MIT'},
  {slug: 'terser__terser', github: 'terser/terser', domain: 'js-parser', lang: 'js', license: 'BSD-2-Clause'},
  {slug: 'mishoo__UglifyJS', github: 'mishoo/UglifyJS', domain: 'js-parser', lang: 'js', license: 'BSD-2-Clause'},
  {slug: 'estools__escodegen', github: 'estools/escodegen', domain: 'ast', lang: 'js', license: 'BSD-2-Clause'},
  {slug: 'estools__estraverse', github: 'estools/estraverse', domain: 'ast', lang: 'js', license: 'BSD-2-Clause'},
  {slug: 'fontello__svgpath', github: 'fontello/svgpath', domain: 'svg', lang: 'js', license: 'MIT'},

  // --- Cron / Glob / URL / HTTP / MIME / Cookie / JWT / Network ---
  {slug: 'harrisiirak__cron-parser', github: 'harrisiirak/cron-parser', domain: 'cron', lang: 'ts', license: 'MIT'},
  {slug: 'bradymholt__cRonstrue', github: 'bradymholt/cRonstrue', domain: 'cron', lang: 'ts', license: 'MIT'},
  {slug: 'isaacs__minimatch', github: 'isaacs/minimatch', domain: 'glob', lang: 'ts', license: 'ISC'},
  {slug: 'jshttp__cookie', github: 'jshttp/cookie', domain: 'http', lang: 'ts', license: 'MIT'},
  {slug: 'broofa__mime', github: 'broofa/mime', domain: 'mime', lang: 'ts', license: 'MIT'},
  {slug: 'salesforce__tough-cookie', github: 'salesforce/tough-cookie', domain: 'http', lang: 'ts', license: 'BSD-3-Clause'},
  {slug: 'auth0__jwt-decode', github: 'auth0/jwt-decode', domain: 'jwt', lang: 'ts', license: 'MIT'},
  {slug: 'beaugunderson__ip-address', github: 'beaugunderson/ip-address', domain: 'network', lang: 'ts', license: 'MIT'},
  {slug: 'jonschlinkert__braces', github: 'jonschlinkert/braces', domain: 'glob', lang: 'js', license: 'MIT'},
  {slug: 'ljharb__qs', github: 'ljharb/qs', domain: 'query', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'medialize__URI-js', github: 'medialize/URI.js', domain: 'url', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__negotiator', github: 'jshttp/negotiator', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'faisalman__ua-parser-js', github: 'faisalman/ua-parser-js', domain: 'ua', lang: 'js', license: 'MIT'},
  {slug: 'lancedikson__bowser', github: 'lancedikson/bowser', domain: 'ua', lang: 'js', license: 'MIT'},
  {slug: 'fastify__fast-uri', github: 'fastify/fast-uri', domain: 'url', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'whitequark__ipaddr-js', github: 'whitequark/ipaddr.js', domain: 'network', lang: 'js', license: 'MIT'},

  // --- Diff / Color / Geo / Math / Graph / Data Structures / Search ---
  {slug: 'AsyncBanana__microdiff', github: 'AsyncBanana/microdiff', domain: 'diff', lang: 'ts', license: 'MIT'},
  {slug: 'Starcounter-Jack__JSON-Patch', github: 'Starcounter-Jack/JSON-Patch', domain: 'diff', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__matrix', github: 'mljs/matrix', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'js-sdsl__js-sdsl', github: 'js-sdsl/js-sdsl', domain: 'datastructures', lang: 'ts', license: 'MIT'},
  {slug: 'lucaong__minisearch', github: 'lucaong/minisearch', domain: 'search', lang: 'ts', license: 'MIT'},
  {slug: 'oramasearch__orama', github: 'oramasearch/orama', domain: 'search', lang: 'ts', license: 'Apache-2.0', subpath: 'packages/orama'},
  {slug: 'Qix-__color-convert', github: 'Qix-/color-convert', domain: 'color', lang: 'js', license: 'MIT'},
  {slug: 'mapbox__earcut', github: 'mapbox/earcut', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'mapbox__delaunator', github: 'mapbox/delaunator', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'mfogel__polygon-clipping', github: 'mfogel/polygon-clipping', domain: 'geo', lang: 'js', license: 'MIT'},
  {slug: 'davidfig__intersects', github: 'davidfig/intersects', domain: 'geo', lang: 'js', license: 'MIT'},
  {slug: 'josdejong__mathjs', github: 'josdejong/mathjs', domain: 'math', lang: 'js', license: 'Apache-2.0'},
  {slug: 'indutny__bn-js', github: 'indutny/bn.js', domain: 'math', lang: 'js', license: 'MIT'},
  {slug: 'jstat__jstat', github: 'jstat/jstat', domain: 'math', lang: 'js', license: 'MIT'},
  {slug: 'd3__d3-quadtree', github: 'd3/d3-quadtree', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-path', github: 'd3/d3-path', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-scale', github: 'd3/d3-scale', domain: 'math', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-shape', github: 'd3/d3-shape', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-random', github: 'd3/d3-random', domain: 'math', lang: 'js', license: 'ISC'},
  {slug: 'graphology__graphology', github: 'graphology/graphology', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'dagrejs__graphlib', github: 'dagrejs/graphlib', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'qiao__PathFinding-js', github: 'qiao/PathFinding.js', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__binary-search-tree', github: 'datastructures-js/binary-search-tree', domain: 'datastructures', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__graph', github: 'datastructures-js/graph', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__trie', github: 'datastructures-js/trie', domain: 'datastructures', lang: 'js', license: 'MIT'},
  {slug: 'datastructures-js__priority-queue', github: 'datastructures-js/priority-queue', domain: 'datastructures', lang: 'js', license: 'MIT'},
  {slug: 'trekhleb__javascript-algorithms', github: 'trekhleb/javascript-algorithms', domain: 'algorithms', lang: 'js', license: 'MIT'},
  {slug: 'olivernn__lunr-js', github: 'olivernn/lunr.js', domain: 'search', lang: 'js', license: 'MIT'},

  // --- Queue / Cache / Rate-Limit / Circuit-Breaker / Retry / CLI / Logger / Date / Crypto / Encoding / Compression / Config ---
  {slug: 'sindresorhus__p-queue', github: 'sindresorhus/p-queue', domain: 'queue', lang: 'ts', license: 'MIT'},
  {slug: 'sindresorhus__p-memoize', github: 'sindresorhus/p-memoize', domain: 'cache', lang: 'ts', license: 'MIT'},
  {slug: 'sindresorhus__mem', github: 'sindresorhus/mem', domain: 'cache', lang: 'ts', license: 'MIT'},
  {slug: 'connor4312__cockatiel', github: 'connor4312/cockatiel', domain: 'circuit-breaker', lang: 'ts', license: 'MIT'},
  {slug: 'jhurliman__node-rate-limiter', github: 'jhurliman/node-rate-limiter', domain: 'rate-limit', lang: 'ts', license: 'MIT'},
  {slug: 'isaacs__yallist', github: 'isaacs/yallist', domain: 'datastructures', lang: 'ts', license: 'ISC'},
  {slug: 'jaredwray__keyv', github: 'jaredwray/keyv', domain: 'cache', lang: 'ts', license: 'MIT', subpath: 'packages/keyv'},
  {slug: 'unjs__unctx', github: 'unjs/unctx', domain: 'async', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__unstorage', github: 'unjs/unstorage', domain: 'cache', lang: 'ts', license: 'MIT'},
  {slug: 'vercel__arg', github: 'vercel/arg', domain: 'cli', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__citty', github: 'unjs/citty', domain: 'cli', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__consola', github: 'unjs/consola', domain: 'logger', lang: 'ts', license: 'MIT'},
  {slug: 'fullstack-build__tslog', github: 'fullstack-build/tslog', domain: 'logger', lang: 'ts', license: 'BSD-3-Clause'},
  {slug: 'gajus__table', github: 'gajus/table', domain: 'table', lang: 'ts', license: 'BSD-3-Clause'},
  {slug: 'wanasit__chrono', github: 'wanasit/chrono', domain: 'date', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__noble-hashes', github: 'paulmillr/noble-hashes', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__noble-ciphers', github: 'paulmillr/noble-ciphers', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__noble-curves', github: 'paulmillr/noble-curves', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__scure-base', github: 'paulmillr/scure-base', domain: 'encoding', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__scure-bip39', github: 'paulmillr/scure-bip39', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'Touffy__client-zip', github: 'Touffy/client-zip', domain: 'compression', lang: 'ts', license: 'MIT'},
  {slug: 'niieani__hashids-js', github: 'niieani/hashids.js', domain: 'encoding', lang: 'ts', license: 'MIT'},
  {slug: 'sqids__sqids-javascript', github: 'sqids/sqids-javascript', domain: 'encoding', lang: 'ts', license: 'MIT'},
  {slug: 'woltapp__blurhash', github: 'woltapp/blurhash', domain: 'encoding', lang: 'ts', license: 'MIT', subpath: 'TypeScript'},
  {slug: 'unjs__uqr', github: 'unjs/uqr', domain: 'encoding', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__destr', github: 'unjs/destr', domain: 'serialize', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__std-env', github: 'unjs/std-env', domain: 'env', lang: 'ts', license: 'MIT'},
  {slug: 'unjs__exsolve', github: 'unjs/exsolve', domain: 'path', lang: 'ts', license: 'MIT'},
  {slug: 'af__envalid', github: 'af/envalid', domain: 'env', lang: 'ts', license: 'MIT'},
  {slug: 'nodeca__pako', github: 'nodeca/pako', domain: 'compression', lang: 'ts', license: 'MIT'},
  {slug: 'brix__crypto-js', github: 'brix/crypto-js', domain: 'crypto', lang: 'js', license: 'MIT'},
  {slug: 'indutny__hash-js', github: 'indutny/hash.js', domain: 'crypto', lang: 'js', license: 'MIT'},
  {slug: 'foliojs__restructure', github: 'foliojs/restructure', domain: 'encoding', lang: 'js', license: 'MIT'},
  {slug: 'spencermountain__spacetime', github: 'spencermountain/spacetime', domain: 'date', lang: 'js', license: 'MIT'},
  {slug: 'js-joda__js-joda', github: 'js-joda/js-joda', domain: 'date', lang: 'js', license: 'BSD-3-Clause', subpath: 'packages/core'},
  {slug: 'panzerdp__voca', github: 'panzerdp/voca', domain: 'string', lang: 'js', license: 'MIT'},
  {slug: 'epeli__underscore-string', github: 'epeli/underscore.string', domain: 'string', lang: 'js', license: 'MIT'},
  {slug: 'ecrmnn__collect-js', github: 'ecrmnn/collect.js', domain: 'functional', lang: 'js', license: 'MIT'},
  {slug: 'jashkenas__underscore', github: 'jashkenas/underscore', domain: 'functional', lang: 'js', license: 'MIT'},
  {slug: 'scurker__currency-js', github: 'scurker/currency.js', domain: 'currency', lang: 'js', license: 'MIT'},
  {slug: 'airbnb__polyglot-js', github: 'airbnb/polyglot.js', domain: 'i18n', lang: 'js', license: 'MIT'},
  {slug: 'lukeed__rosetta', github: 'lukeed/rosetta', domain: 'i18n', lang: 'js', license: 'MIT'},
  {slug: 'lukeed__sade', github: 'lukeed/sade', domain: 'cli', lang: 'js', license: 'MIT'},
  {slug: 'mcollina__fastq', github: 'mcollina/fastq', domain: 'queue', lang: 'js', license: 'ISC'},
  {slug: 'pimterry__loglevel', github: 'pimterry/loglevel', domain: 'logger', lang: 'js', license: 'MIT'},
  {slug: 'wooorm__markdown-table', github: 'wooorm/markdown-table', domain: 'table', lang: 'js', license: 'MIT'},

  // --- Wave 3 Expansion: Pure Multi-File TS/JS Scientific, Geometry, Parser, AST, HTTP, Crypto ---
  {slug: 'mljs__array', github: 'mljs/array', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__stat', github: 'mljs/stat', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__kmeans', github: 'mljs/kmeans', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__pca', github: 'mljs/pca', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__knn', github: 'mljs/knn', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__confusion-matrix', github: 'mljs/confusion-matrix', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__random-forest', github: 'mljs/random-forest', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__naive-bayes', github: 'mljs/naive-bayes', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__regression', github: 'mljs/regression', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__savitzky-golay', github: 'mljs/savitzky-golay', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mljs__curve-fitting', github: 'mljs/curve-fitting', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mathigon__fermat-js', github: 'mathigon/fermat.js', domain: 'math', lang: 'ts', license: 'MIT'},
  {slug: 'mathigon__euclid-js', github: 'mathigon/euclid.js', domain: 'geo', lang: 'ts', license: 'MIT'},
  {slug: 'mathigon__core-js', github: 'mathigon/core.js', domain: 'functional', lang: 'ts', license: 'MIT'},
  {slug: 'pmndrs__maath', github: 'pmndrs/maath', domain: 'math', lang: 'ts', license: 'MIT', subpath: 'packages/maath'},
  {slug: 'codemirror__state', github: 'codemirror/state', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'lezer-parser__common', github: 'lezer-parser/common', domain: 'parser', lang: 'ts', license: 'MIT'},
  {slug: 'lezer-parser__lr', github: 'lezer-parser/lr', domain: 'parser', lang: 'ts', license: 'MIT'},
  {slug: 'ProseMirror__prosemirror-model', github: 'ProseMirror/prosemirror-model', domain: 'ast', lang: 'ts', license: 'MIT'},
  {slug: 'ProseMirror__prosemirror-transform', github: 'ProseMirror/prosemirror-transform', domain: 'ast', lang: 'ts', license: 'MIT'},
  {slug: 'ProseMirror__prosemirror-state', github: 'ProseMirror/prosemirror-state', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'vuejs__core', github: 'vuejs/core', domain: 'reactive', lang: 'ts', license: 'MIT', subpath: 'packages/reactivity'},
  {slug: 'formatjs__formatjs', github: 'formatjs/formatjs', domain: 'i18n', lang: 'ts', license: 'MIT', subpath: 'packages/icu-messageformat-parser'},
  {slug: 'paulmillr__noble-ed25519', github: 'paulmillr/noble-ed25519', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__noble-secp256k1', github: 'paulmillr/noble-secp256k1', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'paulmillr__scure-bip32', github: 'paulmillr/scure-bip32', domain: 'crypto', lang: 'ts', license: 'MIT'},
  {slug: 'effector__effector', github: 'effector/effector', domain: 'state', lang: 'ts', license: 'MIT', subpath: 'src/effector'},
  {slug: 'legendapp__legend-state', github: 'legendapp/legend-state', domain: 'state', lang: 'ts', license: 'MIT'},
  {slug: 'dsherret__code-block-writer', github: 'dsherret/code-block-writer', domain: 'codegen', lang: 'ts', license: 'MIT'},
  {slug: 'ReactiveX__rxjs', github: 'ReactiveX/rxjs', domain: 'reactive', lang: 'ts', license: 'Apache-2.0', subpath: 'packages/rxjs'},
  {slug: 'thi-ng__umbrella', github: 'thi-ng/umbrella', domain: 'math', lang: 'ts', license: 'Apache-2.0', subpath: 'packages/vectors'},
  {slug: 'd3__d3-geo', github: 'd3/d3-geo', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-delaunay', github: 'd3/d3-delaunay', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-contour', github: 'd3/d3-contour', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-chord', github: 'd3/d3-chord', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-force', github: 'd3/d3-force', domain: 'graph', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-dispatch', github: 'd3/d3-dispatch', domain: 'events', lang: 'js', license: 'ISC'},
  {slug: 'd3__d3-selection', github: 'd3/d3-selection', domain: 'vdom', lang: 'js', license: 'ISC'},
  {slug: 'mapbox__pbf', github: 'mapbox/pbf', domain: 'encoding', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'mapbox__vector-tile-js', github: 'mapbox/vector-tile-js', domain: 'geo', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'mapbox__geojson-area', github: 'mapbox/geojson-area', domain: 'geo', lang: 'js', license: 'BSD-2-Clause'},
  {slug: 'mapbox__geojson-rewind', github: 'mapbox/geojson-rewind', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'mapbox__polylabel', github: 'mapbox/polylabel', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'mapbox__supercluster', github: 'mapbox/supercluster', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'mourner__flatbush', github: 'mourner/flatbush', domain: 'geo', lang: 'js', license: 'ISC'},
  {slug: 'mourner__tinyqueue', github: 'mourner/tinyqueue', domain: 'datastructures', lang: 'js', license: 'ISC'},
  {slug: 'anvaka__ngraph-graph', github: 'anvaka/ngraph.graph', domain: 'graph', lang: 'js', license: 'BSD-3-Clause'},
  {slug: 'anvaka__ngraph-path', github: 'anvaka/ngraph.path', domain: 'graph', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__p-retry', github: 'sindresorhus/p-retry', domain: 'retry', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__p-map', github: 'sindresorhus/p-map', domain: 'async', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__p-throttle', github: 'sindresorhus/p-throttle', domain: 'rate-limit', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__camelcase-keys', github: 'sindresorhus/camelcase-keys', domain: 'utility', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__sort-keys', github: 'sindresorhus/sort-keys', domain: 'utility', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__serialize-error', github: 'sindresorhus/serialize-error', domain: 'serialize', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__normalize-url', github: 'sindresorhus/normalize-url', domain: 'url', lang: 'js', license: 'MIT'},
  {slug: 'sindresorhus__query-string', github: 'sindresorhus/query-string', domain: 'query', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__content-type', github: 'jshttp/content-type', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__content-disposition', github: 'jshttp/content-disposition', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__etag', github: 'jshttp/etag', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__fresh', github: 'jshttp/fresh', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__range-parser', github: 'jshttp/range-parser', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'jshttp__media-typer', github: 'jshttp/media-typer', domain: 'http', lang: 'js', license: 'MIT'},
  {slug: 'dchest__tweetnacl-js', github: 'dchest/tweetnacl-js', domain: 'crypto', lang: 'js', license: 'Unlicense'},
  {slug: 'indutny__elliptic', github: 'indutny/elliptic', domain: 'crypto', lang: 'js', license: 'MIT'},
  {slug: 'indutny__asn1-js', github: 'indutny/asn1.js', domain: 'encoding', lang: 'js', license: 'MIT'},
  {slug: 'MikeMcl__decimal-js', github: 'MikeMcl/decimal.js', domain: 'math', lang: 'js', license: 'MIT'},
  {slug: 'MikeMcl__big-js', github: 'MikeMcl/big.js', domain: 'math', lang: 'js', license: 'MIT'},
];

// Additional brand-new repos used specifically in Stateful-I/O & Browser-DOM Engine
export const WAVE3_STATEFUL_EXTRA_REPOS = {
  'jorgebucaran__superfine': {github: 'jorgebucaran/superfine', domain: 'vdom', lang: 'js', license: 'MIT'},
  'developit__vhtml': {github: 'developit/vhtml', domain: 'vdom', lang: 'js', license: 'MIT'},
  'lukeed__regexparam': {github: 'lukeed/regexparam', domain: 'router', lang: 'js', license: 'MIT'},
  'ai__nanoevents': {github: 'ai/nanoevents', domain: 'events', lang: 'js', license: 'MIT'},
  'vanjs-org__van': {github: 'vanjs-org/van', domain: 'vdom', lang: 'js', license: 'MIT'},
  'lukeed__dset': {github: 'lukeed/dset', domain: 'utility', lang: 'js', license: 'MIT'},
  'lukeed__klona': {github: 'lukeed/klona', domain: 'utility', lang: 'js', license: 'MIT'},
  'lukeed__qss': {github: 'lukeed/qss', domain: 'query', lang: 'js', license: 'MIT'},
  'lukeed__flru': {github: 'lukeed/flru', domain: 'cache', lang: 'js', license: 'MIT'},
  'sindresorhus__pretty-ms': {github: 'sindresorhus/pretty-ms', domain: 'formatter', lang: 'js', license: 'MIT'},
  'sindresorhus__pretty-bytes': {github: 'sindresorhus/pretty-bytes', domain: 'formatter', lang: 'js', license: 'MIT'},
};

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
  const parts = s.split(/__|\/|:/).filter(Boolean);
  for (const p of parts) {
    if (p.length >= 2) out.add(p);
    const cleaned = p.replace(/^node-/, '').replace(/\.js$|-js$|\.ts$|-ts$|2$/, '');
    if (cleaned.length >= 3) out.add(cleaned);
  }
  return [...out];
}

function isPreexportedRow(item) {
  return (
    Array.isArray(item?.messages) &&
    item.messages.length > 0 &&
    typeof item.sourceHash === 'string' &&
    item.sourceHash.length > 0 &&
    item.task && typeof item.task === 'object'
  );
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

// ==================== Reference / Forbidden Set Loading ====================

export function loadWave3AuditReferenceSets({
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

      const rawRepos = [row.metadata?.repo, row.task?.metadata?.repo, row.metadata?.github, row.task?.metadata?.github];
      const fam = String(row.family ?? '');
      const famMatch = fam.match(/^(?:oss:|hairy-real:|multifile-js\/|lc65k-oss\/|oss-multifile-v2\/|stateful-oss-js:|oss-js:)([^/:#]+)/i);
      if (famMatch) rawRepos.push(famMatch[1]);
      for (const rr of rawRepos) {
        if (!rr) continue;
        forbidden.repos.add(String(rr).toLowerCase());
        for (const tok of normalizeRepoTokens(rr)) forbidden.repoNamesNormalized.add(tok);
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
    repos: new Set(),
    repoNamesNormalized: new Set(),
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

      const rawRepos = [row.metadata?.repo, row.task?.metadata?.repo, row.metadata?.github, row.task?.metadata?.github];
      const fam = String(row.family ?? row.task?.family ?? '');
      const famMatch = fam.match(/^(?:oss:|hairy-real:|multifile-js\/|lc65k-oss\/|oss-multifile-v2\/|stateful-oss-js:|oss-js:)([^/:#]+)/i);
      if (famMatch) rawRepos.push(famMatch[1]);
      for (const rr of rawRepos) {
        if (!rr) continue;
        stage10.repos.add(String(rr).toLowerCase());
        for (const tok of normalizeRepoTokens(rr)) stage10.repoNamesNormalized.add(tok);
      }
    }
  }

  return {forbidden, stage10};
}

export function isRepoBlocked(repoSlug, repoGithub, refSet) {
  const candidates = [
    String(repoSlug || '').toLowerCase(),
    String(repoGithub || '').toLowerCase(),
    String(repoGithub || '').split('/')[1]?.toLowerCase() ?? '',
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (refSet.repos.has(c) || refSet.repoNamesNormalized.has(c)) return true;
    const stripped = c.replace(/^node-/, '').replace(/\.js$|-js$|\.ts$|-ts$|2$/, '');
    if (stripped.length >= 3 && refSet.repoNamesNormalized.has(stripped)) return true;
  }
  return false;
}

// ==================== Fault-Tolerant Shallow Cloning ====================

function runGitClone(url, destDir, timeoutMs = 45000) {
  return new Promise(resolvePromise => {
    try { rmSync(destDir, {recursive: true, force: true}); } catch {}
    let settled = false;
    const finish = res => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(res);
    };
    const child = spawn('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', url, destDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo'},
    });
    let stderr = '';
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      try { child.stderr?.destroy(); } catch {}
      try { rmSync(destDir, {recursive: true, force: true}); } catch {}
      finish({ok: false, error: 'git-clone-timeout'});
    }, timeoutMs);
    child.stderr.on('data', d => {
      if (stderr.length < 500) stderr += d.toString().slice(0, 500 - stderr.length);
    });
    child.on('error', err => finish({ok: false, error: String(err?.message ?? err)}));
    child.on('exit', code => {
      if (code === 0) finish({ok: true});
      else {
        try { rmSync(destDir, {recursive: true, force: true}); } catch {}
        finish({ok: false, error: `git-exit-${code}: ${stderr.trim().slice(0, 220)}`});
      }
    });
  });
}

async function ensureRepoCloned(repoEntry, cacheDir, errorLogFn) {
  mkdirSync(cacheDir, {recursive: true});
  const destDir = join(cacheDir, repoEntry.slug);
  if (existsSync(join(destDir, '.git'))) {
    try {
      const entries = readdirSync(destDir).filter(e => e !== '.git');
      if (entries.length > 0) return {ok: true, dir: destDir, cached: true};
    } catch {}
  }
  const url = `https://github.com/${repoEntry.github}.git`;
  let res = await runGitClone(url, destDir, 45000);
  if (!res.ok) {
    // One clean retry in case of transient GitHub rate limit
    res = await runGitClone(url, destDir, 45000);
  }
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

// ==================== Node Builtin Rewriting & Source Collection ====================

function rewriteNodeBuiltins(code) {
  let out = code;
  let needsRequireBinding = false;
  let needsOsShim = false;

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

  out = out.replace(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (full, q, mod) => {
    if (NODE_BUILTINS.has(mod)) {
      needsRequireBinding = true;
      return `__require(${q}${mod}${q})`;
    }
    return full;
  });

  out = out.replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s+(['"])([^'"]+)\2\s*;?/gm, (full, name, q, mod) => {
    if (!NODE_BUILTINS.has(mod)) return full;
    needsRequireBinding = true;
    return `const ${name} = __require(${q}${mod}${q});`;
  });
  out = out.replace(/^\s*import\s+(\w+)\s+from\s+(['"])([^'"]+)\2\s*;?/gm, (full, name, q, mod) => {
    if (!NODE_BUILTINS.has(mod)) return full;
    needsRequireBinding = true;
    return `const ${name} = __require(${q}${mod}${q});`;
  });
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
    const strictMatch = out.match(/^(\s*['"]use strict['"];?\s*\n)/);
    if (strictMatch) {
      out = strictMatch[1] + prefix.join('\n') + '\n' + out.slice(strictMatch[1].length);
    } else {
      out = prefix.join('\n') + '\n' + out;
    }
  }
  return out;
}

/** Rewrite tsconfig-style `~/...` imports relative to `src/` when collecting repos like nvie/decoders. */
function rewriteTildeAlias(code, relPath, rootPrefix = 'src') {
  if (!code.includes('~/')) return code;
  const fromDir = pathPosix.dirname(relPath);
  const relToRoot = pathPosix.relative(fromDir, rootPrefix) || '.';
  const normPrefix = relToRoot.startsWith('.') ? relToRoot : './' + relToRoot;
  return code.replace(/(['"])~\/([^'"]+)\1/g, (_, q, target) => `${q}${normPrefix}/${target}${q}`);
}

function collectStatefulRepoFiles(repoDir, relSubpaths, {
  maxFileBytes = 128 * 1024,
  maxTotalBytes = 240 * 1024,
  maxFiles = 140,
  rewriteTildeRoot = null,
  renameMjsToJs = false,
  skipDirsExtra = [],
} = {}) {
  const files = {};
  let totalBytes = 0;
  const skipSet = new Set(['node_modules', 'test', 'tests', '__tests__', '__snapshots__', 'dist', 'build', 'docs', 'examples', 'bench', 'benchmark', ...skipDirsExtra]);

  const normCode = (rel, raw) => {
    if (rel.endsWith('.json')) return raw;
    let out = rewriteNodeBuiltins(raw);
    if (rewriteTildeRoot) out = rewriteTildeAlias(out, rel, rewriteTildeRoot);
    // Normalize bare directory self-import `'./'` -> `'./index'` for virtual module resolver
    out = out.replace(/(from\s+['"])\.\/(['"])/g, '$1./index$2');
    if (renameMjsToJs) out = out.replace(/(['"])(\.\.?\/[^'"]+)\.mjs\1/g, '$1$2.js$1');
    return out;
  };
  const mapRel = rel => (renameMjsToJs && rel.endsWith('.mjs') ? rel.slice(0, -4) + '.js' : rel);

  const addFile = (absPath, baseRoot) => {
    if (Object.keys(files).length >= maxFiles) return;
    const rel = relative(baseRoot, absPath).replaceAll('\\', '/');
    if (SKIP_FILE_RE.test(rel)) return;
    if (!/\.(?:js|mjs|cjs|ts|tsx|mts|cts|json)$/i.test(rel)) return;
    let st;
    try { st = statSync(absPath); } catch { return; }
    if (st.size < 10 || st.size > maxFileBytes) return;
    let raw;
    try { raw = readFileSync(absPath, 'utf8'); } catch { return; }
    if (raw.includes('\0')) return;
    const mapped = mapRel(rel);
    let targetRel;
    try { targetRel = normalizeRepoPath(mapped); } catch { return; }
    if (Object.hasOwn(files, targetRel)) return;
    const transformed = normCode(targetRel, raw);
    const b = Buffer.byteLength(transformed, 'utf8');
    if (totalBytes + b > maxTotalBytes && Object.keys(files).length >= 3) return;
    files[targetRel] = transformed;
    totalBytes += b;
  };

  const walk = (dir, baseRoot) => {
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    // Visit regular files before subdirectories so core root files are never truncated by large subdirs (e.g. i18n)
    entries.sort((a, b) => (Number(a.isDirectory()) - Number(b.isDirectory())) || a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (Object.keys(files).length >= maxFiles) break;
      if (ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipSet.has(ent.name)) continue;
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
      walk(abs, repoDir);
    } else {
      addFile(abs, repoDir);
    }
  }
  if (!Object.keys(files).length) throw new Error(`No JS/TS files collected from ${repoDir}`);
  return files;
}

// ==================== Deterministic 2x Verification + Live Session Replay ====================

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
  if (div < 0) throw new Error('Counterfactual pair observations did not diverge');
  if (div >= bo.length) throw new Error('Counterfactual pair observation length mismatch before divergence');
  const ai = ao[div][0];
  const bi = bo[div][0];
  if (ai !== bi || !isDeepStrictEqual(left.slice(0, ai), right.slice(0, bi))) {
    throw new Error('Future observation altered an earlier model-visible prefix');
  }
  return {passed: true, testedDivergence: true, divergenceObservation: div, identicalPrefixMessages: ai};
}

/** Independent 2x export + live createTinkerSession replay + schema & token-budget guard. */
export async function verifyAndExportWave3Task2x(task, {
  traceFormat = 'compact',
  reasoningChannel = 'thinking',
  splitComponent,
  pairId = null,
  requireExternalCalls = false,
  minCodeLoadCalls = 1,
} = {}) {
  let fmt = traceFormat;

  const runPairExport = async f => {
    const opts = {traceFormat: f, reasoningChannel};
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
      throw new Error(`traceAudit flags failed on ${task.id}`);
    }
    return run1;
  };

  let exported = await runPairExport(fmt);

  const measure = ex => {
    const assistantMsgs = ex.messages.filter(m => m.role === 'assistant');
    const episodeChars = JSON.stringify(ex.messages).length;
    const approxTokens = estimateTokens(episodeChars, 3.2);
    const maxAssistantTurnTokens = Math.max(0, ...assistantMsgs.map(estimateMessageTokens));
    return {assistantTurns: assistantMsgs.length, episodeChars, approxTokens, maxAssistantTurnTokens};
  };

  let stats = measure(exported);
  if ((stats.approxTokens > SAFE_MAX_CONTEXT_TOKENS || stats.maxAssistantTurnTokens > SAFE_MAX_TURN_TOKENS) && fmt === 'compact') {
    fmt = 'actions-only';
    exported = await runPairExport(fmt);
    stats = measure(exported);
  }

  if (!isPreexportedRow(exported)) {
    throw new Error(`Failed _is_preexported_row schema check on ${task.id}`);
  }
  const codeLoadCalls = Number(exported.metadata?.codeLoadCalls ?? 0);
  if (codeLoadCalls < minCodeLoadCalls) {
    throw new Error(`codeLoadCalls=${codeLoadCalls} < ${minCodeLoadCalls} on ${task.id}`);
  }
  const extCalls = Number(exported.metadata?.externalCalls ?? 0);
  if (requireExternalCalls && extCalls < 1) {
    throw new Error(`Stateful task has 0 non-code.load external I/O calls on ${task.id}`);
  }

  const {declared, used} = extractDeclaredAndUsedTools(exported.messages);
  const undeclared = used.filter(op => !declared.has(op));
  if (undeclared.length > 0) {
    throw new Error(`Undeclared tools invoked: ${[...new Set(undeclared)].join(', ')}`);
  }

  if (stats.assistantTurns > MAX_ASSISTANT_TURNS) {
    throw new Error(`assistantTurns ${stats.assistantTurns} > ${MAX_ASSISTANT_TURNS}`);
  }
  if (stats.approxTokens > MAX_CONTEXT_TOKENS) {
    throw new Error(`approxTokens ${stats.approxTokens} > ${MAX_CONTEXT_TOKENS}`);
  }
  if (stats.maxAssistantTurnTokens > MAX_TURN_TOKENS) {
    throw new Error(`maxAssistantTurnTokens ${stats.maxAssistantTurnTokens} > ${MAX_TURN_TOKENS}`);
  }

  // Independent explicit live createTinkerSession step-by-step replay verification!
  const prepared = await prepareTinkerTask(task, {traceFormat: fmt});
  const session = createTinkerSession(prepared);
  try {
    for (const msg of exported.messages) {
      if (msg.role === 'assistant') {
        const step = await session.step(msg, 0);
        if (step.done && !step.grade.success) {
          throw new Error(`Live createTinkerSession replay failed: ${JSON.stringify(step.grade)}`);
        }
      }
    }
    const grade = session.grade();
    if (!grade.success || grade.externalCalls !== extCalls) {
      throw new Error(`Live createTinkerSession grade mismatch: ${JSON.stringify(grade)}`);
    }
  } finally {
    session.close();
  }

  const fileEntries = Object.entries(exported.task.files ?? {});
  const codebaseChars = fileEntries.reduce((s, [, c]) => s + c.length, 0);
  const codebaseApproxTokens = estimateTokens(codebaseChars, 3.5);
  const nonClOps = [...new Set(used.filter(op => op !== 'code.load'))].sort();

  return {
    ...exported,
    split: 'train',
    split_component: splitComponent,
    ...(pairId ? {pair_id: pairId} : {}),
    metadata: {
      ...exported.metadata,
      ...(pairId ? {pair_id: pairId} : {}),
      deterministic2xVerified: true,
      liveSessionReplayVerified: true,
      codebaseChars,
      codebaseApproxTokens,
      episodeChars: stats.episodeChars,
      approxTokens: stats.approxTokens,
      assistantTurns: stats.assistantTurns,
      maxAssistantTurnTokens: stats.maxAssistantTurnTokens,
      externalOps: nonClOps,
    },
  };
}

// ==================== Engine 2 Helpers: Stateful-I/O & Browser-DOM Live Recorders ====================

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

async function runLiveNodeIoCapture({files, entryFile, entry, args, worldFiles, worldEnv, initGit = false, postGitWrites = null}) {
  const workDir = mkdtempSync(join(tmpdir(), 'wave3-stateful-oss-'));
  try {
    seedWorkspaceDir(workDir, worldFiles, {initGit, postGitWrites});
    const recordedCalls = [];
    const codeLoadEvents = [];
    let clockMs = 1732000000000;
    let uuidIdx = 0;

    const liveIo = createLiveNodeIoRecorder(recordedCalls, {
      workDir,
      env: {...(worldEnv ?? {})},
      timeoutMs: 4000,
      maxCalls: 64,
      encodeReadable,
    });
    liveIo.uuid = () => {
      const hex = String(++uuidIdx).padStart(12, '0');
      const u = `22223333-4444-4555-8666-${hex}`;
      recordedCalls.push({operation: 'platform.uuid', arguments: [], status: 'fulfilled', result: u});
      return u;
    };
    const {liveFetch} = createLiveFetchRecorder(recordedCalls, {timeoutMs: 4000, encodeReadable});

    const context = vm.createContext({
      URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, Buffer, Blob,
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
      timeoutMs: 6000,
      traceMode: false,
      onCodeLoadEvent(req) { codeLoadEvents.push(req); },
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

async function runLiveBrowserCapture({
  files,
  entryFile,
  entry = 'run',
  args = [],
  initialHtml = DEFAULT_BROWSER_HTML,
  initialUrl = DEFAULT_BROWSER_URL,
  storage = {},
  dialogs = {},
  httpHandler = null,
  now = [],
}) {
  const localMap = new Map(Object.entries(storage.local ?? {}));
  const sessionMap = new Map(Object.entries(storage.session ?? {}));
  const confirms = Array.isArray(dialogs.confirm) ? [...dialogs.confirm] : [];
  const prompts = Array.isArray(dialogs.prompt) ? [...dialogs.prompt] : [];
  const timestamps = Array.isArray(now) ? [...now] : [];
  let nowIdx = 0;
  let confirmIdx = 0;
  let promptIdx = 0;
  let httpIdx = 0;
  const recordedCalls = [];
  const codeLoadEvents = [];

  const getMap = area => (area === 'session' ? sessionMap : localMap);

  const browserInvoke = (op, rawArgs) => {
    const opArgs = Array.from(rawArgs ?? []);
    let result = null;
    if (op === 'browser.storageGet') {
      const [area, key] = opArgs;
      result = getMap(area).has(key) ? getMap(area).get(key) : null;
    } else if (op === 'browser.storageSet') {
      const [area, key, val] = opArgs;
      getMap(area).set(key, String(val));
      result = null;
    } else if (op === 'browser.storageRemove') {
      const [area, key] = opArgs;
      getMap(area).delete(key);
      result = null;
    } else if (op === 'browser.storageClear') {
      const [area] = opArgs;
      getMap(area).clear();
      result = null;
    } else if (op === 'browser.alert') {
      result = null;
    } else if (op === 'browser.confirm') {
      result = confirmIdx < confirms.length ? Boolean(confirms[confirmIdx++]) : true;
    } else if (op === 'browser.prompt') {
      const def = opArgs[1] ?? '';
      result = promptIdx < prompts.length ? prompts[promptIdx++] : def;
    }
    recordedCalls.push({
      operation: op,
      arguments: encodeReadable(opArgs),
      status: 'fulfilled',
      result: encodeReadable(result),
    });
    return result;
  };

  const platformFetch = async (reqInput, reqInit) => {
    const norm = normalizeFetchRequest(reqInput, reqInit);
    const [url, method, headers, body] = norm;
    let outcome;
    if (typeof httpHandler === 'function') {
      outcome = await httpHandler({url, method, headers, body, index: httpIdx++});
    } else if (Array.isArray(httpHandler)) {
      outcome = httpHandler[httpIdx++] ?? {status: 200, statusText: 'OK', url, headers: {'content-type': 'application/json'}, body: '{}'};
    } else {
      outcome = {status: 200, statusText: 'OK', url, headers: {'content-type': 'application/json'}, body: '{}'};
    }
    if (outcome?.reject) {
      const errObj = {name: outcome.name ?? 'TypeError', message: outcome.message ?? 'Network request failed'};
      recordedCalls.push({
        operation: 'http.request',
        arguments: encodeReadable(norm),
        status: 'rejected',
        result: encodeReadable(errObj),
      });
      throw errObj;
    }
    const payload = {
      status: outcome.status ?? 200,
      statusText: outcome.statusText ?? 'OK',
      url: outcome.url ?? url,
      headers: outcome.headers ?? {'content-type': 'application/json'},
      body: typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body ?? {}),
    };
    recordedCalls.push({
      operation: 'http.request',
      arguments: encodeReadable(norm),
      status: 'fulfilled',
      result: encodeReadable(payload),
    });
    return payload;
  };

  const consoleObj = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [
    level,
    (...cArgs) => {
      recordedCalls.push({
        operation: 'platform.console.' + level,
        arguments: encodeReadable(cArgs),
        status: 'fulfilled',
        result: {$js: 'undefined'},
      });
    },
  ]));

  try {
    const context = vm.createContext({
      URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, Buffer,
      __platformFetch: platformFetch,
      __browserInvoke: browserInvoke,
      __browserInitialHtml: initialHtml,
      __browserInitialUrl: initialUrl,
      __recDateNow: () => {
        const val = nowIdx < timestamps.length ? timestamps[nowIdx++] : 1732000000000 + nowIdx * 1000;
        recordedCalls.push({
          operation: 'platform.dateNow',
          arguments: [],
          status: 'fulfilled',
          result: encodeReadable(val),
        });
        return val;
      },
      console: consoleObj,
      queueMicrotask: cb => queueMicrotask(cb),
    }, {codeGeneration: {strings: false, wasm: false}});

    new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 4000});
    new vm.Script('Date.now = __recDateNow;').runInContext(context, {timeout: 1000});
    new vm.Script(`(function(){let state=17>>>0;
      Math.random=function(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};})()`)
      .runInContext(context, {timeout: 1000});
    new vm.Script(VM_BROWSER_DOM_RUNTIME_SCRIPT).runInContext(context, {timeout: 4000});

    const clonedArgs = structuredClone(args);
    const execRes = await executeVirtualCodebaseInContext({
      context,
      files,
      entryFile,
      entry,
      initialLoadedFiles: [entryFile],
      args: clonedArgs,
      timeoutMs: 6000,
      traceMode: false,
      onCodeLoadEvent(req) { codeLoadEvents.push(req); },
      setTraceActive() {},
    });
    if (execRes.kind === 'throw') {
      return {ok: false, error: `Browser guest threw: ${execRes.value?.name ?? 'Error'}: ${execRes.value?.message ?? String(execRes.value)}`};
    }
    return {ok: true, recordedCalls, codeLoadEvents, outcome: encodeReadable({arguments: clonedArgs, value: execRes.value})};
  } catch (err) {
    return {ok: false, error: String(err?.message ?? err)};
  }
}

// ==================== Engine 2: 35+ Brand-New Real-World Stateful-I/O & Browser-DOM OSS Scenarios ====================

async function buildWave3StatefulAndBrowserScenarios(cacheDir, port, {forbidden, stage10, errorLogFn}) {
  const scenarios = [];
  const baseUrl = `http://127.0.0.1:${port}`;

  // Build lookup of repo metadata from both catalogs
  const repoMetaBySlug = new Map();
  for (const e of WAVE3_PURE_CATALOG) repoMetaBySlug.set(e.slug, e);
  for (const [slug, e] of Object.entries(WAVE3_STATEFUL_EXTRA_REPOS)) {
    repoMetaBySlug.set(slug, {slug, ...e});
  }

  const loadRepo = async (slug, subpaths, opts = {}) => {
    const meta = repoMetaBySlug.get(slug);
    if (!meta) {
      errorLogFn({stage: 'stateful-meta', repo: slug, error: 'missing-repo-metadata'});
      return null;
    }
    if (isRepoBlocked(meta.slug, meta.github, forbidden) || isRepoBlocked(meta.slug, meta.github, stage10)) {
      errorLogFn({stage: 'stateful-blocked', repo: slug, error: 'repo-overlap-forbidden-or-stage10'});
      return null;
    }
    const cRes = await ensureRepoCloned(meta, cacheDir, errorLogFn);
    if (!cRes.ok) return null;
    try {
      const files = collectStatefulRepoFiles(cRes.dir, subpaths, opts);
      return {meta, files};
    } catch (err) {
      errorLogFn({stage: 'stateful-collect', repo: slug, error: String(err?.message ?? err)});
      return null;
    }
  };

  const addStatefulPair = (loaded, slugName, entryFile, entryCode, entryFn, args, worldA, worldB, extraFeatures = []) => {
    if (!loaded) return;
    const files = {...loaded.files, [entryFile]: rewriteNodeBuiltins(entryCode)};
    scenarios.push({
      envKind: 'node-io',
      repo: loaded.meta.slug,
      github: loaded.meta.github,
      domain: loaded.meta.domain,
      license: loaded.meta.license,
      slug: slugName,
      pairId: `wave3-stateful-pair:${loaded.meta.slug}:${slugName}`,
      files,
      entryFile,
      entry: entryFn,
      args,
      variants: [
        {suffix: worldA.label, ...worldA},
        {suffix: worldB.label, ...worldB},
      ],
      features: ['wave3-oss', 'real-oss-stateful-io', 'causal-pair', 'multi-file', 'code-load', ...extraFeatures],
    });
  };

  const addBrowserPair = (loaded, slugName, entryFile, entryCode, entryFn, args, worldA, worldB, extraFeatures = []) => {
    if (!loaded) return;
    const files = {...loaded.files, [entryFile]: entryCode};
    scenarios.push({
      envKind: 'browser',
      repo: loaded.meta.slug,
      github: loaded.meta.github,
      domain: loaded.meta.domain,
      license: loaded.meta.license,
      slug: slugName,
      pairId: `wave3-browser-pair:${loaded.meta.slug}:${slugName}`,
      files,
      entryFile,
      entry: entryFn,
      args,
      variants: [
        {suffix: worldA.label, ...worldA},
        {suffix: worldB.label, ...worldB},
      ],
      features: ['wave3-oss', 'real-oss-browser-dom', 'browser-dom', 'frontend', 'causal-pair', 'multi-file', 'code-load', ...extraFeatures],
    });
  };

  // ==================== PART 2A: STATEFUL-I/O REAL OSS REPOS (26+ Brand-New Repos) ====================

  // 1. af/envalid (TS) — real env validator + FS config fallback + console.warn
  let r = await loadRepo('af__envalid', ['src']);
  addStatefulPair(r, 'envalid_service_boot', 'boot_env.ts', `import * as fs from 'node:fs';
import { cleanEnv, str, port, bool } from './src/index.ts';

export function run(overridePath: string, outPath: string) {
  const fileVars = fs.existsSync(overridePath) ? JSON.parse(fs.readFileSync(overridePath, 'utf8')) : {};
  const merged = {
    NODE_ENV: process.env.NODE_ENV ?? fileVars.NODE_ENV ?? 'development',
    PORT: process.env.PORT ?? fileVars.PORT ?? '3000',
    FEATURE_V2: process.env.FEATURE_V2 ?? fileVars.FEATURE_V2 ?? 'false',
    API_HOST: process.env.API_HOST ?? fileVars.API_HOST ?? 'localhost',
  };
  const cfg = cleanEnv(merged, {
    NODE_ENV: str({ choices: ['development', 'staging', 'production'] }),
    PORT: port(),
    FEATURE_V2: bool(),
    API_HOST: str(),
  });
  if (cfg.isProduction && !cfg.FEATURE_V2) {
    console.warn('production running with FEATURE_V2 disabled');
  }
  const summary = { env: cfg.NODE_ENV, port: cfg.PORT, v2: cfg.FEATURE_V2, host: cfg.API_HOST, isProd: cfg.isProduction };
  fs.writeFileSync(outPath, JSON.stringify(summary), 'utf8');
  return summary;
}
`, 'run', ['/workspace/env.json', '/workspace/boot_report.json'],
    {label: 'prod_from_env', files: {'env.json': JSON.stringify({PORT: '8080', FEATURE_V2: 'false'})}, env: {NODE_ENV: 'production', API_HOST: 'api.prod.internal'}},
    {label: 'staging_from_file', files: {'env.json': JSON.stringify({NODE_ENV: 'staging', PORT: '4200', FEATURE_V2: 'true', API_HOST: 'api.stage.internal'})}, env: {}},
    ['typescript', 'fs-io', 'env-io', 'console']);

  // 2. pelotom/runtypes (TS) — validate workspace deploy manifest from FS + write audit
  r = await loadRepo('pelotom__runtypes', ['src']);
  addStatefulPair(r, 'runtypes_manifest_gate', 'validate_deploy.ts', `import * as fs from 'node:fs';
import { Object as RtObj, String as RtStr, Number as RtNum, Boolean as RtBool, Array as RtArr } from './src/index.ts';

const DeploySpec = RtObj({
  service: RtStr,
  replicas: RtNum,
  canary: RtBool,
  regions: RtArr(RtStr),
});

export function run(specPath: string, outPath: string) {
  const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const strict = process.env.STRICT_DEPLOY === '1';
  const result = DeploySpec.inspect(raw, false);
  let decision: any;
  if (result.success) {
    const okReplicas = !strict || result.value.replicas >= 2;
    decision = { valid: okReplicas, service: result.value.service, replicas: result.value.replicas, regions: result.value.regions.length };
  } else {
    console.error('manifest validation failed:', result.code);
    decision = { valid: false, code: result.code };
  }
  fs.writeFileSync(outPath, JSON.stringify(decision), 'utf8');
  return decision;
}
`, 'run', ['/workspace/deploy.json', '/workspace/decision.json'],
    {label: 'valid_spec', files: {'deploy.json': JSON.stringify({service: 'billing', replicas: 3, canary: true, regions: ['us-east', 'eu-west']})}, env: {STRICT_DEPLOY: '1'}},
    {label: 'invalid_spec', files: {'deploy.json': JSON.stringify({service: 'billing', replicas: 'three', canary: true, regions: ['us-east']})}, env: {STRICT_DEPLOY: '1'}},
    ['typescript', 'fs-io', 'env-io', 'console']);

  // 3. nvie/decoders (TS) — decode remote HTTP payload + local fallback file
  r = await loadRepo('nvie__decoders', ['src'], {rewriteTildeRoot: 'src'});
  addStatefulPair(r, 'decoders_http_config', 'decode_remote.ts', `import * as fs from 'node:fs';
import { object, string, number, boolean, array } from './src/index.ts';

const FlagDecoder = object({
  version: number,
  enabled: boolean,
  rules: array(object({ id: string, pct: number })),
});

export async function run(apiUrl: string, fallbackPath: string, outPath: string) {
  const resp = await fetch(apiUrl);
  let source = 'remote';
  let payload: unknown;
  if (resp.ok) {
    payload = await resp.json();
  } else {
    source = 'fallback';
    payload = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
  }
  const decoded = FlagDecoder.decode(payload);
  const out = decoded.ok
    ? { ok: true, source, version: decoded.value.version, ruleCount: decoded.value.rules.length, activeIds: decoded.value.rules.filter(x => x.pct > 0).map(x => x.id) }
    : { ok: false, source, error: 'decode_failed' };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', [`${baseUrl}/flags`, '/workspace/fallback.json', '/workspace/flags_out.json'],
    {
      label: 'remote_valid',
      files: {'fallback.json': JSON.stringify({version: 1, enabled: false, rules: []})},
      env: {},
      httpRoutes: {'/flags': {status: 200, body: JSON.stringify({version: 4, enabled: true, rules: [{id: 'r1', pct: 50}, {id: 'r2', pct: 0}, {id: 'r3', pct: 100}]})}},
    },
    {
      label: 'fallback_on_503',
      files: {'fallback.json': JSON.stringify({version: 2, enabled: true, rules: [{id: 'safe-default', pct: 10}]})},
      env: {},
      httpRoutes: {'/flags': {status: 503, body: JSON.stringify({error: 'unavailable'})}},
    },
    ['typescript', 'http-io', 'fs-io']);

  // 4. badrap/valita (TS) — validate directory of JSON tenant records
  r = await loadRepo('badrap__valita', ['src']);
  addStatefulPair(r, 'valita_tenant_audit', 'audit_tenants.ts', `import * as fs from 'node:fs';
import * as v from './src/index.ts';

const TenantSchema = v.object({
  id: v.string(),
  tier: v.union(v.literal('free'), v.literal('pro'), v.literal('enterprise')),
  seats: v.number(),
});

export function run(dirPath: string, outPath: string) {
  const files = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.json')).sort();
  const valid: Array<{id: string; tier: string; seats: number}> = [];
  const invalid: string[] = [];
  for (const name of files) {
    const raw = JSON.parse(fs.readFileSync(dirPath + '/' + name, 'utf8'));
    const res = TenantSchema.try(raw);
    if (res.ok) valid.push(res.value);
    else {
      console.warn('invalid tenant file:', name);
      invalid.push(name);
    }
  }
  const totalSeats = valid.reduce((s, t) => s + t.seats, 0);
  const report = { validCount: valid.length, invalid, totalSeats };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/tenants', '/workspace/tenant_report.json'],
    {
      label: 'all_valid_tenants',
      files: {
        'tenants/acme.json': JSON.stringify({id: 'acme', tier: 'enterprise', seats: 40}),
        'tenants/beta.json': JSON.stringify({id: 'beta', tier: 'pro', seats: 12}),
      },
      env: {},
    },
    {
      label: 'one_corrupt_tenant',
      files: {
        'tenants/acme.json': JSON.stringify({id: 'acme', tier: 'enterprise', seats: 40}),
        'tenants/bad.json': JSON.stringify({id: 'bad', tier: 'unknown-plan', seats: 5}),
      },
      env: {},
    },
    ['typescript', 'fs-io', 'console']);

  // 5. bradymholt/cRonstrue (TS) — human-readable cron documentation generator from FS + env
  r = await loadRepo('bradymholt__cRonstrue', ['src']);
  addStatefulPair(r, 'cronstrue_schedule_docs', 'cron_docs.ts', `import * as fs from 'node:fs';
import { toString as describeCron } from './src/cronstrue.ts';

export function run(jobsPath: string, outPath: string) {
  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8')) as Array<{name: string; cron: string}>;
  const use24HourTimeFormat = process.env.TIME_FORMAT === '24h';
  const rows = jobs.map(j => ({
    name: j.name,
    cron: j.cron,
    description: describeCron(j.cron, { use24HourTimeFormat }),
  }));
  const md = rows.map(r => '- **' + r.name + '**: ' + r.description).join('\\n') + '\\n';
  fs.writeFileSync(outPath, md, 'utf8');
  return { count: rows.length, use24HourTimeFormat, descriptions: rows.map(r => r.description) };
}
`, 'run', ['/workspace/jobs.json', '/workspace/SCHEDULES.md'],
    {
      label: 'format_24h',
      files: {'jobs.json': JSON.stringify([{name: 'backup', cron: '30 23 * * 1-5'}, {name: 'cleanup', cron: '0 14 * * 0'}])},
      env: {TIME_FORMAT: '24h'},
    },
    {
      label: 'format_12h',
      files: {'jobs.json': JSON.stringify([{name: 'backup', cron: '30 23 * * 1-5'}, {name: 'cleanup', cron: '0 14 * * 0'}])},
      env: {TIME_FORMAT: '12h'},
    },
    ['typescript', 'fs-io', 'env-io']);

  // 6. dcastil/tailwind-merge (TS) — resolve layered UI theme overrides from FS + env
  r = await loadRepo('dcastil__tailwind-merge', ['packages/tailwind-merge/src']);
  addStatefulPair(r, 'twmerge_theme_compiler', 'theme_merge.ts', `import * as fs from 'node:fs';
import { twMerge } from './packages/tailwind-merge/src/index.ts';

export function run(basePath: string, overridePath: string, outPath: string) {
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8')) as Record<string, string>;
  const overrides = fs.existsSync(overridePath) ? JSON.parse(fs.readFileSync(overridePath, 'utf8')) : {};
  const compact = process.env.COMPACT_MODE === '1';
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(base).sort()) {
    const extra = compact ? 'p-1 text-xs' : '';
    resolved[key] = twMerge(base[key], overrides[key] || '', extra);
  }
  fs.writeFileSync(outPath, JSON.stringify(resolved), 'utf8');
  return { compact, resolved };
}
`, 'run', ['/workspace/base_theme.json', '/workspace/override_theme.json', '/workspace/resolved_theme.json'],
    {
      label: 'compact_with_overrides',
      files: {
        'base_theme.json': JSON.stringify({button: 'px-4 py-2 bg-blue-500 text-base rounded', card: 'p-6 bg-white border'}),
        'override_theme.json': JSON.stringify({button: 'bg-emerald-600 px-6'}),
      },
      env: {COMPACT_MODE: '1'},
    },
    {
      label: 'default_no_overrides',
      files: {
        'base_theme.json': JSON.stringify({button: 'px-4 py-2 bg-blue-500 text-base rounded', card: 'p-6 bg-white border'}),
      },
      env: {COMPACT_MODE: '0'},
    },
    ['typescript', 'fs-io', 'env-io']);

  // 7. eta-dev/eta (TS) — render template file from workspace FS with fetched/FS context
  r = await loadRepo('eta-dev__eta', ['src']);
  addStatefulPair(r, 'eta_release_notes_render', 'render_notes.ts', `import * as fs from 'node:fs';
import { Eta } from './src/index.ts';

export function run(tplPath: string, dataPath: string, outPath: string) {
  const tpl = fs.readFileSync(tplPath, 'utf8');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const eta = new Eta({ autoEscape: true });
  const rendered = eta.renderString(tpl, { ...data, env: process.env.RELEASE_CHANNEL || 'stable' });
  fs.writeFileSync(outPath, rendered, 'utf8');
  return { length: rendered.length, channel: process.env.RELEASE_CHANNEL || 'stable', rendered };
}
`, 'run', ['/workspace/notes.eta', '/workspace/release.json', '/workspace/NOTES.html'],
    {
      label: 'canary_release',
      files: {
        'notes.eta': '<h1><%= it.pkg %> (<%= it.env %>)</h1><ul><% it.items.forEach(function(x){ %><li><%= x %></li><% }) %></ul>',
        'release.json': JSON.stringify({pkg: 'core-sdk', items: ['faster parser', 'fix <script> escape']}),
      },
      env: {RELEASE_CHANNEL: 'canary'},
    },
    {
      label: 'stable_release',
      files: {
        'notes.eta': '<h1><%= it.pkg %> (<%= it.env %>)</h1><ul><% it.items.forEach(function(x){ %><li><%= x %></li><% }) %></ul>',
        'release.json': JSON.stringify({pkg: 'core-sdk', items: ['initial stable']}),
      },
      env: {RELEASE_CHANNEL: 'stable'},
    },
    ['typescript', 'fs-io', 'env-io']);

  // 8. lucaong/minisearch (TS) — index workspace documents and query by env
  r = await loadRepo('lucaong__minisearch', ['src']);
  addStatefulPair(r, 'minisearch_workspace_index', 'search_docs.ts', `import * as fs from 'node:fs';
import MiniSearch from './src/index.ts';

export function run(docsPath: string, outPath: string) {
  const docs = JSON.parse(fs.readFileSync(docsPath, 'utf8')) as Array<{id: number; title: string; body: string}>;
  const query = process.env.SEARCH_QUERY || 'cache';
  const ms = new MiniSearch({ fields: ['title', 'body'], storeFields: ['title'] });
  ms.addAll(docs);
  const hits = ms.search(query, { prefix: true, fuzzy: 0.2 }).map(h => ({ id: h.id, title: h.title }));
  const report = { query, indexed: docs.length, hitCount: hits.length, hits };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/docs.json', '/workspace/search_results.json'],
    {
      label: 'query_matches_two',
      files: {'docs.json': JSON.stringify([
        {id: 1, title: 'LRU Cache Guide', body: 'Eviction policy for distributed caching.'},
        {id: 2, title: 'HTTP Retry Spec', body: 'Exponential backoff with jitter.'},
        {id: 3, title: 'Edge Cache Keys', body: 'Normalize query strings before cache lookup.'},
      ])},
      env: {SEARCH_QUERY: 'cache'},
    },
    {
      label: 'query_matches_retry',
      files: {'docs.json': JSON.stringify([
        {id: 1, title: 'LRU Cache Guide', body: 'Eviction policy for distributed caching.'},
        {id: 2, title: 'HTTP Retry Spec', body: 'Exponential backoff with jitter.'},
        {id: 3, title: 'Edge Cache Keys', body: 'Normalize query strings before cache lookup.'},
      ])},
      env: {SEARCH_QUERY: 'jitter'},
    },
    ['typescript', 'fs-io', 'env-io']);

  // 9. pillarjs/path-to-regexp (TS) — route matcher over workspace config + HTTP batch
  r = await loadRepo('pillarjs__path-to-regexp', ['src']);
  addStatefulPair(r, 'pathtoregexp_gateway_dispatch', 'gateway_match.ts', `import * as fs from 'node:fs';
import { match } from './src/index.ts';

export async function run(routesPath: string, batchUrl: string, outPath: string) {
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8')) as Array<{name: string; pattern: string}>;
  const compiled = routes.map(r => ({ name: r.name, fn: match(r.pattern) }));
  const resp = await fetch(batchUrl);
  const reqPaths = await resp.json() as string[];
  const dispatched = reqPaths.map(p => {
    for (const c of compiled) {
      const m = c.fn(p);
      if (m) return { path: p, route: c.name, params: m.params };
    }
    return { path: p, route: null, params: null };
  });
  const summary = { total: dispatched.length, matched: dispatched.filter(d => d.route !== null).length, dispatched };
  fs.writeFileSync(outPath, JSON.stringify(summary), 'utf8');
  return summary;
}
`, 'run', ['/workspace/routes.json', `${baseUrl}/requests`, '/workspace/dispatch.json'],
    {
      label: 'all_routes_hit',
      files: {'routes.json': JSON.stringify([{name: 'user', pattern: '/users/:id'}, {name: 'post', pattern: '/orgs/:org/posts/:slug'}])},
      env: {},
      httpRoutes: {'/requests': {status: 200, body: JSON.stringify(['/users/42', '/orgs/acme/posts/launch'])}},
    },
    {
      label: 'mixed_404_miss',
      files: {'routes.json': JSON.stringify([{name: 'user', pattern: '/users/:id'}, {name: 'post', pattern: '/orgs/:org/posts/:slug'}])},
      env: {},
      httpRoutes: {'/requests': {status: 200, body: JSON.stringify(['/users/7', '/unknown/path'])}},
    },
    ['typescript', 'fs-io', 'http-io']);

  // 10. jshttp/cookie (TS) — parse & rotate HTTP session cookies with Date.now + FS
  r = await loadRepo('jshttp__cookie', ['src']);
  addStatefulPair(r, 'cookie_session_rotator', 'rotate_cookie.ts', `import * as fs from 'node:fs';
import { parseCookie, stringifySetCookie } from './src/index.ts';

export function run(headerPath: string, outPath: string) {
  const rawHeader = fs.readFileSync(headerPath, 'utf8').trim();
  const parsed = parseCookie(rawHeader);
  const nowSec = Math.floor(Date.now() / 1000);
  const hasSession = Boolean(parsed.sid);
  const newSid = hasSession ? parsed.sid + '-r1' : 'guest-' + nowSec;
  const setCookie = stringifySetCookie({
    name: 'sid',
    value: newSid,
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: hasSession ? 7200 : 900,
  });
  const out = { hadSession: hasSession, theme: parsed.theme || 'light', setCookie };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/cookie_header.txt', '/workspace/set_cookie.json'],
    {label: 'existing_session', files: {'cookie_header.txt': 'sid=abc99; theme=dark; locale=en'}, env: {}},
    {label: 'fresh_guest', files: {'cookie_header.txt': 'theme=compact'}, env: {}},
    ['typescript', 'fs-io', 'date-now']);

  // 11. auth0/jwt-decode (TS) — decode bearer token from env/FS and check expiry against Date.now
  r = await loadRepo('auth0__jwt-decode', ['lib']);
  const makeFakeJwt = payloadObj => {
    const h = Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url');
    const p = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    return `${h}.${p}.sig_placeholder`;
  };
  addStatefulPair(r, 'jwt_expiry_audit', 'check_jwt.ts', `import * as fs from 'node:fs';
import { jwtDecode } from './lib/index.ts';

export function run(tokenPath: string, outPath: string) {
  const token = process.env.AUTH_TOKEN || fs.readFileSync(tokenPath, 'utf8').trim();
  const claims = jwtDecode<{sub: string; role: string; exp: number}>(token);
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = claims.exp <= nowSec;
  if (expired) console.warn('token expired for subject:', claims.sub);
  const audit = { sub: claims.sub, role: claims.role, expired, ttlSec: claims.exp - nowSec };
  fs.writeFileSync(outPath, JSON.stringify(audit), 'utf8');
  return audit;
}
`, 'run', ['/workspace/token.jwt', '/workspace/jwt_audit.json'],
    {label: 'active_admin_token', files: {'token.jwt': makeFakeJwt({sub: 'u-101', role: 'admin', exp: 1732003600})}, env: {}},
    {label: 'expired_env_token', files: {'token.jwt': ''}, env: {AUTH_TOKEN: makeFakeJwt({sub: 'u-202', role: 'viewer', exp: 1731999000})}},
    ['typescript', 'fs-io', 'env-io', 'date-now', 'console']);

  // 12. AsyncBanana/microdiff (TS) — diff baseline vs current config in workspace FS
  r = await loadRepo('AsyncBanana__microdiff', ['index.ts']);
  addStatefulPair(r, 'microdiff_config_drift', 'drift_check.ts', `import * as fs from 'node:fs';
import diff from './index.ts';

export function run(basePath: string, nextPath: string, outPath: string) {
  const baseObj = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const nextObj = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
  const changes = diff(baseObj, nextObj);
  const removals = changes.filter(c => c.type === 'REMOVE');
  if (removals.length > 0) console.warn('breaking removals detected:', removals.length);
  const report = { changeCount: changes.length, breaking: removals.length > 0, types: changes.map(c => c.type) };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/base.json', '/workspace/next.json', '/workspace/drift.json'],
    {
      label: 'additive_only',
      files: {
        'base.json': JSON.stringify({api: {v1: true, timeout: 5000}}),
        'next.json': JSON.stringify({api: {v1: true, timeout: 8000, v2: true}}),
      },
      env: {},
    },
    {
      label: 'breaking_removal',
      files: {
        'base.json': JSON.stringify({api: {v1: true, timeout: 5000}}),
        'next.json': JSON.stringify({api: {timeout: 5000}}),
      },
      env: {},
    },
    ['typescript', 'fs-io', 'console']);

  // 13. paulmillr/scure-base (TS) — encode/decode workspace binary artifact in Base32 & Base58
  r = await loadRepo('paulmillr__scure-base', ['index.ts']);
  addStatefulPair(r, 'scurebase_artifact_armor', 'armor_blob.ts', `import * as fs from 'node:fs';
import { base32, base58 } from './index.ts';

export function run(binPath: string, outPath: string) {
  const raw = fs.readFileSync(binPath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const codec = process.env.ARMOR_CODEC || 'base32';
  const encoded = codec === 'base58' ? base58.encode(bytes) : base32.encode(bytes);
  const decoded = codec === 'base58' ? base58.decode(encoded) : base32.decode(encoded);
  const res = { codec, byteLen: bytes.length, encoded, roundtripOk: decoded.length === bytes.length };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`, 'run', ['/workspace/key.bin', '/workspace/key_armored.json'],
    {label: 'base32_key', files: {'key.bin': Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60])}, env: {ARMOR_CODEC: 'base32'}},
    {label: 'base58_key', files: {'key.bin': Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60])}, env: {ARMOR_CODEC: 'base58'}},
    ['typescript', 'fs-io', 'env-io']);

  // 14. sqids/sqids-javascript (TS) — generate short public slugs for DB records from FS + env
  r = await loadRepo('sqids__sqids-javascript', ['src/sqids.ts']);
  addStatefulPair(r, 'sqids_url_slugger', 'slug_ids.ts', `import * as fs from 'node:fs';
import Sqids from './src/sqids.ts';

export function run(inPath: string, outPath: string) {
  const records = JSON.parse(fs.readFileSync(inPath, 'utf8')) as Array<{org: number; item: number}>;
  const minLength = Number(process.env.SQID_MIN_LEN || 6);
  const sqids = new Sqids({ minLength });
  const mapped = records.map(r => {
    const code = sqids.encode([r.org, r.item]);
    const back = sqids.decode(code);
    return { code, ok: back[0] === r.org && back[1] === r.item };
  });
  const res = { minLength, count: mapped.length, mapped };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`, 'run', ['/workspace/ids.json', '/workspace/slugs.json'],
    {label: 'minlen_6', files: {'ids.json': JSON.stringify([{org: 12, item: 99}, {org: 45, item: 7}])}, env: {SQID_MIN_LEN: '6'}},
    {label: 'minlen_10', files: {'ids.json': JSON.stringify([{org: 12, item: 99}, {org: 45, item: 7}])}, env: {SQID_MIN_LEN: '10'}},
    ['typescript', 'fs-io', 'env-io']);

  // 15. supermacro/neverthrow (TS) — Result pipeline over FS + HTTP settlement API
  r = await loadRepo('supermacro__neverthrow', ['src']);
  addStatefulPair(r, 'neverthrow_order_settlement', 'settle_orders.ts', `import * as fs from 'node:fs';
import { ok, err, Result } from './src/index.ts';

function validateOrder(o: {id: string; amount: number}): Result<{id: string; amount: number}, string> {
  if (o.amount <= 0) return err('non_positive:' + o.id);
  return ok(o);
}

export async function run(ordersPath: string, feeUrl: string, outPath: string) {
  const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8')) as Array<{id: string; amount: number}>;
  const resp = await fetch(feeUrl);
  const { feeBps } = await resp.json() as { feeBps: number };
  const combined = Result.combine(orders.map(validateOrder));
  let report: any;
  if (combined.isOk()) {
    const gross = combined.value.reduce((s, o) => s + o.amount, 0);
    const fee = Math.round((gross * feeBps) / 10000);
    report = { settled: true, count: combined.value.length, gross, fee, net: gross - fee };
  } else {
    console.error('order rejected:', combined.error);
    report = { settled: false, reason: combined.error };
  }
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/orders.json', `${baseUrl}/fee`, '/workspace/settlement.json'],
    {
      label: 'valid_orders_settled',
      files: {'orders.json': JSON.stringify([{id: 'o1', amount: 1000}, {id: 'o2', amount: 2500}])},
      env: {},
      httpRoutes: {'/fee': {status: 200, body: JSON.stringify({feeBps: 250})}},
    },
    {
      label: 'negative_order_rejected',
      files: {'orders.json': JSON.stringify([{id: 'o1', amount: 1000}, {id: 'o2', amount: -50}])},
      env: {},
      httpRoutes: {'/fee': {status: 200, body: JSON.stringify({feeBps: 250})}},
    },
    ['typescript', 'fs-io', 'http-io', 'console']);

  // 16. unjs/std-env (TS) — runtime CI/provider detection + shell.exec git status!
  r = await loadRepo('unjs__std-env', ['src']);
  addStatefulPair(r, 'stdenv_ci_git_gate', 'ci_gate.ts', `import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isCI, isDebug, provider } from './src/index.ts';

export function run(outPath: string) {
  const gitStatus = execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim();
  const dirtyFiles = gitStatus ? gitStatus.split('\\n').length : 0;
  const blocked = isCI && dirtyFiles > 0;
  if (blocked) console.error('CI release blocked by dirty worktree:', dirtyFiles);
  const report = { isCI, isDebug, provider, dirtyFiles, blocked };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/ci_gate.json'],
    {
      label: 'ci_dirty_blocked',
      files: {'README.md': 'v1\n'},
      initGit: true,
      postGitWrites: {'untracked.tmp': 'dirty'},
      env: {CI: 'true', GITHUB_ACTIONS: 'true'},
    },
    {
      label: 'local_clean_allowed',
      files: {'README.md': 'v1\n'},
      initGit: true,
      env: {DEBUG: '1'},
    },
    ['typescript', 'fs-io', 'env-io', 'shell-io', 'console']);

  // 17. unjs/destr (TS) — safely deserialize raw HTTP + local cache payloads
  r = await loadRepo('unjs__destr', ['src']);
  addStatefulPair(r, 'destr_payload_normalizer', 'normalize_cfg.ts', `import * as fs from 'node:fs';
import { destr } from './src/index.ts';

export async function run(apiUrl: string, cachePath: string, outPath: string) {
  const resp = await fetch(apiUrl);
  const rawText = await resp.text();
  const parsed = destr<any>(rawText);
  const cached = fs.existsSync(cachePath) ? destr<any>(fs.readFileSync(cachePath, 'utf8')) : {};
  const merged = typeof parsed === 'object' && parsed !== null
    ? { source: 'object', retries: parsed.retries ?? cached.retries ?? 3, debug: Boolean(parsed.debug) }
    : { source: typeof parsed, rawValue: parsed, retries: cached.retries ?? 3 };
  fs.writeFileSync(outPath, JSON.stringify(merged), 'utf8');
  return merged;
}
`, 'run', [`${baseUrl}/raw-cfg`, '/workspace/cache.txt', '/workspace/normalized.json'],
    {
      label: 'json_object_payload',
      files: {'cache.txt': '{"retries":5}'},
      env: {},
      httpRoutes: {'/raw-cfg': {status: 200, headers: {'content-type': 'text/plain'}, body: '{"retries":2,"debug":true}'}},
    },
    {
      label: 'primitive_boolean_payload',
      files: {'cache.txt': '{"retries":5}'},
      env: {},
      httpRoutes: {'/raw-cfg': {status: 200, headers: {'content-type': 'text/plain'}, body: 'true'}},
    },
    ['typescript', 'http-io', 'fs-io']);

  // 18. nodeca/pako (TS) — deflate & inflate workspace file + verify ratio
  r = await loadRepo('nodeca__pako', ['src'], {renameMjsToJs: true});
  addStatefulPair(r, 'pako_log_compressor', 'compress_log.ts', `import * as fs from 'node:fs';
import { deflate, inflate } from './src/index.ts';

export function run(inPath: string, outPath: string) {
  const text = fs.readFileSync(inPath, 'utf8');
  const level = Number(process.env.ZLIB_LEVEL || 6) as any;
  const compressed = deflate(text, { level });
  const restored = inflate(compressed, { to: 'string' });
  const savedBytes = text.length - compressed.length;
  const report = {
    inputLen: text.length,
    compressedLen: compressed.length,
    savedBytes,
    worthCompressing: savedBytes > 0,
    roundtripOk: restored === text,
  };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/app.log', '/workspace/compress_report.json'],
    {label: 'repetitive_log', files: {'app.log': 'INFO request_ok status=200 latency=12ms route=/api/v1/health\n'.repeat(12)}, env: {ZLIB_LEVEL: '6'}},
    {label: 'tiny_log', files: {'app.log': 'ok'}, env: {ZLIB_LEVEL: '1'}},
    ['typescript', 'fs-io', 'env-io']);

  // 19. sindresorhus/is (TS) — runtime type-guard payload inspector over FS + HTTP
  r = await loadRepo('sindresorhus__is', ['source']);
  addStatefulPair(r, 'sindresorhus_is_payload_audit', 'inspect_payload.ts', `import * as fs from 'node:fs';
import is from './source/index.ts';

export async function run(apiUrl: string, outPath: string) {
  const resp = await fetch(apiUrl);
  const data = await resp.json();
  const checks = {
    isPlainObject: is.plainObject(data),
    hasArrayItems: is.plainObject(data) && is.array((data as any).items),
    allStrings: is.plainObject(data) && is.array((data as any).items) && (data as any).items.every((x: unknown) => is.nonEmptyString(x)),
    hasNumericVersion: is.plainObject(data) && is.safeInteger((data as any).version),
  };
  const passed = checks.isPlainObject && checks.hasArrayItems && checks.allStrings && checks.hasNumericVersion;
  const report = { passed, checks };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', [`${baseUrl}/catalog`, '/workspace/type_audit.json'],
    {
      label: 'valid_catalog',
      files: {'.keep': ''},
      env: {},
      httpRoutes: {'/catalog': {status: 200, body: JSON.stringify({version: 3, items: ['alpha', 'beta', 'gamma']})}},
    },
    {
      label: 'malformed_catalog',
      files: {'.keep': ''},
      env: {},
      httpRoutes: {'/catalog': {status: 200, body: JSON.stringify({version: '3', items: ['alpha', '']})}},
    },
    ['typescript', 'http-io', 'fs-io']);

  // 20. formkit/tempo (TS) — billing cycle & deadline calculator from FS + Date.now + env
  r = await loadRepo('formkit__tempo', ['src']);
  addStatefulPair(r, 'tempo_invoice_due_dates', 'invoice_dates.ts', `import * as fs from 'node:fs';
import { addDay, format, isAfter } from './src/index.ts';

export function run(invoicesPath: string, outPath: string) {
  const now = new Date(Date.now());
  const graceDays = Number(process.env.GRACE_DAYS || 7);
  const invoices = JSON.parse(fs.readFileSync(invoicesPath, 'utf8')) as Array<{id: string; issued: string; netDays: number}>;
  const evaluated = invoices.map(inv => {
    const due = addDay(new Date(inv.issued), inv.netDays + graceDays);
    const overdue = isAfter(now, due);
    return { id: inv.id, dueDate: format(due, 'YYYY-MM-DD', 'en'), overdue };
  });
  const overdueCount = evaluated.filter(e => e.overdue).length;
  const report = { graceDays, overdueCount, evaluated };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/invoices.json', '/workspace/due_report.json'],
    {
      label: 'short_grace_overdue',
      files: {'invoices.json': JSON.stringify([{id: 'INV-1', issued: '2024-10-15T00:00:00Z', netDays: 30}, {id: 'INV-2', issued: '2024-11-10T00:00:00Z', netDays: 30}])},
      env: {GRACE_DAYS: '0'},
    },
    {
      label: 'long_grace_current',
      files: {'invoices.json': JSON.stringify([{id: 'INV-1', issued: '2024-10-15T00:00:00Z', netDays: 30}, {id: 'INV-2', issued: '2024-11-10T00:00:00Z', netDays: 30}])},
      env: {GRACE_DAYS: '15'},
    },
    ['typescript', 'fs-io', 'env-io', 'date-now']);

  // 21. natemoo-re/ultrahtml (TS) — HTML AST sanitizer & link extractor over workspace FS
  r = await loadRepo('natemoo-re__ultrahtml', ['src']);
  addStatefulPair(r, 'ultrahtml_markdown_sanitizer', 'sanitize_html.ts', `import * as fs from 'node:fs';
import { parse, walkSync, renderSync, ELEMENT_NODE } from './src/index.ts';

export function run(htmlPath: string, outPath: string) {
  const raw = fs.readFileSync(htmlPath, 'utf8');
  const ast = parse(raw);
  const links: string[] = [];
  let stripped = 0;
  walkSync(ast, (node: any, parent: any, idx: number) => {
    if (node.type === ELEMENT_NODE && node.name === 'a' && node.attributes?.href) {
      links.push(node.attributes.href);
    }
    if (node.type === ELEMENT_NODE && node.name === 'script' && parent?.children) {
      parent.children.splice(idx, 1);
      stripped++;
    }
  });
  const cleanHtml = renderSync(ast);
  if (stripped > 0) console.warn('stripped script tags:', stripped);
  fs.writeFileSync(outPath, cleanHtml, 'utf8');
  return { links, stripped, cleanLength: cleanHtml.length };
}
`, 'run', ['/workspace/page.html', '/workspace/clean.html'],
    {label: 'xss_stripped', files: {'page.html': '<article><a href="https://docs.example.com">Docs</a><script>alert(1)</script><p>Safe</p></article>'}, env: {}},
    {label: 'clean_article', files: {'page.html': '<article><a href="https://a.test">A</a><a href="https://b.test">B</a><p>Hello</p></article>'}, env: {}},
    ['typescript', 'fs-io', 'console']);

  // 22. m93a/filtrex (JS/ESM) — rule expression evaluator over FS rules + live HTTP metrics
  r = await loadRepo('m93a__filtrex', ['src'], {renameMjsToJs: true});
  addStatefulPair(r, 'filtrex_alert_evaluator', 'eval_alerts.js', `import * as fs from 'node:fs';
import { compileExpression } from './src/filtrex.js';

export async function run(rulesPath, metricsUrl, outPath) {
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const resp = await fetch(metricsUrl);
  const metrics = await resp.json();
  const fired = [];
  for (const rule of rules) {
    const fn = compileExpression(rule.expr);
    if (fn(metrics)) fired.push(rule.name);
  }
  const report = { metrics, firedCount: fired.length, fired };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/rules.json', `${baseUrl}/metrics`, '/workspace/alerts.json'],
    {
      label: 'alerts_fired',
      files: {'rules.json': JSON.stringify([{name: 'high_cpu', expr: 'cpu > 80 and errors >= 5'}, {name: 'mem_warn', expr: 'mem > 90'}])},
      env: {},
      httpRoutes: {'/metrics': {status: 200, body: JSON.stringify({cpu: 92, errors: 8, mem: 64})}},
    },
    {
      label: 'all_healthy',
      files: {'rules.json': JSON.stringify([{name: 'high_cpu', expr: 'cpu > 80 and errors >= 5'}, {name: 'mem_warn', expr: 'mem > 90'}])},
      env: {},
      httpRoutes: {'/metrics': {status: 200, body: JSON.stringify({cpu: 42, errors: 1, mem: 55})}},
    },
    ['http-io', 'fs-io']);

  // 23. paulmillr/noble-ciphers (TS) — authenticated encryption/decryption of workspace secret file
  r = await loadRepo('paulmillr__noble-ciphers', ['src']);
  addStatefulPair(r, 'nobleciphers_chacha_vault', 'seal_secret.ts', `import * as fs from 'node:fs';
import { chacha20poly1305 } from './src/chacha.ts';

export function run(plainPath: string, outPath: string) {
  const plain = fs.readFileSync(plainPath, 'utf8');
  const keySeed = (process.env.VAULT_KEY || '0123456789abcdef0123456789abcdef').slice(0, 32).padEnd(32, '0');
  const key = new TextEncoder().encode(keySeed);
  const nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const cipher = chacha20poly1305(key, nonce);
  const sealed = cipher.encrypt(new TextEncoder().encode(plain));
  const opened = new TextDecoder().decode(cipher.decrypt(sealed));
  const hexHead = Array.from(sealed.slice(0, 6)).map(b => b.toString(16).padStart(2, '0')).join('');
  const out = { sealedLen: sealed.length, hexHead, roundtripOk: opened === plain };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/secret.txt', '/workspace/vault.json'],
    {label: 'key_alpha', files: {'secret.txt': 'db_pass=s3cr3t-alpha'}, env: {VAULT_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}},
    {label: 'key_beta', files: {'secret.txt': 'db_pass=s3cr3t-alpha'}, env: {VAULT_KEY: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}},
    ['typescript', 'fs-io', 'env-io']);

  // 24. Starcounter-Jack/JSON-Patch (TS) — apply RFC-6902 patch from HTTP onto FS document
  r = await loadRepo('Starcounter-Jack__JSON-Patch', ['src']);
  addStatefulPair(r, 'jsonpatch_doc_updater', 'apply_patch.ts', `import * as fs from 'node:fs';
import { applyPatch, validate } from './src/core.ts';

export async function run(docPath: string, patchUrl: string, outPath: string) {
  const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
  const resp = await fetch(patchUrl);
  const ops = await resp.json();
  const validationErr = validate(ops, doc);
  if (validationErr) {
    console.warn('invalid json patch:', validationErr.name);
    const fail = { applied: false, error: validationErr.name };
    fs.writeFileSync(outPath, JSON.stringify(fail), 'utf8');
    return fail;
  }
  const patched = applyPatch(doc, ops, true, false).newDocument;
  fs.writeFileSync(outPath, JSON.stringify(patched), 'utf8');
  return { applied: true, doc: patched };
}
`, 'run', ['/workspace/profile.json', `${baseUrl}/patch`, '/workspace/profile_next.json'],
    {
      label: 'valid_patch',
      files: {'profile.json': JSON.stringify({name: 'Ada', tier: 'starter', quotas: {api: 100}})},
      env: {},
      httpRoutes: {'/patch': {status: 200, body: JSON.stringify([{op: 'replace', path: '/tier', value: 'pro'}, {op: 'add', path: '/quotas/workers', value: 8}])}},
    },
    {
      label: 'invalid_test_op',
      files: {'profile.json': JSON.stringify({name: 'Ada', tier: 'starter', quotas: {api: 100}})},
      env: {},
      httpRoutes: {'/patch': {status: 200, body: JSON.stringify([{op: 'replace', path: '/nonexistent/deep', value: 1}])}},
    },
    ['typescript', 'fs-io', 'http-io', 'console']);

  // 25. unjs/uqr (TS) — generate QR matrix from FS URL + env error correction level
  r = await loadRepo('unjs__uqr', ['src']);
  addStatefulPair(r, 'uqr_ticket_matrix', 'make_qr.ts', `import * as fs from 'node:fs';
import { encode } from './src/index.ts';

export function run(ticketPath: string, outPath: string) {
  const payload = fs.readFileSync(ticketPath, 'utf8').trim();
  const ecc = (process.env.QR_ECC || 'M') as 'L' | 'M' | 'Q' | 'H';
  const qr = encode(payload, { ecc });
  let darkModules = 0;
  for (const row of qr.data) for (const cell of row) if (cell) darkModules++;
  const res = { size: qr.size, ecc, darkModules };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`, 'run', ['/workspace/ticket.txt', '/workspace/qr_stats.json'],
    {label: 'ecc_low', files: {'ticket.txt': 'https://tickets.example.org/t/987654'}, env: {QR_ECC: 'L'}},
    {label: 'ecc_high', files: {'ticket.txt': 'https://tickets.example.org/t/987654'}, env: {QR_ECC: 'H'}},
    ['typescript', 'fs-io', 'env-io']);

  // 26. EricSmekens/jsep (JS) — parse formula config from FS + check AST operator allowlist
  r = await loadRepo('EricSmekens__jsep', ['src']);
  addStatefulPair(r, 'jsep_formula_linter', 'lint_formulas.js', `import * as fs from 'node:fs';
import jsep from './src/jsep.js';

function collectOps(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') out.add(node.operator);
  if (node.type === 'CallExpression') out.add('CALL');
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(c => collectOps(c, out));
    else if (v && typeof v === 'object') collectOps(v, out);
  }
}

export function run(formulasPath, outPath) {
  const formulas = JSON.parse(fs.readFileSync(formulasPath, 'utf8'));
  const allowCalls = process.env.ALLOW_CALLS === '1';
  const results = formulas.map(f => {
    const ast = jsep(f.expr);
    const ops = new Set();
    collectOps(ast, ops);
    const allowed = allowCalls || !ops.has('CALL');
    return { name: f.name, rootType: ast.type, ops: [...ops].sort(), allowed };
  });
  fs.writeFileSync(outPath, JSON.stringify(results), 'utf8');
  return { allowCalls, allAllowed: results.every(r => r.allowed), results };
}
`, 'run', ['/workspace/formulas.json', '/workspace/lint.json'],
    {label: 'calls_blocked', files: {'formulas.json': JSON.stringify([{name: 'margin', expr: '(rev - cost) / rev'}, {name: 'cap', expr: 'min(x, 100)'}])}, env: {ALLOW_CALLS: '0'}},
    {label: 'calls_allowed', files: {'formulas.json': JSON.stringify([{name: 'margin', expr: '(rev - cost) / rev'}, {name: 'cap', expr: 'min(x, 100)'}])}, env: {ALLOW_CALLS: '1'}},
    ['fs-io', 'env-io']);

  // 27. silentmatt/expr-eval (JS) — evaluate pricing table from FS + fetched exchange rate
  r = await loadRepo('silentmatt__expr-eval', ['src', 'index.js']);
  addStatefulPair(r, 'expreval_pricing_engine', 'price_calc.js', `import * as fs from 'node:fs';
import { Parser } from './index.js';

export async function run(planPath, rateUrl, outPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const resp = await fetch(rateUrl);
  const { fxRate } = await resp.json();
  const parser = new Parser();
  const expr = parser.parse(plan.formula);
  const usd = expr.evaluate(plan.vars);
  const local = Math.round(usd * fxRate * 100) / 100;
  const out = { plan: plan.name, usd, fxRate, local };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/plan.json', `${baseUrl}/fx`, '/workspace/quote.json'],
    {
      label: 'eur_rate',
      files: {'plan.json': JSON.stringify({name: 'team', formula: 'base + max(0, seats - 5) * perSeat', vars: {base: 49, seats: 12, perSeat: 9}})},
      env: {},
      httpRoutes: {'/fx': {status: 200, body: JSON.stringify({fxRate: 0.92})}},
    },
    {
      label: 'gbp_rate',
      files: {'plan.json': JSON.stringify({name: 'team', formula: 'base + max(0, seats - 5) * perSeat', vars: {base: 49, seats: 12, perSeat: 9}})},
      env: {},
      httpRoutes: {'/fx': {status: 200, body: JSON.stringify({fxRate: 0.79})}},
    },
    ['fs-io', 'http-io']);

  // 28. hjson/hjson-js (JS) — parse human-friendly HJSON config from FS + env overlay
  r = await loadRepo('hjson__hjson-js', ['lib']);
  addStatefulPair(r, 'hjson_config_loader', 'load_hjson.js', `const fs = require('fs');
const Hjson = require('./lib/hjson.js');

function run(cfgPath, outPath) {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = Hjson.parse(raw);
  const region = process.env.DEPLOY_REGION || cfg.defaultRegion || 'us-east';
  const endpoint = (cfg.regions && cfg.regions[region]) || cfg.fallbackEndpoint;
  const out = { app: cfg.app, region, endpoint, tags: cfg.tags || [] };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
module.exports = { run };
`, 'run', ['/workspace/service.hjson', '/workspace/resolved_cfg.json'],
    {
      label: 'eu_region_env',
      files: {'service.hjson': '{\n  # service config\n  app: payments\n  defaultRegion: us-east\n  fallbackEndpoint: "https://fb.internal"\n  regions: {\n    us-east: "https://us.internal"\n    eu-west: "https://eu.internal"\n  }\n  tags: [\n    core\n    pci\n  ]\n}\n'},
      env: {DEPLOY_REGION: 'eu-west'},
    },
    {
      label: 'unknown_region_fallback',
      files: {'service.hjson': '{\n  # service config\n  app: payments\n  defaultRegion: us-east\n  fallbackEndpoint: "https://fb.internal"\n  regions: {\n    us-east: "https://us.internal"\n    eu-west: "https://eu.internal"\n  }\n  tags: [\n    core\n    pci\n  ]\n}\n'},
      env: {DEPLOY_REGION: 'ap-south'},
    },
    ['fs-io', 'env-io']);

  // 29. vanillaes/csv (JS) — parse CSV ledger from FS, filter by env threshold, write CSV report
  r = await loadRepo('vanillaes__csv', ['src']);
  addStatefulPair(r, 'vanillaes_csv_ledger_filter', 'filter_csv.js', `import * as fs from 'node:fs';
import { parse, stringify } from './src/index.js';

export function run(csvPath, outPath) {
  const rows = parse(fs.readFileSync(csvPath, 'utf8'));
  const minAmount = Number(process.env.MIN_AMOUNT || 100);
  const header = rows[0];
  const kept = rows.slice(1).filter(r => Number(r[2]) >= minAmount);
  const outCsv = stringify([header, ...kept]);
  fs.writeFileSync(outPath, outCsv, 'utf8');
  return { totalRows: rows.length - 1, keptRows: kept.length, minAmount, ids: kept.map(r => r[0]) };
}
`, 'run', ['/workspace/tx.csv', '/workspace/high_tx.csv'],
    {label: 'threshold_100', files: {'tx.csv': 'id,merchant,amount\nt1,Cafe,45\nt2,Cloud,280\nt3,Flight,620\n'}, env: {MIN_AMOUNT: '100'}},
    {label: 'threshold_500', files: {'tx.csv': 'id,merchant,amount\nt1,Cafe,45\nt2,Cloud,280\nt3,Flight,620\n'}, env: {MIN_AMOUNT: '500'}},
    ['fs-io', 'env-io']);

  // 30. dagrejs/graphlib (TS) — topological build-order planner from FS workspace package graph
  r = await loadRepo('dagrejs__graphlib', ['lib', 'index.ts']);
  addStatefulPair(r, 'graphlib_build_planner', 'plan_build.ts', `import * as fs from 'node:fs';
import { Graph, alg } from './lib/index.ts';

export function run(depsPath: string, outPath: string) {
  const spec = JSON.parse(fs.readFileSync(depsPath, 'utf8')) as {packages: string[]; edges: Array<[string, string]>};
  const g = new Graph();
  for (const pkg of spec.packages) g.setNode(pkg);
  for (const [from, to] of spec.edges) g.setEdge(from, to);
  const acyclic = alg.isAcyclic(g);
  let plan: any;
  if (acyclic) {
    plan = { acyclic: true, order: alg.topsort(g) };
  } else {
    const cycles = alg.findCycles(g);
    console.error('dependency cycle detected:', cycles.length);
    plan = { acyclic: false, cycles };
  }
  fs.writeFileSync(outPath, JSON.stringify(plan), 'utf8');
  return plan;
}
`, 'run', ['/workspace/graph.json', '/workspace/build_plan.json'],
    {
      label: 'acyclic_dag',
      files: {'graph.json': JSON.stringify({packages: ['core', 'utils', 'cli', 'web'], edges: [['utils', 'core'], ['core', 'cli'], ['core', 'web']]})},
      env: {},
    },
    {
      label: 'cyclic_graph_rejected',
      files: {'graph.json': JSON.stringify({packages: ['core', 'utils', 'cli'], edges: [['utils', 'core'], ['core', 'cli'], ['cli', 'utils']]})},
      env: {},
    },
    ['typescript', 'fs-io', 'console']);

  // 30b. lukeed/qss (JS) — parse & rebuild HTTP query strings from FS + env filter
  r = await loadRepo('lukeed__qss', ['src']);
  addStatefulPair(r, 'qss_query_sanitizer', 'sanitize_qs.js', `import * as fs from 'node:fs';
import { decode, encode } from './src/index.js';

export function run(qsPath, outPath) {
  const raw = fs.readFileSync(qsPath, 'utf8').trim();
  const stripTracking = process.env.STRIP_UTM === '1';
  const obj = decode(raw);
  if (stripTracking) {
    for (const k of Object.keys(obj)) {
      if (k.startsWith('utm_')) delete obj[k];
    }
  }
  const clean = encode(obj, '?');
  const res = { stripTracking, keys: Object.keys(obj).sort(), clean };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`, 'run', ['/workspace/query.txt', '/workspace/clean_qs.json'],
    {label: 'strip_utm_on', files: {'query.txt': 'page=2&sort=asc&utm_source=email&utm_campaign=fall'}, env: {STRIP_UTM: '1'}},
    {label: 'strip_utm_off', files: {'query.txt': 'page=2&sort=asc&utm_source=email&utm_campaign=fall'}, env: {STRIP_UTM: '0'}},
    ['fs-io', 'env-io']);

  // 30c. lukeed/flru (JS) — LRU cache simulation over workspace FS access log + env capacity
  r = await loadRepo('lukeed__flru', ['src']);
  addStatefulPair(r, 'flru_cache_replay', 'replay_lru.js', `import * as fs from 'node:fs';
import flru from './src/index.js';

export function run(logPath, outPath) {
  const ops = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const maxItems = Number(process.env.CACHE_CAP || 2);
  const cache = flru(maxItems);
  let hits = 0;
  let misses = 0;
  for (const op of ops) {
    if (op.type === 'set') cache.set(op.key, op.val);
    else if (op.type === 'get') {
      if (cache.get(op.key) !== undefined) hits++;
      else misses++;
    }
  }
  const report = { maxItems, hits, misses, hitRate: Math.round((hits / Math.max(1, hits + misses)) * 100) };
  fs.writeFileSync(outPath, JSON.stringify(report), 'utf8');
  return report;
}
`, 'run', ['/workspace/access.json', '/workspace/cache_stats.json'],
    {
      label: 'small_cap_evicts',
      files: {'access.json': JSON.stringify([{type: 'set', key: 'a', val: 1}, {type: 'set', key: 'b', val: 2}, {type: 'set', key: 'c', val: 3}, {type: 'set', key: 'd', val: 4}, {type: 'set', key: 'e', val: 5}, {type: 'get', key: 'a'}, {type: 'get', key: 'e'}])},
      env: {CACHE_CAP: '2'},
    },
    {
      label: 'large_cap_hits',
      files: {'access.json': JSON.stringify([{type: 'set', key: 'a', val: 1}, {type: 'set', key: 'b', val: 2}, {type: 'set', key: 'c', val: 3}, {type: 'set', key: 'd', val: 4}, {type: 'set', key: 'e', val: 5}, {type: 'get', key: 'a'}, {type: 'get', key: 'e'}])},
      env: {CACHE_CAP: '8'},
    },
    ['fs-io', 'env-io']);

  // 30d. lukeed/rosetta (JS) — i18n message renderer from FS locale bundles + env locale
  r = await loadRepo('lukeed__rosetta', ['src']);
  addStatefulPair(r, 'rosetta_email_localizer', 'localize_email.js', `import * as fs from 'node:fs';
import rosetta from './src/index.js';

export function run(bundlesPath, outPath) {
  const bundles = JSON.parse(fs.readFileSync(bundlesPath, 'utf8'));
  const lang = process.env.USER_LOCALE || 'en';
  const i18n = rosetta(bundles);
  i18n.locale(lang);
  const subject = i18n.t('welcome.subject', { name: 'Ada' });
  const cta = i18n.t('welcome.cta');
  const out = { lang, subject, cta };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/i18n.json', '/workspace/email.json'],
    {
      label: 'locale_en',
      files: {'i18n.json': JSON.stringify({en: {welcome: {subject: 'Welcome, {{name}}!', cta: 'Get Started'}}, es: {welcome: {subject: 'Bienvenida, {{name}}!', cta: 'Comenzar'}}})},
      env: {USER_LOCALE: 'en'},
    },
    {
      label: 'locale_es',
      files: {'i18n.json': JSON.stringify({en: {welcome: {subject: 'Welcome, {{name}}!', cta: 'Get Started'}}, es: {welcome: {subject: 'Bienvenida, {{name}}!', cta: 'Comenzar'}}})},
      env: {USER_LOCALE: 'es'},
    },
    ['fs-io', 'env-io']);

  // 30e. jridgewell/resolve-uri (TS) — resolve relative asset URLs from FS manifest + env base CDN
  r = await loadRepo('jridgewell__resolve-uri', ['src']);
  addStatefulPair(r, 'resolveuri_cdn_rewriter', 'rewrite_cdn.ts', `import * as fs from 'node:fs';
import resolveUri from './src/resolve-uri.ts';

export function run(manifestPath: string, outPath: string) {
  const assets = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as string[];
  const baseUrl = process.env.CDN_BASE || 'https://cdn.example.com/v1/assets/';
  const resolved = assets.map(a => resolveUri(a, baseUrl));
  const out = { baseUrl, count: resolved.length, resolved };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/assets.json', '/workspace/cdn_urls.json'],
    {label: 'prod_cdn', files: {'assets.json': JSON.stringify(['./app.js', '../fonts/inter.woff2', '/favicon.ico'])}, env: {CDN_BASE: 'https://cdn.prod.test/v2/js/'}},
    {label: 'staging_cdn', files: {'assets.json': JSON.stringify(['./app.js', '../fonts/inter.woff2', '/favicon.ico'])}, env: {CDN_BASE: 'https://stage.test/preview/js/'}},
    ['typescript', 'fs-io', 'env-io']);

  // 30f. lukeed/klona (JS) — snapshot clone & mutation-isolation validator over FS + HTTP
  r = await loadRepo('lukeed__klona', ['src']);
  addStatefulPair(r, 'klona_snapshot_diff', 'snapshot_clone.js', `import * as fs from 'node:fs';
import { klona } from './src/index.js';

export async function run(statePath, patchUrl, outPath) {
  const original = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const draft = klona(original);
  const resp = await fetch(patchUrl);
  const patch = await resp.json();
  draft.settings.theme = patch.theme;
  draft.flags.push(patch.flag);
  const isolated = original.settings.theme !== draft.settings.theme && original.flags.length !== draft.flags.length;
  const out = { isolated, originalTheme: original.settings.theme, draftTheme: draft.settings.theme, draftFlags: draft.flags };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/state.json', `${baseUrl}/ui-patch`, '/workspace/snapshot.json'],
    {
      label: 'dark_patch',
      files: {'state.json': JSON.stringify({settings: {theme: 'light'}, flags: ['core']})},
      env: {},
      httpRoutes: {'/ui-patch': {status: 200, body: JSON.stringify({theme: 'dark', flag: 'beta-grid'})}},
    },
    {
      label: 'contrast_patch',
      files: {'state.json': JSON.stringify({settings: {theme: 'light'}, flags: ['core']})},
      env: {},
      httpRoutes: {'/ui-patch': {status: 200, body: JSON.stringify({theme: 'high-contrast', flag: 'a11y'})}},
    },
    ['fs-io', 'http-io']);

  // 30g. sindresorhus/pretty-ms (JS) — format job duration telemetry from FS + env compact mode
  r = await loadRepo('sindresorhus__pretty-ms', ['index.js']);
  addStatefulPair(r, 'prettyms_job_report', 'format_durations.js', `import * as fs from 'node:fs';
import prettyMs from './index.js';

export function run(jobsPath, outPath) {
  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  const verbose = process.env.VERBOSE_TIME === '1';
  const formatted = jobs.map(j => ({ name: j.name, duration: prettyMs(j.ms, { verbose }) }));
  const out = { verbose, formatted };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/timings.json', '/workspace/timings_human.json'],
    {label: 'compact_mode', files: {'timings.json': JSON.stringify([{name: 'build', ms: 133700}, {name: 'test', ms: 4250}])}, env: {VERBOSE_TIME: '0'}},
    {label: 'verbose_mode', files: {'timings.json': JSON.stringify([{name: 'build', ms: 133700}, {name: 'test', ms: 4250}])}, env: {VERBOSE_TIME: '1'}},
    ['fs-io', 'env-io']);

  // 31. lukeed/dset + lukeed/klona (JS) — deep config merger + patcher over FS + env
  r = await loadRepo('lukeed__dset', ['src']);
  addStatefulPair(r, 'dset_nested_override', 'patch_nested.js', `import * as fs from 'node:fs';
import { dset } from './src/index.js';

export function run(cfgPath, outPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (process.env.SET_PATH && process.env.SET_VAL) {
    dset(cfg, process.env.SET_PATH, process.env.SET_VAL);
  }
  fs.writeFileSync(outPath, JSON.stringify(cfg), 'utf8');
  return cfg;
}
`, 'run', ['/workspace/app.json', '/workspace/app_out.json'],
    {label: 'override_db_host', files: {'app.json': JSON.stringify({db: {host: 'localhost', port: 5432}})}, env: {SET_PATH: 'db.host', SET_VAL: 'pg.prod.internal'}},
    {label: 'add_cache_url', files: {'app.json': JSON.stringify({db: {host: 'localhost', port: 5432}})}, env: {SET_PATH: 'cache.redis.url', SET_VAL: 'redis://edge:6379'}},
    ['fs-io', 'env-io']);

  // 32. sindresorhus/pretty-bytes (JS) — workspace directory size summary report
  r = await loadRepo('sindresorhus__pretty-bytes', ['index.js']);
  addStatefulPair(r, 'prettybytes_dir_usage', 'dir_usage.js', `import * as fs from 'node:fs';
import prettyBytes from './index.js';

export function run(dirPath, outPath) {
  const binary = process.env.BINARY_UNITS === '1';
  const entries = fs.readdirSync(dirPath).sort();
  let total = 0;
  const items = entries.map(name => {
    const st = fs.statSync(dirPath + '/' + name);
    total += st.size;
    return { name, bytes: st.size, human: prettyBytes(st.size, { binary }) };
  });
  const res = { binary, totalBytes: total, totalHuman: prettyBytes(total, { binary }), items };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`, 'run', ['/workspace/artifacts', '/workspace/usage.json'],
    {
      label: 'decimal_units',
      files: {'artifacts/bundle.js': 'x'.repeat(2400), 'artifacts/style.css': 'y'.repeat(1200)},
      env: {BINARY_UNITS: '0'},
    },
    {
      label: 'binary_units',
      files: {'artifacts/bundle.js': 'x'.repeat(2400), 'artifacts/style.css': 'y'.repeat(1200)},
      env: {BINARY_UNITS: '1'},
    },
    ['fs-io', 'env-io']);

  // ==================== PART 2B: BROWSER-DOM REAL OSS REPOS (12+ Brand-New Repos) ====================

  // 33. pmndrs/zustand (TS) — real Zustand vanilla store + DOM task board + localStorage + confirm + fetch
  r = await loadRepo('pmndrs__zustand', ['src/vanilla.ts', 'src/shallow.ts']);
  addBrowserPair(r, 'zustand_task_board_dom', 'app_zustand.ts', `import { createStore } from './src/vanilla.ts';

interface Task { id: string; title: string; done: boolean; }
interface BoardState {
  tasks: Task[];
  addTask: (t: Task) => void;
  clearCompleted: () => void;
}

export async function run(apiUrl: string) {
  const savedRaw = localStorage.getItem('board:tasks');
  const initialTasks: Task[] = savedRaw ? JSON.parse(savedRaw) : [];
  const store = createStore<BoardState>((set) => ({
    tasks: initialTasks,
    addTask: (t) => set((s) => ({ tasks: [...s.tasks, t] })),
    clearCompleted: () => set((s) => ({ tasks: s.tasks.filter(x => !x.done) })),
  }));

  const resp = await fetch(apiUrl);
  const incoming = await resp.json() as Task[];
  for (const t of incoming) store.getState().addTask(t);

  let cleared = false;
  if (store.getState().tasks.some(t => t.done) && confirm('Clear completed tasks?')) {
    store.getState().clearCompleted();
    cleared = true;
  }

  const root = document.getElementById('app')!;
  const ul = document.createElement('ul');
  for (const t of store.getState().tasks) {
    const li = document.createElement('li');
    li.setAttribute('data-id', t.id);
    li.textContent = (t.done ? '[x] ' : '[ ] ') + t.title;
    ul.appendChild(li);
  }
  root.appendChild(ul);
  localStorage.setItem('board:tasks', JSON.stringify(store.getState().tasks));
  return { cleared, remaining: store.getState().tasks.length, html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/tasks'],
    {
      label: 'confirm_clear_true',
      storage: {local: {'board:tasks': JSON.stringify([{id: 't1', title: 'Setup CI', done: true}])}},
      dialogs: {confirm: [true]},
      httpHandler: () => ({status: 200, body: [{id: 't2', title: 'Ship Wave 3', done: false}]}),
    },
    {
      label: 'confirm_clear_false',
      storage: {local: {'board:tasks': JSON.stringify([{id: 't1', title: 'Setup CI', done: true}])}},
      dialogs: {confirm: [false]},
      httpHandler: () => ({status: 200, body: [{id: 't2', title: 'Ship Wave 3', done: false}]}),
    },
    ['typescript', 'browser-storage', 'browser-dialog', 'http-io']);

  // 34. preactjs/signals (TS) — real @preact/signals-core reactive pricing UI in DOM + localStorage + fetch
  r = await loadRepo('preactjs__signals', ['packages/core/src']);
  addBrowserPair(r, 'preact_signals_cart_dom', 'app_signals.ts', `import { signal, computed, effect } from './packages/core/src/index.ts';

export async function run(ratesUrl: string) {
  const tier = localStorage.getItem('shop:tier') || 'standard';
  const resp = await fetch(ratesUrl);
  const { items, discount } = await resp.json() as { items: Array<{name: string; price: number}>; discount: number };

  const subtotal = signal(items.reduce((s, i) => s + i.price, 0));
  const rate = signal(tier === 'vip' ? discount : 0);
  const total = computed(() => Math.round(subtotal.value * (1 - rate.value)));

  const root = document.getElementById('app')!;
  const badge = document.createElement('div');
  badge.setAttribute('id', 'total-badge');
  root.appendChild(badge);

  let renders = 0;
  const dispose = effect(() => {
    renders++;
    badge.textContent = tier.toUpperCase() + ': $' + total.value;
  });
  dispose();

  localStorage.setItem('shop:lastTotal', String(total.value));
  return { tier, subtotal: subtotal.value, total: total.value, renders, badgeText: badge.textContent };
}
`, 'run', ['https://app.example.test/api/cart'],
    {
      label: 'vip_discount_tier',
      storage: {local: {'shop:tier': 'vip'}},
      httpHandler: () => ({status: 200, body: {items: [{name: 'Pro Plan', price: 100}, {name: 'Addon', price: 50}], discount: 0.2}}),
    },
    {
      label: 'standard_tier',
      storage: {local: {'shop:tier': 'standard'}},
      httpHandler: () => ({status: 200, body: {items: [{name: 'Pro Plan', price: 100}, {name: 'Addon', price: 50}], discount: 0.2}}),
    },
    ['typescript', 'browser-storage', 'http-io']);

  // 35. developit/mitt (TS) — real Mitt event bus bridging DOM events, sessionStorage auth, and notifications
  r = await loadRepo('developit__mitt', ['src']);
  addBrowserPair(r, 'mitt_notification_hub_dom', 'app_mitt.ts', `import mitt from './src/index.ts';

type Events = { notify: { level: string; text: string }; audit: string };

export async function run(feedUrl: string) {
  const role = sessionStorage.getItem('auth:role') || 'guest';
  const bus = mitt<Events>();
  const root = document.getElementById('app')!;
  const list = document.createElement('ul');
  root.appendChild(list);

  const delivered: string[] = [];
  bus.on('notify', (ev) => {
    if (ev.level === 'admin' && role !== 'admin') return;
    const li = document.createElement('li');
    li.textContent = '[' + ev.level + '] ' + ev.text;
    list.appendChild(li);
    delivered.push(ev.text);
  });

  const resp = await fetch(feedUrl);
  const alerts = await resp.json() as Array<{level: string; text: string}>;
  for (const a of alerts) bus.emit('notify', a);

  sessionStorage.setItem('notify:count', String(delivered.length));
  return { role, deliveredCount: delivered.length, delivered, html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/alerts'],
    {
      label: 'admin_sees_all',
      storage: {session: {'auth:role': 'admin'}},
      httpHandler: () => ({status: 200, body: [{level: 'info', text: 'Deploy green'}, {level: 'admin', text: 'Rotate KMS key'}]}),
    },
    {
      label: 'guest_filtered',
      storage: {session: {'auth:role': 'guest'}},
      httpHandler: () => ({status: 200, body: [{level: 'info', text: 'Deploy green'}, {level: 'admin', text: 'Rotate KMS key'}]}),
    },
    ['typescript', 'browser-storage', 'http-io']);

  // 36. jorgebucaran/superfine (JS) — real Superfine VDOM h() + patch() interactive coupon cart
  r = await loadRepo('jorgebucaran__superfine', ['index.js']);
  addBrowserPair(r, 'superfine_vdom_coupon_dom', 'app_superfine.js', `import { h, text, patch } from './index.js';

export function run() {
  const savedPrice = Number(localStorage.getItem('cart:price') || '120');
  const code = prompt('Enter promo code:', '');
  const off = code === 'SAVE25' ? 25 : 0;
  const finalPrice = Math.max(0, savedPrice - off);

  const root = document.getElementById('app');
  const vnode = h('section', { id: 'checkout' }, [
    h('h2', {}, text('Order Summary')),
    h('p', { id: 'price' }, text('Total: $' + finalPrice)),
    h('span', { id: 'promo' }, text(off > 0 ? 'Applied ' + code : 'No promo')),
  ]);
  patch(root, vnode);
  localStorage.setItem('cart:final', String(finalPrice));
  return { code, off, finalPrice, html: document.body.innerHTML };
}
`, 'run', [],
    {label: 'valid_promo_code', storage: {local: {'cart:price': '120'}}, dialogs: {prompt: ['SAVE25']}},
    {label: 'no_promo_code', storage: {local: {'cart:price': '120'}}, dialogs: {prompt: ['INVALID']}},
    ['browser-storage', 'browser-dialog']);

  // 37. redom/redom (JS) — real RE:DOM multi-file el() + mount() + list() table renderer
  r = await loadRepo('redom__redom', ['esm']);
  addBrowserPair(r, 'redom_leaderboard_dom', 'app_redom.js', `import { el, mount } from './esm/index.js';

export async function run(apiUrl) {
  const sortDir = localStorage.getItem('table:sort') || 'desc';
  const resp = await fetch(apiUrl);
  const rows = await resp.json();
  rows.sort((a, b) => sortDir === 'asc' ? a.score - b.score : b.score - a.score);

  const root = document.getElementById('app');
  const ul = el('ul.leaderboard', rows.map(r => el('li', r.name + ':' + r.score)));
  mount(root, ul);
  localStorage.setItem('table:top', rows[0]?.name || 'none');
  return { sortDir, order: rows.map(r => r.name), html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/scores'],
    {
      label: 'sort_desc',
      storage: {local: {'table:sort': 'desc'}},
      httpHandler: () => ({status: 200, body: [{name: 'Ada', score: 94}, {name: 'Linus', score: 88}, {name: 'Grace', score: 99}]}),
    },
    {
      label: 'sort_asc',
      storage: {local: {'table:sort': 'asc'}},
      httpHandler: () => ({status: 200, body: [{name: 'Ada', score: 94}, {name: 'Linus', score: 88}, {name: 'Grace', score: 99}]}),
    },
    ['browser-storage', 'http-io']);

  // 38. patrick-steele-idem/morphdom (JS) — live DOM morphing from fetched server fragment
  r = await loadRepo('patrick-steele-idem__morphdom', ['src']);
  addBrowserPair(r, 'morphdom_fragment_sync', 'app_morphdom.js', `import morphdom from './src/index.js';

export async function run(fragUrl) {
  const root = document.getElementById('app');
  const revBefore = localStorage.getItem('ui:rev') || 'v0';
  const resp = await fetch(fragUrl);
  let updated = false;
  const wrapper = document.createElement('div');
  wrapper.id = 'app';
  if (resp.status === 200) {
    const data = await resp.json();
    wrapper.innerHTML = data.html;
    morphdom(root, wrapper);
    localStorage.setItem('ui:rev', data.rev);
    updated = true;
  } else {
    wrapper.innerHTML = root.innerHTML + '<small data-cached="1">cached</small>';
    morphdom(root, wrapper);
    console.info('keeping cached revision:', revBefore);
  }
  return { updated, rev: localStorage.getItem('ui:rev') || revBefore, text: root.textContent.trim() };
}
`, 'run', ['https://app.example.test/api/fragment'],
    {
      label: 'morph_new_rev',
      initialHtml: '<!DOCTYPE html><html><body><div id="app"><h1>Old Banner</h1></div></body></html>',
      storage: {local: {'ui:rev': 'v1'}},
      httpHandler: () => ({status: 200, body: {rev: 'v2', html: '<h1>Live v2 Banner</h1><p>Synced</p>'}}),
    },
    {
      label: 'not_modified_304',
      initialHtml: '<!DOCTYPE html><html><body><div id="app"><h1>Old Banner</h1></div></body></html>',
      storage: {local: {'ui:rev': 'v1'}},
      httpHandler: () => ({status: 304, body: ''}),
    },
    ['browser-storage', 'http-io', 'console']);

  // 39. developit/vhtml (JS) — SSR hyperscript card list hydrating #app with dismissed filter
  r = await loadRepo('developit__vhtml', ['src']);
  addBrowserPair(r, 'vhtml_notice_cards_dom', 'app_vhtml.js', `import h from './src/vhtml.js';

export async function run(apiUrl) {
  const dismissedRaw = sessionStorage.getItem('notices:dismissed');
  const dismissed = new Set(dismissedRaw ? JSON.parse(dismissedRaw) : []);
  const resp = await fetch(apiUrl);
  const notices = await resp.json();
  const visible = notices.filter(n => !dismissed.has(n.id));

  const html = h('div', { class: 'notices' }, visible.map(n =>
    h('article', { 'data-id': n.id }, h('strong', null, n.title), ': ', n.body)
  ));
  const root = document.getElementById('app');
  root.innerHTML = html;
  sessionStorage.setItem('notices:visibleCount', String(visible.length));
  return { visibleIds: visible.map(n => n.id), html };
}
`, 'run', ['https://app.example.test/api/notices'],
    {
      label: 'one_dismissed',
      storage: {session: {'notices:dismissed': JSON.stringify(['n1'])}},
      httpHandler: () => ({status: 200, body: [{id: 'n1', title: 'Maintenance', body: 'Sunday'}, {id: 'n2', title: 'New API', body: 'v3 live'}]}),
    },
    {
      label: 'none_dismissed',
      storage: {session: {}},
      httpHandler: () => ({status: 200, body: [{id: 'n1', title: 'Maintenance', body: 'Sunday'}, {id: 'n2', title: 'New API', body: 'v3 live'}]}),
    },
    ['browser-storage', 'http-io']);

  // 40. developit/unistore (JS) — state store managing multi-step checkout + confirm + POST
  r = await loadRepo('developit__unistore', ['src']);
  addBrowserPair(r, 'unistore_checkout_dom', 'app_unistore.js', `import createStore from './src/index.js';

export async function run(submitUrl) {
  const draftRaw = sessionStorage.getItem('checkout:draft');
  const draft = draftRaw ? JSON.parse(draftRaw) : { item: 'starter', qty: 1 };
  const store = createStore({ ...draft, status: 'draft', orderId: null });

  const root = document.getElementById('app');
  const render = () => {
    const s = store.getState();
    root.innerHTML = '<div data-status="' + s.status + '">' + s.item + ' x' + s.qty + '</div>';
  };
  store.subscribe(render);
  render();

  if (confirm('Place order for ' + draft.item + '?')) {
    const resp = await fetch(submitUrl, { method: 'POST', body: JSON.stringify(draft) });
    const data = await resp.json();
    store.setState({ status: 'submitted', orderId: data.orderId });
    sessionStorage.removeItem('checkout:draft');
  } else {
    store.setState({ status: 'cancelled' });
  }
  return { state: store.getState(), html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/orders'],
    {
      label: 'order_confirmed',
      storage: {session: {'checkout:draft': JSON.stringify({item: 'pro-seat', qty: 3})}},
      dialogs: {confirm: [true]},
      httpHandler: () => ({status: 200, body: {orderId: 'ORD-778'}}),
    },
    {
      label: 'order_cancelled',
      storage: {session: {'checkout:draft': JSON.stringify({item: 'pro-seat', qty: 3})}},
      dialogs: {confirm: [false]},
      httpHandler: () => ({status: 200, body: {orderId: 'ORD-778'}}),
    },
    ['browser-storage', 'browser-dialog', 'http-io']);

  // 41. lukeed/regexparam (JS) — SPA router matching location.pathname + history.pushState + sessionStorage
  r = await loadRepo('lukeed__regexparam', ['src']);
  addBrowserPair(r, 'regexparam_spa_router_dom', 'app_router.js', `import { parse } from './src/index.js';

export function run(targetPath) {
  const role = sessionStorage.getItem('user:role') || 'viewer';
  const routes = [
    { name: 'admin-panel', auth: 'admin', compiled: parse('/admin/:section') },
    { name: 'project-view', auth: 'any', compiled: parse('/projects/:org/:repo') },
  ];

  history.pushState({ from: location.pathname }, '', targetPath);
  const current = location.pathname;
  let matched = { name: 'not-found', params: {} };
  for (const r of routes) {
    const m = r.compiled.pattern.exec(current);
    if (m) {
      if (r.auth === 'admin' && role !== 'admin') {
        matched = { name: 'forbidden', params: {} };
      } else {
        const params = {};
        r.compiled.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        matched = { name: r.name, params };
      }
      break;
    }
  }
  const root = document.getElementById('app');
  root.innerHTML = '<main data-route="' + matched.name + '">' + current + '</main>';
  localStorage.setItem('nav:lastRoute', matched.name);
  return { role, current, matched, html: root.innerHTML };
}
`, 'run', ['/admin/billing'],
    {label: 'admin_authorized', storage: {session: {'user:role': 'admin'}}},
    {label: 'viewer_forbidden', storage: {session: {'user:role': 'viewer'}}},
    ['browser-storage', 'browser-history']);

  // 42. ai/nanoevents (JS) — lightweight event emitter + DOM counter widget + localStorage
  r = await loadRepo('ai__nanoevents', ['index.js']);
  addBrowserPair(r, 'nanoevents_counter_dom', 'app_nanoevents.js', `import { createNanoEvents } from './index.js';

export function run(steps) {
  const emitter = createNanoEvents();
  let count = Number(localStorage.getItem('counter:val') || '0');
  const root = document.getElementById('app');
  const el = document.createElement('span');
  root.appendChild(el);

  const historyLog = [];
  emitter.on('delta', (d) => {
    count += d;
    el.textContent = 'Count=' + count;
    historyLog.push(count);
  });

  for (const s of steps) emitter.emit('delta', s);
  localStorage.setItem('counter:val', String(count));
  return { finalCount: count, historyLog, text: el.textContent };
}
`, 'run', [[2, 3, -1]],
    {label: 'from_zero', storage: {local: {'counter:val': '0'}}},
    {label: 'from_ten', storage: {local: {'counter:val': '10'}}},
    ['browser-storage']);

  // 43. nanojsx/nano (TS) — real NanoJSX h() + renderSSR() inside Browser DOM with fetch + localStorage
  r = await loadRepo('nanojsx__nano', ['src']);
  addBrowserPair(r, 'nanojsx_profile_card_dom', 'app_nanojsx.ts', `import { h, renderSSR } from './src/index.ts';

export async function run(profileUrl: string) {
  const theme = localStorage.getItem('pref:theme') || 'light';
  const resp = await fetch(profileUrl);
  const user = await resp.json() as { name: string; badges: string[] };

  const tree = h('section', { class: 'profile ' + theme },
    h('h1', null, user.name),
    h('ul', null, ...user.badges.map(b => h('li', null, b))),
  );
  const html = renderSSR(tree);
  const root = document.getElementById('app')!;
  root.innerHTML = html;
  localStorage.setItem('pref:lastUser', user.name);
  return { theme, badgeCount: user.badges.length, html };
}
`, 'run', ['https://app.example.test/api/me'],
    {
      label: 'dark_theme_profile',
      storage: {local: {'pref:theme': 'dark'}},
      httpHandler: () => ({status: 200, body: {name: 'Ada', badges: ['maintainer', 'ts-hero']}}),
    },
    {
      label: 'light_theme_profile',
      storage: {local: {'pref:theme': 'light'}},
      httpHandler: () => ({status: 200, body: {name: 'Grace', badges: ['founder']}}),
    },
    ['typescript', 'browser-storage', 'http-io']);

  // 44. formkit/tempo (TS) — Browser DOM event countdown widget using Date.now + localStorage locale
  r = await loadRepo('formkit__tempo', ['src']);
  addBrowserPair(r, 'tempo_event_banner_dom', 'app_tempo_dom.ts', `import { format, diffDays } from './src/index.ts';

export function run(eventIso: string) {
  const locale = localStorage.getItem('i18n:locale') || 'en';
  const now = new Date(Date.now());
  const eventDate = new Date(eventIso);
  const daysLeft = diffDays(eventDate, now);
  const formatted = format(eventDate, 'YYYY-MM-DD', locale);

  const root = document.getElementById('app')!;
  root.innerHTML = '<div data-locale="' + locale + '">' + formatted + ' (' + daysLeft + 'd)</div>';
  localStorage.setItem('event:lastDays', String(daysLeft));
  return { locale, formatted, daysLeft, html: root.innerHTML };
}
`, 'run', ['2024-12-01T00:00:00Z'],
    {label: 'ten_days_left', storage: {local: {'i18n:locale': 'en'}}, now: [Date.parse('2024-11-21T00:00:00Z')]},
    {label: 'two_days_left', storage: {local: {'i18n:locale': 'fr'}}, now: [Date.parse('2024-11-29T00:00:00Z')]},
    ['typescript', 'browser-storage', 'date-now']);

  // 45. natemoo-re/ultrahtml (TS) — Browser DOM untrusted preview sanitizer with fetch + console.warn
  r = await loadRepo('natemoo-re__ultrahtml', ['src']);
  addBrowserPair(r, 'ultrahtml_preview_dom', 'app_ultrahtml_dom.ts', `import { parse, walkSync, renderSync, ELEMENT_NODE } from './src/index.ts';

export async function run(snippetUrl: string) {
  const resp = await fetch(snippetUrl);
  const rawHtml = await resp.text();
  const ast = parse(rawHtml);
  let removed = 0;
  walkSync(ast, (node: any, parent: any, idx: number) => {
    if (node.type === ELEMENT_NODE && (node.name === 'script' || node.name === 'iframe') && parent?.children) {
      parent.children.splice(idx, 1);
      removed++;
    }
  });
  const safeHtml = renderSync(ast);
  if (removed > 0) console.warn('blocked unsafe elements:', removed);
  const root = document.getElementById('app')!;
  root.innerHTML = safeHtml;
  sessionStorage.setItem('preview:blocked', String(removed));
  return { removed, safeHtml };
}
`, 'run', ['https://app.example.test/api/snippet'],
    {
      label: 'unsafe_snippet_blocked',
      httpHandler: () => ({status: 200, headers: {'content-type': 'text/html'}, body: '<p>Hello</p><script>steal()</script><iframe src="x"></iframe>'}),
    },
    {
      label: 'clean_snippet',
      httpHandler: () => ({status: 200, headers: {'content-type': 'text/html'}, body: '<p>Welcome to <b>Wave 3</b></p>'}),
    },
    ['typescript', 'browser-storage', 'http-io', 'console']);

  // 46. dcastil/tailwind-merge (TS) — Browser DOM button class resolver from localStorage theme + fetch
  r = await loadRepo('dcastil__tailwind-merge', ['packages/tailwind-merge/src']);
  addBrowserPair(r, 'twmerge_button_dom', 'app_twmerge_dom.ts', `import { twMerge } from './packages/tailwind-merge/src/index.ts';

export async function run(themeUrl: string) {
  const density = localStorage.getItem('ui:density') || 'normal';
  const resp = await fetch(themeUrl);
  const { buttonOverride } = await resp.json() as { buttonOverride: string };
  const classes = twMerge('px-4 py-2 bg-slate-700 text-white rounded', buttonOverride, density === 'compact' ? 'px-2 py-1 text-xs' : '');

  const root = document.getElementById('app')!;
  const btn = document.createElement('button');
  btn.className = classes;
  btn.textContent = 'Save';
  root.appendChild(btn);
  localStorage.setItem('ui:lastBtnClass', classes);
  return { density, classes, html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/theme'],
    {
      label: 'compact_emerald',
      storage: {local: {'ui:density': 'compact'}},
      httpHandler: () => ({status: 200, body: {buttonOverride: 'bg-emerald-600 font-bold'}}),
    },
    {
      label: 'normal_amber',
      storage: {local: {'ui:density': 'normal'}},
      httpHandler: () => ({status: 200, body: {buttonOverride: 'bg-amber-500 text-black'}}),
    },
    ['typescript', 'browser-storage', 'http-io']);

  // 47. lucaong/minisearch (TS) — Browser DOM instant search widget with localStorage recent queries
  r = await loadRepo('lucaong__minisearch', ['src']);
  addBrowserPair(r, 'minisearch_instant_dom', 'app_minisearch_dom.ts', `import MiniSearch from './src/index.ts';

export async function run(indexUrl: string) {
  const query = prompt('Search docs:', 'routing') || '';
  const resp = await fetch(indexUrl);
  const docs = await resp.json() as Array<{id: number; title: string; tags: string}>;
  const ms = new MiniSearch({ fields: ['title', 'tags'], storeFields: ['title'] });
  ms.addAll(docs);
  const hits = ms.search(query, { prefix: true });

  const root = document.getElementById('app')!;
  const ul = document.createElement('ul');
  for (const h of hits) {
    const li = document.createElement('li');
    li.textContent = String(h.title);
    ul.appendChild(li);
  }
  root.appendChild(ul);
  localStorage.setItem('search:lastQuery', query);
  return { query, hitTitles: hits.map(h => h.title), html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/docs'],
    {
      label: 'query_routing',
      dialogs: {prompt: ['routing']},
      httpHandler: () => ({status: 200, body: [{id: 1, title: 'SPA Routing', tags: 'router nav'}, {id: 2, title: 'State Signals', tags: 'reactive'}]}),
    },
    {
      label: 'query_reactive',
      dialogs: {prompt: ['reactive']},
      httpHandler: () => ({status: 200, body: [{id: 1, title: 'SPA Routing', tags: 'router nav'}, {id: 2, title: 'State Signals', tags: 'reactive'}]}),
    },
    ['typescript', 'browser-storage', 'browser-dialog', 'http-io']);

  // 48. bradymholt/cRonstrue (TS) — Browser DOM cron preview widget with prompt + localStorage
  r = await loadRepo('bradymholt__cRonstrue', ['src']);
  addBrowserPair(r, 'cronstrue_preview_dom', 'app_cronstrue_dom.ts', `import { toString as describeCron } from './src/cronstrue.ts';

export function run() {
  const expr = prompt('Cron expression:', '0 9 * * 1-5') || '0 9 * * 1-5';
  const use24 = localStorage.getItem('clock:24h') === '1';
  const human = describeCron(expr, { use24HourTimeFormat: use24 });
  const root = document.getElementById('app')!;
  root.innerHTML = '<output id="cron-desc">' + human + '</output>';
  localStorage.setItem('cron:last', expr);
  return { expr, use24, human, html: root.innerHTML };
}
`, 'run', [],
    {label: 'weekday_morning_24h', storage: {local: {'clock:24h': '1'}}, dialogs: {prompt: ['0 9 * * 1-5']}},
    {label: 'nightly_midnight_12h', storage: {local: {'clock:24h': '0'}}, dialogs: {prompt: ['30 22 * * *']}},
    ['typescript', 'browser-storage', 'browser-dialog']);

  // 49. eta-dev/eta (TS) — Browser DOM client template renderer with fetch + localStorage (uses pure EtaCore)
  r = await loadRepo('eta-dev__eta', ['src']);
  addBrowserPair(r, 'eta_client_card_dom', 'app_eta_dom.ts', `import { EtaCore } from './src/core.ts';

export async function run(dataUrl: string) {
  const role = sessionStorage.getItem('user:role') || 'member';
  const resp = await fetch(dataUrl);
  const data = await resp.json() as { title: string; count: number };
  const eta = new EtaCore({ autoEscape: true });
  const html = eta.renderString('<div><h3><%= it.title %></h3><span><%= it.role %>:<%= it.count %></span></div>', { ...data, role });
  const root = document.getElementById('app')!;
  root.innerHTML = html;
  return { role, html };
}
`, 'run', ['https://app.example.test/api/widget'],
    {
      label: 'owner_role',
      storage: {session: {'user:role': 'owner'}},
      httpHandler: () => ({status: 200, body: {title: 'Deployments', count: 14}}),
    },
    {
      label: 'member_role',
      storage: {session: {'user:role': 'member'}},
      httpHandler: () => ({status: 200, body: {title: 'Deployments', count: 14}}),
    },
    ['typescript', 'browser-storage', 'http-io']);

  // 50. jshttp/cookie (TS) — Browser session cookie parser + DOM banner with localStorage
  r = await loadRepo('jshttp__cookie', ['src']);
  addBrowserPair(r, 'cookie_consent_banner_dom', 'app_cookie_dom.ts', `import { parseCookie, stringifyCookie } from './src/index.ts';

export function run(rawCookie: string) {
  const parsed = parseCookie(rawCookie);
  let consent = parsed.consent || localStorage.getItem('privacy:consent') || 'pending';
  if (consent === 'pending') {
    consent = confirm('Accept analytics cookies?') ? 'accepted' : 'declined';
    localStorage.setItem('privacy:consent', consent);
  }
  const serialized = stringifyCookie({ consent, lang: parsed.lang || 'en' });
  const root = document.getElementById('app')!;
  root.innerHTML = '<div data-consent="' + consent + '">' + serialized + '</div>';
  return { consent, serialized, html: root.innerHTML };
}
`, 'run', ['lang=en'],
    {label: 'consent_accepted', storage: {local: {}}, dialogs: {confirm: [true]}},
    {label: 'consent_declined', storage: {local: {}}, dialogs: {confirm: [false]}},
    ['typescript', 'browser-storage', 'browser-dialog']);

  // 51. pelotom/runtypes (TS) — Browser form validator + DOM error banner + fetch submit
  r = await loadRepo('pelotom__runtypes', ['src']);
  addBrowserPair(r, 'runtypes_form_submit_dom', 'app_runtypes_dom.ts', `import { Object as RtObj, String as RtStr, Number as RtNum } from './src/index.ts';

const ProfileForm = RtObj({ username: RtStr, age: RtNum });

export async function run(submitUrl: string) {
  const raw = sessionStorage.getItem('form:payload') || '{}';
  const parsed = JSON.parse(raw);
  const check = ProfileForm.inspect(parsed, false);
  const root = document.getElementById('app')!;
  if (!check.success) {
    console.warn('form invalid:', check.code);
    root.innerHTML = '<p class="error">' + check.code + '</p>';
    return { submitted: false, code: check.code };
  }
  const resp = await fetch(submitUrl, { method: 'POST', body: JSON.stringify(check.value) });
  const res = await resp.json();
  root.innerHTML = '<p class="ok">Saved #' + res.id + '</p>';
  return { submitted: true, id: res.id, html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/profile'],
    {
      label: 'valid_form_submitted',
      storage: {session: {'form:payload': JSON.stringify({username: 'ada', age: 31})}},
      httpHandler: () => ({status: 200, body: {id: 4041}}),
    },
    {
      label: 'invalid_form_blocked',
      storage: {session: {'form:payload': JSON.stringify({username: 'ada', age: 'thirty'})}},
      httpHandler: () => ({status: 200, body: {id: 4041}}),
    },
    ['typescript', 'browser-storage', 'http-io', 'console']);

  // 52. nvie/decoders (TS) — Browser API decoder + DOM status badge
  r = await loadRepo('nvie__decoders', ['src'], {rewriteTildeRoot: 'src'});
  addBrowserPair(r, 'decoders_status_widget_dom', 'app_decoders_dom.ts', `import { object, string, boolean } from './src/index.ts';

const HealthDecoder = object({ region: string, healthy: boolean });

export async function run(healthUrl: string) {
  const resp = await fetch(healthUrl);
  const raw = await resp.json();
  const res = HealthDecoder.decode(raw);
  const root = document.getElementById('app')!;
  if (res.ok) {
    const status = res.value.healthy ? 'UP' : 'DEGRADED';
    root.innerHTML = '<span data-status="' + status + '">' + res.value.region + ':' + status + '</span>';
    localStorage.setItem('health:last', status);
    return { ok: true, status, region: res.value.region };
  }
  console.error('health schema mismatch');
  root.innerHTML = '<span data-status="UNKNOWN">UNKNOWN</span>';
  return { ok: false, status: 'UNKNOWN' };
}
`, 'run', ['https://app.example.test/api/health'],
    {
      label: 'healthy_region',
      httpHandler: () => ({status: 200, body: {region: 'us-east', healthy: true}}),
    },
    {
      label: 'degraded_region',
      httpHandler: () => ({status: 200, body: {region: 'eu-central', healthy: false}}),
    },
    ['typescript', 'browser-storage', 'http-io', 'console']);

  // 53. badrap/valita (TS) — Browser settings validator + localStorage migration
  r = await loadRepo('badrap__valita', ['src']);
  addBrowserPair(r, 'valita_prefs_migrator_dom', 'app_valita_dom.ts', `import * as v from './src/index.ts';

const Prefs = v.object({ fontSize: v.number(), dark: v.boolean() });

export function run() {
  const raw = localStorage.getItem('editor:prefs');
  let prefs = { fontSize: 14, dark: false };
  let migrated = false;
  if (raw) {
    const res = Prefs.try(JSON.parse(raw));
    if (res.ok) prefs = res.value;
    else {
      console.warn('resetting corrupt editor prefs');
      localStorage.setItem('editor:prefs', JSON.stringify(prefs));
      migrated = true;
    }
  }
  const root = document.getElementById('app')!;
  root.innerHTML = '<div data-dark="' + prefs.dark + '" data-size="' + prefs.fontSize + '">Editor</div>';
  return { migrated, prefs, html: root.innerHTML };
}
`, 'run', [],
    {label: 'valid_stored_prefs', storage: {local: {'editor:prefs': JSON.stringify({fontSize: 16, dark: true})}}},
    {label: 'corrupt_prefs_reset', storage: {local: {'editor:prefs': JSON.stringify({fontSize: 'big', dark: 'yes'})}}},
    ['typescript', 'browser-storage', 'console']);

  // 54. supermacro/neverthrow (TS) — Browser async fetch Result pipeline + DOM feedback
  r = await loadRepo('supermacro__neverthrow', ['src']);
  addBrowserPair(r, 'neverthrow_save_dom', 'app_neverthrow_dom.ts', `import { ok, err, Result } from './src/index.ts';

function parseQuota(v: string | null): Result<number, string> {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return err('invalid_quota');
  return ok(n);
}

export async function run(apiUrl: string) {
  const quotaRes = parseQuota(localStorage.getItem('org:quota'));
  const root = document.getElementById('app')!;
  if (quotaRes.isErr()) {
    root.innerHTML = '<p class="err">' + quotaRes.error + '</p>';
    return { ok: false, error: quotaRes.error };
  }
  const resp = await fetch(apiUrl);
  const { used } = await resp.json() as { used: number };
  const pct = Math.round((used / quotaRes.value) * 100);
  root.innerHTML = '<progress value="' + pct + '" max="100">' + pct + '%</progress>';
  return { ok: true, used, quota: quotaRes.value, pct };
}
`, 'run', ['https://app.example.test/api/usage'],
    {
      label: 'valid_quota_progress',
      storage: {local: {'org:quota': '200'}},
      httpHandler: () => ({status: 200, body: {used: 150}}),
    },
    {
      label: 'invalid_quota_err',
      storage: {local: {'org:quota': 'bad'}},
      httpHandler: () => ({status: 200, body: {used: 150}}),
    },
    ['typescript', 'browser-storage', 'http-io']);

  // 55. pillarjs/path-to-regexp (TS) — Browser SPA deep-link hydrator + history + localStorage
  r = await loadRepo('pillarjs__path-to-regexp', ['src']);
  addBrowserPair(r, 'pathtoregexp_spa_dom', 'app_p2r_dom.ts', `import { match } from './src/index.ts';

export async function run(apiBase: string) {
  const matcher = match<{team: string; id: string}>('/teams/:team/issues/:id');
  const m = matcher(location.pathname);
  const root = document.getElementById('app')!;
  if (!m) {
    root.innerHTML = '<p>404 Not Found</p>';
    localStorage.setItem('last:status', '404');
    return { found: false };
  }
  const resp = await fetch(apiBase + '/' + m.params.team + '/' + m.params.id);
  const issue = await resp.json() as { title: string; state: string };
  root.innerHTML = '<h2>' + issue.title + '</h2><span>' + issue.state + '</span>';
  localStorage.setItem('last:issue', m.params.id);
  return { found: true, params: m.params, issue };
}
`, 'run', ['https://app.example.test/api/issues'],
    {
      label: 'matched_issue_route',
      initialUrl: 'https://app.example.test/teams/core/issues/42',
      httpHandler: () => ({status: 200, body: {title: 'Fix OPSD mask', state: 'open'}}),
    },
    {
      label: 'unmatched_404_route',
      initialUrl: 'https://app.example.test/unknown/page',
      httpHandler: () => ({status: 200, body: {}}),
    },
    ['typescript', 'browser-storage', 'http-io']);

  // 56. AsyncBanana/microdiff (TS) — Browser live draft dirty-indicator in DOM + confirm discard
  r = await loadRepo('AsyncBanana__microdiff', ['index.ts']);
  addBrowserPair(r, 'microdiff_draft_guard_dom', 'app_microdiff_dom.ts', `import diff from './index.ts';

export function run(nextDraft: Record<string, unknown>) {
  const saved = JSON.parse(localStorage.getItem('doc:saved') || '{}');
  const changes = diff(saved, nextDraft);
  const root = document.getElementById('app')!;
  let discarded = false;
  if (changes.length > 0) {
    if (confirm('Discard ' + changes.length + ' unsaved changes?')) {
      discarded = true;
      root.innerHTML = '<p>Reverted to saved</p>';
    } else {
      localStorage.setItem('doc:saved', JSON.stringify(nextDraft));
      root.innerHTML = '<p>Saved ' + changes.length + ' edits</p>';
    }
  } else {
    root.innerHTML = '<p>No changes</p>';
  }
  return { changeCount: changes.length, discarded, html: root.innerHTML };
}
`, 'run', [{title: 'Wave 3 Spec', status: 'review'}],
    {
      label: 'discard_confirmed',
      storage: {local: {'doc:saved': JSON.stringify({title: 'Wave 3 Spec', status: 'draft'})}},
      dialogs: {confirm: [true]},
    },
    {
      label: 'save_kept',
      storage: {local: {'doc:saved': JSON.stringify({title: 'Wave 3 Spec', status: 'draft'})}},
      dialogs: {confirm: [false]},
    },
    ['typescript', 'browser-storage', 'browser-dialog']);

  // 57. paulmillr/noble-hashes (TS) — SHA-256 checksum verifier over workspace FS artifacts
  r = await loadRepo('paulmillr__noble-hashes', ['src/sha2.ts', 'src/_md.ts', 'src/utils.ts', 'src/_u64.ts', 'src/hmac.ts']);
  addStatefulPair(r, 'noblehashes_checksum_verify', 'verify_sha256.ts', `import * as fs from 'node:fs';
import { sha256 } from './src/sha2.ts';
import { bytesToHex } from './src/utils.ts';

export function run(artifactPath: string, manifestPath: string, outPath: string) {
  const raw = fs.readFileSync(artifactPath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const actual = bytesToHex(sha256(bytes));
  const expected = fs.readFileSync(manifestPath, 'utf8').trim();
  const matched = actual === expected;
  if (!matched) console.error('checksum mismatch:', actual.slice(0, 12));
  const res = { matched, actualPrefix: actual.slice(0, 16), expectedPrefix: expected.slice(0, 16) };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
`, 'run', ['/workspace/release.bin', '/workspace/release.sha256', '/workspace/verify.json'],
    {
      label: 'checksum_valid',
      files: {
        'release.bin': Buffer.from('wave3-artifact-payload'),
        'release.sha256': createHash('sha256').update('wave3-artifact-payload').digest('hex'),
      },
      env: {},
    },
    {
      label: 'checksum_tampered',
      files: {
        'release.bin': Buffer.from('wave3-artifact-TAMPERED'),
        'release.sha256': createHash('sha256').update('wave3-artifact-payload').digest('hex'),
      },
      env: {},
    },
    ['typescript', 'fs-io', 'console']);

  // 58. jshttp/content-type (TS) — parse HTTP Content-Type header from fetched endpoint + write audit
  r = await loadRepo('jshttp__content-type', ['src']);
  addStatefulPair(r, 'contenttype_header_guard', 'check_ct.ts', `import * as fs from 'node:fs';
import { parse } from './src/index.ts';

export async function run(apiUrl: string, outPath: string) {
  const resp = await fetch(apiUrl);
  const rawCt = resp.headers.get('content-type') || 'application/octet-stream';
  const parsed = parse(rawCt);
  const isJson = parsed.type === 'application/json';
  const out = { type: parsed.type, charset: parsed.parameters.charset || null, isJson };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', [`${baseUrl}/payload`, '/workspace/ct_audit.json'],
    {label: 'utf8_json', files: {'.keep': ''}, env: {}, httpRoutes: {'/payload': {status: 200, headers: {'content-type': 'application/json; charset=utf-8'}, body: '{"ok":true}'}}},
    {label: 'plain_text', files: {'.keep': ''}, env: {}, httpRoutes: {'/payload': {status: 200, headers: {'content-type': 'text/plain; charset=iso-8859-1'}, body: 'hello'}}},
    ['typescript', 'http-io', 'fs-io']);

  // 59. jshttp/range-parser (TS) — compute HTTP byte-range slices for workspace asset file
  r = await loadRepo('jshttp__range-parser', ['src']);
  addStatefulPair(r, 'rangeparser_media_slice', 'slice_range.ts', `import * as fs from 'node:fs';
import { parse, format } from './src/index.ts';

export function run(filePath: string, outPath: string) {
  const st = fs.statSync(filePath);
  const hdr = process.env.RANGE_HEADER || 'bytes=0-9';
  const parsed = parse(st.size, hdr);
  const valid = parsed.ranges.length > 0;
  const out = {
    valid,
    size: st.size,
    type: parsed.type,
    ranges: parsed.ranges.map(r => [r.start, r.end]),
    header: valid ? format(parsed) : null,
  };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/video.bin', '/workspace/range.json'],
    {label: 'satisfiable_range', files: {'video.bin': Buffer.alloc(100, 7)}, env: {RANGE_HEADER: 'bytes=10-29,50-59'}},
    {label: 'suffix_range', files: {'video.bin': Buffer.alloc(100, 7)}, env: {RANGE_HEADER: 'bytes=-25'}},
    ['typescript', 'fs-io', 'env-io']);

  // 60. jshttp/media-typer (TS) — validate uploaded MIME types from FS manifest + env allowlist
  r = await loadRepo('jshttp__media-typer', ['src']);
  addStatefulPair(r, 'mediatyper_upload_guard', 'check_mime.ts', `import * as fs from 'node:fs';
import { parse, format } from './src/index.ts';

export function run(listPath: string, outPath: string) {
  const types = JSON.parse(fs.readFileSync(listPath, 'utf8')) as string[];
  const allowSvg = process.env.ALLOW_SVG === '1';
  const results = types.map(raw => {
    const p = parse(raw);
    const allowed = p.type === 'image' && (p.subtype !== 'svg' || allowSvg);
    return { canonical: format(p), type: p.type, subtype: p.subtype, allowed };
  });
  const out = { allowSvg, allowedCount: results.filter(x => x.allowed).length, results };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/mimes.json', '/workspace/mime_audit.json'],
    {label: 'svg_blocked', files: {'mimes.json': JSON.stringify(['image/png', 'image/svg+xml', 'application/pdf'])}, env: {ALLOW_SVG: '0'}},
    {label: 'svg_allowed', files: {'mimes.json': JSON.stringify(['image/png', 'image/svg+xml', 'application/pdf'])}, env: {ALLOW_SVG: '1'}},
    ['typescript', 'fs-io', 'env-io']);

  // 61. jshttp/content-disposition (TS) — build & parse download Content-Disposition headers over FS
  r = await loadRepo('jshttp__content-disposition', ['src']);
  addStatefulPair(r, 'contentdisp_export_header', 'make_cd.ts', `import * as fs from 'node:fs';
import { create, parse } from './src/index.ts';

export function run(metaPath: string, outPath: string) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { filename: string; inline: boolean };
  const hdr = create(meta.filename, { type: meta.inline ? 'inline' : 'attachment' });
  const parsed = parse(hdr);
  const out = { header: hdr, type: parsed.type, filename: parsed.parameters.filename };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/export.json', '/workspace/cd_out.json'],
    {label: 'attachment_csv', files: {'export.json': JSON.stringify({filename: 'report-2025.csv', inline: false})}, env: {}},
    {label: 'inline_pdf', files: {'export.json': JSON.stringify({filename: 'invoice-42.pdf', inline: true})}, env: {}},
    ['typescript', 'fs-io']);

  // 61b. jshttp/etag (TS) — generate strong/weak HTTP ETags for workspace static assets
  r = await loadRepo('jshttp__etag', ['src']);
  addStatefulPair(r, 'etag_asset_fingerprinter', 'make_etag.ts', `import * as fs from 'node:fs';
import { etag } from './src/index.ts';

export function run(assetPath: string, outPath: string) {
  const body = fs.readFileSync(assetPath, 'utf8');
  const weak = process.env.WEAK_ETAG === '1';
  const tag = etag(body, { weak });
  const out = { weak, bytes: body.length, etag: tag };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/app.css', '/workspace/etag.json'],
    {label: 'strong_etag', files: {'app.css': 'body{margin:0;color:#111}'}, env: {WEAK_ETAG: '0'}},
    {label: 'weak_etag', files: {'app.css': 'body{margin:0;color:#111}'}, env: {WEAK_ETAG: '1'}},
    ['typescript', 'fs-io', 'env-io']);

  // 61c. unjs/magic-regexp (TS) — structured log line parser built with typed RegExp builder over FS
  r = await loadRepo('unjs__magic-regexp', ['src']);
  addStatefulPair(r, 'magicregexp_log_extractor', 'extract_logs.ts', `import * as fs from 'node:fs';
import { createRegExp, exactly, oneOrMore, digit, letter } from './src/index.ts';

export function run(logPath: string, outPath: string) {
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\\n');
  const levelFilter = process.env.LOG_LEVEL || 'ERROR';
  const rx = createRegExp(
    exactly('['),
    oneOrMore(letter).groupedAs('level'),
    exactly('] code='),
    oneOrMore(digit).groupedAs('code'),
  );
  const matched: Array<{level: string; code: number}> = [];
  for (const line of lines) {
    const m = line.match(rx);
    if (m?.groups && m.groups.level === levelFilter) {
      matched.push({ level: m.groups.level, code: Number(m.groups.code) });
    }
  }
  const out = { levelFilter, count: matched.length, matched };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/server.log', '/workspace/matched_logs.json'],
    {label: 'filter_error', files: {'server.log': '[INFO] code=200 ok\n[ERROR] code=502 upstream\n[ERROR] code=504 timeout\n[WARN] code=429 rate\n'}, env: {LOG_LEVEL: 'ERROR'}},
    {label: 'filter_warn', files: {'server.log': '[INFO] code=200 ok\n[ERROR] code=502 upstream\n[ERROR] code=504 timeout\n[WARN] code=429 rate\n'}, env: {LOG_LEVEL: 'WARN'}},
    ['typescript', 'fs-io', 'env-io']);

  // 61d. jridgewell/sourcemap-codec (TS) — decode & re-encode VLQ sourcemap mappings read from FS
  r = await loadRepo('jridgewell__sourcemap-codec', ['src']);
  addStatefulPair(r, 'sourcemapcodec_vlq_inspector', 'inspect_vlq.ts', `import * as fs from 'node:fs';
import { decode, encode } from './src/sourcemap-codec.ts';

export function run(mapPath: string, outPath: string) {
  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as { version: number; mappings: string };
  const decoded = decode(raw.mappings);
  const reencoded = encode(decoded);
  const segCount = decoded.reduce((s, line) => s + line.length, 0);
  const out = { lineCount: decoded.length, segCount, roundtripOk: reencoded === raw.mappings };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/app.js.map', '/workspace/vlq_audit.json'],
    {label: 'two_line_map', files: {'app.js.map': JSON.stringify({version: 3, mappings: 'AAAA,SAAS;AACT,IAAI'})}, env: {}},
    {label: 'four_line_map', files: {'app.js.map': JSON.stringify({version: 3, mappings: 'AAAA;AACA,GAAG;AACH;AACA,IAAM'})}, env: {}},
    ['typescript', 'fs-io']);

  // 61e. isaacs/yallist (TS) — doubly-linked history buffer managing undo/redo ops from FS
  r = await loadRepo('isaacs__yallist', ['src']);
  addStatefulPair(r, 'yallist_history_buffer', 'replay_history.ts', `import * as fs from 'node:fs';
import { Yallist } from './src/index.ts';

export function run(opsPath: string, outPath: string) {
  const ops = JSON.parse(fs.readFileSync(opsPath, 'utf8')) as Array<{op: string; val?: string}>;
  const maxLen = Number(process.env.MAX_HISTORY || 3);
  const list = new Yallist<string>();
  for (const item of ops) {
    if (item.op === 'push' && item.val) {
      list.push(item.val);
      while (list.length > maxLen) list.shift();
    } else if (item.op === 'undo') {
      list.pop();
    }
  }
  const arr = list.toArray();
  const out = { maxLen, length: arr.length, items: arr };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/edits.json', '/workspace/history_out.json'],
    {label: 'cap_three', files: {'edits.json': JSON.stringify([{op: 'push', val: 'a'}, {op: 'push', val: 'b'}, {op: 'push', val: 'c'}, {op: 'push', val: 'd'}, {op: 'undo'}])}, env: {MAX_HISTORY: '3'}},
    {label: 'cap_two', files: {'edits.json': JSON.stringify([{op: 'push', val: 'a'}, {op: 'push', val: 'b'}, {op: 'push', val: 'c'}, {op: 'push', val: 'd'}, {op: 'undo'}])}, env: {MAX_HISTORY: '2'}},
    ['typescript', 'fs-io', 'env-io']);

  // 61f. broofa/mime (TS) — custom MIME registry mapping workspace files to content types
  r = await loadRepo('broofa__mime', ['src/Mime.ts']);
  addStatefulPair(r, 'mime_static_classifier', 'classify_assets.ts', `import * as fs from 'node:fs';
import Mime from './src/Mime.ts';

export function run(dirPath: string, outPath: string) {
  const customMap = { 'application/x-wgsl': ['wgsl'], 'text/plain': ['log', 'txt'], 'application/json': ['json'], 'text/css': ['css'] };
  const mime = new Mime(customMap);
  const files = fs.readdirSync(dirPath).sort();
  const mapped = files.map(f => ({ file: f, mime: mime.getType(f) || 'application/octet-stream' }));
  const out = { count: mapped.length, mapped };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/static', '/workspace/mime_map.json'],
    {label: 'web_and_shader', files: {'static/shader.wgsl': 'fn main(){}', 'static/style.css': 'body{}', 'static/data.json': '{}'}},
    {label: 'logs_and_unknown', files: {'static/app.log': 'ok', 'static/raw.bin': '0101'}},
    ['typescript', 'fs-io']);

  // 62. jshttp/fresh (JS) — evaluate HTTP cache freshness against fetched ETag + env If-None-Match
  r = await loadRepo('jshttp__fresh', ['index.js']);
  addStatefulPair(r, 'fresh_cache_validator', 'check_fresh.js', `const fs = require('fs');
const fresh = require('./index.js');

async function run(apiUrl, outPath) {
  const resp = await fetch(apiUrl);
  const etag = resp.headers.get('etag');
  const reqHeaders = { 'if-none-match': process.env.CLIENT_ETAG || '' };
  const resHeaders = { etag };
  const isFresh = fresh(reqHeaders, resHeaders);
  const out = { clientEtag: reqHeaders['if-none-match'], serverEtag: etag, isFresh };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
module.exports = { run };
`, 'run', [`${baseUrl}/asset`, '/workspace/fresh.json'],
    {label: 'etag_match_304', files: {'.keep': ''}, env: {CLIENT_ETAG: '"v9-abc"'}, httpRoutes: {'/asset': {status: 200, headers: {etag: '"v9-abc"'}, body: 'ok'}}},
    {label: 'etag_stale_200', files: {'.keep': ''}, env: {CLIENT_ETAG: '"v8-old"'}, httpRoutes: {'/asset': {status: 200, headers: {etag: '"v9-abc"'}, body: 'ok'}}},
    ['http-io', 'fs-io', 'env-io']);

  // 63. mljs/stat (JS) — compute workspace sensor anomaly statistics via FS + env z-threshold
  r = await loadRepo('mljs__stat', ['array.js', 'index.js', 'matrix.js']);
  addStatefulPair(r, 'mljs_stat_sensor_audit', 'sensor_stats.js', `const fs = require('fs');
const stat = require('./array.js');

function run(dataPath, outPath) {
  const readings = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const maxStd = Number(process.env.MAX_STD || 5);
  const avg = Math.round(stat.mean(readings) * 100) / 100;
  const std = Math.round(stat.standardDeviation(readings) * 100) / 100;
  const noisy = std > maxStd;
  if (noisy) console.warn('sensor noise high:', std);
  const res = { count: readings.length, avg, std, maxStd, noisy };
  fs.writeFileSync(outPath, JSON.stringify(res), 'utf8');
  return res;
}
module.exports = { run };
`, 'run', ['/workspace/sensors.json', '/workspace/sensor_report.json'],
    {label: 'stable_readings', files: {'sensors.json': JSON.stringify([20.1, 20.4, 19.9, 20.2, 20.0])}, env: {MAX_STD: '2'}},
    {label: 'noisy_readings', files: {'sensors.json': JSON.stringify([10, 35, 12, 40, 15])}, env: {MAX_STD: '2'}},
    ['fs-io', 'env-io', 'console']);

  // 64. niieani/hashids.js (TS) — encode & verify public referral codes from FS + env salt
  r = await loadRepo('niieani__hashids-js', ['src']);
  addStatefulPair(r, 'hashids_referral_coder', 'encode_refs.ts', `import * as fs from 'node:fs';
import Hashids from './src/hashids.ts';

export function run(usersPath: string, outPath: string) {
  const userIds = JSON.parse(fs.readFileSync(usersPath, 'utf8')) as number[];
  const salt = process.env.REF_SALT || 'default-salt';
  const hashids = new Hashids(salt, 8);
  const codes = userIds.map(id => {
    const code = hashids.encode(id);
    const decoded = hashids.decode(code);
    return { id, code, roundtripOk: Number(decoded[0]) === id };
  });
  const out = { saltLen: salt.length, codes };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/users.json', '/workspace/refs.json'],
    {label: 'prod_salt', files: {'users.json': JSON.stringify([101, 2048, 9999])}, env: {REF_SALT: 'prod-2025-key'}},
    {label: 'stage_salt', files: {'users.json': JSON.stringify([101, 2048, 9999])}, env: {REF_SALT: 'staging-key'}},
    ['typescript', 'fs-io', 'env-io']);

  // 65. woltapp/blurhash (TS) — encode/verify image placeholder hashes from FS pixel buffer
  r = await loadRepo('woltapp__blurhash', ['TypeScript/src']);
  addStatefulPair(r, 'blurhash_thumb_encoder', 'make_blurhash.ts', `import * as fs from 'node:fs';
import { encode, isBlurhashValid } from './TypeScript/src/index.ts';

export function run(imgPath: string, outPath: string) {
  const spec = JSON.parse(fs.readFileSync(imgPath, 'utf8')) as { width: number; height: number; rgba: number[] };
  const cx = Number(process.env.BH_CX || 3);
  const cy = Number(process.env.BH_CY || 3);
  const hash = encode(new Uint8ClampedArray(spec.rgba), spec.width, spec.height, cx, cy);
  const check = isBlurhashValid(hash);
  const out = { cx, cy, hash, valid: check.result };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/thumb.json', '/workspace/blurhash.json'],
    {label: 'comp_2x2', files: {'thumb.json': JSON.stringify({width: 2, height: 2, rgba: [255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,0,255]})}, env: {BH_CX: '2', BH_CY: '2'}},
    {label: 'comp_3x2', files: {'thumb.json': JSON.stringify({width: 2, height: 2, rgba: [255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,0,255]})}, env: {BH_CX: '3', BH_CY: '2'}},
    ['typescript', 'fs-io', 'env-io']);

  // 66. tnfe/limu (TS) — immutable structural draft updates over FS state + HTTP patch
  r = await loadRepo('tnfe__limu', ['src']);
  addStatefulPair(r, 'limu_immutable_ledger', 'apply_limu.ts', `import * as fs from 'node:fs';
import { produce } from './src/index.ts';

export async function run(statePath: string, eventUrl: string, outPath: string) {
  const base = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { balance: number; tx: string[] };
  const resp = await fetch(eventUrl);
  const ev = await resp.json() as { id: string; delta: number };
  const next = produce(base, draft => {
    draft.balance += ev.delta;
    draft.tx.push(ev.id);
  });
  const unchangedBase = base.balance !== next.balance && base.tx.length !== next.tx.length;
  const out = { unchangedBase, before: base.balance, after: next.balance, txCount: next.tx.length };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/ledger.json', `${baseUrl}/tx`, '/workspace/ledger_next.json'],
    {label: 'credit_tx', files: {'ledger.json': JSON.stringify({balance: 500, tx: ['init']})}, env: {}, httpRoutes: {'/tx': {status: 200, body: JSON.stringify({id: 'tx-9', delta: 150})}}},
    {label: 'debit_tx', files: {'ledger.json': JSON.stringify({balance: 500, tx: ['init']})}, env: {}, httpRoutes: {'/tx': {status: 200, body: JSON.stringify({id: 'tx-10', delta: -80})}}},
    ['typescript', 'fs-io', 'http-io']);

  // 67. Qix-/color-convert (JS) — convert workspace brand palette hex -> RGB/HSL/CMYK via FS + env target
  r = await loadRepo('Qix-__color-convert', ['index.js', 'conversions.js', 'route.js']);
  addStatefulPair(r, 'colorconvert_palette_export', 'convert_palette.js', `const fs = require('fs');
const convert = require('./index.js');

function run(palettePath, outPath) {
  const palette = JSON.parse(fs.readFileSync(palettePath, 'utf8'));
  const space = process.env.COLOR_SPACE || 'hsl';
  const converted = {};
  for (const [name, hex] of Object.entries(palette)) {
    converted[name] = space === 'cmyk' ? convert.hex.cmyk(hex) : convert.hex.hsl(hex);
  }
  const out = { space, converted };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
module.exports = { run };
`, 'run', ['/workspace/palette.json', '/workspace/palette_out.json'],
    {label: 'hsl_space', files: {'palette.json': JSON.stringify({primary: '#2563eb', accent: '#10b981'})}, env: {COLOR_SPACE: 'hsl'}},
    {label: 'cmyk_space', files: {'palette.json': JSON.stringify({primary: '#2563eb', accent: '#10b981'})}, env: {COLOR_SPACE: 'cmyk'}},
    ['fs-io', 'env-io']);

  // 68. fontello/svgpath (JS) — scale & translate SVG icon paths read from workspace FS
  r = await loadRepo('fontello__svgpath', ['lib', 'index.js']);
  addStatefulPair(r, 'svgpath_icon_scaler', 'scale_svg.js', `const fs = require('fs');
const svgpath = require('./index.js');

function run(iconPath, outPath) {
  const d = fs.readFileSync(iconPath, 'utf8').trim();
  const factor = Number(process.env.ICON_SCALE || 2);
  const transformed = svgpath(d).scale(factor).translate(4, 4).round(1).toString();
  const out = { factor, input: d, transformed };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
module.exports = { run };
`, 'run', ['/workspace/icon.path', '/workspace/icon_scaled.json'],
    {label: 'scale_2x', files: {'icon.path': 'M 0 0 L 10 0 L 10 10 Z'}, env: {ICON_SCALE: '2'}},
    {label: 'scale_3x', files: {'icon.path': 'M 0 0 L 10 0 L 10 10 Z'}, env: {ICON_SCALE: '3'}},
    ['fs-io', 'env-io']);

  // 69. markdown-it/mdurl (JS) — parse & normalize markdown links read from workspace FS
  r = await loadRepo('markdown-it__mdurl', ['lib', 'index.mjs'], {renameMjsToJs: true});
  addStatefulPair(r, 'mdurl_link_normalizer', 'norm_links.js', `import * as fs from 'node:fs';
import { parse, format, encode } from './index.js';

export function run(linksPath, outPath) {
  const links = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
  const forceHttps = process.env.FORCE_HTTPS === '1';
  const normalized = links.map(raw => {
    const p = parse(encode(raw));
    if (forceHttps && p.protocol === 'http:') p.protocol = 'https:';
    return format(p);
  });
  const out = { forceHttps, count: normalized.length, normalized };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/links.json', '/workspace/links_norm.json'],
    {label: 'force_https_on', files: {'links.json': JSON.stringify(['http://docs.example.com/a b', 'https://api.example.com/v1'])}, env: {FORCE_HTTPS: '1'}},
    {label: 'force_https_off', files: {'links.json': JSON.stringify(['http://docs.example.com/a b', 'https://api.example.com/v1'])}, env: {FORCE_HTTPS: '0'}},
    ['fs-io', 'env-io']);

  // 70. mapbox/earcut (JS) — triangulate GeoJSON polygon rings from workspace FS
  r = await loadRepo('mapbox__earcut', ['src']);
  addStatefulPair(r, 'earcut_mesh_builder', 'triangulate.js', `import * as fs from 'node:fs';
import earcut, { deviation } from './src/earcut.js';

export function run(polyPath, outPath) {
  const poly = JSON.parse(fs.readFileSync(polyPath, 'utf8'));
  const indices = earcut(poly.coords, poly.holes || [], 2);
  const err = Math.round(deviation(poly.coords, poly.holes || [], 2, indices) * 10000) / 10000;
  const out = { triangleCount: indices.length / 3, indexCount: indices.length, deviation: err };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/poly.json', '/workspace/mesh.json'],
    {label: 'simple_quad', files: {'poly.json': JSON.stringify({coords: [0,0, 10,0, 10,10, 0,10]})}, env: {}},
    {label: 'quad_with_hole', files: {'poly.json': JSON.stringify({coords: [0,0, 10,0, 10,10, 0,10, 3,3, 7,3, 7,7, 3,7], holes: [4]})}, env: {}},
    ['fs-io']);

  // 71. mapbox/geojson-rewind (JS) — enforce RFC 7946 winding order on FS GeoJSON
  r = await loadRepo('mapbox__geojson-rewind', ['index.js']);
  addStatefulPair(r, 'geojsonrewind_ring_fixer', 'rewind_geo.js', `const fs = require('fs');
const rewind = require('./index.js');

function run(geoPath, outPath) {
  const gj = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
  const clockwise = process.env.WIND_CW === '1';
  const fixed = rewind(gj, clockwise);
  const ring = fixed.coordinates[0];
  const out = { clockwise, firstTwo: ring.slice(0, 2), ringLen: ring.length };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
module.exports = { run };
`, 'run', ['/workspace/shape.geojson', '/workspace/fixed.geojson'],
    {label: 'ccw_rfc7946', files: {'shape.geojson': JSON.stringify({type: 'Polygon', coordinates: [[[0,0],[0,10],[10,10],[10,0],[0,0]]]})}, env: {WIND_CW: '0'}},
    {label: 'cw_legacy', files: {'shape.geojson': JSON.stringify({type: 'Polygon', coordinates: [[[0,0],[0,10],[10,10],[10,0],[0,0]]]})}, env: {WIND_CW: '1'}},
    ['fs-io', 'env-io']);

  // 72. mourner/tinyqueue (JS) — priority job scheduler reading tasks from FS + env batch limit
  r = await loadRepo('mourner__tinyqueue', ['index.js']);
  addStatefulPair(r, 'tinyqueue_job_dispatcher', 'dispatch_jobs.js', `import * as fs from 'node:fs';
import TinyQueue from './index.js';

export function run(jobsPath, outPath) {
  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  const limit = Number(process.env.BATCH_LIMIT || 2);
  const q = new TinyQueue(jobs, (a, b) => a.priority - b.priority);
  const dispatched = [];
  while (q.length > 0 && dispatched.length < limit) {
    dispatched.push(q.pop().id);
  }
  const out = { limit, dispatched, remaining: q.length };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/queue.json', '/workspace/dispatched.json'],
    {label: 'limit_two', files: {'queue.json': JSON.stringify([{id: 'j1', priority: 5}, {id: 'j2', priority: 1}, {id: 'j3', priority: 3}, {id: 'j4', priority: 2}])}, env: {BATCH_LIMIT: '2'}},
    {label: 'limit_three', files: {'queue.json': JSON.stringify([{id: 'j1', priority: 5}, {id: 'j2', priority: 1}, {id: 'j3', priority: 3}, {id: 'j4', priority: 2}])}, env: {BATCH_LIMIT: '3'}},
    ['fs-io', 'env-io']);

  // 73. d3/d3-quadtree (JS) — spatial nearest-neighbor lookup over workspace POI dataset + env query
  r = await loadRepo('d3__d3-quadtree', ['src']);
  addStatefulPair(r, 'd3quadtree_nearest_store', 'find_nearest.js', `import * as fs from 'node:fs';
import { quadtree } from './src/index.js';

export function run(poisPath, outPath) {
  const pois = JSON.parse(fs.readFileSync(poisPath, 'utf8'));
  const qx = Number(process.env.QUERY_X || 0);
  const qy = Number(process.env.QUERY_Y || 0);
  const tree = quadtree().x(d => d.x).y(d => d.y).addAll(pois);
  const nearest = tree.find(qx, qy);
  const out = { query: [qx, qy], size: tree.size(), nearest: nearest ? nearest.name : null };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/pois.json', '/workspace/nearest.json'],
    {label: 'near_north', files: {'pois.json': JSON.stringify([{name: 'NorthHub', x: 10, y: 90}, {name: 'SouthHub', x: 12, y: 5}, {name: 'EastHub', x: 85, y: 40}])}, env: {QUERY_X: '11', QUERY_Y: '80'}},
    {label: 'near_east', files: {'pois.json': JSON.stringify([{name: 'NorthHub', x: 10, y: 90}, {name: 'SouthHub', x: 12, y: 5}, {name: 'EastHub', x: 85, y: 40}])}, env: {QUERY_X: '75', QUERY_Y: '35'}},
    ['fs-io', 'env-io']);

  // 74. d3/d3-path (JS) — generate SVG sparkline path from fetched metrics + write SVG file
  r = await loadRepo('d3__d3-path', ['src']);
  addStatefulPair(r, 'd3path_sparkline_gen', 'make_sparkline.js', `import * as fs from 'node:fs';
import { path as d3Path } from './src/index.js';

export async function run(metricsUrl, outPath) {
  const resp = await fetch(metricsUrl);
  const pts = await resp.json();
  const p = d3Path();
  pts.forEach((pt, idx) => {
    if (idx === 0) p.moveTo(pt[0], pt[1]);
    else p.lineTo(pt[0], pt[1]);
  });
  const d = p.toString();
  const svg = '<svg><path d="' + d + '"/></svg>';
  fs.writeFileSync(outPath, svg, 'utf8');
  return { pointCount: pts.length, d };
}
`, 'run', [`${baseUrl}/spark`, '/workspace/spark.svg'],
    {label: 'rising_trend', files: {'.keep': ''}, env: {}, httpRoutes: {'/spark': {status: 200, body: JSON.stringify([[0, 40], [20, 30], [40, 15], [60, 5]])}}},
    {label: 'flat_trend', files: {'.keep': ''}, env: {}, httpRoutes: {'/spark': {status: 200, body: JSON.stringify([[0, 20], [30, 20], [60, 20]])}}},
    ['http-io', 'fs-io']);

  // 75. scurker/currency.js (JS) — invoice subtotal & tax calculator from FS + env tax rate
  r = await loadRepo('scurker__currency-js', ['src']);
  addStatefulPair(r, 'currencyjs_invoice_totals', 'calc_invoice.js', `import * as fs from 'node:fs';
import currency from './src/currency.js';

export function run(itemsPath, outPath) {
  const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
  const taxRate = Number(process.env.TAX_RATE || 0.08);
  let subtotal = currency(0);
  for (const item of items) {
    subtotal = subtotal.add(currency(item.price).multiply(item.qty));
  }
  const tax = subtotal.multiply(taxRate);
  const total = subtotal.add(tax);
  const out = { taxRate, subtotal: subtotal.format(), tax: tax.format(), total: total.format() };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
`, 'run', ['/workspace/cart.json', '/workspace/invoice.json'],
    {label: 'us_tax_8pct', files: {'cart.json': JSON.stringify([{price: '19.99', qty: 2}, {price: '5.50', qty: 3}])}, env: {TAX_RATE: '0.08'}},
    {label: 'eu_vat_20pct', files: {'cart.json': JSON.stringify([{price: '19.99', qty: 2}, {price: '5.50', qty: 3}])}, env: {TAX_RATE: '0.20'}},
    ['fs-io', 'env-io']);

  // 76. wooorm/markdown-table (JS) — render workspace benchmark results as Markdown table
  r = await loadRepo('wooorm__markdown-table', ['index.js']);
  addStatefulPair(r, 'markdowntable_bench_report', 'render_table.js', `import * as fs from 'node:fs';
import { markdownTable } from './index.js';

export function run(dataPath, outPath) {
  const rows = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const alignRight = process.env.ALIGN_NUMS === '1';
  const md = markdownTable(rows, { align: alignRight ? ['l', 'r', 'r'] : ['l', 'l', 'l'] });
  fs.writeFileSync(outPath, md, 'utf8');
  return { alignRight, lines: md.split('\\n').length, md };
}
`, 'run', ['/workspace/bench.json', '/workspace/TABLE.md'],
    {label: 'right_aligned', files: {'bench.json': JSON.stringify([['Model', 'Pass', 'Tok'], ['v1', '82%', '1200'], ['v2', '91%', '980']])}, env: {ALIGN_NUMS: '1'}},
    {label: 'left_aligned', files: {'bench.json': JSON.stringify([['Model', 'Pass', 'Tok'], ['v1', '82%', '1200'], ['v2', '91%', '980']])}, env: {ALIGN_NUMS: '0'}},
    ['fs-io', 'env-io']);

  // 77. MikeMcl/big.js (JS) — exact arbitrary-precision interest calculator over FS + env compounding
  r = await loadRepo('MikeMcl__big-js', ['big.js']);
  addStatefulPair(r, 'bigjs_precision_ledger', 'calc_interest.js', `const fs = require('fs');
const Big = require('./big.js');

function run(acctPath, outPath) {
  const acct = JSON.parse(fs.readFileSync(acctPath, 'utf8'));
  const periods = Number(process.env.PERIODS || 4);
  let bal = new Big(acct.principal);
  const rate = new Big(acct.rate);
  for (let i = 0; i < periods; i++) {
    bal = bal.times(rate.plus(1));
  }
  const out = { periods, principal: acct.principal, finalBalance: bal.toFixed(4) };
  fs.writeFileSync(outPath, JSON.stringify(out), 'utf8');
  return out;
}
module.exports = { run };
`, 'run', ['/workspace/account.json', '/workspace/balance.json'],
    {label: 'periods_4', files: {'account.json': JSON.stringify({principal: '1000.00', rate: '0.0125'})}, env: {PERIODS: '4'}},
    {label: 'periods_12', files: {'account.json': JSON.stringify({principal: '1000.00', rate: '0.0125'})}, env: {PERIODS: '12'}},
    ['fs-io', 'env-io']);

  // 78. d3/d3-dispatch (JS) — Browser DOM event dispatcher wiring interactive panel state + localStorage
  r = await loadRepo('d3__d3-dispatch', ['src']);
  addBrowserPair(r, 'd3dispatch_panel_dom', 'app_d3dispatch_dom.js', `import { dispatch } from './src/index.js';

export function run(tabName) {
  const prevTab = localStorage.getItem('panel:tab') || 'overview';
  const bus = dispatch('switch');
  const root = document.getElementById('app');
  const log = [];
  bus.on('switch.dom', (next) => {
    root.innerHTML = '<section data-tab="' + next + '">Active: ' + next + '</section>';
    log.push('dom:' + next);
  });
  bus.on('switch.storage', (next) => {
    localStorage.setItem('panel:tab', next);
    log.push('saved:' + next);
  });
  bus.call('switch', null, tabName);
  return { prevTab, nextTab: tabName, log, html: root.innerHTML };
}
`, 'run', ['metrics'],
    {label: 'from_overview', storage: {local: {'panel:tab': 'overview'}}},
    {label: 'from_logs', storage: {local: {'panel:tab': 'logs'}}},
    ['browser-storage']);

  // 79. tnfe/limu (TS) — Browser DOM immutable Kanban state board + localStorage + confirm archive
  r = await loadRepo('tnfe__limu', ['src']);
  addBrowserPair(r, 'limu_kanban_dom', 'app_limu_dom.ts', `import { produce } from './src/index.ts';

interface Board { col: string; cards: string[]; archived: number; }

export function run(newCard: string) {
  const base: Board = JSON.parse(localStorage.getItem('kanban:state') || '{"col":"todo","cards":[],"archived":0}');
  const archiveOld = base.cards.length >= 2 && confirm('Archive oldest card?');
  const next = produce(base, draft => {
    if (archiveOld) {
      draft.cards.shift();
      draft.archived++;
    }
    draft.cards.push(newCard);
  });
  const root = document.getElementById('app')!;
  root.innerHTML = '<div data-archived="' + next.archived + '">' + next.cards.join(',') + '</div>';
  localStorage.setItem('kanban:state', JSON.stringify(next));
  return { archiveOld, next, html: root.innerHTML };
}
`, 'run', ['Ship-Stage11'],
    {label: 'archive_confirmed', storage: {local: {'kanban:state': JSON.stringify({col: 'todo', cards: ['Fix-A', 'Fix-B'], archived: 0})}}, dialogs: {confirm: [true]}},
    {label: 'archive_skipped', storage: {local: {'kanban:state': JSON.stringify({col: 'todo', cards: ['Fix-A', 'Fix-B'], archived: 0})}}, dialogs: {confirm: [false]}},
    ['typescript', 'browser-storage', 'browser-dialog']);

  // 80. scurker/currency.js (JS) — Browser DOM checkout total widget with localStorage currency + fetch
  r = await loadRepo('scurker__currency-js', ['src']);
  addBrowserPair(r, 'currencyjs_checkout_dom', 'app_currency_dom.js', `import currency from './src/currency.js';

export async function run(cartUrl) {
  const symbol = localStorage.getItem('shop:symbol') || '$';
  const resp = await fetch(cartUrl);
  const { items } = await resp.json();
  let sum = currency(0, { symbol });
  for (const x of items) sum = sum.add(currency(x.price, { symbol }).multiply(x.qty));
  const root = document.getElementById('app');
  root.innerHTML = '<strong id="cart-total">' + sum.format() + '</strong>';
  localStorage.setItem('shop:formattedTotal', sum.format());
  return { symbol, formatted: sum.format(), html: root.innerHTML };
}
`, 'run', ['https://app.example.test/api/bag'],
    {label: 'usd_symbol', storage: {local: {'shop:symbol': '$'}}, httpHandler: () => ({status: 200, body: {items: [{price: '24.50', qty: 2}, {price: '9.99', qty: 1}]}})},
    {label: 'eur_symbol', storage: {local: {'shop:symbol': '€'}}, httpHandler: () => ({status: 200, body: {items: [{price: '24.50', qty: 2}, {price: '9.99', qty: 1}]}})},
    ['browser-storage', 'http-io']);

  return scenarios;
}

async function runStatefulAndBrowserEngine({
  cacheDir,
  forbidden,
  stage10,
  usedIds,
  usedHashes,
  onAdmitRows,
  errorLogFn,
}) {
  const httpServer = createDeterministicHttpServer();
  const port = await httpServer.start();
  const admitted = [];
  let pairsVerified = 0;

  try {
    const scenarios = await buildWave3StatefulAndBrowserScenarios(cacheDir, port, {forbidden, stage10, errorLogFn});
    console.error(`[stateful+browser] Built ${scenarios.length} real-OSS stateful/browser pair scenarios (${scenarios.length * 2} candidate tasks)`);

    for (const scen of scenarios) {
      const splitComponent = sha256(`wave3-oss:${scen.envKind}:${scen.repo}:${scen.slug}`);
      if (forbidden.splitComponents.has(splitComponent)) {
        errorLogFn({stage: 'stateful-forbidden', repo: scen.repo, slug: scen.slug, error: 'split-component-collision'});
        continue;
      }

      const variantRows = [];
      let scenOk = true;

      for (const variant of scen.variants) {
        const taskId = `w3-${scen.envKind === 'browser' ? 'dom' : 'io'}-${slugify(scen.repo)}-${slugify(scen.slug)}-${slugify(variant.suffix)}`;
        if (usedIds.has(taskId) || forbidden.ids.has(taskId) || stage10.ids.has(taskId)) {
          scenOk = false;
          break;
        }

        const isTs = TS_EXT_RE.test(scen.entryFile) || Object.keys(scen.files).some(p => TS_EXT_RE.test(p));
        const family = `oss-wave3-${scen.envKind}/${scen.repo}/${scen.slug}`;
        if (forbidden.families.has(family)) {
          scenOk = false;
          break;
        }

        try {
          let probe;
          if (scen.envKind === 'browser') {
            probe = await runLiveBrowserCapture({
              files: scen.files,
              entryFile: scen.entryFile,
              entry: scen.entry,
              args: scen.args,
              initialHtml: variant.initialHtml ?? DEFAULT_BROWSER_HTML,
              initialUrl: variant.initialUrl ?? DEFAULT_BROWSER_URL,
              storage: variant.storage ?? {},
              dialogs: variant.dialogs ?? {},
              httpHandler: variant.httpHandler ?? null,
              now: variant.now ?? [],
            });
          } else {
            httpServer.setRoutes(variant.httpRoutes ?? {});
            probe = await runLiveNodeIoCapture({
              files: scen.files,
              entryFile: scen.entryFile,
              entry: scen.entry,
              args: scen.args,
              worldFiles: variant.files ?? {},
              worldEnv: variant.env ?? {},
              initGit: Boolean(variant.initGit),
              postGitWrites: variant.postGitWrites ?? null,
            });
          }

          if (!probe.ok) throw new Error(`live probe failed: ${probe.error}`);
          if (!probe.recordedCalls.length) throw new Error('live probe recorded 0 external I/O calls');

          const task = {
            id: taskId,
            family,
            language: isTs ? 'ts' : 'js',
            ...(scen.envKind === 'browser' ? {
              environment: 'browser',
              initialHtml: variant.initialHtml ?? DEFAULT_BROWSER_HTML,
              initialUrl: variant.initialUrl ?? DEFAULT_BROWSER_URL,
            } : {}),
            executionMode: 'native',
            files: scen.files,
            entryFile: scen.entryFile,
            entry: scen.entry,
            initialLoadedFiles: [scen.entryFile],
            args: encodeReadable(scen.args),
            fixture: {calls: probe.recordedCalls},
            randomSeed: 17,
            timeoutMs: 25000,
            tier: 5,
            features: [...scen.features, ...(isTs ? ['typescript'] : ['javascript'])],
            metadata: {
              repo: scen.repo,
              github: scen.github,
              domain: scen.domain,
              license: scen.license,
              scenario: scen.slug,
              variant: variant.suffix,
              harvestMode: scen.envKind === 'browser' ? 'browser-dom-pair' : 'stateful-io-pair',
              real_oss: true,
              stateful_io: scen.envKind !== 'browser',
              browser_dom: scen.envKind === 'browser',
              pair_id: scen.pairId,
              fileCount: Object.keys(scen.files).length,
            },
          };

          const exported = await verifyAndExportWave3Task2x(task, {
            splitComponent,
            pairId: scen.pairId,
            requireExternalCalls: true,
            minCodeLoadCalls: 1,
          });
          if (forbidden.sourceHashes.has(exported.sourceHash) || stage10.sourceHashes.has(exported.sourceHash)) {
            throw new Error('external sourceHash collision');
          }
          variantRows.push(exported);
        } catch (err) {
          errorLogFn({stage: `stateful-${scen.envKind}`, repo: scen.repo, slug: scen.slug, variant: variant.suffix, error: String(err?.message ?? err).slice(0, 260)});
          scenOk = false;
          break;
        }
      }

      if (!scenOk || variantRows.length !== 2) continue;

      // Ensure both sides of pair use identical traceFormat before causal prefix audit
      const fmtA = variantRows[0].metadata?.traceFormat ?? 'compact';
      const fmtB = variantRows[1].metadata?.traceFormat ?? 'compact';
      if (fmtA !== fmtB) {
        try {
          variantRows[0] = await verifyAndExportWave3Task2x(variantRows[0].task, {
            traceFormat: 'actions-only',
            splitComponent,
            pairId: scen.pairId,
            requireExternalCalls: true,
          });
          variantRows[1] = await verifyAndExportWave3Task2x(variantRows[1].task, {
            traceFormat: 'actions-only',
            splitComponent,
            pairId: scen.pairId,
            requireExternalCalls: true,
          });
        } catch (err) {
          errorLogFn({stage: 'stateful-align', repo: scen.repo, slug: scen.slug, error: String(err?.message ?? err).slice(0, 220)});
          continue;
        }
      }

      // Note: Browser pairs with differing initialUrl/initialHtml have intentionally different prompts;
      // check causal prefix audit when prompts are identical, or verify distinct outcomes otherwise.
      try {
        const promptA = variantRows[0].messages.find(m => m.role === 'user');
        const promptB = variantRows[1].messages.find(m => m.role === 'user');
        if (isDeepStrictEqual(promptA, promptB)) {
          const pairAudit = auditCausalPrefixPair(variantRows[0].messages, variantRows[1].messages);
          variantRows[0].metadata.causalPairAudit = pairAudit;
          variantRows[1].metadata.causalPairAudit = pairAudit;
        } else {
          // Different initialUrl/initialHtml browser state pair — verify distinct outcomes
          const lastA = variantRows[0].messages.at(-1);
          const lastB = variantRows[1].messages.at(-1);
          if (isDeepStrictEqual(lastA, lastB)) {
            throw new Error('Browser state variants produced identical final outcome');
          }
          const pairAudit = {passed: true, testedDivergence: true, mode: 'browser-env-variant'};
          variantRows[0].metadata.causalPairAudit = pairAudit;
          variantRows[1].metadata.causalPairAudit = pairAudit;
        }
        pairsVerified++;
      } catch (err) {
        errorLogFn({stage: 'stateful-causal-audit', repo: scen.repo, slug: scen.slug, error: String(err?.message ?? err).slice(0, 220)});
        continue;
      }

      for (const row of variantRows) {
        admitted.push(row);
        usedIds.add(row.id);
        usedHashes.add(row.sourceHash);
      }
      onAdmitRows(variantRows);
      console.error(`[stateful+${scen.envKind}] OK ${scen.repo}/${scen.slug} (+2 pair tasks, files=${variantRows[0].metadata.fileCount}, ops=${variantRows[0].metadata.externalOps.join(',')})`);
    }
  } finally {
    await httpServer.stop();
  }

  console.error(`[stateful+browser] Complete: ${admitted.length} verified tasks (${pairsVerified} complete causal pairs)`);
  return admitted;
}

// ==================== Engine 1: Pure Multi-File OSS Harvester (Modes A, B, C1) ====================

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
          let hasValueBindings = !clause;
          if (clause && !isTypeOnly) {
            if (clause.name) hasValueBindings = true;
            if (clause.namedBindings) {
              if (ts.isNamespaceImport(clause.namedBindings)) hasValueBindings = true;
              else if (ts.isNamedImports(clause.namedBindings)) {
                hasValueBindings = clause.namedBindings.elements.some(el => !el.isTypeOnly);
              }
            }
          }
          if (hasValueBindings && ts.isStringLiteral(node.moduleSpecifier)) {
            specs.add(node.moduleSpecifier.text);
          }
        } else if (ts.isExportDeclaration(node)) {
          if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            let hasValue = !node.exportClause;
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
    } catch {}
  }

  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  const importRe = /(?:^|[;\n])\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
  const requireRe = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  for (const m of stripped.matchAll(importRe)) specs.add(m[1]);
  for (const m of stripped.matchAll(requireRe)) specs.add(m[1]);
  return [...specs];
}

function walkSourceFiles(rootDir, maxDepth = 6, maxFiles = 360) {
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
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) visit(join(dir, entry.name), depth + 1);
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
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name)) continue;
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
  tryRoot(join(base, 'esm'));
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

export function buildMultiFilePackagesV3(repoDir, {
  subpath = null,
  minFiles = 5,
  maxFiles = 210,
  targetMinBytes = TARGET_MIN_CODEBASE_BYTES,
  targetMaxBytes = TARGET_MAX_CODEBASE_BYTES,
  maxPackages = 8,
} = {}) {
  const clampedMaxFiles = Math.min(MAX_CODEBASE_FILES - 16, Math.max(minFiles, maxFiles));
  const packages = [];
  const seenFileSets = new Set();

  const mapPurePath = p => (p.endsWith('.mjs') ? p.slice(0, -4) + '.js' : p);
  const normPureCode = (norm, raw) => {
    let out = raw;
    if (out.includes('~/') && norm.startsWith('src/')) out = rewriteTildeAlias(out, norm, 'src');
    out = out.replace(/(from\s+['"])\.\/(['"])/g, '$1./index$2');
    out = out.replace(/(from\s+['"])\.(['"])/g, '$1./index$2');
    out = out.replace(/(['"])(\.\.?\/[^'"]+)\.mjs\1/g, '$1$2.js$1');
    return out;
  };

  const repoWideAbs = walkSourceFiles(subpath && existsSync(join(repoDir, subpath)) ? join(repoDir, subpath) : repoDir, 5, 280);
  const repoWideFiles = {};
  for (const abs of repoWideAbs) {
    const relRaw = mapPurePath(relative(repoDir, abs).replaceAll('\\', '/'));
    let norm;
    try { norm = normalizeRepoPath(relRaw); } catch { continue; }
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    repoWideFiles[norm] = normPureCode(norm, content);
  }

  for (const root of collectCandidateRoots(repoDir, subpath)) {
    const absFiles = walkSourceFiles(root, 6, 600);
    if (absFiles.length < 2) continue;

    const allFiles = {};
    for (const abs of absFiles) {
      const relRaw = mapPurePath(relative(repoDir, abs).replaceAll('\\', '/'));
      let norm;
      try { norm = normalizeRepoPath(relRaw); } catch { continue; }
      let content;
      try { content = readFileSync(abs, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      allFiles[norm] = normPureCode(norm, content);
    }

    const allPaths = Object.keys(allFiles).sort();
    if (allPaths.length < 2) continue;

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
        const aRich = Math.min(a.closure.size, 70);
        const bRich = Math.min(b.closure.size, 70);
        return (aIdx - bIdx) || (aTs - bTs) || (bRich - aRich) || a.path.localeCompare(b.path);
      });

    for (const {path: entryFile, closure} of entryCandidates.slice(0, 18)) {
      const selectedPaths = [...closure].sort();
      let totalBytes = selectedPaths.reduce((s, p) => s + Buffer.byteLength(allFiles[p], 'utf8'), 0);
      if (totalBytes > HARD_MAX_PACKAGE_BYTES) continue;

      const selectedSet = new Set(selectedPaths);
      const entryDir = pathPosix.dirname(entryFile);

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

      for (const distPath of distractors) {
        if (selectedPaths.length >= clampedMaxFiles) break;
        const b = Buffer.byteLength(pool[distPath], 'utf8');
        if (totalBytes + b > HARD_MAX_PACKAGE_BYTES) continue;
        if (selectedPaths.length >= Math.max(minFiles, closure.size + 8) && totalBytes >= targetMinBytes) {
          if (totalBytes + b > targetMaxBytes) break;
          if (totalBytes >= 135 * 1024 || selectedPaths.length >= 100) break;
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

function createProbeVmContext({recordedCalls, onOverflow, timeoutMs = 250}) {
  let clockMs = 1732000100000;
  let randState = 17 >>> 0;
  const nodeIoAdapter = {
    invokeSync(op, args) {
      if (op === 'env.get') {
        const key = String(args[0] ?? '');
        const val = key === 'NODE_ENV' ? 'production' : null;
        if (recordedCalls.length >= 16) { onOverflow(); return val; }
        recordedCalls.push({operation: 'env.get', arguments: encodeReadable([key]), status: 'fulfilled', result: encodeReadable(val)});
        return val;
      }
      if (op === 'platform.uuid') {
        const val = '00000000-0000-4000-8000-000000000017';
        if (recordedCalls.length >= 16) { onOverflow(); return val; }
        recordedCalls.push({operation: 'platform.uuid', arguments: [], status: 'fulfilled', result: encodeReadable(val)});
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
        recordedCalls.push({operation: 'platform.randomBytes', arguments: encodeReadable([n]), status: 'fulfilled', result: encodeReadable(b64)});
        return b64;
      }
      onOverflow();
      throw new Error('Unsupported node IO op in pure probe: ' + op);
    },
    invokeAsync(op) {
      onOverflow();
      return Promise.reject(new Error('Unsupported async node IO op: ' + op));
    },
  };

  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, Buffer,
    AbortController, AbortSignal, Blob,
    __platformNodeIo: createReplayNodeIoBridge(nodeIoAdapter),
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(lvl => [lvl, (...xs) => {
      if (recordedCalls.length >= 16) { onOverflow(); return; }
      try {
        recordedCalls.push({operation: 'platform.console.' + lvl, arguments: encodeReadable(xs), status: 'fulfilled', result: {$js: 'undefined'}});
      } catch { onOverflow(); }
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

export function discoverCallableExports(files, entryFile, {timeoutMs = 500} = {}) {
  const names = new Set();
  try {
    const entryInfo = analyzeSourceFile(files[entryFile], entryFile);
    for (const sym of entryInfo.symbols.values()) {
      if (sym.exported && (sym.kind === 'function' || sym.kind === 'export') &&
          /^[A-Za-z_$][\w$]*$/.test(sym.name) && !JS_RESERVED_WORDS.has(sym.name)) {
        names.add(sym.name);
      }
    }
  } catch {}

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

function extractReadmeCalls(repoDir, exportNames) {
  const byFn = new Map();
  const exportSet = new Set(exportNames);
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
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
  const aliases = [pkgName, pkgName.replace(/\.js$|-js$/i, ''), basename(entryFile).replace(/\.[^.]+$/, '')];

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
  try {
    const readmeCalls = extractReadmeCalls(repoDir, exportNames);
    for (const [fn, calls] of readmeCalls.entries()) {
      const existing = byFn.get(fn) ?? [];
      for (const c of calls) {
        if (existing.length < 20 && !existing.some(x => x.sig === c.sig)) existing.push(c);
      }
      if (existing.length) byFn.set(fn, existing);
    }
  } catch {}
  return byFn;
}

function generateDomainProbes(fnName, domain) {
  const lower = fnName.toLowerCase();
  const candidates = [];

  const domainBanks = {
    html: [
      ['<div class="card"><h1 id="t">Hello</h1><p>World &amp; <b>more</b></p></div>'],
      ['<ul><li>one</li><li>two</li></ul>'],
    ],
    xml: [
      ['<catalog><item id="1"><name>Widget</name><price>19.99</price></item></catalog>'],
      [{root: {item: [{id: 1, name: 'a'}, {id: 2, name: 'b'}]}}],
    ],
    svg: [
      ['M 10 20 L 30 40 C 50 60 70 80 90 100 Z'],
    ],
    yaml: [
      ['name: service\nversion: 2\nenabled: true\ntags:\n  - prod\n  - edge\n'],
      [{service: 'api', replicas: 3, flags: ['v2', 'canary']}],
    ],
    toml: [
      ['title = "Service"\n[server]\nhost = "127.0.0.1"\nport = 8080\n'],
      [{title: 'App', server: {host: 'localhost', port: 3000}}],
    ],
    json5: [
      ['{\n  // comment\n  unquoted: \'single\', trailing: [1, 2, 3,], hex: 0x1a,\n}'],
      [{name: 'widget', count: 4}],
    ],
    sql: [
      ['SELECT u.id, u.name FROM users u WHERE u.active = 1 ORDER BY u.id DESC LIMIT 10;'],
    ],
    'js-parser': [
      ['function sum(xs) { let total = 0; for (const x of xs) total += x; return total; }'],
      ['export const add = (a, b) => a + b * 2;'],
    ],
    ast: [
      ['const x = 1 + 2 * 3;'],
      [{type: 'Program', body: [{type: 'VariableDeclaration', kind: 'const', declarations: [{type: 'VariableDeclarator', id: {type: 'Identifier', name: 'x'}, init: {type: 'Literal', value: 42}}]}]}],
    ],
    parser: [
      ['a + b * (c - 2)'],
      ['hello 123 world'],
    ],
    css: [
      ['main > ul.nav li:nth-child(2n+1) > a[href^="https"]:hover'],
      ['.card { color: #224466; padding: 8px 16px; }'],
      ['2n+1'],
      ['px-2 py-1 bg-red-500 p-4 bg-blue-600'],
      ['text-sm font-bold', 'text-lg text-gray-800'],
    ],
    expr: [
      ['(2 + 3) * 4 - 6 / 2'],
      ['price * qty - discount'],
      ['a > 5 && b <= 10'],
    ],
    markdown: [
      ['# Release Notes\n\nParagraph with *italic*, **bold**, and `code`.\n\n- First\n- Second\n'],
      ['<h1>Title</h1><p>Hello <strong>world</strong></p>'],
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
      ['/api/v1/items/:slug'],
      ['/files/*path'],
    ],
    template: [
      ['Hello <%= it.name %>! Count: <%= it.count + 1 %>', {name: 'Ada', count: 4}],
      ['Hello {{name}}! Items: {{count}}', {name: 'Ada', count: 3}],
    ],
    query: [
      ['a=1&b[c]=two&b[d][0]=x&flag=true'],
      [{filter: {status: 'open', tags: ['v1', 'v2']}, page: 2}],
    ],
    url: [
      ['https://user:pass@example.com:8443/api/v2/items?sort=asc&limit=10#top'],
      ['Check https://example.org/docs and mailto:dev@example.org today.'],
      ['https://example.com/a/b/', '../c/d.js'],
    ],
    http: [
      ['session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'],
      ['text/html,application/xhtml+xml;q=0.9,application/json;q=0.8'],
      ['en-US,en;q=0.9,fr;q=0.5'],
    ],
    mime: [
      ['application/json'],
      ['index.html'],
      ['archive.tar.gz'],
    ],
    jwt: [
      ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSJ9.sig'],
    ],
    network: [
      ['192.168.1.42'],
      ['2001:db8::1'],
      ['10.0.0.0/24'],
    ],
    ua: [
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'],
      ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
      ['GPTBot/1.0 (+https://openai.com/gptbot)'],
    ],
    date: [
      [new Date('2025-11-27T10:30:00Z')],
      [new Date('2025-11-27T10:30:00Z'), 5],
      [new Date('2025-11-27T10:30:00Z'), new Date('2025-01-15T08:00:00Z')],
      ['2025-11-27T10:30:00Z'],
      ['next Friday at 3pm'],
    ],
    currency: [
      ['$1,234.56'],
      [1234.56],
    ],
    color: [
      ['#3b82f6'],
      [[59, 130, 246]],
      ['rgb(59, 130, 246)'],
    ],
    math: [
      [[1, 2, 3, 4, 5]],
      [[1, 2, 3], [4, 5, 6]],
      [[[1, 2], [3, 4]]],
      [[[1, 2], [3, 4], [5, 6]], 2],
      [12, 18],
      [17],
      [0.5, 0, 1],
      ['2 * (3 + 4)^2'],
    ],
    geo: [
      [[[0, 0], [4, 0], [4, 3], [0, 3]]],
      [[0, 0, 10, 0, 10, 10, 0, 10]],
      [[[0, 0], [2, 0], [1, 2]], [1, 1]],
      [0, 0, 5, 3, 4],
      [0, 0, 5, 6, 0, 5],
      [0, 0, 10, 10, 5, 5],
      [{type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]}],
    ],
    search: [
      [{schema: {title: 'string', body: 'string'}}],
    ],
    crypto: [
      [new Uint8Array([104, 101, 108, 108, 111])],
      ['hello world'],
      ['secret-key', 'message-payload'],
    ],
    encoding: [
      [new Uint8Array([1, 2, 3, 4, 5, 255])],
      [[1, 2, 3]],
      ['Hello, World! 12345'],
      ['AAAB,CAAC;EAAE'],
    ],
    sourcemap: [
      ['AAAA;AACA,GAAG;AACH'],
      [[[[0, 0, 0, 0]], [[0, 0, 1, 0], [3, 0, 1, 3]]]],
    ],
    compression: [
      ['The quick brown fox jumps over the lazy dog. '.repeat(4)],
      [new Uint8Array([65, 66, 67, 65, 66, 67, 65, 66, 67, 68, 69])],
    ],
    diff: [
      [{a: 1, b: [1, 2, 3], c: {x: 'old'}}, {a: 1, b: [1, 4, 3], c: {x: 'new', y: 2}}],
    ],
    cli: [
      [['--port', '8080', '-v', '--tag', 'alpha', 'serve']],
    ],
    table: [
      [[['Name', 'Role'], ['Ada', 'Admin'], ['Grace', 'Lead']]],
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
      ['{"ok":true,"count":42}'],
      [{id: 1, tags: ['a', 'b'], nested: {ok: true}}],
    ],
    schema: [
      [{name: 'alice', age: 30, active: true}],
      ['hello'],
      [42],
    ],
    validator: [
      ['hello@example.com'],
      [[1, 2, 3]],
      [{a: 1}],
    ],
    state: [
      [{count: 0, items: ['a', 'b']}],
    ],
    reactive: [
      [42],
      [{count: 1}],
    ],
    'state-machine': [
      [{id: 'toggle', initial: 'off', states: {off: {on: {FLIP: 'on'}}, on: {on: {FLIP: 'off'}}}}],
    ],
    i18n: [
      ['hello.world'],
      [{hello: {world: 'Hello %{name}!'}}],
    ],
    'string-ast': [
      ['line1\nline2\nline3', 8],
    ],
  };

  if (domain && domainBanks[domain]) candidates.push(...domainBanks[domain]);

  if (/stringify|serialize|format|encode|compress|dump|pack|render|compile/.test(lower)) {
    candidates.push([{a: 1, b: 'two', list: [1, 2, 3]}], ['hello world'], [[1, 2, 3, 4]]);
  }
  if (/parse|decode|decompress|unpack|lex|token|scan|split|extract/.test(lower)) {
    candidates.push(['{"a":1,"b":[2,3]}'], ['a=1&b=two&c=3'], ['1 + 2 * 3'], ['foo/bar/baz.ts']);
  }
  if (/equal|same|match|compare|diff|patch|merge|assign|clone|copy/.test(lower)) {
    candidates.push([{a: 1, b: [2, 3]}, {a: 1, b: [2, 4]}], [{a: 1, b: {c: 2}}, {b: {d: 3}, e: 4}], ['src/a/b.ts', 'src/**/*.ts']);
  }
  if (/chunk|zip|uniq|group|sort|flatten|partition|slice|take|drop|pick|omit|sum|mean|clamp|range/.test(lower)) {
    candidates.push([[1, 2, 3, 4, 5, 6], 2], [[3, 1, 4, 1, 5, 9]], [{a: 1, b: 2, c: 3}, ['a', 'c']], [1, 10, 2]);
  }
  if (/date|day|month|year|week|hour|minute|second|time|iso|add|sub/.test(lower)) {
    candidates.push([new Date('2025-11-27T10:30:00Z')], [new Date('2025-11-27T10:30:00Z'), 3], [new Date('2025-11-27T10:30:00Z'), new Date('2025-11-20T10:30:00Z')]);
  }

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
      onCodeLoadEvent(req) { codeLoadEvents.push(req); },
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

// ==================== Mode C1: 1-Line AST Mutation Generator ====================

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function getLineText(text, lineNum) {
  return text.split('\n')[lineNum - 1] ?? '';
}

const BINARY_OP_FLIPS = {
  '<': '<=', '<=': '<', '>': '>=', '>=': '>',
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '+': '-', '-': '+', '&&': '||', '||': '&&',
};

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
      start, end, replacement, kind, line,
      beforeLine: beforeLine.trim().slice(0, 160),
      afterLine: afterLine.trim().slice(0, 160),
      mutated,
      priority: (inPreferred ? 0 : 10) +
        (kind.startsWith('binary-cmp') ? 0 : kind.startsWith('arith') ? 1 : kind.startsWith('guard') ? 2 : 3),
    });
  };

  let sf;
  try {
    const scriptKind = relPath.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : TS_EXT_RE.test(relPath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, scriptKind);
  } catch {
    return [];
  }

  function isInsideForIncrementor(node) {
    let cur = node.parent;
    while (cur) {
      if (ts.isForStatement(cur) && cur.incrementor && node.pos >= cur.incrementor.pos && node.end <= cur.incrementor.end) return true;
      if (ts.isTypeNode(cur) || ts.isInterfaceDeclaration(cur) || ts.isTypeAliasDeclaration(cur)) return true;
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
          const kind = ['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(opText)
            ? 'binary-cmp' : (opText === '+' || opText === '-' ? 'arith-op' : 'logic-op');
          pushCandidate(opStart, opEnd, BINARY_OP_FLIPS[opText], kind);
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
    const preferredLineRanges = [];
    const info = analyzeSourceFile(src, targetFile);
    for (const ev of baseHit.codeLoadEvents) {
      if (ev.path === targetFile && ev.symbol && info.symbols.has(ev.symbol)) {
        const sym = info.symbols.get(ev.symbol);
        preferredLineRanges.push([sym.startLine, sym.endLine]);
      }
    }

    const candidates = generateAst1LineMutations(src, targetFile, {preferredLineRanges, maxCandidates: 16});
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

export async function harvestSinglePureRepo({
  repoEntry,
  repoDir,
  forbidden,
  stage10,
  usedIds,
  usedHashes,
  maxPerRepo = 9,
  maxPerFn = 2,
  minFiles = 5,
  maxFiles = 210,
  maxPairsPerRepo = 3,
  enableMutations = true,
  repoTimeoutMs = 95_000,
  errorLogFn = () => {},
}) {
  const deadline = Date.now() + repoTimeoutMs;
  const rows = [];
  const packages = buildMultiFilePackagesV3(repoDir, {
    subpath: repoEntry.subpath ?? null,
    minFiles,
    maxFiles,
    maxPackages: 6,
  });
  if (!packages.length) {
    errorLogFn({stage: 'package', repo: repoEntry.slug, error: 'no-valid-multifile-packages'});
    return rows;
  }

  const splitComponent = sha256(`oss-wave3-pure:${repoEntry.slug}`);
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

    const realTestMap = collectRealTestArgs(repoDir, repoEntry, exportFns, pkg.entryFile);
    const rankedFns = [...exportFns].sort((a, b) => {
      const aHas = (realTestMap.get(a)?.length ?? 0) > 0 ? 0 : 1;
      const bHas = (realTestMap.get(b)?.length ?? 0) > 0 ? 0 : 1;
      return (aHas - bHas) || a.localeCompare(b);
    });

    const pkgCache = {analysisCache: new Map(), cjsCache: new Map()};
    let pkgFatal = false;

    for (const fnName of rankedFns.slice(0, 36)) {
      if (pkgFatal || rows.length >= maxPerRepo || Date.now() > deadline) break;
      let fnTasks = 0;
      const seenOutcomeSigs = new Set();

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

      acceptedHits.sort((a, b) => {
        const aMulti = a.loadedPaths.size >= 2 ? 0 : 1;
        const bMulti = b.loadedPaths.size >= 2 ? 0 : 1;
        const aReal = a.probe.mode === 'real-test' ? 0 : 1;
        const bReal = b.probe.mode === 'real-test' ? 0 : 1;
        return (aMulti - bMulti) || (aReal - bReal) || (b.loadedPaths.size - a.loadedPaths.size);
      });

      for (const {probe, hit} of acceptedHits) {
        if (fnTasks >= maxPerFn || rows.length >= maxPerRepo) break;

        const isTs = TS_EXT_RE.test(pkg.entryFile) || Object.keys(pkg.files).some(p => TS_EXT_RE.test(p));
        const hasSymbolLoad = hit.codeLoadEvents.some(e => Boolean(e.symbol));
        const hasWholeFileLoad = hit.codeLoadEvents.some(e => !e.symbol);
        seq++;

        const baseId = `w3-${slugify(repoEntry.slug)}-${slugify(fnName)}-${seq}`;
        const family = `oss-wave3-pure/${repoEntry.slug}/${pkg.entryFile}`;

        if (usedIds.has(baseId) || forbidden.ids.has(baseId) || stage10.ids.has(baseId) || forbidden.families.has(family)) {
          continue;
        }

        let pairVariant = null;
        if (enableMutations && repoPairs < maxPairsPerRepo && rows.length + 2 <= maxPerRepo) {
          try {
            pairVariant = await findMutationVariant(pkg, fnName, probe.args, hit);
          } catch {}
        }

        const pairId = pairVariant ? `wave3-mut-pair:${repoEntry.slug}:${slugify(fnName)}:${seq}` : null;

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
          timeoutMs: 25000,
          tier: (callHit.codeLoadEvents.length >= 2 || isMutated || callHit.recordedCalls.length > 0) ? 5 : 4,
          features: [
            'wave3-oss',
            'multi-file',
            'code-load',
            'native-v8',
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
            real_oss: true,
            stateful_io: false,
            browser_dom: false,
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
          exportedBase = await verifyAndExportWave3Task2x(baseTask, {
            splitComponent,
            pairId,
            requireExternalCalls: false,
            minCodeLoadCalls: 1,
          });
        } catch (err) {
          errorLogFn({stage: 'export-base', repo: repoEntry.slug, id: baseId, error: String(err?.message ?? err).slice(0, 240)});
          continue;
        }

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
            exportedMut = await verifyAndExportWave3Task2x(mutTask, {
              splitComponent,
              pairId,
              requireExternalCalls: false,
              minCodeLoadCalls: 1,
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

// ==================== Comprehensive 5-Axis Zero-Leakage + Stage 10 Dedup Audit ====================

export function auditWave3Dataset(rows, {forbidden, stage10, catalogStats = null} = {}) {
  const realExecOverlaps = {task_id: [], family: [], sourceHash: [], split_component: [], repo: []};
  const stage10Overlaps = {task_id: [], sourceHash: [], repo: []};
  const seenIds = new Set();
  const duplicateIds = [];

  const byRepo = {};
  const byLanguage = {js: 0, ts: 0};
  const reposByLanguage = {js: new Set(), ts: new Set()};
  const byMode = {
    'real-test': 0,
    'api-probe': 0,
    'oss-mutation-pair': 0,
    'stateful-io-pair': 0,
    'browser-dom-pair': 0,
  };
  const byCategory = {pure_multifile: 0, stateful_io: 0, browser_dom: 0};
  const reposByCategory = {pure_multifile: new Set(), stateful_io: new Set(), browser_dom: new Set(), stateful_or_browser: new Set()};
  const pairGroups = new Map();
  const astMutationPairGroups = new Map();
  const statefulPairGroups = new Map();
  const browserPairGroups = new Map();
  const externalOpCounts = {};

  let validPreexported = 0;
  let verified2x = 0;
  let liveReplayed = 0;
  let withinContextBudget = 0;
  let withinTurnBudget = 0;

  const episodeTokens = [];
  const turnTokens = [];
  const fileCounts = [];
  const codebaseTokens = [];
  const codeLoadCounts = [];

  for (const row of rows) {
    const tid = String(row.id ?? '');
    if (seenIds.has(tid)) duplicateIds.push(tid);
    seenIds.add(tid);

    if (forbidden.ids.has(tid)) realExecOverlaps.task_id.push(tid);
    if (forbidden.families.has(String(row.family ?? ''))) realExecOverlaps.family.push(row.family);
    if (forbidden.sourceHashes.has(String(row.sourceHash ?? ''))) realExecOverlaps.sourceHash.push(row.sourceHash);
    if (forbidden.splitComponents.has(String(row.split_component ?? ''))) realExecOverlaps.split_component.push(row.split_component);

    const repo = String(row.metadata?.repo ?? row.task?.metadata?.repo ?? '');
    const github = String(row.metadata?.github ?? row.task?.metadata?.github ?? '');
    if (isRepoBlocked(repo, github, forbidden)) realExecOverlaps.repo.push(repo);

    if (stage10.ids.has(tid)) stage10Overlaps.task_id.push(tid);
    if (stage10.sourceHashes.has(String(row.sourceHash ?? ''))) stage10Overlaps.sourceHash.push(row.sourceHash);
    if (isRepoBlocked(repo, github, stage10)) stage10Overlaps.repo.push(repo);

    if (isPreexportedRow(row) && typeof row.split_component === 'string' && row.split_component.length > 0) {
      validPreexported++;
    }
    if (row.metadata?.deterministic2xVerified && row.metadata?.traceAudit?.replayVerified) verified2x++;
    if (row.metadata?.liveSessionReplayVerified) liveReplayed++;

    const lang = row.task?.language === 'ts' ? 'ts' : 'js';
    byLanguage[lang]++;
    if (repo) reposByLanguage[lang].add(repo);

    const mode = row.metadata?.harvestMode ?? 'api-probe';
    if (Object.hasOwn(byMode, mode)) byMode[mode]++;

    const isBrowser = Boolean(row.metadata?.browser_dom || row.task?.environment === 'browser');
    const isStateful = Boolean(row.metadata?.stateful_io);
    if (isBrowser) {
      byCategory.browser_dom++;
      if (repo) { reposByCategory.browser_dom.add(repo); reposByCategory.stateful_or_browser.add(repo); }
    } else if (isStateful) {
      byCategory.stateful_io++;
      if (repo) { reposByCategory.stateful_io.add(repo); reposByCategory.stateful_or_browser.add(repo); }
    } else {
      byCategory.pure_multifile++;
      if (repo) reposByCategory.pure_multifile.add(repo);
    }

    if (row.pair_id) {
      if (!pairGroups.has(row.pair_id)) pairGroups.set(row.pair_id, []);
      pairGroups.get(row.pair_id).push(tid);
      if (row.pair_id.startsWith('wave3-mut-pair:')) {
        if (!astMutationPairGroups.has(row.pair_id)) astMutationPairGroups.set(row.pair_id, []);
        astMutationPairGroups.get(row.pair_id).push(tid);
      } else if (row.pair_id.startsWith('wave3-stateful-pair:')) {
        if (!statefulPairGroups.has(row.pair_id)) statefulPairGroups.set(row.pair_id, []);
        statefulPairGroups.get(row.pair_id).push(tid);
      } else if (row.pair_id.startsWith('wave3-browser-pair:')) {
        if (!browserPairGroups.has(row.pair_id)) browserPairGroups.set(row.pair_id, []);
        browserPairGroups.get(row.pair_id).push(tid);
      }
    }

    for (const call of row.task?.fixture?.calls ?? []) {
      const op = call.operation ?? 'unknown';
      externalOpCounts[op] = (externalOpCounts[op] ?? 0) + 1;
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

    if (!byRepo[repo]) {
      byRepo[repo] = {
        tasks: 0,
        language: lang,
        domain: row.metadata?.domain ?? 'unknown',
        pureTasks: 0,
        statefulTasks: 0,
        browserTasks: 0,
        pairTasks: 0,
        fileCountMin: Infinity,
        fileCountMax: 0,
      };
    }
    const rs = byRepo[repo];
    rs.tasks++;
    if (isBrowser) rs.browserTasks++;
    else if (isStateful) rs.statefulTasks++;
    else rs.pureTasks++;
    if (row.pair_id) rs.pairTasks++;
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
  const completeAstPairs = [...astMutationPairGroups.values()].filter(g => g.length === 2).length;
  const completeStatefulPairs = [...statefulPairGroups.values()].filter(g => g.length === 2).length;
  const completeBrowserPairs = [...browserPairGroups.values()].filter(g => g.length === 2).length;

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
    stage10Overlaps.sourceHash.length === 0 &&
    stage10Overlaps.repo.length === 0;

  return {
    schema: 'oss-js-wave3-audit/1',
    generated_at: new Date().toISOString(),
    totals: {
      tasks: rows.length,
      distinct_repos: distinctRepos,
      ts_repos: tsReposCount,
      js_repos: jsReposCount,
      ts_repo_ratio: distinctRepos ? Math.round((tsReposCount / distinctRepos) * 1000) / 1000 : 0,
      ts_task_ratio: rows.length ? Math.round((byLanguage.ts / rows.length) * 1000) / 1000 : 0,
      by_language: byLanguage,
      by_category: byCategory,
      stateful_and_browser_tasks: byCategory.stateful_io + byCategory.browser_dom,
      distinct_repos_by_category: {
        pure_multifile: reposByCategory.pure_multifile.size,
        stateful_io: reposByCategory.stateful_io.size,
        browser_dom: reposByCategory.browser_dom.size,
        stateful_or_browser: reposByCategory.stateful_or_browser.size,
      },
      by_harvest_mode: byMode,
      counterfactual_pairs_complete: completePairs,
      counterfactual_pair_breakdown: {
        ast_mutation_pairs: completeAstPairs,
        stateful_io_world_pairs: completeStatefulPairs,
        browser_dom_world_pairs: completeBrowserPairs,
      },
      counterfactual_pair_tasks: rows.filter(r => Boolean(r.pair_id)).length,
      duplicate_ids: duplicateIds.length,
    },
    external_op_call_counts: Object.fromEntries(Object.entries(externalOpCounts).sort((a, b) => a[0].localeCompare(b[0]))),
    distributions: {
      episode_approx_tokens: statsOf(episodeTokens),
      max_assistant_turn_tokens: statsOf(turnTokens),
      codebase_approx_tokens: statsOf(codebaseTokens),
      file_count: statsOf(fileCounts),
      code_load_calls: statsOf(codeLoadCounts),
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
      stage10_zero_dupe: {
        passed: stage10DedupPassed,
        overlap_counts: {
          task_id: stage10Overlaps.task_id.length,
          sourceHash: stage10Overlaps.sourceHash.length,
          repo: stage10Overlaps.repo.length,
        },
        overlaps: stage10Overlaps,
      },
      preexported_schema: {
        passed: validPreexported === rows.length && duplicateIds.length === 0,
        valid_rows: validPreexported,
        total_rows: rows.length,
      },
      determinism_2x_and_live_replay: {
        passed: verified2x === rows.length && liveReplayed === rows.length,
        verified_2x_rows: verified2x,
        live_replayed_rows: liveReplayed,
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

// ==================== Main CLI Orchestrator ====================

async function main() {
  const {values} = parseArgs({
    options: {
      'output-dir': {type: 'string', default: DEFAULT_OUTPUT_DIR},
      'cache-dir': {type: 'string', default: DEFAULT_CACHE_DIR},
      'realexec-bm': {type: 'string', default: DEFAULT_REALEXEC_BM},
      'realexec-man': {type: 'string', default: DEFAULT_REALEXEC_MAN},
      'stage10-jsonl': {type: 'string', default: DEFAULT_STAGE10_JSONL},
      'max-repos': {type: 'string', default: '300'},
      'max-tasks': {type: 'string', default: '680'},
      'max-per-repo': {type: 'string', default: '12'},
      'max-per-fn': {type: 'string', default: '3'},
      'max-pairs-per-repo': {type: 'string', default: '5'},
      'min-files': {type: 'string', default: '5'},
      'max-files': {type: 'string', default: '210'},
      'clone-concurrency': {type: 'string', default: '8'},
      'repo-concurrency': {type: 'string', default: '6'},
      'repo-timeout-ms': {type: 'string', default: '95000'},
      'resume': {type: 'boolean', default: true},
      'no-resume': {type: 'boolean', default: false},
      'only-stateful': {type: 'boolean', default: false},
      'only-pure': {type: 'boolean', default: false},
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
  const onlyStateful = Boolean(values['only-stateful']);
  const onlyPure = Boolean(values['only-pure']);
  const maxRepos = Math.max(1, Number(values['max-repos']) || 200);
  const maxTasks = Math.max(1, Number(values['max-tasks']) || 680);
  const maxPerRepo = Math.max(1, Number(values['max-per-repo']) || 9);
  const maxPerFn = Math.max(1, Number(values['max-per-fn']) || 2);
  const maxPairsPerRepo = Math.max(0, Number(values['max-pairs-per-repo']) || 3);
  const minFiles = Math.max(2, Number(values['min-files']) || 5);
  const maxFiles = Math.max(minFiles, Number(values['max-files']) || 210);
  const cloneConcurrency = Math.max(1, Number(values['clone-concurrency']) || 8);
  const repoConcurrency = Math.max(1, Number(values['repo-concurrency']) || 6);
  const repoTimeoutMs = Math.max(15000, Number(values['repo-timeout-ms']) || 95000);

  const errorLogFn = entry => {
    try {
      appendFileSync(errorsPath, JSON.stringify({ts: new Date().toISOString(), ...entry}) + '\n');
    } catch {}
  };

  const {forbidden, stage10} = loadWave3AuditReferenceSets({
    realExecBmPath: values['realexec-bm'],
    realExecManPath: values['realexec-man'],
    stage10Path: values['stage10-jsonl'],
  });

  console.error(`[init] RealExecBench forbidden: ${forbidden.ids.size} ids, ${forbidden.families.size} families, ${forbidden.sourceHashes.size} hashes, ${forbidden.repos.size} repos`);
  console.error(`[init] Stage10 zero-dupe: ${stage10.ids.size} ids, ${stage10.sourceHashes.size} hashes, ${stage10.repos.size} repos`);

  const allRows = [];
  const usedIds = new Set();
  const usedHashes = new Set();
  const completedRepos = new Set();
  let statefulDone = false;

  if (resume && existsSync(tasksPath)) {
    for (const line of readFileSync(tasksPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        allRows.push(r);
        if (r.id) usedIds.add(r.id);
        if (r.sourceHash) usedHashes.add(r.sourceHash);
      } catch {}
    }
    if (existsSync(progressPath)) {
      try {
        const p = JSON.parse(readFileSync(progressPath, 'utf8'));
        for (const s of p.completedRepos ?? []) completedRepos.add(s);
        statefulDone = Boolean(p.statefulDone);
      } catch {}
    }
    console.error(`[resume] Loaded ${allRows.length} existing tasks (statefulDone=${statefulDone}, completedPureRepos=${completedRepos.size})`);
  } else {
    writeFileSync(tasksPath, '');
    writeFileSync(errorsPath, '');
    writeFileSync(progressPath, JSON.stringify({statefulDone: false, completedRepos: []}, null, 2) + '\n');
  }

  const persistProgress = () => {
    writeFileSync(progressPath, JSON.stringify({
      statefulDone,
      completedRepos: [...completedRepos].sort(),
    }, null, 2) + '\n');
  };

  const admitRows = rows => {
    if (!rows.length) return;
    appendFileSync(tasksPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    allRows.push(...rows);
  };

  // Phase 1: Stateful-I/O & Browser-DOM Real OSS Engine
  if (!onlyPure && !statefulDone) {
    await runStatefulAndBrowserEngine({
      cacheDir,
      forbidden,
      stage10,
      usedIds,
      usedHashes,
      onAdmitRows: admitRows,
      errorLogFn,
    });
    statefulDone = true;
    persistProgress();
  }

  // Phase 2: Pure Multi-File Real OSS Engine (Modes A, B, C1)
  const cleanPureCatalog = WAVE3_PURE_CATALOG.filter(entry =>
    !isRepoBlocked(entry.slug, entry.github, forbidden) &&
    !isRepoBlocked(entry.slug, entry.github, stage10),
  ).slice(0, maxRepos);

  if (!onlyStateful) {
    const remainingCatalog = cleanPureCatalog.filter(e => !completedRepos.has(e.slug));
    console.error(`[pure] Preparing ${remainingCatalog.length}/${cleanPureCatalog.length} brand-new OSS repos (concurrency=${cloneConcurrency})...`);
    const cloneResults = await cloneBatchWithConcurrency(remainingCatalog, cacheDir, cloneConcurrency, errorLogFn);
    const clonedOk = [...cloneResults.values()].filter(r => r.ok).length;
    console.error(`[pure] Ready: ${clonedOk}/${remainingCatalog.length} repos cloned/cached`);

    let cursor = 0;
    const harvestWorker = async () => {
      while (cursor < remainingCatalog.length) {
        if (allRows.length >= maxTasks) break;
        const idx = cursor++;
        const repoEntry = remainingCatalog[idx];
        const cRes = cloneResults.get(repoEntry.slug);
        if (!cRes?.ok) {
          completedRepos.add(repoEntry.slug);
          persistProgress();
          continue;
        }
        try {
          const repoRows = await harvestSinglePureRepo({
            repoEntry,
            repoDir: cRes.dir,
            forbidden,
            stage10,
            usedIds,
            usedHashes,
            maxPerRepo,
            maxPerFn,
            minFiles,
            maxFiles,
            maxPairsPerRepo,
            enableMutations,
            repoTimeoutMs,
            errorLogFn,
          });
          if (repoRows.length) {
            admitRows(repoRows);
            const pairCount = repoRows.filter(r => r.pair_id).length / 2;
            console.error(`[pure] OK ${repoEntry.slug} (${repoEntry.lang}): +${repoRows.length} tasks (${pairCount} mut pairs) | total=${allRows.length}`);
          }
        } catch (err) {
          errorLogFn({stage: 'harvest-repo', repo: repoEntry.slug, error: String(err?.message ?? err).slice(0, 260)});
        }
        completedRepos.add(repoEntry.slug);
        persistProgress();
      }
    };

    await Promise.all(Array.from({length: repoConcurrency}, () => harvestWorker()));
  }

  // Final Audit
  const totalCatalogRepos = new Set([
    ...WAVE3_PURE_CATALOG.map(e => e.slug),
    ...Object.keys(WAVE3_STATEFUL_EXTRA_REPOS),
  ]).size;
  const catalogTsCount = WAVE3_PURE_CATALOG.filter(e => e.lang === 'ts').length;
  const audit = auditWave3Dataset(allRows, {
    forbidden,
    stage10,
    catalogStats: {
      total_curated_repos: totalCatalogRepos,
      pure_catalog_repos: WAVE3_PURE_CATALOG.length,
      pure_catalog_ts_repos: catalogTsCount,
      pure_catalog_ts_ratio: Math.round((catalogTsCount / WAVE3_PURE_CATALOG.length) * 1000) / 1000,
      clean_pure_catalog_after_filter: cleanPureCatalog.length,
    },
  });

  writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
  console.log(JSON.stringify({
    tasksPath,
    auditPath,
    totals: audit.totals,
    distributions: audit.distributions,
    checks: Object.fromEntries(Object.entries(audit.checks).map(([k, v]) => [k, {passed: v.passed, ...(v.overlap_counts ? {overlap_counts: v.overlap_counts} : {})}])),
  }, null, 2));

  if (!audit.checks.zero_leakage_realexecbench.passed ||
      !audit.checks.stage10_zero_dupe.passed ||
      !audit.checks.preexported_schema.passed ||
      !audit.checks.determinism_2x_and_live_replay.passed ||
      !audit.checks.token_bounds.passed) {
    console.error('[AUDIT FAILED] One or more strict audit checks failed!');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
