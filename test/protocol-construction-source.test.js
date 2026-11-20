import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {createConstructionSourceAdapterV8} from '../src/semantic/protocol-construction-source-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

function build(source,args=[]){
  const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args});runtime.drive();
  const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle,{adapters:[createConstructionSourceAdapterV8]});
  return {bundle,compiled};
}
async function checked(source,args=[]){
  const {bundle,compiled}=build(source,args),audit=await auditProtocolSourceV8({bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph(args)},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');assert(audit.metadataAudit.checked>0);
  return {bundle,compiled,audit};
}
function replay(compiled,{checkpoints=false}={}){
  let harness=new RegionExecutionHarness({sessionId:'construction-source',automaticDelivery:false,now:()=>-Infinity,maxGenerated:16384});
  harness.publishProgram({programId:'program1',source:compiled.source,entry:compiled.entry,capabilities:[]});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'construction-entry',inputGraph:compiled.inputGraph,realmPolicy:'fresh',completionPolicy:'call-return'});
  for(const claim of compiled.claims){
    harness.select('invocation1',claim.line);
    if(checkpoints&&['construct.enter','construct.body','construct.finish','super.bind','super.finish'].includes(claim.record.kind)){
      const restored=RegionExecutionHarness.restore(harness.checkpoint());
      assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(harness.controller));harness=restored;
    }
  }
  assert.deepEqual({kind:harness.controller.completion.kind,graph:harness.controller.observedGraph()},compiled.outcome);
  return harness;
}

test('base class fields and private writes source-qualify and replay through public constructor records',async()=>{
  const source='"use strict";function run(n){const before=n+1;class C{#x=2;y=3;constructor(v){this.#x=v;}m(){return this.#x+this.y;}}const o=new C(before);return o.m();}',
    {compiled,audit}=await checked(source,[3]),records=compiled.claims.map(row=>row.record);
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',7]);
  for(const kind of ['class.link','class.initializer','private.declare','private.define','private.set','private.get',
    'construct.enter','construct.body','construct.finish','construct.this'])assert(records.some(row=>row.kind===kind),kind);
  assert(records.some(row=>row.kind==='allocate'&&row.code?.endsWith(':instance')));
  assert.equal(audit.metadataAudit.status,'agreed');
  const harness=replay(compiled,{checkpoints:true}),state=sharedRegionState(harness.controller);
  assert(JSON.stringify(state).includes('privateElements'));
  assert(compiled.claims.every(row=>!row.line.includes('stateChanges')&&!row.line.includes('journalEvent')));
});

test('derived super retains actual newTarget and private initializer state across public checkpoints',async()=>{
  const source='"use strict";function run(){class A{x=1;constructor(n){this.x=n;this.target=new.target;}}class B extends A{#y=2;constructor(n){super(n);}m(){return this.x+this.#y;}}const o=new B(4);return o.target===B?o.m():0;}',
    {compiled}=await checked(source);
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',6]);
  const records=compiled.claims.map(row=>row.record);
  for(const kind of ['super.select','super.bind','super.finish','construct.target'])assert(records.some(row=>row.kind===kind),kind);
  const enters=records.filter(row=>row.kind==='construct.enter');assert.equal(enters.length,2);
  assert.deepEqual(enters[0].newTarget,enters[1].newTarget);assert.notDeepEqual(enters[0].callee,enters[1].callee);
  replay(compiled,{checkpoints:true});
});

test('default derived constructors and separately branded private methods share public identities',async()=>{
  const source='"use strict";function run(){class A{#x=1;#m(){return this.#x;}a(){return this.#m();}}class B extends A{#x=2;b(){return this.#x;}has(o){return #x in o;}}const o=new B();return o.has(o)?o.a()+o.b():0;}',
    {compiled}=await checked(source),records=compiled.claims.map(row=>row.record);
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',3]);
  const names=records.filter(row=>row.kind==='private.declare'&&row.name==='x');assert.equal(names.length,2);assert.notEqual(names[0].owner,names[1].owner);
  assert(records.some(row=>row.kind==='private.define'&&row.elementKind==='method'));
  assert(records.some(row=>row.kind==='private.has'&&row.result===true));replay(compiled);
});

test('class Symbol methods static private fields and accessor calls retain descriptor evidence',async()=>{
  for(const source of [
    '"use strict";function run(){const s=Symbol("method");class C{static #n=2;static read(){return this.#n;}[s](n){return n+1;}}const o=new C();return o[s](C.read());}',
    '"use strict";function run(){class C{#x=1;get x(){return this.#x;}set x(v){this.#x=v;}}const o=new C();o.x=4;return o.x;}'
  ]){const {compiled}=await checked(source);replay(compiled);}
});

test('primitive constructor returns keep the receiver and unused classes keep independent metadata',async()=>{
  for(const source of [
    '"use strict";function run(){class C{x=1;constructor(){return 8;}}const o=new C();return o.x;}',
    '"use strict";function run(){class C{static #x=3;m(){return 2;}}return 7;}'
  ]){
    const {compiled,audit}=await checked(source);replay(compiled);
    assert(audit.observations.metadata.at(-1).objects.some(node=>node.annotations?.some(row=>row.name==='class/1')));
  }
});

test('private prefix and postfix updates convert scalar values and verify the actual stored result',async()=>{
  for(const source of [
    '"use strict";function run(){class C{#x="2";m(){const old=this.#x++;return old+ ++this.#x;}}const o=new C();return o.m();}',
    '"use strict";function run(){class C{#x=4n;m(){const old=this.#x--;return old+ --this.#x;}}const o=new C();return o.m();}'
  ]){const {compiled}=await checked(source);replay(compiled);assert.equal(compiled.claims.filter(row=>row.record.kind==='private.set').length,2);}
});

test('class methods retain their initialized class-name capture through construction checkpoints',async()=>{
  const source='"use strict";function run(){class C{m(){return C;}}const original=C;const o=new C();C=3;return o.m()===original;}',
    {compiled}=await checked(source);
  assert.deepEqual(compiled.outcome.graph.roots.at(-1),['bool',true]);
  const method=compiled.claims.find(row=>row.record.kind==='allocate'&&row.record.captures?.some(capture=>capture.binding==='C'));
  assert(method,'the method must retain its inner class-name cell');
  replay(compiled,{checkpoints:true});
});

test('abrupt field initialization preserves thrown values and skips the remaining constructor work',async()=>{
  for(const source of [
    '"use strict";function run(){function fail(){throw 7;}class C{x=fail();constructor(){throw 9;}}return new C();}',
    '"use strict";function run(){function fail(){throw 7;}class B{}class D extends B{x=fail();constructor(){super();throw 9;}}return new D();}',
    '"use strict";function run(){function fail(){throw 7;}class B{x=fail();constructor(){throw 9;}}class D extends B{y=9;constructor(){super();throw 11;}}return new D();}',
    '"use strict";function run(){class C{static{throw 7;}}return 9;}'
  ]){
    const {compiled}=await checked(source),records=compiled.claims.map(row=>row.record);
    assert.equal(compiled.outcome.kind,'throw');assert.deepEqual(compiled.outcome.graph.roots.at(-1),['num',7]);
    if(!source.includes('static{'))assert(records.some(row=>row.kind==='construct.finish'&&row.completion.kind==='throw'));
    replay(compiled,{checkpoints:true});
  }
});

test('unmodeled class continuations remain explicit source refusals even with a scalar result',()=>{
  for(const [source,reason]of [
    ['"use strict";function run(){class C{get #x(){return 1;}}return 3;}',/private accessor/i],
    ['"use strict";function run(){class C{constructor(){this.f=()=>new.target;}}const o=new C();return 3;}',/heap kind or metadata|lexical constructor/],
    ['"use strict";function run(){class A{m(){return 1;}}class B extends A{m(){return super.m();}}const o=new B();return o.m();}',/super property references/],
  ])assert.throws(()=>build(source),reason,source);
});
