// Opt-in native-V8 module *diagnostics* for trusted, pinned Test262 sources.
// Node's experimental VM modules require --experimental-vm-modules on Node 20-24.
// Native V8 is not the owned interpreter; node:vm is NOT a security sandbox.
import vm,{createContext,runInContext,Script} from 'node:vm';
const {SourceTextModule}=vm;
import {posix} from 'node:path';

const response=(status,reason,extra={})=>({schema:'test262-native-module-reference/1',
  authority:'native-v8-diagnostic-only',verifiedOwned:false,admitted:false,
  status,reason,...extra});
const safeInclude=name=>typeof name==='string'&&
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(name)&&!name.includes('..');
const validPath=name=>typeof name==='string'&&name.startsWith('test/')&&
  !name.includes('\\')&&!name.includes('\0')&&!name.includes('//')&&
  posix.normalize(name)===name&&!name.split('/').includes('..')&&
  name.endsWith('.js');
const errorName=error=>String(error?.name??typeof error).slice(0,100);
class UnsupportedModule extends Error {}
const resolveImport=(specifier,from)=>{
  if(typeof specifier!=='string'||!/^\.\.?\//.test(specifier)||
     specifier.includes('\\')||/[?#\0]/.test(specifier))
    throw new UnsupportedModule('Bare, absolute, URL and dynamic imports are unavailable');
  const target=posix.normalize(posix.join(posix.dirname(from),specifier));
  if(!validPath(target))throw new UnsupportedModule('Module import escapes pinned test root');
  return target;
};
const withDeadline=async(promise,timeoutMs)=>{
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new UnsupportedModule('Module evaluation deadline exceeded')),timeoutMs);
  })]);}finally{clearTimeout(timer);}
};

/**
 * Execute a single Test262 module with the REAL pinned harness and a caller-
 * provided pinned module resolver. The resolver receives normalized paths
 * under test/ only and returns exact source bytes or null for missing files.
 * Module and harness sources must come from a trusted, clean checkout.
 * No module graph, source operation or result is ever training-admitted here.
 */
export async function executeTest262ModuleReference({source,metadata,
  harnessSources={},filename='test/module.js',loadModuleSource=async()=>null,
  timeoutMs=300}={}){
  if(typeof source!=='string'||!metadata||!validPath(filename)||
     typeof loadModuleSource!=='function'||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>1000)
    throw new TypeError('Invalid Test262 native module reference arguments');
  const {flags,includes,features,negative}=metadata;
  if(metadata.metadataStatus!=='parsed'||!Array.isArray(flags)||
     !Array.isArray(includes)||!Array.isArray(features))
    return response('unsupported','Unparsed or incomplete Test262 metadata');
  if(!flags.includes('module')||flags.some(f=>f!=='module')||
     negative&&(!['parse','early','resolution','runtime'].includes(negative.phase)||
       !/^[A-Za-z_$][\w$]*$/.test(negative.type)))
    return response('unsupported','Module execution flags or negative metadata unsupported');
  if(negative?.phase==='early')
    return response('unsupported','Native module API cannot distinguish early errors from parse errors');
  if(typeof SourceTextModule!=='function')
    return response('unsupported','Node --experimental-vm-modules is required');
  const harness=[...new Set(['sta.js','assert.js',...includes])];
  if(harness.some(x=>!safeInclude(x)||typeof harnessSources[x]!=='string'))
    return response('unsupported','Missing or unsafe pinned harness include');

  // Module jobs MUST use a context without microtaskMode:'afterEvaluate':
  // that option can strand SourceTextModule.evaluate() promises on Node 22.
  const context=createContext(Object.create(null),{
    codeGeneration:{strings:false,wasm:false}
  });
  const constructorFor=type=>{
    const ctor=runInContext('globalThis['+JSON.stringify(type)+']',context,
      {timeout:timeoutMs});
    return typeof ctor==='function'?ctor:null;
  };
  const negativeConstructor=negative?constructorFor(negative.type):null;
  if(negative&&!negativeConstructor)
    return response('unsupported','Declared negative error constructor unavailable');
  const matches=(error)=>error!==null&&
    (typeof error==='object'||typeof error==='function')&&
    error instanceof negativeConstructor;
  const modules=new Map();
  let dynamicImportObserved=false;
  const newModule=(code,id)=>new SourceTextModule(code,{context,identifier:id,
    importModuleDynamically:()=>{
      dynamicImportObserved=true;
      throw new UnsupportedModule('Dynamic imports are not modeled');
    }
  });
  let root;
  try{root=newModule(source,filename);modules.set(filename,root);}
  catch(error){
    if(negative?.phase==='parse'&&matches(error))
      return response('passed','Expected module parse-time error observed',
        {phase:'parse',errorType:negative.type});
    return response('failed','Unexpected module parse-time '+errorName(error),
      {phase:'parse',errorType:errorName(error)});
  }
  if(negative?.phase==='parse')
    return response('failed','Expected a module parse-time error but parsing succeeded',
      {phase:'parse'});
  try{
    for(const name of harness){
      new Script(harnessSources[name],{filename:'harness/'+name})
        .runInContext(context,{timeout:timeoutMs,displayErrors:false});
    }
  }catch(error){
    return response('unsupported','Harness failed to initialize: '+errorName(error),
      {phase:'harness'});
  }
  try{
    await withDeadline(root.link(async(specifier,referencing)=>{
      const id=resolveImport(specifier,referencing.identifier);
      if(modules.has(id))return modules.get(id);
      let code;
      try{code=await loadModuleSource(id);}
      catch{throw new UnsupportedModule('Pinned module fixture could not be read: '+id);}
      if(typeof code!=='string')
        throw new UnsupportedModule('Pinned module fixture unavailable: '+id);
      // Imported-source parse errors cannot prove a main-file negative phase.
      let module;
      try{module=newModule(code,id);}
      catch{throw new UnsupportedModule('Pinned module fixture failed to parse: '+id);}
      modules.set(id,module);
      return module;
    }),timeoutMs);
  }catch(error){
    if(error instanceof UnsupportedModule)
      return response('unsupported',error.message,{phase:'resolution'});
    if(negative?.phase==='resolution'&&matches(error))
      return response('passed','Expected module resolution error observed',
        {phase:'resolution',errorType:negative.type,modules:modules.size});
    return response('failed','Unexpected module resolution '+errorName(error),
      {phase:'resolution',errorType:errorName(error)});
  }
  if(negative?.phase==='resolution')
    return response('failed','Expected a module resolution error but linking succeeded',
      {phase:'resolution'});
  try{
    await withDeadline(root.evaluate({timeout:timeoutMs}),timeoutMs);
    if(dynamicImportObserved)
      return response('unsupported','Dynamic imports are not modeled',{phase:'runtime'});
    if(negative)return response('failed','Expected a module runtime error but execution completed',
      {phase:'runtime'});
    return response('passed','Module evaluated without uncaught error',
      {phase:'runtime',modules:modules.size,harness});
  }catch(error){
    if(error instanceof UnsupportedModule)
      return response('unsupported',error.message,{phase:'runtime'});
    if(negative?.phase==='runtime'&&matches(error))
      return response('passed','Expected module runtime error constructor observed',
        {phase:'runtime',errorType:negative.type,modules:modules.size});
    return response('failed','Unexpected module runtime '+errorName(error),
      {phase:'runtime',errorType:errorName(error)});
  }
}
