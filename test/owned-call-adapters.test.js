import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {normalizeJournal} from '../src/semantic/normalize.js';

test('call and apply retain strict receivers, lexical arrows and original closure identities',()=>{
  for(const body of [
    'const o={n:x,read:function(d){return this.n+d;}};return o.read.call(o,2);',
    'const o={n:x,read:function(d){return this.n+d;}};return Reflect.apply(o.read,o,[2]);',
    'function f(){return this;}return [f.call(),f.call(null),f.call(3),f.apply("s",null)];',
    'const o={n:7,read:function(){const f=()=>this.n;return f.call({n:90});}};return o.read();',
    'function f(d){return this.n+d;}return f.call({n:3},...[4]);',
    'function* f(d){yield this.n+d;}return f.call({n:3},4).next().value;'
  ])runtimeDifferential(body,{args:[4]});
});

test('apply reads array-like length then indexed values without consulting iteration',()=>{
  for(const body of [
    'function f(a,...rest){return [this.n,a,rest.length,rest[0],rest[1]];}return f.apply({n:1},[2,,4]);',
    'function f(a,...rest){return [a,rest.length,rest[0],rest[1]];}return Reflect.apply(f,null,{length:"3.8",0:2,2:4});',
    'function f(...rest){return rest.length;}return f.apply(null,{length:-2,get 0(){throw 9;}});',
    'function f(a,b,c){return [a,b,c];}const list=Object.create({length:3,0:4,2:6});return Reflect.apply(f,null,list);',
    'function f(a=7,...rest){return [a,rest.length];}return [f.apply(null),Reflect.apply(f,null,{})];',
    'function f(a){return a;}const list={length:1,0:8,[Symbol.iterator](){throw 9;}};return Reflect.apply(f,null,list);'
  ])runtimeDifferential(body);
});

test('call adapters keep source argument evaluation order and user overrides',()=>{
  for(const body of [
    'let order="";function f(d){order+="c";return this.n+d;}function target(){order+="f";return f;}function receiver(){order+="r";return {n:3};}function list(){order+="a";return [4];}const value=Reflect.apply(target(),receiver(),list());return [value,order];',
    'function f(){return 90;}f.call=function(d){return this===f?d+2:0;};return f.call(3);',
    'function f(){return 90;}f.apply=function(d){return this===f?d+2:0;};return f.apply(3);',
    'function f(){return 90;}Object.setPrototypeOf(f,{call:function(d){return this===f?d+2:0;}});return f.call(3);'
  ])runtimeDifferential(body);
});

test('noncallable targets fail before array-like access and invalid scalar lists are guest errors',()=>{
  for(const body of [
    'let called=0;const args={get length(){called++;return 0;}};try{Reflect.apply(3,null,args);}catch(e){return [e.name,called];}',
    'function f(){}const call=f.call;try{return call(null);}catch(e){return e.name;}',
    'function f(){}try{return Reflect.apply(f,null,null);}catch(e){return e.name;}',
    'function f(){}try{return f.apply(null,"abc");}catch(e){return e.name;}',
    'function f(){}try{return f.apply(null,{length:1n});}catch(e){return e.name;}'
  ])runtimeDifferential(body);
});

test('unmodeled apply accessors, coercions and builtin targets remain profile refusals',()=>{
  for(const body of [
    'function f(x){return x;}return Reflect.apply(f,null,{get length(){return 1;},0:3});',
    'function f(x){return x;}return Reflect.apply(f,null,{length:1,get 0(){return 3;}});',
    'function f(x){return x;}return Reflect.apply(f,null,{length:{valueOf(){return 1;}},0:3});',
    'return Reflect.apply(Math.max,null,[1,2]);'
  ]){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});
    assert.throws(()=>runtime.drive(),/requires (an? owned|its owned)|requires owned/);
  }
});

test('read-only archive validation rejects changed adapter arguments, receiver and read observations',()=>{
  const {bundle}=runtimeDifferential('function f(a,...rest){return this.n+a+rest[0];}return Reflect.apply(f,{n:2},[3,4]);');
  const event=bundle.events.find(row=>row.operands[0]?.[1]?.[1]==='Reflect.apply');assert(event);
  const semantic=normalizeJournal(bundle).events.find(row=>row.journalEvent===event.eventId);
  assert.equal(semantic.callAdapter,'Reflect.apply');
  assert.deepEqual(semantic.arguments,[['num',3],['num',4]]);
  const change=mutate=>{const copy=structuredClone(bundle),edited=copy.events.find(row=>row.eventId===event.eventId);mutate(edited);return copy;};
  assert.throws(()=>validateBundle(change(row=>{row.readObservations[1].value=['num',8];})),/Apply argument reads/);
  assert.throws(()=>validateBundle(change(row=>{row.operands[2]=['null'];})),/evaluated source stack/);
  assert.throws(()=>validateBundle(change(row=>{row.stateChanges.find(p=>p.table==='frames'&&p.before===null).after.thisValue=['null'];})),/activation or receiver/);
  assert.throws(()=>validateBundle(change(row=>{row.stateChanges.find(p=>p.table==='envs'&&p.before===null).after.bindings.a.token.value=['num',8];})),/effective argument/);
});
