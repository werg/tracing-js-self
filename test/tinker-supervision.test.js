import test from 'node:test';
import assert from 'node:assert/strict';
import {TINKER_TRACE_FORMATS, encodeReadable, prepareTinkerTask, exportTinkerExample,
  readableMessagesFromJournal, auditTeacherConversation, createTinkerSession,
  parseStudentAction, assistantVisibleText, assistantThinkingText} from '../src/training/tinker-execution.js';
import {auditCausalPrefixPair, auditTinkerSupervision} from '../src/training/tinker-supervision.js';

const task = (source, options = {}) => ({id: 'case', family: 'family', source, args: [], ...options});
const call = (operation, args) => JSON.stringify({type: 'call', operation, arguments: encodeReadable(args)});
const complete = (value, args = [], kind = 'return') => {
  const encoded = encodeReadable({arguments: args, value});
  return JSON.stringify({type: 'complete', kind, arguments: encoded.arguments, value: encoded.value});
};
const actions = messages => messages.filter(message => message.role === 'assistant').map(message => parseStudentAction(message));
const observations = messages => messages.filter((message, index) => index > 1 && message.role === 'user');
const allText = message => [assistantThinkingText(message), assistantVisibleText(message)].filter(Boolean).join('\n');

test('all three teacher formats replay, deduplicate writes, and compact removes intermediate steps', async () => {
  const input = task('function run(box){const alias=box;const step=box.count+2;alias.count=step;if(box.count>2){box.marker=host.readNumber("marker");}return alias;}', {
    args: [{count: 1}], fixture: {calls: [{operation: 'demo.readNumber', arguments: ['marker'], result: 991}]},
    metadata: {features: ['mutation', 'alias', 'branch', 'external'], tier: 3}});
  const exported = await Promise.all(TINKER_TRACE_FORMATS.map(traceFormat => exportTinkerExample(input, {traceFormat})));
  const [full, compact, bare] = exported;
  for (const row of exported) {
    assert.equal(row.metadata.traceAudit.replayVerified, true);
    assert.equal(row.metadata.traceAudit.observationsMatched, true);
    assert.deepEqual(row.metadata.features, input.metadata.features);
    assert.equal(row.metadata.tier, 3);
    assert.deepEqual(actions(row.messages), actions(full.messages));
    assert.deepEqual(observations(row.messages), observations(full.messages));
  }
  assert(full.metadata.traceAudit.narrationLines > compact.metadata.traceAudit.narrationLines);
  assert(compact.metadata.traceAudit.narrationLines > 0);
  assert.equal(bare.metadata.traceAudit.narrationLines, 0);
  assert.match(full.messages.map(allText).join('\n'), /box\.count\+2 => 3/);
  assert.doesNotMatch(compact.messages.filter(m => m.role === 'assistant').map(allText).join('\n'), /box\.count\+2 => 3/);
  for (const message of bare.messages.filter(m => m.role === 'assistant')) {
    assert.equal(typeof message.content, 'string');
    assert(message.content.startsWith('```json\n'));
  }
  assert(bare.metadata.traceAudit.assistantBytes < compact.metadata.traceAudit.assistantBytes);
  await assert.rejects(exportTinkerExample(input, {traceFormat: 'not-a-format'}), /traceFormat/);
  // Verify compound assignment loop has no duplicate consecutive lines.
  const loop = await exportTinkerExample(task('function run(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}', {args: [[2, 3]]}), {traceFormat: 'full'});
  const lines = assistantThinkingText(loop.messages.at(-1)).split('\n');
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1], 'Duplicate consecutive trace line: ' + lines[i]);
});

test('branch narration reports the JavaScript test rather than its inverse VM jump decision', async () => {
  for (const traceFormat of ['full', 'compact']) for (const [value, expected, path] of [[2, 'true', 'then'], [-2, 'false', 'else']]) {
    const exported = await exportTinkerExample(task('function run(x){if(x>0){return 1;}else{return 2;}}', {args: [value]}), {traceFormat});
    const text = allText(exported.messages.at(-1));
    assert.match(text, new RegExp('branch x>0 => ' + expected + ' \\(' + path + '\\)'));
    assert.doesNotMatch(text, new RegExp('branch x>0 => ' + (expected === 'true' ? 'false' : 'true')));
  }
  const loop = await exportTinkerExample(task('function run(){let i=0;while(i<2){i++;}return i;}'), {traceFormat: 'compact'});
  assert.match(allText(loop.messages.at(-1)), /branch i<2 => true \(then\)/);
  assert.match(allText(loop.messages.at(-1)), /branch i<2 => false \(else\)/);
});

test('mutation and alias narration comes from the current event, never the future heap', async () => {
  const input = task('function run(box){const alias=box;alias.count=2;const future=host.readNumber("future");box.count=future;return alias;}', {
    args: [{count: 1}], fixture: {calls: [{operation: 'demo.readNumber', arguments: ['future'], result: 773991}]},
    metadata: {privateSentinel: 'PRIVATE_TEACHER_METADATA'}});
  for (const traceFormat of ['full', 'compact']) {
    const exported = await exportTinkerExample(input, {traceFormat});
    const before = allText(exported.messages[2]), after = allText(exported.messages.at(-1));
    assert.match(before, /alias -> box/);
    assert.match(before, /alias\.count = 2/);
    assert.doesNotMatch(before, /773991|PRIVATE_TEACHER_METADATA|"ref","o[0-9]+"|a0:e[0-9]+/);
    assert.match(after, /box\.count = 773991/);
    assert.match(after, /return -> alias/);
    assert.doesNotMatch(JSON.stringify(exported.messages), /PRIVATE_TEACHER_METADATA/);
  }
});

test('second-observation branch counterfactual preserves every earlier conversation message', async () => {
  const make = value => task('async function run(){const a=await host.readAsync("first");const b=await host.readAsync(a>0?"second":"other");if(b>10){host.store("side",b);return b+a;}return b-a;}', {
    fixture: {calls: [{operation: 'demo.readAsync', arguments: ['first'], result: 2},
      {operation: 'demo.readAsync', arguments: ['second'], result: value},
      ...(value > 10 ? [{operation: 'demo.store', arguments: ['side', value]}] : [])]}});
  for (const traceFormat of TINKER_TRACE_FORMATS) {
    const left = await exportTinkerExample(make(23817), {traceFormat}), right = await exportTinkerExample(make(5), {traceFormat});
    const audit = auditCausalPrefixPair(left, right, {divergenceObservation: 1});
    assert.equal(audit.passed, true);
    assert.equal(audit.testedDivergence, true);
    assert.equal(audit.divergenceObservation, 1);
    assert.doesNotMatch(JSON.stringify(left.messages.slice(0, audit.identicalPrefixMessages)), /23817/);
    const leaked = structuredClone(left);
    leaked.messages[2] = {role: 'assistant', content: 'Future private observation: 23817.\n' + assistantVisibleText(leaked.messages[2])};
    assert.throws(() => auditCausalPrefixPair(leaked, right, {divergenceObservation: 1}), /earlier model-visible prefix/);
  }
});

test('rejected native observations remain private until the corresponding call', async () => {
  const make = secret => task('async function run(){const a=await lookup("a");try{return (await lookup("b"))+a;}catch(e){return e+":"+a;}}', {
    nativeBindings: [{name: 'lookup', kind: 'promise'}], fixture: {calls: [
      {operation: 'natlang.call', arguments: ['lookup', {$js: 'undefined'}, ['a']], result: 4},
      {operation: 'natlang.call', arguments: ['lookup', {$js: 'undefined'}, ['b']], status: 'rejected', result: secret}]}});
  for (const traceFormat of TINKER_TRACE_FORMATS) {
    const left = await exportTinkerExample(make('PRIVATE_LEFT_REJECTION'), {traceFormat});
    const right = await exportTinkerExample(make('PRIVATE_RIGHT_REJECTION'), {traceFormat});
    const audit = auditCausalPrefixPair(left, right, {divergenceObservation: 1});
    assert.doesNotMatch(JSON.stringify(left.messages.slice(0, audit.identicalPrefixMessages)), /PRIVATE_LEFT_REJECTION|PRIVATE_RIGHT_REJECTION|natlangCall/);
    assert.match(left.messages[audit.identicalPrefixMessages].content, /rejected.*PRIVATE_LEFT_REJECTION/);
  }
});

test('supplied random draws are observations and later draws cannot change earlier trace prefixes', async () => {
  const make = second => task('function run(){const a=freshRandom();const b=freshRandom();return a<b;}', {
    nativeBindings: [{name: 'freshRandom', kind: 'synchronous'}], fixture: {calls: [
      {operation: 'natlang.callSync', arguments: ['freshRandom', {$js: 'undefined'}, []], result: 0.4},
      {operation: 'natlang.callSync', arguments: ['freshRandom', {$js: 'undefined'}, []], result: second}]}});
  const left = await exportTinkerExample(make(0.812345)), right = await exportTinkerExample(make(0.212345));
  const audit = auditCausalPrefixPair(left, right);
  assert.equal(audit.divergenceObservation, 1);
  assert.doesNotMatch(JSON.stringify(left.messages.slice(0, audit.identicalPrefixMessages)), /0\.812345|0\.212345/);
});

test('student mistakes receive only arrived observations and a wrong call terminates without correction', async () => {
  const prepared = await prepareTinkerTask(task('function run(){const a=host.readNumber("one");const b=host.readNumber("two");return a+b;}', {
    fixture: {calls: [{operation: 'demo.readNumber', arguments: ['one'], result: 3},
      {operation: 'demo.readNumber', arguments: ['two'], result: 771234}]}}));
  const session = createTinkerSession(prepared);
  const student = 'I believe the result is 999999, and retain this mistaken computation.\n```json\n' + call('demo.readNumber', ['one']) + '\n```';
  const first = await session.step(student, 20);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].role, 'user');
  assert.doesNotMatch(JSON.stringify(first), /771234|771237|999999|expected|teacher|corrected/);
  const history = [...session.messages, {role: 'assistant', content: student}, ...first.messages];
  assert.equal(history[2].content, student);
  const invalid = await session.step(call('demo.readNumber', ['incorrect']), 35);
  assert.deepEqual(invalid.messages, []);
  assert.equal(invalid.done, true);
  assert.equal(invalid.grade.failureCategory, 'incorrect-external-request');
  assert.doesNotMatch(JSON.stringify(invalid), /771234|771237|"two"|expected|corrected/);
  const stopped = await session.step(call('demo.readNumber', ['two']), 45);
  assert.equal(stopped.done, true);
  assert.deepEqual(stopped.messages, []);
});

test('teacher audit rejects altered observations, injected prose, and absent completion', async () => {
  const prepared = await prepareTinkerTask(task('function run(){return host.readNumber("x")+1;}', {
    fixture: {calls: [{operation: 'demo.readNumber', arguments: ['x'], result: 9}]}}));
  const messages = readableMessagesFromJournal(prepared.bundle, prepared);
  assert.equal((await auditTeacherConversation(prepared, messages)).replayVerified, true);
  const observation = structuredClone(messages); observation[3].content += ' forged';
  await assert.rejects(auditTeacherConversation(prepared, observation), /causal source events/);
  const prose = structuredClone(messages);
  prose[2] = {role: 'assistant', content: 'Future result 10.\n' + assistantVisibleText(prose[2])};
  await assert.rejects(auditTeacherConversation(prepared, prose), /causal source events/);
  await assert.rejects(auditTeacherConversation(prepared, messages.slice(0, -1)), /causal source events/);
});

test('stratified audit is reproducible, covers features and retains reviewable conversations', async () => {
  const inputs = [
    task('function run(x){return x+1;}', {id: 'scalar', family: 'scalar', args: [2], metadata: {features: ['scalar'], tier: 0}}),
    task('function run(box){box.x++;return box;}', {id: 'mutation', family: 'mutation', args: [{x: 1}], metadata: {features: ['mutation', 'alias'], tier: 1}}),
    ...[17, 23].map(value => task('function run(){return host.readNumber("x")+1;}', {id: 'observation-' + value, family: 'observations',
      metadata: {features: ['external'], tier: 2}, fixture: {calls: [{operation: 'demo.readNumber', arguments: ['x'], result: value}]}}))];
  const left = await auditTinkerSupervision(inputs, {samplePerFeature: 2, seed: 23, includeMessages: true});
  const right = await auditTinkerSupervision([...inputs].reverse(), {samplePerFeature: 2, seed: 23, includeMessages: true});
  assert.deepEqual(left.rows, right.rows);
  assert.deepEqual(left.featureCoverage, right.featureCoverage);
  assert.equal(left.modelPerformanceEvidence, false);
  assert.equal(left.allReplayed, true);
  assert.equal(left.rows.length, inputs.length * 3);
  assert.equal(left.causalDivergencesChecked, 3);
  assert.equal(left.formatTotals['actions-only'].narrationLines, 0);
  assert(left.rows.every(row => Array.isArray(row.messages)));
  for (const feature of ['scalar', 'mutation', 'alias', 'external']) assert(left.featureCoverage[feature].selected > 0);
});

test('private failure categories distinguish wrong values, mutations, aliases, exceptions and missing effects', async () => {
  const prepared = await prepareTinkerTask(task('function run(box){box.x++;return box;}', {args: [{x: 1}]}));
  const mutate = await createTinkerSession(prepared).step(complete({x: 2}, [{x: 1}]), 10);
  assert.equal(mutate.grade.failureCategory, 'mutation-mismatch');
  const alias = await createTinkerSession(prepared).step(complete({x: 2}, [{x: 2}]), 10);
  assert.equal(alias.grade.failureCategory, 'alias-mismatch');
  const value = await createTinkerSession(prepared).step(complete(4, [{x: 2}]), 10);
  assert.equal(value.grade.failureCategory, 'wrong-return');
  const scalar = await prepareTinkerTask(task('function run(){throw "bad";}'));
  assert.equal((await createTinkerSession(scalar).step(complete('worse', [], 'throw'), 10)).grade.failureCategory, 'wrong-exception');
  assert.equal((await createTinkerSession(scalar).step(complete('bad'), 10)).grade.failureCategory, 'wrong-completion-kind');
  const effect = await prepareTinkerTask(task('function run(){host.store("x",2);return 2;}', {fixture: {calls: [{operation: 'demo.store', arguments: ['x', 2]}]}}));
  assert.equal((await createTinkerSession(effect).step(complete(2), 10)).grade.failureCategory, 'missing-external-effects');
});

test('runtime-looking user data remains valid data rather than being censored by audit heuristics', async () => {
  const exported = await exportTinkerExample(task('function run(){return "a0:e2";}'));
  assert.equal(exported.metadata.traceAudit.replayVerified, true);
  assert.match(allText(exported.messages.at(-1)), /a0:e2/);
});

test('compact trace distinguishes callback returns and pending returns before finally', async () => {
  const cleanup = await exportTinkerExample(task('function run(box){try{return box.count;}finally{box.count++;}}', {args: [{count: 2}]}), {traceFormat: 'compact'});
  const text = allText(cleanup.messages.at(-1));
  assert.match(text, /return 2/);
  assert.match(text, /box\.count = 3/);
  assert(text.indexOf('return 2') < text.indexOf('box.count = 3'));
  const callbacks = await exportTinkerExample(task('function run(xs){return xs.map(x=>x+1);}', {args: [[2, 3]]}), {traceFormat: 'compact'});
  assert.match(allText(callbacks.messages.at(-1)), /return \(callback\) 3/);
  assert.match(allText(callbacks.messages.at(-1)), /return -> object/);
  const literal = await exportTinkerExample(task('function run(){console.log(["value",3]);return 4;}', {
    fixture: {calls: [{operation: 'platform.console.log', arguments: [['value', 3]]}]}}), {traceFormat: 'compact'});
  assert.doesNotMatch(allText(literal.messages[2]), /in \[/);
});

test('aggregate audit checks supplied frozen training conversations instead of silently replacing them', async () => {
  const exported = await exportTinkerExample(task('function run(x){return x+1;}', {args: [2]}), {traceFormat: 'compact'});
  const audited = await auditTinkerSupervision([exported]);
  assert.equal(audited.suppliedConversationAudits.length, 1);
  assert.equal(audited.suppliedConversationAudits[0].traceFormat, 'compact');
  const injected = structuredClone(exported);
  injected.messages[injected.messages.length - 1] = {role: 'assistant', content: 'Extra private teacher guidance.\n' + assistantVisibleText(injected.messages.at(-1))};
  await assert.rejects(auditTinkerSupervision([injected]), /causal source events/);
});
