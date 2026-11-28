import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportTinkerExample,
  parseStudentAction,
  encodeReadable,
} from '../src/training/tinker-execution.js';
import {scanPublicSourceNodeIoTools} from '../src/training/tinker-node-io.js';

const nativeTask = (source, overrides = {}) => ({
  id: 'node-io-expansion',
  family: 'node-io-expansion',
  executionMode: 'native',
  source,
  entry: 'run',
  args: [],
  ...overrides,
});

test('scanPublicSourceNodeIoTools detects expanded fs, fs.promises, child_process, and crypto operations from AST', () => {
  const ops = [...scanPublicSourceNodeIoTools(`
    const fs = require('node:fs');
    const fsp = require('node:fs/promises');
    const {spawnSync} = require('node:child_process');
    const crypto = require('node:crypto');
    async function run() {
      fs.mkdirSync('/workspace/sub', {recursive: true});
      fs.appendFileSync('/workspace/sub/log.txt', 'line1\\n');
      fs.copyFileSync('/workspace/sub/log.txt', '/workspace/sub/log.bak');
      fs.renameSync('/workspace/sub/log.bak', '/workspace/sub/log2.bak');
      fs.accessSync('/workspace/sub/log2.bak');
      fs.unlinkSync('/workspace/sub/log2.bak');
      await fsp.rm('/workspace/sub', {recursive: true, force: true});
      const buf = new Uint8Array(4);
      crypto.randomFillSync(buf);
      spawnSync('echo', ['ok'], {encoding: 'utf8'});
    }
  `)].sort();
  assert.deepEqual(ops, [
    'fs.exists',
    'fs.mkdir',
    'fs.readBytes',
    'fs.readText',
    'fs.rename',
    'fs.unlink',
    'fs.writeBytes',
    'fs.writeText',
    'platform.randomBytes',
    'shell.exec',
  ]);

  // Pure built-ins (events, stream, crypto HMAC/scrypt/pbkdf2/timingSafeEqual) must declare ZERO external tools
  const pureOps = [...scanPublicSourceNodeIoTools(`
    const {EventEmitter} = require('node:events');
    const {Readable, Writable, Transform, PassThrough, pipeline} = require('node:stream');
    const crypto = require('node:crypto');
    function run() {
      const ee = new EventEmitter();
      const hmac = crypto.createHmac('sha256', 'k').update('v').digest();
      const eq = crypto.timingSafeEqual(hmac, hmac);
      const dk = crypto.pbkdf2Sync('pw', 'salt', 10, 16, 'sha256');
      const sk = crypto.scryptSync('pw', 'salt', 16);
      return [ee, Readable, Writable, Transform, PassThrough, pipeline, eq, dk, sk];
    }
  `)];
  assert.deepEqual(pureOps, []);
});

test('sync fs expansion: mkdirSync, appendFileSync, copyFileSync, renameSync, accessSync, unlinkSync, rmSync', async () => {
  const source = `
    const fs = require('node:fs');
    function run() {
      fs.mkdirSync('/workspace/out', {recursive: true});
      fs.appendFileSync('/workspace/out/a.txt', 'hello');
      fs.appendFileSync('/workspace/out/a.txt', ' world');
      fs.copyFileSync('/workspace/out/a.txt', '/workspace/out/b.txt');
      fs.renameSync('/workspace/out/b.txt', '/workspace/out/c.txt');
      fs.accessSync('/workspace/out/c.txt', fs.constants.R_OK);
      let missingCode = null;
      try {
        fs.accessSync('/workspace/out/missing.txt');
      } catch (err) {
        missingCode = err.code;
      }
      fs.unlinkSync('/workspace/out/c.txt');
      fs.rmSync('/workspace/out/already-gone.txt', {force: true});
      return {missingCode, ok: true};
    }
  `;

  const helloWorldBytes = encodeReadable(new Uint8Array(Buffer.from('hello world', 'utf8')));
  const exported = await exportTinkerExample(nativeTask(source, {
    id: 'node-sync-fs-expansion',
    fixture: {
      calls: [
        {operation: 'fs.mkdir', arguments: ['/workspace/out'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.exists', arguments: ['/workspace/out/a.txt'], status: 'fulfilled', result: false},
        {operation: 'fs.writeText', arguments: ['/workspace/out/a.txt', 'hello'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.exists', arguments: ['/workspace/out/a.txt'], status: 'fulfilled', result: true},
        {operation: 'fs.readText', arguments: ['/workspace/out/a.txt'], status: 'fulfilled', result: 'hello'},
        {operation: 'fs.writeText', arguments: ['/workspace/out/a.txt', 'hello world'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.readBytes', arguments: ['/workspace/out/a.txt'], status: 'fulfilled', result: helloWorldBytes},
        {operation: 'fs.writeBytes', arguments: ['/workspace/out/b.txt', helloWorldBytes], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.rename', arguments: ['/workspace/out/b.txt', '/workspace/out/c.txt'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.exists', arguments: ['/workspace/out/c.txt'], status: 'fulfilled', result: true},
        {operation: 'fs.exists', arguments: ['/workspace/out/missing.txt'], status: 'fulfilled', result: false},
        {operation: 'fs.unlink', arguments: ['/workspace/out/c.txt'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.unlink', arguments: ['/workspace/out/already-gone.txt'], status: 'rejected', result: {name: 'Error', message: 'ENOENT: no such file'}},
      ],
    },
  }), {traceFormat: 'compact'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.equal(comp.kind, 'return');
  assert.deepEqual(comp.value, {missingCode: 'ENOENT', ok: true});
});

test('fs.promises expansion: mkdir, writeFile, appendFile, readFile, copyFile, rename, access, stat, readdir, rm, unlink', async () => {
  const source = `
    const fsp = require('node:fs/promises');
    async function run() {
      await fsp.mkdir('/workspace/p', {recursive: true});
      await fsp.writeFile('/workspace/p/n.txt', 'v1', 'utf8');
      await fsp.appendFile('/workspace/p/n.txt', '+v2', 'utf8');
      const txt = await fsp.readFile('/workspace/p/n.txt', 'utf8');
      await fsp.copyFile('/workspace/p/n.txt', '/workspace/p/copy.txt');
      await fsp.rename('/workspace/p/copy.txt', '/workspace/p/final.txt');
      await fsp.access('/workspace/p/final.txt');
      const st = await fsp.stat('/workspace/p/final.txt');
      const list = await fsp.readdir('/workspace/p');
      await fsp.unlink('/workspace/p/final.txt');
      await fsp.rm('/workspace/p', {recursive: true});
      return {txt, size: st.size, isFile: st.isFile(), list};
    }
  `;

  const bytes = encodeReadable(new Uint8Array(Buffer.from('v1+v2', 'utf8')));
  const exported = await exportTinkerExample(nativeTask(source, {
    id: 'node-fs-promises-expansion',
    fixture: {
      calls: [
        {operation: 'fs.mkdir', arguments: ['/workspace/p'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.writeText', arguments: ['/workspace/p/n.txt', 'v1'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.exists', arguments: ['/workspace/p/n.txt'], status: 'fulfilled', result: true},
        {operation: 'fs.readText', arguments: ['/workspace/p/n.txt'], status: 'fulfilled', result: 'v1'},
        {operation: 'fs.writeText', arguments: ['/workspace/p/n.txt', 'v1+v2'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.readText', arguments: ['/workspace/p/n.txt'], status: 'fulfilled', result: 'v1+v2'},
        {operation: 'fs.readBytes', arguments: ['/workspace/p/n.txt'], status: 'fulfilled', result: bytes},
        {operation: 'fs.writeBytes', arguments: ['/workspace/p/copy.txt', bytes], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.rename', arguments: ['/workspace/p/copy.txt', '/workspace/p/final.txt'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.exists', arguments: ['/workspace/p/final.txt'], status: 'fulfilled', result: true},
        {operation: 'fs.stat', arguments: ['/workspace/p/final.txt'], status: 'fulfilled', result: {isFile: true, isDirectory: false, size: 5}},
        {operation: 'fs.readdir', arguments: ['/workspace/p'], status: 'fulfilled', result: ['final.txt', 'n.txt']},
        {operation: 'fs.unlink', arguments: ['/workspace/p/final.txt'], status: 'fulfilled', result: {$js: 'undefined'}},
        {operation: 'fs.unlink', arguments: ['/workspace/p'], status: 'fulfilled', result: {$js: 'undefined'}},
      ],
    },
  }), {traceFormat: 'compact'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.deepEqual(comp.value, {txt: 'v1+v2', size: 5, isFile: true, list: ['final.txt', 'n.txt']});
});

test('EventEmitter, stream (Readable/Writable/Transform/PassThrough/pipeline), and AbortController/AbortSignal work purely', async () => {
  const source = `
    const EventEmitter = require('node:events');
    const {Readable, Writable, Transform, PassThrough, pipeline, promises: streamPromises} = require('node:stream');

    async function run() {
      // 1. EventEmitter
      const ee = new EventEmitter();
      const log = [];
      const onMsg = x => log.push('on:' + x);
      ee.on('msg', onMsg);
      ee.once('msg', x => log.push('once:' + x));
      const countBefore = ee.listenerCount('msg');
      ee.emit('msg', 'a');
      ee.emit('msg', 'b');
      ee.off('msg', onMsg);
      const countAfterOff = ee.listenerCount('msg');
      ee.on('x', () => {});
      ee.removeAllListeners();

      // 2. Streams: Readable -> Transform -> PassThrough -> Writable via pipeline
      const src = Readable.from(['hello', ' ', 'streams']);
      const upper = new Transform({
        objectMode: true,
        transform(chunk, _enc, cb) {
          cb(null, String(chunk).toUpperCase());
        },
        flush(cb) {
          cb(null, '!');
        },
      });
      const pt = new PassThrough({objectMode: true});
      const collected = [];
      const sink = new Writable({
        objectMode: true,
        write(chunk, _enc, cb) {
          collected.push(chunk);
          cb();
        },
      });
      await streamPromises.pipeline(src, upper, pt, sink);

      // Sync callback pipeline + async iterator
      const iterOut = [];
      for await (const item of Readable.from([1, 2, 3])) {
        iterOut.push(item * 10);
      }

      // 3. AbortController & AbortSignal
      const ac = new AbortController();
      const abortEvents = [];
      ac.signal.addEventListener('abort', () => abortEvents.push(ac.signal.reason));
      const beforeAborted = ac.signal.aborted;
      ac.abort('stop-now');
      const preAborted = AbortSignal.abort('already');
      const timeoutSig = AbortSignal.timeout(0);
      await Promise.resolve();
      const anySig = AbortSignal.any([new AbortController().signal, preAborted]);

      return {
        log,
        countBefore,
        countAfterOff,
        remainingEvents: ee.eventNames(),
        streamJoined: collected.join(''),
        iterOut,
        beforeAborted,
        afterAborted: ac.signal.aborted,
        abortEvents,
        preAbortedReason: preAborted.reason,
        timeoutAborted: timeoutSig.aborted,
        timeoutReasonName: timeoutSig.reason?.name ?? null,
        anyAborted: anySig.aborted,
        anyReason: anySig.reason,
      };
    }
  `;

  const exported = await exportTinkerExample(nativeTask(source, {id: 'node-events-stream-abort'}), {traceFormat: 'compact'});
  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  assert.equal(exported.messages.some(m => m.role === 'tool_declare'), false);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.deepEqual(comp.value, {
    log: ['on:a', 'once:a', 'on:b'],
    countBefore: 2,
    countAfterOff: 0,
    remainingEvents: [],
    streamJoined: 'HELLO STREAMS!',
    iterOut: [10, 20, 30],
    beforeAborted: false,
    afterAborted: true,
    abortEvents: ['stop-now'],
    preAbortedReason: 'already',
    timeoutAborted: true,
    timeoutReasonName: 'TimeoutError',
    anyAborted: true,
    anyReason: 'already',
  });
});

test('crypto additions (createHmac, timingSafeEqual, scryptSync, pbkdf2Sync, randomFillSync) and child_process execSync/spawnSync options', async () => {
  const source = `
    const crypto = require('node:crypto');
    const cp = require('node:child_process');
    function run() {
      const mac1 = crypto.createHmac('sha256', 'secret-key').update('payload').digest();
      const mac2 = crypto.createHmac('sha256', 'secret-key').update('payload').digest();
      const macEq = crypto.timingSafeEqual(mac1, mac2);
      const pbk = crypto.pbkdf2Sync('pass', 'salt', 100, 16, 'sha256').toString('hex');
      const scr = crypto.scryptSync('pass', 'salt', 16).toString('hex');
      const filled = new Uint8Array(6);
      crypto.randomFillSync(filled, 1, 4);

      const execOut = cp.execSync('cat', {encoding: 'utf8', cwd: '/workspace/sub', env: {MODE: 'test'}, input: 'ping'}).trim();
      const sp = cp.spawnSync('grep', ['needle'], {encoding: 'utf8', cwd: '/workspace/sub', input: 'haystack'});
      return {
        macHex: mac1.toString('hex').slice(0, 16),
        macEq,
        pbkLen: pbk.length,
        scrLen: scr.length,
        filled: Array.from(filled),
        execOut,
        spawnStatus: sp.status,
        spawnStdout: sp.stdout,
        spawnStderr: sp.stderr,
      };
    }
  `;

  const exported = await exportTinkerExample(nativeTask(source, {
    id: 'node-crypto-cp-expansion',
    fixture: {
      calls: [
        {operation: 'platform.randomBytes', arguments: [4], status: 'fulfilled', result: encodeReadable(new Uint8Array([10, 20, 30, 40]))},
        {
          operation: 'shell.exec',
          arguments: [{command: 'cat', args: [], cwd: '/workspace/sub', env: {MODE: 'test'}, input: 'ping'}],
          status: 'fulfilled',
          result: {stdout: 'ping\n', stderr: '', status: 0},
        },
        {
          operation: 'shell.exec',
          arguments: [{command: 'grep', args: ['needle'], cwd: '/workspace/sub', input: 'haystack'}],
          status: 'fulfilled',
          result: {stdout: '', stderr: 'no match', status: 1},
        },
      ],
    },
  }), {traceFormat: 'compact'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const declared = JSON.parse(exported.messages.find(m => m.role === 'tool_declare').content).map(t => t.function.name).sort();
  assert.deepEqual(declared, ['platform.randomBytes', 'shell.exec']);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.equal(comp.value.macEq, true);
  assert.equal(comp.value.pbkLen, 32);
  assert.equal(comp.value.scrLen, 32);
  assert.deepEqual(comp.value.filled, [0, 10, 20, 30, 40, 0]);
  assert.equal(comp.value.execOut, 'ping');
  assert.equal(comp.value.spawnStatus, 1);
  assert.equal(comp.value.spawnStdout, '');
  assert.equal(comp.value.spawnStderr, 'no match');
});

test('multi-file import.meta.url resolves to file:///workspace/<relPath> alongside Node built-in imports', async () => {
  const files = {
    'src/main.js': [
      "import {helperMeta} from './nested/helper.js';",
      "import path from 'node:path';",
      "import {fileURLToPath} from 'node:url';",
      'export function run() {',
      '  const myUrl = import.meta.url;',
      '  const myPath = fileURLToPath(myUrl);',
      '  const helper = helperMeta();',
      '  return {myUrl, myBase: path.basename(myPath), helper};',
      '}',
    ].join('\n'),
    'src/nested/helper.js': [
      "import {EventEmitter} from 'node:events';",
      'export function helperMeta() {',
      '  const ee = new EventEmitter();',
      '  let got = null;',
      '  ee.once("u", v => { got = v; });',
      '  ee.emit("u", import.meta.url);',
      '  return {url: got, dirname: import.meta.dirname, filename: import.meta.filename};',
      '}',
    ].join('\n'),
  };

  const exported = await exportTinkerExample({
    id: 'mf-import-meta-url',
    family: 'mf-import-meta-url',
    executionMode: 'native',
    files,
    entryFile: 'src/main.js',
    entry: 'run',
    initialLoadedFiles: ['src/main.js'],
    args: [],
  }, {traceFormat: 'compact'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  assert(exported.metadata.codeLoadCalls >= 1);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.deepEqual(comp.value, {
    myUrl: 'file:///workspace/src/main.js',
    myBase: 'main.js',
    helper: {
      url: 'file:///workspace/src/nested/helper.js',
      dirname: '/workspace/src/nested',
      filename: '/workspace/src/nested/helper.js',
    },
  });
});
