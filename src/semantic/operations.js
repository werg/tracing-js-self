// Independent algorithm semantics. This module never executes source, consults
// a sealed teacher archive, or dispatches an external operation.
import {isDeepStrictEqual,types} from 'node:util';
import {assertAlgorithmValue,validateAlgorithm,validateTerm,ALGORITHM_LIMITS,
  isAlgorithmDataRecord,assertAlgorithmDataArray,assertAlgorithmId} from './ir.js';

export const BINARY_OPERATIONS=Object.freeze({
  '+':'add','-':'subtract','*':'multiply','/':'divide','%':'remainder','**':'power',
  '<':'less','<=':'less_equal','>':'greater','>=':'greater_equal',
  '===':'equal','!==':'not_equal','==':'loose_equal','!=':'loose_not_equal',
  '&':'bit_and','|':'bit_or','^':'bit_xor','<<':'shift_left','>>':'shift_right','>>>':'unsigned_shift_right'
});
export const UNARY_OPERATIONS=Object.freeze({
  '!':'not','+':'positive','-':'negate','~':'bit_not','typeof':'type_of','void':'void'
});
const descriptions={add:'add',subtract:'subtract',multiply:'multiply',divide:'divide',
  remainder:'take the remainder',power:'raise to a power',less:'compare less than',
  less_equal:'compare less than or equal',greater:'compare greater than',greater_equal:'compare greater than or equal',
  equal:'compare strict equality',not_equal:'compare strict inequality',loose_equal:'compare primitive equality',
  loose_not_equal:'compare primitive inequality',bit_and:'bitwise and',bit_or:'bitwise or',bit_xor:'bitwise exclusive or',
  shift_left:'shift left',shift_right:'shift right',unsigned_shift_right:'shift right unsigned',
  not:'negate the truth value',positive:'convert to a number',negate:'negate',bit_not:'invert bits',
  type_of:'inspect primitive type',void:'produce undefined'};
// Controlled readings describe the same ordered operands as the evaluator.
// They are presentation templates, never executable prose or proof authority.
const readings={
  add:'the sum or primitive concatenation of {0} and {1}',
  subtract:'{0} minus {1}',multiply:'the product of {0} and {1}',
  divide:'{0} divided by {1}',remainder:'the remainder of {0} divided by {1}',
  power:'{0} raised to {1}',less:'whether {0} is less than {1}',
  less_equal:'whether {0} is less than or equal to {1}',
  greater:'whether {0} is greater than {1}',greater_equal:'whether {0} is greater than or equal to {1}',
  equal:'whether {0} strictly equals {1}',not_equal:'whether {0} does not strictly equal {1}',
  loose_equal:'whether {0} equals {1} under primitive coercion',
  loose_not_equal:'whether {0} differs from {1} under primitive coercion',
  bit_and:'the bitwise AND of {0} and {1}',bit_or:'the bitwise OR of {0} and {1}',
  bit_xor:'the bitwise exclusive OR of {0} and {1}',shift_left:'{0} shifted left by {1}',
  shift_right:'{0} shifted right by {1}',unsigned_shift_right:'{0} shifted right by {1} with zero fill',
  not:'the negation of the truth value of {0}',positive:'{0} converted to a Number',
  negate:'the numeric negation of {0}',bit_not:'the bitwise inversion of {0}',
  type_of:'the primitive type of {0}',void:'undefined after evaluating {0}',
  select:'{1} when {0} is truthy, otherwise {2}; evaluate only the selected branch',
  and:'{1} only when {0} is truthy, otherwise {0}',
  or:'{1} only when {0} is falsy, otherwise {0}',
  coalesce:'{1} only when {0} is null or undefined, otherwise {0}'
};
export const OPERATION_REGISTRY=Object.freeze(Object.fromEntries([
  ...Object.entries(BINARY_OPERATIONS).map(([operator,name])=>[name,Object.freeze({arity:2,operator,
    description:descriptions[name],reading:readings[name],lazy:false})]),
  ...Object.entries(UNARY_OPERATIONS).map(([operator,name])=>[name,Object.freeze({arity:1,operator,
    description:descriptions[name],reading:readings[name],lazy:false})]),
  ['select',Object.freeze({arity:3,operator:'?:',description:'choose a value from the condition',reading:readings.select,lazy:true})],
  ['and',Object.freeze({arity:2,operator:'&&',description:'use the right value only when the left is truthy',reading:readings.and,lazy:true})],
  ['or',Object.freeze({arity:2,operator:'||',description:'use the right value only when the left is falsy',reading:readings.or,lazy:true})],
  ['coalesce',Object.freeze({arity:2,operator:'??',description:'use the fallback only for null or undefined',reading:readings.coalesce,lazy:true})]
]));

export function encodeAlgorithmScalar(value){
  if(value===undefined)return ['undefined'];if(value===null)return ['null'];
  if(typeof value==='boolean')return ['bool',value];if(typeof value==='string')return ['str',value];
  if(typeof value==='bigint')return ['bigint',String(value)];
  if(typeof value==='number')return ['num',Object.is(value,-0)?'-0':Number.isNaN(value)?'NaN':
    value===Infinity?'+Infinity':value===-Infinity?'-Infinity':value];
  throw new TypeError('Algorithm values require an explicit data identity');
}
export function decodeAlgorithmScalar(value){
  assertAlgorithmValue(value,{allowReference:false});
  if(value[0]==='undefined')return undefined;if(value[0]==='null')return null;
  if(value[0]==='bigint')return BigInt(value[1]);
  if(value[0]==='num')return value[1]==='-0'?-0:value[1]==='NaN'?NaN:
    value[1]==='+Infinity'?Infinity:value[1]==='-Infinity'?-Infinity:value[1];
  return value[1];
}
export const encodeScalar=encodeAlgorithmScalar;
export const decodeScalar=decodeAlgorithmScalar;
const truthy=value=>value[0]==='ref'||Boolean(decodeAlgorithmScalar(value));
const lookup=(map,id)=>{
  if(types.isProxy(map))throw new TypeError('Proxy algorithm state is outside the data profile');
  if(map instanceof Map)return Map.prototype.get.call(map,id);
  if(!isAlgorithmDataRecord(map))throw new TypeError('Algorithm state must be an ordinary data record or map');
  return Object.hasOwn(map,id)?map[id]:undefined;
};

/** Only descriptor-certified, ordinary public data may be projected or folded. */
export function algorithmHeapNode(heap,id){
  const node=lookup(heap,id);
  if(!isAlgorithmDataRecord(node)||!['array','object'].includes(node.kind)||
    node.accessors!==undefined&&(!isAlgorithmDataRecord(node.accessors)||Object.keys(node.accessors).length)||
    Object.hasOwn(node,'proxy')||Object.hasOwn(node,'iterator')||
    node.prototype!==undefined&&node.prototype!==null&&
      node.prototype!==(node.kind==='array'?'Array.prototype':'Object.prototype'))
    throw new TypeError('Algorithm needs an ordinary data object');
  if(node.kind==='array'&&node.prototype===null)throw new TypeError('Array prototype is outside the dense profile');
  let properties;
  if(types.isProxy(node.properties))throw new TypeError('Proxy data properties are outside the algorithm profile');
  if(node.properties instanceof Map)properties=new Map(Map.prototype.entries.call(node.properties));
  else if(Array.isArray(node.properties)){
    assertAlgorithmDataArray(node.properties,'data properties');
    properties=new Map();
    for(const prop of node.properties){
      let key,value;
      if(Array.isArray(prop)){assertAlgorithmDataArray(prop,'data property');
        if(prop.length!==2)throw new TypeError('Algorithm data property pair');[key,value]=prop;}
      else if(isAlgorithmDataRecord(prop)&&Object.hasOwn(prop,'key')&&Object.hasOwn(prop,'value')){
        key=prop.key;value=prop.value;
      }else throw new TypeError('Algorithm data property descriptor');
      if(properties.has(key))throw new TypeError('Duplicate algorithm data property');
      properties.set(key,value);
    }
  }else if(isAlgorithmDataRecord(node.properties))properties=new Map(Object.entries(node.properties)
    .map(([key,value])=>[key,Array.isArray(value)?value:
      isAlgorithmDataRecord(value)&&Object.hasOwn(value,'value')?value.value:undefined]));
  else throw new TypeError('Algorithm needs committed data properties');
  for(const [key,value] of properties){
    if(typeof key!=='string'||key==='__proto__')throw new TypeError('Algorithm data property key');
    assertAlgorithmValue(value);
  }
  return {node,properties};
}
export function validateDenseNumericArray(value,{heap=new Map()}={}){
  assertAlgorithmValue(value);
  if(value[0]!=='ref')throw new TypeError('Ordered fold requires a dense numeric array identity');
  const {node,properties}=algorithmHeapNode(heap,value[1]),length=properties.get('length');
  if(node.kind!=='array'||length?.[0]!=='num'||!Number.isSafeInteger(length[1])||
    length[1]<0||length[1]>ALGORITHM_LIMITS.foldItems)throw new TypeError('Ordered fold array bound');
  if(properties.size!==length[1]+1)throw new TypeError('Ordered fold refuses holes or extra properties');
  const items=[];
  for(let i=0;i<length[1];i++){
    const item=properties.get(String(i));
    if(item?.[0]!=='num'||!Number.isFinite(decodeAlgorithmScalar(item)))
      throw new TypeError('Ordered fold requires dense finite binary64 elements');
    items.push(item);
  }
  return items;
}
export function validateAlgorithmInputs(core,args,{heap=new Map()}={}){
  validateAlgorithm(core);
  assertAlgorithmDataArray(args,'input values');
  if(args.length!==core.inputs.length)throw new TypeError('Exact algorithm input arity required');
  const inputs=new Map();
  for(let i=0;i<args.length;i++){
    const value=args[i],input=core.inputs[i];assertAlgorithmValue(value);
    if(input.type==='scalar'&&value[0]==='ref')throw new TypeError('Algorithm scalar input required');
    if(input.type==='number'&&value[0]!=='num')throw new TypeError('Algorithm binary64 number input required');
    if(input.type==='dense-number-array')validateDenseNumericArray(value,{heap});
    if(input.type==='data'&&value[0]==='ref')algorithmHeapNode(heap,value[1]);
    inputs.set(input.id,structuredClone(value));
  }
  return inputs;
}

export function snapshotAlgorithmHeap(heap){
  if(types.isProxy(heap))throw new TypeError('Proxy algorithm heap is outside the data profile');
  const entries=heap instanceof Map?[...Map.prototype.entries.call(heap)]:
    isAlgorithmDataRecord(heap)?Object.entries(heap):null;
  if(!entries||entries.length>256)throw new TypeError('Algorithm heap shape or node budget');
  const result=new Map();
  for(const [id] of entries){
    assertAlgorithmId(id,'heap identity');
    const {node,properties}=algorithmHeapNode(heap,id);
    result.set(id,{kind:node.kind,...(node.prototype===null?{prototype:null}:{}),
      properties:new Map([...properties].map(([key,value])=>[key,structuredClone(value)]))});
  }
  for(const node of result.values())for(const value of node.properties.values())
    if(value[0]==='ref'&&!result.has(value[1]))throw new TypeError('Dangling algorithm heap reference '+value[1]);
  return result;
}

function primitiveOperation(name,values){
  if(name==='void')return ['undefined'];
  if(name==='not')return ['bool',!truthy(values[0])];
  if(values.some(value=>value[0]==='ref')){
    if(name==='type_of')return ['str','object'];
    const [left,right]=values,both=left?.[0]==='ref'&&right?.[0]==='ref';
    if(!['equal','not_equal','loose_equal','loose_not_equal'].includes(name)||
      !both&&name.startsWith('loose_')&&![left?.[0],right?.[0]].some(tag=>['null','undefined'].includes(tag)))
      throw new TypeError('Opaque reference coercion is outside the algorithm profile');
    const equal=both&&left[1]===right[1];
    return ['bool',['equal','loose_equal'].includes(name)?equal:!equal];
  }
  const [a,b]=values.map(decodeAlgorithmScalar);
  switch(name){
    case 'add':return encodeAlgorithmScalar(a+b);case 'subtract':return encodeAlgorithmScalar(a-b);
    case 'multiply':return encodeAlgorithmScalar(a*b);case 'divide':return encodeAlgorithmScalar(a/b);
    case 'remainder':return encodeAlgorithmScalar(a%b);case 'power':return encodeAlgorithmScalar(a**b);
    case 'less':return ['bool',a<b];case 'less_equal':return ['bool',a<=b];
    case 'greater':return ['bool',a>b];case 'greater_equal':return ['bool',a>=b];
    case 'equal':return ['bool',a===b];case 'not_equal':return ['bool',a!==b];
    case 'loose_equal':return ['bool',a==b];case 'loose_not_equal':return ['bool',a!=b];
    case 'bit_and':return encodeAlgorithmScalar(a&b);case 'bit_or':return encodeAlgorithmScalar(a|b);
    case 'bit_xor':return encodeAlgorithmScalar(a^b);case 'shift_left':return encodeAlgorithmScalar(a<<b);
    case 'shift_right':return encodeAlgorithmScalar(a>>b);case 'unsigned_shift_right':return encodeAlgorithmScalar(a>>>b);
    case 'positive':return encodeAlgorithmScalar(+a);case 'negate':return encodeAlgorithmScalar(-a);
    case 'bit_not':return encodeAlgorithmScalar(~a);case 'type_of':return ['str',typeof a];
    default:throw new TypeError('Unimplemented algorithm operation '+name);
  }
}

export function evaluateTerm(term,{inputs=new Map(),values=new Map(),heap=new Map()}={}){
  validateTerm(term);
  const committed=value=>{
    if(value[0]==='ref')algorithmHeapNode(heap,value[1]);
    return structuredClone(value);
  };
  function visit(node){
    if(node.op==='literal')return committed(node.value);
    if(node.op==='input'||node.op==='ref'){
      const value=lookup(node.op==='input'?inputs:values,node.id);
      if(value===undefined)throw new TypeError('Uncommitted algorithm dependency '+node.id);
      assertAlgorithmValue(value);return committed(value);
    }
    if(node.op==='project'){
      const object=visit(node.object);
      if(object[0]!=='ref')throw new TypeError('Data projection requires an object identity');
      const {properties}=algorithmHeapNode(heap,object[1]);
      return committed(properties.get(node.key)??['undefined']);
    }
    if(node.op==='fold_left'){
      const collection=visit(node.input),initial=visit(node.initial);
      const items=validateDenseNumericArray(collection,{heap});
      if(initial[0]!=='num')throw new TypeError('Ordered fold initial value must be binary64');
      let total=decodeAlgorithmScalar(initial);
      for(const value of items)total+=decodeAlgorithmScalar(value);
      return encodeAlgorithmScalar(total);
    }
    if(node.op==='select')return visit(node.args[truthy(visit(node.args[0]))?1:2]);
    if(['and','or','coalesce'].includes(node.op)){
      const left=visit(node.args[0]);
      const right=node.op==='and'?truthy(left):node.op==='or'?!truthy(left):['null','undefined'].includes(left[0]);
      return right?visit(node.args[1]):left;
    }
    // map evaluates in source order; no reassociation or commutative sorting.
    return primitiveOperation(node.op,node.args.map(visit));
  }
  return visit(term);
}

export function checkAlgorithmClaim(term,claimed,environment={}){
  assertAlgorithmValue(claimed);
  try{
    const expected=evaluateTerm(term,environment),consistent=isDeepStrictEqual(expected,claimed);
    return {consistent,claimed:structuredClone(claimed),expected,
      ...(consistent?{}:{reason:'Incorrect algorithm computation'})};
  }catch(error){return {consistent:false,claimed:structuredClone(claimed),reason:error.message};}
}

export function evaluateAlgorithm(core,args,{heap=new Map(),observations=[]}={}){
  assertAlgorithmDataArray(observations,'observations');
  const publicHeap=snapshotAlgorithmHeap(heap),inputs=validateAlgorithmInputs(core,args,{heap:publicHeap});
  const values=new Map(),requests=[],delivered=[],claims=[];
  const environment={inputs,values,heap:publicHeap};
  let completion=null,cursor=0;
  for(let index=0;index<core.steps.length;index++){
    const step=core.steps[index];
    if(step.kind==='compute'){
      const result=evaluateTerm(step.term,environment);values.set(step.id,result);
      claims.push({step:index,kind:'compute',id:step.id,result:structuredClone(result)});
    }else if(step.kind==='request'){
      const request={id:step.id,boundary:step.boundary,operation:step.operation,
        arguments:step.arguments.map(term=>evaluateTerm(term,environment))};
      requests.push(request);claims.push({step:index,kind:'request',...structuredClone(request)});
    }else if(step.kind==='observe'){
      const observation=observations[cursor];
      if(!observation){completion={kind:'suspend',requests:[step.request],live:[...values.keys()],step:index};break;}
      if(!isAlgorithmDataRecord(observation)||
        Object.keys(observation).some(key=>!['request','status','result','mode'].includes(key))||
        observation.request!==step.request||!['fulfilled','rejected','completed'].includes(observation.status)||
        observation.mode!==undefined&&observation.mode!=='observed'||
        (observation.status==='completed')===Object.hasOwn(observation,'result'))
        throw new TypeError('Algorithm observation authority or delivery order');
      const value=observation.status==='completed'?['undefined']:observation.result;
      assertAlgorithmValue(value);cursor++;delivered.push(structuredClone(observation));
      if(observation.status==='rejected'){completion={kind:'throw',value:structuredClone(value)};break;}
      values.set(step.id,structuredClone(value));
    }else if(step.kind==='write'){
      const object=evaluateTerm(step.object,environment),value=evaluateTerm(step.value,environment);
      if(object[0]!=='ref')throw new TypeError('Visible write requires an identity');
      const {node,properties}=algorithmHeapNode(publicHeap,object[1]);
      if(node.kind==='array')throw new TypeError('Array writes require a separate shape profile');
      if(step.present)properties.set(step.key,value);else properties.delete(step.key);
      node.properties=properties;
      claims.push({step:index,kind:'write',object,key:step.key,value,present:step.present});
    }else if(step.kind==='return'||step.kind==='throw'){
      completion={kind:step.kind,value:evaluateTerm(step.value,environment)};
      claims.push({step:index,...structuredClone(completion)});
    }else if(step.kind==='suspend'){
      completion={kind:'suspend',requests:[...step.requests],live:[...step.live],step:index};
      claims.push({step:index,kind:'suspend',requests:[...step.requests],live:[...step.live]});
    }
  }
  if(cursor!==observations.length)throw new TypeError('Unconsumed or future algorithm observation');
  return {completion,claims,values,requests,observations:delivered,heap:publicHeap};
}

/** Alternative explanations may omit claims; every stated claim remains true. */
export function checkAlgorithmClaims(core,args,claims,environment={}){
  if(!Array.isArray(claims))throw new TypeError('Algorithm claims must be a list');
  try{
    const evaluated=evaluateAlgorithm(core,args,environment),byStep=new Map(evaluated.claims.map(row=>[row.step,row]));
    let prior=-1;
    for(const claim of claims){
      if(!Number.isSafeInteger(claim?.step)||claim.step<=prior||!isDeepStrictEqual(claim,byStep.get(claim.step)))
        return {consistent:false,reason:'Incorrect, duplicate, or uncommitted algorithm claim',claim};
      prior=claim.step;
    }
    return {consistent:true,completion:evaluated.completion};
  }catch(error){return {consistent:false,reason:error.message};}
}
