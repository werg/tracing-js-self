// Canonical data describes language-neutral mathematical values. Only the
// explicitly declared JavaScript-track contract below changes the expected
// runtime type; the observed result is never coerced to make a test pass.
import {isDeepStrictEqual} from 'node:util';

export function canonicalReturnMatches(value,expected,binding,{family,property}={}){
  if(binding==null)return isDeepStrictEqual(value,expected);
  if(binding.schema!=='exercism-grains-bigint/1'||
      family!=='exercism/javascript:grains'||!['square','total'].includes(property)||
      typeof binding.decimal!=='string'||!/^(0|[1-9]\d*)$/.test(binding.decimal)||
      typeof expected!=='number'||!Number.isInteger(expected)||
      Number(binding.decimal)!==expected)
    throw new TypeError('Invalid exact Exercism JavaScript expected-value binding');
  return typeof value==='bigint'&&value.toString()===binding.decimal;
}
