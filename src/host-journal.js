// Structural host-input authority checks over archived mutations only.
// Does not import or invoke the runtime, replay guest code, or claim native/spec correctness.
import { isDeepStrictEqual } from 'node:util';
import {validatePreparedRequest} from './host/validate-request.js';

// External payloads are scalar tuples: reconstructing arbitrary host objects is
// not supported. Check the wire format independently of Runtime.guestValue.
function canonicalScalar(value) {
  if (!Array.isArray(value)) return false;
  if (value.length === 1) return value[0] === 'null' || value[0] === 'undefined';
  if (value.length !== 2) return false;
  const [kind, payload] = value;
  switch (kind) {
    case 'bool': return typeof payload === 'boolean';
    case 'str': return typeof payload === 'string';
    case 'bigint': return typeof payload === 'string' && /^(0|-?[1-9]\d*)$/.test(payload);
    case 'num':
      return (typeof payload === 'number' && Number.isFinite(payload) &&
        !Object.is(payload, -0)) || ['-0', 'NaN', '+Infinity', '-Infinity'].includes(payload);
    default: return false;
  }
}
export function validateHostJournal(bundle, fail) {
  const dispatched = new Set();
  const created = new Set();
  const arrived = new Map(); // input ID -> effect ID
  const inputForEffect = new Map(); // bounded profile: one input per effect
  const delivered = new Set();
  const heap = structuredClone(bundle.initialState.heap);

  function patches(event, table) {
    return event.stateChanges.filter(p => p.table === table);
  }
  function onlyPatch(event, list, id, label) {
    if (list.length !== 1 || list[0].id !== id)
      fail(`Expected one ${label} mutation`, event.eventId);
    return list[0];
  }
  function cause(event, kind, key) {
    const matches = event.causes.filter(c => c.kind === kind);
    const value = matches[0]?.[key];
    if (matches.length !== 1 || typeof value !== 'string' || !value)
      fail(`Missing or ambiguous ${kind} cause`, event.eventId);
    return value;
  }
  function changedOnly(before, after, changes) {
    return before && after && isDeepStrictEqual(after, {
      ...before, ...changes, version: before.version + 1
    });
  }

  for (const [index,event] of bundle.events.entries()) {
    // Only earlier committed patches supply a request's materialization.
    // A later mutation to the same object must not rewrite this historical payload.
    if(index)for(const patch of patches(bundle.events[index-1],'heap')) {
      if(patch.after===null)delete heap[patch.id];
      else heap[patch.id]=structuredClone(patch.after);
    }
    const effects = patches(event, 'effects');
    const inputs = patches(event, 'inputs');

    if (event.operation === 'call.enter') {
      if (inputs.length || effects.length > 1)
        fail('Unexpected host mutations during call', event.eventId);
      if (!effects.length) {
        if (event.causes.some(c => c.kind === 'effect'))
          fail('Effect cause without effect creation', event.eventId);
        continue;
      }
      const p = effects[0];
      if (p.before !== null || !p.after || p.after.id !== p.id ||
          p.after.dispatch !== 'prepared' || p.after.external !== 'pending' ||
          !Array.isArray(p.after.inputIds) || p.after.inputIds.length ||
          !['promise', 'synchronous'].includes(p.after.kind) ||
          cause(event, 'effect', 'effectId') !== p.id || created.has(p.id))
        fail('Malformed effect creation', event.eventId);
      if(!event.siteId||!event.invocationId||
          p.after.frameId!==event.invocationId||
          !isDeepStrictEqual(event.operands?.[0],['hostfn',p.after.operation])||
          !isDeepStrictEqual(p.after.args,event.operands?.slice(1))||
          !isDeepStrictEqual(p.after.argOrigins,event.operandOrigins?.slice(1)))
        fail('External request differs from originating JS invocation or operands',
          event.eventId);
      try {validatePreparedRequest(heap,p.after);}
      catch(error) {fail(error.message,event.eventId);}
      created.add(p.id);
      continue;
    }

    if (event.operation === 'effect.dispatch') {
      const id = cause(event, 'effect', 'effectId');
      const p = onlyPatch(event, effects, id, 'dispatch');
      if (inputs.length || !created.has(id) || dispatched.has(id) ||
          p.before?.dispatch !== 'prepared' || p.before?.external !== 'pending' ||
          !changedOnly(p.before, p.after, { dispatch: 'dispatched' }))
        fail('Invalid dispatch transition', event.eventId);
      dispatched.add(id);
      continue;
    }

    if (event.operation === 'external.input.arrive') {
      const effectId = cause(event, 'effect', 'effectId');
      const p = onlyPatch(event, inputs, inputs[0]?.id, 'input creation');
      const fx = onlyPatch(event, effects, effectId, 'arrival effect');
      if (!dispatched.has(effectId) || inputForEffect.has(effectId) ||
          p.before !== null || p.after?.id !== p.id ||
          p.after?.effectId !== effectId || p.after.status !== 'arrived' ||
          typeof p.after.abrupt !== 'boolean' || !canonicalScalar(p.after.value) ||
          arrived.has(p.id) || fx.before?.dispatch !== 'dispatched' ||
          fx.before?.external !== 'pending' ||
          p.after.kind !== (fx.before.kind === 'promise' ? 'completion' : 'immediate') ||
          !Array.isArray(fx.before.inputIds) ||
          !changedOnly(fx.before, fx.after, { inputIds: [...fx.before.inputIds, p.id] }))
        fail('Invalid host arrival linkage', event.eventId);
      arrived.set(p.id, effectId);
      inputForEffect.set(effectId, p.id);
      continue;
    }

    if (event.operation === 'external.input.deliver') {
      const inputId = cause(event, 'input', 'inputId');
      const effectId = cause(event, 'effect', 'effectId');
      const p = onlyPatch(event, inputs, inputId, 'input delivery');
      const fx = onlyPatch(event, effects, effectId, 'delivery effect');
      if (arrived.get(inputId) !== effectId || delivered.has(inputId) ||
          p.before?.id !== inputId || p.before?.effectId !== effectId ||
          p.before?.status !== 'arrived' ||
          !changedOnly(p.before, p.after, { status: 'delivered' }) ||
          fx.before?.dispatch !== 'dispatched' ||
          fx.before?.external !== 'pending' ||
          !fx.before.inputIds?.includes(inputId) ||
          !changedOnly(fx.before, fx.after, {
            external: p.before.abrupt ? 'rejected' : 'completed',
            ...(fx.before.kind === 'synchronous' ? { immediate: 'completed' } : {})
          }) ||
          !isDeepStrictEqual(event.result, p.before.value))
        fail('Invalid host delivery transition', event.eventId);
      delivered.add(inputId);
      continue;
    }

    if (effects.length || inputs.length)
      fail('Host records changed outside lifecycle operation', event.eventId);
  }

  for (const fx of Object.values(bundle.effects)) {
    if (!created.has(fx.id) ||
        (fx.dispatch === 'dispatched' && !dispatched.has(fx.id)) ||
        !['prepared', 'dispatched'].includes(fx.dispatch) ||
        !Array.isArray(fx.inputIds) || fx.inputIds.length > 1 ||
        fx.inputIds.some(id => arrived.get(id) !== fx.id) ||
        (fx.external !== 'pending' && !fx.inputIds.some(id => delivered.has(id))))
      fail(`Effect ${fx.id} lifecycle is not journaled`);
  }
  for (const input of Object.values(bundle.inputs)) {
    if (arrived.get(input.id) !== input.effectId ||
        !['arrived', 'delivered'].includes(input.status) ||
        (input.status === 'delivered') !== delivered.has(input.id))
      fail(`Input ${input.id} lifecycle is not journaled`);
  }
}
