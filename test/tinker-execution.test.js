import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {encodeReadable, decodeReadable, prepareTinkerTask, exportTinkerExample,
  createTinkerSession, parseStudentAction, normalizedSourceHash,
  assistantVisibleText, assistantThinkingText} from '../src/training/tinker-execution.js';

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

test('readable exporter uses Inkling thinking blocks by default and masks real observations by role', async () => {
  const input = task('function run(x){const y=host.readNumber("x")+x;host.store("y",y);return y;}', {
    args: [1], fixture: {calls: [{operation: 'demo.readNumber', arguments: ['x'], result: 4},
      {operation: 'demo.store', arguments: ['y', 5], result: {$js: 'undefined'}}]}});
  const exported = await exportTinkerExample(input);
  assert.deepEqual(exported.messages.map(message => message.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(exported.metadata.reasoningChannel, 'thinking');
  assert.match(assistantThinkingText(exported.messages[4]), /host\.readNumber\("x"\)\+x => 5/);
  assert.match(assistantVisibleText(exported.messages[4]), /```json\n\{"type":"call"/);
  assert.equal(exported.metadata.externalObservationsTrainable, false);
  assert.equal(exported.metadata.sourceVerified, true);
  const generated = exported.messages.filter(message => message.role === 'assistant')
    .map(message => assistantThinkingText(message) + '\n' + assistantVisibleText(message)).join('\n');
  assert.doesNotMatch(generated, /invocationId|effectId|sourceAdmission|prefixDigest|a0:e/);
  const session = createTinkerSession(await prepareTinkerTask(exported.task));
  for (const message of exported.messages.filter(message => message.role === 'assistant')) await session.step(assistantVisibleText(message), 100);
  assert.equal(session.grade(100).success, true);
});

test('counterfactual private observations cannot alter the initial prompt or request prefix', async () => {
  const make = value => task('function run(){const n=host.readNumber("secret");return n+1;}', {
    fixture: {calls: [{operation: 'demo.readNumber', arguments: ['secret'], result: value}]}});
  const left = await exportTinkerExample(make(7123)), right = await exportTinkerExample(make(9234));
  assert.deepEqual(left.messages.slice(0, 3), right.messages.slice(0, 3));
  assert.doesNotMatch(JSON.stringify(left.messages.slice(0, 3)), /7123|9234/);
  assert.notDeepEqual(left.messages[3], right.messages[3]);
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
});

test('fresh randomness is privately materialized once and preserved for reproducible start/export', async () => {
  const exported = await exportTinkerExample(task('function run(){return freshRandom();}', {freshRandomCalls: 1}));
  assert.equal(exported.task.freshRandomCalls, 0);
  const draw = exported.task.fixture.calls[0].result;
  assert(draw >= 0 && draw < 1);
  assert.doesNotMatch(JSON.stringify(exported.messages.slice(0, 3)), new RegExp(String(draw).replace('.', '\\.')));
  const session = createTinkerSession(await prepareTinkerTask(exported.task));
  const observed = await session.step(call('freshRandom', []), 10);
  assert.match(observed.messages[0].content, /freshRandom/);
  assert.equal((await session.step(complete(draw), 20)).grade.success, true);
});

test('an existing strict directive is preserved when hoisted native wrappers are added', async () => {
  const exported = await exportTinkerExample(task('"use strict";function run(){return lookup("key");}', {
    nativeBindings: [{name: 'lookup', kind: 'synchronous'}], fixture: {calls: [
      {operation: 'natlang.callSync', arguments: ['lookup', {$js: 'undefined'}, ['key']], result: 9}]}}));
  const generated = exported.messages.filter(message => message.role === 'assistant');
  assert.doesNotMatch(generated.map(message => assistantThinkingText(message) + '\n' + assistantVisibleText(message)).join('\n'), /natlangCallSync/);
  const session = createTinkerSession(await prepareTinkerTask(exported.task));
  for (const message of generated) await session.step(assistantVisibleText(message), 50);
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
  } finally { child.stdin.end(); await new Promise(resolve => child.on('close', resolve)); lines.close(); }
  assert.equal(stderr, '');
});
