import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {realizeGraph,describeGraph} from '../src/training/graph.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

function run(code,args=[]){
  const source='"use strict";'+code;
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args});
  const status=runtime.drive();
  const archive=runtime.exportRun();
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  let native;
  try{native={kind:'return',value:Function(source+';return run;')()(...structuredClone(args))};}
  catch(error){native={kind:'throw',name:error.name};}
  if(status.kind==='runtime.failure'){
    assert.equal(native.kind,'throw');
    assert.equal(runtime.state.control.a0.failure.kind,'guest-abrupt');
    assert.equal(runtime.state.control.a0.failure.completion.errorType,native.name);
  }else{
    assert.equal(status.kind,'terminated');
    assert.equal(native.kind,'return');
    const actual=realizeGraph(runtime.state.heap,[runtime.result]);
    assert.deepEqual(describeGraph(actual),describeGraph([native.value]));
  }
  return runtime;
}

const positive=[
  'const x=7;function run(a=x){var x=3;return a;}',
  'const x=7;function run(a=()=>x){var x=3;return a();}',
  'function run(a=1,b=()=>a){var a=3;return [a,b()];}',
  'function run(a=2){var a;return a;}',
  'function run(a={x:1},b=()=>a){var a;a.x=3;return [a,b(),a===b()];}',
  'function run(a=1,b=a+1,c=b+1){return [a,b,c];}',
  'function run(n=3,base=2){if(n===0)return base;return run(n-1,base)+1;}',
  'function run(a=1,...rest){return [a,rest];}'
];

test('parameter expressions isolate body vars while preserving copies, aliases and recursive initialization',()=>{
  for(const source of positive)run(source);
  run('function run(a=1,b=2,...rest){return [a,b,rest];}',[undefined,3,4,5]);
  run('function run(a=1,b=2){return [a,b];}',[null,0]);
});

test('all parameters shadow outer names before their left-to-right initialization',()=>{
  for(const code of [
    'const b=7;function run(a=b,b=3){return a;}',
    'const a=7;function run(a=a){return a;}',
    'const b=7;function run(a=typeof b,b=3){return a;}',
    'function run(a=b,b=3){return a;}'
  ])run(code);
  run('const b=7;function run(a=b,b=3){return a;}',[undefined,9]);
});

test('default closures capture the parameter environment including later initialization',()=>{
  run('const b=7;function run(a=()=>b,b=3){return a();}');
  run('const b=7;function run(a=()=>b,b=a()){return b;}');
});

test('abrupt parameter initialization prevents later initializers and body execution',()=>{
  run('let count=0;function fail(){throw 7;}function f(a=fail(),b=count++){count=99;}function run(){try{f();}catch(e){return [e,count];}}');
});

test('successful parameter environment repairs pass independent current-v5 admission checks',async()=>{
  for(const code of positive){
    const checked=await verifyEffectfulTrainingCase({source:'"use strict";'+code,
      entry:'run',family:'parameter-environment',fixture:{calls:[]}});
    assert.equal(checked.status,'locally_verified',code+': '+checked.reason);
  }
});

test('v5 explicitly refuses a closure capturing a later TDZ cell instead of capturing an outer name',async()=>{
  const checked=await verifyEffectfulTrainingCase({
    source:'"use strict";const b=7;function run(a=()=>b,b=3){return a();}',
    entry:'run',family:'parameter-forward-capture',fixture:{calls:[]}});
  assert.equal(checked.status,'projection_refused');
  assert.match(checked.reason,/closure captures an uninitialized binding: b/);
});
