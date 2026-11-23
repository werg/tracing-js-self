import {SHARED_TYPE_NAMES} from './owned-shared-memory.js';
import {unavailableOwnedStandardGlobal} from './conformance/test262-capabilities.js';

// These realm-provided cells are object properties even though the evaluator
// stores their immutable bindings as const. Authored lexical declarations are
// never included merely because they share the environment with these cells.
const realmProperties=new Set(['undefined','NaN','Infinity','globalThis','host','console','Date',
  'queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval','parseInt','isNaN','print',
  'Object','Array','Number','BigInt','String','Symbol','Reflect','Math','Promise','Set',
  'Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError',
  'ArrayBuffer','SharedArrayBuffer','DataView',...SHARED_TYPE_NAMES,'Atomics',
  '__traced_eval_create_module_namespace']);

export function ownedGlobalProperty(state,key,sources=[]){
  const control=state.control.a0,global=state.envs[control.globalEnvId];
  const environmentId=control.scriptSequence?.environmentId??Object.values(state.frames).find(frame=>
    frame.callerFrameId===null&&state.envs[frame.envId]?.parent===control.globalEnvId&&
    sources.some(source=>source.entry===frame.codeId))?.envId;
  const binding=state.envs[environmentId]?.bindings[key];
  if(binding&&['var','function'].includes(binding.kind))return binding.token;
  const cell=global?.bindings[key];
  if(cell&&(['var','function'].includes(cell.kind)||realmProperties.has(key)))return cell.token;
  if(unavailableOwnedStandardGlobal(key))throw new TypeError('Global object property requires owned intrinsic storage: '+key);
  return null;
}
