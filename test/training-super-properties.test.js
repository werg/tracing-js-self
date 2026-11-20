import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {parseTraining} from '../src/training/profile.js';
import {independentEffectfulReference} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {describeGraph,realizeGraph} from '../src/training/graph.js';
import {referenceOutcome} from '../src/training/reference.js';
import {replayExact} from '../src/replay.js';
import {isDeepStrictEqual} from 'node:util';

// These two evaluation-order cases expose known V8 oracle limitations. Preserve
// the pinned specification result, and make the independent disagreement visible.
function specOrder(body,expected,knownNativeDeviation,t){
  const source='"use strict";function run(){'+body+'}',runtime=createRuntime().startEntry({text:source,functionName:'run'});
  runtime.drive();const bundle=runtime.exportRun();
  assert.deepEqual(realizeGraph(runtime.state.heap,[runtime.result])[0],expected);
  assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
  const observed=referenceOutcome({source,entry:'run',args:[],initialHeap:bundle.initialState.heap});
  assert.equal(observed.kind,'return');
  if(!isDeepStrictEqual(observed.graph,describeGraph([expected]))){
    assert.deepEqual(observed.graph,describeGraph([knownNativeDeviation]));
    t.diagnostic('Native reference disagrees with pinned ECMAScript 2026 super evaluation order; this case is not reference-qualified.');
  }
}

test('super methods and accessors use their home prototype with the actual call receiver',()=>{
  runtimeDifferential('class B{m(){return this.x;}get v(){return this.x;}set v(x){this.x=x;}}class D extends B{x=3;m(){return super.m()+super.v;}set(x){super.v=x;return this.x;}}const d=new D();return [d.m(),d.set(7),d.x];');
  runtimeDifferential('class B{get m(){return function(){return this.x;};}}class D extends B{x=4;m(){return super.m();}}return (new D()).m();');
  runtimeDifferential('class B{m(){return this.x;}}class D extends B{m(){return ()=>super.m();}}const other={x:8,f:D.prototype.m};const arrow=other.f();return arrow();');
  runtimeDifferential('const p={m(){return this.x;}};const o={__proto__:p,x:3,m(){return super.m();}};const q={x:7,f:o.m};return [o.m(),q.f()];');
});
test('static methods fields blocks and private methods retain the correct home object',()=>{
  runtimeDifferential('class B{static x=3;static m(){return this.x;}m(){return 2;}}class D extends B{static x=4;static m(){return super.m()+super.x;}x=super.m();#m(){return super.m();}read(){return this.#m();}static{this.z=super.m();}}const d=new D();return [D.m(),D.z,d.x,d.read()];');
  runtimeDifferential('class B{m(){return this.x;}}class D extends B{constructor(){super();this.x=4;this.f=()=>super.m();}}return (new D()).f();');
  runtimeDifferential('class B{tag(s,x){return [s[0],x,this.v];}}class D extends B{v=9;m(){return super.tag`a${3}`;}}return (new D()).m();');
});
test('super lookup observes live home changes after key evaluation and captures before RHS evaluation',t=>{
  runtimeDifferential('class B{m(){return 1;}}class C{m(){return 2;}}class D extends B{m(){return super[(Object.setPrototypeOf(D.prototype,C.prototype),"m")]();}}return (new D()).m();');
  specOrder('let log=[];class B{set x(v){log.push("B",v);}}class C{set x(v){log.push("C",v);}}class D extends B{m(){super.x=(Object.setPrototypeOf(D.prototype,C.prototype),7);}}new D().m();return log;',['B',7],['C',7],t);
  runtimeDifferential('let keys=0;class B{}class D extends B{constructor(){try{super[(keys++,"x")];}catch(e){return {name:e.name};}}}const d=new D();return [d.name,keys];');
  runtimeDifferential('class B{m(){return 1;}}class C{m(){return 2;}}class D extends B{m(){return super.m();}}const d=new D(),a=d.m();Object.setPrototypeOf(D.prototype,C.prototype);return [a,d.m()];');
});
test('super writes use receiver own data without calling receiver accessors',()=>{
  runtimeDifferential('class B{}B.prototype.x=1;class D extends B{m(){super.x=4;return [this.x,super.x];}}return (new D()).m();');
  runtimeDifferential('let hits=0;class B{}B.prototype.x=1;class D extends B{set x(v){hits++;}m(){super.x=4;return [this.x,hits];}}return (new D()).m();');
  runtimeDifferential('let hits=0;class B{}B.prototype.x=1;class D extends B{m(){Object.defineProperty(this,"x",{set(v){hits++;}});try{super.x=4;}catch(e){return [e.name,hits];}}}return (new D()).m();');
  runtimeDifferential('class B{get x(){return 2;}}class D extends B{m(){try{super.x=4;}catch(e){return e.name;}}}return (new D()).m();');
  runtimeDifferential('class B{}B.prototype.x=2;class D extends B{m(){const result=super.x+=3;return [result,this.x,super.x];}}return (new D()).m();');
});
test('super uses Symbol keys and explicitly supported intrinsic methods without losing null-base errors',()=>{
  runtimeDifferential('const k=Symbol("m");class B{[k](){return this.x;}}class D extends B{x=5;m(){return super[k]();}}return (new D()).m();');
  runtimeDifferential('class C{m(){return super.valueOf()===this;}}return (new C()).m();');
  runtimeDifferential('class C{m(){return super.x;}}Object.setPrototypeOf(C.prototype,null);try{return (new C()).m();}catch(e){return e.name;}');
});
test('super constructor selection precedes argument effects and arrow home state survives JSON restoration',t=>{
  specOrder('let log=[];class B{constructor(){log.push("B");}}class E{constructor(){log.push("E");}}class D extends B{constructor(){super(Object.setPrototypeOf(D,E));}}new D();new D();return log;',['B','E'],['E','E'],t);
  const source='"use strict";function run(){class B{m(){return this.x;}}class D extends B{x=7;m(){return ()=>super.m();}}const fn=(new D()).m();return fn();}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!Object.values(original.state.heap).some(value=>value.arrow&&value.codeId))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),JSON.parse(JSON.stringify(original.exportRun())));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  const forged=structuredClone(restored.exportRun()),reference=forged.events.find(event=>event.operation==='reference.super');
  reference.result[1]=['null'];
  assert.throws(()=>validateBundle(forged),/Super reference/);
});
test('super calls and writes have independent completion receipts and bounded exclusions',async()=>{
  const source='"use strict";function run(){class B{m(){return this.x;}}B.prototype.x=2;class D extends B{m(){super.x=4;return super.m();}}return (new D()).m();}';
  const {bundle}=runtimeDifferential(null,{source});
  const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
  const comparison=compareCompletionObservations(ownedCompletionObservations(bundle,source),reference.completions);
  assert.equal(comparison.status,'agreed',JSON.stringify(comparison));
  for(const expression of ['super.x++','super.x??=2'])
    assert.throws(()=>parseTraining('"use strict";function run(){class B{m(){'+expression+';}}}'),/super .*profile/i);
});
