import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {independentEffectfulReference,verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

test('base class fields precede parameter defaults and public methods remain on the prototype',()=>{
  runtimeDifferential('let log=[];class C {x=(log.push("field"),2);constructor(x=(log.push("param"),this.x)){log.push("body");this.y=x;}get(){return this.y;}}const c=new C();return [c.get(),log,Object.keys(c),Object.keys(C.prototype),c.constructor===C];');
  runtimeDifferential('class C {x=1;get y(){return this.x+1;}set y(v){this.x=v;}f=()=>this.x;}const c=new C();c.y=7;const f=c.f;return [c.y,f()];');
  runtimeDifferential('class C {x=1;constructor(){return {y:2};}}return Object.keys(new C());');
});
test('computed names evaluate once before static initialization and preserve key identity',()=>{
  runtimeDifferential('let log=[];const key=Symbol("k");class C {[(log.push("key1"),key)]=(log.push("field"),3);static [(log.push("key2"),"x")]=(log.push("static"),4);static {log.push(this.x);}}const before=log.slice();const a=new C(),b=new C();return [before,log,a[key],b[key],Object.getOwnPropertySymbols(a)[0]===key];');
  runtimeDifferential('class C {value=C;}const D=C;C=0;return (new D()).value===D;');
  runtimeDifferential('try{class C {[C](){}}}catch(e){return e.name;}');
});
test('private fields and methods use fresh lexical brands and readonly method slots',()=>{
  runtimeDifferential('class C {#x=2;#inc(y){return this.#x+y;}read(){return this.#inc(3);}bump(){return this.#x++;}set(x){this.#x=x;return ++this.#x;}method(){return this.#inc;}static has(o){return #x in o;}}const a=new C(),b=new C();return [a.read(),a.bump(),a.set(9),b.read(),a.method()===b.method(),C.has(a),C.has({}),C.has(new Proxy(a,{})),Object.keys(a)];');
  runtimeDifferential('function make(){return class {#x=3;static has(o){return #x in o;}};}const A=make(),B=make();return [A.has(new A()),A.has(new B())];');
  runtimeDifferential('class C {#m(){}fail(){this.#m=3;}}try{(new C()).fail();}catch(e){return e.name;}');
  runtimeDifferential('class C {#x;static has(o){return #x in o;}}try{C.has(1);}catch(e){return e.name;}');
});
test('private initialization is ordered and abrupt construction keeps only completed slots',()=>{
  runtimeDifferential('let escaped;class C {#m(){return 7;}a=this.#m();#x=(escaped=this,3);#y=(()=>{throw 9;})();static x(o){return o.#x;}static hasY(o){return #y in o;}}try{new C();}catch(e){return [e,escaped.a,C.x(escaped),C.hasY(escaped)];}');
  runtimeDifferential('class C {x=this.#later;#later=3;}try{new C();}catch(e){return e.name;}');
  runtimeDifferential('class C {#x=3;static read(o){return o.#x;}}try{C.read({});}catch(e){return e.name;}');
});
test('static fields blocks accessors and private methods retain their class receiver',()=>{
  runtimeDifferential('class C {static #x=2;static #inc(){return ++this.#x;}static y=this.#inc();static {this.y+=3;}static get z(){return this.#x;}static set z(v){this.#x=v;}static read(){return C.#x;}}C.z=9;return [C.y,C.z,C.read(),Object.keys(C)];');
  runtimeDifferential('class C {static {var x=3;this.a=x;}static {var x=7;this.b=x;}}return [C.a,C.b];');
});
test('class calls and construction of methods fail with owned TypeErrors',()=>{
  runtimeDifferential('let log=[];class C {constructor(x=(log.push(1),2)){log.push(3);}}try{C();}catch(e){return [e.name,log];}');
  runtimeDifferential('class C {}try{[1].map(C);}catch(e){return e.name;}');
  runtimeDifferential('class C {m(){return 1;}}const m=C.prototype.m;try{new m();}catch(e){return e.name;}');
  runtimeDifferential('class C {}try{C.prototype={};}catch(e){return e.name;}');
  runtimeDifferential('try{class C {static ["prototype"](){}}}catch(e){return e.name;}');
  runtimeDifferential('class C {m(){}}return C.prototype.m.prototype;');
});
test('private state survives JSON restoration and independent mutation checks',()=>{
  const source='"use strict";function run(){class C {#x=2;bump(){return ++this.#x;}read(){return this.#x;}}const c=new C();c.bump();return c.read();}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!Object.values(original.state.heap).some(x=>Object.keys(x.privateSlots??{}).length))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(original.exportRun())),JSON.parse(JSON.stringify(restored.exportRun())));
  assert.equal(validateBundle(restored.exportRun()).valid,true);assert.equal(replayExact(restored.exportRun()).valid,true);
  const forged=structuredClone(restored.exportRun());
  const event=forged.events.find(e=>e.stateChanges.some(p=>p.table==='heap'&&p.before?.privateSlots&&p.after?.privateVersions&&JSON.stringify(p.before.privateSlots)!==JSON.stringify(p.after.privateSlots)));
  const patch=event.stateChanges.find(p=>p.table==='heap'&&p.after?.privateSlots);
  patch.after.privateSlots[Object.keys(patch.after.privateSlots)[0]].value=['num',99];
  assert.throws(()=>validateBundle(forged),/Private write/);
});
test('private assignment source receipts agree and public private state remains refused',async()=>{
  const source='"use strict";function run(){class C {#x=1;set(x){this.#x=x;return this.#x;}}const c=new C();return c.set(7);}';
  const {bundle}=runtimeDifferential('',{source});
  const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
  const check=compareCompletionObservations(ownedCompletionObservations(bundle,source),reference.completions);
  assert.equal(check.status,'agreed',JSON.stringify(check));
  const admitted=await verifyEffectfulTrainingCase({source,entry:'run',family:'base-classes-private-slots',fixture:{calls:[]}});
  assert.equal(admitted.status,'projection_refused');
});
test('derived classes private accessors and top-level class environment stay explicit refusals',()=>{
  for(const source of ['"use strict";function run(){class C extends Object {}return new C();}',
    '"use strict";function run(){class C {get #x(){return 1;}}return new C();}',
    '"use strict";class C {}function run(){return new C();}'])
    assert.throws(()=>createRuntime().startEntry({text:source,functionName:'run'}),/Unsupported training/);
});
