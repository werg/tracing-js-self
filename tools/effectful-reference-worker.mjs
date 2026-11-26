#!/usr/bin/env node
// Independent trusted-source reference process. OS sandboxing is required
// before accepting hostile sources; node:vm alone is not a security boundary.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createFixtureBroker} from '../src/training/fixture-broker.js';
import {HOST_METHODS,hostOperation} from '../src/host/operations.js';
import {decodeOwnedGraph} from '../src/host/graph-codec.js';
import {describeCompletionGraph,DECLARED_EXCEPTION_PROFILE} from '../src/training/exception-profile.js';
import {encode} from '../src/values.js';
import {instrumentOperationSource} from '../src/training/operation-reference.js';
import {instrumentBranchSource} from '../src/training/branch-reference.js';
import {instrumentCompletionSource,createCompletionCapture,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {instrumentNativeTraceSource,createNativeTraceCollector} from '../src/training/native-trace.js';
import {normalizeFetchRequest,VM_FETCH_RUNTIME_SCRIPT} from '../src/training/tinker-http-fetch.js';
import {VM_BROWSER_DOM_RUNTIME_SCRIPT,DEFAULT_BROWSER_HTML,DEFAULT_BROWSER_URL} from '../src/training/tinker-browser-dom.js';

let mode='original',phase='input';
try{
  const input=JSON.parse(readFileSync(0,'utf8'));
  mode=input.mode??'original';
  if(!['original','operations','branches','completions','trace'].includes(mode)||
    !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(input.entry??''))
    throw new TypeError('Invalid reference mode or entry identifier');
  const broker=createFixtureBroker(input.fixture),operations=[],decisions=[];
  const traceCollector=mode==='trace'?createNativeTraceCollector():null;
  const callbackFailures=[],unhandledRejections=[],infrastructureFailures=[];
  process.on('unhandledRejection',error=>{
    try{unhandledRejections.push({kind:'throw',graph:describeCompletionGraph([],error,'throw')});}
    catch(cause){infrastructureFailures.push({category:'reference_instrumentation_unsupported',
      message:'Unrepresentable unhandled rejection: '+String(cause.message)});}
  });
  const fail=(error,category='reference_process_failure')=>{
    infrastructureFailures.push({category,message:String(error?.message??error)});
    throw error;
  };
  const failure=error=>{
    try{callbackFailures.push({kind:'throw',graph:describeCompletionGraph([],error,'throw')});}
    catch(cause){infrastructureFailures.push({category:'reference_instrumentation_unsupported',
      message:'Unrepresentable callback failure: '+String(cause.message)});}
  };
  const invoke=(operation,args)=>{
    if(traceCollector)traceCollector.nextTurn();
    try{const result=broker.invoke(operation,args.map((arg,index)=>
      hostOperation(operation).callbackIndices.includes(index)?(...values)=>{
        queueMicrotask(()=>{try{const result=arg(...values);
          if(result&&typeof result.then==='function')result.catch(failure);}
          catch(error){failure(error);}});
      }:arg));
      if(result&&typeof result.then==='function')return result.catch(error=>{
        if(error instanceof Error)infrastructureFailures.push({
          category:'reference_process_failure',message:String(error.message)});
        throw error;
      });
      return result;
    }catch(error){
      // A planned rejected synchronous fixture is guest input. A broker
      // mismatch is verification infrastructure and cannot become a label.
      if(error instanceof Error)infrastructureFailures.push({
        category:'reference_process_failure',message:String(error.message)});
      throw error;
    }
  };
  const host=Object.create(null);
  for(const [method,operation] of Object.entries(HOST_METHODS))host[method]=(...args)=>invoke(operation,args);
  for(const call of input.fixture.calls)if(call.operation.startsWith('demo.'))
    host[call.operation.slice(5)]=(...args)=>invoke(call.operation,args);
  const args=decodeOwnedGraph(JSON.stringify(input.inputGraph));
  const completionCapture=createCompletionCapture({initialValues:args});
  const capture=(site,value)=>{
    if(operations.length>=16384)fail(new RangeError('Reference operation cap'),'reference_resource_limit');
    try{operations.push({site,value:encode(value)});}catch(error){fail(error,'reference_instrumentation_unsupported');}
    return value;
  };
  const branch=(site,value)=>{
    if(decisions.length>=16384)fail(new RangeError('Reference branch cap'),'reference_resource_limit');
    decisions.push({site,decision:['bool',!Boolean(value)]});return value;
  };
  const logical=(site,operator,value)=>{
    if(decisions.length>=16384)fail(new RangeError('Reference branch cap'),'reference_resource_limit');
    decisions.push({site,decision:['bool',operator==='&&'?!value:
      operator==='||'?Boolean(value):value!==null&&value!==undefined]});return value;
  };
  const extraGlobals = input.executionMode === 'native'
    ? {
        URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone,
        __platformFetch: (reqInput, reqInit) => invoke('http.request', normalizeFetchRequest(reqInput, reqInit)),
        ...(input.environment === 'browser' ? {
          __browserInvoke: (op, opArgs) => invoke(op, Array.from(opArgs ?? [])),
          __browserInitialHtml: input.initialHtml ?? DEFAULT_BROWSER_HTML,
          __browserInitialUrl: input.initialUrl ?? DEFAULT_BROWSER_URL,
        } : {}),
      }
    : {};
  const context=vm.createContext({...extraGlobals,...(traceCollector?traceCollector.hooks:{}),host,__args:args,__result:undefined,__kind:'return',
    __tracingCapture:capture,__tracingBranch:branch,__tracingLogical:logical,
    [COMPLETION_HOOK]:(...args)=>{try{return completionCapture.capture(...args);}
      catch(error){return fail(error,'reference_instrumentation_unsupported');}},
    queueMicrotask:callback=>queueMicrotask(()=>{try{callback();}catch(error){failure(error);}}),
    console:Object.fromEntries(['log','info','warn','error'].map(method=>[method,(...args)=>
      invoke('platform.console.'+method,args)]))},{codeGeneration:{strings:false,wasm:false}});
  if (input.executionMode === 'native') {
    new vm.Script(VM_FETCH_RUNTIME_SCRIPT).runInContext(context, {timeout: input.timeoutMs ?? 5000});
  }
  const usesToolRandom=input.randomMode==='tool'||input.fixture.calls.some(call=>call.operation==='platform.random');
  if(usesToolRandom){
    context.__platformRandom=()=>invoke('platform.random',[]);
    new vm.Script('Math.random = __platformRandom;').runInContext(context,{timeout:input.timeoutMs??5000});
  }else if(input.randomSeed!==undefined&&input.randomSeed!==null){
    if(!Number.isInteger(input.randomSeed)||input.randomSeed<0||input.randomSeed>0xffffffff)
      throw new TypeError('Invalid deterministic guest RNG fixture seed');
    context.__trainingRandomSeed=input.randomSeed;
    // Declared deterministic fixture, identical to the existing pure-source
    // profile. No unseeded host randomness participates in qualification.
    new vm.Script(`(function(){let state=__trainingRandomSeed>>>0;
      Math.random=function(){state=(Math.imul(state,1664525)+1013904223)>>>0;
        return state/4294967296;};})()`).runInContext(context,{timeout:input.timeoutMs??5000});
  }
  if(input.fixture.calls.some(call=>call.operation==='platform.dateNow')){
    context.__platformDateNow=()=>invoke('platform.dateNow',[]);
    new vm.Script('Date.now = __platformDateNow;').runInContext(context,{timeout:input.timeoutMs??5000});
  }
  if (input.executionMode === 'native' && input.environment === 'browser') {
    new vm.Script(VM_BROWSER_DOM_RUNTIME_SCRIPT).runInContext(context, {timeout: input.timeoutMs ?? 5000});
  }
  phase='instrumentation';
  const source=mode==='operations'?instrumentOperationSource(input.source):
    mode==='branches'?instrumentBranchSource(input.source):
    mode==='completions'?instrumentCompletionSource(input.source):
    mode==='trace'?instrumentNativeTraceSource(input.source,{entryName:input.entry,sourceLength:input.traceSourceLength}).source:
    input.source;
  phase='compile';
  // Catch only guest invocation throws *inside* the reference realm. Script
  // compilation and vm deadline failures still escape as verifier failures.
  const script=new vm.Script(source+'\ntry { __result = '+input.entry+
    '.apply(undefined,__args); } catch (__guestThrown) { __kind="throw"; __result=__guestThrown; }',
    {filename:'independent-effectful-reference.js'});
  phase='execute';
  script.runInContext(context,{timeout:input.timeoutMs??5000});
  let value=context.__result,kind=context.__kind;
  if(kind==='return'){
    if(input.environment==='browser'&&value&&typeof value.then==='function'){
      let settled=false;
      const tracked=Promise.resolve(value).then(
        res=>{settled=true;return {ok:true,res};},
        err=>{settled=true;return {ok:false,err};}
      );
      for(let steps=0;steps<2000&&!settled;steps++){
        await new Promise(resolve=>setImmediate(resolve));
        if(settled)break;
        if(context.__browserHasPendingTimers&&context.__browserHasPendingTimers()){
          try{context.__browserStepNextTimer();}catch(error){failure(error);}
        }else{
          break;
        }
      }
      const outcomeBox=await tracked;
      if(outcomeBox.ok)value=outcomeBox.res;
      else{kind='throw';value=outcomeBox.err;}
    }else{
      try{value=await value;}catch(error){kind='throw';value=error;}
    }
  }
  // Allow queued callback failures to settle before certifying quiescence.
  await new Promise(resolve=>setImmediate(resolve));
  if(infrastructureFailures.length){
    const error=new Error(infrastructureFailures[0].message);
    error.category=infrastructureFailures[0].category;throw error;
  }
  phase='observe';
  const outcome={kind,graph:describeCompletionGraph(args,value,kind)};
  process.stdout.write(JSON.stringify({schema:'effectful-reference/4',exceptionProfile:DECLARED_EXCEPTION_PROFILE,outcome,
    effects:broker.finish(),operations,decisions,completions:completionCapture.observations,
    ...(traceCollector?{traceTurns:traceCollector.finalize()}:{}),
    callbackFailures,unhandledRejections})+'\n');
}catch(error){
  const category=error.category??(error.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'?
    'reference_resource_limit':['instrumentation','compile','observe'].includes(phase)?
      'reference_instrumentation_unsupported':'reference_process_failure');
  const message=String(error?.message??error);
  process.stdout.write(JSON.stringify({schema:'effectful-reference/4',error:message,
    failure:{category,message,mode,phase}})+'\n');process.exitCode=1;
}
