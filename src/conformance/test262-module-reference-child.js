// Disposable native reference for the bounded Test262 module profile.
// Inputs are JSON data; module requests must resolve inside the catalog's
// pinned dependency graph. This process is never the owned interpreter.
import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import {createContext,runInContext,Script,SourceTextModule} from 'node:vm';
import {parse} from 'acorn';
import {test262HostCapabilities} from './test262-capabilities.js';
import {createModuleEvaluationCoordinator} from './test262-module-evaluation.js';
import {createTest262ReferenceCompletion} from './test262-reference-completion.js';

const input=JSON.parse(readFileSync(0,'utf8'));
const {variant,profile,sources}=input;
const negative=variant.metadata.negative;
const completion=createTest262ReferenceCompletion(),output=completion.output;
let unhandledRejection=null;
process.on('unhandledRejection',error=>{unhandledRejection=error;});
const syntaxError=error=>error instanceof SyntaxError||error?.name==='SyntaxError';

function guestErrorType(error,context){
  if(!error||typeof error!=='object')return null;
  // Test262Error is supplied by the original sta.js harness, not an intrinsic
  // realm Error subclass. Check its genuine prototype chain so a forged own
  // `constructor` property cannot satisfy a negative test.
  try{
    const test262Error=runInContext('typeof Test262Error === "function" ? Test262Error : null',context);
    if(test262Error&&Object.getPrototypeOf(error)===test262Error.prototype&&error instanceof test262Error)
      return 'Test262Error';
  }catch{}
  for(const name of ['AggregateError','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError','Error']){
    try{
      const constructor=runInContext(name,context);
      if(error instanceof constructor&&error.constructor===constructor)return name;
    }catch{}
  }
  return null;
}

async function main(){
  if(typeof SourceTextModule!=='function')return {status:'environment_unavailable',
    reason:'Node VM module support is unavailable',phase:'environment'};
  const timeout=profile.hostProfile.reference.timeoutMs;
  const context=createContext(Object.create(null),{
    codeGeneration:{strings:true,wasm:false}
  });
  const print=value=>{
    if(output.length>=10000){const error=new RangeError('Reference print budget exceeded');error.code='ERR_TEST262_PRINT_LIMIT';throw error;}
    completion.print(String(value));
  };
  Object.setPrototypeOf(print,null);Object.freeze(print);
  Object.defineProperty(context,'print',{value:print,writable:false,configurable:false});

  const paths=Object.keys(sources).sort();
  if(!paths.includes(variant.path))return {status:'infrastructure_error',
    reason:'Catalog module graph omits its entry module',phase:'module-input'};
  for(const path of paths){
    if(!path.startsWith('test/')||path.split('/').some(part=>!part||part==='.'||part==='..')||
      typeof sources[path]!=='string')return {status:'infrastructure_error',
        reason:'Invalid catalog module source path: '+path,phase:'module-input'};
  }
  const modules=new Map();
  const dynamicPending=new Set(),unavailableModuleRequests=[];
  let executionPerformed=false;
  const refuseModuleRequest=reason=>{
    unavailableModuleRequests.push(reason);
    const error=new Error(reason);error.name='Test262ReferenceEnvironmentError';
    error.code='ERR_TEST262_UNPINNED_MODULE_REQUEST';return error;
  };
  const moduleRequestUnavailable=()=>({status:'environment_unavailable',
    reason:[...new Set(unavailableModuleRequests)].join('; '),phase:'environment',
    unresolved:[...new Set(unavailableModuleRequests)],executionPerformed});
  const resolveRequest=(specifier,referrer,attributes)=>{
    if(attributes&&Object.keys(attributes).length)
      throw refuseModuleRequest('Import attributes require a declared host module loader');
    if(typeof specifier!=='string'||!specifier.startsWith('./')&&!specifier.startsWith('../'))
      throw refuseModuleRequest('Module request is outside the pinned relative graph');
    const parent=referrer.identifier.slice('test262://'.length);
    const target=posix.normalize(posix.join(posix.dirname(parent),specifier));
    if(!target.startsWith('test/')||target.split('/').some(part=>!part||part==='.'||part==='..')||
      !modules.has(target))throw refuseModuleRequest('Module request is absent from the pinned dependency graph');
    return modules.get(target);
  };
  const linker=(specifier,referrer,extra)=>resolveRequest(specifier,referrer,extra?.attributes);
  const coordinator=createModuleEvaluationCoordinator({linker,timeout,refuse:refuseModuleRequest});
  const importModuleDynamically=(specifier,referrer,attributes)=>{
    const pending=(async()=>{
      const target=resolveRequest(specifier,referrer,attributes);
      return coordinator.evaluateOnce(target);
    })();
    dynamicPending.add(pending);
    pending.then(()=>dynamicPending.delete(pending),()=>dynamicPending.delete(pending));
    return pending;
  };
  const createModule=path=>new SourceTextModule(sources[path],{
    context,identifier:'test262://'+path,
    initializeImportMeta(meta,module){meta.url=module.identifier;},
    importModuleDynamically
  });

  // The test's own parse expectation is observed before compiling dependencies,
  // harness files, or executing any guest code.
  let entry;
  try{entry=createModule(variant.path);}
  catch(error){
    const matches=negative?.phase==='parse'&&negative.type==='SyntaxError'&&syntaxError(error);
    return {status:matches?'passed':'failed',reason:matches?'Expected module parse SyntaxError observed':
      'Unexpected module parse error',phase:'parse',errorType:syntaxError(error)?'SyntaxError':null};
  }
  if(negative?.phase==='parse')return {status:'failed',reason:'Expected a module parse-time error but the source parsed',phase:'parse'};
  modules.set(variant.path,entry);
  if(input.dependenciesComplete!==true)return {status:'environment_unavailable',
    reason:'Pinned module dependency closure is incomplete: '+(input.unresolved??[]).join(', '),
    phase:'environment',unresolved:input.unresolved??[]};
  for(const path of paths){
    if(path===variant.path)continue;
    try{modules.set(path,createModule(path));}
    catch(error){return {status:'failed',reason:'Pinned module dependency did not parse',
      phase:'parse',errorType:syntaxError(error)?'SyntaxError':null};}
  }
  const missing=[];
  for(const path of paths){
    try{
      const ast=parse(sources[path],{ecmaVersion:'latest',sourceType:'module'});
      missing.push(...test262HostCapabilities(ast));
    }catch{
      // Native module parsing above remains the reference authority. If the
      // shared AST preflight cannot inspect this grammar, a literal $262 token
      // still fails closed as an unavailable host hook rather than a false pass.
      if(/\$262\b/.test(sources[path]))missing.push('test262-host-object');
    }
  }
  for(const flag of variant.metadata.flags)
    if(['CanBlockIsTrue','CanBlockIsFalse','non-deterministic'].includes(flag))missing.push('host-flag:'+flag);
  if(missing.length)return {status:'environment_unavailable',
    reason:'Unavailable original Test262 capabilities: '+[...new Set(missing)].sort().join(', '),
    phase:'environment',missingCapabilities:[...new Set(missing)].sort()};

  const harness=[];
  try{
    for(const file of input.harness??[]){
      new Script(file.text,{filename:file.path}).runInContext(context,{timeout,displayErrors:false});
      if(file.path==='harness/doneprintHandle.js')completion.bind(context);
      harness.push(file.path);
    }
  }catch(error){
    const resource=error?.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'||/Reference print budget exceeded/.test(error?.message??'');
    return {status:resource?'resource_limited':'failed',reason:resource?'Reference harness time budget exceeded':
      'Original reference harness failed before module linking',phase:'harness',
      errorType:guestErrorType(error,context),harness};
  }

  let linkError=null;
  try{await entry.link(linker);}
  catch(error){linkError=error;}
  if(linkError){
    if(unavailableModuleRequests.length)return moduleRequestUnavailable();
    const observed=guestErrorType(linkError,context);
    const passed=negative?.phase==='resolution'&&observed===negative.type;
    return {status:passed?'passed':'failed',reason:passed?'Expected module resolution error constructor observed':
      'Unexpected module linking error',phase:'resolution',errorType:observed??'unknown',harness};
  }
  if(negative?.phase==='resolution')return {status:'failed',
    reason:'Expected a module resolution error but linking completed',phase:'resolution',harness};

  let evaluation;
  const deadline=Date.now()+timeout;
  try{executionPerformed=true;evaluation=entry.evaluate({timeout});}
  catch(error){
    if(['ERR_SCRIPT_EXECUTION_TIMEOUT','ERR_TEST262_PRINT_LIMIT'].includes(error?.code))return {status:'resource_limited',
      reason:'Synchronous module evaluation exceeded the reference time budget',phase:'runtime',harness};
    const observed=guestErrorType(error,context);
    const passed=negative?.phase==='runtime'&&observed===negative.type;
    return {status:passed?'passed':'failed',reason:passed?'Expected module runtime error constructor observed':
      'Unexpected module evaluation error',phase:'runtime',errorType:observed??'unknown',harness};
  }
  coordinator.trackEvaluation(entry,evaluation);
  let timer;
  const remaining=()=>Math.max(0,deadline-Date.now());
  const timedOut=new Promise(resolve=>{timer=setTimeout(()=>resolve({kind:'timeout'}),remaining());});
  const settled=await Promise.race([evaluation.then(()=>({kind:'fulfilled'}),error=>({kind:'rejected',error})),timedOut]);
  if(settled.kind==='timeout')return {status:'resource_limited',
    reason:'Module evaluation or top-level await exceeded the reference time budget',phase:'runtime',harness};
  if(settled.kind==='rejected'){
    clearTimeout(timer);
    if(unavailableModuleRequests.length)return moduleRequestUnavailable();
    if(['ERR_SCRIPT_EXECUTION_TIMEOUT','ERR_TEST262_PRINT_LIMIT'].includes(settled.error?.code))
      return {status:'resource_limited',reason:'Module evaluation exceeded the reference time budget',
        phase:'runtime',harness};
    const observed=guestErrorType(settled.error,context);
    const passed=negative?.phase==='runtime'&&observed===negative.type;
    return {status:passed?'passed':'failed',reason:passed?'Expected module runtime error constructor observed':
      'Unexpected module evaluation rejection',phase:'runtime',errorType:observed??'unknown',harness};
  }
  // Drain the immediate Promise turn so literal dynamic imports and their
  // guest reactions are observed before a synchronous module can pass.
  await new Promise(resolve=>setImmediate(resolve));
  const asyncDone=()=>output.some(({text})=>text==='Test262:AsyncTestComplete'||
    text.startsWith('Test262:AsyncTestFailure:'));
  while(dynamicPending.size||variant.metadata.flags.includes('async')&&!asyncDone()){
    if(unavailableModuleRequests.length){clearTimeout(timer);return moduleRequestUnavailable();}
    if(unhandledRejection){clearTimeout(timer);return {status:'failed',
      reason:'Module graph produced an unhandled rejection',phase:'runtime',
      errorType:guestErrorType(unhandledRejection,context),harness};}
    if(remaining()===0){clearTimeout(timer);return {status:'resource_limited',
      reason:dynamicPending.size?'Dynamic module work exceeded the reference time budget':
        'No original reference async completion before quiescence',phase:'runtime',
      completionPrints:0,harness};}
    await new Promise(resolve=>setTimeout(resolve,Math.min(2,remaining())));
  }
  clearTimeout(timer);
  if(unavailableModuleRequests.length)return moduleRequestUnavailable();
  if(unhandledRejection)return {status:'failed',reason:'Module graph produced an unhandled rejection',
    phase:'runtime',errorType:guestErrorType(unhandledRejection,context),harness};
  if(negative)return {status:'failed',reason:'Expected a module runtime error but evaluation completed',phase:'runtime',harness};
  const prints=output.map(item=>item.text);
  if(variant.metadata.flags.includes('async')){
    return {...completion.result(),phase:'runtime',harness,printCount:prints.length};
  }
  const completions=prints.filter(value=>value==='Test262:AsyncTestComplete');
  const failures=prints.filter(value=>value.startsWith('Test262:AsyncTestFailure:'));
  if(failures.length)return {status:'failed',reason:'Original reference async harness reported failure',
    phase:'runtime',completionPrints:completions.length,failurePrints:failures.length,harness};
  if(completions.length>1)return {status:'failed',reason:'Reference async completion occurred more than once',
    phase:'runtime',completionPrints:completions.length,harness};
  return {status:'passed',reason:'Original module graph and reference assertions completed',
    phase:'runtime',harness,printCount:prints.length};
}

let answer;
try{answer=await main();}
catch(error){answer={status:'infrastructure_error',reason:error?.message??String(error),phase:'module-reference'};}
process.stdout.write(JSON.stringify({schema:'test262-module-reference-child/1',...answer})+'\n');
