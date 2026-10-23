import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {validateBundle,replayExact} from '../src/index.js';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
async function agree(code,scope={}){
  const archived=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:(bundle,request,lowering)=>archived.push({bundle,lowering})});
  try{
    const own=await env.executeAsync({code,scope,body:true,path:'natlang://async-expr.ts'});
    assert.equal(archived.length,1);
    const {bundle,lowering}=archived[0];
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
    // Reference only: V8 runs separately, never as the guest continuation.
    const native=vm.runInNewContext(
      lowering.javascript+'\n__natlang_trace_entry(self,{});',
      {self:structuredClone(scope)},{timeout:1000});
    assert.deepEqual(own.result,await native);
    return own.result;
  }finally{env.close();}
}
test('async arrows create owned promises and capture lexical variables',async()=>{
  assert.equal(await agree(
    'const offset:number=4;const add=async (x:number)=>x+offset;'+
    'return await add(self.value);',{value:3}),7);
  assert.deepEqual(await agree(
    'const functions=[];for(let i=0;i<3;i++)functions.push(async()=>i);'+
    'return [await functions[0](),await functions[1](),await functions[2]()];'),[0,1,2]);
});
test('anonymous async function expression adopts returned owned promise',async()=>{
  assert.equal(await agree(
    'const f=async function(x:number){return await Promise.resolve(x+2);};'+
    'return await f(self.n);',{n:8}),10);
});
test('owned async expression rejection passes through await catch',async()=>{
  assert.equal(await agree(
    'const f=async (x:number)=>{throw x;};'+
    'try {return await f(self.value);}catch(e){return e+5;}',
    {value:7}),12);
});
