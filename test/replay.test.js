import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';
import { replayExact, TraceReplayError } from '../src/replay.js';
import { validateBundle } from '../src/validation.js';

const archive = bundle => JSON.parse(JSON.stringify(bundle));

function asyncRun() {
  let externalWrites = 0;
  const source = `async function task() {
    const a = host.readAsync("A"); const b = host.readAsync("B");
    const bias = await Promise.resolve(5);
    const av = await a; const bv = await b;
    host.store("answer", av + bv + bias);
  } task();`;
  const runtime = createRuntime({ adapters: {
    'demo.store': () => { externalWrites++; return { kind: 'normal', value: undefined }; }
  }}).start(source);
  assert.equal(runtime.drive().kind, 'waiting');
  const [a,b] = Object.values(runtime.state.effects);
  const arrivedB = runtime.recordInputArrival({ effectId:b.id, kind:'completion', value:20 });
  runtime.deliverInput(arrivedB.inputId);
  assert.equal(runtime.drive().kind, 'waiting');
  const arrivedA = runtime.recordInputArrival({ effectId:a.id, kind:'completion', value:10 });
  runtime.deliverInput(arrivedA.inputId);
  assert.equal(runtime.drive().kind, 'terminated');
  assert.equal(externalWrites, 1);
  return { bundle: archive(runtime.exportRun()), writes: () => externalWrites };
}

test('dry replay reproduces all events, chunks, checkpoints and inputs without external writes', () => {
  const { bundle, writes } = asyncRun();
  assert.equal(validateBundle(bundle).valid, true);
  const summary = replayExact(bundle);
  assert.equal(summary.valid, true);
  assert.equal(summary.eventCount, bundle.events.length);
  assert.equal(summary.chunkCount, 3);
  assert.equal(summary.externalAdapterCalls, 0);
  assert.equal(writes(), 1, 'replay must not invoke original native adapter');
  assert(bundle.events.some(e => e.operation === 'job.enter'));
  assert(bundle.events.some(e => e.operation === 'external.input.arrive'));
  assert(bundle.events.some(e => e.operation === 'external.input.deliver'));
});

test('replay preserves transport-supplied IDs and runs with multiple registered sources', () => {
  const runtime = createRuntime();
  runtime.registerSource({text:'let unused = 4;',url:'unused.js'});
  const source = runtime.registerSource({text:'let result = host.readNumber("key");',url:'entry.js'});
  runtime.start(source);
  assert.equal(runtime.drive().kind, 'waiting');
  const effectId = Object.values(runtime.state.effects)[0].id;
  runtime.recordInputArrival({effectId,kind:'immediate',value:17,inputId:'transport-17'});
  runtime.deliverInput('transport-17');
  assert.equal(runtime.drive().kind, 'terminated');
  const bundle = archive(runtime.exportRun());
  assert.equal(bundle.initialState.counters.ids.input, 0);
  assert.equal(bundle.finalState.counters.ids.input, 0);
  assert.equal(replayExact(bundle).valid, true);
});

test('structurally valid corruption of a semantic result is rejected by execution replay', () => {
  const {bundle} = asyncRun();
  const event = bundle.events.find(e => e.operation === 'primitive.binary');
  assert(event);
  event.result = ['num', 9999];
  assert.equal(validateBundle(bundle).valid, true, 'state-only validation cannot prove results');
  assert.throws(() => replayExact(bundle), error =>
    error instanceof TraceReplayError && error.eventId === event.eventId &&
    /semantic event/.test(error.message));
});

test('replay detects forged read observations and producer links', () => {
  const original = asyncRun().bundle;
  const observation = archive(original);
  const read = observation.events.find(e => e.readObservations?.length);
  assert(read);
  read.readObservations[0].version = 1234567;
  assert.equal(validateBundle(observation).valid, true);
  assert.throws(() => replayExact(observation), TraceReplayError);

  const link = archive(original);
  const referenced = link.events.find(e => e.operandOrigins.some(origin => origin !== null));
  assert(referenced);
  referenced.operandOrigins = referenced.operandOrigins.map(origin => origin ? 'a0:e1' : null);
  assert.equal(validateBundle(link).valid, true);
  assert.throws(() => replayExact(link), TraceReplayError);
});

test('replay compiles source afresh rather than executing archived bytecode', () => {
  const original = asyncRun().bundle;
  const changedSource = archive(original);
  changedSource.sources[0].text += '\nlet detached = 100;';
  assert.equal(validateBundle(changedSource).valid, true);
  assert.throws(() => replayExact(changedSource), /compiled/);

  const forgedBytecode = archive(original);
  const code = Object.values(forgedBytecode.programs)[0];
  code.instructions[0].op = 'UNKNOWN';
  assert.equal(validateBundle(forgedBytecode).valid, true);
  assert.throws(() => replayExact(forgedBytecode), /compiled bytecode/);
});

test('replay rejects fabricated chunk exits even when state patches reconstruct', () => {
  const bundle = asyncRun().bundle;
  bundle.chunks[0].exit.kind = 'terminated';
  assert.equal(validateBundle(bundle).valid, true);
  assert.throws(() => replayExact(bundle), /Chunk exit mismatch/);
});

test('a live synchronous failure can be reproduced without a host adapter', () => {
  const runtime = createRuntime({adapters:{'demo.readNumber':() => ({
    kind:'throw', value:'service error'
  })}}).start('host.readNumber("A");');
  assert.equal(runtime.drive().kind, 'runtime.failure');
  const bundle = archive(runtime.exportRun());
  assert.equal(validateBundle(bundle).valid, true);
  assert.equal(replayExact(bundle).valid, true);
});
