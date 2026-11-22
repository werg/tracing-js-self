#!/usr/bin/env node
// Independent native ESM execution for bounded, authored module graphs. The
// parent owns a process deadline; this worker never loads files or host APIs.
import vm from 'node:vm';
import {posix} from 'node:path';
import {randomBytes} from 'node:crypto';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {prepareOriginalNamespaceModules} from './module-namespace-reference-observations.mjs';

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
  let namespacePlan=null,observations=null,observerModule=null,observerSpecifier=null,observationFailure=null;
  let observerLocal=null,namespaceObjects=new Map();
  if(request.moduleNamespacePlan!==undefined){
    const nonce=randomBytes(12).toString('hex');
    observerSpecifier='__native_module_namespace_observer_'+nonce;
    observerLocal='__nativeNamespaceObserver_'+nonce;
    const prepared=prepareOriginalNamespaceModules({modules:request.modules,entryModule:request.entryModule,
      plan:request.moduleNamespacePlan,observerSpecifier,observerLocal});
    namespacePlan=prepared.plan;
    observations=[];
    const exportsByFile=new Map(namespacePlan.namespaces.map(row=>[row.file,new Set(row.exports.map(item=>item.name))]));
    const encodeScalar=value=>{
      if(value!==null&&!['undefined','boolean','string','number','bigint'].includes(typeof value))
        throw new TypeError('Original ESM namespace observation returned a non-scalar');
      const encoded=encodeNativeGraph([value]);
      if(encoded.objects.length!==0||encoded.roots.length!==1||encoded.roots[0]?.[0]==='ref')
        throw new TypeError('Original ESM namespace observation returned a non-scalar');
      return encoded.roots[0];
    };
    const requireNamespace=(file,namespace)=>{
      if(namespaceObjects.get(namespace)!==file)
        throw new TypeError('Original ESM namespace identity differs from the source plan');
    };
    const record=(kind,fields)=>{
      if(observations.length>=8192)throw new RangeError('Namespace observation row bound');
      observations.push({kind,...fields});
    };
    const nativeObject=vm.runInContext('Object',context);
    const nativeObjectKeys=vm.runInContext('Object.keys',context);
    const nativeDescriptor=vm.runInContext('Object.getOwnPropertyDescriptor',context);
    const observe=fn=>{try{return fn();}catch(error){observationFailure=error;throw error;}};
    const observer={
      cellInitialize:(cell,loweredName,value)=>observe(()=>{record('cell.initialize',{cell,loweredName,value:encodeScalar(value)});return value;}),
      cellWrite:(cell,loweredName,value)=>observe(()=>{record('cell.write',{cell,loweredName,value:encodeScalar(value)});return value;}),
      read:(file,namespace,exportName,value)=>observe(()=>{requireNamespace(file,namespace);
        record('namespace.read',{moduleFile:file,exportName,value:encodeScalar(value)});return value;}),
      dynamicRead:(file,namespace,exportName)=>observe(()=>{
        requireNamespace(file,namespace);
        if(typeof exportName!=='string'||!exportsByFile.get(file)?.has(exportName))
          throw new TypeError('Dynamic namespace key is not a planned string export');
        const value=Reflect.get(namespace,exportName);
        record('namespace.read',{moduleFile:file,exportName,value:encodeScalar(value)});return value;
      }),
      keys:(file,method,namespace)=>observe(()=>{requireNamespace(file,namespace);
        if(method!==nativeObjectKeys)throw new TypeError('Object.keys intrinsic changed');
        const names=Reflect.apply(method,nativeObject,[namespace]);
        if(!Array.isArray(names))throw new TypeError('Namespace own keys are unsupported');
        const copied=[];
        for(let index=0;index<names.length;index++){
          const name=names[index];
          if(typeof name!=='string')throw new TypeError('Namespace own keys are unsupported');
          copied.push(name);
        }
        const expected=namespacePlan.namespaces.find(row=>row.file===file)?.exports.map(item=>item.name);
        if(!expected||JSON.stringify(copied)!==JSON.stringify(expected))
          throw new TypeError('Namespace own keys differ from the source plan');
        record('namespace.keys',{moduleFile:file,names:copied});return names;}),
      descriptor:(file,method,namespace,exportName)=>observe(()=>{requireNamespace(file,namespace);
        if(method!==nativeDescriptor)throw new TypeError('Object descriptor intrinsic changed');
        const value=Reflect.apply(method,nativeObject,[namespace,exportName]);
        if(!value||!Object.hasOwn(value,'value')||value.get!==undefined||value.set!==undefined)
          throw new TypeError('Namespace accessor descriptor is unsupported');
        const descriptor={value:encodeScalar(value.value),writable:value.writable,
          enumerable:value.enumerable,configurable:value.configurable};
        record('namespace.descriptor',{moduleFile:file,exportName,value:descriptor});return value;}),
    };
    observerModule=new vm.SyntheticModule(['default'],function(){this.setExport('default',observer);},
      {context,identifier:observerSpecifier});
    for(const [id,source] of Object.entries(prepared.modules))modules.set(id,new vm.SourceTextModule(source,{context,identifier:id,
      importModuleDynamically:()=>{throw new TypeError('Dynamic import is outside this module profile');}}));
  }else{
    for(const [id,source] of Object.entries(request.modules))modules.set(id,new vm.SourceTextModule(source,{context,identifier:id,
      importModuleDynamically:()=>{throw new TypeError('Dynamic import is outside this module profile');}}));
  }
  const root=modules.get(request.entryModule);if(!root)throw new TypeError('Missing module entry');
  await deadline(root.link((specifier,owner)=>{
    if(observerModule&&specifier===observerSpecifier)return observerModule;
    if(typeof specifier!=='string'||!/^\.\.?\//.test(specifier)||/[\\?#\0]/.test(specifier))
      throw new TypeError('Only relative declared module dependencies are allowed');
    const id=posix.normalize(posix.join(posix.dirname(owner.identifier),specifier));
    if(id.startsWith('../')||!modules.has(id))throw new TypeError('Module dependency is unavailable');
    return modules.get(id);
  }));
  if(namespacePlan){
    for(const row of namespacePlan.namespaces){
      const target=modules.get(row.file);
      if(!target)throw new TypeError('Planned namespace module is unavailable');
      namespaceObjects.set(target.namespace,row.file);
      observations.push({kind:'namespace.create',moduleFile:row.file});
    }
  }
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
    if(observationFailure)throw observationFailure;
    kind='throw';value=error;
  }
  const {schema,...graph}=encodeNativeGraph([...context.__moduleInputs,value],{maxBytes:1048576});
  const response={schema:'semantic-module-reference/1',status:'passed',authority:'native-v8-module-execution',
    outcome:{kind,graph},...(namespacePlan?{namespaceObservations:{
      schema:'semantic-module-namespace-observations/1',rows:observations}}:{}),
    modules:modules.size,node:process.version};
  if(Buffer.byteLength(JSON.stringify(response),'utf8')>1048576)
    throw new RangeError('Module reference output bound');
  send(response);
}catch(error){const resourceLimited=error instanceof RangeError||error?.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'||
    error?.message==='Module reference deadline exceeded';
  send({schema:'semantic-module-reference/1',status:resourceLimited?'resource_limited':'unsupported',
    authority:'native-v8-module-execution',reason:String(error.message),node:process.version});}
