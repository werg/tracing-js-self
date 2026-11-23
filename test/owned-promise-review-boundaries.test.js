import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRuntime} from '../src/runtime.js';
import {validateBundle,reconstruct} from '../src/validation.js';
import {validatePromiseResolutionEvent} from '../src/promise-resolution-validation.js';
import {replayExact} from '../src/replay.js';
import {encode} from '../src/values.js';

const wire=value=>JSON.parse(JSON.stringify(value));
const read=(runtime,name)=>Object.values(runtime.state.envs).flatMap(env=>Object.entries(env.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
const start=body=>createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});
function nativeOrder(body){
  const reference=spawnSync(process.execPath,['-e','"use strict";function run(){'+body+
    ';setImmediate(()=>process.stdout.write(JSON.stringify(order)));}run();'],{encoding:'utf8',timeout:10000});
  assert.equal(reference.status,0,reference.stderr||String(reference.error));
  return encode(JSON.parse(reference.stdout));
}
function checked(runtime,body){
  assert.equal(runtime.drive().kind,'terminated');
  const archive=wire(runtime.exportRun());
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  if(body!==undefined)assert.deepEqual(read(runtime,'order'),nativeOrder(body));
  return {runtime,archive};
}
const differential=body=>checked(start(body),body);
const snapshots=archive=>[archive.initialState,archive.finalState,...Object.values(archive.checkpoints)];

test('generator constructor and species getters refuse before entry and cannot become a caught success',()=>{
  for(const [setup,call,expected]of[
    ["Object.defineProperty(p,'constructor',{get:function*(){order+='bad';}});",
      "Promise.resolve(p).then(value=>{order+=value;});",'s1'],
    ["Object.defineProperty(p,'constructor',{get:function*(){order+='bad';}});",
      "p.then(value=>{order+=value;});",'s1'],
    ["const constructor={};p.constructor=constructor;Object.defineProperty(constructor,Symbol.species,{get:function*(){order+='bad';}});",
      "p.then(value=>{order+=value;});",'cs'],
    ["Object.defineProperty(p,'constructor',{get:function*(){order+='bad';}});",
      "async function work(){try{const value=await p;order+=value;}catch(error){order+='c';}}work();",'s1']
  ]){
    const body=`let order='';const p=Promise.resolve(1);${setup}try{${call}}catch(error){order+='c';}order+='s';`;
    assert.deepEqual(nativeOrder(body),['str',expected]);
    const runtime=start(body);
    assert.throws(()=>runtime.drive(),/Generator Promise constructor getters are outside the owned profile/);
    assert.deepEqual(read(runtime,'order'),['str','']);
    assert.equal(Object.values(runtime.state.frames).some(frame=>frame.promiseConstructorLookup),false);
  }
  differential(`let order='';const p=Promise.resolve(1);Object.defineProperty(p,'constructor',{
    get(){order+='g';return Promise;}});order+=Promise.resolve(p)===p?'p':'bad';`);
});

test('async finally suspension and throw retain cleanup getter ownership and exact restoration',()=>{
  for(const exit of ["await 0;order+='a';",'throw 7;']){
    const body=`let order='';Promise.resolve(1).finally(async()=>{order+='f';
      Object.defineProperty(Promise.prototype,'constructor',{get(){order+='g';return Promise;},configurable:true});
      ${exit}}).then(value=>{order+='v'+value;},error=>{order+='e'+error;});queueMicrotask(()=>{order+='q';});`;
    const runtime=start(body),saved=new Map();
    for(let steps=0;steps<1000;steps++){
      const control=runtime.state.control.a0,frame=runtime.state.frames[control.activeFrameId],
        continuation=frame?.promiseConstructorLookup?.continuation;
      if(continuation?.kind==='finally'&&!frame.promiseConstructorLookup.delivered){
        const key=continuation.stage+':'+runtime.state.frames[continuation.frameId].status;
        if(!saved.has(key))saved.set(key,wire(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters'))));
      }
      if(frame?.status==='running')runtime.step();
      else if(control.queue.length)runtime.enterQueuedJob();
      else break;
    }
    const {archive}=checked(runtime,body),status=exit.startsWith('await')?'suspended':'thrown';
    assert.deepEqual([...saved.keys()].sort(),['resolve:'+status,'then:'+status]);
    for(const [boundary,snapshot]of saved){
      const restored=Object.assign(createRuntime(),snapshot);
      assert.equal(restored.drive().kind,'terminated',boundary);
      assert.deepEqual(wire(restored.exportRun()),archive,boundary);
      assert.equal(validateBundle(restored.exportRun()).valid,true);
      assert.equal(replayExact(restored.exportRun()).valid,true);
    }
  }
});

test('an async finally cleanup getter throw rejects the matching result while the callback resumes',()=>{
  differential(`let order='';const reason={tag:7};Promise.resolve(1).finally(async()=>{order+='f';
    Object.defineProperty(Promise.prototype,'constructor',{get(){order+='g';throw reason;},configurable:true});
    await 0;order+='a';}).then(()=>{order+='bad';},error=>{order+=error===reason?'e':'bad';});
    queueMicrotask(()=>{order+='q';});`);
  differential(`let order='';const p=Promise.resolve(1);Object.defineProperty(p,'constructor',{
    get(){order+='g';const missing=null;return missing.constructor;}});async function work(){return p;}
    work().catch(error=>{order+=error.name;});`);
});

test('await retains the selected wrapper and synchronous then getter invocation before suspension',()=>{
  for(const promise of [true,false]){
    const body=`let order='';const p=${promise?'Promise.resolve(1)':'{}'};
      ${promise?"Object.defineProperty(p,'constructor',{value:undefined});":''}
      Object.defineProperty(p,'then',{get(){order+='g';return function(resolve){order+=this===p?'t':'bad';resolve(7);};}});
      async function work(){order+='a';const value=await p;order+=value;order+='z';}
      work().then(()=>{order+='r';});queueMicrotask(()=>{order+='q';});`;
    const {archive}=differential(body),event=archive.events.find(event=>event.operation==='async.await'),
      getter=event.stateChanges.find(change=>change.table==='frames'&&change.before===null&&change.after?.promiseThenLookup),
      wrapper=getter.after.promiseThenLookup.promiseId;
    assert.deepEqual(event.causes,[{kind:'promise',promiseId:wrapper},{kind:'invocation',frameId:getter.id}]);
    assert.equal(getter.after.promiseThenLookup.resume.promiseId,wrapper);
    assert.equal(event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId).after.awaiting,null);
    for(const mutate of[
      causes=>{causes[0].promiseId=null;},
      causes=>{causes[0].promiseId='p404';},
      causes=>{causes[1].frameId=event.invocationId;},
      causes=>{causes.pop();},
      causes=>{causes.push({...causes[0]});}
    ]){
      const forged=wire(archive);mutate(forged.events[event.sequence-1].causes);
      assert.throws(()=>validateBundle(forged),/Promise await dependency or getter invocation evidence/);
    }
  }
});

test('thenable entry authenticates the invocation cause, active frame and exact captured environment',()=>{
  const {archive}=differential(`let order='';const captured=9;
    const t={then:function(resolve){order+='t';resolve(captured);}};
    Promise.resolve(t).then(value=>{order+=value;});`),
    event=archive.events.find(event=>event.stateChanges.some(change=>change.after?.thenableJob)),
    frame=event.stateChanges.find(change=>change.table==='frames'&&change.before===null&&change.after?.thenableJob).after;
  const cause=wire(archive);
  cause.events[event.sequence-1].causes.find(cause=>cause.kind==='invocation').frameId=Object.keys(archive.initialState.frames)[0];
  assert.throws(()=>validateBundle(cause),/Queued thenable changed its invocation/);
  const active=wire(archive);
  active.events[event.sequence-1].stateChanges.find(change=>change.table==='control').after.activeFrameId=Object.keys(archive.initialState.frames)[0];
  assert.throws(()=>reconstruct(active,{throughEventId:event.eventId}),/Queued thenable changed its invocation/);
  const captured=wire(archive),parent=Object.keys(archive.initialState.envs)[0];
  for(const row of captured.events)for(const change of row.stateChanges)
    if(change.table==='envs'&&change.id===frame.envId)for(const entity of[change.before,change.after])if(entity)entity.parent=parent;
  for(const state of snapshots(captured))if(state.envs[frame.envId])state.envs[frame.envId].parent=parent;
  assert.throws(()=>validateBundle(captured),/Queued thenable changed its invocation, capture/);
  differential(`let order='';const holder={go(){const then=resolve=>{order+=this===holder?'h':'bad';resolve(9);};
    Promise.resolve({then}).then(value=>{order+=value;});}};holder.go();`);
});

test('constructor getter throws require the current pending destination and exact opaque rejection token',()=>{
  const {archive}=checked(start(`let order='';const reason={tag:7},p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){order+='g';throw reason;}});
    async function work(){return p;}work();work();`)),
    throws=archive.events.filter(event=>event.completion?.type==='throw'&&event.stateChanges.some(change=>change.after?.promiseConstructorLookup?.delivered)),
    previous=throws[0],event=throws.at(-1),frame=event.stateChanges.find(change=>change.after?.promiseConstructorLookup),
    destination=frame.after.promiseConstructorLookup.continuation.promiseId;
  assert.equal(event.eventId,archive.events.at(-1).eventId);
  const reason=wire(archive),wrong=reason.events[event.sequence-1].stateChanges.find(change=>change.table==='promises'&&change.id===destination);
  wrong.after.value={value:['num',999],origin:event.completion.value.origin};
  for(const state of snapshots(reason))if(state.promises[destination]?.status==='rejected')state.promises[destination].value=wire(wrong.after.value);
  assert.throws(()=>validateBundle(reason),/constructor throw did not reject its current destination with the exact reason/);
  const owner=wire(archive);owner.events[event.sequence-1].invocationId=previous.invocationId;
  assert.throws(()=>validateBundle(owner),/constructor throw did not reject its current destination/);
  const historical=wire(archive),current=historical.events[event.sequence-1],
    rejection=current.stateChanges.find(change=>change.table==='promises'&&change.id===destination),
    currentFrame=current.stateChanges.find(change=>change.table==='frames'&&change.id===frame.id);
  current.stateChanges=current.stateChanges.filter(change=>change!==rejection);
  current.completion=wire(previous.completion);current.operandOrigins=[previous.completion.value.origin];
  currentFrame.after.completion=wire(previous.completion);
  for(const state of snapshots(historical)){
    if(state.promises[destination]?.status==='rejected')state.promises[destination]=wire(rejection.before);
    if(state.frames[frame.id]?.status==='thrown')state.frames[frame.id].completion=wire(previous.completion);
  }
  assert.throws(()=>validateBundle(historical),/constructor throw did not reject its current destination/);
  differential(`let order='';const reason=Promise.resolve(7),p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){order+='g';throw reason;}});async function work(){return p;}
    work().catch(error=>{order+=error===reason?'e':'bad';});`);
});

test('nested helper and reentrant constructor throws retain their actual unwind chain and destination',()=>{
  for(const route of ['new Promise(resolve=>resolve(p))','Promise.resolve(2).finally(()=>p)'])
    for(const kind of ['opaque','classified','reentrant']){
      const body=`let order='';const reason={},p=Promise.resolve(1);
        function helper(){order+='h';${kind==='classified'?'const missing=null;return missing.value;':'throw reason;'}}
        ${kind==='reentrant'?"const inner=Promise.resolve(3);Object.defineProperty(inner,'constructor',{get(){order+='i';helper();}});":''}
        Object.defineProperty(p,'constructor',{get(){order+='g';${kind==='reentrant'?'Promise.resolve(inner);':'helper();'}}});
        ${route}.catch(error=>{order+=${kind==='classified'?"error.name==='TypeError'":"error===reason"}?'ok':'bad';});`;
      const {archive}=differential(body),event=archive.events.find(event=>event.completion?.type==='throw'&&
        event.stateChanges.some(change=>change.after?.promiseConstructorLookup?.delivered&&
          ['adopt','finally'].includes(change.after.promiseConstructorLookup.continuation.kind)));
      assert(event);
      const before=reconstruct(archive,{throughEventId:'a0:e'+(event.sequence-1)}),
        current=before.frames[event.invocationId];
      assert(current.callerFrameId);
      const forgedBefore=wire(before),forgedEvent=wire(event),unrelated=Object.keys(archive.initialState.frames)[0];
      assert.notEqual(current.callerFrameId,unrelated);
      forgedBefore.frames[current.id].callerFrameId=unrelated;
      forgedEvent.stateChanges.find(change=>change.table==='frames'&&change.id===current.id).before.callerFrameId=unrelated;
      assert.throws(()=>validatePromiseResolutionEvent(forgedBefore,forgedEvent,message=>{throw new Error(message);}),
        /constructor throw did not reject its current destination/);
    }
});

test('arrow constructor getters retain lexical this independently of the Promise property receiver',()=>{
  const {archive}=differential(`let order='';const holder={run(){const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get:()=>{order+=this===holder?'l':'bad';return Promise;}});
    order+=Promise.resolve(p)===p?'p':'bad';p.then(()=>{order+='v';});}};holder.run();`),
    event=archive.events.find(event=>event.stateChanges.some(change=>change.before===null&&change.after?.promiseConstructorLookup)),
    created=event.stateChanges.find(change=>change.before===null&&change.after?.promiseConstructorLookup);
  assert.equal(created.after.promiseConstructorLookup.receiver[0],'promise');
  assert.equal(created.after.thisValue[0],'ref');
  const forged=wire(archive),getter=forged.events[event.sequence-1].stateChanges.find(change=>change.id===created.id&&change.table==='frames');
  getter.after.thisValue=wire(getter.after.promiseConstructorLookup.receiver);
  assert.throws(()=>validateBundle(forged),/Promise constructor callback receiver changed/);
});
