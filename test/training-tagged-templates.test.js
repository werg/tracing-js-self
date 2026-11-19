import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {independentEffectfulReference} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

test('tagged templates cache by source site and preserve raw cooked and substitution values',()=>{
  runtimeDifferential('let first;function tag(s,x){const same=first===s;first=s;return [same,s[0],s.raw[0],s[1],x];}function call(x){return tag`a\\n${x}z`;}return [call(1),call(2)];');
  runtimeDifferential('function tag(s){return s;}const a=tag`x`,b=tag`x`;return a===b;');
  runtimeDifferential('let first;function make(){return ()=>tag`same`;}function tag(s){const out=first===s;first=s;return out;}const a=make(),b=make();return [a(),b()];');
  runtimeDifferential('function tag(s){return [s[0],s.raw[0]];}return tag`\\unicode`;');
  runtimeDifferential('function tag(s,x){return [s[0],x===Symbol.iterator];}return tag`${Symbol.iterator}`;');
});
test('tag receiver and substitution order are owned exactly once',()=>{
  runtimeDifferential('let log=[];const o={n:4,get tag(){log.push("get");return function(s,a,b){log.push("tag");return [this.n,a,b];};}};const value=o.tag`a${(log.push("a"),1)}b${(log.push("b"),2)}`;return [value,log];');
  runtimeDifferential('class C {#tag(s,x){return [this.n,s[0],x];}n=3;read(){return this.#tag`v${4}`;}}return (new C()).read();');
  runtimeDifferential('let calls=0;function tag(){calls++;}function fail(){throw 7;}try{tag`x${fail()}`;}catch(e){return [e,calls];}');
});
test('template arrays and raw arrays are frozen with precise descriptors',()=>{
  runtimeDifferential('function tag(s){const raw=Object.getOwnPropertyDescriptor(s,"raw"),zero=Object.getOwnPropertyDescriptor(s,"0"),length=Object.getOwnPropertyDescriptor(s,"length");return [Object.isFrozen(s),Object.isFrozen(s.raw),raw.enumerable,raw.writable,raw.configurable,zero.enumerable,zero.writable,zero.configurable,length.enumerable,length.writable,length.configurable,Object.keys(s)];}return tag`a${1}b`;');
  runtimeDifferential('function tag(s){let a,b,c,d;try{s[0]="x";}catch(e){a=e.name;}try{s.x=3;}catch(e){b=e.name;}try{s.raw.push(1);}catch(e){c=e.name;}try{Object.setPrototypeOf(s,null);}catch(e){d=e.name;}return [a,b,c,d,s[0],s.raw[0],s.reverse()===s];}return tag`a`;');
  runtimeDifferential('function tag(s){try{Object.defineProperty(s,"raw",{get(){return 2;}});}catch(e){return [e.name,s.raw[0]];}}return tag`a`;');
});
test('template identity survives plain JSON continuation and rejects changed frozen payload',()=>{
  const source='"use strict";function run(){let first;function tag(s){const same=first===s;first=s;return same;}function call(){return tag`same`;}return [call(),call()];}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!original.state.control.a0.templateObjects)original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(original.exportRun())),JSON.parse(JSON.stringify(restored.exportRun())));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  const forged=structuredClone(restored.exportRun()),event=forged.events.find(e=>e.stateChanges.some(p=>p.after?.templateSite));
  const patch=event.stateChanges.find(p=>p.after?.templateSite);patch.after.properties['0'].value=['str','different'];
  assert.throws(()=>validateBundle(forged),/Invalid frozen template/);
});
test('independent tagged-call receipts agree with descriptor state retained',async()=>{
  const source='"use strict";function run(){function tag(s,x){return s[0]+x;}return tag`a${3}`;}';
  const {bundle}=runtimeDifferential('',{source});
  const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
  const check=compareCompletionObservations(ownedCompletionObservations(bundle,source),reference.completions);
  assert.equal(check.status,'agreed',JSON.stringify(check));

});
