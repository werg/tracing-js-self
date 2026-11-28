#!/usr/bin/env node
// Stage 10 Frontend / Browser-DOM Wave 2 Scale Builder & Deterministic Verifier.
//
// Generates 220+ brand-new, diverse, realistic Frontend / Browser-DOM tasks across
// 58 brand-new unique app families (`frontend-w2:*` and `lc65k-fe-w2/*`), covering:
//   - 36 single-file interactive Browser/DOM families (~136 tasks, all 16 UI categories)
//   - 22 multi-file 12K-56K token Browser/DOM SPA families (88 tasks, 25-160 files,
//     4 distinct architectures, barrel re-exports, >=36% TypeScript `.ts` modules)
//   - 46 counterfactual `causal-pair` groups (92 paired tasks)
//
// Every task is:
//   1. Exported 2x independently via exportTinkerExample() (which spawns
//      tools/effectful-reference-worker.mjs) with 100% deterministic identity check.
//   2. Verified for replayVerified, canonicalCausalNarration, flexible student session,
//      and auditTinkerSupervision() causal-prefix future-blindness.
//   3. Enforced within max_tokens <= 20000 per assistant turn, total context well within
//      65472 tokens, assistant turns <= 46, and multi-file codebase 12K-56K tokens.
//   4. Audited for 0 overlap against RealExecBench v1 (benchmark.jsonl + manifest.json)
//      on id, family, sourceHash, and split_component.
//   5. Emitted in pre-exported row format (`schema`, `id`, `family`, `sourceHash`,
//      `task`, `messages`, `metadata`, `split_component`) for _is_preexported_row pass-through.

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, parseArgs} from 'node:util';
import vm from 'node:vm';
import {
  assistantThinkingText,
  assistantVisibleText,
  createTinkerSession,
  encodeReadable,
  exportTinkerExample,
  parseStudentAction,
  prepareTinkerTask,
} from '../src/training/tinker-execution.js';
import {auditTinkerSupervision} from '../src/training/tinker-supervision.js';
import {executeVirtualCodebaseInContext} from '../src/training/tinker-codebase.js';
import {normalizeFetchRequest, VM_FETCH_RUNTIME_SCRIPT} from '../src/training/tinker-http-fetch.js';
import {
  DEFAULT_BROWSER_HTML,
  DEFAULT_BROWSER_URL,
  VM_BROWSER_DOM_RUNTIME_SCRIPT,
} from '../src/training/tinker-browser-dom.js';

process.on('unhandledRejection', () => {});

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT = resolve(__dirname, '../runs/stage10-frontend-wave2/tasks.jsonl');
export const DEFAULT_AUDIT_OUTPUT = resolve(__dirname, '../runs/stage10-frontend-wave2/audit.json');
export const DEFAULT_BENCHMARK_JSONL = '/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl';
export const DEFAULT_BENCHMARK_MANIFEST = '/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json';

export const MAX_TURN_TOKENS = 20000;
export const MAX_CONTEXT_TOKENS = 60000; // conservative headroom below 65,472
export const MAX_ASSISTANT_TURNS = 46; // headroom below max_turns=48
export const MIN_MF_CODEBASE_TOKENS = 12000;
export const MAX_MF_CODEBASE_TOKENS = 56000;

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function estimateTokens(chars, charsPerToken = 3.2) {
  return Math.ceil(chars / charsPerToken);
}

function estimateMessageTokens(msg) {
  let chars = 0;
  if (typeof msg.content === 'string') {
    chars += msg.content.length;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      chars += String(part?.thinking ?? part?.text ?? '').length;
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    chars += JSON.stringify(msg.tool_calls).length;
  }
  return estimateTokens(chars, 2.8);
}

// ==================== Deterministic Single-File Browser Fixture Recorder ====================
export async function recordSingleFileBrowserFixture({
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
      result = promptIdx < prompts.length ? prompts[promptIdx++] : (opArgs[1] ?? '');
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
      calls.push({operation: 'http.request', arguments: encodeReadable(normalized), status: 'rejected', result: encodeReadable(errObj)});
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
    calls.push({
      operation: 'platform.console.' + method,
      arguments: encodeReadable(Array.from(cArgs)),
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
  }, {codeGeneration: {strings: false, wasm: false}});

  new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});
  if (timestamps.length > 0) {
    context.__platformDateNow = () => {
      const val = timestamps[Math.min(nowIdx++, timestamps.length - 1)];
      calls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: encodeReadable(val)});
      return val;
    };
    new vm.Script('Date.now = __platformDateNow;').runInContext(context, {timeout: 5000});
  }
  new vm.Script(VM_BROWSER_DOM_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});
  new vm.Script(`"use strict";\n${source}\n__result = ${entry}.apply(undefined, __args);`).runInContext(context, {timeout: 5000});

  const val = context.__result;
  if (val && typeof val.then === 'function') {
    let settled = false;
    const tracked = Promise.resolve(val).then(
      res => { settled = true; return {ok: true, res}; },
      err => { settled = true; return {ok: false, err}; },
    );
    let idleTicks = 0;
    for (let steps = 0; steps < 2000 && !settled; steps++) {
      await new Promise(r => setImmediate(r));
      if (settled) break;
      if (context.__browserHasPendingTimers && context.__browserHasPendingTimers()) {
        idleTicks = 0;
        context.__browserStepNextTimer();
      } else if (++idleTicks >= 16) {
        break;
      }
    }
    const box = await tracked;
    if (!box.ok) throw box.err;
  }

  return {calls};
}

// ==================== Deterministic Multi-File Browser Fixture Recorder ====================
export async function recordMultiFileBrowserFixture({
  files,
  entryFile,
  entry = 'run',
  initialLoadedFiles = [entryFile],
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
      result = getMap(area).has(key) ? String(getMap(area).get(key)) : null;
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
      result = promptIdx < prompts.length ? prompts[promptIdx++] : (opArgs[1] ?? '');
    }
    calls.push({operation: op, arguments: encodeReadable(opArgs), status: 'fulfilled', result: encodeReadable(result)});
    return result;
  };

  const platformFetch = async (reqInput, reqInit) => {
    const norm = normalizeFetchRequest(reqInput, reqInit);
    const [url, method, headers, body] = norm;
    let outcome;
    if (typeof http === 'function') {
      outcome = await http({url, method, headers, body, index: httpIdx++});
    } else if (Array.isArray(http)) {
      outcome = http[httpIdx++] ?? {status: 200, statusText: 'OK', url, headers: {'content-type': 'application/json'}, body: '{}'};
    } else {
      outcome = {status: 200, statusText: 'OK', url, headers: {'content-type': 'application/json'}, body: '{}'};
    }
    if (outcome?.reject) {
      const errObj = {name: outcome.reject.name ?? outcome.name ?? 'TypeError', message: outcome.reject.message ?? outcome.message ?? 'Network request failed'};
      calls.push({operation: 'http.request', arguments: encodeReadable(norm), status: 'rejected', result: encodeReadable(errObj)});
      throw errObj;
    }
    const payload = {
      status: outcome.status ?? 200,
      statusText: outcome.statusText ?? (outcome.status >= 400 ? 'Error' : 'OK'),
      url: outcome.url ?? url,
      headers: outcome.headers ?? {'content-type': 'application/json'},
      body: typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.json ?? outcome.body ?? {}),
    };
    calls.push({operation: 'http.request', arguments: encodeReadable(norm), status: 'fulfilled', result: encodeReadable(payload)});
    return payload;
  };

  const consoleObj = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [
    level,
    (...cArgs) => {
      calls.push({
        operation: 'platform.console.' + level,
        arguments: encodeReadable(cArgs),
        status: 'fulfilled',
        result: encodeReadable(undefined),
      });
    },
  ]));

  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone, Buffer,
    __platformFetch: platformFetch,
    __browserInvoke: browserInvoke,
    __browserInitialHtml: initialHtml,
    __browserInitialUrl: initialUrl,
    __recDateNow: () => {
      const val = nowIdx < timestamps.length ? timestamps[nowIdx++] : 1740000000000 + nowIdx * 1000;
      calls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: encodeReadable(val)});
      return val;
    },
    console: consoleObj,
    queueMicrotask: cb => queueMicrotask(cb),
  }, {codeGeneration: {strings: false, wasm: false}});

  new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});
  if (timestamps.length > 0) {
    new vm.Script('Date.now = __recDateNow;').runInContext(context, {timeout: 1000});
  }
  new vm.Script(`(function(){let state=23>>>0;
    Math.random=function(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};})()`)
    .runInContext(context, {timeout: 1000});
  new vm.Script(VM_BROWSER_DOM_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});

  const codeLoadEvents = [];
  const res = await executeVirtualCodebaseInContext({
    context,
    files,
    entryFile,
    entry,
    initialLoadedFiles,
    args: structuredClone(args),
    timeoutMs: 8000,
    traceMode: false,
    onCodeLoadEvent(req) { codeLoadEvents.push(req); },
    setTraceActive() {},
  });
  if (res.kind === 'throw') {
    throw new Error(`Multi-file recorder guest threw: ${res.value?.message ?? String(res.value)}`);
  }
  return {calls, codeLoadEvents, value: res.value};
}

async function buildSingleTask({
  id,
  family,
  source,
  args = [],
  initialHtml = DEFAULT_BROWSER_HTML,
  initialUrl = DEFAULT_BROWSER_URL,
  mock = null,
  extraFeatures = [],
  pairId = null,
  meta = {},
}) {
  const fixture = mock
    ? await recordSingleFileBrowserFixture({source, args, initialHtml, initialUrl, ...mock})
    : {calls: []};
  const features = [
    'frontend',
    'browser-dom',
    'frontend-wave2',
    'native-v8',
    ...(fixture.calls.length > 0 ? ['external'] : []),
    ...(pairId ? ['causal-pair'] : []),
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
      wave: 'stage10-frontend-wave2',
      ...(pairId ? {pair_id: pairId} : {}),
      ...meta,
    },
  };
}

// ============================================================================
// PART 1: 36 SINGLE-FILE INTERACTIVE BROWSER / DOM FAMILIES (~136 tasks)
// ============================================================================

async function buildSingleFileFamiliesPart1() {
  const tasks = [];

  // --------------------------------------------------------------------------
  // SF-01: Expense Claim Form & Multi-Field Policy Validator (causal pair + 2)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:expense-claim-validator';
    const html = `<!DOCTYPE html><html><head><title>Expense Claim</title></head><body>
<form id="claim-form">
  <select id="currency"><option value="USD" selected>USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option></select>
  <input id="merchant" type="text" value="" />
  <input id="amount" type="number" value="0" />
  <input id="receipt-id" type="text" value="" />
  <input id="client-billable" type="checkbox" />
  <div id="converted">$0.00</div>
  <div id="claim-msg" class="msg"></div>
  <button id="claim-submit" type="submit">Submit Claim</button>
</form></body></html>`;
    const url = 'https://finance.w2.test/expenses/new';
    const source = `async function run(events) {
  const RATES = { USD: 1, EUR: 1.08, GBP: 1.27 };
  const form = document.getElementById('claim-form');
  const currency = document.getElementById('currency');
  const merchant = document.getElementById('merchant');
  const amount = document.getElementById('amount');
  const receipt = document.getElementById('receipt-id');
  const billable = document.getElementById('client-billable');
  const converted = document.getElementById('converted');
  const msg = document.getElementById('claim-msg');
  const submitBtn = document.getElementById('claim-submit');

  const saved = localStorage.getItem('expense_draft_w2');
  if (saved) {
    const d = JSON.parse(saved);
    if (d.merchant) merchant.value = d.merchant;
    if (d.amount) amount.value = String(d.amount);
    if (d.currency) currency.value = d.currency;
  }

  function usdValue() {
    const raw = Number(amount.value) || 0;
    return Math.round(raw * (RATES[currency.value] || 1) * 100) / 100;
  }

  function updatePreview() {
    converted.textContent = '$' + usdValue().toFixed(2);
    localStorage.setItem('expense_draft_w2', JSON.stringify({
      merchant: merchant.value.trim(),
      amount: Number(amount.value) || 0,
      currency: currency.value,
    }));
  }

  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);

  let pending = Promise.resolve({ submitted: false });
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const errs = [];
    const usd = usdValue();
    if (merchant.value.trim().length < 2) errs.push('merchant');
    if (usd <= 0 || usd > 2500) errs.push('amount-range');
    if (usd >= 75 && !/^RCP-[0-9]{4}$/.test(receipt.value.trim())) errs.push('receipt-required');
    if (errs.length) {
      msg.className = 'msg error';
      msg.textContent = 'Invalid: ' + errs.join(',');
      pending = Promise.resolve({ submitted: false, errors: errs, usd });
      return;
    }
    submitBtn.disabled = true;
    pending = (async () => {
      const res = await fetch('https://api.finance.w2.test/claims', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          merchant: merchant.value.trim(),
          currency: currency.value,
          usd,
          receipt: receipt.value.trim() || null,
          billable: billable.checked,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        localStorage.removeItem('expense_draft_w2');
        msg.className = 'msg ok';
        msg.textContent = 'Approved ' + body.claimId;
        return { submitted: true, claimId: body.claimId, usd };
      }
      submitBtn.disabled = false;
      msg.className = 'msg error';
      msg.textContent = 'Policy: ' + (body.reason || res.status);
      return { submitted: false, status: res.status, reason: body.reason, usd };
    })();
  });

  for (const e of events) {
    if (e.type === 'set') {
      const el = document.getElementById(e.id);
      el.value = String(e.value);
      el.dispatchEvent(new Event(el.localName === 'select' ? 'change' : 'input', { bubbles: true }));
    } else if (e.type === 'check') {
      billable.click();
    } else if (e.type === 'submit') {
      submitBtn.click();
    }
  }
  const result = await pending;
  return { result, converted: converted.textContent, msgClass: msg.className, msgText: msg.textContent, disabled: submitBtn.disabled };
}`;
    const pairEvents = [[
      {type: 'set', id: 'currency', value: 'EUR'},
      {type: 'set', id: 'merchant', value: 'Nordic Rail'},
      {type: 'set', id: 'amount', value: 120},
      {type: 'set', id: 'receipt-id', value: 'RCP-4821'},
      {type: 'check'},
      {type: 'submit'},
    ]];
    const pairId = 'w2-pair:expense-claim-validator';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-expense-claim-approved', family, source, args: pairEvents, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {expense_draft_w2: JSON.stringify({merchant: 'Old', amount: 10, currency: 'USD'})}}, http: () => ({status: 201, json: {claimId: 'CLM-901'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-expense-claim-policy-422', family, source, args: pairEvents, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {expense_draft_w2: JSON.stringify({merchant: 'Old', amount: 10, currency: 'USD'})}}, http: () => ({status: 422, json: {reason: 'duplicate-receipt'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-expense-claim-missing-receipt', family, source, initialHtml: html, initialUrl: url,
      args: [[{type: 'set', id: 'merchant', value: 'Airport Taxi'}, {type: 'set', id: 'amount', value: 95}, {type: 'submit'}]],
      mock: {storage: {local: {}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-expense-claim-small-gbp', family, source, initialHtml: html, initialUrl: url,
      args: [[{type: 'set', id: 'currency', value: 'GBP'}, {type: 'set', id: 'merchant', value: 'Tea Bar'}, {type: 'set', id: 'amount', value: 30}, {type: 'submit'}]],
      mock: {storage: {local: {}}, http: () => ({status: 201, json: {claimId: 'CLM-902'}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-02: Patient Clinic Intake Wizard (conditional fields + sessionStorage)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:patient-intake-wizard';
    const html = `<!DOCTYPE html><html><head><title>Clinic Intake</title></head><body>
<div id="wizard" data-step="1">
  <section id="step-1"><input id="full-name" value="" /><input id="birth-year" type="number" value="1990" /></section>
  <section id="step-2" hidden><input id="has-allergy" type="checkbox" /><input id="allergy-note" value="" /><input id="ins-code" value="" /></section>
  <button id="next-btn" type="button">Next</button>
  <button id="back-btn" type="button">Back</button>
  <button id="finish-btn" type="button">Register</button>
  <div id="intake-status">step-1</div>
</div></body></html>`;
    const url = 'https://clinic.w2.test/intake';
    const source = `async function run(actions) {
  const wiz = document.getElementById('wizard');
  const s1 = document.getElementById('step-1');
  const s2 = document.getElementById('step-2');
  const nameEl = document.getElementById('full-name');
  const yearEl = document.getElementById('birth-year');
  const allergyChk = document.getElementById('has-allergy');
  const allergyNote = document.getElementById('allergy-note');
  const insCode = document.getElementById('ins-code');
  const status = document.getElementById('intake-status');
  const nextBtn = document.getElementById('next-btn');
  const backBtn = document.getElementById('back-btn');
  const finishBtn = document.getElementById('finish-btn');

  const cached = sessionStorage.getItem('intake_ckpt');
  if (cached) {
    const c = JSON.parse(cached);
    if (c.name) nameEl.value = c.name;
    if (c.insCode) insCode.value = c.insCode;
  }

  function showStep(n) {
    wiz.dataset.step = String(n);
    s1.hidden = n !== 1;
    s2.hidden = n !== 2;
    status.textContent = 'step-' + n;
  }

  nextBtn.addEventListener('click', () => {
    const yr = Number(yearEl.value);
    if (nameEl.value.trim().split(/\\s+/).length < 2 || yr < 1900 || yr > 2026) {
      status.textContent = 'err-step1';
      return;
    }
    sessionStorage.setItem('intake_ckpt', JSON.stringify({ name: nameEl.value.trim(), year: yr, insCode: insCode.value.trim() }));
    showStep(2);
  });

  backBtn.addEventListener('click', () => showStep(1));

  let regPromise = Promise.resolve(null);
  finishBtn.addEventListener('click', () => {
    if (wiz.dataset.step !== '2') { status.textContent = 'finish-blocked'; return; }
    if (allergyChk.checked && allergyNote.value.trim().length < 3) { status.textContent = 'err-allergy'; return; }
    if (!/^[A-Z]{2}-[0-9]{4}$/.test(insCode.value.trim())) { status.textContent = 'err-insurance'; return; }
    regPromise = (async () => {
      const res = await fetch('https://api.clinic.w2.test/patients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: nameEl.value.trim(),
          birthYear: Number(yearEl.value),
          allergy: allergyChk.checked ? allergyNote.value.trim() : 'none',
          insurance: insCode.value.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        sessionStorage.removeItem('intake_ckpt');
        status.textContent = 'registered:' + data.mrn;
        return { ok: true, mrn: data.mrn };
      }
      status.textContent = 'conflict:' + res.status;
      return { ok: false, status: res.status, code: data.code };
    })();
  });

  for (const a of actions) {
    if (a.op === 'fill') document.getElementById(a.id).value = String(a.value);
    else if (a.op === 'click') document.getElementById(a.id).click();
  }
  const outcome = await regPromise;
  return { step: wiz.dataset.step, status: status.textContent, s2Hidden: s2.hidden, outcome };
}`;
    const pairActions = [[
      {op: 'fill', id: 'full-name', value: 'Mina Patel'},
      {op: 'fill', id: 'birth-year', value: 1986},
      {op: 'click', id: 'next-btn'},
      {op: 'click', id: 'has-allergy'},
      {op: 'fill', id: 'allergy-note', value: 'Penicillin'},
      {op: 'fill', id: 'ins-code', value: 'HC-4410'},
      {op: 'click', id: 'finish-btn'},
    ]];
    const pairId = 'w2-pair:patient-intake-wizard';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-intake-ok', family, source, args: pairActions, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {session: {}}, http: () => ({status: 201, json: {mrn: 'MRN-7721'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-intake-dup-409', family, source, args: pairActions, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {session: {}}, http: () => ({status: 409, json: {code: 'DUPLICATE_MRN'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-intake-allergy-validation', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'fill', id: 'full-name', value: 'Leo Kim'}, {op: 'click', id: 'next-btn'}, {op: 'click', id: 'has-allergy'}, {op: 'fill', id: 'allergy-note', value: 'no'}, {op: 'click', id: 'finish-btn'}]],
      mock: {storage: {session: {}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-intake-hydrated-back', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'click', id: 'next-btn'}, {op: 'click', id: 'back-btn'}, {op: 'click', id: 'next-btn'}, {op: 'click', id: 'finish-btn'}]],
      mock: {storage: {session: {intake_ckpt: JSON.stringify({name: 'Sara Chen', insCode: 'BX-1029'})}}, http: () => ({status: 201, json: {mrn: 'MRN-8804'}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-03: Developer Webhook Subscription Form (test ping + confirm disable)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:webhook-endpoint-form';
    const html = `<!DOCTYPE html><html><head><title>Webhooks</title></head><body>
<div id="hook-panel" data-active="true">
  <input id="hook-url" value="https://hooks.client.test/events" />
  <input id="hook-secret" value="whsec_alpha99" />
  <input id="ev-push" type="checkbox" checked />
  <input id="ev-release" type="checkbox" />
  <button id="ping-btn" type="button">Send Ping</button>
  <button id="toggle-btn" type="button">Disable</button>
  <span id="hook-badge" class="badge active">ACTIVE</span>
  <div id="ping-out"></div>
</div></body></html>`;
    const url = 'https://dev.w2.test/settings/webhooks';
    const source = `async function run(steps) {
  const panel = document.getElementById('hook-panel');
  const urlEl = document.getElementById('hook-url');
  const secretEl = document.getElementById('hook-secret');
  const evPush = document.getElementById('ev-push');
  const evRelease = document.getElementById('ev-release');
  const pingBtn = document.getElementById('ping-btn');
  const toggleBtn = document.getElementById('toggle-btn');
  const badge = document.getElementById('hook-badge');
  const pingOut = document.getElementById('ping-out');

  let inflight = Promise.resolve();
  pingBtn.addEventListener('click', () => {
    const target = urlEl.value.trim();
    const events = [evPush.checked ? 'push' : null, evRelease.checked ? 'release' : null].filter(Boolean);
    if (!target.startsWith('https://') || secretEl.value.trim().length < 8 || events.length === 0) {
      pingOut.textContent = 'invalid-config';
      return;
    }
    inflight = (async () => {
      const res = await fetch('https://api.dev.w2.test/webhooks/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, events, active: panel.dataset.active === 'true' }),
      });
      const body = await res.json();
      pingOut.textContent = res.ok ? ('pong:' + body.latencyMs + 'ms') : ('fail:' + res.status);
    })();
  });

  toggleBtn.addEventListener('click', () => {
    const currentlyActive = panel.dataset.active === 'true';
    if (currentlyActive) {
      if (!confirm('Disable active webhook delivery?')) {
        pingOut.textContent = 'disable-cancelled';
        return;
      }
      panel.dataset.active = 'false';
      badge.className = 'badge paused';
      badge.textContent = 'PAUSED';
      toggleBtn.textContent = 'Enable';
      pingOut.textContent = 'disabled';
    } else {
      panel.dataset.active = 'true';
      badge.className = 'badge active';
      badge.textContent = 'ACTIVE';
      toggleBtn.textContent = 'Disable';
      pingOut.textContent = 'enabled';
    }
  });

  for (const s of steps) {
    if (s.op === 'value') document.getElementById(s.id).value = s.value;
    else if (s.op === 'click') document.getElementById(s.id).click();
    await inflight;
  }
  return { active: panel.dataset.active, badge: badge.textContent, btn: toggleBtn.textContent, out: pingOut.textContent };
}`;
    const pairSteps = [[{op: 'click', id: 'ev-release'}, {op: 'click', id: 'toggle-btn'}, {op: 'click', id: 'ping-btn'}]];
    const pairId = 'w2-pair:webhook-confirm-disable';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-webhook-disable-yes', family, source, args: pairSteps, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [true]}, http: () => ({status: 200, json: {latencyMs: 42}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-webhook-disable-no', family, source, args: pairSteps, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [false]}, http: () => ({status: 200, json: {latencyMs: 38}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-webhook-insecure-url', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'value', id: 'hook-url', value: 'http://plain.test/hook'}, {op: 'click', id: 'ping-btn'}]],
      mock: {},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-04: Sortable & Filterable Accounts-Payable Invoice Ledger Table
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:invoice-ledger-table';
    const html = `<!DOCTYPE html><html><head><title>Invoice Ledger</title></head><body>
<div id="ledger">
  <select id="status-filter"><option value="all" selected>All</option><option value="open">Open</option><option value="overdue">Overdue</option><option value="paid">Paid</option></select>
  <button id="sort-amount" data-sort="amount">Sort Amount</button>
  <button id="sort-vendor" data-sort="vendor">Sort Vendor</button>
  <button id="pay-selected">Pay Selected</button>
  <table id="inv-table"><tbody></tbody></table>
  <div id="ledger-summary"></div>
</div></body></html>`;
    const url = 'https://ap.w2.test/ledger';
    const source = `async function run(invoices, actions) {
  const tbody = document.querySelector('#inv-table tbody');
  const filterEl = document.getElementById('status-filter');
  const summary = document.getElementById('ledger-summary');
  const rows = invoices.map(r => ({ ...r }));
  let sortCol = localStorage.getItem('ledger_sort') || 'amount';
  let sortDir = 'desc';
  const selected = new Set();

  function render() {
    const f = filterEl.value;
    const vis = rows.filter(r => f === 'all' || r.status === f);
    vis.sort((a, b) => {
      let cmp = sortCol === 'amount' ? a.amount - b.amount : a.vendor.localeCompare(b.vendor);
      if (cmp === 0) cmp = a.id.localeCompare(b.id);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    tbody.innerHTML = '';
    for (const inv of vis) {
      const tr = document.createElement('tr');
      tr.dataset.id = inv.id;
      tr.dataset.status = inv.status;
      tr.innerHTML = '<td><input type="checkbox" class="sel-box" ' + (selected.has(inv.id) ? 'checked' : '') + ' /></td>'
        + '<td class="vendor">' + inv.vendor + '</td>'
        + '<td class="amt">' + inv.amount + '</td>'
        + '<td class="st">' + inv.status + '</td>';
      tbody.appendChild(tr);
    }
    const sum = vis.reduce((acc, r) => acc + r.amount, 0);
    summary.textContent = vis.length + ' rows | $' + sum + ' | sort=' + sortCol + ':' + sortDir;
  }

  filterEl.addEventListener('change', render);
  for (const btn of document.querySelectorAll('button[data-sort]')) {
    btn.addEventListener('click', () => {
      const col = btn.dataset.sort;
      if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = col; sortDir = col === 'amount' ? 'desc' : 'asc'; }
      localStorage.setItem('ledger_sort', sortCol);
      render();
    });
  }
  tbody.addEventListener('click', ev => {
    const cb = ev.target.closest('input.sel-box');
    if (!cb) return;
    const id = cb.closest('tr').dataset.id;
    if (cb.checked) selected.add(id); else selected.delete(id);
  });

  let batchOutcome = null;
  let payPromise = Promise.resolve();
  document.getElementById('pay-selected').addEventListener('click', () => {
    const ids = [...selected].sort();
    if (!ids.length) { batchOutcome = { paid: 0, note: 'none-selected' }; return; }
    payPromise = (async () => {
      const res = await fetch('https://api.ap.w2.test/invoices/batch-pay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (res.ok) {
        for (const r of rows) if (selected.has(r.id)) r.status = 'paid';
        selected.clear();
        render();
        batchOutcome = { paid: ids.length, batchId: data.batchId };
      } else {
        batchOutcome = { paid: 0, status: res.status, error: data.error };
      }
    })();
  });

  render();
  for (const act of actions) {
    if (act.op === 'filter') { filterEl.value = act.value; filterEl.dispatchEvent(new Event('change')); }
    else if (act.op === 'click') document.querySelector(act.sel)?.click();
    await payPromise;
  }
  return {
    summary: summary.textContent,
    order: tbody.querySelectorAll('tr').map(tr => tr.dataset.id + ':' + tr.dataset.status),
    batchOutcome,
  };
}`;
    const seed = [
      {id: 'INV-10', vendor: 'Zephyr Cloud', amount: 1200, status: 'open'},
      {id: 'INV-11', vendor: 'Atlas Freight', amount: 850, status: 'overdue'},
      {id: 'INV-12', vendor: 'Cobalt Labs', amount: 1200, status: 'overdue'},
      {id: 'INV-13', vendor: 'Beacon Power', amount: 400, status: 'paid'},
    ];
    const pairArgs = [seed, [
      {op: 'filter', value: 'overdue'},
      {op: 'click', sel: '#sort-vendor'},
      {op: 'click', sel: 'tr[data-id="INV-11"] input.sel-box'},
      {op: 'click', sel: 'tr[data-id="INV-12"] input.sel-box'},
      {op: 'click', sel: '#pay-selected'},
    ]];
    const pairId = 'w2-pair:invoice-ledger-batch-pay';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-ledger-pay-ok', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, http: () => ({status: 200, json: {batchId: 'BAT-55'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-ledger-pay-locked-409', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, http: () => ({status: 409, json: {error: 'accounting-period-locked'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-ledger-toggle-sort-dir', family, source, initialHtml: html, initialUrl: url,
      args: [seed, [{op: 'click', sel: '#sort-amount'}, {op: 'click', sel: '#pay-selected'}]],
      mock: {storage: {local: {ledger_sort: 'amount'}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-ledger-open-filter', family, source, initialHtml: html, initialUrl: url,
      args: [seed, [{op: 'filter', value: 'open'}, {op: 'click', sel: 'tr[data-id="INV-10"] input.sel-box'}, {op: 'click', sel: '#pay-selected'}]],
      mock: {storage: {local: {}}, http: () => ({status: 200, json: {batchId: 'BAT-56'}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-05: Kubernetes Cluster Nodes Inventory Grid (filter + cordon confirm)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:cluster-nodes-grid';
    const html = `<!DOCTYPE html><html><head><title>Cluster Nodes</title></head><body>
<section id="cluster-ui">
  <input id="min-cpu" type="number" value="0" />
  <input id="node-search" value="" />
  <ul id="node-list"></ul>
  <p id="ops-log">idle</p>
</section></body></html>`;
    const url = 'https://k8s.w2.test/nodes';
    const source = `async function run(nodes, ops) {
  const list = document.getElementById('node-list');
  const minCpu = document.getElementById('min-cpu');
  const search = document.getElementById('node-search');
  const log = document.getElementById('ops-log');
  const state = nodes.map(n => ({ ...n }));

  function render() {
    const floor = Number(minCpu.value) || 0;
    const q = search.value.trim().toLowerCase();
    const visible = state.filter(n => n.cpuPct >= floor && (!q || n.name.toLowerCase().includes(q) || n.zone.includes(q)));
    visible.sort((a, b) => b.cpuPct - a.cpuPct || a.name.localeCompare(b.name));
    list.innerHTML = '';
    for (const n of visible) {
      const li = document.createElement('li');
      li.dataset.node = n.name;
      li.className = n.cordoned ? 'node cordoned' : 'node ready';
      li.innerHTML = '<span>' + n.name + ' (' + n.cpuPct + '%)</span><button class="drain-btn" data-node="' + n.name + '">Drain</button>';
      list.appendChild(li);
    }
  }

  let pending = Promise.resolve();
  list.addEventListener('click', ev => {
    const btn = ev.target.closest('button.drain-btn');
    if (!btn) return;
    const nodeName = btn.dataset.node;
    const target = state.find(n => n.name === nodeName);
    if (!target || target.cordoned) return;
    if (!confirm('Cordon and drain ' + nodeName + '?')) {
      log.textContent = 'aborted:' + nodeName;
      return;
    }
    pending = (async () => {
      const res = await fetch('https://api.k8s.w2.test/nodes/' + nodeName + '/drain', { method: 'POST' });
      if (res.ok) {
        target.cordoned = true;
        render();
        log.textContent = 'drained:' + nodeName;
      } else {
        log.textContent = 'drain-err:' + res.status;
      }
    })();
  });

  minCpu.addEventListener('input', render);
  search.addEventListener('input', render);
  render();

  for (const op of ops) {
    if (op.type === 'cpu') { minCpu.value = String(op.value); minCpu.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    else if (op.type === 'search') { search.value = op.value; search.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    else if (op.type === 'drain') { document.querySelector('button.drain-btn[data-node="' + op.node + '"]')?.click(); }
    await pending;
  }

  return {
    log: log.textContent,
    visible: list.querySelectorAll('li').map(li => li.dataset.node + ':' + li.className),
  };
}`;
    const cluster = [
      {name: 'gpu-east-01', zone: 'us-east', cpuPct: 88, cordoned: false},
      {name: 'cpu-west-04', zone: 'us-west', cpuPct: 42, cordoned: false},
      {name: 'gpu-east-02', zone: 'us-east', cpuPct: 76, cordoned: false},
    ];
    const pairArgs = [cluster, [{type: 'cpu', value: 70}, {type: 'drain', node: 'gpu-east-01'}]];
    const pairId = 'w2-pair:cluster-drain-confirm';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-cluster-drain-yes', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [true]}, http: () => ({status: 200, json: {evicted: 6}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-cluster-drain-no', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [false]}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-cluster-zone-search-500', family, source, initialHtml: html, initialUrl: url,
      args: [cluster, [{type: 'search', value: 'west'}, {type: 'drain', node: 'cpu-west-04'}]],
      mock: {dialogs: {confirm: [true]}, http: () => ({status: 500, json: {error: 'pdb-blocked'}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-06: Student Gradebook Matrix Table (inline edit + weighted grades)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:gradebook-matrix-table';
    const html = `<!DOCTYPE html><html><head><title>Gradebook</title></head><body>
<div id="gb">
  <button id="sort-rank">Sort Rank</button>
  <button id="sort-name">Sort Name</button>
  <table id="grades"><tbody></tbody></table>
  <div id="class-avg">0</div>
</div></body></html>`;
    const url = 'https://lms.w2.test/gradebook';
    const source = `function run(students, edits) {
  const tbody = document.querySelector('#grades tbody');
  const avgEl = document.getElementById('class-avg');
  const rows = students.map(s => ({ ...s }));
  let mode = 'rank';

  const letter = score => score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  const weighted = s => Math.round((s.hw * 0.4 + s.exam * 0.6) * 10) / 10;

  function render() {
    const ordered = [...rows].sort((a, b) =>
      mode === 'rank' ? (weighted(b) - weighted(a) || a.name.localeCompare(b.name)) : a.name.localeCompare(b.name)
    );
    tbody.innerHTML = '';
    for (const s of ordered) {
      const w = weighted(s);
      const tr = document.createElement('tr');
      tr.dataset.student = s.id;
      tr.innerHTML = '<td class="nm">' + s.name + '</td>'
        + '<td><input class="exam-in" type="number" value="' + s.exam + '" /></td>'
        + '<td class="final">' + w + ' (' + letter(w) + ')</td>';
      tbody.appendChild(tr);
    }
    const mean = rows.length ? Math.round((rows.reduce((a, s) => a + weighted(s), 0) / rows.length) * 10) / 10 : 0;
    avgEl.textContent = String(mean);
  }

  tbody.addEventListener('input', ev => {
    const inp = ev.target.closest('input.exam-in');
    if (!inp) return;
    const id = inp.closest('tr').dataset.student;
    const st = rows.find(r => r.id === id);
    if (!st) return;
    st.exam = Math.max(0, Math.min(100, Number(inp.value) || 0));
    localStorage.setItem('gb_autosave', JSON.stringify(rows.map(r => ({ id: r.id, exam: r.exam }))));
    render();
  });

  document.getElementById('sort-rank').addEventListener('click', () => { mode = 'rank'; render(); });
  document.getElementById('sort-name').addEventListener('click', () => { mode = 'name'; render(); });
  render();

  for (const e of edits) {
    if (e.op === 'exam') {
      const inp = tbody.querySelector('tr[data-student="' + e.id + '"] input.exam-in');
      if (inp) { inp.value = String(e.score); inp.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    } else if (e.op === 'sort') {
      document.getElementById(e.mode === 'name' ? 'sort-name' : 'sort-rank').click();
    }
  }
  return {
    avg: Number(avgEl.textContent),
    table: tbody.querySelectorAll('tr').map(tr => tr.dataset.student + ':' + tr.querySelector('.final').textContent),
  };
}`;
    const roster = [
      {id: 's1', name: 'Clara', hw: 85, exam: 78},
      {id: 's2', name: 'Devon', hw: 92, exam: 88},
      {id: 's3', name: 'Aisha', hw: 74, exam: 91},
    ];
    tasks.push(await buildSingleTask({
      id: 'fe-w2-gradebook-boost-rank', family, source, initialHtml: html, initialUrl: url,
      args: [roster, [{op: 'exam', id: 's1', score: 96}]],
      mock: {},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-gradebook-clamp-and-name', family, source, initialHtml: html, initialUrl: url,
      args: [roster, [{op: 'exam', id: 's3', score: 120}, {op: 'exam', id: 's2', score: 52}, {op: 'sort', mode: 'name'}]],
      mock: {},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-gradebook-initial-sort', family, source, initialHtml: html, initialUrl: url,
      args: [roster, [{op: 'sort', mode: 'name'}, {op: 'sort', mode: 'rank'}]],
      mock: null,
    }));
  }

  // --------------------------------------------------------------------------
  // SF-07: Playlist Drag-and-Drop Reorder Queue (CustomEvent drop + sync)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:playlist-reorder-queue';
    const html = `<!DOCTYPE html><html><head><title>Playlist Queue</title></head><body>
<div id="player">
  <ul id="track-list"></ul>
  <div id="total-dur">0:00</div>
  <button id="sync-queue">Sync</button>
  <span id="sync-badge">local</span>
</div></body></html>`;
    const url = 'https://audio.w2.test/queue';
    const source = `async function run(tracks, moves) {
  const ul = document.getElementById('track-list');
  const durEl = document.getElementById('total-dur');
  const badge = document.getElementById('sync-badge');
  const queue = tracks.map(t => ({ ...t }));

  const fmt = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  function render() {
    ul.innerHTML = '';
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      const li = document.createElement('li');
      li.dataset.trackId = t.id;
      li.dataset.index = String(i);
      li.innerHTML = '<span class="t-title">' + t.title + '</span><button class="up">Up</button><button class="rm">X</button>';
      ul.appendChild(li);
    }
    const secs = queue.reduce((s, t) => s + t.sec, 0);
    durEl.textContent = fmt(secs);
    localStorage.setItem('playlist_order', JSON.stringify(queue.map(t => t.id)));
  }

  ul.addEventListener('reorder-drop', ev => {
    const { fromId, toIndex } = ev.detail;
    const fromIdx = queue.findIndex(t => t.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = queue.splice(fromIdx, 1);
    const clamped = Math.max(0, Math.min(queue.length, toIndex));
    queue.splice(clamped, 0, moved);
    render();
  });

  ul.addEventListener('click', ev => {
    const li = ev.target.closest('li[data-track-id]');
    if (!li) return;
    const idx = Number(li.dataset.index);
    if (ev.target.classList.contains('up') && idx > 0) {
      [queue[idx - 1], queue[idx]] = [queue[idx], queue[idx - 1]];
      render();
    } else if (ev.target.classList.contains('rm')) {
      queue.splice(idx, 1);
      render();
    }
  });

  let syncPromise = Promise.resolve();
  document.getElementById('sync-queue').addEventListener('click', () => {
    syncPromise = (async () => {
      const res = await fetch('https://api.audio.w2.test/queue', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order: queue.map(t => t.id) }),
      });
      badge.textContent = res.ok ? 'synced' : ('offline:' + res.status);
    })();
  });

  render();
  for (const m of moves) {
    if (m.op === 'drop') ul.dispatchEvent(new CustomEvent('reorder-drop', { detail: { fromId: m.fromId, toIndex: m.toIndex } }));
    else if (m.op === 'up') ul.querySelector('li[data-track-id="' + m.id + '"] button.up')?.click();
    else if (m.op === 'rm') ul.querySelector('li[data-track-id="' + m.id + '"] button.rm')?.click();
    else if (m.op === 'sync') document.getElementById('sync-queue').click();
    await syncPromise;
  }
  return { order: queue.map(t => t.id), totalDur: durEl.textContent, badge: badge.textContent };
}`;
    const tracks = [
      {id: 'tr1', title: 'Intro', sec: 95},
      {id: 'tr2', title: 'Solaris', sec: 210},
      {id: 'tr3', title: 'Drift', sec: 185},
      {id: 'tr4', title: 'Outro', sec: 130},
    ];
    const pairArgs = [tracks, [{op: 'drop', fromId: 'tr4', toIndex: 1}, {op: 'rm', id: 'tr1'}, {op: 'sync'}]];
    const pairId = 'w2-pair:playlist-reorder-sync';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-playlist-sync-ok', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 200, json: {saved: true}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-playlist-sync-503', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 503, json: {error: 'unavailable'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-playlist-move-up-chain', family, source, initialHtml: html, initialUrl: url,
      args: [tracks, [{op: 'up', id: 'tr3'}, {op: 'up', id: 'tr3'}, {op: 'up', id: 'tr3'}]],
      mock: {},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-08: Sprint Backlog Lane Ranker (drag-drop WIP limit + confirm override)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:sprint-backlog-ranker';
    const html = `<!DOCTYPE html><html><head><title>Backlog Ranker</title></head><body>
<main id="board" data-wip-limit="8">
  <section id="lane-now" data-lane="now"></section>
  <section id="lane-next" data-lane="next"></section>
  <section id="lane-icebox" data-lane="icebox"></section>
  <div id="wip-status">ok</div>
</main></body></html>`;
    const url = 'https://agile.w2.test/backlog';
    const source = `function run(items, drags) {
  const board = document.getElementById('board');
  const wipLimit = Number(board.dataset.wipLimit);
  const wipEl = document.getElementById('wip-status');
  const lanes = {
    now: document.getElementById('lane-now'),
    next: document.getElementById('lane-next'),
    icebox: document.getElementById('lane-icebox'),
  };
  const cards = items.map(it => ({ ...it }));

  function lanePoints(laneName) {
    return cards.filter(c => c.lane === laneName).reduce((s, c) => s + c.pts, 0);
  }

  function render() {
    for (const name of ['now', 'next', 'icebox']) {
      const sec = lanes[name];
      sec.innerHTML = '';
      for (const c of cards.filter(x => x.lane === name)) {
        const div = document.createElement('div');
        div.className = 'story';
        div.dataset.story = c.id;
        div.dataset.pts = String(c.pts);
        div.textContent = c.id + ':' + c.pts + 'pt';
        sec.appendChild(div);
      }
      sec.dataset.points = String(lanePoints(name));
    }
  }

  board.addEventListener('lane-drop', ev => {
    const { storyId, toLane } = ev.detail;
    const card = cards.find(c => c.id === storyId);
    if (!card || card.lane === toLane) return;
    if (toLane === 'now') {
      const projected = lanePoints('now') + card.pts;
      if (projected > wipLimit) {
        if (!confirm('Exceed WIP limit (' + projected + '/' + wipLimit + ')?')) {
          wipEl.textContent = 'blocked:' + storyId;
          return;
        }
        wipEl.textContent = 'override:' + projected;
      }
    }
    card.lane = toLane;
    render();
  });

  render();
  for (const d of drags) {
    board.dispatchEvent(new CustomEvent('lane-drop', { detail: d }));
  }
  return {
    wipStatus: wipEl.textContent,
    nowPoints: Number(lanes.now.dataset.points),
    lanes: {
      now: lanes.now.querySelectorAll('.story').map(el => el.dataset.story),
      next: lanes.next.querySelectorAll('.story').map(el => el.dataset.story),
      icebox: lanes.icebox.querySelectorAll('.story').map(el => el.dataset.story),
    },
  };
}`;
    const stories = [
      {id: 'ST-1', pts: 5, lane: 'now'},
      {id: 'ST-2', pts: 5, lane: 'next'},
      {id: 'ST-3', pts: 2, lane: 'icebox'},
    ];
    const pairArgs = [stories, [{storyId: 'ST-3', toLane: 'now'}, {storyId: 'ST-2', toLane: 'now'}]];
    const pairId = 'w2-pair:sprint-wip-override';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-backlog-wip-allow', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [true]}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-backlog-wip-block', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [false]}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-backlog-rebalance-clean', family, source, initialHtml: html, initialUrl: url,
      args: [stories, [{storyId: 'ST-1', toLane: 'next'}, {storyId: 'ST-2', toLane: 'now'}, {storyId: 'ST-3', toLane: 'now'}]],
      mock: null,
    }));
  }

  // --------------------------------------------------------------------------
  // SF-09: Dashboard Widget Layout (pin/unpin, collapse, reset confirm, storage)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:dashboard-widget-layout';
    const html = `<!DOCTYPE html><html><head><title>Dashboard</title></head><body>
<div id="dash">
  <div id="grid"></div>
  <button id="reset-layout">Reset Layout</button>
  <span id="dash-msg"></span>
</div></body></html>`;
    const url = 'https://bi.w2.test/dashboard';
    const source = `function run(ops) {
  const DEFAULTS = [
    { id: 'rev', pinned: true, collapsed: false },
    { id: 'churn', pinned: false, collapsed: false },
    { id: 'nps', pinned: false, collapsed: false },
    { id: 'latency', pinned: false, collapsed: true },
  ];
  const grid = document.getElementById('grid');
  const msg = document.getElementById('dash-msg');
  const saved = localStorage.getItem('dash_tiles_w2');
  let tiles = saved ? JSON.parse(saved) : DEFAULTS.map(t => ({ ...t }));

  function sortAndRender() {
    tiles.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    grid.innerHTML = '';
    for (const t of tiles) {
      const card = document.createElement('article');
      card.dataset.tile = t.id;
      card.className = 'tile' + (t.pinned ? ' pinned' : '') + (t.collapsed ? ' collapsed' : '');
      card.innerHTML = '<button class="pin">P</button><button class="fold">F</button>';
      grid.appendChild(card);
    }
    localStorage.setItem('dash_tiles_w2', JSON.stringify(tiles));
  }

  grid.addEventListener('click', ev => {
    const card = ev.target.closest('article[data-tile]');
    if (!card) return;
    const t = tiles.find(x => x.id === card.dataset.tile);
    if (!t) return;
    if (ev.target.classList.contains('pin')) t.pinned = !t.pinned;
    else if (ev.target.classList.contains('fold')) t.collapsed = !t.collapsed;
    sortAndRender();
  });

  document.getElementById('reset-layout').addEventListener('click', () => {
    if (confirm('Reset dashboard layout to defaults?')) {
      tiles = DEFAULTS.map(t => ({ ...t }));
      localStorage.removeItem('dash_tiles_w2');
      sortAndRender();
      msg.textContent = 'reset-done';
    } else {
      msg.textContent = 'reset-kept';
    }
  });

  sortAndRender();
  for (const op of ops) {
    if (op.type === 'reset') document.getElementById('reset-layout').click();
    else grid.querySelector('article[data-tile="' + op.tile + '"] button.' + op.type)?.click();
  }
  return {
    msg: msg.textContent,
    tiles: grid.querySelectorAll('article').map(a => a.dataset.tile + ':' + a.className),
  };
}`;
    const pairOps = [[{type: 'pin', tile: 'nps'}, {type: 'fold', tile: 'rev'}, {type: 'reset'}]];
    const pairId = 'w2-pair:dashboard-reset-confirm';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-dash-reset-yes', family, source, args: pairOps, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, dialogs: {confirm: [true]}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-dash-reset-no', family, source, args: pairOps, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, dialogs: {confirm: [false]}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-dash-hydrate-unpin', family, source, initialHtml: html, initialUrl: url,
      args: [[{type: 'pin', tile: 'latency'}, {type: 'fold', tile: 'latency'}]],
      mock: {storage: {local: {dash_tiles_w2: JSON.stringify([{id: 'rev', pinned: false, collapsed: true}, {id: 'latency', pinned: false, collapsed: true}])}}},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-10: Vector Canvas Layer Inspector (Bounded Undo/Redo + Ctrl+Z / Ctrl+Y)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:canvas-layer-history';
    const html = `<!DOCTYPE html><html><head><title>Layer Inspector</title></head><body>
<div id="studio">
  <ul id="layers"></ul>
  <span id="stack-info">undo=0 redo=0</span>
</div></body></html>`;
    const url = 'https://design.w2.test/canvas';
    const source = `function run(commands) {
  const ul = document.getElementById('layers');
  const info = document.getElementById('stack-info');
  let layers = [
    { id: 'bg', name: 'Background', opacity: 100, visible: true },
    { id: 'hero', name: 'Hero Text', opacity: 100, visible: true },
  ];
  const undoStack = [];
  const redoStack = [];
  const snap = arr => arr.map(x => ({ ...x }));

  function render() {
    ul.innerHTML = '';
    for (const l of layers) {
      const li = document.createElement('li');
      li.dataset.id = l.id;
      li.className = l.visible ? 'layer vis' : 'layer hid';
      li.textContent = l.name + '@' + l.opacity + '%';
      ul.appendChild(li);
    }
    info.textContent = 'undo=' + undoStack.length + ' redo=' + redoStack.length;
    sessionStorage.setItem('layer_count', String(layers.length));
  }

  function applyCmd(cmd) {
    undoStack.push(snap(layers));
    if (undoStack.length > 8) undoStack.shift();
    redoStack.length = 0;
    if (cmd.type === 'add') layers.push({ id: cmd.id, name: cmd.name, opacity: 100, visible: true });
    else if (cmd.type === 'opacity') { const l = layers.find(x => x.id === cmd.id); if (l) l.opacity = cmd.value; }
    else if (cmd.type === 'toggle') { const l = layers.find(x => x.id === cmd.id); if (l) l.visible = !l.visible; }
    else if (cmd.type === 'delete') layers = layers.filter(x => x.id !== cmd.id);
    render();
  }

  window.addEventListener('keydown', ev => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 'z') {
      if (!undoStack.length) return;
      redoStack.push(snap(layers));
      layers = undoStack.pop();
      render();
    } else if (ev.ctrlKey && ev.key.toLowerCase() === 'y') {
      if (!redoStack.length) return;
      undoStack.push(snap(layers));
      layers = redoStack.pop();
      render();
    }
  });

  render();
  for (const c of commands) {
    if (c.type === 'undo') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    else if (c.type === 'redo') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    else applyCmd(c);
  }
  return {
    stackInfo: info.textContent,
    layers: ul.querySelectorAll('li').map(li => li.dataset.id + ':' + li.className + ':' + li.textContent),
  };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-layers-undo-redo-branch', family, source, initialHtml: html, initialUrl: url,
      args: [[
        {type: 'add', id: 'badge', name: 'Badge'},
        {type: 'opacity', id: 'badge', value: 60},
        {type: 'undo'},
        {type: 'toggle', id: 'hero'},
        {type: 'redo'},
      ]],
      mock: {},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-layers-delete-restore', family, source, initialHtml: html, initialUrl: url,
      args: [[
        {type: 'delete', id: 'hero'},
        {type: 'opacity', id: 'bg', value: 40},
        {type: 'undo'},
        {type: 'undo'},
        {type: 'redo'},
      ]],
      mock: {},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-layers-empty-undo', family, source, initialHtml: html, initialUrl: url,
      args: [[{type: 'undo'}, {type: 'add', id: 'icon', name: 'Logo'}, {type: 'undo'}, {type: 'redo'}]],
      mock: {},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-11: Rich Document Outline Editor (indent/outdent + undo + prompt rename)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:rich-outline-editor';
    const html = `<!DOCTYPE html><html><head><title>Outliner</title></head><body>
<ol id="outline"></ol>
<div id="outline-status">ready</div>
</body></html>`;
    const url = 'https://docs.w2.test/outline';
    const source = `function run(nodes, actions) {
  const ol = document.getElementById('outline');
  const status = document.getElementById('outline-status');
  let items = nodes.map(n => ({ ...n }));
  const history = [];

  function render() {
    ol.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.dataset.id = it.id;
      li.dataset.depth = String(it.depth);
      li.textContent = '  '.repeat(it.depth) + it.title;
      ol.appendChild(li);
    }
    localStorage.setItem('outline_v2', JSON.stringify(items));
  }

  render();
  for (const act of actions) {
    if (act.op === 'indent') {
      const idx = items.findIndex(x => x.id === act.id);
      if (idx > 0 && items[idx].depth <= items[idx - 1].depth && items[idx].depth < 3) {
        history.push(items.map(x => ({ ...x })));
        items[idx].depth++;
        render();
      }
    } else if (act.op === 'outdent') {
      const idx = items.findIndex(x => x.id === act.id);
      if (idx >= 0 && items[idx].depth > 0) {
        history.push(items.map(x => ({ ...x })));
        items[idx].depth--;
        render();
      }
    } else if (act.op === 'rename') {
      const target = items.find(x => x.id === act.id);
      if (target) {
        const next = prompt('Rename section:', target.title);
        if (next && next.trim()) {
          history.push(items.map(x => ({ ...x })));
          target.title = next.trim();
          status.textContent = 'renamed:' + act.id;
          render();
        } else {
          status.textContent = 'rename-cancelled';
        }
      }
    } else if (act.op === 'undo' && history.length) {
      items = history.pop();
      status.textContent = 'undone';
      render();
    }
  }
  return {
    status: status.textContent,
    outline: ol.querySelectorAll('li').map(li => li.dataset.id + '@d' + li.dataset.depth + ':' + li.textContent.trim()),
  };
}`;
    const seedNodes = [
      {id: 'n1', title: 'Overview', depth: 0},
      {id: 'n2', title: 'Architecture', depth: 0},
      {id: 'n3', title: 'Storage', depth: 1},
    ];
    const pairArgs = [seedNodes, [{op: 'indent', id: 'n2'}, {op: 'rename', id: 'n3'}]];
    const pairId = 'w2-pair:outline-prompt-rename';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-outline-rename-apply', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {prompt: ['Persistent Storage']}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-outline-rename-cancel', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {prompt: [null]}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-outline-outdent-undo', family, source, initialHtml: html, initialUrl: url,
      args: [seedNodes, [{op: 'outdent', id: 'n3'}, {op: 'indent', id: 'n2'}, {op: 'undo'}]],
      mock: {},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-12: Issue Comment Reaction Optimistic UI with Rollback (causal pair + 2)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:issue-reaction-optimistic';
    const html = `<!DOCTYPE html><html><head><title>Issue #412</title></head><body>
<article id="comment-7">
  <button id="react-up" data-emoji="thumbs_up" data-reacted="false" data-count="14">👍 14</button>
  <button id="react-rocket" data-emoji="rocket" data-reacted="true" data-count="3">🚀 3</button>
  <div id="react-toast" class="toast"></div>
</article></body></html>`;
    const url = 'https://git.w2.test/org/repo/issues/412';
    const source = `async function run(clicks) {
  const article = document.getElementById('comment-7');
  const toast = document.getElementById('react-toast');
  const snapshots = [];

  async function toggleReaction(btn) {
    const wasReacted = btn.dataset.reacted === 'true';
    const prevCount = Number(btn.dataset.count);
    const prevText = btn.textContent;
    const icon = prevText.split(' ')[0];
    const nextReacted = !wasReacted;
    const nextCount = prevCount + (nextReacted ? 1 : -1);

    // Optimistic update before fetch resolves
    btn.dataset.reacted = String(nextReacted);
    btn.dataset.count = String(nextCount);
    btn.textContent = icon + ' ' + nextCount;
    btn.disabled = true;
    snapshots.push({ phase: 'optimistic', emoji: btn.dataset.emoji, count: nextCount, reacted: nextReacted });

    const res = await fetch('https://api.git.w2.test/comments/7/reactions', {
      method: nextReacted ? 'POST' : 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emoji: btn.dataset.emoji }),
    });
    btn.disabled = false;
    if (!res.ok) {
      // Exact rollback
      btn.dataset.reacted = String(wasReacted);
      btn.dataset.count = String(prevCount);
      btn.textContent = prevText;
      toast.textContent = 'rollback:' + btn.dataset.emoji + ':' + res.status;
      snapshots.push({ phase: 'rollback', emoji: btn.dataset.emoji, count: prevCount, reacted: wasReacted });
      return;
    }
    const data = await res.json();
    btn.dataset.count = String(data.serverCount);
    btn.textContent = icon + ' ' + data.serverCount;
    toast.textContent = 'committed:' + btn.dataset.emoji;
    snapshots.push({ phase: 'committed', emoji: btn.dataset.emoji, count: data.serverCount, reacted: nextReacted });
  }

  let inflight = Promise.resolve();
  article.addEventListener('click', ev => {
    const btn = ev.target.closest('button[data-emoji]');
    if (!btn) return;
    inflight = toggleReaction(btn);
  });

  for (const sel of clicks) {
    document.querySelector(sel)?.click();
    await inflight;
  }
  return {
    up: document.getElementById('react-up').textContent + ':' + document.getElementById('react-up').dataset.reacted,
    rocket: document.getElementById('react-rocket').textContent + ':' + document.getElementById('react-rocket').dataset.reacted,
    toast: toast.textContent,
    snapshots,
  };
}`;
    const pairClicks = [['#react-up', '#react-rocket']];
    const pairId = 'w2-pair:issue-reaction-rollback';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-reaction-commit-ok', family, source, args: pairClicks, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [
        {status: 200, json: {serverCount: 15}},
        {status: 200, json: {serverCount: 2}},
      ]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-reaction-rollback-500', family, source, args: pairClicks, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [
        {status: 500, json: {error: 'db-write-timeout'}},
        {status: 200, json: {serverCount: 2}},
      ]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-reaction-rate-limit-429', family, source, initialHtml: html, initialUrl: url,
      args: [['#react-up']],
      mock: {http: () => ({status: 429, json: {error: 'rate_limited'}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-13: Prod Feature-Flag Kill-Switch Optimistic Toggle + Confirm + Rollback
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:feature-flag-optimistic';
    const html = `<!DOCTYPE html><html><head><title>Feature Flags</title></head><body>
<ul id="flags">
  <li data-flag="checkout_v3" data-env="prod"><input type="checkbox" class="sw" checked /><span class="st">ON</span></li>
  <li data-flag="dark_charts" data-env="staging"><input type="checkbox" class="sw" /><span class="st">OFF</span></li>
</ul>
<div id="flag-banner"></div></body></html>`;
    const url = 'https://flags.w2.test/console';
    const source = `async function run(targets) {
  const ul = document.getElementById('flags');
  const banner = document.getElementById('flag-banner');
  let pending = Promise.resolve();

  ul.addEventListener('click', ev => {
    const sw = ev.target.closest('input.sw');
    if (!sw) return;
    const li = sw.closest('li[data-flag]');
    const flag = li.dataset.flag;
    const env = li.dataset.env;
    const nextVal = sw.checked;
    if (env === 'prod' && !confirm('Toggle prod flag ' + flag + ' to ' + (nextVal ? 'ON' : 'OFF') + '?')) {
      sw.checked = !nextVal;
      banner.textContent = 'cancelled:' + flag;
      return;
    }
    const st = li.querySelector('.st');
    st.textContent = nextVal ? 'ON' : 'OFF';
    li.classList.add('syncing');
    pending = (async () => {
      const res = await fetch('https://api.flags.w2.test/flags/' + flag, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env, enabled: nextVal }),
      });
      li.classList.remove('syncing');
      if (!res.ok) {
        sw.checked = !nextVal;
        st.textContent = !nextVal ? 'ON' : 'OFF';
        banner.textContent = 'reverted:' + flag + ':' + res.status;
      } else {
        banner.textContent = 'saved:' + flag + ':' + (nextVal ? 'ON' : 'OFF');
      }
    })();
  });

  for (const name of targets) {
    ul.querySelector('li[data-flag="' + name + '"] input.sw')?.click();
    await pending;
  }
  return {
    banner: banner.textContent,
    states: ul.querySelectorAll('li').map(li => li.dataset.flag + '=' + li.querySelector('.st').textContent + ':' + li.querySelector('input.sw').checked),
  };
}`;
    const pairTargets = [['checkout_v3']];
    const pairId = 'w2-pair:feature-flag-rollback';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-flag-prod-saved', family, source, args: pairTargets, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [true]}, http: () => ({status: 200, json: {ok: true}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-flag-prod-403-revert', family, source, args: pairTargets, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [true]}, http: () => ({status: 403, json: {error: 'approver-required'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-flag-prod-confirm-cancel', family, source, initialHtml: html, initialUrl: url,
      args: [['checkout_v3', 'dark_charts']],
      mock: {dialogs: {confirm: [false]}, http: () => ({status: 200, json: {ok: true}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-14: Reading-List Bookmark Tag Chip Optimistic Mutation + 409 Rollback
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:bookmark-tag-optimistic';
    const html = `<!DOCTYPE html><html><head><title>Bookmarks</title></head><body>
<div id="bm" data-version="4">
  <div id="chips"><span class="chip" data-tag="js">js<button class="x">x</button></span><span class="chip" data-tag="dom">dom<button class="x">x</button></span></div>
  <input id="new-tag" value="" />
  <button id="add-tag">Add</button>
  <p id="bm-msg"></p>
</div></body></html>`;
    const url = 'https://read.w2.test/bookmarks/91';
    const source = `async function run(ops) {
  const root = document.getElementById('bm');
  const chipsEl = document.getElementById('chips');
  const input = document.getElementById('new-tag');
  const msg = document.getElementById('bm-msg');

  const currentTags = () => chipsEl.querySelectorAll('.chip').map(el => el.dataset.tag);
  function drawTags(tags) {
    chipsEl.innerHTML = '';
    for (const t of tags) {
      const s = document.createElement('span');
      s.className = 'chip';
      s.dataset.tag = t;
      s.innerHTML = t + '<button class="x">x</button>';
      chipsEl.appendChild(s);
    }
  }

  async function mutate(nextTags) {
    const prevTags = currentTags();
    const ver = Number(root.dataset.version);
    drawTags(nextTags);
    const res = await fetch('https://api.read.w2.test/bookmarks/91', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: ver, tags: nextTags }),
    });
    const data = await res.json();
    if (res.ok) {
      root.dataset.version = String(data.version);
      msg.textContent = 'v' + data.version;
    } else {
      drawTags(data.serverTags || prevTags);
      if (data.version) root.dataset.version = String(data.version);
      msg.textContent = 'conflict:' + res.status;
    }
  }

  let inflight = Promise.resolve();
  document.getElementById('add-tag').addEventListener('click', () => {
    const slug = input.value.trim().toLowerCase();
    const cur = currentTags();
    if (!slug || cur.includes(slug)) { msg.textContent = 'skip'; return; }
    input.value = '';
    inflight = mutate([...cur, slug]);
  });
  chipsEl.addEventListener('click', ev => {
    if (!ev.target.classList.contains('x')) return;
    const tag = ev.target.closest('.chip').dataset.tag;
    inflight = mutate(currentTags().filter(t => t !== tag));
  });

  for (const op of ops) {
    if (op.type === 'add') { input.value = op.tag; document.getElementById('add-tag').click(); }
    else if (op.type === 'remove') chipsEl.querySelector('.chip[data-tag="' + op.tag + '"] button.x')?.click();
    await inflight;
  }
  return { version: Number(root.dataset.version), tags: currentTags(), msg: msg.textContent };
}`;
    const pairOps = [[{type: 'add', tag: 'perf'}, {type: 'remove', tag: 'js'}]];
    const pairId = 'w2-pair:bookmark-tag-conflict';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-bookmark-tags-ok', family, source, args: pairOps, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [{status: 200, json: {version: 5}}, {status: 200, json: {version: 6}}]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-bookmark-tags-409', family, source, args: pairOps, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [
        {status: 409, json: {version: 7, serverTags: ['js', 'dom', 'a11y']}},
        {status: 200, json: {version: 8}},
      ]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-bookmark-duplicate-skip', family, source, initialHtml: html, initialUrl: url,
      args: [[{type: 'add', tag: 'DOM'}, {type: 'add', tag: 'testing'}]],
      mock: {http: () => ({status: 200, json: {version: 5}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-15: OAuth Secrets Vault 401 Token Refresh + Retry Flow (causal pair + 2)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:oauth-vault-retry';
    const html = `<!DOCTYPE html><html><head><title>Secrets Vault</title></head><body>
<main id="vault">
  <ul id="secret-list"></ul>
  <div id="auth-state">unknown</div>
</main></body></html>`;
    const url = 'https://vault.w2.test/projects/core';
    const source = `async function run(projectId) {
  const list = document.getElementById('secret-list');
  const authState = document.getElementById('auth-state');

  async function authedFetch(endpoint) {
    let token = sessionStorage.getItem('vault_access');
    let res = await fetch(endpoint, { headers: { authorization: 'Bearer ' + (token || '') } });
    if (res.status !== 401) return res;
    const refreshTok = sessionStorage.getItem('vault_refresh');
    if (!refreshTok) {
      authState.textContent = 'logged-out';
      history.replaceState(null, '', '/login');
      return res;
    }
    const rRes = await fetch('https://auth.vault.w2.test/token/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshTok }),
    });
    if (!rRes.ok) {
      sessionStorage.removeItem('vault_access');
      sessionStorage.removeItem('vault_refresh');
      authState.textContent = 'session-expired';
      history.replaceState({ from: location.pathname }, '', '/login?expired=1');
      return rRes;
    }
    const tokens = await rRes.json();
    sessionStorage.setItem('vault_access', tokens.accessToken);
    authState.textContent = 'refreshed';
    return fetch(endpoint, { headers: { authorization: 'Bearer ' + tokens.accessToken } });
  }

  const res = await authedFetch('https://api.vault.w2.test/projects/' + projectId + '/secrets');
  if (!res.ok) {
    return { ok: false, status: res.status, authState: authState.textContent, path: location.pathname + location.search, keys: [] };
  }
  const data = await res.json();
  if (authState.textContent === 'unknown') authState.textContent = 'valid';
  list.innerHTML = data.keys.map(k => '<li data-key="' + k + '">' + k + '</li>').join('');
  return {
    ok: true,
    authState: authState.textContent,
    path: location.pathname,
    keys: list.querySelectorAll('li').map(li => li.dataset.key),
  };
}`;
    const pairId = 'w2-pair:oauth-vault-401-refresh';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-vault-refresh-retry-ok', family, source, args: ['core'], initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {session: {vault_access: 'old-tok', vault_refresh: 'ref-88'}},
        http: [
          {status: 401, json: {error: 'expired'}},
          {status: 200, json: {accessToken: 'new-tok-99'}},
          {status: 200, json: {keys: ['DB_URL', 'STRIPE_KEY']}},
        ],
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-vault-refresh-revoked-401', family, source, args: ['core'], initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {session: {vault_access: 'old-tok', vault_refresh: 'ref-88'}},
        http: [
          {status: 401, json: {error: 'expired'}},
          {status: 401, json: {error: 'refresh_revoked'}},
        ],
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-vault-direct-valid', family, source, args: ['edge'], initialHtml: html, initialUrl: url,
      mock: {
        storage: {session: {vault_access: 'fresh-tok'}},
        http: () => ({status: 200, json: {keys: ['EDGE_SIGNING']}}),
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-vault-no-refresh-token', family, source, args: ['core'], initialHtml: html, initialUrl: url,
      mock: {
        storage: {session: {vault_access: 'stale'}},
        http: () => ({status: 401, json: {error: 'expired'}}),
      },
    }));
  }

  // --------------------------------------------------------------------------
  // SF-16: Billing Portal Re-Auth + Two-Endpoint Hydrator (causal pair + 1)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:billing-portal-reauth';
    const html = `<!DOCTYPE html><html><head><title>Billing</title></head><body>
<section id="billing">
  <div id="plan-name">loading</div>
  <div id="balance">0</div>
  <div id="reauth-note"></div>
</section></body></html>`;
    const url = 'https://billing.w2.test/overview';
    const source = `async function run(accountId) {
  const planEl = document.getElementById('plan-name');
  const balEl = document.getElementById('balance');
  const noteEl = document.getElementById('reauth-note');
  let token = localStorage.getItem('bill_jwt') || '';
  let refreshed = false;

  async function callApi(path) {
    let res = await fetch('https://api.billing.w2.test' + path, { headers: { authorization: 'Bearer ' + token } });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      const rr = await fetch('https://api.billing.w2.test/reauth', { method: 'POST', body: JSON.stringify({ accountId }) });
      if (!rr.ok) {
        console.warn('billing-reauth-failed', rr.status);
        localStorage.removeItem('bill_jwt');
        noteEl.textContent = 'reauth-required';
        return null;
      }
      const next = await rr.json();
      token = next.jwt;
      localStorage.setItem('bill_jwt', token);
      noteEl.textContent = 'jwt-rotated';
      res = await fetch('https://api.billing.w2.test' + path, { headers: { authorization: 'Bearer ' + token } });
    }
    return res.ok ? await res.json() : null;
  }

  const plan = await callApi('/accounts/' + accountId + '/plan');
  if (!plan) return { hydrated: false, note: noteEl.textContent };
  const bal = await callApi('/accounts/' + accountId + '/balance');
  planEl.textContent = plan.tier;
  balEl.textContent = bal ? ('$' + bal.due) : 'err';
  return { hydrated: true, plan: planEl.textContent, balance: balEl.textContent, note: noteEl.textContent };
}`;
    const pairId = 'w2-pair:billing-reauth-flow';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-billing-reauth-ok', family, source, args: ['acct_42'], initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {local: {bill_jwt: 'jwt-old'}},
        http: [
          {status: 401, json: {error: 'expired'}},
          {status: 200, json: {jwt: 'jwt-v2'}},
          {status: 200, json: {tier: 'Enterprise'}},
          {status: 200, json: {due: 1450}},
        ],
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-billing-reauth-403', family, source, args: ['acct_42'], initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {local: {bill_jwt: 'jwt-old'}},
        http: [
          {status: 401, json: {error: 'expired'}},
          {status: 403, json: {error: 'account_suspended'}},
        ],
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-billing-fresh-jwt', family, source, args: ['acct_99'], initialHtml: html, initialUrl: url,
      mock: {
        storage: {local: {bill_jwt: 'jwt-live'}},
        http: [
          {status: 200, json: {tier: 'Starter'}},
          {status: 200, json: {due: 49}},
        ],
      },
    }));
  }

  // --------------------------------------------------------------------------
  // SF-17: RFP Proposal Composer (localStorage draft vs server version conflict)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:rfp-proposal-autosave';
    const html = `<!DOCTYPE html><html><head><title>RFP Composer</title></head><body>
<div id="composer">
  <button class="tab" data-tab="summary">Summary</button>
  <button class="tab" data-tab="budget">Budget</button>
  <textarea id="editor"></textarea>
  <span id="dirty-flag">clean</span>
  <span id="sync-note"></span>
</div></body></html>`;
    const url = 'https://rfp.w2.test/proposals/p7';
    const source = `async function run(edits) {
  const editor = document.getElementById('editor');
  const dirtyEl = document.getElementById('dirty-flag');
  const noteEl = document.getElementById('sync-note');
  let activeTab = sessionStorage.getItem('rfp_tab') || 'summary';
  const rawDraft = localStorage.getItem('rfp_draft_p7');
  let draft = rawDraft ? JSON.parse(rawDraft) : { rev: 1, summary: '', budget: '' };

  const remoteRes = await fetch('https://api.rfp.w2.test/proposals/p7');
  const remote = await remoteRes.json();
  if (remote.rev > draft.rev) {
    draft = { rev: remote.rev, summary: remote.summary, budget: remote.budget };
    localStorage.setItem('rfp_draft_p7', JSON.stringify(draft));
    noteEl.textContent = 'adopted-server-r' + remote.rev;
  } else {
    noteEl.textContent = 'kept-local-r' + draft.rev;
  }

  function loadTab(tab) {
    activeTab = tab;
    sessionStorage.setItem('rfp_tab', tab);
    editor.value = draft[tab] || '';
  }

  for (const btn of document.querySelectorAll('button.tab')) {
    btn.addEventListener('click', () => loadTab(btn.dataset.tab));
  }
  editor.addEventListener('input', () => {
    draft[activeTab] = editor.value;
    draft.rev++;
    dirtyEl.textContent = 'dirty:r' + draft.rev;
    localStorage.setItem('rfp_draft_p7', JSON.stringify(draft));
  });

  loadTab(activeTab);
  for (const e of edits) {
    if (e.op === 'tab') document.querySelector('button.tab[data-tab="' + e.tab + '"]').click();
    else if (e.op === 'type') { editor.value = e.text; editor.dispatchEvent(new InputEvent('input', { bubbles: true })); }
  }
  return { activeTab, rev: draft.rev, dirty: dirtyEl.textContent, note: noteEl.textContent, summary: draft.summary, budget: draft.budget };
}`;
    const pairEdits = [[{op: 'tab', tab: 'budget'}, {op: 'type', text: '$48,000 fixed'}]];
    const pairId = 'w2-pair:rfp-draft-hydration';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-rfp-local-newer', family, source, args: pairEdits, initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {local: {rfp_draft_p7: JSON.stringify({rev: 5, summary: 'Local exec summary', budget: '$40k'})}, session: {rfp_tab: 'summary'}},
        http: () => ({status: 200, json: {rev: 3, summary: 'Older server summary', budget: '$35k'}}),
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-rfp-server-newer', family, source, args: pairEdits, initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {local: {rfp_draft_p7: JSON.stringify({rev: 5, summary: 'Local exec summary', budget: '$40k'})}, session: {rfp_tab: 'summary'}},
        http: () => ({status: 200, json: {rev: 8, summary: 'Fresh server summary', budget: '$52k'}}),
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-rfp-empty-storage', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'type', text: 'Phase 1 scope'}]],
      mock: {storage: {local: {}, session: {}}, http: () => ({status: 200, json: {rev: 2, summary: 'Seeded', budget: '$10k'}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-18: Multi-Tab SQL Scratchpad (localStorage tabs + sessionStorage filter)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:sql-scratchpad-tabs';
    const html = `<!DOCTYPE html><html><head><title>SQL Studio</title></head><body>
<div id="sql-app">
  <div id="tab-bar"></div>
  <textarea id="sql-in"></textarea>
  <button id="run-sql">Run</button>
  <table id="result-grid"><tbody></tbody></table>
  <span id="row-meta">0 rows</span>
</div></body></html>`;
    const url = 'https://data.w2.test/sql';
    const source = `async function run(actions) {
  const bar = document.getElementById('tab-bar');
  const sqlIn = document.getElementById('sql-in');
  const tbody = document.querySelector('#result-grid tbody');
  const meta = document.getElementById('row-meta');
  const storedTabs = localStorage.getItem('sql_tabs');
  const tabs = storedTabs ? JSON.parse(storedTabs) : [{ id: 't1', sql: 'SELECT 1' }];
  let activeId = sessionStorage.getItem('sql_active') || tabs[0].id;

  function renderTabs() {
    bar.innerHTML = '';
    for (const t of tabs) {
      const b = document.createElement('button');
      b.dataset.tab = t.id;
      b.className = t.id === activeId ? 'tab active' : 'tab';
      b.textContent = t.id;
      bar.appendChild(b);
    }
    const cur = tabs.find(t => t.id === activeId) || tabs[0];
    activeId = cur.id;
    sqlIn.value = cur.sql;
  }

  bar.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-tab]');
    if (!b) return;
    activeId = b.dataset.tab;
    sessionStorage.setItem('sql_active', activeId);
    renderTabs();
  });

  sqlIn.addEventListener('input', () => {
    const cur = tabs.find(t => t.id === activeId);
    if (cur) { cur.sql = sqlIn.value; localStorage.setItem('sql_tabs', JSON.stringify(tabs)); }
  });

  let pending = Promise.resolve();
  document.getElementById('run-sql').addEventListener('click', () => {
    const query = sqlIn.value.trim();
    pending = (async () => {
      const res = await fetch('https://api.data.w2.test/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tabId: activeId, sql: query }),
      });
      const data = await res.json();
      if (!res.ok) {
        tbody.innerHTML = '';
        meta.textContent = 'err:' + data.code;
        return;
      }
      tbody.innerHTML = data.rows.map(r => '<tr><td>' + r.join('</td><td>') + '</td></tr>').join('');
      meta.textContent = data.rows.length + ' rows';
    })();
  });

  renderTabs();
  for (const a of actions) {
    if (a.op === 'addTab') {
      tabs.push({ id: a.id, sql: a.sql });
      activeId = a.id;
      localStorage.setItem('sql_tabs', JSON.stringify(tabs));
      sessionStorage.setItem('sql_active', activeId);
      renderTabs();
    } else if (a.op === 'select') bar.querySelector('button[data-tab="' + a.id + '"]')?.click();
    else if (a.op === 'edit') { sqlIn.value = a.sql; sqlIn.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    else if (a.op === 'run') document.getElementById('run-sql').click();
    await pending;
  }
  return { activeId, meta: meta.textContent, tabCount: tabs.length, rowsHtml: tbody.innerHTML };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-sql-add-and-run', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'addTab', id: 't2', sql: 'SELECT id, total FROM orders LIMIT 2'}, {op: 'run'}]],
      mock: {storage: {local: {}, session: {}}, http: () => ({status: 200, json: {rows: [[101, 45], [102, 80]]}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-sql-syntax-error', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'edit', sql: 'SELEC * FROM users'}, {op: 'run'}]],
      mock: {storage: {local: {}, session: {}}, http: () => ({status: 400, json: {code: 'SYNTAX_ERR'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-sql-switch-hydrated', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'select', id: 'q-a'}, {op: 'run'}]],
      mock: {
        storage: {local: {sql_tabs: JSON.stringify([{id: 'q-a', sql: 'SELECT count(*) FROM events'}, {id: 'q-b', sql: 'SELECT 2'}])}, session: {sql_active: 'q-b'}},
        http: () => ({status: 200, json: {rows: [[912]]}}),
      },
    }));
  }

  return tasks;
}

async function buildSingleFileFamiliesPart2() {
  const tasks = [];

  // --------------------------------------------------------------------------
  // SF-19: Helpcenter SPA Router (pushState/replaceState/popstate + breadcrumbs)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:helpcenter-spa-router';
    const html = `<!DOCTYPE html><html><head><title>Help Center</title></head><body>
<nav id="crumbs"></nav>
<article id="kb-view"><p>Home</p></article>
</body></html>`;
    const url = 'https://help.w2.test/home';
    const source = `async function run(navOps) {
  const crumbs = document.getElementById('crumbs');
  const view = document.getElementById('kb-view');
  const log = [];

  async function renderCurrent() {
    const pathname = location.pathname;
    const usp = new URLSearchParams(location.search);
    const ver = usp.get('v') || '1';
    const segs = pathname.split('/').filter(Boolean);
    crumbs.innerHTML = segs.map((s, i) => '<span data-depth="' + i + '">' + s + '</span>').join(' / ');
    const res = await fetch('https://cms.help.w2.test' + pathname + '?v=' + ver);
    if (!res.ok) {
      document.title = 'Not Found';
      view.innerHTML = '<div class="err">404:' + pathname + '</div>';
      log.push({ pathname, ver, status: res.status });
      return;
    }
    const art = await res.json();
    document.title = art.heading + ' (v' + ver + ')';
    view.innerHTML = '<h1>' + art.heading + '</h1><p>' + art.summary + '</p>';
    log.push({ pathname, ver, status: 200, heading: art.heading });
  }

  let popDone = Promise.resolve();
  window.addEventListener('popstate', () => { popDone = renderCurrent(); });

  for (const op of navOps) {
    if (op.type === 'push') { history.pushState(op.state ?? null, '', op.url); await renderCurrent(); }
    else if (op.type === 'replace') { history.replaceState(op.state ?? null, '', op.url); await renderCurrent(); }
    else if (op.type === 'back') { history.back(); await popDone; }
    else if (op.type === 'forward') { history.forward(); await popDone; }
  }
  return {
    title: document.title,
    href: location.href,
    historyLength: history.length,
    crumbs: crumbs.textContent,
    viewHtml: view.innerHTML,
    log,
  };
}`;
    const pairNav = [[
      {type: 'push', url: '/articles/sso-setup?v=2', state: {k: 'sso'}},
      {type: 'push', url: '/articles/scim-sync?v=2', state: {k: 'scim'}},
      {type: 'back'},
    ]];
    const pairId = 'w2-pair:helpcenter-router-404';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-help-router-200', family, source, args: pairNav, initialHtml: html, initialUrl: url, pairId,
      mock: {http: ({url: u}) => u.includes('scim')
        ? {status: 200, json: {heading: 'SCIM Provisioning', summary: 'Auto sync groups'}}
        : {status: 200, json: {heading: 'SSO Setup', summary: 'Configure SAML'}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-help-router-404', family, source, args: pairNav, initialHtml: html, initialUrl: url, pairId,
      mock: {http: ({url: u}) => u.includes('scim')
        ? {status: 404, json: {error: 'missing'}}
        : {status: 200, json: {heading: 'SSO Setup', summary: 'Configure SAML'}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-help-router-replace-forward', family, source, initialHtml: html, initialUrl: url,
      args: [[
        {type: 'replace', url: '/articles/quickstart?v=3'},
        {type: 'push', url: '/articles/webhooks?v=3'},
        {type: 'back'},
        {type: 'forward'},
      ]],
      mock: {http: ({url: u}) => ({status: 200, json: {heading: u.includes('webhooks') ? 'Webhooks' : 'Quickstart', summary: 'Docs'}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-20: Storefront Facet Router (replaceState query facets + pushState PDP)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:storefront-facet-router';
    const html = `<!DOCTYPE html><html><head><title>Storefront</title></head><body>
<div id="shop">
  <select id="cat"><option value="all" selected>All</option><option value="audio">Audio</option><option value="lighting">Lighting</option></select>
  <select id="sort"><option value="popular" selected>Popular</option><option value="price_asc">Price</option></select>
  <div id="catalog"></div>
</div></body></html>`;
    const url = 'https://shop.w2.test/catalog';
    const source = `async function run(steps) {
  const catEl = document.getElementById('cat');
  const sortEl = document.getElementById('sort');
  const catalog = document.getElementById('catalog');

  async function syncCatalog() {
    const usp = new URLSearchParams(location.search);
    const cat = usp.get('cat') || 'all';
    const sort = usp.get('sort') || 'popular';
    catEl.value = cat;
    sortEl.value = sort;
    const res = await fetch('https://api.shop.w2.test/products?cat=' + cat + '&sort=' + sort);
    const data = await res.json();
    if (data.items.length === 0) {
      catalog.innerHTML = '<p class="empty">Sold out</p>';
      return;
    }
    catalog.innerHTML = data.items.map(p => '<div class="prod" data-sku="' + p.sku + '">' + p.name + ' ($' + p.price + ')</div>').join('');
  }

  function updateFacets() {
    const usp = new URLSearchParams();
    if (catEl.value !== 'all') usp.set('cat', catEl.value);
    if (sortEl.value !== 'popular') usp.set('sort', sortEl.value);
    const qs = usp.toString() ? '?' + usp.toString() : '';
    history.replaceState({ cat: catEl.value, sort: sortEl.value }, '', '/catalog' + qs);
  }

  let popPromise = Promise.resolve();
  window.addEventListener('popstate', () => { popPromise = syncCatalog(); });

  for (const s of steps) {
    if (s.op === 'facet') {
      catEl.value = s.cat;
      sortEl.value = s.sort;
      updateFacets();
      await syncCatalog();
    } else if (s.op === 'open') {
      history.pushState({ sku: s.sku }, '', '/product/' + s.sku);
      catalog.innerHTML = '<section class="pdp" data-sku="' + s.sku + '">Detail ' + s.sku + '</section>';
    } else if (s.op === 'back') {
      history.back();
      await popPromise;
    }
  }
  return {
    url: location.pathname + location.search,
    historyLen: history.length,
    catalogHtml: catalog.innerHTML,
  };
}`;
    const pairSteps = [[{op: 'facet', cat: 'audio', sort: 'price_asc'}, {op: 'open', sku: 'MIC-9'}, {op: 'back'}]];
    const pairId = 'w2-pair:storefront-facet-stock';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-shop-in-stock', family, source, args: pairSteps, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 200, json: {items: [{sku: 'MIC-9', name: 'Studio Mic', price: 129}]}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-shop-sold-out', family, source, args: pairSteps, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 200, json: {items: []}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-shop-lighting-browse', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'facet', cat: 'lighting', sort: 'popular'}]],
      mock: {http: () => ({status: 200, json: {items: [{sku: 'LED-2', name: 'Key Light', price: 79}, {sku: 'LED-4', name: 'Ring Bar', price: 45}]}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-21: Admin Console Hash + Role Guard Router (hashchange + sessionStorage)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:admin-hash-tab-router';
    const html = `<!DOCTYPE html><html><head><title>Admin</title></head><body>
<div id="admin">
  <section id="sec-overview" class="panel"></section>
  <section id="sec-audit" class="panel" hidden></section>
  <div id="guard-msg">ok</div>
</div></body></html>`;
    const url = 'https://admin.w2.test/console#overview';
    const source = `async function run(hashes) {
  const ov = document.getElementById('sec-overview');
  const au = document.getElementById('sec-audit');
  const guard = document.getElementById('guard-msg');
  const role = sessionStorage.getItem('admin_role') || 'viewer';
  let inflight = Promise.resolve();

  async function syncHash() {
    const h = (location.hash || '#overview').slice(1);
    if (h === 'audit' && role !== 'superadmin') {
      guard.textContent = 'denied:' + role;
      ov.hidden = false;
      au.hidden = true;
      return;
    }
    ov.hidden = h !== 'overview';
    au.hidden = h !== 'audit';
    guard.textContent = 'active:' + h;
    const res = await fetch('https://api.admin.w2.test/console/' + h);
    const data = await res.json();
    (h === 'audit' ? au : ov).textContent = data.summary;
  }

  window.addEventListener('hashchange', () => { inflight = syncHash(); });
  await syncHash();
  for (const h of hashes) {
    location.hash = h;
    await inflight;
  }
  return {
    hash: location.hash,
    guard: guard.textContent,
    overview: ov.hidden ? null : ov.textContent,
    audit: au.hidden ? null : au.textContent,
  };
}`;
    const pairHashes = [['#audit']];
    const pairId = 'w2-pair:admin-hash-role-guard';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-admin-hash-superadmin', family, source, args: pairHashes, initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {session: {admin_role: 'superadmin'}},
        http: ({url: u}) => ({status: 200, json: {summary: u.endsWith('/audit') ? '42 audit events' : '99.98% uptime'}}),
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-admin-hash-viewer-denied', family, source, args: pairHashes, initialHtml: html, initialUrl: url, pairId,
      mock: {
        storage: {session: {admin_role: 'viewer'}},
        http: () => ({status: 200, json: {summary: '99.98% uptime'}}),
      },
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-admin-hash-roundtrip', family, source, initialHtml: html, initialUrl: url,
      args: [['#audit', '#overview']],
      mock: {
        storage: {session: {admin_role: 'superadmin'}},
        http: ({url: u}) => ({status: 200, json: {summary: u.endsWith('/audit') ? 'Audit OK' : 'Overview OK'}}),
      },
    }));
  }

  // --------------------------------------------------------------------------
  // SF-22: Airport Code Debounced Autocomplete (setTimeout/clearTimeout + keys)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:airport-code-autocomplete';
    const html = `<!DOCTYPE html><html><head><title>Flight Search</title></head><body>
<div id="ac">
  <input id="airport-q" value="" />
  <ul id="suggestions" role="listbox"></ul>
  <div id="picked">none</div>
</div></body></html>`;
    const url = 'https://flights.w2.test/book';
    const source = `async function run(keystrokes, navKeys) {
  const input = document.getElementById('airport-q');
  const ul = document.getElementById('suggestions');
  const picked = document.getElementById('picked');
  let timer = null;
  let reqSeq = 0;
  let activeIdx = -1;
  let items = [];
  let pendingFetch = Promise.resolve();

  function renderList() {
    ul.innerHTML = '';
    for (let i = 0; i < items.length; i++) {
      const li = document.createElement('li');
      li.dataset.code = items[i].code;
      li.className = i === activeIdx ? 'opt active' : 'opt';
      li.textContent = items[i].code + ' - ' + items[i].city;
      ul.appendChild(li);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { items = []; activeIdx = -1; renderList(); return; }
    const mySeq = ++reqSeq;
    timer = setTimeout(() => {
      pendingFetch = (async () => {
        const res = await fetch('https://api.flights.w2.test/airports?q=' + encodeURIComponent(q));
        if (mySeq !== reqSeq) return;
        if (!res.ok) { items = []; activeIdx = -1; picked.textContent = 'search-err:' + res.status; renderList(); return; }
        const data = await res.json();
        items = data.results;
        activeIdx = items.length ? 0 : -1;
        renderList();
      })();
    }, 150);
  });

  input.addEventListener('keydown', ev => {
    if (!items.length) return;
    if (ev.key === 'ArrowDown') { activeIdx = (activeIdx + 1) % items.length; renderList(); }
    else if (ev.key === 'ArrowUp') { activeIdx = (activeIdx - 1 + items.length) % items.length; renderList(); }
    else if (ev.key === 'Enter' && activeIdx >= 0) {
      picked.textContent = items[activeIdx].code;
      input.value = items[activeIdx].code;
    }
  });

  for (const k of keystrokes) {
    input.value = k.text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: k.text }));
    if (k.waitMs > 0) await window.__flushTimersAsync(k.waitMs);
    await pendingFetch;
  }
  await window.__flushTimersAsync(300);
  await pendingFetch;

  for (const key of navKeys) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }
  return {
    picked: picked.textContent,
    activeIdx,
    options: ul.querySelectorAll('li').map(li => li.dataset.code + (li.classList.contains('active') ? '*' : '')),
  };
}`;
    const pairArgs = [
      [{text: 's', waitMs: 50}, {text: 'sa', waitMs: 60}, {text: 'san', waitMs: 200}],
      ['ArrowDown', 'Enter'],
    ];
    const pairId = 'w2-pair:airport-debounce-fetch';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-airport-ac-matches', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 200, json: {results: [{code: 'SAN', city: 'San Diego'}, {code: 'SFO', city: 'San Francisco'}, {code: 'SJC', city: 'San Jose'}]}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-airport-ac-503', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 503, json: {error: 'upstream-down'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-airport-ac-wrap-up', family, source, initialHtml: html, initialUrl: url,
      args: [[{text: 'lon', waitMs: 200}], ['ArrowUp', 'Enter']],
      mock: {http: () => ({status: 200, json: {results: [{code: 'LHR', city: 'London Heathrow'}, {code: 'LGW', city: 'London Gatwick'}]}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-23: Team Chat @Mention Debounced Picker (sessionStorage cache + debounce)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:mention-picker-debounce';
    const html = `<!DOCTYPE html><html><head><title>Chat</title></head><body>
<div id="chat">
  <textarea id="msg-box"></textarea>
  <ul id="mention-menu"></ul>
</div></body></html>`;
    const url = 'https://chat.w2.test/channels/eng';
    const source = `async function run(drafts, pickHandle) {
  const box = document.getElementById('msg-box');
  const menu = document.getElementById('mention-menu');
  let timer = null;
  let inflight = Promise.resolve();

  function renderUsers(users) {
    menu.innerHTML = users.map(u => '<li data-handle="' + u + '">@' + u + '</li>').join('');
  }

  box.addEventListener('input', () => {
    clearTimeout(timer);
    const m = /@([a-z0-9_]{2,})$/i.exec(box.value);
    if (!m) { menu.innerHTML = ''; return; }
    const prefix = m[1].toLowerCase();
    timer = setTimeout(() => {
      inflight = (async () => {
        const cached = sessionStorage.getItem('mention:' + prefix);
        if (cached) { renderUsers(JSON.parse(cached)); return; }
        const res = await fetch('https://api.chat.w2.test/directory?q=' + prefix);
        if (!res.ok) { renderUsers([]); return; }
        const data = await res.json();
        sessionStorage.setItem('mention:' + prefix, JSON.stringify(data.handles));
        renderUsers(data.handles);
      })();
    }, 120);
  });

  menu.addEventListener('click', ev => {
    const li = ev.target.closest('li[data-handle]');
    if (!li) return;
    box.value = box.value.replace(/@[a-z0-9_]+$/i, '@' + li.dataset.handle + ' ');
    menu.innerHTML = '';
  });

  for (const d of drafts) {
    box.value = d.text;
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    if (d.waitMs > 0) await window.__flushTimersAsync(d.waitMs);
    await inflight;
  }
  await window.__flushTimersAsync(200);
  await inflight;
  if (pickHandle) menu.querySelector('li[data-handle="' + pickHandle + '"]')?.click();
  return { text: box.value, openChoices: menu.querySelectorAll('li').map(li => li.dataset.handle) };
}`;
    const pairArgs = [[{text: 'ping @al', waitMs: 50}, {text: 'ping @ali', waitMs: 160}], 'alice_k'];
    const pairId = 'w2-pair:mention-picker-cache-vs-remote';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-mention-remote-ok', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {session: {}}, http: () => ({status: 200, json: {handles: ['alice_k', 'ali_r']}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-mention-remote-offline', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {session: {}}, http: () => ({status: 502, json: {error: 'gateway'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-mention-cache-hit', family, source, initialHtml: html, initialUrl: url,
      args: [[{text: 'cc @dev', waitMs: 150}], 'dev_ops'],
      mock: {storage: {session: {'mention:dev': JSON.stringify(['dev_ops', 'devon'])}}},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-24: API Key Rotation Dialog (prompt + confirm counterfactual pairs)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:api-key-rotation-dialog';
    const html = `<!DOCTYPE html><html><head><title>API Keys</title></head><body>
<div id="keys-ui">
  <ul id="key-rows"><li data-key-id="k_old" class="active">prod-main (active)</li></ul>
  <button id="rotate-btn">Rotate Key</button>
  <div id="key-status">idle</div>
</div></body></html>`;
    const url = 'https://security.w2.test/keys';
    const source = `async function run() {
  const ul = document.getElementById('key-rows');
  const status = document.getElementById('key-status');
  const btn = document.getElementById('rotate-btn');
  let done = Promise.resolve();

  btn.addEventListener('click', () => {
    const label = prompt('New key label:', 'prod-main-v2');
    if (!label || !label.trim()) {
      status.textContent = 'prompt-cancelled';
      return;
    }
    const revokeOld = confirm('Immediately revoke existing key k_old?');
    done = (async () => {
      const res = await fetch('https://api.security.w2.test/keys/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), revokeOld }),
      });
      const data = await res.json();
      if (!res.ok) { status.textContent = 'err:' + res.status; return; }
      if (revokeOld) {
        const oldLi = ul.querySelector('li[data-key-id="k_old"]');
        if (oldLi) { oldLi.className = 'revoked'; oldLi.textContent = 'prod-main (revoked)'; }
      }
      const li = document.createElement('li');
      li.dataset.keyId = data.keyId;
      li.className = 'active';
      li.textContent = label.trim() + ' (active)';
      ul.appendChild(li);
      status.textContent = revokeOld ? ('rotated-revoked:' + data.keyId) : ('rotated-dual:' + data.keyId);
    })();
  });

  btn.click();
  await done;
  return {
    status: status.textContent,
    keys: ul.querySelectorAll('li').map(li => li.dataset.keyId + ':' + li.className + ':' + li.textContent),
  };
}`;
    const pairId = 'w2-pair:api-key-rotation-confirm';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-key-rotate-revoke-yes', family, source, args: [], initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {prompt: ['prod-2026'], confirm: [true]}, http: () => ({status: 201, json: {keyId: 'k_new1'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-key-rotate-revoke-no', family, source, args: [], initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {prompt: ['prod-2026'], confirm: [false]}, http: () => ({status: 201, json: {keyId: 'k_new2'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-key-rotate-prompt-cancel', family, source, args: [], initialHtml: html, initialUrl: url,
      mock: {dialogs: {prompt: [null]}},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-25: Workspace Ownership Transfer Modal (prompt slug + confirm + alert)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:workspace-transfer-dialog';
    const html = `<!DOCTYPE html><html><head><title>Transfer Workspace</title></head><body>
<div id="ws" data-slug="acme-core" data-owner="alice">
  <button id="transfer-btn">Transfer Ownership</button>
  <p id="ws-banner">owner:alice</p>
</div></body></html>`;
    const url = 'https://org.w2.test/acme-core/danger';
    const source = `async function run(newOwner) {
  const ws = document.getElementById('ws');
  const banner = document.getElementById('ws-banner');
  const btn = document.getElementById('transfer-btn');
  let inflight = Promise.resolve();

  btn.addEventListener('click', () => {
    const typed = prompt('Type workspace slug to confirm transfer:', '');
    if (typed !== ws.dataset.slug) {
      alert('Slug mismatch: transfer aborted');
      banner.textContent = 'slug-mismatch';
      return;
    }
    if (!confirm('Transfer ' + ws.dataset.slug + ' to ' + newOwner + '?')) {
      banner.textContent = 'confirm-aborted';
      return;
    }
    inflight = (async () => {
      const res = await fetch('https://api.org.w2.test/workspaces/' + ws.dataset.slug + '/transfer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: newOwner }),
      });
      if (res.ok) {
        ws.dataset.owner = newOwner;
        banner.textContent = 'transferred:' + newOwner;
      } else {
        banner.textContent = 'failed:' + res.status;
      }
    })();
  });

  btn.click();
  await inflight;
  return { owner: ws.dataset.owner, banner: banner.textContent };
}`;
    const pairId = 'w2-pair:workspace-transfer-slug';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-transfer-slug-match', family, source, args: ['bob'], initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {prompt: ['acme-core'], confirm: [true]}, http: () => ({status: 200, json: {ok: true}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-transfer-slug-mismatch', family, source, args: ['bob'], initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {prompt: ['acme-wrong']}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-transfer-confirm-no', family, source, args: ['carol'], initialHtml: html, initialUrl: url,
      mock: {dialogs: {prompt: ['acme-core'], confirm: [false]}},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-26: Deployment Alert Toast Stack (priority cap + sticky vs auto-expire)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:deploy-alert-toast-stack';
    const html = `<!DOCTYPE html><html><head><title>Deploy Monitor</title></head><body>
<div id="toast-host"></div>
<span id="overflow-count">0</span>
</body></html>`;
    const url = 'https://deploy.w2.test/live';
    const source = `async function run(events, advanceMs) {
  const host = document.getElementById('toast-host');
  const overflowEl = document.getElementById('overflow-count');
  const MAX_VISIBLE = 3;
  const active = [];
  const queue = [];
  let seq = 0;

  function render() {
    host.innerHTML = '';
    for (const t of active) {
      const div = document.createElement('div');
      div.className = 'toast ' + t.level;
      div.dataset.tid = t.id;
      div.textContent = t.msg + '@' + t.ts;
      host.appendChild(div);
    }
    overflowEl.textContent = String(queue.length);
  }

  function dismiss(id) {
    const idx = active.findIndex(t => t.id === id);
    if (idx < 0) return;
    clearTimeout(active[idx].timer);
    active.splice(idx, 1);
    while (active.length < MAX_VISIBLE && queue.length > 0) {
      activate(queue.shift());
    }
    render();
  }

  function activate(t) {
    active.push(t);
    if (t.level !== 'critical') {
      t.timer = setTimeout(() => dismiss(t.id), t.ttlMs || 200);
    }
  }

  for (const ev of events) {
    if (ev.op === 'push') {
      const item = { id: 't' + (++seq), level: ev.level, msg: ev.msg, ttlMs: ev.ttlMs ?? 200, ts: Date.now(), timer: null };
      if (active.length < MAX_VISIBLE) activate(item);
      else queue.push(item);
      render();
    } else if (ev.op === 'dismiss') {
      dismiss(ev.id);
    } else if (ev.op === 'wait') {
      await window.__flushTimersAsync(ev.ms);
    }
  }
  if (advanceMs > 0) await window.__flushTimersAsync(advanceMs);
  return {
    visible: host.querySelectorAll('.toast').map(el => el.dataset.tid + ':' + el.className + ':' + el.textContent),
    queued: Number(overflowEl.textContent),
  };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-toast-promote-overflow', family, source, initialHtml: html, initialUrl: url,
      args: [[
        {op: 'push', level: 'critical', msg: 'DB failover'},
        {op: 'push', level: 'info', msg: 'Build 41', ttlMs: 100},
        {op: 'push', level: 'info', msg: 'Build 42', ttlMs: 250},
        {op: 'push', level: 'warn', msg: 'Slow query', ttlMs: 300},
      ], 150],
      mock: {now: [1000, 1010, 1020, 1030]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-toast-manual-dismiss-critical', family, source, initialHtml: html, initialUrl: url,
      args: [[
        {op: 'push', level: 'critical', msg: 'TLS expiring'},
        {op: 'push', level: 'info', msg: 'Canary OK', ttlMs: 120},
        {op: 'dismiss', id: 't1'},
      ], 200],
      mock: {now: [2000, 2005]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-toast-all-sticky', family, source, initialHtml: html, initialUrl: url,
      args: [[
        {op: 'push', level: 'critical', msg: 'Alert A'},
        {op: 'push', level: 'critical', msg: 'Alert B'},
      ], 500],
      mock: {now: [3000, 3050]},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-27: Inbox Undo Snackbar (delayed DELETE via setTimeout vs Undo cancel)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:inbox-undo-snackbar';
    const html = `<!DOCTYPE html><html><head><title>Mail</title></head><body>
<ul id="mail-list">
  <li data-mid="m1">Quarterly Review<button class="arch">Archive</button></li>
  <li data-mid="m2">Design Spec<button class="arch">Archive</button></li>
</ul>
<div id="snackbar" hidden><span id="sb-text"></span><button id="undo-btn">Undo</button></div>
</body></html>`;
    const url = 'https://mail.w2.test/inbox';
    const source = `async function run(mid, clickUndoAtMs) {
  const list = document.getElementById('mail-list');
  const snackbar = document.getElementById('snackbar');
  const sbText = document.getElementById('sb-text');
  const undoBtn = document.getElementById('undo-btn');

  let pendingRow = null;
  let pendingTimer = null;
  let commitPromise = Promise.resolve({ committed: false });

  list.addEventListener('click', ev => {
    const btn = ev.target.closest('button.arch');
    if (!btn) return;
    const li = btn.closest('li[data-mid]');
    const nextSibling = li.nextSibling;
    pendingRow = { li, nextSibling, id: li.dataset.mid };
    li.remove();
    snackbar.hidden = false;
    sbText.textContent = 'Archived ' + pendingRow.id;
    pendingTimer = setTimeout(() => {
      const target = pendingRow;
      pendingRow = null;
      commitPromise = (async () => {
        const res = await fetch('https://api.mail.w2.test/messages/' + target.id, { method: 'DELETE' });
        if (res.ok) {
          snackbar.hidden = true;
          sbText.textContent = 'committed:' + target.id;
          return { committed: true, id: target.id };
        }
        list.insertBefore(target.li, target.nextSibling);
        sbText.textContent = 'restore-err:' + res.status;
        return { committed: false, restored: true, status: res.status };
      })();
    }, 300);
  });

  undoBtn.addEventListener('click', () => {
    if (!pendingRow) return;
    clearTimeout(pendingTimer);
    list.insertBefore(pendingRow.li, pendingRow.nextSibling);
    sbText.textContent = 'undone:' + pendingRow.id;
    snackbar.hidden = true;
    pendingRow = null;
  });

  list.querySelector('li[data-mid="' + mid + '"] button.arch')?.click();
  if (clickUndoAtMs !== null) {
    await window.__flushTimersAsync(clickUndoAtMs);
    undoBtn.click();
  }
  await window.__flushTimersAsync(500);
  const outcome = await commitPromise;
  return {
    outcome,
    sbText: sbText.textContent,
    remaining: list.querySelectorAll('li').map(li => li.dataset.mid),
  };
}`;
    const pairId = 'w2-pair:inbox-snackbar-delete';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-snackbar-commit-200', family, source, args: ['m1', null], initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 200, json: {deleted: true}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-snackbar-commit-500-restore', family, source, args: ['m1', null], initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 500, json: {error: 'storage-busy'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-snackbar-undo-before-timer', family, source, args: ['m1', 120], initialHtml: html, initialUrl: url,
      mock: null,
    }));
  }

  // --------------------------------------------------------------------------
  // SF-28: Keyed Virtual-DOM Reconciler (DOM node reuse & patch tracking)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:keyed-vdom-reconciler';
    const html = `<!DOCTYPE html><html><head><title>VDOM</title></head><body><ul id="vroot"></ul></body></html>`;
    const url = 'https://vdom.w2.test/bench';
    const source = `function run(frames) {
  const root = document.getElementById('vroot');
  const nodePool = new Map();
  let createdCount = 0;
  let reusedCount = 0;
  let removedCount = 0;

  function patchList(vnodes) {
    const nextKeys = new Set(vnodes.map(v => v.key));
    for (const [k, el] of [...nodePool.entries()]) {
      if (!nextKeys.has(k)) {
        el.remove();
        nodePool.delete(k);
        removedCount++;
      }
    }
    let anchor = null;
    for (let i = vnodes.length - 1; i >= 0; i--) {
      const vn = vnodes[i];
      let el = nodePool.get(vn.key);
      if (!el) {
        el = document.createElement('li');
        el.dataset.key = vn.key;
        nodePool.set(vn.key, el);
        createdCount++;
      } else {
        reusedCount++;
      }
      if (el.className !== (vn.cls || '')) el.className = vn.cls || '';
      if (el.textContent !== vn.label) el.textContent = vn.label;
      if (el.parentNode !== root || el.nextSibling !== anchor) root.insertBefore(el, anchor);
      anchor = el;
    }
  }

  const refIdentity = {};
  for (let f = 0; f < frames.length; f++) {
    patchList(frames[f]);
    if (f === 0) {
      for (const [k, el] of nodePool.entries()) refIdentity[k] = el;
    }
  }

  const preservedKeys = [];
  for (const [k, origEl] of Object.entries(refIdentity)) {
    if (nodePool.get(k) === origEl) preservedKeys.push(k);
  }
  return {
    createdCount,
    reusedCount,
    removedCount,
    preservedKeys: preservedKeys.sort(),
    domOrder: root.querySelectorAll('li').map(li => li.dataset.key + ':' + li.className + ':' + li.textContent),
  };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-vdom-reorder-insert', family, source, initialHtml: html, initialUrl: url,
      args: [[
        [{key: 'a', cls: 'row', label: 'Alpha'}, {key: 'b', cls: 'row', label: 'Beta'}, {key: 'c', cls: 'row', label: 'Gamma'}],
        [{key: 'c', cls: 'row hot', label: 'Gamma!'}, {key: 'd', cls: 'row new', label: 'Delta'}, {key: 'a', cls: 'row', label: 'Alpha'}],
      ]],
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-vdom-three-frames', family, source, initialHtml: html, initialUrl: url,
      args: [[
        [{key: 'k1', cls: '', label: 'One'}, {key: 'k2', cls: '', label: 'Two'}],
        [{key: 'k2', cls: 'sel', label: 'Two-v2'}, {key: 'k3', cls: 'new', label: 'Three'}, {key: 'k1', cls: '', label: 'One'}],
        [{key: 'k3', cls: 'done', label: 'Three-done'}],
      ]],
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-vdom-clear-and-rebuild', family, source, initialHtml: html, initialUrl: url,
      args: [[
        [{key: 'x', cls: 'a', label: 'X'}],
        [],
        [{key: 'x', cls: 'b', label: 'X2'}, {key: 'y', cls: 'b', label: 'Y'}],
      ]],
    }));
  }

  // --------------------------------------------------------------------------
  // SF-29: Fine-Grained Reactive Signals Counter Board (microtask batching)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:reactive-signals-counter-board';
    const html = `<!DOCTYPE html><html><head><title>Signals Board</title></head><body>
<div id="sig-app">
  <span id="subtotal">0</span>
  <span id="tax">0</span>
  <span id="grand">0</span>
  <span id="render-count">0</span>
</div></body></html>`;
    const url = 'https://signals.w2.test/cart';
    const source = `async function run(mutations) {
  let activeEffect = null;
  const dirtyEffects = new Set();
  let flushScheduled = false;

  function scheduleEffect(eff) {
    dirtyEffects.add(eff);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(() => {
        flushScheduled = false;
        const batch = [...dirtyEffects];
        dirtyEffects.clear();
        for (const fn of batch) fn();
      });
    }
  }

  function createSignal(init) {
    let val = init;
    const subs = new Set();
    return [
      () => { if (activeEffect) subs.add(activeEffect); return val; },
      next => {
        const resolved = typeof next === 'function' ? next(val) : next;
        if (Object.is(val, resolved)) return;
        val = resolved;
        for (const eff of subs) scheduleEffect(eff);
      },
    ];
  }

  const [price, setPrice] = createSignal(20);
  const [qty, setQty] = createSignal(1);
  const [taxRate, setTaxRate] = createSignal(0.1);
  let renders = 0;

  function renderDom() {
    activeEffect = renderDom;
    const sub = price() * qty();
    const tx = Math.round(sub * taxRate() * 100) / 100;
    const tot = Math.round((sub + tx) * 100) / 100;
    activeEffect = null;
    renders++;
    document.getElementById('subtotal').textContent = String(sub);
    document.getElementById('tax').textContent = String(tx);
    document.getElementById('grand').textContent = String(tot);
    document.getElementById('render-count').textContent = String(renders);
  }
  renderDom();

  for (const batch of mutations) {
    for (const m of batch) {
      if (m.k === 'price') setPrice(m.v);
      else if (m.k === 'qty') setQty(m.v);
      else if (m.k === 'taxRate') setTaxRate(m.v);
    }
    await Promise.resolve();
  }
  return {
    subtotal: Number(document.getElementById('subtotal').textContent),
    tax: Number(document.getElementById('tax').textContent),
    grand: Number(document.getElementById('grand').textContent),
    renders: Number(document.getElementById('render-count').textContent),
  };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-signals-batched-updates', family, source, initialHtml: html, initialUrl: url,
      args: [[
        [{k: 'price', v: 35}, {k: 'qty', v: 3}],
        [{k: 'taxRate', v: 0.08}],
      ]],
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-signals-noop-dedupe', family, source, initialHtml: html, initialUrl: url,
      args: [[
        [{k: 'price', v: 20}, {k: 'qty', v: 1}],
        [{k: 'qty', v: 4}, {k: 'taxRate', v: 0.2}],
      ]],
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-signals-three-batches', family, source, initialHtml: html, initialUrl: url,
      args: [[
        [{k: 'qty', v: 2}],
        [{k: 'price', v: 15}],
        [{k: 'qty', v: 5}, {k: 'taxRate', v: 0.05}],
      ]],
    }));
  }

  // --------------------------------------------------------------------------
  // SF-30: Accessible ARIA Accordion & Keyboard Navigation + localStorage
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:faq-accordion-aria-nav';
    const html = `<!DOCTYPE html><html><head><title>FAQ</title></head><body>
<div id="faq" data-mode="single">
  <button class="acc-hdr" id="h0" aria-expanded="true" aria-controls="p0">Pricing</button>
  <div id="p0" class="acc-panel">Free and Pro</div>
  <button class="acc-hdr" id="h1" aria-expanded="false" aria-controls="p1">Security</button>
  <div id="p1" class="acc-panel" hidden>SOC2 Type II</div>
  <button class="acc-hdr" id="h2" aria-expanded="false" aria-controls="p2">SLA</button>
  <div id="p2" class="acc-panel" hidden>99.95%</div>
</div></body></html>`;
    const url = 'https://faq.w2.test/help';
    const source = `function run(mode, keys) {
  const faq = document.getElementById('faq');
  faq.dataset.mode = mode;
  const headers = faq.querySelectorAll('button.acc-hdr');

  function setOpen(idx, open) {
    if (open && faq.dataset.mode === 'single') {
      headers.forEach((h, i) => {
        if (i !== idx) {
          h.setAttribute('aria-expanded', 'false');
          document.getElementById(h.getAttribute('aria-controls')).hidden = true;
        }
      });
    }
    headers[idx].setAttribute('aria-expanded', String(open));
    document.getElementById(headers[idx].getAttribute('aria-controls')).hidden = !open;
    const openIds = headers.filter(h => h.getAttribute('aria-expanded') === 'true').map(h => h.id);
    localStorage.setItem('faq_open', JSON.stringify(openIds));
  }

  headers.forEach((h, idx) => {
    h.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') headers[(idx + 1) % headers.length].focus();
      else if (ev.key === 'ArrowUp') headers[(idx - 1 + headers.length) % headers.length].focus();
      else if (ev.key === 'Home') headers[0].focus();
      else if (ev.key === 'End') headers[headers.length - 1].focus();
      else if (ev.key === 'Enter' || ev.key === ' ') {
        const cur = h.getAttribute('aria-expanded') === 'true';
        setOpen(idx, !cur);
      }
    });
  });

  headers[0].focus();
  for (const key of keys) {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }
  return {
    focused: document.activeElement.id,
    expanded: headers.filter(h => h.getAttribute('aria-expanded') === 'true').map(h => h.id),
    visiblePanels: faq.querySelectorAll('.acc-panel').filter(p => !p.hidden).map(p => p.id),
  };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-faq-single-mode-keys', family, source, initialHtml: html, initialUrl: url,
      args: ['single', ['ArrowDown', 'Enter', 'End', ' ']],
      mock: {},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-faq-multi-mode-keys', family, source, initialHtml: html, initialUrl: url,
      args: ['multi', ['ArrowDown', 'Enter', 'ArrowDown', 'Enter', 'Home', 'Enter']],
      mock: {},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-faq-wrap-arrow-up', family, source, initialHtml: html, initialUrl: url,
      args: ['single', ['ArrowUp', 'Enter']],
      mock: {},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-31: Global Ctrl+K Command Palette (keyboard + fetch + recent storage)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:command-palette-shortcuts';
    const html = `<!DOCTYPE html><html><head><title>Workspace</title></head><body>
<div id="palette" hidden>
  <input id="cmd-q" value="" />
  <ul id="cmd-list"></ul>
</div>
<div id="cmd-out">idle</div>
</body></html>`;
    const url = 'https://ide.w2.test/project';
    const source = `async function run(events) {
  const pal = document.getElementById('palette');
  const qEl = document.getElementById('cmd-q');
  const ul = document.getElementById('cmd-list');
  const out = document.getElementById('cmd-out');
  const COMMANDS = [
    { id: 'deploy-prod', label: 'Deploy to Production', remote: true },
    { id: 'clear-cache', label: 'Clear Build Cache', remote: true },
    { id: 'toggle-grid', label: 'Toggle Layout Grid', remote: false },
  ];
  let filtered = [...COMMANDS];
  let selIdx = 0;
  let inflight = Promise.resolve();

  function render() {
    const q = qEl.value.trim().toLowerCase();
    filtered = COMMANDS.filter(c => !q || c.label.toLowerCase().includes(q) || c.id.includes(q));
    if (selIdx >= filtered.length) selIdx = Math.max(0, filtered.length - 1);
    ul.innerHTML = filtered.map((c, i) => '<li data-cmd="' + c.id + '" class="' + (i === selIdx ? 'active' : '') + '">' + c.label + '</li>').join('');
  }

  window.addEventListener('keydown', ev => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 'k') {
      pal.hidden = !pal.hidden;
      if (!pal.hidden) { qEl.value = ''; selIdx = 0; render(); }
    } else if (ev.key === 'Escape') {
      pal.hidden = true;
    } else if (!pal.hidden && ev.key === 'ArrowDown') {
      if (filtered.length) selIdx = (selIdx + 1) % filtered.length;
      render();
    } else if (!pal.hidden && ev.key === 'Enter' && filtered[selIdx]) {
      const cmd = filtered[selIdx];
      pal.hidden = true;
      localStorage.setItem('last_cmd', cmd.id);
      if (!cmd.remote) {
        out.textContent = 'local:' + cmd.id;
      } else {
        inflight = (async () => {
          const res = await fetch('https://api.ide.w2.test/commands/' + cmd.id, { method: 'POST' });
          out.textContent = res.ok ? ('ran:' + cmd.id) : ('denied:' + cmd.id + ':' + res.status);
        })();
      }
    }
  });

  qEl.addEventListener('input', () => { selIdx = 0; render(); });

  for (const e of events) {
    if (e.op === 'key') window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, ctrlKey: Boolean(e.ctrl) }));
    else if (e.op === 'type') { qEl.value = e.text; qEl.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    await inflight;
  }
  return { hidden: pal.hidden, out: out.textContent, lastCmd: localStorage.getItem('last_cmd') };
}`;
    const pairEv = [[{op: 'key', key: 'k', ctrl: true}, {op: 'type', text: 'deploy'}, {op: 'key', key: 'Enter'}]];
    const pairId = 'w2-pair:command-palette-deploy';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-cmd-deploy-200', family, source, args: pairEv, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, http: () => ({status: 200, json: {job: 'j-7'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-cmd-deploy-403', family, source, args: pairEv, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, http: () => ({status: 403, json: {error: 'forbidden'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-cmd-local-arrow-enter', family, source, initialHtml: html, initialUrl: url,
      args: [[{op: 'key', key: 'k', ctrl: true}, {op: 'key', key: 'ArrowDown'}, {op: 'key', key: 'ArrowDown'}, {op: 'key', key: 'Enter'}]],
      mock: {storage: {local: {}}},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-32: Multi-Locale RTL + High-Contrast Theme Switcher (fetch sync + fallback)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:multilocale-rtl-switcher';
    const html = `<!DOCTYPE html><html lang="en" dir="ltr"><head><title>Settings</title></head><body class="theme-light">
<main id="prefs">
  <h1 data-i18n="title">Settings</h1>
  <button data-i18n="save" id="save-prefs">Save</button>
  <select id="locale-sel"><option value="en" selected>EN</option><option value="ar">AR</option><option value="ja">JA</option></select>
  <select id="theme-sel"><option value="light" selected>Light</option><option value="dark">Dark</option><option value="hc">High Contrast</option></select>
  <p id="sync-res"></p>
</main></body></html>`;
    const url = 'https://app.w2.test/preferences';
    const source = `async function run(nextLocale, nextTheme) {
  const DICT = {
    en: { dir: 'ltr', title: 'Settings', save: 'Save' },
    ar: { dir: 'rtl', title: 'Al-Idadat', save: 'Hifz' },
    ja: { dir: 'ltr', title: 'Settei', save: 'Hozon' },
  };
  const locSel = document.getElementById('locale-sel');
  const thSel = document.getElementById('theme-sel');
  const syncRes = document.getElementById('sync-res');

  function applyUi() {
    const entry = DICT[locSel.value] || DICT.en;
    document.documentElement.setAttribute('lang', locSel.value);
    document.documentElement.setAttribute('dir', entry.dir);
    document.body.className = 'theme-' + thSel.value;
    for (const node of document.querySelectorAll('[data-i18n]')) {
      const key = node.getAttribute('data-i18n');
      if (entry[key]) node.textContent = entry[key];
    }
  }

  let savePromise = Promise.resolve();
  document.getElementById('save-prefs').addEventListener('click', () => {
    applyUi();
    const payload = { locale: locSel.value, theme: thSel.value };
    localStorage.setItem('ui_prefs_w2', JSON.stringify(payload));
    savePromise = (async () => {
      const res = await fetch('https://api.app.w2.test/me/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      syncRes.textContent = res.ok ? 'synced-remote' : ('local-only:' + res.status);
    })();
  });

  locSel.value = nextLocale;
  thSel.value = nextTheme;
  document.getElementById('save-prefs').click();
  await savePromise;
  return {
    lang: document.documentElement.getAttribute('lang'),
    dir: document.documentElement.getAttribute('dir'),
    bodyClass: document.body.className,
    heading: document.querySelector('h1').textContent,
    sync: syncRes.textContent,
  };
}`;
    const pairId = 'w2-pair:multilocale-rtl-sync';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-i18n-ar-rtl-synced', family, source, args: ['ar', 'hc'], initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 200, json: {saved: true}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-i18n-ar-rtl-500-fallback', family, source, args: ['ar', 'hc'], initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 500, json: {error: 'db-down'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-i18n-ja-dark', family, source, args: ['ja', 'dark'], initialHtml: html, initialUrl: url,
      mock: {http: () => ({status: 200, json: {saved: true}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-33: Reading-Mode Density, Font & Reduced-Motion Accessibility Bar
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:density-font-accessibility-bar';
    const html = `<!DOCTYPE html><html><head><title>Reader</title></head><body data-density="comfortable" data-font="sans" data-motion="full">
<div id="a11y-bar">
  <button id="btn-density">Density</button>
  <button id="btn-font">Font</button>
  <button id="btn-motion">Motion</button>
</div></body></html>`;
    const url = 'https://reader.w2.test/article/12';
    const source = `function run(clicks) {
  const body = document.body;
  const saved = localStorage.getItem('reader_a11y');
  if (saved) {
    const p = JSON.parse(saved);
    if (p.density) body.dataset.density = p.density;
    if (p.font) body.dataset.font = p.font;
    if (p.motion) body.dataset.motion = p.motion;
  }
  const previewFont = sessionStorage.getItem('reader_preview_font');
  if (previewFont) body.dataset.font = previewFont;

  function persist() {
    localStorage.setItem('reader_a11y', JSON.stringify({
      density: body.dataset.density,
      font: body.dataset.font,
      motion: body.dataset.motion,
    }));
  }

  document.getElementById('btn-density').addEventListener('click', () => {
    body.dataset.density = body.dataset.density === 'compact' ? 'comfortable' : 'compact';
    persist();
  });
  document.getElementById('btn-font').addEventListener('click', () => {
    body.dataset.font = body.dataset.font === 'serif' ? 'sans' : 'serif';
    sessionStorage.removeItem('reader_preview_font');
    persist();
  });
  document.getElementById('btn-motion').addEventListener('click', () => {
    body.dataset.motion = body.dataset.motion === 'reduced' ? 'full' : 'reduced';
    persist();
  });

  for (const id of clicks) document.getElementById(id)?.click();
  return { density: body.dataset.density, font: body.dataset.font, motion: body.dataset.motion };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-a11y-toggle-all', family, source, initialHtml: html, initialUrl: url,
      args: [['btn-density', 'btn-font', 'btn-motion']],
      mock: {storage: {local: {}, session: {}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-a11y-session-preview-override', family, source, initialHtml: html, initialUrl: url,
      args: [['btn-motion']],
      mock: {storage: {local: {reader_a11y: JSON.stringify({density: 'compact', font: 'sans', motion: 'full'})}, session: {reader_preview_font: 'serif'}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-a11y-double-toggle-font', family, source, initialHtml: html, initialUrl: url,
      args: [['btn-font', 'btn-font']],
      mock: {storage: {local: {}, session: {reader_preview_font: 'serif'}}},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-34: Code Snippet Copy / Data-URI Download / Short-Link Share Widget
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:snippet-copy-share-widget';
    const html = `<!DOCTYPE html><html><head><title>Snippet</title></head><body>
<section id="snip-card" data-snip-id="sn_88">
  <pre id="code-body">const sum = (a, b) => a + b;</pre>
  <button id="copy-btn">Copy</button>
  <button id="dl-btn">Download</button>
  <button id="share-btn">Share</button>
  <a id="dl-link" href=""></a>
  <span id="share-out"></span>
</section></body></html>`;
    const url = 'https://paste.w2.test/sn_88';
    const source = `async function run(actions, waitAfterCopyMs) {
  const card = document.getElementById('snip-card');
  const codeBody = document.getElementById('code-body');
  const copyBtn = document.getElementById('copy-btn');
  const dlLink = document.getElementById('dl-link');
  const shareOut = document.getElementById('share-out');
  let clipboardText = '';
  let sharePromise = Promise.resolve();

  copyBtn.addEventListener('click', () => {
    clipboardText = codeBody.textContent;
    copyBtn.textContent = 'Copied!';
    copyBtn.dataset.copied = 'true';
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.dataset.copied = 'false';
    }, 200);
  });

  document.getElementById('dl-btn').addEventListener('click', () => {
    dlLink.setAttribute('download', card.dataset.snipId + '.js');
    dlLink.setAttribute('href', 'data:text/javascript;base64,' + btoa(codeBody.textContent));
  });

  document.getElementById('share-btn').addEventListener('click', () => {
    sharePromise = (async () => {
      const res = await fetch('https://api.paste.w2.test/shorten', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snippetId: card.dataset.snipId }),
      });
      const data = await res.json();
      shareOut.textContent = res.ok ? data.shortUrl : ('rate-limit:' + res.status);
    })();
  });

  for (const id of actions) {
    document.getElementById(id)?.click();
    await sharePromise;
  }
  if (waitAfterCopyMs > 0) await window.__flushTimersAsync(waitAfterCopyMs);
  return {
    clipboardText,
    copyLabel: copyBtn.textContent,
    copiedFlag: copyBtn.dataset.copied || 'false',
    downloadFile: dlLink.getAttribute('download'),
    downloadHref: dlLink.getAttribute('href'),
    shareOut: shareOut.textContent,
  };
}`;
    const pairArgs = [['copy-btn', 'dl-btn', 'share-btn'], 250];
    const pairId = 'w2-pair:snippet-share-rate-limit';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-snippet-share-201', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 201, json: {shortUrl: 'https://p.w2.test/x9K'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-snippet-share-429', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: () => ({status: 429, json: {error: 'quota'}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-snippet-copy-still-active', family, source, initialHtml: html, initialUrl: url,
      args: [['copy-btn', 'dl-btn'], 50],
      mock: null,
    }));
  }

  // --------------------------------------------------------------------------
  // SF-35: Analytics Report Exporter (CSV/JSON/MD + prompt filename + history)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:report-export-downloader';
    const html = `<!DOCTYPE html><html><head><title>Export</title></head><body>
<div id="exp">
  <select id="fmt"><option value="csv" selected>CSV</option><option value="json">JSON</option><option value="md">Markdown</option></select>
  <button id="export-btn">Export</button>
  <a id="anchor"></a>
  <p id="exp-status">ready</p>
</div></body></html>`;
    const url = 'https://analytics.w2.test/reports/q4';
    const source = `function run(rows, format) {
  const fmtEl = document.getElementById('fmt');
  const anchor = document.getElementById('anchor');
  const status = document.getElementById('exp-status');
  fmtEl.value = format;

  document.getElementById('export-btn').addEventListener('click', () => {
    const name = prompt('Export filename (without extension):', 'q4-report');
    if (!name || !name.trim()) {
      status.textContent = 'export-cancelled';
      return;
    }
    const clean = name.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    const f = fmtEl.value;
    let payload = '';
    if (f === 'csv') {
      payload = 'region,rev\\n' + rows.map(r => r.region + ',' + r.rev).join('\\n');
    } else if (f === 'md') {
      payload = '| region | rev |\\n|---|---|\\n' + rows.map(r => '| ' + r.region + ' | ' + r.rev + ' |').join('\\n');
    } else {
      payload = JSON.stringify(rows);
    }
    const filename = clean + '.' + f;
    anchor.setAttribute('download', filename);
    anchor.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(payload));
    const prev = JSON.parse(localStorage.getItem('export_log') || '[]');
    prev.push({ filename, rows: rows.length });
    localStorage.setItem('export_log', JSON.stringify(prev));
    status.textContent = 'ready:' + filename;
  });

  document.getElementById('export-btn').click();
  return {
    status: status.textContent,
    download: anchor.getAttribute('download'),
    hrefLen: (anchor.getAttribute('href') || '').length,
    decoded: anchor.getAttribute('href') ? decodeURIComponent(anchor.getAttribute('href').split(',')[1]) : null,
  };
}`;
    const sampleRows = [{region: 'NA', rev: 420}, {region: 'EU', rev: 315}];
    const pairArgs = [sampleRows, 'csv'];
    const pairId = 'w2-pair:report-export-prompt';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-export-csv-named', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, dialogs: {prompt: ['board deck 2026']}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-export-csv-cancelled', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {storage: {local: {}}, dialogs: {prompt: [null]}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-export-markdown', family, source, args: [sampleRows, 'md'], initialHtml: html, initialUrl: url,
      mock: {storage: {local: {export_log: JSON.stringify([{filename: 'prev.json', rows: 1}])}}, dialogs: {prompt: ['summary']}},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-36: CI Build Log WebSocket-Style Polling Loop (chained setTimeout + cursor)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:build-log-poller';
    const html = `<!DOCTYPE html><html><head><title>CI Run #509</title></head><body>
<section id="ci">
  <span id="ci-status">running</span>
  <ol id="log-lines"></ol>
</section></body></html>`;
    const url = 'https://ci.w2.test/runs/509';
    const source = `async function run(runId, maxPolls) {
  const statusEl = document.getElementById('ci-status');
  const ol = document.getElementById('log-lines');
  let cursor = 0;
  let polls = 0;

  while (polls < maxPolls) {
    polls++;
    const res = await fetch('https://api.ci.w2.test/runs/' + runId + '/events?cursor=' + cursor);
    const data = await res.json();
    for (const line of data.lines) {
      const li = document.createElement('li');
      li.textContent = line;
      ol.appendChild(li);
    }
    cursor = data.nextCursor;
    statusEl.textContent = data.status;
    if (data.status === 'passed' || data.status === 'failed') {
      if (data.status === 'failed') alert('Build ' + runId + ' failed!');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100 * polls));
  }
  return {
    polls,
    cursor,
    status: statusEl.textContent,
    virtualTime: window.__virtualNow(),
    lines: ol.querySelectorAll('li').map(li => li.textContent),
  };
}`;
    const pairArgs = ['509', 5];
    const pairId = 'w2-pair:build-log-poller-terminal';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-poller-build-passed', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [
        {status: 200, json: {status: 'running', nextCursor: 2, lines: ['clone', 'install']}},
        {status: 200, json: {status: 'passed', nextCursor: 3, lines: ['tests ok']}},
      ]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-poller-build-failed', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [
        {status: 200, json: {status: 'running', nextCursor: 2, lines: ['clone', 'install']}},
        {status: 200, json: {status: 'failed', nextCursor: 3, lines: ['ERR: 2 tests failed']}},
      ]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-poller-max-polls-cap', family, source, args: ['510', 2], initialHtml: html, initialUrl: url,
      mock: {http: [
        {status: 200, json: {status: 'running', nextCursor: 1, lines: ['step1']}},
        {status: 200, json: {status: 'running', nextCursor: 2, lines: ['step2']}},
      ]},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-37: Live Auction Ticker Poller + Auto-Counterbid (causal pair: 200 vs 409)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:auction-bid-poller';
    const html = `<!DOCTYPE html><html><head><title>Auction Lot #18</title></head><body>
<div id="lot">
  <span id="high-bid">$100</span>
  <span id="leader">alice</span>
  <span id="bid-status">watching</span>
</div></body></html>`;
    const url = 'https://auction.w2.test/lots/18';
    const source = `async function run(me, maxCeiling) {
  const bidEl = document.getElementById('high-bid');
  const leaderEl = document.getElementById('leader');
  const statusEl = document.getElementById('bid-status');

  for (let round = 0; round < 3; round++) {
    const res = await fetch('https://api.auction.w2.test/lots/18/state?r=' + round);
    const st = await res.json();
    bidEl.textContent = '$' + st.amount;
    leaderEl.textContent = st.leader;
    if (st.closed) {
      statusEl.textContent = st.leader === me ? 'won' : 'lost';
      break;
    }
    if (st.leader !== me && st.amount + 10 <= maxCeiling) {
      const nextAmt = st.amount + 10;
      const bRes = await fetch('https://api.auction.w2.test/lots/18/bid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bidder: me, amount: nextAmt }),
      });
      if (bRes.ok) {
        bidEl.textContent = '$' + nextAmt;
        leaderEl.textContent = me;
        statusEl.textContent = 'leading:' + nextAmt;
      } else {
        statusEl.textContent = 'outbid:' + bRes.status;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return {
    highBid: bidEl.textContent,
    leader: leaderEl.textContent,
    status: statusEl.textContent,
    elapsedMs: window.__virtualNow(),
  };
}`;
    const pairArgs = ['me_42', 150];
    const pairId = 'w2-pair:auction-counterbid-race';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-auction-bid-won', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [
        {status: 200, json: {amount: 120, leader: 'rival', closed: false}},
        {status: 200, json: {accepted: true}},
        {status: 200, json: {amount: 130, leader: 'me_42', closed: true}},
      ]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-auction-bid-409-lost', family, source, args: pairArgs, initialHtml: html, initialUrl: url, pairId,
      mock: {http: [
        {status: 200, json: {amount: 120, leader: 'rival', closed: false}},
        {status: 409, json: {error: 'stale-bid'}},
        {status: 200, json: {amount: 165, leader: 'whale', closed: true}},
      ]},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-auction-over-ceiling-watch', family, source, args: ['me_42', 125], initialHtml: html, initialUrl: url,
      mock: {http: [
        {status: 200, json: {amount: 120, leader: 'rival', closed: false}},
        {status: 200, json: {amount: 120, leader: 'rival', closed: true}},
      ]},
    }));
  }

  return tasks;
}

async function buildSingleFileFamiliesPart2Extra() {
  const tasks = [];

  // --------------------------------------------------------------------------
  // SF-38: Cookie & Privacy Consent Banner (granular toggles + confirm + fetch)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:cookie-consent-banner';
    const html = `<!DOCTYPE html><html><head><title>Portal</title></head><body>
<div id="consent-modal">
  <input id="ck-analytics" type="checkbox" />
  <input id="ck-marketing" type="checkbox" />
  <button id="accept-all">Accept All</button>
  <button id="save-custom">Save Preferences</button>
  <button id="revoke-all">Revoke</button>
  <span id="consent-state">pending</span>
</div></body></html>`;
    const url = 'https://portal.w2.test/home';
    const source = `async function run(actions) {
  const modal = document.getElementById('consent-modal');
  const ckAna = document.getElementById('ck-analytics');
  const ckMkt = document.getElementById('ck-marketing');
  const stateEl = document.getElementById('consent-state');
  let inflight = Promise.resolve();

  async function save(prefs) {
    localStorage.setItem('privacy_consent_w2', JSON.stringify(prefs));
    const res = await fetch('https://api.portal.w2.test/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    modal.hidden = true;
    stateEl.textContent = res.ok
      ? ('saved:a=' + Number(prefs.analytics) + ',m=' + Number(prefs.marketing))
      : ('local-saved:' + res.status);
  }

  document.getElementById('accept-all').addEventListener('click', () => {
    ckAna.checked = true;
    ckMkt.checked = true;
    inflight = save({ necessary: true, analytics: true, marketing: true });
  });
  document.getElementById('save-custom').addEventListener('click', () => {
    inflight = save({ necessary: true, analytics: ckAna.checked, marketing: ckMkt.checked });
  });
  document.getElementById('revoke-all').addEventListener('click', () => {
    if (!confirm('Revoke all optional tracking cookies?')) {
      stateEl.textContent = 'revoke-cancelled';
      return;
    }
    ckAna.checked = false;
    ckMkt.checked = false;
    localStorage.removeItem('privacy_consent_w2');
    modal.hidden = false;
    stateEl.textContent = 'revoked';
  });

  for (const id of actions) {
    document.getElementById(id)?.click();
    await inflight;
  }
  return { hidden: modal.hidden, state: stateEl.textContent, analytics: ckAna.checked, marketing: ckMkt.checked };
}`;
    const pairActions = [['accept-all', 'revoke-all']];
    const pairId = 'w2-pair:cookie-consent-revoke';
    tasks.push(await buildSingleTask({
      id: 'fe-w2-consent-revoke-yes', family, source, args: pairActions, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [true]}, http: () => ({status: 200, json: {ok: true}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-consent-revoke-no', family, source, args: pairActions, initialHtml: html, initialUrl: url, pairId,
      mock: {dialogs: {confirm: [false]}, http: () => ({status: 200, json: {ok: true}})},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-consent-custom-analytics-only', family, source, initialHtml: html, initialUrl: url,
      args: [['ck-analytics', 'save-custom']],
      mock: {http: () => ({status: 200, json: {ok: true}})},
    }));
  }

  // --------------------------------------------------------------------------
  // SF-39: Split-Pane Markdown Preview & TOC Outline Builder (sessionStorage)
  // --------------------------------------------------------------------------
  {
    const family = 'frontend-w2:markdown-preview-split';
    const html = `<!DOCTYPE html><html><head><title>MD Editor</title></head><body>
<div id="md-wrap">
  <textarea id="md-src"></textarea>
  <nav id="toc"></nav>
  <article id="preview"></article>
  <span id="word-count">0 words</span>
</div></body></html>`;
    const url = 'https://notes.w2.test/editor';
    const source = `function run(revisions) {
  const src = document.getElementById('md-src');
  const toc = document.getElementById('toc');
  const preview = document.getElementById('preview');
  const wc = document.getElementById('word-count');

  const draft = sessionStorage.getItem('md_draft_w2');
  if (draft) src.value = draft;

  function render() {
    const raw = src.value;
    sessionStorage.setItem('md_draft_w2', raw);
    const lines = raw.split('\\n');
    const htmlParts = [];
    const headings = [];
    for (const line of lines) {
      const m = /^(#{1,3})\\s+(.+)$/.exec(line.trim());
      if (m) {
        const lvl = m[1].length;
        const text = m[2].trim();
        const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        headings.push({ lvl, text, slug });
        htmlParts.push('<h' + lvl + ' id="' + slug + '">' + text + '</h' + lvl + '>');
      } else if (line.trim().startsWith('- ')) {
        htmlParts.push('<p class="bullet">' + line.trim().slice(2) + '</p>');
      } else if (line.trim()) {
        htmlParts.push('<p>' + line.trim() + '</p>');
      }
    }
    preview.innerHTML = htmlParts.join('');
    toc.innerHTML = headings.map(h => '<a data-lvl="' + h.lvl + '" href="#' + h.slug + '">' + h.text + '</a>').join('');
    const words = raw.trim() ? raw.trim().split(/\\s+/).length : 0;
    wc.textContent = words + ' words';
  }

  src.addEventListener('input', render);
  render();
  for (const rev of revisions) {
    src.value = rev;
    src.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  return {
    wordCount: wc.textContent,
    tocLinks: toc.querySelectorAll('a').map(a => a.dataset.lvl + ':' + a.getAttribute('href')),
    previewHtml: preview.innerHTML,
  };
}`;
    tasks.push(await buildSingleTask({
      id: 'fe-w2-md-render-headings', family, source, initialHtml: html, initialUrl: url,
      args: [['# Release Notes\n## Highlights\n- Faster DOM\n### Upgrade']],
      mock: {storage: {session: {}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-md-hydrate-and-edit', family, source, initialHtml: html, initialUrl: url,
      args: [['# Draft v2\nFinal copy ready.']],
      mock: {storage: {session: {md_draft_w2: '# Draft v1\nOld line'}}},
    }));
    tasks.push(await buildSingleTask({
      id: 'fe-w2-md-clear-doc', family, source, initialHtml: html, initialUrl: url,
      args: [['# Title\nBody text', '']],
      mock: {storage: {session: {}}},
    }));
  }

  return tasks;
}

// ============================================================================
// PART 2: MULTI-FILE 12K-56K BROWSER/DOM SPAs (22 families x 4 = 88 tasks)
// 4 Distinct Architectures (A, B, C, D) + Barrel Re-Exports + >=36% TypeScript
// ============================================================================

const W2_DISTRACTOR_MODULES = [
  ['features/analytics', 'AnalyticsView', ['computeFunnelRates', 'bucketDailyEvents', 'formatRetentionRow', 'renderMetricsCard']],
  ['features/billing', 'BillingPanel', ['calculateProration', 'groupLineItems', 'formatInvoiceBadge', 'validateTaxCode']],
  ['features/exports', 'ExportRunner', ['serializeCsvBatch', 'buildManifestHeader', 'estimateArchiveSize', 'filterExportColumns']],
  ['features/imports', 'ImportWizard', ['parseMappingRules', 'detectDuplicateKeys', 'summarizeDryRun', 'normalizeColumnHeaders']],
  ['features/webhooks', 'WebhookConsole', ['computeSignaturePreview', 'filterDeliveryLogs', 'classifyStatusBand', 'buildRetrySchedule']],
  ['features/auditTrail', 'AuditTrail', ['indexActorActions', 'groupByResourceType', 'formatDiffEntry', 'sliceAuditWindow']],
  ['features/permissions', 'RoleMatrix', ['expandPolicyGrants', 'evaluateScopeAccess', 'diffRoleAssignments', 'listInheritedScopes']],
  ['features/notifications', 'NoticeCenter', ['sortNoticesByUrgency', 'countUnreadByChannel', 'formatDigestPreview', 'muteCategoryWindow']],
  ['pages/profileSettings', 'ProfileSettings', ['validateDisplayName', 'normalizeTimezone', 'serializeAvatarCrop', 'buildSecuritySummary']],
  ['pages/teamDirectory', 'TeamDirectory', ['filterMembersByDept', 'computeSeatUtilization', 'sortByLastActive', 'formatMemberChip']],
  ['pages/integrations', 'IntegrationHub', ['matchConnectorCaps', 'validateWebhookUrl', 'formatSyncCadence', 'groupByProvider']],
  ['pages/shortcutsHelp', 'ShortcutsHelp', ['parseShortcutChord', 'groupBindingsByPane', 'formatKeycapHint', 'detectChordConflicts']],
  ['pages/changelog', 'ChangelogView', ['parseSemverTag', 'groupEntriesByType', 'highlightBreakingNote', 'sliceReleaseNotes']],
  ['widgets/sparkline', 'SparklineWidget', ['normalizeDataPoints', 'computeSlopeTrend', 'buildPolylineCoords', 'summarizeSeriesBounds']],
  ['widgets/datepicker', 'DateRangePicker', ['buildMonthMatrix', 'clampRangeWindow', 'formatIsoDateSpan', 'isWeekendSlot']],
  ['widgets/tagSelector', 'TagSelector', ['normalizeTagToken', 'rankTagMatches', 'mergeSelectedTags', 'formatOverflowPill']],
  ['widgets/breadcrumbBar', 'BreadcrumbBar', ['splitPathTokens', 'collapseMiddleCrumbs', 'labelRouteSegment', 'buildCrumbAria']],
  ['widgets/stepperRail', 'StepperRail', ['computeCompletionPct', 'findNextPendingStep', 'validateStepOrder', 'formatStepStatus']],
  ['widgets/splitPane', 'SplitPaneLayout', ['clampSplitRatio', 'computePaneWidths', 'snapToBreakpoint', 'serializeLayoutState']],
  ['widgets/virtualScroller', 'VirtualScroller', ['computeVisibleRange', 'estimateTotalHeight', 'measureRowOffsets', 'pinOverscanWindow']],
  ['utils/colorTokens', 'ColorTokens', ['parseHexChannels', 'computeLuminance', 'evaluateContrastPair', 'pickAccessibleFg']],
  ['utils/formatters', 'FormatHelpers', ['formatCompactCount', 'formatDurationShort', 'truncateMiddleLabel', 'formatByteUnits']],
  ['utils/keyboard', 'KeyboardNav', ['resolveArrowDelta', 'matchModifierMask', 'cycleFocusIndex', 'isPrintableKey']],
  ['utils/searchIndex', 'LocalSearchIndex', ['tokenizeTextField', 'scorePrefixMatch', 'buildPostingMap', 'highlightTermSpans']],
  ['utils/schemaDiff', 'SchemaDiff', ['collectChangedPaths', 'formatPatchSummary', 'isEqualShallow', 'pruneNullEntries']],
  ['utils/csvParser', 'CsvCodec', ['escapeCsvField', 'parseCsvRecords', 'alignColumnTypes', 'buildHeaderIndex']],
  ['services/cacheLayer', 'CacheLayer', ['computeCacheKey', 'evictLruEntries', 'checkTtlFreshness', 'summarizeCacheStats']],
  ['services/retryPolicy', 'RetryPolicy', ['computeBackoffMs', 'shouldRetryStatus', 'capAttemptBudget', 'formatRetryState']],
  ['services/offlineLog', 'OfflineLog', ['appendPendingMutation', 'compactQueueOps', 'resolveCausalOrder', 'countQueuedOps']],
  ['services/telemetry', 'TelemetryClient', ['buildMetricSample', 'sanitizeTagMap', 'flushSampleBatch', 'aggregateCounterMap']],
];

function buildWave2Distractors(domainSlug, count, {ext = 'js', verbose = false} = {}) {
  const isTs = ext === 'ts';
  const files = {};
  for (let i = 0; i < count; i++) {
    const entry = W2_DISTRACTOR_MODULES[i % W2_DISTRACTOR_MODULES.length];
    const wave = Math.floor(i / W2_DISTRACTOR_MODULES.length);
    const [rawRel, rawCls, rawFns] = entry;
    const rel = wave === 0 ? rawRel : `${rawRel}Part${wave + 1}`;
    const cls = wave === 0 ? rawCls : `${rawCls}Part${wave + 1}`;
    const fns = wave === 0 ? rawFns : rawFns.map(f => `${f}P${wave + 1}`);
    const relPath = `src/${rel}.${ext}`;

    const tsTypes = isTs
      ? `export interface ${cls}Options {\n  domain: string;\n  limit: number;\n  strict: boolean;\n  labels: string[];\n}\n\n`
      : '';
    const verboseBlock = verbose
      ? [
          `export const ${cls.toUpperCase()}_CONFIG${isTs ? `: ${cls}Options` : ''} = {`,
          `  domain: ${JSON.stringify(domainSlug)},`,
          `  limit: ${20 + (i % 15) * 4},`,
          `  strict: ${i % 2 === 0},`,
          `  labels: [${JSON.stringify(domainSlug)}, ${JSON.stringify(rel.split('/')[1])}, 'w2'],`,
          `};`,
          `export function inspect${cls}Bucket(rows${isTs ? ': Array<Record<string, unknown>>' : ''}, cap${isTs ? ': number' : ''} = ${20 + i}) {`,
          `  const kept = [];`,
          `  let total = 0;`,
          `  for (let k = 0; k < rows.length && k < cap; k++) {`,
          `    const r = rows[k];`,
          `    if (r && !r.hidden) { kept.push(String(r.id ?? k)); total += Number(r.weight ?? 1); }`,
          `  }`,
          `  return { module: ${JSON.stringify(rel)}, count: kept.length, total, kept };`,
          `}`,
          '',
        ].join('\n')
      : '';

    const fnBlocks = fns.map((fn, fi) => [
      `export function ${fn}(payload${isTs ? ': Record<string, unknown>' : ''}, opts${isTs ? ': Record<string, unknown>' : ''} = {}) {`,
      `  const obj = payload && typeof payload === 'object' ? payload : { raw: payload };`,
      `  const keys = Object.keys(obj).sort();`,
      `  const tag = keys.map(k => k + ':' + String(obj[k])).join(';');`,
      `  return { domain: ${JSON.stringify(domainSlug)}, fn: ${JSON.stringify(fn)}, seed: ${i * 13 + fi * 5 + 1}, keys: keys.length, tag, optKeys: Object.keys(opts || {}).length };`,
      `}`,
    ].join('\n')).join('\n\n');

    files[relPath] = `${tsTypes}${verboseBlock}${fnBlocks}\n`;
  }
  return files;
}

// ----------------------------------------------------------------------------
// Architecture A: Redux/Reducer + Barrel Re-Exports + Optimistic Rollback SPA
// ----------------------------------------------------------------------------
function buildArchASpa(spec, {distractorCount, verboseDistractors}) {
  const isTs = spec.useTypeScript;
  const ext = isTs ? 'ts' : 'js';
  const T = s => (isTs ? s : '');
  const files = {};

  if (isTs) {
    files['src/types.ts'] = [
      `export interface ${spec.entity}Item {`,
      `  id: string;`,
      `  name: string;`,
      `  stage: string;`,
      `  region: string;`,
      `  units: number;`,
      `  critical: boolean;`,
      `}`,
      `export interface DispatchState {`,
      `  items: ${spec.entity}Item[];`,
      `  filterStage: string;`,
      `  filterRegion: string;`,
      `  banner: string;`,
      `  committedCount: number;`,
      `}`,
    ].join('\n') + '\n';
  }

  files[`src/config.${ext}`] = [
    `export const DOMAIN = ${JSON.stringify(spec.domain)};`,
    `export const API_ROOT = ${JSON.stringify(spec.apiRoot)};`,
    `export const STORAGE_KEY = ${JSON.stringify('w2a_' + spec.domain)};`,
    `export const STAGES = ${JSON.stringify(spec.stages)};`,
    `export const REGIONS = ${JSON.stringify(spec.regions)};`,
  ].join('\n') + '\n';

  files[`src/store/actions.${ext}`] = [
    `export function setFilterAction(stage${T(': string')}, region${T(': string')}) {`,
    `  return { type: 'SET_FILTER', stage, region };`,
    `}`,
    `export function optimisticStageAction(id${T(': string')}, nextStage${T(': string')}) {`,
    `  return { type: 'STAGE_ITEM', id, nextStage };`,
    `}`,
    `export function rollbackItemsAction(snapshot${T(': any[]')}, reason${T(': string')}) {`,
    `  return { type: 'ROLLBACK', snapshot, reason };`,
    `}`,
    `export function setBannerAction(banner${T(': string')}) {`,
    `  return { type: 'BANNER', banner };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/store/reducer.${ext}`] = [
    `export function createInitialState(seedItems${T(': any[]')}) {`,
    `  return {`,
    `    items: seedItems.map((it${T(': any')}) => ({ ...it })),`,
    `    filterStage: 'all',`,
    `    filterRegion: 'all',`,
    `    banner: 'ready',`,
    `    committedCount: 0,`,
    `  };`,
    `}`,
    `export function workspaceReducer(state${T(': any')}, action${T(': any')}) {`,
    `  if (action.type === 'SET_FILTER') {`,
    `    return { ...state, filterStage: action.stage, filterRegion: action.region };`,
    `  }`,
    `  if (action.type === 'STAGE_ITEM') {`,
    `    return {`,
    `      ...state,`,
    `      items: state.items.map((it${T(': any')}) => it.id === action.id ? { ...it, stage: action.nextStage } : it),`,
    `      banner: 'optimistic:' + action.id + '->' + action.nextStage,`,
    `    };`,
    `  }`,
    `  if (action.type === 'ROLLBACK') {`,
    `    return { ...state, items: action.snapshot.map((it${T(': any')}) => ({ ...it })), banner: 'rollback:' + action.reason };`,
    `  }`,
    `  if (action.type === 'BANNER') {`,
    `    return { ...state, banner: action.banner, committedCount: state.committedCount + 1 };`,
    `  }`,
    `  return state;`,
    `}`,
  ].join('\n') + '\n';

  files[`src/store/selectors.${ext}`] = [
    `export function selectVisibleItems(state${T(': any')}) {`,
    `  return state.items`,
    `    .filter((it${T(': any')}) => (state.filterStage === 'all' || it.stage === state.filterStage) && (state.filterRegion === 'all' || it.region === state.filterRegion))`,
    `    .sort((a${T(': any')}, b${T(': any')}) => (b.units - a.units) || a.id.localeCompare(b.id));`,
    `}`,
    `export function selectTotalUnits(items${T(': any[]')}) {`,
    `  return items.reduce((acc${T(': number')}, it${T(': any')}) => acc + Number(it.units || 0), 0);`,
    `}`,
  ].join('\n') + '\n';

  // Barrel re-export for store!
  files[`src/store/index.${ext}`] = [
    `export { setFilterAction, optimisticStageAction, rollbackItemsAction, setBannerAction } from './actions.${ext}';`,
    `export { createInitialState, workspaceReducer } from './reducer.${ext}';`,
    `export { selectVisibleItems, selectTotalUnits } from './selectors.${ext}';`,
  ].join('\n') + '\n';

  files[`src/services/storage.${ext}`] = [
    `import { STORAGE_KEY } from '../config.${ext}';`,
    `export function loadStoredRegion() {`,
    `  return localStorage.getItem(STORAGE_KEY + ':region') || 'all';`,
    `}`,
    `export function saveLastFilter(stage${T(': string')}, region${T(': string')}) {`,
    `  localStorage.setItem(STORAGE_KEY + ':region', region);`,
    `  sessionStorage.setItem(STORAGE_KEY + ':stage', stage);`,
    `}`,
  ].join('\n') + '\n';

  files[`src/services/api.${ext}`] = [
    `import { API_ROOT } from '../config.${ext}';`,
    `export async function patchItemStage(id${T(': string')}, nextStage${T(': string')}, actor${T(': string')}) {`,
    `  const res = await fetch(API_ROOT + '/items/' + id + '/stage', {`,
    `    method: 'PATCH',`,
    `    headers: { 'content-type': 'application/json' },`,
    `    body: JSON.stringify({ stage: nextStage, actor }),`,
    `  });`,
    `  const data = await res.json();`,
    `  return { ok: res.ok, status: res.status, data };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/components/tableView.${ext}`] = [
    `export function renderTableRows(items${T(': any[]')}) {`,
    `  const tbody = document.querySelector('#data-grid tbody');`,
    `  if (!tbody) return 0;`,
    `  tbody.innerHTML = '';`,
    `  for (const it of items) {`,
    `    const tr = document.createElement('tr');`,
    `    tr.dataset.itemId = it.id;`,
    `    tr.dataset.stage = it.stage;`,
    `    tr.className = it.critical ? 'row crit' : 'row';`,
    `    tr.innerHTML = '<td>' + it.name + '</td><td>' + it.region + '</td><td>' + it.stage + '</td><td>' + it.units + '</td>';`,
    `    tbody.appendChild(tr);`,
    `  }`,
    `  return items.length;`,
    `}`,
  ].join('\n') + '\n';

  files[`src/components/toolbar.${ext}`] = [
    `export function syncToolbarDom(banner${T(': string')}, visibleCount${T(': number')}, totalUnits${T(': number')}) {`,
    `  const b = document.getElementById('banner');`,
    `  if (b) b.textContent = banner;`,
    `  const c = document.getElementById('visible-count');`,
    `  if (c) c.textContent = String(visibleCount);`,
    `  const u = document.getElementById('total-units');`,
    `  if (u) u.textContent = String(totalUnits);`,
    `}`,
  ].join('\n') + '\n';

  // Barrel re-export for components!
  files[`src/components/index.${ext}`] = [
    `export { renderTableRows } from './tableView.${ext}';`,
    `export { syncToolbarDom } from './toolbar.${ext}';`,
  ].join('\n') + '\n';

  files[`src/router/historyRouter.${ext}`] = [
    `export function syncRouteParams(stage${T(': string')}, region${T(': string')}) {`,
    `  const usp = new URLSearchParams();`,
    `  if (stage && stage !== 'all') usp.set('stage', stage);`,
    `  if (region && region !== 'all') usp.set('region', region);`,
    `  const qs = usp.toString() ? '?' + usp.toString() : '';`,
    `  history.replaceState({ stage, region }, '', location.pathname + qs);`,
    `  return location.pathname + location.search;`,
    `}`,
  ].join('\n') + '\n';

  files[`src/index.${ext}`] = [
    `import { DOMAIN, STAGES } from './config.${ext}';`,
    `import { createInitialState, workspaceReducer, setFilterAction, optimisticStageAction, rollbackItemsAction, setBannerAction, selectVisibleItems, selectTotalUnits } from './store/index.${ext}';`,
    `import { loadStoredRegion, saveLastFilter } from './services/storage.${ext}';`,
    `import { patchItemStage } from './services/api.${ext}';`,
    `import { renderTableRows, syncToolbarDom } from './components/index.${ext}';`,
    `import { syncRouteParams } from './router/historyRouter.${ext}';`,
    ``,
    `export async function run(input${T(': any')}) {`,
    `  const seedRows = document.querySelectorAll('#data-grid tbody tr').map((tr${T(': any')}) => ({`,
    `    id: tr.dataset.itemId,`,
    `    name: tr.dataset.name,`,
    `    stage: tr.dataset.stage,`,
    `    region: tr.dataset.region,`,
    `    units: Number(tr.dataset.units || 0),`,
    `    critical: tr.dataset.critical === 'true',`,
    `  }));`,
    `  let state = createInitialState(seedRows);`,
    `  const initialRegion = input.region || loadStoredRegion();`,
    `  state = workspaceReducer(state, setFilterAction(input.stage || 'all', initialRegion));`,
    `  saveLastFilter(state.filterStage, state.filterRegion);`,
    `  const route = syncRouteParams(state.filterStage, state.filterRegion);`,
    ``,
    `  const target = state.items.find((it${T(': any')}) => it.id === input.mutateId);`,
    `  if (target && STAGES.includes(input.nextStage)) {`,
    `    let proceed = true;`,
    `    if (target.critical) {`,
    `      proceed = confirm('Move critical ' + target.id + ' to ' + input.nextStage + '?');`,
    `    }`,
    `    if (proceed) {`,
    `      const snap = state.items.map((it${T(': any')}) => ({ ...it }));`,
    `      state = workspaceReducer(state, optimisticStageAction(target.id, input.nextStage));`,
    `      renderTableRows(selectVisibleItems(state));`,
    `      const resp = await patchItemStage(target.id, input.nextStage, input.actor);`,
    `      if (resp.ok) {`,
    `        state = workspaceReducer(state, setBannerAction('committed:' + resp.data.rev));`,
    `      } else {`,
    `        state = workspaceReducer(state, rollbackItemsAction(snap, String(resp.status)));`,
    `      }`,
    `    } else {`,
    `      state = workspaceReducer(state, setBannerAction('cancelled:' + target.id));`,
    `    }`,
    `  }`,
    ``,
    `  const visible = selectVisibleItems(state);`,
    `  const rendered = renderTableRows(visible);`,
    `  const units = selectTotalUnits(visible);`,
    `  syncToolbarDom(state.banner, rendered, units);`,
    `  return {`,
    `    domain: DOMAIN,`,
    `    route,`,
    `    banner: document.getElementById('banner').textContent,`,
    `    visibleIds: document.querySelectorAll('#data-grid tbody tr').map((tr${T(': any')}) => tr.dataset.itemId + ':' + tr.dataset.stage),`,
    `    totalUnits: Number(document.getElementById('total-units').textContent),`,
    `  };`,
    `}`,
  ].join('\n') + '\n';

  Object.assign(files, buildWave2Distractors(spec.domain, distractorCount, {ext, verbose: verboseDistractors}));

  const rowsHtml = spec.seedItems.map(it =>
    `<tr data-item-id="${it.id}" data-name="${it.name}" data-stage="${it.stage}" data-region="${it.region}" data-units="${it.units}" data-critical="${it.critical}"><td>${it.name}</td></tr>`
  ).join('\n');
  const initialHtml = `<!DOCTYPE html><html><head><title>${spec.title}</title></head><body>
<div id="workspace">
  <span id="banner">ready</span>
  <span id="visible-count">0</span>
  <span id="total-units">0</span>
  <table id="data-grid"><tbody>${rowsHtml}</tbody></table>
</div></body></html>`;

  return {files, entryFile: `src/index.${ext}`, initialHtml, initialUrl: `https://${spec.domain}.w2.test/board`};
}

// ----------------------------------------------------------------------------
// Architecture B: Command-Stack Undo/Redo + Debounced Search + Dialog Gate SPA
// ----------------------------------------------------------------------------
function buildArchBSpa(spec, {distractorCount, verboseDistractors}) {
  const isTs = spec.useTypeScript;
  const ext = isTs ? 'ts' : 'js';
  const T = s => (isTs ? s : '');
  const files = {};

  files[`src/config.${ext}`] = [
    `export const APP_NAME = ${JSON.stringify(spec.domain)};`,
    `export const SYNC_URL = ${JSON.stringify(spec.apiRoot + '/publish')};`,
    `export const DRAFT_KEY = ${JSON.stringify('w2b_' + spec.domain + '_draft')};`,
  ].join('\n') + '\n';

  files[`src/commands/historyStack.${ext}`] = [
    `export function createCommandHistory(initialList${T(': any[]')}) {`,
    `  let current = initialList.map((x${T(': any')}) => ({ ...x }));`,
    `  const past${T(': any[][]')} = [];`,
    `  const future${T(': any[][]')} = [];`,
    `  return {`,
    `    snapshot() { return current.map((x${T(': any')}) => ({ ...x })); },`,
    `    apply(mutator${T(': (arr: any[]) => any[]')}) {`,
    `      past.push(current.map((x${T(': any')}) => ({ ...x })));`,
    `      future.length = 0;`,
    `      current = mutator(current.map((x${T(': any')}) => ({ ...x })));`,
    `    },`,
    `    undo() {`,
    `      if (!past.length) return false;`,
    `      future.push(current.map((x${T(': any')}) => ({ ...x })));`,
    `      current = past.pop() || [];`,
    `      return true;`,
    `    },`,
    `    redo() {`,
    `      if (!future.length) return false;`,
    `      past.push(current.map((x${T(': any')}) => ({ ...x })));`,
    `      current = future.pop() || [];`,
    `      return true;`,
    `    },`,
    `    counts() { return { undo: past.length, redo: future.length }; },`,
    `  };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/commands/operations.${ext}`] = [
    `export function renameEntry(list${T(': any[]')}, id${T(': string')}, nextLabel${T(': string')}) {`,
    `  return list.map((x${T(': any')}) => x.id === id ? { ...x, label: nextLabel } : x);`,
    `}`,
    `export function adjustScore(list${T(': any[]')}, id${T(': string')}, delta${T(': number')}) {`,
    `  return list.map((x${T(': any')}) => x.id === id ? { ...x, weight: Math.max(0, x.weight + delta) } : x);`,
    `}`,
  ].join('\n') + '\n';

  files[`src/commands/index.${ext}`] = [
    `export { createCommandHistory } from './historyStack.${ext}';`,
    `export { renameEntry, adjustScore } from './operations.${ext}';`,
  ].join('\n') + '\n';

  files[`src/search/queryEngine.${ext}`] = [
    `export function filterEntries(entries${T(': any[]')}, query${T(': string')}) {`,
    `  const q = query.trim().toLowerCase();`,
    `  return entries`,
    `    .filter((e${T(': any')}) => !q || e.label.toLowerCase().includes(q) || e.group.toLowerCase().includes(q))`,
    `    .sort((a${T(': any')}, b${T(': any')}) => b.weight - a.weight || a.id.localeCompare(b.id));`,
    `}`,
  ].join('\n') + '\n';

  files[`src/search/debouncer.${ext}`] = [
    `export function createDebouncedRunner(delayMs${T(': number')}, fn${T(': (val: string) => void')}) {`,
    `  let timer${T(': any')} = null;`,
    `  return (val${T(': string')}) => {`,
    `    clearTimeout(timer);`,
    `    timer = setTimeout(() => fn(val), delayMs);`,
    `  };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/ui/workspaceDom.${ext}`] = [
    `export function renderEntriesDom(entries${T(': any[]')}, statusText${T(': string')}) {`,
    `  const ul = document.getElementById('entry-list');`,
    `  if (ul) {`,
    `    ul.innerHTML = '';`,
    `    for (const e of entries) {`,
    `      const li = document.createElement('li');`,
    `      li.dataset.id = e.id;`,
    `      li.textContent = e.label + ' [' + e.group + ':' + e.weight + ']';`,
    `      ul.appendChild(li);`,
    `    }`,
    `  }`,
    `  const st = document.getElementById('status-pill');`,
    `  if (st) st.textContent = statusText;`,
    `}`,
  ].join('\n') + '\n';

  files[`src/io/draftStore.${ext}`] = [
    `import { DRAFT_KEY } from '../config.${ext}';`,
    `export function persistDraft(items${T(': any[]')}) {`,
    `  localStorage.setItem(DRAFT_KEY, JSON.stringify(items.map((x${T(': any')}) => ({ id: x.id, label: x.label, weight: x.weight }))));`,
    `}`,
  ].join('\n') + '\n';

  files[`src/io/remoteSync.${ext}`] = [
    `import { SYNC_URL } from '../config.${ext}';`,
    `export async function publishSnapshot(tag${T(': string')}, items${T(': any[]')}) {`,
    `  const res = await fetch(SYNC_URL, {`,
    `    method: 'POST',`,
    `    headers: { 'content-type': 'application/json' },`,
    `    body: JSON.stringify({ tag, count: items.length, ids: items.map((x${T(': any')}) => x.id) }),`,
    `  });`,
    `  const body = await res.json();`,
    `  return { ok: res.ok, status: res.status, body };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/app.${ext}`] = [
    `import { APP_NAME } from './config.${ext}';`,
    `import { createCommandHistory, renameEntry, adjustScore } from './commands/index.${ext}';`,
    `import { filterEntries } from './search/queryEngine.${ext}';`,
    `import { createDebouncedRunner } from './search/debouncer.${ext}';`,
    `import { renderEntriesDom } from './ui/workspaceDom.${ext}';`,
    `import { persistDraft } from './io/draftStore.${ext}';`,
    `import { publishSnapshot } from './io/remoteSync.${ext}';`,
    ``,
    `export async function run(plan${T(': any')}) {`,
    `  const seed = document.querySelectorAll('#entry-list li').map((li${T(': any')}) => ({`,
    `    id: li.dataset.id,`,
    `    label: li.dataset.label,`,
    `    group: li.dataset.group,`,
    `    weight: Number(li.dataset.weight || 0),`,
    `  }));`,
    `  const hist = createCommandHistory(seed);`,
    `  let activeQuery = '';`,
    `  let status = 'editing';`,
    `  const searchInp = document.getElementById('search-box')${T(' as any')};`,
    `  const debouncedSearch = createDebouncedRunner(100, (q${T(': string')}) => {`,
    `    activeQuery = q;`,
    `    renderEntriesDom(filterEntries(hist.snapshot(), activeQuery), status);`,
    `  });`,
    `  if (searchInp) searchInp.addEventListener('input', () => debouncedSearch(searchInp.value));`,
    ``,
    `  hist.apply((arr${T(': any[]')}) => adjustScore(arr, plan.boostId, plan.boostDelta));`,
    `  if (plan.promptRenameId) {`,
    `    const nextName = prompt('New label for ' + plan.promptRenameId + ':', plan.defaultLabel);`,
    `    if (nextName && nextName.trim()) {`,
    `      hist.apply((arr${T(': any[]')}) => renameEntry(arr, plan.promptRenameId, nextName.trim()));`,
    `    }`,
    `  }`,
    `  if (plan.doUndo) hist.undo();`,
    `  if (plan.doRedo) hist.redo();`,
    `  persistDraft(hist.snapshot());`,
    ``,
    `  for (const stroke of plan.searchStrokes) {`,
    `    searchInp.value = stroke;`,
    `    searchInp.dispatchEvent(new InputEvent('input', { bubbles: true }));`,
    `    await window.__flushTimersAsync(40);`,
    `  }`,
    `  await window.__flushTimersAsync(150);`,
    ``,
    `  let publishResult${T(': any')} = { published: false };`,
    `  if (plan.publishTag) {`,
    `    if (confirm('Publish ' + APP_NAME + ' snapshot ' + plan.publishTag + '?')) {`,
    `      const resp = await publishSnapshot(plan.publishTag, hist.snapshot());`,
    `      status = resp.ok ? ('published:' + resp.body.version) : ('publish-err:' + resp.status);`,
    `      publishResult = { published: resp.ok, status: resp.status, version: resp.body.version ?? null };`,
    `    } else {`,
    `      status = 'publish-cancelled';`,
    `    }`,
    `  }`,
    `  const visible = filterEntries(hist.snapshot(), activeQuery);`,
    `  renderEntriesDom(visible, status);`,
    `  return {`,
    `    app: APP_NAME,`,
    `    status: document.getElementById('status-pill').textContent,`,
    `    history: hist.counts(),`,
    `    visible: document.querySelectorAll('#entry-list li').map((li${T(': any')}) => li.dataset.id + '=' + li.textContent),`,
    `    publishResult,`,
    `  };`,
    `}`,
  ].join('\n') + '\n';

  Object.assign(files, buildWave2Distractors(spec.domain, distractorCount, {ext, verbose: verboseDistractors}));

  const liHtml = spec.seedItems.map(it =>
    `<li data-id="${it.id}" data-label="${it.label}" data-group="${it.group}" data-weight="${it.weight}">${it.label}</li>`
  ).join('\n');
  const initialHtml = `<!DOCTYPE html><html><head><title>${spec.title}</title></head><body>
<div id="studio">
  <input id="search-box" value="" />
  <span id="status-pill">init</span>
  <ul id="entry-list">${liHtml}</ul>
</div></body></html>`;

  return {files, entryFile: `src/app.${ext}`, initialHtml, initialUrl: `https://${spec.domain}.w2.test/studio`};
}

// ----------------------------------------------------------------------------
// Architecture C: Auth-401-Retry + SPA Router + Keyed VDOM Patcher SPA
// ----------------------------------------------------------------------------
function buildArchCSpa(spec, {distractorCount, verboseDistractors}) {
  const isTs = spec.useTypeScript;
  const ext = isTs ? 'ts' : 'js';
  const T = s => (isTs ? s : '');
  const files = {};

  files[`src/config.${ext}`] = [
    `export const PORTAL = ${JSON.stringify(spec.domain)};`,
    `export const API_BASE = ${JSON.stringify(spec.apiRoot)};`,
    `export const TOKEN_KEY = ${JSON.stringify('w2c_' + spec.domain + '_tok')};`,
  ].join('\n') + '\n';

  files[`src/auth/sessionVault.${ext}`] = [
    `import { TOKEN_KEY } from '../config.${ext}';`,
    `export function getTokens() {`,
    `  return {`,
    `    access: sessionStorage.getItem(TOKEN_KEY + ':access') || '',`,
    `    refresh: sessionStorage.getItem(TOKEN_KEY + ':refresh') || '',`,
    `  };`,
    `}`,
    `export function setAccessToken(tok${T(': string')}) {`,
    `  sessionStorage.setItem(TOKEN_KEY + ':access', tok);`,
    `}`,
    `export function clearSessionTokens() {`,
    `  sessionStorage.removeItem(TOKEN_KEY + ':access');`,
    `  sessionStorage.removeItem(TOKEN_KEY + ':refresh');`,
    `}`,
  ].join('\n') + '\n';

  files[`src/auth/tokenClient.${ext}`] = [
    `import { API_BASE } from '../config.${ext}';`,
    `import { getTokens, setAccessToken, clearSessionTokens } from './sessionVault.${ext}';`,
    `export async function authedJsonFetch(path${T(': string')}) {`,
    `  const toks = getTokens();`,
    `  let res = await fetch(API_BASE + path, { headers: { authorization: 'Bearer ' + toks.access } });`,
    `  let refreshed = false;`,
    `  if (res.status === 401 && toks.refresh) {`,
    `    const rRes = await fetch(API_BASE + '/auth/refresh', {`,
    `      method: 'POST',`,
    `      headers: { 'content-type': 'application/json' },`,
    `      body: JSON.stringify({ refresh: toks.refresh }),`,
    `    });`,
    `    if (!rRes.ok) {`,
    `      clearSessionTokens();`,
    `      return { ok: false, status: rRes.status, refreshed: false, data: null };`,
    `    }`,
    `    const rData = await rRes.json();`,
    `    setAccessToken(rData.accessToken);`,
    `    refreshed = true;`,
    `    res = await fetch(API_BASE + path, { headers: { authorization: 'Bearer ' + rData.accessToken } });`,
    `  }`,
    `  const data = res.ok ? await res.json() : null;`,
    `  return { ok: res.ok, status: res.status, refreshed, data };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/router/matcher.${ext}`] = [
    `export function matchPortalRoute(pathname${T(': string')}) {`,
    `  const segs = pathname.split('/').filter(Boolean);`,
    `  if (segs[0] === 'item' && segs[1]) return { view: 'detail', itemId: segs[1] };`,
    `  return { view: 'list', itemId: null };`,
    `}`,
    `export function pushPortalPath(path${T(': string')}) {`,
    `  history.pushState({ path }, '', path);`,
    `  return matchPortalRoute(location.pathname);`,
    `}`,
  ].join('\n') + '\n';

  files[`src/router/index.${ext}`] = [
    `export { matchPortalRoute, pushPortalPath } from './matcher.${ext}';`,
  ].join('\n') + '\n';

  files[`src/vdom/h.${ext}`] = [
    `export function vnode(key${T(': string')}, tag${T(': string')}, cls${T(': string')}, text${T(': string')}) {`,
    `  return { key, tag, cls, text };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/vdom/reconcile.${ext}`] = [
    `export function patchContainer(containerId${T(': string')}, vnodes${T(': any[]')}) {`,
    `  const root = document.getElementById(containerId);`,
    `  if (!root) return 0;`,
    `  const existing = new Map();`,
    `  for (const child of root.children) {`,
    `    if (child.dataset.vkey) existing.set(child.dataset.vkey, child);`,
    `  }`,
    `  const keep = new Set(vnodes.map((v${T(': any')}) => v.key));`,
    `  for (const [k, node] of existing.entries()) {`,
    `    if (!keep.has(k)) node.remove();`,
    `  }`,
    `  let reused = 0;`,
    `  let anchor${T(': any')} = null;`,
    `  for (let i = vnodes.length - 1; i >= 0; i--) {`,
    `    const vn = vnodes[i];`,
    `    let el = existing.get(vn.key);`,
    `    if (el) reused++;`,
    `    else { el = document.createElement(vn.tag); el.dataset.vkey = vn.key; }`,
    `    el.className = vn.cls;`,
    `    el.textContent = vn.text;`,
    `    if (el.parentNode !== root || el.nextSibling !== anchor) root.insertBefore(el, anchor);`,
    `    anchor = el;`,
    `  }`,
    `  return reused;`,
    `}`,
  ].join('\n') + '\n';

  files[`src/views/listView.${ext}`] = [
    `import { vnode } from '../vdom/h.${ext}';`,
    `export function buildListVNodes(records${T(': any[]')}) {`,
    `  return records.map((r${T(': any')}) => vnode(r.id, 'li', 'item ' + r.state, r.title + ' [' + r.state + ']'));`,
    `}`,
  ].join('\n') + '\n';

  files[`src/views/detailView.${ext}`] = [
    `export function renderDetailBanner(record${T(': any')}) {`,
    `  const panel = document.getElementById('detail-panel');`,
    `  if (!panel) return;`,
    `  panel.textContent = record ? (record.id + ':' + record.title + ':' + record.state) : 'not-found';`,
    `}`,
  ].join('\n') + '\n';

  files[`src/views/index.${ext}`] = [
    `export { buildListVNodes } from './listView.${ext}';`,
    `export { renderDetailBanner } from './detailView.${ext}';`,
  ].join('\n') + '\n';

  files[`src/main.${ext}`] = [
    `import { PORTAL } from './config.${ext}';`,
    `import { authedJsonFetch } from './auth/tokenClient.${ext}';`,
    `import { matchPortalRoute, pushPortalPath } from './router/index.${ext}';`,
    `import { patchContainer } from './vdom/reconcile.${ext}';`,
    `import { buildListVNodes, renderDetailBanner } from './views/index.${ext}';`,
    ``,
    `export async function run(navPlan${T(': any')}) {`,
    `  const first = await authedJsonFetch('/records');`,
    `  if (!first.ok) {`,
    `    history.replaceState(null, '', '/login');`,
    `    document.getElementById('auth-banner').textContent = 'auth-failed:' + first.status;`,
    `    return { portal: PORTAL, ok: false, path: location.pathname, authBanner: document.getElementById('auth-banner').textContent, reused: 0 };`,
    `  }`,
    `  document.getElementById('auth-banner').textContent = first.refreshed ? 'refreshed-ok' : 'session-ok';`,
    `  const reused1 = patchContainer('vdom-list', buildListVNodes(first.data.records));`,
    `  const route = pushPortalPath('/item/' + navPlan.openId);`,
    `  const picked = first.data.records.find((r${T(': any')}) => r.id === route.itemId) || null;`,
    `  renderDetailBanner(picked);`,
    `  let backRoute = route.view;`,
    `  if (navPlan.goBack) {`,
    `    history.back();`,
    `    backRoute = matchPortalRoute(location.pathname).view;`,
    `  }`,
    `  return {`,
    `    portal: PORTAL,`,
    `    ok: true,`,
    `    authBanner: document.getElementById('auth-banner').textContent,`,
    `    reusedNodes: reused1,`,
    `    detailText: document.getElementById('detail-panel').textContent,`,
    `    finalView: backRoute,`,
    `    finalPath: location.pathname,`,
    `    listItems: document.querySelectorAll('#vdom-list li').map((li${T(': any')}) => li.dataset.vkey + ':' + li.className),`,
    `  };`,
    `}`,
  ].join('\n') + '\n';

  Object.assign(files, buildWave2Distractors(spec.domain, distractorCount, {ext, verbose: verboseDistractors}));

  const initialHtml = `<!DOCTYPE html><html><head><title>${spec.title}</title></head><body>
<div id="portal">
  <span id="auth-banner">checking</span>
  <ul id="vdom-list"><li data-vkey="${spec.seedKeepId}" class="item stale">Old</li></ul>
  <div id="detail-panel">empty</div>
</div></body></html>`;

  return {files, entryFile: `src/main.${ext}`, initialHtml, initialUrl: `https://${spec.domain}.w2.test/records`};
}

// ----------------------------------------------------------------------------
// Architecture D: Live Polling + Toast Queue + Multi-Locale Theme/i18n SPA
// ----------------------------------------------------------------------------
function buildArchDSpa(spec, {distractorCount, verboseDistractors}) {
  const isTs = spec.useTypeScript;
  const ext = isTs ? 'ts' : 'js';
  const T = s => (isTs ? s : '');
  const files = {};

  files[`src/config.${ext}`] = [
    `export const SYSTEM = ${JSON.stringify(spec.domain)};`,
    `export const FEED_URL = ${JSON.stringify(spec.apiRoot + '/feed')};`,
    `export const PREF_KEY = ${JSON.stringify('w2d_' + spec.domain + '_pref')};`,
  ].join('\n') + '\n';

  files[`src/i18n/catalog.${ext}`] = [
    `export const MESSAGES${T(': Record<string, Record<string, string>>')} = {`,
    `  en: { done: 'Completed', halted: 'Halted', running: 'Active' },`,
    `  de: { done: 'Abgeschlossen', halted: 'Gestoppt', running: 'Aktiv' },`,
    `  fr: { done: 'Termine', halted: 'Arrete', running: 'Actif' },`,
    `};`,
    `export function translateStatus(locale${T(': string')}, key${T(': string')}) {`,
    `  const bag = MESSAGES[locale] || MESSAGES.en;`,
    `  return bag[key] || key;`,
    `}`,
  ].join('\n') + '\n';

  files[`src/i18n/index.${ext}`] = [
    `export { translateStatus } from './catalog.${ext}';`,
  ].join('\n') + '\n';

  files[`src/poller/backoff.${ext}`] = [
    `export function computePollDelay(attempt${T(': number')}) {`,
    `  return Math.min(400, 80 * attempt);`,
    `}`,
  ].join('\n') + '\n';

  files[`src/api/client.${ext}`] = [
    `import { FEED_URL } from '../config.${ext}';`,
    `export async function fetchFeedPage(cursor${T(': number')}) {`,
    `  const res = await fetch(FEED_URL + '?cursor=' + cursor);`,
    `  const data = await res.json();`,
    `  return { ok: res.ok, status: res.status, data };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/ui/toastQueue.${ext}`] = [
    `export function pushToast(level${T(': string')}, text${T(': string')}) {`,
    `  const host = document.getElementById('toasts');`,
    `  if (!host) return;`,
    `  const div = document.createElement('div');`,
    `  div.className = 'toast ' + level;`,
    `  div.textContent = text;`,
    `  host.appendChild(div);`,
    `}`,
  ].join('\n') + '\n';

  files[`src/ui/boardView.${ext}`] = [
    `export function appendEventsToDom(events${T(': any[]')}) {`,
    `  const ul = document.getElementById('event-feed');`,
    `  if (!ul) return;`,
    `  for (const ev of events) {`,
    `    const li = document.createElement('li');`,
    `    li.dataset.evId = ev.id;`,
    `    li.textContent = ev.msg;`,
    `    ul.appendChild(li);`,
    `  }`,
    `}`,
  ].join('\n') + '\n';

  files[`src/poller/loop.${ext}`] = [
    `import { computePollDelay } from './backoff.${ext}';`,
    `import { fetchFeedPage } from '../api/client.${ext}';`,
    `import { appendEventsToDom } from '../ui/boardView.${ext}';`,
    `import { pushToast } from '../ui/toastQueue.${ext}';`,
    `export async function runPollLoop(maxPolls${T(': number')}) {`,
    `  let cursor = 0;`,
    `  let stateKey = 'running';`,
    `  let polls = 0;`,
    `  while (polls < maxPolls) {`,
    `    polls++;`,
    `    const resp = await fetchFeedPage(cursor);`,
    `    if (!resp.ok) {`,
    `      stateKey = 'halted';`,
    `      pushToast('error', 'feed-' + resp.status);`,
    `      break;`,
    `    }`,
    `    appendEventsToDom(resp.data.events || []);`,
    `    cursor = resp.data.nextCursor;`,
    `    stateKey = resp.data.state;`,
    `    if (resp.data.alert) pushToast('warn', resp.data.alert);`,
    `    if (stateKey === 'done' || stateKey === 'halted') break;`,
    `    await new Promise((r${T(': any')}) => setTimeout(r, computePollDelay(polls)));`,
    `  }`,
    `  return { polls, cursor, stateKey };`,
    `}`,
  ].join('\n') + '\n';

  files[`src/bootstrap.${ext}`] = [
    `import { SYSTEM, PREF_KEY } from './config.${ext}';`,
    `import { translateStatus } from './i18n/index.${ext}';`,
    `import { runPollLoop } from './poller/loop.${ext}';`,
    `import { pushToast } from './ui/toastQueue.${ext}';`,
    ``,
    `export async function run(opts${T(': any')}) {`,
    `  const saved = localStorage.getItem(PREF_KEY);`,
    `  const prefs = saved ? JSON.parse(saved) : { locale: 'en', theme: 'light' };`,
    `  const locale = opts.locale || prefs.locale;`,
    `  const theme = opts.theme || prefs.theme;`,
    `  document.documentElement.setAttribute('lang', locale);`,
    `  document.body.className = 'theme-' + theme;`,
    `  localStorage.setItem(PREF_KEY, JSON.stringify({ locale, theme }));`,
    ``,
    `  const summary = await runPollLoop(opts.maxPolls || 3);`,
    `  if (summary.stateKey === 'halted' && opts.confirmAck) {`,
    `    const ack = confirm('Acknowledge halt on ' + SYSTEM + '?');`,
    `    pushToast('info', ack ? 'halt-acked' : 'halt-unacked');`,
    `  }`,
    `  const label = translateStatus(locale, summary.stateKey);`,
    `  document.getElementById('status-label').textContent = label;`,
    `  return {`,
    `    system: SYSTEM,`,
    `    lang: document.documentElement.getAttribute('lang'),`,
    `    theme: document.body.className,`,
    `    statusLabel: label,`,
    `    polls: summary.polls,`,
    `    elapsedMs: window.__virtualNow(),`,
    `    events: document.querySelectorAll('#event-feed li').map((li${T(': any')}) => li.dataset.evId + ':' + li.textContent),`,
    `    toasts: document.querySelectorAll('#toasts .toast').map((d${T(': any')}) => d.className + ':' + d.textContent),`,
    `  };`,
    `}`,
  ].join('\n') + '\n';

  Object.assign(files, buildWave2Distractors(spec.domain, distractorCount, {ext, verbose: verboseDistractors}));

  const initialHtml = `<!DOCTYPE html><html lang="en"><head><title>${spec.title}</title></head><body class="theme-light">
<div id="monitor">
  <span id="status-label">init</span>
  <ul id="event-feed"></ul>
  <div id="toasts"></div>
</div></body></html>`;

  return {files, entryFile: `src/bootstrap.${ext}`, initialHtml, initialUrl: `https://${spec.domain}.w2.test/live`};
}

// ==================== 22 Multi-File SPA Domain Specs (8 TS + 14 JS) ====================
const ARCH_A_DOMAINS = [
  {
    domain: 'fleet-dispatch', entity: 'Route', title: 'Fleet Dispatch', useTypeScript: false,
    apiRoot: 'https://api.fleet.w2.test', stages: ['queued', 'enroute', 'delivered'], regions: ['north', 'south', 'west'],
    seedItems: [
      {id: 'RT-1', name: 'Cold-Chain Van 4', stage: 'queued', region: 'north', units: 42, critical: true},
      {id: 'RT-2', name: 'Express Box 9', stage: 'enroute', region: 'south', units: 18, critical: false},
      {id: 'RT-3', name: 'Freight Rig 2', stage: 'queued', region: 'north', units: 65, critical: false},
    ],
  },
  {
    domain: 'clinical-trials', entity: 'Cohort', title: 'Clinical Trials', useTypeScript: true,
    apiRoot: 'https://api.trials.w2.test', stages: ['screening', 'enrolled', 'closed'], regions: ['eu', 'us', 'apac'],
    seedItems: [
      {id: 'CT-1', name: 'Oncology Arm A', stage: 'screening', region: 'us', units: 120, critical: true},
      {id: 'CT-2', name: 'Cardio Arm B', stage: 'enrolled', region: 'eu', units: 85, critical: false},
      {id: 'CT-3', name: 'Neuro Arm C', stage: 'screening', region: 'us', units: 50, critical: false},
    ],
  },
  {
    domain: 'cloud-quotas', entity: 'Quota', title: 'Cloud Quotas', useTypeScript: false,
    apiRoot: 'https://api.quotas.w2.test', stages: ['requested', 'approved', 'provisioned'], regions: ['us-east', 'eu-west', 'ap-south'],
    seedItems: [
      {id: 'QT-1', name: 'H100 Cluster', stage: 'requested', region: 'us-east', units: 64, critical: true},
      {id: 'QT-2', name: 'TPU Slice', stage: 'approved', region: 'eu-west', units: 32, critical: false},
      {id: 'QT-3', name: 'NVMe Pool', stage: 'requested', region: 'us-east', units: 24, critical: false},
    ],
  },
  {
    domain: 'grant-review', entity: 'Grant', title: 'Grant Review', useTypeScript: true,
    apiRoot: 'https://api.grants.w2.test', stages: ['triage', 'panel', 'funded'], regions: ['bio', 'ai', 'climate'],
    seedItems: [
      {id: 'GR-1', name: 'Grid Storage Lab', stage: 'triage', region: 'climate', units: 450, critical: true},
      {id: 'GR-2', name: 'Protein Fold Core', stage: 'panel', region: 'bio', units: 300, critical: false},
      {id: 'GR-3', name: 'Solar Perovskite', stage: 'triage', region: 'climate', units: 210, critical: false},
    ],
  },
  {
    domain: 'warehouse-rma', entity: 'Return', title: 'Warehouse RMA', useTypeScript: false,
    apiRoot: 'https://api.rma.w2.test', stages: ['received', 'inspected', 'restocked'], regions: ['dock-a', 'dock-b', 'dock-c'],
    seedItems: [
      {id: 'RM-1', name: 'Battery Pack Lot', stage: 'received', region: 'dock-a', units: 90, critical: true},
      {id: 'RM-2', name: 'Router Chassis', stage: 'inspected', region: 'dock-b', units: 30, critical: false},
      {id: 'RM-3', name: 'Sensor Module', stage: 'received', region: 'dock-a', units: 55, critical: false},
    ],
  },
  {
    domain: 'ad-campaigns', entity: 'Campaign', title: 'Ad Campaigns', useTypeScript: false,
    apiRoot: 'https://api.ads.w2.test', stages: ['draft', 'live', 'paused'], regions: ['na', 'emea', 'latam'],
    seedItems: [
      {id: 'AD-1', name: 'Holiday Launch', stage: 'draft', region: 'na', units: 800, critical: true},
      {id: 'AD-2', name: 'Brand Search', stage: 'live', region: 'emea', units: 350, critical: false},
      {id: 'AD-3', name: 'Video Retarget', stage: 'draft', region: 'na', units: 220, critical: false},
    ],
  },
];

const ARCH_B_DOMAINS = [
  {
    domain: 'design-tokens', title: 'Design Tokens', useTypeScript: true,
    apiRoot: 'https://api.tokens.w2.test',
    seedItems: [
      {id: 'tk-1', label: 'brand-primary', group: 'color', weight: 90},
      {id: 'tk-2', label: 'surface-card', group: 'color', weight: 70},
      {id: 'tk-3', label: 'space-gutter', group: 'layout', weight: 50},
    ],
  },
  {
    domain: 'curriculum-planner', title: 'Curriculum Planner', useTypeScript: false,
    apiRoot: 'https://api.courses.w2.test',
    seedItems: [
      {id: 'cs-1', label: 'Distributed Systems', group: 'systems', weight: 80},
      {id: 'cs-2', label: 'Compilers Lab', group: 'systems', weight: 75},
      {id: 'cs-3', label: 'Linear Algebra', group: 'math', weight: 60},
    ],
  },
  {
    domain: 'menu-pos-builder', title: 'POS Menu Builder', useTypeScript: false,
    apiRoot: 'https://api.pos.w2.test',
    seedItems: [
      {id: 'mn-1', label: 'Miso Ramen', group: 'mains', weight: 95},
      {id: 'mn-2', label: 'Yuzu Soda', group: 'drinks', weight: 40},
      {id: 'mn-3', label: 'Gyoza Plate', group: 'mains', weight: 65},
    ],
  },
  {
    domain: 'podcast-studio', title: 'Podcast Studio', useTypeScript: true,
    apiRoot: 'https://api.podcast.w2.test',
    seedItems: [
      {id: 'ch-1', label: 'Cold Open', group: 'intro', weight: 85},
      {id: 'ch-2', label: 'Guest Deep Dive', group: 'main', weight: 92},
      {id: 'ch-3', label: 'Listener QA', group: 'main', weight: 55},
    ],
  },
  {
    domain: 'floorplan-seating', title: 'Floorplan Seating', useTypeScript: false,
    apiRoot: 'https://api.floorplan.w2.test',
    seedItems: [
      {id: 'bo-1', label: 'Keynote Stage', group: 'hall-a', weight: 100},
      {id: 'bo-2', label: 'Sponsor Lounge', group: 'hall-a', weight: 65},
      {id: 'bo-3', label: 'Workshop Room', group: 'hall-b', weight: 50},
    ],
  },
  {
    domain: 'shader-presets', title: 'Shader Presets', useTypeScript: false,
    apiRoot: 'https://api.shaders.w2.test',
    seedItems: [
      {id: 'sh-1', label: 'Volumetric Fog', group: 'post', weight: 88},
      {id: 'sh-2', label: 'Bloom Pass', group: 'post', weight: 72},
      {id: 'sh-3', label: 'Water Caustics', group: 'surface', weight: 64},
    ],
  },
];

const ARCH_C_DOMAINS = [
  {domain: 'payroll-portal', title: 'Payroll Portal', useTypeScript: true, apiRoot: 'https://api.payroll.w2.test', seedKeepId: 'pay-1',
    records: [{id: 'pay-1', title: 'March Contractors', state: 'approved'}, {id: 'pay-2', title: 'April Bonus Run', state: 'pending'}]},
  {domain: 'secrets-kms', title: 'Secrets KMS', useTypeScript: false, apiRoot: 'https://api.kms.w2.test', seedKeepId: 'key-1',
    records: [{id: 'key-1', title: 'Root Signing Key', state: 'active'}, {id: 'key-2', title: 'Staging TLS Key', state: 'rotating'}]},
  {domain: 'licensing-hub', title: 'Licensing Hub', useTypeScript: true, apiRoot: 'https://api.licenses.w2.test', seedKeepId: 'lic-1',
    records: [{id: 'lic-1', title: 'Enterprise 500 Seat', state: 'active'}, {id: 'lic-2', title: 'Academic Lab Pack', state: 'trial'}]},
  {domain: 'dns-zone-panel', title: 'DNS Zone Panel', useTypeScript: false, apiRoot: 'https://api.dns.w2.test', seedKeepId: 'zn-1',
    records: [{id: 'zn-1', title: 'edge.example.test', state: 'propagated'}, {id: 'zn-2', title: 'mail.example.test', state: 'pending'}]},
  {domain: 'telemetry-alerts', title: 'Telemetry Alerts', useTypeScript: false, apiRoot: 'https://api.alerts.w2.test', seedKeepId: 'al-1',
    records: [{id: 'al-1', title: 'P99 Latency Policy', state: 'armed'}, {id: 'al-2', title: 'Error Budget Burn', state: 'muted'}]},
];

const ARCH_D_DOMAINS = [
  {domain: 'ci-release-train', title: 'Release Train', useTypeScript: true, apiRoot: 'https://api.train.w2.test',
    ev1: {id: 'e1', msg: 'canary 10% healthy'}, ev2: {id: 'e2', msg: 'promoted 100%'}},
  {domain: 'energy-microgrid', title: 'Energy Microgrid', useTypeScript: false, apiRoot: 'https://api.grid.w2.test',
    ev1: {id: 'e1', msg: 'battery discharge 420kW'}, ev2: {id: 'e2', msg: 'peak shaved'}},
  {domain: 'auction-exchange', title: 'Auction Exchange', useTypeScript: true, apiRoot: 'https://api.exch.w2.test',
    ev1: {id: 'e1', msg: 'lot 9 opened at $420'}, ev2: {id: 'e2', msg: 'lot 9 settled'}},
  {domain: 'lab-instruments', title: 'Lab Instruments', useTypeScript: false, apiRoot: 'https://api.lab.w2.test',
    ev1: {id: 'e1', msg: 'bioreactor 37.0C stable'}, ev2: {id: 'e2', msg: 'harvest ready'}},
  {domain: 'rail-signaling', title: 'Rail Signaling', useTypeScript: false, apiRoot: 'https://api.rail.w2.test',
    ev1: {id: 'e1', msg: 'north corridor clear'}, ev2: {id: 'e2', msg: 'express on time'}},
];

async function makeMultiFileTask({id, family, built, args, mock, useTypeScript, pairId = null, arch, variant}) {
  const rec = await recordMultiFileBrowserFixture({
    files: built.files,
    entryFile: built.entryFile,
    entry: 'run',
    initialLoadedFiles: [built.entryFile],
    args,
    initialHtml: built.initialHtml,
    initialUrl: built.initialUrl,
    ...mock,
  });
  const features = [
    'frontend',
    'browser-dom',
    'frontend-wave2',
    'multi-file',
    'code-load',
    'long-context-65k',
    ...(rec.calls.length > 0 ? ['external'] : []),
    ...(useTypeScript ? ['typescript'] : []),
    ...(pairId ? ['causal-pair'] : []),
  ];
  return {
    id,
    family,
    language: useTypeScript ? 'ts' : 'js',
    environment: 'browser',
    executionMode: 'native',
    files: built.files,
    entryFile: built.entryFile,
    entry: 'run',
    initialLoadedFiles: [built.entryFile],
    initialHtml: built.initialHtml,
    initialUrl: built.initialUrl,
    args,
    fixture: {calls: rec.calls},
    randomSeed: 23,
    timeoutMs: 20000,
    tier: 5,
    features: [...new Set(features)],
    metadata: {
      tier: 5,
      environment: 'browser',
      wave: 'stage10-frontend-wave2',
      arch,
      variant,
      ...(pairId ? {pair_id: pairId} : {}),
    },
  };
}

async function buildMultiFileFamilies() {
  const tasks = [];

  // Architecture A (6 families x 4 = 24 tasks, 6 causal pairs)
  for (const spec of ARCH_A_DOMAINS) {
    const family = `lc65k-fe-w2/${spec.domain}`;
    const pairBuilt = buildArchASpa(spec, {distractorCount: 38, verboseDistractors: true});
    const medBuilt = buildArchASpa(spec, {distractorCount: 54, verboseDistractors: true});
    const xlBuilt = buildArchASpa(spec, {distractorCount: spec.useTypeScript ? 86 : 104, verboseDistractors: false});
    const pairArgs = [{actor: 'ops_lead', stage: 'all', region: spec.regions[0], mutateId: spec.seedItems[0].id, nextStage: spec.stages[1]}];
    const pairId = `w2-mf-pair:${spec.domain}`;

    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-commit`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'A-reducer-barrel', variant: 'pair-commit',
      mock: {storage: {local: {}}, dialogs: {confirm: [true]}, http: () => ({status: 200, json: {rev: 12}})},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-rollback`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'A-reducer-barrel', variant: 'pair-rollback',
      mock: {storage: {local: {}}, dialogs: {confirm: [true]}, http: () => ({status: 409, json: {error: 'version-conflict'}})},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-med-cancel`, family, built: medBuilt, useTypeScript: spec.useTypeScript, arch: 'A-reducer-barrel', variant: 'med',
      args: [{actor: 'analyst', stage: spec.stages[0], region: '', mutateId: spec.seedItems[0].id, nextStage: spec.stages[2]}],
      mock: {storage: {local: {[`w2a_${spec.domain}:region`]: spec.regions[0]}}, dialogs: {confirm: [false]}},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-xl-noncrit`, family, built: xlBuilt, useTypeScript: spec.useTypeScript, arch: 'A-reducer-barrel', variant: 'xl',
      args: [{actor: 'coord', stage: 'all', region: 'all', mutateId: spec.seedItems[2].id, nextStage: spec.stages[2]}],
      mock: {storage: {local: {}}, http: () => ({status: 200, json: {rev: 24}})},
    }));
  }

  // Architecture B (6 families x 4 = 24 tasks, 6 causal pairs)
  for (const spec of ARCH_B_DOMAINS) {
    const family = `lc65k-fe-w2/${spec.domain}`;
    const pairBuilt = buildArchBSpa(spec, {distractorCount: 40, verboseDistractors: true});
    const medBuilt = buildArchBSpa(spec, {distractorCount: 58, verboseDistractors: true});
    const xlBuilt = buildArchBSpa(spec, {distractorCount: spec.useTypeScript ? 88 : 106, verboseDistractors: false});
    const qPrefix = spec.seedItems[0].group.slice(0, 3);
    const pairArgs = [{
      boostId: spec.seedItems[1].id, boostDelta: 25,
      promptRenameId: spec.seedItems[0].id, defaultLabel: spec.seedItems[0].label + '-v2',
      doUndo: true, doRedo: true,
      searchStrokes: [qPrefix.slice(0, 2), qPrefix],
      publishTag: 'v2.4',
    }];
    const pairId = `w2-mf-pair:${spec.domain}`;

    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-pub-yes`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'B-command-debounce', variant: 'pair-pub-yes',
      mock: {dialogs: {prompt: [spec.seedItems[0].label + ' Pro'], confirm: [true]}, http: () => ({status: 201, json: {version: '2.4.1'}})},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-pub-no`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'B-command-debounce', variant: 'pair-pub-no',
      mock: {dialogs: {prompt: [spec.seedItems[0].label + ' Pro'], confirm: [false]}},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-med-undo-only`, family, built: medBuilt, useTypeScript: spec.useTypeScript, arch: 'B-command-debounce', variant: 'med',
      args: [{boostId: spec.seedItems[2].id, boostDelta: 40, promptRenameId: spec.seedItems[2].id, defaultLabel: 'Alt', doUndo: true, doRedo: false, searchStrokes: [''], publishTag: ''}],
      mock: {dialogs: {prompt: [null]}},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-xl-pub-500`, family, built: xlBuilt, useTypeScript: spec.useTypeScript, arch: 'B-command-debounce', variant: 'xl',
      args: [{boostId: spec.seedItems[0].id, boostDelta: -10, promptRenameId: null, defaultLabel: '', doUndo: false, doRedo: false, searchStrokes: [spec.seedItems[0].label.slice(0, 4)], publishTag: 'v3.0'}],
      mock: {dialogs: {confirm: [true]}, http: () => ({status: 500, json: {error: 'lock-timeout'}})},
    }));
  }

  // Architecture C (5 families x 4 = 20 tasks, 5 causal pairs)
  for (const spec of ARCH_C_DOMAINS) {
    const family = `lc65k-fe-w2/${spec.domain}`;
    const pairBuilt = buildArchCSpa(spec, {distractorCount: 42, verboseDistractors: true});
    const medBuilt = buildArchCSpa(spec, {distractorCount: 62, verboseDistractors: true});
    const xlBuilt = buildArchCSpa(spec, {distractorCount: spec.useTypeScript ? 90 : 108, verboseDistractors: false});
    const tokKey = `w2c_${spec.domain}_tok`;
    const pairArgs = [{openId: spec.records[1].id, goBack: true}];
    const pairId = `w2-mf-pair:${spec.domain}`;

    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-refresh-ok`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'C-auth-router-vdom', variant: 'pair-refresh-ok',
      mock: {
        storage: {session: {[tokKey + ':access']: 'old-jwt', [tokKey + ':refresh']: 'ref-77'}},
        http: [
          {status: 401, json: {error: 'expired'}},
          {status: 200, json: {accessToken: 'fresh-jwt'}},
          {status: 200, json: {records: spec.records}},
        ],
      },
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-refresh-401`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'C-auth-router-vdom', variant: 'pair-refresh-401',
      mock: {
        storage: {session: {[tokKey + ':access']: 'old-jwt', [tokKey + ':refresh']: 'ref-77'}},
        http: [
          {status: 401, json: {error: 'expired'}},
          {status: 401, json: {error: 'revoked'}},
        ],
      },
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-med-valid-detail`, family, built: medBuilt, useTypeScript: spec.useTypeScript, arch: 'C-auth-router-vdom', variant: 'med',
      args: [{openId: spec.records[0].id, goBack: false}],
      mock: {storage: {session: {[tokKey + ':access']: 'live-jwt'}}, http: () => ({status: 200, json: {records: spec.records}})},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-xl-missing-id`, family, built: xlBuilt, useTypeScript: spec.useTypeScript, arch: 'C-auth-router-vdom', variant: 'xl',
      args: [{openId: 'nonexistent-99', goBack: true}],
      mock: {storage: {session: {[tokKey + ':access']: 'live-jwt'}}, http: () => ({status: 200, json: {records: spec.records}})},
    }));
  }

  // Architecture D (5 families x 4 = 20 tasks, 5 causal pairs)
  for (const spec of ARCH_D_DOMAINS) {
    const family = `lc65k-fe-w2/${spec.domain}`;
    const pairBuilt = buildArchDSpa(spec, {distractorCount: 44, verboseDistractors: true});
    const medBuilt = buildArchDSpa(spec, {distractorCount: 64, verboseDistractors: true});
    const xlBuilt = buildArchDSpa(spec, {distractorCount: spec.useTypeScript ? 92 : 110, verboseDistractors: false});
    const prefKey = `w2d_${spec.domain}_pref`;
    const pairArgs = [{locale: 'de', theme: 'dark', maxPolls: 3, confirmAck: true}];
    const pairId = `w2-mf-pair:${spec.domain}`;

    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-done`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'D-poller-i18n-toast', variant: 'pair-done',
      mock: {
        storage: {local: {[prefKey]: JSON.stringify({locale: 'en', theme: 'light'})}},
        http: [
          {status: 200, json: {state: 'running', nextCursor: 1, events: [spec.ev1]}},
          {status: 200, json: {state: 'done', nextCursor: 2, events: [spec.ev2]}},
        ],
      },
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-pair-halted`, family, built: pairBuilt, args: pairArgs, useTypeScript: spec.useTypeScript, pairId, arch: 'D-poller-i18n-toast', variant: 'pair-halted',
      mock: {
        storage: {local: {[prefKey]: JSON.stringify({locale: 'en', theme: 'light'})}},
        dialogs: {confirm: [true]},
        http: [
          {status: 200, json: {state: 'running', nextCursor: 1, events: [spec.ev1]}},
          {status: 200, json: {state: 'halted', nextCursor: 2, events: [], alert: 'threshold-breach'}},
        ],
      },
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-med-fr-503`, family, built: medBuilt, useTypeScript: spec.useTypeScript, arch: 'D-poller-i18n-toast', variant: 'med',
      args: [{locale: 'fr', theme: 'hc', maxPolls: 2, confirmAck: true}],
      mock: {storage: {local: {}}, dialogs: {confirm: [false]}, http: () => ({status: 503, json: {error: 'unavailable'}})},
    }));
    tasks.push(await makeMultiFileTask({
      id: `lc65k-fe-w2-${spec.domain}-xl-en-cap`, family, built: xlBuilt, useTypeScript: spec.useTypeScript, arch: 'D-poller-i18n-toast', variant: 'xl',
      args: [{locale: 'en', theme: 'light', maxPolls: 2, confirmAck: false}],
      mock: {
        storage: {local: {}},
        http: [
          {status: 200, json: {state: 'running', nextCursor: 1, events: [spec.ev1]}},
          {status: 200, json: {state: 'running', nextCursor: 2, events: [spec.ev2]}},
        ],
      },
    }));
  }

  return tasks;
}

export async function buildAllCandidates({kind = 'all'} = {}) {
  const all = [];
  if (kind === 'all' || kind === 'single') {
    all.push(...await buildSingleFileFamiliesPart1());
    all.push(...await buildSingleFileFamiliesPart2());
    all.push(...await buildSingleFileFamiliesPart2Extra());
  }
  if (kind === 'all' || kind === 'multifile') {
    all.push(...await buildMultiFileFamilies());
  }
  return all;
}

// ============================================================================
// PART 3: 2x INDEPENDENT DETERMINISTIC VERIFICATION, BUDGETING & LEAKAGE AUDIT
// ============================================================================

export async function verifyFlexibleStudentSession(exported) {
  const prepared = await prepareTinkerTask(exported.task, {traceFormat: 'compact'});
  const session = createTinkerSession(prepared);
  let tok = 0;
  try {
    for (const msg of exported.messages) {
      if (msg.role !== 'assistant') continue;
      tok += 20;
      const action = parseStudentAction(msg);
      if (action.type === 'call') {
        const res = await session.step({
          role: 'assistant',
          content: '',
          tool_calls: [{
            type: 'function',
            id: action.toolCallId ?? 'c_' + tok,
            function: {name: action.operation, arguments: JSON.stringify({arguments: action.arguments})},
          }],
        }, tok);
        if (res.done) {
          throw new Error(`Unexpected early termination on ${exported.id}: ${res.grade.reason}`);
        }
      } else if (action.type === 'complete') {
        const doneRes = await session.step(JSON.stringify(action), tok);
        if (!doneRes.done || !doneRes.grade.success) {
          throw new Error(`Live session completion failed on ${exported.id}: ${doneRes.grade.reason} (${doneRes.grade.failureCategory})`);
        }
      }
    }
  } finally {
    session.close();
  }
}

export async function exportAndVerifyTaskTwice(task) {
  const opts = {traceFormat: 'compact', reasoningChannel: 'thinking'};
  // Run 2x independently through the real JS reference worker
  const run1 = await exportTinkerExample(task, opts);
  const run2 = await exportTinkerExample(task, opts);

  if (run1.sourceHash !== run2.sourceHash) {
    throw new Error(`Non-deterministic sourceHash on ${task.id}`);
  }
  if (!isDeepStrictEqual(run1.messages, run2.messages)) {
    throw new Error(`Non-deterministic messages across 2x independent runs on ${task.id}`);
  }
  if (!isDeepStrictEqual(run1.metadata.traceAudit, run2.metadata.traceAudit)) {
    throw new Error(`Non-deterministic traceAudit across 2x independent runs on ${task.id}`);
  }
  if (!run1.metadata.traceAudit?.replayVerified) {
    throw new Error(`traceAudit.replayVerified is false on ${task.id}`);
  }
  if (!run1.metadata.traceAudit?.canonicalCausalNarration) {
    throw new Error(`traceAudit.canonicalCausalNarration is false on ${task.id}`);
  }

  // Validate pre-exported row invariants for runner.py `_is_preexported_row`
  if (!Array.isArray(run1.messages) || run1.messages.length === 0) {
    throw new Error(`Empty messages on ${task.id}`);
  }
  if (typeof run1.sourceHash !== 'string' || !run1.sourceHash) {
    throw new Error(`Missing sourceHash on ${task.id}`);
  }
  if (!run1.task || typeof run1.task !== 'object') {
    throw new Error(`Missing task object on ${task.id}`);
  }

  const assistantMsgs = run1.messages.filter(m => m.role === 'assistant');
  const assistantTurns = assistantMsgs.length;
  if (assistantTurns > MAX_ASSISTANT_TURNS) {
    throw new Error(`assistantTurns ${assistantTurns} > ${MAX_ASSISTANT_TURNS} on ${task.id}`);
  }

  const perTurnTokens = assistantMsgs.map(estimateMessageTokens);
  const maxAssistantTurnTokens = Math.max(0, ...perTurnTokens);
  if (maxAssistantTurnTokens > MAX_TURN_TOKENS) {
    throw new Error(`maxAssistantTurnTokens ${maxAssistantTurnTokens} > ${MAX_TURN_TOKENS} on ${task.id}`);
  }

  const episodeChars = JSON.stringify(run1.messages).length;
  const approxTokens = estimateTokens(episodeChars, 3.2);
  if (approxTokens > MAX_CONTEXT_TOKENS) {
    throw new Error(`approxTokens ${approxTokens} > ${MAX_CONTEXT_TOKENS} on ${task.id}`);
  }

  const isMultiFile = Boolean(run1.task.files && typeof run1.task.files === 'object');
  let codebaseChars = 0;
  let codebaseApproxTokens = 0;
  let fileCount = 1;
  let loadedFileCount = 1;

  if (isMultiFile) {
    const fileEntries = Object.entries(run1.task.files);
    fileCount = fileEntries.length;
    codebaseChars = fileEntries.reduce((sum, [, text]) => sum + text.length, 0);
    codebaseApproxTokens = estimateTokens(codebaseChars, 3.5);
    if (fileCount < 25 || fileCount > 160) {
      throw new Error(`Multi-file fileCount ${fileCount} outside [25, 160] on ${task.id}`);
    }
    if (codebaseApproxTokens < MIN_MF_CODEBASE_TOKENS || codebaseApproxTokens > MAX_MF_CODEBASE_TOKENS) {
      throw new Error(`Multi-file codebaseApproxTokens ${codebaseApproxTokens} (${codebaseChars} chars) outside [${MIN_MF_CODEBASE_TOKENS}, ${MAX_MF_CODEBASE_TOKENS}] on ${task.id}`);
    }
    if ((run1.metadata.codeLoadCalls ?? 0) < 3) {
      throw new Error(`Expected >=3 code.load calls on ${task.id}, got ${run1.metadata.codeLoadCalls}`);
    }
    const loadedPaths = new Set(run1.task.initialLoadedFiles ?? [run1.task.entryFile]);
    for (const m of run1.messages) {
      if (m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'code.load') {
        const reqs = JSON.parse(m.tool_calls[0].function.arguments).arguments;
        for (const r of reqs) if (r?.path) loadedPaths.add(r.path);
      }
    }
    loadedFileCount = loadedPaths.size;
    await verifyFlexibleStudentSession(run1);
  } else {
    codebaseChars = run1.task.source.length;
    codebaseApproxTokens = estimateTokens(codebaseChars, 3.2);
    if (approxTokens > MAX_TURN_TOKENS) {
      throw new Error(`Single-file approxTokens ${approxTokens} > ${MAX_TURN_TOKENS} on ${task.id}`);
    }
  }

  const traceLines = assistantMsgs.reduce((n, m) => {
    const t = assistantThinkingText(m).trim();
    return n + (t ? t.split('\n').length : 0);
  }, 0);

  const splitComponent = sha256(`${run1.family}:${run1.sourceHash}`);
  const pairId = run1.metadata.pair_id ?? task.metadata?.pair_id ?? null;

  const preexportedRow = {
    schema: run1.schema,
    id: run1.id,
    family: run1.family,
    sourceHash: run1.sourceHash,
    split_component: splitComponent,
    ...(pairId ? {pair_id: pairId} : {}),
    task: run1.task,
    messages: run1.messages,
    metadata: {
      ...run1.metadata,
      tier: 5,
      environment: 'browser',
      wave: 'stage10-frontend-wave2',
      deterministic2xVerified: true,
      fileCount,
      loadedFileCount,
      codebaseChars,
      codebaseApproxTokens,
      episodeChars,
      approxTokens,
      assistantTurns,
      maxAssistantTurnTokens,
      traceLines,
      narrationLines: run1.metadata.traceAudit.narrationLines,
      sourceHash: run1.sourceHash,
      ...(pairId ? {pair_id: pairId} : {}),
    },
  };

  return {row: preexportedRow, exported: run1};
}

export function loadBenchmarkForbiddenSets({
  benchmarkJsonlPath = DEFAULT_BENCHMARK_JSONL,
  manifestPath = DEFAULT_BENCHMARK_MANIFEST,
} = {}) {
  const ids = new Set();
  const families = new Set();
  const sourceHashes = new Set();
  const splitComponents = new Set();
  let benchmarkRows = 0;

  if (benchmarkJsonlPath && existsSync(benchmarkJsonlPath)) {
    const raw = readFileSync(benchmarkJsonlPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      benchmarkRows++;
      if (row.id) ids.add(String(row.id));
      if (row.task?.id) ids.add(String(row.task.id));
      if (row.family) families.add(String(row.family));
      if (row.task?.family) families.add(String(row.task.family));
      if (row.sourceHash) sourceHashes.add(String(row.sourceHash));
      if (row.metadata?.sourceHash) sourceHashes.add(String(row.metadata.sourceHash));
      if (row.split_component) splitComponents.add(String(row.split_component));
    }
  }

  let manifestLoaded = false;
  if (manifestPath && existsSync(manifestPath)) {
    manifestLoaded = true;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const trackIds of Object.values(manifest.task_ids_by_track ?? {})) {
      for (const tid of trackIds ?? []) ids.add(String(tid));
    }
    for (const trackInfo of Object.values(manifest.tracks ?? {})) {
      for (const pid of trackInfo?.pair_ids ?? []) {
        const parts = String(pid).split(':');
        if (parts.length >= 2) families.add(parts.slice(1, -1).join(':'));
      }
    }
  }

  return {ids, families, sourceHashes, splitComponents, benchmarkRows, manifestLoaded};
}

export function runZeroLeakageAudit(rows, paths = {}) {
  const forbidden = loadBenchmarkForbiddenSets(paths);
  const overlaps = {id: [], family: [], sourceHash: [], split_component: []};

  for (const row of rows) {
    if (forbidden.ids.has(row.id)) overlaps.id.push(row.id);
    if (forbidden.families.has(row.family)) overlaps.family.push(row.family);
    if (forbidden.sourceHashes.has(row.sourceHash)) overlaps.sourceHash.push(row.sourceHash);
    if (row.split_component && forbidden.splitComponents.has(row.split_component)) {
      overlaps.split_component.push(row.split_component);
    }
  }

  const passed =
    overlaps.id.length === 0 &&
    overlaps.family.length === 0 &&
    overlaps.sourceHash.length === 0 &&
    overlaps.split_component.length === 0;

  return {
    passed,
    benchmarkJsonlPath: paths.benchmarkJsonlPath ?? DEFAULT_BENCHMARK_JSONL,
    manifestPath: paths.manifestPath ?? DEFAULT_BENCHMARK_MANIFEST,
    checkedRows: rows.length,
    benchmarkRowsLoaded: forbidden.benchmarkRows,
    manifestLoaded: forbidden.manifestLoaded,
    forbiddenCounts: {
      ids: forbidden.ids.size,
      families: forbidden.families.size,
      sourceHashes: forbidden.sourceHashes.size,
      split_components: forbidden.splitComponents.size,
    },
    overlapCounts: {
      id: overlaps.id.length,
      family: overlaps.family.length,
      sourceHash: overlaps.sourceHash.length,
      split_component: overlaps.split_component.length,
    },
    overlaps,
  };
}

function summarizeDist(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    min: sorted[0],
    p25: pct(0.25),
    p50: pct(0.5),
    p90: pct(0.9),
    max: sorted.at(-1),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const {values} = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      output: {type: 'string', short: 'o', default: DEFAULT_OUTPUT},
      'audit-output': {type: 'string', default: DEFAULT_AUDIT_OUTPUT},
      'benchmark-jsonl': {type: 'string', default: DEFAULT_BENCHMARK_JSONL},
      'benchmark-manifest': {type: 'string', default: DEFAULT_BENCHMARK_MANIFEST},
      jobs: {type: 'string', default: '6'},
      kind: {type: 'string', default: 'all'},
      limit: {type: 'string'},
      'supervision-audit': {type: 'boolean', default: true},
      help: {type: 'boolean', short: 'h'},
    },
  });

  if (values.help) {
    console.log(`Usage: node tools/tinker-build-frontend-wave2.mjs [options]
  -o, --output <path>             Pre-exported JSONL output (default: ${DEFAULT_OUTPUT})
  --audit-output <path>           Audit JSON summary output (default: ${DEFAULT_AUDIT_OUTPUT})
  --benchmark-jsonl <path>        RealExecBench JSONL for 0-leakage check
  --benchmark-manifest <path>     RealExecBench manifest.json for 0-leakage check
  --jobs <n>                      Parallel verification workers (default: 6)
  --kind <all|single|multifile>   Subset to build (default: all)
  --limit <n>                     Build only first N candidates
  --no-supervision-audit          Skip auditTinkerSupervision pass`);
    process.exit(0);
  }

  const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 6));
  const candidates = await buildAllCandidates({kind: values.kind});
  const selected = values.limit ? candidates.slice(0, Math.max(1, Number(values.limit))) : candidates;

  // Guard unique IDs upfront
  const seenIds = new Set();
  for (const t of selected) {
    if (seenIds.has(t.id)) throw new Error(`Duplicate candidate task ID: ${t.id}`);
    seenIds.add(t.id);
  }

  const results = new Array(selected.length);
  let cursor = 0;
  let failures = 0;
  let completed = 0;

  await Promise.all(Array.from({length: Math.min(jobs, selected.length)}, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= selected.length) break;
      const task = selected[idx];
      try {
        const verified = await exportAndVerifyTaskTwice(task);
        results[idx] = {ok: true, ...verified};
      } catch (err) {
        failures++;
        results[idx] = {ok: false, id: task.id, family: task.family, error: String(err?.message ?? err)};
        process.stderr.write(`FAIL ${task.id}: ${err?.message ?? err}\n`);
      } finally {
        completed++;
        if (completed % 25 === 0 || completed === selected.length) {
          process.stderr.write(`verified ${completed}/${selected.length} (failures=${failures})\n`);
        }
      }
    }
  }));

  if (failures > 0) {
    const failedList = results.filter(r => !r?.ok);
    console.error(JSON.stringify({failures, failedList: failedList.slice(0, 20)}, null, 2));
    process.exit(1);
  }

  const rows = results.map(r => r.row);
  const exportedObjs = results.map(r => r.exported);

  // Full causal supervision audit (verifies future-blindness across all causal pairs!)
  let supervisionAudit = null;
  if (values['supervision-audit'] && exportedObjs.length > 0) {
    const auditResult = await auditTinkerSupervision(exportedObjs, {
      formats: ['compact'],
      samplePerFeature: 1000,
      seed: 17,
    });
    if (!auditResult.valid || !auditResult.success || !auditResult.allReplayed) {
      throw new Error(`auditTinkerSupervision failed: ${JSON.stringify(auditResult.failures)}`);
    }
    supervisionAudit = {
      valid: auditResult.valid,
      allReplayed: auditResult.allReplayed,
      sampleTasks: auditResult.sampleTasks,
      causalPairsVerified: auditResult.causalPairs.length,
      causalDivergencesChecked: auditResult.causalDivergencesChecked,
    };
  }

  // Zero-leakage audit against RealExecBench v1
  const leakageAudit = runZeroLeakageAudit(rows, {
    benchmarkJsonlPath: values['benchmark-jsonl'],
    manifestPath: values['benchmark-manifest'],
  });
  if (!leakageAudit.passed) {
    console.error(JSON.stringify({leakageAudit}, null, 2));
    throw new Error('Zero-leakage audit failed against RealExecBench v1!');
  }

  // Compute rich summary metrics
  const singleRows = rows.filter(r => !r.task.files);
  const mfRows = rows.filter(r => Boolean(r.task.files));
  const mfTsRows = mfRows.filter(r => r.task.language === 'ts');
  const pairGroups = new Map();
  for (const r of rows) {
    if (r.pair_id) {
      if (!pairGroups.has(r.pair_id)) pairGroups.set(r.pair_id, []);
      pairGroups.get(r.pair_id).push(r.id);
    }
  }
  const completePairGroups = [...pairGroups.entries()].filter(([, ids]) => ids.length >= 2);

  const outPath = resolve(values.output);
  const auditPath = resolve(values['audit-output']);
  mkdirSync(dirname(outPath), {recursive: true});
  mkdirSync(dirname(auditPath), {recursive: true});

  writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const auditReport = {
    schema: 'stage10-frontend-wave2-audit/1',
    outputPath: outPath,
    auditPath,
    counts: {
      totalTasks: rows.length,
      singleFileTasks: singleRows.length,
      multiFileTasks: mfRows.length,
      multiFileTsTasks: mfTsRows.length,
      multiFileTsRatio: mfRows.length ? Math.round((mfTsRows.length / mfRows.length) * 1000) / 1000 : 0,
      uniqueFamilies: new Set(rows.map(r => r.family)).size,
      singleFileFamilies: new Set(singleRows.map(r => r.family)).size,
      multiFileFamilies: new Set(mfRows.map(r => r.family)).size,
      uniqueSourceHashes: new Set(rows.map(r => r.sourceHash)).size,
      causalPairGroups: completePairGroups.length,
      causalPairTasks: completePairGroups.reduce((s, [, ids]) => s + ids.length, 0),
      effectfulTasks: rows.filter(r => r.metadata.externalCalls > 0).length,
    },
    preexportedRowCheck: {
      allHaveMessages: rows.every(r => Array.isArray(r.messages) && r.messages.length > 0),
      allHaveSourceHash: rows.every(r => typeof r.sourceHash === 'string' && r.sourceHash.length > 0),
      allHaveTaskObject: rows.every(r => r.task && typeof r.task === 'object'),
      allDeterministic2x: rows.every(r => r.metadata.deterministic2xVerified === true),
    },
    distributions: {
      allEpisodeApproxTokens: summarizeDist(rows.map(r => r.metadata.approxTokens)),
      singleFileEpisodeTokens: summarizeDist(singleRows.map(r => r.metadata.approxTokens)),
      multiFileEpisodeTokens: summarizeDist(mfRows.map(r => r.metadata.approxTokens)),
      multiFileCodebaseTokens: summarizeDist(mfRows.map(r => r.metadata.codebaseApproxTokens)),
      multiFileFileCounts: summarizeDist(mfRows.map(r => r.metadata.fileCount)),
      maxAssistantTurnTokens: summarizeDist(rows.map(r => r.metadata.maxAssistantTurnTokens)),
      assistantTurns: summarizeDist(rows.map(r => r.metadata.assistantTurns)),
    },
    budgets: {
      maxTurnTokenLimit: MAX_TURN_TOKENS,
      maxContextTokenLimit: MAX_CONTEXT_TOKENS,
      maxAssistantTurnsLimit: MAX_ASSISTANT_TURNS,
      allWithinTurnBudget: rows.every(r => r.metadata.maxAssistantTurnTokens <= MAX_TURN_TOKENS),
      allWithinContextBudget: rows.every(r => r.metadata.approxTokens <= MAX_CONTEXT_TOKENS),
      allWithinTurnCountBudget: rows.every(r => r.metadata.assistantTurns <= MAX_ASSISTANT_TURNS),
    },
    supervisionAudit,
    zeroLeakageAudit: leakageAudit,
  };

  writeFileSync(auditPath, JSON.stringify(auditReport, null, 2) + '\n');
  console.log(JSON.stringify(auditReport, null, 2));
  return auditReport;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
