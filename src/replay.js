// Deterministic re-execution of the declared bounded interpreter profile.
// The archive supplies only source text and external inputs. Guest instructions
// and their semantic events are regenerated; no host adapter is ever installed.
// This checks consistency with *this interpreter*, not ECMAScript conformance.
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from './runtime.js';
import { validateBundle } from './validation.js';

export class TraceReplayError extends Error {
  constructor(message, eventId = null, cause = null) {
    super(eventId ? `${message} at ${eventId}` : message, cause ? { cause } : undefined);
    this.name = 'TraceReplayError';
    this.eventId = eventId;
  }
}
function fail(message, eventId = null, cause = null) {
  throw new TraceReplayError(message, eventId, cause);
}
// Compare the serializable wire representation. Compilers sometimes include
// optional undefined properties that JSON artifacts correctly omit.
const wire = value => JSON.parse(JSON.stringify(value));
function expectSame(actual, expected, label, eventId = null) {
  if (!isDeepStrictEqual(wire(actual), wire(expected))) fail(`Replay divergence: ${label}`, eventId);
}
function causeId(event, kind, field) {
  const id = event.causes?.find(c => c.kind === kind)?.[field];
  if (typeof id !== 'string' || !id) fail(`Missing ${kind} cause`, event.eventId);
  return id;
}
function inputArrival(runtime, event) {
  // Read the immutable arrival payload from the event that introduced it,
  // never from the final input table, which may reflect later deliveries.
  const patches = event.stateChanges.filter(p => p.table === 'inputs' && p.before === null);
  if (patches.length !== 1 || !patches[0].after) fail('Expected one input creation', event.eventId);
  const input = patches[0].after;
  const effectId = causeId(event, 'effect', 'effectId');
  if (input.effectId !== effectId || input.status !== 'arrived') fail('Malformed input creation', event.eventId);

  // Input IDs can be allocated by the VM or supplied by a transport. Preserve
  // the two different counter effects, then compare the entire emitted event.
  const beforeCount = runtime.state.counters.ids.input;
  const countPatch = event.stateChanges.find(p => p.table === 'counters' && p.id === 'ids');
  const afterCount = countPatch?.after?.input ?? beforeCount;
  if (afterCount !== beforeCount && afterCount !== beforeCount + 1) fail('Invalid input allocation', event.eventId);
  runtime.recordInputArrival({
    effectId, kind: input.kind, value: input.value, abrupt: input.abrupt,
    inputId: afterCount === beforeCount + 1 ? null : input.id
  });
}
// Mirror the quiescence decision in Runtime.drive, including the priority of a
// blocked synchronous frame over queued jobs. A chunk cannot seal mid-execution.
function exitKind(runtime) {
  if (runtime.prepared()) return null;
  const c = runtime.state.control.a0;
  const active = c.activeFrameId && runtime.state.frames[c.activeFrameId];
  if (active?.status === 'running') return null;
  if (active?.status === 'blocked') return 'waiting';
  if (c.queue.length) return null;
  const pending = Object.values(runtime.state.promises).some(p => p.status === 'pending') ||
    Object.values(runtime.state.effects).some(e => e.external === 'pending');
  return c.status === 'failed' ? 'runtime.failure' : pending ? 'waiting' : 'terminated';
}

/**
 * Re-execute a fully sealed run without native effects, checking every event,
 * source site, state mutation, chunk boundary, and checkpoint.
 *
 * The independent structural validator is run first. The interpreter is then
 * compiled again from recorded source; archived bytecode is never executed.
 * Recorded environment inputs are injected at precisely their journaled events.
 * This is NOT an independent spec oracle or native resource restoration.
 */
export function replayExact(bundle) {
  validateBundle(bundle);
  const runtime = createRuntime(); // Deliberately no adapters: no external calls.
  let entryCode = null;
  const initial = bundle.initialState;
  const activeId = initial?.control?.a0?.activeFrameId;
  if (activeId) entryCode = initial.frames?.[activeId]?.codeId;
  if (!entryCode || !Array.isArray(bundle.sources) || !bundle.sources.length)
    fail('Missing started source or initial frame');

  let entry = null;
  try {
    for (const src of bundle.sources) {
      const compiled = runtime.registerSource({ text: src.text, url: src.url, goal: src.goal });
      if (compiled.entry === entryCode) entry = compiled;
    }
    if (!entry) fail('Initial frame has no matching registered source');
    expectSame(runtime.sources, bundle.sources, 'source descriptors');
    expectSame(runtime.sites, bundle.sites, 'compiled source sites');
    expectSame(runtime.programs, bundle.programs, 'compiled bytecode');
    runtime.start(entry);
    expectSame(runtime.initialState, bundle.initialState, 'initial machine state');
  } catch (error) {
    if (error instanceof TraceReplayError) throw error;
    fail('Cannot compile/start archived source', null, error);
  }

  let chunkIndex = 0;
  function sealExpected() {
    while (chunkIndex < bundle.chunks.length &&
           bundle.chunks[chunkIndex].lastEvent === runtime.events.length) {
      const expected = bundle.chunks[chunkIndex];
      const actualKind = exitKind(runtime);
      if (actualKind === null) fail('Chunk sealed with runnable guest work', runtime.events.at(-1)?.eventId);
      if (actualKind !== expected.exit?.kind)
        fail(`Chunk exit mismatch: expected ${expected.exit?.kind}, got ${actualKind}`,
          runtime.events.at(-1)?.eventId);
      runtime.seal(actualKind);
      if (runtime.chunks.length !== chunkIndex + 1) fail('Missing replay chunk boundary');
      expectSame(runtime.chunks[chunkIndex], expected, `chunk ${chunkIndex + 1}`);
      expectSame(runtime.checkpoints[expected.after], bundle.checkpoints[expected.after],
        `checkpoint ${expected.after}`);
      chunkIndex++;
    }
  }

  sealExpected();
  for (const expected of bundle.events) {
    const before = runtime.events.length;
    try {
      switch (expected.operation) {
        case 'effect.dispatch':
          runtime.dispatchPrepared(causeId(expected, 'effect', 'effectId'));
          break;
        case 'external.input.arrive':
          inputArrival(runtime, expected);
          break;
        case 'external.input.deliver':
          runtime.deliverInput(causeId(expected, 'input', 'inputId'));
          break;
        case 'job.enter':
          runtime.enterQueuedJob();
          break;
        default:
          runtime.step();
      }
    } catch (error) {
      if (error instanceof TraceReplayError) throw error;
      fail('Cannot reproduce journal operation', expected.eventId, error);
    }
    if (runtime.events.length !== before + 1)
      fail('Expected one replay event', expected.eventId);
    expectSame(runtime.events[before], expected, 'semantic event', expected.eventId);
    sealExpected();
  }

  if (chunkIndex !== bundle.chunks.length) fail('Unreproduced chunk boundaries');
  expectSame(runtime.state, bundle.finalState, 'final machine state');
  expectSame(runtime.state.effects, bundle.effects, 'final effect table');
  expectSame(runtime.state.inputs, bundle.inputs, 'final input table');
  expectSame(runtime.checkpoints, bundle.checkpoints, 'checkpoint map');

  return {
    valid: true,
    mode: 'bounded-deterministic-reexecution/1',
    eventCount: runtime.events.length,
    chunkCount: runtime.chunks.length,
    externalAdapterCalls: 0,
    evidence: 'exact interpreter event/state reproduction under recorded inputs; not independent spec or native replay'
  };
}
