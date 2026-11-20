import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';

test('new.target distinguishes ordinary calls and construction without spelling-based inference',()=>{
  runtimeDifferential('function f(){return new.target;}return f();');
  runtimeDifferential('function C(){this.target=new.target;}const alias=C;const c=new alias();return c.target===C;');
  runtimeDifferential('class C {constructor(x=new.target){this.x=x;}}return (new C()).x===C;');
  runtimeDifferential('class C {value=new.target;f=()=>new.target;}const c=new C();return [c.value,c.f()];');
});
test('arrow new.target retains its lexical constructor through nested closures and callbacks',()=>{
  runtimeDifferential('function C(){this.direct=new.target===C;this.arrow=()=>new.target;this.nested=()=>()=>new.target;}const c=new C(),fn=c.arrow;return [c.direct,fn()===C,c.nested()()===C];');
  runtimeDifferential('function C(){const f=()=>this;this.get=()=>[f(),new.target];}const c=new C(),f=c.get;const pair=f();return [pair[0]===c,pair[1]===C];');
  runtimeDifferential('function C(){this.result=[1].map(()=>new.target===C);}return (new C()).result;');
  runtimeDifferential('function C(){const o={};Object.defineProperty(o,"v",{get:()=>[this,new.target]});this.o=o;}const c=new C(),v=c.o.v;return [v[0]===c,v[1]===C];');
  runtimeDifferential('function C(){this.p=new Proxy({},{get:()=>new.target});}const c=new C();return c.p.x===C;');
  runtimeDifferential('function C(){function ordinary(){return ()=>new.target;}this.f=ordinary();}return (new C()).f();');
});
test('lexical constructor context remains serializable after the constructor has returned',()=>{
  const source='"use strict";function run(){function C(){this.f=()=>[this,new.target];}const c=new C(),f=c.f;const result=f();return [result[0]===c,result[1]===C];}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!Object.values(original.state.frames).some(frame=>frame.newTarget&&frame.status==='completed'))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(original.exportRun())),JSON.parse(JSON.stringify(restored.exportRun())));
  const bundle=restored.exportRun();assert.equal(validateBundle(bundle).valid,true);
  const forged=structuredClone(bundle),event=forged.events.find(e=>e.stateChanges.some(p=>p.before===null&&p.after?.lexicalThisFrameId));
  event.stateChanges.find(p=>p.after?.lexicalThisFrameId).after.lexicalThisFrameId='f99999';
  assert.throws(()=>validateBundle(forged),/unrelated receiver/);
});
