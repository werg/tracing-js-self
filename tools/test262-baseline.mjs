#!/usr/bin/env node
// A pinned, explicitly selected Test262 baseline, not a complete suite runner.
// Official source files are read unchanged. No native eval, vm, Function, or
// require executes guest scripts in the owned runtime.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.js';
import { runReferenceScript } from '../src/reference-engine.js';

const manifest = JSON.parse(readFileSync(
  new URL('../conformance/test262-cases.json', import.meta.url), 'utf8'));
const expectedSchema = 'tracing-test262-selection/1';
const args = process.argv.slice(2);
function option(flag, defaultValue) {
  const i = args.indexOf(flag);
  if (i === -1) return defaultValue;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing argument to ${flag}`);
  return args[i + 1];
}
function parseMeta(source, path) {
  const match = source.match(/\/\*---([\s\S]*?)---\*\//);
  if (!match) throw new Error(`Missing official Test262 frontmatter: ${path}`);
  const meta = match[1];
  const list = (name) => {
    const entry = meta.match(new RegExp(`^\\s*${name}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm'));
    if (!entry) {
      if (new RegExp(`^\\s*${name}:\\s*`, 'm').test(meta))
        throw new Error(`Unsupported frontmatter ${name} representation: ${path}`);
      return [];
    }
    return entry[1].split(',').map(x => x.trim()).filter(Boolean);
  };
  const block = meta.match(/^negative:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] ?? null;
  const negative = block && {
    phase: block.match(/^\s*phase:\s*([\w-]+)/m)?.[1],
    type: block.match(/^\s*type:\s*([\w-]+)/m)?.[1]
  };
  if (negative && (!['parse', 'runtime'].includes(negative.phase) ||
    !/^[A-Za-z]+Error$/.test(negative.type || ''))) {
    throw new Error(`Invalid or unsupported negative expectation in ${path}`);
  }
  if (meta.includes('negative:') && !negative)
    throw new Error(`Cannot parse negative metadata in ${path}`);
  return { flags: list('flags'), includes: list('includes'),
    features: list('features'), negative };
}
function checkRevision(root, sha) {
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'],
    {encoding:'utf8'}).trim();
  if (revision !== sha) throw new Error(`Test262 revision mismatch: expected ${sha}, found ${revision}`);
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'],
    {encoding:'utf8'}).trim();
  if (dirty) throw new Error('Test262 checkout has tracked modifications');
}
function runOwned(source, path) {
  const runtime = createRuntime();
  let entry;
  try {
    entry = runtime.registerSource({text:source,url:`test262/${path}`});
  } catch (error) {
    return {phase:'parse',errorName:error.name,message:String(error.message).slice(0,160)};
  }
  try {
    runtime.start(entry);
    const progress = runtime.drive();
    if (progress.kind !== 'terminated')
      return {phase:'incomplete',detail:progress.kind};
    return {phase:'normal'};
  } catch (error) {
    return {phase:'runtime',errorName:error.name,message:String(error.message).slice(0,160)};
  }
}
function matches(actual, expected) {
  if (!expected) return actual.phase === 'normal';
  return actual.phase === expected.phase && actual.errorName === expected.type;
}
function validateManifest() {
  if (manifest.schema !== expectedSchema || manifest.profile !== 'bounded-js-subset/1')
    throw new Error('Unknown baseline manifest');
  if (!/^[0-9a-f]{40}$/.test(manifest.test262Commit)) throw new Error('Unpinned Test262 corpus');
  if (!Array.isArray(manifest.cases) || !manifest.cases.length)
    throw new Error('Test262 selection cannot be empty');
  const seen = new Set();
  for (const c of manifest.cases) {
    if (typeof c.path !== 'string' || !/^[\w./-]+\.js$/.test(c.path) ||
      c.path.startsWith('/') || c.path.split('/').includes('..') || seen.has(c.path))
      throw new Error(`Invalid or duplicate Test262 path: ${c.path}`);
    if (!['pass','xfail','skip'].includes(c.baseline)) throw new Error('Unknown expected case status');
    if (c.baseline !== 'pass' && (!c.reason || typeof c.reason !== 'string'))
      throw new Error('Every skipped/known-failing test needs a documented reason');
    seen.add(c.path);
  }
}
async function main() {
  validateManifest();
  const root = resolve(option('--test262-root','.cache/test262'));
  checkRevision(root,manifest.test262Commit);
  const cases = [];
  for (const test of manifest.cases) {
    const source = readFileSync(join(root, 'test', test.path), 'utf8');
    const meta = parseMeta(source,test.path);
    const unsupported = [
      ...meta.flags.filter(x => x !== 'noStrict').map(x => `flag:${x}`),
      ...meta.includes.map(x => `include:${x}`),
      ...meta.features.map(x => `feature:${x}`),
      ...(/\bassert\s*\./.test(source) ? ['assert-harness'] : []),
      ...(/\$262\b|\$DONE\b/.test(source) ? ['host-test262-intrinsic'] : [])
    ];
    const row = {path:test.path,baseline:test.baseline,negative:meta.negative,flags:meta.flags};
    if (unsupported.length || test.baseline === 'skip') {
      row.status='skip';
      row.reasons=[...unsupported,...(test.reason ? [test.reason] : [])];
      if(test.baseline !== 'skip')
        row.unexpected=`Unlisted missing harness/feature: ${unsupported.join(',')}`;
    } else {
      row.owned = runOwned(source,test.path);
      row.reference = runReferenceScript(source, {specifier:`test262/${test.path}`});
      row.referencePass = matches(row.reference,meta.negative);
      row.status = matches(row.owned,meta.negative) ? 'pass' : 'xfail';
      if (!row.referencePass)
        row.unexpected='Pinned reference engine did not match Test262 expectation';
      if (row.status !== test.baseline)
        row.unexpected=`Baseline changed: expected ${test.baseline}, observed ${row.status}`;
    }
    cases.push(row);
  }
  const count = (status) => cases.filter(c => c.status === status).length;
  const report = {
    schema:'tracing-test262-report/1',
    profile:manifest.profile,
    test262Commit:manifest.test262Commit,
    reference:{package:manifest.referencePackage,version:manifest.referenceVersion,
      role:'independent spec-backed completion oracle; not authoritative trace'},
    scope:'Explicit Test262 selection only; NOT full Test262 or any percentage conformance claim',
    totals:{selected:cases.length,executed:cases.length-count('skip'),
      passed:count('pass'),knownFailed:count('xfail'),skipped:count('skip'),
      unexpected:cases.filter(c=>c.unexpected).length},
    cases,
  };
  const output = option('--output', null);
  if (output) {
    mkdirSync(dirname(resolve(output)), {recursive:true});
    writeFileSync(resolve(output),JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.totals.unexpected) process.exitCode = 1;
}
main().catch(error=>{console.error(error.stack || error);process.exitCode=1;});
