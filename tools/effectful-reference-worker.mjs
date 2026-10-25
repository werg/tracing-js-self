#!/usr/bin/env node
// Isolated reference process for declared repository fixtures. It executes
// original/instrumented source independently of the owned interpreter. No
// private journal, selected witness, expected return or final heap is input.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createFixtureBroker} from '../src/training/fixture-broker.js';
import {HOST_METHODS,hostOperation} from '../src/host/operations.js';
import {decodeOwnedGraph} from '../src/host/graph-codec.js';
import {describeGraph} from '../src/training/graph.js';
import {encode} from '../src/values.js';
import {instrumentOperationSource} from '../src/training/operation-reference.js';
import {instrumentBranchSource} from '../src/training/branch-reference.js';

const input=JSON.parse(readFileSync(0,'utf8'));
const broker=createFixtureBroker(input.fixture),operations=[],decisions=[];
const callbackFailures=[];
const invoke=(operation,args)=>broker.invoke(operation,args.map((arg,index)=>
  hostOperation(operation).callbackIndices.includes(index)?(...values)=>{
    queueMicrotask(()=>{try{const result=arg(...values);
      if(result&&typeof result.then==='function')result.catch(error=>callbackFailures.push(String(error)));}
      catch(error){callbackFailures.push(String(error));}});
  }:arg));
const host=Object.create(null);
for(const [method,operation] of Object.entries(HOST_METHODS))
  host[method]=(...args)=>invoke(operation,args);
for(const call of input.fixture.calls)if(call.operation.startsWith('demo.'))
  host[call.operation.slice(5)]=(...args)=>invoke(call.operation,args);
const args=decodeOwnedGraph(JSON.stringify(input.inputGraph));
const capture=(site,value)=>{if(operations.length>=16384)throw new RangeError('Reference operation cap');
  operations.push({site,value:encode(value)});return value;};
const branch=(site,value)=>{decisions.push({site,decision:['bool',!Boolean(value)]});return value;};
const logical=(site,operator,value)=>{decisions.push({site,decision:['bool',operator==='&&'?!value:
  operator==='||'?Boolean(value):value!==null&&value!==undefined]});return value;};
const context=vm.createContext({host,__args:args,__result:undefined,__tracingCapture:capture,
  __tracingBranch:branch,__tracingLogical:logical,
  queueMicrotask:callback=>queueMicrotask(()=>{try{callback();}
    catch(error){callbackFailures.push(String(error));}}),
  console:Object.fromEntries(['log','info','warn','error'].map(method=>[method,(...args)=>
    broker.invoke('platform.console.'+method,args)]))},{codeGeneration:{strings:false,wasm:false}});
if(input.fixture.calls.some(call=>call.operation==='platform.dateNow'))
  context.Date={now:()=>broker.invoke('platform.dateNow',[])};
const source=input.mode==='operations'?instrumentOperationSource(input.source):
  input.mode==='branches'?instrumentBranchSource(input.source):input.source;
try{
  new vm.Script(source+'\n__result = '+input.entry+'.apply(undefined,__args);',
    {filename:'independent-effectful-reference.js'}).runInContext(context,{timeout:input.timeoutMs??5000});
  let value,kind='return';
  try{value=await context.__result;}catch(error){kind='throw';value=error;}
  const outcome={kind,graph:describeGraph([...args,value])};
  process.stdout.write(JSON.stringify({schema:'effectful-reference/4',outcome,
    effects:broker.finish(),operations,decisions,callbackFailures})+'\n');
}catch(error){process.stdout.write(JSON.stringify({schema:'effectful-reference/4',error:String(error.message??error)})+'\n');process.exitCode=1;}
