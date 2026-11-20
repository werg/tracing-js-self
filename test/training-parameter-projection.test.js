import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {ownedEffectfulOutcome} from '../src/training/effectful-compiler.js';
import {describeCompletionGraph} from '../src/training/exception-profile.js';
import {decodeWitness} from '../src/training/format.js';

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
    assert.match(result.reason,/unallocated owned identity|Selected work is not in the active invocation/);
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
  const replaced=structuredClone(archive);
  replaced.events.find(event=>event.eventId===propagation.eventId).completion.value.value=['num',3];
  assert.throws(()=>validateBundle(replaced),/Invalid propagated parameter TDZ exception/);
});

test('forward parameter closures publish only after captured cells actually initialize',async()=>{
  for(const code of [
    'const b=7;function run(a=()=>b,b=3){return a();}',
    'function run(a=function(){return b;},b=3){return a();}',
    'function run(a=()=>b,b=3){b=5;return a();}',
    'function run(a=()=>b,b=3){var b=5;return a();}',
    'function run(a=()=>b,b=3,c=a){b=5;return [c===a,c()];}',
    'function run(a=()=>[b,c],b=3,c=4){b=6;return a();}',
    'function run(a=()=>b,b={n:3}){return a().n;}'
  ]){
    const result=await checked(code);
    assert.equal(result.status,'locally_verified',code+': '+result.reason);
    const rechecked=await recheckEffectfulAdmission(result.exported,{requireAdmitted:false});
    assert(rechecked.sourceValidated&&rechecked.replayValidated&&rechecked.effectsValidated);
  }
  const result=await checked('const b=7;function run(a=()=>b,b=3){return a();}');
  const records=result.exported.public.timeline.filter(row=>row.kind==='semantic')
    .map(row=>({...decodeWitness(row.line),sequence:row.sequence}));
  assert.deepEqual(records[0].fields,{name:'b',value:['num',3]});
  assert.equal(records[1].kind,'allocate');
  assert.deepEqual(records[1].fields.captures,[{binding:'b',cell:'b'}]);
  assert.deepEqual(records[2].fields,{name:'a',value:['ref',records[1].fields.name]});
  const certificate=result.exported.sidecar.compiler.certificates.find(row=>row.sequence===records[1].sequence);
  assert.equal(certificate.rule,'owned-deferred-parameter-closure/4');
  assert.equal(certificate.journalEvents[0],certificate.allocationEvent);
  assert.equal(certificate.journalEvents.at(-1),certificate.initializationBoundary);
  assert.notEqual(certificate.allocationEvent,certificate.initializationBoundary);
  const fixture=controlledEvaluationCase(result.exported,{id:'parameter-forward-capture'});
  const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
    request:fixture.request,seed:17,representation:'compact'});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));
  assert.deepEqual(actual.outcome,fixture.expected);
});

test('a provided object keeps its observed identity through deferred capture and later alias mutation',async()=>{
  const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(a=()=>b,b){b.n=5;return [a()===b,a().n];}',
    entry:'run',args:[undefined,{n:1}],family:'parameter-capture-object',fixture:{calls:[]}});
  assert.equal(result.status,'locally_verified',result.reason);
  const rechecked=await recheckEffectfulAdmission(result.exported,{requireAdmitted:false});
  assert(rechecked.sourceValidated&&rechecked.replayValidated&&rechecked.effectsValidated);
});

test('deferred capture refuses early reads, effects, exceptions and circular dependencies',async()=>{
  for(const code of [
    'function run(a=()=>b,b=a()){return b;}',
    'function run(a=()=>b,c=a,b=3){return c();}',
    'function run(a=()=>a){return a()===a;}',
    'function run(a=()=>b,b=()=>c,c=3){return a()();}',
    'function fail(){throw 7;}function run(a=()=>b,b=fail()){return a();}',
    'function run(){function f(a=()=>[x,b],b=3){return a();}return f();let x=1;}'
  ]){
    const result=await checked(code);
    assert.equal(result.status,'projection_refused',code+': '+result.reason);
    assert.match(result.reason,/deferred parameter|deferred closure/);
    assert.equal(result.exported,undefined);
  }
  const effect=await verifyEffectfulTrainingCase({source:'"use strict";function run(a=()=>b,b=host.store("x",1)){return a();}',
    entry:'run',family:'parameter-capture-effect',fixture:{calls:[{operation:'demo.store',arguments:['x',1]}]}});
  assert.equal(effect.status,'projection_refused',effect.reason);
  assert.match(effect.reason,/deferred parameter closure crosses/);
});
