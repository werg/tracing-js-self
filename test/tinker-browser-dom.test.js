import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportTinkerExample,
  prepareTinkerTask,
  createTinkerSession,
  parseStudentAction,
  assistantThinkingText,
  encodeReadable,
} from '../src/training/tinker-execution.js';
import {auditCausalPrefixPair, auditTinkerSupervision} from '../src/training/tinker-supervision.js';
import {
  scanPublicSourceBrowserTools,
  DEFAULT_BROWSER_URL,
  DEFAULT_BROWSER_HTML,
} from '../src/training/tinker-browser-dom.js';

const browserTask = (source, overrides = {}) => ({
  id: 'browser-case',
  family: 'browser-test',
  environment: 'browser',
  executionMode: 'native',
  source,
  entry: 'run',
  args: [],
  ...overrides,
});

const complete = (value, args = [], kind = 'return') => {
  const encoded = encodeReadable({arguments: args, value});
  return JSON.stringify({type: 'complete', kind, arguments: encoded.arguments, value: encoded.value});
};

const callTool = (operation, args, id = 'c1') => ({
  role: 'assistant',
  content: '',
  tool_calls: [{type: 'function', id, function: {name: operation, arguments: JSON.stringify({arguments: encodeReadable(args)})}}],
});

test('scanPublicSourceBrowserTools detects browser tools strictly from public AST and respects shadowing', () => {
  assert.deepEqual(scanPublicSourceBrowserTools('function run() { return document.body.innerHTML; }'), []);

  assert.deepEqual(
    scanPublicSourceBrowserTools(`function run() {
      const a = localStorage.getItem('k');
      sessionStorage.setItem('s', '1');
      if (confirm('ok?')) {
        const name = window.prompt('Name:', 'Alice');
        alert('hi ' + name);
      }
      return fetch('/api/x');
    }`),
    ['browser.alert', 'browser.confirm', 'browser.prompt', 'browser.storageGet', 'browser.storageSet', 'http.request'],
  );

  // Escaped / aliased storage object declares all 4 storage operations
  assert.deepEqual(
    scanPublicSourceBrowserTools('function run() { const s = window.localStorage; s.removeItem("x"); }'),
    ['browser.storageClear', 'browser.storageGet', 'browser.storageRemove', 'browser.storageSet'],
  );

  // Member methods, object keys, strings, and shadowed locals must NOT trigger false declarations
  assert.deepEqual(
    scanPublicSourceBrowserTools(`function run(ui) {
      const cfg = {alert: 1, confirm: 2, prompt: 3, fetch: 4, localStorage: 5};
      function inner(alert, confirm, localStorage) {
        alert('local');
        confirm('local');
        return localStorage.getItem('x');
      }
      ui.confirm('member');
      ui.fetch('/member');
      return inner(() => {}, () => {}, {getItem: () => null}) || 'localStorage.setItem("str")' + cfg.alert;
    }`),
    [],
  );

  // Console and Date.now via window.* and bare globals
  assert.deepEqual(
    scanPublicSourceBrowserTools('function run() { window.console.warn("w"); return window.Date.now(); }'),
    ['platform.console.warn', 'platform.dateNow'],
  );
});

test('DOM tree manipulation, HTML parser/serializer, entities, void tags, classList, dataset, style, and CSS selectors', async () => {
  const initialHtml = `<!DOCTYPE html>
<html>
<head><title>Inventory &amp; Cart</title></head>
<body>
  <main id="root" data-view-mode="grid" style="color: navy; font-size: 14px">
    <h1 class="heading primary">Items &lt;3&gt;</h1>
    <ul id="list">
      <li class="item active" data-item-id="a1"><span class="label">Widget</span><button class="btn primary" data-action="save">Save</button></li>
      <li class="item" data-item-id="b2"><span class="label">Gadget</span><button class="btn" data-action="remove" disabled>Del</button></li>
    </ul>
    <input id="qty" type="number" value="2" />
    <input id="agree" type="checkbox" checked>
    <br>
    <img src="logo.png" alt="Logo &quot;X&quot;"/>
  </main>
</body>
</html>`;

  const source = `function run() {
    const root = document.getElementById('root');
    const h1 = document.querySelector('h1.heading.primary');
    const saveBtn = document.querySelector('ul#list > li.active button.primary[data-action="save"]');
    const allBtns = document.querySelectorAll('button[data-action^="sa"], button[data-action="remove"]');
    const closestLi = saveBtn.closest('li[data-item-id]');
    const disabledBtns = document.querySelectorAll('button:disabled');
    const checkedBoxes = document.querySelectorAll('input:checked');

    // Dataset camelCase <-> data-kebab-case
    const prevMode = root.dataset.viewMode;
    root.dataset.viewMode = 'list';
    root.dataset.totalCount = '2';

    // classList + style
    h1.classList.add('highlighted');
    h1.classList.remove('primary');
    const toggledOn = h1.classList.toggle('sticky');
    const toggledOff = h1.classList.toggle('sticky');
    root.style.backgroundColor = '#fff';

    // Tree manipulation + DocumentFragment + cloneNode
    const list = document.getElementById('list');
    const frag = document.createDocumentFragment();
    const li3 = document.createElement('li');
    li3.className = 'item';
    li3.dataset.itemId = 'c3';
    li3.innerHTML = '<span class="label">Sprocket &amp; Co</span>';
    frag.appendChild(li3);
    list.appendChild(frag);

    const cloned = li3.cloneNode(true);
    cloned.dataset.itemId = 'c4';
    list.insertBefore(cloned, list.firstElementChild);
    const removed = list.removeChild(list.children[2]); // b2

    // Form value/checked/disabled
    const qty = document.getElementById('qty');
    const oldQty = qty.value;
    qty.value = '5';
    const agree = document.getElementById('agree');
    const wasChecked = agree.checked;
    agree.click(); // toggles checkbox
    const afterClickChecked = agree.checked;

    document.title = 'Updated Title';
    return {
      title: document.title,
      h1Text: h1.textContent,
      h1Classes: h1.className,
      toggled: [toggledOn, toggledOff],
      prevMode,
      newModeAttr: root.getAttribute('data-view-mode'),
      totalCountAttr: root.getAttribute('data-total-count'),
      styleCss: root.getAttribute('style'),
      saveMatches: saveBtn.matches('button.primary[data-action="save"]'),
      closestId: closestLi.dataset.itemId,
      allBtnActions: allBtns.map(b => b.dataset.action),
      disabledCount: disabledBtns.length,
      checkedCount: checkedBoxes.length,
      removedId: removed.dataset.itemId,
      listIds: list.children.map(el => el.dataset.itemId),
      qty: [oldQty, qty.value, qty.getAttribute('value')],
      checkbox: [wasChecked, afterClickChecked],
      imgAlt: document.querySelector('img').alt,
      snapHtmlHasSprocket: window.__snapshotDom('#list').html.includes('Sprocket &amp; Co'),
    };
  }`;

  const exported = await exportTinkerExample(browserTask(source, {
    id: 'dom-core',
    initialHtml,
    initialUrl: 'https://shop.example.test/cart',
  }), {traceFormat: 'compact', reasoningChannel: 'thinking'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  assert.equal(exported.messages.some(m => m.role === 'tool_declare'), false);
  const userPrompt = exported.messages.find(m => m.role === 'user').content;
  assert.match(userPrompt, /Initial URL: https:\/\/shop\.example\.test\/cart/);
  assert.match(userPrompt, /Initial DOM:\n```html\n<!DOCTYPE html>/);

  const comp = parseStudentAction(exported.messages.at(-1));
  assert.equal(comp.kind, 'return');
  assert.deepEqual(comp.value, {
    title: 'Updated Title',
    h1Text: 'Items <3>',
    h1Classes: 'heading highlighted',
    toggled: [true, false],
    prevMode: 'grid',
    newModeAttr: 'list',
    totalCountAttr: '2',
    styleCss: 'color: navy; font-size: 14px; background-color: #fff',
    saveMatches: true,
    closestId: 'a1',
    allBtnActions: ['save', 'remove'],
    disabledCount: 1,
    checkedCount: 1,
    removedId: 'b2',
    listIds: ['c4', 'a1', 'c3'],
    qty: ['2', '5', '2'],
    checkbox: [true, false],
    imgAlt: 'Logo "X"',
    snapHtmlHasSprocket: true,
  });
});

test('W3C event dispatch supports capture -> target -> bubble, once, preventDefault, stopPropagation, and stopImmediatePropagation', async () => {
  const initialHtml = `<div id="outer"><div id="mid"><button id="inner">Go</button></div></div>`;
  const source = `function run() {
    const outer = document.getElementById('outer');
    const mid = document.getElementById('mid');
    const inner = document.getElementById('inner');
    const log = [];

    outer.addEventListener('click', e => log.push('outer:cap:' + e.eventPhase), true);
    mid.addEventListener('click', e => log.push('mid:cap:' + e.eventPhase), {capture: true, once: true});
    inner.addEventListener('click', e => log.push('inner:target:' + e.eventPhase));
    mid.addEventListener('click', e => log.push('mid:bub:' + e.eventPhase));
    outer.addEventListener('click', e => log.push('outer:bub:' + e.eventPhase));

    inner.click();
    inner.click(); // mid:cap was once:true so should not run second time

    // Test stopPropagation + preventDefault
    const log2 = [];
    const custom = new CustomEvent('ping', {bubbles: true, cancelable: true, detail: {n: 42}});
    inner.addEventListener('ping', e => {
      log2.push('inner1:' + e.detail.n);
      e.preventDefault();
      e.stopImmediatePropagation();
    });
    inner.addEventListener('ping', () => log2.push('inner2:should-not-run'));
    mid.addEventListener('ping', () => log2.push('mid:should-not-run'));
    const notPrevented = inner.dispatchEvent(custom);

    return {log, log2, notPrevented, defaultPrevented: custom.defaultPrevented};
  }`;

  const exported = await exportTinkerExample(browserTask(source, {id: 'dom-events', initialHtml}), {traceFormat: 'compact'});
  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.deepEqual(comp.value, {
    log: [
      'outer:cap:1', 'mid:cap:1', 'inner:target:2', 'mid:bub:3', 'outer:bub:3',
      'outer:cap:1', 'inner:target:2', 'mid:bub:3', 'outer:bub:3',
    ],
    log2: ['inner1:42'],
    notPrevented: false,
    defaultPrevented: true,
  });
});

test('location, history pushState/replaceState/back/popstate, and virtual timers work deterministically', async () => {
  const initialHtml = `<nav><a href="/home">Home</a><a href="/docs">Docs</a></nav><div id="view"></div>`;
  const source = `async function run() {
    const view = document.getElementById('view');
    const events = [];
    window.addEventListener('popstate', e => {
      events.push({path: location.pathname, search: location.search, state: e.state});
      view.textContent = 'back:' + location.pathname;
    });

    history.pushState({page: 'docs'}, '', '/docs?tab=api');
    const afterPush = {href: location.href, path: location.pathname, search: location.search, len: history.length, state: history.state};
    history.replaceState({page: 'docs', v: 2}, '', '/docs?tab=api#intro');
    const afterReplace = {hash: location.hash, state: history.state, len: history.length};
    history.back();

    // Virtual timers: debounce cancellation + requestAnimationFrame + async wait
    const ticks = [];
    const cancelledId = setTimeout(() => ticks.push('cancelled'), 50);
    clearTimeout(cancelledId);
    setTimeout(() => ticks.push('t100:' + window.__virtualNow()), 100);
    requestAnimationFrame(ts => ticks.push('raf:' + ts));
    const flush1 = window.__flushTimers(120);

    // Await a timer directly (handled deterministically by worker timer pump)
    const delayed = await new Promise(resolve => setTimeout(() => resolve('done@' + window.__virtualNow()), 30));

    return {
      afterPush,
      afterReplace,
      afterBackPath: location.pathname,
      events,
      viewText: view.textContent,
      ticks,
      flush1,
      delayed,
    };
  }`;

  const exported = await exportTinkerExample(browserTask(source, {
    id: 'dom-history-timers',
    initialHtml,
    initialUrl: 'https://docs.example.test/home',
  }), {traceFormat: 'compact'});
  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.deepEqual(comp.value, {
    afterPush: {
      href: 'https://docs.example.test/docs?tab=api',
      path: '/docs',
      search: '?tab=api',
      len: 2,
      state: {page: 'docs'},
    },
    afterReplace: {
      hash: '#intro',
      state: {page: 'docs', v: 2},
      len: 2,
    },
    afterBackPath: '/home',
    events: [{path: '/home', search: '', state: null}],
    viewText: 'back:/home',
    ticks: ['raf:16', 't100:100'],
    flush1: {now: 120, executed: 2, pending: 0},
    delayed: 'done@150',
  });
});

test('storage, dialogs, fetch, console, and Date.now route through external tools with causal zero future leakage and live session grading', async () => {
  const initialHtml = `<div id="app"><span id="status">idle</span><ul id="items"></ul></div>`;
  const source = `async function run(userId) {
    const rawDraft = localStorage.getItem('draft:' + userId);
    const token = sessionStorage.getItem('token');
    const now = Date.now();
    const ok = confirm('Sync cart for ' + userId + '?');
    if (!ok) {
      console.warn('sync-cancelled');
      document.getElementById('status').textContent = 'cancelled';
      return {status: 'cancelled', html: document.body.innerHTML};
    }
    const note = prompt('Order note:', 'standard');
    const res = await fetch('https://api.shop.test/orders', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-token': token || ''},
      body: JSON.stringify({userId, draft: rawDraft, note, ts: now}),
    });
    const payload = await res.json();
    if (res.ok) {
      localStorage.removeItem('draft:' + userId);
      localStorage.setItem('lastOrder', payload.orderId);
      alert('Created ' + payload.orderId);
      document.getElementById('status').textContent = 'order:' + payload.orderId;
    } else {
      console.error('order-failed', res.status);
      document.getElementById('status').textContent = 'error:' + res.status;
    }
    return {status: document.getElementById('status').textContent, orderId: payload.orderId ?? null};
  }`;

  const makePairTask = (id, confirmed, orderId) => browserTask(source, {
    id,
    initialHtml,
    initialUrl: 'https://shop.example.test/checkout',
    args: ['u42'],
    features: ['frontend', 'browser-dom', 'external'],
    fixture: {
      calls: [
        {operation: 'browser.storageGet', arguments: ['local', 'draft:u42'], result: 'item-1'},
        {operation: 'browser.storageGet', arguments: ['session', 'token'], result: 'tok-9'},
        {operation: 'platform.dateNow', arguments: [], result: 1700000000000},
        {operation: 'browser.confirm', arguments: ['Sync cart for u42?'], result: confirmed},
        ...(confirmed ? [
          {operation: 'browser.prompt', arguments: ['Order note:', 'standard'], result: 'leave at door'},
          {
            operation: 'http.request',
            arguments: [
              'https://api.shop.test/orders',
              'POST',
              {'content-type': 'application/json', 'x-token': 'tok-9'},
              JSON.stringify({userId: 'u42', draft: 'item-1', note: 'leave at door', ts: 1700000000000}),
            ],
            status: 'fulfilled',
            result: {
              status: 201,
              statusText: 'Created',
              url: 'https://api.shop.test/orders',
              headers: {'content-type': 'application/json'},
              body: JSON.stringify({orderId}),
            },
          },
          {operation: 'browser.storageRemove', arguments: ['local', 'draft:u42'], result: null},
          {operation: 'browser.storageSet', arguments: ['local', 'lastOrder', orderId], result: null},
          {operation: 'browser.alert', arguments: ['Created ' + orderId], result: null},
        ] : [
          {operation: 'platform.console.warn', arguments: ['sync-cancelled'], result: null},
        ]),
      ],
    },
  });

  const left = await exportTinkerExample(makePairTask('checkout-yes', true, 'ORD-777'), {traceFormat: 'compact'});
  const right = await exportTinkerExample(makePairTask('checkout-no', false, 'ORD-999'), {traceFormat: 'compact'});

  assert.equal(left.metadata.traceAudit.replayVerified, true);
  assert.equal(right.metadata.traceAudit.replayVerified, true);

  // Verify declared tools are identical across diverging branches and have required: ["arguments"]
  const leftTools = JSON.parse(left.messages.find(m => m.role === 'tool_declare').content);
  const rightTools = JSON.parse(right.messages.find(m => m.role === 'tool_declare').content);
  assert.deepEqual(leftTools, rightTools);
  assert.deepEqual(leftTools.map(t => t.function.name), [
    'browser.alert',
    'browser.confirm',
    'browser.prompt',
    'browser.storageGet',
    'browser.storageRemove',
    'browser.storageSet',
    'http.request',
    'platform.console.error',
    'platform.console.warn',
    'platform.dateNow',
  ]);
  for (const tool of leftTools) {
    assert.deepEqual(tool.function.parameters.required, ['arguments']);
  }

  // Causal zero-future-leakage audit on diverging confirm() observation (index 3)
  const pairAudit = auditCausalPrefixPair(left, right, {divergenceObservation: 3});
  assert.equal(pairAudit.passed, true);
  assert.equal(pairAudit.testedDivergence, true);
  assert.doesNotMatch(JSON.stringify(left.messages.slice(0, pairAudit.identicalPrefixMessages)), /ORD-777|ORD-999|leave at door/);
  assert.doesNotMatch(JSON.stringify(left.messages.slice(3, pairAudit.identicalPrefixMessages)), /sync-cancelled/);

  // Supervision audit across both tasks
  const supAudit = await auditTinkerSupervision([left, right], {formats: ['compact'], samplePerFeature: 10});
  assert.equal(supAudit.valid, true);
  assert.equal(supAudit.allReplayed, true);
  assert.equal(supAudit.causalDivergencesChecked, 1);

  // Live ExecutionSession grading (happy path + mismatch rejection)
  const preparedRight = await prepareTinkerTask(right.task, {traceFormat: 'compact'});
  const session = createTinkerSession(preparedRight);
  assert.equal((await session.step(callTool('browser.storageGet', ['local', 'draft:u42'], 't1'), 10)).done, false);
  assert.equal((await session.step(callTool('browser.storageGet', ['session', 'token'], 't2'), 20)).done, false);
  assert.equal((await session.step(callTool('platform.dateNow', [], 't3'), 30)).done, false);
  const obsConfirm = await session.step(callTool('browser.confirm', ['Sync cart for u42?'], 't4'), 40);
  assert.equal(obsConfirm.done, false);
  assert.equal(JSON.parse(obsConfirm.messages[0].content).value, false);
  assert.equal((await session.step(callTool('platform.console.warn', ['sync-cancelled'], 't5'), 50)).done, false);
  const finalStep = await session.step(complete({
    status: 'cancelled',
    html: '<div id="app"><span id="status">cancelled</span><ul id="items"></ul></div>',
  }, ['u42']), 70);
  assert.equal(finalStep.done, true);
  assert.equal(finalStep.grade.success, true);

  // Wrong tool arguments must fail immediately without leaking expected arguments
  const badSession = createTinkerSession(preparedRight);
  const badRes = await badSession.step(callTool('browser.storageGet', ['local', 'wrong-key'], 'b1'), 10);
  assert.equal(badRes.done, true);
  assert.equal(badRes.grade.success, false);
  assert.doesNotMatch(JSON.stringify(badRes), /draft:u42|tok-9/);
});

test('browser defaults populate DEFAULT_BROWSER_URL and DEFAULT_BROWSER_HTML when omitted', async () => {
  const exported = await exportTinkerExample({
    id: 'browser-defaults',
    family: 'browser-test',
    environment: 'browser',
    source: 'function run() { return window.__snapshotDom(); }',
  }, {traceFormat: 'compact'});

  assert.equal(exported.task.executionMode, 'native');
  assert.equal(exported.task.initialUrl, DEFAULT_BROWSER_URL);
  assert.equal(exported.task.initialHtml, DEFAULT_BROWSER_HTML);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.deepEqual(comp.value, {
    url: DEFAULT_BROWSER_URL,
    title: 'App',
    html: '<div id="app"></div>',
  });
});

test('debounced async search with setTimeout/clearTimeout + fetch + DOM rendering + flushTimersAsync works deterministically', async () => {
  const initialHtml = `<input id="q" value=""><ul id="results"></ul><span id="meta"></span>`;
  const source = `async function run(queries) {
    const input = document.getElementById('q');
    const results = document.getElementById('results');
    const meta = document.getElementById('meta');
    let timer = null;
    let fetchCount = 0;

    input.addEventListener('input', () => {
      if (timer !== null) clearTimeout(timer);
      const q = input.value.trim();
      timer = setTimeout(async () => {
        fetchCount++;
        const resp = await fetch('https://search.test/api?q=' + encodeURIComponent(q));
        const data = await resp.json();
        results.innerHTML = data.hits.map(h => '<li>' + h + '</li>').join('');
        meta.textContent = data.hits.length + ' hits';
      }, 200);
    });

    for (const q of queries) {
      input.value = q;
      input.dispatchEvent(new InputEvent('input', {bubbles: true, data: q}));
      window.__flushTimers(50);
    }
    await window.__flushTimersAsync(300);
    return {fetchCount, meta: meta.textContent, items: results.querySelectorAll('li').map(el => el.textContent)};
  }`;

  const exported = await exportTinkerExample(browserTask(source, {
    id: 'dom-debounced-search',
    initialHtml,
    args: [['r', 're', 'rea', 'react']],
    fixture: {
      calls: [{
        operation: 'http.request',
        arguments: ['https://search.test/api?q=react', 'GET', {}, null],
        status: 'fulfilled',
        result: {
          status: 200,
          statusText: 'OK',
          url: 'https://search.test/api?q=react',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({hits: ['react', 'react-dom']}),
        },
      }],
    },
  }), {traceFormat: 'compact'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.deepEqual(comp.value, {
    fetchCount: 1,
    meta: '2 hits',
    items: ['react', 'react-dom'],
  });
});

test('combined multi-file + browser DOM app supports on-demand code.load, DOM/events/storage/fetch/timers, zero leakage, and flexible live session grading', async () => {
  const initialHtml = `<!DOCTYPE html>
<html>
<head><title>Workspace Tasks</title></head>
<body>
  <main id="app">
    <header><span id="user-badge">guest</span><span id="status">idle</span></header>
    <ul id="task-list"><li class="task" data-id="t0">Seed task</li></ul>
    <button id="sync-btn" type="button">Sync</button>
  </main>
</body>
</html>`;

  const files = {
    'src/app.js': [
      "import { loadToken, saveLastSync } from './storage.js';",
      "import { syncRemoteTasks } from './api.js';",
      "import { renderTasks, setStatus } from './dom.js';",
      "import { unusedExportReport } from './distractor.js';",
      'export async function run(userId, doExport) {',
      '  if (doExport) return unusedExportReport(userId);',
      '  const token = loadToken();',
      '  document.getElementById("user-badge").textContent = userId;',
      '  const ok = confirm("Sync tasks for " + userId + "?");',
      '  if (!ok) {',
      '    setStatus("cancelled");',
      '    return {synced: false, status: document.getElementById("status").textContent, count: document.querySelectorAll("#task-list li").length};',
      '  }',
      '  const tag = prompt("Tag filter:", "all");',
      '  const payload = await syncRemoteTasks(userId, token, tag);',
      '  renderTasks(payload.items);',
      '  const delayedStatus = await new Promise(resolve => {',
      '    setTimeout(() => {',
      '      setStatus("synced:" + payload.items.length);',
      '      resolve(document.getElementById("status").textContent);',
      '    }, 25);',
      '  });',
      '  saveLastSync(payload.syncId);',
      '  return {synced: true, status: delayedStatus, count: document.querySelectorAll("#task-list li").length, syncId: payload.syncId};',
      '}',
    ].join('\n'),
    'src/storage.js': [
      'export function loadToken() {',
      '  return sessionStorage.getItem("auth_token") || "anon";',
      '}',
      'export function saveLastSync(syncId) {',
      '  localStorage.setItem("last_sync_id", String(syncId));',
      '}',
    ].join('\n'),
    'src/api.js': [
      'export async function syncRemoteTasks(userId, token, tag) {',
      '  const res = await fetch("https://tasks.example.test/api/sync?user=" + encodeURIComponent(userId) + "&tag=" + encodeURIComponent(tag), {',
      '    method: "GET",',
      '    headers: {"x-auth": token},',
      '  });',
      '  return await res.json();',
      '}',
    ].join('\n'),
    'src/dom.js': [
      'export function setStatus(text) {',
      '  document.getElementById("status").textContent = text;',
      '}',
      'export function renderTasks(items) {',
      '  const list = document.getElementById("task-list");',
      '  list.innerHTML = "";',
      '  for (const item of items) {',
      '    const li = document.createElement("li");',
      '    li.className = "task";',
      '    li.dataset.id = item.id;',
      '    li.textContent = item.title;',
      '    list.appendChild(li);',
      '  }',
      '}',
    ].join('\n'),
    'src/distractor.js': [
      'export function unusedExportReport(userId) {',
      '  alert("Exporting " + userId);',
      '  return {exported: true};',
      '}',
    ].join('\n'),
  };

  const makeCombinedTask = (id, confirmed, syncId) => ({
    id,
    family: 'mf-browser-workspace',
    environment: 'browser',
    executionMode: 'native',
    files,
    entryFile: 'src/app.js',
    entry: 'run',
    initialLoadedFiles: ['src/app.js'],
    initialHtml,
    initialUrl: 'https://tasks.example.test/board',
    args: ['ada', false],
    features: ['multi-file', 'code-load', 'frontend', 'browser-dom'],
    fixture: {
      calls: [
        {operation: 'browser.storageGet', arguments: ['session', 'auth_token'], result: 'tok-42'},
        {operation: 'browser.confirm', arguments: ['Sync tasks for ada?'], result: confirmed},
        ...(confirmed ? [
          {operation: 'browser.prompt', arguments: ['Tag filter:', 'all'], result: 'urgent'},
          {
            operation: 'http.request',
            arguments: ['https://tasks.example.test/api/sync?user=ada&tag=urgent', 'GET', {'x-auth': 'tok-42'}, null],
            status: 'fulfilled',
            result: {
              status: 200,
              statusText: 'OK',
              url: 'https://tasks.example.test/api/sync?user=ada&tag=urgent',
              headers: {'content-type': 'application/json'},
              body: JSON.stringify({syncId, items: [{id: 't1', title: 'Ship 65K'}, {id: 't2', title: 'Audit traces'}]}),
            },
          },
          {operation: 'browser.storageSet', arguments: ['local', 'last_sync_id', syncId], result: null},
        ] : []),
      ],
    },
  });

  const left = await exportTinkerExample(makeCombinedTask('mf-browser-yes', true, 'SYNC-101'), {traceFormat: 'compact', reasoningChannel: 'thinking'});
  const right = await exportTinkerExample(makeCombinedTask('mf-browser-no', false, 'SYNC-202'), {traceFormat: 'compact', reasoningChannel: 'thinking'});

  assert.equal(left.metadata.traceAudit.replayVerified, true);
  assert.equal(right.metadata.traceAudit.replayVerified, true);
  assert(left.metadata.codeLoadCalls >= 3, 'Expected multi-file browser teacher to load storage, api, and dom modules');
  assert(right.metadata.codeLoadCalls >= 2, 'Expected cancelled branch to load storage and dom modules');

  // Verify tool declarations are identical across branches, include code.load + exact browser tools (NO storageRemove/storageClear!)
  const leftTools = JSON.parse(left.messages.find(m => m.role === 'tool_declare').content).map(t => t.function.name);
  const rightTools = JSON.parse(right.messages.find(m => m.role === 'tool_declare').content).map(t => t.function.name);
  assert.deepEqual(leftTools, rightTools);
  assert.deepEqual(leftTools, [
    'browser.alert',
    'browser.confirm',
    'browser.prompt',
    'browser.storageGet',
    'browser.storageSet',
    'code.load',
    'http.request',
  ]);

  // Verify dead distractor.js was NEVER loaded in either branch
  const leftLoads = left.messages
    .filter(m => m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'code.load')
    .flatMap(m => JSON.parse(m.tool_calls[0].function.arguments).arguments);
  assert.doesNotMatch(JSON.stringify(leftLoads), /distractor\.js/);

  // Verify prompt contains both repo manifest + initial URL/DOM
  const userPrompt = left.messages.find(m => m.role === 'user').content;
  assert.match(userPrompt, /Repository manifest \(5 files\):/);
  assert.match(userPrompt, /Initial URL: https:\/\/tasks\.example\.test\/board/);
  assert.match(userPrompt, /Initial DOM:\n```html/);

  // Verify causal zero-future-leakage across diverging confirm() observation
  const pairAudit = auditCausalPrefixPair(left, right);
  assert.equal(pairAudit.passed, true);
  assert.equal(pairAudit.testedDivergence, true);
  assert.doesNotMatch(JSON.stringify(left.messages.slice(0, pairAudit.identicalPrefixMessages)), /SYNC-101|SYNC-202|urgent|Ship 65K/);

  const supAudit = await auditTinkerSupervision([left, right], {formats: ['compact'], samplePerFeature: 10});
  assert.equal(supAudit.valid, true);
  assert.equal(supAudit.allReplayed, true);
  assert.equal(supAudit.causalDivergencesChecked, 1);

  // Verify final outputs
  const leftComp = parseStudentAction(left.messages.at(-1));
  assert.deepEqual(leftComp.value, {synced: true, status: 'synced:2', count: 2, syncId: 'SYNC-101'});
  const rightComp = parseStudentAction(right.messages.at(-1));
  assert.deepEqual(rightComp.value, {synced: false, status: 'cancelled', count: 1});

  // Live session grading: student batches all code.load up-front (different from teacher's causal order)
  // and executes exact external browser.* + http.request effects -> MUST SUCCEED
  const preparedLeft = await prepareTinkerTask(left.task, {traceFormat: 'compact'});
  const session = createTinkerSession(preparedLeft);
  const sLoad = await session.step(callTool('code.load', [
    {path: 'src/storage.js'},
    {path: 'src/api.js'},
    {path: 'src/dom.js'},
  ], 'cl1'), 30);
  assert.equal(sLoad.done, false);
  assert.equal(JSON.parse(sLoad.messages[0].content).value.length, 3);
  assert.equal((await session.step(callTool('browser.storageGet', ['session', 'auth_token'], 'b1'), 40)).done, false);
  assert.equal((await session.step(callTool('browser.confirm', ['Sync tasks for ada?'], 'b2'), 50)).done, false);
  assert.equal((await session.step(callTool('browser.prompt', ['Tag filter:', 'all'], 'b3'), 60)).done, false);
  assert.equal((await session.step(callTool('http.request', ['https://tasks.example.test/api/sync?user=ada&tag=urgent', 'GET', {'x-auth': 'tok-42'}, null], 'h1'), 80)).done, false);
  assert.equal((await session.step(callTool('browser.storageSet', ['local', 'last_sync_id', 'SYNC-101'], 'b4'), 90)).done, false);
  const sDone = await session.step(complete({synced: true, status: 'synced:2', count: 2, syncId: 'SYNC-101'}, ['ada', false]), 120);
  assert.equal(sDone.done, true);
  assert.equal(sDone.grade.success, true);
  assert.equal(sDone.grade.codeLoadCalls, 1);
  assert.equal(sDone.grade.externalCalls, 5);
  session.close();

  // Wrong external browser effect fails immediately even after valid code.load
  const badSession = createTinkerSession(preparedLeft);
  await badSession.step(callTool('code.load', [{path: 'src/storage.js'}], 'clx'), 20);
  const badRes = await badSession.step(callTool('browser.storageGet', ['local', 'auth_token'], 'bx'), 30);
  assert.equal(badRes.done, true);
  assert.equal(badRes.grade.success, false);
  assert.equal(badRes.grade.failureCategory, 'incorrect-external-request');
  badSession.close();
});

test('FormData (including new FormData(formEl)), DOMParser, requestAnimationFrame/cancelAnimationFrame, queueMicrotask, Observers, getBoundingClientRect, and getComputedStyle', async () => {
  const initialHtml = `<!DOCTYPE html>
<html>
<head><title>Expanded DOM</title></head>
<body>
  <form id="profile-form">
    <input name="username" value="ada" />
    <input name="ignored_disabled" value="nope" disabled />
    <input type="checkbox" name="newsletter" value="yes" checked />
    <input type="checkbox" name="unchecked_opt" value="no" />
    <input type="radio" name="plan" value="free" />
    <input type="radio" name="plan" value="pro" checked />
    <select name="role">
      <option value="viewer">Viewer</option>
      <option value="admin" selected>Admin</option>
    </select>
    <select name="tags" multiple>
      <option value="js" selected>JS</option>
      <option value="py" selected>PY</option>
      <option value="rs">RS</option>
    </select>
    <textarea name="bio">Hello DOM</textarea>
    <button type="submit" name="btn" value="send">Send</button>
  </form>
  <div id="box" style="left: 10px; top: 20px; width: 120px; height: 45px; color: crimson; --accent-color: teal">
    <span id="txt">start</span>
  </div>
  <div id="hidden-box" hidden>secret</div>
</body>
</html>`;

  const source = `async function run() {
    // 1. FormData from HTMLFormElement + mutation API
    const form = document.getElementById('profile-form');
    const fd = new FormData(form);
    const fromForm = Array.from(fd.entries());
    fd.append('tags', 'ts');
    fd.set('username', 'grace');
    const allTags = fd.getAll('tags');
    const hasBio = fd.has('bio');
    fd.delete('newsletter');
    const forEachPairs = [];
    fd.forEach((v, k) => forEachPairs.push(k + '=' + v));

    // 2. DOMParser returning a real virtual Document
    const parsedDoc = new DOMParser().parseFromString(
      '<!DOCTYPE html><html><head><title>Parsed</title></head><body><section class="card"><p data-k="1">One</p><p data-k="2">Two</p></section></body></html>',
      'text/html',
    );
    const parsedSummary = {
      isDoc: parsedDoc instanceof Document,
      title: parsedDoc.title,
      items: parsedDoc.querySelectorAll('section.card p').map(el => el.dataset.k + ':' + el.textContent),
    };

    // 3. requestAnimationFrame / cancelAnimationFrame (+16ms frames) & queueMicrotask
    const rafLog = [];
    const cancelledRaf = requestAnimationFrame(() => rafLog.push('cancelled'));
    cancelAnimationFrame(cancelledRaf);
    requestAnimationFrame(ts1 => {
      rafLog.push('f1:' + ts1);
      requestAnimationFrame(ts2 => rafLog.push('f2:' + ts2));
    });
    const microLog = [];
    queueMicrotask(() => microLog.push('m1'));
    queueMicrotask(() => microLog.push('m2'));
    await window.__flushTimersAsync(40);

    // 4. MutationObserver (attributes, childList, characterData, takeRecords, disconnect)
    const box = document.getElementById('box');
    const txtSpan = document.getElementById('txt');
    const mutEvents = [];
    const mo = new MutationObserver(records => {
      for (const r of records) {
        mutEvents.push({
          type: r.type,
          targetId: r.target.id || r.target.nodeName,
          attr: r.attributeName,
          oldValue: r.oldValue,
          added: r.addedNodes.length,
          removed: r.removedNodes.length,
        });
      }
    });
    mo.observe(box, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-state'],
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      subtree: true,
    });
    box.setAttribute('data-state', 'ready');
    box.setAttribute('data-ignored', 'x'); // filtered out
    const child = document.createElement('em');
    child.textContent = 'added';
    box.appendChild(child);
    txtSpan.firstChild.data = 'updated';
    await Promise.resolve();
    mo.disconnect();
    box.setAttribute('data-state', 'after-disconnect');
    await Promise.resolve();

    // 5. ResizeObserver & IntersectionObserver
    const resizeSizes = [];
    const ro = new ResizeObserver(entries => {
      for (const e of entries) resizeSizes.push([e.contentRect.width, e.contentRect.height]);
    });
    ro.observe(box);
    const interEvents = [];
    const io = new IntersectionObserver(entries => {
      for (const e of entries) interEvents.push([e.target.id, e.isIntersecting, e.intersectionRatio]);
    });
    io.observe(box);
    io.observe(document.getElementById('hidden-box'));
    await Promise.resolve();
    ro.disconnect();
    io.disconnect();

    // 6. getBoundingClientRect & window.getComputedStyle
    const rect = box.getBoundingClientRect();
    const cs = window.getComputedStyle(box);
    const hiddenCs = window.getComputedStyle(document.getElementById('hidden-box'));

    return {
      fromForm,
      allTags,
      hasBio,
      userAfterSet: fd.get('username'),
      hasNewsletterAfterDelete: fd.has('newsletter'),
      forEachCount: forEachPairs.length,
      parsedSummary,
      rafLog,
      microLog,
      perfNow: performance.now(),
      mutEvents,
      resizeSizes,
      interEvents,
      rect: rect.toJSON(),
      computed: {
        display: cs.display,
        color: cs.getPropertyValue('color'),
        accent: cs.getPropertyValue('--accent-color'),
        hiddenDisplay: hiddenCs.display,
      },
    };
  }`;

  const exported = await exportTinkerExample(browserTask(source, {
    id: 'dom-expansion-suite',
    initialHtml,
  }), {traceFormat: 'compact'});

  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  assert.equal(exported.messages.some(m => m.role === 'tool_declare'), false);
  const comp = parseStudentAction(exported.messages.at(-1));
  assert.equal(comp.kind, 'return');
  assert.deepEqual(comp.value, {
    fromForm: [
      ['username', 'ada'],
      ['newsletter', 'yes'],
      ['plan', 'pro'],
      ['role', 'admin'],
      ['tags', 'js'],
      ['tags', 'py'],
      ['bio', 'Hello DOM'],
    ],
    allTags: ['js', 'py', 'ts'],
    hasBio: true,
    userAfterSet: 'grace',
    hasNewsletterAfterDelete: false,
    forEachCount: 7,
    parsedSummary: {
      isDoc: true,
      title: 'Parsed',
      items: ['1:One', '2:Two'],
    },
    rafLog: ['f1:16', 'f2:32'],
    microLog: ['m1', 'm2'],
    perfNow: 40,
    mutEvents: [
      {type: 'attributes', targetId: 'box', attr: 'data-state', oldValue: null, added: 0, removed: 0},
      {type: 'childList', targetId: 'box', attr: null, oldValue: null, added: 1, removed: 0},
      {type: 'characterData', targetId: '#text', attr: null, oldValue: 'start', added: 0, removed: 0},
    ],
    resizeSizes: [[120, 45]],
    interEvents: [['box', true, 1], ['hidden-box', false, 0]],
    rect: {x: 10, y: 20, width: 120, height: 45, top: 20, left: 10, right: 130, bottom: 65},
    computed: {
      display: 'block',
      color: 'crimson',
      accent: 'teal',
      hiddenDisplay: 'none',
    },
  });
});


