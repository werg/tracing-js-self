import test from 'node:test';
import assert from 'node:assert/strict';
import { runReferenceScript } from '../src/reference-engine.js';
import { createRuntime } from '../src/runtime.js';

const shared = [
  ['number precedence', 'let result = 2 + 3 * 4; result;'],
  ['string concatenation', 'let result = "a" + "b"; result;'],
  ['BigInt arithmetic', 'let result = 123n + 456n; result;'],
  ['signed zero', 'let result = -0; result;'],
  ['lexical closure', 'let x = 7; function f(y) { return x + y; } let result = f(4); result;'],
  ['while loop', 'let result = 0; let i = 0; while (i < 4) { result += i; i += 1; } result;'],
  ['dense array', 'let values = [8, 5]; let result = values[1]; result;'],
  ['object identity', 'let object = {a: 2}; let alias = object; alias.b = 7; let result = object.a + object.b; result;'],
  ['short-circuit', 'let result = 0 || 27; result;'],
  ['nullish', 'let result = null ?? 13; result;'],
];

function resultBinding(runtime) {
  for (const env of Object.values(runtime.state.envs)) {
    if (Object.hasOwn(env.bindings, 'result')) return env.bindings.result.token?.value;
  }
  throw new Error('Missing result binding');
}

for (const [label, source] of shared) {
  test(`owned VM scalar result agrees with engine262: ${label}`, () => {
    const expected = runReferenceScript(source, { specifier: `differential/${label}.js` });
    assert.equal(expected.phase, 'normal', JSON.stringify(expected));
    assert('value' in expected, 'fixture must have a primitive completion');
    const runtime = createRuntime().start(source);
    assert.equal(runtime.drive().kind, 'terminated');
    assert.deepEqual(resultBinding(runtime), expected.value);
  });
}

test('engine262 separates reference parse failures from runtime failures', () => {
  assert.deepEqual(runReferenceScript('const x = ;'), {phase:'parse',errorName:'SyntaxError'});
  assert.deepEqual(runReferenceScript('let x = x + 1;'), {phase:'runtime',errorName:'ReferenceError'});
});

test('spec oracle accepts syntax the owned traced VM explicitly refuses', () => {
  const source = 'let f = (x) => x + 1; f(3);';
  assert.deepEqual(runReferenceScript(source), {phase:'normal',value:['num',4]});
  assert.throws(() => createRuntime().start(source), SyntaxError);
});
