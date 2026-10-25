import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Runtime, createRuntime, encode, decode, validateBundle, reconstruct,
  replayExact, causalPrefix, TraceValidationError, TraceReplayError
} from 'tracing-js-self';

import {verifyTrainingCase,SemanticController,evaluateSelectedTrajectory} from 'tracing-js-self/training/diagnostic';
import {verifyEffectfulTrainingCase,SelectedExecutionHarness,HARNESS_PROFILE} from 'tracing-js-self/training';

const archive = runtime => JSON.parse(JSON.stringify(runtime.exportRun()));
const binding = (state, name) => Object.values(state.envs)
  .find(environment => Object.hasOwn(environment.bindings, name))?.bindings[name]?.token?.value;

function verifyArchive(bundle) {
  assert.equal(validateBundle(bundle).valid, true);
  assert.deepEqual(reconstruct(bundle), bundle.finalState);
  const replay = replayExact(bundle);
  assert.equal(replay.valid, true);
  assert.equal(replay.externalAdapterCalls, 0);
}

test('package entry embeds a scalar program with source identity and replayable state', () => {
  const runtime = createRuntime();
  assert(runtime instanceof Runtime);
  const source = runtime.registerSource({
    text: 'let answer = 2 + 3 * 4;', url: 'memory:embedded-scalar.js'
  });
  assert.equal(runtime.start(source), runtime);
  assert.equal(runtime.drive().kind, 'terminated');
  assert.equal(decode(binding(runtime.inspectState(), 'answer')), 14);
  const bundle = archive(runtime);
  assert.equal(bundle.sources[0].url, 'memory:embedded-scalar.js');
  verifyArchive(bundle);
});

test('public scalar codec preserves special numbers, BigInt and UTF-16 strings', () => {
  for (const value of [undefined, null, false, true, -0, NaN, Infinity, -Infinity,
    42, 9007199254740993n, '\ud800', 'embedded\u0000text']) {
    const wireValue = JSON.parse(JSON.stringify(encode(value)));
    assert(Object.is(decode(wireValue), value));
  }
  assert.throws(() => encode({ answer: 42 }), TypeError);
  assert.throws(() => decode(['ref', 'guest-object']), TypeError);
});

test('embedded synchronous host calls wait for delivery even when their result is unused', () => {
  const runtime = new Runtime().start('host.readNumber("input"); let after = 1;');
  const progress = runtime.drive();
  assert.equal(progress.kind, 'waiting');
  assert.equal(binding(runtime.inspectState(), 'after'), undefined);
  const effect = Object.values(runtime.inspectState().effects)
    .find(item => item.operation === 'demo.readNumber');
  assert(effect);
  const arrival = runtime.recordInputArrival({
    effectId: effect.id, kind: 'immediate', value: 17, inputId: 'sync-input'
  });
  assert.equal(binding(runtime.inspectState(), 'after'), undefined);
  runtime.deliverInput(arrival.inputId);
  assert.equal(runtime.drive().kind, 'terminated');
  assert.equal(decode(binding(runtime.inspectState(), 'after')), 1);
  verifyArchive(archive(runtime));
});

test('embedded async delivery stays private until supplied and replay never repeats a host write', () => {
  const writes = [];
  const runtime = createRuntime({ adapters: {
    'demo.store': ({ args }) => {
      writes.push(args);
      return { kind: 'normal', value: undefined };
    }
  }}).start(`async function work() {
    const value = await host.readAsync("input");
    host.store("answer", value + 1);
  } work();`);
  assert.equal(runtime.drive().kind, 'waiting');
  const effect = Object.values(runtime.inspectState().effects)
    .find(item => item.operation === 'demo.readAsync');
  assert(effect);
  const arrival = runtime.recordInputArrival({
    effectId: effect.id, kind: 'completion', value: 987654, inputId: 'async-input'
  });
  const beforeDelivery = runtime.events.at(-1).eventId;
  assert.deepEqual(writes, []);
  runtime.deliverInput(arrival.inputId);
  assert.equal(runtime.drive().kind, 'terminated');
  assert.deepEqual(writes, [['answer', 987655]]);
  const bundle = archive(runtime);
  const prefix = causalPrefix(bundle, { throughEventId: beforeDelivery });
  assert.equal(prefix.events.some(event => event.op === 'external.input.arrive'), false);
  assert.equal(JSON.stringify(prefix).includes('987654'), false);
  const supplied = causalPrefix(bundle).events.find(event => event.supplied);
  assert.equal(decode(supplied.supplied.value), 987654);
  verifyArchive(bundle);
  assert.deepEqual(writes, [['answer', 987655]], 'replay cannot dispatch a second host write');
});

test('package exports the validation and replay error constructors thrown by its APIs', () => {
  const runtime = createRuntime().start('let answer = 42;');
  assert.equal(runtime.drive().kind, 'terminated');
  const invalidStructure = archive(runtime);
  invalidStructure.events[0].catalogRef = 'unknown.operation/1';
  assert.throws(() => validateBundle(invalidStructure), TraceValidationError);
  const invalidSource = archive(runtime);
  invalidSource.sources[0].text = 'let answer = 43;';
  assert.throws(() => replayExact(invalidSource), TraceReplayError);
});

test('offline diagnostic subpath retains independent bounded-pure corpus checks',()=>{
  const checked=verifyTrainingCase({
    source:'"use strict";function f(x){return x+1;}',entry:'f',args:[4]
  });
  assert.equal(checked.status,'locally_verified');
  assert.equal(typeof SemanticController,'function');
  const report=evaluateSelectedTrajectory({
    groups:checked.exported.public.groups,
    referenceOutcome:checked.exported.sidecar.reference
  });
  assert.equal(report.valid,true);
  assert.equal(report.correctness,'correct');
});

test('production training subpath emits explicit harness invocations and exact source evidence',async()=>{
  assert.equal(HARNESS_PROFILE,'selected-harness/2');
  const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(x){return x+1;}',
    entry:'run',args:[4],fixture:{calls:[]},family:'package-api'});
  assert.equal(result.status,'locally_verified',result.reason);
  assert.equal(result.exported.public.profile,HARNESS_PROFILE);
  assert.equal(result.exported.public.groups,undefined);
  assert.equal(SelectedExecutionHarness.replay(result.exported).invocations.get('invocation1').controller.completion.value[1],5);
});
