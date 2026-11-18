import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';

test('a synchronous root replays authenticated async helper declarations and reactions',async()=>{
  for(const body of [
    'async function helper(){return 7;}function run(){return helper();}',
    'async function fail(){throw 7;}function run(){return fail().catch(e=>e);}',
    'async function fail(a=b,b=3){}function run(){return fail().catch(e=>e.name);}',
    'async function unused(){return 8;}function run(){return 7;}'
  ]){
    const result=await verifyEffectfulTrainingCase({source:'"use strict";'+body,
      entry:'run',family:'async-helper-replay',fixture:{calls:[]}});
    assert.equal(result.status,'locally_verified',body+': '+result.reason);
    assert.equal(result.exported.sidecar.reference.outcome.kind,'return');
    const rechecked=await recheckEffectfulAdmission(result.exported,{requireAdmitted:false});
    assert(rechecked.sourceValidated&&rechecked.replayValidated&&rechecked.effectsValidated);
  }
});

test('disabled async entry profile still refuses and async replay does not enable host bindings',()=>{
  const source='"use strict";async function helper(){return 7;}function run(){return typeof host;}';
  for(const options of [{},{allowAsync:false}])
    assert.throws(()=>createRuntime().startEntry({text:source,functionName:'run',args:[],...options}),
      /strict owned static\/function bundle/);
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});
  runtime.drive();const archive=runtime.exportRun();
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  assert.deepEqual(runtime.result,['str','undefined']);
  assert.equal(archive.initialState.envs[archive.initialState.control.a0.globalEnvId].bindings.host,undefined);
});

test('untrusted async bytecode annotations cannot widen the recompiled source profile',()=>{
  const runtime=createRuntime().startEntry({text:'"use strict";function run(){return 7;}',functionName:'run',args:[]});
  runtime.drive();const archive=runtime.exportRun();
  const forged=structuredClone(archive);
  const declaration=Object.values(forged.programs).flatMap(program=>program.instructions)
    .find(instruction=>instruction.op==='DEF_FN');
  declaration.arg.async=true;
  assert.throws(()=>replayExact(forged),/Replay divergence: compiled bytecode/);
});
