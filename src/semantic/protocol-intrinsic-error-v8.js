// Shared private allocator for operation-derived intrinsic Error values. This
// helper is never a public protocol record; only a fault adapter that has
// independently derived its operation may call it.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {invalidInMessage} from '../intrinsic-error-diagnostics.js';
import {initializePromiseObjectsV8,promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';

export const INTRINSIC_ERROR_PROFILE_V8='intrinsic-errors/1';
export const INTRINSIC_ERROR_STATE_V8_SCHEMA='semantic-intrinsic-error-state/1';
export const INTRINSIC_ERROR_STATE_V8_FIELDS=Object.freeze(['schema','errors']);
export const INTRINSIC_ERROR_STATE_V8_ROW_FIELDS=Object.freeze(['id','errorType']);
export const INTRINSIC_ERROR_RECORD_FIELDS=Object.freeze({
  'property.fault':Object.freeze(['kind','operation','target','key','error'])
});
export const INTRINSIC_ERROR_TYPES_V8=Object.freeze([
  'Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError'
]);
const names=new Set(INTRINSIC_ERROR_TYPES_V8),objectLike=new Set(['ref','promise','intrinsic','builtinfn','hostfn','host']);
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const maxErrors=4096;

function intrinsicErrorRowsV8(controller,snapshot,api){
  const branded=[...controller.heap.entries()].filter(([,node])=>node&&Object.hasOwn(node,'declaredError'));
  for(const [,node] of branded)validateIntrinsicErrorNodeV8(node,api);
  if(snapshot===null){
    api.require(branded.length===0,'intrinsic Error registry is missing branded identities');
    return [];
  }
  assertAlgorithmFields(snapshot,INTRINSIC_ERROR_STATE_V8_FIELDS,'intrinsic Error state');
  api.require(snapshot.schema===INTRINSIC_ERROR_STATE_V8_SCHEMA,'intrinsic Error state schema');
  assertAlgorithmDataArray(snapshot.errors,'intrinsic Error rows');
  api.require(snapshot.errors.length<=maxErrors,'intrinsic Error count bound');
  const seen=new Set();
  for(const row of snapshot.errors){
    assertAlgorithmFields(row,INTRINSIC_ERROR_STATE_V8_ROW_FIELDS,'intrinsic Error row');
    api.require(identity(row.id),'intrinsic Error identity');
    api.require(names.has(row.errorType),'intrinsic Error type');
    api.require(!seen.has(row.id),'duplicate intrinsic Error identity');
    seen.add(row.id);
    const node=controller.heap.get(row.id);
    api.require(node?.kind==='object'&&node.declaredError===row.errorType,
      'intrinsic Error registry differs from its heap identity');
  }
  api.require(branded.length===snapshot.errors.length,'intrinsic Error registry does not cover every branded object');
  return snapshot.errors;
}

export function allocateIntrinsicErrorV8(controller,{identity:id,errorType,message},api){
  api.require(identity(id),'intrinsic Error identity');
  api.require(names.has(errorType),'intrinsic Error type');
  api.require(typeof message==='string'&&message.length<=4096,'intrinsic Error message');
  const registry=intrinsicErrorRowsV8(controller,controller.protocol?.intrinsicErrors,api);
  api.require(registry.length<maxErrors,'intrinsic Error count bound');
  if(!controller.protocol?.promiseObjects?.initialized)initializePromiseObjectsV8(controller,api);
  api.allocate(controller,{name:id,objectKind:'object',length:null,code:null,captures:[],
    functionKind:null,lexicalReceiver:null,properties:[
      {key:['str','message'],value:['str',message]}
    ]});
  const node=controller.heap.get(id);
  api.require(node?.kind==='object'&&node.properties instanceof Map&&
    node.properties.get('message')?.[1]===message,
    'intrinsic Error allocation identity');
  node.declaredError=errorType;node.prototype=['ref',promiseIntrinsicIdV8(errorType+'.prototype')];
  api.installDescriptor(node,['str','message'],{kind:'data',value:['str',message],writable:true,enumerable:false,configurable:true});
  controller.protocol.intrinsicErrors={schema:INTRINSIC_ERROR_STATE_V8_SCHEMA,
    errors:[...registry,{id,errorType}]};
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
    message:invalidInMessage(record.key,record.target,{node:id=>controller.heap.get(id),
      symbolDescription:id=>controller.protocol.symbols.find(row=>row.id===id)?.description})},api);
  controller.lastReturn={kind:'throw',value:api.copy(thrown)};
  return true;
}

export function restoreIntrinsicErrorStateV8(controller,snapshot,api){
  intrinsicErrorRowsV8(controller,snapshot,api);
  return {valid:true};
}
