import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {independentEffectfulReference} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

test('yield delegation forwards values and receives the final expression result',()=>{
  runtimeDifferential('function* g(){return yield* [1,2];}const it=g();return [it.next(99),it.next(3),it.next(),it.next()];');
  runtimeDifferential('function* inner(){const x=yield 1;return x+2;}function* outer(){return 3+(yield* inner());}const it=outer();return [it.next(),it.next(4)];');
  runtimeDifferential('function* a(){return yield* "A💡B";}const it=a();return [it.next(),it.next(),it.next(),it.next()];');
});
test('delegate next is cached and direct yielded result identity and lazy value access survive',()=>{
  runtimeDifferential('let reads=0,gets=0,done=0;const row={get value(){reads++;return 8;},get done(){done++;return false;}};const iterable={[Symbol.iterator](){return this;},get next(){gets++;return function(...args){return row;};}};function* g(){yield* iterable;}const it=g(),a=it.next(),before=reads,b=it.next();return [a===row,b===row,b.value,reads,before,gets,done];');
  runtimeDifferential('let calls=[];const iterable={[Symbol.iterator](){return this;},next(...args){calls.push(args);return {done:calls.length===2,value:4};}};function* g(){return yield* iterable;}const it=g();return [it.next(99),it.next(7),calls];');
});
test('return and throw forward to the delegate and can yield during cleanup',()=>{
  runtimeDifferential('let log=[];function* inner(){try{yield 1;}finally{log.push("inner");yield 2;}}function* outer(){try{yield* inner();log.push("after");}finally{log.push("outer");}}const it=outer();return [it.next(),it.return(9),it.next(),log];');
  runtimeDifferential('function* inner(){try{yield 1;}catch(e){yield e+2;}return 9;}function* outer(){return yield* inner();}const it=outer();return [it.next(),it.throw(4),it.next()];');
  runtimeDifferential('let log=[];const iterable={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},get return(){log.push("get-return");return function(v){log.push(v);return {done:true,value:v+2};};}};function* g(){try{yield* iterable;}finally{log.push("finally");}}const it=g();return [it.next(),it.return(7),log];');
  runtimeDifferential('let log=[];const iterable={[Symbol.iterator](){return this;},next(v){log.push(v);return {done:log.length>1,value:5};},return(v){return {done:false,value:v};}};function* g(){return 1+(yield* iterable);}const it=g();return [it.next(),it.return(7),it.next(3),log];');
});
test('missing throw closes with normal precedence and missing return propagates its value',()=>{
  runtimeDifferential('let log=[];const iterable={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(...args){log.push(args.length);return {};}};function* g(){try{yield* iterable;}catch(e){return e.name;}}const it=g();return [it.next(),it.throw(7),log];');
  runtimeDifferential('const iterable={[Symbol.iterator](){return this;},next(){return {done:false};},return(){throw 8;}};function* g(){try{yield* iterable;}catch(e){return e;}}const it=g();it.next();return it.throw(7);');
  runtimeDifferential('const iterable={[Symbol.iterator](){return this;},next(){return {done:false};},return(){return 1;}};function* g(){try{yield* iterable;}catch(e){return e.name;}}const it=g();it.next();return it.throw(7);');
  runtimeDifferential('let log=[];function* g(){try{yield* [1,2];}finally{log.push("finally");}}const it=g();return [it.next(),it.return(7),log];');
});
test('delegate next and done failures propagate without invented closing',()=>{
  runtimeDifferential('let closes=0;const iterable={[Symbol.iterator](){return this;},next(){throw 3;},return(){closes++;return {};}};function* g(){try{yield* iterable;}catch(e){return e;}}return [g().next(),closes];');
  runtimeDifferential('let closes=0;const iterable={[Symbol.iterator](){return this;},next(){return {get done(){throw 3;}};},return(){closes++;return {};}};function* g(){try{yield* iterable;}catch(e){return e;}}return [g().next(),closes];');
  runtimeDifferential('const iterable={[Symbol.iterator](){return this;},next(){return 1;}};function* g(){try{yield* iterable;}catch(e){return e.name;}}return g().next();');
});
test('delegated suspended completion restores from JSON and source receipts agree',async()=>{
  const source='"use strict";function run(){function* inner(){const x=yield 2;return x+1;}function* outer(){return 3+(yield* inner());}const it=outer();return [it.next(),it.next(4)];}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!Object.values(original.state.frames).some(frame=>frame.delegateYield))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(original.exportRun())),JSON.parse(JSON.stringify(restored.exportRun())));
  const bundle=restored.exportRun();assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
  const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
  const check=compareCompletionObservations(ownedCompletionObservations(bundle,source),reference.completions);
  assert.equal(check.status,'agreed',JSON.stringify(check));
  const forged=structuredClone(bundle),resumed=forged.events.find(e=>e.stateChanges.some(p=>p.table==='frames'&&!p.before?.delegateResume&&p.after?.delegateResume));
  const patch=resumed.stateChanges.find(p=>p.after?.delegateResume);patch.after.delegateResume.kind='return';
  assert.throws(()=>validateBundle(forged),/completion was not forwarded/);
});
