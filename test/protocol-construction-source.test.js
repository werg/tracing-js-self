import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,Runtime} from '../src/runtime.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {createConstructionSourceAdapterV8} from '../src/semantic/protocol-construction-source-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {verifyProtocolRegionTrainingCase} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {LANGUAGE_EXPANSION_FAMILIES} from '../fixtures/language-expansion/benchmark.js';
import {issue51ConstructionFixtures,issue51ConstructionUnsupportedControls} from '../fixtures/semantic-regions/objects-issue51-construction.js';
import {SemanticExecutionController} from '../src/semantic/execution-controller.js';
import {restorePromiseAdoptionStateV8} from '../src/semantic/protocol-promise-adoption-v8.js';

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
function startHarness(compiled){
  const harness=new RegionExecutionHarness({sessionId:'construction-source',automaticDelivery:false,now:()=>-Infinity,maxGenerated:16384});
  harness.publishProgram({programId:'program1',source:compiled.source,entry:compiled.entry,capabilities:[]});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'construction-entry',inputGraph:compiled.inputGraph,realmPolicy:'fresh',completionPolicy:'call-return'});
  return harness;
}
function replay(compiled,{checkpoints=false}={}){
  let harness=startHarness(compiled);
  for(const claim of compiled.claims){
    harness.select('invocation1',claim.line);
    if(checkpoints&&['callable.capture','construct.enter','construct.body','construct.finish','construct.target',
      'construct.this','super.bind','super.finish'].includes(claim.record.kind)){
      const restored=RegionExecutionHarness.restore(harness.checkpoint());
      assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(harness.controller));harness=restored;
    }
  }
  assert.deepEqual({kind:harness.controller.completion.kind,graph:harness.controller.observedGraph()},compiled.outcome);
  return harness;
}

test('issue51 retained constructor arrows source-qualify after super substitution and conversion',async()=>{
  assert.deepEqual(issue51ConstructionFixtures.map(row=>row.ancestorIds),issue51ConstructionFixtures.map(()=>['issue51-original-objects']));
  for(const fixture of issue51ConstructionFixtures){
    const result=await verifyProtocolRegionTrainingCase(structuredClone(fixture));
    assert(result.exported,result.reason);
    const reference=result.exported.sidecar.sourceArtifact.sidecar.reference;
    assert.equal(reference.status,'agreed',fixture.id);
    assert.equal(result.exported.sidecar.sourceArtifact.sidecar.outcome.kind,'return',fixture.id);
  }
});

test('constructor-captured arrows refuse unauthenticated scheduled callbacks at selection and restore',async()=>{
  const fixture=issue51ConstructionUnsupportedControls[0];
  const native=vm.runInNewContext(fixture.source+'\nrun()');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(Array.from(native.result),[3,true]);
  const refusal=await verifyProtocolRegionTrainingCase(structuredClone(fixture));
  assert.equal(refusal.exported,undefined);
  assert.match(refusal.reason,/profile|unsupported|outside/i);

  const captured={kind:'closure',functionKind:'arrow',callable:{lexicalConstruction:{frame:'ctor',thisCell:'body:this'}}},
    controller=Object.create(SemanticExecutionController.prototype);
  controller.heap=new Map([['callback',captured]]);
  assert.throws(()=>controller.schedulerClosure('callback'),/authenticated synchronous call frame/);
  controller.jobs=new Map([['job',{closure:'callback'}]]);
  const api={require(condition,message){if(!condition)throw new Error(message);}};
  assert.throws(()=>restorePromiseAdoptionStateV8(controller,api),/unauthenticated constructor capture/);
});

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

test('constructor arrows retain pre-super this, new.target and private brand through super and completion',async()=>{
  const source='"use strict";function run(){class A{}class D extends A{#x=5;constructor(){'+
    'const capture=()=>[this,new.target,this.#x];super();const during=capture();this.capture=capture;this.during=during;}}'+
    'const d=new D();const after=d.capture();return [d.during[0]===after[0],d.during[1]===D,after[1]===D,'+
    'd.during[2]===5,after[2]===5];}',
    {compiled,audit}=await checked(source);
  assert.equal(audit.status,'agreed');
  const completed=replay(compiled);
  assert.deepEqual(completed.controller.materialize(completed.controller.completion.value),[true,true,true,true,true]);
  const records=compiled.claims.map(row=>row.record);
  assert.equal(records.filter(row=>row.kind==='callable.capture').length,1);
  const capture=records.find(row=>row.kind==='callable.capture');
  assert.equal(capture.thisCell.endsWith(':this'),true);
  assert(records.some(row=>row.kind==='construct.target'));
  assert(records.some(row=>row.kind==='construct.this'));
  replay(compiled,{checkpoints:true});
});

test('derived constructor substitution preserves a captured arrow receiver and private brand',async()=>{
  const source='"use strict";function run(){class A{}class D extends A{#x=5;constructor(){'+
    'const capture=()=>[this,new.target,this.#x];super();return {capture};}}const result=new D();'+
    'const captured=result.capture();return [captured[0]!==result,captured[1]===D,captured[2]===5];}',
    {compiled}=await checked(source),harness=replay(compiled);
  assert.deepEqual(harness.controller.materialize(harness.controller.completion.value),[true,true,true]);
  replay(compiled,{checkpoints:true});
});

test('retained constructor frame, receiver cell and active arrow callee reject forged checkpoint state',async()=>{
  const source='"use strict";function run(){class A{}class D extends A{constructor(){'+
    'const capture=()=>[this,new.target];super();this.capture=capture;}}const first=new D();const second=new D();'+
    'const result=first.capture();return result[0]===first&&result[1]===D;}',
    {compiled}=await checked(source),claims=compiled.claims,captures=claims.filter(row=>row.record.kind==='callable.capture');
  assert.equal(captures.length,2);
  const targetAt=claims.findIndex(row=>row.record.kind==='construct.target'&&row.record.invocation!==null);
  assert(targetAt>0,'the retained arrow reads new.target while active');
  let harness=startHarness(compiled);
  for(let i=0;i<=targetAt;i++)harness.select('invocation1',claims[i].line);
  const packet=harness.checkpoint(),state=packet.selected.invocations[0][1].state,
    callable=captures[0].record.object,heapEntry=state.heap.find(([id])=>id===callable),
    lexical=heapEntry[1].callable.lexicalConstruction,frames=state.protocol.construction.frames,
    alternate=frames.find(row=>row.id!==lexical.frame);
  assert(alternate,'a second constructor has a distinct retained frame');
  const restoreForged=mutate=>{
    const restored=RegionExecutionHarness.restore(packet),controller=restored.controller,
      protocol=structuredClone(controller.protocol);
    mutate(controller,protocol);
    assert.throws(()=>restoreProtocolStateV8(controller,protocol),/construction|call frame|lexical|receiver cell|callee/i);
  };
  restoreForged((controller)=>{controller.heap.get(callable).callable.lexicalConstruction.frame=alternate.id;});
  restoreForged((controller)=>{controller.heap.get(callable).callable.lexicalConstruction.thisCell=alternate.bodyInvocation+':this';});
  restoreForged((_controller,protocol)=>{protocol.callFrames.at(-1).callee=['ref',captures[1].record.object];});
  restoreForged((controller)=>{controller.receiver=['undefined'];});
  restoreForged((controller)=>{controller.captureAliases.set('forged',lexical.thisCell);});
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
    ['"use strict";function run(){class A{m(){return 1;}}class B extends A{m(){return super.m();}}const o=new B();return o.m();}',/super property references/],
  ])assert.throws(()=>build(source),reason,source);
});

test('every inherited-getter benchmark input preserves callable capability and one live captured write',async()=>{
  const family=LANGUAGE_EXPANSION_FAMILIES.find(row=>row.id==='getter-captured-write'),source=family.variants[2].source;
  for(const args of family.inputs){
    const result=await verifyRegionTrainingCase({source,entry:family.entry,args,family:family.family});
    assert(result.exported,result.reason);const artifact=result.exported,controller=RegionExecutionHarness.replay(artifact).controller;
    assert.deepEqual(controller.materialize(controller.completion.value),[args[0],1]);
    assert(artifact.sidecar.protocolExtensions.includes('class-private-source/1'));
    const records=artifact.public.timeline.filter(row=>row.kind==='protocol').map(row=>decodeProtocolRecordV8(row.fields.line));
    assert(records.some(row=>row.kind==='callable.define'&&row.constructorKind===null&&!row.classConstructor));
    assert.equal(records.filter(row=>row.kind==='property.get.call').length,1);
    assert(artifact.contexts.some(context=>context.state.protocol?.pendingCalls.length));
  }
});

test('independent callable observations reject a consistently nonconstructible teacher and public replay',async()=>{
  const source='"use strict";function run(){function helper(){return 99;}const kept={helper};const proto={get n(){return 3;}};const o=Object.create(proto);return o.n;}',
    original=Runtime.prototype.commit;let mutant;
  try{
    Runtime.prototype.commit=function(operation,callback,options){return original.call(this,operation,(draft,eventId)=>{
      const result=callback(draft,eventId),code=Object.values(this.programs).flatMap(program=>program.instructions)
        .find(instruction=>instruction.op==='DEF_FN'&&instruction.arg.name==='helper')?.arg.codeId;
      if(code)for(const node of Object.values(draft.heap))if(node.kind==='function'&&node.codeId===code)node.nonConstructible=true;
      return result;
    },options);};
    mutant=build(source); // The archive and its public replay agree on the same incorrect capability.
  }finally{Runtime.prototype.commit=original;}
  assert.deepEqual(mutant.compiled.outcome.graph.roots.at(-1),['num',3]);replay(mutant.compiled);
  await assert.rejects(()=>auditProtocolSourceV8({bundle:mutant.bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:mutant.compiled.outcome}),/metadataAudit.*mismatch/);
});

test('every ordinary-constructor benchmark input qualifies through shared public construction and prototype records',async()=>{
  const family=LANGUAGE_EXPANSION_FAMILIES.find(row=>row.id==='class-instance-state'),source=family.variants[1].source;
  for(const args of family.inputs){
    const result=await verifyRegionTrainingCase({source,entry:family.entry,args,family:family.family});
    assert(result.exported,result.reason);const artifact=result.exported,controller=RegionExecutionHarness.replay(artifact).controller;
    assert.deepEqual(controller.materialize(controller.completion.value),[args[0]+1,args[0]+1]);
    const records=artifact.public.timeline.filter(row=>row.kind==='protocol').map(row=>decodeProtocolRecordV8(row.fields.line));
    assert(records.some(row=>row.kind==='callable.define'&&row.constructorKind==='base'&&!row.classConstructor));
    for(const kind of ['construct.enter','construct.finish','property.define'])assert(records.some(row=>row.kind===kind),kind);
  }
});

test('ordinary construction preserves newTarget early function observations primitive returns and object substitution',async()=>{
  for(const body of [
    'function C(n){this.n=n;this.target=new.target;}const kept=C;function arg(){const before=C;return 4;}const o=new C(arg());return o.target===C?o.n:0;',
    'function C(){this.n=4;return 9;}const o=new C();return o.n;',
    'function C(){this.n=4;return {n:8};}const kept=C;const o=new C();return o.n;',
    'const C=function(n){this.n=n;};const o=new C(4);return o.n;',
    'function C(){this.n=4;}C.prototype={shared:3};const o=new C();return o.n+o.shared;',
    'function A(n){this.n=n;}class C extends A{constructor(n){super(n);}}const o=new C(4);return o.n;'
  ]){const {compiled}=await checked('"use strict";function run(){'+body+'}');replay(compiled,{checkpoints:true});}
});

test('independent ordinary prototype metadata rejects a consistently wrong teacher and public descriptor',async()=>{
  const source='"use strict";function run(){function C(){this.n=4;}const o=new C();return 7;}',
    original=Runtime.prototype.commit;let mutant;
  try{
    Runtime.prototype.commit=function(operation,callback,options){return original.call(this,operation,(draft,eventId)=>{
      const result=callback(draft,eventId);
      for(const node of Object.values(draft.heap))if(node.kind==='function'&&node.prototypeInitialized&&!node.classConstructor)
        node.dataAttributes.prototype.writable=false;
      return result;
    },options);};
    mutant=build(source);
  }finally{Runtime.prototype.commit=original;}
  assert.deepEqual(mutant.compiled.outcome.graph.roots.at(-1),['num',7]);replay(mutant.compiled);
  await assert.rejects(()=>auditProtocolSourceV8({bundle:mutant.bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:mutant.compiled.outcome}),/metadataAudit.*mismatch/);
});
