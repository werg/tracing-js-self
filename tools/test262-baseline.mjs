#!/usr/bin/env node
// Merge of PR #2's selected Test262 *execution* ledger with PR #3's fixture
// integrity and reference pinning. This is NOT the complete Test262 harness.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSpecOracle } from '../src/spec-oracle.js';
import { validateSelection,checkExecutionFixture,classifyExecutionCase,summarizeExecutionCases } from '../src/test262-execution.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/targets.lock.json',import.meta.url),'utf8'));
const selection = JSON.parse(readFileSync(new URL('../conformance/test262-cases.json',import.meta.url),'utf8'));
validateSelection(selection,profile);

const installed = JSON.parse(readFileSync(new URL('../node_modules/@engine262/engine262/package.json',import.meta.url),'utf8'));
assert.equal(installed.version,profile.referenceEngine.npmVersion,'Engine262 reference version differs from profile lock');

function options(argv) {
  const result = {};
  for (let i=0;i<argv.length;i++) {
    const key = argv[i];
    if (!['--test262-root','--output'].includes(key) || key in result)
      throw new Error('Usage: node tools/test262-baseline.mjs [--test262-root dir] [--output report.json]');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value for '+key);
    result[key] = value;
  }
  return result;
}
const args = options(process.argv.slice(2));
const root = args['--test262-root'] ? resolve(args['--test262-root']) : null;

if (root) {
  const head = execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if (head !== selection.test262Commit) throw new Error('Local Test262 checkout has the wrong commit: '+head);
  const dirty = execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();
  if (dirty) throw new Error('Local Test262 checkout has modifications');
}

async function fetchCase(entry) {
  let bytes;
  if (root) {
    bytes = await readFile(join(root,'test',entry.path));
  } else {
    const url = 'https://raw.githubusercontent.com/tc39/test262/' +
      selection.test262Commit + '/test/' + entry.path;
    const response = await fetch(url,{signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('Unable to retrieve pinned fixture '+entry.path+': '+response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length > 1024*1024) throw new Error('Oversized Test262 fixture: '+entry.path);
  checkExecutionFixture(entry,bytes);
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

const reference = await createSpecOracle();
const rows = [];
for (const entry of selection.cases) {
  const source = await fetchCase(entry);
  rows.push(classifyExecutionCase(entry,source,reference.runScript));
}
const totals = summarizeExecutionCases(rows);
const report = {
  schema:'tracing-test262-execution-report/2',
  evidence:'selected sloppy-script execution only; host-side VM errors are diagnostics, not guest completion records',
  profile:selection.profile,
  test262Commit:selection.test262Commit,
  sourceVerification:'pinned upstream Git revision plus individual Git blob SHA-1',
  reference:{package:selection.referencePackage,version:installed.version,traceAuthority:false},
  totals,cases:rows
};
if (args['--output']) {
  const destination = resolve(args['--output']);
  await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({schema:report.schema,totals,
  mismatches:rows.filter(x=>x.unexpected).map(x=>({path:x.path,reason:x.unexpected}))},null,2));
if (totals.unexpected) process.exitCode = 1;
