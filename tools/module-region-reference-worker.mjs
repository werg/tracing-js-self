#!/usr/bin/env node
// Independent native ESM execution for bounded, authored module graphs. The
// parent owns a process deadline; this worker never loads files or host APIs.
import vm from 'node:vm';
import {posix} from 'node:path';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

let input='';for await(const chunk of process.stdin){input+=chunk;
  if(Buffer.byteLength(input)>1048576)throw new RangeError('Module reference input bound');}
const request=JSON.parse(input),timeoutMs=request.timeoutMs??1000;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const deadline=async promise=>{
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('Module reference deadline exceeded')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
};
try{
  if(typeof vm.SourceTextModule!=='function')throw new TypeError('Native ESM support unavailable');
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  context.__graphJSON=JSON.stringify(request.inputGraph);
  // Build ordinary values inside the guest realm, preserving holes and aliases.
  vm.runInContext('globalThis.__moduleInputs=(()=>{const g=JSON.parse(__graphJSON),table=new Map();'+
    'for(const n of g.objects)table.set(n.id,n.kind==="array"?[]:n.prototype===null?Object.create(null):{});'+
    'function v(t){switch(t[0]){case "ref":return table.get(t[1]);case "undefined":return undefined;'+
    'case "null":return null;case "bool":case "str":return t[1];case "bigint":return BigInt(t[1]);'+
    'case "num":return t[1]==="-0"?-0:t[1]==="NaN"?NaN:t[1]==="+Infinity"?Infinity:t[1]==="-Infinity"?-Infinity:t[1];'+
    'default:throw new TypeError("Undeclared input tag");}}'+
    'for(const n of g.objects)for(const p of n.properties)Object.defineProperty(table.get(n.id),p.key,'+
    '{value:v(p.value),writable:true,enumerable:p.key!=="length"||n.kind!=="array",configurable:p.key!=="length"||n.kind!=="array"});'+
    'return g.roots.map(v);})();delete globalThis.__graphJSON;',context,{timeout:timeoutMs});
  const modules=new Map();
  for(const [id,source] of Object.entries(request.modules))modules.set(id,new vm.SourceTextModule(source,{context,identifier:id,
    importModuleDynamically:()=>{throw new TypeError('Dynamic import is outside this module profile');}}));
  const root=modules.get(request.entryModule);if(!root)throw new TypeError('Missing module entry');
  await deadline(root.link((specifier,owner)=>{
    if(typeof specifier!=='string'||!/^\.\.?\//.test(specifier)||/[\\?#\0]/.test(specifier))
      throw new TypeError('Only relative declared module dependencies are allowed');
    const id=posix.normalize(posix.join(posix.dirname(owner.identifier),specifier));
    if(id.startsWith('../')||!modules.has(id))throw new TypeError('Module dependency is unavailable');
    return modules.get(id);
  }));
  let kind='return',value;
  try{
    await deadline(root.evaluate({timeout:timeoutMs}));
    const inputs=context.__moduleInputs[0],calls=request.calls??[{exportName:request.exportName}];
    const results=[];
    for(const [index,call] of calls.entries()){
      if(!Object.hasOwn(root.namespace,call.exportName))throw new TypeError('Missing entry export');
      context.__entryValue=root.namespace[call.exportName];
      context.__entryArgs=request.calls?inputs.calls[index].args:inputs.args;
      results.push(await deadline(vm.runInContext('typeof __entryValue==="function"?Reflect.apply(__entryValue,undefined,__entryArgs):__entryValue',
        context,{timeout:timeoutMs})));
    }
    value=request.calls?results:results[0];
  }catch(error){
    // A process/VM deadline is a resource disposition, never a guest throw.
    if(error?.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'&&error instanceof Error||
      error instanceof Error&&error.message==='Module reference deadline exceeded')throw error;
    kind='throw';value=error;
  }
  const {schema,...graph}=encodeNativeGraph([...context.__moduleInputs,value],{maxBytes:1048576});
  send({schema:'semantic-module-reference/1',status:'passed',authority:'native-v8-module-execution',
    outcome:{kind,graph},modules:modules.size,node:process.version});
}catch(error){send({schema:'semantic-module-reference/1',status:/deadline|timeout|limit|bound/i.test(error.message)?'resource_limited':'unsupported',
  authority:'native-v8-module-execution',reason:String(error.message),node:process.version});}
