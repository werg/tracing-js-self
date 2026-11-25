#!/usr/bin/env node
/** Reproducible local audit of actual full/compact/actions-only teacher turns. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {parseArgs} from 'node:util';
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
  const result = await auditTinkerSupervision(tasks.map(row => row.task ?? row), {
    seed, samplePerFeature, formats: values.formats.split(','), includeMessages: values['include-messages'],
  });
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
