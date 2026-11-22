// Shared exact shape checks for direct and composed source protocols.
import {propertyKeyValue} from '../property-keys.js';
import {PROTOCOL_INTRINSIC_PROTOTYPES_V8} from './protocol-codec-v8.js';
const copy=structuredClone;
const refuse=message=>{const error=new TypeError('Protocol source projection: '+message);
  error.category='unsupported.protocol-source';throw error;};
const ordinaryFields=new Set(['id','kind','properties','propertyVersions','shapeVersion','version','propertyOrder','prototype','accessors','dataAttributes','extensible']);
const functionFields=new Set([...ordinaryFields,'codeId','closureEnvId','async','arrow','lexicalThis','nonConstructible']);
const symbolFields=new Set(['id','kind','description','registeredKey','properties','propertyVersions','shapeVersion','version']);
export const frameFields=new Set(['id','codeId','pc','stack','envId','callerFrameId','asyncPromiseId','status','blockedOn','awaiting','operationId','pendingCoercionThrow','handlers','loops','thisValue','version','pendingProperty','completion']);
export function guardHeap(node,{extraFields=[],allowUnknown=false,allowFunctionMetadata=false}={}){
  const fields=node.kind==='symbol'?symbolFields:node.kind==='function'?functionFields:
    ['object','array'].includes(node.kind)?ordinaryFields:null;
  const allowed=fields?new Set([...fields,...extraFields]):allowUnknown?new Set(['id','kind','version',...extraFields]):null;
  if(!allowed||Object.keys(node).some(key=>!allowed.has(key)))refuse('heap kind or metadata needs a declared protocol: '+node.kind);
  if(node.nonConstructible===true&&!node.arrow&&!allowFunctionMetadata)refuse('method construction capability requires explicit function metadata');
  if(node.kind==='function'&&node.async)refuse('async function state needs the scheduler protocol');
}
export function prototype(node){const p=node.prototype;
  if(p===undefined||['Object.prototype','Array.prototype','Function.prototype'].includes(p))return 'ordinary';
  if(PROTOCOL_INTRINSIC_PROTOTYPES_V8.includes(p))return p;
  if(p===null)return null;if(typeof p==='string')return ['ref',p];
  refuse('unrecognized owned prototype representation');
}
export function descriptor(node,key){
  const accessor=Object.hasOwn(node.accessors??{},key)?node.accessors[key]:null;
  if(accessor)return {kind:'accessor',get:copy(accessor.get?.value??['undefined']),set:copy(accessor.set?.value??['undefined']),
    enumerable:accessor.enumerable,configurable:accessor.configurable};
  const value=node.properties?.[key]?.value;if(!value)return null;
  return {kind:'data',value:copy(value),...(node.kind==='array'&&key==='length'?
    {writable:true,enumerable:false,configurable:false}:{writable:true,enumerable:true,configurable:true}),...copy(node.dataAttributes?.[key]??{})};
}
export function orderedKeys(node){
  const keys=[...new Set([...(node.propertyOrder??[]),...Object.keys(node.properties??{}),...Object.keys(node.accessors??{})])]
    .filter(key=>descriptor(node,key)!==null);
  const integer=key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<4294967295;
  return [...keys.filter(integer).sort((a,b)=>Number(a)-Number(b)),
    ...keys.filter(key=>!integer(key)&&propertyKeyValue(key)[0]==='str'),...keys.filter(key=>propertyKeyValue(key)[0]==='symbol')];
}
