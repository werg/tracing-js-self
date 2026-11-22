// Lossless typed-value presentation shared by wire clients and derived views.
// No record grammar, execution envelope or representation version is loaded.
import {assertAlgorithmValue} from './ir.js';

const plainName=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
const reservedNames=new Set(['request','observe','write','return','throw','suspend']);
export const renderValueName=value=>plainName.test(value)&&!reservedNames.has(value)?value:JSON.stringify(value);

export function encodeAlgorithmValue(value){
  assertAlgorithmValue(value);
  switch(value[0]){
    case 'undefined':case 'null':return value[0];
    case 'bool':case 'str':return JSON.stringify(value[1]);
    case 'num':return value[1]==='+Infinity'?'Infinity':typeof value[1]==='string'?value[1]:JSON.stringify(value[1]);
    case 'bigint':return value[1]+'n';
    case 'ref':return '@'+renderValueName(value[1]);
  }
}
