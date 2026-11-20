import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {describeGraph,realizeGraph} from '../src/training/graph.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

function compare(body){
  const source='"use strict";function run(){'+body+'}';
  const runtime=createRuntime().startEntry({text:source,functionName:'run'});
  assert.equal(runtime.drive().kind,'terminated');
  const archive=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  assert.deepEqual(describeGraph(realizeGraph(runtime.state.heap,[runtime.result])),
    describeGraph([Function(source+';return run();')()]),body);
  return {source,runtime,archive};
}

test('some stops at the first truthy return and reads later elements from the current owned heap',()=>{
  compare(`const seen=[],a=[1,2,3];
    const found=a.some((value,index,array)=>{
      seen.push([value,index,array===a]);
      if(index===0){a[1]=9;a.push(4);}
      return index===1?{}:false;
    });return [found,seen,a];`);
  compare(`return [false,0,'',null,undefined,NaN].some(value=>value);`);
  compare(`return [].some(()=>{throw 7;});`);
});

test('forEach ignores callback return values, returns undefined, and snapshots the initial length',()=>{
  compare(`const a=[1,2],seen=[];
    const result=a.forEach((value,index,array)=>{
      seen.push([value,index,array===a]);
      if(index===0){a[1]=7;a.push(99);}
      return true;
    });return [result,seen,a];`);
  compare(`return [].forEach(()=>{throw 7;});`);
});

test('nested some and forEach callbacks remain independently owned and replayable',()=>{
  compare(`const seen=[];
    [1,2].forEach(outer=>{[3,4].some(inner=>{
      seen.push(outer+inner);return inner===3;
    });});return seen;`);
});

test('callback throws unwind the array continuation before catch/finally and later callbacks',()=>{
  for(const method of ['some','forEach','map','filter','reduce']){
    const {runtime}=compare(`const seen=[];
      try{[1,2].${method}(()=>{seen.push(1);throw 7;}${method==='reduce'?',0':''});}
      catch(error){seen.push(error);}finally{seen.push(8);}
      const end=[3].forEach(value=>seen.push(value));return [seen,end];`);
    assert.equal(Object.values(runtime.state.frames).some(frame=>frame.pendingArrayMethod),false,method);
  }
});

test('fill writes holes without reading them and preserves holes outside the selected interval',()=>{
  compare(`const a=Array(4),returned=a.fill(undefined,1,3);return [a,returned===a,Object.keys(a)];`);
  compare(`const value={n:3},a=Array(3);a.fill(value);return [a,a[0]===a[2],a[0]===value];`);
  compare(`const a=Array(3);a.fill(7,2,1);return [a,Object.keys(a)];`);
});

test('dense callback and sparse-fill source cases pass the independent v5 admission checks',async()=>{
  for(const body of [
    'const a=Array(3).fill();return a.map((value,index)=>index);',
    'let n=0;[1,2,3].forEach(value=>{n+=value;});return n;',
    'return [3,5].some(value=>6%value===0);',
    'try{[1,2].some(()=>{throw 7;});}catch(error){return error;}'
  ]){
    const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(){'+body+'}',
      entry:'run',fixture:{calls:[]},family:'bounded-array-callback-extension'});
    assert.equal(result.status,'locally_verified',result.reason);
  }
});

test('async callbacks and inherited fill setters remain explicit refusals',()=>{
  for(const body of [
    'return [1].some(async value=>value);',
    'const a=Array(2),fill=a.fill,p={};Object.defineProperty(p,"0",{set:value=>{throw 7;}});p.fill=fill;Object.setPrototypeOf(a,p);return a.fill(3);'
  ]){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});
    assert.throws(()=>runtime.drive(),/owned data slots|outside the bounded profile|Unsupported callback thisArg/);
    assert.equal(Object.keys(runtime.state.effects).length,0);
  }
});
