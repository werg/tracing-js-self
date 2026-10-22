import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

// Observable reference oracle, not the proposed semantic interpreter.
async function guestProgram(host) {
  let optionReads = 0;
  const memory = new Uint8Array(1);
  const options = {
    get increment() {
      optionReads += 1;
      host.observe('getter', optionReads);
      return 2;
    }
  };

  const returned = host.visit(options, memory, value => {
    host.observe('callback.enter', value, memory[0]);
    memory[0] += value;
    host.observe('callback.write', memory[0]);
    return memory[0] + 1;
  });
  host.observe('visit.return', returned, memory[0], optionReads);

  let caught;
  try {
    host.failAfterMutation(memory);
    host.observe('unreachable');
  } catch (error) {
    caught = error.message;
    host.observe('caught', caught, memory[0]);
  }

  const a = host.readAsync('A');
  const b = host.readAsync('B');
  host.observe('requests.issued');
  const bias = await Promise.resolve(5);
  host.observe('bias', bias);
  const av = await a;
  host.observe('a', av);
  const bv = await b;
  host.observe('b', bv);
  const answer = returned + memory[0] + bias + av + bv;
  host.store('answer', answer);
  return { answer, optionReads, memory: memory[0], caught };
}

function makeEnvironment({ packing = 'individual', replay = null,
                           duplicateConversion = false } = {}) {
  const events = [];
  const pending = new Map();
  const dispatches = [];
  const queued = [];
  const mockStorage = new Map();
  let liveWrites = 0;
  let cursor = 0;

  function record(...row) {
    if (replay) {
      assert.deepEqual(row, replay[cursor], 'reference transcript divergence');
    }
    events.push(row);
    cursor += 1;
  }

  function dispatch(names) {
    for (const name of names) pending.get(name).dispatched = true;
    dispatches.push({ requests: [...names] });
  }

  // Typed service entry: never inspect the original options object here.
  function visitTyped({ increment, memory, callback }) {
    memory[0] = increment;
    record('service.write', memory[0]);
    const result = callback(increment);
    record('service.afterCallback', memory[0], result);
    return result;
  }

  const host = {
    observe: record,
    visit(options, memory, callback) {
      assert(memory instanceof Uint8Array);
      assert.equal(typeof callback, 'function');
      // This fixture defines exactly one dictionary read, then conversion.
      const increment = Number(options.increment);
      if (duplicateConversion) Number(options.increment);
      assert(Number.isInteger(increment) && increment >= 0 && increment <= 255);
      record('binding.complete', increment);
      return visitTyped({ increment, memory, callback });
    },
    failAfterMutation(memory) {
      memory[0] = 7;
      record('service.writeThenThrow', memory[0]);
      throw new Error('fixture boom');
    },
    readAsync(name) {
      assert(!pending.has(name));
      let resolve;
      const promise = new Promise(accept => { resolve = accept; });
      pending.set(name, { resolve, dispatched: false, delivered: false });
      record('read.request', name);
      if (packing === 'individual') dispatch([name]);
      else queued.push(name);
      return promise;
    },
    store(key, value) {
      record('store', key, value);
      if (!replay) {
        mockStorage.set(key, value);
        liveWrites += 1;
      }
    }
  };

  return {
    host, events, dispatches, mockStorage,
    flush() {
      if (queued.length) dispatch(queued.splice(0));
    },
    deliver(name, value) {
      const entry = pending.get(name);
      assert(entry && entry.dispatched && !entry.delivered);
      record('input.deliver', name, value);
      entry.delivered = true;
      entry.resolve(value);
    },
    finish() {
      assert([...pending.values()].every(entry => entry.delivered));
      if (replay) assert.equal(cursor, replay.length);
      return { events, dispatches, liveWrites };
    }
  };
}

async function runScenario(options = {}) {
  const environment = makeEnvironment(options);
  const completion = guestProgram(environment.host);
  assert.deepEqual(environment.events.at(-1), ['requests.issued']);
  environment.flush();

  // The fulfilled internal await must resume asynchronously.
  await Promise.resolve();
  assert.deepEqual(environment.events.at(-1), ['bias', 5]);

  environment.deliver('B', 20);
  await Promise.resolve();
  assert(!environment.events.some(row => row[0] === 'a' || row[0] === 'b'));
  environment.deliver('A', 10);

  const result = await completion;
  return { ...environment.finish(), result };
}

const expected = [
  ['getter', 1],
  ['binding.complete', 2],
  ['service.write', 2],
  ['callback.enter', 2, 2],
  ['callback.write', 4],
  ['service.afterCallback', 4, 5],
  ['visit.return', 5, 4, 1],
  ['service.writeThenThrow', 7],
  ['caught', 'fixture boom', 7],
  ['read.request', 'A'],
  ['read.request', 'B'],
  ['requests.issued'],
  ['bias', 5],
  ['input.deliver', 'B', 20],
  ['input.deliver', 'A', 10],
  ['a', 10],
  ['b', 20],
  ['store', 'answer', 47]
];

const recorded = await runScenario();
assert.deepEqual(recorded.events, expected);
assert.deepEqual(recorded.result, {
  answer: 47, optionReads: 1, memory: 7, caught: 'fixture boom'
});
assert.equal(recorded.liveWrites, 1);
assert.deepEqual(recorded.dispatches, [{ requests: ['A'] }, { requests: ['B'] }]);

// This mock explicitly permits joint dispatch before either input delivery.
const batched = await runScenario({ packing: 'batch', replay: expected });
assert.deepEqual(batched.events, expected);
assert.deepEqual(batched.result, recorded.result);
assert.deepEqual(batched.dispatches, [{ requests: ['A', 'B'] }]);
assert.equal(batched.liveWrites, 0);

// An equal numeric result cannot hide a repeated observable conversion.
const duplicate = await runScenario({ duplicateConversion: true });
assert.equal(duplicate.result.optionReads, 2);
assert.throws(() => assert.deepEqual(duplicate.events, expected));

const bundle = {
  schema: 'semantic-tracing-observation-oracle/1',
  evidenceKind: 'native-reference-with-mock-service',
  completeSemanticTrace: false,
  source: {
    guest: guestProgram.toString(),
    harness: readFileSync(new URL(import.meta.url), 'utf8')
  },
  inputs: [['B', 20], ['A', 10]],
  expectedObservations: expected,
  expectedResult: recorded.result,
  permittedDispatchVariants: [recorded.dispatches, batched.dispatches],
  checks: {
    getterReadOnce: true,
    bufferCoherenceAcrossCallback: true,
    synchronousThrowPreserved: true,
    reverseCompletionOrder: true,
    internalAwaitSuspends: true,
    permittedBatchingEquivalent: true,
    transcriptStoreDoesNotRepeatMockEffect: true,
    duplicateConversionDetected: true
  }
};

if (process.argv.includes('--write')) {
  writeFileSync('reference-observations.json', JSON.stringify(bundle, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: Object.keys(bundle.checks), result: recorded.result }, null, 2));
