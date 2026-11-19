import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {materializeHostArguments} from '../src/host/materialize.js';
import {protocolSymbols,validateProtocolSymbols} from '../src/semantic/protocol-values.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';

test('symbols retain distinct identity, descriptions, registry and well-known identity',()=>{
  runtimeDifferential('const a=Symbol("same"),b=Symbol("same");return [a===a,a===b,a==b,typeof a,!a,String(a),a.description,a.valueOf()===a,Symbol().description,Symbol("").description];');
  runtimeDifferential('const a=Symbol.for("key"),b=Symbol.for("key");return [a===b,Symbol.keyFor(a),Symbol.keyFor(Symbol("key")),Symbol.iterator===Symbol.iterator,Symbol.iterator===Symbol.asyncIterator,Symbol.toPrimitive.description];');
});
test('symbol keys retain own-key order without colliding with descriptions or escaped strings',()=>{
  runtimeDifferential('const a=Symbol("k"),b=Symbol("k");const o={[a]:1,z:3,[b]:2,2:4,1:5};const keys=Reflect.ownKeys(o);return [o[a],o[b],Object.keys(o),Object.getOwnPropertyNames(o),keys[3]===a,keys[4]===b,Object.getOwnPropertySymbols(o).length];');
  runtimeDifferential('const a=Symbol("s");const o={"\\u0000symbol:o2":9,[a]:5,"\\u0000string:x":7};return [o["\\u0000symbol:o2"],o[a],o["\\u0000string:x"],Object.keys(o)];');
  runtimeDifferential('return [x["\\u0000symbol:o2"],Object.keys(x)];',{args:[{'\0symbol:o2':7}]});
  const publicStrings=verifyOwnedSourceCase({source:'"use strict";function run(){const o={"\\u0000symbol:o2":9};return [o["\\u0000symbol:o2"],Object.keys(o)];}',entry:'run'});
  assert.equal(publicStrings.status,'locally_verified',publicStrings.reason);
});
test('symbol getters setters spread and rest share ordinary property semantics',()=>{
  runtimeDifferential('const a=Symbol("s");let calls=0;const o={get [a](){calls++;return 4;},normal:5};const copy={...o};const {[a]:v,...rest}=copy;return [v,calls,Object.keys(rest),Object.getOwnPropertySymbols(rest).length];');
  runtimeDifferential('const a=Symbol();let calls=0;const p={get [a](){return calls;},set [a](v){calls=v;}};const o=Object.create(p);o[a]=7;return [o[a],Object.hasOwn(o,a),Object.getOwnPropertySymbols(p)[0]===a];');
});
test('symbol conversion failures are guest throws with owned completion and replay',()=>{
  runtimeDifferential('let errors=[];const a=Symbol();try{a+1;}catch(e){errors.push(e.name);}try{""+a;}catch(e){errors.push(e.name);}try{+a;}catch(e){errors.push(e.name);}try{Symbol(a);}catch(e){errors.push(e.name);}try{Number(a);}catch(e){errors.push(e.name);}try{new Symbol();}catch(e){errors.push(e.name);}try{Symbol.keyFor("x");}catch(e){errors.push(e.name);}return errors;');
});
test('symbol archives survive JSON and reject identity tampering',()=>{
  const {bundle}=runtimeDifferential('const a=Symbol("x");const b=Symbol.for("registry");return a!==b;');
  const archive=JSON.parse(JSON.stringify(bundle));
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  const contract=protocolSymbols(archive.finalState.heap);
  assert.equal(validateProtocolSymbols(JSON.parse(JSON.stringify(contract))).valid,true);
  const mutated=structuredClone(contract);mutated.symbols.push(mutated.symbols.at(-1));
  assert.throws(()=>validateProtocolSymbols(mutated),/symbol interface/);
  const broken=structuredClone(bundle),event=broken.events.find(e=>e.result?.[0]==='symbol');
  event.result=['symbol','missing'];
  assert.throws(()=>validateBundle(broken),/owned symbol/);
});
test('symbol host transport and old detailed/native projection remain explicit refusals',async()=>{
  const {runtime}=runtimeDifferential('const a=Symbol("x");const o={[a]:1};return 1;');
  const symbol=Object.values(runtime.state.heap).find(entity=>entity.kind==='symbol');
  const object=Object.values(runtime.state.heap).find(entity=>entity.kind==='object');
  for(const codec of ['canonical-json/1','owned-graph/1']){
    assert.throws(()=>materializeHostArguments(runtime.state.heap,[['symbol',symbol.id]],{codec}),/symbol|scalar/i);
    assert.throws(()=>materializeHostArguments(runtime.state.heap,[['ref',object.id]],{codec}),/Symbol property transport/);
  }
  assert.throws(()=>createRuntime().startEntry({text:'"use strict";function run(x){return x;}',functionName:'run',args:[Symbol('host')]}),/primitive/);
  const r=await verifyEffectfulTrainingCase({source:'"use strict";function run(){const s=Symbol("x");return typeof s;}',entry:'run',family:'owned-symbol',fixture:{calls:[]}});
  assert.equal(r.status,'projection_refused');
});
