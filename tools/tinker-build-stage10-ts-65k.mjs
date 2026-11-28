#!/usr/bin/env node
// Build, 2x independently verify, audit, and pre-export Stage 10 TypeScript tasks.
//
// Produces >= 110 brand-new, deterministic, pre-exported TypeScript execution tasks
// across 45+ brand-new unique TS families (strictly zero-overlap with RealExecBench v1):
//
//   Part B1 — 30 Hairy Single-File TypeScript families x 2 variants = 60 tasks
//             (rendered as raw TypeScript in `src/main.ts` with generics, discriminated
//              unions, enums, readonly, as const, abstract classes, implements,
//              parameter properties, type guards, optional chaining, nullish coalescing,
//              async/await, and effectful causal pairs).
//   Part B2 — 14 Brand-New 45-120 file Multi-File 12K-56K TypeScript Codebases
//             x 3 variants = 42 tasks (barrel re-exports, interfaces/enums, >3.5KB
//             symbol-loaded modules, distractor `.ts` modules, fetch/console/Date.now
//             I/O, causal diverging pairs & throw paths).
//   Part B3 — Real OSS Multi-File TypeScript Repos harvested from cached OSS repos
//             (strictly disjoint from RealExecBench v1), targeting 15-24 tasks across
//             6+ unique OSS TS repo families.
//
// Verification:
//   1. Pass 1: exportTinkerExample(..., {traceFormat: 'compact', reasoningChannel: 'thinking'})
//      + independent live session replay via createTinkerSession(prepareTinkerTask(...)).
//   2. Pass 2: Independent export through `tools/tinker-execution.mjs` JSONL worker,
//      asserting 100% byte-for-byte identical `messages` and `sourceHash`.
//   3. Causal zero-future-leakage audit via auditTinkerSupervision(...).
//   4. Token bounds: total context <= 195,000 chars (~56K tok, inside 65,472) and
//      every individual assistant turn <= 56,000 chars (~16K tok, inside 20,000).
//   5. Strict zero-leakage check against RealExecBench v1 (`id`, `family`, `sourceHash`,
//      `split_component`).

import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
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
import {harvestMultiFileRepos} from './tinker-harvest-multifile-js.mjs';

process.on('unhandledRejection', () => {});

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'runs/stage10-py-ts-65k/ts-tasks.jsonl');
const DEFAULT_REPORT = resolve(REPO_ROOT, 'runs/stage10-py-ts-65k/ts-report.json');
const DEFAULT_REALEXEC_BM = '/home/werg/tracing-js-self/runs/realexecbench-v1/benchmark.jsonl';
const DEFAULT_REALEXEC_MAN = '/home/werg/tracing-js-self/runs/realexecbench-v1/manifest.json';

const MAX_EPISODE_CHARS = 195_000;
const MAX_TURN_CHARS = 56_000;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadRealExecForbidden(bmPath = DEFAULT_REALEXEC_BM, manPath = DEFAULT_REALEXEC_MAN) {
  const ids = new Set();
  const families = new Set();
  const sourceHashes = new Set();
  const splitComponents = new Set();
  if (existsSync(bmPath)) {
    for (const line of readFileSync(bmPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.id) ids.add(String(row.id));
      if (row.family) families.add(String(row.family));
      if (row.sourceHash) sourceHashes.add(String(row.sourceHash));
      if (row.split_component) splitComponents.add(String(row.split_component));
    }
  }
  if (existsSync(manPath)) {
    const man = JSON.parse(readFileSync(manPath, 'utf8'));
    for (const list of Object.values(man.task_ids_by_track ?? {})) {
      for (const tid of list) ids.add(String(tid));
    }
  }
  return {ids, families, sourceHashes, splitComponents};
}

// ==================== Deterministic TS Multi-File Fixture Recorder ====================

async function recordTsFixture({
  files,
  entryFile,
  entry = 'run',
  args = [],
  http = [],
  now = [1735000000000, 1735000001000, 1735000002000, 1735000003000],
  allowThrow = false,
}) {
  const calls = [];
  let httpIdx = 0;
  let nowIdx = 0;

  const platformFetch = async (reqInput, reqInit) => {
    const norm = normalizeFetchRequest(reqInput, reqInit);
    const [url] = norm;
    const outcome = typeof http === 'function'
      ? await http({url, index: httpIdx++})
      : (http[httpIdx++] ?? {status: 200, statusText: 'OK', url, headers: {'content-type': 'application/json'}, body: '{}'});
    if (outcome?.reject) {
      const errObj = {name: outcome.name ?? 'TypeError', message: outcome.message ?? 'Network error'};
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
    __recDateNow: () => {
      const val = nowIdx < now.length ? now[nowIdx++] : 1735000000000 + nowIdx * 1000;
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

  new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: 3000});
  new vm.Script('Date.now = __recDateNow;').runInContext(context, {timeout: 1000});
  new vm.Script(`(function(){let s=17>>>0;Math.random=function(){s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};})()`)
    .runInContext(context, {timeout: 1000});

  const res = await executeVirtualCodebaseInContext({
    context,
    files,
    entryFile,
    entry,
    initialLoadedFiles: [entryFile],
    args: structuredClone(args),
    timeoutMs: 6000,
    traceMode: false,
    onCodeLoadEvent() {},
    setTraceActive() {},
  });
  if (res.kind === 'throw' && !allowThrow) {
    throw new Error(`TS fixture recorder threw unexpectedly: ${res.value?.message ?? String(res.value)}`);
  }
  return calls;
}

// ==================== PART B1: 30 Hairy Single-File TypeScript Families (60 tasks) ====================

async function buildPartB1SingleFileTs() {
  const pureSpecs = [
    // 1. Generic binary heap with comparator interface & readonly
    {
      name: 'generic_binary_heap',
      features: ['generics', 'interfaces', 'class', 'readonly'],
      code: `
export interface Comparator<T> {
  compare(a: T, b: T): number;
}
export interface Job {
  readonly id: string;
  readonly priority: number;
}
class MinHeap<T> {
  private readonly data: T[] = [];
  constructor(private readonly cmp: Comparator<T>) {}
  push(item: T): void {
    this.data.push(item);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp.compare(this.data[i], this.data[p]) >= 0) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let sm = i;
        if (l < this.data.length && this.cmp.compare(this.data[l], this.data[sm]) < 0) sm = l;
        if (r < this.data.length && this.cmp.compare(this.data[r], this.data[sm]) < 0) sm = r;
        if (sm === i) break;
        [this.data[i], this.data[sm]] = [this.data[sm], this.data[i]];
        i = sm;
      }
    }
    return top;
  }
  get size(): number { return this.data.length; }
}
export function run(jobs: readonly Job[], k: number): string[] {
  const heap = new MinHeap<Job>({
    compare: (a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id),
  });
  for (const j of jobs) heap.push(j);
  const out: string[] = [];
  while (out.length < k && heap.size > 0) {
    const next = heap.pop();
    if (next) out.push(next.id + ':' + next.priority);
  }
  return out;
}`,
      variants: [
        ['a', [[{id: 'b', priority: 3}, {id: 'a', priority: 1}, {id: 'c', priority: 1}, {id: 'd', priority: 2}], 3], false],
        ['b', [[{id: 'z', priority: 5}, {id: 'm', priority: 2}, {id: 'a', priority: 2}], 5], false],
      ],
    },

    // 2. Discriminated union state machine with exhaustive never check
    {
      name: 'discriminated_order_fsm',
      features: ['discriminated-union', 'never-exhaustive', 'switch'],
      code: `
type OrderState =
  | { status: 'draft'; items: number }
  | { status: 'authorized'; items: number; authCode: string }
  | { status: 'captured'; totalCents: number }
  | { status: 'cancelled'; reason: string };

type OrderEvent =
  | { type: 'add'; count: number }
  | { type: 'auth'; code: string }
  | { type: 'capture'; unitCents: number }
  | { type: 'cancel'; reason: string };

function assertNever(x: never): never {
  throw new Error('Unhandled event: ' + JSON.stringify(x));
}

function transition(state: OrderState, ev: OrderEvent): OrderState {
  switch (ev.type) {
    case 'add':
      return state.status === 'draft' ? { status: 'draft', items: state.items + ev.count } : state;
    case 'auth':
      return state.status === 'draft' && state.items > 0
        ? { status: 'authorized', items: state.items, authCode: ev.code }
        : state;
    case 'capture':
      return state.status === 'authorized'
        ? { status: 'captured', totalCents: state.items * ev.unitCents }
        : state;
    case 'cancel':
      return state.status === 'captured' ? state : { status: 'cancelled', reason: ev.reason };
    default:
      return assertNever(ev);
  }
}

export function run(events: readonly OrderEvent[]): { final: OrderState; trail: string[] } {
  let st: OrderState = { status: 'draft', items: 0 };
  const trail: string[] = [st.status];
  for (const ev of events) {
    st = transition(st, ev);
    trail.push(st.status);
  }
  return { final: st, trail };
}`,
      variants: [
        ['capture', [[{type: 'add', count: 3}, {type: 'auth', code: 'A9'}, {type: 'capture', unitCents: 450}, {type: 'cancel', reason: 'late'}]], false],
        ['cancel', [[{type: 'add', count: 2}, {type: 'cancel', reason: 'user'}, {type: 'auth', code: 'X1'}]], false],
      ],
    },

    // 3. Numeric bitmask enum + string enum + reverse mapping
    {
      name: 'enum_bitmask_acl',
      features: ['enum', 'bitwise', 'interfaces'],
      code: `
enum Perm {
  None = 0,
  Read = 1 << 0,
  Write = 1 << 1,
  Admin = 1 << 2,
  Audit = 1 << 3,
}
enum Role {
  Viewer = 'VIEWER',
  Editor = 'EDITOR',
  Owner = 'OWNER',
}
const ROLE_MASKS: Record<Role, number> = {
  [Role.Viewer]: Perm.Read,
  [Role.Editor]: Perm.Read | Perm.Write,
  [Role.Owner]: Perm.Read | Perm.Write | Perm.Admin | Perm.Audit,
};
export function run(role: Role, extra: number, revoke: number): { mask: number; names: string[]; isAdmin: boolean } {
  const mask = ((ROLE_MASKS[role] ?? Perm.None) | extra) & ~revoke;
  const bits = [Perm.Read, Perm.Write, Perm.Admin, Perm.Audit];
  const names = bits.filter(b => (mask & b) !== 0).map(b => Perm[b]);
  return { mask, names, isAdmin: (mask & Perm.Admin) === Perm.Admin };
}`,
      variants: [
        ['editor_plus', ['EDITOR', 8, 0], false],
        ['owner_revoke', ['OWNER', 0, 6], false],
      ],
    },

    // 4. Abstract class, implements, constructor parameter properties
    {
      name: 'abstract_class_params',
      features: ['abstract-class', 'implements', 'parameter-properties'],
      code: `
interface Measurable {
  area(): number;
  label(): string;
}
abstract class Shape implements Measurable {
  constructor(protected readonly id: string, public readonly color: string) {}
  abstract area(): number;
  label(): string {
    return this.id + '[' + this.color + ']=' + this.area().toFixed(2);
  }
}
class Rect extends Shape {
  constructor(id: string, color: string, private readonly w: number, private readonly h: number) {
    super(id, color);
  }
  area(): number { return this.w * this.h; }
}
class Circle extends Shape {
  constructor(id: string, color: string, private readonly r: number) {
    super(id, color);
  }
  area(): number { return Math.round(Math.PI * this.r * this.r * 100) / 100; }
}
type ShapeSpec = { kind: 'rect'; id: string; color: string; w: number; h: number } | { kind: 'circle'; id: string; color: string; r: number };

export function run(specs: readonly ShapeSpec[]): { total: number; labels: string[] } {
  const shapes: Shape[] = specs.map(s =>
    s.kind === 'rect' ? new Rect(s.id, s.color, s.w, s.h) : new Circle(s.id, s.color, s.r)
  );
  const total = Math.round(shapes.reduce((acc, s) => acc + s.area(), 0) * 100) / 100;
  return { total, labels: shapes.map(s => s.label()) };
}`,
      variants: [
        ['a', [[{kind: 'rect', id: 'r1', color: 'red', w: 4, h: 5}, {kind: 'circle', id: 'c1', color: 'blue', r: 3}]], false],
        ['b', [[{kind: 'circle', id: 'c2', color: 'green', r: 2}, {kind: 'rect', id: 'r2', color: 'gold', w: 3.5, h: 2}]], false],
      ],
    },

    // 5. Type guards, `in` narrowing, optional chaining & nullish coalescing
    {
      name: 'type_guards_narrowing',
      features: ['type-guard', 'optional-chaining', 'nullish-coalescing'],
      code: `
interface UserPayload { kind: 'user'; name?: string | null; meta?: { score?: number } }
interface BotPayload { kind: 'bot'; handle: string; weight?: number }
type Entry = UserPayload | BotPayload | { raw: string };

function isUser(e: Entry): e is UserPayload {
  return 'kind' in e && e.kind === 'user';
}
function isBot(e: Entry): e is BotPayload {
  return 'kind' in e && e.kind === 'bot';
}
export function run(entries: readonly Entry[]): { names: string[]; scoreSum: number } {
  const names: string[] = [];
  let scoreSum = 0;
  for (const e of entries) {
    if (isUser(e)) {
      names.push(e.name ?? 'anon');
      scoreSum += e.meta?.score ?? 10;
    } else if (isBot(e)) {
      names.push('@' + e.handle);
      scoreSum += e.weight ?? 1;
    } else {
      names.push('raw:' + e.raw);
    }
  }
  return { names, scoreSum };
}`,
      variants: [
        ['a', [[{kind: 'user', name: null, meta: {score: 0}}, {kind: 'bot', handle: 'ci', weight: 5}, {raw: 'ping'}]], false],
        ['b', [[{kind: 'user', name: 'Ada'}, {kind: 'bot', handle: 'ops'}]], false],
      ],
    },

    // 6. `as const` lookup table, indexed access types & route matcher
    {
      name: 'as_const_mapped_router',
      features: ['as-const', 'mapped-types', 'tuples'],
      code: `
const ROUTES = [
  { name: 'userDetail', pattern: '/users/:id', auth: true },
  { name: 'orgRepo', pattern: '/orgs/:org/repos/:repo', auth: true },
  { name: 'health', pattern: '/health', auth: false },
] as const;

type RouteName = typeof ROUTES[number]['name'];
interface MatchResult { route: RouteName; auth: boolean; params: Record<string, string> }

export function run(paths: readonly string[]): Array<MatchResult | null> {
  return paths.map(p => {
    const segs = p.split('/').filter(Boolean);
    for (const r of ROUTES) {
      const pat = r.pattern.split('/').filter(Boolean);
      if (pat.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < pat.length; i++) {
        if (pat[i].startsWith(':')) params[pat[i].slice(1)] = segs[i];
        else if (pat[i] !== segs[i]) { ok = false; break; }
      }
      if (ok) return { route: r.name, auth: r.auth, params };
    }
    return null;
  });
}`,
      variants: [
        ['a', [['/users/42', '/orgs/acme/repos/core', '/health', '/unknown']], false],
        ['b', [['/orgs/dev/repos/ui', '/users/99/extra']], false],
      ],
    },

    // 7. Recursive AST expression evaluator with lexical `let` bindings
    {
      name: 'ast_expr_visitor',
      features: ['discriminated-union', 'recursion', 'map'],
      code: `
type Expr =
  | { op: 'num'; v: number }
  | { op: 'var'; name: string }
  | { op: 'bin'; fn: '+' | '-' | '*' | '/'; l: Expr; r: Expr }
  | { op: 'let'; name: string; val: Expr; body: Expr };

function evalExpr(node: Expr, env: ReadonlyMap<string, number>): number {
  switch (node.op) {
    case 'num': return node.v;
    case 'var': {
      const found = env.get(node.name);
      if (found === undefined) throw new ReferenceError('Unbound variable: ' + node.name);
      return found;
    }
    case 'bin': {
      const a = evalExpr(node.l, env), b = evalExpr(node.r, env);
      if (node.fn === '+') return a + b;
      if (node.fn === '-') return a - b;
      if (node.fn === '*') return a * b;
      if (b === 0) throw new RangeError('Division by zero');
      return Math.trunc(a / b);
    }
    case 'let': {
      const next = new Map(env);
      next.set(node.name, evalExpr(node.val, env));
      return evalExpr(node.body, next);
    }
  }
}

export function run(ast: Expr, init: Record<string, number>): number {
  return evalExpr(ast, new Map(Object.entries(init)));
}`,
      variants: [
        ['ok', [{op: 'let', name: 'x', val: {op: 'bin', fn: '+', l: {op: 'var', name: 'a'}, r: {op: 'num', v: 3}}, body: {op: 'bin', fn: '*', l: {op: 'var', name: 'x'}, r: {op: 'num', v: 4}}}, {a: 5}], false],
        ['throw_div0', [{op: 'bin', fn: '/', l: {op: 'num', v: 10}, r: {op: 'bin', fn: '-', l: {op: 'var', name: 'k'}, r: {op: 'num', v: 2}}}, {k: 2}], true],
      ],
    },

    // 8. Generic Result<T, E> monad pipeline
    {
      name: 'result_monad_pipeline',
      features: ['generics', 'discriminated-union', 'functional'],
      code: `
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

function flatMap<T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}
function mapOk<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return r.ok ? Ok(fn(r.value)) : r;
}

export function run(inputs: readonly string[]): Array<Result<number, string>> {
  return inputs.map(raw => {
    const parsed: Result<number, string> = /^-?\\d+$/.test(raw.trim())
      ? Ok(Number(raw.trim()))
      : Err('nan:' + raw);
    const positive = flatMap(parsed, n => (n > 0 ? Ok(n) : Err('non-positive:' + n)));
    return mapOk(positive, n => n * n + 1);
  });
}`,
      variants: [
        ['a', [[' 4 ', '-2', 'abc', '7']], false],
        ['b', [['0', '10', '3']], false],
      ],
    },

    // 9. Generic LRU + TTL cache with Map ordering
    {
      name: 'generic_lru_ttl_cache',
      features: ['generics', 'class', 'map'],
      code: `
interface CacheEntry<V> { value: V; expiresAt: number }
class LruTtlCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  public hits = 0;
  public misses = 0;
  constructor(private readonly cap: number) {}
  set(key: K, value: V, now: number, ttl: number): void {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.cap) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: now + ttl });
  }
  get(key: K, now: number): V | undefined {
    const e = this.store.get(key);
    if (!e || e.expiresAt <= now) {
      if (e) this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, e);
    this.hits++;
    return e.value;
  }
  keys(): K[] { return [...this.store.keys()]; }
}
type Op = { op: 'set'; k: string; v: number; t: number; ttl: number } | { op: 'get'; k: string; t: number };
export function run(cap: number, ops: readonly Op[]) {
  const c = new LruTtlCache<string, number>(cap);
  const reads: Array<number | null> = [];
  for (const o of ops) {
    if (o.op === 'set') c.set(o.k, o.v, o.t, o.ttl);
    else reads.push(c.get(o.k, o.t) ?? null);
  }
  return { reads, hits: c.hits, misses: c.misses, keys: c.keys() };
}`,
      variants: [
        ['a', [2, [{op: 'set', k: 'a', v: 1, t: 0, ttl: 10}, {op: 'set', k: 'b', v: 2, t: 1, ttl: 5}, {op: 'get', k: 'a', t: 2}, {op: 'set', k: 'c', v: 3, t: 3, ttl: 10}, {op: 'get', k: 'b', t: 4}, {op: 'get', k: 'a', t: 12}]], false],
        ['b', [2, [{op: 'set', k: 'x', v: 9, t: 0, ttl: 3}, {op: 'get', k: 'x', t: 3}, {op: 'set', k: 'y', v: 8, t: 4, ttl: 10}, {op: 'get', k: 'y', t: 6}]], false],
      ],
    },

    // 10. Immutable deep structural patcher with Readonly & Partial
    {
      name: 'immutable_deep_patch',
      features: ['generics', 'readonly', 'recursion'],
      code: `
type JsonObj = { [k: string]: unknown };
function isPlainObj(v: unknown): v is JsonObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function mergePatch(target: Readonly<JsonObj>, patch: Readonly<JsonObj>, changed: string[], prefix = ''): JsonObj {
  const out: JsonObj = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const path = prefix ? prefix + '.' + k : k;
    if (v === null) {
      if (k in out) { delete out[k]; changed.push('-' + path); }
    } else if (isPlainObj(v) && isPlainObj(out[k])) {
      out[k] = mergePatch(out[k] as JsonObj, v, changed, path);
    } else {
      if (out[k] !== v) changed.push('~' + path);
      out[k] = v;
    }
  }
  return out;
}
export function run(base: JsonObj, patch: JsonObj) {
  const changed: string[] = [];
  const merged = mergePatch(base, patch, changed);
  return { merged, changed };
}`,
      variants: [
        ['a', [{a: 1, cfg: {host: 'old', port: 80, debug: true}}, {cfg: {port: 443, debug: null}, env: 'prod'}], false],
        ['b', [{x: {y: 1, z: 2}}, {x: {y: 1, z: 5, w: 9}}], false],
      ],
    },

    // 11. SemVer class with implements & constraint range solver
    {
      name: 'semver_constraint_solver',
      features: ['class', 'implements', 'tuples'],
      code: `
interface Comparable<T> { compareTo(other: T): number }
class SemVer implements Comparable<SemVer> {
  constructor(public readonly major: number, public readonly minor: number, public readonly patch: number) {}
  static parse(raw: string): SemVer {
    const m = /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(raw.trim());
    if (!m) throw new Error('Invalid semver: ' + raw);
    return new SemVer(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  compareTo(o: SemVer): number {
    return (this.major - o.major) || (this.minor - o.minor) || (this.patch - o.patch);
  }
  satisfies(range: string): boolean {
    if (range.startsWith('^')) {
      const base = SemVer.parse(range.slice(1));
      const upper = base.major > 0 ? new SemVer(base.major + 1, 0, 0) : new SemVer(0, base.minor + 1, 0);
      return this.compareTo(base) >= 0 && this.compareTo(upper) < 0;
    }
    if (range.startsWith('>=')) return this.compareTo(SemVer.parse(range.slice(2))) >= 0;
    return this.compareTo(SemVer.parse(range)) === 0;
  }
  toString(): string { return this.major + '.' + this.minor + '.' + this.patch; }
}
export function run(versions: readonly string[], ranges: readonly string[]): { matched: string[]; best: string | null } {
  const parsed = versions.map(v => SemVer.parse(v)).sort((a, b) => a.compareTo(b));
  const matched = parsed.filter(v => ranges.every(r => v.satisfies(r))).map(v => v.toString());
  return { matched, best: matched.length ? matched[matched.length - 1] : null };
}`,
      variants: [
        ['a', [['1.0.0', '1.4.2', '1.9.0', '2.0.0'], ['^1.2.0', '>=1.4.0']], false],
        ['b', [['0.2.1', '0.2.9', '0.3.0'], ['^0.2.0']], false],
      ],
    },

    // 12. Interval meeting scheduler with typed tuples
    {
      name: 'interval_meeting_sched',
      features: ['tuples', 'readonly', 'algorithm'],
      code: `
type Slot = readonly [start: number, end: number];
export function run(busy: readonly Slot[], dayStart: number, dayEnd: number, minLen: number) {
  const sorted = [...busy].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  let overlaps = 0;
  for (const [s, e] of sorted) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      overlaps++;
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  const free: Array<[number, number]> = [];
  let cur = dayStart;
  for (const [s, e] of merged) {
    if (s - cur >= minLen) free.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (dayEnd - cur >= minLen) free.push([cur, dayEnd]);
  return { merged, free, overlaps };
}`,
      variants: [
        ['a', [[[9, 11], [10, 12], [14, 15], [16, 17]], 8, 18, 2], false],
        ['b', [[[8, 10], [10, 12], [15, 16]], 8, 17, 1], false],
      ],
    },

    // 13. Reactive Signal & Computed dependency graph
    {
      name: 'reactive_signal_graph',
      features: ['generics', 'class', 'closure'],
      code: `
class Signal<T> {
  private subs = new Set<() => void>();
  constructor(private val: T) {}
  get(): T { return this.val; }
  set(next: T): void {
    if (Object.is(this.val, next)) return;
    this.val = next;
    for (const fn of this.subs) fn();
  }
  subscribe(fn: () => void): void { this.subs.add(fn); }
}
class Computed<T> {
  private dirty = true;
  private cached!: T;
  public recomputes = 0;
  constructor(deps: Array<Signal<unknown>>, private readonly compute: () => T) {
    for (const d of deps) d.subscribe(() => { this.dirty = true; });
  }
  get(): T {
    if (this.dirty) {
      this.cached = this.compute();
      this.dirty = false;
      this.recomputes++;
    }
    return this.cached;
  }
}
export function run(updates: readonly Array<[number, number]>) {
  const price = new Signal<number>(10);
  const qty = new Signal<number>(2);
  const total = new Computed<number>([price, qty], () => price.get() * qty.get());
  const snapshots: number[] = [total.get()];
  for (const [p, q] of updates) {
    price.set(p);
    qty.set(q);
    snapshots.push(total.get());
  }
  return { snapshots, recomputes: total.recomputes };
}`,
      variants: [
        ['a', [[[10, 2], [12, 2], [12, 5]]], false],
        ['b', [[[8, 3], [8, 3], [15, 4]]], false],
      ],
    },

    // 14. Typed wildcard EventBus with priority middleware
    {
      name: 'typed_event_bus',
      features: ['interfaces', 'class', 'generics'],
      code: `
interface Sub { pattern: string; priority: number; tag: string }
function matchTopic(pattern: string, topic: string): boolean {
  const p = pattern.split('.'), t = topic.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] !== '*' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
export function run(subs: readonly Sub[], topics: readonly string[]): Record<string, string[]> {
  const ordered = [...subs].sort((a, b) => b.priority - a.priority || a.tag.localeCompare(b.tag));
  const out: Record<string, string[]> = {};
  for (const tp of topics) {
    out[tp] = ordered.filter(s => matchTopic(s.pattern, tp)).map(s => s.tag);
  }
  return out;
}`,
      variants: [
        ['a', [[{pattern: 'order.*', priority: 5, tag: 'audit'}, {pattern: 'order.#', priority: 10, tag: 'all'}, {pattern: 'order.paid', priority: 20, tag: 'bill'}], ['order.paid', 'order.ship.us', 'user.login']], false],
        ['b', [[{pattern: '*', priority: 1, tag: 'root'}, {pattern: 'svc.*.err', priority: 9, tag: 'pager'}], ['svc.api.err', 'ping']], false],
      ],
    },

    // 15. Typed SQL-like in-memory query builder (where/groupBy/orderBy)
    {
      name: 'in_memory_query_engine',
      features: ['generics', 'class', 'map'],
      code: `
interface Row { dept: string; role: string; salary: number; active: boolean }
class Query<T> {
  constructor(private readonly rows: readonly T[]) {}
  where(pred: (r: T) => boolean): Query<T> { return new Query(this.rows.filter(pred)); }
  orderBy(cmp: (a: T, b: T) => number): Query<T> { return new Query([...this.rows].sort(cmp)); }
  groupBy<K extends string>(keyFn: (r: T) => K): Map<K, T[]> {
    const m = new Map<K, T[]>();
    for (const r of this.rows) {
      const k = keyFn(r);
      const list = m.get(k) ?? [];
      list.push(r);
      m.set(k, list);
    }
    return m;
  }
  toArray(): T[] { return [...this.rows]; }
}
export function run(rows: readonly Row[], minSal: number) {
  const q = new Query(rows).where(r => r.active && r.salary >= minSal).orderBy((a, b) => b.salary - a.salary);
  const grouped = q.groupBy(r => r.dept);
  const summary: Record<string, { count: number; avg: number }> = {};
  for (const [k, list] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    summary[k] = { count: list.length, avg: Math.round(list.reduce((s, r) => s + r.salary, 0) / list.length) };
  }
  return { matched: q.toArray().length, summary };
}`,
      variants: [
        ['a', [[{dept: 'eng', role: 'sr', salary: 180, active: true}, {dept: 'eng', role: 'jr', salary: 110, active: true}, {dept: 'ops', role: 'sr', salary: 150, active: false}, {dept: 'ops', role: 'mid', salary: 140, active: true}], 120], false],
        ['b', [[{dept: 'ml', role: 'sr', salary: 200, active: true}, {dept: 'ml', role: 'mid', salary: 160, active: true}], 100], false],
      ],
    },

    // 16. Glob pattern matcher (*, ?, char class)
    {
      name: 'glob_pattern_matcher',
      features: ['recursion', 'memoization', 'string'],
      code: `
function globMatch(pat: string, str: string): boolean {
  const memo = new Map<string, boolean>();
  function dp(i: number, j: number): boolean {
    const k = i + ':' + j;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let res = false;
    if (i === pat.length) res = j === str.length;
    else if (pat[i] === '*') res = dp(i + 1, j) || (j < str.length && dp(i, j + 1));
    else if (j < str.length && (pat[i] === '?' || pat[i] === str[j])) res = dp(i + 1, j + 1);
    memo.set(k, res);
    return res;
  }
  return dp(0, 0);
}
export function run(patterns: readonly string[], paths: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of patterns) out[p] = paths.filter(s => globMatch(p, s));
  return out;
}`,
      variants: [
        ['a', [['src/*.ts', 'src/??.ts'], ['src/a.ts', 'src/ab.ts', 'src/abc.js', 'lib/x.ts']], false],
        ['b', [['*test*?.mjs'], ['a_test1.mjs', 'test.mjs', 'my_test9.mjs']], false],
      ],
    },

    // 17. Sparse matrix multiply & transpose with readonly tuples
    {
      name: 'sparse_matrix_ops',
      features: ['tuples', 'readonly', 'map'],
      code: `
type Entry = readonly [r: number, c: number, v: number];
function matMul(a: readonly Entry[], b: readonly Entry[]): Entry[] {
  const bByRow = new Map<number, Array<[number, number]>>();
  for (const [r, c, v] of b) {
    const arr = bByRow.get(r) ?? [];
    arr.push([c, v]);
    bByRow.set(r, arr);
  }
  const acc = new Map<string, number>();
  for (const [r, k, av] of a) {
    for (const [c, bv] of bByRow.get(k) ?? []) {
      const key = r + ',' + c;
      acc.set(key, (acc.get(key) ?? 0) + av * bv);
    }
  }
  const res: Array<[number, number, number]> = [];
  for (const [key, v] of acc.entries()) {
    if (v !== 0) {
      const [r, c] = key.split(',').map(Number);
      res.push([r, c, v]);
    }
  }
  return res.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
export function run(a: readonly Entry[], b: readonly Entry[]) {
  const prod = matMul(a, b);
  const trace = prod.filter(([r, c]) => r === c).reduce((s, [, , v]) => s + v, 0);
  return { prod, trace };
}`,
      variants: [
        ['a', [[[0, 0, 2], [0, 1, 3], [1, 1, 4]], [[0, 0, 1], [1, 0, 5], [1, 1, 2]]], false],
        ['b', [[[0, 1, 3], [1, 0, -2]], [[0, 0, 4], [1, 1, 5]]], false],
      ],
    },

    // 18. Dijkstra weighted graph with throw on unreachable target
    {
      name: 'dijkstra_weighted_graph',
      features: ['generics', 'map', 'exception'],
      code: `
interface Edge<N> { to: N; weight: number }
export function run(edges: readonly Array<[string, string, number]>, src: string, dst: string) {
  const adj = new Map<string, Edge<string>[]>();
  const nodes = new Set<string>([src, dst]);
  for (const [u, v, w] of edges) {
    nodes.add(u); nodes.add(v);
    const list = adj.get(u) ?? [];
    list.push({ to: v, weight: w });
    adj.set(u, list);
  }
  const dist = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  while (visited.size < nodes.size) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = dist.get(n) ?? Infinity;
      if (!visited.has(n) && d < bestD) { bestD = d; best = n; }
    }
    if (best === null) break;
    visited.add(best);
    for (const e of adj.get(best) ?? []) {
      const alt = bestD + e.weight;
      if (alt < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, alt);
        prev.set(e.to, best);
      }
    }
  }
  if (!dist.has(dst)) throw new Error('Unreachable: ' + src + '->' + dst);
  const path: string[] = [];
  let cur: string | undefined = dst;
  while (cur !== undefined) { path.push(cur); cur = prev.get(cur); }
  return { distance: dist.get(dst)!, path: path.reverse() };
}`,
      variants: [
        ['ok', [[['a', 'b', 2], ['a', 'c', 6], ['b', 'c', 3], ['c', 'd', 1]], 'a', 'd'], false],
        ['unreachable', [[['a', 'b', 1], ['c', 'd', 2]], 'a', 'd'], true],
      ],
    },

    // 19. Token bucket vs sliding log rate limiter (discriminated strategy)
    {
      name: 'token_bucket_limiter',
      features: ['discriminated-union', 'algorithm'],
      code: `
type LimiterCfg =
  | { kind: 'bucket'; cap: number; refillPerSec: number }
  | { kind: 'window'; maxReq: number; windowSec: number };

export function run(cfg: LimiterCfg, timestamps: readonly number[]): { allowed: boolean[]; admitted: number } {
  const allowed: boolean[] = [];
  if (cfg.kind === 'bucket') {
    let tokens = cfg.cap;
    let last = timestamps[0] ?? 0;
    for (const t of timestamps) {
      tokens = Math.min(cfg.cap, tokens + (t - last) * cfg.refillPerSec);
      last = t;
      if (tokens >= 1) { tokens -= 1; allowed.push(true); }
      else allowed.push(false);
    }
  } else {
    const log: number[] = [];
    for (const t of timestamps) {
      while (log.length && log[0] <= t - cfg.windowSec) log.shift();
      if (log.length < cfg.maxReq) { log.push(t); allowed.push(true); }
      else allowed.push(false);
    }
  }
  return { allowed, admitted: allowed.filter(Boolean).length };
}`,
      variants: [
        ['bucket', [{kind: 'bucket', cap: 2, refillPerSec: 0.5}, [0, 0, 1, 2, 4]], false],
        ['window', [{kind: 'window', maxReq: 2, windowSec: 5}, [1, 2, 3, 6, 7]], false],
      ],
    },

    // 20. Recursive schema validator & coercer with custom Error subclass
    {
      name: 'schema_coercer_errors',
      features: ['discriminated-union', 'class', 'exception'],
      code: `
type Schema =
  | { type: 'string'; minLen?: number }
  | { type: 'number'; min?: number; max?: number }
  | { type: 'object'; fields: Record<string, Schema> };

class ValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super('Validation failed: ' + issues.join('; '));
    this.name = 'ValidationError';
  }
}

function validate(schema: Schema, val: unknown, path: string, issues: string[]): unknown {
  if (schema.type === 'string') {
    if (typeof val !== 'string') { issues.push(path + ':expected-string'); return val; }
    const s = val.trim();
    if (schema.minLen !== undefined && s.length < schema.minLen) issues.push(path + ':too-short');
    return s;
  }
  if (schema.type === 'number') {
    const n = typeof val === 'string' && val.trim() !== '' ? Number(val) : val;
    if (typeof n !== 'number' || !Number.isFinite(n)) { issues.push(path + ':expected-number'); return val; }
    if (schema.min !== undefined && n < schema.min) issues.push(path + ':below-min');
    if (schema.max !== undefined && n > schema.max) issues.push(path + ':above-max');
    return n;
  }
  if (typeof val !== 'object' || val === null || Array.isArray(val)) {
    issues.push(path + ':expected-object');
    return val;
  }
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(schema.fields)) {
    out[k] = validate(sub, (val as Record<string, unknown>)[k], path ? path + '.' + k : k, issues);
  }
  return out;
}

export function run(schema: Schema, input: unknown, strict: boolean) {
  const issues: string[] = [];
  const coerced = validate(schema, input, '', issues);
  if (strict && issues.length > 0) throw new ValidationError(issues);
  return { valid: issues.length === 0, coerced, issues };
}`,
      variants: [
        ['ok', [{type: 'object', fields: {name: {type: 'string', minLen: 2}, port: {type: 'number', min: 1, max: 65535}}}, {name: ' api ', port: '8080'}, true], false],
        ['throw', [{type: 'object', fields: {name: {type: 'string', minLen: 3}, port: {type: 'number', min: 100}}}, {name: 'a', port: 20}, true], true],
      ],
    },

    // 21. Functional Parser<T> combinators for key=val filter DSL
    {
      name: 'parser_combinator_dsl',
      features: ['generics', 'functional', 'closure'],
      code: `
type ParseRes<T> = { ok: true; val: T; rest: string } | { ok: false };
type Parser<T> = (input: string) => ParseRes<T>;

const regex = (re: RegExp): Parser<string> => (s) => {
  const m = re.exec(s);
  return m ? { ok: true, val: m[0], rest: s.slice(m[0].length) } : { ok: false };
};
const ws = regex(/^\\s*/);
const lex = <T>(p: Parser<T>): Parser<T> => (s) => {
  const r1 = ws(s);
  return r1.ok ? p(r1.rest) : { ok: false };
};
const seq = <A, B>(a: Parser<A>, b: Parser<B>): Parser<[A, B]> => (s) => {
  const ra = a(s); if (!ra.ok) return ra;
  const rb = b(ra.rest); if (!rb.ok) return rb;
  return { ok: true, val: [ra.val, rb.val], rest: rb.rest };
};
const many = <T>(p: Parser<T>): Parser<T[]> => (s) => {
  const out: T[] = [];
  let cur = s;
  while (true) {
    const r = p(cur);
    if (!r.ok || r.rest === cur) break;
    out.push(r.val);
    cur = r.rest;
  }
  return { ok: true, val: out, rest: cur };
};

export function run(query: string): Array<[string, string, string]> {
  const ident = lex(regex(/^[a-zA-Z_][a-zA-Z0-9_]*/));
  const op = lex(regex(/^(?:>=|<=|!=|=|>|<)/));
  const val = lex(regex(/^[a-zA-Z0-9_.-]+/));
  const clause: Parser<[string, string, string]> = (s) => {
    const r = seq(seq(ident, op), val)(s);
    return r.ok ? { ok: true, val: [r.val[0][0], r.val[0][1], r.val[1]], rest: r.rest } : { ok: false };
  };
  const parsed = many(clause)(query);
  return parsed.ok ? parsed.val : [];
}`,
      variants: [
        ['a', ['status=open priority>=3 owner!=bot'], false],
        ['b', ['env=prod latency<250'], false],
      ],
    },

    // 22. CRDT LWW-Element-Set + G-Counter convergence
    {
      name: 'crdt_lww_gcounter',
      features: ['interfaces', 'map', 'set'],
      code: `
interface LwwState { add: Record<string, number>; rem: Record<string, number> }
function mergeLww(a: LwwState, b: LwwState): LwwState {
  const mergeMap = (m1: Record<string, number>, m2: Record<string, number>) => {
    const out: Record<string, number> = { ...m1 };
    for (const [k, t] of Object.entries(m2)) out[k] = Math.max(out[k] ?? -1, t);
    return out;
  };
  return { add: mergeMap(a.add, b.add), rem: mergeMap(a.rem, b.rem) };
}
function activeElements(st: LwwState): string[] {
  return Object.entries(st.add)
    .filter(([k, ta]) => ta > (st.rem[k] ?? -1))
    .map(([k]) => k)
    .sort();
}
function mergeGCounter(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, number> = {};
  for (const k of [...keys].sort()) out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  return out;
}
export function run(s1: LwwState, s2: LwwState, c1: Record<string, number>, c2: Record<string, number>) {
  const lww = mergeLww(s1, s2);
  const gc = mergeGCounter(c1, c2);
  const sum = Object.values(gc).reduce((a, b) => a + b, 0);
  return { elements: activeElements(lww), counter: gc, total: sum };
}`,
      variants: [
        ['a', [{add: {a: 1, b: 3}, rem: {a: 2}}, {add: {a: 4, c: 2}, rem: {b: 5}}, {n1: 4, n2: 1}, {n1: 2, n2: 6}], false],
        ['b', [{add: {x: 5}, rem: {x: 5}}, {add: {y: 1}, rem: {}}, {a: 3}, {b: 7}], false],
      ],
    },

    // 23. LCS diff generator & patch applier with discriminated EditOp
    {
      name: 'lcs_diff_patch_ops',
      features: ['discriminated-union', 'dp'],
      code: `
type EditOp = { op: 'keep'; v: string } | { op: 'del'; v: string } | { op: 'ins'; v: string };
function diff(a: readonly string[], b: readonly string[]): EditOp[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: EditOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ op: 'keep', v: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', v: a[i] }); i++; }
    else { ops.push({ op: 'ins', v: b[j] }); j++; }
  }
  while (i < m) ops.push({ op: 'del', v: a[i++] });
  while (j < n) ops.push({ op: 'ins', v: b[j++] });
  return ops;
}
export function run(a: readonly string[], b: readonly string[]) {
  const ops = diff(a, b);
  const rebuilt = ops.filter(o => o.op !== 'del').map(o => o.v);
  return { ops, matchesTarget: JSON.stringify(rebuilt) === JSON.stringify(b) };
}`,
      variants: [
        ['a', [['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'e']], false],
        ['b', [['k', 'm'], ['m', 'n', 'p']], false],
      ],
    },

    // 24. Topological DI service container with cycle detection throw
    {
      name: 'di_service_container',
      features: ['interfaces', 'set', 'exception'],
      code: `
interface ServiceDef { name: string; deps: readonly string[]; cost: number }
export function run(defs: readonly ServiceDef[]): { order: string[]; totalCost: number } {
  const byName = new Map(defs.map(d => [d.name, d]));
  const state = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];
  function visit(name: string): void {
    const st = state.get(name) ?? 0;
    if (st === 2) return;
    if (st === 1) throw new Error('Dependency cycle at ' + name);
    const def = byName.get(name);
    if (!def) throw new Error('Unknown service ' + name);
    state.set(name, 1);
    for (const dep of def.deps) visit(dep);
    state.set(name, 2);
    order.push(name);
  }
  for (const d of defs) visit(d.name);
  const totalCost = order.reduce((s, n) => s + byName.get(n)!.cost, 0);
  return { order, totalCost };
}`,
      variants: [
        ['dag', [[{name: 'api', deps: ['auth', 'db'], cost: 3}, {name: 'auth', deps: ['db'], cost: 2}, {name: 'db', deps: [], cost: 5}]], false],
        ['cycle', [[{name: 'a', deps: ['b'], cost: 1}, {name: 'b', deps: ['a'], cost: 1}]], true],
      ],
    },

    // 25. Binary DataView / Uint8Array TLV packet codec with enum
    {
      name: 'binary_packet_codec',
      features: ['enum', 'typed-array', 'binary'],
      code: `
enum FieldTag { Int16 = 1, Ascii = 2 }
type FieldVal = { tag: FieldTag.Int16; value: number } | { tag: FieldTag.Ascii; value: string };

export function run(fields: readonly FieldVal[]) {
  const chunks: Uint8Array[] = [];
  for (const f of fields) {
    if (f.tag === FieldTag.Int16) {
      const b = new Uint8Array(4);
      const dv = new DataView(b.buffer);
      dv.setUint8(0, f.tag); dv.setUint8(1, 2); dv.setInt16(2, f.value, false);
      chunks.push(b);
    } else {
      const enc = new TextEncoder().encode(f.value);
      const b = new Uint8Array(2 + enc.length);
      b[0] = f.tag; b[1] = enc.length; b.set(enc, 2);
      chunks.push(b);
    }
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const pkt = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { pkt.set(c, off); off += c.length; }
  const decoded: Array<{ tag: string; value: number | string }> = [];
  const dv = new DataView(pkt.buffer);
  let p = 0;
  while (p < pkt.length) {
    const tag = pkt[p] as FieldTag;
    const len = pkt[p + 1];
    p += 2;
    if (tag === FieldTag.Int16) decoded.push({ tag: FieldTag[tag], value: dv.getInt16(p, false) });
    else decoded.push({ tag: FieldTag[tag], value: new TextDecoder().decode(pkt.subarray(p, p + len)) });
    p += len;
  }
  return { bytes: totalLen, decoded };
}`,
      variants: [
        ['a', [[{tag: 1, value: -320}, {tag: 2, value: 'ACK'}]], false],
        ['b', [[{tag: 2, value: 'v2'}, {tag: 1, value: 1024}, {tag: 2, value: 'OK'}]], false],
      ],
    },

    // 26. Multi-currency pricing engine with discount combinators
    {
      name: 'multicurrency_pricer',
      features: ['discriminated-union', 'interfaces', 'readonly'],
      code: `
interface LineItem { readonly sku: string; readonly unitCents: number; readonly qty: number }
type Discount =
  | { kind: 'pct'; bps: number }
  | { kind: 'flat'; cents: number }
  | { kind: 'bogo'; sku: string };

export function run(items: readonly LineItem[], discounts: readonly Discount[], taxBps: number) {
  let subtotal = items.reduce((s, it) => s + it.unitCents * it.qty, 0);
  let saved = 0;
  for (const d of discounts) {
    if (d.kind === 'bogo') {
      for (const it of items) {
        if (it.sku === d.sku) saved += Math.floor(it.qty / 2) * it.unitCents;
      }
    } else if (d.kind === 'pct') {
      saved += Math.round((subtotal - saved) * d.bps / 10000);
    } else {
      saved += Math.min(subtotal - saved, d.cents);
    }
  }
  const taxable = Math.max(0, subtotal - saved);
  const tax = Math.round(taxable * taxBps / 10000);
  return { subtotal, saved, tax, total: taxable + tax };
}`,
      variants: [
        ['a', [[{sku: 'tee', unitCents: 2000, qty: 3}, {sku: 'hat', unitCents: 1500, qty: 1}], [{kind: 'bogo', sku: 'tee'}, {kind: 'pct', bps: 1000}], 825], false],
        ['b', [[{sku: 'book', unitCents: 3000, qty: 2}], [{kind: 'flat', cents: 750}], 500], false],
      ],
    },

    // 27. Cron field matcher + IterableIterator generator
    {
      name: 'cron_schedule_iter',
      features: ['generator', 'interfaces', 'set'],
      code: `
function expandField(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(',')) {
    const [rangePart, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min, hi = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-').map(Number);
        lo = a; hi = b;
      } else {
        lo = hi = Number(rangePart);
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function* nextMinutes(minExpr: string, hourExpr: string, startMin: number): IterableIterator<string> {
  const mins = expandField(minExpr, 0, 59);
  const hours = expandField(hourExpr, 0, 23);
  for (let m = startMin; m < startMin + 1440; m++) {
    const cur = m % 1440;
    const h = Math.floor(cur / 60), mm = cur % 60;
    if (hours.has(h) && mins.has(mm)) {
      yield String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }
  }
}

export function run(minExpr: string, hourExpr: string, startMin: number, count: number): string[] {
  const it = nextMinutes(minExpr, hourExpr, startMin);
  const res: string[] = [];
  for (const slot of it) {
    res.push(slot);
    if (res.length >= count) break;
  }
  return res;
}`,
      variants: [
        ['a', ['*/15', '9-10', 540, 5], false],
        ['b', ['5,35', '23,0', 1400, 4], false],
      ],
    },
  ];

  const tasks = [];
  for (const spec of pureSpecs) {
    const fam = `stage10-ts-hairy:${spec.name}`;
    const files = {'src/main.ts': spec.code.trim() + '\n'};
    for (const [vTag, vArgs, isThrow] of spec.variants) {
      tasks.push({
        id: `stage10-ts-hairy-${spec.name.replaceAll('_', '-')}-${vTag}`,
        family: fam,
        language: 'ts',
        executionMode: 'native',
        files,
        entryFile: 'src/main.ts',
        entry: 'run',
        args: encodeReadable(vArgs),
        fixture: {calls: []},
        tier: isThrow ? 5 : 4,
        features: [...new Set(['typescript', 'hairy-ts', ...spec.features, ...(isThrow ? ['exception'] : [])])],
        metadata: {bucket: 'bucket_b_single_ts', sourceOrigin: 'stage10-ts-hairy'},
      });
    }
  }

  // 28-30: 3 Effectful single-file TypeScript causal-pair families (6 tasks)
  const effSpecs = [
    {
      name: 'effect_typed_circuit_breaker',
      code: `
interface ApiPayload { ok: boolean; value: number }
type Outcome = { source: 'live'; value: number; ts: number } | { source: 'fallback'; value: number; reason: string; ts: number };

export async function run(endpoint: string, fallbackVal: number): Promise<Outcome> {
  const ts = Date.now();
  try {
    const resp = await fetch(endpoint, { method: 'GET', headers: { accept: 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = (await resp.json()) as ApiPayload;
    console.info('live-ok:' + data.value);
    return { source: 'live', value: data.value, ts };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('fallback:' + reason);
    return { source: 'fallback', value: fallbackVal, reason, ts };
  }
}`,
      args: ['https://svc.internal/v1/score', 42],
      httpA: [{status: 200, body: {ok: true, value: 99}}],
      httpB: [{reject: true, name: 'TypeError', message: 'ECONNREFUSED'}],
    },
    {
      name: 'effect_typed_retry_client',
      code: `
interface FetchReport { attempts: number; status: number; body: Record<string, unknown> | null }

export async function run(url: string, maxAttempts: number): Promise<FetchReport> {
  let lastStatus = 0;
  for (let i = 1; i <= maxAttempts; i++) {
    const resp = await fetch(url, { method: 'GET' });
    lastStatus = resp.status;
    if (resp.ok) {
      const body = (await resp.json()) as Record<string, unknown>;
      return { attempts: i, status: resp.status, body };
    }
    console.warn('attempt-' + i + '-status-' + resp.status);
    if (resp.status < 500) {
      return { attempts: i, status: resp.status, body: null };
    }
  }
  return { attempts: maxAttempts, status: lastStatus, body: null };
}`,
      args: ['https://api.internal/v2/job', 3],
      httpA: [{status: 503, body: {}}, {status: 200, body: {done: true}}],
      httpB: [{status: 400, body: {err: 'bad-req'}}],
    },
    {
      name: 'effect_typed_config_overlay',
      code: `
interface ServiceConfig { region: string; retries: number; strict: boolean }

export async function run(cfgUrl: string, defaults: Readonly<ServiceConfig>): Promise<ServiceConfig & { loadedAt: number; remote: boolean }> {
  const loadedAt = Date.now();
  try {
    const resp = await fetch(cfgUrl, { method: 'GET' });
    if (!resp.ok) throw new Error('status-' + resp.status);
    const patch = (await resp.json()) as Partial<ServiceConfig>;
    console.info('overlay-applied');
    return { ...defaults, ...patch, loadedAt, remote: true };
  } catch {
    console.warn('using-defaults');
    return { ...defaults, loadedAt, remote: false };
  }
}`,
      args: ['https://cfg.internal/service.json', {region: 'us-east', retries: 2, strict: false}],
      httpA: [{status: 200, body: {retries: 5, strict: true}}],
      httpB: [{status: 500, body: {}}],
    },
  ];

  for (const sp of effSpecs) {
    const fam = `stage10-ts-hairy:${sp.name}`;
    const files = {'src/main.ts': sp.code.trim() + '\n'};
    const callsA = await recordTsFixture({files, entryFile: 'src/main.ts', args: sp.args, http: sp.httpA});
    const callsB = await recordTsFixture({files, entryFile: 'src/main.ts', args: sp.args, http: sp.httpB});
    tasks.push({
      id: `stage10-ts-hairy-${sp.name.replaceAll('_', '-')}-a`,
      family: fam,
      language: 'ts',
      executionMode: 'native',
      files,
      entryFile: 'src/main.ts',
      entry: 'run',
      args: encodeReadable(sp.args),
      fixture: {calls: callsA},
      tier: 5,
      features: ['typescript', 'hairy-ts', 'async', 'effectful', 'causal-branch', 'http'],
      metadata: {bucket: 'bucket_b_single_ts', sourceOrigin: 'stage10-ts-hairy', variant: 'a'},
    });
    tasks.push({
      id: `stage10-ts-hairy-${sp.name.replaceAll('_', '-')}-b`,
      family: fam,
      language: 'ts',
      executionMode: 'native',
      files,
      entryFile: 'src/main.ts',
      entry: 'run',
      args: encodeReadable(sp.args),
      fixture: {calls: callsB},
      tier: 5,
      features: ['typescript', 'hairy-ts', 'async', 'effectful', 'causal-branch', 'http'],
      metadata: {bucket: 'bucket_b_single_ts', sourceOrigin: 'stage10-ts-hairy', variant: 'b'},
    });
  }

  return tasks;
}

// ==================== PART B2: 14 Brand-New 45-120 File Multi-File 65K TS Repos (42 tasks) ====================

const TS_DISTRACTOR_GROUPS = [
  ['adapters', ['grpcClient', 'kafkaSink', 'redisStore', 's3Mirror', 'httpPool', 'ndjsonCodec', 'csvExport', 'otelTracer', 'amqpBridge', 'natsSub']],
  ['validators', ['schemaV1', 'schemaV2', 'idempotency', 'quotaCheck', 'hmacVerify', 'tenantBounds', 'sizeGuard', 'clockSkew', 'utf8Guard', 'crcCheck']],
  ['handlers', ['webhookIn', 'cronTick', 'batchFlush', 'replayCmd', 'backfillOp', 'drainHook', 'healthz', 'metricsOut', 'statusApi', 'debugDump']],
  ['compat', ['v1Codec', 'v2Codec', 'fieldAlias', 'legacyHook', 'xmlBridge', 'iniParse', 'envMap', 'pathNorm', 'tzAlias', 'urlCanon']],
  ['analytics', ['cohortRollup', 'funnelCalc', 'latencyHist', 'errorMatrix', 'costAlloc', 'sloBurn', 'driftScore', 'trendFit', 'quantileBin', 'anomalyZ']],
  ['compliance', ['piiMask', 'gdprErase', 'soc2Log', 'ttlSweep', 'accessAudit', 'keyRotate', 'consentDb', 'legalHold', 'bundleZip', 'policySnap']],
  ['cli', ['inspectCmd', 'verifyCmd', 'diffCmd', 'seedCmd', 'pruneCmd', 'benchCmd', 'doctorCmd', 'tailCmd', 'exportCmd', 'replayCli']],
  ['integrations', ['slackCard', 'jiraBridge', 'pagerV2', 'githubCheck', 'linearSync', 'emailMime', 'datadogEv', 'teamsPost', 'opsgenie', 'webhookSig']],
  ['ops', ['liveness', 'readiness', 'leaderLock', 'shardRouter', 'breakerCfg', 'bulkhead', 'retryBudget', 'backpressure', 'hedgeReq', 'canaryGate']],
  ['testing', ['fixtureGen', 'clockStub', 'httpTape', 'snapCmp', 'fuzzPool', 'chaosInj', 'loadGen', 'contractChk', 'goldenDiff', 'mockBroker']],
  ['storage', ['pgPool', 'sqliteWal', 'dynamoMap', 'blobIndex', 'kvShards', 'lockTable', 'checkpoint', 'compactor', 'journalLog', 'snapStore']],
  ['security', ['jwtParse', 'jwksCache', 'rbacGraph', 'abacEval', 'csrfToken', 'corsRules', 'rateLimit', 'ipAllow', 'kmsWrap', 'sigVerify']],
  ['workers', ['jobQueue', 'dlqWorker', 'cronLoop', 'poolMgr', 'leaseRenew', 'fanoutRun', 'stepRetry', 'stateSnap', 'batchSplit', 'sinkFlush']],
  ['ui_models', ['tableView', 'filterBar', 'detailCard', 'toastQueue', 'themeVars', 'routeMap', 'formState', 'badgeMap', 'chartSeries', 'pagerNav']],
];

function makeTsDistractor(domain, group, modName) {
  const cls = modName[0].toUpperCase() + modName.slice(1) + 'Record';
  const upper = modName.replace(/([A-Z])/g, '_$1').toUpperCase();
  return `// Distractor module ${domain}/${group}/${modName}.ts
export interface ${cls} {
  readonly id: string;
  readonly domain: string;
  readonly score: number;
  readonly tags: readonly string[];
}

export const ${upper}_VERSION = '2.1';
export const ${upper}_LIMIT = 128;

export function normalize${cls}(raw: Partial<${cls}>): ${cls} {
  return {
    id: String(raw.id ?? 'anon'),
    domain: ${JSON.stringify(domain)},
    score: Number(raw.score ?? 0),
    tags: Array.isArray(raw.tags) ? raw.tags.map(t => String(t).trim()) : [],
  };
}

export function summarize${cls}(rows: readonly ${cls}[]): { count: number; totalScore: number } {
  let totalScore = 0;
  for (const r of rows) totalScore += r.score;
  return { count: rows.length, totalScore: Math.round(totalScore * 100) / 100 };
}
`;
}

function makeTsLargeModulePadding(tag, count = 10) {
  const parts = [];
  for (let i = 1; i <= count; i++) {
    parts.push(`
export interface ${tag}DiagSnapshot${i} {
  readonly shard: string;
  readonly count: number;
  readonly score: number;
}

export function compute${tag}Diag${i}(items: readonly Array<Record<string, unknown>>, cutoff = ${i * 10}): ${tag}DiagSnapshot${i} {
  let count = 0;
  let score = 0;
  for (const row of items) {
    const v = Number(row?.weight ?? row?.score ?? ${i});
    if (v >= cutoff) {
      count++;
      score += v;
    }
  }
  return { shard: ${JSON.stringify(tag + '-' + i)}, count, score };
}
`);
  }
  return parts.join('\n');
}

async function buildMultiFileTsRepo(spec) {
  const {
    domain,
    title,
    apiUrl,
    engineClass,
    engineCode,
    policyClass,
    policyCode,
    distractorGroups,
    modsPerGroup,
    runArgs,
    liveBody,
    fallbackDefaults,
    throwBody,
  } = spec;

  const files = {};
  files['src/types.ts'] = `// Shared domain types for ${title}
export enum RunStatus {
  Ok = 'OK',
  Degraded = 'DEGRADED',
  Rejected = 'REJECTED',
}

export interface InputItem {
  readonly id: string;
  readonly category: string;
  readonly value: number;
  readonly weight?: number;
  readonly extra?: string;
}

export interface EvaluatedItem {
  readonly id: string;
  readonly bucket: string;
  readonly score: number;
  readonly note: string;
}

export interface FeedPayload {
  readonly source: 'live-http' | 'fallback-defaults';
  readonly threshold: number;
  readonly factor: number;
  readonly blockedCategories: readonly string[];
}

export interface PipelineSummary {
  readonly count: number;
  readonly totalScore: number;
  readonly flaggedIds: readonly string[];
  readonly buckets: Record<string, number>;
}
`;

  files['src/config.ts'] = `import type { FeedPayload } from './types.ts';

export const SERVICE_DOMAIN = ${JSON.stringify(domain)};
export const FEED_ENDPOINT = ${JSON.stringify(apiUrl)};
export const FALLBACK_DEFAULTS: FeedPayload = ${JSON.stringify({source: 'fallback-defaults', ...fallbackDefaults}, null, 2)};
`;

  files['src/audit.ts'] = `export function emitAudit(level: 'info' | 'warn' | 'error', msg: string): number {
  const ts = Date.now();
  const formatted = '[' + ts + '][' + ${JSON.stringify(domain)} + '] ' + msg;
  if (level === 'error') console.error(formatted);
  else if (level === 'warn') console.warn(formatted);
  else console.info(formatted);
  return ts;
}
`;

  files['src/fallback.ts'] = `import { FALLBACK_DEFAULTS } from './config.ts';
import type { FeedPayload } from './types.ts';

export function buildFallbackFeed(batchId: string): FeedPayload & { batchId: string } {
  return {
    ...FALLBACK_DEFAULTS,
    source: 'fallback-defaults',
    batchId,
  };
}
`;

  files['src/client.ts'] = `import { emitAudit } from './audit.ts';
import { FEED_ENDPOINT } from './config.ts';
import { buildFallbackFeed } from './fallback.ts';
import type { FeedPayload } from './types.ts';

export async function loadReferenceFeed(batchId: string): Promise<FeedPayload> {
  const url = FEED_ENDPOINT + '?batch=' + encodeURIComponent(batchId);
  try {
    const resp = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = (await resp.json()) as Omit<FeedPayload, 'source'>;
    return {
      source: 'live-http',
      threshold: Number(data.threshold),
      factor: Number(data.factor),
      blockedCategories: Array.isArray(data.blockedCategories) ? data.blockedCategories : [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitAudit('warn', 'live feed failed (' + msg + '); switching to fallback');
    return buildFallbackFeed(batchId);
  }
}
`;

  files['src/normalizer.ts'] = `import type { InputItem } from './types.ts';

export interface NormalizedBatch {
  readonly domain: string;
  readonly items: readonly InputItem[];
  readonly totalWeight: number;
  readonly categories: readonly string[];
}

export function normalizeInputBatch(domain: string, rawItems: readonly InputItem[]): NormalizedBatch {
  const items: InputItem[] = [];
  const catSet = new Set<string>();
  let totalWeight = 0;
  for (const raw of rawItems) {
    const cleanCat = String(raw.category ?? 'default').trim().toLowerCase();
    const cleanWeight = Number.isFinite(raw.weight) ? Number(raw.weight) : 1;
    const cleanVal = Math.round(Number(raw.value ?? 0) * 100) / 100;
    catSet.add(cleanCat);
    totalWeight += cleanWeight;
    items.push({
      id: String(raw.id).trim(),
      category: cleanCat,
      value: cleanVal,
      weight: cleanWeight,
      ...(raw.extra ? { extra: String(raw.extra).trim() } : {}),
    });
  }
  return {
    domain,
    items,
    totalWeight: Math.round(totalWeight * 100) / 100,
    categories: [...catSet].sort(),
  };
}
`;

  files['src/telemetry.ts'] = `import type { EvaluatedItem, PipelineSummary } from './types.ts';

export interface TelemetryDigest {
  readonly domain: string;
  readonly batchId: string;
  readonly itemCount: number;
  readonly bucketKeys: readonly string[];
  readonly maxItemScore: number;
  readonly minItemScore: number;
  readonly meanScore: number;
}

export function buildTelemetryDigest(
  domain: string,
  batchId: string,
  summary: PipelineSummary,
  rows: readonly EvaluatedItem[],
): TelemetryDigest {
  let maxItemScore = rows.length ? -Infinity : 0;
  let minItemScore = rows.length ? Infinity : 0;
  for (const r of rows) {
    if (r.score > maxItemScore) maxItemScore = r.score;
    if (r.score < minItemScore) minItemScore = r.score;
  }
  const meanScore = rows.length ? Math.round((summary.totalScore / rows.length) * 100) / 100 : 0;
  return {
    domain,
    batchId,
    itemCount: rows.length,
    bucketKeys: Object.keys(summary.buckets).sort(),
    maxItemScore,
    minItemScore,
    meanScore,
  };
}
`;

  files['src/engine.ts'] = engineCode.trim() + '\n' + makeTsLargeModulePadding(engineClass, 10);
  files['src/policy.ts'] = policyCode.trim() + '\n' + makeTsLargeModulePadding(policyClass, 10);

  // Barrel re-export module
  files['src/index.ts'] = `export { RunStatus } from './types.ts';
export { SERVICE_DOMAIN } from './config.ts';
export { emitAudit } from './audit.ts';
export { loadReferenceFeed } from './client.ts';
export { normalizeInputBatch } from './normalizer.ts';
export { buildTelemetryDigest } from './telemetry.ts';
export { ${engineClass} } from './engine.ts';
export { ${policyClass} } from './policy.ts';
`;

  // Entry module
  files['src/entry.ts'] = `// Entry point for ${title}
import {
  RunStatus,
  SERVICE_DOMAIN,
  emitAudit,
  loadReferenceFeed,
  normalizeInputBatch,
  buildTelemetryDigest,
  ${engineClass},
  ${policyClass},
} from './index.ts';
import type { InputItem } from './types.ts';

export async function run(batchId: string, items: readonly InputItem[]) {
  emitAudit('info', 'start batch=' + batchId + ' domain=' + SERVICE_DOMAIN);
  const norm = normalizeInputBatch(SERVICE_DOMAIN, items);
  const feed = await loadReferenceFeed(batchId);
  const engine = new ${engineClass}(feed);
  const evaluated = engine.evaluateAll(norm.items);
  const summary = engine.summarize(evaluated);
  const digest = buildTelemetryDigest(SERVICE_DOMAIN, batchId, summary, evaluated);

  const policy = new ${policyClass}(feed);
  const verdict = policy.check(summary, evaluated);
  if (!verdict.approved) {
    emitAudit('error', 'rejected batch=' + batchId + ' reason=' + verdict.reason);
    throw new Error(SERVICE_DOMAIN + ' rejected: ' + verdict.reason);
  }
  const doneTs = emitAudit('info', 'completed batch=' + batchId + ' source=' + feed.source);
  return {
    domain: SERVICE_DOMAIN,
    batchId,
    status: feed.source === 'live-http' ? RunStatus.Ok : RunStatus.Degraded,
    source: feed.source,
    summary,
    digest,
    evaluated,
    doneTs,
  };
}
`;

  // Populate realistic TypeScript distractor modules across subdirs (100-145 files total for 14K-36K tok range)
  const effectiveGroups = Math.min(TS_DISTRACTOR_GROUPS.length, distractorGroups + 4);
  const effectiveMods = Math.min(10, modsPerGroup + 2);
  for (const [grp, mods] of TS_DISTRACTOR_GROUPS.slice(0, effectiveGroups)) {
    for (const m of mods.slice(0, effectiveMods)) {
      files[`src/${grp}/${m}.ts`] = makeTsDistractor(domain, grp, m);
    }
  }

  const fam = `stage10-ts-repo:${domain}`;
  const tasks = [];

  // Variant 1: Live HTTP succeeds (Causal pair A)
  const calls1 = await recordTsFixture({
    files,
    entryFile: 'src/entry.ts',
    args: runArgs,
    http: [{status: 200, body: liveBody}],
  });
  tasks.push({
    id: `stage10-ts-${domain.replaceAll('_', '-')}-live-ok`,
    family: fam,
    language: 'ts',
    executionMode: 'native',
    files,
    entryFile: 'src/entry.ts',
    entry: 'run',
    args: encodeReadable(runArgs),
    fixture: {calls: calls1},
    timeoutMs: 30000,
    tier: 5,
    features: ['long-context-65k', 'multi-file', 'code-load', 'typescript', 'effectful', 'causal-branch', 'http'],
    metadata: {bucket: 'bucket_b_multifile_ts_65k', sourceOrigin: 'stage10-ts-synth-65k', variant: 'live-ok'},
  });

  // Variant 2: Live HTTP rejects -> fallback defaults (Causal pair B — IDENTICAL prompt & args!)
  const calls2 = await recordTsFixture({
    files,
    entryFile: 'src/entry.ts',
    args: runArgs,
    http: [{reject: true, name: 'TypeError', message: 'upstream 503'}],
  });
  tasks.push({
    id: `stage10-ts-${domain.replaceAll('_', '-')}-fallback-ok`,
    family: fam,
    language: 'ts',
    executionMode: 'native',
    files,
    entryFile: 'src/entry.ts',
    entry: 'run',
    args: encodeReadable(runArgs),
    fixture: {calls: calls2},
    timeoutMs: 30000,
    tier: 5,
    features: ['long-context-65k', 'multi-file', 'code-load', 'typescript', 'effectful', 'causal-branch', 'http'],
    metadata: {bucket: 'bucket_b_multifile_ts_65k', sourceOrigin: 'stage10-ts-synth-65k', variant: 'fallback-ok'},
  });

  // Variant 3: Policy rejects -> throws Error!
  const calls3 = await recordTsFixture({
    files,
    entryFile: 'src/entry.ts',
    args: runArgs,
    http: [{status: 200, body: throwBody}],
    allowThrow: true,
  });
  tasks.push({
    id: `stage10-ts-${domain.replaceAll('_', '-')}-policy-throw`,
    family: fam,
    language: 'ts',
    executionMode: 'native',
    files,
    entryFile: 'src/entry.ts',
    entry: 'run',
    args: encodeReadable(runArgs),
    fixture: {calls: calls3},
    timeoutMs: 30000,
    tier: 5,
    features: ['long-context-65k', 'multi-file', 'code-load', 'typescript', 'effectful', 'causal-branch', 'exception', 'http'],
    metadata: {bucket: 'bucket_b_multifile_ts_65k', sourceOrigin: 'stage10-ts-synth-65k', variant: 'policy-throw'},
  });

  return tasks;
}

function makeStandardEngineCode(engineClass, scoreExpr, bucketExpr) {
  return `import type { EvaluatedItem, FeedPayload, InputItem, PipelineSummary } from './types.ts';

export class ${engineClass} {
  private readonly blocked: ReadonlySet<string>;
  constructor(private readonly feed: FeedPayload) {
    this.blocked = new Set(feed.blockedCategories);
  }

  evaluateAll(items: readonly InputItem[]): EvaluatedItem[] {
    return items.map(item => {
      const blocked = this.blocked.has(item.category);
      const rawScore = ${scoreExpr};
      const score = Math.round(rawScore * 100) / 100;
      const bucket = blocked ? 'blocked' : (${bucketExpr});
      return { id: item.id, bucket, score, note: item.category + ':' + bucket };
    });
  }

  summarize(rows: readonly EvaluatedItem[]): PipelineSummary {
    const buckets: Record<string, number> = {};
    const flaggedIds: string[] = [];
    let totalScore = 0;
    for (const r of rows) {
      buckets[r.bucket] = (buckets[r.bucket] ?? 0) + 1;
      totalScore += r.score;
      if (r.bucket === 'blocked' || r.bucket === 'flagged') flaggedIds.push(r.id);
    }
    return {
      count: rows.length,
      totalScore: Math.round(totalScore * 100) / 100,
      flaggedIds,
      buckets,
    };
  }
  describeProfile(tag: string): Record<string, unknown> {
    return {
      engine: ${JSON.stringify(engineClass)},
      tag,
      threshold: this.feed.threshold,
      factor: this.feed.factor,
      blockedCount: this.blocked.size,
      source: this.feed.source,
    };
  }

  validateItemContract(item: InputItem): string[] {
    const errs: string[] = [];
    if (!item.id || item.id.trim().length === 0) errs.push('empty-id');
    if (!item.category || item.category.trim().length === 0) errs.push('empty-category');
    if (!Number.isFinite(item.value) || item.value < 0) errs.push('invalid-value');
    if (item.weight !== undefined && (!Number.isFinite(item.weight) || item.weight < 0)) errs.push('invalid-weight');
    return errs;
  }

  computeCategoryBreakdown(rows: readonly EvaluatedItem[]): Record<string, { count: number; total: number }> {
    const out: Record<string, { count: number; total: number }> = {};
    for (const r of rows) {
      const cat = r.note.split(':')[0] || 'unknown';
      const cur = out[cat] ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total = Math.round((cur.total + r.score) * 100) / 100;
      out[cat] = cur;
    }
    return out;
  }
}`;
}

function makeStandardPolicyCode(policyClass, maxFlagged) {
  return `import type { EvaluatedItem, FeedPayload, PipelineSummary } from './types.ts';

export class ${policyClass} {
  constructor(private readonly feed: FeedPayload) {}

  check(summary: PipelineSummary, rows: readonly EvaluatedItem[]): { approved: boolean; reason: string } {
    const blockedCount = rows.filter(r => r.bucket === 'blocked').length;
    if (blockedCount > 0) {
      return { approved: false, reason: 'blocked-category-count=' + blockedCount };
    }
    if (summary.flaggedIds.length > ${maxFlagged}) {
      return { approved: false, reason: 'flagged=' + summary.flaggedIds.length + '>limit' };
    }
    if (summary.totalScore > this.feed.threshold * 4) {
      return { approved: false, reason: 'totalScore=' + summary.totalScore + '>cap' };
    }
    return { approved: true, reason: 'pass' };
  }

  describeLimits(): Record<string, unknown> {
    return {
      policy: ${JSON.stringify(policyClass)},
      maxFlagged: ${maxFlagged},
      scoreCap: this.feed.threshold * 4,
      blockedCategories: [...this.feed.blockedCategories],
      source: this.feed.source,
    };
  }

  collectAuditReasons(summary: PipelineSummary, rows: readonly EvaluatedItem[]): string[] {
    const reasons: string[] = [];
    for (const r of rows) {
      if (r.bucket === 'blocked') reasons.push('blocked:' + r.id);
      else if (r.bucket === 'flagged') reasons.push('flagged:' + r.id);
    }
    if (summary.totalScore > this.feed.threshold * 4) reasons.push('score-cap-exceeded');
    return reasons;
  }
}`;
}

async function buildPartB2MultiFileTs() {
  const repoSpecs = [
    {
      domain: 'ts_checkout_orchestrator', title: 'Checkout Pricing & Promo Orchestrator',
      apiUrl: 'https://pricing.internal/v1/promos', engineClass: 'CheckoutEngine', policyClass: 'CheckoutPolicy',
      scoreExpr: 'item.value * (item.weight ?? 1) * this.feed.factor',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "standard"', maxFlagged: 1,
      distractorGroups: 7, modsPerGroup: 7,
      runArgs: ['CHK-101', [{id: 'sku1', category: 'apparel', value: 40, weight: 2}, {id: 'sku2', category: 'gear', value: 65, weight: 1}]],
      liveBody: {threshold: 90, factor: 0.9, blockedCategories: ['restricted']},
      fallbackDefaults: {threshold: 100, factor: 1.0, blockedCategories: ['restricted']},
      throwBody: {threshold: 90, factor: 1.0, blockedCategories: ['gear']},
    },
    {
      domain: 'ts_graphql_federation', title: 'GraphQL Subgraph Query Federation Planner',
      apiUrl: 'https://gql.internal/v1/costs', engineClass: 'SubgraphPlanner', policyClass: 'QueryCostGate',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 2) * 3',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "fast"', maxFlagged: 1,
      distractorGroups: 8, modsPerGroup: 7,
      runArgs: ['GQL-42', [{id: 'users', category: 'core', value: 20, weight: 3}, {id: 'orders', category: 'commerce', value: 35, weight: 2}]],
      liveBody: {threshold: 55, factor: 1.1, blockedCategories: ['deprecated']},
      fallbackDefaults: {threshold: 60, factor: 1.2, blockedCategories: ['deprecated']},
      throwBody: {threshold: 20, factor: 2.0, blockedCategories: []},
    },
    {
      domain: 'ts_oauth_token_broker', title: 'OAuth2 JWT Scope & Risk Token Broker',
      apiUrl: 'https://iam.internal/v1/jwks-policy', engineClass: 'TokenRiskEngine', policyClass: 'TokenGrantPolicy',
      scoreExpr: '(item.value + (item.weight ?? 1) * 5) * this.feed.factor',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "trusted"', maxFlagged: 1,
      distractorGroups: 8, modsPerGroup: 8,
      runArgs: ['TOK-09', [{id: 'sub1', category: 'service', value: 12, weight: 2}, {id: 'sub2', category: 'user', value: 18, weight: 3}]],
      liveBody: {threshold: 40, factor: 1.0, blockedCategories: ['revoked']},
      fallbackDefaults: {threshold: 45, factor: 1.05, blockedCategories: ['revoked']},
      throwBody: {threshold: 40, factor: 1.0, blockedCategories: ['user']},
    },
    {
      domain: 'ts_edge_waf_engine', title: 'Edge WAF Request Risk Scoring Engine',
      apiUrl: 'https://waf.internal/v1/intel', engineClass: 'WafScorer', policyClass: 'WafBlockPolicy',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 0) * 10',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "clean"', maxFlagged: 1,
      distractorGroups: 9, modsPerGroup: 8,
      runArgs: ['WAF-77', [{id: 'req1', category: 'api', value: 15, weight: 1}, {id: 'req2', category: 'static', value: 5, weight: 0}]],
      liveBody: {threshold: 50, factor: 1.2, blockedCategories: ['tor']},
      fallbackDefaults: {threshold: 45, factor: 1.3, blockedCategories: ['tor']},
      throwBody: {threshold: 10, factor: 3.0, blockedCategories: []},
    },
    {
      domain: 'ts_design_token_compiler', title: 'Design System Multi-Theme Token Compiler',
      apiUrl: 'https://design.internal/v1/overrides', engineClass: 'TokenCompiler', policyClass: 'ContrastGate',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 1)',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "accessible"', maxFlagged: 1,
      distractorGroups: 7, modsPerGroup: 8,
      runArgs: ['DS-12', [{id: 'primary', category: 'color', value: 14, weight: 2}, {id: 'surface', category: 'spacing', value: 8, weight: 1}]],
      liveBody: {threshold: 30, factor: 1.0, blockedCategories: ['legacy']},
      fallbackDefaults: {threshold: 35, factor: 1.1, blockedCategories: ['legacy']},
      throwBody: {threshold: 30, factor: 1.0, blockedCategories: ['color']},
    },
    {
      domain: 'ts_kanban_sync_engine', title: 'Collaborative Kanban Conflict Sync Engine',
      apiUrl: 'https://board.internal/v1/state', engineClass: 'BoardReconciler', policyClass: 'SyncConflictPolicy',
      scoreExpr: 'item.value * (item.weight ?? 1) * this.feed.factor',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "synced"', maxFlagged: 1,
      distractorGroups: 8, modsPerGroup: 7,
      runArgs: ['KB-33', [{id: 'card1', category: 'todo', value: 10, weight: 2}, {id: 'card2', category: 'doing', value: 15, weight: 1}]],
      liveBody: {threshold: 40, factor: 1.0, blockedCategories: ['locked']},
      fallbackDefaults: {threshold: 45, factor: 1.1, blockedCategories: ['locked']},
      throwBody: {threshold: 10, factor: 2.0, blockedCategories: []},
    },
    {
      domain: 'ts_analytics_funnel', title: 'Session Analytics Conversion Funnel Engine',
      apiUrl: 'https://metrics.internal/v1/baselines', engineClass: 'FunnelAnalyzer', policyClass: 'DropoffPolicy',
      scoreExpr: '(item.value * this.feed.factor) / Math.max(1, item.weight ?? 1)',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "healthy"', maxFlagged: 1,
      distractorGroups: 9, modsPerGroup: 8,
      runArgs: ['AN-50', [{id: 'signup', category: 'web', value: 80, weight: 2}, {id: 'checkout', category: 'mobile', value: 60, weight: 3}]],
      liveBody: {threshold: 60, factor: 1.0, blockedCategories: ['bot']},
      fallbackDefaults: {threshold: 65, factor: 1.1, blockedCategories: ['bot']},
      throwBody: {threshold: 15, factor: 1.5, blockedCategories: []},
    },
    {
      domain: 'ts_invoice_tax_engine', title: 'Multi-Jurisdiction VAT/GST Invoice Tax Engine',
      apiUrl: 'https://tax.internal/v1/rates', engineClass: 'TaxCalculator', policyClass: 'InvoiceAuditGate',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 0)',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "compliant"', maxFlagged: 1,
      distractorGroups: 8, modsPerGroup: 8,
      runArgs: ['INV-88', [{id: 'eu1', category: 'saas', value: 100, weight: 5}, {id: 'us1', category: 'support', value: 50, weight: 2}]],
      liveBody: {threshold: 150, factor: 1.2, blockedCategories: ['sanctioned']},
      fallbackDefaults: {threshold: 160, factor: 1.25, blockedCategories: ['sanctioned']},
      throwBody: {threshold: 150, factor: 1.2, blockedCategories: ['saas']},
    },
    {
      domain: 'ts_feature_rollout_sdk', title: 'Deterministic Feature Rollout Bucketing SDK',
      apiUrl: 'https://flags.internal/v1/rules', engineClass: 'RolloutEvaluator', policyClass: 'ExposureGate',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 1) * 4',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "eligible"', maxFlagged: 1,
      distractorGroups: 9, modsPerGroup: 8,
      runArgs: ['FLG-21', [{id: 'expA', category: 'canary', value: 25, weight: 2}, {id: 'expB', category: 'beta', value: 15, weight: 1}]],
      liveBody: {threshold: 60, factor: 1.0, blockedCategories: ['killed']},
      fallbackDefaults: {threshold: 55, factor: 0.9, blockedCategories: ['killed']},
      throwBody: {threshold: 15, factor: 2.0, blockedCategories: []},
    },
    {
      domain: 'ts_media_transcode_dag', title: 'Adaptive Video Transcode Bitrate Planner',
      apiUrl: 'https://media.internal/v1/profiles', engineClass: 'BitratePlanner', policyClass: 'TranscodeQuotaGate',
      scoreExpr: 'item.value * this.feed.factor * (item.weight ?? 1)',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "standard"', maxFlagged: 1,
      distractorGroups: 7, modsPerGroup: 8,
      runArgs: ['MED-04', [{id: '1080p', category: 'h264', value: 30, weight: 2}, {id: '720p', category: 'av1', value: 18, weight: 1}]],
      liveBody: {threshold: 80, factor: 1.1, blockedCategories: ['corrupt']},
      fallbackDefaults: {threshold: 85, factor: 1.0, blockedCategories: ['corrupt']},
      throwBody: {threshold: 80, factor: 1.1, blockedCategories: ['av1']},
    },
    {
      domain: 'ts_log_alert_correlator', title: 'Real-Time Log Alert Correlator & Runbook Router',
      apiUrl: 'https://obs.internal/v1/thresholds', engineClass: 'AlertCorrelator', policyClass: 'SeverityEscalationGate',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 1) * 6',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "normal"', maxFlagged: 1,
      distractorGroups: 10, modsPerGroup: 8,
      runArgs: ['LOG-63', [{id: 'svcA', category: 'http5xx', value: 12, weight: 2}, {id: 'svcB', category: 'timeout', value: 8, weight: 1}]],
      liveBody: {threshold: 40, factor: 1.2, blockedCategories: ['sev0']},
      fallbackDefaults: {threshold: 45, factor: 1.1, blockedCategories: ['sev0']},
      throwBody: {threshold: 10, factor: 2.5, blockedCategories: []},
    },
    {
      domain: 'ts_shipping_rate_engine', title: 'Multi-Carrier Dimensional Weight Rate Shopper',
      apiUrl: 'https://ship.internal/v1/tariffs', engineClass: 'CarrierRateEngine', policyClass: 'ShippingCapGate',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 2) * 2.5',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "economy"', maxFlagged: 1,
      distractorGroups: 8, modsPerGroup: 8,
      runArgs: ['SHP-19', [{id: 'box1', category: 'ground', value: 18, weight: 4}, {id: 'box2', category: 'air', value: 32, weight: 2}]],
      liveBody: {threshold: 60, factor: 1.1, blockedCategories: ['hazmat']},
      fallbackDefaults: {threshold: 65, factor: 1.15, blockedCategories: ['hazmat']},
      throwBody: {threshold: 60, factor: 1.1, blockedCategories: ['air']},
    },
    {
      domain: 'ts_calendar_booking_api', title: 'Timezone-Aware Calendar Booking Slot Engine',
      apiUrl: 'https://cal.internal/v1/busy', engineClass: 'BookingEngine', policyClass: 'OverbookPolicy',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 1) * 5',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "available"', maxFlagged: 1,
      distractorGroups: 7, modsPerGroup: 7,
      runArgs: ['CAL-31', [{id: 'slot1', category: 'consult', value: 30, weight: 1}, {id: 'slot2', category: 'demo', value: 20, weight: 2}]],
      liveBody: {threshold: 55, factor: 1.0, blockedCategories: ['holiday']},
      fallbackDefaults: {threshold: 60, factor: 1.05, blockedCategories: ['holiday']},
      throwBody: {threshold: 20, factor: 1.5, blockedCategories: []},
    },
    {
      domain: 'ts_bundle_size_auditor', title: 'ESM Chunk Graph Bundle Size Budget Auditor',
      apiUrl: 'https://ci.internal/v1/bundle-baseline', engineClass: 'BundleAuditor', policyClass: 'SizeBudgetGate',
      scoreExpr: 'item.value * this.feed.factor + (item.weight ?? 0) * 3',
      bucketExpr: 'score >= this.feed.threshold ? "flagged" : "within-budget"', maxFlagged: 1,
      distractorGroups: 10, modsPerGroup: 9,
      runArgs: ['BND-92', [{id: 'vendor', category: 'esm', value: 45, weight: 2}, {id: 'app', category: 'esm', value: 28, weight: 1}]],
      liveBody: {threshold: 75, factor: 1.0, blockedCategories: ['forbidden-cjs']},
      fallbackDefaults: {threshold: 80, factor: 1.05, blockedCategories: ['forbidden-cjs']},
      throwBody: {threshold: 25, factor: 1.5, blockedCategories: []},
    },
  ];

  const all = [];
  for (const s of repoSpecs) {
    const engineCode = makeStandardEngineCode(s.engineClass, s.scoreExpr, s.bucketExpr);
    const policyCode = makeStandardPolicyCode(s.policyClass, s.maxFlagged);
    all.push(...await buildMultiFileTsRepo({...s, engineCode, policyCode}));
  }
  return all;
}

// ==================== PART B3: Clean Real OSS Multi-File TypeScript Harvest ====================

const REALEXEC_BLOCKED_TS_REPOS = new Set([
  'darkreader__darkreader',
  'jgm__djot.js',
  'cerebroapp__cerebro',
  'BrainJS__brain.js',
  'helmetjs__helmet',
  'immerjs__immer',
  'cruise-automation__rosbag.js',
  'acornjs__acorn',
  'gka__chroma.js',
  'beautifier__js-beautify',
]);

async function buildPartB3OssMultiFileTs(forbidden) {
  const candidateRepos = [
    '/tmp/tinker-harvest-dgx/kpdecker__jsdiff',
    '/tmp/tinker-harvest-dgx/krisk__Fuse',
    '/tmp/tinker-harvest-dgx/uuidjs__uuid',
    '/tmp/tinker-harvest-dgx/gregjacobs__Autolinker.js',
    '/tmp/tinker-harvest-dgx/steveruizok__perfect-arrows',
    '/tmp/tinker-harvest-dgx/unjs__hookable',
    '/tmp/tinker-harvest-dgx/tweenjs__tween.js',
    '/tmp/tinker-harvest-dgx/cacjs__cac',
    '/tmp/tinker-harvest-dgx/snabbdom__snabbdom',
    '/tmp/tinker-harvest-dgx/vinta__pangu.js',
    '/tmp/tinker-harvest-dgx/yiminghe__async-validator',
    '/tmp/tinker-harvest-dgx/typicode__lowdb',
    '/tmp/tinker-harvest-dgx/chartist-js__chartist',
    '/tmp/tinker-harvest-dgx/grid-js__gridjs',
    '/tmp/tinker-harvest-dgx/cure53__DOMPurify',
    '/tmp/tinker-harvest-dgx/retejs__rete',
    '/tmp/tinker-harvest-dgx/VolodymyrBaydalka__docxjs',
    '/tmp/tinker-harvest-dgx-part2/altcha-org__altcha',
    '/tmp/tinker-harvest-dgx-part2/cuixiaorui__mini-vue',
    '/tmp/tinker-harvest-dgx-part2/d3__d3-sankey',
    '/tmp/tinker-harvest-dgx-wave2/QwikDev__partytown',
    '/tmp/tinker-harvest-dgx-wave2/Tonejs__Tone.js',
  ].filter(p => existsSync(p) && !REALEXEC_BLOCKED_TS_REPOS.has(p.split('/').at(-1)));

  const harvested = [];
  for (const repoDir of candidateRepos) {
    if (harvested.length >= 24) break;
    try {
      const {examples} = await harvestMultiFileRepos([repoDir], {
        singleRepoMode: true,
        minFiles: 4,
        maxFiles: 120,
        maxPerRepo: 3,
        maxPerFn: 2,
        maxTasks: 3,
        minLoadedFiles: 1,
        minEpisodeChars: 4000,
        maxEpisodeChars: MAX_EPISODE_CHARS,
        idPrefix: 'stage10-ts-oss',
        excludeIds: new Set(forbidden.ids),
        excludeSourceHashes: new Set(forbidden.sourceHashes),
        traceFormat: 'compact',
        reasoningChannel: 'thinking',
      });
      for (const ex of examples) {
        if (ex.task?.language !== 'ts') continue;
        // Convert back to raw task for unified 2x verification pass
        harvested.push({
          ...ex.task,
          family: `stage10-ts-oss:${ex.task.metadata?.repo ?? 'oss'}:${ex.task.entryFile}`,
          features: [...new Set([...(ex.task.features ?? []), 'typescript', 'oss-real', 'multi-file', 'code-load'])],
          metadata: {
            ...(ex.task.metadata ?? {}),
            bucket: 'bucket_b_oss_ts',
            sourceOrigin: 'stage10-ts-oss-multifile',
          },
        });
      }
    } catch {
      // Skip repos that fail probing
    }
  }
  return harvested;
}

// ==================== 2x Independent Verification Harness (Direct + Real Node Worker) ====================

class JsWorkerClient {
  constructor() {
    this.proc = spawn(process.execPath, [resolve(REPO_ROOT, 'tools/tinker-execution.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = createInterface({input: this.proc.stdout, crlfDelay: Infinity});
    this.pending = new Map();
    this.seq = 0;
    this.rl.on('line', line => {
      if (!line.trim()) return;
      const resp = JSON.parse(line);
      const entry = this.pending.get(resp.id);
      if (entry) {
        this.pending.delete(resp.id);
        if (resp.ok) entry.resolve(resp.result);
        else entry.reject(new Error(`Worker error: ${resp.error?.name}: ${resp.error?.message}`));
      }
    });
  }

  request(op, payload = {}) {
    const id = `ts-req-${++this.seq}`;
    return new Promise((resolveFn, rejectFn) => {
      this.pending.set(id, {resolve: resolveFn, reject: rejectFn});
      this.proc.stdin.write(JSON.stringify({id, op, ...payload}) + '\n');
    });
  }

  close() {
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill(); } catch {}
  }
}

async function verifyLiveSession(exported) {
  const prepared = await prepareTinkerTask(exported.task, {traceFormat: 'compact'});
  const session = createTinkerSession(prepared);
  try {
    let tok = 0;
    for (const msg of exported.messages) {
      if (msg.role !== 'assistant') continue;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        tok += 30;
        const stepRes = await session.step({role: 'assistant', content: '', tool_calls: [msg.tool_calls[0]]}, tok);
        if (stepRes.done) throw new Error(`Early session termination on ${exported.id}`);
      } else {
        const comp = parseStudentAction(msg);
        tok += 40;
        const doneRes = await session.step(JSON.stringify(comp), tok);
        if (!doneRes.done || !doneRes.grade.success) {
          throw new Error(`Live session grade failed on ${exported.id}: ${doneRes.grade?.reason}`);
        }
      }
    }
  } finally {
    session.close();
  }
}

async function verifyAndPreExportOne(task, worker, forbidden) {
  // Pass 1: Direct exportTinkerExample + live session replay
  const pass1 = await exportTinkerExample(task, {traceFormat: 'compact', reasoningChannel: 'thinking'});
  if (!pass1.metadata?.traceAudit?.replayVerified) {
    throw new Error(`${task.id}: pass1 replayVerified is false`);
  }
  await verifyLiveSession(pass1);

  // Pass 2: Independent export via real JSONL worker `tools/tinker-execution.mjs`
  const pass2 = await worker.request('export', {
    task,
    traceFormat: 'compact',
    reasoningChannel: 'thinking',
  });
  if (pass1.sourceHash !== pass2.sourceHash) {
    throw new Error(`${task.id}: non-deterministic sourceHash across 2x passes`);
  }
  if (JSON.stringify(pass1.messages) !== JSON.stringify(pass2.messages)) {
    throw new Error(`${task.id}: non-deterministic messages across 2x passes`);
  }

  const serialized = JSON.stringify(pass1.messages);
  if (serialized.length > MAX_EPISODE_CHARS) {
    throw new Error(`${task.id}: episodeChars ${serialized.length} > ${MAX_EPISODE_CHARS}`);
  }
  let maxTurnChars = 0;
  for (const m of pass1.messages) {
    if (m.role === 'assistant') {
      const turnText = assistantThinkingText(m) + '\n' + assistantVisibleText(m) +
        (Array.isArray(m.tool_calls) ? '\n' + JSON.stringify(m.tool_calls) : '');
      if (turnText.length > maxTurnChars) maxTurnChars = turnText.length;
    }
  }
  if (maxTurnChars > MAX_TURN_CHARS) {
    throw new Error(`${task.id}: assistant turn chars ${maxTurnChars} > ${MAX_TURN_CHARS}`);
  }

  const fileCount = task.files ? Object.keys(task.files).length : 1;
  const codeLoadCalls = Number(pass1.metadata?.codeLoadCalls ?? 0);
  if (fileCount > 1 && codeLoadCalls < 1) {
    throw new Error(`${task.id}: multi-file TS task has 0 code.load calls`);
  }

  const splitComponent = sha256(`${pass1.family}:${pass1.sourceHash}`);
  if (forbidden.ids.has(pass1.id)) throw new Error(`LEAKAGE id=${pass1.id}`);
  if (forbidden.families.has(pass1.family)) throw new Error(`LEAKAGE family=${pass1.family}`);
  if (forbidden.sourceHashes.has(pass1.sourceHash)) throw new Error(`LEAKAGE sourceHash=${pass1.sourceHash}`);
  if (forbidden.splitComponents.has(splitComponent)) throw new Error(`LEAKAGE split_component=${splitComponent}`);

  return {
    ...pass1,
    split_component: splitComponent,
    metadata: {
      ...(task.metadata ?? {}),
      ...pass1.metadata,
      conversationChars: serialized.length,
      approxTokens35: Math.ceil(serialized.length / 3.5),
      estimatedTokens32: Math.ceil(serialized.length / 3.2),
      maxTurnChars,
      fileCount,
      codeLoadCalls,
      deterministic2xVerified: true,
      liveReplayVerified: true,
    },
  };
}

async function main() {
  const {values} = parseArgs({
    options: {
      output: {type: 'string', default: DEFAULT_OUTPUT},
      report: {type: 'string', default: DEFAULT_REPORT},
      jobs: {type: 'string', default: '4'},
      'realexec-benchmark': {type: 'string', default: DEFAULT_REALEXEC_BM},
      'realexec-manifest': {type: 'string', default: DEFAULT_REALEXEC_MAN},
    },
  });

  const forbidden = loadRealExecForbidden(values['realexec-benchmark'], values['realexec-manifest']);

  process.stderr.write('Building Stage 10 TypeScript candidates...\n');
  const b1 = await buildPartB1SingleFileTs();
  process.stderr.write(`  Part B1 (Hairy single-file TS): ${b1.length} tasks across ${new Set(b1.map(t => t.family)).size} families\n`);
  const b2 = await buildPartB2MultiFileTs();
  process.stderr.write(`  Part B2 (Synth 45-120f TS 65K): ${b2.length} tasks across ${new Set(b2.map(t => t.family)).size} families\n`);
  const b3 = await buildPartB3OssMultiFileTs(forbidden);
  process.stderr.write(`  Part B3 (OSS multi-file TS):    ${b3.length} tasks across ${new Set(b3.map(t => t.family)).size} families\n`);

  const allCandidates = [...b1, ...b2, ...b3];
  const jobs = Math.max(1, Math.min(8, Number(values.jobs) || 4));
  const workers = Array.from({length: jobs}, () => new JsWorkerClient());
  for (const w of workers) {
    const h = await w.request('health');
    if (!h?.schema) throw new Error('JS worker health check failed');
  }

  const results = new Array(allCandidates.length);
  const failures = [];
  let cursor = 0;
  let doneCount = 0;

  try {
    await Promise.all(workers.map(async worker => {
      while (true) {
        const idx = cursor++;
        if (idx >= allCandidates.length) break;
        const task = allCandidates[idx];
        try {
          results[idx] = await verifyAndPreExportOne(task, worker, forbidden);
        } catch (err) {
          failures.push({id: task.id, family: task.family, error: String(err?.message ?? err)});
          process.stderr.write(`FAIL ${task.id}: ${err?.message ?? err}\n`);
        }
        doneCount++;
        if (doneCount % 25 === 0 || doneCount === allCandidates.length) {
          process.stderr.write(`  verified ${doneCount}/${allCandidates.length} (fail=${failures.length})\n`);
        }
      }
    }));
  } finally {
    for (const w of workers) w.close();
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({failures: failures.slice(0, 20), totalFailures: failures.length}, null, 2));
    process.exit(1);
  }

  const verified = results.filter(Boolean);
  const uniqueIds = new Set(verified.map(r => r.id));
  if (uniqueIds.size !== verified.length) throw new Error('Duplicate TS task IDs detected');

  // Causal supervision audit on all causal-branch tasks
  const causalRows = verified.filter(r => (r.task?.features ?? []).includes('causal-branch'));
  const supAudit = await auditTinkerSupervision(causalRows, {formats: ['compact'], samplePerFeature: 1000, seed: 17});
  if (!supAudit.valid || !supAudit.success || !supAudit.allReplayed) {
    throw new Error(`TS auditTinkerSupervision failed: ${JSON.stringify(supAudit.failures)}`);
  }

  const outPath = resolve(values.output);
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, verified.map(r => JSON.stringify(r)).join('\n') + '\n');

  const buckets = {};
  for (const b of ['bucket_b_single_ts', 'bucket_b_multifile_ts_65k', 'bucket_b_oss_ts']) {
    const sub = verified.filter(r => r.metadata?.bucket === b);
    const est = sub.map(r => r.metadata.approxTokens35).sort((a, b) => a - b);
    buckets[b] = {
      count: sub.length,
      families: new Set(sub.map(r => r.family)).size,
      approxTokens35: est.length ? {min: est[0], p50: est[Math.floor(est.length / 2)], max: est.at(-1)} : null,
    };
  }

  const report = {
    totalTasks: verified.length,
    uniqueFamilies: new Set(verified.map(r => r.family)).size,
    buckets,
    maxEpisodeChars: Math.max(...verified.map(r => r.metadata.conversationChars)),
    maxTurnChars: Math.max(...verified.map(r => r.metadata.maxTurnChars)),
    causalAudit: {
      valid: supAudit.valid,
      allReplayed: supAudit.allReplayed,
      causalPairs: supAudit.causalPairs.length,
      causalDivergencesChecked: supAudit.causalDivergencesChecked,
    },
    zeroLeakageChecked: true,
    output: outPath,
  };
  const repPath = resolve(values.report);
  mkdirSync(dirname(repPath), {recursive: true});
  writeFileSync(repPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
