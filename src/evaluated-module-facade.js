// Host-callable wrappers for explicitly named owned ESM exports.
// Every call is an owned, replay-checked invocation; these wrappers themselves
// are NOT guest-callable native callbacks or natlang's callable-folder realm.
import {types} from 'node:util';
import {createBoundedRetainedModuleSession} from './evaluated-module-session.js';
import {linkEvaluatedModules} from './evaluated-modules.js';

function checkedExportNames(values){
  if(!Array.isArray(values)||types.isProxy(values)||
     Object.getPrototypeOf(values)!==Array.prototype||
     values.length<1||values.length>32||
     Reflect.ownKeys(values).length!==values.length+1)
    throw new TypeError('Require 1..32 dense own export names');
  const names=[],seen=new Set();
  for(let i=0;i<values.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(values,String(i));
    if(!descriptor||!Object.hasOwn(descriptor,'value')||
       typeof descriptor.value!=='string'||
       !/^[$A-Za-z_][$\w]*$/.test(descriptor.value)||
       ['__proto__','prototype','constructor','then'].includes(descriptor.value)||
       seen.has(descriptor.value))
      throw new TypeError('Invalid or duplicate owned module export name');
    names.push(descriptor.value);seen.add(descriptor.value);
  }
  return names;
}

/**
 * A synchronous, deterministic bounded module interface for a JavaScript
 * embedding. It is not the native CJS natlang module loader, and its function
 * wrappers must never be fed back into the owned guest heap.
 */
export function createBoundedModuleFacade({
  modules,entryModule,exportNames,maxSteps=100000,onTrace=null
}={}){
  const names=checkedExportNames(exportNames);
  const session=createBoundedRetainedModuleSession({
    modules,entryModule,maxSteps,onTrace
  });
  // Link and compile *every* advertised entry before exposing any function.
  // This prevents an unsupported package/native helper from escaping merely
  // because its host wrapper has not been invoked yet.
  try{
    for(const exportName of names)
      linkEvaluatedModules({modules:session.modules,entryModule,exportName,args:[]});
  }catch(error){session.close();throw error;}
  const exports=Object.create(null);
  for(const name of names)
    Object.defineProperty(exports,name,{
      enumerable:true,writable:false,configurable:false,
      value:(...args)=>session.invokeSync(name,args).result
    });
  return Object.freeze({
    exports:Object.freeze(exports),
    session,
    close:()=>session.close()
  });
}
