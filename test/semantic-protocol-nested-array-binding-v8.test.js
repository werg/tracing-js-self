import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

function compile(body){
  const source='"use strict";function run(){'+body+'}';
  const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args:[]});
  runtime.drive();
  const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);
  return {source,bundle,compiled};
}
async function nativeChecked(body){
  const {source,bundle,compiled}=compile(body);
  const audit=await auditProtocolSourceV8({bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');
  assert.equal(audit.completionAudit.status,'agreed');
  assert.equal(audit.metadataAudit.status,'agreed');
  const harness=new RegionExecutionHarness({sessionId:'nested-binding-test',automaticDelivery:false,
    now:()=>-Infinity,maxGenerated:16384});
  harness.publishProgram({programId:'program1',source:compiled.source,entry:compiled.entry,capabilities:[]});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'nested-binding-entry',inputGraph:compiled.inputGraph,realmPolicy:'fresh',completionPolicy:'call-return'});
  for(const claim of compiled.claims)harness.select('invocation1',claim.line);
  assert.deepEqual({kind:harness.controller.completion.kind,graph:harness.controller.observedGraph()},compiled.outcome);
  return {compiled,audit};
}

test('nested variable array patterns retain ordinary iterator guards, defaults and rest order',async()=>{
  const {compiled}=await nativeChecked(
    'let log="";function fallback(){log+="d";return 4;}const [[first=fallback(),...tail]]=[[undefined,2,3]];'+
    'return [first,tail[0],tail[1],log];');
  assert.deepEqual(compiled.outcome.kind,'return');
  const records=compiled.claims.map(row=>row.record);
  assert.equal(records.filter(row=>row.kind==='iterator.arrayGuard').length,2);
  assert(records.some(row=>row.kind==='compute'&&row.fields?.expr?.operator==='==='));
  assert(records.some(row=>row.kind==='allocate'&&row.objectKind==='array'));
});

test('an abrupt nested default closes the active custom outer iterator before catch',async()=>{
  const {compiled,audit}=await nativeChecked(
    'let log="";function fail(){throw 7;}const outer={[Symbol.iterator](){return this;},'+
    'next(){return {done:false,value:[undefined]};},return(){log+="closed";return {};}};'+
    'try{const [[first=fail()]]=outer;}catch(e){return log+e;}');
  const observed=compiled.claims.map(row=>row.record);
  assert(observed.some(row=>row.kind==='throw'));
  assert(compiled.outcome.kind==='return');
  assert.equal(audit.extensionAudit.status,'agreed');
  const rows=audit.observations.extensions.find(row=>row.profile==='custom-iterator-observations/1').rows;
  assert(rows.some(row=>row.kind==='call'&&row.operation==='return'));
  assert(rows.some(row=>row.kind==='call.return'&&row.operation==='return'));
});

test('nested custom iterables without a scoped observer are refused',()=>{
  const source='"use strict";function run(){const inner={};const outer={[Symbol.iterator](){return this;},'+
    'next(){return {done:false,value:inner};},return(){return {};}};const [[first]]=outer;return first;}';
  const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args:[]});runtime.drive();
  assert.throws(()=>compileProtocolSourceV8(runtime.exportRun()),/nested custom iterable binding/i);
});
