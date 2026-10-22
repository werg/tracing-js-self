import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';
import { reconstruct, validateBundle, TraceValidationError } from '../src/validation.js';
import { replayExact } from '../src/replay.js';
import { validateHostJournal } from '../src/host-journal.js';

const archived = value => JSON.parse(JSON.stringify(value));

function completedRun() {
  const runtime = createRuntime().start('const a = host.readAsync("A"); const b = host.readAsync("B");');
  assert.equal(runtime.drive().kind, 'waiting');
  const [a, b] = Object.values(runtime.state.effects);
  const first = runtime.recordInputArrival({ effectId: a.id, kind: 'completion', value: 11 });
  runtime.deliverInput(first.inputId);
  const second = runtime.recordInputArrival({
    effectId: b.id, kind: 'completion', value: 22, inputId: 'transport-B'
  });
  runtime.deliverInput(second.inputId);
  assert.equal(runtime.drive().kind, 'terminated');
  return archived(runtime.exportRun());
}

function refreshChunkCauseIndexes(bundle) {
  let index = 0;
  for (const chunk of bundle.chunks) {
    const events = bundle.events.slice(index, chunk.lastEvent);
    chunk.effects = [...new Set(events.flatMap(e => e.causes
      .filter(c => c.kind === 'effect').map(c => c.effectId)))];
    chunk.inputs = [...new Set(events.flatMap(e => e.causes
      .filter(c => c.kind === 'input').map(c => c.inputId)))];
    index = chunk.lastEvent;
  }
}

test('legitimate host histories reconstruct and replay with generated and transport input IDs', () => {
  const bundle = completedRun();
  assert.equal(validateBundle(bundle).valid, true);
  assert.equal(replayExact(bundle).valid, true);
  assert.equal(bundle.events.filter(e => e.operation === 'external.input.deliver').length, 2);
});

test('runtime rejects multiple input arrivals for one single-outcome effect without changing the journal', () => {
  const runtime = createRuntime().start('host.readAsync("A");');
  assert.equal(runtime.drive().kind, 'waiting');
  const effectId = Object.values(runtime.state.effects)[0].id;
  const first = runtime.recordInputArrival({ effectId, kind: 'completion', value: 17 });
  const count = runtime.events.length;
  assert.throws(() => runtime.recordInputArrival({
    effectId, kind: 'completion', value: 18
  }), /already has an input arrival/);
  assert.equal(runtime.events.length, count);
  runtime.deliverInput(first.inputId);
  assert.equal(runtime.drive().kind, 'terminated');
  assert.equal(validateBundle(archived(runtime.exportRun())).valid, true);
});

test('host inputs are canonical scalar tuples, including NaN across JSON replay', () => {
  const runtime = createRuntime().start('host.readAsync("A");');
  assert.equal(runtime.drive().kind, 'waiting');
  const effectId = Object.values(runtime.state.effects)[0].id;
  const count = runtime.events.length;
  const invalid = [
    ['num', NaN], ['num', Infinity], ['num', -Infinity], ['num', -0],
    ['num', null], ['bigint', '-0'], ['bool', 0], ['ref', 'o1']
  ];
  for (const value of invalid) {
    assert.throws(() => runtime.recordInputArrival({
      effectId, kind: 'completion', value
    }), /Unsupported canonical external payload/);
  }
  assert.equal(runtime.events.length, count);
  const arrival = runtime.recordInputArrival({ effectId, kind: 'completion', value: NaN });
  assert.deepEqual(runtime.state.inputs[arrival.inputId].value, ['num', 'NaN']);
  runtime.deliverInput(arrival.inputId);
  assert.equal(runtime.drive().kind, 'terminated');
  const bundle = archived(runtime.exportRun());
  assert.equal(validateBundle(bundle).valid, true);
  assert.equal(replayExact(bundle).valid, true);
});

test('archived host payloads must use canonical scalar tags', () => {
  const bundle = completedRun();
  const arrival = bundle.events.find(e => e.operation === 'external.input.arrive');
  arrival.stateChanges.find(p => p.table === 'inputs').after.value = ['num', null];
  assert.throws(() => validateHostJournal(bundle, (message, eventId) => {
    throw new TraceValidationError(message, eventId);
  }), /Invalid host arrival linkage/);
});

test('transport input IDs cannot shadow object prototypes or use non-string identifiers', () => {
  const runtime = createRuntime().start('host.readAsync("A");');
  runtime.drive();
  const effectId = Object.values(runtime.state.effects)[0].id;
  const count = runtime.events.length;
  for (const inputId of ['__proto__', 'constructor', 'prototype', '', 7]) {
    assert.throws(() => runtime.recordInputArrival({
      effectId, kind: 'completion', value: 10, inputId
    }), /Transport input ID/);
  }
  assert.equal(runtime.events.length, count);
});

test('initial checkpoint and exported host-table copies are authenticated against reconstruction', () => {
  const mutations = [
    b => { b.checkpoints.q0.control.a0.status = 'forged'; },
    b => { Object.values(b.effects)[0].operation = 'forged'; },
    b => { Object.values(b.inputs)[0].value = ['num', 99]; }
  ];
  for (const mutate of mutations) {
    const bundle = completedRun();
    mutate(bundle);
    assert.throws(() => validateBundle(bundle), TraceValidationError);
  }
});

test('host dispatch, arrival and delivery causes must match their mutations', () => {
  const scenarios = [
    b => {
      const event = b.events.find(e => e.operation === 'effect.dispatch');
      const all = Object.keys(b.effects);
      event.causes.find(c => c.kind === 'effect').effectId = all[1];
    },
    b => {
      const event = b.events.find(e => e.operation === 'external.input.arrive');
      event.causes.find(c => c.kind === 'effect').effectId = Object.keys(b.effects)[1];
    },
    b => {
      const event = b.events.find(e => e.operation === 'external.input.deliver');
      event.causes.find(c => c.kind === 'input').inputId = 'transport-B';
    }
  ];
  for (const mutate of scenarios) {
    const bundle = completedRun();
    mutate(bundle);
    refreshChunkCauseIndexes(bundle);
    assert.deepEqual(reconstruct(bundle), bundle.finalState, 'patch history still reconstructs');
    assert.throws(() => validateBundle(bundle), TraceValidationError);
  }
});

test('host delivery results and lifecycle transitions are checked independently of replay', () => {
  const scenarios = [
    b => {
      b.events.find(e => e.operation === 'external.input.deliver').result = ['num', 999];
    },
    b => {
      const e = b.events.find(e => e.operation === 'effect.dispatch');
      e.operation = 'stack.pop';
      e.catalogRef = 'stack.pop/1';
    },
    b => {
      const e = b.events.find(e => e.operation === 'external.input.arrive');
      const fx = e.stateChanges.find(p => p.table === 'effects');
      fx.after.inputIds = []; // Invalid linkage, even if version/preconditions could be rewritten.
    }
  ];
  for (const mutate of scenarios) {
    const bundle = completedRun();
    mutate(bundle);
    assert.throws(() => validateBundle(bundle), TraceValidationError);
  }
});

test('chunk identities, cause indexes and pending summaries cannot be forged', () => {
  const scenarios = [
    b => { b.chunks[0].chunkId = 'a0:c400'; },
    b => { b.chunks[0].effects = []; },
    b => { b.chunks[0].exit.pendingEffects = []; },
    b => { b.chunks[0].exit.waitingOn = ['fictional-block']; }
  ];
  for (const mutate of scenarios) {
    const bundle = completedRun();
    mutate(bundle);
    assert.throws(() => validateBundle(bundle), TraceValidationError);
  }
});

test('synchronous host throw lifecycle remains structurally valid and replayable', () => {
  const runtime = createRuntime().start('host.readNumber("A");');
  assert.equal(runtime.drive().kind, 'waiting');
  const effectId = Object.values(runtime.state.effects)[0].id;
  const input = runtime.recordInputArrival({
    effectId, kind: 'immediate', value: 'unavailable', abrupt: true
  });
  runtime.deliverInput(input.inputId);
  assert.equal(runtime.drive().kind, 'runtime.failure');
  const bundle = archived(runtime.exportRun());
  assert.equal(validateBundle(bundle).valid, true);
  assert.equal(replayExact(bundle).valid, true);
});

test('reserved mutation entity IDs are rejected before object property assignment', () => {
  const bundle = completedRun();
  const event = bundle.events.find(e => e.stateChanges.length);
  event.stateChanges[0].id = '__proto__';
  assert.throws(() => reconstruct(bundle), /Invalid mutation entity ID/);
});
