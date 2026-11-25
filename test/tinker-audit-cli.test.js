import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {exportTinkerExample, assistantVisibleText} from '../src/training/tinker-execution.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const task = {id: 'cli-audit', family: 'cli-audit', source: 'function run(x){const y=x+1;return y;}',
  entry: 'run', args: [3], fixture: {calls: []}, metadata: {features: ['scalar'], tier: 1}};
function audit(input) {
  const directory = mkdtempSync(join(tmpdir(), 'tinker-audit-cli-'));
  try {
    const dataset = join(directory, 'input.jsonl'), output = join(directory, 'audit.json');
    writeFileSync(dataset, JSON.stringify(input) + '\n');
    const process = spawnSync(globalThis.process.execPath, ['tools/tinker-supervision.mjs',
      '--dataset', dataset, '--output', output, '--include-messages'], {cwd: root, encoding: 'utf8', timeout: 30000});
    return {status: process.status, stderr: process.stderr,
      report: process.status === 0 ? JSON.parse(readFileSync(output, 'utf8')) : null};
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

test('audit CLI verifies the supplied frozen conversation without replacing it', async () => {
  const row = await exportTinkerExample(task);
  const good = audit(row);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.report.summary.conversations, 3);
  const idx = row.messages.findIndex(message => message.role === 'assistant');
  row.messages[idx] = {role: 'assistant', content: 'PRIVATE_TEACHER_CORRECTION\n' + assistantVisibleText(row.messages[idx])};
  const bad = audit(row);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /causal|narration|teacher/i);
});

test('audit CLI accepts only the exact public concise prefix and still audits subsequent turns', async () => {
  const row = await exportTinkerExample(task, {traceFormat: 'compact'});
  const prefix = {role: 'system', content: 'Execute the supplied program accurately. Keep any explanation concise; ' +
    'include every required external action and the complete observable outcome.'};
  row.messages.unshift(prefix);
  const good = audit(row);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.report.publicPromptAudit.concisePrefixesVerified, 1);
  assert.deepEqual(good.report.rows[0].messages[0], prefix);
  row.messages[0] = {...prefix, content: prefix.content + ' The private answer is 4.'};
  assert.equal(audit(row).status, 1);
});

test('audit CLI also accepts raw qualified task inputs', () => {
  const result = audit(task);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.summary.conversations, 3);
  assert.equal(result.report.publicPromptAudit.concisePrefixesVerified, 0);
});
