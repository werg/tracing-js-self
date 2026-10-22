// Independent, spec-backed reference execution via a pinned engine262 build.
//
// Deliberately NOT a tracing backend. No engine262 values, objects, contexts or
// jobs are allowed into the owned-machine journal: their host-side identities
// cannot currently satisfy the serializable state and replay contracts.
import {
  Agent, ManagedRealm, setSurroundingAgent, ThrowCompletion,
  ValueOfNormalCompletion, Get, X,
} from '@engine262/engine262';
import { encode } from './values.js';

function errorName(realm, value) {
  if (value?.type !== 'Object') return null;
  const pop = realm.pushTopContext();
  try {
    const name = X(Get(value, 'name'));
    return name?.type === 'String' ? name.value : null;
  } finally {
    pop?.();
  }
}

function summarize(realm, completion, phase) {
  if (completion instanceof ThrowCompletion) {
    return { phase, errorName: errorName(realm, completion.Value) };
  }
  const value = ValueOfNormalCompletion(completion);
  if (!value) throw new TypeError('Expected a value completion from engine262');
  // Encode only exact primitive values; never coerce an engine object using
  // native JavaScript or serialize its internal slots as owned VM state.
  if (['Undefined', 'Null', 'Boolean', 'String', 'Number', 'BigInt'].includes(value.type)) {
    return { phase: 'normal', value: encode(value.value) };
  }
  return { phase: 'normal', valueType: value.type };
}

/**
 * Execute one Script-goal source in an isolated engine262 Agent and Realm.
 * Parse failures are distinguished from runtime throws. No host bridges,
 * test262 harness globals, or native guest evaluator are installed.
 * Only a portable scalar completion or a failure classification is returned.
 */
export function runReferenceScript(source, { specifier = '<reference>' } = {}) {
  if (typeof source !== 'string') throw new TypeError('Source text required');
  const agent = new Agent({ startEventLoop: false });
  setSurroundingAgent(agent); // engine262's Agent is process-global.
  const realm = new ManagedRealm({ name: 'reference-oracle', specifier });
  const compiled = realm.compileScript(source, { specifier });
  if (compiled instanceof ThrowCompletion) return summarize(realm, compiled, 'parse');
  const executed = realm.evaluateScriptSkipDebugger(ValueOfNormalCompletion(compiled), { specifier });
  return summarize(realm, executed, 'runtime');
}
