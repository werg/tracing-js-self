import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {createNativeProtocolMetadata,createOwnedProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {prepareProtocolObservationExtensionsV8} from '../src/semantic/protocol-source-observations-v8.js';
import {applyProtocolRecordV8,createProtocolStateV8,PROTOCOL_MACHINE_API_V8,restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {applyMemoryRecordV8,restoreMemoryStateV8} from '../src/semantic/protocol-memory-v8.js';

function archive(source){const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});runtime.drive();return runtime.exportRun();}

test('producer adapters declare their exact profile and preserve ordinary state checking',()=>{
  const bundle=archive('"use strict";function run(){const o={n:3};return o.n+1;}');
  const adapter={id:'test-arithmetic/1',event(ctx,event,row){
    if(!row||!['primitive.binary','spec.operation.complete'].includes(event.operation))return false;
    ctx.emit({kind:'compute',expr:{op:'binary',operator:'+',left:{op:'literal',value:row.operands[0]},
      right:{op:'literal',value:row.operands[1]}},result:row.result,bind:null},event,'source-test-adapter/1');return true;
  }};
  const compiled=compileProtocolSourceV8(bundle,{adapters:[adapter]});
  assert.deepEqual(compiled.extensions,['test-arithmetic/1']);assert.equal(compiled.sourceProfile,'protocol-source-extensions/1');
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',4]);
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[{id:'bad/1',heapFields:()=>[]}]}),/complete state check/);
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[{id:'bad/1',heapFields:()=>[],checkHeap:()=>false}]}),/complete heap comparison/);
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[{...adapter,event(ctx,event,row){
    if(!row||!['primitive.binary','spec.operation.complete'].includes(event.operation))return false;
    ctx.emit({kind:'compute',expr:{op:'literal',value:['num',99]},result:row.result,bind:null},event);return true;
  }}]}),/computation|claim|result/);
});

test('extension annotations share independently assigned identities with ordinary descriptor values',()=>{
  const secret={},object={child:secret};
  const native=createNativeProtocolMetadata({initialValues:[object],adapters:[{nativeNode(value,ctx){
    if(value!==object)return null;return {...ctx.defaultNode(value),annotations:[{name:'private/1',values:[secret],data:{brand:'field',version:1}}]};
  }}]});
  const state={heap:{o1:{kind:'object',properties:{child:{value:['ref','o2']}}},o2:{kind:'object',properties:{}}}};
  const bundle={initialState:state,entrySpec:{arguments:[['ref','o1']]}};
  const owned=createOwnedProtocolMetadata(bundle,{adapters:[{ownedNode(value,ctx){
    if(value[1]!=='o1')return null;assert.equal(ctx.state,state);
    return {...ctx.defaultNode(value),annotations:[{name:'private/1',values:[['ref','o2']],data:{brand:'field',version:1}}]};
  }}]});
  const expected=native.observe('site','initialize',object),observed=owned.observe({row:{site:'site',kind:'initialize'},tag:['ref','o1'],state});
  assert.deepEqual(observed,expected);
  assert.deepEqual(expected.objects[0].annotations[0].values,[expected.objects[0].properties[0].descriptor.value]);
  let calls=0;const proxy=new Proxy({}, {ownKeys(){calls++;return [];}});
  const guarded=createNativeProtocolMetadata({adapters:[{nativeNode(){calls++;return {kind:'function'};}}]});
  assert.throws(()=>guarded.observe('proxy','initialize',proxy),/Proxy metadata/);assert.equal(calls,0);
});

test('annotation data cannot run a getter or hide noncanonical guest state',()=>{
  let calls=0;const object={},data={get value(){calls++;return 3;}};
  const native=createNativeProtocolMetadata({adapters:[{nativeNode(value,ctx){
    return {...ctx.defaultNode(value),annotations:[{name:'invalid/1',values:[],data}]};
  }}]});
  assert.throws(()=>native.observe('site','initialize',object),/non-data JSON object/);assert.equal(calls,0);
});

test('observation extensions only instrument completion mode and cannot overwrite capture globals',()=>{
  let created=0;const adapter=({side})=>{created++;return {id:'test-observer/1',
    globals:{__tracingProtocolRegister:()=>side},instrument:text=>text+'\n/* metadata */',metadataAdapter:{}};};
  const original=prepareProtocolObservationExtensionsV8({source:'source',mode:'original',adapters:[adapter]});
  assert.equal(original.instrument('unchanged'),'unchanged');assert.equal(created,0);
  const completion=prepareProtocolObservationExtensionsV8({source:'source',mode:'completions',adapters:[adapter]});
  assert.equal(completion.instrument('already instrumented'),'already instrumented\n/* metadata */');
  assert.equal(completion.globals.__tracingProtocolRegister(),'native');assert.equal(completion.metadataAdapters.length,1);
  assert.throws(()=>prepareProtocolObservationExtensionsV8({adapters:[{id:'bad',globals:{__tracingCapture:()=>{}}}]}),/reserved name/);
  assert.throws(()=>prepareProtocolObservationExtensionsV8({adapters:[adapter,adapter]}),/Distinct observation extension/);
});

test('independent call observers compose once and retain bounded private observation receipts',()=>{
  const rows=[],receiver={},fn=function(value){assert.equal(this,receiver);rows.push('call');return value+1;};let invoke;
  const extension=prepareProtocolObservationExtensionsV8({source:'',adapters:[
    {id:'first/1',setCallObserver(value){invoke=value;},observeCall(call,next){assert.equal(call.callee,fn);rows.push('first');return next();},
      observations:()=>rows.map(kind=>({kind}))},
    {id:'second/1',observeCall(call,next){rows.push('second');return next();}}
  ]});
  assert.equal(invoke({callee:fn,receiver,arguments:[3]}),4);
  assert.deepEqual(rows,['first','second','call']);
  assert.deepEqual(extension.observations(),[{profile:'first/1',rows:rows.map(kind=>({kind}))}]);
  const invalid=prepareProtocolObservationExtensionsV8({adapters:[{id:'bad/1',observations:()=>[{get value(){throw Error('must not execute');}}]}]});
  assert.throws(()=>invalid.observations(),/non-data JSON object/);
});

test('trusted machine components share the authoritative heap and reserved identity checks',()=>{
  const c={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
    frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};
  const api=PROTOCOL_MACHINE_API_V8;assert(Object.isFrozen(api));
  applyProtocolRecordV8(c,{kind:'symbol.create',id:'o1',description:['str','reserved']});
  assert.throws(()=>applyMemoryRecordV8(c,{kind:'memory.construct',constructor:'ArrayBuffer',name:'o1',backing:null,arguments:[['num',4]]},api),/duplicate allocation/);
  applyMemoryRecordV8(c,{kind:'memory.construct',constructor:'ArrayBuffer',name:'buffer',backing:null,arguments:[['num',4]]},api);
  applyMemoryRecordV8(c,{kind:'memory.construct',constructor:'Uint8Array',name:'bytes',backing:null,arguments:[['ref','buffer']]},api);
  applyMemoryRecordV8(c,{kind:'memory.set',object:'bytes',key:['str','1'],value:['num',257]},api);
  applyMemoryRecordV8(c,{kind:'memory.get',object:'bytes',key:['str','1'],result:['num',1]},api);
  const expected=new Uint8Array(4);expected[1]=257;
  assert.deepEqual(c.heap.get('buffer').bytes,[...expected]);assert.equal(restoreMemoryStateV8(c,api).valid,true);
  const unrelated={...c,heap:new Map([['future',{kind:'hidden-state',properties:new Map()}]])};
  assert.throws(()=>restoreProtocolStateV8(unrelated,createProtocolStateV8()),/undeclared protocol heap kind/);
});

test('the independent worker dependency graph cannot import producer protocol execution',async()=>{
  const {readFile}=await import('node:fs/promises'),{parse}=await import('acorn');
  const seen=new Set(),forbidden=new Set(['runtime.js','frontend.js','protocol-state-v8.js','protocol-codec-v8.js',
    'protocol-source-compiler-v8.js','protocol-source-v8.js','protocol-memory-v8.js','protocol-construction-v8.js',
    'protocol-iterator-v8.js','protocol-iterator-source-v8.js',
    'protocol-enumeration-v8.js','protocol-enumeration-source-v8.js',
    'owned-number-conversion.js','protocol-number-v8.js','protocol-number-source-v8.js',
    'protocol-proxy-v8.js','protocol-proxy-source-v8.js',
    'protocol-machine-extensions-v8.js','protocol-source-extensions-v8.js','region-harness.js','regions.js']);
  async function visit(url){if(seen.has(url.href))return;seen.add(url.href);
    assert(!forbidden.has(url.pathname.split('/').at(-1)),`independent worker imports producer authority ${url.pathname}`);
    const ast=parse(await readFile(url,'utf8'),{sourceType:'module',ecmaVersion:'latest'});
    for(const statement of ast.body)if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(statement.type)&&statement.source?.value.startsWith('.'))
      await visit(new URL(statement.source.value,url));
  }
  await visit(new URL('../tools/protocol-reference-v8.mjs',import.meta.url));assert(seen.size>5);
});
