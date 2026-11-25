// Standard Error instance/prototype storage. Engine-specific stack formatting
// remains outside this data model and cannot be read as an ordinary field.
import {token} from './values.js';
export const ERROR_CONSTRUCTORS=Object.freeze(['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError']);
export const ERROR_PROTOTYPES=Object.freeze(ERROR_CONSTRUCTORS.map(name=>name+'.prototype'));
export function errorPrototypeRecord(name){
  if(!ERROR_PROTOTYPES.includes(name))throw new TypeError('Unknown Error intrinsic prototype');
  const type=name.slice(0,-10),properties={constructor:token(['intrinsic',type]),name:token(['str',type]),message:token(['str',''])};
  if(type==='Error')properties.toString=token(['builtinfn','Error.prototype.toString']);
  return {id:name,kind:'object',prototype:type==='Error'?'Object.prototype':'Error.prototype',properties,
    propertyVersions:Object.fromEntries(Object.keys(properties).map(key=>[key,0])),
    dataAttributes:Object.fromEntries(Object.keys(properties).map(key=>[key,{writable:true,enumerable:false,configurable:true}])),
    propertyOrder:Object.keys(properties),shapeVersion:0,extensible:true,version:0};
}
export function ensureErrorPrototype(state,name){return state.heap[name]??=errorPrototypeRecord(name);}
export function ownedIntrinsicError(id,errorType,message,origin,{omitMessage=false}={}){
  if(!ERROR_CONSTRUCTORS.includes(errorType))throw new TypeError('Unknown Error intrinsic');
  return {id,kind:'object',declaredError:errorType,prototype:errorType+'.prototype',
    properties:omitMessage?{}:{message:token(['str',message],origin)},
    propertyVersions:omitMessage?{}:{message:1},
    dataAttributes:omitMessage?{}:{message:{writable:true,enumerable:false,configurable:true}},
    propertyOrder:omitMessage?[]:['message'],shapeVersion:omitMessage?0:1,version:0};
}
