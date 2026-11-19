import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {applyProtocolRecordV8,createProtocolStateV8} from '../src/semantic/protocol-state-v8.js';

async function checked(body){
  const source='"use strict";function run(){'+body+'}',runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});
  runtime.drive();const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle),audit=await auditProtocolSourceV8({bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');return compiled;
}
test('object literal methods define own data properties without reading inherited intrinsic function values',async()=>{
  const compiled=await checked('const o={valueOf:()=>7,toString:()=>"eight"};return [o.valueOf(),o.toString()];');
  for(const name of ['valueOf','toString'])assert(compiled.claims.some(row=>row.record.kind==='property.define'&&row.record.key[1]===name));
});
test('object literal definitions do not call an inherited setter',async()=>{
  const compiled=await checked('let hits=0;const proto={};Object.defineProperty(proto,"x",{set:function(v){hits+=v;},configurable:true});const o={__proto__:proto,x:3};return [hits,o.x];');
  const array=compiled.outcome.graph.objects.at(-1);assert.deepEqual(array.properties.slice(0,2),[['0',['num',0]],['1',['num',3]]]);
});
test('ordinary assignment can shadow writable inherited Object methods',async()=>{
  const compiled=await checked('const o={};o.toString=()=>"seven";o.valueOf=()=>7;return [o.toString(),o.valueOf()];');
  assert.equal(compiled.claims.filter(row=>row.record.kind==='property.set').length,4);
});
test('shadowing preserves readonly own data and accessor refusal boundaries',()=>{
  const controller={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['root'],
    frameFunctions:new Map([['root','run']]),protocol:createProtocolStateV8(),completion:null};
  const apply=record=>applyProtocolRecordV8(controller,record);
  apply({kind:'allocate',name:'o1',objectKind:'object',code:null,captures:[],functionKind:null,lexicalReceiver:null,length:null,properties:[]});
  apply({kind:'property.define',object:'o1',key:['str','valueOf'],descriptor:{kind:'data',value:['num',1],writable:false,enumerable:true,configurable:true},success:true});
  apply({kind:'property.set',object:'o1',key:['str','valueOf'],receiver:['ref','o1'],value:['num',2],success:false});
  assert.deepEqual(controller.heap.get('o1').properties.get('valueOf'),['num',1]);
  assert.throws(()=>apply({kind:'property.set',object:'o1',key:['str','__proto__'],receiver:['ref','o1'],value:['null'],success:true}),/inherited intrinsic/);
  assert.throws(()=>apply({kind:'property.get',object:'o1',key:['str','toString'],receiver:['ref','o1'],result:['undefined']}),/inherited intrinsic/);
});
