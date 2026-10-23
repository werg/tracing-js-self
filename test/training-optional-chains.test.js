import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {parseTraining} from '../src/training/profile.js';
import {referenceOutcome} from '../src/training/reference.js';
import {describeGraph,realizeGraph} from '../src/training/graph.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
function differential(code,scope={}){
  const captured=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:(bundle,request,lowering)=>captured.push({bundle,lowering})});
  const result=env.execute({code,body:true,
    path:'natlang://optional-chains.ts',scope});
  assert.equal(captured.length,1);
  const {bundle,lowering}=captured[0];
  assert.match(lowering.javascript,/\?\./);
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  const {sourceId,functionName,arguments:args}=bundle.entrySpec;
  assert.equal(sourceId,bundle.sources[0].sourceId);
  const reference=referenceOutcome({
    source:lowering.javascript,entry:functionName,args,
    initialHeap:bundle.initialState.heap
  });
  assert.equal(reference.kind,'return',JSON.stringify(reference));
  const value=bundle.finalState.control.a0.completion.value;
  const observed=describeGraph(realizeGraph(bundle.finalState.heap,[...args,value]));
  assert.deepEqual(observed,reference.graph);
  env.close();
  return result.result;
}

test('owned optional chains skip the entire later suffix and computed keys',()=>{
  assert.deepEqual(differential(`
    let count=0;
    const key=()=>{count++;return "inner";};
    const absent=self.missing?.[key()].value;
    const present=self.present?.[key()].value;
    return [absent??-1,present,count];
  `,{missing:null,present:{inner:{value:7}}}),[-1,7,1]);
});
test('optional receiver method calls keep this and skip absent arguments',()=>{
  assert.deepEqual(differential(`
    let count=0;
    const key=()=>{count++;return "at";};
    const obj=[9,10];
    const absent=undefined;
    const a=absent?.[key()](count++);
    const b=obj?.[key()](count++);
    return [a??-1,b,count];
  `),[-1,10,2]);
});
test('optional function calls skip arguments while preserving guest calls',()=>{
  assert.deepEqual(differential(`
    let n=0;
    const absent=undefined;
    const f=(v:number)=>v*3;
    const a=absent?.(n++);
    const b=f?.(n++);
    return [a??-1,b,n];
  `),[-1,0,1]);
});
test('optional property access distinguishes nullish and falsy receivers',()=>{
  assert.deepEqual(differential(`
    let count=0;
    const key=()=>{count++;return "length";};
    const a=self.absent?.[key()];
    const b=self.falsy?.[key()];
    return [a??-1,b??-2,count];
  `,{absent:null,falsy:''}),[-1,0,1]);
});
test('receiver-aware optional method calls skip arguments when nullish',()=>{
  assert.deepEqual(differential(`
    let counter=0;
    const obj={f:null};
    const a=obj.f?.(counter++);
    const b=obj?.f?.(counter++);
    const arr=[9,10];
    const c=arr.at?.(1);
    return [a??-1,b??-2,c,counter];
  `),[-1,-2,10,0]);
});
test('dynamic optional calls remain prohibited without native escape',()=>{
  assert.throws(()=>parseTraining('"use strict"; function f(){return require?.("x");}'),
    /dynamic source or host call/);
});
