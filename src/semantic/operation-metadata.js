// Presentation and qualification metadata only. Evaluators remain independently
// implemented; adding metadata never admits a new source or execution profile.
import {OPERATION_REGISTRY} from './operations.js';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const pureEffects={reads:[],writes:[],guestCalls:false,allocation:false,identityEscape:false,
  suspension:false,externalRequests:false,retainedCallbacks:false,cleanup:false};
const conversion=new Set(['positive','negate','bit_not','subtract','multiply','divide','remainder',
  'power','bit_and','bit_or','bit_xor','shift_left','shift_right','unsigned_shift_right']);
export const OPERATION_METADATA_VERSION='semantic-operation-metadata/1';
export const OPERATION_METADATA=freeze(Object.fromEntries([
  ...Object.entries(OPERATION_REGISTRY).map(([name,operation])=>[name,{
    family:operation.lazy?'selection':'primitive-transformation',
    domain:name==='add'?'JavaScript primitives: Number/BigInt addition or string concatenation':
      conversion.has(name)?'JavaScript primitive numeric conversion; mixed numeric types may throw':
      'JavaScript primitive values under the declared operation profile',
    evaluationOrder:'left-to-right',
    laziness:operation.lazy?{conditionOperand:0,evaluatedOperands:'predicate-dependent'}:null,
    effects:{...pureEffects,mayThrow:conversion.has(name)||name==='add'},
    completion:conversion.has(name)||name==='add'?['normal','throw']:['normal'],
    notation:{canonical:'functional',formal:operation.operator,hybrid:operation.operator,
      prose:operation.reading},
    consumer:{javascript:'implemented',native:'requires-exact-contract-admission'},
    qualification:'Input-domain, source, claim and native checks are independent gates'
  }]),
  ['project',{family:'binding-projection',domain:'descriptor-certified ordinary own data property',
    evaluationOrder:'object then checked own key',laziness:null,
    effects:{...pureEffects,reads:['object:key'],mayThrow:false},completion:['normal'],
    notation:{canonical:'project(object, key)',formal:'own_data(object, key)',
      hybrid:'read own data field',prose:'Read the own data field, or undefined if absent.'},
    consumer:{javascript:'implemented',native:'requires-exact-contract-admission'},
    qualification:'Accessors, proxies and inherited behavior are not silently projected'}],
  ['fold_left',{family:'ordered-traversal',domain:'profile-bound ordered array traversal and step',
    evaluationOrder:'ascending indices; accumulator before item',laziness:null,
    effects:{...pureEffects,reads:['input:elements'],mayThrow:false},completion:['normal'],
    notation:{canonical:'fold_left(input, initial, step)',formal:'fold_left(input, initial, step)',
      hybrid:'fold in order',prose:'Accumulate in order from the explicit initial state.'},
    consumer:{javascript:'implemented',native:'requires-exact-contract-admission'},
    qualification:'Traversal, holes, hooks, callback behavior and Number rounding belong to the profile'}]
]));
export function operationMetadata(name){
  const result=OPERATION_METADATA[name];
  if(!result)throw new TypeError('No qualified operation metadata for '+name);
  return result;
}
