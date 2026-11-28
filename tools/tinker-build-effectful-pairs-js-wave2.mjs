#!/usr/bin/env node
// Build and 2x-verify Wave 2 Counterfactual Effectful I/O & Shell pairs for JS/TS.
// Generates 66 brand-new realistic effectful families (158 paired tasks, all causal-pair)
// covering shell.exec, http.request/fetch, fs.*, kv/env/platform/random/uuid/multi-service chains.
// Every task is recorded via exact native runtime contracts, then independently verified 2x:
//   (1) exportTinkerExample() via tools/effectful-reference-worker.mjs + auditTeacherConversation()
//   (2) separate child process tools/tinker-execution.mjs (export + live start/step/grade replay)
// Plus causal-prefix invariance checks across every counterfactual pair group.

import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {parseArgs} from 'node:util';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

import {HOST_METHODS} from '../src/host/operations.js';
import {compileBoundedTypeScript} from '../src/typescript.js';
import {encodeReadable, decodeReadable, exportTinkerExample} from '../src/training/tinker-execution.js';
import {normalizeFetchRequest, VM_FETCH_RUNTIME_SCRIPT} from '../src/training/tinker-http-fetch.js';
import {createReplayNodeIoBridge, VM_NODE_IO_RUNTIME_SCRIPT} from '../src/training/tinker-node-io.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

// ---------------------------------------------------------------------------
// Deterministic local recorder mirroring effectful-reference-worker.mjs
// ---------------------------------------------------------------------------
async function recordJsFixture({
  source,
  entry = 'run',
  args = [],
  language = 'js',
  nativeBindings = [],
  randomMode = 'seeded',
  randomSeed = 17,
  respond,
  allowThrow = false,
}) {
  const jsSource = language === 'ts'
    ? compileBoundedTypeScript(source, {path: 'training.ts'}).javascript
    : source;
  const recordedCalls = [];

  function invokeSync(op, callArgs) {
    const idx = recordedCalls.length;
    if (idx >= 128) throw new RangeError('Too many recorded calls');
    const clonedArgs = decodeReadable(encodeReadable(callArgs));
    const reply = respond(op, clonedArgs, idx);
    if (!reply || typeof reply !== 'object') {
      throw new Error(`Unscripted sync call #${idx}: ${op}(${JSON.stringify(encodeReadable(callArgs))})`);
    }
    const status = reply.status ?? 'fulfilled';
    const result = reply.result;
    recordedCalls.push({
      operation: op,
      arguments: encodeReadable(callArgs),
      status,
      result: encodeReadable(result),
    });
    const realized = decodeReadable(encodeReadable(result));
    if (status === 'rejected') throw realized;
    return realized;
  }

  function invokeAsync(op, callArgs) {
    const idx = recordedCalls.length;
    if (idx >= 128) return Promise.reject(new RangeError('Too many recorded calls'));
    const clonedArgs = decodeReadable(encodeReadable(callArgs));
    const reply = respond(op, clonedArgs, idx);
    if (!reply || typeof reply !== 'object') {
      return Promise.reject(new Error(`Unscripted async call #${idx}: ${op}(${JSON.stringify(encodeReadable(callArgs))})`));
    }
    const status = reply.status ?? 'fulfilled';
    const result = reply.result;
    recordedCalls.push({
      operation: op,
      arguments: encodeReadable(callArgs),
      status,
      result: encodeReadable(result),
    });
    const realized = decodeReadable(encodeReadable(result));
    return status === 'rejected' ? Promise.reject(realized) : Promise.resolve(realized);
  }

  const host = Object.create(null);
  for (const [method, operation] of Object.entries(HOST_METHODS)) {
    const isSync = operation.startsWith('platform.') || operation === 'natlang.callSync';
    host[method] = (...a) => (isSync ? invokeSync(operation, a) : invokeAsync(operation, a));
  }

  const nodeIoBridge = createReplayNodeIoBridge({
    invokeSync: (op, a) => invokeSync(op, a),
    invokeAsync: (op, a) => invokeAsync(op, a),
  });

  const guestArgs = decodeReadable(encodeReadable(args));
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, Buffer,
    host,
    __args: guestArgs,
    __result: undefined,
    __kind: 'return',
    __platformFetch: (reqInput, reqInit) => invokeAsync('http.request', normalizeFetchRequest(reqInput, reqInit)),
    __platformNodeIo: nodeIoBridge,
    queueMicrotask: cb => queueMicrotask(cb),
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(m => [
      m, (...a) => invokeSync('platform.console.' + m, a),
    ])),
  });

  new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});
  new vm.Script(VM_NODE_IO_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});

  if (randomMode === 'tool') {
    context.__platformRandom = () => invokeSync('platform.random', []);
    new vm.Script('Math.random = __platformRandom;').runInContext(context, {timeout: 5000});
  } else {
    context.__trainingRandomSeed = randomSeed;
    new vm.Script(`(function(){let s=__trainingRandomSeed>>>0;Math.random=function(){s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};})()`).runInContext(context, {timeout: 5000});
  }

  if (/\bDate\.now\b/.test(jsSource)) {
    context.__platformDateNow = () => invokeSync('platform.dateNow', []);
    new vm.Script('Date.now = __platformDateNow;').runInContext(context, {timeout: 5000});
  }

  const preamble = nativeBindings.map(b =>
    `function ${b.name}(...a){return host.${b.kind === 'promise' ? 'natlangCall' : 'natlangCallSync'}(${JSON.stringify(b.name)},undefined,a);}`
  ).join('\n');

  const fullSrc = `"use strict";\n${jsSource}\n${preamble}\ntry { __result = ${entry}.apply(undefined, __args); } catch (e) { __kind = "throw"; __result = e; }`;
  new vm.Script(fullSrc).runInContext(context, {timeout: 5000});
  let value = context.__result;
  let kind = context.__kind;
  if (kind === 'return') {
    try { value = await value; } catch (err) { kind = 'throw'; value = err; }
  }
  if (kind === 'throw' && !allowThrow) {
    throw new Error(`Unexpected guest throw while recording: ${value?.name ?? 'Error'}: ${value?.message ?? value}`);
  }
  return {calls: recordedCalls, kind, value};
}

// Helper to create queue-based responder for concise, explicit counterfactual scripts.
function makeResponder(script) {
  const queues = new Map();
  for (const [op, items] of Object.entries(script)) {
    queues.set(op, [...items]);
  }
  return (op, callArgs, idx) => {
    const key = op === 'natlang.call' || op === 'natlang.callSync' ? callArgs[0] : op;
    if (key.startsWith('platform.console.')) {
      return {status: 'fulfilled', result: undefined};
    }
    const q = queues.get(key) ?? queues.get(op);
    if (!q || q.length === 0) {
      throw new Error(`Queue exhausted for ${key} (${op}) at call #${idx} with args ${JSON.stringify(encodeReadable(callArgs))}`);
    }
    const next = q.shift();
    if (typeof next === 'function') return next(callArgs, idx);
    if (next && typeof next === 'object' && ('status' in next || 'result' in next) && Object.keys(next).every(k => k === 'status' || k === 'result')) {
      return {status: next.status ?? 'fulfilled', result: next.result};
    }
    return {status: 'fulfilled', result: next};
  };
}

const ok = result => ({status: 'fulfilled', result});
const fail = result => ({status: 'rejected', result});
const shRes = (stdout = '', stderr = '', status = 0) => ok({stdout, stderr, status});
const httpResp = (status, body, headers = {'content-type': 'application/json'}, url = '') => ok({
  status,
  statusText: status >= 200 && status < 300 ? 'OK' : 'ERR',
  url,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const KV_BINDINGS = [
  {name: 'kv_get', kind: 'promise', description: 'Read JSON value for key from KV store, or null if absent.'},
  {name: 'kv_set', kind: 'promise', description: 'Write JSON value for key in KV store.'},
];
const KV_DEL_BINDINGS = [
  ...KV_BINDINGS,
  {name: 'kv_del', kind: 'promise', description: 'Delete key from KV store.'},
];

// ===========================================================================
// 66 Brand-New Realistic Effectful Families (158 Counterfactual Paired Tasks)
//   Group 1: 14 shell.exec families (34 tasks)
//   Group 2: 20 http.request / fetch families (48 tasks)
//   Group 3: 16 fs.* families (38 tasks)
//   Group 4: 16 kv / env / platform / random / uuid / multi-service families (38 tasks)
// ===========================================================================
function buildFamilySpecs() {
  const specs = [];

  // =========================================================================
  // GROUP 1: SHELL.EXEC (14 families, 34 tasks)
  // =========================================================================

  // 1. git-dirty-commit-guard (3 branches)
  specs.push({
    slug: 'git-dirty-commit-guard',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'platform', 'branch'],
    source: `function run(repoDir, message) {
  const {execFileSync} = require('node:child_process');
  const statusOut = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {encoding: 'utf8'}).trim();
  if (!statusOut) {
    console.info('clean-tree:' + repoDir);
    return {committed: false, reason: 'clean', files: []};
  }
  const files = statusOut.split('\\n').map(l => l.trim().split(/\\s+/).pop());
  try {
    execFileSync('git', ['-C', repoDir, 'diff', '--cached', '--quiet'], {encoding: 'utf8'});
    console.warn('nothing-staged:' + files.length);
    return {committed: false, reason: 'unstaged-only', files};
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  const commitOut = execFileSync('git', ['-C', repoDir, 'commit', '-m', message], {encoding: 'utf8'}).trim();
  return {committed: true, reason: 'ok', files, summary: commitOut.split('\\n')[0]};
}`,
    args: ['/srv/repo', 'chore: release'],
    branches: [
      ['clean-skip', {'shell.exec': [shRes('')]}],
      ['unstaged-only', {'shell.exec': [shRes(' M src/app.js\n?? tmp.log\n'), shRes('', '', 0)]}],
      ['staged-commit', {'shell.exec': [shRes('M  src/app.js\n'), shRes('', '', 1), shRes('[main 9a1b2c3] chore: release\n 1 file changed')]}],
    ],
  });

  // 2. git-tag-semver-bump (2 branches)
  specs.push({
    slug: 'git-tag-semver-bump',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'regexp', 'branch'],
    source: `function run(repoDir, bump) {
  const cp = require('node:child_process');
  let latest = 'v0.0.0';
  try {
    latest = cp.execFileSync('git', ['-C', repoDir, 'describe', '--tags', '--abbrev=0'], {encoding: 'utf8'}).trim();
  } catch (err) {
    console.warn('no-tags:' + err.status);
  }
  const m = /^v(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(latest);
  if (!m) return {ok: false, reason: 'invalid-tag', latest};
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') { maj++; min = 0; pat = 0; }
  else if (bump === 'minor') { min++; pat = 0; }
  else { pat++; }
  const nextTag = 'v' + maj + '.' + min + '.' + pat;
  cp.execFileSync('git', ['-C', repoDir, 'tag', nextTag], {encoding: 'utf8'});
  return {ok: true, previous: latest, nextTag};
}`,
    args: ['/workspace/pkg', 'minor'],
    branches: [
      ['existing-tag', {'shell.exec': [shRes('v2.4.7\n'), shRes('')]}],
      ['first-tag-fallback', {'shell.exec': [shRes('', 'fatal: No names found', 128), shRes('')]}],
    ],
  });

  // 3. test-runner-rerun-flakes (3 branches)
  specs.push({
    slug: 'test-runner-rerun-flakes',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'loop', 'exception', 'platform'],
    source: `function run(suite, maxRetries) {
  const {execFileSync} = require('node:child_process');
  const attempts = [];
  for (let i = 1; i <= maxRetries + 1; i++) {
    try {
      const out = execFileSync('npm', ['test', '--', suite], {encoding: 'utf8'}).trim();
      attempts.push({attempt: i, status: 0});
      return {passed: true, flaky: i > 1, attempts, output: out};
    } catch (err) {
      attempts.push({attempt: i, status: err.status ?? 1, stderr: String(err.stderr || '').trim()});
      console.warn('test-fail:' + suite + ':try=' + i);
    }
  }
  return {passed: false, flaky: false, attempts};
}`,
    args: ['auth.spec.js', 2],
    branches: [
      ['pass-first', {'shell.exec': [shRes('12 passing (140ms)')]}],
      ['flake-recovered', {'shell.exec': [shRes('', 'timeout on socket', 1), shRes('12 passing (155ms)')]}],
      ['hard-fail', {'shell.exec': [shRes('', 'assertion failed', 1), shRes('', 'assertion failed', 1), shRes('', 'assertion failed', 1)]}],
    ],
  });

  // 4. build-fallback-clean-rebuild (2 branches)
  specs.push({
    slug: 'build-fallback-clean-rebuild',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'exception', 'platform'],
    source: `function run(target) {
  const {execSync} = require('node:child_process');
  try {
    const out = execSync('make build-' + target, {encoding: 'utf8'}).trim();
    return {ok: true, mode: 'incremental', summary: out};
  } catch (err) {
    console.warn('incremental-failed:' + err.status);
    execSync('make clean', {encoding: 'utf8'});
    try {
      const out2 = execSync('make build-' + target, {encoding: 'utf8'}).trim();
      return {ok: true, mode: 'clean-rebuild', summary: out2};
    } catch (err2) {
      console.error('clean-rebuild-failed:' + err2.status);
      return {ok: false, mode: 'clean-rebuild', status: err2.status, stderr: String(err2.stderr || '').trim()};
    }
  }
}`,
    args: ['release'],
    branches: [
      ['incremental-ok', {'shell.exec': [shRes('built release in 1.2s')]}],
      ['clean-rebuild-ok', {'shell.exec': [shRes('', 'stale object cache', 2), shRes('cleaned'), shRes('built release in 4.8s')]}],
    ],
  });

  // 5. npm-audit-severity-gate (3 branches)
  specs.push({
    slug: 'npm-audit-severity-gate',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'json', 'exception', 'branch'],
    source: `function run(projectDir, blockOnHigh) {
  const {execFileSync} = require('node:child_process');
  let raw;
  let exitCode = 0;
  try {
    raw = execFileSync('npm', ['audit', '--json', '--prefix', projectDir], {encoding: 'utf8'});
  } catch (err) {
    exitCode = err.status ?? 1;
    raw = String(err.stdout || '{}');
  }
  const report = JSON.parse(raw);
  const counts = report.vulnerabilities || {critical: 0, high: 0, moderate: 0};
  const blocked = counts.critical > 0 || (blockOnHigh && counts.high > 0);
  if (blocked) {
    console.error('audit-blocked:crit=' + counts.critical + ':high=' + counts.high);
  }
  return {exitCode, blocked, counts};
}`,
    args: ['/app/web', true],
    branches: [
      ['zero-vulns', {'shell.exec': [shRes('{"vulnerabilities":{"critical":0,"high":0,"moderate":0}}')]}],
      ['moderate-only-allowed', {'shell.exec': [shRes('{"vulnerabilities":{"critical":0,"high":0,"moderate":3}}', '', 1)]}],
      ['high-blocked', {'shell.exec': [shRes('{"vulnerabilities":{"critical":0,"high":2,"moderate":1}}', '', 1)]}],
    ],
  });

  // 6. eslint-autofix-verify (2 branches)
  specs.push({
    slug: 'eslint-autofix-verify',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'exception', 'platform'],
    source: `function run(globPattern) {
  const {execFileSync} = require('node:child_process');
  try {
    execFileSync('eslint', [globPattern], {encoding: 'utf8'});
    return {clean: true, autofixed: false, remaining: 0};
  } catch (err) {
    console.info('eslint-errors:' + err.status);
  }
  try {
    execFileSync('eslint', ['--fix', globPattern], {encoding: 'utf8'});
    return {clean: true, autofixed: true, remaining: 0};
  } catch (err2) {
    const lines = String(err2.stdout || '').trim().split('\\n').filter(Boolean);
    return {clean: false, autofixed: true, remaining: lines.length};
  }
}`,
    args: ['src/**/*.js'],
    branches: [
      ['already-clean', {'shell.exec': [shRes('')]}],
      ['autofix-still-dirty', {'shell.exec': [shRes('src/a.js:3 error\n', '', 1), shRes('src/a.js:9 error\nsrc/b.js:4 error\n', '', 1)]}],
    ],
  });

  // 7. tarball-compress-and-sha256 (2 branches)
  specs.push({
    slug: 'tarball-compress-and-sha256',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'fs', 'fs.writeText'],
    source: `function run(srcDir, archivePath) {
  const {execFileSync} = require('node:child_process');
  const fs = require('node:fs');
  try {
    execFileSync('tar', ['-czf', archivePath, srcDir], {encoding: 'utf8'});
  } catch (err) {
    console.error('tar-failed:' + err.status);
    return {ok: false, stage: 'tar', status: err.status};
  }
  const sumOut = execFileSync('sha256sum', [archivePath], {encoding: 'utf8'}).trim();
  const digest = sumOut.split(/\\s+/)[0];
  fs.writeFileSync(archivePath + '.sha256', digest + '  ' + archivePath + '\\n', 'utf8');
  return {ok: true, archivePath, digest};
}`,
    args: ['/build/out', '/build/release.tar.gz'],
    branches: [
      ['pack-and-sign', {'shell.exec': [shRes(''), shRes('d41d8cd98f00b204e9800998ecf8427e  /build/release.tar.gz\n')], 'fs.writeText': [ok(undefined)]}],
      ['tar-failure', {'shell.exec': [shRes('', 'tar: No space left on device', 2)]}],
    ],
  });

  // 8. service-systemd-health-probe (3 branches)
  specs.push({
    slug: 'service-systemd-health-probe',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'platform', 'branch'],
    source: `function run(serviceName, autoRestart) {
  const {execFileSync} = require('node:child_process');
  let state;
  try {
    state = execFileSync('systemctl', ['is-active', serviceName], {encoding: 'utf8'}).trim();
  } catch (err) {
    state = String(err.stdout || 'inactive').trim() || 'inactive';
  }
  if (state === 'active') {
    return {service: serviceName, state: 'active', restarted: false};
  }
  if (!autoRestart) {
    console.warn('service-down:' + serviceName + ':' + state);
    return {service: serviceName, state, restarted: false};
  }
  execFileSync('systemctl', ['restart', serviceName], {encoding: 'utf8'});
  const after = execFileSync('systemctl', ['is-active', serviceName], {encoding: 'utf8'}).trim();
  return {service: serviceName, state: after, restarted: true, previous: state};
}`,
    args: ['worker-queue', true],
    branches: [
      ['already-active', {'shell.exec': [shRes('active\n')]}],
      ['restarted-healthy', {'shell.exec': [shRes('failed\n', '', 3), shRes(''), shRes('active\n')]}],
      ['restarted-still-activating', {'shell.exec': [shRes('inactive\n', '', 3), shRes(''), shRes('activating\n')]}],
    ],
  });

  // 9. docker-image-pull-or-build (2 branches)
  specs.push({
    slug: 'docker-image-pull-or-build',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'exception', 'platform'],
    source: `function run(imageTag, contextDir) {
  const {execFileSync} = require('node:child_process');
  try {
    const inspect = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], {encoding: 'utf8'}).trim();
    return {source: 'cache', imageTag, id: inspect};
  } catch (_err) {
    console.info('cache-miss:' + imageTag);
  }
  try {
    execFileSync('docker', ['pull', imageTag], {encoding: 'utf8'});
    const id = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], {encoding: 'utf8'}).trim();
    return {source: 'registry', imageTag, id};
  } catch (_err2) {
    console.warn('pull-failed-building:' + imageTag);
    execFileSync('docker', ['build', '-t', imageTag, contextDir], {encoding: 'utf8'});
    return {source: 'local-build', imageTag, id: 'local:' + imageTag};
  }
}`,
    args: ['acme/api:1.9', '/repo/docker'],
    branches: [
      ['pull-from-registry', {'shell.exec': [shRes('', 'No such image', 1), shRes('Pulled'), shRes('sha256:99aa11\n')]}],
      ['fallback-local-build', {'shell.exec': [shRes('', 'No such image', 1), shRes('', 'manifest unknown', 1), shRes('Successfully built')]}],
    ],
  });

  // 10. git-branch-merge-ff-or-abort (2 branches)
  specs.push({
    slug: 'git-branch-merge-ff-or-abort',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'exception', 'platform'],
    source: `function run(repoDir, branch) {
  const {execFileSync} = require('node:child_process');
  execFileSync('git', ['-C', repoDir, 'fetch', 'origin', branch], {encoding: 'utf8'});
  try {
    execFileSync('git', ['-C', repoDir, 'merge', '--ff-only', 'origin/' + branch], {encoding: 'utf8'});
    const sha = execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim();
    return {merged: true, strategy: 'ff-only', head: sha};
  } catch (err) {
    console.warn('ff-rejected:' + branch);
    execFileSync('git', ['-C', repoDir, 'merge', '--abort'], {encoding: 'utf8'});
    return {merged: false, strategy: 'aborted', reason: String(err.stderr || '').trim()};
  }
}`,
    args: ['/srv/app', 'release-24'],
    branches: [
      ['ff-success', {'shell.exec': [shRes(''), shRes('Fast-forward'), shRes('7c4e11a\n')]}],
      ['diverged-abort', {'shell.exec': [shRes(''), shRes('', 'fatal: Not possible to fast-forward', 128), shRes('')]}],
    ],
  });

  // 11. tls-cert-expiry-check (3 branches)
  specs.push({
    slug: 'tls-cert-expiry-check',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'platform', 'branch'],
    source: `function run(certPath, warnDays) {
  const {execFileSync} = require('node:child_process');
  const nowSec = Math.floor(Date.now() / 1000);
  const out = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-enddate'], {encoding: 'utf8'}).trim();
  const raw = out.replace(/^notAfter=/, '');
  const expSec = Math.floor(Number(raw));
  const daysLeft = Math.floor((expSec - nowSec) / 86400);
  if (daysLeft <= 0) {
    console.error('cert-expired:' + certPath);
    return {status: 'expired', daysLeft, renew: true};
  }
  if (daysLeft <= warnDays) {
    console.warn('cert-expiring:' + certPath + ':' + daysLeft);
    execFileSync('certbot', ['renew', '--cert-name', certPath], {encoding: 'utf8'});
    return {status: 'renewed', daysLeft, renew: true};
  }
  return {status: 'valid', daysLeft, renew: false};
}`,
    args: ['/etc/tls/api.pem', 14],
    branches: [
      ['healthy-cert', {'platform.dateNow': [1700000000000], 'shell.exec': [shRes('notAfter=' + (1700000000 + 60 * 86400) + '\n')]}],
      ['expiring-renewed', {'platform.dateNow': [1700000000000], 'shell.exec': [shRes('notAfter=' + (1700000000 + 7 * 86400) + '\n'), shRes('Renewed')]}],
      ['already-expired', {'platform.dateNow': [1700000000000], 'shell.exec': [shRes('notAfter=' + (1700000000 - 2 * 86400) + '\n')]}],
    ],
  });

  // 12. db-dump-verify-restore (2 branches, TypeScript)
  specs.push({
    slug: 'db-dump-verify-restore',
    domain: 'shell',
    language: 'ts',
    features: ['shell', 'shell.exec', 'fs', 'fs.stat', 'typescript'],
    source: `declare function require(id: string): any;
interface BackupResult { ok: boolean; bytes: number; verified: boolean; reason?: string; }
function run(dbName: string, dumpPath: string, minBytes: number): BackupResult {
  const {execFileSync} = require('node:child_process');
  const fs = require('node:fs');
  execFileSync('pg_dump', ['-Fc', '-f', dumpPath, dbName], {encoding: 'utf8'});
  const st = fs.statSync(dumpPath);
  if (!st.isFile() || st.size < minBytes) {
    console.error('dump-too-small:' + st.size);
    return {ok: false, bytes: st.size, verified: false, reason: 'size-below-min'};
  }
  execFileSync('pg_restore', ['--list', dumpPath], {encoding: 'utf8'});
  return {ok: true, bytes: st.size, verified: true};
}`,
    args: ['billing_prod', '/backups/billing.dump', 1024],
    branches: [
      ['verified-dump', {'shell.exec': [shRes(''), shRes('; Archive created')], 'fs.stat': [ok({isFile: true, isDirectory: false, size: 8192})]}],
      ['truncated-dump', {'shell.exec': [shRes('')], 'fs.stat': [ok({isFile: true, isDirectory: false, size: 128})]}],
    ],
  });

  // 13. disk-usage-prune-guard (2 branches)
  specs.push({
    slug: 'disk-usage-prune-guard',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'platform', 'branch'],
    source: `function run(mountPath, thresholdPct) {
  const {execFileSync} = require('node:child_process');
  const dfOut = execFileSync('df', ['-P', mountPath], {encoding: 'utf8'}).trim().split('\\n');
  const cols = dfOut[dfOut.length - 1].trim().split(/\\s+/);
  const pct = parseInt(cols[4].replace('%', ''), 10);
  if (pct < thresholdPct) {
    return {mountPath, pct, pruned: false, reclaimed: '0B'};
  }
  console.warn('disk-high:' + mountPath + ':' + pct + '%');
  const pruneOut = execFileSync('docker', ['system', 'prune', '-f'], {encoding: 'utf8'}).trim();
  const m = /Total reclaimed space:\\s*(.+)$/.exec(pruneOut);
  return {mountPath, pct, pruned: true, reclaimed: m ? m[1].trim() : 'unknown'};
}`,
    args: ['/var/lib/docker', 80],
    branches: [
      ['below-threshold', {'shell.exec': [shRes('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme0 100000 62000 38000 62% /var/lib/docker\n')]}],
      ['above-threshold-prune', {'shell.exec': [
        shRes('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme0 100000 88000 12000 88% /var/lib/docker\n'),
        shRes('Deleted Containers:\nc1\nTotal reclaimed space: 3.4GB\n'),
      ]}],
    ],
  });

  // 14. port-listener-diagnostics (2 branches)
  specs.push({
    slug: 'port-listener-diagnostics',
    domain: 'shell',
    features: ['shell', 'shell.exec', 'env', 'env.get', 'branch'],
    source: `function run(defaultPort) {
  const {execFileSync} = require('node:child_process');
  const port = Number(process.env.SERVICE_PORT || defaultPort);
  let out = '';
  try {
    out = execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-t'], {encoding: 'utf8'}).trim();
  } catch (_err) {
    return {port, inUse: false, pids: []};
  }
  const pids = out.split('\\n').map(s => Number(s.trim())).filter(Boolean);
  if (pids.length === 0) return {port, inUse: false, pids: []};
  const cmd = execFileSync('ps', ['-p', String(pids[0]), '-o', 'comm='], {encoding: 'utf8'}).trim();
  return {port, inUse: true, pids, owner: cmd};
}`,
    args: [8080],
    branches: [
      ['port-free', {'env.get': [ok('9090')], 'shell.exec': [shRes('', '', 1)]}],
      ['port-occupied', {'env.get': [ok(null)], 'shell.exec': [shRes('4120\n4121\n'), shRes('node\n')]}],
    ],
  });

  // =========================================================================
  // GROUP 2: HTTP.REQUEST / FETCH (20 families, 48 tasks)
  // =========================================================================

  // 15. fetch-retry-after-429-vs-403 (3 branches)
  specs.push({
    slug: 'fetch-retry-after-429-vs-403',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'branch', 'platform', 'json'],
    source: `async function run(url, maxAttempts) {
  const waits = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, {method: 'GET', headers: {'Accept': 'application/json', 'X-Attempt': String(attempt)}});
    if (resp.ok) {
      const data = await resp.json();
      return {ok: true, status: resp.status, attempts: attempt, waits, data};
    }
    if (resp.status === 429 || resp.status === 503) {
      const ra = Number(resp.headers.get('retry-after') || (attempt * 2));
      waits.push(ra);
      console.warn('backoff:' + resp.status + ':wait=' + ra);
      continue;
    }
    console.error('fatal-http:' + resp.status);
    return {ok: false, status: resp.status, attempts: attempt, waits, data: null};
  }
  return {ok: false, status: 503, attempts: maxAttempts, waits, data: null};
}`,
    args: ['https://api.wave2.test/v1/orders', 3],
    branches: [
      ['retry-429-then-200', {'http.request': [
        httpResp(429, {error: 'rate_limit'}, {'retry-after': '5', 'content-type': 'application/json'}),
        httpResp(200, {orders: 14}),
      ]}],
      ['abort-403-immediate', {'http.request': [
        httpResp(403, {error: 'forbidden'}),
      ]}],
      ['exhaust-503', {'http.request': [
        httpResp(503, 'down', {'retry-after': '1'}),
        httpResp(503, 'down', {}),
        httpResp(503, 'down', {'retry-after': '4'}),
      ]}],
    ],
  });

  // 16. oauth-refresh-on-401 (3 branches)
  specs.push({
    slug: 'oauth-refresh-on-401',
    domain: 'http',
    features: ['http', 'http.request', 'native-bindings', 'json', 'branch'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(resourceUrl, tokenUrl, clientId) {
  let token = await kv_get('oauth:' + clientId);
  let resp = await fetch(resourceUrl, {method: 'GET', headers: {'Authorization': 'Bearer ' + token}});
  if (resp.status === 401) {
    console.info('refresh-token:' + clientId);
    const ref = await fetch(tokenUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({grant_type: 'refresh_token', client_id: clientId}),
    });
    if (!ref.ok) {
      return {ok: false, refreshed: false, status: ref.status};
    }
    const tokBody = await ref.json();
    token = tokBody.access_token;
    await kv_set('oauth:' + clientId, token);
    resp = await fetch(resourceUrl, {method: 'GET', headers: {'Authorization': 'Bearer ' + token}});
    return {ok: resp.ok, refreshed: true, status: resp.status, payload: resp.ok ? await resp.json() : null};
  }
  return {ok: resp.ok, refreshed: false, status: resp.status, payload: resp.ok ? await resp.json() : null};
}`,
    args: ['https://api.wave2.test/me', 'https://auth.wave2.test/token', 'cli-7'],
    branches: [
      ['valid-token', {
        kv_get: [ok('tok_live_1')],
        'http.request': [httpResp(200, {user: 'ada'})],
      }],
      ['expired-refresh-ok', {
        kv_get: [ok('tok_old_0')],
        kv_set: [ok(true)],
        'http.request': [
          httpResp(401, {error: 'expired'}),
          httpResp(200, {access_token: 'tok_new_2'}),
          httpResp(200, {user: 'ada'}),
        ],
      }],
      ['refresh-denied', {
        kv_get: [ok('tok_old_0')],
        'http.request': [
          httpResp(401, {error: 'expired'}),
          httpResp(400, {error: 'invalid_grant'}),
        ],
      }],
    ],
  });

  // 17. etag-conditional-cache-fetch (3 branches)
  specs.push({
    slug: 'etag-conditional-cache-fetch',
    domain: 'http',
    features: ['http', 'http.request', 'native-bindings', 'json', 'branch'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(url, cacheKey) {
  const cached = await kv_get(cacheKey);
  const headers = {'Accept': 'application/json'};
  if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
  const resp = await fetch(url, {method: 'GET', headers});
  if (resp.status === 304 && cached) {
    return {source: 'not-modified', etag: cached.etag, data: cached.data};
  }
  if (!resp.ok) {
    return {source: 'error', status: resp.status, data: null};
  }
  const data = await resp.json();
  const etag = resp.headers.get('etag') || '';
  await kv_set(cacheKey, {etag, data});
  return {source: 'fetched', etag, data};
}`,
    args: ['https://cdn.wave2.test/catalog.json', 'cat:v1'],
    branches: [
      ['cache-304-hit', {
        kv_get: [ok({etag: '"e-100"', data: {items: 5}})],
        'http.request': [httpResp(304, '', {etag: '"e-100"'})],
      }],
      ['cache-200-updated', {
        kv_get: [ok({etag: '"e-100"', data: {items: 5}})],
        kv_set: [ok(true)],
        'http.request': [httpResp(200, {items: 8}, {etag: '"e-101"', 'content-type': 'application/json'})],
      }],
      ['cold-miss-fetch', {
        kv_get: [ok(null)],
        kv_set: [ok(true)],
        'http.request': [httpResp(200, {items: 8}, {etag: '"e-101"', 'content-type': 'application/json'})],
      }],
    ],
  });

  // 18. cursor-pagination-collector (2 branches)
  specs.push({
    slug: 'cursor-pagination-collector',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'json'],
    source: `async function run(baseUrl, maxPages) {
  let cursor = null;
  const items = [];
  let pages = 0;
  while (pages < maxPages) {
    const url = cursor ? baseUrl + '?cursor=' + encodeURIComponent(cursor) : baseUrl;
    const resp = await fetch(url, {method: 'GET', headers: {'Accept': 'application/json'}});
    if (!resp.ok) {
      return {ok: false, pages, items, status: resp.status};
    }
    const page = await resp.json();
    pages++;
    for (const row of page.items) items.push(row.id);
    if (!page.nextCursor) {
      return {ok: true, truncated: false, pages, items};
    }
    cursor = page.nextCursor;
  }
  return {ok: true, truncated: true, pages, items};
}`,
    args: ['https://api.wave2.test/events', 3],
    branches: [
      ['complete-two-pages', {'http.request': [
        httpResp(200, {items: [{id: 'e1'}, {id: 'e2'}], nextCursor: 'cur_2'}),
        httpResp(200, {items: [{id: 'e3'}], nextCursor: null}),
      ]}],
      ['truncated-at-cap', {'http.request': [
        httpResp(200, {items: [{id: 'e1'}], nextCursor: 'c2'}),
        httpResp(200, {items: [{id: 'e2'}], nextCursor: 'c3'}),
        httpResp(200, {items: [{id: 'e3'}], nextCursor: 'c4'}),
      ]}],
    ],
  });

  // 19. webhook-hmac-idempotency-send (2 branches)
  specs.push({
    slug: 'webhook-hmac-idempotency-send',
    domain: 'http',
    features: ['http', 'http.request', 'crypto', 'json', 'platform'],
    source: `async function run(endpoint, secret, eventObj) {
  const crypto = require('node:crypto');
  const body = JSON.stringify(eventObj);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const idemKey = 'idem-' + eventObj.id;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
      'X-Webhook-Signature': 'sha256=' + sig,
    },
    body,
  });
  if (resp.status === 409) {
    console.info('duplicate-ignored:' + idemKey);
    return {delivered: true, duplicate: true, status: 409};
  }
  const text = await resp.text();
  return {delivered: resp.ok, duplicate: false, status: resp.status, reply: text};
}`,
    args: ['https://hooks.wave2.test/v2', 'whsec_test', {id: 'evt_77', type: 'charge.ok'}],
    branches: [
      ['fresh-201', {'http.request': [httpResp(201, 'accepted', {'content-type': 'text/plain'})]}],
      ['duplicate-409', {'http.request': [httpResp(409, 'already processed', {'content-type': 'text/plain'})]}],
    ],
  });

  // 20. circuit-breaker-http-gateway (3 branches)
  specs.push({
    slug: 'circuit-breaker-http-gateway',
    domain: 'http',
    features: ['http', 'http.request', 'native-bindings', 'platform', 'exception'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(service, url, failThreshold, cooldownMs) {
  const now = Date.now();
  const state = (await kv_get('cb:' + service)) || {failures: 0, openUntil: 0};
  if (state.openUntil > now) {
    console.warn('circuit-open:' + service);
    return {ok: false, shortCircuited: true, remainingMs: state.openUntil - now};
  }
  try {
    const resp = await fetch(url, {method: 'GET'});
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    await kv_set('cb:' + service, {failures: 0, openUntil: 0});
    return {ok: true, shortCircuited: false, body: await resp.text()};
  } catch (err) {
    const failures = state.failures + 1;
    const openUntil = failures >= failThreshold ? now + cooldownMs : 0;
    await kv_set('cb:' + service, {failures, openUntil});
    console.error('cb-fail:' + service + ':' + failures);
    return {ok: false, shortCircuited: false, tripped: openUntil > 0, error: String(err.message || err)};
  }
}`,
    args: ['payments', 'https://pay.wave2.test/ping', 2, 30000],
    branches: [
      ['open-short-circuit', {'platform.dateNow': [100000], kv_get: [ok({failures: 2, openUntil: 120000})]}],
      ['half-open-recovers', {
        'platform.dateNow': [130000],
        kv_get: [ok({failures: 2, openUntil: 120000})],
        'http.request': [httpResp(200, 'pong', {'content-type': 'text/plain'})],
        kv_set: [ok(true)],
      }],
      ['trips-breaker-on-502', {
        'platform.dateNow': [100000],
        kv_get: [ok({failures: 1, openUntil: 0})],
        'http.request': [httpResp(502, 'bad gateway', {'content-type': 'text/plain'})],
        kv_set: [ok(true)],
      }],
    ],
  });

  // 21. batch-fanout-partial-failures (2 branches)
  specs.push({
    slug: 'batch-fanout-partial-failures',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'exception', 'json'],
    source: `async function run(baseUrl, ids) {
  const succeeded = [];
  const failed = [];
  for (const id of ids) {
    try {
      const resp = await fetch(baseUrl + '/' + id, {method: 'DELETE', headers: {'X-Reason': 'cleanup'}});
      if (resp.ok || resp.status === 404) {
        succeeded.push({id, status: resp.status});
      } else {
        failed.push({id, status: resp.status});
      }
    } catch (err) {
      failed.push({id, error: String(err.message || err)});
    }
  }
  return {allOk: failed.length === 0, succeeded, failed};
}`,
    args: ['https://api.wave2.test/sessions', ['s1', 's2', 's3']],
    branches: [
      ['all-cleared', {'http.request': [
        httpResp(204, ''),
        httpResp(404, 'gone'),
        httpResp(200, 'deleted'),
      ]}],
      ['partial-network-and-500', {'http.request': [
        httpResp(204, ''),
        fail({name: 'TypeError', message: 'ECONNRESET'}),
        httpResp(500, 'internal error'),
      ]}],
    ],
  });

  // 22. graphql-error-envelope-client (3 branches)
  specs.push({
    slug: 'graphql-error-envelope-client',
    domain: 'http',
    features: ['http', 'http.request', 'json', 'branch'],
    source: `async function run(endpoint, query, variables) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query, variables}),
  });
  if (!resp.ok) {
    return {ok: false, kind: 'http-error', status: resp.status};
  }
  const env = await resp.json();
  if (Array.isArray(env.errors) && env.errors.length > 0) {
    const codes = env.errors.map(e => e.extensions?.code || 'UNKNOWN');
    return {ok: false, kind: 'graphql-error', codes, partialData: env.data ?? null};
  }
  return {ok: true, kind: 'data', data: env.data};
}`,
    args: ['https://gql.wave2.test/graphql', 'query Q($id:ID!){node(id:$id){name}}', {id: 'n1'}],
    branches: [
      ['clean-data', {'http.request': [httpResp(200, {data: {node: {name: 'Alpha'}}})]}],
      ['graphql-errors', {'http.request': [httpResp(200, {data: null, errors: [{message: 'Denied', extensions: {code: 'FORBIDDEN'}}]})]}],
      ['http-502', {'http.request': [httpResp(502, 'bad gateway', {'content-type': 'text/plain'})]}],
    ],
  });

  // 23. presigned-upload-two-phase (2 branches, TypeScript)
  specs.push({
    slug: 'presigned-upload-two-phase',
    domain: 'http',
    language: 'ts',
    features: ['http', 'http.request', 'json', 'typescript'],
    source: `interface UploadOutcome { ok: boolean; stage: string; objectKey?: string; etag?: string; }
async function run(apiBase: string, filename: string, content: string): Promise<UploadOutcome> {
  const initResp = await fetch(apiBase + '/uploads/init', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({filename, bytes: content.length}),
  });
  if (!initResp.ok) return {ok: false, stage: 'init'};
  const {uploadUrl, objectKey} = await initResp.json();
  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {'Content-Type': 'text/plain'},
    body: content,
  });
  if (!putResp.ok) return {ok: false, stage: 'put', objectKey};
  const etag = putResp.headers.get('etag') || '';
  const doneResp = await fetch(apiBase + '/uploads/complete', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({objectKey, etag}),
  });
  return {ok: doneResp.ok, stage: 'complete', objectKey, etag};
}`,
    args: ['https://files.wave2.test', 'notes.txt', 'hello world'],
    branches: [
      ['three-step-ok', {'http.request': [
        httpResp(200, {uploadUrl: 'https://s3.wave2.test/put/k1', objectKey: 'k1'}),
        httpResp(200, '', {etag: '"abc123"'}),
        httpResp(200, {stored: true}),
      ]}],
      ['s3-put-fails', {'http.request': [
        httpResp(200, {uploadUrl: 'https://s3.wave2.test/put/k1', objectKey: 'k1'}),
        httpResp(403, 'SignatureDoesNotMatch', {'content-type': 'text/plain'}),
      ]}],
    ],
  });

  // 24. multi-region-failover-get (3 branches)
  specs.push({
    slug: 'multi-region-failover-get',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'exception', 'platform'],
    source: `async function run(regions, path) {
  const tried = [];
  for (const reg of regions) {
    const url = 'https://' + reg + '.api.wave2.test' + path;
    tried.push(reg);
    try {
      const resp = await fetch(url, {method: 'GET', headers: {'X-Region': reg}});
      if (resp.ok) {
        return {ok: true, region: reg, tried, payload: await resp.json()};
      }
      console.warn('region-unhealthy:' + reg + ':' + resp.status);
    } catch (err) {
      console.warn('region-err:' + reg + ':' + String(err.message || err));
    }
  }
  return {ok: false, region: null, tried, payload: null};
}`,
    args: [['us-east', 'eu-west', 'ap-south'], '/v1/status'],
    branches: [
      ['primary-ok', {'http.request': [httpResp(200, {healthy: true})]}],
      ['secondary-failover', {'http.request': [fail({name: 'TypeError', message: 'timeout'}), httpResp(200, {healthy: true})]}],
      ['all-regions-down', {'http.request': [httpResp(503, 'err'), fail({name: 'TypeError', message: 'dns'}), httpResp(500, 'err')]}],
    ],
  });

  // 25. api-version-negotiation (2 branches)
  specs.push({
    slug: 'api-version-negotiation',
    domain: 'http',
    features: ['http', 'http.request', 'json', 'branch'],
    source: `async function run(baseUrl, resourceId) {
  const v2 = await fetch(baseUrl + '/v2/items/' + resourceId, {method: 'GET'});
  if (v2.ok) {
    const data = await v2.json();
    return {version: 'v2', name: data.displayName, tags: data.tags};
  }
  if (v2.status === 404 || v2.status === 501) {
    const v1 = await fetch(baseUrl + '/v1/items/' + resourceId, {method: 'GET'});
    if (v1.ok) {
      const legacy = await v1.json();
      return {version: 'v1', name: legacy.title, tags: legacy.labels || []};
    }
    return {version: 'none', status: v1.status};
  }
  return {version: 'error', status: v2.status};
}`,
    args: ['https://svc.wave2.test', 'item-42'],
    branches: [
      ['v2-supported', {'http.request': [httpResp(200, {displayName: 'Widget', tags: ['pro']})]}],
      ['v1-fallback', {'http.request': [httpResp(501, 'not implemented'), httpResp(200, {title: 'Legacy Widget', labels: ['old']})]}],
    ],
  });

  // 26. polling-async-job-status (3 branches)
  specs.push({
    slug: 'polling-async-job-status',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'platform', 'json'],
    source: `async function run(submitUrl, payload, maxPolls) {
  const sub = await fetch(submitUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (sub.status !== 202) return {ok: false, stage: 'submit', status: sub.status};
  const {jobId, statusUrl} = await sub.json();
  for (let i = 1; i <= maxPolls; i++) {
    const st = await fetch(statusUrl, {method: 'GET'});
    const body = await st.json();
    if (body.state === 'done') return {ok: true, jobId, polls: i, output: body.output};
    if (body.state === 'failed') return {ok: false, jobId, polls: i, error: body.error};
    console.info('poll-pending:' + jobId + ':' + i);
  }
  return {ok: false, jobId, polls: maxPolls, error: 'timeout'};
}`,
    args: ['https://jobs.wave2.test/submit', {task: 'export'}, 3],
    branches: [
      ['done-second-poll', {'http.request': [
        httpResp(202, {jobId: 'j9', statusUrl: 'https://jobs.wave2.test/status/j9'}),
        httpResp(200, {state: 'running'}),
        httpResp(200, {state: 'done', output: 's3://bucket/j9.csv'}),
      ]}],
      ['job-failed', {'http.request': [
        httpResp(202, {jobId: 'j9', statusUrl: 'https://jobs.wave2.test/status/j9'}),
        httpResp(200, {state: 'failed', error: 'oom'}),
      ]}],
      ['poll-timeout', {'http.request': [
        httpResp(202, {jobId: 'j9', statusUrl: 'https://jobs.wave2.test/status/j9'}),
        httpResp(200, {state: 'queued'}),
        httpResp(200, {state: 'running'}),
        httpResp(200, {state: 'running'}),
      ]}],
    ],
  });

  // 27. health-quorum-aggregator (2 branches)
  specs.push({
    slug: 'health-quorum-aggregator',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'exception'],
    source: `async function run(nodes, minHealthy) {
  let healthy = 0;
  const report = [];
  for (const node of nodes) {
    try {
      const resp = await fetch('https://' + node + '/healthz', {method: 'GET'});
      const up = resp.status === 200;
      if (up) healthy++;
      report.push({node, up, code: resp.status});
    } catch (err) {
      report.push({node, up: false, error: String(err.message || err)});
    }
  }
  return {quorum: healthy >= minHealthy, healthy, total: nodes.length, report};
}`,
    args: [['n1.wave2.test', 'n2.wave2.test', 'n3.wave2.test'], 2],
    branches: [
      ['quorum-met', {'http.request': [httpResp(200, 'ok'), httpResp(503, 'starting'), httpResp(200, 'ok')]}],
      ['quorum-lost', {'http.request': [httpResp(200, 'ok'), fail({name: 'TypeError', message: 'refused'}), httpResp(500, 'err')]}],
    ],
  });

  // 28. redirect-hop-tracer (2 branches)
  specs.push({
    slug: 'redirect-hop-tracer',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'branch'],
    source: `async function run(startUrl, maxHops) {
  let current = startUrl;
  const visited = [current];
  for (let hop = 0; hop < maxHops; hop++) {
    const resp = await fetch(current, {method: 'HEAD'});
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return {ok: false, reason: 'missing-location', visited};
      if (visited.includes(loc)) return {ok: false, reason: 'redirect-loop', visited};
      visited.push(loc);
      current = loc;
      continue;
    }
    return {ok: resp.ok, finalUrl: current, status: resp.status, hops: visited.length - 1};
  }
  return {ok: false, reason: 'max-hops', visited};
}`,
    args: ['https://short.wave2.test/go', 3],
    branches: [
      ['resolved-two-hops', {'http.request': [
        httpResp(301, '', {location: 'https://mid.wave2.test/r'}),
        httpResp(302, '', {location: 'https://dest.wave2.test/home'}),
        httpResp(200, ''),
      ]}],
      ['loop-detected', {'http.request': [
        httpResp(302, '', {location: 'https://mid.wave2.test/r'}),
        httpResp(302, '', {location: 'https://short.wave2.test/go'}),
      ]}],
    ],
  });

  // 29. host-http-get-json-enricher (2 branches)
  specs.push({
    slug: 'host-http-get-json-enricher',
    domain: 'http',
    features: ['http', 'http.get', 'json', 'exception', 'platform'],
    source: `async function run(userId, apiBase) {
  const userRaw = await host.httpGet(apiBase + '/users/' + userId);
  const user = JSON.parse(userRaw);
  let perms = [];
  try {
    const permRaw = await host.httpGet(apiBase + '/roles/' + user.role);
    perms = JSON.parse(permRaw).permissions;
  } catch (err) {
    console.warn('role-fallback:' + user.role + ':' + String(err));
    perms = ['read:self'];
  }
  return {id: userId, name: user.name, role: user.role, perms};
}`,
    args: ['u42', 'https://iam.wave2.test'],
    branches: [
      ['role-enriched', {'http.get': [ok('{"name":"Lin","role":"admin"}'), ok('{"permissions":["read","write","admin"]}')]}],
      ['role-service-error', {'http.get': [ok('{"name":"Lin","role":"ops"}'), fail('503-unavailable')]}],
    ],
  });

  // 30. optimistic-lock-put-conflict (2 branches)
  specs.push({
    slug: 'optimistic-lock-put-conflict',
    domain: 'http',
    features: ['http', 'http.request', 'json', 'platform'],
    source: `async function run(url, delta) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const getResp = await fetch(url, {method: 'GET'});
    const etag = getResp.headers.get('etag') || '';
    const doc = await getResp.json();
    const updated = {count: doc.count + delta};
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'If-Match': etag},
      body: JSON.stringify(updated),
    });
    if (putResp.ok) {
      return {ok: true, attempts: attempt, count: updated.count};
    }
    if (putResp.status !== 412) {
      return {ok: false, attempts: attempt, status: putResp.status};
    }
    console.warn('etag-conflict:attempt=' + attempt);
  }
  return {ok: false, attempts: 2, status: 412};
}`,
    args: ['https://doc.wave2.test/counter/1', 5],
    branches: [
      ['first-put-ok', {'http.request': [
        httpResp(200, {count: 10}, {etag: '"v1"'}),
        httpResp(200, {count: 15}, {etag: '"v2"'}),
      ]}],
      ['conflict-then-retry-ok', {'http.request': [
        httpResp(200, {count: 10}, {etag: '"v1"'}),
        httpResp(412, 'precondition failed'),
        httpResp(200, {count: 12}, {etag: '"v2"'}),
        httpResp(200, {count: 17}, {etag: '"v3"'}),
      ]}],
    ],
  });

  // 31. webhook-dlq-fallback (2 branches)
  specs.push({
    slug: 'webhook-dlq-fallback',
    domain: 'http',
    features: ['http', 'http.request', 'native-bindings', 'json', 'platform'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(targetUrl, eventId, payload) {
  const resp = await fetch(targetUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Event-Id': eventId},
    body: JSON.stringify(payload),
  });
  if (resp.ok) {
    return {status: 'delivered', eventId, httpStatus: resp.status};
  }
  const dlqKey = 'dlq:' + eventId;
  await kv_set(dlqKey, {url: targetUrl, status: resp.status, payload});
  console.error('queued-dlq:' + eventId + ':' + resp.status);
  return {status: 'dlq', eventId, httpStatus: resp.status, dlqKey};
}`,
    args: ['https://partner.wave2.test/hook', 'ev-501', {order: 99}],
    branches: [
      ['delivered-200', {'http.request': [httpResp(200, {ok: true})]}],
      ['failed-500-dlq', {'http.request': [httpResp(500, 'boom')], kv_set: [ok(true)]}],
    ],
  });

  // 32. rate-limit-header-budget-client (2 branches)
  specs.push({
    slug: 'rate-limit-header-budget-client',
    domain: 'http',
    features: ['http', 'http.request', 'loop', 'json', 'platform'],
    source: `async function run(baseUrl, keys, reserveFloor) {
  const fetched = {};
  const skipped = [];
  let remaining = Infinity;
  for (const key of keys) {
    if (remaining <= reserveFloor) {
      skipped.push(key);
      continue;
    }
    const resp = await fetch(baseUrl + '/' + key, {method: 'GET'});
    const hdr = resp.headers.get('x-ratelimit-remaining');
    if (hdr !== null) remaining = Number(hdr);
    if (resp.ok) fetched[key] = await resp.json();
    else skipped.push(key);
  }
  return {fetched, skipped, remaining};
}`,
    args: ['https://quota.wave2.test/items', ['k1', 'k2', 'k3'], 1],
    branches: [
      ['plenty-quota', {'http.request': [
        httpResp(200, {v: 1}, {'x-ratelimit-remaining': '10'}),
        httpResp(200, {v: 2}, {'x-ratelimit-remaining': '9'}),
        httpResp(200, {v: 3}, {'x-ratelimit-remaining': '8'}),
      ]}],
      ['hit-reserve-floor', {'http.request': [
        httpResp(200, {v: 1}, {'x-ratelimit-remaining': '2'}),
        httpResp(200, {v: 2}, {'x-ratelimit-remaining': '1'}),
      ]}],
    ],
  });

  // 33. signed-url-json-download-verify (2 branches)
  specs.push({
    slug: 'signed-url-json-download-verify',
    domain: 'http',
    features: ['http', 'http.request', 'crypto', 'json'],
    source: `async function run(url, expectedSha256) {
  const crypto = require('node:crypto');
  const resp = await fetch(url, {method: 'GET'});
  if (!resp.ok) return {ok: false, reason: 'http-' + resp.status};
  const raw = await resp.text();
  const actual = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  if (actual !== expectedSha256) {
    console.error('checksum-mismatch:' + actual.slice(0, 8));
    return {ok: false, reason: 'checksum-mismatch', actual: actual.slice(0, 12)};
  }
  return {ok: true, data: JSON.parse(raw), sha: actual.slice(0, 12)};
}`,
    args: ['https://cdn.wave2.test/manifest.json', sha256('{"release":"2.1"}')],
    branches: [
      ['verified-match', {'http.request': [httpResp(200, '{"release":"2.1"}')]}],
      ['tampered-body', {'http.request': [httpResp(200, '{"release":"9.9"}')]}],
    ],
  });

  // 34. service-discovery-post-route (3 branches)
  specs.push({
    slug: 'service-discovery-post-route',
    domain: 'http',
    features: ['http', 'http.request', 'json', 'branch'],
    source: `async function run(registryUrl, serviceName, bodyObj) {
  const reg = await fetch(registryUrl + '/services/' + serviceName, {method: 'GET'});
  if (!reg.ok) return {ok: false, stage: 'discovery', status: reg.status};
  const {endpoints} = await reg.json();
  const active = endpoints.find(e => e.healthy);
  if (!active) return {ok: false, stage: 'no-healthy-endpoint'};
  const post = await fetch(active.url + '/ingest', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(bodyObj),
  });
  return {ok: post.ok, stage: 'dispatch', target: active.url, status: post.status};
}`,
    args: ['https://consul.wave2.test', 'indexer', {doc: 7}],
    branches: [
      ['routed-to-healthy', {'http.request': [
        httpResp(200, {endpoints: [{url: 'https://i1.wave2.test', healthy: false}, {url: 'https://i2.wave2.test', healthy: true}]}),
        httpResp(202, {queued: true}),
      ]}],
      ['no-healthy-nodes', {'http.request': [
        httpResp(200, {endpoints: [{url: 'https://i1.wave2.test', healthy: false}]}),
      ]}],
      ['registry-404', {'http.request': [httpResp(404, {error: 'unknown'})]}],
    ],
  });

  // =========================================================================
  // GROUP 3: FS.* (16 families, 38 tasks)
  // =========================================================================

  // 35. atomic-config-temp-commit (2 branches)
  specs.push({
    slug: 'atomic-config-temp-commit',
    domain: 'fs',
    features: ['fs', 'fs.exists', 'fs.readText', 'fs.writeText', 'json'],
    source: `function run(configPath, patch) {
  const fs = require('node:fs');
  let base = {};
  if (fs.existsSync(configPath)) {
    base = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const merged = {...base, ...patch};
  const serialized = JSON.stringify(merged, null, 2);
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  const check = fs.readFileSync(tmpPath, 'utf8');
  if (check !== serialized) {
    return {ok: false, reason: 'verify-mismatch'};
  }
  fs.writeFileSync(configPath, serialized, 'utf8');
  return {ok: true, hadExisting: Object.keys(base).length > 0, keys: Object.keys(merged).sort()};
}`,
    args: ['/etc/app/settings.json', {logLevel: 'debug', workers: 4}],
    branches: [
      ['merge-existing', {
        'fs.exists': [ok(true)],
        'fs.readText': [
          ok('{"workers":2,"host":"0.0.0.0"}'),
          ok(JSON.stringify({workers: 4, host: '0.0.0.0', logLevel: 'debug'}, null, 2)),
        ],
        'fs.writeText': [ok(undefined), ok(undefined)],
      }],
      ['create-fresh', {
        'fs.exists': [ok(false)],
        'fs.writeText': [ok(undefined), ok(undefined)],
        'fs.readText': [ok(JSON.stringify({logLevel: 'debug', workers: 4}, null, 2))],
      }],
    ],
  });

  // 36. config-cascade-override (3 branches)
  specs.push({
    slug: 'config-cascade-override',
    domain: 'fs',
    features: ['fs', 'fs.exists', 'fs.readText', 'fs.writeText', 'loop', 'json'],
    source: `function run(paths, outPath) {
  const fs = require('node:fs');
  const loaded = [];
  let merged = {timeout: 30, retries: 1};
  for (const p of paths) {
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      merged = {...merged, ...obj};
      loaded.push(p);
    }
  }
  if (loaded.length > 0) {
    fs.writeFileSync(outPath, JSON.stringify(merged), 'utf8');
  }
  return {loaded, merged, wrote: loaded.length > 0};
}`,
    args: [['/etc/svc/base.json', '/etc/svc/prod.json', '/etc/svc/local.json'], '/var/run/svc.effective.json'],
    branches: [
      ['base-and-prod', {
        'fs.exists': [ok(true), ok(true), ok(false)],
        'fs.readText': [ok('{"timeout":60,"region":"us"}'), ok('{"retries":5}')],
        'fs.writeText': [ok(undefined)],
      }],
      ['none-present', {
        'fs.exists': [ok(false), ok(false), ok(false)],
      }],
      ['local-only', {
        'fs.exists': [ok(false), ok(false), ok(true)],
        'fs.readText': [ok('{"timeout":5,"debug":true}')],
        'fs.writeText': [ok(undefined)],
      }],
    ],
  });

  // 37. dir-scan-json-aggregator (2 branches)
  specs.push({
    slug: 'dir-scan-json-aggregator',
    domain: 'fs',
    features: ['fs', 'fs.readdir', 'fs.stat', 'fs.readText', 'loop', 'json'],
    source: `function run(dirPath, maxBytes) {
  const fs = require('node:fs');
  const entries = fs.readdirSync(dirPath).sort();
  let total = 0;
  const parsed = [];
  const skipped = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = dirPath + '/' + name;
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > maxBytes) {
      skipped.push(name);
      continue;
    }
    const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
    total += obj.amount || 0;
    parsed.push(name);
  }
  return {parsed, skipped, total};
}`,
    args: ['/data/invoices', 4096],
    branches: [
      ['all-valid-files', {
        'fs.readdir': [ok(['README.md', 'inv2.json', 'inv1.json'])],
        'fs.stat': [ok({isFile: true, isDirectory: false, size: 120}), ok({isFile: true, isDirectory: false, size: 240})],
        'fs.readText': [ok('{"amount":150}'), ok('{"amount":275}')],
      }],
      ['oversized-and-subdir-skipped', {
        'fs.readdir': [ok(['big.json', 'dir.json', 'ok.json'])],
        'fs.stat': [
          ok({isFile: true, isDirectory: false, size: 9000}),
          ok({isFile: false, isDirectory: true, size: 0}),
          ok({isFile: true, isDirectory: false, size: 80}),
        ],
        'fs.readText': [ok('{"amount":50}')],
      }],
    ],
  });

  // 38. lockfile-acquire-stale-takeover (3 branches)
  specs.push({
    slug: 'lockfile-acquire-stale-takeover',
    domain: 'fs',
    features: ['fs', 'fs.exists', 'fs.readText', 'fs.writeText', 'platform', 'json'],
    source: `function run(lockPath, ownerId, ttlMs) {
  const fs = require('node:fs');
  const now = Date.now();
  if (fs.existsSync(lockPath)) {
    const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (cur.owner !== ownerId && now < cur.expiresAt) {
      console.warn('lock-busy:' + cur.owner);
      return {acquired: false, holder: cur.owner, staleTaken: false};
    }
    const next = {owner: ownerId, expiresAt: now + ttlMs};
    fs.writeFileSync(lockPath, JSON.stringify(next), 'utf8');
    return {acquired: true, holder: ownerId, staleTaken: cur.owner !== ownerId};
  }
  fs.writeFileSync(lockPath, JSON.stringify({owner: ownerId, expiresAt: now + ttlMs}), 'utf8');
  return {acquired: true, holder: ownerId, staleTaken: false};
}`,
    args: ['/var/lock/cron.lock', 'worker-b', 60000],
    branches: [
      ['fresh-acquire', {'platform.dateNow': [500000], 'fs.exists': [ok(false)], 'fs.writeText': [ok(undefined)]}],
      ['held-by-other', {'platform.dateNow': [500000], 'fs.exists': [ok(true)], 'fs.readText': [ok('{"owner":"worker-a","expiresAt":550000}')]}],
      ['stale-takeover', {'platform.dateNow': [600000], 'fs.exists': [ok(true)], 'fs.readText': [ok('{"owner":"worker-a","expiresAt":550000}')], 'fs.writeText': [ok(undefined)]}],
    ],
  });

  // 39. log-rotation-size-threshold (2 branches)
  specs.push({
    slug: 'log-rotation-size-threshold',
    domain: 'fs',
    features: ['fs', 'fs.stat', 'fs.readText', 'fs.writeText', 'platform'],
    source: `function run(logPath, maxBytes) {
  const fs = require('node:fs');
  const st = fs.statSync(logPath);
  if (st.size < maxBytes) {
    return {rotated: false, size: st.size};
  }
  const ts = Date.now();
  const content = fs.readFileSync(logPath, 'utf8');
  const archivePath = logPath + '.' + ts;
  fs.writeFileSync(archivePath, content, 'utf8');
  fs.writeFileSync(logPath, '', 'utf8');
  console.info('rotated:' + archivePath);
  return {rotated: true, size: st.size, archivePath};
}`,
    args: ['/var/log/app.log', 10000],
    branches: [
      ['below-limit', {'fs.stat': [ok({isFile: true, isDirectory: false, size: 4200})]}],
      ['rotate-and-truncate', {
        'fs.stat': [ok({isFile: true, isDirectory: false, size: 15400})],
        'platform.dateNow': [1700009000],
        'fs.readText': [ok('line1\nline2\n')],
        'fs.writeText': [ok(undefined), ok(undefined)],
      }],
    ],
  });

  // 40. migration-script-rollback-on-error (2 branches)
  specs.push({
    slug: 'migration-script-rollback-on-error',
    domain: 'fs',
    features: ['fs', 'fs.readText', 'fs.writeText', 'json', 'exception', 'platform'],
    source: `async function run(dbFile, patchFile) {
  const fsp = require('node:fs/promises');
  const backup = await fsp.readFile(dbFile, 'utf8');
  const db = JSON.parse(backup);
  try {
    const patchRaw = await fsp.readFile(patchFile, 'utf8');
    const patch = JSON.parse(patchRaw);
    if (!Array.isArray(patch.ops)) throw new Error('missing ops array');
    for (const op of patch.ops) {
      if (op.type === 'set') db[op.key] = op.value;
      else if (op.type === 'del') delete db[op.key];
      else throw new Error('unknown op:' + op.type);
    }
    await fsp.writeFile(dbFile, JSON.stringify(db), 'utf8');
    return {committed: true, rolledBack: false, keys: Object.keys(db).sort()};
  } catch (err) {
    console.error('rollback:' + String(err.message || err));
    await fsp.writeFile(dbFile, backup, 'utf8');
    return {committed: false, rolledBack: true, error: String(err.message || err)};
  }
}`,
    args: ['/data/state.json', '/data/patch.json'],
    branches: [
      ['commit-migration', {
        'fs.readText': [ok('{"a":1,"b":2}'), ok('{"ops":[{"type":"set","key":"c","value":3},{"type":"del","key":"b"}]}')],
        'fs.writeText': [ok(undefined)],
      }],
      ['invalid-op-rollback', {
        'fs.readText': [ok('{"a":1,"b":2}'), ok('{"ops":[{"type":"drop","key":"a"}]}')],
        'fs.writeText': [ok(undefined)],
      }],
    ],
  });

  // 41. dotenv-file-loader-with-defaults (2 branches)
  specs.push({
    slug: 'dotenv-file-loader-with-defaults',
    domain: 'fs',
    features: ['fs', 'fs.exists', 'fs.readText', 'loop', 'branch'],
    source: `function run(envPath, defaults) {
  const fs = require('node:fs');
  const result = {...defaults};
  if (!fs.existsSync(envPath)) {
    return {found: false, count: 0, config: result};
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\\n');
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    result[k] = v;
    count++;
  }
  return {found: true, count, config: result};
}`,
    args: ['/app/.env', {PORT: '3000', HOST: '127.0.0.1'}],
    branches: [
      ['dotenv-present', {'fs.exists': [ok(true)], 'fs.readText': [ok('# app cfg\nPORT=8080\nMODE=prod\n')]}],
      ['dotenv-missing', {'fs.exists': [ok(false)]}],
    ],
  });

  // 42. binary-magic-header-validator (3 branches)
  specs.push({
    slug: 'binary-magic-header-validator',
    domain: 'fs',
    features: ['fs', 'fs.readBytes', 'typedarray', 'branch'],
    source: `function run(filePath) {
  const fs = require('node:fs');
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {format: 'png', bytes: buf.length, valid: true};
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return {format: 'gzip', bytes: buf.length, valid: true};
  }
  return {format: 'unknown', bytes: buf.length, valid: false};
}`,
    args: ['/uploads/blob.bin'],
    branches: [
      ['png-header', {'fs.readBytes': [ok(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))]}],
      ['gzip-header', {'fs.readBytes': [ok(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))]}],
      ['unknown-bytes', {'fs.readBytes': [ok(new Uint8Array([0x41, 0x42, 0x43]))]}],
    ],
  });

  // 43. package-json-dep-auditor (2 branches, TypeScript)
  specs.push({
    slug: 'package-json-dep-auditor',
    domain: 'fs',
    language: 'ts',
    features: ['fs', 'fs.readText', 'fs.writeText', 'json', 'typescript'],
    source: `declare function require(id: string): any;
interface AuditReport { bannedFound: string[]; cleaned: boolean; }
function run(pkgPath: string, banned: string[], autoStrip: boolean): AuditReport {
  const fs = require('node:fs');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = pkg.dependencies || {};
  const bannedFound = banned.filter((b: string) => Object.hasOwn(deps, b)).sort();
  if (bannedFound.length > 0 && autoStrip) {
    for (const b of bannedFound) delete deps[b];
    fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');
    return {bannedFound, cleaned: true};
  }
  return {bannedFound, cleaned: false};
}`,
    args: ['/workspace/package.json', ['left-pad', 'event-stream'], true],
    branches: [
      ['clean-pkg', {'fs.readText': [ok('{"name":"demo","dependencies":{"lodash":"4.17.21"}}')]}],
      ['stripped-banned', {'fs.readText': [ok('{"name":"demo","dependencies":{"lodash":"4.17.21","left-pad":"1.3.0"}}')], 'fs.writeText': [ok(undefined)]}],
    ],
  });

  // 44. csv-ledger-reconcile-report (2 branches)
  specs.push({
    slug: 'csv-ledger-reconcile-report',
    domain: 'fs',
    features: ['fs', 'fs.readText', 'fs.writeText', 'loop', 'json'],
    source: `function run(inCsv, reportPath) {
  const fs = require('node:fs');
  const lines = fs.readFileSync(inCsv, 'utf8').trim().split('\\n');
  let credits = 0, debits = 0, malformed = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length !== 3) { malformed++; continue; }
    const amt = Number(parts[2]);
    if (!Number.isFinite(amt)) { malformed++; continue; }
    if (parts[1] === 'CR') credits += amt;
    else if (parts[1] === 'DR') debits += amt;
    else malformed++;
  }
  const summary = {credits, debits, net: credits - debits, malformed};
  if (malformed === 0) {
    fs.writeFileSync(reportPath, JSON.stringify(summary), 'utf8');
  }
  return {summary, wroteReport: malformed === 0};
}`,
    args: ['/data/ledger.csv', '/data/summary.json'],
    branches: [
      ['clean-ledger', {'fs.readText': [ok('id,type,amt\n1,CR,200\n2,DR,75\n3,CR,50\n')], 'fs.writeText': [ok(undefined)]}],
      ['malformed-skips-write', {'fs.readText': [ok('id,type,amt\n1,CR,200\n2,BAD,99\n')]}],
    ],
  });

  // 45. dir-manifest-checksum-index (2 branches)
  specs.push({
    slug: 'dir-manifest-checksum-index',
    domain: 'fs',
    features: ['fs', 'fs.readdir', 'fs.readText', 'fs.writeText', 'crypto', 'json'],
    source: `function run(dirPath, manifestPath) {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt')).sort();
  if (files.length === 0) {
    return {indexed: 0, manifest: {}};
  }
  const manifest = {};
  for (const f of files) {
    const body = fs.readFileSync(dirPath + '/' + f, 'utf8');
    manifest[f] = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  return {indexed: files.length, manifest};
}`,
    args: ['/assets/docs', '/assets/manifest.json'],
    branches: [
      ['two-txt-files', {
        'fs.readdir': [ok(['b.txt', 'a.txt', 'logo.png'])],
        'fs.readText': [ok('alpha'), ok('beta')],
        'fs.writeText': [ok(undefined)],
      }],
      ['no-txt-files', {'fs.readdir': [ok(['logo.png', 'icon.svg'])]}],
    ],
  });

  // 46. enoent-fallback-seed-file (2 branches)
  specs.push({
    slug: 'enoent-fallback-seed-file',
    domain: 'fs',
    features: ['fs', 'fs.readText', 'fs.writeText', 'exception', 'json'],
    source: `function run(path, seedData) {
  const fs = require('node:fs');
  try {
    const raw = fs.readFileSync(path, 'utf8');
    return {created: false, data: JSON.parse(raw)};
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.writeFileSync(path, JSON.stringify(seedData), 'utf8');
    return {created: true, data: seedData};
  }
}`,
    args: ['/var/state/cursor.json', {offset: 0, epoch: 1}],
    branches: [
      ['existing-file', {'fs.readText': [ok('{"offset":42,"epoch":3}')]}],
      ['enoent-creates-seed', {'fs.readText': [fail({name: 'Error', message: 'ENOENT: no such file or directory'})], 'fs.writeText': [ok(undefined)]}],
    ],
  });

  // 47. async-fs-template-render (2 branches)
  specs.push({
    slug: 'async-fs-template-render',
    domain: 'fs',
    features: ['fs', 'fs.readText', 'fs.writeText', 'regexp'],
    source: `async function run(tplPath, vars, outPath) {
  const fsp = require('node:fs/promises');
  const tpl = await fsp.readFile(tplPath, 'utf8');
  const missing = [];
  const rendered = tpl.replace(/\\{\\{([a-zA-Z0-9_]+)\\}\\}/g, (_, k) => {
    if (Object.hasOwn(vars, k)) return String(vars[k]);
    missing.push(k);
    return '{{' + k + '}}';
  });
  if (missing.length > 0) {
    return {ok: false, missing, wrote: false};
  }
  await fsp.writeFile(outPath, rendered, 'utf8');
  return {ok: true, missing: [], wrote: true, rendered};
}`,
    args: ['/tpl/nginx.conf.tpl', {HOST: 'api.local', PORT: 8080}, '/etc/nginx/api.conf'],
    branches: [
      ['all-vars-bound', {'fs.readText': [ok('server {{HOST}}:{{PORT}};')], 'fs.writeText': [ok(undefined)]}],
      ['missing-var-aborts', {'fs.readText': [ok('server {{HOST}}:{{PORT}} ssl={{CERT}};')]}],
    ],
  });

  // 48. quota-dir-size-enforcer (3 branches)
  specs.push({
    slug: 'quota-dir-size-enforcer',
    domain: 'fs',
    features: ['fs', 'fs.readdir', 'fs.stat', 'platform', 'loop'],
    source: `function run(dirPath, softCap, hardCap) {
  const fs = require('node:fs');
  const names = fs.readdirSync(dirPath).sort();
  let totalBytes = 0;
  let files = 0;
  for (const name of names) {
    const st = fs.statSync(dirPath + '/' + name);
    if (st.isFile()) {
      files++;
      totalBytes += st.size;
    }
  }
  if (totalBytes > hardCap) {
    console.error('hard-quota-exceeded:' + totalBytes);
    return {status: 'blocked', files, totalBytes};
  }
  if (totalBytes > softCap) {
    console.warn('soft-quota-exceeded:' + totalBytes);
    return {status: 'warn', files, totalBytes};
  }
  return {status: 'ok', files, totalBytes};
}`,
    args: ['/home/uploads', 1000, 2000],
    branches: [
      ['under-soft', {'fs.readdir': [ok(['a.dat', 'b.dat'])], 'fs.stat': [ok({isFile: true, isDirectory: false, size: 300}), ok({isFile: true, isDirectory: false, size: 400})]}],
      ['between-soft-hard', {'fs.readdir': [ok(['a.dat', 'b.dat'])], 'fs.stat': [ok({isFile: true, isDirectory: false, size: 900}), ok({isFile: true, isDirectory: false, size: 600})]}],
      ['over-hard', {'fs.readdir': [ok(['huge.dat'])], 'fs.stat': [ok({isFile: true, isDirectory: false, size: 2500})]}],
    ],
  });

  // 49. ndjson-checkpoint-tailer (2 branches)
  specs.push({
    slug: 'ndjson-checkpoint-tailer',
    domain: 'fs',
    features: ['fs', 'fs.readText', 'fs.writeText', 'json', 'loop'],
    source: `async function run(logPath, cursorPath) {
  let offset = 0;
  try {
    offset = Number(await host.readText(cursorPath)) || 0;
  } catch (_err) {
    offset = 0;
  }
  const lines = (await host.readText(logPath)).split('\\n').filter(Boolean);
  const batch = lines.slice(offset).map(l => JSON.parse(l));
  if (batch.length > 0) {
    await host.writeText(cursorPath, String(lines.length));
  }
  return {startOffset: offset, newOffset: lines.length, processed: batch.length, events: batch.map(e => e.id)};
}`,
    args: ['/var/log/events.ndjson', '/var/log/events.cursor'],
    branches: [
      ['advance-cursor', {
        'fs.readText': [ok('1'), ok('{"id":"e1"}\n{"id":"e2"}\n{"id":"e3"}\n')],
        'fs.writeText': [ok(undefined)],
      }],
      ['already-caught-up', {
        'fs.readText': [ok('2'), ok('{"id":"e1"}\n{"id":"e2"}\n')],
      }],
    ],
  });

  // 50. secret-file-permission-and-json-check (2 branches)
  specs.push({
    slug: 'secret-file-permission-and-json-check',
    domain: 'fs',
    features: ['fs', 'fs.exists', 'fs.stat', 'fs.readText', 'json', 'platform'],
    source: `function run(credPath) {
  const fs = require('node:fs');
  if (!fs.existsSync(credPath)) {
    console.error('missing-cred:' + credPath);
    return {ok: false, reason: 'missing'};
  }
  const st = fs.statSync(credPath);
  if (!st.isFile() || st.size === 0) {
    return {ok: false, reason: 'empty-or-dir'};
  }
  const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  if (!creds.clientId || !creds.clientSecret) {
    return {ok: false, reason: 'incomplete-fields'};
  }
  return {ok: true, clientId: creds.clientId, secretLen: creds.clientSecret.length};
}`,
    args: ['/etc/secrets/oauth.json'],
    branches: [
      ['valid-creds', {'fs.exists': [ok(true)], 'fs.stat': [ok({isFile: true, isDirectory: false, size: 64})], 'fs.readText': [ok('{"clientId":"cid-9","clientSecret":"topsecret"}')]}],
      ['missing-creds', {'fs.exists': [ok(false)]}],
    ],
  });

  // =========================================================================
  // GROUP 4: KV + ENV + PLATFORM + RANDOM + UUID + MULTI-SERVICE (16 families, 38 tasks)
  // =========================================================================

  // 51. ttl-cache-fresh-stale-cold (3 branches)
  specs.push({
    slug: 'ttl-cache-fresh-stale-cold',
    domain: 'kv-platform',
    features: ['native-bindings', 'http', 'http.request', 'platform', 'json'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(key, originUrl, ttlMs) {
  const now = Date.now();
  const cached = await kv_get(key);
  if (cached && now < cached.exp) {
    return {state: 'fresh-hit', value: cached.value};
  }
  const resp = await fetch(originUrl, {method: 'GET'});
  if (resp.ok) {
    const value = await resp.json();
    await kv_set(key, {value, exp: now + ttlMs});
    return {state: cached ? 'stale-refreshed' : 'cold-filled', value};
  }
  if (cached) {
    console.warn('serving-stale:' + key);
    return {state: 'stale-fallback', value: cached.value};
  }
  return {state: 'miss-error', status: resp.status};
}`,
    args: ['profile:42', 'https://origin.wave2.test/profile/42', 60000],
    branches: [
      ['fresh-hit', {'platform.dateNow': [10000], kv_get: [ok({value: {tier: 'gold'}, exp: 50000})]}],
      ['stale-refresh', {
        'platform.dateNow': [60000],
        kv_get: [ok({value: {tier: 'silver'}, exp: 50000})],
        'http.request': [httpResp(200, {tier: 'platinum'})],
        kv_set: [ok(true)],
      }],
      ['stale-fallback-on-503', {
        'platform.dateNow': [60000],
        kv_get: [ok({value: {tier: 'silver'}, exp: 50000})],
        'http.request': [httpResp(503, 'origin down')],
      }],
    ],
  });

  // 52. sliding-window-rate-limiter (3 branches)
  specs.push({
    slug: 'sliding-window-rate-limiter',
    domain: 'kv-platform',
    features: ['native-bindings', 'platform', 'branch'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(clientId, windowMs, limit) {
  const now = Date.now();
  const key = 'rl:' + clientId;
  const stamps = (await kv_get(key)) || [];
  const active = stamps.filter(t => now - t < windowMs);
  if (active.length >= limit) {
    console.warn('rate-limited:' + clientId + ':' + active.length);
    return {allowed: false, count: active.length, remaining: 0};
  }
  active.push(now);
  await kv_set(key, active);
  return {allowed: true, count: active.length, remaining: limit - active.length};
}`,
    args: ['ip-10-0-0-5', 10000, 3],
    branches: [
      ['allowed-fresh', {'platform.dateNow': [20000], kv_get: [ok([15000])], kv_set: [ok(true)]}],
      ['pruned-expired-allowed', {'platform.dateNow': [25000], kv_get: [ok([10000, 12000, 14000, 22000])], kv_set: [ok(true)]}],
      ['denied-at-limit', {'platform.dateNow': [20000], kv_get: [ok([15000, 17000, 19000])]}],
    ],
  });

  // 53. feature-flag-rollout-evaluator (3 branches)
  specs.push({
    slug: 'feature-flag-rollout-evaluator',
    domain: 'kv-platform',
    features: ['native-bindings', 'env', 'env.get', 'random', 'platform'],
    randomMode: 'tool',
    nativeBindings: KV_BINDINGS,
    source: `async function run(flagName, userId) {
  const killSwitch = process.env.FLAGS_DISABLED;
  if (killSwitch === '1') {
    return {enabled: false, reason: 'kill-switch'};
  }
  const cfg = await kv_get('flag:' + flagName);
  if (!cfg || !cfg.active) {
    return {enabled: false, reason: 'inactive'};
  }
  if (Array.isArray(cfg.allowlist) && cfg.allowlist.includes(userId)) {
    return {enabled: true, reason: 'allowlist'};
  }
  const roll = Math.random();
  const enabled = roll < cfg.pct;
  return {enabled, reason: enabled ? 'rollout-hit' : 'rollout-miss', roll};
}`,
    args: ['new-checkout', 'usr-99'],
    branches: [
      ['kill-switch-off', {'env.get': [ok('1')]}],
      ['allowlist-match', {'env.get': [ok(null)], kv_get: [ok({active: true, pct: 0.1, allowlist: ['usr-99']})]}],
      ['rollout-hit', {'env.get': [ok('0')], kv_get: [ok({active: true, pct: 0.25, allowlist: []})], 'platform.random': [ok(0.18)]}],
    ],
  });

  // 54. idempotency-store-dedup-charge (3 branches)
  specs.push({
    slug: 'idempotency-store-dedup-charge',
    domain: 'kv-platform',
    features: ['native-bindings', 'http', 'http.request', 'platform', 'uuid'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(idemKey, amountCents) {
  const crypto = require('node:crypto');
  const existing = await kv_get('idem:' + idemKey);
  if (existing) {
    return {replayed: true, chargeId: existing.chargeId, status: existing.status};
  }
  const txId = crypto.randomUUID();
  const resp = await fetch('https://pay.wave2.test/charges', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Tx-Id': txId},
    body: JSON.stringify({amountCents, txId}),
  });
  const status = resp.ok ? 'succeeded' : 'failed';
  await kv_set('idem:' + idemKey, {chargeId: txId, status});
  return {replayed: false, chargeId: txId, status};
}`,
    args: ['order-771', 2500],
    branches: [
      ['replay-cached', {kv_get: [ok({chargeId: '00000000-0000-4000-8000-000000000001', status: 'succeeded'})]}],
      ['new-charge-ok', {
        kv_get: [ok(null)],
        'platform.uuid': [ok('11111111-1111-4111-8111-111111111111')],
        'http.request': [httpResp(201, {ok: true})],
        kv_set: [ok(true)],
      }],
      ['new-charge-declined', {
        kv_get: [ok(null)],
        'platform.uuid': [ok('22222222-2222-4222-8222-222222222222')],
        'http.request': [httpResp(402, {error: 'declined'})],
        kv_set: [ok(true)],
      }],
    ],
  });

  // 55. saga-order-compensator (3 branches)
  specs.push({
    slug: 'saga-order-compensator',
    domain: 'kv-platform',
    features: ['http', 'http.request', 'native-bindings', 'platform', 'json'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(orderId, sku, total) {
  const inv = await fetch('https://inv.wave2.test/reserve', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({orderId, sku}),
  });
  if (!inv.ok) {
    await kv_set('saga:' + orderId, {state: 'inventory-failed'});
    return {ok: false, state: 'inventory-failed', compensated: false};
  }
  const pay = await fetch('https://pay.wave2.test/capture', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({orderId, total}),
  });
  if (!pay.ok) {
    console.warn('saga-compensate:' + orderId);
    await fetch('https://inv.wave2.test/release', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({orderId, sku}),
    });
    await kv_set('saga:' + orderId, {state: 'compensated'});
    return {ok: false, state: 'compensated', compensated: true};
  }
  await kv_set('saga:' + orderId, {state: 'completed'});
  return {ok: true, state: 'completed', compensated: false};
}`,
    args: ['ord-900', 'SKU-5', 4900],
    branches: [
      ['saga-completed', {'http.request': [httpResp(200, {reserved: true}), httpResp(200, {captured: true})], kv_set: [ok(true)]}],
      ['payment-failed-compensated', {'http.request': [httpResp(200, {reserved: true}), httpResp(402, 'insufficient'), httpResp(200, {released: true})], kv_set: [ok(true)]}],
      ['inventory-failed-early', {'http.request': [httpResp(409, 'out-of-stock')], kv_set: [ok(true)]}],
    ],
  });

  // 56. session-token-mint-and-store (2 branches)
  specs.push({
    slug: 'session-token-mint-and-store',
    domain: 'kv-platform',
    features: ['native-bindings', 'crypto', 'platform', 'env', 'env.get'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(userId) {
  const crypto = require('node:crypto');
  const ttlSec = Number(process.env.SESSION_TTL || '3600');
  const now = Date.now();
  const rawBytes = crypto.randomBytes(8);
  const token = Buffer.from(rawBytes).toString('hex');
  const exp = now + ttlSec * 1000;
  await kv_set('sess:' + token, {userId, exp});
  return {token, userId, ttlSec, exp};
}`,
    args: ['user-88'],
    branches: [
      ['custom-ttl', {'env.get': [ok('900')], 'platform.dateNow': [1700000000000], 'platform.randomBytes': [ok(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))], kv_set: [ok(true)]}],
      ['default-ttl', {'env.get': [ok(null)], 'platform.dateNow': [1700000000000], 'platform.randomBytes': [ok(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01, 0x02]))], kv_set: [ok(true)]}],
    ],
  });

  // 57. env-driven-multi-service-deploy-pipeline (3 branches: env + fs + shell + http + kv!)
  specs.push({
    slug: 'env-driven-multi-service-deploy-pipeline',
    domain: 'multi-service',
    features: ['env', 'env.get', 'fs', 'fs.readText', 'shell', 'shell.exec', 'http', 'http.request', 'native-bindings', 'platform'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(manifestPath) {
  const fs = require('node:fs');
  const {execFileSync} = require('node:child_process');
  const envName = process.env.DEPLOY_ENV || 'staging';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const prev = await kv_get('deploy:' + envName);
  if (prev && prev.version === manifest.version) {
    return {deployed: false, reason: 'already-live', envName, version: manifest.version};
  }
  try {
    execFileSync('npm', ['run', 'smoke', '--', manifest.version], {encoding: 'utf8'});
  } catch (err) {
    console.error('smoke-failed:' + manifest.version);
    return {deployed: false, reason: 'smoke-failed', envName, status: err.status};
  }
  const hook = await fetch('https://deploy.wave2.test/notify', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({env: envName, version: manifest.version}),
  });
  await kv_set('deploy:' + envName, {version: manifest.version, notified: hook.ok});
  return {deployed: true, envName, version: manifest.version, notified: hook.ok};
}`,
    args: ['/release/manifest.json'],
    branches: [
      ['fresh-deploy-ok', {
        'env.get': [ok('prod')],
        'fs.readText': [ok('{"version":"3.2.0"}')],
        kv_get: [ok({version: '3.1.0'})],
        'shell.exec': [shRes('smoke ok')],
        'http.request': [httpResp(200, {ok: true})],
        kv_set: [ok(true)],
      }],
      ['noop-already-live', {
        'env.get': [ok('prod')],
        'fs.readText': [ok('{"version":"3.2.0"}')],
        kv_get: [ok({version: '3.2.0'})],
      }],
      ['smoke-test-aborts', {
        'env.get': [ok(null)],
        'fs.readText': [ok('{"version":"3.2.1"}')],
        kv_get: [ok(null)],
        'shell.exec': [shRes('', 'smoke failed', 1)],
      }],
    ],
  });

  // 58. incident-pager-dedup-escalator (2 branches: env + kv + platform.dateNow + http)
  specs.push({
    slug: 'incident-pager-dedup-escalator',
    domain: 'multi-service',
    features: ['env', 'env.get', 'native-bindings', 'platform', 'http', 'http.request'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(alertKey, severity) {
  const now = Date.now();
  const silenceMs = Number(process.env.ALERT_SILENCE_MS || '300000');
  const prev = await kv_get('alert:' + alertKey);
  if (prev && now - prev.lastSent < silenceMs && severity !== 'critical') {
    console.info('alert-suppressed:' + alertKey);
    return {paged: false, reason: 'dedup', alertKey};
  }
  const resp = await fetch('https://pager.wave2.test/trigger', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({alertKey, severity, ts: now}),
  });
  await kv_set('alert:' + alertKey, {lastSent: now, severity});
  return {paged: resp.ok, reason: 'triggered', status: resp.status};
}`,
    args: ['db-cpu-high', 'warning'],
    branches: [
      ['suppressed-within-window', {'platform.dateNow': [500000], 'env.get': [ok('600000')], kv_get: [ok({lastSent: 400000, severity: 'warning'})]}],
      ['window-expired-pages', {'platform.dateNow': [900000], 'env.get': [ok('300000')], kv_get: [ok({lastSent: 400000, severity: 'warning'})], 'http.request': [httpResp(202, {incident: 'inc-7'})], kv_set: [ok(true)]}],
    ],
  });

  // 59. ab-experiment-weighted-logger (2 branches: random + kv + http)
  specs.push({
    slug: 'ab-experiment-weighted-logger',
    domain: 'kv-platform',
    features: ['random', 'native-bindings', 'http', 'http.request', 'platform'],
    randomMode: 'tool',
    nativeBindings: KV_BINDINGS,
    source: `async function run(expId, userId, treatmentShare) {
  const existing = await kv_get('exp:' + expId + ':' + userId);
  if (existing) {
    return {variant: existing, sticky: true};
  }
  const r = Math.random();
  const variant = r < treatmentShare ? 'treatment' : 'control';
  await kv_set('exp:' + expId + ':' + userId, variant);
  await fetch('https://metrics.wave2.test/assign', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({expId, userId, variant}),
  });
  return {variant, sticky: false, roll: r};
}`,
    args: ['search-rank-v2', 'u-101', 0.3],
    branches: [
      ['sticky-existing', {kv_get: [ok('control')]}],
      ['new-treatment-assigned', {kv_get: [ok(null)], 'platform.random': [ok(0.15)], kv_set: [ok(true)], 'http.request': [httpResp(204, '')]}],
    ],
  });

  // 60. secret-rotation-dual-write (2 branches: env + crypto + kv + fs + http)
  specs.push({
    slug: 'secret-rotation-dual-write',
    domain: 'multi-service',
    features: ['env', 'env.get', 'crypto', 'native-bindings', 'fs', 'fs.writeText', 'http', 'http.request'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(serviceName, localSecretFile) {
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const dryRun = process.env.DRY_RUN === 'true';
  const nextSecret = crypto.randomUUID();
  if (dryRun) {
    console.info('dry-run-rotate:' + serviceName);
    return {rotated: false, dryRun: true, previewPrefix: nextSecret.slice(0, 8)};
  }
  const resp = await fetch('https://vault.wave2.test/secrets/' + serviceName, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({secret: nextSecret}),
  });
  if (!resp.ok) return {rotated: false, dryRun: false, status: resp.status};
  await kv_set('secret-ver:' + serviceName, nextSecret.slice(0, 8));
  fs.writeFileSync(localSecretFile, nextSecret, 'utf8');
  return {rotated: true, dryRun: false, prefix: nextSecret.slice(0, 8)};
}`,
    args: ['billing-svc', '/run/secrets/billing.key'],
    branches: [
      ['dry-run-noop', {'env.get': [ok('true')], 'platform.uuid': [ok('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')]}],
      ['live-rotate-ok', {
        'env.get': [ok('false')],
        'platform.uuid': [ok('12345678-1111-4222-8333-444444444444')],
        'http.request': [httpResp(200, {updated: true})],
        kv_set: [ok(true)],
        'fs.writeText': [ok(undefined)],
      }],
    ],
  });

  // 61. cache-invalidation-fanout-and-del (2 branches)
  specs.push({
    slug: 'cache-invalidation-fanout-and-del',
    domain: 'kv-platform',
    features: ['native-bindings', 'http', 'http.request', 'loop'],
    nativeBindings: KV_DEL_BINDINGS,
    source: `async function run(keys, cdnPurgeUrl) {
  const deleted = [];
  for (const k of keys) {
    const cur = await kv_get(k);
    if (cur !== null) {
      await kv_del(k);
      deleted.push(k);
    }
  }
  if (deleted.length === 0) {
    return {purgedCdn: false, deleted};
  }
  const resp = await fetch(cdnPurgeUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({keys: deleted}),
  });
  return {purgedCdn: resp.ok, deleted, status: resp.status};
}`,
    args: [['page:/home', 'page:/pricing'], 'https://cdn.wave2.test/purge'],
    branches: [
      ['none-cached-skip-cdn', {kv_get: [ok(null), ok(null)]}],
      ['one-deleted-purges-cdn', {kv_get: [ok({html: '<p>hi</p>'}), ok(null)], kv_del: [ok(true)], 'http.request': [httpResp(200, {purged: 1})]}],
    ],
  });

  // 62. distributed-cron-leader-exec (3 branches: kv + platform.dateNow + shell.exec + fs)
  specs.push({
    slug: 'distributed-cron-leader-exec',
    domain: 'multi-service',
    features: ['native-bindings', 'platform', 'shell', 'shell.exec', 'fs', 'fs.writeText'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(nodeId, jobCmd, reportFile) {
  const {execFileSync} = require('node:child_process');
  const fs = require('node:fs');
  const now = Date.now();
  const lease = await kv_get('leader:nightly');
  if (lease && lease.node !== nodeId && now < lease.exp) {
    return {ran: false, leader: lease.node};
  }
  await kv_set('leader:nightly', {node: nodeId, exp: now + 60000});
  try {
    const out = execFileSync(jobCmd[0], jobCmd.slice(1), {encoding: 'utf8'}).trim();
    fs.writeFileSync(reportFile, out, 'utf8');
    return {ran: true, ok: true, leader: nodeId, out};
  } catch (err) {
    console.error('cron-job-err:' + err.status);
    return {ran: true, ok: false, leader: nodeId, status: err.status};
  }
}`,
    args: ['node-2', ['vacuum-db', '--quick'], '/var/log/vacuum.out'],
    branches: [
      ['follower-skips', {'platform.dateNow': [10000], kv_get: [ok({node: 'node-1', exp: 50000})]}],
      ['elected-and-succeeds', {
        'platform.dateNow': [60000],
        kv_get: [ok({node: 'node-1', exp: 50000})],
        kv_set: [ok(true)],
        'shell.exec': [shRes('reclaimed 120 pages\n')],
        'fs.writeText': [ok(undefined)],
      }],
      ['elected-and-fails', {
        'platform.dateNow': [60000],
        kv_get: [ok(null)],
        kv_set: [ok(true)],
        'shell.exec': [shRes('', 'lock timeout', 2)],
      }],
    ],
  });

  // 63. env-proxy-url-builder-fetch (2 branches, TypeScript)
  specs.push({
    slug: 'env-proxy-url-builder-fetch',
    domain: 'multi-service',
    language: 'ts',
    features: ['env', 'env.get', 'http', 'http.request', 'url', 'typescript'],
    source: `interface ProxyResult { viaProxy: boolean; status: number; target: string; }
async function run(targetUrl: string): Promise<ProxyResult> {
  const proxyBase = process.env.HTTP_PROXY_API;
  if (proxyBase) {
    const wrapped = proxyBase + '?target=' + encodeURIComponent(targetUrl);
    const resp = await fetch(wrapped, {method: 'GET', headers: {'X-Forwarded': '1'}});
    return {viaProxy: true, status: resp.status, target: wrapped};
  }
  const direct = await fetch(targetUrl, {method: 'GET'});
  return {viaProxy: false, status: direct.status, target: targetUrl};
}`,
    args: ['https://ext.wave2.test/feed'],
    branches: [
      ['via-proxy', {'env.get': [ok('https://proxy.wave2.test/fetch')], 'http.request': [httpResp(200, 'ok')]}],
      ['direct-connect', {'env.get': [ok(null)], 'http.request': [httpResp(200, 'ok')]}],
    ],
  });

  // 64. log-shipper-batch-checkpoint (2 branches: fs + http + kv + platform.dateNow)
  specs.push({
    slug: 'log-shipper-batch-checkpoint',
    domain: 'multi-service',
    features: ['fs', 'fs.readdir', 'fs.readText', 'http', 'http.request', 'native-bindings', 'platform'],
    nativeBindings: KV_BINDINGS,
    source: `async function run(spoolDir, ingestUrl) {
  const fs = require('node:fs');
  const files = fs.readdirSync(spoolDir).filter(f => f.endsWith('.log')).sort();
  const shipped = [];
  for (const f of files) {
    const done = await kv_get('shipped:' + f);
    if (done) continue;
    const text = fs.readFileSync(spoolDir + '/' + f, 'utf8');
    const resp = await fetch(ingestUrl, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain', 'X-Log-File': f},
      body: text,
    });
    if (!resp.ok) {
      console.warn('ship-paused:' + f + ':' + resp.status);
      return {ok: false, shipped, stoppedAt: f};
    }
    await kv_set('shipped:' + f, Date.now());
    shipped.push(f);
  }
  return {ok: true, shipped, stoppedAt: null};
}`,
    args: ['/var/spool/logs', 'https://logs.wave2.test/ingest'],
    branches: [
      ['ships-new-skips-done', {
        'fs.readdir': [ok(['01.log', '02.log'])],
        kv_get: [ok(1700000001), ok(null)],
        'fs.readText': [ok('ERROR disk\n')],
        'http.request': [httpResp(202, 'ok')],
        'platform.dateNow': [1700000500],
        kv_set: [ok(true)],
      }],
      ['pauses-on-503', {
        'fs.readdir': [ok(['01.log', '02.log'])],
        kv_get: [ok(null)],
        'fs.readText': [ok('INFO boot\n')],
        'http.request': [httpResp(503, 'backpressure')],
      }],
    ],
  });

  // 65. release-artifact-promote-pipeline (2 branches: fs + shell + http + env)
  specs.push({
    slug: 'release-artifact-promote-pipeline',
    domain: 'multi-service',
    features: ['env', 'env.get', 'fs', 'fs.exists', 'shell', 'shell.exec', 'http', 'http.request'],
    source: `async function run(artifactPath, releaseTag) {
  const fs = require('node:fs');
  const {execFileSync} = require('node:child_process');
  const token = process.env.RELEASE_TOKEN;
  if (!token) return {promoted: false, reason: 'missing-token'};
  if (!fs.existsSync(artifactPath)) return {promoted: false, reason: 'missing-artifact'};
  const sha = execFileSync('sha256sum', [artifactPath], {encoding: 'utf8'}).trim().split(/\\s+/)[0];
  const resp = await fetch('https://releases.wave2.test/promote', {
    method: 'POST',
    headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify({tag: releaseTag, sha}),
  });
  return {promoted: resp.ok, status: resp.status, sha: sha.slice(0, 12)};
}`,
    args: ['/dist/app.tgz', 'v4.5.0'],
    branches: [
      ['promoted-ok', {
        'env.get': [ok('tok_rel_99')],
        'fs.exists': [ok(true)],
        'shell.exec': [shRes('aabbccddeeff001122334455  /dist/app.tgz\n')],
        'http.request': [httpResp(200, {live: true})],
      }],
      ['missing-token-blocks', {
        'env.get': [ok(null)],
      }],
    ],
  });

  // 66. jittered-kv-lock-retry-worker (2 branches: random + platform.dateNow + kv)
  specs.push({
    slug: 'jittered-kv-lock-retry-worker',
    domain: 'kv-platform',
    features: ['native-bindings', 'random', 'platform', 'loop'],
    randomMode: 'tool',
    nativeBindings: KV_BINDINGS,
    source: `async function run(lockKey, workerId, maxTries) {
  const backoffs = [];
  for (let i = 0; i < maxTries; i++) {
    const now = Date.now();
    const cur = await kv_get(lockKey);
    if (!cur || now >= cur.exp) {
      await kv_set(lockKey, {owner: workerId, exp: now + 5000});
      return {acquired: true, tries: i + 1, backoffs};
    }
    const jitter = Math.floor(Math.random() * 100) + 10;
    backoffs.push(jitter);
    console.info('lock-wait:' + i + ':ms=' + jitter);
  }
  return {acquired: false, tries: maxTries, backoffs};
}`,
    args: ['mutex:compact', 'w-7', 3],
    branches: [
      ['acquired-on-second-try', {
        'platform.dateNow': [10000, 16000],
        kv_get: [ok({owner: 'w-1', exp: 15000}), ok({owner: 'w-1', exp: 15000})],
        'platform.random': [ok(0.42)],
        kv_set: [ok(true)],
      }],
      ['exhausted-contention', {
        'platform.dateNow': [10000, 10200, 10400],
        kv_get: [ok({owner: 'w-1', exp: 20000}), ok({owner: 'w-1', exp: 20000}), ok({owner: 'w-1', exp: 20000})],
        'platform.random': [ok(0.1), ok(0.5), ok(0.8)],
      }],
    ],
  });

  return specs;
}

// ---------------------------------------------------------------------------
// Independent 2nd verification via separate tools/tinker-execution.mjs worker
// ---------------------------------------------------------------------------
class ExecutionWorkerClient {
  constructor() {
    this.proc = spawn(process.execPath, [resolve(REPO_ROOT, 'tools/tinker-execution.mjs')], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.rl = createInterface({input: this.proc.stdout, crlfDelay: Infinity});
    this.pending = new Map();
    this.nextId = 1;
    this.rl.on('line', line => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(`${msg.error?.name ?? 'Error'}: ${msg.error?.message ?? 'worker error'}`));
    });
  }
  request(payload) {
    const id = this.nextId++;
    return new Promise((resolveFn, rejectFn) => {
      this.pending.set(id, {resolve: resolveFn, reject: rejectFn});
      this.proc.stdin.write(JSON.stringify({id, ...payload}) + '\n');
    });
  }
  close() {
    this.proc.stdin.end();
    this.rl.close();
  }
}

function initialPrefixLen(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') return i + 1;
  }
  return 2;
}

function auditCausalPairGroup(rows) {
  if (rows.length < 2) throw new Error('Causal pair group needs >= 2 rows');
  const basePrefix = initialPrefixLen(rows[0].messages);
  const basePrompt = JSON.stringify(rows[0].messages.slice(0, basePrefix));
  let divergences = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i].messages;
      const b = rows[j].messages;
      const pLen = initialPrefixLen(a);
      if (pLen !== initialPrefixLen(b) || JSON.stringify(a.slice(0, pLen)) !== JSON.stringify(b.slice(0, pLen))) {
        throw new Error(`Causal prompt mismatch in ${rows[i].id} vs ${rows[j].id}`);
      }
      if (JSON.stringify(a.slice(0, pLen)) !== basePrompt) {
        throw new Error(`Prompt mismatch against group base in ${rows[i].id}`);
      }
      const ao = a.map((m, idx) => [idx, m]).filter(([idx, m]) => idx >= pLen && m.role === 'tool');
      const bo = b.map((m, idx) => [idx, m]).filter(([idx, m]) => idx >= pLen && m.role === 'tool');
      let div = -1;
      for (let k = 0; k < Math.min(ao.length, bo.length); k++) {
        if (JSON.stringify(ao[k][1]) !== JSON.stringify(bo[k][1])) {
          div = k;
          break;
        }
      }
      if (div < 0) {
        if (ao.length === bo.length && JSON.stringify(a) === JSON.stringify(b)) {
          throw new Error(`Counterfactual pair ${rows[i].id} vs ${rows[j].id} produced identical conversations!`);
        }
        continue;
      }
      const ai = ao[div][0];
      const bi = bo[div][0];
      if (ai !== bi || JSON.stringify(a.slice(0, ai)) !== JSON.stringify(b.slice(0, bi))) {
        throw new Error(`Future leakage detected in ${rows[i].id} vs ${rows[j].id} before obs ${div}`);
      }
      divergences++;
    }
  }
  return divergences;
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------
const {values} = parseArgs({options: {
  output: {type: 'string', short: 'o', default: 'runs/stage10-effectful-wave2/js-tasks.jsonl'},
  'trace-format': {type: 'string', default: 'compact'},
  'reasoning-channel': {type: 'string', default: 'thinking'},
  jobs: {type: 'string', default: '4'},
  help: {type: 'boolean', short: 'h'},
}});

if (values.help) {
  console.log('Usage: node tools/tinker-build-effectful-pairs-js-wave2.mjs [-o <out.jsonl>] [--jobs 4]');
  process.exit(0);
}

const traceFormat = values['trace-format'];
const reasoningChannel = values['reasoning-channel'];
const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));

const specs = buildFamilySpecs();
const rawTasks = [];

for (const spec of specs) {
  const lang = spec.language ?? 'js';
  const family = `eff-wave2-${lang}:${spec.slug}`;
  const pairId = `eff-wave2-pair:${lang}:${spec.slug}`;
  for (const [branchName, script, extra = {}] of spec.branches) {
    const recorded = await recordJsFixture({
      source: spec.source,
      entry: spec.entry ?? 'run',
      args: spec.args,
      language: lang,
      nativeBindings: spec.nativeBindings ?? [],
      randomMode: spec.randomMode ?? 'seeded',
      randomSeed: spec.randomSeed ?? 17,
      respond: makeResponder(script),
      allowThrow: Boolean(extra.allowThrow),
    });
    const ops = [...new Set(recorded.calls.map(c => c.operation))];
    const features = [...new Set([
      'native-v8',
      'external',
      'effectful',
      'hard-effectful',
      'causal-pair',
      'sequential',
      spec.domain,
      ...spec.features,
      ...ops,
      ...(lang === 'ts' ? ['typescript'] : []),
    ])].sort();
    rawTasks.push({
      id: `eff-wave2-${lang}-${spec.slug}-${branchName}`,
      family,
      language: lang,
      tier: 5,
      source: spec.source,
      entry: spec.entry ?? 'run',
      args: encodeReadable(spec.args),
      executionMode: 'native',
      randomMode: spec.randomMode ?? 'seeded',
      randomSeed: spec.randomSeed ?? 17,
      nativeBindings: spec.nativeBindings ?? [],
      fixture: {calls: recorded.calls},
      maxSteps: 200000,
      timeoutMs: 10000,
      features,
      metadata: {
        sourceOrigin: 'stage10-effectful-pairs-js-wave2',
        domain: spec.domain,
        executionMode: 'native',
        language: lang,
        tier: 5,
        features,
        pair_id: pairId,
        pair_branch: branchName,
      },
    });
  }
}

// Pass 1: exportTinkerExample (effectful-reference-worker.mjs + auditTeacherConversation)
const pass1 = new Array(rawTasks.length);
let cursor1 = 0;
await Promise.all(Array.from({length: jobs}, async () => {
  while (cursor1 < rawTasks.length) {
    const idx = cursor1++;
    const task = rawTasks[idx];
    const exp = await exportTinkerExample(task, {traceFormat, reasoningChannel});
    if (!exp.metadata?.traceAudit?.replayVerified) {
      throw new Error(`Pass 1 replayVerified false for ${task.id}`);
    }
    pass1[idx] = exp;
  }
}));

// Pass 2: Independent verification through separate tools/tinker-execution.mjs worker processes
const pass2 = new Array(rawTasks.length);
let cursor2 = 0;
const workers = Array.from({length: jobs}, () => new ExecutionWorkerClient());
try {
  await Promise.all(workers.map(async worker => {
    while (cursor2 < rawTasks.length) {
      const idx = cursor2++;
      const task = rawTasks[idx];
      const exp2 = await worker.request({
        op: 'export',
        task,
        traceFormat,
        reasoningChannel,
      });
      if (!exp2.metadata?.traceAudit?.replayVerified) {
        throw new Error(`Pass 2 replayVerified false for ${task.id}`);
      }
      // Determinism check: Pass 1 and Pass 2 must match byte-for-byte on sourceHash & messages
      if (exp2.sourceHash !== pass1[idx].sourceHash) {
        throw new Error(`Determinism sourceHash mismatch on ${task.id}`);
      }
      if (JSON.stringify(exp2.messages) !== JSON.stringify(pass1[idx].messages)) {
        throw new Error(`Determinism messages mismatch on ${task.id}`);
      }
      // Also run live start -> step -> grade replay on the worker for every task!
      const started = await worker.request({op: 'start', task: exp2.task});
      const sid = started.sessionId;
      try {
        const prefixLen = initialPrefixLen(exp2.messages);
        let finalGrade = null;
        for (let m = prefixLen; m < exp2.messages.length; m++) {
          const msg = exp2.messages[m];
          if (msg.role !== 'assistant') continue;
          const stepRes = await worker.request({op: 'step', sessionId: sid, action: msg, generatedTokens: 0});
          if (stepRes.done) finalGrade = stepRes.grade;
        }
        if (!finalGrade?.success) {
          throw new Error(`Live session replay failed for ${task.id}: ${JSON.stringify(finalGrade)}`);
        }
      } finally {
        await worker.request({op: 'close', sessionId: sid});
      }
      // Attach pair_id and split_component cleanly on exported row
      const pairId = task.metadata.pair_id;
      exp2.pair_id = pairId;
      exp2.split_component = sha256(`${exp2.family}:${exp2.sourceHash}`);
      exp2.metadata = {
        ...task.metadata,
        ...exp2.metadata,
        pair_id: pairId,
        pair_branch: task.metadata.pair_branch,
        determinismVerified2x: true,
      };
      pass2[idx] = exp2;
    }
  }));
} finally {
  for (const w of workers) w.close();
}

// Causal-prefix invariance audit across every pair group
const byPair = new Map();
for (const row of pass2) {
  const pid = row.pair_id;
  if (!byPair.has(pid)) byPair.set(pid, []);
  byPair.get(pid).push(row);
}
let totalDivergences = 0;
for (const [pid, grp] of byPair.entries()) {
  totalDivergences += auditCausalPairGroup(grp);
}

const outPath = resolve(REPO_ROOT, values.output);
mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, pass2.map(r => JSON.stringify(r)).join('\n') + '\n');

const opCounts = {};
const domainCounts = {};
const langCounts = {};
for (const r of pass2) {
  const lang = r.task.language || 'js';
  langCounts[lang] = (langCounts[lang] || 0) + 1;
  const dom = r.metadata.domain || 'unknown';
  domainCounts[dom] = (domainCounts[dom] || 0) + 1;
  for (const c of r.task.fixture.calls) {
    opCounts[c.operation] = (opCounts[c.operation] || 0) + 1;
  }
}

console.log(JSON.stringify({
  ok: true,
  output: outPath,
  totalTasks: pass2.length,
  uniqueFamilies: new Set(pass2.map(r => r.family)).size,
  causalPairGroups: byPair.size,
  causalDivergencesVerified: totalDivergences,
  determinismVerified2x: pass2.length,
  languages: langCounts,
  domains: domainCounts,
  operationCallCounts: opCounts,
}, null, 2));
