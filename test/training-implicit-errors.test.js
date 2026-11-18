import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';

const sources=[
  'function run(a=b,b=2){return a;}',
  'const b=7;function run(a=b,b=2){return a;}',
  'function run(a=a){return a;}',
  'function run(a=typeof b,b=2){return a;}',
  'function f(a=b,b=2){}function run(){try{f();}catch(e){return [e.name,e.message];}}',
  'function f(a=b,b=2){}function run(){try{f();}finally{let x=1;}}',
  'function fail(){let x=x;}function f(){try{fail();}catch(e){throw e;}}'+
    'function run(){try{f();}catch(e){return [e.name,e.message];}}',
  'function run(){try{const x=1;x++;}catch(e){return e.name;}}',
  'function run(){try{let x=null;return x.a;}catch(e){return e.name;}}',
  'function run(){const a=[];a.length=-1;return a;}'
];

test('implicit guest faults retain their committed exception through both source verification paths',async()=>{
  for(const code of sources){
    const source='"use strict";'+code;
    const checked=await verifyEffectfulTrainingCase({source,entry:'run',
      family:'implicit-guest-error',fixture:{calls:[]}});
    assert.equal(checked.status,'locally_verified',code+': '+checked.reason);
    const rechecked=await recheckEffectfulAdmission(checked.exported,{requireAdmitted:false});
    assert(rechecked.sourceValidated&&rechecked.replayValidated&&rechecked.effectsValidated);
    const pure=verifyOwnedSourceCase({source,entry:'run'});
    assert.equal(pure.status,'locally_verified',code+': '+pure.reason);
    assert.equal(recheckOwnedSourceEvidence(pure.exported).valid,true);
    const allocated=checked.exported.sidecar.archive.events.filter(event=>
      event.completion?.errorType&&event.completion?.value?.value[0]==='ref');
    assert.equal(allocated.length,1,'one owned fault allocation, including rethrows');
  }
});

test('implicit parameter errors complete selected execution with finally cleanup and exact identity',async()=>{
  for(const asynchronous of [false,true]){
    const checked=await verifyEffectfulTrainingCase({
      source:'"use strict";'+(asynchronous?'async ':'')+'function fail(a=b,b=2){return a;}'+
        (asynchronous?'async ':'')+'function run(){try{return '+(asynchronous?'await ':'')+
        'fail();}finally{host.store("cleanup",1);}}',entry:'run',
      family:'implicit-error-cleanup',fixture:{calls:[{operation:'demo.store',arguments:['cleanup',1]}]}});
    assert.equal(checked.status,'locally_verified',checked.reason);
    const fixture=controlledEvaluationCase(checked.exported,{id:'implicit-error-cleanup'});
    const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
      request:fixture.request,seed:17,representation:'compact'});
    assert.equal(actual.failure,null,JSON.stringify(actual.failure));
    assert.deepEqual(actual.outcome,fixture.expected);
    assert.equal(actual.outcome.completion.kind,'throw');
    assert.deepEqual(actual.outcome.cleanup,{pendingEffects:0,pendingJobs:0,openHandlers:0});
  }
});

test('exact error messages and unsupported Error features still gate implicit faults',async()=>{
  const mismatch=await verifyEffectfulTrainingCase({
    source:'"use strict";function run(){return [1].with(2,3);}',entry:'run',
    family:'implicit-error-message-boundary',fixture:{calls:[]}});
  assert.equal(mismatch.status,'reference_outcome_mismatch');
  for(const access of ['e.stack','Object.keys(e)','(e.name="Other")']){
    const checked=await verifyEffectfulTrainingCase({
      source:'"use strict";function run(){try{let x=x;}catch(e){return '+access+';}}',
      entry:'run',family:'implicit-error-profile-boundary',fixture:{calls:[]}});
    assert.notEqual(checked.status,'locally_verified');
    assert.notEqual(checked.status,'admitted');
  }
});
