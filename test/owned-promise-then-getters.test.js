import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {validatePromiseResolutionState} from '../src/promise-resolution-validation.js';
import {encode} from '../src/values.js';

const wire=value=>JSON.parse(JSON.stringify(value));
const read=(runtime,name)=>Object.values(runtime.state.envs)
  .flatMap(environment=>Object.entries(environment.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
function start(source){
  return createRuntime().startEntry({text:'"use strict";function run(){'+source+'}',functionName:'run'});
}
async function differential(source){
  const runtime=start(source);
  assert.equal(runtime.drive().kind,'terminated');
  const archive=wire(runtime.exportRun());
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  const context=vm.createContext({queueMicrotask});
  vm.runInContext('"use strict";'+source,context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(read(runtime,'order'),encode(vm.runInContext('order',context)));
  return {runtime,archive};
}

test('then getter runs synchronously once and the captured method runs as a job with its receiver',async()=>{
  const {runtime}=await differential(`let order='';let reads=0;
    const thenable={value:7,get then(){reads++;order+='g';
      return function(resolve){order+='t';resolve(this.value);};}};
    Promise.resolve(thenable).then(value=>{order+=value;});
    order+='s';queueMicrotask(()=>{order+='q';});`);
  assert.deepEqual(read(runtime,'order'),['str','gstq7']);
  assert.deepEqual(read(runtime,'reads'),['num',1]);
});

test('throwing then getter rejects the Promise without escaping resolve or violating first-call ownership',async()=>{
  await differential(`let order='';let rejectLater;
    const thenable={get then(){order+='g';rejectLater(3);throw 7;}};
    const promise=new Promise((resolve,reject)=>{rejectLater=reject;
      try{resolve(thenable);order+='r';}catch(error){order+='bad';}
      resolve(9);reject(11);});
    promise.catch(error=>{order+=error;});order+='s';`);
});

test('noncallable then getter fulfills with the original identity',async()=>{
  await differential(`let order='';const thenable={get then(){order+='g';return 1;}};
    Promise.resolve(thenable).then(value=>{order+=value===thenable?'y':'n';});order+='s';`);
});

test('nested synchronous then getters preserve both caller continuations',async()=>{
  await differential(`let order='';
    const inner={get then(){order+='i';return resolve=>{order+='I';resolve(2);};}};
    const outer={get then(){order+='o';Promise.resolve(inner).then(v=>{order+=v;});
      order+='g';return resolve=>{order+='O';resolve(3);};}};
    Promise.resolve(outer).then(v=>{order+=v;});order+='s';`);
});

test('thenable resolution reads a nested then getter before returning to the old then method',async()=>{
  await differential(`let order='';
    const inner={get then(){order+='g';return resolve=>{order+='i';resolve(7);};}};
    const outer={then(resolve,reject){order+='o';resolve(inner);order+='x';reject(9);throw 11;}};
    Promise.resolve(outer).then(v=>{order+=v;},e=>{order+='e'+e;});
    queueMicrotask(()=>{order+='q';});`);
});

test('then getters during async return and await execute before the caller resumes',async()=>{
  for(const body of ['return thenable;','const value=await thenable;order+=value;return 9;'])
    await differential(`let order='';
      const thenable={get then(){order+='g';return resolve=>{order+='t';resolve(7);};}};
      async function work(){order+='a';${body}}
      work().then(value=>{order+='v'+value;});order+='s';
      queueMicrotask(()=>{order+='q';});`);
});

test('then and finally result getters retain reaction completion and competing microtask order',async()=>{
  for(const method of ['then','finally'])for(const body of [
    "order+='g';return resolve=>{order+='t';resolve(9);};",
    "order+='g';throw 11;"
  ])await differential(`let order='';const thenable={get then(){${body}}};
    Promise.resolve(7).${method}(()=>{order+='f';return thenable;})
      .then(value=>{order+='v'+value;},error=>{order+='e'+error;});
    Promise.resolve().then(()=>{order+='a';}).then(()=>{order+='b';})
      .then(()=>{order+='c';}).then(()=>{order+='d';});`);
});

test('Promise combinators complete each then lookup before beginning the next one',async()=>{
  for(const method of ['all','race','allSettled','any'])await differential(`let order='';
    const first={get then(){order+='a';return resolve=>{order+='A';resolve(3);};}};
    const second={get then(){order+='b';return resolve=>{order+='B';resolve(4);};}};
    Promise.${method}([first,second]).then(()=>{order+='v';});
    order+='s';queueMicrotask(()=>{order+='q';});`);
});

test('Promise combinator array iteration observes mutations and holes after each getter',async()=>{
  await differential(`let order='';let inputs;
    const first={get then(){order+='g';inputs[1]=9;inputs.push(11);return resolve=>resolve(7);}};
    inputs=[first,3];Promise.all(inputs).then(values=>{order+=values.join(',');});order+='s';`);
  await differential(`let order='';let inputs;
    const first={get then(){order+='g';inputs.length=1;return resolve=>resolve(7);}};
    inputs=[first,3];Promise.all(inputs).then(values=>{order+=values.join(',');});order+='s';`);
  await differential(`let order='';Promise.all([,3]).then(values=>{
    order+=(values[0]===undefined?'u':'bad')+values[1];});order+='s';`);
});

test('inherited and callable-object then getters are owned, with the original receiver',async()=>{
  await differential(`let order='';const prototype={get then(){order+=this.tag;
      return function(resolve){resolve(this.value);};}};
    const thenable=Object.create(prototype);thenable.tag='g';thenable.value=7;
    Promise.resolve(thenable).then(v=>{order+=v;});order+='s';`);
  await differential(`let order='';function thenable(){}
    Object.setPrototypeOf(thenable,{get then(){order+='g';return resolve=>resolve(7);}});
    Promise.resolve(thenable).then(v=>{order+=v;});order+='s';`);
});

test('Proxy then lookup uses the trap receiver and rechecks the live target invariant',async()=>{
  await differential(`let order='';const target={tag:7};
    const handler={get(object,key,receiver){order+=key==='then'?'g':'x';
      return resolve=>resolve(receiver===proxy?object.tag:0);}};
    const proxy=new Proxy(target,handler);
    Promise.resolve(proxy).then(v=>{order+=v;});order+='s';`);
  await differential(`let order='';const target={};
    const proxy=new Proxy(target,{get(object,key){order+='g';
      Object.defineProperty(object,'then',{value:1,writable:false,configurable:false});
      return resolve=>resolve(7);}});
    Promise.resolve(proxy).catch(error=>{order+=error.name;});order+='s';`);
  await differential(`let order='';const proxy=new Proxy({},{get:3});
    try{Promise.resolve(proxy).catch(error=>{order+=error.name;});order+='s';}
    catch(error){order+='bad';}`);
});

test('async then getter returns its Promise as a noncallable method without awaiting it',async()=>{
  await differential(`let order='';const thenable={};
    Object.defineProperty(thenable,'then',{get:async function(){order+='g';await 0;order+='G';return 7;}});
    Promise.resolve(thenable).then(value=>{order+=value===thenable?'v':'bad';});order+='s';`);
});

test('then lookup JSON restoration does not repeat already executed getter work',()=>{
  const source=`let order='';const thenable={get then(){order+='g';
    return resolve=>{order+='t';resolve(7);};}};
    Promise.resolve(7).finally(()=>thenable).then(v=>{order+=v;});`;
  const runtime=start(source);
  while(!Object.values(runtime.state.frames).some(frame=>frame.promiseThenLookup&&!frame.promiseThenLookup.delivered)){
    if(runtime.state.control.a0.activeFrameId)runtime.step();else runtime.enterQueuedJob();
  }
  // Checkpoint after the getter has written its observable marker.
  while(read(runtime,'order')?.[1]!=='g')runtime.step();
  const snapshot=wire(Object.fromEntries(Object.entries(runtime).filter(([name])=>name!=='adapters')));
  const restored=Object.assign(createRuntime(),snapshot);
  assert.equal(runtime.drive().kind,'terminated');assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(wire(restored.exportRun()),wire(runtime.exportRun()));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
  assert.deepEqual(read(restored,'order'),['str','gt7']);
  const forged=structuredClone(snapshot.state),frame=Object.values(forged.frames).find(value=>value.promiseThenLookup);
  frame.promiseThenLookup.resume.kind='unowned';
  assert.throws(()=>validatePromiseResolutionState(forged,message=>{throw Error(message);}),/resume/);
  const altered=runtime.exportRun(),created=altered.events.flatMap(event=>event.stateChanges)
    .find(change=>change.table==='frames'&&change.before===null&&change.after?.promiseThenLookup);
  created.after.thisValue=['num',404];
  assert.throws(()=>validateBundle(altered),/lookup callback receiver/);
});
