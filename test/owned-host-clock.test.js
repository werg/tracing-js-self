import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from 'tracing-js-self/native';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {replayExact,validateBundle,createRuntime} from 'tracing-js-self';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
test('separate Date.now requests are journaled and replay never reads clock',async()=>{
  let reads=0;
  const times=[1700000000001,1700000000022];
  const {bundle,progress}=await executeWithNativeServices({
    entry:{text:'"use strict";async function f(){const a=Date.now(); const b=Date.now();return [a,b,b-a];}',
      functionName:'f',args:[]},
    services:{'platform.dateNow':()=>times[reads++]}
  });
  assert.equal(progress.kind,'terminated');
  assert.equal(reads,2);
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  assert.equal(reads,2,'replay cannot consult host time');
  const effects=Object.values(bundle.effects).filter(e=>e.operation==='platform.dateNow');
  assert.equal(effects.length,2);
  assert(effects.every(e=>e.request.signature==='platform.dateNow/1'&&
    e.request.payload==='[]'&&e.kind==='synchronous'));
  assert.equal(bundle.events.filter(e=>e.operation==='external.input.arrive').length,2);
});
test('typed natlang guest clock uses only explicit native service',async()=>{
  let reads=0;const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    services:{'platform.dateNow':()=>{reads++;return 42;}},
    onTrace:bundle=>traces.push(bundle)});
  try{
    const answer=await env.executeAsync({code:'const n: number=Date.now();return n+3;',
      body:true,scope:{},path:'natlang://clock.ts'});
    assert.equal(answer.result,45);
    assert.equal(reads,1);
    assert.equal(traces.length,1);
    assert.equal(replayExact(traces[0]).valid,true);
    assert.equal(reads,1);
  }finally{env.close();}
});
test('ungranted Date.now cannot read ambient V8 time',async()=>{
  const runtime=createRuntime();
  runtime.startEntry({text:'"use strict";function f(){return Date.now();}',
    functionName:'f',args:[]});
  assert.notEqual(runtime.drive().kind,'terminated');
  await assert.rejects(executeWithNativeServices({
    entry:{text:'"use strict";async function f(){return Date.now();}',
      functionName:'f',args:[]},services:{}
  }),/without a registered native service/);
});
