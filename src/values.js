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
export function primitiveBinary(op, left, right) {
  if (!['undefined','null','bool','str','num','bigint'].includes(left[0]) || !['undefined','null','bool','str','num','bigint'].includes(right[0])) {
    throw new TypeError('Object coercion is not implemented; refusing opaque native coercion');
  }
  const a = decode(left), b = decode(right);
  switch (op) {
    case '+': return encode(a + b);
    case '-': return encode(a - b);
    case '*': return encode(a * b);
    case '/': return encode(a / b);
    case '%': return encode(a % b);
    case '**': return encode(a ** b);
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
export function primitiveUnary(op, arg) {
  const a = decode(arg);
  switch (op) {
    case '!': return encode(!a);
    case '-': return encode(-a);
    case '+': return encode(+a);
    case 'typeof': return encode(typeof a);
    default: throw new SyntaxError(`Unsupported unary operator ${op}`);
  }
}
export function truthy(value) { return !!decode(value); }
export function token(value, origin = null) { return { value, origin }; }
export function isToken(value) { return value && Array.isArray(value.value) && Object.hasOwn(value, 'origin'); }
