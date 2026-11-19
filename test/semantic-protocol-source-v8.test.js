import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {createCompletionCapture} from '../src/training/completion-reference.js';
import {createProtocolCompletionCapture} from '../src/semantic/protocol-source-observations-v8.js';

const getter='"use strict";function run(x){const before=x+2;const s=Symbol("key");const o={};let calls=0;Object.defineProperty(o,s,{get:()=>{calls++;return x+3;}});const a=o[s];return before+a+calls;}';
function build(source,args=[]){const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args});runtime.drive();
  const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);return {bundle,compiled};}
async function checked(source,args=[]){const {bundle,compiled}=build(source,args);
  const audit=await auditProtocolSourceV8({bundle,referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph(args)},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');return {bundle,compiled,audit};}

test('source Symbol getter retains rich state, live captures and independently checked arithmetic on both sides',async()=>{
  const {compiled,audit}=await checked(getter,[4]);
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',14]);
  const protocols=compiled.claims.filter(row=>row.kind==='protocol').map(row=>row.record);
  assert(protocols.some(row=>row.kind==='property.define'&&row.key[0]==='symbol'&&row.descriptor.kind==='accessor'));
  assert.equal(protocols.filter(row=>row.kind==='property.get.call').length,1);
  assert.equal(protocols.filter(row=>row.kind==='property.finish').length,1);
  assert.equal(audit.operationAudit.checked,5);assert.equal(audit.completionAudit.checked,11);
  const call=compiled.claims.findIndex(row=>row.record.kind==='property.get.call'),finish=compiled.claims.findIndex(row=>row.record.kind==='property.finish');
  assert(compiled.claims.slice(0,call).some(row=>row.kind==='detail'&&row.record.kind==='compute'));
  assert(compiled.claims.slice(finish+1).some(row=>row.kind==='detail'&&row.record.kind==='compute'));
  assert(compiled.claims.every(row=>!row.line.includes('journalEvents')&&!row.line.includes('sourceId')));
});

test('source Symbol identities, registry keys and reflective key enumeration remain distinct',async()=>{
  const source='"use strict";function run(){const a=Symbol("same"),b=Symbol("same");const r=Symbol.for("registry"),again=Symbol.for("registry");const o={};o[a]=3;o[b]=4;o["\\0symbol:o2"]=5;const keys=Reflect.ownKeys(o);return [a===b,r===again,Symbol.keyFor(r),a.description,keys.length,o[a],o[b],o["\\0symbol:o2"]];}';
  const {compiled}=await checked(source);
  assert.equal(compiled.claims.filter(row=>row.record.kind==='symbol.for').length,2);
  assert(compiled.claims.some(row=>row.record.kind==='property.keys'));
  assert(compiled.claims.some(row=>row.record.kind==='symbol.read'&&row.record.operation==='keyFor'));
});

test('source setter has dynamic this, a live capture, and assignment completion independent of setter return',async()=>{
  const source='"use strict";function run(){let calls=0;const s=Symbol("x");const o={value:1};Object.defineProperty(o,s,{set:function(v){calls++;this.value=v;return 999;}});const result=(o[s]=7);return [result,o.value,calls];}';
  const {compiled}=await checked(source);
  const finish=compiled.claims.find(row=>row.record.kind==='property.finish').record;
  assert.deepEqual(finish.completion,{kind:'normal',value:['num',7]});
  assert(compiled.claims.some(row=>row.record.kind==='allocate'&&row.record.functionKind==='ordinary'));
});

test('new source observation identity protocol does not silently widen historical completions',()=>{
  const a=Symbol('x'),b=Symbol('x'),capture=createProtocolCompletionCapture();
  capture.capture('one','initialize',a);capture.capture('two','initialize',b);capture.capture('three','return',a);
  assert.deepEqual(capture.observations.map(row=>row.value),[['identity','symbol',1],['identity','symbol',2],['identity','symbol',1]]);
  assert.throws(()=>createCompletionCapture().capture('old','return',a),/primitive values/);
});

test('source projection refuses unmodeled hidden state even when the final scalar would match',()=>{
  for(const source of [
    '"use strict";function run(){const s=Symbol("x");const o=new Proxy({x:3},{});return 3;}',
    '"use strict";function run(){class C{};return 3;}',
    '"use strict";function run(){const s=Symbol("x");return s;}',
    '"use strict";async function run(){const s=Symbol("x");return 3;}',
    '"use strict";function run(){const s=Symbol("x");const o={};o[s]=3;return o;}'
  ])assert.throws(()=>build(source),/protocol|boundary|Symbol|primitive|Unsupported|source|data|strict owned/i);
});
