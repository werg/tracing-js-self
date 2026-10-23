// Canonical scalar and identity values. No JSON.stringify of guest objects or accessors.
export const U = Object.freeze(['undefined']);
export function encode(value) {
  if (value === undefined) return U;
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['bool', value];
  if (typeof value === 'string') return ['str', value];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return ['num', '-0'];
    if (Number.isNaN(value)) return ['num', 'NaN'];
    if (value === Infinity) return ['num', '+Infinity'];
    if (value === -Infinity) return ['num', '-Infinity'];
    return ['num', value];
  }
  throw new TypeError('Only primitive values may be encoded without a guest identity');
}
export function decode(value) {
  switch (value?.[0]) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'bool': case 'str': return value[1];
    case 'bigint': return BigInt(value[1]);
    case 'num': return value[1] === '-0' ? -0 : value[1] === 'NaN' ? NaN : value[1] === '+Infinity' ? Infinity : value[1] === '-Infinity' ? -Infinity : value[1];
    default: throw new TypeError(`Cannot decode guest identity as a primitive: ${value?.[0]}`);
  }
}
const primitiveKinds = new Set(['undefined','null','bool','str','num','bigint']);
const referenceKinds = new Set(['ref','promise','host','intrinsic','hostfn','builtinfn']);
export function isReference(value) {
  return Array.isArray(value) && referenceKinds.has(value[0]);
}
export function primitiveBinary(op, left, right) {
  if (isReference(left) || isReference(right)) {
    if (['===','!==','==','!='].includes(op)) {
      // The bounded profile has only identity comparisons for references.
      // Loose equality with non-null primitives would invoke unowned coercion.
      const both = isReference(left) && isReference(right);
      const nullable = ['null','undefined'].includes(left[0]) ||
        ['null','undefined'].includes(right[0]);
      if (!both && !nullable && ['==','!='].includes(op))
        throw new TypeError('Reference coercion is outside the bounded profile');
      const same = both && left[0] === right[0] && left[1] === right[1];
      return encode(op === '===' || op === '==' ? same : !same);
    }
    throw new TypeError('Object coercion is not implemented; refusing opaque native coercion');
  }
  if (!primitiveKinds.has(left[0]) || !primitiveKinds.has(right[0]))
    throw new TypeError('Unsupported guest operand');
  const a = decode(left), b = decode(right);
  switch (op) {
    case '+': return encode(a + b);
    case '-': return encode(a - b);
    case '*': return encode(a * b);
    case '/': return encode(a / b);
    case '%': return encode(a % b);
    case '**': return encode(a ** b);
    case '&': return encode(a & b);
    case '|': return encode(a | b);
    case '^': return encode(a ^ b);
    case '<<': return encode(a << b);
    case '>>': return encode(a >> b);
    case '>>>': return encode(a >>> b);
    case '<': return encode(a < b);
    case '<=': return encode(a <= b);
    case '>': return encode(a > b);
    case '>=': return encode(a >= b);
    case '===': return encode(a === b);
    case '!==': return encode(a !== b);
    case '==': return encode(a == b); // only primitives; no guest-object coercion
    case '!=': return encode(a != b);
    default: throw new SyntaxError(`Unsupported binary operator ${op}`);
  }
}
export function primitiveUnary(op, arg, heap = null) {
  if(op === 'void')return U;
  if (isReference(arg)) {
    if (op === 'typeof') {
      const isFunction = arg[0] === 'hostfn' || arg[0] === 'builtinfn' ||
        (arg[0] === 'ref' && heap?.[arg[1]]?.kind === 'function');
      return encode(isFunction ? 'function' : 'object');
    }
    if (op === '!') return encode(false);
    throw new TypeError('Reference coercion is outside the bounded profile');
  }
  const a = decode(arg);
  switch (op) {
    case '!': return encode(!a);
    case '-': return encode(-a);
    case '+': return encode(+a);
    case '~': return encode(~a);
    case 'typeof': return encode(typeof a);
    default: throw new SyntaxError(`Unsupported unary operator ${op}`);
  }
}
export function truthy(value) {
  if (isReference(value)) return true;
  return !!decode(value);
}
export function token(value, origin = null) { return { value, origin }; }
export function isToken(value) { return value && Array.isArray(value.value) && Object.hasOwn(value, 'origin'); }
