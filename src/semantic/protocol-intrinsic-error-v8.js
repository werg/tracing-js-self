// Shared private allocator for operation-derived intrinsic Error values. This
// helper is never a public protocol record; only a fault adapter that has
// independently derived its operation may call it.
import {assertAlgorithmFields} from './ir.js';

export const INTRINSIC_ERROR_PROFILE_V8='intrinsic-errors/1';
export const INTRINSIC_ERROR_RECORD_FIELDS=Object.freeze({
  'property.fault':Object.freeze(['kind','operation','target','key','error'])
});
export const INTRINSIC_ERROR_TYPES_V8=Object.freeze([
  'Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError'
]);
const names=new Set(INTRINSIC_ERROR_TYPES_V8),objectLike=new Set(['ref','promise','intrinsic','builtinfn','hostfn','host']);
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256;
export function allocateIntrinsicErrorV8(controller,{identity:id,errorType,message},api){
  api.require(identity(id),'intrinsic Error identity');
  api.require(names.has(errorType),'intrinsic Error type');
  api.require(typeof message==='string'&&message.length<=4096,'intrinsic Error message');
  api.allocate(controller,{name:id,objectKind:'object',length:null,code:null,captures:[],
    functionKind:null,lexicalReceiver:null,properties:[
      {key:['str','name'],value:['str',errorType]},
      {key:['str','message'],value:['str',message]}
    ]});
  const node=controller.heap.get(id);
  api.require(node?.kind==='object'&&node.properties instanceof Map&&
    node.properties.get('name')?.[1]===errorType&&node.properties.get('message')?.[1]===message,
    'intrinsic Error allocation identity');
  node.declaredError=errorType;
  return ['ref',id];
}
export function intrinsicErrorNameV8(value){
  return typeof value==='string'&&names.has(value)?value:null;
}
export function validateIntrinsicErrorNodeV8(node,api){
  if(Object.hasOwn(node,'declaredError'))
    api.require(node.kind==='object'&&names.has(node.declaredError),'intrinsic Error brand');
  return true;
}
export function validateIntrinsicErrorRecordV8(record,{value}){
  const fields=INTRINSIC_ERROR_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'intrinsic Error fault');
  if(record.operation!=='has')throw new TypeError('Intrinsic Error fault operation');
  if(!identity(record.error))throw new TypeError('Intrinsic Error fault identity');
  value(record.target);value(record.key);
  return true;
}
export function applyIntrinsicErrorRecordV8(controller,record,api){
  if(!INTRINSIC_ERROR_RECORD_FIELDS[record.kind])return false;
  api.require(record.operation==='has','unsupported intrinsic Error operation');
  api.known(controller,record.target);api.known(controller,record.key);
  api.require(controller.stack.length>0,'intrinsic Error fault requires an active invocation');
  api.require(!objectLike.has(record.target[0]),'property fault requires a primitive in-operator RHS');
  api.require(['undefined','null','bool','str','num','bigint','symbol'].includes(record.target[0]),
    'property fault target is outside the primitive value profile');
  const thrown=allocateIntrinsicErrorV8(controller,{identity:record.error,errorType:'TypeError',
    message:'Right-hand side of in is not an object'},api);
  controller.lastReturn={kind:'throw',value:api.copy(thrown)};
  return true;
}
