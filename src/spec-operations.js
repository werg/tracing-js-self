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
    phase:operator === '+' ? 'left-primitive' : 'left-numeric', status:'running', coercion:null, version:0};
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

// Bounded ordinary [[Get]] with explicitly owned data-property prototype
// traversal. References never escape into host Reflect or JavaScript getters.
// A null return is a fail-closed exotic/accessor/intrinsic operation.
export function objectPrototype(obj) {
  return Object.hasOwn(obj,'prototype')?obj.prototype:
    obj.kind==='array'?'Array.prototype':'Object.prototype';
}
export function ordinaryGet(heap, receiver, name) {
  const original=receiver[0]==='ref'?heap[receiver[1]]:null;
  if(!original||!['object','array'].includes(original.kind))return null;
  const observation=value=>({
    kind:'property',objectId:original.id,key:name,
    version:Object.hasOwn(original.propertyVersions??{},name)?original.propertyVersions[name]:0,shapeVersion:original.shapeVersion??0,
    present:Object.hasOwn(original.properties,name),
    value:value.value,supplyingEvent:value.origin??null
  });
  let current=original;
  const visited=new Set();
  for(;;){
    if(visited.has(current.id))return null;
    visited.add(current.id);
    // Accessor [[Get]] needs a guest callback continuation, never silently
    // skip a getter and fall back to an inherited/default conversion method.
    if(Object.hasOwn(current.accessors??{},name))return null;
    if(Object.hasOwn(current.properties,name)){
      const method=current.properties[name];
      if(!method||!Array.isArray(method.value))return null;
      return {method,observation:observation(method)};
    }
    const proto=objectPrototype(current);
    if(proto===null){
      const method=token(['undefined']);
      return {method,observation:observation(method)};
    }
    if(proto==='Array.prototype'){
      if(['push','pop','includes'].includes(name)){
        const method=token(['builtinfn','Array.prototype.'+name]);
        return {method,observation:observation(method)};
      }
      if(name==='toString'){
        const method=token(['builtinfn','Array.toString']);
        return {method,observation:observation(method)};
      }
      if(name in Array.prototype && name!=='valueOf')return null;
      const method=name==='valueOf'?token(['builtinfn','Object.valueOf']):token(['undefined']);
      return {method,observation:observation(method)};
    }
    if(proto==='Object.prototype'){
      if(name==='valueOf'||name==='toString'){
        const method=token(['builtinfn',name==='valueOf'?'Object.valueOf':'Object.toString']);
        return {method,observation:observation(method)};
      }
      if(name in Object.prototype)return null;
      const method=token(['undefined']);
      return {method,observation:observation(method)};
    }
    current=heap[proto];
    if(!current||!['object','array'].includes(current.kind))return null;
  }
}
export function ordinaryBuiltin(heap, receiver, name) {
  const obj=receiver[0]==='ref'?heap[receiver[1]]:null;
  if(!obj||!['object','array'].includes(obj.kind))return null;
  if(name==='Object.valueOf')return receiver;
  if(name==='Object.toString')return ['str',obj.kind==='array'?'[object Array]':'[object Object]'];
  if(name==='Array.toString') {
    if(obj.kind!=='array'||Object.hasOwn(obj.properties,'join'))return null;
    const length=decode(obj.properties.length.value);
    // The implemented Array::join leaf covers dense primitive data arrays.
    // Accessors, sparse/inherited indices and nested objects fail closed.
    if(!Number.isSafeInteger(length)||length>10000)return null;
    const parts=[];
    for(let i=0;i<length;i++){
      const property=obj.properties[String(i)];
      if(!property)return null;
      const value=property.value;
      if(!primitives.has(value[0]))return null;
      parts.push(['null','undefined'].includes(value[0])?'':String(decode(value)));
    }
    return ['str',parts.join(',')];
  }
  return null;
}
/** Mutate only a plain owned operation record, completing exactly one phase. */
export function advanceArithmetic(record, eventId, {heap=null,invoke=null,takeReturn=null,abrupt=null}={}) {
  if (record.status !== 'running') throw new Error('Arithmetic operation already completed');
  const metadata = specStep(record);
  const r = record.registers;
  let operands = [], result = null, reads=[];
  const use = (...values) => { operands = values; };
  const write = (name, value) => { result = value; r[name] = token(value, eventId); };
  const complete = completion => { record.completion = completion; record.phase = 'complete'; };
  const normal = value => {
    write('value', value);
    complete({type:'normal', value:token(value, eventId)});
  };
  const unsupported = (feature='ToPrimitive(Object)') => complete({type:'unsupported',feature,
    message:'Guest conversion is outside the bounded owned object profile',origin:eventId});
  const startCoercion=(input,left,register,resume)=>{
    if(input.value[0]!=='ref'||!heap?.[input.value[1]]||
       !['array','object'].includes(heap[input.value[1]].kind)) {
      unsupported();return;
    }
    record.coercion={side:left?'left':'right',input,register,resume,index:0,
      method:null,waitingFrameId:null};
    record.phase='coercion-get';
  };
  const finishCoercion=value=>{
    const c=record.coercion;
    if(primitives.has(value[0])) {
      write(c.register,value);
      record.phase=c.resume;
      record.coercion=null;
    } else {
      c.index++;
      c.method=null;c.waitingFrameId=null;
      if(c.index===2)complete({type:'throw',errorType:'TypeError',
        message:'Cannot convert object to primitive value',origin:eventId});
      else record.phase='coercion-get';
    }
  };

  switch (record.phase) {
    case 'left-primitive': case 'right-primitive': {
      const left = record.phase === 'left-primitive';
      const input = record.operands[left ? 0 : 1]; use(input);
      if (!primitives.has(input.value[0])) {
        startCoercion(input,left,left?'leftPrimitive':'rightPrimitive',left?'right-primitive':'select');break;
      }
      write(left ? 'leftPrimitive' : 'rightPrimitive', input.value);
      record.phase = left ? 'right-primitive' : 'select'; break;
    }
    case 'coercion-get': {
      const c=record.coercion;use(c.input);
      const name=c.index===0?'valueOf':'toString';
      const obtained=ordinaryGet(heap,c.input.value,name);
      if(!obtained){unsupported();break;}
      c.method=obtained.method;
      reads=[obtained.observation];
      record.phase='coercion-call';
      break;
    }
    case 'coercion-call': {
      const c=record.coercion;use(c.method,c.input);
      const v=c.method.value;
      if(v[0]==='ref'&&heap[v[1]]?.kind==='function'){
        // An async valueOf returns a Promise object even before its first
        // suspension. Its asynchronous guest reaction behavior is not part
        // of this ordinary coercion subset.
        if(heap[v[1]].async){unsupported('AsyncToPrimitive');break;}
        if(!invoke)throw new Error('Missing owned conversion call dispatcher');
        c.waitingFrameId=invoke(v,c.input.value);
        record.phase='coercion-return';
      }else if(v[0]==='builtinfn' && ['Object.valueOf','Object.toString','Array.toString'].includes(v[1])){
        const value=ordinaryBuiltin(heap,c.input.value,v[1]);
        if(value===null){unsupported('ArrayToString(complex)');break;}
        finishCoercion(value);
      }else{
        // A non-callable property is skipped, as in OrdinaryToPrimitive.
        finishCoercion(c.input.value);
      }
      break;
    }
    case 'coercion-return': {
      const c=record.coercion;
      if(abrupt){
        if(abrupt.type!=='throw')throw new Error('Invalid conversion call abrupt completion');
        use(abrupt.value??c.input);
        complete(abrupt);
      }else{
        if(!takeReturn)throw new Error('Missing owned conversion return');
        const returned=takeReturn(c.waitingFrameId);
        use(returned);
        finishCoercion(returned.value);
      }
      break;
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
      if (!primitives.has(input.value[0])) {
        startCoercion(input,left,left?'leftNumericPrimitive':'rightNumericPrimitive',left?'left-numeric-kind':'right-numeric-kind');break;
      }
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
    result, reads, causes:[{kind:'spec-operation', operationId:record.id}],
    ...(record.status === 'completed' ? {completion:record.completion} : {})};
}
