import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {reconstruct,validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {SHARED_TYPE_NAMES} from '../src/owned-shared-memory.js';

function stopped(text){
  const runtime=createRuntime();
  const source=runtime.registerSource({text,scriptProfile:true});
  runtime.startScriptSequence([source]);
  assert.equal(runtime.drive().kind,'unsupported');
  return JSON.parse(JSON.stringify(runtime.exportRun()));
}

test('terminal expression, constructor and randomness refusals validate and exactly replay',()=>{
  for(const text of ['void /x.y/g;','new Number(1);','Math.random();']){
    const bundle=stopped(text);
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
    assert.equal(bundle.events.at(-1).completion.type,'unsupported');
    assert.equal(bundle.finalState.control.a0.status,'unsupported');
  }
});

test('unsupported completion cannot enter guest catch/finally or settle an async result',()=>{
  const bundle=stopped('async function f(){try{await /x.y/g;}catch(error){print("caught");}'+
    'finally{print("finally");}}f();');
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  assert.deepEqual(bundle.finalState.control.a0.test262Output,[]);
  const frame=bundle.finalState.frames[bundle.finalState.control.a0.failure.frameId];
  assert.equal(frame.status,'unsupported');
  assert.equal(bundle.finalState.promises[frame.asyncPromiseId].status,'pending');
});

test('independent reconstruction rejects forged unsupported instructions and terminal ownership',()=>{
  const original=stopped('void /x.y/g;');
  const mutate=change=>{
    const bundle=structuredClone(original),event=bundle.events.at(-1);
    change(event,bundle);
    // Ignore final-state/checkpoint equality here: the independent event checks
    // must reject corruption before those generic consistency checks run.
    assert.throws(()=>reconstruct(bundle),/unsupported|Unsupported/);
  };
  mutate(event=>{delete event.completion;});
  mutate(event=>{
    event.completion.feature='invented refusal';
    for(const patch of event.stateChanges){
      if(patch.table==='frames')patch.after.completion.feature='invented refusal';
      else patch.after.failure.completion.feature='invented refusal';
    }
  });
  mutate(event=>{event.operation='primitive.binary';event.catalogRef='primitive.binary/1';});
  mutate(event=>{event.stateChanges.find(p=>p.table==='control').after.activeFrameId=event.invocationId;});
  mutate(event=>{event.stateChanges.find(p=>p.table==='frames').after.status='thrown';});
  mutate(event=>{event.stateChanges.find(p=>p.table==='frames').after.pc++;});
  mutate(event=>{event.result=['undefined'];});
  mutate(event=>{event.operands=[['num',1]];event.operandOrigins=[null];});
});

test('unsupported operand provenance and pending frame state cannot be rewritten',()=>{
  for(const text of ['new Number(1);','Math.random();']){
    const bundle=stopped(text),event=bundle.events.at(-1);
    event.operandOrigins[0]=null;
    assert.throws(()=>reconstruct(bundle),/Invalid owned unsupported completion/);
  }
  const bundle=stopped('Math.random();'),event=bundle.events.at(-1);
  event.stateChanges.find(p=>p.table==='frames').after.stack.push({value:['num',7],origin:null});
  assert.throws(()=>reconstruct(bundle),/Unowned terminal unsupported completion/);
});

test('owned constructor transitions cannot be forged into valid profile refusals',()=>{
  const calls=['Symbol()','Error()','EvalError()','RangeError()','ReferenceError()',
    'SyntaxError()','TypeError()','URIError()','Promise(function(resolve){resolve(1);})',
    'Set()','ArrayBuffer(1)','SharedArrayBuffer(1)','DataView(new ArrayBuffer(1))',
    ...SHARED_TYPE_NAMES.map(name=>name+'(1)')];
  for(const call of calls){
    const runtime=createRuntime();
    const source=runtime.registerSource({text:'new '+call+';',scriptProfile:true});
    runtime.startScriptSequence([source]);runtime.drive();
    const bundle=runtime.exportRun();
    assert.equal(validateBundle(bundle).valid,true,call);
    const index=bundle.events.findLastIndex(event=>event.operation==='object.construct');
    const before=reconstruct(bundle,{throughEventId:bundle.events[index-1].eventId});
    const event=structuredClone(bundle.events[index]),frame=before.frames[event.invocationId];
    const control=before.control.a0,instruction=bundle.programs[frame.codeId].instructions[frame.pc];
    const operands=frame.stack.slice(-instruction.arg-1);
    const completion={type:'unsupported',feature:'Constructor requires owned semantics: '+operands[0].value[1]};
    Object.assign(event,{completion,result:null,causes:[],readObservations:[],
      operands:operands.map(token=>token.value),operandOrigins:operands.map(token=>token.origin),stateChanges:[
      {kind:'frames.replace',table:'frames',id:frame.id,before:frame,after:{...frame,pc:frame.pc+1,
        stack:frame.stack.slice(0,frame.stack.length-instruction.arg-1),status:'unsupported',
        completion,version:frame.version+1}},
      {kind:'control.replace',table:'control',id:'a0',before:control,after:{...control,
        status:'unsupported',activeFrameId:null,failure:{kind:'unsupported',frameId:frame.id,completion},
        version:control.version+1}}
    ]});
    bundle.events=[...bundle.events.slice(0,index),event];
    assert.throws(()=>reconstruct(bundle),/Owned constructor cannot become a generic unsupported completion/,call);
  }
});
