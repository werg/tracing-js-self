import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {createNativeProtocolMetadata,createOwnedProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

test('a function parameter does not capture a same-named outer temporal-dead-zone binding',async()=>{
  const source='"use strict";function run(){const f=(x)=>x+1;const x=4;return f(x);}',
    runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});runtime.drive();
  const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);
  const closure=compiled.claims.find(row=>row.record.kind==='allocate'&&row.record.functionKind==='arrow').record;
  assert.deepEqual(closure.captures,[]);assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',5]);
  const audit=await auditProtocolSourceV8({bundle,referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');
});

test('a forward arrow capture stays uninitialized until publication and reads the live cell after restore',async()=>{
  const source='"use strict";function run(){const marker=Symbol("capture");const f=()=>x;let x=4;const first=f();x=7;return first+f();}',
    result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'forward-arrow-capture'});
  assert(result.exported,result.reason);
  const artifact=result.exported,cut=artifact.public.timeline.findIndex(row=>
    row.fields?.line?.includes('"kind":"allocate"')&&row.fields.line.includes('"binding":"x"'))+1;
  assert(cut>0);
  const partial=RegionExecutionHarness.replay({...artifact.public,timeline:artifact.public.timeline.slice(0,cut)},{requireTerminal:false}),
    closure=[...partial.controller.heap.values()].find(node=>node.captures?.some(capture=>capture.binding==='x')),
    cell=closure.captures.find(capture=>capture.binding==='x').cell;
  assert.equal(partial.controller.locals.has(cell),false);
  const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(partial.checkpoint())));
  assert.equal(restored.controller.locals.has(cell),false);
  for(const row of artifact.public.timeline.slice(cut))
    restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(restored.exportEpisode(),artifact.public);
  assert.deepEqual(restored.controller.completion,{kind:'return',value:['num',11]});
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
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
