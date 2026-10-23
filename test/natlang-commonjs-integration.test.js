import test from 'node:test';
import assert from 'node:assert/strict';
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
