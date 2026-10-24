import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {validateBundle,replayExact} from 'tracing-js-self';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
const compiled='"use strict";Object.defineProperty(exports,"__esModule",{value:true});'+
  'exports.add=add;exports.read=read;'+
  'function add(v){return v+3;}function read(){return 8;}';

test('retained natlang module seam installs pure CJS export functions with owned execution',()=>{
  let requireCalls=0;
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:(bundle,request,lowering)=>traces.push({bundle,request,lowering})});
  const exports={},module={exports};
  const bindings={exports,module,require:()=>{requireCalls++;throw new Error('unowned require');},
    __natlang:{},__natlang_context:{},nl:()=>{},iterateOn:()=>{}};
  try{
    const result=env.evaluateModule(compiled,bindings);
    assert.equal(result,exports);
    assert.equal(module.exports,exports);
    assert.equal(exports.add(4),7);
    assert.equal(exports.read(),8);
    assert.equal(requireCalls,0);
    assert.equal(traces.length,2);
    for(const trace of traces){
      assert.equal(validateBundle(trace.bundle).valid,true);
      assert.equal(replayExact(trace.bundle).valid,true);
      assert.equal(trace.request.path.startsWith('natlang://retained-cjs/'),true);
      assert.equal(trace.lowering.compiler,'natlang-commonjs/1');
    }
    assert.equal(env.evaluateModule(compiled,bindings),exports,
      'same retained module record must preserve callable identities');
    assert.equal(exports.add(2),5);
    assert.equal(traces.length,3);
  }finally{env.close();}
  assert.throws(()=>exports.add(1),EvalFailure);
});

test('retained CJS seam refuses require/native guest execution with no successful trace',()=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:bundle=>traces.push(bundle)});
  try{
    for(const code of [
      'exports.f=f;function f(){return require("fs");}',
      'exports.f=f;function f(){return __natlang.run();}',
      'require("fs");exports.f=f;function f(){return 1;}',
      'module.exports={f(){return 1;}};'
    ]){
      const exports={},module={exports};
      assert.throws(()=>env.evaluateModule(code,{exports,module,require:()=>{}}),EvalFailure);
      assert.deepEqual(exports,{});
    }
    assert.equal(traces.length,0);
  }finally{env.close();}
});

test('rejected trace sink rolls back callable module invocation history',()=>{
  let count=0;
  const env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:()=>{count++;throw new Error('sink refused');}});
  const exports={},module={exports};
  try{
    env.evaluateModule(compiled,{exports,module,require:()=>{}});
    assert.throws(()=>exports.add(2),EvalFailure);
    assert.equal(count,1);
  }finally{env.close();}
});

test('pinned TypeScript-emitted CommonJS module retains real lexical cells',()=>{
  const code=ts.transpileModule(
    'let total=1; export function add(v:number){total+=v;return total;}'+
    'export function read(){return total;}',
    {fileName:'pure-module.ts',compilerOptions:{
      target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS
    }}
  ).outputText;
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:bundle=>traces.push(bundle)});
  const exports={},module={exports};let requireCalls=0;
  try{
    assert.equal(env.evaluateModule(code,{
      module,exports,require:()=>{requireCalls++;throw Error('unowned require');},
      __natlang:()=>{},nl:()=>{},iterateOn:()=>{},__natlang_context:{}
    }),exports);
    assert.equal(exports.add(3),4);
    assert.equal(exports.read(),4);
    assert.equal(exports.add(5),9);
    assert.equal(exports.read(),9);
    assert.equal(requireCalls,0);
    assert.equal(traces.length,4);
    for(const archive of traces){
      assert.equal(validateBundle(archive).valid,true);
      assert.equal(replayExact(archive).valid,true);
    }
  }finally{env.close();}
});
test('failed trace hook leaves retained TypeScript CommonJS lexical state unchanged',()=>{
  const code=ts.transpileModule(
    'let n=1;export function inc(){n++;return n;}export function read(){return n;}',
    {fileName:'pure-module.ts',compilerOptions:{
      target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS
    }}
  ).outputText;
  let attempts=0;
  const env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:()=>{
      if(attempts++===0)throw new Error('archive refused');
    }});
  const exports={},module={exports};
  try{
    env.evaluateModule(code,{exports,module,require:()=>{}});
    assert.throws(()=>exports.inc(),EvalFailure);
    assert.equal(exports.read(),1,'replay-backed guest module state must roll back');
    assert.equal(exports.inc(),2);
    assert.equal(exports.read(),2);
  }finally{env.close();}
});
 
test('pinned TypeScript const-function exports with chained initialization markers',()=>{
  const code=ts.transpileModule(
    'let total=1;'+
    'export const add=(v:number)=>{total+=v;return total;};'+
    'export const read=()=>total;'+
    'export const double=function(v:number){return v*2;};',
    {fileName:'const-functions.ts',compilerOptions:{
      target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS
    }}
  ).outputText;
  assert.match(code,/exports\.double = exports\.read = exports\.add = void 0/);
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained',
    onTrace:bundle=>traces.push(bundle)});
  const exports={},module={exports};
  try{
    assert.equal(env.evaluateModule(code,{exports,module,require:()=>{throw Error('unowned');}}),exports);
    assert.equal(exports.add(3),4);
    assert.equal(exports.read(),4);
    assert.equal(exports.double(6),12);
    assert.equal(exports.add(5),9);
    assert.equal(exports.read(),9);
    assert.equal(traces.length,5);
    for(const archive of traces){
      assert.equal(validateBundle(archive).valid,true);
      assert.equal(replayExact(archive).valid,true);
    }
  }finally{env.close();}
});

test('CommonJS empty markers and unowned exports fail closed',()=>{
  const env=createBoundedNatlangEnvironment({EvalFailure,mode:'retained'});
  try{
    for(const code of [
      'exports.unused=void 0;exports.f=f;function f(){return 1;}',
      'exports.f=void sideEffect();exports.f=f;function f(){return 1;}',
      'exports.f=void 0;const f=()=>1;',
      'exports.f=f;let f=()=>1;',
      'exports.f=()=>1;'
    ]){
      const exports={},module={exports};
      assert.throws(()=>env.evaluateModule(code,{exports,module,require:()=>{}}),EvalFailure);
      assert.deepEqual(exports,{});
    }
  }finally{env.close();}
});
