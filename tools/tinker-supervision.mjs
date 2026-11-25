#!/usr/bin/env node
/** Reproducible local audit of actual full/compact/actions-only teacher turns. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {parseArgs, isDeepStrictEqual} from 'node:util';
import {auditTinkerSupervision} from '../src/training/tinker-supervision.js';

try {
  const {values} = parseArgs({options: {
    dataset: {type: 'string'}, output: {type: 'string'}, seed: {type: 'string', default: '17'},
    'sample-per-feature': {type: 'string', default: '2'}, 'include-messages': {type: 'boolean', default: false},
    formats: {type: 'string', default: 'full,compact,actions-only'},
  }});
  if (!values.dataset) throw new TypeError('--dataset JSONL is required');
  const seed = Number(values.seed), samplePerFeature = Number(values['sample-per-feature']);
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(samplePerFeature) || samplePerFeature < 1)
    throw new TypeError('seed must be nonnegative and sample-per-feature positive integers');
  const tasks = (await readFile(values.dataset, 'utf8')).split('\n').filter(line => line.trim()).map(JSON.parse);
  // The runner may prepend this fixed public instruction. Check it exactly,
  // then audit every remaining supplied message; never discard supplied turns.
  const concise = {role: 'system', content: 'Execute the supplied program accurately. Keep any explanation concise; ' +
    'include every required external action and the complete observable outcome.'};
  const conciseIds = new Set();
  const audited = tasks.map(row => {
    if (!row.task || !Array.isArray(row.messages) || !isDeepStrictEqual(row.messages[0], concise)) return row;
    conciseIds.add(row.id);
    return {...row, messages: row.messages.slice(1)};
  });
  const result = await auditTinkerSupervision(audited, {
    seed, samplePerFeature, formats: values.formats.split(','), includeMessages: values['include-messages'],
  });
  result.publicPromptAudit = {concisePrefixesVerified: conciseIds.size,
    scope: 'Only the exact public concise instruction is normalized; all remaining supplied messages are audited'};
  for (const row of result.rows ?? []) if (conciseIds.has(row.id)) {
    row.publicConcisePrefixVerified = true;
    if (row.messages) row.messages = [concise, ...row.messages];
  }
  const text = JSON.stringify(result, null, 2) + '\n';
  if (values.output) {
    await mkdir(dirname(values.output), {recursive: true});
    await writeFile(values.output, text);
    console.log(JSON.stringify({output: values.output, modelSampled: false, ...result.summary}));
  } else process.stdout.write(text);
  if (result.valid === false || result.success === false || result.failures?.length) process.exitCode = 1;
} catch (error) {
  console.error('tinker-supervision:', error.message);
  process.exitCode = 1;
}
