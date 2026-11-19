#!/usr/bin/env node
// Independent V8 source execution. This worker never imports the owned runtime,
// protocol evaluator, projector, or teacher archive. Trusted source only unless
// invoked under the existing Linux namespace isolation profile.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {decodeOwnedGraph} from '../src/host/graph-codec.js';
import {describeCompletionGraph} from '../src/training/exception-profile.js';
import {instrumentOperationSource} from '../src/training/operation-reference.js';
import {instrumentBranchSource} from '../src/training/branch-reference.js';
import {instrumentCompletionSource,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {createProtocolCompletionCapture,prepareProtocolObservationExtensionsV8} from '../src/semantic/protocol-source-observations-v8.js';
import {encode} from '../src/values.js';

let mode='original',phase='input';
try{
  const input=JSON.parse(readFileSync(0,'utf8'));mode=input.mode??'original';
  if(!['original','operations','branches','completions'].includes(mode)||
    !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(input.entry??''))throw new TypeError('Invalid reference mode or entry');
  if(input.awaitReturnedPromise!==undefined&&typeof input.awaitReturnedPromise!=='boolean')
    throw new TypeError('Explicit returned Promise completion policy required');
  const args=decodeOwnedGraph(JSON.stringify(input.inputGraph)),operations=[],decisions=[],failures=[];
  const extensions=prepareProtocolObservationExtensionsV8({source:input.source,mode,side:'native'});
  const completion=createProtocolCompletionCapture({initialValues:args,adapters:extensions.metadataAdapters});
  function bounded(list,row){if(list.length>=32768)throw new RangeError('Independent protocol observation cap');list.push(row);}
  const context=vm.createContext({...extensions.globals,__args:args,__result:undefined,__kind:'return',
    __tracingCapture:(site,value)=>{try{bounded(operations,{site,value:encode(value)});}catch(error){failures.push(error.message);throw error;}return value;},
    __tracingBranch:(site,value)=>{bounded(decisions,{site,decision:['bool',!Boolean(value)]});return value;},
    __tracingLogical:(site,operator,value)=>{bounded(decisions,{site,decision:['bool',
      operator==='&&'?!value:operator==='||'?Boolean(value):value!==null&&value!==undefined]});return value;},
    [COMPLETION_HOOK]:(...values)=>{try{return completion.capture(...values);}catch(error){failures.push(error.message);throw error;}}
  },{codeGeneration:{strings:false,wasm:false}});
  completion.setIntrinsicPrototypes(vm.runInContext('[Object.prototype,Array.prototype,Function.prototype]',context));
  extensions.initializeRealm(expression=>vm.runInContext(expression,context));
  phase='instrumentation';
  const source=mode==='operations'?instrumentOperationSource(input.source):
    mode==='branches'?instrumentBranchSource(input.source):
    mode==='completions'?extensions.instrument(instrumentCompletionSource(input.source)):input.source;
  phase='compile';const script=new vm.Script(source+'\ntry { __result = '+input.entry+
    '.apply(undefined,__args); } catch (__guestThrown) { __kind="throw"; __result=__guestThrown; }',
    {filename:'independent-protocol-reference-v8.js'});
  phase='execute';script.runInContext(context,{timeout:input.timeoutMs??5000});
  // The parent process enforces the same hard deadline for asynchronous work.
  // Only a source profile explicitly requesting this completion policy awaits.
  if(input.awaitReturnedPromise&&context.__kind==='return'){
    try{context.__result=await context.__result;}
    catch(error){context.__kind='throw';context.__result=error;}
  }
  if(failures.length)throw new TypeError(failures[0]);
  phase='observe';
  const outcome={kind:context.__kind,graph:describeCompletionGraph(args,context.__result,context.__kind)};
  const extensionObservations=extensions.observations();
  process.stdout.write(JSON.stringify({schema:'protocol-source-reference/1',mode,outcome,
    operations,decisions,completions:completion.observations,metadata:completion.metadata,
    ...(extensionObservations.length?{extensionObservations}:{})})+'\n');
}catch(error){process.stdout.write(JSON.stringify({schema:'protocol-source-reference/1',error:String(error.message),
  category:error.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'?'resource_limited':'unsupported.protocol-reference',mode,phase})+'\n');process.exitCode=1;}
