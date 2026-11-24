#!/usr/bin/env node
// Independent V8 source execution. This worker never imports the owned runtime,
// protocol evaluator, projector, or teacher archive. Trusted source only unless
// invoked under the existing Linux namespace isolation profile.
import vm from 'node:vm';
import {types} from 'node:util';
import {readFileSync} from 'node:fs';
import {decodeOwnedGraph} from '../src/host/graph-codec.js';
import {describeCompletionGraph} from '../src/training/exception-profile.js';
import {instrumentOperationSource} from '../src/training/operation-reference.js';
import {instrumentBranchSource} from '../src/training/branch-reference.js';
import {instrumentCompletionSource,COMPLETION_HOOK} from '../src/training/completion-reference.js';
import {createProtocolCompletionCapture,prepareProtocolObservationExtensionsV8} from '../src/semantic/protocol-source-observations-v8.js';
import {encode} from '../src/values.js';
import {inspectNativePromiseSettlementV8} from '../src/semantic/native-promise-result-v8.js';

let mode='original',phase='input';
try{
  const input=JSON.parse(readFileSync(0,'utf8'));mode=input.mode??'original';
  if(!['original','operations','branches','completions'].includes(mode)||
    !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(input.entry??''))throw new TypeError('Invalid reference mode or entry');
  if(input.awaitReturnedPromise!==undefined&&typeof input.awaitReturnedPromise!=='boolean')
    throw new TypeError('Explicit returned Promise completion policy required');
  const args=decodeOwnedGraph(JSON.stringify(input.inputGraph)),operations=[],decisions=[],failures=[];
  const extensions=prepareProtocolObservationExtensionsV8({source:input.source,mode,side:'native',initialValues:args});
  const completion=createProtocolCompletionCapture({initialValues:args,adapters:extensions.metadataAdapters});
  function bounded(list,row){if(list.length>=32768)throw new RangeError('Independent protocol observation cap');list.push(row);}
  const context=vm.createContext({...extensions.globals,queueMicrotask,__args:args,__result:undefined,__kind:'return',
    __tracingCapture:(site,value)=>{try{bounded(operations,{site,value:encode(value)});}catch(error){failures.push(error.message);throw error;}return value;},
    __tracingBranch:(site,value)=>{bounded(decisions,{site,decision:['bool',!Boolean(value)]});return value;},
    __tracingLogical:(site,operator,value)=>{bounded(decisions,{site,decision:['bool',
      operator==='&&'?!value:operator==='||'?Boolean(value):value!==null&&value!==undefined]});return value;},
    [COMPLETION_HOOK]:(...values)=>{try{return completion.capture(...values);}catch(error){failures.push(error.message);throw error;}}
  },{codeGeneration:{strings:false,wasm:false}});
  completion.setIntrinsicPrototypes(vm.runInContext('[Object.prototype,Array.prototype,Function.prototype,Error.prototype,EvalError.prototype,RangeError.prototype,ReferenceError.prototype,SyntaxError.prototype,TypeError.prototype,URIError.prototype]',context),['Object.prototype','Array.prototype','Function.prototype','Error.prototype','EvalError.prototype','RangeError.prototype','ReferenceError.prototype','SyntaxError.prototype','TypeError.prototype','URIError.prototype']);
  extensions.initializeRealm(expression=>vm.runInContext(expression,context));
  phase='instrumentation';
  const source=mode==='operations'?instrumentOperationSource(input.source):
    mode==='branches'?instrumentBranchSource(input.source):
    mode==='completions'?extensions.instrument(instrumentCompletionSource(input.source)):input.source;
  phase='compile';const script=new vm.Script(source+'\ntry { __result = '+input.entry+
    '.apply(undefined,__args); } catch (__guestThrown) { __kind="throw"; __result=__guestThrown; }',
    {filename:'independent-protocol-reference-v8.js'});
  const unhandled=[],onUnhandled=(reason,promise)=>unhandled.push({reason,promise});
  if(input.awaitReturnedPromise)process.on('unhandledRejection',onUnhandled);
  phase='execute';script.runInContext(context,{timeout:input.timeoutMs??5000});
  // The owned scheduler runs the whole current microtask queue, including
  // detached async work after a scalar root return. One host turn boundary
  // drains that queue to quiescence; a fixed number of Promise awaits would
  // truncate longer chains. The parent deadline still bounds infinite jobs.
  if(input.awaitReturnedPromise){
    try{
      const root=context.__kind==='return'&&types.isPromise(context.__result)?context.__result:null;
      await new Promise(resolve=>setImmediate(resolve));
      // An observer failure can interrupt the guest's settlement chain. Retain
      // that original diagnostic before classifying its stranded root Promise.
      if(failures.length)throw new TypeError(failures[0]);
      if(root){
        // A host `await` (including inspector Runtime.awaitPromise) adds guest
        // constructor/then/species lookups. Read actual native settlement slots
        // after the required drain instead, without modifying guest objects.
        const settled=await inspectNativePromiseSettlementV8(root);
        if(settled.status==='pending'){
          const error=new RangeError('Returned Promise remains pending after native microtask drain');
          error.code='ERR_PROTOCOL_PROMISE_PENDING';throw error;
        }
        context.__kind=settled.kind;context.__result=settled.value;
      }
      if(unhandled.some(row=>row.promise!==root))
        throw new TypeError('Unhandled independent guest Promise rejection outside the returned root');
    }finally{process.removeListener('unhandledRejection',onUnhandled);}
  }
  if(failures.length)throw new TypeError(failures[0]);
  phase='observe';
  const outcome={kind:context.__kind,graph:describeCompletionGraph(args,context.__result,context.__kind)};
  const extensionObservations=extensions.observations();
  process.stdout.write(JSON.stringify({schema:'protocol-source-reference/1',mode,outcome,
    operations,decisions,completions:completion.observations,metadata:completion.metadata,
    ...(extensionObservations.length?{extensionObservations}:{})})+'\n');
}catch(error){process.stdout.write(JSON.stringify({schema:'protocol-source-reference/1',error:String(error.message),
  category:['ERR_SCRIPT_EXECUTION_TIMEOUT','ERR_PROTOCOL_PROMISE_PENDING'].includes(error.code)?'resource_limited':
    error.category==='unsupported.native-promise-observer'?error.category:'unsupported.protocol-reference',mode,phase})+'\n');process.exitCode=1;}
