import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from 'tracing-js-self/native';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {validateBundle,replayExact} from 'tracing-js-self';

class EvalFailure extends Error {
  constructor(message,events,debug){super(message);this.events=events;this.debug=debug;}
}
test('journaled console effects preserve call order and never replay native writers',async()=>{
  const messages=[];
  const {bundle,progress}=await executeWithNativeServices({
    entry:{text:'"use strict";async function f(){console.log("a");console.warn("b");return 7;}',
      functionName:'f',args:[]},
    services:{
      'platform.console.log':({args})=>{messages.push(['log',...args]);},
      'platform.console.warn':({args})=>{messages.push(['warn',...args]);}
    }
  });
  assert.equal(progress.kind,'terminated');
  assert.deepEqual(messages,[['log','a'],['warn','b']]);
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  assert.deepEqual(messages,[['log','a'],['warn','b']]);
});
test('natlang console text reaches its logs and stays traceable',async()=>{
  const traces=[];
  const env=createBoundedNatlangEnvironment({
    EvalFailure,services:{'platform.console.log':()=>undefined},
    onTrace:b=>traces.push(b)
  });
  try{
    const result=await env.executeAsync({
      code:'console.log("first");console.log("second");return 3;',
      body:true,scope:{},path:'natlang://console.ts'
    });
    assert.deepEqual(result.logs,['first','second']);
    assert.equal(result.result,3);
    assert.equal(traces.length,1);
    assert.equal(replayExact(traces[0]).valid,true);
  }finally{env.close();}
});
