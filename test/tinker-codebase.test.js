import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  ADAPTIVE_MANIFEST_FILE_THRESHOLD,
  CODE_LIST_TOOL_SPEC,
  CODE_SEARCH_TOOL_SPEC,
  MAX_CODEBASE_FILES,
  MAX_CODEBASE_FILE_BYTES,
  MAX_CODEBASE_TOTAL_BYTES,
  MAX_CODE_LIST_RESPONSE_BYTES,
  MAX_CODE_LOAD_BATCH,
  MAX_CODE_LOAD_RESPONSE_BYTES,
  MAX_CODE_SEARCH_RESPONSE_BYTES,
  WHOLE_FILE_LOAD_MAX_BYTES,
  normalizeCodebaseSpec,
  renderRepoManifest,
  serveCodeList,
  serveCodeLoad,
  serveCodeSearch,
} from '../src/training/tinker-codebase.js';
import {
  assistantThinkingText,
  createTinkerSession,
  encodeReadable,
  exportTinkerExample,
  prepareTinkerTask,
} from '../src/training/tinker-execution.js';
import {harvestMultiFileRepos} from '../tools/tinker-harvest-multifile-js.mjs';
import {createNativeTraceCollector} from '../src/training/native-trace.js';

const complete = (value, args = [], kind = 'return') => {
  const encoded = encodeReadable({arguments: args, value});
  return JSON.stringify({type: 'complete', kind, arguments: encoded.arguments, value: encoded.value});
};

const toolCallMsg = (name, args, id = 'tc_1') => ({
  role: 'assistant',
  content: '',
  tool_calls: [{type: 'function', id, function: {name, arguments: JSON.stringify({arguments: args})}}],
});

function makeBigModule() {
  const padding = Array.from({length: 45}, (_, i) =>
    `export function distractor_${i}(v) { const k = v + ${i}; return k * 2 - ${i}; }`).join('\n');
  return [
    "import { scale } from './small.js';",
    'const OFFSET = 7;',
    'const FACTOR = 3;',
    padding,
    'function internalAdjust(n) {',
    '  const adjusted = n + OFFSET;',
    '  return adjusted;',
    '}',
    'export function computeBig(x) {',
    '  const base = scale(x) * FACTOR;',
    '  return internalAdjust(base);',
    '}',
  ].join('\n');
}

test('renderRepoManifest outputs deterministic sorted index with sizes, symbols, and [loaded] tag', () => {
  const files = {
    'src/z_unused.js': 'export function neverCalled(x) { return x; }\nfunction localHelper() { return 1; }\n',
    'src/index.js': "import { add } from './math.ts';\nexport function run(a, b) { return add(a, b); }\n",
    'src/math.ts': 'export interface Pair { a: number; b: number; }\nexport function add(a: number, b: number): number { return a + b; }\nexport class Calc { mul(x: number) { return x * 2; } }\n',
  };
  const manifest = renderRepoManifest(files, 'src/index.js');
  const lines = manifest.split('\n');
  assert.match(lines[0], /Repository manifest \(3 files\):/);
  assert.match(lines[1], /^- src\/index\.js \[loaded\] \(\d+ lines, \d+ bytes\) — exports: run$/);
  assert.match(lines[2], /^- src\/math\.ts \(\d+ lines, \d+ bytes\) — exports: Pair, add, Calc$/);
  assert.match(lines[3], /^- src\/z_unused\.js \(\d+ lines, \d+ bytes\) — exports: neverCalled; defs: localHelper$/);
  // Deterministic across key insertion orders
  const reversed = Object.fromEntries(Object.entries(files).reverse());
  assert.equal(renderRepoManifest(reversed, 'src/index.js'), manifest);
});

test('serveCodeLoad handles whole file, symbol snippets with imports/consts, line ranges, batching, and structured errors', () => {
  const big = makeBigModule();
  assert(Buffer.byteLength(big, 'utf8') > WHOLE_FILE_LOAD_MAX_BYTES, 'fixture big module should exceed 3072 bytes');
  const files = {
    'src/small.js': 'export function scale(n) { return n * 2; }\nexport function negate(n) { return -n; }\n',
    'src/big.js': big,
    'src/typed.ts': [
      "import { scale } from './small.js';",
      'const STEP: number = 5;',
      'export interface Result { total: number; }',
      'export function unusedTs(x: number): number { return x - 1; }',
      'export function runTs(x: number): Result {',
      '  return { total: scale(x) + STEP };',
      '}',
    ].join('\n'),
  };

  // Single object normalized to array + whole file mode
  const whole = serveCodeLoad(files, {path: 'src/small.js'});
  assert.equal(whole.length, 1);
  assert.equal(whole[0].mode, 'file');
  assert.equal(whole[0].path, 'src/small.js');
  assert.equal(whole[0].content, files['src/small.js']);
  assert.equal(whole[0].bytes, Buffer.byteLength(files['src/small.js'], 'utf8'));

  // Batched symbol + line range (snake_case & camelCase) + TS symbol + missing symbol + missing file
  const batch = serveCodeLoad(files, [
    {path: 'src/big.js', symbol: 'computeBig'},
    {path: 'src/small.js', startLine: 1, endLine: 1},
    {path: 'src/small.js', start_line: 2, end_line: 2},
    {path: 'src/typed.ts', symbol: 'runTs'},
    {path: 'src/big.js', symbol: 'doesNotExist'},
    {path: 'src/missing.js'},
  ]);
  assert.equal(batch.length, 6);

  // Symbol snippet contains imports, simple consts, and exact target, NOT distractor_0
  assert.equal(batch[0].mode, 'symbol');
  assert.equal(batch[0].symbol, 'computeBig');
  assert.match(batch[0].content, /import \{ scale \} from '\.\/small\.js'/);
  assert.match(batch[0].content, /const OFFSET = 7/);
  assert.match(batch[0].content, /export function computeBig/);
  assert.doesNotMatch(batch[0].content, /distractor_0/);
  assert(batch[0].startLine >= 40 && batch[0].endLine >= batch[0].startLine);

  // Line ranges
  assert.equal(batch[1].mode, 'range');
  assert.equal(batch[1].content, 'export function scale(n) { return n * 2; }');
  assert.equal(batch[2].mode, 'range');
  assert.equal(batch[2].content, 'export function negate(n) { return -n; }');

  // TypeScript symbol preserves original lines & consts
  assert.equal(batch[3].mode, 'symbol');
  assert.equal(batch[3].startLine, 5);
  assert.equal(batch[3].endLine, 7);
  assert.match(batch[3].content, /const STEP: number = 5/);
  assert.match(batch[3].content, /export function runTs/);
  assert.doesNotMatch(batch[3].content, /unusedTs/);

  // Structured errors without throwing
  assert.match(batch[4].error, /not found/i);
  assert(batch[4].availableSymbols.includes('computeBig'));
  assert.match(batch[5].error, /not found/i);
  assert.deepEqual(batch[5].availableSymbols, []);
});

test('multi-file teacher emits whole-file for small files, symbol snippets for large files, skips dead branches, and preserves causal traces', async () => {
  const big = makeBigModule();
  const files = {
    'src/index.js': [
      "import { computeBig } from './big.js';",
      "import { deadHelper } from './dead.js';",
      "import { extraSmall } from './small.js';",
      'export function run(x) {',
      '  if (x > 0) {',
      '    const first = computeBig(x);',
      '    const second = extraSmall(first);',
      '    return second;',
      '  }',
      '  return deadHelper(x);',
      '}',
    ].join('\n'),
    'src/small.js': [
      'export function scale(n) { const s = n * 2; return s; }',
      'export function extraSmall(n) { const e = n + 1; return e; }',
    ].join('\n'),
    'src/big.js': big,
    'src/dead.js': 'export function deadHelper(x) { return x * 999; }\n',
  };

  const exported = await exportTinkerExample({
    id: 'mf-policy',
    family: 'mf-policy',
    executionMode: 'native',
    files,
    entryFile: 'src/index.js',
    entry: 'run',
    args: [4],
  }, {traceFormat: 'compact', reasoningChannel: 'thinking'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  assert.equal(exported.metadata.traceAudit.canonicalCausalNarration, true);
  assert.equal(exported.metadata.traceAudit.observationsMatched, true);

  // Verify tool_declare contains code.load with required: ["arguments"]
  const toolDeclMsg = exported.messages.find(m => m.role === 'tool_declare');
  assert(toolDeclMsg);
  const declaredTools = JSON.parse(toolDeclMsg.content);
  const codeLoadDecl = declaredTools.find(t => t.function.name === 'code.load');
  assert(codeLoadDecl);
  assert.deepEqual(codeLoadDecl.function.parameters.required, ['arguments']);

  // Extract all code.load tool calls made by teacher
  const assistantMsgs = exported.messages.filter(m => m.role === 'assistant');
  const codeLoadCalls = assistantMsgs
    .filter(m => m.tool_calls?.[0]?.function?.name === 'code.load')
    .map(m => JSON.parse(m.tool_calls[0].function.arguments).arguments);

  // Expected causal sequence:
  // 1. computeBig in src/big.js (>3072B) -> symbol mode
  // 2. scale in src/small.js (<=3072B) -> whole-file mode
  // 3. internalAdjust in src/big.js (>3072B) -> symbol mode
  // 4. extraSmall in src/small.js -> ALREADY loaded via whole-file, so NO 4th code.load!
  // 5. dead.js -> NEVER loaded!
  assert.deepEqual(codeLoadCalls, [
    [{path: 'src/big.js', symbol: 'computeBig'}],
    [{path: 'src/small.js'}],
    [{path: 'src/big.js', symbol: 'internalAdjust'}],
  ]);
  assert.equal(exported.metadata.codeLoadCalls, 3);
  assert.doesNotMatch(JSON.stringify(codeLoadCalls), /dead\.js/);

  // Causal trace audit: Turn 0 (before loading computeBig) must have `branch x > 0 => true (then)`
  // and must NOT contain any trace lines from big.js or small.js!
  const turn0Thinking = assistantThinkingText(assistantMsgs[0]);
  assert.match(turn0Thinking, /branch x > 0 => true \(then\)/);
  assert.doesNotMatch(turn0Thinking, /\bs = |\bbase = |\badjusted = /);

  // Final result: scale(4)=8 -> 8*3=24 -> internalAdjust(24)=31 -> extraSmall(31)=32
  const finalMsg = assistantMsgs.at(-1);
  const finalJson = JSON.parse(finalMsg.content.find(p => p.type === 'text').text.match(/```json\n([\s\S]+?)\n```/)[1]);
  assert.equal(finalJson.value, 32);
});

test('flexible live student grading allows different code.load granularity, batching, and recovery while enforcing exact external effects', async () => {
  const big = makeBigModule();
  const files = {
    'src/index.js': [
      "import { computeBig } from './big.js';",
      'export function run(state) {',
      '  const ts = Date.now();',
      '  const val = computeBig(state.x) + ts;',
      '  state.done = true;',
      '  return val;',
      '}',
    ].join('\n'),
    'src/small.js': 'export function scale(n) { return n * 2; }\n',
    'src/big.js': big,
  };

  const makeTask = nowVal => ({
    id: 'mf-flex',
    family: 'mf-flex',
    executionMode: 'native',
    files,
    entryFile: 'src/index.js',
    entry: 'run',
    args: [{x: 2}],
    fixture: {calls: [{operation: 'platform.dateNow', arguments: [], result: nowVal}]},
  });

  // Counterfactual zero-future-leakage check on external Date.now()
  const left = await exportTinkerExample(makeTask(1000), {traceFormat: 'compact'});
  const right = await exportTinkerExample(makeTask(9999), {traceFormat: 'compact'});
  const dateNowIdx = left.messages.findIndex(m => m.role === 'tool' && m.name === 'platform.dateNow');
  assert(dateNowIdx > 0);
  assert.deepEqual(left.messages.slice(0, dateNowIdx), right.messages.slice(0, dateNowIdx));
  assert.doesNotMatch(JSON.stringify(left.messages.slice(0, dateNowIdx)), /1000|9999/);
  assert.notDeepEqual(left.messages[dateNowIdx], right.messages[dateNowIdx]);

  const prepared = await prepareTinkerTask(makeTask(1000), {traceFormat: 'compact'});

  // Student A: batches whole-file loads of BOTH src/big.js and src/small.js in ONE code.load call,
  // even though teacher emitted separate symbol/file loads!
  const sessionA = createTinkerSession(prepared);
  const step1 = await sessionA.step(toolCallMsg('code.load', [{path: 'src/big.js'}, {path: 'src/small.js'}], 'b1'), 40);
  assert.equal(step1.done, false);
  assert.equal(step1.messages.length, 1);
  assert.equal(step1.messages[0].name, 'code.load');
  const obs1 = JSON.parse(step1.messages[0].content);
  assert.equal(obs1.status, 'fulfilled');
  assert.equal(obs1.value.length, 2);
  assert.equal(obs1.value[0].mode, 'file');
  assert.equal(obs1.value[1].mode, 'file');

  // Also test a bad code.load request (missing symbol) -> structured error, session stays alive!
  const stepErr = await sessionA.step(toolCallMsg('code.load', [{path: 'src/big.js', symbol: 'nope'}], 'b2'), 60);
  assert.equal(stepErr.done, false);
  const obsErr = JSON.parse(stepErr.messages[0].content);
  assert.match(obsErr.value[0].error, /not found/i);

  // Now invoke Date.now() (exact external effect) and complete!
  const stepDate = await sessionA.step(toolCallMsg('platform.dateNow', [], 'd1'), 80);
  assert.equal(stepDate.done, false);
  assert.equal(JSON.parse(stepDate.messages[0].content).value, 1000);

  // computeBig(2): scale(2)=4, 4*3=12, 12+7=19; 19 + 1000 = 1019
  const doneA = await sessionA.step(complete(1019, [{x: 2, done: true}]), 110);
  assert.equal(doneA.done, true);
  assert.equal(doneA.grade.success, true);
  assert.equal(doneA.grade.codeLoadCalls, 2);
  assert.equal(doneA.grade.externalCalls, 1);
  assert(doneA.grade.codeLoadBytes > WHOLE_FILE_LOAD_MAX_BYTES);
  sessionA.close();

  // Student B: skips required external Date.now() call -> MUST FAIL even if code.load succeeded!
  const sessionB = createTinkerSession(prepared);
  await sessionB.step(toolCallMsg('code.load', [{path: 'src/big.js', symbol: 'computeBig'}], 's1'), 30);
  const badB = await sessionB.step(complete(1019, [{x: 2, done: true}]), 60);
  assert.equal(badB.done, true);
  assert.equal(badB.grade.success, false);
  assert.equal(badB.grade.failureCategory, 'missing-external-effects');
  sessionB.close();
});

test('multi-file TypeScript codebase executes and exports with replay verification', async () => {
  const files = {
    'src/index.ts': [
      "import { formatScore } from './format.ts';",
      'export function summarize(scores: number[]): string {',
      '  const sum: number = scores.reduce((a: number, b: number) => a + b, 0);',
      '  return formatScore(sum, scores.length);',
      '}',
    ].join('\n'),
    'src/format.ts': [
      'export function formatScore(total: number, count: number): string {',
      '  const avg: number = count > 0 ? total / count : 0;',
      '  return `${total}/${count}=${avg}`;',
      '}',
    ].join('\n'),
    'src/unused.ts': 'export const VERSION: string = "1.0.0";\n',
  };
  const exported = await exportTinkerExample({
    id: 'mf-ts',
    family: 'mf-ts',
    files,
    entryFile: 'src/index.ts',
    entry: 'summarize',
    args: [[10, 20, 30]],
  }, {traceFormat: 'compact', reasoningChannel: 'thinking'});

  assert.equal(exported.task.language, 'ts');
  assert.equal(exported.metadata.codeLoadCalls, 1);
  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const lastAssistant = exported.messages.filter(m => m.role === 'assistant').at(-1);
  assert.match(JSON.stringify(lastAssistant), /60\/3=20/);
});

test('harvestMultiFileRepos harvests verified multi-file tasks with real distractor files', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mf-harvest-test-'));
  try {
    mkdirSync(join(tmp, 'src'), {recursive: true});
    writeFileSync(join(tmp, 'src/index.js'), [
      "import { normalizeWords } from './normalize.js';",
      "import { countChars } from './stats.js';",
      'export function analyzeText(input) {',
      '  const words = normalizeWords(String(input));',
      '  return { count: words.length, chars: countChars(words), words };',
      '}',
    ].join('\n'));
    writeFileSync(join(tmp, 'src/normalize.js'), [
      'export function normalizeWords(text) {',
      '  return text.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);',
      '}',
    ].join('\n'));
    writeFileSync(join(tmp, 'src/stats.js'), [
      'export function countChars(words) {',
      '  let total = 0;',
      '  for (const w of words) total += w.length;',
      '  return total;',
      '}',
    ].join('\n'));
    writeFileSync(join(tmp, 'src/distractor.js'), [
      'export function renderHtml(title) {',
      '  return `<h1>${title}</h1>`;',
      '}',
    ].join('\n'));

    const {examples, stats} = await harvestMultiFileRepos([tmp], {
      singleRepoMode: true,
      maxPerRepo: 3,
      maxPerFn: 2,
      minFiles: 3,
      maxFiles: 10,
      traceFormat: 'compact',
    });

    assert(examples.length >= 1, 'Expected at least 1 harvested multi-file task');
    assert.equal(stats.verifiedTasks, examples.length);
    for (const ex of examples) {
      assert(ex.metadata.codeLoadCalls >= 1);
      assert.equal(ex.metadata.traceAudit.replayVerified, true);
      assert(Object.keys(ex.task.files).includes('src/distractor.js'));
      assert(ex.metadata.features.includes('multi-file'));
      assert(ex.metadata.features.includes('code-load'));
    }
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('raised codebase caps accept up to 2048 files, 32MB total, 512KB per file, 64-item code.load batches, and preserve flat manifest <= 120 files', () => {
  assert.equal(MAX_CODEBASE_FILES, 2048);
  assert.equal(MAX_CODEBASE_TOTAL_BYTES, 32 * 1024 * 1024);
  assert.equal(MAX_CODEBASE_FILE_BYTES, 524288);
  assert.equal(MAX_CODE_LOAD_BATCH, 64);
  assert.equal(MAX_CODE_LOAD_RESPONSE_BYTES, 64_000);
  assert.equal(MAX_CODE_SEARCH_RESPONSE_BYTES, 32_000);
  assert.equal(MAX_CODE_LIST_RESPONSE_BYTES, 32_000);
  assert.equal(ADAPTIVE_MANIFEST_FILE_THRESHOLD, 120);

  // Tool specs follow OpenAI-style function schema with required: ['arguments']
  assert.equal(CODE_SEARCH_TOOL_SPEC.type, 'function');
  assert.equal(CODE_SEARCH_TOOL_SPEC.function.name, 'code.search');
  assert.deepEqual(CODE_SEARCH_TOOL_SPEC.function.parameters.required, ['arguments']);
  assert.equal(CODE_LIST_TOOL_SPEC.type, 'function');
  assert.equal(CODE_LIST_TOOL_SPEC.function.name, 'code.list');
  assert.deepEqual(CODE_LIST_TOOL_SPEC.function.parameters.required, ['arguments']);

  // <= 120 files preserves exact flat manifest listing every file + symbols
  const files = {'src/index.js': 'export function run() { return 1; }\n'};
  for (let i = 1; i < 120; i++) {
    const padExports = Array.from({length: 14}, (_, j) =>
      `export function helper_${i}_${j}(v) { return v + ${j}; }`).join('\n');
    const padDefs = Array.from({length: 6}, (_, j) =>
      `function internal_${i}_${j}(v) { return v - ${j}; }`).join('\n');
    files[`src/modules/mod_${String(i).padStart(3, '0')}.js`] = padExports + '\n' + padDefs + '\n';
  }
  const spec = normalizeCodebaseSpec({files, entryFile: 'src/index.js'});
  assert.equal(Object.keys(spec.files).length, 120);

  const manifest = renderRepoManifest(spec.files, 'src/index.js');
  const lines = manifest.split('\n');
  assert.equal(lines.length, 121);
  assert.match(lines[0], /Repository manifest \(120 files\):/);
  assert(manifest.length < 30000, `Expected compact 120-file manifest (<30000 chars), got ${manifest.length}`);
  assert.match(lines[2], /\(\+\d+ more\)/);

  // Batch of 64 code.load requests succeeds without truncation
  const reqs = Array.from({length: 64}, (_, i) => ({
    path: `src/modules/mod_${String(i + 1).padStart(3, '0')}.js`,
    symbol: `helper_${i + 1}_0`,
  }));
  const batchRes = serveCodeLoad(spec.files, reqs);
  assert.equal(batchRes.length, 64);
  assert.equal(batchRes[0].mode, 'symbol');
  assert.equal(batchRes[63].mode, 'symbol');

  // Single file > 512KB is rejected cleanly
  assert.throws(
    () => normalizeCodebaseSpec({files: {'src/huge.js': 'a'.repeat(MAX_CODEBASE_FILE_BYTES + 1)}, entryFile: 'src/huge.js'}),
    /size limit/i,
  );
  // > 2048 files is rejected cleanly
  const tooMany = {};
  for (let i = 0; i < MAX_CODEBASE_FILES + 1; i++) tooMany[`f_${i}.js`] = 'export const x = 1;\n';
  assert.throws(
    () => normalizeCodebaseSpec({files: tooMany, entryFile: 'f_0.js'}),
    /2048/,
  );
});

test('1000-file (>4MB) codebase: validation, adaptive directory-summary manifest, code.list, code.search, and code.load', () => {
  const files = {
    'src/index.ts': 'export function mainEntry(x: number): number { return x + 1; }\n',
    'src/neighbor.ts': 'export function nearEntry(y: number): number { return y * 2; }\n',
    'src/extra_loaded.ts': 'export const INITIAL_TAG = "loaded";\n',
  };
  const padLine = '// ' + 'x'.repeat(110);
  const padBlock = Array.from({length: 38}, () => padLine).join('\n'); // ~4.3 KB per file => >4.3 MB across 1000 files
  for (let i = 0; i < 997; i++) {
    const pkgIdx = String(i % 20).padStart(2, '0');
    const ext = i % 3 === 0 ? 'ts' : 'js';
    const relPath = `src/pkg_${pkgIdx}/mod_${String(i).padStart(4, '0')}.${ext}`;
    const needleLine = i === 420
      ? 'export function verifyAuthToken(secret: string): string { return "TOKEN_NEEDLE_" + secret; }'
      : (i === 777
        ? 'export function refreshSessionToken(id: string): string { return "TOKEN_NEEDLE_ALT_" + id; }'
        : `export function handler_${i}(v) { return v + ${i}; }`);
    files[relPath] = [
      `// Module ${i} in pkg_${pkgIdx}`,
      `const MOD_ID = ${i};`,
      needleLine,
      padBlock,
    ].join('\n');
  }

  const totalBytes = Object.values(files).reduce((sum, s) => sum + Buffer.byteLength(s, 'utf8'), 0);
  assert.equal(Object.keys(files).length, 1000);
  assert(totalBytes > 4 * 1024 * 1024, `Expected >4MB repo, got ${totalBytes} bytes`);

  // 1. Validation passes cleanly
  const spec = normalizeCodebaseSpec({
    files,
    entryFile: 'src/index.ts',
    initialLoadedFiles: ['src/index.ts', 'src/extra_loaded.ts'],
  });
  assert.equal(Object.keys(spec.files).length, 1000);

  // 2. Adaptive directory-summary manifest stays compact (< 12 KB) and deterministic
  const manifest = renderRepoManifest(spec.files, spec.entryFile, spec.initialLoadedFiles);
  assert(Buffer.byteLength(manifest, 'utf8') < 12_000, `Expected <12KB adaptive manifest, got ${manifest.length} chars`);
  assert.match(manifest, /1000 files/);
  assert.match(manifest, /code\.list/);
  assert.match(manifest, /code\.search/);
  assert.match(manifest, /code\.load/);
  assert.match(manifest, /src\/index\.ts \[loaded\]/);
  assert.match(manifest, /src\/extra_loaded\.ts \[loaded\]/);
  assert.match(manifest, /src\/neighbor\.ts/);
  assert.match(manifest, /src\/pkg_00\/ \(\d+ files, [\d.]+ KB, sample: /);
  const reversed = Object.fromEntries(Object.entries(spec.files).reverse());
  assert.equal(renderRepoManifest(reversed, spec.entryFile, spec.initialLoadedFiles), manifest);

  // 2b. Even a 2,000-file repo with 200 deep directories stays < 12 KB via hierarchical rollup
  const hugeFiles = {'app/entry.js': 'export function start() { return 1; }\n'};
  for (let i = 0; i < 1999; i++) {
    hugeFiles[`services/domain_${i % 40}/sub_${i % 5}/deep_${i % 3}/file_${String(i).padStart(4, '0')}.ts`] =
      `export const V_${i} = ${i};\n`;
  }
  const hugeManifest = renderRepoManifest(hugeFiles, 'app/entry.js');
  assert(Buffer.byteLength(hugeManifest, 'utf8') < 12_000, `Expected <12KB 2000-file manifest, got ${hugeManifest.length}`);
  assert.match(hugeManifest, /2000 files/);

  // 3. code.list: default empty args, pagination, prefix, glob, includeSymbols, byte cap
  const listDefault = serveCodeList(spec.files, []);
  assert.equal(listDefault.totalFiles, 1000);
  assert.equal(listDefault.returned, 100);
  assert.equal(listDefault.truncated, true);
  assert(listDefault.directories.length >= 20);
  assert.equal(listDefault.files[0].symbols, undefined);
  assert(Buffer.byteLength(JSON.stringify(listDefault), 'utf8') <= MAX_CODE_LIST_RESPONSE_BYTES);

  const listPage2 = serveCodeList(spec.files, [{offset: 100, maxEntries: 50}]);
  assert.equal(listPage2.totalFiles, 1000);
  assert.equal(listPage2.returned, 50);
  assert.equal(listPage2.truncated, true);
  assert.notEqual(listPage2.files[0].path, listDefault.files[0].path);

  // Prefix + glob + includeSymbols
  const listFiltered = serveCodeList(spec.files, [{prefix: 'src/pkg_00/', glob: '*.ts', includeSymbols: true}]);
  assert(listFiltered.totalFiles > 0 && listFiltered.totalFiles < 50);
  assert.equal(listFiltered.returned, listFiltered.totalFiles);
  assert.equal(listFiltered.truncated, false);
  assert(listFiltered.files.every(f => f.path.startsWith('src/pkg_00/') && f.path.endsWith('.ts')));
  assert(Array.isArray(listFiltered.files[0].symbols) && listFiltered.files[0].symbols.length >= 1);

  // Nested path glob (**/*.ts)
  const listDeepGlob = serveCodeList(spec.files, {glob: 'src/pkg_00/**/*.ts'});
  assert.equal(listDeepGlob.totalFiles, listFiltered.totalFiles);

  // 4. code.search: literal (object & 1-element array), case sensitivity, regex with context, invalid regex
  const litSearch = serveCodeSearch(spec.files, [{query: 'token_needle_'}]);
  assert.equal(litSearch.error, undefined);
  assert.equal(litSearch.totalMatches, 2);
  assert.equal(litSearch.truncated, false);
  assert.equal(litSearch.matches.length, 2);
  assert.equal(litSearch.matches[0].path, 'src/pkg_00/mod_0420.ts');
  assert.equal(litSearch.matches[0].line, 3);
  assert.equal(litSearch.matches[0].contextBefore, undefined);
  assert.equal(litSearch.matches[1].path, 'src/pkg_17/mod_0777.ts');

  const caseSensMiss = serveCodeSearch(spec.files, {query: 'token_needle_', caseSensitive: true});
  assert.equal(caseSensMiss.totalMatches, 0);
  const caseSensHit = serveCodeSearch(spec.files, {query: 'TOKEN_NEEDLE_', caseSensitive: true});
  assert.equal(caseSensHit.totalMatches, 2);

  // Regex + pathPrefix + glob + contextLines
  const regexSearch = serveCodeSearch(spec.files, [{
    query: 'function\\s+(verify|refresh)\\w+Token',
    isRegex: true,
    pathPrefix: 'src/pkg_00/',
    glob: '*.ts',
    contextLines: 2,
  }]);
  assert.equal(regexSearch.error, undefined);
  assert.equal(regexSearch.totalMatches, 1);
  assert.equal(regexSearch.matches[0].path, 'src/pkg_00/mod_0420.ts');
  assert.equal(regexSearch.matches[0].line, 3);
  assert.deepEqual(regexSearch.matches[0].contextBefore, ['// Module 420 in pkg_00', 'const MOD_ID = 420;']);
  assert.equal(regexSearch.matches[0].contextAfter.length, 2);

  // Invalid regex returns structured error without throwing
  const badRegex = serveCodeSearch(spec.files, [{query: '([unclosed', isRegex: true}]);
  assert.equal(badRegex.totalMatches, 0);
  assert.deepEqual(badRegex.matches, []);
  assert.match(badRegex.error, /Invalid regex/i);

  // Truncation & 32KB cap on broad search
  const broadSearch = serveCodeSearch(spec.files, {query: 'MOD_ID', maxResults: 500});
  assert.equal(broadSearch.totalMatches, 997);
  assert.equal(broadSearch.truncated, true);
  assert(broadSearch.matches.length <= 100);
  assert(Buffer.byteLength(JSON.stringify(broadSearch), 'utf8') <= MAX_CODE_SEARCH_RESPONSE_BYTES);

  // 5. code.load loads the file/symbol discovered via code.search cleanly
  const foundPath = regexSearch.matches[0].path;
  const loaded = serveCodeLoad(spec.files, [{path: foundPath, symbol: 'verifyAuthToken'}]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].mode, 'symbol');
  assert.equal(loaded[0].path, foundPath);
  assert.match(loaded[0].content, /TOKEN_NEEDLE_/);
});

test('createNativeTraceCollector total-line compaction is strictly causal (future turns never alter earlier turns)', () => {
  const shortRun = createNativeTraceCollector({maxLinesPerTurn: 20, maxTotalLines: 30});
  const longRun = createNativeTraceCollector({maxLinesPerTurn: 20, maxTotalLines: 30});

  for (const collector of [shortRun, longRun]) {
    for (let i = 0; i < 15; i++) collector.hooks.__traceWrite('a', i, 'i');
    collector.nextTurn();
    for (let i = 0; i < 10; i++) collector.hooks.__traceWrite('b', i, 'i');
    collector.nextTurn();
  }
  // Short run ends with 2 lines; long run emits many future turns exceeding maxTotalLines
  shortRun.hooks.__traceWrite('c', 1, '1');
  for (let t = 0; t < 5; t++) {
    for (let i = 0; i < 15; i++) longRun.hooks.__traceWrite('d_' + t, i, 'i');
    longRun.nextTurn();
  }

  const shortTurns = shortRun.finalize();
  const longTurns = longRun.finalize();
  assert.deepEqual(shortTurns.slice(0, 2), longTurns.slice(0, 2));
  assert(longTurns.reduce((s, t) => s + t.length, 0) <= 30);
});
