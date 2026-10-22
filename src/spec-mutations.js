// Writer-side commands for owned spec records. The validator has a separate
// read-only implementation and never imports this writer or the evaluator.
import { SPEC_REGISTERS } from './spec-schema.js';
const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function operationMutation(before, after) {
  if (!after) throw new Error('Owned operation history cannot be deleted');
  if (!before) return {kind:'operation.create', table:'operations', id:after.id, record:copy(after)};
  for (const key of Object.keys(before)) {
    if (!['version','phase','status','registers','completion'].includes(key) && !equal(before[key], after[key]))
      throw new Error('Immutable owned-operation field changed: ' + key);
  }
  const common = {table:'operations', id:after.id, expectedVersion:before.version};
  if (after.status === 'completed') {
    if (before.phase !== 'complete' || before.status !== 'running' || after.phase !== 'done' ||
        !equal(before.registers, after.registers) || !equal(before.completion, after.completion))
      throw new Error('Invalid operation completion transition');
    return {kind:'operation.complete', ...common, completion:copy(after.completion)};
  }
  const writes = [];
  for (const name of new Set([...Object.keys(before.registers), ...Object.keys(after.registers)])) {
    if (!SPEC_REGISTERS.includes(name)) throw new Error('Unknown spec register: ' + name);
    const old = before.registers[name] ?? null, value = after.registers[name] ?? null;
    if (!equal(old, value)) writes.push({name, before:copy(old), after:copy(value)});
  }
  return {kind:'operation.advance', ...common, from:before.phase, to:after.phase, writes,
    completionBefore:copy(before.completion), completionAfter:copy(after.completion)};
}
