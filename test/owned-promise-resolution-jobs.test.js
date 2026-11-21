import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {encode} from '../src/values.js';

const read=(runtime,name)=>Object.values(runtime.state.envs)
  .flatMap(environment=>Object.entries(environment.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
const wire=value=>JSON.parse(JSON.stringify(value));
async function differential(source,names=['order']){
  const runtime=createRuntime().start(source);
  assert.equal(runtime.drive().kind,'terminated');
  const archive=wire(runtime.exportRun());
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  const context=vm.createContext({queueMicrotask});
  vm.runInContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  for(const name of names)
    assert.deepEqual(read(runtime,name),encode(vm.runInContext(name,context)),name);
  return {runtime,archive};
}

const pendingAdoption=`let order='';let settle;
  let target=new Promise(function(resolve){settle=resolve;});
  let outer=new Promise(function(resolve){resolve(target);});
  outer.then(function(){order+='a';});target.then(function(){order+='d';});
  settle(7);queueMicrotask(function(){order+='q';});`;

test('pending Promise adoption preserves both assimilation and reaction jobs',async()=>{
  const {runtime,archive}=await differential(pendingAdoption);
  assert.deepEqual(read(runtime,'order'),['str','dqa']);
  const queues=archive.events.flatMap(event=>event.stateChanges
    .filter(change=>change.table==='control').map(change=>change.after.queue));
  assert(queues.some(queue=>queue.some(job=>job.kind==='promise-adopt')));
  assert(queues.some(queue=>queue.some(job=>job.kind==='adoption')));
});

test('already settled and rejected Promise adoption cannot overtake queued work',async()=>{
  for(const method of ['resolve','reject'])await differential(`let order='';
    let target=Promise.${method}(7);
    let outer=new Promise(function(resolve){resolve(target);});
    outer.then(function(v){order+='v'+v;},function(e){order+='e'+e;});
    Promise.resolve().then(function(){order+='a';})
      .then(function(){order+='b';}).then(function(){order+='c';});`);
});

test('repeated thenable identity is allowed and stale resolving pairs stay consumed',async()=>{
  const {runtime}=await differential(`let order='';let count=0;
    let thenable={then:function(resolve,reject){count+=1;
      if(count===1){resolve(thenable);reject(8);resolve(9);throw 10;}
      resolve(7);reject(11);throw 12;
    }};
    Promise.resolve(thenable).then(function(value){order+='v'+value;},
      function(){order+='e';});`,['order','count']);
  assert.deepEqual(read(runtime,'count'),['num',2]);
  assert.deepEqual(read(runtime,'order'),['str','v7']);
});

test('a finite thenable chain can exceed the former identity/length heuristic',async()=>{
  const {runtime}=await differential(`let order='';let count=0;
    let thenable={then:function(resolve){count+=1;
      if(count<70){resolve(thenable);}else{resolve(count);}
    }};Promise.resolve(thenable).then(function(value){order+='v'+value;});`,['order','count']);
  assert.deepEqual(read(runtime,'count'),['num',70]);
});

test('mutually adopting distinct Promises remain pending; only direct self-resolution rejects',()=>{
  const runtime=createRuntime().start(`let firstResolve;let secondResolve;let order='';
    let first=new Promise(function(resolve){firstResolve=resolve;});
    let second=new Promise(function(resolve){secondResolve=resolve;});
    firstResolve(second);secondResolve(first);
    first.catch(function(){order+='a';});second.catch(function(){order+='b';});`);
  assert.equal(runtime.drive().kind,'waiting');
  assert.deepEqual(read(runtime,'order'),['str','']);
  assert.equal(validateBundle(runtime.exportRun()).valid,true);
  assert.equal(replayExact(runtime.exportRun()).valid,true);
});

test('an unending thenable exhausts execution resources without a fabricated guest rejection',()=>{
  const runtime=createRuntime({maxSteps:300}).start(`let order='';
    let thenable={then:function(resolve){resolve(thenable);}};
    Promise.resolve(thenable).catch(function(){order+='rejected';});`);
  assert.throws(()=>runtime.drive(),/Driver safety limit/);
  assert.deepEqual(read(runtime,'order'),['str','']);
  assert.equal(Object.values(runtime.state.promises).some(promise=>promise.status==='rejected'),false);
});

test('callable finally retains primitive/Promise/thenable cleanup job ordering',async()=>{
  for(const cleanup of ['17','Promise.resolve(17)','{then:function(resolve){resolve(17);}}'])
    for(const method of ['resolve','reject'])await differential(`let order='';
      Promise.${method}(7).finally(function(){order+='f';return ${cleanup};})
        .then(function(value){order+='v'+value;},function(reason){order+='e'+reason;});
      Promise.resolve().then(function(){order+='a';}).then(function(){order+='b';})
        .then(function(){order+='c';}).then(function(){order+='d';});`);
});

test('finally throws and rejected cleanup replace the original outcome at the correct job',async()=>{
  for(const body of ['throw 9;','return Promise.reject(9);'])await differential(`let order='';
    Promise.resolve(7).finally(function(){order+='f';${body}})
      .then(function(value){order+='v'+value;},function(reason){order+='e'+reason;});
    Promise.resolve().then(function(){order+='a';}).then(function(){order+='b';})
      .then(function(){order+='c';}).then(function(){order+='d';});`);
});

test('async callbacks publish their promise after synchronous work and their first suspension',async()=>{
  for(const method of ['then','finally'])for(const body of [
    "order+='x';return 7;",
    "order+='x';await Promise.resolve(0);order+='y';return 7;",
    "order+='x';throw 9;"
  ])await differential(`let order='';
    Promise.resolve(5).${method}(async function(){${body}})
      .then(function(value){order+='v'+value;},function(reason){order+='e'+reason;});
    Promise.resolve().then(function(){order+='a';}).then(function(){order+='b';})
      .then(function(){order+='c';}).then(function(){order+='d';});`);
});

test('pending adoption, assimilation, finally and async callback boundaries restore from JSON',()=>{
  const source=pendingAdoption+`
    let count=0;let thenable={then:function(resolve){count+=1;
      if(count===1){resolve(thenable);}else{resolve(9);}}};
    Promise.resolve(thenable).finally(async function(){await Promise.resolve(0);order+='f';})
      .then(function(value){order+=value;});`;
  const runtime=createRuntime().start(source),snapshots=new Map();
  for(let steps=0;steps<1000;steps++){
    const control=runtime.state.control.a0,frame=runtime.state.frames[control.activeFrameId];
    const key=frame?.finallyReaction?'finally-callback':
      frame?.asyncPromiseId&&frame?.reactionJob?'async-callback':
      !frame&&control.queue[0]?.kind;
    if(['promise-adopt','adoption','thenable','finally-pass','finally-callback','async-callback'].includes(key)&&!snapshots.has(key))
      snapshots.set(key,wire(Object.fromEntries(Object.entries(runtime).filter(([name])=>name!=='adapters'))));
    if(frame?.status==='running')runtime.step();
    else if(control.queue.length)runtime.enterQueuedJob();
    else break;
  }
  runtime.drive();
  assert.deepEqual([...snapshots.keys()].sort(),['adoption','async-callback','finally-callback','finally-pass','promise-adopt','thenable']);
  for(const [boundary,snapshot] of snapshots){
    const restored=Object.assign(createRuntime(),snapshot);
    assert.equal(restored.drive().kind,'terminated',boundary);
    assert.deepEqual(wire(restored.exportRun()),wire(runtime.exportRun()),boundary);
    assert.equal(validateBundle(restored.exportRun()).valid,true);
    assert.equal(replayExact(restored.exportRun()).valid,true);
  }
});

test('forged adoption target or resolving owner is rejected independently',async()=>{
  const {archive}=await differential(pendingAdoption);
  const event=archive.events.find(row=>row.operation==='job.enter'&&
    row.stateChanges.some(change=>change.table==='control'&&change.before?.queue?.[0]?.kind==='promise-adopt'));
  assert(event);
  const changed=structuredClone(archive);
  changed.events[event.sequence-1].causes[0].promiseId='p404';
  assert.throws(()=>validateBundle(changed),/adoption/);
});
