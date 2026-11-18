import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {ownedEffectfulOutcome} from '../src/training/effectful-compiler.js';
import {describeCompletionGraph} from '../src/training/exception-profile.js';

const checked=code=>verifyEffectfulTrainingCase({source:'"use strict";'+code,
  entry:'run',family:'parameter-projection',fixture:{calls:[]}});

test('parameter TDZ reads, typeof, writes and updates project genuine implicit ReferenceErrors',async()=>{
  for(const code of [
    'const b=9;function run(a=b,b=3){return a;}',
    'const a=9;function run(a=a){return a;}',
    'const b=9;function run(a=typeof b,b=3){return a;}',
    'function run(a=b++,b=3){return a;}',
    'function run(a=(b=4),b=3){return a;}',
    'async function run(a=b,b=3){return a;}'
  ]){
    const result=await checked(code);
    assert.equal(result.status,'locally_verified',code+': '+result.reason);
    assert.equal(result.exported.sidecar.reference.outcome.kind,'throw');
    assert.deepEqual(result.exported.sidecar.reference.outcome.graph.objects[0].properties[0],
      ['name',['str','ReferenceError']]);
    const rechecked=await recheckEffectfulAdmission(result.exported,{requireAdmitted:false});
    assert(rechecked.sourceValidated&&rechecked.replayValidated&&rechecked.effectsValidated);
  }
});

test('implicit parameter errors unwind callers, honor catch/finally and never run later initialization',async()=>{
  for(const code of [
    'let count=0;function fail(a=b,b=count++){count=99;}function run(){try{fail();}catch(e){return [e.name,e.message,count];}}',
    'function fail(a=b,b=3){}function middle(){fail();}function run(){middle();}',
    'function fail(a=b,b=3){}function run(){try{fail();}finally{const n=1;}}',
    'function fail(a=b,b=3){}function run(){try{fail();}finally{return 7;}}'
  ]){
    const result=await checked(code);
    assert.equal(result.status,'locally_verified',code+': '+result.reason);
  }
  const result=await checked('const b=9;function run(a=b,b=3){return a;}');
  const fixture=controlledEvaluationCase(result.exported,{id:'parameter-tdz'});
  const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',
    caseId:fixture.id,request:fixture.request,seed:17,representation:'compact'});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));
  assert.deepEqual(actual.outcome,fixture.expected);
});

test('parameter TDZ evidence binds an actual uninitialized cell and owned error allocation',()=>{
  const runtime=createRuntime().startEntry({text:'"use strict";function run(a=b,b=3){}',functionName:'run',args:[]});
  assert.equal(runtime.drive().kind,'runtime.failure');
  const archive=runtime.exportRun();
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  const event=archive.events.find(event=>event.completion?.parameterTdz);
  assert(event);
  const wrongCell=structuredClone(archive);
  wrongCell.events.find(row=>row.eventId===event.eventId).completion.parameterTdz.name='a';
  assert.throws(()=>validateBundle(wrongCell),/Invalid committed parameter TDZ exception/);
  const wrongValue=structuredClone(archive);
  wrongValue.events.find(row=>row.eventId===event.eventId).completion.value={value:['num',3],origin:event.eventId};
  assert.throws(()=>validateBundle(wrongValue),/Invalid committed parameter TDZ exception/);
});

test('interpreter errors and resource exhaustion remain failures outside the parameter throw boundary',async()=>{
  const runtime=createRuntime().startEntry({text:'"use strict";function run(){return 1;}',functionName:'run',args:[]});
  const frame=runtime.state.frames[runtime.state.control.a0.activeFrameId];
  runtime.programs[frame.codeId].instructions[frame.pc].op='INJECTED_INVALID_OPCODE';
  assert.throws(()=>runtime.drive(),/Unknown opcode INJECTED_INVALID_OPCODE/);
  assert.equal(runtime.state.control.a0.failure,undefined);
  const limited=await verifyEffectfulTrainingCase({source:'"use strict";function run(){while(true){}}',
    entry:'run',family:'parameter-resource-boundary',maxSteps:2,fixture:{calls:[]}});
  assert(!['admitted','locally_verified'].includes(limited.status));
  assert.equal(limited.exported,undefined);
});

test('coercion propagates the original authenticated parameter error without allocating a second error',async()=>{
  for(const body of [
    'return {valueOf:fail}+1;',
    'try{return {valueOf:fail}+1;}catch(e){return [e.name,e.message,e===e];}',
    'try{return {valueOf:fail}+1;}finally{return 8;}'
  ]){
    const source='"use strict";function fail(a=b,b=3){}function run(){'+body+'}';
    const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});
    runtime.drive();const archive=runtime.exportRun();
    assert.equal(validateBundle(archive).valid,true);
    assert.equal(replayExact(archive).valid,true);
    let kind='return',value;
    try{value=Function(source+';return run;')()();}catch(error){kind='throw';value=error;}
    assert.deepEqual(ownedEffectfulOutcome(archive),{kind,graph:describeCompletionGraph([],value,kind)});
    // Function references installed as object coercion hooks remain outside
    // the public projection profile, just as they do for explicit throws.
    const result=await checked(source.slice('"use strict";'.length));
    assert.equal(result.status,'projection_refused',body+': '+result.reason);
    assert.match(result.reason,/unallocated owned identity/);
  }
  const runtime=createRuntime().startEntry({text:'"use strict";function fail(a=b,b=3){}function run(){return {valueOf:fail}+1;}',functionName:'run',args:[]});
  runtime.drive();const archive=runtime.exportRun();
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  const [origin,propagation]=archive.events.filter(event=>event.completion?.parameterTdz);
  assert.equal(propagation.operation,'spec.operation.complete');
  assert.deepEqual(propagation.completion,origin.completion);
  assert(!propagation.stateChanges.some(change=>change.table==='heap'&&change.before===null));
  const forged=structuredClone(archive);
  forged.events.find(event=>event.eventId===propagation.eventId).completion.origin='a0:e1';
  assert.throws(()=>validateBundle(forged),/Invalid propagated parameter TDZ exception/);
});
