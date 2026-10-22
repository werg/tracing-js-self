#!/usr/bin/env node
// Fetch only a small, SHA-pinned Test262 syntax slice. The files are parsed
// but NEVER executed; this is explicitly not a full Test262 harness.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createSpecOracle } from '../src/spec-oracle.js';
import { verifySuiteFile, parseTest262Metadata, inspectBoundedFrontend, summarizeSyntaxRows } from '../src/test262-baseline.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/targets.lock.json', import.meta.url), 'utf8'));
const slice = JSON.parse(readFileSync(new URL('../coverage/test262-slice.lock.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../node_modules/@engine262/engine262/package.json', import.meta.url), 'utf8'));
assert.equal(pkg.version, profile.referenceEngine.npmVersion, 'Unpinned engine262 package');
assert.equal(slice.schema, 'test262-syntax-slice/1');

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (!args[i + 1]) throw new Error(`Missing value for ${name}`);
  return args[i + 1];
};
if (args.some(arg => !['--root','--output'].includes(arg) && !args.some((x,i) => i>0 && x===arg && ['--root','--output'].includes(args[i-1]))))
  throw new Error('Usage: node scripts/run-conformance.mjs [--root path/to/test262] [--output path.json]');
const root = option('--root');
const output = option('--output');
const ref = profile.conformanceSuiteRevisions.test262;
assert.match(ref, /^[0-9a-f]{40}$/);
const reference = await createSpecOracle();

async function getTest(path) {
  if (root) return readFile(join(resolve(root), path));
  const url = `https://raw.githubusercontent.com/tc39/test262/${ref}/${path}`;
  const response = await fetch(url, {signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Cannot fetch pinned Test262 fixture ${path}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > 1024*1024) throw new Error(`Oversized Test262 fixture: ${path}`);
  return data;
}

const rows = [];
for (const entry of slice.tests) {
  const data = await getTest(entry.path);
  verifySuiteFile(entry, data);
  const source = new TextDecoder('utf-8', {fatal:true}).decode(data);
  const meta = parseTest262Metadata(source);
  const bounded = inspectBoundedFrontend(source);
  const referenceAccepted = reference.compileScript(source, {url:entry.path}).accepted;
  const boundedPassed = bounded.parseAccepted === meta.expectedParseAccepted;
  const referencePassed = referenceAccepted === meta.expectedParseAccepted;
  if (bounded.parseAccepted !== entry.baselineParseAccepted) {
    throw new Error(`Pinned bounded parser snapshot changed for ${entry.path}: ${bounded.parseAccepted}`);
  }
  if (!referencePassed) {
    throw new Error(`Spec reference disagrees with Test262 parse metadata for ${entry.path}`);
  }
  rows.push({
    path:entry.path,
    test262ExpectedParseAccepted:meta.expectedParseAccepted,
    referenceAccepted,
    referencePassed,
    bounded,
    boundedPassed,
    status:boundedPassed?'matched':'known-gap'
  });
}
const summary = summarizeSyntaxRows(rows);
const report = {
  schema:'test262-parser-baseline/1',
  evidence:'script syntax only; no harness, execution, module, or strict-mode conformance claim',
  profile:profile.profile,
  suite:{repository:'tc39/test262',commit:ref,cases:rows.length,source:'pinned-commit-and-verified-git-blobs'},
  oracle:{name:'engine262',revision:profile.referenceEngine.upstreamCommit,packageVersion:pkg.version,traceAuthority:false},
  summary,rows
};
if (output) {await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({suite:report.suite,oracle:report.oracle,summary,failures:rows.filter(row=>!row.boundedPassed).map(row=>row.path)},null,2));
assert(summary.total>0 && summary.referencePassed===summary.total);
