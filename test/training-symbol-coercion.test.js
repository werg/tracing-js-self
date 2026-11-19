import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';

test('owned Symbol.toPrimitive hooks precede ordinary conversion with receiver and hint',()=>{
  runtimeDifferential('let log=[];const a={[Symbol.toPrimitive](hint){log.push([this===a,hint]);return 4;},valueOf(){throw 9;}};return [a+2,a*3,log];');
  runtimeDifferential('const p={[Symbol.toPrimitive](hint){return this.n+hint;}};const a=Object.create(p);a.n="x";return a+"!";');
  runtimeDifferential('const a={[Symbol.toPrimitive](...args){return args[0];}};return [a+"",a*3];');
});
test('nullish hooks fall back while noncallable and object-returning hooks throw',()=>{
  runtimeDifferential('const a={[Symbol.toPrimitive]:null,valueOf(){return 5;}};return a+1;');
  runtimeDifferential('const a={[Symbol.toPrimitive](){return {};},valueOf(){return 5;}};try{return a+1;}catch(e){return e.name;}');
  runtimeDifferential('const a={[Symbol.toPrimitive]:7};try{return a+1;}catch(e){return e.name;}');
  runtimeDifferential('const a={[Symbol.toPrimitive](){return Symbol();}};try{return ""+a;}catch(e){return e.name;}');
  runtimeDifferential('let log=[];const a={[Symbol.toPrimitive](){log.push(1);throw 7;}};try{return a+1;}catch(e){return [e,log];}finally{log.push(2);}');
});
test('ordinary toString honors owned string Symbol.toStringTag',()=>{
  runtimeDifferential('const a={[Symbol.toStringTag]:"Custom"};return a+"";');
  runtimeDifferential('const a={[Symbol.toStringTag]:7};return a+"";');
});
test('hook dispatch receipts reject a forged skipped protocol phase',()=>{
  const {bundle}=runtimeDifferential('const a={[Symbol.toPrimitive](){return 5;}};return a+2;');
  const edited=structuredClone(bundle);
  const entry=edited.events.find(e=>e.stateChanges.some(p=>p.kind==='operation.advance'&&p.coercionAfter?.index===-1&&p.coercionBefore===null));
  entry.stateChanges.find(p=>p.kind==='operation.advance').coercionAfter.index=0;
  assert.throws(()=>validateBundle(edited),/Symbol.toPrimitive hook/);
});
test('unowned protocol getter species and concat hooks fail explicitly',()=>{
  for(const body of [
    'const a={get [Symbol.toPrimitive](){return ()=>7;}};return a+1;',
    'const a=[];a.constructor={};return a.map(x=>x);',
    'const a=[1];a[Symbol.isConcatSpreadable]=false;return a.concat([]);'
  ]){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});
    let failed=false;
    try{failed=runtime.drive().kind==='unsupported';}catch(error){failed=/profile|Symbol.isConcatSpreadable/.test(error.message);}
    assert.equal(failed,true,body);
  }
});
