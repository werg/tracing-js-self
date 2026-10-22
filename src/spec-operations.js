// A serializable implementation of the primitive arithmetic slice of
// ApplyStringOrNumericBinaryOperator. No JS generators/closures hold guest work.
// References and domain limits are recorded in docs/OWNED_ARITHMETIC.md.
import { encode, decode, token } from './values.js';
import { ARITHMETIC_OPERATORS, specStep } from './spec-schema.js';

const primitives = new Set(['undefined', 'null', 'bool', 'str', 'num', 'bigint']);
export const isOwnedArithmetic = operator => ARITHMETIC_OPERATORS.includes(operator);

export function createArithmetic({ id, frameId, operator, left, right, siteId, sourceId, codeId }) {
  if (!isOwnedArithmetic(operator)) throw new Error('Unsupported owned operator: ' + operator);
  return {id, frameId, algorithm:'ApplyStringOrNumericBinaryOperator', operator,
    siteId, sourceId, codeId, operands:[left, right], registers:{}, completion:null,
    phase:operator === '+' ? 'left-primitive' : 'left-numeric', status:'running', version:0};
}

function toNumber(value) {
  switch (value[0]) {
    case 'undefined': return ['num', 'NaN'];
    case 'null': return ['num', 0];
    case 'bool': return ['num', value[1] ? 1 : 0];
    case 'num': return value;
    // Explicit primitive leaf. This never invokes a guest conversion method.
    // StringNumericLiteral parsing/rounding is delegated to the host Number.
    case 'str': return encode(Number(value[1]));
    default: throw new Error('Invalid ToNumber operand in owned arithmetic');
  }
}

function toString(value) {
  switch (value[0]) {
    case 'undefined': return ['str', 'undefined'];
    case 'null': return ['str', 'null'];
    case 'bool': return ['str', value[1] ? 'true' : 'false'];
    case 'str': return value;
    case 'bigint': return ['str', value[1]];
    // Host number formatting is a declared scalar leaf, including -0 -> "0".
    case 'num': return ['str', String(decode(value))];
    default: throw new Error('Invalid ToString operand in owned arithmetic');
  }
}

function numeric(operator, left, right) {
  const a = decode(left), b = decode(right);
  // The caller has already performed and journaled conversion and type checks.
  // These leaves operate only on same-type Number or BigInt host primitives.
  switch (operator) {
    case '+': return encode(a + b);
    case '-': return encode(a - b);
    case '*': return encode(a * b);
    case '/': return encode(a / b);
    case '%': return encode(a % b);
    case '**': return encode(a ** b);
    default: throw new Error('Invalid numeric operator');
  }
}

/** Mutate only a plain owned operation record, completing exactly one phase. */
export function advanceArithmetic(record, eventId) {
  if (record.status !== 'running') throw new Error('Arithmetic operation already completed');
  const metadata = specStep(record);
  const r = record.registers;
  let operands = [], result = null;
  const use = (...values) => { operands = values; };
  const write = (name, value) => { result = value; r[name] = token(value, eventId); };
  const complete = completion => { record.completion = completion; record.phase = 'complete'; };
  const normal = value => {
    write('value', value);
    complete({type:'normal', value:token(value, eventId)});
  };
  const unsupported = () => complete({type:'unsupported', feature:'ToPrimitive(Object)',
    message:'Object coercion is not implemented; no guest method was invoked', origin:eventId});

  switch (record.phase) {
    case 'left-primitive': case 'right-primitive': {
      const left = record.phase === 'left-primitive';
      const input = record.operands[left ? 0 : 1]; use(input);
      if (!primitives.has(input.value[0])) { unsupported(); break; }
      write(left ? 'leftPrimitive' : 'rightPrimitive', input.value);
      record.phase = left ? 'right-primitive' : 'select'; break;
    }
    case 'select':
      use(r.leftPrimitive, r.rightPrimitive);
      record.phase = r.leftPrimitive.value[0] === 'str' || r.rightPrimitive.value[0] === 'str'
        ? 'left-string' : 'left-numeric';
      result = ['bool', record.phase === 'left-string']; break;
    case 'left-string': case 'right-string': {
      const left = record.phase === 'left-string';
      const input = left ? r.leftPrimitive : r.rightPrimitive; use(input);
      write(left ? 'leftString' : 'rightString', toString(input.value));
      record.phase = left ? 'right-string' : 'concatenate'; break;
    }
    case 'concatenate':
      use(r.leftString, r.rightString);
      normal(['str', r.leftString.value[1] + r.rightString.value[1]]); break;
    case 'left-numeric': case 'right-numeric': {
      const left = record.phase === 'left-numeric';
      use((left ? r.leftPrimitive : r.rightPrimitive) ?? record.operands[left ? 0 : 1]);
      record.phase = left ? 'left-numeric-primitive' : 'right-numeric-primitive'; break;
    }
    case 'left-numeric-primitive': case 'right-numeric-primitive': {
      const left = record.phase === 'left-numeric-primitive';
      const input = (left ? r.leftPrimitive : r.rightPrimitive) ?? record.operands[left ? 0 : 1]; use(input);
      if (!primitives.has(input.value[0])) { unsupported(); break; }
      write(left ? 'leftNumericPrimitive' : 'rightNumericPrimitive', input.value);
      record.phase = left ? 'left-numeric-kind' : 'right-numeric-kind'; break;
    }
    case 'left-numeric-kind': case 'right-numeric-kind': {
      const left = record.phase === 'left-numeric-kind';
      const input = left ? r.leftNumericPrimitive : r.rightNumericPrimitive; use(input);
      if (input.value[0] === 'bigint') {
        write(left ? 'leftNumeric' : 'rightNumeric', input.value);
        record.phase = left ? 'right-numeric' : 'numeric-types';
      } else record.phase = left ? 'left-number' : 'right-number';
      break;
    }
    case 'left-number': case 'right-number': {
      const left = record.phase === 'left-number';
      const input = left ? r.leftNumericPrimitive : r.rightNumericPrimitive; use(input);
      write(left ? 'leftNumeric' : 'rightNumeric', toNumber(input.value));
      record.phase = left ? 'right-numeric' : 'numeric-types'; break;
    }
    case 'numeric-types':
      use(r.leftNumeric, r.rightNumeric);
      result = ['bool', r.leftNumeric.value[0] === r.rightNumeric.value[0]];
      if (!result[1]) complete({type:'throw', errorType:'TypeError',
        message:'Cannot mix BigInt and Number in arithmetic', origin:eventId});
      else record.phase = 'apply';
      break;
    case 'apply': {
      use(r.leftNumeric, r.rightNumeric);
      if (r.leftNumeric.value[0] === 'bigint') {
        const divisor = decode(r.rightNumeric.value);
        if ((record.operator === '/' || record.operator === '%') && divisor === 0n) {
          complete({type:'throw', errorType:'RangeError', message:'BigInt division by zero', origin:eventId}); break;
        }
        if (record.operator === '**' && divisor < 0n) {
          complete({type:'throw', errorType:'RangeError', message:'Negative BigInt exponent', origin:eventId}); break;
        }
      }
      // Resource exhaustion or an unexpected host error is an implementation
      // failure, never silently relabeled as a guest ECMAScript exception.
      normal(numeric(record.operator, r.leftNumeric.value, r.rightNumeric.value)); break;
    }
    case 'complete':
      if (!record.completion) throw new Error('Missing arithmetic completion');
      if (record.completion.type === 'normal') {
        use(record.completion.value); result = record.completion.value.value;
      }
      record.status = 'completed'; record.phase = 'done'; break;
    default: throw new Error('Unknown owned arithmetic phase');
  }
  return {...metadata, operands:operands.map(x => x.value), origins:operands.map(x => x.origin),
    result, causes:[{kind:'spec-operation', operationId:record.id}],
    ...(record.status === 'completed' ? {completion:record.completion} : {})};
}
