// Rich multi-turn effectful JavaScript workflow families covering all owned
// host and platform capabilities: console, clock, filesystem streams/text,
// HTTP requests/streams, network sockets, DOM nodes, sync/async state,
// Promise reactions, microtasks, and input-mutating side-effect pipelines.

export function effectfulWorkflowTemplates() {
  return [
    // --- 1. Platform Console & Clock (5 families) ---
    {
      name: 'timed-execution-audit',
      source: `function run(xs, limitMs) {
  const t0 = Date.now();
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i] * xs[i];
  const elapsed = Date.now() - t0;
  console.log('sum=' + sum + ' ms=' + elapsed);
  if (elapsed > limitMs) console.warn('slow:' + elapsed);
  return {sum, elapsed, slow: elapsed > limitMs};
}`,
      inputs: [
        [[1, 2, 3], 10],
        [[2, 4, 6], 5],
        [[], 1],
        [[5, -3, 2, 1], 10],
        [[3, 3, 3, 3], 2],
        [[10, 20], 50],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'platform'],
      tier: 4,
      fixture: i => {
        const specs = [
          [1000, 1004, 14, 10],
          [2000, 2012, 56, 5],
          [500, 500, 0, 1],
          [3000, 3015, 39, 10],
          [4000, 4001, 36, 2],
          [9000, 9060, 500, 50],
        ][i % 6];
        const [t0, t1, sum, limit] = specs;
        const elapsed = t1 - t0;
        return {calls: [
          {operation: 'platform.dateNow', arguments: [], result: t0},
          {operation: 'platform.dateNow', arguments: [], result: t1},
          {operation: 'platform.console.log', arguments: ['sum=' + sum + ' ms=' + elapsed]},
          ...(elapsed > limit ? [{operation: 'platform.console.warn', arguments: ['slow:' + elapsed]}] : []),
        ]};
      },
    },
    {
      name: 'diagnostic-console-levels',
      source: `function run(events) {
  const counts = {info: 0, warn: 0, error: 0, log: 0};
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.level === 'error') { console.error(ev.msg); counts.error++; }
    else if (ev.level === 'warn') { console.warn(ev.msg); counts.warn++; }
    else if (ev.level === 'info') { console.info(ev.msg); counts.info++; }
    else { console.log(ev.msg); counts.log++; }
  }
  return counts;
}`,
      inputs: [
        [[{level: 'info', msg: 'boot'}]],
        [[{level: 'warn', msg: 'low-mem'}, {level: 'error', msg: 'oom'}]],
        [[{level: 'log', msg: 'a'}, {level: 'info', msg: 'b'}, {level: 'warn', msg: 'c'}]],
        [[{level: 'error', msg: 'e1'}, {level: 'error', msg: 'e2'}, {level: 'info', msg: 'ok'}]],
        [[{level: 'info', msg: 's1'}, {level: 'log', msg: 's2'}, {level: 'warn', msg: 's3'}, {level: 'error', msg: 's4'}]],
        [[{level: 'warn', msg: 'retry'}, {level: 'info', msg: 'done'}]],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'object', 'platform'],
      tier: 4,
      fixture: i => {
        const lists = [
          [{level: 'info', msg: 'boot'}],
          [{level: 'warn', msg: 'low-mem'}, {level: 'error', msg: 'oom'}],
          [{level: 'log', msg: 'a'}, {level: 'info', msg: 'b'}, {level: 'warn', msg: 'c'}],
          [{level: 'error', msg: 'e1'}, {level: 'error', msg: 'e2'}, {level: 'info', msg: 'ok'}],
          [{level: 'info', msg: 's1'}, {level: 'log', msg: 's2'}, {level: 'warn', msg: 's3'}, {level: 'error', msg: 's4'}],
          [{level: 'warn', msg: 'retry'}, {level: 'info', msg: 'done'}],
        ][i % 6];
        return {calls: lists.map(ev => ({operation: 'platform.console.' + (['info', 'warn', 'error'].includes(ev.level) ? ev.level : 'log'), arguments: [ev.msg]}))};
      },
    },
    {
      name: 'clock-deadline-batch-runner',
      source: `function run(items, budgetMs) {
  const start = Date.now();
  const done = [];
  for (let i = 0; i < items.length; i++) {
    const now = Date.now();
    if (now - start >= budgetMs) {
      console.warn('deadline:' + i);
      return {completed: done, stoppedAt: i};
    }
    done.push(items[i] * 2);
  }
  console.info('all-done:' + done.length);
  return {completed: done, stoppedAt: -1};
}`,
      inputs: [
        [[1, 2], 100],
        [[3, 4, 5], 10],
        [[7, 8, 9, 10], 15],
        [[2], 5],
        [[1, 2, 3, 4], 50],
        [[6, 7, 8], 8],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [
          [[100, 110, 120], 'info', 'all-done:2'],
          [[100, 104, 111], 'warn', 'deadline:1'],
          [[200, 205, 210, 216], 'warn', 'deadline:2'],
          [[500, 506], 'warn', 'deadline:0'],
          [[1000, 1005, 1010, 1020, 1030], 'info', 'all-done:4'],
          [[300, 303, 307, 309], 'warn', 'deadline:2'],
        ][i % 6];
        const [times, lvl, msg] = specs;
        return {calls: [
          ...times.map(t => ({operation: 'platform.dateNow', arguments: [], result: t})),
          {operation: 'platform.console.' + lvl, arguments: [msg]},
        ]};
      },
    },
    {
      name: 'structured-error-reporter',
      source: `function parsePositive(raw) {
  const n = Number(raw);
  if (!(n > 0)) throw new RangeError('non-positive:' + raw);
  return n;
}
function run(raw) {
  let out = null;
  try {
    out = parsePositive(raw) * 10;
    return {ok: true, out};
  } catch (err) {
    console.error(err.name + ':' + err.message);
    return {ok: false, error: err.message};
  } finally {
    console.info('ts:' + Date.now());
  }
}`,
      inputs: [['5'], ['-2'], ['0'], ['12'], ['abc'], ['3']],
      features: ['external', 'sequential', 'exception', 'finally', 'multi-function', 'platform'],
      tier: 5,
      fixture: i => {
        const raws = ['5', '-2', '0', '12', 'abc', '3'];
        const ts = [101, 202, 303, 404, 505, 606][i % 6];
        const raw = raws[i % 6];
        const ok = Number(raw) > 0;
        return {calls: [
          ...(!ok ? [{operation: 'platform.console.error', arguments: ['RangeError:non-positive:' + raw]}] : []),
          {operation: 'platform.dateNow', arguments: [], result: ts},
          {operation: 'platform.console.info', arguments: ['ts:' + ts]},
        ]};
      },
    },
    {
      name: 'mutating-telemetry-pipeline',
      source: `function run(records) {
  const ts = Date.now();
  let flagged = 0;
  for (let i = 0; i < records.length; i++) {
    records[i].checkedAt = ts;
    if (records[i].score < 50) {
      records[i].flag = true;
      flagged++;
    }
  }
  console.log('flagged:' + flagged + '/' + records.length);
  return records;
}`,
      inputs: [
        [[{id: 'a', score: 80}]],
        [[{id: 'a', score: 30}, {id: 'b', score: 70}]],
        [[{id: 'x', score: 10}, {id: 'y', score: 20}, {id: 'z', score: 90}]],
        [[{id: 'k1', score: 50}, {id: 'k2', score: 49}]],
        [[]],
        [[{id: 'm', score: 0}, {id: 'n', score: 100}, {id: 'p', score: 45}]],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'mutation', 'alias', 'platform'],
      tier: 5,
      fixture: i => {
        const ts = [1000, 2000, 3000, 4000, 5000, 6000][i % 6];
        const counts = ['0/1', '1/2', '2/3', '1/2', '0/0', '2/3'][i % 6];
        return {calls: [
          {operation: 'platform.dateNow', arguments: [], result: ts},
          {operation: 'platform.console.log', arguments: ['flagged:' + counts]},
        ]};
      },
    },

    // --- 2. Filesystem Text & Stream I/O (6 families) ---
    {
      name: 'fs-config-loader-merge',
      source: `function parseKv(text) {
  const out = {};
  let line = '';
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\\n') {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
      line = '';
    } else line += text[i];
  }
  return out;
}
async function run(basePath, overridePath, outPath) {
  const baseText = await host.readText(basePath);
  const cfg = parseKv(baseText);
  let hadOverride = true;
  try {
    const overText = await host.readText(overridePath);
    const over = parseKv(overText);
    const keys = Object.keys(over);
    for (let i = 0; i < keys.length; i++) cfg[keys[i]] = over[keys[i]];
  } catch (err) {
    hadOverride = false;
  }
  const keys = Object.keys(cfg);
  const lines = [];
  for (let i = 0; i < keys.length; i++) lines.push(keys[i] + '=' + cfg[keys[i]]);
  await host.writeText(outPath, lines.join('\\n'));
  return {hadOverride, cfg};
}`,
      inputs: [
        ['base.env', 'local.env', 'merged.env'],
        ['a.env', 'b.env', 'c.env'],
        ['def.env', 'missing.env', 'out.env'],
        ['p.env', 'q.env', 'r.env'],
        ['x.env', 'no.env', 'y.env'],
        ['base2.env', 'over2.env', 'final.env'],
      ],
      features: ['external', 'sequential', 'loop', 'exception', 'string', 'object', 'multi-function', 'fs'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'fs.readText', arguments: ['base.env'], result: 'a=1\nb=2'}, {operation: 'fs.readText', arguments: ['local.env'], result: 'b=9\nc=3'}, {operation: 'fs.writeText', arguments: ['merged.env', 'a=1\nb=9\nc=3']}],
          [{operation: 'fs.readText', arguments: ['a.env'], result: 'mode=dev'}, {operation: 'fs.readText', arguments: ['b.env'], result: 'mode=prod'}, {operation: 'fs.writeText', arguments: ['c.env', 'mode=prod']}],
          [{operation: 'fs.readText', arguments: ['def.env'], result: 'port=8080\nhost=localhost'}, {operation: 'fs.readText', arguments: ['missing.env'], status: 'rejected', result: 'ENOENT'}, {operation: 'fs.writeText', arguments: ['out.env', 'port=8080\nhost=localhost']}],
          [{operation: 'fs.readText', arguments: ['p.env'], result: 'k=1'}, {operation: 'fs.readText', arguments: ['q.env'], result: 'm=2'}, {operation: 'fs.writeText', arguments: ['r.env', 'k=1\nm=2']}],
          [{operation: 'fs.readText', arguments: ['x.env'], result: 'v=ok'}, {operation: 'fs.readText', arguments: ['no.env'], status: 'rejected', result: 'EACCES'}, {operation: 'fs.writeText', arguments: ['y.env', 'v=ok']}],
          [{operation: 'fs.readText', arguments: ['base2.env'], result: 'x=1\ny=2\nz=3'}, {operation: 'fs.readText', arguments: ['over2.env'], result: 'y=20'}, {operation: 'fs.writeText', arguments: ['final.env', 'x=1\ny=20\nz=3']}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'fs-directory-filter-stats',
      source: `function splitCsv(s) {
  if (!s.length) return [];
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ',') { out.push(cur); cur = ''; }
    else cur += s[i];
  }
  out.push(cur);
  return out;
}
async function run(dir, suffix) {
  const listing = await host.listFiles(dir);
  const files = splitCsv(listing);
  let matched = 0, totalChars = 0;
  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    if (name.endsWith(suffix)) {
      const content = await host.readText(dir + '/' + name);
      matched++;
      totalChars += content.length;
    }
  }
  return {matched, totalChars};
}`,
      inputs: [
        ['src', '.js'],
        ['docs', '.md'],
        ['empty', '.txt'],
        ['cfg', '.json'],
        ['lib', '.ts'],
        ['logs', '.log'],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'string', 'multi-function', 'fs'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'fs.list', arguments: ['src'], result: 'a.js,b.txt,c.js'}, {operation: 'fs.readText', arguments: ['src/a.js'], result: 'let x=1;'}, {operation: 'fs.readText', arguments: ['src/c.js'], result: 'return x;'}],
          [{operation: 'fs.list', arguments: ['docs'], result: 'readme.md,logo.png'}, {operation: 'fs.readText', arguments: ['docs/readme.md'], result: '# Hello'}],
          [{operation: 'fs.list', arguments: ['empty'], result: ''}],
          [{operation: 'fs.list', arguments: ['cfg'], result: 'a.json,b.json,c.yaml'}, {operation: 'fs.readText', arguments: ['cfg/a.json'], result: '{}'}, {operation: 'fs.readText', arguments: ['cfg/b.json'], result: '{"ok":true}'}],
          [{operation: 'fs.list', arguments: ['lib'], result: 'mod.ts,util.ts,test.js'}, {operation: 'fs.readText', arguments: ['lib/mod.ts'], result: 'export const n=1;'}, {operation: 'fs.readText', arguments: ['lib/util.ts'], result: 'export const m=2;'}],
          [{operation: 'fs.list', arguments: ['logs'], result: 'app.log,err.log'}, {operation: 'fs.readText', arguments: ['logs/app.log'], result: 'start'}, {operation: 'fs.readText', arguments: ['logs/err.log'], result: 'warn!'}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'fs-stream-transform-copy',
      source: `async function run(src, dst) {
  const reader = await host.openRead(src);
  const writer = await host.openWrite(dst);
  let chunks = 0, written = 0;
  try {
    while (true) {
      const chunk = await host.readChunk(reader);
      if (chunk === '') break;
      const upper = chunk.toUpperCase();
      written += await host.writeChunk(writer, upper);
      chunks++;
    }
  } finally {
    await host.closeWrite(writer);
    await host.closeStream(reader);
  }
  return {chunks, written};
}`,
      inputs: [
        ['in1.txt', 'out1.txt'],
        ['in2.txt', 'out2.txt'],
        ['in3.txt', 'out3.txt'],
        ['empty.txt', 'out4.txt'],
        ['a.txt', 'b.txt'],
        ['c.txt', 'd.txt'],
      ],
      features: ['external', 'sequential', 'loop', 'finally', 'string', 'fs'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['in1.txt', 'out1.txt', ['hi']],
          ['in2.txt', 'out2.txt', ['ab', 'cd']],
          ['in3.txt', 'out3.txt', ['one', 'two', 'three']],
          ['empty.txt', 'out4.txt', []],
          ['a.txt', 'b.txt', ['hello ', 'world']],
          ['c.txt', 'd.txt', ['x', 'yz']],
        ][i % 6];
        const [src, dst, chunks] = specs;
        const calls = [
          {operation: 'fs.openRead', arguments: [src], result: 'r:' + i},
          {operation: 'fs.openWrite', arguments: [dst], result: 'w:' + i},
        ];
        for (const ch of chunks) {
          calls.push({operation: 'fs.readChunk', arguments: ['r:' + i], result: ch});
          calls.push({operation: 'fs.writeChunk', arguments: ['w:' + i, ch.toUpperCase()], result: ch.length});
        }
        calls.push({operation: 'fs.readChunk', arguments: ['r:' + i], result: ''});
        calls.push({operation: 'fs.closeWrite', arguments: ['w:' + i]});
        calls.push({operation: 'fs.close', arguments: ['r:' + i]});
        return {calls};
      },
    },
    {
      name: 'fs-atomic-backup-write',
      source: `async function run(path, nextContent) {
  let backedUp = false;
  try {
    const prev = await host.readText(path);
    if (prev === nextContent) return {changed: false, backedUp: false};
    await host.writeText(path + '.bak', prev);
    backedUp = true;
  } catch (err) {
    backedUp = false;
  }
  await host.writeText(path, nextContent);
  return {changed: true, backedUp};
}`,
      inputs: [
        ['app.cfg', 'v2'],
        ['app.cfg', 'v1'],
        ['new.cfg', 'init'],
        ['data.txt', 'hello'],
        ['same.txt', 'keep'],
        ['fresh.txt', 'start'],
      ],
      features: ['external', 'sequential', 'branch', 'exception', 'fs'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'fs.readText', arguments: ['app.cfg'], result: 'v1'}, {operation: 'fs.writeText', arguments: ['app.cfg.bak', 'v1']}, {operation: 'fs.writeText', arguments: ['app.cfg', 'v2']}],
          [{operation: 'fs.readText', arguments: ['app.cfg'], result: 'v1'}],
          [{operation: 'fs.readText', arguments: ['new.cfg'], status: 'rejected', result: 'ENOENT'}, {operation: 'fs.writeText', arguments: ['new.cfg', 'init']}],
          [{operation: 'fs.readText', arguments: ['data.txt'], result: 'old'}, {operation: 'fs.writeText', arguments: ['data.txt.bak', 'old']}, {operation: 'fs.writeText', arguments: ['data.txt', 'hello']}],
          [{operation: 'fs.readText', arguments: ['same.txt'], result: 'keep'}],
          [{operation: 'fs.readText', arguments: ['fresh.txt'], status: 'rejected', result: 'ENOENT'}, {operation: 'fs.writeText', arguments: ['fresh.txt', 'start']}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'fs-chunked-line-counter',
      source: `async function run(path) {
  const handle = await host.openRead(path);
  let bytes = 0, newlines = 0, failed = false;
  try {
    while (true) {
      const chunk = await host.readChunk(handle);
      if (chunk === '') break;
      bytes += chunk.length;
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === '\\n') newlines++;
    }
  } catch (err) {
    failed = true;
    console.error('read-fail:' + err);
  } finally {
    await host.closeStream(handle);
  }
  return {bytes, newlines, failed};
}`,
      inputs: [['f0'], ['f1'], ['f2'], ['f3'], ['f4'], ['f5']],
      features: ['external', 'sequential', 'loop', 'exception', 'finally', 'fs', 'platform'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'fs.openRead', arguments: ['f0'], result: 'h0'}, {operation: 'fs.readChunk', arguments: ['h0'], result: 'a\nb\n'}, {operation: 'fs.readChunk', arguments: ['h0'], result: ''}, {operation: 'fs.close', arguments: ['h0']}],
          [{operation: 'fs.openRead', arguments: ['f1'], result: 'h1'}, {operation: 'fs.readChunk', arguments: ['h1'], result: 'one'}, {operation: 'fs.readChunk', arguments: ['h1'], result: '\ntwo\n'}, {operation: 'fs.readChunk', arguments: ['h1'], result: ''}, {operation: 'fs.close', arguments: ['h1']}],
          [{operation: 'fs.openRead', arguments: ['f2'], result: 'h2'}, {operation: 'fs.readChunk', arguments: ['h2'], result: 'ok\n'}, {operation: 'fs.readChunk', arguments: ['h2'], status: 'rejected', result: 'EIO'}, {operation: 'platform.console.error', arguments: ['read-fail:EIO']}, {operation: 'fs.close', arguments: ['h2']}],
          [{operation: 'fs.openRead', arguments: ['f3'], result: 'h3'}, {operation: 'fs.readChunk', arguments: ['h3'], result: ''}, {operation: 'fs.close', arguments: ['h3']}],
          [{operation: 'fs.openRead', arguments: ['f4'], result: 'h4'}, {operation: 'fs.readChunk', arguments: ['h4'], status: 'rejected', result: 'EOF_CORRUPT'}, {operation: 'platform.console.error', arguments: ['read-fail:EOF_CORRUPT']}, {operation: 'fs.close', arguments: ['h4']}],
          [{operation: 'fs.openRead', arguments: ['f5'], result: 'h5'}, {operation: 'fs.readChunk', arguments: ['h5'], result: 'x\n'}, {operation: 'fs.readChunk', arguments: ['h5'], result: 'y\n'}, {operation: 'fs.readChunk', arguments: ['h5'], result: 'z'}, {operation: 'fs.readChunk', arguments: ['h5'], result: ''}, {operation: 'fs.close', arguments: ['h5']}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'fs-log-rotation-writer',
      source: `function splitLines(text) {
  if (!text.length) return [];
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\n') { out.push(cur); cur = ''; }
    else cur += text[i];
  }
  out.push(cur);
  return out;
}
async function run(path, entry, maxLines) {
  let prev = '';
  try { prev = await host.readText(path); } catch (e) { prev = ''; }
  const lines = splitLines(prev);
  lines.push(entry);
  const rotated = lines.length > maxLines;
  const kept = rotated ? lines.slice(lines.length - maxLines) : lines;
  await host.writeText(path, kept.join('\\n'));
  if (rotated) console.info('rotated:' + path);
  return {count: kept.length, rotated};
}`,
      inputs: [
        ['app.log', 'e3', 3],
        ['app.log', 'e4', 3],
        ['new.log', 'first', 2],
        ['sys.log', 'd', 2],
        ['run.log', 'ok', 4],
        ['err.log', 'boom', 1],
      ],
      features: ['external', 'sequential', 'branch', 'exception', 'string', 'multi-function', 'fs', 'platform'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'fs.readText', arguments: ['app.log'], result: 'e1\ne2'}, {operation: 'fs.writeText', arguments: ['app.log', 'e1\ne2\ne3']}],
          [{operation: 'fs.readText', arguments: ['app.log'], result: 'e1\ne2\ne3'}, {operation: 'fs.writeText', arguments: ['app.log', 'e2\ne3\ne4']}, {operation: 'platform.console.info', arguments: ['rotated:app.log']}],
          [{operation: 'fs.readText', arguments: ['new.log'], status: 'rejected', result: 'ENOENT'}, {operation: 'fs.writeText', arguments: ['new.log', 'first']}],
          [{operation: 'fs.readText', arguments: ['sys.log'], result: 'a\nb\nc'}, {operation: 'fs.writeText', arguments: ['sys.log', 'c\nd']}, {operation: 'platform.console.info', arguments: ['rotated:sys.log']}],
          [{operation: 'fs.readText', arguments: ['run.log'], result: 'start'}, {operation: 'fs.writeText', arguments: ['run.log', 'start\nok']}],
          [{operation: 'fs.readText', arguments: ['err.log'], result: 'old'}, {operation: 'fs.writeText', arguments: ['err.log', 'boom']}, {operation: 'platform.console.info', arguments: ['rotated:err.log']}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },

    // --- 3. HTTP Requests, Retries, Caching & Streams (6 families) ---
    {
      name: 'http-status-checked-fetch',
      source: `async function run(url) {
  const res = await host.httpRequest(url, 'GET', '{}', '');
  try {
    const status = await host.httpStatus(res);
    if (status !== 200) {
      console.warn('http-' + status);
      return {ok: false, status, body: ''};
    }
    const body = await host.httpRead(res);
    return {ok: true, status, body};
  } finally {
    await host.httpClose(res);
  }
}`,
      inputs: [
        ['https://api.test/ok'],
        ['https://api.test/missing'],
        ['https://api.test/err'],
        ['https://api.test/items'],
        ['https://api.test/auth'],
        ['https://api.test/ping'],
      ],
      features: ['external', 'sequential', 'branch', 'finally', 'http', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['https://api.test/ok', 200, '{"ok":1}'],
          ['https://api.test/missing', 404, null],
          ['https://api.test/err', 500, null],
          ['https://api.test/items', 200, '[1,2,3]'],
          ['https://api.test/auth', 401, null],
          ['https://api.test/ping', 200, 'pong'],
        ][i % 6];
        const [url, status, body] = specs;
        const h = 'http:r' + i;
        return {calls: [
          {operation: 'http.request', arguments: [url, 'GET', '{}', ''], result: h},
          {operation: 'http.responseStatus', arguments: [h], result: status},
          ...(status === 200
            ? [{operation: 'http.responseRead', arguments: [h], result: body}]
            : [{operation: 'platform.console.warn', arguments: ['http-' + status]}]),
          {operation: 'http.responseClose', arguments: [h]},
        ]};
      },
    },
    {
      name: 'http-retry-5xx-loop',
      source: `async function run(url, maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await host.httpRequest(url, 'GET', '{}', '');
    let status = 0;
    try {
      status = await host.httpStatus(res);
      if (status === 200) {
        const body = await host.httpRead(res);
        return {ok: true, attempt, body};
      }
      console.warn('retry:' + attempt + ':' + status);
    } finally {
      await host.httpClose(res);
    }
    if (status < 500) return {ok: false, attempt, status};
  }
  return {ok: false, attempt: maxRetries, status: 503};
}`,
      inputs: [
        ['https://svc.test/a', 2],
        ['https://svc.test/b', 3],
        ['https://svc.test/c', 3],
        ['https://svc.test/d', 2],
        ['https://svc.test/e', 3],
        ['https://svc.test/f', 2],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'finally', 'http', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['https://svc.test/a', [200], 'ok-a'],
          ['https://svc.test/b', [503, 200], 'ok-b'],
          ['https://svc.test/c', [503, 502, 200], 'ok-c'],
          ['https://svc.test/d', [404], null],
          ['https://svc.test/e', [503, 400], null],
          ['https://svc.test/f', [503, 503], null],
        ][i % 6];
        const [url, statuses, body] = specs;
        const calls = [];
        statuses.forEach((st, idx) => {
          const h = 'http:' + i + ':' + idx;
          calls.push({operation: 'http.request', arguments: [url, 'GET', '{}', ''], result: h});
          calls.push({operation: 'http.responseStatus', arguments: [h], result: st});
          if (st === 200) calls.push({operation: 'http.responseRead', arguments: [h], result: body});
          else calls.push({operation: 'platform.console.warn', arguments: ['retry:' + (idx + 1) + ':' + st]});
          calls.push({operation: 'http.responseClose', arguments: [h]});
        });
        return {calls};
      },
    },
    {
      name: 'http-stream-chunk-collector',
      source: `async function run(url) {
  const res = await host.httpRequest(url, 'GET', '{}', '');
  let body = '', chunks = 0;
  try {
    const status = await host.httpStatus(res);
    if (status !== 200) return {status, chunks: 0, body: ''};
    while (true) {
      const part = await host.httpReadChunk(res);
      if (part === '') break;
      body += part;
      chunks++;
    }
    return {status, chunks, body};
  } finally {
    await host.httpClose(res);
  }
}`,
      inputs: [
        ['https://stream.test/0'],
        ['https://stream.test/1'],
        ['https://stream.test/2'],
        ['https://stream.test/3'],
        ['https://stream.test/4'],
        ['https://stream.test/5'],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'finally', 'http'],
      tier: 5,
      fixture: i => {
        const specs = [
          [200, ['hello']],
          [200, ['foo', '-', 'bar']],
          [403, null],
          [200, []],
          [200, ['a', 'b', 'c', 'd']],
          [500, null],
        ][i % 6];
        const [status, parts] = specs;
        const h = 'hs:' + i;
        const calls = [
          {operation: 'http.request', arguments: ['https://stream.test/' + i, 'GET', '{}', ''], result: h},
          {operation: 'http.responseStatus', arguments: [h], result: status},
        ];
        if (status === 200) {
          for (const p of parts) calls.push({operation: 'http.responseReadChunk', arguments: [h], result: p});
          calls.push({operation: 'http.responseReadChunk', arguments: [h], result: ''});
        }
        calls.push({operation: 'http.responseClose', arguments: [h]});
        return {calls};
      },
    },
    {
      name: 'http-webhook-fanout',
      source: `async function run(urls, payload) {
  let sent = 0, failed = 0;
  const replies = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const reply = await host.httpPost(urls[i], payload);
      sent++;
      replies.push(reply);
    } catch (err) {
      failed++;
      console.error(urls[i] + ':' + err);
    }
  }
  return {sent, failed, replies};
}`,
      inputs: [
        [['https://h1.test'], 'ping'],
        [['https://h1.test', 'https://h2.test'], 'evt1'],
        [['https://a.test', 'https://b.test', 'https://c.test'], 'go'],
        [['https://fail.test'], 'x'],
        [['https://u1.test', 'https://u2.test'], 'msg'],
        [['https://k1.test', 'https://k2.test', 'https://k3.test'], 'sync'],
      ],
      features: ['external', 'sequential', 'loop', 'exception', 'http', 'platform'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'http.post', arguments: ['https://h1.test', 'ping'], result: 'ok'}],
          [{operation: 'http.post', arguments: ['https://h1.test', 'evt1'], result: '200'}, {operation: 'http.post', arguments: ['https://h2.test', 'evt1'], status: 'rejected', result: 'timeout'}, {operation: 'platform.console.error', arguments: ['https://h2.test:timeout']}],
          [{operation: 'http.post', arguments: ['https://a.test', 'go'], result: 'a'}, {operation: 'http.post', arguments: ['https://b.test', 'go'], status: 'rejected', result: '502'}, {operation: 'platform.console.error', arguments: ['https://b.test:502']}, {operation: 'http.post', arguments: ['https://c.test', 'go'], result: 'c'}],
          [{operation: 'http.post', arguments: ['https://fail.test', 'x'], status: 'rejected', result: 'refused'}, {operation: 'platform.console.error', arguments: ['https://fail.test:refused']}],
          [{operation: 'http.post', arguments: ['https://u1.test', 'msg'], result: 'r1'}, {operation: 'http.post', arguments: ['https://u2.test', 'msg'], result: 'r2'}],
          [{operation: 'http.post', arguments: ['https://k1.test', 'sync'], status: 'rejected', result: 'down'}, {operation: 'platform.console.error', arguments: ['https://k1.test:down']}, {operation: 'http.post', arguments: ['https://k2.test', 'sync'], result: 'ok2'}, {operation: 'http.post', arguments: ['https://k3.test', 'sync'], result: 'ok3'}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'http-get-cache-store',
      source: `async function run(url) {
  const cached = await host.readAsync('http:' + url);
  if (cached !== null) return {source: 'cache', body: cached};
  const body = await host.httpGet(url);
  host.store('http:' + url, body);
  return {source: 'origin', body};
}`,
      inputs: [
        ['https://cdn.test/1'],
        ['https://cdn.test/2'],
        ['https://cdn.test/3'],
        ['https://cdn.test/4'],
        ['https://cdn.test/5'],
        ['https://cdn.test/6'],
      ],
      features: ['external', 'sequential', 'branch', 'http'],
      tier: 4,
      fixture: i => {
        const url = 'https://cdn.test/' + (i + 1);
        if (i % 2 === 0) return {calls: [{operation: 'demo.readAsync', arguments: ['http:' + url], result: 'cached-' + i}]};
        return {calls: [
          {operation: 'demo.readAsync', arguments: ['http:' + url], result: null},
          {operation: 'http.get', arguments: [url], result: 'fresh-' + i},
          {operation: 'demo.store', arguments: ['http:' + url, 'fresh-' + i]},
        ]};
      },
    },
    {
      name: 'http-header-etag-check',
      source: `async function run(url, knownEtag) {
  const res = await host.httpRequest(url, 'GET', '{"if-none-match":"' + knownEtag + '"}', '');
  try {
    const status = await host.httpStatus(res);
    const hdr = await host.httpHeaders(res);
    if (status === 304) return {modified: false, headers: hdr, body: null};
    const body = await host.httpRead(res);
    return {modified: true, headers: hdr, body};
  } finally {
    await host.httpClose(res);
  }
}`,
      inputs: [
        ['https://etag.test/a', 'e1'],
        ['https://etag.test/b', 'e2'],
        ['https://etag.test/c', 'e3'],
        ['https://etag.test/d', 'e4'],
        ['https://etag.test/e', 'e5'],
        ['https://etag.test/f', 'e6'],
      ],
      features: ['external', 'sequential', 'branch', 'finally', 'http'],
      tier: 5,
      fixture: i => {
        const urls = ['a', 'b', 'c', 'd', 'e', 'f'];
        const url = 'https://etag.test/' + urls[i % 6];
        const etag = 'e' + (i + 1);
        const h = 'he:' + i;
        const notMod = i % 2 === 0;
        return {calls: [
          {operation: 'http.request', arguments: [url, 'GET', '{"if-none-match":"' + etag + '"}', ''], result: h},
          {operation: 'http.responseStatus', arguments: [h], result: notMod ? 304 : 200},
          {operation: 'http.responseHeaders', arguments: [h], result: 'etag:' + (notMod ? etag : etag + 'b')},
          ...(!notMod ? [{operation: 'http.responseRead', arguments: [h], result: 'body-' + i}] : []),
          {operation: 'http.responseClose', arguments: [h]},
        ]};
      },
    },

    // --- 4. Network Sockets (3 families) ---
    {
      name: 'socket-request-response',
      source: `async function run(hostName, port, msg) {
  const sock = await host.socketConnect(hostName, port);
  try {
    const sent = await host.socketWrite(sock, msg);
    const reply = await host.socketRead(sock);
    return {ok: true, sent, reply};
  } catch (err) {
    console.error('sock:' + err);
    return {ok: false, error: err};
  } finally {
    await host.socketClose(sock);
  }
}`,
      inputs: [
        ['db.local', 5432, 'PING'],
        ['cache.local', 6379, 'GET k'],
        ['mq.local', 5672, 'PUB x'],
        ['rpc.local', 9000, 'HELLO'],
        ['bad.local', 8080, 'REQ'],
        ['svc.local', 7000, 'STAT'],
      ],
      features: ['external', 'sequential', 'exception', 'finally', 'net', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['db.local', 5432, 'PING', 'PONG', false],
          ['cache.local', 6379, 'GET k', '42', false],
          ['mq.local', 5672, 'PUB x', 'ECONNRESET', true],
          ['rpc.local', 9000, 'HELLO', 'WORLD', false],
          ['bad.local', 8080, 'REQ', 'TIMEOUT', true],
          ['svc.local', 7000, 'STAT', 'OK:3', false],
        ][i % 6];
        const [hostName, port, msg, reply, failRead] = specs;
        const s = 's:' + i;
        return {calls: [
          {operation: 'net.connect', arguments: [hostName, port], result: s},
          {operation: 'net.write', arguments: [s, msg], result: msg.length},
          ...(failRead
            ? [{operation: 'net.read', arguments: [s], status: 'rejected', result: reply}, {operation: 'platform.console.error', arguments: ['sock:' + reply]}]
            : [{operation: 'net.read', arguments: [s], result: reply}]),
          {operation: 'net.close', arguments: [s]},
        ]};
      },
    },
    {
      name: 'socket-multi-command-session',
      source: `async function run(addr, port, cmds) {
  const sock = await host.socketConnect(addr, port);
  const replies = [];
  let aborted = false;
  try {
    for (let i = 0; i < cmds.length; i++) {
      await host.socketWrite(sock, cmds[i]);
      const reply = await host.socketRead(sock);
      replies.push(reply);
      if (reply === 'ERR') { aborted = true; break; }
    }
  } finally {
    await host.socketClose(sock);
  }
  return {replies, aborted};
}`,
      inputs: [
        ['s1', 9001, ['A']],
        ['s2', 9002, ['A', 'B']],
        ['s3', 9003, ['A', 'B', 'C']],
        ['s4', 9004, ['X', 'Y', 'Z']],
        ['s5', 9005, ['INIT', 'AUTH', 'GET']],
        ['s6', 9006, ['ONE', 'TWO']],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'finally', 'net'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['s1', 9001, [['A', 'OK']]],
          ['s2', 9002, [['A', 'OK'], ['B', 'DONE']]],
          ['s3', 9003, [['A', 'OK'], ['B', 'ERR']]],
          ['s4', 9004, [['X', 'ERR']]],
          ['s5', 9005, [['INIT', '1'], ['AUTH', '2'], ['GET', '3']]],
          ['s6', 9006, [['ONE', 'OK'], ['TWO', 'ERR']]],
        ][i % 6];
        const [addr, port, pairs] = specs;
        const s = 'sm:' + i;
        const calls = [{operation: 'net.connect', arguments: [addr, port], result: s}];
        for (const [cmd, rep] of pairs) {
          calls.push({operation: 'net.write', arguments: [s, cmd], result: cmd.length});
          calls.push({operation: 'net.read', arguments: [s], result: rep});
        }
        calls.push({operation: 'net.close', arguments: [s]});
        return {calls};
      },
    },
    {
      name: 'socket-healthcheck-probe',
      source: `async function run(targets) {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      const sock = await host.socketConnect(t.host, t.port);
      try {
        await host.socketWrite(sock, 'PING');
        const rep = await host.socketRead(sock);
        if (rep === 'PONG') return {healthy: t.host, checked: i + 1};
      } finally {
        await host.socketClose(sock);
      }
    } catch (err) {
      console.warn('down:' + t.host);
    }
  }
  return {healthy: null, checked: targets.length};
}`,
      inputs: [
        [[{host: 'n1', port: 80}]],
        [[{host: 'n1', port: 80}, {host: 'n2', port: 80}]],
        [[{host: 'a', port: 90}, {host: 'b', port: 90}, {host: 'c', port: 90}]],
        [[{host: 'x', port: 70}, {host: 'y', port: 70}]],
        [[{host: 'p1', port: 60}, {host: 'p2', port: 60}]],
        [[{host: 'd1', port: 50}, {host: 'd2', port: 50}]],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'exception', 'finally', 'net', 'platform'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'net.connect', arguments: ['n1', 80], result: 'p0'}, {operation: 'net.write', arguments: ['p0', 'PING'], result: 4}, {operation: 'net.read', arguments: ['p0'], result: 'PONG'}, {operation: 'net.close', arguments: ['p0']}],
          [{operation: 'net.connect', arguments: ['n1', 80], status: 'rejected', result: 'ECONNREFUSED'}, {operation: 'platform.console.warn', arguments: ['down:n1']}, {operation: 'net.connect', arguments: ['n2', 80], result: 'p1'}, {operation: 'net.write', arguments: ['p1', 'PING'], result: 4}, {operation: 'net.read', arguments: ['p1'], result: 'PONG'}, {operation: 'net.close', arguments: ['p1']}],
          [{operation: 'net.connect', arguments: ['a', 90], result: 'pa'}, {operation: 'net.write', arguments: ['pa', 'PING'], result: 4}, {operation: 'net.read', arguments: ['pa'], result: 'BUSY'}, {operation: 'net.close', arguments: ['pa']}, {operation: 'net.connect', arguments: ['b', 90], status: 'rejected', result: 'DOWN'}, {operation: 'platform.console.warn', arguments: ['down:b']}, {operation: 'net.connect', arguments: ['c', 90], result: 'pc'}, {operation: 'net.write', arguments: ['pc', 'PING'], result: 4}, {operation: 'net.read', arguments: ['pc'], result: 'PONG'}, {operation: 'net.close', arguments: ['pc']}],
          [{operation: 'net.connect', arguments: ['x', 70], status: 'rejected', result: 'NO'}, {operation: 'platform.console.warn', arguments: ['down:x']}, {operation: 'net.connect', arguments: ['y', 70], status: 'rejected', result: 'NO'}, {operation: 'platform.console.warn', arguments: ['down:y']}],
          [{operation: 'net.connect', arguments: ['p1', 60], result: 'pp1'}, {operation: 'net.write', arguments: ['pp1', 'PING'], result: 4}, {operation: 'net.read', arguments: ['pp1'], result: 'PONG'}, {operation: 'net.close', arguments: ['pp1']}],
          [{operation: 'net.connect', arguments: ['d1', 50], result: 'pd1'}, {operation: 'net.write', arguments: ['pd1', 'PING'], result: 4}, {operation: 'net.read', arguments: ['pd1'], result: 'NOPE'}, {operation: 'net.close', arguments: ['pd1']}, {operation: 'net.connect', arguments: ['d2', 50], result: 'pd2'}, {operation: 'net.write', arguments: ['pd2', 'PING'], result: 4}, {operation: 'net.read', arguments: ['pd2'], result: 'NOPE'}, {operation: 'net.close', arguments: ['pd2']}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },

    // --- 5. DOM Query & Mutation Workflows (4 families) ---
    {
      name: 'dom-counter-increment',
      source: `async function run(selector, delta) {
  const node = await host.domQuery(selector);
  try {
    const current = Number(await host.domGetText(node));
    const next = current + delta;
    await host.domSetText(node, String(next));
    await host.domSetAttribute(node, 'data-count', String(next));
    return {previous: current, next};
  } finally {
    await host.domRelease(node);
  }
}`,
      inputs: [
        ['#count', 1],
        ['#likes', 5],
        ['#score', -2],
        ['#total', 10],
        ['#badge', 0],
        ['#qty', 3],
      ],
      features: ['external', 'sequential', 'finally', 'dom'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['#count', 1, '4'],
          ['#likes', 5, '10'],
          ['#score', -2, '7'],
          ['#total', 10, '0'],
          ['#badge', 0, '3'],
          ['#qty', 3, '9'],
        ][i % 6];
        const [sel, delta, cur] = specs;
        const next = String(Number(cur) + delta);
        const h = 'dom:' + i;
        return {calls: [
          {operation: 'dom.query', arguments: [sel], result: h},
          {operation: 'dom.getText', arguments: [h], result: cur},
          {operation: 'dom.setText', arguments: [h, next]},
          {operation: 'dom.setAttribute', arguments: [h, 'data-count', next]},
          {operation: 'dom.release', arguments: [h]},
        ]};
      },
    },
    {
      name: 'dom-state-sync-or-remove',
      source: `async function run(selector) {
  const node = await host.domQuery(selector);
  try {
    const state = await host.domGetAttribute(node, 'data-state');
    if (state === 'obsolete') {
      await host.domRemove(node);
      return 'removed';
    }
    const next = state === 'pending' ? 'active' : 'done';
    await host.domSetAttribute(node, 'data-state', next);
    await host.domSetText(node, 'state:' + next);
    return next;
  } finally {
    await host.domRelease(node);
  }
}`,
      inputs: [['#n0'], ['#n1'], ['#n2'], ['#n3'], ['#n4'], ['#n5']],
      features: ['external', 'sequential', 'branch', 'finally', 'dom'],
      tier: 5,
      fixture: i => {
        const states = ['pending', 'obsolete', 'active', 'pending', 'obsolete', 'ready'];
        const st = states[i % 6];
        const h = 'ds:' + i;
        const calls = [
          {operation: 'dom.query', arguments: ['#n' + i], result: h},
          {operation: 'dom.getAttribute', arguments: [h, 'data-state'], result: st},
        ];
        if (st === 'obsolete') calls.push({operation: 'dom.remove', arguments: [h]});
        else {
          const next = st === 'pending' ? 'active' : 'done';
          calls.push({operation: 'dom.setAttribute', arguments: [h, 'data-state', next]});
          calls.push({operation: 'dom.setText', arguments: [h, 'state:' + next]});
        }
        calls.push({operation: 'dom.release', arguments: [h]});
        return {calls};
      },
    },
    {
      name: 'dom-diff-batch-updater',
      source: `async function run(updates) {
  let changed = 0, skipped = 0;
  for (let i = 0; i < updates.length; i++) {
    const [sel, want] = updates[i];
    const node = await host.domQuery(sel);
    try {
      const cur = await host.domGetText(node);
      if (cur !== want) {
        await host.domSetText(node, want);
        changed++;
      } else skipped++;
    } finally {
      await host.domRelease(node);
    }
  }
  return {changed, skipped};
}`,
      inputs: [
        [[['#a', 'hi']]],
        [[['#a', 'hi'], ['#b', 'yo']]],
        [[['#x', '1'], ['#y', '2'], ['#z', '3']]],
        [[['#t', 'same']]],
        [[['#p', 'new'], ['#q', 'keep']]],
        [[['#k1', 'v1'], ['#k2', 'v2']]],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'finally', 'dom'],
      tier: 5,
      fixture: i => {
        const plans = [
          [['#a', 'old', 'hi']],
          [['#a', 'hi', 'hi'], ['#b', 'old', 'yo']],
          [['#x', '0', '1'], ['#y', '2', '2'], ['#z', '0', '3']],
          [['#t', 'same', 'same']],
          [['#p', 'old', 'new'], ['#q', 'keep', 'keep']],
          [['#k1', 'x', 'v1'], ['#k2', 'y', 'v2']],
        ][i % 6];
        const calls = [];
        plans.forEach(([sel, cur, want], idx) => {
          const h = 'du:' + i + ':' + idx;
          calls.push({operation: 'dom.query', arguments: [sel], result: h});
          calls.push({operation: 'dom.getText', arguments: [h], result: cur});
          if (cur !== want) calls.push({operation: 'dom.setText', arguments: [h, want]});
          calls.push({operation: 'dom.release', arguments: [h]});
        });
        return {calls};
      },
    },
    {
      name: 'dom-form-validator-render',
      source: `function validateForm(form) {
  if (!form.name || form.name.length < 2) return 'short-name';
  if (form.age < 0 || form.age > 150) return 'bad-age';
  return 'ok';
}
async function run(form) {
  const status = validateForm(form);
  const valid = status === 'ok';
  const banner = await host.domQuery('#status');
  try {
    await host.domSetText(banner, valid ? 'Saved:' + form.name : 'Error:' + status);
    await host.domSetAttribute(banner, 'data-valid', valid ? 'true' : 'false');
    console.log('form:' + status);
  } finally {
    await host.domRelease(banner);
  }
  return {valid, status};
}`,
      inputs: [
        [{name: 'Ada', age: 36}],
        [{name: 'A', age: 20}],
        [{name: 'Bob', age: -5}],
        [{name: 'Grace', age: 85}],
        [{name: '', age: 10}],
        [{name: 'Lin', age: 200}],
      ],
      features: ['external', 'sequential', 'branch', 'finally', 'multi-function', 'dom', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [
          [true, 'ok', 'Saved:Ada'],
          [false, 'short-name', 'Error:short-name'],
          [false, 'bad-age', 'Error:bad-age'],
          [true, 'ok', 'Saved:Grace'],
          [false, 'short-name', 'Error:short-name'],
          [false, 'bad-age', 'Error:bad-age'],
        ][i % 6];
        const [valid, status, text] = specs;
        const h = 'df:' + i;
        return {calls: [
          {operation: 'dom.query', arguments: ['#status'], result: h},
          {operation: 'dom.setText', arguments: [h, text]},
          {operation: 'dom.setAttribute', arguments: [h, 'data-valid', valid ? 'true' : 'false']},
          {operation: 'platform.console.log', arguments: ['form:' + status]},
          {operation: 'dom.release', arguments: [h]},
        ]};
      },
    },

    // --- 6. Sync/Async State, Promises, Microtasks & Input Mutation (6 families) ---
    {
      name: 'sync-read-mutate-store',
      source: `function run(state, keys) {
  for (let i = 0; i < keys.length; i++) {
    const val = host.readNumber(keys[i]);
    state.total += val;
    state.seen.push(val);
  }
  host.store('total', state.total);
  return state;
}`,
      inputs: [
        [{total: 0, seen: []}, ['a']],
        [{total: 10, seen: [10]}, ['a', 'b']],
        [{total: 5, seen: []}, ['k1', 'k2', 'k3']],
        [{total: -3, seen: []}, ['x', 'y']],
        [{total: 0, seen: []}, []],
        [{total: 1, seen: [1]}, ['m', 'n', 'p']],
      ],
      features: ['external', 'sequential', 'loop', 'mutation', 'alias', 'object'],
      tier: 5,
      fixture: i => {
        const specs = [
          [0, [['a', 4]]],
          [10, [['a', 3], ['b', 7]]],
          [5, [['k1', 1], ['k2', 2], ['k3', 3]]],
          [-3, [['x', 8], ['y', -2]]],
          [0, []],
          [1, [['m', 5], ['n', 0], ['p', 4]]],
        ][i % 6];
        const [init, pairs] = specs;
        let total = init;
        const calls = [];
        for (const [k, v] of pairs) {
          calls.push({operation: 'demo.readNumber', arguments: [k], result: v});
          total += v;
        }
        calls.push({operation: 'demo.store', arguments: ['total', total]});
        return {calls};
      },
    },
    {
      name: 'promise-chain-recovery',
      source: `async function run(key, fallback) {
  return await host.readAsync(key)
    .then(function(v) {
      host.store('ok:' + key, v * 2);
      return v * 2;
    }, function(err) {
      host.store('err:' + key, err);
      return fallback;
    })
    .finally(function() {
      host.store('done:' + key, 1);
    });
}`,
      inputs: [
        ['k1', 0],
        ['k2', -1],
        ['k3', 9],
        ['k4', 5],
        ['k5', 100],
        ['k6', 42],
      ],
      features: ['external', 'sequential', 'promise', 'exception', 'finally'],
      tier: 5,
      fixture: i => {
        const key = 'k' + (i + 1);
        const rejected = i % 2 === 1;
        return {calls: [
          {operation: 'demo.readAsync', arguments: [key], status: rejected ? 'rejected' : 'fulfilled', result: rejected ? 'miss-' + i : (i + 3)},
          rejected
            ? {operation: 'demo.store', arguments: ['err:' + key, 'miss-' + i]}
            : {operation: 'demo.store', arguments: ['ok:' + key, (i + 3) * 2]},
          {operation: 'demo.store', arguments: ['done:' + key, 1]},
        ]};
      },
    },
    {
      name: 'microtask-ordered-effects',
      source: `function run(label, n) {
  let acc = n;
  queueMicrotask(function() {
    host.store('micro:' + label, acc);
  });
  acc = acc * 3;
  console.log('sync:' + label + ':' + acc);
  host.store('sync:' + label, acc);
  return acc;
}`,
      inputs: [
        ['a', 2],
        ['b', 5],
        ['c', 0],
        ['d', -4],
        ['e', 7],
        ['f', 11],
      ],
      features: ['external', 'sequential', 'microtask', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [['a', 2], ['b', 5], ['c', 0], ['d', -4], ['e', 7], ['f', 11]][i % 6];
        const [label, n] = specs;
        const acc = n * 3;
        return {calls: [
          {operation: 'platform.console.log', arguments: ['sync:' + label + ':' + acc]},
          {operation: 'demo.store', arguments: ['sync:' + label, acc]},
          {operation: 'demo.store', arguments: ['micro:' + label, acc]},
        ]};
      },
    },
    {
      name: 'stateful-account-transfer',
      source: `function run(audit, from, to, amount) {
  const src = host.readNumber('bal:' + from);
  const dst = host.readNumber('bal:' + to);
  if (amount <= 0 || src < amount) {
    audit.push({from, to, amount, ok: false});
    console.warn('reject:' + from);
    return {ok: false, src, dst};
  }
  const nextSrc = src - amount, nextDst = dst + amount;
  host.store('bal:' + from, nextSrc);
  host.store('bal:' + to, nextDst);
  audit.push({from, to, amount, ok: true});
  console.info('tx:' + amount);
  return {ok: true, src: nextSrc, dst: nextDst};
}`,
      inputs: [
        [[], 'a', 'b', 20],
        [[], 'a', 'b', 90],
        [[], 'x', 'y', 0],
        [[{prev: 1}], 'u1', 'u2', 15],
        [[], 'm', 'n', 50],
        [[], 'p', 'q', 100],
      ],
      features: ['external', 'sequential', 'branch', 'mutation', 'alias', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['a', 'b', 20, 50, 10],
          ['a', 'b', 90, 50, 10],
          ['x', 'y', 0, 30, 5],
          ['u1', 'u2', 15, 25, 0],
          ['m', 'n', 50, 50, 5],
          ['p', 'q', 100, 40, 20],
        ][i % 6];
        const [from, to, amt, src, dst] = specs;
        const ok = amt > 0 && src >= amt;
        return {calls: [
          {operation: 'demo.readNumber', arguments: ['bal:' + from], result: src},
          {operation: 'demo.readNumber', arguments: ['bal:' + to], result: dst},
          ...(ok ? [
            {operation: 'demo.store', arguments: ['bal:' + from, src - amt]},
            {operation: 'demo.store', arguments: ['bal:' + to, dst + amt]},
            {operation: 'platform.console.info', arguments: ['tx:' + amt]},
          ] : [
            {operation: 'platform.console.warn', arguments: ['reject:' + from]},
          ]),
        ]};
      },
    },
    {
      name: 'circuit-breaker-dispatcher',
      source: `async function run(service, threshold) {
  const fails = host.readNumber('cb:' + service);
  if (fails >= threshold) {
    console.warn('open:' + service);
    return {state: 'open', value: null, fails};
  }
  try {
    const value = await host.readAsync('rpc:' + service);
    if (fails > 0) host.store('cb:' + service, 0);
    return {state: 'closed', value, fails: 0};
  } catch (err) {
    const nextFails = fails + 1;
    host.store('cb:' + service, nextFails);
    console.error('fail:' + service + ':' + nextFails);
    return {state: nextFails >= threshold ? 'tripped' : 'closed', value: null, fails: nextFails};
  }
}`,
      inputs: [
        ['auth', 3],
        ['pay', 3],
        ['inv', 2],
        ['mail', 3],
        ['geo', 2],
        ['pdf', 4],
      ],
      features: ['external', 'sequential', 'branch', 'exception', 'platform'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'demo.readNumber', arguments: ['cb:auth'], result: 0}, {operation: 'demo.readAsync', arguments: ['rpc:auth'], result: 'tok'}],
          [{operation: 'demo.readNumber', arguments: ['cb:pay'], result: 3}, {operation: 'platform.console.warn', arguments: ['open:pay']}],
          [{operation: 'demo.readNumber', arguments: ['cb:inv'], result: 1}, {operation: 'demo.readAsync', arguments: ['rpc:inv'], result: 42}, {operation: 'demo.store', arguments: ['cb:inv', 0]}],
          [{operation: 'demo.readNumber', arguments: ['cb:mail'], result: 1}, {operation: 'demo.readAsync', arguments: ['rpc:mail'], status: 'rejected', result: 'timeout'}, {operation: 'demo.store', arguments: ['cb:mail', 2]}, {operation: 'platform.console.error', arguments: ['fail:mail:2']}],
          [{operation: 'demo.readNumber', arguments: ['cb:geo'], result: 1}, {operation: 'demo.readAsync', arguments: ['rpc:geo'], status: 'rejected', result: 'err'}, {operation: 'demo.store', arguments: ['cb:geo', 2]}, {operation: 'platform.console.error', arguments: ['fail:geo:2']}],
          [{operation: 'demo.readNumber', arguments: ['cb:pdf'], result: 4}, {operation: 'platform.console.warn', arguments: ['open:pdf']}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'config-driven-pipeline-mutation',
      source: `async function run(items) {
  const mode = await host.readAsync('pipeline:mode');
  const factor = await host.readAsync('pipeline:factor');
  let checksum = 0;
  for (let i = 0; i < items.length; i++) {
    const v = items[i].v;
    const next = mode === 'mul' ? v * factor : v + factor;
    items[i].v = next;
    items[i].tag = mode;
    checksum += next;
  }
  const ts = Date.now();
  console.log(mode + ':' + checksum + '@' + ts);
  host.store('pipeline:checksum', checksum);
  return items;
}`,
      inputs: [
        [[{v: 2}, {v: 5}]],
        [[{v: 3}, {v: 4}, {v: 1}]],
        [[{v: 10}]],
        [[{v: -2}, {v: 6}, {v: 0}]],
        [[{v: 1}, {v: 2}, {v: 3}, {v: 4}]],
        [[]],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'mutation', 'alias', 'platform'],
      tier: 5,
      fixture: i => {
        const specs = [
          ['mul', 3, 21, 1001],
          ['add', 10, 38, 1002],
          ['mul', 5, 50, 1003],
          ['add', -1, 1, 1004],
          ['mul', 2, 20, 1005],
          ['add', 7, 0, 1006],
        ][i % 6];
        const [mode, factor, checksum, ts] = specs;
        return {calls: [
          {operation: 'demo.readAsync', arguments: ['pipeline:mode'], result: mode},
          {operation: 'demo.readAsync', arguments: ['pipeline:factor'], result: factor},
          {operation: 'platform.dateNow', arguments: [], result: ts},
          {operation: 'platform.console.log', arguments: [mode + ':' + checksum + '@' + ts]},
          {operation: 'demo.store', arguments: ['pipeline:checksum', checksum]},
        ]};
      },
    },
  ];
}
