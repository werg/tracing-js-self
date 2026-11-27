#!/usr/bin/env node
// Reproducible generator & verifier for 64 realistic Frontend / Browser / DOM
// execution tasks across 16 distinct families (4 variants each, including causal
// diverging pairs), using real cached frontend libraries (hyperapp, htm, marked,
// mustache, mitt, ufo) plus realistic interactive web app components.
//
// 100% verified via:
//   - exportTinkerExample(task, {traceFormat: 'compact', reasoningChannel: 'thinking'})
//   - auditTinkerSupervision(..., {formats: ['compact'], samplePerFeature: 1000})
//   - Inkling-2-Mini 65k token budget (< 28,000 approx tokens)

import {mkdirSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import vm from 'node:vm';
import {
  assistantThinkingText,
  encodeReadable,
  exportTinkerExample,
} from '../src/training/tinker-execution.js';
import {auditTinkerSupervision} from '../src/training/tinker-supervision.js';
import {normalizeFetchRequest, VM_FETCH_RUNTIME_SCRIPT} from '../src/training/tinker-http-fetch.js';
import {
  DEFAULT_BROWSER_HTML,
  DEFAULT_BROWSER_URL,
  VM_BROWSER_DOM_RUNTIME_SCRIPT,
} from '../src/training/tinker-browser-dom.js';

process.on('unhandledRejection', () => {});

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(__dirname, '../runs/frontend-browser-tasks/tasks.jsonl');
const MAX_APPROX_TOKENS = 28000;

const {values} = parseArgs({
  allowNegative: true,
  options: {
    output: {type: 'string', short: 'o', default: DEFAULT_OUTPUT},
    jobs: {type: 'string', default: '4'},
    limit: {type: 'string'},
    audit: {type: 'boolean', default: true},
    help: {type: 'boolean', short: 'h'},
  },
});

if (values.help) {
  console.log(`Usage: node tools/tinker-build-frontend-tasks.mjs [options]
  -o, --output <path>   Output JSONL path (default: ${DEFAULT_OUTPUT})
  --jobs <n>            Parallel verification workers (default: 4)
  --limit <n>           Build only the first N tasks
  --no-audit            Skip full auditTinkerSupervision pass`);
  process.exit(0);
}

const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));
const limit = values.limit ? Math.max(1, Number(values.limit)) : null;

const req = createRequire('/tmp/tinker-harvest-env/package.json');
const esbuild = req('esbuild');

// ==================== Cached Frontend Library Bundler ====================
const bundleCache = new Map();

function bundleLib(key, spec) {
  if (bundleCache.has(key)) return bundleCache.get(key);
  const res = esbuild.buildSync({
    stdin: {
      contents: spec.stdin,
      resolveDir: spec.resolveDir,
      loader: spec.loader ?? 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minifyWhitespace: spec.minify ?? true,
    minifySyntax: spec.minify ?? true,
    minifyIdentifiers: spec.minifyId ?? false,
    legalComments: 'none',
  });
  let code = res.outputFiles[0].text.trim();
  // Strip any leading/trailing IIFE noise cleanly; expose var __lib = ...
  code = 'var __lib;\n' + code;
  bundleCache.set(key, code);
  return code;
}

const LIBS = {
  hyperapp: () => bundleLib('hyperapp', {
    resolveDir: '/tmp/tinker-harvest-dgx/jorgebucaran__hyperapp',
    stdin: 'import {app, h, text, memo} from "./index.js"; __lib = {app, h, text, memo};',
    minify: true,
    minifyId: false,
  }),
  htm: () => bundleLib('htm', {
    resolveDir: '/tmp/tinker-harvest-dgx/developit__htm/src',
    stdin: 'import htm from "./index.mjs"; __lib = htm;',
    minify: true,
    minifyId: false,
  }),
  marked: () => bundleLib('marked', {
    resolveDir: '/tmp/tinker-harvest-dgx-wave2/markedjs__marked',
    stdin: 'import {_Lexer} from "./src/Lexer.ts"; import {_Parser} from "./src/Parser.ts"; __lib = {Lexer: _Lexer, Parser: _Parser};',
    loader: 'ts',
    minify: true,
    minifyId: true,
  }),
  mustache: () => bundleLib('mustache', {
    resolveDir: '/tmp/tinker-harvest-dgx/janl__mustache.js',
    stdin: 'import Mustache from "./mustache.js"; __lib = Mustache;',
    minify: true,
    minifyId: true,
  }),
  mitt: () => bundleLib('mitt', {
    resolveDir: '/tmp/tinker-harvest-env/node_modules/mitt/dist',
    stdin: 'import mitt from "./mitt.mjs"; __lib = mitt;',
    minify: true,
    minifyId: false,
  }),
  ufo: () => bundleLib('ufo', {
    resolveDir: '/tmp/tinker-harvest-env/node_modules/ufo/dist',
    stdin: 'import {parseURL, parseQuery, withQuery, joinURL, cleanDoubleSlashes} from "./index.mjs"; __lib = {parseURL, parseQuery, withQuery, joinURL, cleanDoubleSlashes};',
    minify: true,
    minifyId: false,
  }),
};

// ==================== Deterministic Fixture Auto-Recorder ====================
async function recordBrowserFixture({
  source,
  entry = 'run',
  args = [],
  initialHtml = DEFAULT_BROWSER_HTML,
  initialUrl = DEFAULT_BROWSER_URL,
  storage = {},
  dialogs = {},
  http = null,
  now = [],
}) {
  const localMap = new Map(Object.entries(storage.local ?? {}));
  const sessionMap = new Map(Object.entries(storage.session ?? {}));
  const confirms = Array.isArray(dialogs.confirm) ? [...dialogs.confirm] : [];
  const prompts = Array.isArray(dialogs.prompt) ? [...dialogs.prompt] : [];
  const timestamps = Array.isArray(now) ? [...now] : [];
  let nowIdx = 0;
  let confirmIdx = 0;
  let promptIdx = 0;
  let httpIdx = 0;
  const calls = [];

  const getMap = area => (area === 'session' ? sessionMap : localMap);

  const browserInvoke = (op, rawArgs) => {
    const opArgs = Array.from(rawArgs ?? []);
    let result = null;
    if (op === 'browser.storageGet') {
      const [area, key] = opArgs;
      const m = getMap(area);
      result = m.has(key) ? String(m.get(key)) : null;
    } else if (op === 'browser.storageSet') {
      const [area, key, val] = opArgs;
      getMap(area).set(key, String(val));
      result = null;
    } else if (op === 'browser.storageRemove') {
      const [area, key] = opArgs;
      getMap(area).delete(key);
      result = null;
    } else if (op === 'browser.storageClear') {
      const [area] = opArgs;
      getMap(area).clear();
      result = null;
    } else if (op === 'browser.alert') {
      result = null;
    } else if (op === 'browser.confirm') {
      result = confirmIdx < confirms.length ? Boolean(confirms[confirmIdx++]) : true;
    } else if (op === 'browser.prompt') {
      result = promptIdx < prompts.length ? prompts[promptIdx++] : opArgs[1] ?? '';
    } else {
      throw new Error('Unsupported browser op in recorder: ' + op);
    }
    calls.push({operation: op, arguments: encodeReadable(opArgs), status: 'fulfilled', result: encodeReadable(result)});
    return result;
  };

  const platformFetch = async (reqInput, reqInit) => {
    const normalized = normalizeFetchRequest(reqInput, reqInit);
    const [url, method, headers, body] = normalized;
    const resp = typeof http === 'function'
      ? await http({url, method, headers, body, index: httpIdx++})
      : Array.isArray(http) ? http[httpIdx++] : null;
    if (!resp) throw new Error(`No mock HTTP response for ${method} ${url}`);
    if (resp.reject) {
      const errObj = {name: resp.reject.name ?? 'TypeError', message: resp.reject.message ?? 'fetch failed'};
      calls.push({operation: 'http.request', arguments: encodeReadable(normalized), status: 'rejected', result: errObj});
      throw errObj;
    }
    const payload = {
      status: resp.status ?? 200,
      statusText: resp.statusText ?? (resp.status >= 400 ? 'Error' : 'OK'),
      url: resp.url ?? url,
      headers: resp.headers ?? {'content-type': 'application/json'},
      body: typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.json ?? {}),
    };
    calls.push({operation: 'http.request', arguments: encodeReadable(normalized), status: 'fulfilled', result: encodeReadable(payload)});
    return payload;
  };

  const recordConsole = method => (...cArgs) => {
    const hostArgs = Array.from(cArgs);
    calls.push({
      operation: 'platform.console.' + method,
      arguments: encodeReadable(hostArgs),
      status: 'fulfilled',
      result: encodeReadable(undefined),
    });
  };

  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone,
    queueMicrotask,
    __platformFetch: platformFetch,
    __browserInvoke: browserInvoke,
    __browserInitialHtml: initialHtml,
    __browserInitialUrl: initialUrl,
    __args: structuredClone(args),
    __result: undefined,
    console: {
      log: recordConsole('log'),
      info: recordConsole('info'),
      warn: recordConsole('warn'),
      error: recordConsole('error'),
    },
  });

  new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});
  if (timestamps.length > 0) {
    context.__platformDateNow = () => {
      const val = timestamps[Math.min(nowIdx++, timestamps.length - 1)];
      calls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: val});
      return val;
    };
    new vm.Script('Date.now = __platformDateNow;').runInContext(context, {timeout: 5000});
  }
  new vm.Script(VM_BROWSER_DOM_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});
  new vm.Script(`"use strict";\n${source}\n__result = ${entry}.apply(undefined, __args);`).runInContext(context, {timeout: 5000});

  let val = context.__result;
  if (val && typeof val.then === 'function') {
    let settled = false;
    const tracked = Promise.resolve(val).then(
      res => { settled = true; return {ok: true, res}; },
      err => { settled = true; return {ok: false, err}; },
    );
    for (let steps = 0; steps < 2000 && !settled; steps++) {
      await new Promise(r => setImmediate(r));
      if (settled) break;
      if (context.__browserHasPendingTimers && context.__browserHasPendingTimers()) {
        context.__browserStepNextTimer();
      } else {
        break;
      }
    }
    const box = await tracked;
    if (!box.ok) throw box.err;
  }

  return {calls};
}

// Helper to construct a task record cleanly
async function buildTask({
  id,
  family,
  source,
  args = [],
  initialHtml = DEFAULT_BROWSER_HTML,
  initialUrl = DEFAULT_BROWSER_URL,
  mock = null,
  extraFeatures = [],
  meta = {},
}) {
  const fixture = mock
    ? await recordBrowserFixture({source, args, initialHtml, initialUrl, ...mock})
    : {calls: []};
  const features = [
    'frontend',
    'browser-dom',
    'hairy-real',
    'native-v8',
    ...(fixture.calls.length > 0 ? ['external'] : []),
    ...extraFeatures,
  ];
  return {
    id,
    family,
    environment: 'browser',
    executionMode: 'native',
    source,
    entry: 'run',
    args,
    initialHtml,
    initialUrl,
    fixture,
    tier: 5,
    features: [...new Set(features)],
    metadata: {
      tier: 5,
      environment: 'browser',
      ...meta,
    },
  };
}

// ==================== 16 Frontend / Browser Task Families (64 tasks) ====================

async function buildAllTasks() {
  const tasks = [];

  // ---------------------------------------------------------------------------
  // Family 1: Multi-step form validation & draft persistence (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:form-validation-draft';
    const initialHtml = `<!DOCTYPE html><html><head><title>Account Setup</title></head><body>
<form id="signup-form">
  <div id="banner" class="banner hidden" role="alert"></div>
  <input id="email" name="email" type="email" value="" />
  <input id="org" name="org" type="text" value="" />
  <input id="seats" name="seats" type="number" value="1" />
  <input id="terms" name="terms" type="checkbox" />
  <button id="submit-btn" type="submit">Create Workspace</button>
</form>
</body></html>`;
    const initialUrl = 'https://app.acme.test/signup';
    const source = `async function run(steps) {
  const form = document.getElementById('signup-form');
  const banner = document.getElementById('banner');
  const emailEl = document.getElementById('email');
  const orgEl = document.getElementById('org');
  const seatsEl = document.getElementById('seats');
  const termsEl = document.getElementById('terms');
  const submitBtn = document.getElementById('submit-btn');

  const rawDraft = localStorage.getItem('signup_draft');
  if (rawDraft) {
    const draft = JSON.parse(rawDraft);
    if (draft.email) emailEl.value = draft.email;
    if (draft.org) orgEl.value = draft.org;
    if (draft.seats) seatsEl.value = String(draft.seats);
  }

  function saveDraft() {
    localStorage.setItem('signup_draft', JSON.stringify({
      email: emailEl.value.trim(),
      org: orgEl.value.trim(),
      seats: Number(seatsEl.value) || 1,
    }));
  }

  function validate() {
    const errors = [];
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(emailEl.value.trim())) errors.push('invalid-email');
    if (orgEl.value.trim().length < 2) errors.push('org-too-short');
    const seats = Number(seatsEl.value);
    if (!Number.isInteger(seats) || seats < 1 || seats > 100) errors.push('invalid-seats');
    if (!termsEl.checked) errors.push('terms-required');
    return errors;
  }

  form.addEventListener('input', () => saveDraft());

  let submitPromise = null;
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const errs = validate();
    if (errs.length) {
      banner.className = 'banner error';
      banner.textContent = 'Fix: ' + errs.join(', ');
      submitPromise = Promise.resolve({ok: false, errors: errs});
      return;
    }
    submitBtn.disabled = true;
    banner.className = 'banner pending';
    banner.textContent = 'Submitting...';
    submitPromise = (async () => {
      try {
        const res = await fetch('https://api.acme.test/workspaces', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            email: emailEl.value.trim(),
            org: orgEl.value.trim(),
            seats: Number(seatsEl.value),
          }),
        });
        const data = await res.json();
        if (res.ok) {
          localStorage.removeItem('signup_draft');
          banner.className = 'banner success';
          banner.textContent = 'Created ' + data.workspaceId;
          return {ok: true, workspaceId: data.workspaceId};
        }
        submitBtn.disabled = false;
        console.warn('signup-rejected', res.status);
        banner.className = 'banner error';
        banner.textContent = data.error || ('HTTP ' + res.status);
        return {ok: false, status: res.status, error: data.error};
      } catch (err) {
        submitBtn.disabled = false;
        console.error('signup-network-error', err.message);
        banner.className = 'banner error';
        banner.textContent = 'Network failed';
        return {ok: false, networkError: err.message};
      }
    })();
  });

  for (const step of steps) {
    if (step.field === 'email') {
      emailEl.value = step.value;
      emailEl.dispatchEvent(new InputEvent('input', {bubbles: true, data: step.value}));
    } else if (step.field === 'org') {
      orgEl.value = step.value;
      orgEl.dispatchEvent(new InputEvent('input', {bubbles: true, data: step.value}));
    } else if (step.field === 'seats') {
      seatsEl.value = String(step.value);
      seatsEl.dispatchEvent(new InputEvent('input', {bubbles: true}));
    } else if (step.field === 'terms') {
      termsEl.click();
    }
  }
  submitBtn.click();
  const outcome = await submitPromise;
  return {
    outcome,
    bannerClass: banner.className,
    bannerText: banner.textContent,
    disabled: submitBtn.disabled,
  };
}`;

    const commonArgs = [[
      {field: 'email', value: 'ada@acme.test'},
      {field: 'org', value: 'Acme Labs'},
      {field: 'seats', value: 12},
      {field: 'terms'},
    ]];
    // Causal pair 1a / 1b: identical public prompt, diverging on fetch 201 vs 422
    tasks.push(await buildTask({
      id: 'frontend-form-draft-ok',
      family,
      source,
      args: commonArgs,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {
        storage: {local: {signup_draft: JSON.stringify({email: 'old@acme.test', org: 'Old', seats: 2})}},
        http: () => ({status: 201, statusText: 'Created', json: {workspaceId: 'ws_901'}}),
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-form-draft-422',
      family,
      source,
      args: commonArgs,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {
        storage: {local: {signup_draft: JSON.stringify({email: 'old@acme.test', org: 'Old', seats: 2})}},
        http: () => ({status: 422, statusText: 'Unprocessable Entity', json: {error: 'Domain already claimed'}}),
      },
    }));
    // Variant 1c: network rejection rollback
    tasks.push(await buildTask({
      id: 'frontend-form-draft-network-err',
      family,
      source,
      args: [[{field: 'org', value: 'Beta Co'}, {field: 'terms'}]],
      initialHtml,
      initialUrl,
      mock: {
        storage: {local: {signup_draft: JSON.stringify({email: 'ops@beta.test', org: '', seats: 5})}},
        http: () => ({reject: {name: 'TypeError', message: 'connection reset'}}),
      },
    }));
    // Variant 1d: client-side validation blocks fetch completely
    tasks.push(await buildTask({
      id: 'frontend-form-draft-validation-fail',
      family,
      source,
      args: [[{field: 'email', value: 'bad-email'}, {field: 'seats', value: 250}]],
      initialHtml,
      initialUrl,
      mock: {storage: {local: {}}},
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 2: SPA client-side router & view hydration with real `ufo` (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:spa-router-hydration';
    const ufoLib = LIBS.ufo();
    const initialHtml = `<!DOCTYPE html><html><head><title>Docs</title></head><body>
<nav id="nav">
  <a class="nav-link active" href="/overview">Overview</a>
  <a class="nav-link" href="/guides">Guides</a>
  <a class="nav-link" href="/api">API</a>
</nav>
<main id="outlet"><p>Welcome</p></main>
</body></html>`;
    const initialUrl = 'https://docs.example.test/overview';
    const source = `${ufoLib}
async function run(actions) {
  const {parseURL, parseQuery, withQuery, cleanDoubleSlashes} = __lib;
  const navLinks = document.querySelectorAll('#nav a.nav-link');
  const outlet = document.getElementById('outlet');
  const visited = [];

  async function renderRoute() {
    const parsed = parseURL(location.href);
    const path = cleanDoubleSlashes(parsed.pathname || '/');
    const query = parseQuery(parsed.search || '');
    for (const link of navLinks) {
      link.classList.toggle('active', link.getAttribute('href') === path);
    }
    const apiUrl = withQuery('https://cms.example.test/pages' + path, query.lang ? {lang: query.lang} : {});
    const res = await fetch(apiUrl);
    if (!res.ok) {
      document.title = '404 - Not Found';
      outlet.innerHTML = '<section class="not-found">Missing: ' + path + '</section>';
      visited.push({path, status: res.status});
      return;
    }
    const page = await res.json();
    document.title = page.title + ' | Docs';
    outlet.innerHTML = '<article><h1>' + page.title + '</h1><p>' + page.body + '</p></article>';
    visited.push({path, status: 200, title: page.title});
  }

  let popPromise = Promise.resolve();
  window.addEventListener('popstate', () => { popPromise = renderRoute(); });

  for (const act of actions) {
    if (act.type === 'push') {
      history.pushState(act.state ?? null, '', act.url);
      await renderRoute();
    } else if (act.type === 'replace') {
      history.replaceState(act.state ?? null, '', act.url);
      await renderRoute();
    } else if (act.type === 'back') {
      history.back();
      await popPromise;
    }
  }

  return {
    visited,
    activeHref: document.querySelector('#nav a.active')?.getAttribute('href') ?? null,
    historyLength: history.length,
    snapshot: window.__snapshotDom('#outlet'),
  };
}`;

    const navActions = [[
      {type: 'push', url: '/guides?lang=en', state: {sec: 'guides'}},
      {type: 'push', url: '/api?lang=en', state: {sec: 'api'}},
      {type: 'back'},
    ]];
    // Causal pair 2a / 2b: same actions, 2nd route returns 200 vs 404
    tasks.push(await buildTask({
      id: 'frontend-spa-router-ok',
      family,
      source,
      args: navActions,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair', 'ufo'],
      meta: {package: 'ufo'},
      mock: {
        http: ({url}) => {
          if (url.includes('/guides')) return {status: 200, json: {title: 'Guides', body: 'Step by step'}};
          if (url.includes('/api')) return {status: 200, json: {title: 'API Ref', body: 'Endpoints'}};
          return {status: 404, json: {error: 'missing'}};
        },
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-spa-router-404',
      family,
      source,
      args: navActions,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair', 'ufo'],
      meta: {package: 'ufo'},
      mock: {
        http: ({url}) => {
          if (url.includes('/guides')) return {status: 200, json: {title: 'Guides', body: 'Step by step'}};
          return {status: 404, json: {error: 'missing'}};
        },
      },
    }));
    // Variant 2c: replaceState + query change
    tasks.push(await buildTask({
      id: 'frontend-spa-router-replace',
      family,
      source,
      args: [[
        {type: 'replace', url: '/guides?lang=de', state: {locale: 'de'}},
        {type: 'push', url: '/overview?lang=de', state: {locale: 'de'}},
      ]],
      initialHtml,
      initialUrl,
      extraFeatures: ['ufo'],
      meta: {package: 'ufo'},
      mock: {
        http: ({url}) => ({
          status: 200,
          json: url.includes('/guides') ? {title: 'Anleitungen', body: 'Schritt'} : {title: 'Uebersicht', body: 'Hallo'},
        }),
      },
    }));
    // Variant 2d: double back navigation
    tasks.push(await buildTask({
      id: 'frontend-spa-router-back-chain',
      family,
      source,
      args: [[
        {type: 'push', url: '/api', state: {step: 1}},
        {type: 'push', url: '/guides', state: {step: 2}},
        {type: 'back'},
        {type: 'back'},
      ]],
      initialHtml,
      initialUrl,
      extraFeatures: ['ufo'],
      meta: {package: 'ufo'},
      mock: {
        http: ({url}) => ({
          status: 200,
          json: {title: url.split('/').pop().toUpperCase(), body: 'Loaded ' + url},
        }),
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 3: Interactive shopping cart widget (event delegation, confirm, storage, fetch) (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:shopping-cart-widget';
    const initialHtml = `<!DOCTYPE html><html><head><title>Cart</title></head><body>
<section id="cart">
  <ul id="cart-items">
    <li class="cart-row" data-sku="KB-1" data-price="85" data-stock="3"><span class="qty">1</span><button data-action="inc">+</button><button data-action="dec">-</button></li>
    <li class="cart-row" data-sku="MS-2" data-price="40" data-stock="5"><span class="qty">2</span><button data-action="inc">+</button><button data-action="dec">-</button></li>
  </ul>
  <div id="total">$165</div>
  <button id="clear-btn" data-action="clear">Clear</button>
  <button id="checkout-btn" data-action="checkout">Checkout</button>
  <p id="status"></p>
</section>
</body></html>`;
    const initialUrl = 'https://store.example.test/cart';
    const source = `async function run(clicks) {
  const cart = document.getElementById('cart');
  const list = document.getElementById('cart-items');
  const totalEl = document.getElementById('total');
  const statusEl = document.getElementById('status');

  function readState() {
    return list.querySelectorAll('li.cart-row').map(li => ({
      sku: li.dataset.sku,
      price: Number(li.dataset.price),
      stock: Number(li.dataset.stock),
      qty: Number(li.querySelector('.qty').textContent),
    }));
  }

  function syncTotalAndSave() {
    const items = readState();
    const total = items.reduce((s, it) => s + it.price * it.qty, 0);
    totalEl.textContent = '$' + total;
    localStorage.setItem('cart_v1', JSON.stringify({items: items.map(({sku, qty}) => ({sku, qty})), total}));
    return {items, total};
  }

  let pending = Promise.resolve();
  cart.addEventListener('click', ev => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'inc' || action === 'dec') {
      const row = btn.closest('li.cart-row');
      const qtyEl = row.querySelector('.qty');
      const stock = Number(row.dataset.stock);
      let q = Number(qtyEl.textContent) + (action === 'inc' ? 1 : -1);
      if (q > stock) { statusEl.textContent = 'Max stock reached'; return; }
      if (q <= 0) row.remove();
      else qtyEl.textContent = String(q);
      syncTotalAndSave();
    } else if (action === 'clear') {
      if (confirm('Clear all items from cart?')) {
        list.innerHTML = '';
        totalEl.textContent = '$0';
        localStorage.removeItem('cart_v1');
        statusEl.textContent = 'cleared';
      } else {
        statusEl.textContent = 'kept';
      }
    } else if (action === 'checkout') {
      const {items, total} = syncTotalAndSave();
      if (items.length === 0) { statusEl.textContent = 'empty-cart'; return; }
      pending = (async () => {
        const res = await fetch('https://api.store.test/checkout', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({items: items.map(({sku, qty}) => ({sku, qty})), total}),
        });
        const data = await res.json();
        statusEl.textContent = res.ok ? 'paid:' + data.receiptId : 'declined:' + res.status;
      })();
    }
  });

  for (const selector of clicks) {
    const el = document.querySelector(selector);
    if (el) el.click();
    await pending;
  }

  return {
    total: totalEl.textContent,
    status: statusEl.textContent,
    remainingSkus: list.querySelectorAll('li.cart-row').map(li => li.dataset.sku + ':' + li.querySelector('.qty').textContent),
  };
}`;

    // Causal pair 3a / 3b: user clicks inc then clear -> confirm(true) vs confirm(false)
    const clearClicks = [['li[data-sku="KB-1"] button[data-action="inc"]', '#clear-btn']];
    tasks.push(await buildTask({
      id: 'frontend-cart-clear-confirm-yes',
      family,
      source,
      args: clearClicks,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {dialogs: {confirm: [true]}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-cart-clear-confirm-no',
      family,
      source,
      args: clearClicks,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {dialogs: {confirm: [false]}},
    }));
    // Variant 3c: stock cap + checkout success
    tasks.push(await buildTask({
      id: 'frontend-cart-stock-cap-checkout',
      family,
      source,
      args: [[
        'li[data-sku="KB-1"] button[data-action="inc"]',
        'li[data-sku="KB-1"] button[data-action="inc"]',
        'li[data-sku="KB-1"] button[data-action="inc"]',
        '#checkout-btn',
      ]],
      initialHtml,
      initialUrl,
      mock: {http: () => ({status: 200, json: {receiptId: 'RCP-4040'}})},
    }));
    // Variant 3d: decrement item to 0 (removes row) + checkout declined
    tasks.push(await buildTask({
      id: 'frontend-cart-remove-row-declined',
      family,
      source,
      args: [[
        'li[data-sku="KB-1"] button[data-action="dec"]',
        'li[data-sku="MS-2"] button[data-action="inc"]',
        '#checkout-btn',
      ]],
      initialHtml,
      initialUrl,
      mock: {http: () => ({status: 402, json: {error: 'card_declined'}})},
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 4: Live debounced search & filterable table (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:debounced-search-table';
    const initialHtml = `<!DOCTYPE html><html><head><title>Package Search</title></head><body>
<input id="search" type="search" value="" />
<select id="sort"><option value="name" selected>Name</option><option value="stars">Stars</option></select>
<span id="status">idle</span>
<table><tbody id="rows"></tbody></table>
</body></html>`;
    const initialUrl = 'https://registry.example.test/search';
    const source = `async function run(events) {
  const search = document.getElementById('search');
  const sort = document.getElementById('sort');
  const status = document.getElementById('status');
  const rows = document.getElementById('rows');
  let timer = null;
  let requests = 0;

  function renderTable(items) {
    const key = sort.value;
    const sorted = items.slice().sort((a, b) =>
      key === 'stars' ? b.stars - a.stars : a.name.localeCompare(b.name),
    );
    if (!sorted.length) {
      rows.innerHTML = '<tr class="empty"><td colspan="2">No matches</td></tr>';
      status.textContent = '0 results';
      return;
    }
    rows.innerHTML = sorted
      .map(it => '<tr data-pkg="' + it.name + '"><td>' + it.name + '</td><td>' + it.stars + '</td></tr>')
      .join('');
    status.textContent = sorted.length + ' results';
  }

  function scheduleQuery() {
    if (timer !== null) clearTimeout(timer);
    const q = search.value.trim();
    if (!q) {
      rows.innerHTML = '';
      status.textContent = 'idle';
      return;
    }
    status.textContent = 'waiting';
    timer = setTimeout(async () => {
      timer = null;
      requests++;
      const res = await fetch('https://api.registry.test/search?q=' + encodeURIComponent(q));
      if (!res.ok) {
        status.textContent = 'error:' + res.status;
        rows.innerHTML = '';
        return;
      }
      const data = await res.json();
      renderTable(data.items);
    }, 200);
  }

  search.addEventListener('input', scheduleQuery);
  sort.addEventListener('change', scheduleQuery);

  for (const ev of events) {
    if (ev.type === 'type') {
      search.value = ev.value;
      search.dispatchEvent(new InputEvent('input', {bubbles: true, data: ev.value}));
    } else if (ev.type === 'sort') {
      sort.value = ev.value;
      sort.dispatchEvent(new Event('change', {bubbles: true}));
    } else if (ev.type === 'wait') {
      await window.__flushTimersAsync(ev.ms);
    }
  }
  await window.__flushTimersAsync(400);

  return {
    requests,
    status: status.textContent,
    pkgs: rows.querySelectorAll('tr[data-pkg]').map(tr => tr.dataset.pkg + ':' + tr.children[1].textContent),
    empty: Boolean(rows.querySelector('tr.empty')),
  };
}`;

    const burstEvents = [[
      {type: 'type', value: 'vi'},
      {type: 'wait', ms: 80},
      {type: 'type', value: 'vit'},
      {type: 'wait', ms: 80},
      {type: 'type', value: 'vite'},
      {type: 'sort', value: 'stars'},
    ]];
    // Causal pair 4a / 4b: same debounced burst, diverging on fetch hits vs empty
    tasks.push(await buildTask({
      id: 'frontend-debounce-search-hits',
      family,
      source,
      args: burstEvents,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {
        http: () => ({status: 200, json: {items: [{name: 'vitest', stars: 14000}, {name: 'vite', stars: 71000}, {name: 'vitepress', stars: 13500}]}}),
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-debounce-search-empty',
      family,
      source,
      args: burstEvents,
      initialHtml,
      initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {
        http: () => ({status: 200, json: {items: []}}),
      },
    }));
    // Variant 4c: two distinct settled queries + server 503 on second
    tasks.push(await buildTask({
      id: 'frontend-debounce-search-two-queries',
      family,
      source,
      args: [[
        {type: 'type', value: 'dom'},
        {type: 'wait', ms: 250},
        {type: 'type', value: 'dom-purify'},
        {type: 'wait', ms: 250},
      ]],
      initialHtml,
      initialUrl,
      mock: {
        http: ({index}) => index === 0
          ? {status: 200, json: {items: [{name: 'dom-utils', stars: 900}]}}
          : {status: 503, json: {error: 'busy'}},
      },
    }));
    // Variant 4d: clear input cancels pending timer -> zero fetches
    tasks.push(await buildTask({
      id: 'frontend-debounce-search-cancel',
      family,
      source,
      args: [[
        {type: 'type', value: 'abc'},
        {type: 'wait', ms: 100},
        {type: 'type', value: ''},
        {type: 'wait', ms: 300},
      ]],
      initialHtml,
      initialUrl,
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 5: Event capture/bubble & modal/dropdown ARIA controller (4 variants)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:modal-dropdown-events';
    const initialHtml = `<!DOCTYPE html><html><head><title>Overlays</title></head><body>
<div id="backdrop" class="backdrop">
  <button id="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button>
  <div id="menu" hidden>
    <button class="menu-item" data-cmd="rename">Rename</button>
    <button class="menu-item" data-cmd="archive">Archive</button>
  </div>
  <div id="modal" role="dialog" aria-hidden="true" hidden>
    <div id="modal-card">
      <input id="modal-input" value="Draft" />
      <button id="modal-save">Save</button>
      <button id="modal-close">Close</button>
    </div>
  </div>
</div>
</body></html>`;
    const initialUrl = 'https://ui.example.test/overlays';
    const source = `function run(script) {
  const backdrop = document.getElementById('backdrop');
  const toggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('menu');
  const modal = document.getElementById('modal');
  const card = document.getElementById('modal-card');
  const modalInput = document.getElementById('modal-input');
  const log = [];

  document.addEventListener('click', () => {
    log.push('doc:capture');
  }, {capture: true});

  toggle.addEventListener('click', ev => {
    ev.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    log.push('menu:' + (open ? 'open' : 'close'));
  });

  menu.addEventListener('click', ev => {
    const item = ev.target.closest('.menu-item');
    if (!item) return;
    ev.stopPropagation();
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    log.push('cmd:' + item.dataset.cmd);
    if (item.dataset.cmd === 'rename') {
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      modalInput.focus();
    }
  });

  card.addEventListener('click', ev => {
    ev.stopPropagation();
    if (ev.target.id === 'modal-close') {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      toggle.focus();
      log.push('modal:close-btn');
    } else if (ev.target.id === 'modal-save') {
      log.push('modal:save:' + modalInput.value);
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
    }
  });

  backdrop.addEventListener('click', () => {
    if (!menu.hidden) {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      log.push('backdrop:close-menu');
    }
    if (!modal.hidden) {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      log.push('backdrop:close-modal');
    }
  });

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !modal.hidden) {
      ev.preventDefault();
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      toggle.focus();
      log.push('key:escape-modal');
    }
  });

  for (const step of script) {
    if (step.click) document.querySelector(step.click).click();
    if (step.input !== undefined) modalInput.value = step.input;
    if (step.key) document.dispatchEvent(new KeyboardEvent('keydown', {key: step.key, bubbles: true, cancelable: true}));
  }

  return {
    log,
    menuHidden: menu.hidden,
    ariaExpanded: toggle.getAttribute('aria-expanded'),
    modalHidden: modal.hidden,
    ariaHidden: modal.getAttribute('aria-hidden'),
    activeId: document.activeElement?.id ?? null,
  };
}`;

    tasks.push(await buildTask({
      id: 'frontend-overlay-open-rename-save',
      family, source, initialHtml, initialUrl,
      args: [[{click: '#menu-toggle'}, {click: '[data-cmd="rename"]'}, {input: 'Q4 Plan'}, {click: '#modal-save'}]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-overlay-escape-dismiss',
      family, source, initialHtml, initialUrl,
      args: [[{click: '#menu-toggle'}, {click: '[data-cmd="rename"]'}, {key: 'Escape'}]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-overlay-backdrop-close',
      family, source, initialHtml, initialUrl,
      args: [[{click: '#menu-toggle'}, {click: '#backdrop'}]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-overlay-archive-cmd',
      family, source, initialHtml, initialUrl,
      args: [[{click: '#menu-toggle'}, {click: '[data-cmd="archive"]'}, {click: '#menu-toggle'}, {click: '#menu-toggle'}]],
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 6: Real `hyperapp` VDOM reconciliation & keyed list diffing (4 variants)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:hyperapp-vdom-reconcile';
    const hyperappLib = LIBS.hyperapp();
    const initialHtml = `<!DOCTYPE html><html><head><title>Hyperapp Tasks</title></head><body><div id="root"></div></body></html>`;
    const initialUrl = 'https://vdom.example.test/hyperapp';
    const source = `${hyperappLib}
function run(ops) {
  const {app, h, text} = __lib;
  const Add = (state, title) => ({
    ...state,
    nextId: state.nextId + 1,
    items: [...state.items, {id: state.nextId, title, done: false}],
  });
  const Toggle = (state, id) => ({
    ...state,
    items: state.items.map(it => it.id === id ? {...it, done: !it.done} : it),
  });
  const Reverse = state => ({...state, items: state.items.slice().reverse()});
  const SetFilter = (state, filter) => ({...state, filter});

  const visibleItems = state => state.items.filter(it =>
    state.filter === 'all' ? true : state.filter === 'done' ? it.done : !it.done,
  );

  const dispatch = app({
    node: document.getElementById('root'),
    init: {
      nextId: 3,
      filter: 'all',
      items: [
        {id: 1, title: 'Parse HTML', done: true},
        {id: 2, title: 'Diff VDOM', done: false},
      ],
    },
    view: state => h('div', {id: 'root', class: 'board'}, [
      h('h2', {}, text('Filter: ' + state.filter + ' (' + visibleItems(state).length + ')')),
      h('button', {id: 'rev-btn', onclick: Reverse}, text('Reverse')),
      h('ul', {id: 'todo-list'}, visibleItems(state).map(it =>
        h('li', {key: it.id, class: {done: it.done}, 'data-id': String(it.id), onclick: [Toggle, it.id]}, text(it.title)),
      )),
    ]),
  });
  window.__flushTimers(32);

  for (const op of ops) {
    if (op.type === 'add') dispatch(Add, op.title);
    else if (op.type === 'filter') dispatch(SetFilter, op.filter);
    else if (op.type === 'click') document.querySelector(op.selector).click();
    window.__flushTimers(32);
  }

  return {
    heading: document.querySelector('#root h2').textContent,
    items: document.querySelectorAll('#todo-list li').map(li => ({
      id: li.getAttribute('data-id'),
      cls: li.className,
      text: li.textContent,
    })),
    html: document.getElementById('root').outerHTML,
  };
}`;

    tasks.push(await buildTask({
      id: 'frontend-hyperapp-add-toggle',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['hyperapp', 'vdom'], meta: {package: 'hyperapp'},
      args: [[{type: 'add', title: 'Ship build'}, {type: 'click', selector: 'li[data-id="2"]'}]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-hyperapp-reverse-keyed',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['hyperapp', 'vdom'], meta: {package: 'hyperapp'},
      args: [[{type: 'add', title: 'Write tests'}, {type: 'click', selector: '#rev-btn'}]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-hyperapp-filter-open',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['hyperapp', 'vdom'], meta: {package: 'hyperapp'},
      args: [[{type: 'add', title: 'Audit trace'}, {type: 'filter', filter: 'open'}, {type: 'click', selector: 'li[data-id="2"]'}]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-hyperapp-filter-done',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['hyperapp', 'vdom'], meta: {package: 'hyperapp'},
      args: [[{type: 'click', selector: 'li[data-id="2"]'}, {type: 'filter', filter: 'done'}, {type: 'click', selector: '#rev-btn'}]],
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 7: Real `developit/htm` JSX-to-DOM renderer + localStorage filter (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:htm-vdom-renderer';
    const htmLib = LIBS.htm();
    const initialHtml = `<!DOCTYPE html><html><head><title>Metrics</title></head><body><div id="mount"></div></body></html>`;
    const initialUrl = 'https://dash.example.test/metrics';
    const source = `${htmLib}
function run(cards, nextCategory) {
  function h(type, props, ...children) {
    const el = document.createElement(type);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v !== false && v != null) {
          el.setAttribute(k, v === true ? '' : String(v));
        }
      }
    }
    const appendChild = ch => {
      if (Array.isArray(ch)) ch.forEach(appendChild);
      else if (ch != null && ch !== false && ch !== true) {
        el.appendChild(ch instanceof Node ? ch : document.createTextNode(String(ch)));
      }
    };
    children.forEach(appendChild);
    return el;
  }
  const html = __lib.bind(h);
  const mount = document.getElementById('mount');
  let category = localStorage.getItem('metrics_cat') || 'all';
  let selectedId = null;

  function render() {
    const filtered = category === 'all' ? cards : cards.filter(c => c.cat === category);
    const tree = html\`<section class="grid" data-category=\${category}>
      <header><span>Showing \${filtered.length}</span></header>
      <div class="cards">\${filtered.map(c => html\`<article class=\${selectedId === c.id ? 'card selected' : 'card'} data-id=\${c.id} onClick=\${() => { selectedId = c.id; render(); }}><h3>\${c.name}</h3><strong>\${c.value}</strong></article>\`)}</div>
    </section>\`;
    mount.replaceChildren(tree);
  }

  render();
  const initialCount = mount.querySelectorAll('article.card').length;
  if (nextCategory && nextCategory !== category) {
    category = nextCategory;
    localStorage.setItem('metrics_cat', category);
    render();
  }
  const firstCard = mount.querySelector('article.card');
  if (firstCard) firstCard.click();

  return {
    initialCount,
    category,
    selectedId,
    renderedIds: mount.querySelectorAll('article.card').map(el => el.dataset.id + (el.classList.contains('selected') ? '*' : '')),
  };
}`;

    const sampleCards = [
      {id: 'm1', name: 'Latency', cat: 'perf', value: '42ms'},
      {id: 'm2', name: 'Error Rate', cat: 'rel', value: '0.1%'},
      {id: 'm3', name: 'Throughput', cat: 'perf', value: '1.8k/s'},
    ];
    // Causal pair 7a / 7b: same args, diverging on stored metrics_cat ('perf' vs 'rel')
    tasks.push(await buildTask({
      id: 'frontend-htm-saved-perf',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair', 'htm'], meta: {package: 'htm'},
      args: [sampleCards, null],
      mock: {storage: {local: {metrics_cat: 'perf'}}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-htm-saved-rel',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair', 'htm'], meta: {package: 'htm'},
      args: [sampleCards, null],
      mock: {storage: {local: {metrics_cat: 'rel'}}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-htm-switch-cat',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['htm'], meta: {package: 'htm'},
      args: [sampleCards, 'perf'],
      mock: {storage: {local: {}}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-htm-empty-cat',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['htm'], meta: {package: 'htm'},
      args: [sampleCards, 'billing'],
      mock: {storage: {local: {metrics_cat: 'all'}}},
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 8: Real `marked` Markdown -> DOM Sanitizer pipeline (4 variants)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:marked-sanitizer-pipeline';
    const markedLib = LIBS.marked();
    const initialHtml = `<!DOCTYPE html><html><head><title>Markdown Preview</title></head><body><div id="preview"></div><span id="stripped">0</span></body></html>`;
    const initialUrl = 'https://editor.example.test/preview';
    const source = `${markedLib}
function run(markdown) {
  const {Lexer, Parser} = __lib;
  const rawHtml = Parser.parse(Lexer.lex(markdown));
  const parsed = new DOMParser().parseFromString(rawHtml, 'text/html');
  const blockedTags = new Set(['script', 'iframe', 'object', 'embed', 'style']);
  let strippedCount = 0;

  function sanitize(node) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (blockedTags.has(child.localName)) {
        child.remove();
        strippedCount++;
        continue;
      }
      for (const attr of child.getAttributeNames()) {
        const val = child.getAttribute(attr) || '';
        if (attr.startsWith('on') || ((attr === 'href' || attr === 'src') && /^\\s*javascript:/i.test(val))) {
          child.removeAttribute(attr);
          strippedCount++;
        }
      }
      sanitize(child);
    }
  }

  sanitize(parsed.body);
  const preview = document.getElementById('preview');
  preview.innerHTML = parsed.body.innerHTML;
  document.getElementById('stripped').textContent = String(strippedCount);

  return {
    strippedCount,
    headings: preview.querySelectorAll('h1, h2').map(h => h.textContent),
    links: preview.querySelectorAll('a').map(a => ({text: a.textContent, href: a.getAttribute('href')})),
    html: preview.innerHTML.trim(),
  };
}`;

    tasks.push(await buildTask({
      id: 'frontend-marked-xss-script-strip',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['marked', 'sanitizer'], meta: {package: 'marked'},
      args: ['# Release Notes\n\nHello **world**!\n\n<script>alert(1)</script>\n\n[Docs](https://docs.test/v2)'],
    }));
    tasks.push(await buildTask({
      id: 'frontend-marked-js-uri-strip',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['marked', 'sanitizer'], meta: {package: 'marked'},
      args: ['## Links\n\n<a href="javascript:evil()" onclick="steal()">Click</a> and [Safe](https://safe.test)'],
    }));
    tasks.push(await buildTask({
      id: 'frontend-marked-list-code',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['marked', 'sanitizer'], meta: {package: 'marked'},
      args: ['# Checklist\n\n- Item `alpha`\n- Item `beta`\n\n<iframe src="https://evil.test"></iframe>'],
    }));
    tasks.push(await buildTask({
      id: 'frontend-marked-clean-doc',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['marked', 'sanitizer'], meta: {package: 'marked'},
      args: ['# Guide\n\n## Setup\n\nRun `npm test` and check [CI](https://ci.test).'],
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 9: Real `mustache.js` template rendering + fetch + bookmark toggle (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:mustache-dom-templates';
    const mustacheLib = LIBS.mustache();
    const initialHtml = `<!DOCTYPE html><html><head><title>Feed</title></head><body><main id="feed"></main></body></html>`;
    const initialUrl = 'https://news.example.test/feed';
    const source = `${mustacheLib}
async function run(topic, toggleId) {
  const Mustache = __lib;
  const template = '<ul class="articles">{{#articles}}<li data-id="{{id}}" class="{{#saved}}saved{{/saved}}"><h4>{{title}}</h4><button class="bm">Save</button></li>{{/articles}}</ul>';
  const savedSet = new Set(JSON.parse(localStorage.getItem('bookmarks') || '[]'));

  const res = await fetch('https://api.news.test/articles?topic=' + encodeURIComponent(topic));
  const data = await res.json();
  const view = {
    articles: data.articles.map(a => ({...a, saved: savedSet.has(a.id)})),
  };

  const feed = document.getElementById('feed');
  feed.innerHTML = Mustache.render(template, view);

  feed.addEventListener('click', ev => {
    const btn = ev.target.closest('button.bm');
    if (!btn) return;
    const li = btn.closest('li[data-id]');
    const id = li.dataset.id;
    if (savedSet.has(id)) {
      savedSet.delete(id);
      li.classList.remove('saved');
    } else {
      savedSet.add(id);
      li.classList.add('saved');
    }
    localStorage.setItem('bookmarks', JSON.stringify([...savedSet].sort()));
  });

  if (toggleId) {
    const targetBtn = feed.querySelector('li[data-id="' + toggleId + '"] button.bm');
    if (targetBtn) targetBtn.click();
  }

  return {
    savedIds: feed.querySelectorAll('li.saved').map(li => li.dataset.id),
    titles: feed.querySelectorAll('li h4').map(h => h.textContent),
  };
}`;

    // Causal pair 9a / 9b: same topic & toggleId, diverging on fetch article list
    tasks.push(await buildTask({
      id: 'frontend-mustache-feed-a',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair', 'mustache'], meta: {package: 'mustache'},
      args: ['js', 'a2'],
      mock: {
        storage: {local: {bookmarks: JSON.stringify(['a1'])}},
        http: () => ({status: 200, json: {articles: [{id: 'a1', title: 'ES2026'}, {id: 'a2', title: 'DOM Events'}]}}),
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-mustache-feed-b',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair', 'mustache'], meta: {package: 'mustache'},
      args: ['js', 'a2'],
      mock: {
        storage: {local: {bookmarks: JSON.stringify(['a1'])}},
        http: () => ({status: 200, json: {articles: [{id: 'a1', title: 'WebGPU'}, {id: 'a2', title: 'CSS Grid'}, {id: 'a3', title: 'HTML & <Tags>'}]}}),
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-mustache-unbookmark',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['mustache'], meta: {package: 'mustache'},
      args: ['css', 'c1'],
      mock: {
        storage: {local: {bookmarks: JSON.stringify(['c1', 'c2'])}},
        http: () => ({status: 200, json: {articles: [{id: 'c1', title: 'Container Queries'}, {id: 'c2', title: 'Subgrid'}]}}),
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-mustache-no-toggle',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['mustache'], meta: {package: 'mustache'},
      args: ['rust', null],
      mock: {
        storage: {local: {}},
        http: () => ({status: 200, json: {articles: [{id: 'r1', title: 'WASM'}]}}),
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 10: Auth session refresh & token expiry guard (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:auth-session-refresh';
    const initialHtml = `<!DOCTYPE html><html><head><title>Portal</title></head><body>
<header><span id="auth-badge" class="badge">unknown</span><span id="user-name"></span></header>
</body></html>`;
    const initialUrl = 'https://portal.example.test/dashboard';
    const source = `async function run() {
  const badge = document.getElementById('auth-badge');
  const userName = document.getElementById('user-name');
  const rawSession = sessionStorage.getItem('auth_session');
  if (!rawSession) {
    badge.className = 'badge guest';
    badge.textContent = 'signed-out';
    return {authenticated: false, reason: 'no-session'};
  }
  const sess = JSON.parse(rawSession);
  const now = Date.now();
  if (now < sess.expiresAt - 60000) {
    badge.className = 'badge ok';
    badge.textContent = 'active';
    userName.textContent = sess.user;
    return {authenticated: true, refreshed: false, token: sess.token};
  }
  const refreshToken = localStorage.getItem('refresh_token');
  const res = await fetch('https://auth.example.test/refresh', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({refreshToken, user: sess.user}),
  });
  if (res.ok) {
    const next = await res.json();
    sessionStorage.setItem('auth_session', JSON.stringify({
      user: sess.user,
      token: next.token,
      expiresAt: now + next.ttlMs,
    }));
    badge.className = 'badge ok';
    badge.textContent = 'refreshed';
    userName.textContent = sess.user;
    return {authenticated: true, refreshed: true, token: next.token};
  }
  console.warn('session-expired', res.status);
  sessionStorage.removeItem('auth_session');
  localStorage.removeItem('refresh_token');
  badge.className = 'badge expired';
  badge.textContent = 'signed-out';
  return {authenticated: false, reason: 'refresh-failed', status: res.status};
}`;

    const sessionPayload = JSON.stringify({user: 'lin', token: 'tok_old', expiresAt: 1700001000000});
    // Causal pair 10a / 10b / 10c: identical prompt, diverging on Date.now() and fetch refresh 200 vs 401
    tasks.push(await buildTask({
      id: 'frontend-auth-valid-token',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {
        storage: {session: {auth_session: sessionPayload}, local: {refresh_token: 'rt_1'}},
        now: [1700000500000],
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-auth-refresh-ok',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {
        storage: {session: {auth_session: sessionPayload}, local: {refresh_token: 'rt_1'}},
        now: [1700000990000],
        http: () => ({status: 200, json: {token: 'tok_new_77', ttlMs: 3600000}}),
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-auth-refresh-401',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      mock: {
        storage: {session: {auth_session: sessionPayload}, local: {refresh_token: 'rt_1'}},
        now: [1700000990000],
        http: () => ({status: 401, json: {error: 'revoked'}}),
      },
    }));
    tasks.push(await buildTask({
      id: 'frontend-auth-guest',
      family, source, initialHtml, initialUrl,
      mock: {storage: {session: {}, local: {}}},
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 11: Optimistic Kanban board with DOM rollback (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:optimistic-kanban-board';
    const initialHtml = `<!DOCTYPE html><html><head><title>Kanban</title></head><body>
<div id="board">
  <section class="col" data-col="todo"><span class="count">2</span><div class="cards"><div class="card" id="c1" data-status="todo">Auth</div><div class="card" id="c2" data-status="todo">Billing</div></div></section>
  <section class="col" data-col="doing"><span class="count">1</span><div class="cards"><div class="card" id="c3" data-status="doing">Search</div></div></section>
  <section class="col" data-col="done"><span class="count">0</span><div class="cards"></div></section>
</div>
<div id="toast"></div>
</body></html>`;
    const initialUrl = 'https://board.example.test/sprint-4';
    const source = `async function run(moves) {
  const toast = document.getElementById('toast');
  function updateCounts() {
    for (const col of document.querySelectorAll('section.col')) {
      col.querySelector('.count').textContent = String(col.querySelectorAll('.card').length);
    }
  }

  async function moveCard(cardId, targetCol) {
    const card = document.getElementById(cardId);
    const prevParent = card.parentElement;
    const prevNext = card.nextElementSibling;
    const prevStatus = card.dataset.status;
    const destCards = document.querySelector('section.col[data-col="' + targetCol + '"] .cards');

    // Optimistic DOM mutation
    card.dataset.status = targetCol;
    destCards.appendChild(card);
    updateCounts();

    const res = await fetch('https://api.board.test/cards/' + cardId, {
      method: 'PATCH',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({from: prevStatus, to: targetCol}),
    });
    if (!res.ok) {
      // Rollback DOM cleanly
      card.dataset.status = prevStatus;
      prevParent.insertBefore(card, prevNext);
      updateCounts();
      console.warn('move-rollback', cardId, res.status);
      toast.textContent = 'Reverted ' + cardId;
      return false;
    }
    toast.textContent = 'Moved ' + cardId + ' -> ' + targetCol;
    return true;
  }

  const results = [];
  for (const [id, col] of moves) {
    results.push(await moveCard(id, col));
  }
  const columns = {};
  for (const col of document.querySelectorAll('section.col')) {
    columns[col.dataset.col] = col.querySelectorAll('.card').map(c => c.id);
  }
  return {results, columns, toast: toast.textContent};
}`;

    const movePair = [[['c1', 'doing'], ['c3', 'done']]];
    // Causal pair 11a / 11b: second PATCH returns 200 vs 500 (triggers DOM rollback!)
    tasks.push(await buildTask({
      id: 'frontend-kanban-commit-all',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      args: movePair,
      mock: {http: () => ({status: 200, json: {ok: true}})},
    }));
    tasks.push(await buildTask({
      id: 'frontend-kanban-rollback-second',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      args: movePair,
      mock: {http: ({index}) => index === 0 ? {status: 200, json: {ok: true}} : {status: 500, json: {error: 'db'}}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-kanban-rollback-preserves-order',
      family, source, initialHtml, initialUrl,
      args: [[['c1', 'done']]],
      mock: {http: () => ({status: 409, json: {error: 'conflict'}})},
    }));
    tasks.push(await buildTask({
      id: 'frontend-kanban-multi-hops',
      family, source, initialHtml, initialUrl,
      args: [[['c2', 'doing'], ['c2', 'done'], ['c3', 'todo']]],
      mock: {http: () => ({status: 200, json: {ok: true}})},
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 12: Multi-step wizard / stepper with conditional fields & promo prompt (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:stepper-wizard-form';
    const initialHtml = `<!DOCTYPE html><html><head><title>Upgrade Wizard</title></head><body>
<div id="wizard" data-step="1">
  <div class="step" data-step="1">
    <input id="plan-pro" type="radio" name="plan" value="pro" checked />
    <input id="plan-ent" type="radio" name="plan" value="enterprise" />
    <input id="sso-toggle" type="checkbox" disabled />
  </div>
  <div class="step" data-step="2" hidden>
    <input id="company" value="" />
    <button id="promo-btn">Apply Promo</button>
    <span id="discount">0%</span>
  </div>
  <div class="step" data-step="3" hidden><p id="summary"></p></div>
  <button id="next-btn">Next</button>
</div>
</body></html>`;
    const initialUrl = 'https://billing.example.test/upgrade';
    const source = `function run(actions) {
  const wizard = document.getElementById('wizard');
  const planPro = document.getElementById('plan-pro');
  const planEnt = document.getElementById('plan-ent');
  const sso = document.getElementById('sso-toggle');
  const company = document.getElementById('company');
  const promoBtn = document.getElementById('promo-btn');
  const discountEl = document.getElementById('discount');
  const summaryEl = document.getElementById('summary');
  const nextBtn = document.getElementById('next-btn');
  let discount = 0;

  function syncConditional() {
    sso.disabled = !planEnt.checked;
    if (sso.disabled) sso.checked = false;
  }

  planPro.addEventListener('click', syncConditional);
  planEnt.addEventListener('click', syncConditional);

  promoBtn.addEventListener('click', () => {
    const code = prompt('Enter promo code:', '');
    if (code === 'SAVE20') discount = 20;
    else if (code === 'TEAM10') discount = 10;
    else discount = 0;
    discountEl.textContent = discount + '%';
  });

  function showStep(n) {
    wizard.dataset.step = String(n);
    for (const panel of wizard.querySelectorAll('.step')) {
      panel.hidden = Number(panel.dataset.step) !== n;
    }
    if (n === 3) {
      const plan = planEnt.checked ? 'enterprise' : 'pro';
      const base = plan === 'enterprise' ? 200 : 50;
      const finalPrice = base * (100 - discount) / 100;
      summaryEl.textContent = plan + '|sso:' + sso.checked + '|company:' + company.value + '|price:$' + finalPrice;
      nextBtn.disabled = true;
    }
  }

  nextBtn.addEventListener('click', () => {
    const cur = Number(wizard.dataset.step);
    if (cur === 2 && company.value.trim().length < 2) {
      summaryEl.textContent = 'company-required';
      return;
    }
    if (cur < 3) showStep(cur + 1);
  });

  for (const act of actions) {
    if (act.click) document.querySelector(act.click).click();
    if (act.company !== undefined) company.value = act.company;
  }

  return {
    step: Number(wizard.dataset.step),
    ssoDisabled: sso.disabled,
    ssoChecked: sso.checked,
    discount: discountEl.textContent,
    summary: summaryEl.textContent,
    nextDisabled: nextBtn.disabled,
  };
}`;

    const entFlow = [[
      {click: '#plan-ent'},
      {click: '#sso-toggle'},
      {click: '#next-btn'},
      {company: 'Orbital Inc'},
      {click: '#promo-btn'},
      {click: '#next-btn'},
    ]];
    // Causal pair 12a / 12b: same wizard flow, diverging on prompt('SAVE20') vs prompt(null)
    tasks.push(await buildTask({
      id: 'frontend-wizard-ent-promo',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      args: entFlow,
      mock: {dialogs: {prompt: ['SAVE20']}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-wizard-ent-cancel-promo',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      args: entFlow,
      mock: {dialogs: {prompt: [null]}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-wizard-pro-validation-block',
      family, source, initialHtml, initialUrl,
      args: [[{click: '#next-btn'}, {company: 'A'}, {click: '#next-btn'}]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-wizard-switch-back-clears-sso',
      family, source, initialHtml, initialUrl,
      args: [[
        {click: '#plan-ent'},
        {click: '#sso-toggle'},
        {click: '#plan-pro'},
        {click: '#next-btn'},
        {company: 'Solo'},
        {click: '#promo-btn'},
        {click: '#next-btn'},
      ]],
      mock: {dialogs: {prompt: ['TEAM10']}},
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 13: Toast notification queue with virtual timers + real `mitt` event bus (4 variants)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:toast-notification-queue';
    const mittLib = LIBS.mitt();
    const initialHtml = `<!DOCTYPE html><html><head><title>Notifications</title></head><body><div id="toasts" aria-live="polite"></div></body></html>`;
    const initialUrl = 'https://app.example.test/inbox';
    const source = `${mittLib}
function run(events) {
  const bus = __lib();
  const container = document.getElementById('toasts');
  const timers = new Map();
  const dismissed = [];
  let seq = 1;

  function dismiss(id, reason) {
    const t = timers.get(id);
    if (t !== undefined) { clearTimeout(t); timers.delete(id); }
    const el = container.querySelector('.toast[data-id="' + id + '"]');
    if (el) {
      el.remove();
      dismissed.push(id + ':' + reason + '@' + window.__virtualNow());
    }
  }

  bus.on('notify', payload => {
    const id = 't' + (seq++);
    // Enforce max 2 visible toasts by evicting oldest
    while (container.children.length >= 2) {
      dismiss(container.firstElementChild.dataset.id, 'evicted');
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (payload.level || 'info');
    el.dataset.id = id;
    el.innerHTML = '<span>' + payload.text + '</span><button class="close">x</button>';
    el.querySelector('.close').addEventListener('click', () => dismiss(id, 'manual'));
    container.appendChild(el);
    if (payload.ttl > 0) {
      timers.set(id, setTimeout(() => dismiss(id, 'auto'), payload.ttl));
    }
  });

  for (const ev of events) {
    if (ev.notify) bus.emit('notify', ev.notify);
    if (ev.close) {
      const btn = container.querySelector('.toast[data-id="' + ev.close + '"] .close');
      if (btn) btn.click();
    }
    if (ev.advance) window.__flushTimers(ev.advance);
  }

  return {
    now: window.__virtualNow(),
    visible: container.querySelectorAll('.toast').map(el => el.dataset.id + ':' + el.querySelector('span').textContent),
    dismissed,
  };
}`;

    tasks.push(await buildTask({
      id: 'frontend-toasts-auto-expire',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['mitt'], meta: {package: 'mitt'},
      args: [[
        {notify: {text: 'Saved', level: 'success', ttl: 100}},
        {notify: {text: 'Synced', level: 'info', ttl: 250}},
        {advance: 150},
      ]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-toasts-evict-cap',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['mitt'], meta: {package: 'mitt'},
      args: [[
        {notify: {text: 'One', ttl: 500}},
        {notify: {text: 'Two', ttl: 500}},
        {notify: {text: 'Three', ttl: 200}},
        {advance: 250},
      ]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-toasts-manual-cancel',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['mitt'], meta: {package: 'mitt'},
      args: [[
        {notify: {text: 'Warning', level: 'warn', ttl: 300}},
        {advance: 50},
        {close: 't1'},
        {advance: 300},
      ]],
    }));
    tasks.push(await buildTask({
      id: 'frontend-toasts-sticky-and-ephemeral',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['mitt'], meta: {package: 'mitt'},
      args: [[
        {notify: {text: 'Offline', level: 'error', ttl: 0}},
        {notify: {text: 'Retrying', level: 'info', ttl: 100}},
        {advance: 500},
      ]],
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 14: Theme & i18n switcher with localStorage + alert fallback (4 variants, causal pair!)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:theme-i18n-switcher';
    const initialHtml = `<!DOCTYPE html><html lang="en" data-theme="light"><head><title>Settings</title></head><body>
<h1 data-i18n="heading">Settings</h1>
<p data-i18n="desc">Configure your workspace.</p>
<button id="theme-btn">Toggle Theme</button>
</body></html>`;
    const initialUrl = 'https://app.example.test/settings';
    const source = `function run(targetLocale, toggleTheme) {
  const dict = {
    en: {heading: 'Settings', desc: 'Configure your workspace.'},
    es: {heading: 'Configuracion', desc: 'Configura tu espacio.'},
    fr: {heading: 'Parametres', desc: 'Configurez votre espace.'},
  };
  let theme = localStorage.getItem('pref_theme') || 'light';
  let locale = localStorage.getItem('pref_locale') || 'en';

  function apply() {
    document.documentElement.dataset.theme = theme;
    document.documentElement.setAttribute('lang', locale);
    const strings = dict[locale] || dict.en;
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const key = el.dataset.i18n;
      if (strings[key]) el.textContent = strings[key];
    }
  }

  document.getElementById('theme-btn').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('pref_theme', theme);
    apply();
  });

  apply();
  if (targetLocale) {
    if (!Object.hasOwn(dict, targetLocale)) {
      alert('Unsupported locale: ' + targetLocale);
    } else {
      locale = targetLocale;
      localStorage.setItem('pref_locale', locale);
      apply();
    }
  }
  if (toggleTheme) document.getElementById('theme-btn').click();

  return {
    theme: document.documentElement.dataset.theme,
    lang: document.documentElement.getAttribute('lang'),
    heading: document.querySelector('h1').textContent,
    desc: document.querySelector('p').textContent,
  };
}`;

    // Causal pair 14a / 14b: same args, diverging on initial localStorage pref_theme/pref_locale
    tasks.push(await buildTask({
      id: 'frontend-theme-i18n-dark-es',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      args: [null, true],
      mock: {storage: {local: {pref_theme: 'dark', pref_locale: 'es'}}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-theme-i18n-light-fr',
      family, source, initialHtml, initialUrl,
      extraFeatures: ['causal-pair'],
      args: [null, true],
      mock: {storage: {local: {pref_theme: 'light', pref_locale: 'fr'}}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-theme-i18n-unsupported-alert',
      family, source, initialHtml, initialUrl,
      args: ['ja', false],
      mock: {storage: {local: {pref_theme: 'light', pref_locale: 'en'}}},
    }));
    tasks.push(await buildTask({
      id: 'frontend-theme-i18n-switch-fr',
      family, source, initialHtml, initialUrl,
      args: ['fr', true],
      mock: {storage: {local: {}}},
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 15: Sortable/paginated data table synced with URL query params (4 variants)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:table-sort-paginate-url';
    const initialHtml = `<!DOCTYPE html><html><head><title>Users</title></head><body>
<table id="users">
  <thead><tr>
    <th data-sort="name" aria-sort="none">Name</th>
    <th data-sort="score" aria-sort="none">Score</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
<button id="prev-page">Prev</button>
<span id="page-info"></span>
<button id="next-page">Next</button>
</body></html>`;
    const source = `function run(records, clicks) {
  const tbody = document.getElementById('tbody');
  const prevBtn = document.getElementById('prev-page');
  const nextBtn = document.getElementById('next-page');
  const pageInfo = document.getElementById('page-info');
  const pageSize = 2;

  const params = new URLSearchParams(location.search);
  let sortBy = params.get('sort') || 'name';
  let dir = params.get('dir') || 'asc';
  let page = Math.max(1, Number(params.get('page')) || 1);

  function render() {
    const sorted = records.slice().sort((a, b) => {
      const cmp = sortBy === 'score' ? a.score - b.score : a.name.localeCompare(b.name);
      return dir === 'desc' ? -cmp : cmp;
    });
    const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    if (page > totalPages) page = totalPages;
    const slice = sorted.slice((page - 1) * pageSize, page * pageSize);

    tbody.innerHTML = slice.map(r => '<tr><td>' + r.name + '</td><td>' + r.score + '</td></tr>').join('');
    for (const th of document.querySelectorAll('th[data-sort]')) {
      th.setAttribute('aria-sort', th.dataset.sort === sortBy ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= totalPages;
    pageInfo.textContent = page + '/' + totalPages;

    const nextParams = new URLSearchParams({sort: sortBy, dir, page: String(page)});
    history.replaceState({sortBy, dir, page}, '', location.pathname + '?' + nextParams.toString());
  }

  document.querySelector('thead').addEventListener('click', ev => {
    const th = ev.target.closest('th[data-sort]');
    if (!th) return;
    if (sortBy === th.dataset.sort) dir = dir === 'asc' ? 'desc' : 'asc';
    else { sortBy = th.dataset.sort; dir = 'asc'; }
    page = 1;
    render();
  });
  prevBtn.addEventListener('click', () => { page = Math.max(1, page - 1); render(); });
  nextBtn.addEventListener('click', () => { page += 1; render(); });

  render();
  for (const sel of clicks) document.querySelector(sel).click();

  return {
    url: location.href,
    pageInfo: pageInfo.textContent,
    disabled: [prevBtn.disabled, nextBtn.disabled],
    ariaSort: document.querySelectorAll('th').map(th => th.dataset.sort + ':' + th.getAttribute('aria-sort')),
    visibleRows: tbody.querySelectorAll('tr').map(tr => tr.children[0].textContent + '=' + tr.children[1].textContent),
  };
}`;

    const people = [
      {name: 'Cara', score: 88},
      {name: 'Alice', score: 95},
      {name: 'Dan', score: 72},
      {name: 'Bob', score: 91},
      {name: 'Eve', score: 84},
    ];
    tasks.push(await buildTask({
      id: 'frontend-table-sort-score-desc',
      family, source, initialHtml, initialUrl: 'https://admin.example.test/users',
      args: [people, ['th[data-sort="score"]', 'th[data-sort="score"]', '#next-page']],
    }));
    tasks.push(await buildTask({
      id: 'frontend-table-from-query',
      family, source, initialHtml, initialUrl: 'https://admin.example.test/users?sort=score&dir=desc&page=2',
      args: [people, ['#next-page', '#prev-page']],
    }));
    tasks.push(await buildTask({
      id: 'frontend-table-clamp-page',
      family, source, initialHtml, initialUrl: 'https://admin.example.test/users?page=99',
      args: [people, []],
    }));
    tasks.push(await buildTask({
      id: 'frontend-table-toggle-name-desc',
      family, source, initialHtml, initialUrl: 'https://admin.example.test/users',
      args: [people, ['th[data-sort="name"]', '#next-page']],
    }));
  }

  // ---------------------------------------------------------------------------
  // Family 16: Accessible ARIA tabs with keyboard nav + CSV/JSON preview table (4 variants)
  // ---------------------------------------------------------------------------
  {
    const family = 'frontend:accordion-tabs-keyboard';
    const initialHtml = `<!DOCTYPE html><html><head><title>Data Preview</title></head><body>
<div role="tablist" id="tabs">
  <button role="tab" id="tab-csv" aria-selected="true" tabindex="0">CSV</button>
  <button role="tab" id="tab-json" aria-selected="false" tabindex="-1">JSON</button>
  <button role="tab" id="tab-stats" aria-selected="false" tabindex="-1">Stats</button>
</div>
<section id="panel-csv" role="tabpanel"><table id="csv-table"></table></section>
<section id="panel-json" role="tabpanel" hidden><pre id="json-out"></pre></section>
<section id="panel-stats" role="tabpanel" hidden><p id="stats-out"></p></section>
</body></html>`;
    const initialUrl = 'https://tools.example.test/preview';
    const source = `function run(csvText, keys) {
  const tabs = document.querySelectorAll('[role="tab"]');
  const panels = document.querySelectorAll('[role="tabpanel"]');

  const lines = csvText.trim().split('\\n').map(l => l.split(',').map(c => c.trim()));
  const headers = lines[0];
  const rows = lines.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = /^\\d+$/.test(cols[i]) ? Number(cols[i]) : cols[i]; });
    return obj;
  });

  const table = document.getElementById('csv-table');
  table.innerHTML = '<thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + headers.map(h => '<td>' + r[h] + '</td>').join('') + '</tr>').join('') + '</tbody>';
  document.getElementById('json-out').textContent = JSON.stringify(rows);
  const numVals = rows.flatMap(r => Object.values(r).filter(v => typeof v === 'number'));
  const sum = numVals.reduce((a, b) => a + b, 0);
  document.getElementById('stats-out').textContent = 'rows=' + rows.length + ',sum=' + sum;

  let activeIdx = 0;
  function selectTab(idx) {
    activeIdx = (idx + tabs.length) % tabs.length;
    tabs.forEach((t, i) => {
      const on = i === activeIdx;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    tabs[activeIdx].focus();
  }

  document.getElementById('tabs').addEventListener('keydown', ev => {
    if (ev.key === 'ArrowRight') { ev.preventDefault(); selectTab(activeIdx + 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); selectTab(activeIdx - 1); }
    else if (ev.key === 'Home') { ev.preventDefault(); selectTab(0); }
    else if (ev.key === 'End') { ev.preventDefault(); selectTab(tabs.length - 1); }
  });

  tabs[0].focus();
  for (const key of keys) {
    tabs[activeIdx].dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
  }

  return {
    activeTab: tabs[activeIdx].id,
    activeElementId: document.activeElement.id,
    visiblePanels: panels.filter(p => !p.hidden).map(p => p.id),
    tableRows: table.querySelectorAll('tbody tr').length,
    stats: document.getElementById('stats-out').textContent,
    jsonPreview: document.getElementById('json-out').textContent,
  };
}`;

    const csv1 = 'sku,qty,price\nA1,2,15\nB2,4,10';
    const csv2 = 'region,sales\nUS,120\nEU,95\nAPAC,85';
    tasks.push(await buildTask({
      id: 'frontend-tabs-arrow-right',
      family, source, initialHtml, initialUrl,
      args: [csv1, ['ArrowRight']],
    }));
    tasks.push(await buildTask({
      id: 'frontend-tabs-wrap-left',
      family, source, initialHtml, initialUrl,
      args: [csv1, ['ArrowLeft']],
    }));
    tasks.push(await buildTask({
      id: 'frontend-tabs-end-home',
      family, source, initialHtml, initialUrl,
      args: [csv2, ['End', 'ArrowLeft', 'Home']],
    }));
    tasks.push(await buildTask({
      id: 'frontend-tabs-double-right',
      family, source, initialHtml, initialUrl,
      args: [csv2, ['ArrowRight', 'ArrowRight']],
    }));
  }

  return tasks;
}

// ==================== Parallel Verification + Supervision Audit ====================
async function main() {
  const allCandidates = await buildAllTasks();
  const selected = limit ? allCandidates.slice(0, limit) : allCandidates;
  const results = new Array(selected.length);
  let next = 0;
  let failures = 0;

  await Promise.all(
    Array.from({length: Math.min(jobs, selected.length)}, async () => {
      while (next < selected.length) {
        const idx = next++;
        const task = selected[idx];
        try {
          const exported = await exportTinkerExample(task, {
            traceFormat: 'compact',
            reasoningChannel: 'thinking',
          });
          if (!exported.metadata.traceAudit?.replayVerified) {
            throw new Error('traceAudit.replayVerified is false');
          }
          if (!exported.metadata.traceAudit?.canonicalCausalNarration) {
            throw new Error('traceAudit.canonicalCausalNarration is false');
          }
          const traceLines = exported.messages
            .filter(m => m.role === 'assistant')
            .reduce((n, m) => {
              const t = assistantThinkingText(m).trim();
              return n + (t ? t.split('\n').length : 0);
            }, 0);
          const episodeChars = JSON.stringify(exported.messages).length;
          const approxTokens = Math.ceil(episodeChars / 2.4);
          if (approxTokens >= MAX_APPROX_TOKENS) {
            throw new Error(`approx tokens ${approxTokens} >= ${MAX_APPROX_TOKENS}`);
          }
          const enrichedTask = {
            ...exported.task,
            tier: 5,
            metadata: {
              ...exported.task.metadata,
              tier: 5,
              sourceChars: exported.task.source.length,
              traceLines,
              narrationLines: exported.metadata.traceAudit.narrationLines,
              episodeChars,
              approxTokens,
              externalCalls: exported.metadata.externalCalls,
            },
          };
          results[idx] = {ok: true, task: enrichedTask, exported};
        } catch (err) {
          failures++;
          results[idx] = {ok: false, id: task.id, family: task.family, error: String(err?.message ?? err)};
          process.stderr.write(`FAIL ${task.id}: ${err?.message ?? err}\n`);
        }
      }
    }),
  );

  const ok = results.filter(r => r?.ok);

  let auditSummary = null;
  if (failures === 0 && values.audit && ok.length > 0) {
    const auditResult = await auditTinkerSupervision(
      ok.map(r => r.exported),
      {formats: ['compact'], samplePerFeature: 1000, seed: 17},
    );
    if (!auditResult.valid || !auditResult.success || !auditResult.allReplayed) {
      throw new Error(`auditTinkerSupervision failed: ${JSON.stringify(auditResult.failures)}`);
    }
    auditSummary = {
      valid: auditResult.valid,
      allReplayed: auditResult.allReplayed,
      sampleTasks: auditResult.sampleTasks,
      causalPairs: auditResult.causalPairs.length,
      causalDivergencesChecked: auditResult.causalDivergencesChecked,
    };
  }

  const tokens = ok.map(r => r.task.metadata.approxTokens).sort((a, b) => a - b);
  const srcChars = ok.map(r => r.task.metadata.sourceChars).sort((a, b) => a - b);
  const effectful = ok.filter(r => r.task.metadata.externalCalls > 0);

  const summary = {
    totalCandidates: selected.length,
    verified: ok.length,
    failed: failures,
    families: new Set(ok.map(r => r.task.family)).size,
    effectfulCount: effectful.length,
    effectfulFamilies: new Set(effectful.map(r => r.task.family)).size,
    sourceChars: srcChars.length ? {min: srcChars[0], median: srcChars[Math.floor(srcChars.length / 2)], max: srcChars.at(-1)} : null,
    approxTokens: tokens.length ? {min: tokens[0], median: tokens[Math.floor(tokens.length / 2)], max: tokens.at(-1)} : null,
    audit: auditSummary,
  };

  if (failures > 0) {
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  const outPath = resolve(values.output);
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, ok.map(r => JSON.stringify(r.task)).join('\n') + '\n');
  summary.output = outPath;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
