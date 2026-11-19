import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';

test('ordinary instanceof follows owned prototype identities and live constructor prototype',()=>{
  runtimeDifferential('function C(){}const a=new C();return [a instanceof C,{} instanceof C,3 instanceof C,a instanceof Object,[] instanceof Array,[] instanceof Object];');
  runtimeDifferential('function C(){}const old=C.prototype,a=new C();C.prototype={};const b=new C();return [a instanceof C,b instanceof C,Object.create(old) instanceof C,Object.create(C.prototype) instanceof C];');
  runtimeDifferential('function C(){}C.prototype=Object.prototype;return [({}) instanceof C,[] instanceof C,Object.create(null) instanceof C];');
  runtimeDifferential('class C {}return [(new C()) instanceof C,{} instanceof C];');
});
test('Symbol.hasInstance hooks preserve getter order receiver and truthiness',()=>{
  runtimeDifferential('const log=[];const checker={get [Symbol.hasInstance](){log.push("get");return function(value){log.push(this===checker);return value.x;};}};return [({x:2}) instanceof checker,({x:0}) instanceof checker,log];');
  runtimeDifferential('let log=[];const proto={[Symbol.hasInstance](x){log.push(this===checker);return x===3;}};const checker=Object.create(proto);return [(log.push("left"),3) instanceof (log.push("right"),checker),log];');
  runtimeDifferential('class C {static [Symbol.hasInstance](x){return x===3;}}return [3 instanceof C,4 instanceof C];');
  runtimeDifferential('class C {static get [Symbol.hasInstance](){return function(){return {};};}}return 2 instanceof C;');
});
test('instanceof rejects invalid constructors and preserves hook throws',()=>{
  runtimeDifferential('const C=()=>3;try{return {} instanceof C;}catch(e){return [e.name,3 instanceof C];}');
  runtimeDifferential('function C(){}C.prototype=3;try{return {} instanceof C;}catch(e){return [e.name,3 instanceof C];}');
  for(const right of ['null','3','{}','{[Symbol.hasInstance]:3}','{[Symbol.hasInstance]:null}'])
    runtimeDifferential('try{return 1 instanceof ('+right+');}catch(e){return e.name;}');
  runtimeDifferential('const C={[Symbol.hasInstance](){throw 7;}};try{return 1 instanceof C;}catch(e){return e;}');
  runtimeDifferential('function C(){}try{C[Symbol.hasInstance]=()=>true;}catch(e){return e.name;}');
});
test('ordinary hasInstance method is readable callable and ignores noncallable receivers',()=>{
  runtimeDifferential('function C(){}const a=new C(),m=C[Symbol.hasInstance];const o={m};return [C[Symbol.hasInstance](a),m(a),o.m(a)];');
});
test('proxy and unmodeled intrinsic prototype chains remain explicit refusals',()=>{
  for(const body of ['function C(){}return new Proxy(new C(),{}) instanceof C;',
    'return Promise.resolve(3) instanceof Promise;']){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});
    assert.throws(()=>runtime.drive(),/instanceof/);
  }
});
