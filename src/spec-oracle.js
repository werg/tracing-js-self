// Spec-backed comparison oracle only. Nothing executed here is journaled;
// callers MUST NOT treat this as a substitute for the owned tracing machine.
// engine262 is optional and pinned in profiles/targets.lock.json and CI.
import { encode } from './values.js';

function scalar(value) {
  if (!value || !['Undefined','Null','Boolean','String','Number','BigInt'].includes(value.type))
    throw new TypeError(`Non-scalar spec reference result: ${value?.type ?? typeof value}`);
  return encode(value.value);
}

export async function createSpecOracle() {
  let engine;
  try {
    engine = await import('@engine262/engine262');
  } catch (cause) {
    throw new Error('Spec oracle requires the separately pinned @engine262/engine262 package', { cause });
  }

  function makeRealm() {
    // engine262 currently uses a process-global surroundingAgent. Operations
    // are intentionally sequential, with one disposable agent/realm each.
    const agent = new engine.Agent({ startEventLoop: false });
    engine.setSurroundingAgent(agent);
    const realm = new engine.ManagedRealm({ name: 'Tracing differential reference' });
    return realm;
  }

  function compileScript(source, { url = '<spec-reference>' } = {}) {
    const realm = makeRealm();
    const completion = realm.compileScript(source, { specifier: url });
    return { accepted: !(completion instanceof engine.ThrowCompletion) };
  }

  function evaluateScalar(source, { resultExpression = 'result', url = '<spec-reference>' } = {}) {
    // The statement result is observed inside the reference realm, rather
    // than dereferencing or converting any reference-realm object in Node.
    // The expression is fixture-controlled, never supplied from live input.
    const realm = makeRealm();
    const completion = realm.evaluateScriptSkipDebugger(
      `${source}\n${resultExpression};`, { specifier: url }
    );
    if (completion instanceof engine.ThrowCompletion)
      throw new Error(`Spec reference guest completion was abrupt for ${url}`);
    return scalar(engine.ValueOfNormalCompletion(completion));
  }
  function errorName(realm, value) {
    if (value?.type !== 'Object') return null;
    const restore = realm.pushTopContext();
    try {
      const name = engine.X(engine.Get(value, 'name'));
      return name?.type === 'String' ? name.value : null;
    } finally {
      restore?.();
    }
  }

  function describe(realm, completion, phase) {
    if (completion instanceof engine.ThrowCompletion)
      return {phase, errorName: errorName(realm, completion.Value)};
    const value = engine.ValueOfNormalCompletion(completion);
    if (['Undefined','Null','Boolean','String','Number','BigInt'].includes(value?.type))
      return {phase:'normal',value:scalar(value)};
    return {phase:'normal',valueType:value?.type ?? null};
  }

  // A separate reference-only execution surface for explicitly selected
  // Test262 scripts. Per-script Agent/Realm, no harness or host integrations.
  // This is NOT an authoritative owned-machine trace.
  function runScript(source, {url='<spec-reference>'}={}) {
    const realm = makeRealm();
    const compiled = realm.compileScript(source, {specifier:url});
    if (compiled instanceof engine.ThrowCompletion) return describe(realm,compiled,'parse');
    const completion = realm.evaluateScriptSkipDebugger(
      engine.ValueOfNormalCompletion(compiled), {specifier:url});
    return describe(realm,completion,'runtime');
  }

  return { compileScript, evaluateScalar, runScript };
}
