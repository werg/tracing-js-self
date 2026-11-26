import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  TYPED_INPUT_BANK,
  collectLocalRepoCandidates,
  evalStaticAst,
  extractTestCallsFromFiles,
  parseHarvesterArgs,
  qualify,
} from '../tools/tinker-harvest.mjs';
import {exportTinkerExample, prepareTinkerTask, createTinkerSession, parseStudentAction} from '../src/training/tinker-execution.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARVEST_ENV_DIR = '/tmp/tinker-harvest-env';

test('TYPED_INPUT_BANK includes gnarly nested, unicode, multiline, and mixed-number probes', () => {
  const flatJson = JSON.stringify(TYPED_INPUT_BANK);
  assert.match(flatJson, /\\n/);
  assert.match(flatJson, /Café|héllo|café/);
  assert.ok(TYPED_INPUT_BANK.some(args => Array.isArray(args[0]) && args[0].some(v => typeof v === 'number' && v < 0) && args[0].some(v => typeof v === 'number' && !Number.isInteger(v))));
  assert.ok(TYPED_INPUT_BANK.some(args => args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && Object.values(args[0]).includes(null) && Object.values(args[0]).includes('')));
});

test('extractTestCallsFromFiles handles test.each, for..of, forEach, JSON fixtures, spreads, templates, and assertions', () => {
  const root = mkdtempSync(join(tmpdir(), 'harvest-v3-extract-'));
  try {
    const repoDir = join(root, 'repo');
    mkdirSync(join(repoDir, 'test', 'fixtures'), {recursive: true});
    writeFileSync(join(root, 'secret.json'), JSON.stringify({bad: true}));
    writeFileSync(join(repoDir, 'test', 'fixtures', 'cases.json'), JSON.stringify({
      cases: [[10, 20], [30, 40]],
      base: {mode: 'strict', retries: 2},
    }));
    writeFileSync(join(repoDir, 'test', 'fixtures', 'rows.json'), JSON.stringify([
      {input: 'alpha', count: 2},
      {input: 'beta', count: 3},
    ]));

    const jsTest = join(repoDir, 'test', 'suite.test.js');
    writeFileSync(jsTest, `
      import assert from 'node:assert/strict';
      import esmFix from './fixtures/cases.json';
      const cjsRows = require('./fixtures/rows.json');
      const outside = require('../../secret.json');

      function checkUpper(src) {
        expect(upper(src)).toEqual(src.toUpperCase());
      }

      test.each([[1, 2, 3], [4, 5, 9]])('adds %i', (a, b, exp) => {
        assert.deepStrictEqual(add(a, b), exp);
      });

      it.each([
        {input: 'hi', expected: 'HI'},
        {input: 'yo', expected: 'YO'},
      ])('objects', ({input, expected}) => {
        expect(upper(input)).toEqual(expected);
      });

      describe.each([['dev', 1], ['prod', 2]])('mode %s', (mode, mult) => {
        it('scales', () => {
          t.deepEqual(scale(mode, mult), mode + ':' + mult);
        });
      });

      for (const [x, y] of [[7, 8], [9, 10]]) {
        should(pair(x, y)).eql([x, y]);
      }

      const items = [{k: 'a', v: 1}, {k: 'b', v: 2}];
      items.forEach(({k, v}) => {
        assert.equal(tag(k, v), \`\${k}:\${v}\`);
      });

      for (const [a, b] of esmFix.cases) {
        mergeCfg(a, {...esmFix.base, override: b});
      }

      cjsRows.forEach(row => {
        repeatTag(\`\${row.input}-\${row.count}\`, [...[1, 2], row.count]);
      });

      checkUpper('helper-call');
      // Must NOT match assert.equal or expect(...).toEqual as exported target equal()
      assert.equal(1, 1);
      expect(1).toEqual(1);
      // Must ignore traversal outside repoDir
      leak(outside);
    `);

    const tsTest = join(repoDir, 'test', 'typed.spec.ts');
    writeFileSync(tsTest, `
      const table: Array<[string, number]> = [['ts-one', 11], ['ts-two', 22]];
      it.each(table)('ts row', (label: string, n: number) => {
        expect(fromTs(label, n)).toBeTruthy();
      });
    `);

    const exports = ['add', 'upper', 'scale', 'pair', 'tag', 'mergeCfg', 'repeatTag', 'equal', 'leak', 'fromTs'];
    const extracted = extractTestCallsFromFiles(repoDir, [jsTest, tsTest], exports);

    assert.deepEqual(extracted.get('add')?.map(x => x.args), [[1, 2], [4, 5]]);
    assert.deepEqual(extracted.get('upper')?.map(x => x.args), [['hi'], ['yo'], ['helper-call']]);
    assert.deepEqual(extracted.get('scale')?.map(x => x.args), [['dev', 1], ['prod', 2]]);
    assert.deepEqual(extracted.get('pair')?.map(x => x.args), [[7, 8], [9, 10]]);
    assert.deepEqual(extracted.get('tag')?.map(x => x.args), [['a', 1], ['b', 2]]);
    assert.deepEqual(extracted.get('mergeCfg')?.map(x => x.args), [
      [10, {mode: 'strict', retries: 2, override: 20}],
      [30, {mode: 'strict', retries: 2, override: 40}],
    ]);
    assert.deepEqual(extracted.get('repeatTag')?.map(x => x.args), [
      ['alpha-2', [1, 2, 2]],
      ['beta-3', [1, 2, 3]],
    ]);
    assert.deepEqual(extracted.get('fromTs')?.map(x => x.args), [['ts-one', 11], ['ts-two', 22]]);
    assert.equal(extracted.get('equal'), undefined);
    assert.equal(extracted.get('leak'), undefined);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('qualify filters synthetic immediate-TypeError and short probes while keeping unit-test-input exceptions', async () => {
  const synthTypeError = {
    id: 'synth-typeerror',
    family: 'test:synth-typeerror',
    executionMode: 'native',
    source: '"use strict"; function run(x) { return x.trim(); }',
    entry: 'run',
    args: [42],
    fixture: {calls: []},
    metadata: {sourceOrigin: 'dgx-oss-repo', package: 'demo', features: ['real-oss', 'dgx-repo'], lineage: ['test:synth-typeerror']},
  };
  const r1 = await qualify(synthTypeError);
  assert.equal(r1.status, 'refused');
  assert.equal(r1.category, 'immediate-type-error');

  const synthShort = {
    id: 'synth-short',
    family: 'test:synth-short',
    executionMode: 'native',
    source: '"use strict"; function run(x) { const y = x + 1; return y; }',
    entry: 'run',
    args: [4],
    fixture: {calls: []},
    metadata: {sourceOrigin: 'dgx-oss-repo', package: 'demo', features: ['real-oss', 'dgx-repo'], lineage: ['test:synth-short']},
  };
  const r2 = await qualify(synthShort, {minTraceLines: 4});
  assert.equal(r2.status, 'refused');
  assert.equal(r2.category, 'trace-too-short');

  const unitException = {
    id: 'unit-exception',
    family: 'test:unit-exception',
    executionMode: 'native',
    source: '"use strict"; function run(x) { if (!x) throw new TypeError("empty"); return x.trim(); }',
    entry: 'run',
    args: [''],
    fixture: {calls: []},
    metadata: {
      sourceOrigin: 'dgx-oss-unit-test',
      package: 'demo',
      features: ['real-oss', 'dgx-repo', 'unit-test-input'],
      lineage: ['test:unit-exception'],
    },
  };
  const r3 = await qualify(unitException, {minTraceLines: 4});
  assert.equal(r3.status, 'admitted', JSON.stringify(r3));
  assert.equal(r3.completeKind, 'throw');
});

test('harvester prefers unit-test inputs, supports --unit-tests-only, and keeps unit-test exceptions end-to-end', () => {
  assert.equal(existsSync(join(HARVEST_ENV_DIR, 'package.json')), true, 'tinker-harvest-env esbuild required');
  assert.deepEqual(
    [parseHarvesterArgs(['--no-prefer-unit-tests']).preferUnitTests, parseHarvesterArgs(['--unit-tests-only=true']).unitTestsOnly],
    [false, true],
  );

  const root = mkdtempSync(join(tmpdir(), 'harvest-v3-e2e-'));
  try {
    const repoDir = join(root, 'repos', 'demo__pkg');
    const outDir = join(root, 'out');
    mkdirSync(join(repoDir, 'src'), {recursive: true});
    mkdirSync(join(repoDir, 'test'), {recursive: true});
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({name: 'demo-pkg', version: '1.0.0', license: 'MIT'}));
    writeFileSync(join(repoDir, 'src', 'index.js'), `
      export function parseTag(raw) {
        if (typeof raw !== 'string' || !raw.length) {
          throw new TypeError('invalid tag');
        }
        const trimmed = raw.trim();
        const parts = trimmed.split(':');
        const ns = parts[0];
        const name = parts[1] ?? 'default';
        return {ns, name, len: trimmed.length};
      }
      export function sumEven(xs) {
        let total = 0;
        for (const x of xs) {
          if (typeof x === 'number' && x % 2 === 0) total += x;
        }
        return total;
      }
    `);
    writeFileSync(join(repoDir, 'test', 'index.test.js'), `
      import assert from 'node:assert/strict';
      import {parseTag, sumEven} from '../src/index.js';
      test.each([['core:v1'], ['ui:btn']])('tags %s', (tag) => {
        assert.ok(parseTag(tag));
      });
      assert.throws(() => parseTag(''));
    `);

    const preferred = collectLocalRepoCandidates(join(root, 'repos'), {
      maxPerFn: 1,
      maxPerRepo: 2,
      mode: 'native',
      preferUnitTests: true,
      unitTestsOnly: false,
      envDir: HARVEST_ENV_DIR,
    });
    assert.equal(preferred.length, 2);
    assert.ok(preferred.some(t => t.metadata.sourceOrigin === 'dgx-oss-unit-test'));
    assert.equal(preferred.filter(t => t.metadata.upstreamSymbol === 'parseTag')[0].metadata.sourceOrigin, 'dgx-oss-unit-test');

    const nonPreferred = collectLocalRepoCandidates(join(root, 'repos'), {
      maxPerFn: 1,
      maxPerRepo: 2,
      mode: 'native',
      preferUnitTests: false,
      unitTestsOnly: false,
      envDir: HARVEST_ENV_DIR,
    });
    assert.equal(nonPreferred.length, 2);
    assert.ok(nonPreferred.every(t => t.metadata.sourceOrigin === 'dgx-oss-repo'));

    const res = spawnSync(process.execPath, [
      join(REPO_ROOT, 'tools', 'tinker-harvest.mjs'),
      '--skip-npm',
      '--mode', 'native',
      '--env-dir', HARVEST_ENV_DIR,
      '--local-repos', join(root, 'repos'),
      '--output-dir', outDir,
      '--unit-tests-only',
      '--min-trace-lines', '5',
      '--max-per-fn', '5',
    ], {cwd: REPO_ROOT, encoding: 'utf8'});
    assert.equal(res.status, 0, res.stderr);
    const census = JSON.parse(readFileSync(join(outDir, 'census.json'), 'utf8'));
    assert.equal(census.byOrigin['dgx-oss-repo'], undefined);
    assert.equal(census.byOrigin['dgx-oss-unit-test'].admitted, 3);
    const rows = readFileSync(join(outDir, 'harvested.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(r => r.metadata.completeKind === 'throw'), 'keeps real unit-test-input exception test');
    assert.ok(rows.every(r => r.metadata.features.includes('unit-test-input')));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('live fetch() harvesting against local HTTP server replays deterministically after server shutdown', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/catalog') {
      res.writeHead(200, {'Content-Type': 'application/json', 'X-Src': 'local-js'});
      res.end(JSON.stringify({items: [{price: 10}, {price: 25}]}));
    } else if (req.url === '/checkout' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(201, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({accepted: true, total: parsed.total}));
      });
    } else {
      res.writeHead(404);
      res.end('missing');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), 'harvest-fetch-e2e-'));

  try {
    const repoDir = join(root, 'repos', 'demo__fetchpkg');
    const outDir = join(root, 'out');
    mkdirSync(join(repoDir, 'src'), {recursive: true});
    mkdirSync(join(repoDir, 'test'), {recursive: true});
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({name: 'demo-fetchpkg', version: '1.0.0', license: 'MIT', type: 'module'}));
    writeFileSync(join(repoDir, 'src', 'index.js'), `
      export async function syncOrderTotal(base) {
        const res = await fetch(base + '/catalog', {headers: {'Accept': 'application/json'}});
        if (!res.ok) return {ok: false, status: res.status};
        const data = await res.json();
        const total = data.items.reduce((s, x) => s + x.price, 0);
        const postRes = await fetch(base + '/checkout', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({total}),
        });
        const receipt = await postRes.json();
        return {ok: postRes.ok, src: res.headers.get('x-src'), receipt};
      }
    `);
    writeFileSync(join(repoDir, 'test', 'index.test.js'), `
      import assert from 'node:assert/strict';
      import {syncOrderTotal} from '../src/index.js';
      const BASE = ${JSON.stringify(baseUrl)};
      it('syncs catalog and checkout', async () => {
        const out = await syncOrderTotal(BASE);
        assert.equal(out.receipt.total, 35);
      });
    `);

    const res = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        join(REPO_ROOT, 'tools', 'tinker-harvest.mjs'),
        '--skip-npm',
        '--mode', 'native',
        '--env-dir', HARVEST_ENV_DIR,
        '--local-repos', join(root, 'repos'),
        '--output-dir', outDir,
        '--unit-tests-only',
        '--min-trace-lines', '1',
        '--max-per-fn', '3',
      ], {cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe']});
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', status => resolve({status, stdout, stderr}));
    });
    assert.equal(res.status, 0, res.stderr);

    // Completely shut down local HTTP server BEFORE replay verification!
    await new Promise(resolve => server.close(resolve));

    const rows = readFileSync(join(outDir, 'harvested.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    const taskRow = rows[0];
    assert.equal(taskRow.executionMode, 'native');
    assert.ok(taskRow.metadata.features.includes('http.request'));
    assert.equal(taskRow.fixture.calls.length, 2);
    assert.ok(taskRow.fixture.calls.every(c => c.operation === 'http.request'));

    const exported = await exportTinkerExample(taskRow, {traceFormat: 'compact', reasoningChannel: 'thinking'});
    assert.equal(exported.metadata.traceAudit.replayVerified, true);
    const comp = parseStudentAction(exported.messages.at(-1));
    assert.deepEqual(comp.value, {ok: true, src: 'local-js', receipt: {accepted: true, total: 35}});

    const session = createTinkerSession(await prepareTinkerTask(taskRow, {traceFormat: 'compact'}));
    for (const msg of exported.messages.filter(m => m.role === 'assistant')) {
      await session.step(msg, 25);
    }
    assert.equal(session.grade(25).success, true);
  } finally {
    try { server.close(); } catch {}
    rmSync(root, {recursive: true, force: true});
  }
});
