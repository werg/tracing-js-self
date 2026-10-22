// Data-only vocabulary shared by the executor and read-only structural validator.
// The transition graph describes the supported slice, not full ECMA-262 coverage.
export const ENGINE_REVISION = '2d7d8d988c77e94473ba0377122cdfccdfe243ba';
export const ARITHMETIC_OPERATORS = Object.freeze(['+', '-', '*', '/', '%', '**']);
export const NUMERIC_METHODS = Object.freeze({
  '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'remainder', '**': 'exponentiate'
});
export const SPEC_REGISTERS = Object.freeze([
  'leftPrimitive', 'rightPrimitive', 'leftNumericPrimitive', 'rightNumericPrimitive',
  'leftNumeric', 'rightNumeric', 'leftString', 'rightString', 'value'
]);
export const SPEC_TRANSITIONS = Object.freeze({
  'left-primitive': ['right-primitive', 'coercion-get', 'complete'],
  'right-primitive': ['select', 'coercion-get', 'complete'],
  select: ['left-string', 'left-numeric'],
  'left-string': ['right-string'],
  'right-string': ['concatenate'],
  concatenate: ['complete'],
  'left-numeric': ['left-numeric-primitive'],
  'left-numeric-primitive': ['left-numeric-kind', 'coercion-get', 'complete'],
  'left-numeric-kind': ['right-numeric', 'left-number'],
  'left-number': ['right-numeric'],
  'right-numeric': ['right-numeric-primitive'],
  'right-numeric-primitive': ['right-numeric-kind', 'coercion-get', 'complete'],
  'right-numeric-kind': ['numeric-types', 'right-number'],
  'right-number': ['numeric-types'],
  'numeric-types': ['apply', 'complete'],
  apply: ['complete'],
  complete: ['done'],
  'coercion-get': ['coercion-call','complete'],
  'coercion-call': ['coercion-get','coercion-return','right-primitive','select','left-numeric-kind','right-numeric-kind','complete'],
  'coercion-return': ['coercion-get','right-primitive','select','left-numeric-kind','right-numeric-kind','complete'],
  done: []
});

export function specStep(record) {
  let operation, algorithm, clause, step;
  const phase = record.phase;
  if (phase==='coercion-get'||phase==='coercion-call'||phase==='coercion-return'){
    algorithm='OrdinaryToPrimitive';clause='sec-ordinarytoprimitive';
    operation=phase==='coercion-get'?'spec.internal.get':
      phase==='coercion-call'?'spec.internal.call':'spec.internal.return';
    step=phase==='coercion-get'?'Get conversion method':
      phase==='coercion-call'?'Call conversion method with receiver':'Check method result';
  } else if (phase.endsWith('-primitive')) {
    operation = 'spec.to-primitive'; algorithm = 'ToPrimitive'; clause = 'sec-toprimitive';
    step = 'primitive identity; object branch unsupported';
  } else if (phase.endsWith('-string')) {
    operation = 'spec.to-string'; algorithm = 'ToString'; clause = 'sec-tostring';
    step = 'primitive conversion';
  } else if (phase.endsWith('-number')) {
    operation = 'spec.to-number'; algorithm = 'ToNumber'; clause = 'sec-tonumber';
    step = 'primitive conversion';
  } else if (phase.endsWith('-numeric') || phase.endsWith('-numeric-kind')) {
    operation = 'spec.to-numeric'; algorithm = 'ToNumeric'; clause = 'sec-tonumeric';
    step = phase.endsWith('-kind') ? 'BigInt or ToNumber' : 'enter ToPrimitive with number hint';
  } else if (phase === 'apply') {
    const type = record.registers.leftNumeric.value[0] === 'bigint' ? 'BigInt' : 'Number';
    algorithm = type + '::' + NUMERIC_METHODS[record.operator];
    operation = 'spec.numeric.apply';
    clause = 'sec-numeric-types-' + type.toLowerCase() + '-' + NUMERIC_METHODS[record.operator];
    step = 'typed scalar leaf';
  } else {
    algorithm = 'ApplyStringOrNumericBinaryOperator'; clause = 'sec-applystringornumericbinaryoperator';
    operation = ({select:'spec.binary.select', concatenate:'spec.string.concatenate',
      'numeric-types':'spec.numeric.same-type', complete:'spec.operation.complete'})[phase];
    step = ({select:'string or numeric branch', concatenate:'string concatenation',
      'numeric-types':'same numeric type', complete:'return completion'})[phase];
  }
  if (!operation) throw new Error('Invalid owned arithmetic phase: ' + phase);
  return {operation, spec: {algorithm, clause, step, phase, engineRevision: ENGINE_REVISION}};
}
