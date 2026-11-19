import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {independentEffectfulReference} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

test('ordinary derived construction links prototype chains and forwards actual newTarget',()=>{
  runtimeDifferential('class B {x=1;constructor(x){this.x=x;}m(){return this.x;}}class D extends B {y=2;constructor(x){super(x+1);this.z=3;}}const d=new D(4);return [d.m(),d.y,d.z,d instanceof B,d instanceof D,Object.getPrototypeOf(D)===B,Object.getPrototypeOf(D.prototype)===B.prototype];');
  runtimeDifferential('class B {constructor(){this.t=new.target;}}class M extends B {}class D extends M {#x=2;read(){return this.#x;}}const d=new D();return [d.t===D,d instanceof B,d instanceof M,d.read()];');
  runtimeDifferential('function B(x){this.x=x;this.t=new.target;}class D extends B {}const d=new D(4);return [d.x,d.t===D];');
  runtimeDifferential('function B(){}B.prototype=Object.prototype;class D extends B{}return new D() instanceof Object;');
});
test('base fields precede base parameters and derived fields follow super before its call completes',()=>{
  runtimeDifferential('let log=[];class B {b=(log.push("basefield"),1);constructor(x=(log.push("baseparam"),2)){log.push("basebody");}}class D extends B {d=(log.push("derivedfield"),2);constructor(x=(log.push("derivedparam"),3)){log.push("before");super();log.push("after");}}new D();return log;');
  runtimeDifferential('class B {#x=1;base(){return this.#x;}}class D extends B {#x=2;derived(){return this.#x;}}const d=new D();return [d.base(),d.derived(),Object.keys(d)];');
  runtimeDifferential('let fields=0;class B {constructor(){return {x:7};}}class D extends B {x=(fields++,9);#y=3;read(){return this.#y;}constructor(){const value=super();value.z=4;}}const d=new D();return [d.x,d.z,fields];');
  runtimeDifferential('class B {constructor(){return [];}}class D extends B {x=3;#y=4;constructor(){super();this.read=()=>this.#y;}}const d=new D();return [Array.isArray(d),d.x,d.read()];');
});
test('derived this is a live lexical cell across arrows and super may be called through an arrow',()=>{
  runtimeDifferential('class B {}class D extends B {constructor(){const f=()=>this;let before;try{f();}catch(e){before=e.name;}super();this.f=f;this.before=before;}}const d=new D();return [d.before,d.f()===d];');
  runtimeDifferential('class B {constructor(x){this.x=x;}}class D extends B {constructor(...args){const call=()=>super(...args);call();this.target=()=>new.target;}}const d=new D(4);return [d.x,d.target()===D];');
});
test('derived returns failures and repeated super preserve abrupt evaluation order',()=>{
  for(const action of ['this.x=1;','return;','return 3;'])
    runtimeDifferential('class B{}class D extends B{constructor(){'+action+'}}try{new D();}catch(e){return e.name;}');
  runtimeDifferential('let calls=0;class B{constructor(){calls++;}}class D extends B{constructor(){super();super();}}try{new D();}catch(e){return [e.name,calls];}');
  runtimeDifferential('let log=[];class B{}class D extends B{constructor(){try{return 3;}finally{log.push("finally");}}}try{new D();}catch(e){return [e.name,log];}');
  runtimeDifferential('class B{}class D extends B{constructor(){return {x:4};}}return (new D()).x;');
  runtimeDifferential('class B{constructor(){throw 7;}}class D extends B{constructor(){try{super();}catch(e){return {x:e};}}}return (new D()).x;');
});
test('static inheritance preserves dynamic receiver methods accessors and protocol hooks',()=>{
  runtimeDifferential('class B {static x=2;static m(){return this.x;}}class D extends B {static x=3;}return [D.m(),B.m()];');
  runtimeDifferential('class B {static get x(){return this.y;}static set x(v){this.y=v;}}class D extends B {}D.x=7;return [D.x,B.x];');
  runtimeDifferential('class B {static [Symbol.hasInstance](x){return x===3;}}class D extends B {}return [3 instanceof D,4 instanceof D];');
  runtimeDifferential('class B {static a=1;}class D extends B {static b=2;}let keys=[];for(const key in D)keys.push(key);return keys;');
});
test('extends null invalid heritage and altered super constructors retain their distinctions',()=>{
  runtimeDifferential('class N extends null {constructor(){return {x:3};}}return (new N()).x;');
  runtimeDifferential('class N extends null {}try{new N();}catch(e){return [e.name,Object.getPrototypeOf(N.prototype)===null];}');
  runtimeDifferential('try{class D extends (()=>3){}}catch(e){return e.name;}');
  runtimeDifferential('function B(){}B.prototype=3;try{class D extends B{}}catch(e){return e.name;}');
  runtimeDifferential('class B{constructor(){this.x=1;}}class E{constructor(){this.x=2;}}class D extends B{}Object.setPrototypeOf(D,E);return (new D()).x;');
});
test('derived continuation restores between super result and field initialization with independent receipts',async()=>{
  const source='"use strict";function run(){let log=[];class B{constructor(){log.push("base");}}class D extends B{x=(log.push("field"),3);constructor(){super();log.push("body");}}const d=new D();return [d.x,log];}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!Object.values(original.state.frames).some(frame=>frame.superInitializedResult))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(original.exportRun())),JSON.parse(JSON.stringify(restored.exportRun())));
  const bundle=restored.exportRun();assert.equal(validateBundle(bundle).valid,true);
  const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
  const comparison=compareCompletionObservations(ownedCompletionObservations(bundle,source),reference.completions);
  assert.equal(comparison.status,'agreed',JSON.stringify(comparison));
  const forged=structuredClone(bundle),binding=forged.events.find(e=>e.stateChanges.some(p=>p.before?.thisInitialized===false&&p.after?.thisInitialized===true));
  binding.stateChanges.find(p=>p.before?.thisInitialized===false&&p.after?.thisInitialized===true).after.thisValue=['null'];
  assert.throws(()=>validateBundle(forged),/Super result/);
});
test('builtin heritage and custom spread protocols remain explicit execution refusals',()=>{
  for(const body of ['class D extends Array {}return new D();',
    'class B{}class D extends B{constructor(){const xs=[];xs[Symbol.iterator]=function*(){yield 1;};super(...xs);}}return new D();']){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});
    assert.throws(()=>runtime.drive(),/Builtin class heritage|Spread requires/);
  }
});
