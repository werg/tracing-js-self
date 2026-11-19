import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {createNativeProtocolMetadata,createOwnedProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';

test('a function parameter does not capture a same-named outer temporal-dead-zone binding',async()=>{
  const source='"use strict";function run(){const f=(x)=>x+1;const x=4;return f(x);}',
    runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});runtime.drive();
  const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);
  const closure=compiled.claims.find(row=>row.record.kind==='allocate'&&row.record.functionKind==='arrow').record;
  assert.deepEqual(closure.captures,[]);assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',5]);
  const audit=await auditProtocolSourceV8({bundle,referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');
  const actualCapture=createRuntime().startEntry({text:'"use strict";function run(){const f=()=>x;const x=4;return f();}',functionName:'run',args:[]});
  actualCapture.drive();assert.throws(()=>compileProtocolSourceV8(actualCapture.exportRun()),/capture requires an initialized owned cell/);
});

test('an own data property named constructor is not an inherited accessor dictionary member',()=>{
  const object={constructor:3,get x(){return 4;}},native=createNativeProtocolMetadata(),
    state={heap:{o:{kind:'object',properties:{constructor:{value:['num',3]}},propertyOrder:['constructor','x'],
      accessors:{x:{get:{value:['ref','get']},set:{value:['undefined']},enumerable:true,configurable:true}}},get:{kind:'function'}}},
    bundle={initialState:state,entrySpec:{arguments:[]}},owned=createOwnedProtocolMetadata(bundle),
    expected=native.observe('site','initialize',object),observed=owned.observe({row:{site:'site',kind:'initialize'},tag:['ref','o'],state});
  assert.deepEqual(observed,expected);
  assert.deepEqual(observed.objects[0].properties[0].descriptor,
    {kind:'data',value:['num',3],writable:true,enumerable:true,configurable:true});
});
