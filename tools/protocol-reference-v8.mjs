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
import {createProtocolCompletionCapture} from '../src/semantic/protocol-source-observations-v8.js';
import {encode} from '../src/values.js';

let mode='original',phase='input';
try{
  const input=JSON.parse(readFileSync(0,'utf8'));mode=input.mode??'original';
  if(!['original','operations','branches','completions'].includes(mode)||
    !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(input.entry??''))throw new TypeError('Invalid reference mode or entry');
  const args=decodeOwnedGraph(JSON.stringify(input.inputGraph)),operations=[],decisions=[],failures=[];
  const completion=createProtocolCompletionCapture({initialValues:args});
  function bounded(list,row){if(list.length>=32768)throw new RangeError('Independent protocol observation cap');list.push(row);}
  const context=vm.createContext({__args:args,__result:undefined,__kind:'return',
    __tracingCapture:(site,value)=>{try{bounded(operations,{site,value:encode(value)});}catch(error){failures.push(error.message);throw error;}return value;},
    __tracingBranch:(site,value)=>{bounded(decisions,{site,decision:['bool',!Boolean(value)]});return value;},
    __tracingLogical:(site,operator,value)=>{bounded(decisions,{site,decision:['bool',
      operator==='&&'?!value:operator==='||'?Boolean(value):value!==null&&value!==undefined]});return value;},
    [COMPLETION_HOOK]:(...values)=>{try{return completion.capture(...values);}catch(error){failures.push(error.message);throw error;}}
  },{codeGeneration:{strings:false,wasm:false}});
  phase='instrumentation';
  const source=mode==='operations'?instrumentOperationSource(input.source):
    mode==='branches'?instrumentBranchSource(input.source):
    mode==='completions'?instrumentCompletionSource(input.source):input.source;
  phase='compile';const script=new vm.Script(source+'\ntry { __result = '+input.entry+
    '.apply(undefined,__args); } catch (__guestThrown) { __kind="throw"; __result=__guestThrown; }',
    {filename:'independent-protocol-reference-v8.js'});
  phase='execute';script.runInContext(context,{timeout:input.timeoutMs??5000});
  if(failures.length)throw new TypeError(failures[0]);
  phase='observe';
  const outcome={kind:context.__kind,graph:describeCompletionGraph(args,context.__result,context.__kind)};
  process.stdout.write(JSON.stringify({schema:'protocol-source-reference/1',mode,outcome,
    operations,decisions,completions:completion.observations})+'\n');
}catch(error){process.stdout.write(JSON.stringify({schema:'protocol-source-reference/1',error:String(error.message),
  category:error.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'?'resource_limited':'unsupported.protocol-reference',mode,phase})+'\n');process.exitCode=1;}
