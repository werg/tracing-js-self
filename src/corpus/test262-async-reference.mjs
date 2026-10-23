// Opt-in, bounded native-V8 Test262 async-script diagnostics for pinned sources.
// Only VM-owned promise microtasks are supported; no timers, host APIs, module
// jobs or event-loop scheduling. node:vm is NOT a security boundary, and
// diagnostic success never constitutes owned or admitted training evidence.
import {Script,createContext,runInContext} from 'node:vm';

const safeInclude=name=>typeof name==='string'&&
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(name)&&!name.includes('..');
const errorName=error=>String(error?.name??typeof error).slice(0,100);
const response=(status,reason,extra={})=>({schema:'test262-native-async-reference/1',
  authority:'native-v8-diagnostic-only',verifiedOwned:false,admitted:false,
  status,reason,...extra});
const validErrorType=type=>typeof type==='string'&&/^[A-Za-z_$][\w$]*$/.test(type);

/**
 * Execute a Test262 async SCRIPT through the pinned harness and $DONE protocol.
 * A completed run must invoke $DONE exactly once within the VM's synchronous
 * evaluation and immediately drained promise microtasks. This intentionally
 * refuses async tests requiring timers, I/O or later event-loop turns. The
 * caller, not this function, validates the provenance of all supplied bytes.
 */
function executeTurn({source,metadata,mode='sloppy',
  harnessSources={},filename='test262.js',timeoutMs=300}={}){
  if(typeof source!=='string'||!metadata||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>1000)
    throw new TypeError('Invalid Test262 async reference arguments');
  const {flags,includes,features,negative}=metadata;
  if(metadata.metadataStatus!=='parsed'||!Array.isArray(flags)||
     !Array.isArray(includes)||!Array.isArray(features))
    return response('unsupported','Unparsed or incomplete Test262 metadata');
  if(!['sloppy','strict'].includes(mode)||!flags.includes('async')||
     flags.some(flag=>!['async','onlyStrict','noStrict'].includes(flag))||
     flags.includes('onlyStrict')&&mode!=='strict'||
     flags.includes('noStrict')&&mode!=='sloppy'||
     flags.includes('onlyStrict')&&flags.includes('noStrict'))
    return response('unsupported','Async script mode or Test262 flags unsupported');
  if(negative&&(!['parse','runtime','early','resolution'].includes(negative.phase)||
     !validErrorType(negative.type)))
    return response('unsupported','Invalid negative-phase metadata');
  if(negative&&['early','resolution'].includes(negative.phase))
    return response('unsupported','Async script cannot certify early/resolution phase');

  const code=(mode==='strict'?'"use strict";\n':'')+source;
  let script;
  try{script=new Script(code,{filename,displayErrors:false});}
  catch(error){
    if(negative?.phase==='parse'&&error instanceof SyntaxError&&
       negative.type==='SyntaxError')
      return response('passed','Expected async script parse SyntaxError observed',
        {mode,phase:'parse',errorType:'SyntaxError'});
    return response('failed','Unexpected parse-time '+errorName(error),
      {mode,phase:'parse',errorType:errorName(error)});
  }
  if(negative?.phase==='parse')
    return response('failed','Expected parse-time error but parsing succeeded',
      {mode,phase:'parse'});

  const names=[...new Set(['sta.js','assert.js',...includes])];
  if(names.some(name=>!safeInclude(name)||typeof harnessSources[name]!=='string'))
    return response('unsupported','Missing or unsafe pinned harness include');
  const context=createContext(Object.create(null),{
    codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'
  });
  let doneCalls=0,doneArgument;
  Object.defineProperty(context,'__recordDone',{value:error=>{
    doneCalls++;
    if(doneCalls===1)doneArgument=error;
  },writable:false,configurable:false});
  // $DONE must be a guest-realm function. Passing a host callback directly
  // to Promise.then can schedule its reaction on the host microtask queue,
  // outside the bounded VM turn, and silently misclassify completions.
  runInContext('Object.defineProperty(globalThis, "$DONE", {'+
    'value: function(error){ __recordDone(error); }, writable: false, configurable: false})',
    context,{timeout:timeoutMs});
  try{
    for(const name of names){
      new Script(harnessSources[name],{filename:'harness/'+name})
        .runInContext(context,{timeout:timeoutMs,displayErrors:false});
    }
  }catch(error){
    return response('unsupported','Harness failed to initialize: '+errorName(error),
      {mode,phase:'harness'});
  }
  let expectedConstructor=null;
  if(negative?.phase==='runtime'){
    expectedConstructor=runInContext('globalThis['+JSON.stringify(negative.type)+']',
      context,{timeout:timeoutMs});
    if(typeof expectedConstructor!=='function')
      return response('unsupported','Declared negative error constructor unavailable');
  }
  const matches=error=>error!==null&&
    (typeof error==='object'||typeof error==='function')&&
    error instanceof expectedConstructor;
  try{
    script.runInContext(context,{timeout:timeoutMs,displayErrors:false});
  }catch(error){
    if(negative?.phase==='runtime'&&matches(error))
      return response('passed','Expected synchronous runtime error observed',
        {mode,phase:'runtime',errorType:negative.type,harness:names});
    return response('failed','Unexpected runtime '+errorName(error),
      {mode,phase:'runtime',errorType:errorName(error),harness:names});
  }
  if(doneCalls>1)
    return response('failed','Async $DONE invoked more than once',
      {mode,phase:'runtime',completionCalls:doneCalls,harness:names});
  if(doneCalls===0)
    return response('unsupported','No $DONE completion in bounded VM microtask turn',
      {mode,phase:'runtime',completionCalls:0,harness:names});
  if(doneArgument!==undefined){
    if(negative?.phase==='runtime'&&matches(doneArgument))
      return response('passed','Expected async $DONE error constructor observed',
        {mode,phase:'runtime',errorType:negative.type,completionCalls:1,harness:names});
    return response('failed','Unexpected async $DONE error '+errorName(doneArgument),
      {mode,phase:'runtime',errorType:errorName(doneArgument),completionCalls:1,harness:names});
  }
  if(negative)
    return response('failed','Expected runtime error but $DONE succeeded',
      {mode,phase:'runtime',completionCalls:1,harness:names});
  return response('passed','Async script called $DONE once without an error',
    {mode,phase:'runtime',completionCalls:1,harness:names});
}

// Node reports unhandled rejected microtasks at the end of an event-loop turn,
// not while Script.runInContext is draining the context-owned microtask queue.
// Serialize observations: a per-run listener is otherwise unable to attribute
// rejection events to a particular diagnostic execution.
let observationQueue=Promise.resolve();
export function executeTest262AsyncReference(options){
  const task=observationQueue.then(async()=>{
    const rejections=[];
    const onRejection=error=>rejections.push(errorName(error));
    process.on('unhandledRejection',onRejection);
    try{
      const result=executeTurn(options);
      await new Promise(resolve=>setImmediate(resolve));
      if(rejections.length)
        return response('failed','Unhandled async rejection observed',
          {mode:result.mode,phase:'runtime',errorType:rejections[0]});
      return result;
    }finally{process.removeListener('unhandledRejection',onRejection);}
  });
  observationQueue=task.then(()=>undefined,()=>undefined);
  return task;
}
