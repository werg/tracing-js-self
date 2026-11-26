import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {encodeReadable, decodeReadable, prepareTinkerTask, exportTinkerExample,
  createTinkerSession, parseStudentAction, normalizedSourceHash,
  assistantVisibleText, assistantThinkingText} from '../src/training/tinker-execution.js';
import {auditCausalPrefixPair} from '../src/training/tinker-supervision.js';
import {hardEffectfulTasks, hardEffectfulTemplates} from '../src/training/tinker-hard-effectful.js';
import {formatValue} from '../src/training/native-trace.js';

const task = (source, options = {}) => ({id: 'case', family: 'family', source, args: [], ...options});
const complete = (value, args = [], kind = 'return') => {
  const encoded = encodeReadable({arguments: args, value});
  return JSON.stringify({type: 'complete', kind, arguments: encoded.arguments, value: encoded.value});
};
const call = (operation, args) => JSON.stringify({type: 'call', operation, arguments: encodeReadable(args)});

test('readable data preserves scalars, aliases, cycles, holes and null prototypes without runtime handles', () => {
  const shared = {n: -0}, sparse = new Array(3); sparse[1] = undefined;
  const object = Object.assign(Object.create(null), {$js: 'literal'});
  const value = {arguments: [shared, shared], value: {shared, sparse, object, big: 123n, nan: NaN, inf: Infinity}};
  value.value.self = value.value;
  const encoded = encodeReadable(value), decoded = decodeReadable(JSON.parse(JSON.stringify(encoded)));
  assert.deepEqual(decoded, value);
  assert.equal(decoded.arguments[0], decoded.arguments[1]);
  assert.equal(decoded.value.shared, decoded.arguments[0]);
  assert.equal(decoded.value.self, decoded.value);
  assert.equal(Object.hasOwn(decoded.value.sparse, 0), false);
  assert.equal(Object.getPrototypeOf(decoded.value.object), null);
  assert.match(JSON.stringify(encoded), /\/arguments\/0/);
  assert.throws(() => decodeReadable({$js: 'ref', path: '/missing'}), /existing data/);
  assert.throws(() => decodeReadable({$js: 'bigint', value: '1.5'}), /bigint/);
});

test('student action parser allows natural prose, code snippets, and trailing punctuation while rejecting ambiguous actions', () => {
  assert.equal(parseStudentAction('I computed the answer.\n```json\n' + complete(2) + '\n```').value, 2);
  assert.equal(parseStudentAction('In `run`:\n```js\nreturn 2;\n```\n```json\n' + complete(2) + '\n```.').value, 2);
  assert.equal(parseStudentAction('```json ' + complete(2) + '```').value, 2);
  assert.deepEqual(parseStudentAction('{"type":"complete","kind":"return","value":2}').arguments, []);
  assert.throws(() => parseStudentAction('```json\n' + complete(2) + '\n```\nextra explanation'), /end the turn/);
  assert.throws(() => parseStudentAction('```json\n' + complete(2) + '\n```\n```json\n' + complete(2) + '\n```'), /exactly one/);
  assert.throws(() => parseStudentAction('{"type":"call","operation":"demo.readNumber","arguments":[],"answer":3}'), /call action/);
  assert.throws(() => parseStudentAction('{"type":"complete","kind":"return","arguments":[],"value":2,"extra":1}'), /completion/);
});

test('readable exporter uses Inkling thinking blocks and native tool calls by default', async () => {
  const input = task('function run(x){const y=host.readNumber("x")+x;host.store("y",y);return y;}', {
    args: [1], fixture: {calls: [{operation: 'demo.readNumber', arguments: ['x'], result: 4},
      {operation: 'demo.store', arguments: ['y', 5], result: {$js: 'undefined'}}]}});
  const exported = await exportTinkerExample(input);
  assert.deepEqual(exported.messages.map(message => message.role), ['system', 'tool_declare', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  assert.equal(exported.metadata.reasoningChannel, 'thinking');
  assert.match(assistantThinkingText(exported.messages[5]), /host\.readNumber\("x"\)\+x => 5/);
  assert.equal(exported.messages[5].tool_calls[0].function.name, 'demo.store');
  assert.deepEqual(JSON.parse(exported.messages[5].tool_calls[0].function.arguments), {arguments: ['y', 5]});
  assert.equal(exported.messages[4].role, 'tool');
  assert.equal(exported.messages[4].name, 'demo.readNumber');
  assert.equal(exported.metadata.externalObservationsTrainable, false);
  assert.equal(exported.metadata.sourceVerified, true);
  const generated = exported.messages.filter(message => message.role === 'assistant')
    .map(message => assistantThinkingText(message) + '\n' + assistantVisibleText(message)).join('\n');
  assert.doesNotMatch(generated, /invocationId|effectId|sourceAdmission|prefixDigest|a0:e/);
  const session = createTinkerSession(await prepareTinkerTask(exported.task));
  for (const message of exported.messages.filter(message => message.role === 'assistant')) await session.step(message, 100);
  assert.equal(session.grade(100).success, true);
});

test('counterfactual private observations cannot alter the initial prompt or request prefix', async () => {
  const make = value => task('function run(){const n=host.readNumber("secret");return n+1;}', {
    fixture: {calls: [{operation: 'demo.readNumber', arguments: ['secret'], result: value}]}});
  const left = await exportTinkerExample(make(7123)), right = await exportTinkerExample(make(9234));
  assert.deepEqual(left.messages.slice(0, 4), right.messages.slice(0, 4));
  assert.doesNotMatch(JSON.stringify(left.messages.slice(0, 4)), /7123|9234/);
  assert.notDeepEqual(left.messages[4], right.messages[4]);
  const session = createTinkerSession(await prepareTinkerTask(make(7123)));
  const bad = await session.step(call('demo.readNumber', ['incorrect']), 12);
  assert.equal(bad.done, true); assert.equal(bad.grade.reward, 0); assert.deepEqual(bad.messages, []);
  assert.equal(bad.grade.complete, false);
  assert.doesNotMatch(JSON.stringify(bad), /7123|secret|demo\.readNumber/);
});

test('different shorter reasoning succeeds only with complete effects and result, and earns higher reward', async () => {
  const prepared = await prepareTinkerTask(task('function run(){host.store("answer",2);return 2;}', {
    fixture: {calls: [{operation: 'demo.store', arguments: ['answer', 2]}]}}));
  const missing = createTinkerSession(prepared);
  const incomplete = await missing.step(complete(2), 5);
  assert.equal(incomplete.grade.success, false); assert.equal(incomplete.grade.complete, false);
  const wrong = createTinkerSession(prepared);
  await wrong.step(call('demo.store', ['answer', 2]), 10);
  assert.equal((await wrong.step(complete(3), 15)).grade.reward, 0);
  const short = createTinkerSession(prepared), long = createTinkerSession(prepared);
  await short.step(call('demo.store', ['answer', 2]), 10);
  await long.step('An entirely different derivation.\n```json\n' + call('demo.store', ['answer', 2]) + '\n```', 200);
  const a = await short.step(complete(2), 20), b = await long.step(complete(2), 400);
  assert.equal(a.grade.success, true); assert.equal(b.grade.success, true);
  assert(a.grade.reward > b.grade.reward);
  assert.equal(createTinkerSession(prepared).grade(25).reward, 0);
});

test('completion grading preserves input mutation and return/input aliasing', async () => {
  const prepared = await prepareTinkerTask(task('function run(obj){obj.x++;return obj;}', {args: [{x: 1}]}));
  const wrong = createTinkerSession(prepared);
  assert.equal((await wrong.step(complete({x: 2}, [{x: 1}]), 10)).grade.success, false);
  const copy = createTinkerSession(prepared);
  assert.equal((await copy.step(complete({x: 2}, [{x: 2}]), 10)).grade.success, false, 'equal copies are not the returned argument alias');
  const correct = createTinkerSession(prepared), shared = {x: 2};
  assert.equal((await correct.step(complete(shared, [shared]), 10)).grade.success, true);
});

test('exceptional scalars and standard exception values use complete semantic comparison', async () => {
  for (const [source, value, kind] of [
    ['function run(){return 0/0;}', NaN, 'return'],
    ['function run(){return -0;}', -0, 'return'],
    ['function run(){return 1/0;}', Infinity, 'return'],
    ['function run(){return undefined;}', undefined, 'return'],
    ['function run(){throw "bad";}', 'bad', 'throw'],
    ['function run(){throw new TypeError("bad");}', {name: 'TypeError', message: 'bad'}, 'throw']
  ]) {
    const prepared = await prepareTinkerTask(task(source)), session = createTinkerSession(prepared);
    assert.equal((await session.step(complete(value, [], kind), 10)).grade.success, true, source);
  }
});

test('rejected external observations arrive as inputs and the student can catch them', async () => {
  const prepared = await prepareTinkerTask(task('async function run(){try{return await host.readAsync("x");}catch(e){return e+"!";}}', {
    fixture: {calls: [{operation: 'demo.readAsync', arguments: ['x'], result: 'failed', status: 'rejected'}]}}));
  const session = createTinkerSession(prepared);
  const observation = await session.step(call('demo.readAsync', ['x']), 10);
  assert.equal(observation.done, false); assert.match(observation.messages[0].content, /rejected/);
  assert.equal((await session.step(complete('failed!'), 20)).grade.success, true);
});

test('clock and console effects stay on the existing capability boundary', async () => {
  const prepared = await prepareTinkerTask(task('function run(){const n=Date.now();console.log(n);return n;}', {
    fixture: {calls: [{operation: 'platform.dateNow', arguments: [], result: 123},
      {operation: 'platform.console.log', arguments: [123]}]}}));
  const session = createTinkerSession(prepared);
  await session.step(call('platform.dateNow', []), 10);
  await session.step(call('platform.console.log', [123]), 20);
  assert.equal((await session.step(complete(123), 30)).grade.success, true);
  // Sequential multi-tool-call turns execute in order and return matching tool observations.
  const batched = await prepareTinkerTask(task('function run(){host.store("a",1);host.store("b",2);return 3;}', {
    fixture: {calls: [{operation: 'demo.store', arguments: ['a', 1]}, {operation: 'demo.store', arguments: ['b', 2]}]}}));
  const batchSession = createTinkerSession(batched);
  const step = await batchSession.step({role: 'assistant', content: '', tool_calls: [
    {type: 'function', id: 'tc1', function: {name: 'demo.store', arguments: '{"arguments":["a",1]}'}},
    {type: 'function', id: 'tc2', function: {name: 'demo.store', arguments: '{"arguments":["b",2]}'}},
  ]}, 15);
  assert.equal(step.done, false);
  assert.equal(step.messages.length, 2);
  assert.deepEqual(step.messages.map(m => [m.role, m.tool_call_id, m.name]), [
    ['tool', 'tc1', 'demo.store'], ['tool', 'tc2', 'demo.store'],
  ]);
  assert.equal((await batchSession.step(complete(3), 25)).grade.success, true);
});

test('fresh randomness is privately materialized once and preserved for reproducible start/export', async () => {
  const exported = await exportTinkerExample(task('function run(){return freshRandom();}', {freshRandomCalls: 1}));
  assert.equal(exported.task.freshRandomCalls, 0);
  const draw = exported.task.fixture.calls[0].result;
  assert(draw >= 0 && draw < 1);
  assert.doesNotMatch(JSON.stringify(exported.messages.slice(0, 4)), new RegExp(String(draw).replace('.', '\\.')));
  const session = createTinkerSession(await prepareTinkerTask(exported.task));
  const observed = await session.step(call('freshRandom', []), 10);
  assert.equal(observed.messages[0].role, 'tool');
  assert.equal(observed.messages[0].name, 'freshRandom');
  assert.equal((await session.step(complete(draw), 20)).grade.success, true);
});

test('an existing strict directive is preserved when hoisted native wrappers are added', async () => {
  const exported = await exportTinkerExample(task('"use strict";function run(){return lookup("key");}', {
    nativeBindings: [{name: 'lookup', kind: 'synchronous'}], fixture: {calls: [
      {operation: 'natlang.callSync', arguments: ['lookup', {$js: 'undefined'}, ['key']], result: 9}]}}));
  const generated = exported.messages.filter(message => message.role === 'assistant');
  assert.doesNotMatch(generated.map(message => assistantThinkingText(message) + '\n' + assistantVisibleText(message)).join('\n'), /natlangCallSync/);
  const session = createTinkerSession(await prepareTinkerTask(exported.task));
  for (const message of generated) await session.step(message, 50);
  assert.equal(session.grade(50).success, true);
});

test('seeded Math.random remains internal computation and TypeScript uses existing lowering', async () => {
  const seed = 17, expected = ((Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const random = createTinkerSession(await prepareTinkerTask(task('function run(){return Math.random();}', {randomSeed: seed})));
  assert.equal((await random.step(complete(expected), 10)).grade.success, true);
  const ts = createTinkerSession(await prepareTinkerTask(task('function run(x:number):number{return x*2;}', {language: 'ts', args: [4]})));
  assert.equal((await ts.step(complete(8, [4]), 10)).grade.success, true);
  assert.equal(normalizedSourceHash('function run(x){return x+1;}'), normalizedSourceHash('/*comment*/ function run (x) { return x + 1; }'));
});

test('unsupported observation schedules and malformed fixtures are refused before training', async () => {
  await assert.rejects(prepareTinkerTask(task('function run(){return 1;}', {fixture: {calls: [
    {operation: 'demo.readAsync', arguments: ['x'], result: 1},
    {operation: 'demo.readAsync', arguments: ['y'], result: 2}], settlementOrder: [1, 0]}})), /separate execution profile/);
  await assert.rejects(prepareTinkerTask(task('function run(){return 1;}', {fixture: {calls: [{operation: 'unknown', arguments: []}]}})), /Unregistered/);
});

test('worker is a private persistent JSONL boundary and returns generic model failures', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/tinker-execution.mjs', import.meta.url))], {stdio: ['pipe', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout}), pending = new Map(); let next = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  const request = body => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({id, ...body}) + '\n'); });
  try {
    const started = await request({op: 'start', task: task('function run(){return 42;}')});
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(Object.hasOwn(started.result, 'outcome'), false);
    const result = await request({op: 'step', sessionId: started.result.sessionId, action: complete(42), generatedTokens: 12});
    assert.equal(result.result.grade.success, true);
    const closed = await request({op: 'close', sessionId: started.result.sessionId});
    assert.equal(closed.result.closed, true);
    const exportedNative = await request({
      op: 'export',
      traceFormat: 'compact',
      task: task('function run(x){const y=x+1;return y*2;}', {executionMode: 'native', args: [5]}),
    });
    assert.equal(exportedNative.ok, true, JSON.stringify(exportedNative));
    assert.match(assistantThinkingText(exportedNative.result.messages.find(m => m.role === 'assistant')), /y = 6/);
  } finally { child.stdin.end(); await new Promise(resolve => child.on('close', resolve)); lines.close(); }
  assert.equal(stderr, '');
});

test('native V8 executionMode runs RegExp, JSON, URL, Date, and non-deterministic platform.random tools', async () => {
  const source = `function run(raw) {
    const parsed = JSON.parse(raw);
    const u = new URL(parsed.url);
    const hit = /^\\/v([0-9]+)\\/(.+)$/.exec(u.pathname);
    const ts = Date.now();
    const year = new Date(ts).getUTCFullYear();
    const roll = Math.random();
    console.warn('roll:' + roll);
    return {ver: Number(hit[1]), path: hit[2], year, roll};
  }`;
  const t = {
    id: 'native-messy-1',
    family: 'native-messy',
    executionMode: 'native',
    randomMode: 'tool',
    source,
    entry: 'run',
    args: ['{"url":"https://api.example.test/v3/orders"}'],
    fixture: {
      calls: [
        {operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: 1700000100000},
        {operation: 'platform.random', arguments: [], status: 'fulfilled', result: 0.425},
        {operation: 'platform.console.warn', arguments: ['roll:0.425'], status: 'fulfilled', result: {$js: 'undefined'}},
      ],
    },
  };
  const prepared = await prepareTinkerTask(t);
  assert.equal(prepared.bundle, null);
  assert.equal(prepared.outcome.kind, 'return');
  const session = createTinkerSession(prepared);
  const declaredTools = JSON.parse(session.messages.find(m => m.role === 'tool_declare').content);
  const tools = declaredTools.map(x => x.function.name);
  assert.ok(tools.includes('platform.dateNow') && tools.includes('platform.random') && tools.includes('platform.console.warn'));
  for (const decl of declaredTools) {
    assert.deepEqual(decl.function.parameters.required, ['arguments'], `expected required:['arguments'] for ${decl.function.name}`);
  }
  const tc = (name, args, id) => ({role: 'assistant', content: '', tool_calls: [{type: 'function', id, function: {name, arguments: JSON.stringify({arguments: args})}}]});
  const s1 = await session.step(tc('platform.dateNow', [], 'c1'), 10);
  assert.equal(s1.done, false);
  assert.equal(JSON.parse(s1.messages[0].content).value, 1700000100000);
  const s2 = await session.step(tc('platform.random', [], 'c2'), 20);
  assert.equal(JSON.parse(s2.messages[0].content).value, 0.425);
  const s3 = await session.step(tc('platform.console.warn', ['roll:0.425'], 'c3'), 30);
  assert.equal(s3.done, false);
  const s4 = await session.step(complete({ver: 3, path: 'orders', year: 2023, roll: 0.425}, ['{"url":"https://api.example.test/v3/orders"}']), 50);
  assert.equal(s4.done, true);
  assert.equal(s4.grade.success, true);
});

test('native V8 compact trace covers pure messy JS and matches uninstrumented outcome byte-for-byte', async () => {
  const source = `function scoreItem(tag, n) {
    const bonus = /^vip-([0-9]+)$/.exec(tag) ? 10 : 0;
    return n * 2 + bonus;
  }
  function run(payload, state) {
    const data = JSON.parse(payload);
    let total = 0;
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      if (item.active) {
        total += scoreItem(item.tag, item.v);
        state.hits++;
      }
    }
    state.total = total;
    return {total, hits: state.hits};
  }`;
  const t = {
    id: 'native-pure-trace-1',
    family: 'native-pure-trace',
    executionMode: 'native',
    source,
    entry: 'run',
    args: ['{"items":[{"tag":"vip-1","v":3,"active":true},{"tag":"std","v":4,"active":false},{"tag":"std","v":5,"active":true}]}', {hits: 0}],
  };
  const actionsOnlyPrepared = await prepareTinkerTask(t, {traceFormat: 'actions-only'});
  const compactPrepared = await prepareTinkerTask(t, {traceFormat: 'compact'});
  assert.deepEqual(compactPrepared.outcome, actionsOnlyPrepared.outcome);
  assert.deepEqual(compactPrepared.effects, actionsOnlyPrepared.effects);
  assert.equal(actionsOnlyPrepared.traceTurns, null);
  assert.equal(Array.isArray(compactPrepared.traceTurns), true);
  assert.equal(compactPrepared.traceTurns.length, 1);

  const exported = await exportTinkerExample(t, {traceFormat: 'compact'});
  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  assert.equal(exported.metadata.traceAudit.canonicalCausalNarration, true);
  assert.ok(exported.metadata.traceAudit.narrationLines > 5);
  const assistant = exported.messages.find(m => m.role === 'assistant');
  const thinking = assistantThinkingText(assistant);
  assert.match(thinking, /total = 0/);
  assert.match(thinking, /branch i < data\.items\.length => true \(then\)/);
  assert.match(thinking, /return \(scoreItem\) 16/);
  assert.match(thinking, /state\.hits = 2/);
  assert.match(thinking, /state\.total = 26/);
  assert.match(thinking, /data = \{"items": \[/);
  assert.match(thinking, /return \{"total": 26, "hits": 2\}/);
});

test('native V8 compact trace splits multi-turn effectful traces causally with zero future leakage and safe Proxy handling', async () => {
  const makeTask = (tsVal, rollVal) => ({
    id: 'native-multi-trace-' + tsVal,
    family: 'native-multi-trace',
    executionMode: 'native',
    randomMode: 'tool',
    source: `function run(raw) {
      let getterCalls = 0;
      const guarded = new Proxy({ok: 1}, {
        get(target, prop) { getterCalls++; return target[prop]; },
      });
      const parsed = JSON.parse(raw);
      const prefix = parsed.tag + ':';
      const ts = Date.now();
      const year = new Date(ts).getUTCFullYear();
      const roll = Math.random();
      const msg = prefix + year + ':' + roll;
      if (guarded) console.warn(msg);
      return {year, roll, getterCalls};
    }`,
    entry: 'run',
    args: ['{"tag":"ev"}'],
    fixture: {
      calls: [
        {operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: tsVal},
        {operation: 'platform.random', arguments: [], status: 'fulfilled', result: rollVal},
        {operation: 'platform.console.warn', arguments: ['ev:' + new Date(tsVal).getUTCFullYear() + ':' + rollVal], status: 'fulfilled', result: {$js: 'undefined'}},
      ],
    },
  });
  const left = await exportTinkerExample(makeTask(1700000100000, 0.425), {traceFormat: 'compact'});
  const right = await exportTinkerExample(makeTask(1800000100000, 0.875), {traceFormat: 'compact'});
  assert.equal(left.metadata.traceAudit.replayVerified, true);
  assert.equal(right.metadata.traceAudit.replayVerified, true);

  const leftAssistants = left.messages.filter(m => m.role === 'assistant');
  const rightAssistants = right.messages.filter(m => m.role === 'assistant');
  assert.equal(leftAssistants.length, 4); // 3 tool calls + 1 completion
  // Turn 0 (before Date.now): identical across counterfactuals and must not leak future timestamps/rolls.
  const turn0Left = assistantThinkingText(leftAssistants[0]);
  const turn0Right = assistantThinkingText(rightAssistants[0]);
  assert.equal(turn0Left, turn0Right);
  assert.match(turn0Left, /prefix = "ev:"/);
  assert.doesNotMatch(turn0Left, /1700000100000|2023|0\.425/);
  // Turn 1 (after Date.now, before Math.random): has ts and year, must not leak roll.
  const turn1Left = assistantThinkingText(leftAssistants[1]);
  assert.match(turn1Left, /ts = 1700000100000/);
  assert.match(turn1Left, /year = 2023/);
  assert.doesNotMatch(turn1Left, /0\.425/);
  // Turn 2 (after Math.random, before console.warn): has roll and Proxy branch without triggering Proxy getter.
  const turn2Left = assistantThinkingText(leftAssistants[2]);
  assert.match(turn2Left, /roll = 0\.425/);
  assert.match(turn2Left, /branch guarded \(then\)/);
  // Proxy trap was NEVER invoked by trace formatting!
  const finalAction = parseStudentAction(leftAssistants[3]);
  assert.equal(finalAction.value.getterCalls, 0);
});

test('native V8 compact trace bounds massive loops with head+tail compaction', async () => {
  const t = {
    id: 'native-loop-cap',
    family: 'native-loop-cap',
    executionMode: 'native',
    source: `function run(n) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        s += i;
      }
      return s;
    }`,
    entry: 'run',
    args: [1000],
  };
  const prepared = await prepareTinkerTask(t, {traceFormat: 'compact'});
  assert.equal(prepared.traceTurns.length, 1);
  assert.equal(prepared.traceTurns[0].length, 300);
  assert.ok(prepared.traceTurns[0].some(line => /^\.\.\. \(\d+ steps omitted\) \.\.\.$/.test(line)));
  assert.equal(prepared.traceTurns[0].at(-1), 'return 499500');
});

test('hard multi-turn native effectful suite defines 16x5 tier-5 tasks and exports verified compact traces', async () => {
  const templates = hardEffectfulTemplates();
  const tasks = hardEffectfulTasks();
  assert.equal(templates.length, 16);
  assert.equal(tasks.length, 80);
  assert.equal(new Set(tasks.map(t => t.id)).size, 80);
  assert.equal(new Set(tasks.map(t => t.family)).size, 16);
  for (const t of tasks) {
    assert.equal(t.executionMode, 'native');
    assert.equal(t.metadata.tier, 5);
    assert.ok(t.fixture.calls.length >= 3 && t.fixture.calls.length <= 18, `${t.id} calls=${t.fixture.calls.length}`);
  }
  // Verify representative sample spanning Date.now(), Math.random(), HTTP, FS, KV bindings, RegExp/URL, and aliasing.
  const sampleIds = [
    'hard-eff-deadline-bounded-diff-scan-1',
    'hard-eff-jittered-backoff-retry-client-1',
    'hard-eff-ttl-lru-cache-engine-0',
    'hard-eff-weighted-reservoir-sampler-0',
    'hard-eff-circuit-breaker-half-open-clock-0',
    'hard-eff-idempotency-key-router-0',
    'hard-eff-regex-log-redactor-pipeline-0',
    'hard-eff-canary-traffic-splitter-1',
  ];
  for (const id of sampleIds) {
    const task = tasks.find(t => t.id === id);
    assert.ok(task, 'missing sample task ' + id);
    const exported = await exportTinkerExample(task, {traceFormat: 'compact'});
    assert.equal(exported.metadata.traceAudit.replayVerified, true, id);
    assert.equal(exported.metadata.traceAudit.canonicalCausalNarration, true, id);
    assert.equal(exported.metadata.externalCalls, task.fixture.calls.length, id);
    assert.ok(exported.metadata.traceAudit.narrationLines > 0, id);
  }
});

test('native V8 trace safely previews plain arrays/objects while never invoking Proxy traps, getters, or coercions', async () => {
  // Direct unit checks of formatValue bounds, cycles, getters, Proxies, and non-plain objects.
  assert.equal(formatValue([1, 2, 3]), '[1, 2, 3]');
  assert.equal(formatValue({a: 1, b: 'x'}), '{"a": 1, "b": "x"}');
  assert.equal(formatValue({a: {b: {c: 1}}}), '{"a": {"b": {...}}}');
  assert.equal(formatValue([1, 2, 3, 4, 5, 6, 7, 8]), '[1, 2, 3, 4, 5, 6, ...]');
  const cyc = {k: 1};
  cyc.self = cyc;
  assert.equal(formatValue(cyc), '{"k": 1, "self": <cycle>}');
  const arrCyc = [];
  arrCyc.push(arrCyc);
  assert.equal(formatValue(arrCyc), '[<cycle>]');
  const longArr = Array.from({length: 6}, (_, i) => `item_${i}_${'x'.repeat(25)}`);
  const clipped = formatValue(longArr);
  assert.ok(clipped.length <= 120 && (clipped.endsWith('...]') || clipped.endsWith('...')));
  assert.equal(formatValue(new Map([['a', 1]])), null);

  let directTraps = 0;
  const throwingProxy = new Proxy({a: 1}, {
    get() { directTraps++; throw new Error('get trap fired'); },
    ownKeys() { directTraps++; throw new Error('ownKeys trap fired'); },
    getOwnPropertyDescriptor() { directTraps++; throw new Error('gopd trap fired'); },
    getPrototypeOf() { directTraps++; throw new Error('getPrototypeOf trap fired'); },
  });
  assert.equal(formatValue(throwingProxy), null);
  assert.equal(formatValue({nested: throwingProxy}), '{"nested": <proxy>}');
  const getterObj = Object.defineProperty({ok: 1}, 'boom', {
    enumerable: true,
    get() { directTraps++; throw new Error('getter fired'); },
  });
  assert.equal(formatValue(getterObj), '{"ok": 1, "boom": <getter>}');
  assert.equal(directTraps, 0);

  // Full native V8 execution trace test with throwing Proxy traps, throwing getter, class instance, and plain containers.
  const t = {
    id: 'native-rich-preview-proxy-safety',
    family: 'native-rich-preview-proxy-safety',
    executionMode: 'native',
    source: `class CustomBox {
      constructor(v) { this.v = v; }
      toString() { throw new Error('toString fired'); }
      valueOf() { throw new Error('valueOf fired'); }
      [Symbol.toPrimitive]() { throw new Error('toPrimitive fired'); }
    }
    function run() {
      let fires = 0;
      const proxy = new Proxy({ok: 1}, {
        get() { fires++; throw new Error('get trap fired'); },
        ownKeys() { fires++; throw new Error('ownKeys trap fired'); },
        getOwnPropertyDescriptor() { fires++; throw new Error('gopd trap fired'); },
        getPrototypeOf() { fires++; throw new Error('getPrototypeOf trap fired'); },
      });
      const withGetter = {a: 1, get bad() { fires++; throw new Error('getter fired'); }};
      const box = new CustomBox(7);
      const arr = [1, 2, 3];
      const obj = {a: 1, b: 'x'};
      const nested = {p: proxy, g: withGetter, c: box};
      if (proxy && withGetter && box && nested) {
        return {arr, obj, fires};
      }
      return {fires: -1};
    }`,
    entry: 'run',
    args: [],
  };
  const exported = await exportTinkerExample(t, {traceFormat: 'compact'});
  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  const thinking = assistantThinkingText(exported.messages.find(m => m.role === 'assistant'));
  assert.match(thinking, /proxy -> object/);
  assert.match(thinking, /withGetter = \{"a": 1, "bad": <getter>\}/);
  assert.match(thinking, /box -> object/);
  assert.match(thinking, /arr = \[1, 2, 3\]/);
  assert.match(thinking, /obj = \{"a": 1, "b": "x"\}/);
  assert.match(thinking, /nested = \{"p": <proxy>, "g": \{"a": 1, "bad": <getter>\}, "c": <object>\}/);
  assert.match(thinking, /return \{"arr": \[1, 2, 3\], "obj": \{"a": 1, "b": "x"\}, "fires": 0\}/);
  const finalAction = parseStudentAction(exported.messages.at(-1));
  assert.equal(finalAction.value.fires, 0);
});

test('native V8 fetch() intercepts into http.request with Response API, causal zero future leakage, and error rejection', async () => {
  const source = `async function run(baseUrl) {
    const tag = baseUrl.split('/').at(-1);
    const r1 = await fetch(baseUrl, {headers: {'Accept': 'application/json'}});
    const body1 = await r1.json();
    const r2 = await fetch(baseUrl + '/echo', {
      method: 'POST',
      headers: {'X-Tag': tag},
      body: JSON.stringify({count: body1.count}),
    });
    const text2 = await r2.text();
    const buf2 = await r2.arrayBuffer();
    let netErr = null;
    try {
      await fetch(baseUrl + '/down');
    } catch (err) {
      netErr = (err instanceof TypeError) + ':' + err.message;
    }
    return {
      ok1: r1.ok,
      status1: r1.status,
      statusText1: r1.statusText,
      url1: r1.url,
      ctype1: r1.headers.get('content-type'),
      count: body1.count,
      text2,
      bytes2: buf2.byteLength,
      netErr,
    };
  }`;

  const makeFetchTask = (id, count, secret) => ({
    id,
    family: 'native-fetch',
    executionMode: 'native',
    source,
    entry: 'run',
    args: ['https://api.test/v1'],
    fixture: {
      calls: [
        {
          operation: 'http.request',
          arguments: ['https://api.test/v1', 'GET', {accept: 'application/json'}, null],
          status: 'fulfilled',
          result: {
            status: 200,
            statusText: 'OK',
            url: 'https://api.test/v1',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({count, secret}),
          },
        },
        {
          operation: 'http.request',
          arguments: ['https://api.test/v1/echo', 'POST', {'x-tag': 'v1'}, JSON.stringify({count})],
          status: 'fulfilled',
          result: {
            status: 201,
            statusText: 'Created',
            url: 'https://api.test/v1/echo',
            headers: {'content-type': 'text/plain'},
            body: 'ok:' + count,
          },
        },
        {
          operation: 'http.request',
          arguments: ['https://api.test/v1/down', 'GET', {}, null],
          status: 'rejected',
          result: {name: 'TypeError', message: 'fetch failed'},
        },
      ],
    },
  });

  const left = await exportTinkerExample(makeFetchTask('fetch-left', 7, 'SECRET_LEFT_99'), {traceFormat: 'compact'});
  const right = await exportTinkerExample(makeFetchTask('fetch-right', 19, 'SECRET_RIGHT_88'), {traceFormat: 'compact'});
  assert.equal(left.metadata.traceAudit.replayVerified, true);
  assert.equal(right.metadata.traceAudit.replayVerified, true);

  const declared = JSON.parse(left.messages.find(m => m.role === 'tool_declare').content).map(t => t.function.name);
  assert.deepEqual(declared, ['http.request']);

  const audit = auditCausalPrefixPair(left, right, {divergenceObservation: 0});
  assert.equal(audit.passed, true);
  assert.equal(audit.testedDivergence, true);
  assert.doesNotMatch(JSON.stringify(left.messages.slice(0, audit.identicalPrefixMessages)), /SECRET_LEFT_99|ok:7/);

  const comp = parseStudentAction(left.messages.at(-1));
  assert.equal(comp.kind, 'return');
  assert.deepEqual(comp.value, {
    ok1: true,
    status1: 200,
    statusText1: 'OK',
    url1: 'https://api.test/v1',
    ctype1: 'application/json',
    count: 7,
    text2: 'ok:7',
    bytes2: 4,
    netErr: 'true:fetch failed',
  });

  const session = createTinkerSession(await prepareTinkerTask(left.task, {traceFormat: 'compact'}));
  for (const msg of left.messages.filter(m => m.role === 'assistant')) {
    await session.step(msg, 50);
  }
  assert.equal(session.grade(50).success, true);

  // Member method .fetch() must NOT falsely declare http.request
  const memberOnly = await exportTinkerExample(task('function run(svc){return svc && typeof svc === "object" ? 1 : 0;}'));
  assert.equal(memberOnly.messages.some(m => m.role === 'tool_declare'), false);
  const memberCall = await exportTinkerExample(task('function run(svc){return svc.fetch("x");}', {
    args: [{x: 1}],
    executionMode: 'native',
    source: 'function run(){const svc={fetch:x=>x+1};return svc.fetch(2);}',
  }));
  assert.equal(memberCall.messages.some(m => m.role === 'tool_declare'), false);
});
