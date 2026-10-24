// Independent bounded witness semantics. Never runs guest source or consults
// the teacher; a false result is reported, not repaired or substituted.
import {isDeepStrictEqual} from 'node:util';
import {assertValue,validateExpression} from './format.js';

function scalar(v){
  assertValue(v);
  switch(v[0]){
    case 'undefined':return undefined;
    case 'null':return null;
    case 'bool':case 'str':return v[1];
    case 'bigint':return BigInt(v[1]);
    case 'num':return v[1]==='-0'?-0:v[1]==='NaN'?NaN:
      v[1]==='+Infinity'?Infinity:v[1]==='-Infinity'?-Infinity:v[1];
    default:throw new TypeError('Opaque reference cannot be coerced');
  }
}
function tagged(value){
  if(value===undefined)return ['undefined'];
  if(value===null)return ['null'];
  if(typeof value==='boolean')return ['bool',value];
  if(typeof value==='string')return ['str',value];
  if(typeof value==='bigint')return ['bigint',String(value)];
  if(typeof value==='number')return ['num',Object.is(value,-0)?'-0':
    Number.isNaN(value)?'NaN':value===Infinity?'+Infinity':
    value===-Infinity?'-Infinity':value];
  throw new TypeError('Unsupported witness result type');
}
export function evaluateWitnessExpression(expr,{inputs=[],locals=new Map(),
    randomState=null,readProperty=()=>{throw Error('Unbound public read');}}={}){
  const counts=validateExpression(expr);
  function visit(node) {
    if(node.op==='random'){
      if(!Number.isInteger(randomState)||randomState<0||randomState>0xffffffff)
        throw new TypeError('No committed deterministic RNG fixture seed');
      const next=(Math.imul(randomState,1664525)+1013904223)>>>0;
      return ['num',next/4294967296];
    }
    if(node.op==='literal')return node.value;
    if(node.op==='input'){
      if(node.index>=inputs.length)throw new TypeError('Missing supplied input '+node.index);
      return inputs[node.index];
    }
    if(node.op==='local'){
      if(!locals.has(node.name))throw new TypeError('Unknown witness local '+node.name);
      return locals.get(node.name);
    }
    if(node.op==='read')return readProperty(node.object,node.key);
    const left=node.op==='unary'?visit(node.arg):visit(node.left);
    const right=node.op==='binary'?visit(node.right):null;
    if(node.op==='unary'){
      const a=scalar(left);
      switch(node.operator){
        case '!':return tagged(!a);
        case '-':return tagged(-a);
        case '+':return tagged(+a);
        case '~':return tagged(~a);
        case 'void':return ['undefined'];
        case 'typeof':return tagged(typeof a);
      }
    }
    if(node.op==='binary'){
      if(left[0]==='ref'||right[0]==='ref') {
        const equal=left[0]==='ref'&&right[0]==='ref'&&left[1]===right[1];
        const both=left[0]==='ref'&&right[0]==='ref';
        if(!['===','!==','==','!='].includes(node.operator)||
           (!both&&['==','!='].includes(node.operator)&&
             !['undefined','null'].includes(left[0])&&
             !['undefined','null'].includes(right[0])))
          throw new TypeError('Unmodeled reference coercion');
        return tagged(['===','=='].includes(node.operator)?equal:!equal);
      }
      const a=scalar(left),b=scalar(right);
      switch(node.operator){
        case '+':return tagged(a+b);
        case '-':return tagged(a-b);
        case '*':return tagged(a*b);
        case '/':return tagged(a/b);
        case '%':return tagged(a%b);
        case '**':return tagged(a**b);
        case '<':return tagged(a<b);
        case '<=':return tagged(a<=b);
        case '>':return tagged(a>b);
        case '>=':return tagged(a>=b);
        case '===':return tagged(a===b);
        case '!==':return tagged(a!==b);
        case '==':return tagged(a==b);
        case '!=':return tagged(a!=b);
        case '&':return tagged(a&b);
        case '|':return tagged(a|b);
        case '^':return tagged(a^b);
        case '<<':return tagged(a<<b);
        case '>>':return tagged(a>>b);
        case '>>>':return tagged(a>>>b);
      }
    }
    throw new TypeError('Unimplemented witness operation');
  }
  return {value:visit(expr),...counts};
}
export function checkWitnessClaim(expr,claimed,environment={}){
  assertValue(claimed);
  try {
    const evaluation=evaluateWitnessExpression(expr,environment);
    return {consistent:isDeepStrictEqual(evaluation.value,claimed),
      claimed,expected:evaluation.value,operatorCount:evaluation.operatorCount,
      operandCount:evaluation.operandCount,nodeCount:evaluation.nodeCount,
      ...(isDeepStrictEqual(evaluation.value,claimed)?{}:
        {reason:'Incorrect declared primitive computation'})};
  }catch(error){
    return {consistent:false,claimed,reason:'Uncheckable witness claim: '+error.message};
  }
}
