#!/usr/bin/env node
// Verify and export all 80 hard multi-turn native-V8 effectful tasks as JSONL.
// Every task is executed in isolated native V8, traced in compact format, and
// replayed through auditTeacherConversation() before emission.

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {hardEffectfulTasks} from '../src/training/tinker-hard-effectful.js';
import {exportTinkerExample} from '../src/training/tinker-execution.js';

const {values} = parseArgs({options: {
  output: {type: 'string', short: 'o'},
  'trace-format': {type: 'string', default: 'compact'},
  seed: {type: 'string', default: '17'},
  jobs: {type: 'string', default: '4'},
  'export-examples': {type: 'boolean', default: false},
  help: {type: 'boolean', short: 'h'},
}});

if (values.help) {
  console.log(`Usage: node tools/tinker-export-hard-effectful.mjs [options]
  -o, --output <path>       Write verified tasks (or exported examples) as JSONL
  --trace-format <fmt>      Teacher trace format for verification (default: compact)
  --seed <n>                Deterministic seed metadata (default: 17)
  --jobs <n>                Parallel verification workers (default: 4)
  --export-examples         Write full exported conversation rows instead of raw tasks`);
  process.exit(0);
}

const seed = Number(values.seed);
const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));
const traceFormat = values['trace-format'];
const tasks = hardEffectfulTasks({seed});

const results = new Array(tasks.length);
let next = 0;
let failures = 0;

await Promise.all(Array.from({length: Math.min(jobs, tasks.length)}, async () => {
  while (next < tasks.length) {
    const idx = next++;
    const task = tasks[idx];
    try {
      const exported = await exportTinkerExample(task, {traceFormat});
      if (!exported.metadata.traceAudit?.replayVerified) {
        throw new Error('traceAudit.replayVerified is false');
      }
      results[idx] = {ok: true, task: exported.task, exported};
    } catch (err) {
      failures++;
      results[idx] = {ok: false, id: task.id, error: String(err?.message ?? err)};
      process.stderr.write(`FAIL ${task.id}: ${err?.message ?? err}\n`);
    }
  }
}));

const okResults = results.filter(r => r.ok);
const callCounts = okResults.map(r => r.exported.metadata.externalCalls);
const summary = {
  total: tasks.length,
  families: new Set(tasks.map(t => t.family)).size,
  verified: okResults.length,
  failed: failures,
  traceFormat,
  minExternalCalls: callCounts.length ? Math.min(...callCounts) : 0,
  maxExternalCalls: callCounts.length ? Math.max(...callCounts) : 0,
  totalNarrationLines: okResults.reduce((s, r) => s + (r.exported.metadata.traceAudit?.narrationLines ?? 0), 0),
};

if (failures > 0) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}

if (values.output) {
  const outPath = resolve(values.output);
  mkdirSync(dirname(outPath), {recursive: true});
  const rows = values['export-examples']
    ? okResults.map(r => r.exported)
    : okResults.map(r => ({...r.task, metadata: {...r.task.metadata, externalCalls: r.exported.metadata.externalCalls}}));
  writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  summary.output = outPath;
}

console.log(JSON.stringify(summary, null, 2));
