#!/usr/bin/env node
// Generator & verifier for 40 realistic multi-file Browser/DOM Frontend SPA tasks
// (10 distinct application families x 4 variants, including 10 causal diverging pairs
// and a TypeScript multi-file browser SPA family), sized for the 65,536-token window
// (12K-52K tokens, 16-42 files per app with real unloaded distractor modules).
//
// Every task is verified through:
//   - exportTinkerExample(task, {traceFormat: 'compact', reasoningChannel: 'thinking'})
//   - auditTinkerSupervision(..., {formats: ['compact'], samplePerFeature: 1000})
//   - Flexible live student session grading via createTinkerSession()

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import vm from 'node:vm';
import {
  assistantThinkingText,
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
const DEFAULT_OUTPUT = resolve(__dirname, '../runs/long-context-js-65k/frontend-tasks.jsonl');
const MAX_EPISODE_CHARS = 196000;
const MIN_EPISODE_CHARS = 36000;

// ==================== Deterministic Multi-File Browser Fixture Recorder ====================
async function recordMultiFileBrowserFixture({
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
      result = getMap(area).has(key) ? getMap(area).get(key) : null;
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
      const def = opArgs[1] ?? '';
      result = promptIdx < prompts.length ? prompts[promptIdx++] : def;
    }
    calls.push({
      operation: op,
      arguments: encodeReadable(opArgs),
      status: 'fulfilled',
      result: encodeReadable(result),
    });
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
      const errObj = {name: outcome.name ?? 'TypeError', message: outcome.message ?? 'Network request failed'};
      calls.push({
        operation: 'http.request',
        arguments: encodeReadable(norm),
        status: 'rejected',
        result: encodeReadable(errObj),
      });
      throw errObj;
    }
    const payload = {
      status: outcome.status ?? 200,
      statusText: outcome.statusText ?? 'OK',
      url: outcome.url ?? url,
      headers: outcome.headers ?? {'content-type': 'application/json'},
      body: typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body ?? {}),
    };
    calls.push({
      operation: 'http.request',
      arguments: encodeReadable(norm),
      status: 'fulfilled',
      result: encodeReadable(payload),
    });
    return payload;
  };

  const consoleObj = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [
    level,
    (...cArgs) => {
      calls.push({
        operation: 'platform.console.' + level,
        arguments: encodeReadable(cArgs),
        status: 'fulfilled',
        result: encodeReadable(null),
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
      const val = nowIdx < timestamps.length ? timestamps[nowIdx++] : 1730000000000 + nowIdx * 1000;
      calls.push({
        operation: 'platform.dateNow',
        arguments: [],
        status: 'fulfilled',
        result: encodeReadable(val),
      });
      return val;
    },
    console: consoleObj,
    queueMicrotask: cb => queueMicrotask(cb),
  }, {codeGeneration: {strings: false, wasm: false}});

  new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 5000});
  new vm.Script('Date.now = __recDateNow;').runInContext(context, {timeout: 1000});
  new vm.Script(`(function(){let state=17>>>0;
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
    throw new Error(`Recorder guest threw: ${res.value?.message ?? String(res.value)}`);
  }
  return {calls, codeLoadEvents, value: res.value};
}

// ==================== Realistic Distractor Module Factory ====================
const DISTRACTOR_CATALOG = [
  ['pages/settingsPage', 'SettingsPage', ['loadPreferences', 'renderSettingsForm', 'validateNotificationPrefs', 'serializeThemeConfig']],
  ['pages/auditLogPage', 'AuditLogPage', ['fetchAuditEntries', 'formatAuditTimestamp', 'filterAuditByActor', 'renderAuditTable']],
  ['pages/exportWizard', 'ExportWizard', ['buildExportSchema', 'prepareCsvRows', 'renderExportSteps', 'estimatePayloadBytes']],
  ['pages/onboardingGuide', 'OnboardingGuide', ['computeChecklistProgress', 'markStepCompleted', 'renderWelcomeBanner', 'dismissGuide']],
  ['pages/shortcutsModal', 'ShortcutsModal', ['parseKeyCombo', 'matchShortcutBinding', 'renderShortcutLegend', 'formatKeyLabel']],
  ['components/avatarStack', 'AvatarStack', ['computeInitials', 'pickAvatarTone', 'renderAvatarGroup', 'sortByPresence']],
  ['components/commandPalette', 'CommandPalette', ['scoreCommandMatch', 'groupCommandsBySection', 'renderPaletteResults', 'highlightQuery']],
  ['components/notificationsDrawer', 'NotificationsDrawer', ['countUnreadNotices', 'groupByDateBucket', 'renderNoticeCard', 'markBucketRead']],
  ['components/themeSwitcher', 'ThemeSwitcher', ['resolveContrastMode', 'buildCssTokens', 'applyThemeClass', 'readSystemPreference']],
  ['components/helpPopover', 'HelpPopover', ['lookupHelpTopic', 'formatTipCallout', 'positionPopoverAnchor', 'renderHelpCard']],
  ['components/printPreview', 'PrintPreview', ['stripInteractiveControls', 'paginateSections', 'buildPrintHeader', 'renderPrintSheet']],
  ['components/emptyState', 'EmptyState', ['selectIllustrationKey', 'renderEmptyCard', 'buildPrimaryCta', 'describeFilterReset']],
  ['components/breadcrumbs', 'Breadcrumbs', ['splitPathSegments', 'labelSegment', 'truncateCrumbs', 'renderBreadcrumbNav']],
  ['components/paginationBar', 'PaginationBar', ['computePageWindow', 'clampPageIndex', 'renderPageButtons', 'describeRangeSummary']],
  ['components/chartSparkline', 'ChartSparkline', ['normalizeSeries', 'computeMinMax', 'buildSvgPolyline', 'summarizeTrend']],
  ['components/tagPicker', 'TagPicker', ['normalizeTagSlug', 'filterAvailableTags', 'toggleTagSelection', 'renderTagChips']],
  ['utils/i18n', 'I18nCatalog', ['selectLocale', 'interpolateMessage', 'formatPluralRule', 'loadFallbackStrings']],
  ['utils/a11y', 'A11yHelpers', ['computeAriaLabel', 'buildLiveAnnouncement', 'collectFocusableNodes', 'trapFocusOrder']],
  ['utils/diff', 'StateDiff', ['computeObjectPatch', 'summarizeChangedKeys', 'formatDiffSummary', 'hasShallowChanges']],
  ['utils/csv', 'CsvCodec', ['escapeCsvCell', 'encodeCsvTable', 'parseCsvLine', 'inferColumnWidths']],
  ['utils/debounce', 'RateLimiter', ['createDebounceQueue', 'createThrottleGate', 'computeBackoffDelay', 'mergeBatchWindow']],
  ['utils/colors', 'ColorPalette', ['parseHexRgb', 'computeRelativeLuminance', 'contrastRatio', 'pickReadableText']],
  ['services/telemetry', 'TelemetryBuffer', ['createEventEnvelope', 'sanitizeMetricTags', 'batchTelemetryEvents', 'summarizeSessionMetrics']],
  ['services/offlineQueue', 'OfflineQueue', ['enqueueMutation', 'dedupePendingOps', 'sortByLogicalClock', 'estimateQueueAge']],
  ['services/permissions', 'PermissionMatrix', ['expandRoleGrants', 'canPerformAction', 'filterAuthorizedItems', 'describeDeniedReason']],
  ['services/searchIndex', 'SearchIndex', ['tokenizeDocument', 'buildInvertedIndex', 'scoreBm25Lite', 'extractSnippetWindow']],
];

function buildDistractorFiles(domainSlug, count, {ext = 'js', verbose = false} = {}) {
  const isTs = ext === 'ts';
  const files = {};
  for (let i = 0; i < count; i++) {
    const baseEntry = DISTRACTOR_CATALOG[i % DISTRACTOR_CATALOG.length];
    const wave = Math.floor(i / DISTRACTOR_CATALOG.length);
    const [rawRelBase, rawClassName, rawFns] = baseEntry;
    const relBase = wave === 0 ? rawRelBase : `${rawRelBase}V${wave + 1}`;
    const className = wave === 0 ? rawClassName : `${rawClassName}V${wave + 1}`;
    const fns = wave === 0 ? rawFns : rawFns.map(f => `${f}V${wave + 1}`);
    const relPath = `src/${relBase}.${ext}`;
    const typeBlock = isTs
      ? `export interface ${className}Config {\n  namespace: string;\n  enabled: boolean;\n  limit: number;\n  tags: string[];\n}\n\n`
      : '';
    const extraPad = verbose
      ? [
          `export const ${className.toUpperCase()}_DEFAULTS${isTs ? `: ${className}Config` : ''} = {`,
          `  namespace: ${JSON.stringify(domainSlug + ':' + relBase)},`,
          `  enabled: true,`,
          `  limit: ${25 + i * 5},`,
          `  tags: [${JSON.stringify(domainSlug)}, ${JSON.stringify(relBase.split('/')[1])}, 'ui', 'v2'],`,
          `};`,
          '',
          `export function inspect${className}State(records${isTs ? ': Array<Record<string, unknown>>' : ''}, opts${isTs ? ': Partial<' + className + 'Config>' : ''} = {}) {`,
          `  const limit = Number(opts.limit ?? ${className.toUpperCase()}_DEFAULTS.limit);`,
          `  const active = [];`,
          `  const archived = [];`,
          `  for (let idx = 0; idx < records.length && idx < limit; idx++) {`,
          `    const item = records[idx];`,
          `    if (!item || item.archived) archived.push(item);`,
          `    else active.push({index: idx, id: String(item.id ?? idx), label: String(item.title ?? item.name ?? 'item')});`,
          `  }`,
          `  return {namespace: ${className.toUpperCase()}_DEFAULTS.namespace, activeCount: active.length, archivedCount: archived.length, active};`,
          `}`,
          '',
        ].join('\n')
      : '';

    const fnBlocks = fns.map((fn, fi) => [
      `export function ${fn}(input${isTs ? ': Record<string, unknown>' : ''}, options${isTs ? ': Record<string, unknown>' : ''} = {}) {`,
      `  const base = input && typeof input === 'object' ? input : {value: input};`,
      `  const seed = ${i * 17 + fi * 7 + 3};`,
      `  const keys = Object.keys(base).sort();`,
      `  const summary = keys.map(k => k + '=' + String(base[k])).join('|');`,
      `  return {`,
      `    module: ${JSON.stringify(relBase)},`,
      `    op: ${JSON.stringify(fn)},`,
      `    domain: ${JSON.stringify(domainSlug)},`,
      `    seed,`,
      `    count: keys.length,`,
      `    summary,`,
      `    flags: Object.keys(options || {}).sort(),`,
      `  };`,
      `}`,
    ].join('\n')).join('\n\n');

    files[relPath] = `${typeBlock}${extraPad}${fnBlocks}\n`;
  }
  return files;
}

// Helper to add rich secondary exported helpers inside an active module so large-variant
// modules cross WHOLE_FILE_LOAD_MAX_BYTES (3072 B) and trigger symbol-level code.load.
function makeLargeModulePadding(moduleTag, blocks = 14, isTs = false) {
  const lines = [];
  for (let i = 0; i < blocks; i++) {
    lines.push(
      `export function ${moduleTag}AuxHelper${i}(items${isTs ? ': Array<Record<string, unknown>>' : ''}, threshold${isTs ? ': number' : ''} = ${10 + i * 3}) {`,
      `  const kept = [];`,
      `  let score = 0;`,
      `  for (const row of items || []) {`,
      `    const weight = Number(row?.weight ?? row?.priority ?? ${i + 1});`,
      `    if (weight >= threshold) {`,
      `      kept.push({id: String(row?.id ?? 'row-' + kept.length), weight, bucket: ${JSON.stringify(moduleTag + '-' + i)}});`,
      `      score += weight;`,
      `    }`,
      `  }`,
      `  return {bucket: ${JSON.stringify(moduleTag + '-' + i)}, count: kept.length, score, kept};`,
      `}`,
    );
  }
  return lines.join('\n') + '\n';
}

// ==================== Shared Multi-File SPA Architecture Builder ====================
// Builds domain-customized multi-file frontend apps where every domain has its own
// realistic HTML, store, router, storage, validators, formatters, API client, DOM helpers,
// 5-7 domain UI components, and 10-26 domain distractors.
function buildDomainSpa({
  domain,
  title,
  entityName,
  pluralName,
  apiBase,
  urlBase,
  storagePrefix,
  statuses,
  priorities,
  categories,
  confirmVerb,
  promptLabel,
  promptDefault,
  extraMetrics,
  distractorCount,
  largeModules,
  verboseDistractors,
  useTypeScript = false,
  richWorkflow = false,
  xlWorkflow = false,
  enableTimerStep = false,
  enableConsoleWarn = false,
}) {
  const ext = useTypeScript ? 'ts' : 'js';
  const T = (tsAnnot) => (useTypeScript ? tsAnnot : '');
  const pad = (tag, n) => (largeModules ? '\n' + makeLargeModulePadding(tag, n, useTypeScript) : '');

  const files = {};

  // 1. Optional TypeScript types file
  if (useTypeScript) {
    files['src/types.ts'] = [
      `export interface ${entityName}Record {`,
      `  id: string;`,
      `  title: string;`,
      `  status: string;`,
      `  priority: string;`,
      `  category: string;`,
      `  owner: string;`,
      `  amount: number;`,
      `  tags: string[];`,
      `  note?: string;`,
      `}`,
      ``,
      `export interface AppFilterState {`,
      `  status: string;`,
      `  category: string;`,
      `  query: string;`,
      `  sortBy: string;`,
      `}`,
      ``,
      `export interface WorkflowInput {`,
      `  actor: string;`,
      `  route: string;`,
      `  filterStatus: string;`,
      `  filterCategory: string;`,
      `  searchQuery: string;`,
      `  newItem: {`,
      `    id: string;`,
      `    title: string;`,
      `    priority: string;`,
      `    category: string;`,
      `    amount: number;`,
      `    tags: string[];`,
      `  };`,
      `  transitionTargetId: string;`,
      `  targetStatus: string;`,
      `  bulkArchive: boolean;`,
      `}`,
    ].join('\n') + '\n';
  }

  // 2. Constants & config
  files[`src/config.${ext}`] = [
    `export const APP_DOMAIN = ${JSON.stringify(domain)};`,
    `export const API_BASE = ${JSON.stringify(apiBase)};`,
    `export const STORAGE_PREFIX = ${JSON.stringify(storagePrefix)};`,
    `export const VALID_STATUSES = ${JSON.stringify(statuses)};`,
    `export const VALID_PRIORITIES = ${JSON.stringify(priorities)};`,
    `export const VALID_CATEGORIES = ${JSON.stringify(categories)};`,
    `export const PRIORITY_WEIGHTS${T(': Record<string, number>')} = {`,
    ...priorities.map((p, idx) => `  ${JSON.stringify(p)}: ${(priorities.length - idx) * 10},`),
    `};`,
    `export const DOMAIN_LIMITS = {`,
    `  maxTitleLen: 72,`,
    `  minTitleLen: 4,`,
    `  maxAmount: 50000,`,
    `  maxBatchItems: 25,`,
    `  slaThreshold: 2500,`,
    `};`,
    pad(domain + 'Cfg', largeModules ? 10 : 0),
  ].join('\n');

  // 3. Storage module (localStorage + sessionStorage)
  files[`src/storage.${ext}`] = [
    `import { STORAGE_PREFIX } from './config.${ext}';`,
    ``,
    `export function readSessionContext() {`,
    `  const token = sessionStorage.getItem(STORAGE_PREFIX + ':token') || 'anon-session';`,
    `  const role = sessionStorage.getItem(STORAGE_PREFIX + ':role') || 'viewer';`,
    `  return { token, role };`,
    `}`,
    ``,
    `export function readSavedViewPrefs() {`,
    `  const raw = localStorage.getItem(STORAGE_PREFIX + ':prefs');`,
    `  if (!raw) return { sortBy: 'priority', compact: false, pinnedIds: [] };`,
    `  try {`,
    `    const parsed = JSON.parse(raw);`,
    `    return {`,
    `      sortBy: typeof parsed.sortBy === 'string' ? parsed.sortBy : 'priority',`,
    `      compact: Boolean(parsed.compact),`,
    `      pinnedIds: Array.isArray(parsed.pinnedIds) ? parsed.pinnedIds : [],`,
    `    };`,
    `  } catch {`,
    `    return { sortBy: 'priority', compact: false, pinnedIds: [] };`,
    `  }`,
    `}`,
    ``,
    `export function persistWorkspaceState(summary${T(': Record<string, unknown>')}) {`,
    `  localStorage.setItem(STORAGE_PREFIX + ':lastSummary', JSON.stringify(summary));`,
    `  return STORAGE_PREFIX + ':lastSummary';`,
    `}`,
    ``,
    `export function clearDraftCache(actor${T(': string')}) {`,
    `  sessionStorage.removeItem(STORAGE_PREFIX + ':draft:' + actor);`,
    `}`,
    pad(domain + 'StoreIo', largeModules ? 10 : 0),
  ].join('\n');

  // 4. Router module (history.pushState / replaceState + URL query parsing)
  files[`src/router.${ext}`] = [
    `export function parseCurrentRoute() {`,
    `  const params = new URLSearchParams(location.search);`,
    `  return {`,
    `    pathname: location.pathname,`,
    `    view: params.get('view') || 'overview',`,
    `    status: params.get('status') || 'all',`,
    `    category: params.get('category') || 'all',`,
    `    hash: location.hash || '',`,
    `  };`,
    `}`,
    ``,
    `export function navigateToRoute(path${T(': string')}, query${T(': Record<string, string>')}, state${T(': Record<string, unknown>')}) {`,
    `  const usp = new URLSearchParams();`,
    `  for (const key of Object.keys(query).sort()) {`,
    `    if (query[key] !== undefined && query[key] !== '' && query[key] !== 'all') {`,
    `      usp.set(key, String(query[key]));`,
    `    }`,
    `  }`,
    `  const suffix = usp.toString() ? '?' + usp.toString() : '';`,
    `  history.pushState(state, '', path + suffix);`,
    `  return { href: location.href, pathname: location.pathname, search: location.search, historyLen: history.length };`,
    `}`,
    ``,
    `export function syncHashAnchor(anchor${T(': string')}, state${T(': Record<string, unknown>')}) {`,
    `  const nextUrl = location.pathname + location.search + '#' + anchor;`,
    `  history.replaceState(state, '', nextUrl);`,
    `  return location.hash;`,
    `}`,
    pad(domain + 'Router', largeModules ? 10 : 0),
  ].join('\n');

  // 5. Validators module
  files[`src/validators.${ext}`] = [
    `import { DOMAIN_LIMITS, VALID_CATEGORIES, VALID_PRIORITIES, VALID_STATUSES } from './config.${ext}';`,
    ``,
    `export function validateRecordInput(draft${T(': any')}) {`,
    `  const errors${T(': string[]')} = [];`,
    `  const title = String(draft?.title ?? '').trim();`,
    `  if (title.length < DOMAIN_LIMITS.minTitleLen) errors.push('title:too-short');`,
    `  if (title.length > DOMAIN_LIMITS.maxTitleLen) errors.push('title:too-long');`,
    `  if (!VALID_PRIORITIES.includes(draft?.priority)) errors.push('priority:invalid');`,
    `  if (!VALID_CATEGORIES.includes(draft?.category)) errors.push('category:invalid');`,
    `  const amount = Number(draft?.amount ?? 0);`,
    `  if (!Number.isFinite(amount) || amount < 0 || amount > DOMAIN_LIMITS.maxAmount) errors.push('amount:out-of-range');`,
    `  return {`,
    `    valid: errors.length === 0,`,
    `    errors,`,
    `    normalized: {`,
    `      id: String(draft?.id || 'tmp-1'),`,
    `      title,`,
    `      status: VALID_STATUSES[0],`,
    `      priority: VALID_PRIORITIES.includes(draft?.priority) ? draft.priority : VALID_PRIORITIES[VALID_PRIORITIES.length - 1],`,
    `      category: VALID_CATEGORIES.includes(draft?.category) ? draft.category : VALID_CATEGORIES[0],`,
    `      amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,`,
    `      tags: Array.isArray(draft?.tags) ? draft.tags.map((t${T(': any')}) => String(t).trim().toLowerCase()).filter(Boolean) : [],`,
    `    },`,
    `  };`,
    `}`,
    ``,
    `export function validateStatusTransition(fromStatus${T(': string')}, toStatus${T(': string')}) {`,
    `  if (!VALID_STATUSES.includes(fromStatus) || !VALID_STATUSES.includes(toStatus)) {`,
    `    return { allowed: false, reason: 'unknown-status' };`,
    `  }`,
    `  if (fromStatus === toStatus) {`,
    `    return { allowed: false, reason: 'no-op-transition' };`,
    `  }`,
    `  const fromIdx = VALID_STATUSES.indexOf(fromStatus);`,
    `  const toIdx = VALID_STATUSES.indexOf(toStatus);`,
    `  if (fromIdx === VALID_STATUSES.length - 1 && toIdx === 0) {`,
    `    return { allowed: false, reason: 'cannot-reopen-terminal' };`,
    `  }`,
    `  return { allowed: true, reason: 'ok', delta: toIdx - fromIdx };`,
    `}`,
    pad(domain + 'Valid', largeModules ? 14 : 0),
  ].join('\n');

  // 6. Formatters & scoring helpers
  files[`src/formatters.${ext}`] = [
    `import { PRIORITY_WEIGHTS, DOMAIN_LIMITS } from './config.${ext}';`,
    ``,
    `export function formatMoney(amount${T(': number')}) {`,
    `  const n = Math.round(Number(amount || 0) * 100) / 100;`,
    `  return '$' + n.toFixed(2);`,
    `}`,
    ``,
    `export function computeRecordScore(rec${T(': any')}, pinnedIds${T(': string[]')} = []) {`,
    `  const pWeight = PRIORITY_WEIGHTS[rec.priority] ?? 10;`,
    `  const tagBonus = Array.isArray(rec.tags) ? rec.tags.length * 4 : 0;`,
    `  const amountBonus = Math.min(40, Math.floor(Number(rec.amount || 0) / 250));`,
    `  const pinBonus = pinnedIds.includes(rec.id) ? 15 : 0;`,
    `  const slaFlag = Number(rec.amount || 0) >= DOMAIN_LIMITS.slaThreshold ? 10 : 0;`,
    `  return pWeight + tagBonus + amountBonus + pinBonus + slaFlag;`,
    `}`,
    ``,
    `export function summarizeMetrics(records${T(': any[]')}, pinnedIds${T(': string[]')} = []) {`,
    `  const byStatus${T(': Record<string, number>')} = {};`,
    `  const byCategory${T(': Record<string, number>')} = {};`,
    `  let totalAmount = 0;`,
    `  let totalScore = 0;`,
    `  let highRiskCount = 0;`,
    `  for (const r of records) {`,
    `    byStatus[r.status] = (byStatus[r.status] || 0) + 1;`,
    `    byCategory[r.category] = (byCategory[r.category] || 0) + 1;`,
    `    totalAmount += Number(r.amount || 0);`,
    `    const sc = computeRecordScore(r, pinnedIds);`,
    `    totalScore += sc;`,
    `    if (sc >= 50) highRiskCount++;`,
    `  }`,
    `  return {`,
    `    count: records.length,`,
    `    totalAmount: Math.round(totalAmount * 100) / 100,`,
    `    formattedTotal: formatMoney(totalAmount),`,
    `    avgScore: records.length ? Math.round((totalScore / records.length) * 10) / 10 : 0,`,
    `    highRiskCount,`,
    `    byStatus,`,
    `    byCategory,`,
    `    metricTag: ${JSON.stringify(extraMetrics)},`,
    `  };`,
    `}`,
    pad(domain + 'Fmt', largeModules ? 14 : 0),
  ].join('\n');

  // 7. Store module (reactive state + selectors)
  files[`src/store.${ext}`] = [
    `import { PRIORITY_WEIGHTS } from './config.${ext}';`,
    `import { computeRecordScore } from './formatters.${ext}';`,
    ``,
    `export function createWorkspaceStore(initialRecords${T(': any[]')}, initialPrefs${T(': any')}) {`,
    `  let state = {`,
    `    records: initialRecords.map((r${T(': any')}) => ({ ...r, tags: Array.isArray(r.tags) ? [...r.tags] : [] })),`,
    `    filter: { status: 'all', category: 'all', query: '', sortBy: initialPrefs.sortBy || 'priority' },`,
    `    pinnedIds: Array.isArray(initialPrefs.pinnedIds) ? [...initialPrefs.pinnedIds] : [],`,
    `    selectedId: initialRecords[0]?.id ?? null,`,
    `    history: []${T(' as string[]')},`,
    `    banner: 'ready',`,
    `  };`,
    `  const listeners${T(': Array<(s: any) => void>')} = [];`,
    ``,
    `  function emit(tag${T(': string')}) {`,
    `    state.history.push(tag);`,
    `    for (const fn of listeners) fn(state);`,
    `  }`,
    ``,
    `  return {`,
    `    getState() { return state; },`,
    `    subscribe(fn${T(': (s: any) => void')}) { listeners.push(fn); },`,
    `    setFilter(patch${T(': Record<string, string>')}) {`,
    `      state = { ...state, filter: { ...state.filter, ...patch } };`,
    `      emit('filter:' + state.filter.status + ':' + state.filter.category);`,
    `    },`,
    `    addRecord(rec${T(': any')}) {`,
    `      state = { ...state, records: [...state.records, rec], selectedId: rec.id };`,
    `      emit('add:' + rec.id);`,
    `    },`,
    `    updateRecordStatus(id${T(': string')}, nextStatus${T(': string')}, note${T(': string')} = '') {`,
    `      state = {`,
    `        ...state,`,
    `        records: state.records.map((r${T(': any')}) => r.id === id ? { ...r, status: nextStatus, ...(note ? { note } : {}) } : r),`,
    `        selectedId: id,`,
    `      };`,
    `      emit('status:' + id + '->' + nextStatus);`,
    `    },`,
    `    replaceRecords(records${T(': any[]')}, banner${T(': string')}) {`,
    `      state = { ...state, records: records.map((r${T(': any')}) => ({ ...r })), banner };`,
    `      emit('sync:' + banner);`,
    `    },`,
    `    setBanner(banner${T(': string')}) {`,
    `      state = { ...state, banner };`,
    `      emit('banner:' + banner);`,
    `    },`,
    `    selectVisible() {`,
    `      const q = state.filter.query.trim().toLowerCase();`,
    `      const filtered = state.records.filter((r${T(': any')}) => {`,
    `        if (state.filter.status !== 'all' && r.status !== state.filter.status) return false;`,
    `        if (state.filter.category !== 'all' && r.category !== state.filter.category) return false;`,
    `        if (q && !r.title.toLowerCase().includes(q) && !r.tags.some((t${T(': string')}) => t.includes(q))) return false;`,
    `        return true;`,
    `      });`,
    `      filtered.sort((a${T(': any')}, b${T(': any')}) => {`,
    `        if (state.filter.sortBy === 'amount') return (b.amount - a.amount) || a.id.localeCompare(b.id);`,
    `        const sa = computeRecordScore(a, state.pinnedIds);`,
    `        const sb = computeRecordScore(b, state.pinnedIds);`,
    `        return (sb - sa) || ((PRIORITY_WEIGHTS[b.priority] ?? 0) - (PRIORITY_WEIGHTS[a.priority] ?? 0)) || a.id.localeCompare(b.id);`,
    `      });`,
    `      return filtered;`,
    `    },`,
    `  };`,
    `}`,
    pad(domain + 'Store', largeModules ? 16 : 0),
  ].join('\n');

  // 8. API client module (fetch -> http.request)
  files[`src/api.${ext}`] = [
    `import { API_BASE } from './config.${ext}';`,
    ``,
    `export async function fetchRemoteRecords(token${T(': string')}, query${T(': Record<string, string>')}) {`,
    `  const usp = new URLSearchParams();`,
    `  for (const k of Object.keys(query).sort()) {`,
    `    if (query[k]) usp.set(k, query[k]);`,
    `  }`,
    `  const url = API_BASE + '/items' + (usp.toString() ? '?' + usp.toString() : '');`,
    `  const resp = await fetch(url, {`,
    `    method: 'GET',`,
    `    headers: { 'accept': 'application/json', 'x-auth-token': token },`,
    `  });`,
    `  const data = await resp.json();`,
    `  return { ok: resp.ok, status: resp.status, data };`,
    `}`,
    ``,
    `export async function commitWorkspaceAction(token${T(': string')}, actionPayload${T(': Record<string, unknown>')}) {`,
    `  const url = API_BASE + '/commit';`,
    `  const resp = await fetch(url, {`,
    `    method: 'POST',`,
    `    headers: { 'content-type': 'application/json', 'x-auth-token': token },`,
    `    body: JSON.stringify(actionPayload),`,
    `  });`,
    `  const data = await resp.json();`,
    `  return { ok: resp.ok, status: resp.status, data };`,
    `}`,
    pad(domain + 'Api', largeModules ? 10 : 0),
  ].join('\n');

  // 9. DOM utility module
  files[`src/dom.${ext}`] = [
    `export function el(tag${T(': string')}, attrs${T(': Record<string, string>')} = {}, text${T(': string')} = '') {`,
    `  const node = document.createElement(tag);`,
    `  for (const [k, v] of Object.entries(attrs)) {`,
    `    if (k === 'className') node.className = v;`,
    `    else if (k.startsWith('data-')) node.setAttribute(k, v);`,
    `    else node.setAttribute(k, v);`,
    `  }`,
    `  if (text) node.textContent = text;`,
    `  return node;`,
    `}`,
    ``,
    `export function readSeedRecordsFromDom() {`,
    `  const rows = document.querySelectorAll('#record-list > li[data-record-id]');`,
    `  return rows.map((li${T(': any')}) => ({`,
    `    id: li.dataset.recordId,`,
    `    title: li.querySelector('.rec-title')?.textContent?.trim() || '',`,
    `    status: li.dataset.status || ${JSON.stringify(statuses[0])},`,
    `    priority: li.dataset.priority || ${JSON.stringify(priorities[1] ?? priorities[0])},`,
    `    category: li.dataset.category || ${JSON.stringify(categories[0])},`,
    `    owner: li.dataset.owner || 'unassigned',`,
    `    amount: Number(li.dataset.amount || 0),`,
    `    tags: (li.dataset.tags || '').split(',').map((s${T(': string')}) => s.trim()).filter(Boolean),`,
    `  }));`,
    `}`,
    ``,
    `export function setTextById(id${T(': string')}, value${T(': string')}) {`,
    `  const node = document.getElementById(id);`,
    `  if (node) node.textContent = value;`,
    `}`,
    pad(domain + 'Dom', largeModules ? 10 : 0),
  ].join('\n');

  // 10. Component: Header & KPI Summary
  files[`src/components/headerBar.${ext}`] = [
    `import { summarizeMetrics } from '../formatters.${ext}';`,
    `import { setTextById } from '../dom.${ext}';`,
    ``,
    `export function renderHeaderSummary(state${T(': any')}, actor${T(': string')}, role${T(': string')}) {`,
    `  const metrics = summarizeMetrics(state.records, state.pinnedIds);`,
    `  setTextById('actor-badge', actor + ' (' + role + ')');`,
    `  setTextById('kpi-total', String(metrics.count));`,
    `  setTextById('kpi-amount', metrics.formattedTotal);`,
    `  setTextById('kpi-risk', String(metrics.highRiskCount));`,
    `  setTextById('banner-status', state.banner);`,
    `  document.title = ${JSON.stringify(title)} + ' [' + metrics.count + ']';`,
    `  return metrics;`,
    `}`,
    pad(domain + 'Hdr', largeModules ? 10 : 0),
  ].join('\n');

  // 11. Component: Filter Bar
  files[`src/components/filterBar.${ext}`] = [
    `export function bindFilterControls(store${T(': any')}) {`,
    `  const statusSel = document.getElementById('filter-status');`,
    `  const catSel = document.getElementById('filter-category');`,
    `  const searchInp = document.getElementById('filter-search');`,
    `  if (statusSel) {`,
    `    statusSel.addEventListener('change', () => {`,
    `      store.setFilter({ status: statusSel.value });`,
    `    });`,
    `  }`,
    `  if (catSel) {`,
    `    catSel.addEventListener('change', () => {`,
    `      store.setFilter({ category: catSel.value });`,
    `    });`,
    `  }`,
    `  if (searchInp) {`,
    `    searchInp.addEventListener('input', () => {`,
    `      store.setFilter({ query: searchInp.value });`,
    `    });`,
    `  }`,
    `}`,
    ``,
    `export function applyFilterValues(status${T(': string')}, category${T(': string')}, query${T(': string')}) {`,
    `  const statusSel = document.getElementById('filter-status');`,
    `  const catSel = document.getElementById('filter-category');`,
    `  const searchInp = document.getElementById('filter-search');`,
    `  if (statusSel) {`,
    `    statusSel.value = status;`,
    `    statusSel.dispatchEvent(new Event('change', { bubbles: true }));`,
    `  }`,
    `  if (catSel) {`,
    `    catSel.value = category;`,
    `    catSel.dispatchEvent(new Event('change', { bubbles: true }));`,
    `  }`,
    `  if (searchInp) {`,
    `    searchInp.value = query;`,
    `    searchInp.dispatchEvent(new InputEvent('input', { bubbles: true, data: query }));`,
    `  }`,
    `}`,
    pad(domain + 'Flt', largeModules ? 10 : 0),
  ].join('\n');

  // 12. Component: Record List Renderer
  files[`src/components/recordList.${ext}`] = [
    `import { el } from '../dom.${ext}';`,
    `import { formatMoney, computeRecordScore } from '../formatters.${ext}';`,
    ``,
    `export function renderRecordList(records${T(': any[]')}, selectedId${T(': string | null')}, pinnedIds${T(': string[]')} = []) {`,
    `  const ul = document.getElementById('record-list');`,
    `  if (!ul) return 0;`,
    `  ul.innerHTML = '';`,
    `  const frag = document.createDocumentFragment();`,
    `  for (const rec of records) {`,
    `    const score = computeRecordScore(rec, pinnedIds);`,
    `    const li = el('li', {`,
    `      className: 'record-row' + (rec.id === selectedId ? ' selected' : '') + (pinnedIds.includes(rec.id) ? ' pinned' : ''),`,
    `      'data-record-id': rec.id,`,
    `      'data-status': rec.status,`,
    `      'data-priority': rec.priority,`,
    `      'data-category': rec.category,`,
    `      'data-score': String(score),`,
    `    });`,
    `    li.appendChild(el('span', { className: 'rec-title' }, rec.title));`,
    `    li.appendChild(el('span', { className: 'rec-meta' }, rec.status + ' | ' + rec.priority + ' | ' + formatMoney(rec.amount)));`,
    `    if (rec.note) {`,
    `      li.appendChild(el('em', { className: 'rec-note' }, rec.note));`,
    `    }`,
    `    frag.appendChild(li);`,
    `  }`,
    `  ul.appendChild(frag);`,
    `  return records.length;`,
    `}`,
    pad(domain + 'List', largeModules ? 14 : 0),
  ].join('\n');

  // 13. Component: Detail Drawer & Toast
  files[`src/components/detailDrawer.${ext}`] = [
    `import { formatMoney, computeRecordScore } from '../formatters.${ext}';`,
    `import { setTextById } from '../dom.${ext}';`,
    ``,
    `export function renderDetailDrawer(record${T(': any')}, pinnedIds${T(': string[]')} = []) {`,
    `  const panel = document.getElementById('detail-drawer');`,
    `  if (!panel) return null;`,
    `  if (!record) {`,
    `    panel.dataset.activeId = '';`,
    `    setTextById('detail-title', 'No selection');`,
    `    setTextById('detail-body', '');`,
    `    return null;`,
    `  }`,
    `  const score = computeRecordScore(record, pinnedIds);`,
    `  panel.dataset.activeId = record.id;`,
    `  panel.classList.add('open');`,
    `  setTextById('detail-title', record.id + ': ' + record.title);`,
    `  setTextById('detail-body', [`,
    `    'status=' + record.status,`,
    `    'priority=' + record.priority,`,
    `    'category=' + record.category,`,
    `    'amount=' + formatMoney(record.amount),`,
    `    'score=' + score,`,
    `    ...(record.note ? ['note=' + record.note] : []),`,
    `  ].join('; '));`,
    `  return { id: record.id, score };`,
    `}`,
    ``,
    `export function pushToast(message${T(': string')}, level${T(': string')} = 'info') {`,
    `  const host = document.getElementById('toast-region');`,
    `  if (!host) return;`,
    `  const item = document.createElement('div');`,
    `  item.className = 'toast toast-' + level;`,
    `  item.textContent = message;`,
    `  host.appendChild(item);`,
    `}`,
    pad(domain + 'Detail', largeModules ? 10 : 0),
  ].join('\n');

  // 14. Component: Audit & Compliance Panel (loaded on richWorkflow or status transition)
  files[`src/components/compliancePanel.${ext}`] = [
    `import { validateStatusTransition } from '../validators.${ext}';`,
    `import { setTextById } from '../dom.${ext}';`,
    ``,
    `export function evaluateTransitionCheck(records${T(': any[]')}, targetId${T(': string')}, targetStatus${T(': string')}) {`,
    `  const rec = records.find((r${T(': any')}) => r.id === targetId);`,
    `  if (!rec) return { ok: false, reason: 'missing-record', targetId };`,
    `  const check = validateStatusTransition(rec.status, targetStatus);`,
    `  setTextById('compliance-note', check.allowed ? (targetId + ':' + rec.status + '->' + targetStatus) : ('blocked:' + check.reason));`,
    `  return { ok: check.allowed, reason: check.reason, fromStatus: rec.status, toStatus: targetStatus, amount: rec.amount };`,
    `}`,
    pad(domain + 'Comply', largeModules ? 12 : 0),
  ].join('\n');

  // 15. Optional Rich Workflow Insights Panel (loaded when richWorkflow is true)
  files[`src/components/insightsPanel.${ext}`] = [
    `import { computeRecordScore, formatMoney } from '../formatters.${ext}';`,
    `import { el } from '../dom.${ext}';`,
    ``,
    `export function renderInsightsBreakdown(records${T(': any[]')}, pinnedIds${T(': string[]')} = []) {`,
    `  const container = document.getElementById('insights-panel');`,
    `  const ranked = records.map((r${T(': any')}) => ({ id: r.id, score: computeRecordScore(r, pinnedIds), amount: r.amount }));`,
    `  ranked.sort((a${T(': any')}, b${T(': any')}) => (b.score - a.score) || a.id.localeCompare(b.id));`,
    `  const top = ranked.slice(0, 3);`,
    `  if (container) {`,
    `    container.innerHTML = '';`,
    `    for (const item of top) {`,
    `      container.appendChild(el('span', { className: 'insight-chip', 'data-id': item.id }, item.id + ':' + item.score + ':' + formatMoney(item.amount)));`,
    `    }`,
    `  }`,
    `  return { topIds: top.map((x${T(': any')}) => x.id), topScore: top[0]?.score ?? 0 };`,
    `}`,
    pad(domain + 'Insights', largeModules ? 12 : 0),
  ].join('\n');

  // 15b. Extra active modules for XL long-context workflows (loaded on xlWorkflow)
  if (xlWorkflow) {
    files[`src/components/activityFeed.${ext}`] = [
      `import { el } from '../dom.${ext}';`,
      `import { formatMoney } from '../formatters.${ext}';`,
      ``,
      `export function buildActivityEntries(records${T(': any[]')}, history${T(': string[]')}, actor${T(': string')}) {`,
      `  const entries${T(': Array<{seq: number, label: string, severity: string}>')} = [];`,
      `  for (let i = 0; i < history.length; i++) {`,
      `    const ev = history[i];`,
      `    const severity = ev.startsWith('status:') ? 'high' : ev.startsWith('add:') ? 'medium' : 'info';`,
      `    entries.push({ seq: i + 1, label: actor + '@' + ev, severity });`,
      `  }`,
      `  for (const r of records) {`,
      `    if (r.amount >= 3000) {`,
      `      entries.push({ seq: entries.length + 1, label: 'threshold:' + r.id + ':' + formatMoney(r.amount), severity: 'warn' });`,
      `    }`,
      `  }`,
      `  return entries;`,
      `}`,
      ``,
      `export function renderActivityFeed(entries${T(': any[]')}) {`,
      `  const feed = document.getElementById('activity-feed');`,
      `  if (feed) {`,
      `    feed.innerHTML = '';`,
      `    for (const e of entries) {`,
      `      feed.appendChild(el('li', { className: 'feed-item sev-' + e.severity, 'data-seq': String(e.seq) }, e.label));`,
      `    }`,
      `  }`,
      `  return entries.length;`,
      `}`,
      pad(domain + 'Feed', 12),
    ].join('\n');

    files[`src/components/policyEngine.${ext}`] = [
      `import { DOMAIN_LIMITS, PRIORITY_WEIGHTS } from '../config.${ext}';`,
      ``,
      `export function evaluatePortfolioPolicy(records${T(': any[]')}, role${T(': string')}) {`,
      `  const alerts${T(': string[]')} = [];`,
      `  let weightedExposure = 0;`,
      `  let slaViolations = 0;`,
      `  const categoryTotals${T(': Record<string, number>')} = {};`,
      `  for (const r of records) {`,
      `    const w = PRIORITY_WEIGHTS[r.priority] ?? 10;`,
      `    weightedExposure += Math.round((Number(r.amount || 0) * w) / 10);`,
      `    categoryTotals[r.category] = (categoryTotals[r.category] || 0) + Number(r.amount || 0);`,
      `    if (Number(r.amount || 0) >= DOMAIN_LIMITS.slaThreshold) {`,
      `      slaViolations++;`,
      `      alerts.push('sla:' + r.id);`,
      `    }`,
      `  }`,
      `  const approvalTier = weightedExposure >= 60000 ? 'director' : weightedExposure >= 25000 ? 'manager' : 'standard';`,
      `  const authorized = role === 'commander' || role === 'admin' || approvalTier === 'standard';`,
      `  return { approvalTier, authorized, weightedExposure, slaViolations, alertCount: alerts.length, categoryTotals };`,
      `}`,
      pad(domain + 'Policy', 12),
    ].join('\n');

    files[`src/components/exportDigest.${ext}`] = [
      `import { formatMoney, computeRecordScore } from '../formatters.${ext}';`,
      `import { setTextById } from '../dom.${ext}';`,
      ``,
      `export function buildWorkspaceDigest(records${T(': any[]')}, pinnedIds${T(': string[]')}, policy${T(': any')}) {`,
      `  const rows = records.map((r${T(': any')}) => ({`,
      `    id: r.id,`,
      `    score: computeRecordScore(r, pinnedIds),`,
      `    money: formatMoney(r.amount),`,
      `    status: r.status,`,
      `  }));`,
      `  rows.sort((a${T(': any')}, b${T(': any')}) => (b.score - a.score) || a.id.localeCompare(b.id));`,
      `  const headline = rows.slice(0, 3).map((r${T(': any')}) => r.id + '(' + r.score + ')').join(', ');`,
      `  const digestText = policy.approvalTier + ' | ' + headline + ' | exp=' + policy.weightedExposure;`,
      `  setTextById('digest-bar', digestText);`,
      `  return { headline, rowCount: rows.length, approvalTier: policy.approvalTier, digestText };`,
      `}`,
      pad(domain + 'Digest', 12),
    ].join('\n');

    // Four rich whole-file-sized (~2.6-2.9KB) enterprise SPA modules executed on XL runs
    files[`src/components/analyticsMatrix.${ext}`] = [
      `import { VALID_CATEGORIES, VALID_STATUSES, PRIORITY_WEIGHTS } from '../config.${ext}';`,
      `import { computeRecordScore, formatMoney } from '../formatters.${ext}';`,
      `import { el } from '../dom.${ext}';`,
      ``,
      `export function buildCrossTabMatrix(records${T(': any[]')}, pinnedIds${T(': string[]')} = []) {`,
      `  const matrix${T(': Record<string, Record<string, {count: number, amount: number, topScore: number}>>')} = {};`,
      `  for (const cat of VALID_CATEGORIES) {`,
      `    matrix[cat] = {};`,
      `    for (const st of VALID_STATUSES) {`,
      `      matrix[cat][st] = { count: 0, amount: 0, topScore: 0 };`,
      `    }`,
      `  }`,
      `  let hottestCell = { category: VALID_CATEGORIES[0], status: VALID_STATUSES[0], score: -1 };`,
      `  for (const rec of records) {`,
      `    const cat = matrix[rec.category] ? rec.category : VALID_CATEGORIES[0];`,
      `    const st = matrix[cat][rec.status] ? rec.status : VALID_STATUSES[0];`,
      `    const cell = matrix[cat][st];`,
      `    const score = computeRecordScore(rec, pinnedIds);`,
      `    cell.count += 1;`,
      `    cell.amount = Math.round((cell.amount + Number(rec.amount || 0)) * 100) / 100;`,
      `    if (score > cell.topScore) cell.topScore = score;`,
      `    const weight = (PRIORITY_WEIGHTS[rec.priority] ?? 10) + score;`,
      `    if (weight > hottestCell.score) hottestCell = { category: cat, status: st, score: weight };`,
      `  }`,
      `  return { matrix, hottestCell, totalCells: VALID_CATEGORIES.length * VALID_STATUSES.length };`,
      `}`,
      ``,
      `export function renderAnalyticsMatrix(summary${T(': any')}) {`,
      `  const host = document.getElementById('matrix-region');`,
      `  let populated = 0;`,
      `  if (host) {`,
      `    host.innerHTML = '';`,
      `    for (const cat of Object.keys(summary.matrix)) {`,
      `      for (const st of Object.keys(summary.matrix[cat])) {`,
      `        const cell = summary.matrix[cat][st];`,
      `        if (cell.count > 0) {`,
      `          populated++;`,
      `          host.appendChild(el('div', { className: 'matrix-cell', 'data-cat': cat, 'data-status': st },`,
      `            cat + '/' + st + ': ' + cell.count + ' (' + formatMoney(cell.amount) + ')'));`,
      `        }`,
      `      }`,
      `    }`,
      `  }`,
      `  return { populated, hottest: summary.hottestCell.category + ':' + summary.hottestCell.status };`,
      `}`,
    ].join('\n') + '\n';

    files[`src/components/ruleEvaluator.${ext}`] = [
      `import { DOMAIN_LIMITS, PRIORITY_WEIGHTS } from '../config.${ext}';`,
      ``,
      `export const GOVERNANCE_RULES = [`,
      `  { id: 'R-SLA', label: 'High value SLA check', threshold: DOMAIN_LIMITS.slaThreshold, penalty: 15 },`,
      `  { id: 'R-TAG', label: 'Minimum tagging hygiene', minTags: 2, penalty: 8 },`,
      `  { id: 'R-PRI', label: 'Critical priority ownership', minWeight: 30, penalty: 12 },`,
      `  { id: 'R-CAP', label: 'Single record budget cap', cap: 4500, penalty: 20 },`,
      `];`,
      ``,
      `export function evaluateGovernanceRules(records${T(': any[]')}, actor${T(': string')}) {`,
      `  const findings${T(': Array<{ruleId: string, recordId: string, penalty: number}>')} = [];`,
      `  let totalPenalty = 0;`,
      `  let ownedByActor = 0;`,
      `  for (const r of records) {`,
      `    if (r.owner === actor) ownedByActor++;`,
      `    const amt = Number(r.amount || 0);`,
      `    const w = PRIORITY_WEIGHTS[r.priority] ?? 10;`,
      `    if (amt >= GOVERNANCE_RULES[0].threshold) {`,
      `      findings.push({ ruleId: 'R-SLA', recordId: r.id, penalty: GOVERNANCE_RULES[0].penalty });`,
      `      totalPenalty += GOVERNANCE_RULES[0].penalty;`,
      `    }`,
      `    if (!Array.isArray(r.tags) || r.tags.length < GOVERNANCE_RULES[1].minTags) {`,
      `      findings.push({ ruleId: 'R-TAG', recordId: r.id, penalty: GOVERNANCE_RULES[1].penalty });`,
      `      totalPenalty += GOVERNANCE_RULES[1].penalty;`,
      `    }`,
      `    if (w >= GOVERNANCE_RULES[2].minWeight && !r.owner) {`,
      `      findings.push({ ruleId: 'R-PRI', recordId: r.id, penalty: GOVERNANCE_RULES[2].penalty });`,
      `      totalPenalty += GOVERNANCE_RULES[2].penalty;`,
      `    }`,
      `    if (amt >= GOVERNANCE_RULES[3].cap) {`,
      `      findings.push({ ruleId: 'R-CAP', recordId: r.id, penalty: GOVERNANCE_RULES[3].penalty });`,
      `      totalPenalty += GOVERNANCE_RULES[3].penalty;`,
      `    }`,
      `  }`,
      `  const healthScore = Math.max(0, 100 - Math.min(100, Math.round(totalPenalty / Math.max(1, records.length))));`,
      `  return { findingCount: findings.length, totalPenalty, healthScore, ownedByActor };`,
      `}`,
    ].join('\n') + '\n';

    files[`src/components/notificationCenter.${ext}`] = [
      `import { el } from '../dom.${ext}';`,
      `import { formatMoney } from '../formatters.${ext}';`,
      ``,
      `export function buildNotificationBatch(records${T(': any[]')}, governance${T(': any')}, revision${T(': string | null')}) {`,
      `  const items${T(': Array<{id: string, channel: string, text: string}>')} = [];`,
      `  items.push({`,
      `    id: 'n-rev',`,
      `    channel: 'audit',`,
      `    text: 'Workspace synchronized revision=' + String(revision || 'pending') + ' health=' + governance.healthScore,`,
      `  });`,
      `  const sorted = [...records].sort((a${T(': any')}, b${T(': any')}) => (b.amount - a.amount) || a.id.localeCompare(b.id));`,
      `  for (const rec of sorted.slice(0, 4)) {`,
      `    items.push({`,
      `      id: 'n-' + rec.id,`,
      `      channel: rec.amount >= 3000 ? 'pager' : 'slack',`,
      `      text: rec.id + ' [' + rec.status + '] ' + rec.title + ' ' + formatMoney(rec.amount),`,
      `    });`,
      `  }`,
      `  return items;`,
      `}`,
      ``,
      `export function renderNotificationCenter(items${T(': any[]')}) {`,
      `  const panel = document.getElementById('notify-center');`,
      `  if (panel) {`,
      `    panel.innerHTML = '';`,
      `    for (const item of items) {`,
      `      panel.appendChild(el('div', { className: 'notice ch-' + item.channel, 'data-notice-id': item.id }, item.text));`,
      `    }`,
      `  }`,
      `  const pagerCount = items.filter((x${T(': any')}) => x.channel === 'pager').length;`,
      `  return { delivered: items.length, pagerCount };`,
      `}`,
    ].join('\n') + '\n';

    files[`src/components/auditSnapshot.${ext}`] = [
      `import { APP_DOMAIN } from '../config.${ext}';`,
      `import { summarizeMetrics } from '../formatters.${ext}';`,
      ``,
      `export function createAuditSnapshot(state${T(': any')}, governance${T(': any')}, matrixInfo${T(': any')}, notifyInfo${T(': any')}) {`,
      `  const metrics = summarizeMetrics(state.records, state.pinnedIds);`,
      `  const statusKeys = Object.keys(metrics.byStatus).sort();`,
      `  const statusVector = statusKeys.map((k${T(': string')}) => k + ':' + metrics.byStatus[k]).join('|');`,
      `  const checksumSeed = [`,
      `    APP_DOMAIN,`,
      `    String(metrics.count),`,
      `    metrics.formattedTotal,`,
      `    String(governance.healthScore),`,
      `    matrixInfo.hottest,`,
      `    String(notifyInfo.delivered),`,
      `  ].join('#');`,
      `  let acc = 2166136261;`,
      `  for (let i = 0; i < checksumSeed.length; i++) {`,
      `    acc = Math.imul(acc ^ checksumSeed.charCodeAt(i), 16777619) >>> 0;`,
      `  }`,
      `  return {`,
      `    fingerprint: acc.toString(16).padStart(8, '0'),`,
      `    statusVector,`,
      `    healthScore: governance.healthScore,`,
      `    hottestCell: matrixInfo.hottest,`,
      `    deliveredNotices: notifyInfo.delivered,`,
      `  };`,
      `}`,
    ].join('\n') + '\n';

    files[`src/components/slaTracker.${ext}`] = [
      `import { DOMAIN_LIMITS, VALID_PRIORITIES } from '../config.${ext}';`,
      `import { el } from '../dom.${ext}';`,
      ``,
      `export const SLA_WINDOWS_MIN${T(': Record<string, number>')} = {`,
      ...priorities.map((p, idx) => `  ${JSON.stringify(p)}: ${(idx + 1) * 60},`),
      `};`,
      ``,
      `export function computeSlaReport(records${T(': any[]')}) {`,
      `  const buckets${T(': Record<string, {total: number, atRisk: number, avgWindow: number}>')} = {};`,
      `  for (const p of VALID_PRIORITIES) buckets[p] = { total: 0, atRisk: 0, avgWindow: SLA_WINDOWS_MIN[p] ?? 240 };`,
      `  let atRiskTotal = 0;`,
      `  const escalatedIds${T(': string[]')} = [];`,
      `  for (const r of records) {`,
      `    const b = buckets[r.priority] || (buckets[r.priority] = { total: 0, atRisk: 0, avgWindow: 240 });`,
      `    b.total++;`,
      `    if (Number(r.amount || 0) >= DOMAIN_LIMITS.slaThreshold || r.priority === VALID_PRIORITIES[0]) {`,
      `      b.atRisk++;`,
      `      atRiskTotal++;`,
      `      escalatedIds.push(r.id);`,
      `    }`,
      `  }`,
      `  const panel = document.getElementById('sla-region');`,
      `  if (panel) {`,
      `    panel.innerHTML = '';`,
      `    for (const p of VALID_PRIORITIES) {`,
      `      const info = buckets[p];`,
      `      panel.appendChild(el('span', { className: 'sla-pill', 'data-pri': p },`,
      `        p + ':' + info.atRisk + '/' + info.total + '@' + info.avgWindow + 'm'));`,
      `    }`,
      `  }`,
      `  return { atRiskTotal, escalatedCount: escalatedIds.length, topEscalated: escalatedIds.slice(0, 3) };`,
      `}`,
    ].join('\n') + '\n';

    files[`src/components/quotaPlanner.${ext}`] = [
      `import { VALID_CATEGORIES } from '../config.${ext}';`,
      `import { formatMoney } from '../formatters.${ext}';`,
      `import { el } from '../dom.${ext}';`,
      ``,
      `export const CATEGORY_QUOTAS${T(': Record<string, number>')} = {`,
      ...categories.map((c, idx) => `  ${JSON.stringify(c)}: ${5000 + idx * 1500},`),
      `};`,
      ``,
      `export function computeQuotaUtilization(records${T(': any[]')}) {`,
      `  const used${T(': Record<string, number>')} = {};`,
      `  for (const c of VALID_CATEGORIES) used[c] = 0;`,
      `  for (const r of records) {`,
      `    const cat = Object.hasOwn(used, r.category) ? r.category : VALID_CATEGORIES[0];`,
      `    used[cat] = Math.round((used[cat] + Number(r.amount || 0)) * 100) / 100;`,
      `  }`,
      `  const overBudget${T(': string[]')} = [];`,
      `  const host = document.getElementById('quota-region');`,
      `  if (host) host.innerHTML = '';`,
      `  let maxPct = 0;`,
      `  for (const cat of VALID_CATEGORIES) {`,
      `    const cap = CATEGORY_QUOTAS[cat] || 5000;`,
      `    const pct = Math.round((used[cat] / cap) * 100);`,
      `    if (pct > maxPct) maxPct = pct;`,
      `    if (used[cat] > cap) overBudget.push(cat);`,
      `    if (host) {`,
      `      host.appendChild(el('div', { className: 'quota-row', 'data-cat': cat },`,
      `        cat + '=' + formatMoney(used[cat]) + '/' + formatMoney(cap) + ' (' + pct + '%)'));`,
      `    }`,
      `  }`,
      `  return { maxPct, overBudget, totalAllocated: Object.values(used).reduce((a, b) => a + b, 0) };`,
      `}`,
    ].join('\n') + '\n';

    files[`src/components/tagAnalytics.${ext}`] = [
      `import { el } from '../dom.${ext}';`,
      ``,
      `export function analyzeTagDistribution(records${T(': any[]')}) {`,
      `  const freq${T(': Record<string, number>')} = {};`,
      `  const byOwner${T(': Record<string, number>')} = {};`,
      `  for (const r of records) {`,
      `    byOwner[r.owner || 'unknown'] = (byOwner[r.owner || 'unknown'] || 0) + 1;`,
      `    for (const t of Array.isArray(r.tags) ? r.tags : []) {`,
      `      freq[t] = (freq[t] || 0) + 1;`,
      `    }`,
      `  }`,
      `  const rankedTags = Object.entries(freq).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));`,
      `  const host = document.getElementById('tag-region');`,
      `  if (host) {`,
      `    host.innerHTML = '';`,
      `    for (const [tag, count] of rankedTags.slice(0, 6)) {`,
      `      host.appendChild(el('span', { className: 'tag-badge', 'data-tag': tag }, '#' + tag + ':' + count));`,
      `    }`,
      `  }`,
      `  return {`,
      `    uniqueTags: rankedTags.length,`,
      `    topTag: rankedTags[0]?.[0] ?? null,`,
      `    ownerCount: Object.keys(byOwner).length,`,
      `  };`,
      `}`,
    ].join('\n') + '\n';
  }

  // 16. Entry file: src/app.js (or src/app.ts)
  files[`src/app.${ext}`] = [
    `import { APP_DOMAIN } from './config.${ext}';`,
    `import { readSessionContext, readSavedViewPrefs, persistWorkspaceState, clearDraftCache } from './storage.${ext}';`,
    `import { parseCurrentRoute, navigateToRoute, syncHashAnchor } from './router.${ext}';`,
    `import { validateRecordInput } from './validators.${ext}';`,
    `import { createWorkspaceStore } from './store.${ext}';`,
    `import { fetchRemoteRecords, commitWorkspaceAction } from './api.${ext}';`,
    `import { readSeedRecordsFromDom } from './dom.${ext}';`,
    `import { renderHeaderSummary } from './components/headerBar.${ext}';`,
    `import { bindFilterControls, applyFilterValues } from './components/filterBar.${ext}';`,
    `import { renderRecordList } from './components/recordList.${ext}';`,
    `import { renderDetailDrawer, pushToast } from './components/detailDrawer.${ext}';`,
    `import { evaluateTransitionCheck } from './components/compliancePanel.${ext}';`,
    `import { renderInsightsBreakdown } from './components/insightsPanel.${ext}';`,
    ...(xlWorkflow ? [
      `import { buildActivityEntries, renderActivityFeed } from './components/activityFeed.${ext}';`,
      `import { evaluatePortfolioPolicy } from './components/policyEngine.${ext}';`,
      `import { buildWorkspaceDigest } from './components/exportDigest.${ext}';`,
      `import { buildCrossTabMatrix, renderAnalyticsMatrix } from './components/analyticsMatrix.${ext}';`,
      `import { evaluateGovernanceRules } from './components/ruleEvaluator.${ext}';`,
      `import { buildNotificationBatch, renderNotificationCenter } from './components/notificationCenter.${ext}';`,
      `import { createAuditSnapshot } from './components/auditSnapshot.${ext}';`,
      `import { computeSlaReport } from './components/slaTracker.${ext}';`,
      `import { computeQuotaUtilization } from './components/quotaPlanner.${ext}';`,
      `import { analyzeTagDistribution } from './components/tagAnalytics.${ext}';`,
    ] : []),
    ``,
    `export async function run(input${T(': any')}) {`,
    `  const session = readSessionContext();`,
    `  const prefs = readSavedViewPrefs();`,
    `  const initialRoute = parseCurrentRoute();`,
    `  const seedRecords = readSeedRecordsFromDom();`,
    `  const store = createWorkspaceStore(seedRecords, prefs);`,
    `  const ts = Date.now();`,
    ``,
    `  let renderCount = 0;`,
    `  const rerender = () => {`,
    `    renderCount++;`,
    `    const st = store.getState();`,
    `    const visible = store.selectVisible();`,
    `    renderRecordList(visible, st.selectedId, st.pinnedIds);`,
    `    const active = st.records.find((r${T(': any')}) => r.id === st.selectedId) || visible[0] || null;`,
    `    renderDetailDrawer(active, st.pinnedIds);`,
    `    renderHeaderSummary(st, input.actor, session.role);`,
    `  };`,
    `  store.subscribe(rerender);`,
    `  bindFilterControls(store);`,
    `  rerender();`,
    ``,
    `  // 1. Validate & create new record if valid`,
    `  const validation = validateRecordInput(input.newItem);`,
    `  if (validation.valid) {`,
    `    store.addRecord({ ...validation.normalized, owner: input.actor });`,
    `  } else {`,
    `    pushToast('Validation failed: ' + validation.errors.join(','), 'error');`,
    `  }`,
    ``,
    `  // 2. Navigate & apply UI filter events`,
    `  const navResult = navigateToRoute(input.route, {`,
    `    view: 'list',`,
    `    status: input.filterStatus,`,
    `    category: input.filterCategory,`,
    `  }, { actor: input.actor, ts });`,
    `  applyFilterValues(input.filterStatus, input.filterCategory, input.searchQuery);`,
    ``,
    `  // 3. Evaluate status transition compliance`,
    `  const transition = evaluateTransitionCheck(store.getState().records, input.transitionTargetId, input.targetStatus);`,
    enableConsoleWarn
      ? `  if (transition.ok && Number(transition.amount || 0) >= 2000) {\n    console.warn('high-value-transition', input.transitionTargetId, transition.amount);\n  }`
      : `  // standard transition flow`,
    ``,
    `  // 4. Optional confirmation + prompt + remote sync`,
    `  const shouldCommit = confirm(${JSON.stringify(confirmVerb + ' ')} + input.transitionTargetId + ' to ' + input.targetStatus + '?');`,
    `  if (!shouldCommit) {`,
    `    store.setBanner('cancelled-by-user');`,
    `    pushToast('Action cancelled for ' + input.transitionTargetId, 'warn');`,
    `    const hash = syncHashAnchor('cancelled', { reason: 'user-cancel' });`,
    `    const finalState = store.getState();`,
    `    const visibleIds = store.selectVisible().map((r${T(': any')}) => r.id);`,
    `    return {`,
    `      domain: APP_DOMAIN,`,
    `      committed: false,`,
    `      route: navResult.pathname + navResult.search + hash,`,
    `      initialView: initialRoute.view,`,
    `      banner: finalState.banner,`,
    `      visibleIds,`,
    `      totalRecords: finalState.records.length,`,
    `      renderCount,`,
    `      detailTitle: document.getElementById('detail-title')?.textContent || '',`,
    `      toasts: document.querySelectorAll('#toast-region .toast').map((n${T(': any')}) => n.textContent),`,
    `    };`,
    `  }`,
    ``,
    `  const userNote = prompt(${JSON.stringify(promptLabel)}, ${JSON.stringify(promptDefault)}) || ${JSON.stringify(promptDefault)};`,
    `  if (transition.ok) {`,
    `    store.updateRecordStatus(input.transitionTargetId, input.targetStatus, userNote);`,
    `  }`,
    ``,
    `  const remote = await fetchRemoteRecords(session.token, {`,
    `    category: input.filterCategory === 'all' ? '' : input.filterCategory,`,
    `    actor: input.actor,`,
    `  });`,
    `  if (remote.ok && Array.isArray(remote.data?.extraRecords)) {`,
    `    for (const extra of remote.data.extraRecords) {`,
    `      if (!store.getState().records.some((r${T(': any')}) => r.id === extra.id)) {`,
    `        store.addRecord(extra);`,
    `      }`,
    `    }`,
    `  }`,
    ``,
    `  const commitRes = await commitWorkspaceAction(session.token, {`,
    `    domain: APP_DOMAIN,`,
    `    actor: input.actor,`,
    `    targetId: input.transitionTargetId,`,
    `    targetStatus: input.targetStatus,`,
    `    note: userNote,`,
    `    recordCount: store.getState().records.length,`,
    `    ts,`,
    `  });`,
    ``,
    enableTimerStep
      ? [
          `  const timerTag = await new Promise((resolve${T(': (v: string) => void')}) => {`,
          `    setTimeout(() => {`,
          `      pushToast('Deferred audit settled @' + window.__virtualNow(), 'info');`,
          `      resolve('settled@' + window.__virtualNow());`,
          `    }, 40);`,
          `  });`,
        ].join('\n')
      : `  const timerTag = 'immediate';`,
    ``,
    `  let insights = null;`,
    richWorkflow
      ? `  insights = renderInsightsBreakdown(store.getState().records, store.getState().pinnedIds);`
      : `  if (input.bulkArchive) insights = renderInsightsBreakdown(store.getState().records, store.getState().pinnedIds);`,
    ...(xlWorkflow ? [
      `  const activityEntries = buildActivityEntries(store.getState().records, store.getState().history, input.actor);`,
      `  const activityCount = renderActivityFeed(activityEntries);`,
      `  const policy = evaluatePortfolioPolicy(store.getState().records, session.role);`,
      `  const digest = buildWorkspaceDigest(store.getState().records, store.getState().pinnedIds, policy);`,
      `  const matrixSummary = buildCrossTabMatrix(store.getState().records, store.getState().pinnedIds);`,
      `  const matrixInfo = renderAnalyticsMatrix(matrixSummary);`,
      `  const governance = evaluateGovernanceRules(store.getState().records, input.actor);`,
      `  const noticeItems = buildNotificationBatch(store.getState().records, governance, commitRes.data?.revision ?? null);`,
      `  const notifyInfo = renderNotificationCenter(noticeItems);`,
      `  const slaReport = computeSlaReport(store.getState().records);`,
      `  const quotaInfo = computeQuotaUtilization(store.getState().records);`,
      `  const tagStats = analyzeTagDistribution(store.getState().records);`,
      `  const auditSnap = createAuditSnapshot(store.getState(), governance, matrixInfo, notifyInfo);`,
    ] : [
      `  const activityCount = 0;`,
      `  const digest = null;`,
      `  const slaReport = null;`,
      `  const quotaInfo = null;`,
      `  const tagStats = null;`,
      `  const auditSnap = null;`,
    ]),
    ``,
    `  if (commitRes.ok) {`,
    `    store.setBanner('committed:' + (commitRes.data?.revision || 'r1'));`,
    `    pushToast('Committed revision ' + (commitRes.data?.revision || 'r1'), 'success');`,
    `    clearDraftCache(input.actor);`,
    `  } else {`,
    `    store.setBanner('commit-error:' + commitRes.status);`,
    `    pushToast('Commit failed: ' + commitRes.status, 'error');`,
    `  }`,
    ``,
    `  const hash = syncHashAnchor(commitRes.ok ? 'committed' : 'error', { rev: commitRes.data?.revision ?? null });`,
    `  const finalState = store.getState();`,
    `  const visible = store.selectVisible();`,
    `  const persistedKey = persistWorkspaceState({`,
    `    domain: APP_DOMAIN,`,
    `    revision: commitRes.data?.revision ?? null,`,
    `    count: finalState.records.length,`,
    `    visibleCount: visible.length,`,
    `  });`,
    ``,
    `  return {`,
    `    domain: APP_DOMAIN,`,
    `    committed: commitRes.ok,`,
    `    revision: commitRes.data?.revision ?? null,`,
    `    persistedKey,`,
    `    timerTag,`,
    `    route: navResult.pathname + navResult.search + hash,`,
    `    banner: finalState.banner,`,
    `    visibleIds: visible.map((r${T(': any')}) => r.id),`,
    `    totalRecords: finalState.records.length,`,
    `    renderCount,`,
    `    insights,`,
    `    activityCount,`,
    `    digest,`,
    `    slaReport,`,
    `    quotaInfo,`,
    `    tagStats,`,
    `    auditSnap,`,
    `    title: document.title,`,
    `    detailTitle: document.getElementById('detail-title')?.textContent || '',`,
    `    detailBody: document.getElementById('detail-body')?.textContent || '',`,
    `    complianceNote: document.getElementById('compliance-note')?.textContent || '',`,
    `    toasts: document.querySelectorAll('#toast-region .toast').map((n${T(': any')}) => n.textContent),`,
    `  };`,
    `}`,
  ].join('\n') + '\n';

  // Merge distractor modules
  const distractors = buildDistractorFiles(domain, distractorCount, {ext, verbose: verboseDistractors});
  Object.assign(files, distractors);

  // Build rich initial HTML with seed DOM records
  const seedRowsHtml = (records) => records.map(r =>
    `      <li class="record-row" data-record-id="${r.id}" data-status="${r.status}" data-priority="${r.priority}" data-category="${r.category}" data-owner="${r.owner}" data-amount="${r.amount}" data-tags="${r.tags.join(',')}">` +
    `<span class="rec-title">${r.title}</span><span class="rec-meta">${r.status} | ${r.priority}</span></li>`,
  ).join('\n');

  const makeInitialHtml = (seedRecords) => [
    `<!DOCTYPE html>`,
    `<html>`,
    `<head><title>${title}</title></head>`,
    `<body>`,
    `  <div id="app" data-domain="${domain}">`,
    `    <header id="top-bar">`,
    `      <h1>${title}</h1>`,
    `      <span id="actor-badge">guest</span>`,
    `      <span id="banner-status">booting</span>`,
    `      <div class="kpi-strip">`,
    `        <span id="kpi-total">0</span>`,
    `        <span id="kpi-amount">$0.00</span>`,
    `        <span id="kpi-risk">0</span>`,
    `      </div>`,
    `    </header>`,
    `    <section id="toolbar">`,
    `      <select id="filter-status"><option value="all">All</option>${statuses.map(s => `<option value="${s}">${s}</option>`).join('')}</select>`,
    `      <select id="filter-category"><option value="all">All</option>${categories.map(c => `<option value="${c}">${c}</option>`).join('')}</select>`,
    `      <input id="filter-search" type="text" value="" />`,
    `      <span id="compliance-note">idle</span>`,
    `    </section>`,
    `    <main id="workspace">`,
    `      <ul id="record-list">`,
    seedRowsHtml(seedRecords),
    `      </ul>`,
    `      <aside id="detail-drawer" data-active-id="">`,
    `        <h2 id="detail-title">No selection</h2>`,
    `        <p id="detail-body"></p>`,
    `      </aside>`,
    `      <section id="insights-panel"></section>`,
    `      <section id="matrix-region"></section>`,
    `      <section id="notify-center"></section>`,
    `      <section id="sla-region"></section>`,
    `      <section id="quota-region"></section>`,
    `      <section id="tag-region"></section>`,
    `      <ul id="activity-feed"></ul>`,
    `      <footer id="digest-bar"></footer>`,
    `    </main>`,
    `    <div id="toast-region" aria-live="polite"></div>`,
    `  </div>`,
    `</body>`,
    `</html>`,
  ].join('\n');

  return {
    files,
    entryFile: `src/app.${ext}`,
    language: useTypeScript ? 'ts' : 'js',
    urlBase,
    storagePrefix,
    makeInitialHtml,
    pluralName,
  };
}

// ==================== 10 Distinct Frontend App Families ====================
const FAMILY_SPECS = [
  {
    slug: 'kanban-board',
    domain: 'kanban',
    title: 'Sprint Kanban Board',
    entityName: 'TaskCard',
    pluralName: 'cards',
    apiBase: 'https://kanban.app.test/api/v2',
    urlBase: 'https://kanban.app.test/sprints/42?view=board',
    storagePrefix: 'kanban42',
    statuses: ['backlog', 'in_progress', 'review', 'done'],
    priorities: ['p0', 'p1', 'p2', 'p3'],
    categories: ['frontend', 'backend', 'infra', 'design'],
    confirmVerb: 'Move sprint card',
    promptLabel: 'Sprint handoff note:',
    promptDefault: 'ready-for-qa',
    extraMetrics: 'sprint-velocity',
    seed: [
      {id: 'K-101', title: 'Virtualize column scroll', status: 'in_progress', priority: 'p0', category: 'frontend', owner: 'maya', amount: 2400, tags: ['perf', 'dom']},
      {id: 'K-102', title: 'Retry failed webhook queue', status: 'review', priority: 'p1', category: 'backend', owner: 'liam', amount: 1800, tags: ['reliability']},
      {id: 'K-103', title: 'Audit dark-mode contrast', status: 'backlog', priority: 'p2', category: 'design', owner: 'zoe', amount: 950, tags: ['a11y', 'css']},
    ],
    newItem: {id: 'K-104', title: 'Keyboard drag focus ring', priority: 'p1', category: 'frontend', amount: 1600, tags: ['a11y', 'ux']},
    remoteExtra: {id: 'K-105', title: 'Cache sprint burndown snapshot', status: 'in_progress', priority: 'p1', category: 'frontend', owner: 'noah', amount: 2100, tags: ['cache']},
    enableTimerStep: true,
    enableConsoleWarn: true,
  },
  {
    slug: 'shop-checkout',
    domain: 'checkout',
    title: 'Storefront Checkout Console',
    entityName: 'CartOrder',
    pluralName: 'orders',
    apiBase: 'https://shop.app.test/api/checkout',
    urlBase: 'https://shop.app.test/cart?view=checkout',
    storagePrefix: 'shopcart',
    statuses: ['draft', 'validated', 'authorized', 'fulfilled'],
    priorities: ['express', 'priority', 'standard', 'economy'],
    categories: ['hardware', 'accessories', 'bundles', 'digital'],
    confirmVerb: 'Authorize order',
    promptLabel: 'Delivery instruction:',
    promptDefault: 'leave-at-front-desk',
    extraMetrics: 'cart-margin',
    seed: [
      {id: 'O-201', title: 'Mechanical Split Keyboard', status: 'validated', priority: 'express', category: 'hardware', owner: 'claire', amount: 3100, tags: ['fragile', 'vip']},
      {id: 'O-202', title: 'USB-C Thunderbolt Dock', status: 'draft', priority: 'priority', category: 'accessories', owner: 'dev', amount: 1250, tags: ['office']},
      {id: 'O-203', title: 'Studio Monitor Stand Pair', status: 'validated', priority: 'standard', category: 'bundles', owner: 'sam', amount: 2650, tags: ['heavy']},
    ],
    newItem: {id: 'O-204', title: 'Braided DisplayPort Cable', priority: 'priority', category: 'hardware', amount: 680, tags: ['cable']},
    remoteExtra: {id: 'O-205', title: 'Extended Care Plan 2Yr', status: 'validated', priority: 'express', category: 'hardware', owner: 'claire', amount: 1400, tags: ['warranty']},
    enableTimerStep: false,
    enableConsoleWarn: true,
  },
  {
    slug: 'support-inbox',
    domain: 'inbox',
    title: 'Team Support Triage',
    entityName: 'TicketThread',
    pluralName: 'tickets',
    apiBase: 'https://support.app.test/api/triage',
    urlBase: 'https://support.app.test/inbox?view=queue',
    storagePrefix: 'triagebox',
    statuses: ['new', 'triaged', 'escalated', 'resolved'],
    priorities: ['urgent', 'high', 'normal', 'low'],
    categories: ['billing', 'auth', 'api', 'mobile'],
    confirmVerb: 'Escalate ticket',
    promptLabel: 'Escalation summary:',
    promptDefault: 'customer-blocked-on-sso',
    extraMetrics: 'sla-breach-risk',
    seed: [
      {id: 'T-301', title: 'SSO SAML assertion clock skew', status: 'triaged', priority: 'urgent', category: 'auth', owner: 'priya', amount: 4200, tags: ['enterprise', 'sso']},
      {id: 'T-302', title: 'Duplicate invoice PDF download', status: 'new', priority: 'high', category: 'billing', owner: 'omar', amount: 1950, tags: ['finance']},
      {id: 'T-303', title: 'Rate limit header mismatch', status: 'triaged', priority: 'normal', category: 'api', owner: 'lin', amount: 1100, tags: ['sdk']},
    ],
    newItem: {id: 'T-304', title: 'OAuth refresh token rotation', priority: 'high', category: 'auth', amount: 2800, tags: ['oauth', 'urgent']},
    remoteExtra: {id: 'T-305', title: 'SCIM group sync timeout', status: 'triaged', priority: 'urgent', category: 'auth', owner: 'priya', amount: 3500, tags: ['scim']},
    enableTimerStep: true,
    enableConsoleWarn: false,
  },
  {
    slug: 'metrics-studio',
    domain: 'metrics',
    title: 'Telemetry Report Studio',
    entityName: 'MetricQuery',
    pluralName: 'queries',
    apiBase: 'https://metrics.app.test/api/reports',
    urlBase: 'https://metrics.app.test/dashboards/core?view=metrics',
    storagePrefix: 'metstudio',
    statuses: ['draft', 'verified', 'published', 'archived'],
    priorities: ['tier0', 'tier1', 'tier2', 'tier3'],
    categories: ['latency', 'errors', 'cost', 'growth'],
    confirmVerb: 'Publish report',
    promptLabel: 'Alert threshold tag:',
    promptDefault: 'p99-under-250ms',
    extraMetrics: 'telemetry-coverage',
    seed: [
      {id: 'M-401', title: 'Checkout API p99 latency', status: 'verified', priority: 'tier0', category: 'latency', owner: 'hana', amount: 3800, tags: ['slo', 'prod']},
      {id: 'M-402', title: 'Worker OOM restart rate', status: 'draft', priority: 'tier1', category: 'errors', owner: 'ben', amount: 2200, tags: ['k8s']},
      {id: 'M-403', title: 'GPU inference batch utilization', status: 'verified', priority: 'tier1', category: 'cost', owner: 'yuki', amount: 4600, tags: ['gpu', 'finops']},
    ],
    newItem: {id: 'M-404', title: 'Edge cache hit ratio 24h', priority: 'tier1', category: 'latency', amount: 1750, tags: ['cdn', 'edge']},
    remoteExtra: {id: 'M-405', title: 'TLS handshake duration p95', status: 'verified', priority: 'tier0', category: 'latency', owner: 'hana', amount: 2900, tags: ['tls']},
    enableTimerStep: false,
    enableConsoleWarn: true,
  },
  {
    slug: 'cms-publisher',
    domain: 'cms',
    title: 'Editorial Publishing Studio',
    entityName: 'DocArticle',
    pluralName: 'articles',
    apiBase: 'https://cms.app.test/api/content',
    urlBase: 'https://cms.app.test/studio?view=drafts',
    storagePrefix: 'cmsstudio',
    statuses: ['draft', 'editing', 'scheduled', 'live'],
    priorities: ['headline', 'featured', 'standard', 'evergreen'],
    categories: ['release', 'tutorial', 'case_study', 'changelog'],
    confirmVerb: 'Schedule article',
    promptLabel: 'Release channel tag:',
    promptDefault: 'blog-main-feed',
    extraMetrics: 'editorial-readiness',
    seed: [
      {id: 'D-501', title: 'Long-Context Agent Benchmarks', status: 'editing', priority: 'headline', category: 'release', owner: 'elena', amount: 2900, tags: ['ai', 'launch']},
      {id: 'D-502', title: 'Migrating Monorepo to ESM', status: 'draft', priority: 'featured', category: 'tutorial', owner: 'alex', amount: 1500, tags: ['node', 'ts']},
      {id: 'D-503', title: 'Q4 Reliability Postmortem', status: 'editing', priority: 'standard', category: 'changelog', owner: 'ravi', amount: 1800, tags: ['sre']},
    ],
    newItem: {id: 'D-504', title: 'Deterministic Browser Testing Guide', priority: 'featured', category: 'release', amount: 2100, tags: ['dom', 'testing']},
    remoteExtra: {id: 'D-505', title: 'SDK v4 Upgrade Checklist', status: 'editing', priority: 'headline', category: 'release', owner: 'elena', amount: 2600, tags: ['migration']},
    enableTimerStep: true,
    enableConsoleWarn: false,
  },
  {
    slug: 'clinic-booking',
    domain: 'booking',
    title: 'Clinic Appointment Scheduler',
    entityName: 'BookingSlot',
    pluralName: 'bookings',
    apiBase: 'https://clinic.app.test/api/slots',
    urlBase: 'https://clinic.app.test/calendar?view=day',
    storagePrefix: 'cliniccal',
    statuses: ['requested', 'confirmed', 'checked_in', 'completed'],
    priorities: ['stat', 'followup', 'routine', 'telehealth'],
    categories: ['cardiology', 'pediatrics', 'imaging', 'lab'],
    confirmVerb: 'Confirm slot',
    promptLabel: 'Check-in note:',
    promptDefault: 'fasting-verified',
    extraMetrics: 'room-utilization',
    seed: [
      {id: 'B-601', title: 'Morning Echo Stress Consult', status: 'confirmed', priority: 'stat', category: 'cardiology', owner: 'dr-kim', amount: 2750, tags: ['room-a', 'fasting']},
      {id: 'B-602', title: 'Pediatric Annual Wellness', status: 'requested', priority: 'routine', category: 'pediatrics', owner: 'dr-patel', amount: 1200, tags: ['room-b']},
      {id: 'B-603', title: 'MRI Contrast Prep Intake', status: 'confirmed', priority: 'followup', category: 'imaging', owner: 'dr-chen', amount: 3400, tags: ['contrast']},
    ],
    newItem: {id: 'B-604', title: 'Holter Monitor Device Pickup', priority: 'followup', category: 'cardiology', amount: 1450, tags: ['device']},
    remoteExtra: {id: 'B-605', title: 'EKG Walk-In Triage Slot', status: 'confirmed', priority: 'stat', category: 'cardiology', owner: 'dr-kim', amount: 2300, tags: ['ekg']},
    enableTimerStep: false,
    enableConsoleWarn: true,
  },
  {
    slug: 'flag-console',
    domain: 'flags',
    title: 'Feature Flag Rollout Console',
    entityName: 'FeatureFlag',
    pluralName: 'flags',
    apiBase: 'https://flags.app.test/api/rollouts',
    urlBase: 'https://flags.app.test/prod?view=flags',
    storagePrefix: 'flagops',
    statuses: ['off', 'canary', 'ramp', 'global'],
    priorities: ['critical', 'high', 'medium', 'low'],
    categories: ['search', 'payments', 'editor', 'sync'],
    confirmVerb: 'Promote feature flag',
    promptLabel: 'Change ticket ID:',
    promptDefault: 'CHG-8842',
    extraMetrics: 'blast-radius',
    seed: [
      {id: 'F-701', title: 'streaming-vector-reranker', status: 'canary', priority: 'critical', category: 'search', owner: 'nina', amount: 3900, tags: ['ml', 'prod']},
      {id: 'F-702', title: 'instant-sepa-settlement', status: 'off', priority: 'high', category: 'payments', owner: 'marc', amount: 4400, tags: ['eu', 'pci']},
      {id: 'F-703', title: 'crdt-offline-merge', status: 'canary', priority: 'medium', category: 'sync', owner: 'tara', amount: 2100, tags: ['crdt']},
    ],
    newItem: {id: 'F-704', title: 'semantic-facet-highlighter', priority: 'high', category: 'search', amount: 1850, tags: ['ui', 'ab-test']},
    remoteExtra: {id: 'F-705', title: 'hybrid-bm25-fallback', status: 'canary', priority: 'critical', category: 'search', owner: 'nina', amount: 3100, tags: ['fallback']},
    enableTimerStep: true,
    enableConsoleWarn: true,
  },
  {
    slug: 'expense-ledger',
    domain: 'ledger',
    title: 'Budget Expense Approval Ledger',
    entityName: 'ExpenseItem',
    pluralName: 'expenses',
    apiBase: 'https://ledger.app.test/api/expenses',
    urlBase: 'https://ledger.app.test/approvals?view=queue',
    storagePrefix: 'ledgerv3',
    statuses: ['submitted', 'reviewed', 'approved', 'reimbursed'],
    priorities: ['urgent', 'month_end', 'standard', 'deferred'],
    categories: ['cloud', 'travel', 'equipment', 'recruiting'],
    confirmVerb: 'Approve expense',
    promptLabel: 'Cost center memo:',
    promptDefault: 'cc-eng-q4-approved',
    extraMetrics: 'budget-variance',
    seed: [
      {id: 'E-801', title: 'Cluster Reserved Nodes Nov', status: 'reviewed', priority: 'urgent', category: 'cloud', owner: 'victor', amount: 4800, tags: ['aws', 'capex']},
      {id: 'E-802', title: 'NeurIPS Team Flight Booking', status: 'submitted', priority: 'month_end', category: 'travel', owner: 'sara', amount: 2600, tags: ['conf']},
      {id: 'E-803', title: 'Test Lab Oscilloscope Kit', status: 'reviewed', priority: 'standard', category: 'equipment', owner: 'dan', amount: 1900, tags: ['hw']},
    ],
    newItem: {id: 'E-804', title: 'Object Storage Archive Tier', priority: 'month_end', category: 'cloud', amount: 2150, tags: ['s3', 'backup']},
    remoteExtra: {id: 'E-805', title: 'CDN Egress Overage Credit', status: 'reviewed', priority: 'urgent', category: 'cloud', owner: 'victor', amount: 3200, tags: ['cdn']},
    enableTimerStep: false,
    enableConsoleWarn: true,
  },
  {
    slug: 'ts-component-catalog',
    domain: 'catalog',
    title: 'TypeScript Design System Catalog',
    entityName: 'UiComponent',
    pluralName: 'components',
    apiBase: 'https://design.app.test/api/catalog',
    urlBase: 'https://design.app.test/components?view=grid',
    storagePrefix: 'dscatalog',
    statuses: ['alpha', 'beta', 'stable', 'deprecated'],
    priorities: ['core', 'widely_used', 'specialized', 'experimental'],
    categories: ['inputs', 'overlays', 'data_display', 'navigation'],
    confirmVerb: 'Promote component',
    promptLabel: 'Semver release note:',
    promptDefault: 'v3.4.0-a11y-pass',
    extraMetrics: 'adoption-index',
    useTypeScript: true,
    seed: [
      {id: 'C-901', title: 'Combobox MultiSelect Field', status: 'beta', priority: 'core', category: 'inputs', owner: 'iris', amount: 3300, tags: ['aria', 'keyboard']},
      {id: 'C-902', title: 'Command Dialog Sheet', status: 'alpha', priority: 'widely_used', category: 'overlays', owner: 'theo', amount: 2400, tags: ['focus-trap']},
      {id: 'C-903', title: 'Virtual DataGrid Table', status: 'beta', priority: 'core', category: 'data_display', owner: 'jules', amount: 4100, tags: ['perf', 'grid']},
    ],
    newItem: {id: 'C-904', title: 'DateRange Calendar Input', priority: 'widely_used', category: 'inputs', amount: 2700, tags: ['i18n', 'aria']},
    remoteExtra: {id: 'C-905', title: 'Numeric Stepper Control', status: 'beta', priority: 'core', category: 'inputs', owner: 'iris', amount: 2950, tags: ['form']},
    enableTimerStep: true,
    enableConsoleWarn: false,
  },
  {
    slug: 'incident-commander',
    domain: 'incidents',
    title: 'On-Call Incident Commander',
    entityName: 'IncidentCase',
    pluralName: 'incidents',
    apiBase: 'https://oncall.app.test/api/incidents',
    urlBase: 'https://oncall.app.test/active?view=warroom',
    storagePrefix: 'incops',
    statuses: ['triggered', 'investigating', 'mitigated', 'closed'],
    priorities: ['sev1', 'sev2', 'sev3', 'sev4'],
    categories: ['database', 'networking', 'edge', 'auth'],
    confirmVerb: 'Update incident',
    promptLabel: 'Status page bulletin:',
    promptDefault: 'failover-complete-monitoring',
    extraMetrics: 'mttr-pressure',
    seed: [
      {id: 'I-1001', title: 'Primary Replica Lag Spike', status: 'investigating', priority: 'sev1', category: 'database', owner: 'karen', amount: 4900, tags: ['pg', 'us-east']},
      {id: 'I-1002', title: 'BGP Route Flap EU-West', status: 'triggered', priority: 'sev2', category: 'networking', owner: 'leo', amount: 3100, tags: ['edge']},
      {id: 'I-1003', title: 'JWT Key Cache Eviction', status: 'investigating', priority: 'sev2', category: 'auth', owner: 'mira', amount: 2600, tags: ['jwks']},
    ],
    newItem: {id: 'I-1004', title: 'Connection Pool Exhaustion', priority: 'sev1', category: 'database', amount: 3700, tags: ['pgbouncer', 'hot']},
    remoteExtra: {id: 'I-1005', title: 'Read Replica Promotion Check', status: 'investigating', priority: 'sev1', category: 'database', owner: 'karen', amount: 4100, tags: ['failover']},
    enableTimerStep: true,
    enableConsoleWarn: true,
  },
];

// Build 4 variants per family (40 tasks total):
//  - Variant A & B: Exact causal diverging pair (identical public prompt, diverging on confirm())
//    configured at ~16K-28K tokens (18-22 files, medium modules)
//  - Variant C: Medium-Large SPA (~26K-38K tokens, 28 files, large symbol-load modules)
//  - Variant D: Large Long-Context SPA (~36K-52K tokens, 36-40 files, large symbol-load modules + verbose distractors + insights)
async function buildAllCandidates() {
  const candidates = [];

  for (let fIdx = 0; fIdx < FAMILY_SPECS.length; fIdx++) {
    const spec = FAMILY_SPECS[fIdx];
    const family = `lc65k-fe/${spec.slug}`;
    const baseInput = {
      actor: spec.seed[0].owner,
      route: `/${spec.pluralName}/active`,
      filterStatus: 'all',
      filterCategory: spec.categories[0],
      searchQuery: '',
      newItem: spec.newItem,
      transitionTargetId: spec.seed[0].id,
      targetStatus: spec.statuses[2],
      bulkArchive: false,
    };

    // ---- Variants A & B: Causal Diverging Pair (12K-24K tokens, 24 files, whole-file loads) ----
    const pairSpa = buildDomainSpa({
      ...spec,
      distractorCount: 10,
      largeModules: false,
      verboseDistractors: false,
      richWorkflow: false,
      xlWorkflow: false,
    });
    const pairHtml = pairSpa.makeInitialHtml(spec.seed);

    for (const [suffix, confirmed] of [['pair-confirm', true], ['pair-cancel', false]]) {
      const storage = {
        local: {[spec.storagePrefix + ':prefs']: JSON.stringify({sortBy: 'priority', compact: false, pinnedIds: [spec.seed[0].id]})},
        session: {
          [spec.storagePrefix + ':token']: `tok-${spec.domain}-pair`,
          [spec.storagePrefix + ':role']: 'lead',
        },
      };
      const recorded = await recordMultiFileBrowserFixture({
        files: pairSpa.files,
        entryFile: pairSpa.entryFile,
        entry: 'run',
        args: [baseInput],
        initialHtml: pairHtml,
        initialUrl: spec.urlBase,
        storage,
        dialogs: {confirm: [confirmed], prompt: [`${spec.promptDefault}-pair`]},
        now: [1731000000000 + fIdx * 10000],
        http: ({url, method}) => {
          if (method === 'GET') {
            return {status: 200, statusText: 'OK', url, body: {extraRecords: [spec.remoteExtra]}};
          }
          return {status: 200, statusText: 'OK', url, body: {revision: `rev-${spec.domain}-101`, accepted: true}};
        },
      });
      candidates.push({
        id: `lc65k-fe-${spec.slug}-${suffix}`,
        family,
        language: pairSpa.language,
        environment: 'browser',
        executionMode: 'native',
        files: pairSpa.files,
        entryFile: pairSpa.entryFile,
        entry: 'run',
        initialLoadedFiles: [pairSpa.entryFile],
        initialHtml: pairHtml,
        initialUrl: spec.urlBase,
        args: encodeReadable([baseInput]),
        fixture: {calls: recorded.calls},
        randomSeed: 17,
        timeoutMs: 45000,
        tier: 5,
        features: [
          'long-context-65k',
          'multi-file',
          'code-load',
          'frontend',
          'browser-dom',
          'causal-pair',
          ...(spec.useTypeScript ? ['typescript'] : []),
        ],
        metadata: {
          domain: spec.domain,
          variant: suffix,
          fileCount: Object.keys(pairSpa.files).length,
        },
      });
    }

    // ---- Variant C: Medium-Large SPA (~28K-38K tokens, 39 files, large symbol-load modules) ----
    const medSpa = buildDomainSpa({
      ...spec,
      distractorCount: 24,
      largeModules: true,
      verboseDistractors: true,
      richWorkflow: true,
      xlWorkflow: false,
    });
    const medSeed = [
      ...spec.seed,
      {
        id: spec.seed[0].id + 'B',
        title: spec.seed[1].title + ' (v2)',
        status: spec.statuses[1],
        priority: spec.priorities[0],
        category: spec.categories[0],
        owner: spec.seed[1].owner,
        amount: 2450,
        tags: ['followup', 'audit'],
      },
    ];
    const medHtml = medSpa.makeInitialHtml(medSeed);
    const medInput = {
      ...baseInput,
      actor: spec.seed[1].owner,
      route: `/${spec.pluralName}/triage`,
      filterCategory: 'all',
      searchQuery: '',
      transitionTargetId: spec.seed[0].id,
      targetStatus: spec.statuses[3],
      bulkArchive: true,
    };
    const commitOkC = fIdx % 2 === 0;
    const recC = await recordMultiFileBrowserFixture({
      files: medSpa.files,
      entryFile: medSpa.entryFile,
      entry: 'run',
      args: [medInput],
      initialHtml: medHtml,
      initialUrl: spec.urlBase + '&env=staging',
      storage: {
        local: {[spec.storagePrefix + ':prefs']: JSON.stringify({sortBy: 'amount', compact: true, pinnedIds: [spec.seed[0].id, spec.seed[2].id]})},
        session: {
          [spec.storagePrefix + ':token']: `tok-${spec.domain}-med`,
          [spec.storagePrefix + ':role']: 'admin',
        },
      },
      dialogs: {confirm: [true], prompt: [`${spec.promptDefault}-stage`]},
      now: [1731500000000 + fIdx * 10000],
      http: ({url, method}) => {
        if (method === 'GET') {
          return {status: 200, statusText: 'OK', url, body: {extraRecords: [spec.remoteExtra]}};
        }
        return commitOkC
          ? {status: 201, statusText: 'Created', url, body: {revision: `rev-${spec.domain}-202`, accepted: true}}
          : {status: 409, statusText: 'Conflict', url, body: {error: 'stale-etag', revision: null}};
      },
    });
    candidates.push({
      id: `lc65k-fe-${spec.slug}-med`,
      family,
      language: medSpa.language,
      environment: 'browser',
      executionMode: 'native',
      files: medSpa.files,
      entryFile: medSpa.entryFile,
      entry: 'run',
      initialLoadedFiles: [medSpa.entryFile],
      initialHtml: medHtml,
      initialUrl: spec.urlBase + '&env=staging',
      args: encodeReadable([medInput]),
      fixture: {calls: recC.calls},
      randomSeed: 17,
      timeoutMs: 45000,
      tier: 5,
      features: [
        'long-context-65k',
        'multi-file',
        'code-load',
        'frontend',
        'browser-dom',
        ...(spec.useTypeScript ? ['typescript'] : []),
      ],
      metadata: {
        domain: spec.domain,
        variant: 'med',
        fileCount: Object.keys(medSpa.files).length,
      },
    });

    // ---- Variant D: Extra-Large Long-Context SPA (~42K-50K tokens, 180+ files, 24 active modules + XL enterprise analytics) ----
    const largeSpa = buildDomainSpa({
      ...spec,
      distractorCount: 160,
      largeModules: true,
      verboseDistractors: true,
      richWorkflow: true,
      xlWorkflow: true,
    });
    const largeSeed = [
      ...medSeed,
      {
        id: spec.seed[0].id + 'C',
        title: spec.seed[2].title + ' (prod)',
        status: spec.statuses[0],
        priority: spec.priorities[1],
        category: spec.categories[0],
        owner: spec.seed[2].owner,
        amount: 3150,
        tags: ['prod', 'review'],
      },
      {
        id: spec.seed[0].id + 'D',
        title: 'Cross-region sync audit ' + spec.domain,
        status: spec.statuses[1],
        priority: spec.priorities[0],
        category: spec.categories[1],
        owner: spec.seed[0].owner,
        amount: 4050,
        tags: ['multi-region', 'slo'],
      },
      {
        id: spec.seed[0].id + 'E',
        title: 'Failover readiness checklist ' + spec.domain,
        status: spec.statuses[2],
        priority: spec.priorities[1],
        category: spec.categories[2],
        owner: spec.seed[1].owner,
        amount: 2850,
        tags: ['dr', 'audit'],
      },
      {
        id: spec.seed[0].id + 'F',
        title: 'Quarterly compliance export ' + spec.domain,
        status: spec.statuses[0],
        priority: spec.priorities[2],
        category: spec.categories[3],
        owner: spec.seed[2].owner,
        amount: 1950,
        tags: ['compliance'],
      },
    ];
    const largeHtml = largeSpa.makeInitialHtml(largeSeed);
    const largeInput = {
      ...baseInput,
      actor: spec.seed[2].owner,
      route: `/${spec.pluralName}/enterprise`,
      filterStatus: 'all',
      filterCategory: 'all',
      searchQuery: '',
      newItem: {
        ...spec.newItem,
        id: spec.newItem.id + '-XL',
        title: spec.newItem.title + ' Enterprise',
        amount: spec.newItem.amount + 900,
      },
      transitionTargetId: spec.seed[0].id + 'D',
      targetStatus: spec.statuses[2],
      bulkArchive: true,
    };
    const recD = await recordMultiFileBrowserFixture({
      files: largeSpa.files,
      entryFile: largeSpa.entryFile,
      entry: 'run',
      args: [largeInput],
      initialHtml: largeHtml,
      initialUrl: spec.urlBase + '&env=prod&tier=enterprise',
      storage: {
        local: {[spec.storagePrefix + ':prefs']: JSON.stringify({sortBy: 'priority', compact: false, pinnedIds: [spec.seed[0].id, spec.seed[0].id + 'D']})},
        session: {
          [spec.storagePrefix + ':token']: `tok-${spec.domain}-xl`,
          [spec.storagePrefix + ':role']: 'commander',
        },
      },
      dialogs: {confirm: [true], prompt: [`${spec.promptDefault}-enterprise`]},
      now: [1732000000000 + fIdx * 10000],
      http: ({url, method}) => {
        if (method === 'GET') {
          return {
            status: 200,
            statusText: 'OK',
            url,
            body: {
              extraRecords: [
                spec.remoteExtra,
                {
                  ...spec.remoteExtra,
                  id: spec.remoteExtra.id + '-B',
                  title: spec.remoteExtra.title + ' Mirror',
                  amount: spec.remoteExtra.amount + 450,
                },
              ],
            },
          };
        }
        return {status: 200, statusText: 'OK', url, body: {revision: `rev-${spec.domain}-303`, accepted: true}};
      },
    });
    candidates.push({
      id: `lc65k-fe-${spec.slug}-xl`,
      family,
      language: largeSpa.language,
      environment: 'browser',
      executionMode: 'native',
      files: largeSpa.files,
      entryFile: largeSpa.entryFile,
      entry: 'run',
      initialLoadedFiles: [largeSpa.entryFile],
      initialHtml: largeHtml,
      initialUrl: spec.urlBase + '&env=prod&tier=enterprise',
      args: encodeReadable([largeInput]),
      fixture: {calls: recD.calls},
      randomSeed: 17,
      timeoutMs: 45000,
      tier: 5,
      features: [
        'long-context-65k',
        'multi-file',
        'code-load',
        'frontend',
        'browser-dom',
        ...(spec.useTypeScript ? ['typescript'] : []),
      ],
      metadata: {
        domain: spec.domain,
        variant: 'xl',
        fileCount: Object.keys(largeSpa.files).length,
      },
    });
  }

  return candidates;
}

// Verify flexible student session grading (different code.load batching + exact external effects)
async function verifyFlexibleStudentSession(exported) {
  const prepared = await prepareTinkerTask(exported.task, {traceFormat: 'compact'});
  const session = createTinkerSession(prepared);
  try {
    // Student batches first 3 unloaded non-entry files up front in one code.load call
    const nonEntry = Object.keys(prepared.files).filter(p => p !== prepared.entryFile).slice(0, 3);
    const loadRes = await session.step({
      role: 'assistant',
      content: '',
      tool_calls: [{
        type: 'function',
        id: 'flex_load_1',
        function: {name: 'code.load', arguments: JSON.stringify({arguments: nonEntry.map(path => ({path}))})},
      }],
    }, 50);
    if (loadRes.done || loadRes.messages[0]?.name !== 'code.load') {
      throw new Error(`Flexible code.load failed on ${exported.id}`);
    }
    // Replay exact non-code.load external tool calls from exported teacher messages
    let tok = 100;
    for (const msg of exported.messages) {
      if (msg.role !== 'assistant') continue;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const tc = msg.tool_calls[0];
        if (tc.function.name === 'code.load') continue;
        tok += 30;
        const stepRes = await session.step({role: 'assistant', content: '', tool_calls: [tc]}, tok);
        if (stepRes.done) throw new Error(`External call ${tc.function.name} terminated early on ${exported.id}`);
      } else {
        const comp = parseStudentAction(msg);
        tok += 50;
        const doneRes = await session.step(JSON.stringify(comp), tok);
        if (!doneRes.done || !doneRes.grade.success) {
          throw new Error(`Flexible session completion failed on ${exported.id}: ${doneRes.grade.reason}`);
        }
      }
    }
  } finally {
    session.close();
  }
}

async function main() {
  const {values} = parseArgs({
    allowNegative: true,
    options: {
      output: {type: 'string', short: 'o', default: DEFAULT_OUTPUT},
      jobs: {type: 'string', default: '4'},
      limit: {type: 'string'},
      filter: {type: 'string', default: ''},
      audit: {type: 'boolean', default: true},
      'exclude-jsonl': {type: 'string', default: ''},
      help: {type: 'boolean', short: 'h'},
    },
  });

  if (values.help) {
    console.log(`Usage: node tools/tinker-build-multifile-frontend-65k.mjs [options]
  -o, --output <path>       Output JSONL path (default: ${DEFAULT_OUTPUT})
  --jobs <n>                Parallel workers (default: 4)
  --limit <n>               Build only first N candidates
  --exclude-jsonl <paths>   Comma-separated JSONLs to check for ID/hash collisions
  --no-audit                Skip full auditTinkerSupervision pass`);
    process.exit(0);
  }

  const blockedIds = new Set();
  const blockedHashes = new Set();
  if (values['exclude-jsonl']) {
    for (const p of values['exclude-jsonl'].split(',').map(s => s.trim()).filter(Boolean)) {
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row.id) blockedIds.add(row.id);
          if (row.sourceHash) blockedHashes.add(row.sourceHash);
        } catch {}
      }
    }
  }

  const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));
  const candidates = await buildAllCandidates();
  const filtered = values.filter
    ? candidates.filter(c => c.id.includes(values.filter) || c.family.includes(values.filter))
    : candidates;
  const selected = values.limit ? filtered.slice(0, Math.max(1, Number(values.limit))) : filtered;

  const results = new Array(selected.length);
  let cursor = 0;
  let failures = 0;

  await Promise.all(Array.from({length: jobs}, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= selected.length) break;
      const task = selected[idx];
      try {
        if (blockedIds.has(task.id)) throw new Error(`ID collision: ${task.id}`);
        const exported = await exportTinkerExample(task, {
          traceFormat: 'compact',
          reasoningChannel: 'thinking',
        });
        if (blockedHashes.has(exported.sourceHash)) throw new Error(`sourceHash collision: ${exported.sourceHash}`);
        if (!exported.metadata.traceAudit?.replayVerified) throw new Error('replayVerified is false');
        if (!exported.metadata.traceAudit?.canonicalCausalNarration) throw new Error('canonicalCausalNarration is false');
        if ((exported.metadata.codeLoadCalls ?? 0) < 3) {
          throw new Error(`Expected >=3 code.load calls, got ${exported.metadata.codeLoadCalls}`);
        }
        const episodeChars = JSON.stringify(exported.messages).length;
        const approxTokens = Math.ceil(episodeChars / 3.5);
        if (episodeChars < MIN_EPISODE_CHARS || episodeChars > MAX_EPISODE_CHARS) {
          throw new Error(`episodeChars ${episodeChars} (~${approxTokens} tok) outside [${MIN_EPISODE_CHARS}, ${MAX_EPISODE_CHARS}]`);
        }
        // Verify flexible live student grading on every task
        await verifyFlexibleStudentSession(exported);

        const traceLines = exported.messages
          .filter(m => m.role === 'assistant')
          .reduce((n, m) => {
            const t = assistantThinkingText(m).trim();
            return n + (t ? t.split('\n').length : 0);
          }, 0);

        const loadedPaths = new Set();
        for (const m of exported.messages) {
          if (m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'code.load') {
            const reqs = JSON.parse(m.tool_calls[0].function.arguments).arguments;
            for (const r of reqs) if (r?.path) loadedPaths.add(r.path);
          }
        }

        const enrichedTask = {
          ...exported.task,
          tier: 5,
          metadata: {
            ...exported.task.metadata,
            tier: 5,
            fileCount: Object.keys(exported.task.files).length,
            loadedFileCount: loadedPaths.size,
            codeLoadCalls: exported.metadata.codeLoadCalls,
            externalCalls: exported.metadata.externalCalls,
            traceLines,
            narrationLines: exported.metadata.traceAudit.narrationLines,
            episodeChars,
            approxTokens,
            sourceHash: exported.sourceHash,
          },
        };
        results[idx] = {ok: true, task: enrichedTask, exported};
      } catch (err) {
        failures++;
        results[idx] = {ok: false, id: task.id, error: String(err?.message ?? err)};
        process.stderr.write(`FAIL ${task.id}: ${err?.message ?? err}\n`);
      }
    }
  }));

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

  const chars = ok.map(r => r.task.metadata.episodeChars).sort((a, b) => a - b);
  const toks = ok.map(r => r.task.metadata.approxTokens).sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

  const summary = {
    totalCandidates: selected.length,
    verified: ok.length,
    failed: failures,
    families: new Set(ok.map(r => r.task.family)).size,
    tsTasks: ok.filter(r => r.task.language === 'ts').length,
    episodeChars: chars.length ? {min: chars[0], p50: pct(chars, 0.5), p90: pct(chars, 0.9), max: chars.at(-1)} : null,
    approxTokensAt3_5: toks.length ? {min: toks[0], p50: pct(toks, 0.5), p90: pct(toks, 0.9), max: toks.at(-1)} : null,
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
  process.exitCode = 1;
});
