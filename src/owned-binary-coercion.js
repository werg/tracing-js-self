// Scalar conversions for the bounded binary-memory profile. Object conversion
// hooks need a resumable source protocol and must never fall through to a host
// object or be mistaken for a catchable guest TypeError.
import {decode} from './values.js';

export class BinaryProfileError extends TypeError {}
export function binaryNumber(value=['undefined']){
  if(['bigint','symbol'].includes(value[0]))throw new TypeError('Cannot convert this value to a Number');
  if(!['num','str','bool','null','undefined'].includes(value[0]))
    throw new BinaryProfileError('Binary-memory object coercion requires an explicit continuation');
  return Number(decode(value));
}
export function binaryInteger(value=['undefined']){
  const number=binaryNumber(value);
  const integer=Number.isNaN(number)||number===0?0:Math.trunc(number);
  return integer===0?0:integer;
}
export function binaryIndex(value=['undefined']){
  const index=binaryInteger(value);
  if(index<0||index>Number.MAX_SAFE_INTEGER)throw new RangeError('Invalid binary-memory index');
  return index;
}
export function binaryElement(value,kind){
  if(!kind.bigint)return binaryNumber(value);
  if(!['bigint','bool','str'].includes(value?.[0])){
    if(['ref','intrinsic','builtinfn','method'].includes(value?.[0]))
      throw new BinaryProfileError('Binary-memory object coercion requires an explicit continuation');
    throw new TypeError('Cannot convert this value to a BigInt');
  }
  return BigInt(decode(value));
}
export function binaryNumericKey(key){
  if(key==='-0')return -0;
  if(typeof key!=='string')return undefined;
  const number=Number(key);
  return String(number)===key?number:undefined;
}
export function binaryValidIndex(index,length){
  return Number.isInteger(index)&&!Object.is(index,-0)&&index>=0&&index<length;
}
