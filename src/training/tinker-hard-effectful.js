// Hard multi-turn effectful native-V8 messy workflow suite.
// 16 distinct realistic families x 5 parameterized instances = 80 tier-5 tasks.
// Targets our exact remaining failure modes: Date.now(), Math.random() (tool mode),
// host HTTP/FS operations, KV native bindings, console logging, try/catch rejections,
// RegExp/URL/JSON/structuredClone, and input mutations/aliasing (3-18 external calls/task).

import {encodeReadable} from './tinker-execution.js';
import {nearCloneHash} from './tinker-benchmark.js';

const natCall = (name, args, result, extra = {}) => ({
  operation: 'natlang.call',
  arguments: [name, undefined, args],
  result,
  ...extra,
});

const dateCall = ts => ({operation: 'platform.dateNow', arguments: [], result: ts});
const randCall = r => ({operation: 'platform.random', arguments: [], result: r});
const logCall = (level, msg) => ({operation: 'platform.console.' + level, arguments: [msg], result: undefined});
const httpReq = (url, method, headers, body, result, extra = {}) => ({
  operation: 'http.request',
  arguments: [url, method, headers, body],
  result,
  ...extra,
});
const httpGet = (url, result, extra = {}) => ({
  operation: 'http.get',
  arguments: [url],
  result,
  ...extra,
});
const fsRead = (path, result, extra = {}) => ({
  operation: 'fs.readText',
  arguments: [path],
  result,
  ...extra,
});
const fsWrite = (path, text) => ({
  operation: 'fs.writeText',
  arguments: [path, text],
  result: undefined,
});

export function hardEffectfulTemplates() {
  return [
    // =========================================================================
    // 1. deadline-bounded-diff-scan
    // Iterative edit-distance / Myers-style scan checking Date.now() every pass
    // =========================================================================
    {
      name: 'deadline-bounded-diff-scan',
      source: `function run(left, right, deadlineMs) {
  const start = Date.now();
  const n = left.length, m = right.length;
  const maxD = n + m;
  let frontier = new Map([[0, 0]]);
  let passes = 0;
  for (let d = 0; d <= maxD; d++) {
    const now = Date.now();
    const elapsed = now - start;
    if (elapsed >= deadlineMs) {
      console.warn('diff-timeout:d=' + d + ':ms=' + elapsed);
      return {timedOut: true, edits: null, passes, elapsed};
    }
    passes++;
    const next = new Map();
    for (const [k, x0] of frontier.entries()) {
      let x = x0, y = x - k;
      while (x < n && y < m && left[x] === right[y]) { x++; y++; }
      if (x === n && y === m) {
        return {timedOut: false, edits: d, passes, elapsed};
      }
      if (x < n) {
        const kDel = k + 1;
        if (!next.has(kDel) || x + 1 > next.get(kDel)) next.set(kDel, x + 1);
      }
      if (y < m) {
        const kIns = k - 1;
        if (!next.has(kIns) || x > next.get(kIns)) next.set(kIns, x);
      }
    }
    frontier = next;
  }
  const elapsed = Date.now() - start;
  return {timedOut: false, edits: maxD, passes, elapsed};
}`,
      inputs: [
        [['a', 'b', 'c'], ['a', 'x', 'c'], 50],
        [['a', 'b', 'c', 'd'], ['w', 'x', 'y', 'z'], 25],
        [['k', 'i', 't'], ['s', 'i', 't'], 100],
        [['p', 'q', 'r', 's'], ['p', 'r', 't'], 15],
        [['x', 'y'], ['x', 'y', 'z', 'w'], 80],
      ],
      features: ['loop', 'branch', 'map', 'platform', 'deadline'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // edits=2 (delete 'b', insert 'x'), passes d=0,1,2 -> 4 dateNow calls
          return {calls: [dateCall(1000), dateCall(1004), dateCall(1009), dateCall(1014)]};
        }
        if (i === 1) {
          // timeout at d=2 (elapsed=28 >= 25) -> 4 dateNow + 1 warn = 5 calls
          return {calls: [dateCall(2000), dateCall(2008), dateCall(2019), dateCall(2028), logCall('warn', 'diff-timeout:d=2:ms=28')]};
        }
        if (i === 2) {
          // edits=2 (k->s = del+ins), passes d=0,1,2 -> 4 dateNow calls
          return {calls: [dateCall(3000), dateCall(3005), dateCall(3012), dateCall(3021)]};
        }
        if (i === 3) {
          // timeout at d=3 (elapsed=17 >= 15); edits for pqrs->prt is 3 (del q, del s, ins t)
          return {calls: [dateCall(4000), dateCall(4004), dateCall(4009), dateCall(4013), dateCall(4017), logCall('warn', 'diff-timeout:d=3:ms=17')]};
        }
        // i === 4: edits=2 (ins z, ins w), passes d=0,1,2 -> 4 dateNow calls
        return {calls: [dateCall(5000), dateCall(5007), dateCall(5015), dateCall(5022)]};
      },
    },

    // =========================================================================
    // 2. jittered-backoff-retry-client
    // Async http.get retry loop with Math.random() full-jitter + Date.now() budget
    // =========================================================================
    {
      name: 'jittered-backoff-retry-client',
      randomMode: 'tool',
      source: `async function run(url, cfg) {
  const start = Date.now();
  const delays = [];
  let lastErr = null;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    const elapsed = Date.now() - start;
    if (elapsed > cfg.budgetMs) {
      console.error('budget-exceeded:' + attempt + ':' + elapsed);
      return {ok: false, attempts: attempt, delays, error: 'budget-exceeded'};
    }
    try {
      const body = await host.httpGet(url + '?try=' + attempt);
      const parsed = JSON.parse(body);
      return {ok: true, attempts: attempt + 1, delays, data: parsed};
    } catch (err) {
      lastErr = String(err);
      if (attempt < cfg.maxRetries) {
        const cap = Math.min(cfg.maxDelay, cfg.baseDelay * (1 << attempt));
        const delay = Math.floor(Math.random() * cap);
        delays.push(delay);
        console.warn('retry:' + attempt + ':delay=' + delay + ':' + lastErr);
      }
    }
  }
  console.error('exhausted:' + lastErr);
  return {ok: false, attempts: cfg.maxRetries + 1, delays, error: lastErr};
}`,
      inputs: [
        ['https://api.test/orders', {maxRetries: 2, baseDelay: 100, maxDelay: 500, budgetMs: 1000}],
        ['https://api.test/users', {maxRetries: 3, baseDelay: 50, maxDelay: 300, budgetMs: 800}],
        ['https://api.test/ledger', {maxRetries: 2, baseDelay: 80, maxDelay: 200, budgetMs: 120}],
        ['https://api.test/items', {maxRetries: 1, baseDelay: 60, maxDelay: 200, budgetMs: 500}],
        ['https://api.test/health', {maxRetries: 2, baseDelay: 40, maxDelay: 100, budgetMs: 400}],
      ],
      features: ['loop', 'branch', 'exception', 'http', 'platform', 'random', 'json'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // fail 0 (cap=100, r=0.35 -> 35), succeed 1
          return {calls: [
            dateCall(1000),
            dateCall(1010), httpGet('https://api.test/orders?try=0', '503', {status: 'rejected'}),
            randCall(0.35), logCall('warn', 'retry:0:delay=35:503'),
            dateCall(1060), httpGet('https://api.test/orders?try=1', '{"id":7,"ok":true}'),
          ]};
        }
        if (i === 1) {
          // fail 0 (cap=50, r=0.5 -> 25), fail 1 (cap=100, r=0.72 -> 72), succeed 2
          return {calls: [
            dateCall(2000),
            dateCall(2005), httpGet('https://api.test/users?try=0', 'timeout', {status: 'rejected'}),
            randCall(0.5), logCall('warn', 'retry:0:delay=25:timeout'),
            dateCall(2050), httpGet('https://api.test/users?try=1', '502', {status: 'rejected'}),
            randCall(0.72), logCall('warn', 'retry:1:delay=72:502'),
            dateCall(2140), httpGet('https://api.test/users?try=2', '{"count":3}'),
          ]};
        }
        if (i === 2) {
          // fail 0 (cap=80, r=0.25 -> 20), attempt 1 exceeds budget (150 > 120)
          return {calls: [
            dateCall(3000),
            dateCall(3010), httpGet('https://api.test/ledger?try=0', 'reset', {status: 'rejected'}),
            randCall(0.25), logCall('warn', 'retry:0:delay=20:reset'),
            dateCall(3150), logCall('error', 'budget-exceeded:1:150'),
          ]};
        }
        if (i === 3) {
          // fail 0 (cap=60, r=0.5 -> 30), fail 1 -> exhausted
          return {calls: [
            dateCall(4000),
            dateCall(4010), httpGet('https://api.test/items?try=0', 'econnrefused', {status: 'rejected'}),
            randCall(0.5), logCall('warn', 'retry:0:delay=30:econnrefused'),
            dateCall(4055), httpGet('https://api.test/items?try=1', '500', {status: 'rejected'}),
            logCall('error', 'exhausted:500'),
          ]};
        }
        // i === 4: fail 0 (cap=40, r=0.6 -> 24), fail 1 (cap=80, r=0.1 -> 8), succeed 2
        return {calls: [
          dateCall(5000),
          dateCall(5005), httpGet('https://api.test/health?try=0', 'busy', {status: 'rejected'}),
          randCall(0.6), logCall('warn', 'retry:0:delay=24:busy'),
          dateCall(5040), httpGet('https://api.test/health?try=1', 'busy', {status: 'rejected'}),
          randCall(0.1), logCall('warn', 'retry:1:delay=8:busy'),
          dateCall(5070), httpGet('https://api.test/health?try=2', '{"status":"up"}'),
        ]};
      },
    },

    // =========================================================================
    // 3. token-bucket-rate-limiter
    // Calls Date.now() per event to refill tokens, mutates input bucket, calls http.request
    // =========================================================================
    {
      name: 'token-bucket-rate-limiter',
      source: `async function run(bucket, events) {
  const results = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const now = Date.now();
    const dt = Math.max(0, now - bucket.lastTs);
    bucket.tokens = Math.min(bucket.cap, bucket.tokens + dt * bucket.rate);
    bucket.lastTs = now;
    if (bucket.tokens < ev.cost) {
      bucket.dropped++;
      console.warn('drop:' + ev.id + ':have=' + bucket.tokens);
      results.push({id: ev.id, ok: false, status: 429});
      continue;
    }
    bucket.tokens -= ev.cost;
    bucket.sent++;
    const reply = await host.httpRequest(ev.url, 'POST', '{"x-req":"' + ev.id + '"}', JSON.stringify({cost: ev.cost}));
    results.push({id: ev.id, ok: true, status: 200, reply});
  }
  return {results, bucket};
}`,
      inputs: [
        [{cap: 10, tokens: 6, rate: 1, lastTs: 100, sent: 0, dropped: 0}, [{id: 'e1', url: 'https://gw.test/a', cost: 4}, {id: 'e2', url: 'https://gw.test/b', cost: 6}, {id: 'e3', url: 'https://gw.test/c', cost: 3}]],
        [{cap: 8, tokens: 2, rate: 2, lastTs: 200, sent: 0, dropped: 0}, [{id: 'r1', url: 'https://gw.test/x', cost: 5}, {id: 'r2', url: 'https://gw.test/y', cost: 4}, {id: 'r3', url: 'https://gw.test/z', cost: 3}]],
        [{cap: 12, tokens: 12, rate: 1, lastTs: 500, sent: 0, dropped: 0}, [{id: 'k1', url: 'https://gw.test/1', cost: 7}, {id: 'k2', url: 'https://gw.test/2', cost: 8}, {id: 'k3', url: 'https://gw.test/3', cost: 5}]],
        [{cap: 5, tokens: 1, rate: 1, lastTs: 1000, sent: 0, dropped: 0}, [{id: 'm1', url: 'https://gw.test/m', cost: 4}, {id: 'm2', url: 'https://gw.test/n', cost: 4}, {id: 'm3', url: 'https://gw.test/o', cost: 2}]],
        [{cap: 10, tokens: 0, rate: 2, lastTs: 300, sent: 0, dropped: 0}, [{id: 'p1', url: 'https://gw.test/p', cost: 5}, {id: 'p2', url: 'https://gw.test/q', cost: 5}, {id: 'p3', url: 'https://gw.test/r', cost: 4}]],
      ],
      features: ['loop', 'branch', 'mutation', 'alias', 'http', 'platform', 'json'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // t=102: tok=min(10,8)=8 >=4 -> rem=4, send e1
          // t=103: tok=min(10,5)=5 <6 -> drop e2 (have=5)
          // t=104: tok=min(10,6)=6 >=3 -> rem=3, send e3
          return {calls: [
            dateCall(102), httpReq('https://gw.test/a', 'POST', '{"x-req":"e1"}', '{"cost":4}', 'ok-e1'),
            dateCall(103), logCall('warn', 'drop:e2:have=5'),
            dateCall(104), httpReq('https://gw.test/c', 'POST', '{"x-req":"e3"}', '{"cost":3}', 'ok-e3'),
          ]};
        }
        if (i === 1) {
          // t=201: tok=min(8,4)=4 <5 -> drop r1 (have=4)
          // t=202: tok=min(8,6)=6 >=4 -> rem=2, send r2
          // t=203: tok=min(8,4)=4 >=3 -> rem=1, send r3
          return {calls: [
            dateCall(201), logCall('warn', 'drop:r1:have=4'),
            dateCall(202), httpReq('https://gw.test/y', 'POST', '{"x-req":"r2"}', '{"cost":4}', 'ok-r2'),
            dateCall(203), httpReq('https://gw.test/z', 'POST', '{"x-req":"r3"}', '{"cost":3}', 'ok-r3'),
          ]};
        }
        if (i === 2) {
          // t=500: tok=12 >=7 -> rem=5, send k1
          // t=501: tok=6 <8 -> drop k2 (have=6)
          // t=502: tok=7 >=5 -> rem=2, send k3
          return {calls: [
            dateCall(500), httpReq('https://gw.test/1', 'POST', '{"x-req":"k1"}', '{"cost":7}', 'ok-1'),
            dateCall(501), logCall('warn', 'drop:k2:have=6'),
            dateCall(502), httpReq('https://gw.test/3', 'POST', '{"x-req":"k3"}', '{"cost":5}', 'ok-3'),
          ]};
        }
        if (i === 3) {
          // t=1001: tok=2 <4 -> drop m1 (have=2)
          // t=1005: tok=min(5,6)=5 >=4 -> rem=1, send m2
          // t=1006: tok=2 >=2 -> rem=0, send m3
          return {calls: [
            dateCall(1001), logCall('warn', 'drop:m1:have=2'),
            dateCall(1005), httpReq('https://gw.test/n', 'POST', '{"x-req":"m2"}', '{"cost":4}', 'ok-n'),
            dateCall(1006), httpReq('https://gw.test/o', 'POST', '{"x-req":"m3"}', '{"cost":2}', 'ok-o'),
          ]};
        }
        // i === 4:
        // t=303: tok=6 >=5 -> rem=1, send p1
        // t=304: tok=3 <5 -> drop p2 (have=3)
        // t=306: tok=7 >=4 -> rem=3, send p3
        return {calls: [
          dateCall(303), httpReq('https://gw.test/p', 'POST', '{"x-req":"p1"}', '{"cost":5}', 'ok-p1'),
          dateCall(304), logCall('warn', 'drop:p2:have=3'),
          dateCall(306), httpReq('https://gw.test/r', 'POST', '{"x-req":"p3"}', '{"cost":4}', 'ok-p3'),
        ]};
      },
    },

    // =========================================================================
    // 4. ttl-lru-cache-engine
    // Cache-aside with Date.now() TTL checks + kv_get/kv_set + in-place mutation/aliasing
    // =========================================================================
    {
      name: 'ttl-lru-cache-engine',
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Read backing KV record {val, ttl} or null.'},
        {name: 'kv_set', kind: 'promise', description: 'Write record {val, exp} to backing KV store.'},
      ],
      source: `async function run(cache, ops) {
  function touch(k) {
    const idx = cache.order.indexOf(k);
    if (idx >= 0) cache.order.splice(idx, 1);
    cache.order.push(k);
  }
  function putLocal(k, entry) {
    const existed = Object.hasOwn(cache.entries, k);
    cache.entries[k] = entry;
    touch(k);
    if (!existed && cache.order.length > cache.maxSize) {
      const ev = cache.order.shift();
      delete cache.entries[ev];
      cache.stats.evicts++;
      console.info('evict:' + ev);
    }
  }
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const now = Date.now();
    if (op.type === 'set') {
      const entry = {val: op.val, exp: now + op.ttl};
      await kv_set(op.key, entry);
      putLocal(op.key, entry);
      out.push({op: 'set', key: op.key, ok: true});
    } else if (op.type === 'get') {
      const cur = cache.entries[op.key];
      if (cur && now < cur.exp) {
        cache.stats.hits++;
        touch(op.key);
        out.push({op: 'get', key: op.key, hit: true, val: cur.val});
      } else {
        if (cur) {
          delete cache.entries[op.key];
          const idx = cache.order.indexOf(op.key);
          if (idx >= 0) cache.order.splice(idx, 1);
          cache.stats.expired++;
        }
        cache.stats.misses++;
        const remote = await kv_get(op.key);
        if (remote !== null) {
          putLocal(op.key, {val: remote.val, exp: now + remote.ttl});
          out.push({op: 'get', key: op.key, hit: false, val: remote.val});
        } else {
          out.push({op: 'get', key: op.key, hit: false, val: null});
        }
      }
    }
  }
  return {out, cache};
}`,
      inputs: [
        [{maxSize: 2, entries: {}, order: [], stats: {hits: 0, misses: 0, expired: 0, evicts: 0}}, [{type: 'get', key: 'a'}, {type: 'get', key: 'a'}, {type: 'set', key: 'b', val: 2, ttl: 50}, {type: 'get', key: 'c'}]],
        [{maxSize: 2, entries: {x: {val: 10, exp: 120}}, order: ['x'], stats: {hits: 0, misses: 0, expired: 0, evicts: 0}}, [{type: 'get', key: 'x'}, {type: 'get', key: 'x'}, {type: 'set', key: 'y', val: 20, ttl: 40}]],
        [{maxSize: 1, entries: {}, order: [], stats: {hits: 0, misses: 0, expired: 0, evicts: 0}}, [{type: 'set', key: 'k1', val: 'v1', ttl: 30}, {type: 'get', key: 'k1'}, {type: 'set', key: 'k2', val: 'v2', ttl: 30}]],
        [{maxSize: 2, entries: {p: {val: 1, exp: 500}, q: {val: 2, exp: 500}}, order: ['p', 'q'], stats: {hits: 0, misses: 0, expired: 0, evicts: 0}}, [{type: 'get', key: 'p'}, {type: 'get', key: 'r'}, {type: 'get', key: 'q'}]],
        [{maxSize: 2, entries: {}, order: [], stats: {hits: 0, misses: 0, expired: 0, evicts: 0}}, [{type: 'get', key: 'm'}, {type: 'set', key: 'n', val: 7, ttl: 10}, {type: 'get', key: 'n'}]],
      ],
      features: ['loop', 'branch', 'mutation', 'alias', 'native-bindings', 'platform'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // get a (t=100, miss->kv_get->val=1,ttl=50, order=[a])
          // get a (t=110 < 150, hit, order=[a])
          // set b (t=120 -> kv_set b {val:2,exp:170}, order=[a,b])
          // get c (t=130, miss->kv_get->val=3,ttl=50, evict a, order=[b,c])
          return {calls: [
            dateCall(100), natCall('kv_get', ['a'], {val: 1, ttl: 50}),
            dateCall(110),
            dateCall(120), natCall('kv_set', ['b', {val: 2, exp: 170}], true),
            dateCall(130), natCall('kv_get', ['c'], {val: 3, ttl: 50}), logCall('info', 'evict:a'),
          ]};
        }
        if (i === 1) {
          // get x (t=110 < 120, hit)
          // get x (t=125 >= 120, expired+miss -> kv_get -> {val:11,ttl:50})
          // set y (t=130 -> kv_set y {val:20,exp:170})
          return {calls: [
            dateCall(110),
            dateCall(125), natCall('kv_get', ['x'], {val: 11, ttl: 50}),
            dateCall(130), natCall('kv_set', ['y', {val: 20, exp: 170}], true),
          ]};
        }
        if (i === 2) {
          // set k1 (t=200), get k1 (t=210, hit), set k2 (t=220, evict k1)
          return {calls: [
            dateCall(200), natCall('kv_set', ['k1', {val: 'v1', exp: 230}], true),
            dateCall(210),
            dateCall(220), natCall('kv_set', ['k2', {val: 'v2', exp: 250}], true), logCall('info', 'evict:k1'),
          ]};
        }
        if (i === 3) {
          // get p (t=400, hit -> order=[q,p])
          // get r (t=410, miss->kv_get->{val:3,ttl:90} -> evict q, order=[p,r])
          // get q (t=420, miss->kv_get->null)
          return {calls: [
            dateCall(400),
            dateCall(410), natCall('kv_get', ['r'], {val: 3, ttl: 90}), logCall('info', 'evict:q'),
            dateCall(420), natCall('kv_get', ['q'], null),
          ]};
        }
        // i === 4: get m (t=500, miss->null), set n (t=510, exp=520), get n (t=525 >= 520, expired -> kv_get -> {val:8,ttl:20})
        return {calls: [
          dateCall(500), natCall('kv_get', ['m'], null),
          dateCall(510), natCall('kv_set', ['n', {val: 7, exp: 520}], true),
          dateCall(525), natCall('kv_get', ['n'], {val: 8, ttl: 20}),
        ]};
      },
    },

    // =========================================================================
    // 5. lease-fencing-worker-pool
    // Acquires leases with Date.now() expiry, renews via kv_set, catches stale-fence
    // =========================================================================
    {
      name: 'lease-fencing-worker-pool',
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Read current lease {owner, fence, exp} or null.'},
        {name: 'kv_set', kind: 'promise', description: 'Write lease {owner, fence, exp}; may reject with stale-fence.'},
      ],
      source: `async function run(workerId, leaseTtl, jobs) {
  const outcomes = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const key = 'lease:' + job.resource;
    const now = Date.now();
    const cur = await kv_get(key);
    if (cur && cur.owner !== workerId && now < cur.exp) {
      console.info('held:' + job.resource + ':' + cur.owner);
      outcomes.push({id: job.id, status: 'skipped', owner: cur.owner});
      continue;
    }
    const fence = cur ? cur.fence + 1 : 1;
    try {
      await kv_set(key, {owner: workerId, fence, exp: now + leaseTtl});
    } catch (err) {
      console.warn('acquire-fail:' + job.id + ':' + err);
      outcomes.push({id: job.id, status: 'aborted', reason: String(err)});
      continue;
    }
    console.info('acquired:' + job.id + ':fence=' + fence);
    if (job.needsRenew) {
      const renewAt = Date.now();
      try {
        await kv_set(key, {owner: workerId, fence, exp: renewAt + leaseTtl});
        console.info('renewed:' + job.id + ':fence=' + fence);
      } catch (err) {
        console.warn('renew-fail:' + job.id + ':' + err);
        outcomes.push({id: job.id, status: 'lost-lease', fence, reason: String(err)});
        continue;
      }
    }
    outcomes.push({id: job.id, status: 'done', fence});
  }
  return outcomes;
}`,
      inputs: [
        ['w1', 100, [{id: 'j1', resource: 'db', needsRenew: true}, {id: 'j2', resource: 'cache', needsRenew: false}]],
        ['w2', 50, [{id: 'j1', resource: 'idx', needsRenew: true}, {id: 'j2', resource: 'log', needsRenew: false}]],
        ['w3', 80, [{id: 'j1', resource: 'q0', needsRenew: false}, {id: 'j2', resource: 'q1', needsRenew: true}]],
        ['w1', 60, [{id: 'j1', resource: 's1', needsRenew: true}, {id: 'j2', resource: 's2', needsRenew: false}]],
        ['w4', 40, [{id: 'j1', resource: 't1', needsRenew: false}, {id: 'j2', resource: 't2', needsRenew: true}]],
      ],
      features: ['loop', 'branch', 'exception', 'native-bindings', 'platform'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // j1: null -> acquire fence=1 -> renew ok; j2: held by w9 until 500 (now=150) -> skip
          return {calls: [
            dateCall(100), natCall('kv_get', ['lease:db'], null),
            natCall('kv_set', ['lease:db', {owner: 'w1', fence: 1, exp: 200}], true),
            logCall('info', 'acquired:j1:fence=1'),
            dateCall(140), natCall('kv_set', ['lease:db', {owner: 'w1', fence: 1, exp: 240}], true),
            logCall('info', 'renewed:j1:fence=1'),
            dateCall(150), natCall('kv_get', ['lease:cache'], {owner: 'w9', fence: 3, exp: 500}),
            logCall('info', 'held:cache:w9'),
          ]};
        }
        if (i === 1) {
          // j1: expired lease (exp=180 <= 200) -> fence=5 -> renew rejects stale-fence
          // j2: null -> acquire fence=1 ok
          return {calls: [
            dateCall(200), natCall('kv_get', ['lease:idx'], {owner: 'w1', fence: 4, exp: 180}),
            natCall('kv_set', ['lease:idx', {owner: 'w2', fence: 5, exp: 250}], true),
            logCall('info', 'acquired:j1:fence=5'),
            dateCall(230), natCall('kv_set', ['lease:idx', {owner: 'w2', fence: 5, exp: 280}], 'stale-fence', {status: 'rejected'}),
            logCall('warn', 'renew-fail:j1:stale-fence'),
            dateCall(240), natCall('kv_get', ['lease:log'], null),
            natCall('kv_set', ['lease:log', {owner: 'w2', fence: 1, exp: 290}], true),
            logCall('info', 'acquired:j2:fence=1'),
          ]};
        }
        if (i === 2) {
          // j1: acquire rejects cas-conflict; j2: same owner w3 -> fence=3 -> renew ok
          return {calls: [
            dateCall(300), natCall('kv_get', ['lease:q0'], null),
            natCall('kv_set', ['lease:q0', {owner: 'w3', fence: 1, exp: 380}], 'cas-conflict', {status: 'rejected'}),
            logCall('warn', 'acquire-fail:j1:cas-conflict'),
            dateCall(310), natCall('kv_get', ['lease:q1'], {owner: 'w3', fence: 2, exp: 350}),
            natCall('kv_set', ['lease:q1', {owner: 'w3', fence: 3, exp: 390}], true),
            logCall('info', 'acquired:j2:fence=3'),
            dateCall(340), natCall('kv_set', ['lease:q1', {owner: 'w3', fence: 3, exp: 420}], true),
            logCall('info', 'renewed:j2:fence=3'),
          ]};
        }
        if (i === 3) {
          // j1: held by w2 (now=400 < 450) -> skip; j2: expired -> acquire fence=2 ok
          return {calls: [
            dateCall(400), natCall('kv_get', ['lease:s1'], {owner: 'w2', fence: 1, exp: 450}),
            logCall('info', 'held:s1:w2'),
            dateCall(410), natCall('kv_get', ['lease:s2'], {owner: 'w9', fence: 1, exp: 405}),
            natCall('kv_set', ['lease:s2', {owner: 'w1', fence: 2, exp: 470}], true),
            logCall('info', 'acquired:j2:fence=2'),
          ]};
        }
        // i === 4: j1: null -> acquire ok; j2: expired -> acquire fence=7 -> renew rejects fence-revoked
        return {calls: [
          dateCall(500), natCall('kv_get', ['lease:t1'], null),
          natCall('kv_set', ['lease:t1', {owner: 'w4', fence: 1, exp: 540}], true),
          logCall('info', 'acquired:j1:fence=1'),
          dateCall(510), natCall('kv_get', ['lease:t2'], {owner: 'w0', fence: 6, exp: 500}),
          natCall('kv_set', ['lease:t2', {owner: 'w4', fence: 7, exp: 550}], true),
          logCall('info', 'acquired:j2:fence=7'),
          dateCall(535), natCall('kv_set', ['lease:t2', {owner: 'w4', fence: 7, exp: 575}], 'fence-revoked', {status: 'rejected'}),
          logCall('warn', 'renew-fail:j2:fence-revoked'),
        ]};
      },
    },

    // =========================================================================
    // 6. streaming-ndjson-paginator
    // Paginated http.request cursor loop parsing NDJSON + RegExp + dedup + aliased stats
    // =========================================================================
    {
      name: 'streaming-ndjson-paginator',
      source: `async function run(baseUrl, startCursor, stats) {
  let cursor = startCursor;
  const seen = new Set();
  const items = [];
  const idRe = /^evt_([a-z0-9]+)$/i;
  while (cursor !== null) {
    const raw = await host.httpRequest(baseUrl + '?cursor=' + cursor, 'GET', '{"accept":"application/x-ndjson"}', '');
    stats.pages++;
    const lines = raw.split('\\n');
    let nextCursor = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_err) {
        stats.badLines++;
        console.warn('bad-json:' + cursor + ':' + i);
        continue;
      }
      if (obj.next !== undefined) {
        nextCursor = obj.next;
        continue;
      }
      const m = typeof obj.id === 'string' ? idRe.exec(obj.id) : null;
      if (!m) {
        stats.badIds++;
        console.warn('bad-id:' + String(obj.id));
        continue;
      }
      if (seen.has(obj.id)) {
        stats.dups++;
        continue;
      }
      seen.add(obj.id);
      items.push({code: m[1].toLowerCase(), val: obj.v});
      stats.kept++;
    }
    cursor = nextCursor;
  }
  return {items, stats};
}`,
      inputs: [
        ['https://feed.test/ev', 'p0', {pages: 0, kept: 0, dups: 0, badLines: 0, badIds: 0}],
        ['https://feed.test/ev', 'c0', {pages: 0, kept: 0, dups: 0, badLines: 0, badIds: 0}],
        ['https://feed.test/stream', 's0', {pages: 0, kept: 0, dups: 0, badLines: 0, badIds: 0}],
        ['https://feed.test/log', 'a0', {pages: 0, kept: 0, dups: 0, badLines: 0, badIds: 0}],
        ['https://feed.test/out', 'k0', {pages: 0, kept: 0, dups: 0, badLines: 0, badIds: 0}],
      ],
      features: ['loop', 'branch', 'exception', 'regexp', 'json', 'set', 'mutation', 'alias', 'http', 'platform'],
      tier: 5,
      fixture: i => {
        const hdr = '{"accept":"application/x-ndjson"}';
        if (i === 0) {
          return {calls: [
            httpReq('https://feed.test/ev?cursor=p0', 'GET', hdr, '', '{"id":"evt_A1","v":10}\n{broken\n{"next":"p1"}'),
            logCall('warn', 'bad-json:p0:1'),
            httpReq('https://feed.test/ev?cursor=p1', 'GET', hdr, '', '{"id":"evt_A1","v":10}\n{"id":"evt_B2","v":20}\n{"next":null}'),
          ]};
        }
        if (i === 1) {
          return {calls: [
            httpReq('https://feed.test/ev?cursor=c0', 'GET', hdr, '', '{"id":"bad-1","v":1}\n{"id":"evt_01","v":5}\n{"next":"c1"}'),
            logCall('warn', 'bad-id:bad-1'),
            httpReq('https://feed.test/ev?cursor=c1', 'GET', hdr, '', '{"id":"evt_02","v":9}\n{"next":"c2"}'),
            httpReq('https://feed.test/ev?cursor=c2', 'GET', hdr, '', '{"id":"evt_01","v":5}\n{"id":"evt_03","v":12}'),
          ]};
        }
        if (i === 2) {
          return {calls: [
            httpReq('https://feed.test/stream?cursor=s0', 'GET', hdr, '', '{"id":"evt_x1","v":3}\n\nnot-json\n{"next":"s1"}'),
            logCall('warn', 'bad-json:s0:2'),
            httpReq('https://feed.test/stream?cursor=s1', 'GET', hdr, '', '{"id":"nope","v":0}\n{"id":"evt_x2","v":8}'),
            logCall('warn', 'bad-id:nope'),
          ]};
        }
        if (i === 3) {
          return {calls: [
            httpReq('https://feed.test/log?cursor=a0', 'GET', hdr, '', '{"id":"evt_m1","v":1}\n{"next":"a1"}'),
            httpReq('https://feed.test/log?cursor=a1', 'GET', hdr, '', '{"id":"evt_m2","v":2}\n{"next":"a2"}'),
            httpReq('https://feed.test/log?cursor=a2', 'GET', hdr, '', '{"id":"evt_m3","v":3}\n{bad'),
            logCall('warn', 'bad-json:a2:1'),
          ]};
        }
        return {calls: [
          httpReq('https://feed.test/out?cursor=k0', 'GET', hdr, '', '{"id":"evt_Z9","v":4}\n{"id":"bad","v":1}\n{"next":"k1"}'),
          logCall('warn', 'bad-id:bad'),
          httpReq('https://feed.test/out?cursor=k1', 'GET', hdr, '', '{"id":"evt_Z9","v":4}\n{"id":"evt_Q0","v":7}\n{"next":null}'),
        ]};
      },
    },

    // =========================================================================
    // 7. transactional-wal-compactor
    // Reads WAL segments via fs.readText, handles corrupt JSON with console.error,
    // stamps Date.now(), writes compacted snapshot via fs.writeText
    // =========================================================================
    {
      name: 'transactional-wal-compactor',
      source: `async function run(segments, outPath) {
  const store = {};
  let applied = 0, corrupt = 0;
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const text = await host.readText(seg);
    const lines = text.split('\\n');
    for (let j = 0; j < lines.length; j++) {
      const raw = lines[j].trim();
      if (!raw) continue;
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch (_err) {
        corrupt++;
        console.error('corrupt:' + seg + ':' + j);
        continue;
      }
      if (rec.op === 'PUT') {
        store[rec.k] = rec.v;
        applied++;
      } else if (rec.op === 'DEL') {
        delete store[rec.k];
        applied++;
      }
    }
  }
  const ts = Date.now();
  const keys = Object.keys(store).sort();
  const ordered = {};
  for (let i = 0; i < keys.length; i++) ordered[keys[i]] = store[keys[i]];
  const snapshot = {compactedAt: ts, applied, corrupt, data: ordered};
  await host.writeText(outPath, JSON.stringify(snapshot));
  return snapshot;
}`,
      inputs: [
        [['wal-0.log', 'wal-1.log'], 'snap-0.json'],
        [['seg-a.log', 'seg-b.log'], 'snap-1.json'],
        [['w0.log', 'w1.log', 'w2.log'], 'snap-2.json'],
        [['j1.log', 'j2.log'], 'snap-3.json'],
        [['s1.log', 's2.log'], 'snap-4.json'],
      ],
      features: ['loop', 'branch', 'exception', 'json', 'fs', 'platform', 'mutation'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          const snap = '{"compactedAt":1700001000,"applied":3,"corrupt":1,"data":{"a":1,"c":3}}';
          return {calls: [
            fsRead('wal-0.log', '{"op":"PUT","k":"a","v":1}\n{"op":"PUT","k":"b","v":2}'),
            fsRead('wal-1.log', '{truncated\n{"op":"DEL","k":"b"}\n{"op":"PUT","k":"c","v":3}'),
            logCall('error', 'corrupt:wal-1.log:0'),
            dateCall(1700001000),
            fsWrite('snap-0.json', '{"compactedAt":1700001000,"applied":4,"corrupt":1,"data":{"a":1,"c":3}}'),
          ]};
        }
        if (i === 1) {
          return {calls: [
            fsRead('seg-a.log', '{"op":"PUT","k":"x","v":10}\nBAD\n{"op":"PUT","k":"y","v":20}'),
            logCall('error', 'corrupt:seg-a.log:1'),
            fsRead('seg-b.log', '{"op":"PUT","k":"x","v":15}\n{"op":"DEL","k":"y"}'),
            dateCall(1700002000),
            fsWrite('snap-1.json', '{"compactedAt":1700002000,"applied":4,"corrupt":1,"data":{"x":15}}'),
          ]};
        }
        if (i === 2) {
          return {calls: [
            fsRead('w0.log', '{"op":"PUT","k":"k2","v":2}'),
            fsRead('w1.log', '{"op":"PUT","k":"k1","v":1}\n{err'),
            logCall('error', 'corrupt:w1.log:1'),
            fsRead('w2.log', '{"op":"PUT","k":"k3","v":3}'),
            dateCall(1700003000),
            fsWrite('snap-2.json', '{"compactedAt":1700003000,"applied":3,"corrupt":1,"data":{"k1":1,"k2":2,"k3":3}}'),
          ]};
        }
        if (i === 3) {
          return {calls: [
            fsRead('j1.log', '{"op":"PUT","k":"m","v":"ok"}\n{"op":"PUT","k":"n","v":"tmp"}'),
            fsRead('j2.log', '{"op":"DEL","k":"n"}\n{"op":"DEL","k":"missing"}'),
            dateCall(1700004000),
            fsWrite('snap-3.json', '{"compactedAt":1700004000,"applied":4,"corrupt":0,"data":{"m":"ok"}}'),
          ]};
        }
        return {calls: [
          fsRead('s1.log', '{bad1\n{"op":"PUT","k":"p","v":7}'),
          logCall('error', 'corrupt:s1.log:0'),
          fsRead('s2.log', '{bad2\n{"op":"PUT","k":"q","v":9}'),
          logCall('error', 'corrupt:s2.log:0'),
          dateCall(1700005000),
          fsWrite('snap-4.json', '{"compactedAt":1700005000,"applied":2,"corrupt":2,"data":{"p":7,"q":9}}'),
        ]};
      },
    },

    // =========================================================================
    // 8. weighted-reservoir-sampler
    // Messy Math.random() Fisher-Yates + weighted draw over objects preserving aliasing
    // =========================================================================
    {
      name: 'weighted-reservoir-sampler',
      randomMode: 'tool',
      source: `function run(items, k) {
  // Partial Fisher-Yates shuffle in place, then weighted top-k tagger preserving aliases
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  const pool = items.slice();
  const selected = [];
  for (let pick = 0; pick < k && pool.length > 0; pick++) {
    let totalW = 0;
    for (let i = 0; i < pool.length; i++) totalW += pool[i].w;
    let target = Math.random() * totalW;
    let chosenIdx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      target -= pool[i].w;
      if (target < 0) { chosenIdx = i; break; }
    }
    const chosen = pool.splice(chosenIdx, 1)[0];
    chosen.picked = true;
    chosen.rank = pick + 1;
    selected.push(chosen);
  }
  console.info('picked:' + selected.length);
  return {selected, count: selected.length};
}`,
      inputs: [
        [[{id: 'a', w: 1}, {id: 'b', w: 3}, {id: 'c', w: 6}], 2],
        [[{id: 'x', w: 2}, {id: 'y', w: 2}, {id: 'z', w: 4}, {id: 'w', w: 2}], 2],
        [[{id: 'p', w: 5}, {id: 'q', w: 1}, {id: 'r', w: 4}], 1],
        [[{id: 'n1', w: 3}, {id: 'n2', w: 7}, {id: 'n3', w: 5}, {id: 'n4', w: 5}], 3],
        [[{id: 'u', w: 4}, {id: 'v', w: 6}, {id: 't', w: 10}], 2],
      ],
      features: ['loop', 'branch', 'mutation', 'alias', 'random', 'platform'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // 2 shuffle randoms + 2 weighted randoms + 1 info = 5 calls
          return {calls: [randCall(0.5), randCall(0.2), randCall(0.6), randCall(0.25), logCall('info', 'picked:2')]};
        }
        if (i === 1) {
          // 3 shuffle + 2 weighted + 1 info = 6 calls
          return {calls: [randCall(0.75), randCall(0.1), randCall(0.9), randCall(0.3), randCall(0.8), logCall('info', 'picked:2')]};
        }
        if (i === 2) {
          // 2 shuffle + 1 weighted + 1 info = 4 calls
          return {calls: [randCall(0.1), randCall(0.8), randCall(0.55), logCall('info', 'picked:1')]};
        }
        if (i === 3) {
          // 3 shuffle + 3 weighted + 1 info = 7 calls
          return {calls: [randCall(0.2), randCall(0.6), randCall(0.4), randCall(0.15), randCall(0.7), randCall(0.5), logCall('info', 'picked:3')]};
        }
        // i === 4: 2 shuffle + 2 weighted + 1 info = 5 calls
        return {calls: [randCall(0.9), randCall(0.4), randCall(0.25), randCall(0.85), logCall('info', 'picked:2')]};
      },
    },

    // =========================================================================
    // 9. circuit-breaker-half-open-clock
    // CLOSED -> OPEN -> HALF_OPEN -> CLOSED across http.request calls with Date.now()
    // =========================================================================
    {
      name: 'circuit-breaker-half-open-clock',
      source: `async function run(breaker, requests) {
  function transition(next) {
    if (breaker.state !== next) {
      console.warn('cb:' + breaker.state + '->' + next);
      breaker.state = next;
    }
  }
  const results = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const now = Date.now();
    if (breaker.state === 'OPEN') {
      if (now - breaker.openedAt >= breaker.cooldownMs) {
        transition('HALF_OPEN');
      } else {
        results.push({id: req.id, ok: false, skipped: true});
        continue;
      }
    }
    try {
      const body = await host.httpRequest(req.url, 'GET', '{"x-cb":"' + breaker.state + '"}', '');
      breaker.failures = 0;
      if (breaker.state === 'HALF_OPEN') transition('CLOSED');
      results.push({id: req.id, ok: true, body});
    } catch (err) {
      breaker.failures++;
      if (breaker.state === 'HALF_OPEN' || breaker.failures >= breaker.threshold) {
        breaker.openedAt = now;
        transition('OPEN');
      }
      results.push({id: req.id, ok: false, error: String(err)});
    }
  }
  return {results, breaker};
}`,
      inputs: [
        [{state: 'CLOSED', failures: 0, threshold: 2, cooldownMs: 50, openedAt: 0}, [{id: 'r1', url: 'https://svc.test/1'}, {id: 'r2', url: 'https://svc.test/2'}, {id: 'r3', url: 'https://svc.test/3'}, {id: 'r4', url: 'https://svc.test/4'}]],
        [{state: 'CLOSED', failures: 1, threshold: 2, cooldownMs: 30, openedAt: 0}, [{id: 'a1', url: 'https://svc.test/a'}, {id: 'a2', url: 'https://svc.test/b'}, {id: 'a3', url: 'https://svc.test/c'}]],
        [{state: 'OPEN', failures: 2, threshold: 2, cooldownMs: 40, openedAt: 100}, [{id: 'b1', url: 'https://svc.test/x'}, {id: 'b2', url: 'https://svc.test/y'}, {id: 'b3', url: 'https://svc.test/z'}]],
        [{state: 'CLOSED', failures: 0, threshold: 1, cooldownMs: 20, openedAt: 0}, [{id: 'c1', url: 'https://svc.test/m'}, {id: 'c2', url: 'https://svc.test/n'}, {id: 'c3', url: 'https://svc.test/o'}]],
        [{state: 'HALF_OPEN', failures: 2, threshold: 2, cooldownMs: 25, openedAt: 200}, [{id: 'd1', url: 'https://svc.test/p'}, {id: 'd2', url: 'https://svc.test/q'}, {id: 'd3', url: 'https://svc.test/r'}]],
      ],
      features: ['loop', 'branch', 'exception', 'mutation', 'alias', 'http', 'platform'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // r1 fail (f=1), r2 fail (f=2 -> OPEN at 110), r3 at 130 (skip), r4 at 165 (>=50 -> HALF_OPEN -> ok -> CLOSED)
          return {calls: [
            dateCall(100), httpReq('https://svc.test/1', 'GET', '{"x-cb":"CLOSED"}', '', '500', {status: 'rejected'}),
            dateCall(110), httpReq('https://svc.test/2', 'GET', '{"x-cb":"CLOSED"}', '', '502', {status: 'rejected'}),
            logCall('warn', 'cb:CLOSED->OPEN'),
            dateCall(130),
            dateCall(165), logCall('warn', 'cb:OPEN->HALF_OPEN'),
            httpReq('https://svc.test/4', 'GET', '{"x-cb":"HALF_OPEN"}', '', 'ok-4'),
            logCall('warn', 'cb:HALF_OPEN->CLOSED'),
          ]};
        }
        if (i === 1) {
          // a1 fail (f=2 -> OPEN at 200), a2 at 235 -> HALF_OPEN -> fail -> OPEN at 235, a3 at 250 -> skip
          return {calls: [
            dateCall(200), httpReq('https://svc.test/a', 'GET', '{"x-cb":"CLOSED"}', '', 'err', {status: 'rejected'}),
            logCall('warn', 'cb:CLOSED->OPEN'),
            dateCall(235), logCall('warn', 'cb:OPEN->HALF_OPEN'),
            httpReq('https://svc.test/b', 'GET', '{"x-cb":"HALF_OPEN"}', '', 'still-down', {status: 'rejected'}),
            logCall('warn', 'cb:HALF_OPEN->OPEN'),
            dateCall(250),
          ]};
        }
        if (i === 2) {
          // b1 at 120 -> skip; b2 at 140 -> HALF_OPEN -> ok -> CLOSED; b3 at 150 -> CLOSED -> ok
          return {calls: [
            dateCall(120),
            dateCall(140), logCall('warn', 'cb:OPEN->HALF_OPEN'),
            httpReq('https://svc.test/y', 'GET', '{"x-cb":"HALF_OPEN"}', '', 'ok-y'),
            logCall('warn', 'cb:HALF_OPEN->CLOSED'),
            dateCall(150), httpReq('https://svc.test/z', 'GET', '{"x-cb":"CLOSED"}', '', 'ok-z'),
          ]};
        }
        if (i === 3) {
          // c1 fail (f=1>=1 -> OPEN at 300), c2 at 320 -> HALF_OPEN -> ok -> CLOSED, c3 at 330 -> fail -> OPEN
          return {calls: [
            dateCall(300), httpReq('https://svc.test/m', 'GET', '{"x-cb":"CLOSED"}', '', 'timeout', {status: 'rejected'}),
            logCall('warn', 'cb:CLOSED->OPEN'),
            dateCall(320), logCall('warn', 'cb:OPEN->HALF_OPEN'),
            httpReq('https://svc.test/n', 'GET', '{"x-cb":"HALF_OPEN"}', '', 'ok-n'),
            logCall('warn', 'cb:HALF_OPEN->CLOSED'),
            dateCall(330), httpReq('https://svc.test/o', 'GET', '{"x-cb":"CLOSED"}', '', '503', {status: 'rejected'}),
            logCall('warn', 'cb:CLOSED->OPEN'),
          ]};
        }
        // i === 4: d1 HALF_OPEN ok -> CLOSED; d2 CLOSED ok; d3 CLOSED fail (f=1 < 2 stays CLOSED)
        return {calls: [
          dateCall(250), httpReq('https://svc.test/p', 'GET', '{"x-cb":"HALF_OPEN"}', '', 'ok-p'),
          logCall('warn', 'cb:HALF_OPEN->CLOSED'),
          dateCall(260), httpReq('https://svc.test/q', 'GET', '{"x-cb":"CLOSED"}', '', 'ok-q'),
          dateCall(270), httpReq('https://svc.test/r', 'GET', '{"x-cb":"CLOSED"}', '', 'err-r', {status: 'rejected'}),
        ]};
      },
    },

    // =========================================================================
    // 10. webhook-dedup-hmac-dispatcher
    // new URL + RegExp header check + kv_get/kv_set dedup + Date.now() + console.log
    // =========================================================================
    {
      name: 'webhook-dedup-hmac-dispatcher',
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Check whether webhook ID was already delivered.'},
        {name: 'kv_set', kind: 'promise', description: 'Record webhook delivery metadata by ID.'},
      ],
      source: `async function run(events) {
  const sigRe = /^sha256=([0-9a-f]{8,})$/;
  const summary = {delivered: 0, duplicate: 0, rejected: 0, items: []};
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    let parsedUrl;
    try {
      parsedUrl = new URL(ev.url);
    } catch (_err) {
      console.warn('bad-url:' + ev.id);
      summary.rejected++;
      summary.items.push({id: ev.id, status: 'bad-url'});
      continue;
    }
    if (parsedUrl.protocol !== 'https:' || !sigRe.test(ev.sig)) {
      console.warn('invalid-hook:' + ev.id);
      summary.rejected++;
      summary.items.push({id: ev.id, status: 'invalid'});
      continue;
    }
    const prev = await kv_get('wh:' + ev.id);
    if (prev !== null) {
      summary.duplicate++;
      summary.items.push({id: ev.id, status: 'duplicate', seenAt: prev.ts});
      continue;
    }
    const ts = Date.now();
    await kv_set('wh:' + ev.id, {ts, host: parsedUrl.hostname, path: parsedUrl.pathname});
    console.log('deliver:' + ev.id + ':' + parsedUrl.hostname);
    summary.delivered++;
    summary.items.push({id: ev.id, status: 'delivered', host: parsedUrl.hostname, ts});
  }
  return summary;
}`,
      inputs: [
        [[{id: 'w1', url: 'https://hooks.a.test/pay', sig: 'sha256=deadbeef'}, {id: 'w2', url: 'http://insecure.test/x', sig: 'sha256=12345678'}, {id: 'w3', url: 'https://hooks.b.test/ev', sig: 'sha256=abcdef01'}]],
        [[{id: 'h1', url: 'https://cb.test/v1', sig: 'sha256=00112233'}, {id: 'h2', url: 'https://cb.test/v2', sig: 'bad-sig'}, {id: 'h3', url: 'not a url', sig: 'sha256=aabbccdd'}]],
        [[{id: 'e1', url: 'https://x.test/1', sig: 'sha256=11223344'}, {id: 'e2', url: 'https://y.test/2', sig: 'sha256=55667788'}]],
        [[{id: 'd1', url: 'https://z.test/a', sig: 'sha256=99887766'}, {id: 'd2', url: 'https://z.test/b', sig: 'sha256=11112222'}, {id: 'd3', url: 'https://z.test/c', sig: 'sha256=33334444'}]],
        [[{id: 'm1', url: 'https://m.test/hook', sig: 'sha256=abcdef12'}, {id: 'm2', url: 'https://m.test/hook2', sig: 'sha256=fedcba98'}]],
      ],
      features: ['loop', 'branch', 'exception', 'url', 'regexp', 'native-bindings', 'platform'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          return {calls: [
            natCall('kv_get', ['wh:w1'], null),
            dateCall(1000),
            natCall('kv_set', ['wh:w1', {ts: 1000, host: 'hooks.a.test', path: '/pay'}], true),
            logCall('log', 'deliver:w1:hooks.a.test'),
            logCall('warn', 'invalid-hook:w2'),
            natCall('kv_get', ['wh:w3'], {ts: 900, host: 'hooks.b.test', path: '/ev'}),
          ]};
        }
        if (i === 1) {
          return {calls: [
            natCall('kv_get', ['wh:h1'], null),
            dateCall(2000),
            natCall('kv_set', ['wh:h1', {ts: 2000, host: 'cb.test', path: '/v1'}], true),
            logCall('log', 'deliver:h1:cb.test'),
            logCall('warn', 'invalid-hook:h2'),
            logCall('warn', 'bad-url:h3'),
          ]};
        }
        if (i === 2) {
          return {calls: [
            natCall('kv_get', ['wh:e1'], null),
            dateCall(3000),
            natCall('kv_set', ['wh:e1', {ts: 3000, host: 'x.test', path: '/1'}], true),
            logCall('log', 'deliver:e1:x.test'),
            natCall('kv_get', ['wh:e2'], null),
            dateCall(3010),
            natCall('kv_set', ['wh:e2', {ts: 3010, host: 'y.test', path: '/2'}], true),
            logCall('log', 'deliver:e2:y.test'),
          ]};
        }
        if (i === 3) {
          return {calls: [
            natCall('kv_get', ['wh:d1'], {ts: 100}),
            natCall('kv_get', ['wh:d2'], null),
            dateCall(4000),
            natCall('kv_set', ['wh:d2', {ts: 4000, host: 'z.test', path: '/b'}], true),
            logCall('log', 'deliver:d2:z.test'),
            natCall('kv_get', ['wh:d3'], {ts: 200}),
          ]};
        }
        return {calls: [
          natCall('kv_get', ['wh:m1'], null),
          dateCall(5000),
          natCall('kv_set', ['wh:m1', {ts: 5000, host: 'm.test', path: '/hook'}], true),
          logCall('log', 'deliver:m1:m.test'),
          natCall('kv_get', ['wh:m2'], {ts: 4900}),
        ]};
      },
    },

    // =========================================================================
    // 11. multi-stage-config-cascade
    // Layered fs.readText (some rejected), structuredClone deep merge + alias + fs.writeText
    // =========================================================================
    {
      name: 'multi-stage-config-cascade',
      source: `function deepMerge(target, patch) {
  const keys = Object.keys(patch);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = structuredClone(v);
    }
  }
  return target;
}
async function run(defaults, layerPaths, outPath) {
  const merged = structuredClone(defaults);
  const loaded = [];
  const missing = [];
  for (let i = 0; i < layerPaths.length; i++) {
    const path = layerPaths[i];
    try {
      const raw = await host.readText(path);
      const layer = JSON.parse(raw);
      deepMerge(merged, layer);
      loaded.push(path);
    } catch (err) {
      missing.push(path);
      console.warn('skip:' + path + ':' + err);
    }
  }
  await host.writeText(outPath, JSON.stringify(merged));
  const aliasRef = merged.db;
  return {merged, dbRef: aliasRef, loaded, missing};
}`,
      inputs: [
        [{db: {host: 'localhost', port: 5432}, flags: {debug: false}}, ['base.json', 'prod.json', 'local.json'], 'out-0.json'],
        [{db: {host: '127.0.0.1', port: 3306}, retry: 1}, ['env.json', 'override.json'], 'out-1.json'],
        [{db: {host: 'db0', pool: 4}, tags: ['a']}, ['l1.json', 'l2.json', 'l3.json'], 'out-2.json'],
        [{db: {host: 'main', tls: false}, log: 'info'}, ['a.json', 'b.json'], 'out-3.json'],
        [{db: {host: 'old', port: 1111}, limit: 10}, ['x.json', 'y.json', 'z.json'], 'out-4.json'],
      ],
      features: ['loop', 'branch', 'exception', 'json', 'fs', 'platform', 'structured-clone', 'alias'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          return {calls: [
            fsRead('base.json', '{"db":{"port":6432},"flags":{"metrics":true}}'),
            fsRead('prod.json', '{"db":{"host":"pg.prod"}}'),
            fsRead('local.json', 'ENOENT', {status: 'rejected'}),
            logCall('warn', 'skip:local.json:ENOENT'),
            fsWrite('out-0.json', '{"db":{"host":"pg.prod","port":6432},"flags":{"debug":false,"metrics":true}}'),
          ]};
        }
        if (i === 1) {
          return {calls: [
            fsRead('env.json', 'ENOENT', {status: 'rejected'}),
            logCall('warn', 'skip:env.json:ENOENT'),
            fsRead('override.json', '{"retry":5,"db":{"port":3307}}'),
            fsWrite('out-1.json', '{"db":{"host":"127.0.0.1","port":3307},"retry":5}'),
          ]};
        }
        if (i === 2) {
          return {calls: [
            fsRead('l1.json', '{"tags":["a","b"],"db":{"pool":8}}'),
            fsRead('l2.json', 'EACCES', {status: 'rejected'}),
            logCall('warn', 'skip:l2.json:EACCES'),
            fsRead('l3.json', '{"db":{"ssl":true}}'),
            fsWrite('out-2.json', '{"db":{"host":"db0","pool":8,"ssl":true},"tags":["a","b"]}'),
          ]};
        }
        if (i === 3) {
          return {calls: [
            fsRead('a.json', '{"db":{"tls":true}}'),
            fsRead('b.json', '{"log":"warn","extra":1}'),
            fsWrite('out-3.json', '{"db":{"host":"main","tls":true},"log":"warn","extra":1}'),
          ]};
        }
        return {calls: [
          fsRead('x.json', 'ENOENT', {status: 'rejected'}),
          logCall('warn', 'skip:x.json:ENOENT'),
          fsRead('y.json', '{"db":{"host":"new"},"limit":25}'),
          fsRead('z.json', 'ENOENT', {status: 'rejected'}),
          logCall('warn', 'skip:z.json:ENOENT'),
          fsWrite('out-4.json', '{"db":{"host":"new","port":1111},"limit":25}'),
        ]};
      },
    },

    // =========================================================================
    // 12. adaptive-batch-flusher
    // Flushes via http.request on maxBatch OR Date.now() window, tracks latency stats
    // =========================================================================
    {
      name: 'adaptive-batch-flusher',
      source: `async function run(endpoint, records, maxBatch, windowMs) {
  let lastFlush = Date.now();
  let batch = [];
  let flushes = 0, totalLatencyMs = 0;
  async function flush(reason) {
    const t0 = Date.now();
    await host.httpRequest(endpoint, 'POST', '{"content-type":"application/json"}', JSON.stringify({reason, items: batch}));
    const t1 = Date.now();
    totalLatencyMs += (t1 - t0);
    flushes++;
    console.info('flush:' + reason + ':n=' + batch.length);
    batch = [];
    lastFlush = t1;
  }
  for (let i = 0; i < records.length; i++) {
    const now = Date.now();
    if (batch.length > 0 && now - lastFlush >= windowMs) {
      await flush('window');
    }
    batch.push(records[i]);
    if (batch.length >= maxBatch) {
      await flush('size');
    }
  }
  if (batch.length > 0) {
    await flush('final');
  }
  return {flushes, totalLatencyMs, count: records.length};
}`,
      inputs: [
        ['https://ingest.test/b', ['a', 'b', 'c'], 2, 100],
        ['https://ingest.test/b', ['x', 'y', 'z'], 3, 50],
        ['https://ingest.test/m', ['1', '2'], 2, 80],
        ['https://ingest.test/k', ['p', 'q', 'r', 's'], 2, 40],
        ['https://ingest.test/w', ['u', 'v', 'w'], 5, 30],
      ],
      features: ['loop', 'branch', 'http', 'platform', 'json'],
      tier: 5,
      fixture: i => {
        const hdr = '{"content-type":"application/json"}';
        if (i === 0) {
          // lastFlush=100; a at 110 (batch=[a]); b at 120 (batch=[a,b]->flush size t0=121,t1=126); c at 140 (batch=[c]); final flush t0=141,t1=145
          return {calls: [
            dateCall(100),
            dateCall(110),
            dateCall(120),
            dateCall(121), httpReq('https://ingest.test/b', 'POST', hdr, '{"reason":"size","items":["a","b"]}', 'ok'), dateCall(126), logCall('info', 'flush:size:n=2'),
            dateCall(140),
            dateCall(141), httpReq('https://ingest.test/b', 'POST', hdr, '{"reason":"final","items":["c"]}', 'ok'), dateCall(145), logCall('info', 'flush:final:n=1'),
          ]};
        }
        if (i === 1) {
          // lastFlush=200; x at 210 (batch=[x]); y at 265 (265-200>=50 -> flush window t0=266,t1=270, batch=[y]); z at 280 (batch=[y,z]); final flush t0=281,t1=290
          return {calls: [
            dateCall(200),
            dateCall(210),
            dateCall(265),
            dateCall(266), httpReq('https://ingest.test/b', 'POST', hdr, '{"reason":"window","items":["x"]}', 'ok'), dateCall(270), logCall('info', 'flush:window:n=1'),
            dateCall(280),
            dateCall(281), httpReq('https://ingest.test/b', 'POST', hdr, '{"reason":"final","items":["y","z"]}', 'ok'), dateCall(290), logCall('info', 'flush:final:n=2'),
          ]};
        }
        if (i === 2) {
          // lastFlush=300; '1' at 310; '2' at 320 -> flush size (t0=321,t1=330)
          return {calls: [
            dateCall(300),
            dateCall(310),
            dateCall(320),
            dateCall(321), httpReq('https://ingest.test/m', 'POST', hdr, '{"reason":"size","items":["1","2"]}', 'ok'), dateCall(330), logCall('info', 'flush:size:n=2'),
          ]};
        }
        if (i === 3) {
          // lastFlush=400; p at 405; q at 410 -> flush size (t0=411,t1=415); r at 420; s at 465 (465-415>=40 -> flush window t0=466,t1=470); final s (t0=471,t1=476)
          return {calls: [
            dateCall(400),
            dateCall(405),
            dateCall(410),
            dateCall(411), httpReq('https://ingest.test/k', 'POST', hdr, '{"reason":"size","items":["p","q"]}', 'ok'), dateCall(415), logCall('info', 'flush:size:n=2'),
            dateCall(420),
            dateCall(465),
            dateCall(466), httpReq('https://ingest.test/k', 'POST', hdr, '{"reason":"window","items":["r"]}', 'ok'), dateCall(470), logCall('info', 'flush:window:n=1'),
            dateCall(471), httpReq('https://ingest.test/k', 'POST', hdr, '{"reason":"final","items":["s"]}', 'ok'), dateCall(476), logCall('info', 'flush:final:n=1'),
          ]};
        }
        // i === 4: lastFlush=500; u at 505; v at 540 (window -> t0=541,t1=545); w at 550; final [v,w] (t0=551,t1=558)
        return {calls: [
          dateCall(500),
          dateCall(505),
          dateCall(540),
          dateCall(541), httpReq('https://ingest.test/w', 'POST', hdr, '{"reason":"window","items":["u"]}', 'ok'), dateCall(545), logCall('info', 'flush:window:n=1'),
          dateCall(550),
          dateCall(551), httpReq('https://ingest.test/w', 'POST', hdr, '{"reason":"final","items":["v","w"]}', 'ok'), dateCall(558), logCall('info', 'flush:final:n=2'),
        ]};
      },
    },

    // =========================================================================
    // 13. idempotency-key-router
    // Generates hex request IDs from Date.now() + Math.random(), checks kv_get, calls http.request, caches kv_set
    // =========================================================================
    {
      name: 'idempotency-key-router',
      randomMode: 'tool',
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Lookup cached idempotent response {rid, body} or null.'},
        {name: 'kv_set', kind: 'promise', description: 'Cache idempotent response {rid, body}.'},
      ],
      source: `async function run(requests) {
  const out = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const cached = await kv_get('idem:' + req.idemKey);
    if (cached !== null) {
      out.push({idemKey: req.idemKey, replayed: true, rid: cached.rid, body: cached.body});
      continue;
    }
    const ts = Date.now();
    const r = Math.random();
    const rid = ts.toString(16) + '-' + Math.floor(r * 65536).toString(16).padStart(4, '0');
    const body = await host.httpRequest(req.url, 'POST', '{"x-req-id":"' + rid + '"}', req.body);
    await kv_set('idem:' + req.idemKey, {rid, body});
    out.push({idemKey: req.idemKey, replayed: false, rid, body});
  }
  return out;
}`,
      inputs: [
        [[{idemKey: 'k1', url: 'https://pay.test/charge', body: '{"amt":10}'}, {idemKey: 'k1', url: 'https://pay.test/charge', body: '{"amt":10}'}]],
        [[{idemKey: 'a1', url: 'https://pay.test/a', body: '1'}, {idemKey: 'a2', url: 'https://pay.test/b', body: '2'}]],
        [[{idemKey: 'x0', url: 'https://pay.test/x', body: 'ok'}, {idemKey: 'x1', url: 'https://pay.test/y', body: 'go'}]],
        [[{idemKey: 'r1', url: 'https://pay.test/r', body: '{}'}, {idemKey: 'r2', url: 'https://pay.test/r', body: '{}'}, {idemKey: 'r3', url: 'https://pay.test/r', body: '{}'}]],
        [[{idemKey: 'p9', url: 'https://pay.test/p', body: 'hi'}, {idemKey: 'p10', url: 'https://pay.test/q', body: 'yo'}]],
      ],
      features: ['loop', 'branch', 'native-bindings', 'http', 'platform', 'random'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // ts=0x1000=4096, r=0.5 -> floor(32768)=0x8000 -> rid="1000-8000"
          return {calls: [
            natCall('kv_get', ['idem:k1'], null),
            dateCall(4096), randCall(0.5),
            httpReq('https://pay.test/charge', 'POST', '{"x-req-id":"1000-8000"}', '{"amt":10}', 'ch_1'),
            natCall('kv_set', ['idem:k1', {rid: '1000-8000', body: 'ch_1'}], true),
            natCall('kv_get', ['idem:k1'], {rid: '1000-8000', body: 'ch_1'}),
          ]};
        }
        if (i === 1) {
          // a1: ts=256 (0x100), r=0.25 -> 0x4000 -> "100-4000"
          // a2: ts=257 (0x101), r=0.0 -> 0x0000 -> "101-0000"
          return {calls: [
            natCall('kv_get', ['idem:a1'], null),
            dateCall(256), randCall(0.25),
            httpReq('https://pay.test/a', 'POST', '{"x-req-id":"100-4000"}', '1', 'res-a'),
            natCall('kv_set', ['idem:a1', {rid: '100-4000', body: 'res-a'}], true),
            natCall('kv_get', ['idem:a2'], null),
            dateCall(257), randCall(0.0),
            httpReq('https://pay.test/b', 'POST', '{"x-req-id":"101-0000"}', '2', 'res-b'),
            natCall('kv_set', ['idem:a2', {rid: '101-0000', body: 'res-b'}], true),
          ]};
        }
        if (i === 2) {
          // x0: cached; x1: ts=512 (0x200), r=0.75 -> 0xc000 -> "200-c000"
          return {calls: [
            natCall('kv_get', ['idem:x0'], {rid: 'ff-0001', body: 'old'}),
            natCall('kv_get', ['idem:x1'], null),
            dateCall(512), randCall(0.75),
            httpReq('https://pay.test/y', 'POST', '{"x-req-id":"200-c000"}', 'go', 'new'),
            natCall('kv_set', ['idem:x1', {rid: '200-c000', body: 'new'}], true),
          ]};
        }
        if (i === 3) {
          // r1: cached; r2: ts=1024 (0x400), r=0.125 -> 0x2000 -> "400-2000"; r3: cached
          return {calls: [
            natCall('kv_get', ['idem:r1'], {rid: '10-0010', body: 'b1'}),
            natCall('kv_get', ['idem:r2'], null),
            dateCall(1024), randCall(0.125),
            httpReq('https://pay.test/r', 'POST', '{"x-req-id":"400-2000"}', '{}', 'b2'),
            natCall('kv_set', ['idem:r2', {rid: '400-2000', body: 'b2'}], true),
            natCall('kv_get', ['idem:r3'], {rid: '20-0020', body: 'b3'}),
          ]};
        }
        // i === 4: p9 miss (ts=4095=0xfff, r=0.5 -> 0x8000), p10 miss (ts=4100=0x1004, r=0.0625 -> 0x1000)
        return {calls: [
          natCall('kv_get', ['idem:p9'], null),
          dateCall(4095), randCall(0.5),
          httpReq('https://pay.test/p', 'POST', '{"x-req-id":"fff-8000"}', 'hi', 'ok-p'),
          natCall('kv_set', ['idem:p9', {rid: 'fff-8000', body: 'ok-p'}], true),
          natCall('kv_get', ['idem:p10'], null),
          dateCall(4100), randCall(0.0625),
          httpReq('https://pay.test/q', 'POST', '{"x-req-id":"1004-1000"}', 'yo', 'ok-q'),
          natCall('kv_set', ['idem:p10', {rid: '1004-1000', body: 'ok-q'}], true),
        ]};
      },
    },

    // =========================================================================
    // 14. priority-scheduler-with-aging
    // Priority queue aged by Date.now(), checkpoints via kv_set + console.info milestones
    // =========================================================================
    {
      name: 'priority-scheduler-with-aging',
      nativeBindings: [
        {name: 'kv_set', kind: 'promise', description: 'Persist scheduler checkpoint payload.'},
      ],
      source: `async function run(jobs, ageStepMs, checkpointEvery) {
  const queue = jobs.map(j => ({...j}));
  const dispatched = [];
  let step = 0;
  while (queue.length > 0) {
    const now = Date.now();
    let bestIdx = 0;
    let bestPri = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const wait = Math.max(0, now - queue[i].enqueuedAt);
      const eff = queue[i].basePri - Math.floor(wait / ageStepMs);
      if (eff < bestPri || (eff === bestPri && queue[i].id < queue[bestIdx].id)) {
        bestPri = eff;
        bestIdx = i;
      }
    }
    const job = queue.splice(bestIdx, 1)[0];
    step++;
    dispatched.push({id: job.id, effPri: bestPri, at: now});
    console.info('run:' + job.id + ':eff=' + bestPri);
    if (step % checkpointEvery === 0) {
      await kv_set('sched:ckpt:' + step, {step, lastId: job.id, remaining: queue.length});
    }
  }
  return dispatched;
}`,
      inputs: [
        [[{id: 'a', basePri: 5, enqueuedAt: 100}, {id: 'b', basePri: 3, enqueuedAt: 150}, {id: 'c', basePri: 4, enqueuedAt: 120}], 25, 2],
        [[{id: 'j1', basePri: 6, enqueuedAt: 0}, {id: 'j2', basePri: 2, enqueuedAt: 90}, {id: 'j3', basePri: 4, enqueuedAt: 40}], 20, 1],
        [[{id: 'x', basePri: 3, enqueuedAt: 200}, {id: 'y', basePri: 2, enqueuedAt: 200}, {id: 'z', basePri: 5, enqueuedAt: 100}], 50, 2],
        [[{id: 'p1', basePri: 4, enqueuedAt: 500}, {id: 'p2', basePri: 4, enqueuedAt: 450}, {id: 'p3', basePri: 3, enqueuedAt: 520}], 30, 3],
        [[{id: 'm', basePri: 7, enqueuedAt: 1000}, {id: 'n', basePri: 5, enqueuedAt: 1040}, {id: 'o', basePri: 6, enqueuedAt: 1010}], 15, 2],
      ],
      features: ['loop', 'branch', 'native-bindings', 'platform'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // t=175: a:5-3=2, b:3-1=2, c:4-2=2 -> tie -> id 'a' (eff=2)
          // t=180: b:3-1=2, c:4-2=2 -> tie -> id 'b' (eff=2), step=2 -> ckpt
          // t=200: c:4-3=1 -> 'c' (eff=1)
          return {calls: [
            dateCall(175), logCall('info', 'run:a:eff=2'),
            dateCall(180), logCall('info', 'run:b:eff=2'),
            natCall('kv_set', ['sched:ckpt:2', {step: 2, lastId: 'b', remaining: 1}], true),
            dateCall(200), logCall('info', 'run:c:eff=1'),
          ]};
        }
        if (i === 1) {
          // t=100: j1:6-5=1, j2:2-0=2, j3:4-3=1 -> tie -> j1 (eff=1), ckpt 1
          // t=110: j2:2-1=1, j3:4-3=1 -> tie -> j2 (eff=1), ckpt 2
          // t=120: j3:4-4=0 -> j3 (eff=0), ckpt 3
          return {calls: [
            dateCall(100), logCall('info', 'run:j1:eff=1'),
            natCall('kv_set', ['sched:ckpt:1', {step: 1, lastId: 'j1', remaining: 2}], true),
            dateCall(110), logCall('info', 'run:j2:eff=1'),
            natCall('kv_set', ['sched:ckpt:2', {step: 2, lastId: 'j2', remaining: 1}], true),
            dateCall(120), logCall('info', 'run:j3:eff=0'),
            natCall('kv_set', ['sched:ckpt:3', {step: 3, lastId: 'j3', remaining: 0}], true),
          ]};
        }
        if (i === 2) {
          // t=260: x:3-1=2, y:2-1=1, z:5-3=2 -> y (eff=1)
          // t=300: x:3-2=1, z:5-4=1 -> x (eff=1), ckpt 2
          // t=310: z:5-4=1 -> z (eff=1)
          return {calls: [
            dateCall(260), logCall('info', 'run:y:eff=1'),
            dateCall(300), logCall('info', 'run:x:eff=1'),
            natCall('kv_set', ['sched:ckpt:2', {step: 2, lastId: 'x', remaining: 1}], true),
            dateCall(310), logCall('info', 'run:z:eff=1'),
          ]};
        }
        if (i === 3) {
          // t=530: p1:4-1=3, p2:4-2=2, p3:3-0=3 -> p2 (eff=2)
          // t=550: p1:4-1=3, p3:3-1=2 -> p3 (eff=2)
          // t=560: p1:4-2=2 -> p1 (eff=2), ckpt 3
          return {calls: [
            dateCall(530), logCall('info', 'run:p2:eff=2'),
            dateCall(550), logCall('info', 'run:p3:eff=2'),
            dateCall(560), logCall('info', 'run:p1:eff=2'),
            natCall('kv_set', ['sched:ckpt:3', {step: 3, lastId: 'p1', remaining: 0}], true),
          ]};
        }
        // i === 4:
        // t=1060: m:7-4=3, n:5-1=4, o:6-3=3 -> m (eff=3)
        // t=1075: n:5-2=3, o:6-4=2 -> o (eff=2), ckpt 2
        // t=1090: n:5-3=2 -> n (eff=2)
        return {calls: [
          dateCall(1060), logCall('info', 'run:m:eff=3'),
          dateCall(1075), logCall('info', 'run:o:eff=2'),
          natCall('kv_set', ['sched:ckpt:2', {step: 2, lastId: 'o', remaining: 1}], true),
          dateCall(1090), logCall('info', 'run:n:eff=2'),
        ]};
      },
    },

    // =========================================================================
    // 15. regex-log-redactor-pipeline
    // Reads logs via fs.readText, RegExp + URL query scrubbing, writes JSON via fs.writeText
    // =========================================================================
    {
      name: 'regex-log-redactor-pipeline',
      source: `async function run(files, outPath) {
  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}/gi;
  const bearerRe = /Bearer\\s+[A-Za-z0-9._-]+/g;
  const urlRe = /https?:\\/\\/[^\\s]+/g;
  const secretParams = new Set(['token', 'key', 'secret']);
  let totalRedactions = 0;
  const sanitized = {};
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const raw = await host.readText(file);
    let count = 0;
    let text = raw.replace(bearerRe, () => { count++; return 'Bearer [REDACTED]'; });
    text = text.replace(emailRe, () => { count++; return '[EMAIL]'; });
    text = text.replace(urlRe, match => {
      try {
        const u = new URL(match);
        let changed = false;
        for (const k of [...u.searchParams.keys()]) {
          if (secretParams.has(k.toLowerCase())) {
            u.searchParams.set(k, 'REDACTED');
            count++;
            changed = true;
          }
        }
        return changed ? u.toString() : match;
      } catch (_err) {
        return match;
      }
    });
    sanitized[file] = {text, redactions: count};
    totalRedactions += count;
  }
  const report = {totalRedactions, sanitized};
  await host.writeText(outPath, JSON.stringify(report));
  console.info('redacted:' + totalRedactions);
  return report;
}`,
      inputs: [
        [['a.log', 'b.log'], 'clean-0.json'],
        [['auth.log', 'req.log'], 'clean-1.json'],
        [['web.log'], 'clean-2.json'],
        [['x.log', 'y.log'], 'clean-3.json'],
        [['s1.log', 's2.log'], 'clean-4.json'],
      ],
      features: ['loop', 'branch', 'regexp', 'url', 'set', 'json', 'fs', 'platform'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          const rep = {totalRedactions: 3, sanitized: {'a.log': {text: 'user=[EMAIL] auth=Bearer [REDACTED]', redactions: 2}, 'b.log': {text: 'GET https://api.test/v1?token=REDACTED&page=2', redactions: 1}}};
          return {calls: [
            fsRead('a.log', 'user=ada@example.org auth=Bearer tok_99a'),
            fsRead('b.log', 'GET https://api.test/v1?token=abc123&page=2'),
            fsWrite('clean-0.json', JSON.stringify(rep)),
            logCall('info', 'redacted:3'),
          ]};
        }
        if (i === 1) {
          const rep = {totalRedactions: 3, sanitized: {'auth.log': {text: 'Bearer [REDACTED] ok', redactions: 1}, 'req.log': {text: 'https://x.test/p?key=REDACTED&secret=REDACTED', redactions: 2}}};
          return {calls: [
            fsRead('auth.log', 'Bearer secret.jwt.1 ok'),
            fsRead('req.log', 'https://x.test/p?key=k1&secret=s2'),
            fsWrite('clean-1.json', JSON.stringify(rep)),
            logCall('info', 'redacted:3'),
          ]};
        }
        if (i === 2) {
          const rep = {totalRedactions: 2, sanitized: {'web.log': {text: 'from [EMAIL] to https://s.test/a?q=1&token=REDACTED', redactions: 2}}};
          return {calls: [
            fsRead('web.log', 'from bob@corp.io to https://s.test/a?q=1&token=xyz'),
            fsWrite('clean-2.json', JSON.stringify(rep)),
            logCall('info', 'redacted:2'),
          ]};
        }
        if (i === 3) {
          const rep = {totalRedactions: 1, sanitized: {'x.log': {text: 'plain log line', redactions: 0}, 'y.log': {text: 'contact [EMAIL] via https://ok.test/doc?v=1', redactions: 1}}};
          return {calls: [
            fsRead('x.log', 'plain log line'),
            fsRead('y.log', 'contact dev@site.dev via https://ok.test/doc?v=1'),
            fsWrite('clean-3.json', JSON.stringify(rep)),
            logCall('info', 'redacted:1'),
          ]};
        }
        const rep = {totalRedactions: 3, sanitized: {'s1.log': {text: 'Bearer [REDACTED] and Bearer [REDACTED]', redactions: 2}, 's2.log': {text: 'https://m.test/?KEY=REDACTED', redactions: 1}}};
        return {calls: [
          fsRead('s1.log', 'Bearer aa1 and Bearer bb2'),
          fsRead('s2.log', 'https://m.test/?KEY=999'),
          fsWrite('clean-4.json', JSON.stringify(rep)),
          logCall('info', 'redacted:3'),
        ]};
      },
    },

    // =========================================================================
    // 16. canary-traffic-splitter
    // Date.now() rollout window + Math.random() canary split + http.request + fallback
    // =========================================================================
    {
      name: 'canary-traffic-splitter',
      randomMode: 'tool',
      source: `async function run(config, requests) {
  const results = [];
  let canaryHits = 0, fallbacks = 0;
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const now = Date.now();
    const inWindow = now >= config.startTs && now <= config.endTs;
    let useCanary = false;
    if (inWindow) {
      const roll = Math.random();
      useCanary = roll < config.canaryPct;
    }
    if (useCanary) {
      canaryHits++;
      try {
        const res = await host.httpRequest(config.canaryUrl + req.path, 'GET', '{"x-lane":"canary"}', '');
        results.push({id: req.id, lane: 'canary', body: res});
        continue;
      } catch (err) {
        fallbacks++;
        console.error('canary-fallback:' + req.id + ':' + err);
      }
    }
    const res = await host.httpRequest(config.primaryUrl + req.path, 'GET', '{"x-lane":"primary"}', '');
    results.push({id: req.id, lane: 'primary', body: res});
  }
  return {canaryHits, fallbacks, results};
}`,
      inputs: [
        [{startTs: 100, endTs: 200, canaryPct: 0.3, primaryUrl: 'https://p.test', canaryUrl: 'https://c.test'}, [{id: 'r1', path: '/a'}, {id: 'r2', path: '/b'}, {id: 'r3', path: '/c'}]],
        [{startTs: 500, endTs: 600, canaryPct: 0.5, primaryUrl: 'https://p.test', canaryUrl: 'https://c.test'}, [{id: 'k1', path: '/x'}, {id: 'k2', path: '/y'}]],
        [{startTs: 300, endTs: 350, canaryPct: 0.4, primaryUrl: 'https://p.test', canaryUrl: 'https://c.test'}, [{id: 'm1', path: '/1'}, {id: 'm2', path: '/2'}, {id: 'm3', path: '/3'}]],
        [{startTs: 1000, endTs: 1100, canaryPct: 0.25, primaryUrl: 'https://p.test', canaryUrl: 'https://c.test'}, [{id: 'q1', path: '/u'}, {id: 'q2', path: '/v'}]],
        [{startTs: 200, endTs: 400, canaryPct: 0.6, primaryUrl: 'https://p.test', canaryUrl: 'https://c.test'}, [{id: 'z1', path: '/p'}, {id: 'z2', path: '/q'}]],
      ],
      features: ['loop', 'branch', 'exception', 'http', 'platform', 'random'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // r1: t=120 (inWindow), roll=0.1 <0.3 -> canary ok
          // r2: t=150 (inWindow), roll=0.8 >=0.3 -> primary ok
          // r3: t=220 (outside window, no random!) -> primary ok
          return {calls: [
            dateCall(120), randCall(0.1), httpReq('https://c.test/a', 'GET', '{"x-lane":"canary"}', '', 'c-a'),
            dateCall(150), randCall(0.8), httpReq('https://p.test/b', 'GET', '{"x-lane":"primary"}', '', 'p-b'),
            dateCall(220), httpReq('https://p.test/c', 'GET', '{"x-lane":"primary"}', '', 'p-c'),
          ]};
        }
        if (i === 1) {
          // k1: t=510, roll=0.2 <0.5 -> canary rejects -> error + fallback primary
          // k2: t=520, roll=0.4 <0.5 -> canary ok
          return {calls: [
            dateCall(510), randCall(0.2), httpReq('https://c.test/x', 'GET', '{"x-lane":"canary"}', '', '500', {status: 'rejected'}),
            logCall('error', 'canary-fallback:k1:500'),
            httpReq('https://p.test/x', 'GET', '{"x-lane":"primary"}', '', 'p-x'),
            dateCall(520), randCall(0.4), httpReq('https://c.test/y', 'GET', '{"x-lane":"canary"}', '', 'c-y'),
          ]};
        }
        if (i === 2) {
          // m1: t=290 (before window) -> primary
          // m2: t=300 (boundary inWindow), roll=0.39 -> canary rejects -> fallback
          // m3: t=350 (boundary inWindow), roll=0.4 -> not <0.4 -> primary
          return {calls: [
            dateCall(290), httpReq('https://p.test/1', 'GET', '{"x-lane":"primary"}', '', 'p-1'),
            dateCall(300), randCall(0.39), httpReq('https://c.test/2', 'GET', '{"x-lane":"canary"}', '', 'timeout', {status: 'rejected'}),
            logCall('error', 'canary-fallback:m2:timeout'),
            httpReq('https://p.test/2', 'GET', '{"x-lane":"primary"}', '', 'p-2'),
            dateCall(350), randCall(0.4), httpReq('https://p.test/3', 'GET', '{"x-lane":"primary"}', '', 'p-3'),
          ]};
        }
        if (i === 3) {
          // q1: t=1050, roll=0.05 -> canary ok; q2: t=1099, roll=0.24 -> canary rejects -> fallback
          return {calls: [
            dateCall(1050), randCall(0.05), httpReq('https://c.test/u', 'GET', '{"x-lane":"canary"}', '', 'c-u'),
            dateCall(1099), randCall(0.24), httpReq('https://c.test/v', 'GET', '{"x-lane":"canary"}', '', '502', {status: 'rejected'}),
            logCall('error', 'canary-fallback:q2:502'),
            httpReq('https://p.test/v', 'GET', '{"x-lane":"primary"}', '', 'p-v'),
          ]};
        }
        // i === 4: z1: t=250, roll=0.59 -> canary rejects -> fallback; z2: t=300, roll=0.9 -> primary
        return {calls: [
          dateCall(250), randCall(0.59), httpReq('https://c.test/p', 'GET', '{"x-lane":"canary"}', '', 'err', {status: 'rejected'}),
          logCall('error', 'canary-fallback:z1:err'),
          httpReq('https://p.test/p', 'GET', '{"x-lane":"primary"}', '', 'p-p'),
          dateCall(300), randCall(0.9), httpReq('https://p.test/q', 'GET', '{"x-lane":"primary"}', '', 'p-q'),
        ]};
      },
    },
  ];
}

export function hardEffectfulTasks({seed = 17} = {}) {
  const templates = hardEffectfulTemplates();
  const tasks = [];
  for (const tpl of templates) {
    const family = 'hard-effectful:' + tpl.name;
    const cloneHash = nearCloneHash(tpl.source);
    const usesToolRandom = tpl.randomMode === 'tool' || /\bMath\.random\b/.test(tpl.source);
    for (let i = 0; i < tpl.inputs.length; i++) {
      const fixture = tpl.fixture(i);
      const calls = fixture.calls.map(c => ({
        operation: c.operation,
        arguments: encodeReadable(c.arguments ?? []),
        status: c.status ?? 'fulfilled',
        result: encodeReadable(c.result),
      }));
      tasks.push({
        id: `hard-eff-${tpl.name}-${i}`,
        family,
        source: tpl.source,
        entry: 'run',
        args: encodeReadable(structuredClone(tpl.inputs[i])),
        executionMode: 'native',
        ...(usesToolRandom ? {randomMode: 'tool'} : {}),
        ...(tpl.nativeBindings ? {nativeBindings: structuredClone(tpl.nativeBindings)} : {}),
        fixture: {calls},
        randomSeed: seed,
        maxSteps: 100000,
        timeoutMs: 10000,
        metadata: {
          sourceOrigin: 'authored-hard-effectful',
          executionMode: 'native',
          tier: tpl.tier ?? 5,
          template: family,
          lineage: [family, 'near-clone:' + cloneHash],
          features: [...new Set(['native-v8', 'external', 'sequential', 'hard-effectful', ...(tpl.features ?? [])])].sort(),
          externalCalls: calls.length,
          inputVariant: i,
          evaluationRole: 'generalization',
          agentTaskSuccessVerified: false,
        },
      });
    }
  }
  return tasks;
}
