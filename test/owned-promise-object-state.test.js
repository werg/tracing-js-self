import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {encode} from '../src/values.js';

const wire=value=>JSON.parse(JSON.stringify(value));
const read=(runtime,name)=>Object.values(runtime.state.envs).flatMap(env=>Object.entries(env.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
function start(body){return createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});}
function nativeOrder(body){
  // node:test enables async hooks that add host bookkeeping symbols to native
  // Promises. A fresh process keeps ordinary own-property reflection free of
  // that unrelated harness instrumentation.
  const reference=spawnSync(process.execPath,['-e','"use strict";'+body+
    ';setImmediate(()=>process.stdout.write(JSON.stringify(order)));'],{encoding:'utf8',timeout:10000});
  assert.equal(reference.status,0,reference.stderr||String(reference.error));
  return encode(JSON.parse(reference.stdout));
}
async function differential(body){
  const runtime=start(body);assert.equal(runtime.drive().kind,'terminated');
  const archive=wire(runtime.exportRun());
  assert.equal(validateBundle(archive).valid,true);assert.equal(replayExact(archive).valid,true);
  assert.deepEqual(read(runtime,'order'),nativeOrder(body));
  return {runtime,archive};
}

test('Promise aliases share data, accessor descriptors and the actual getter/setter receiver',async()=>{
  await differential(`let order='';const p=Promise.resolve(1),alias=p;
    Object.defineProperty(p,'value',{value:3,writable:true,enumerable:true,configurable:true});
    alias.value++;let stored=0;
    Object.defineProperty(p,'mark',{get(){order+=this===alias?'g':'bad';return stored;},
      set(value){order+=this===p?'s':'bad';stored=value;},configurable:true});
    alias.mark=alias.value;order+=p.mark;
    const data=Object.getOwnPropertyDescriptor(alias,'value'),accessor=Object.getOwnPropertyDescriptor(p,'mark');
    order+=data.value+':'+data.writable+':'+data.enumerable+':'+data.configurable;
    order+=':'+Object.prototype.hasOwnProperty.call(p,'mark')+':'+(accessor.get!==undefined);`);
});

test('Promise prototype is shared, live, and has ordinary descriptor identity',async()=>{
  await differential(`let order='';const a=Promise.resolve(1),b=Promise.resolve(2),proto=Promise.prototype;
    order+=(Object.getPrototypeOf(a)===proto)+':'+(Object.getPrototypeOf(b)===proto)+':';
    Object.defineProperty(proto,'tag',{get(){return this===a?'a':'b';},configurable:true});
    order+=a.tag+b.tag;Object.defineProperty(a,'tag',{value:'own',configurable:true});order+=a.tag+b.tag;
    const d=Object.getOwnPropertyDescriptor(proto,'constructor');
    order+=':'+(d.value===Promise)+':'+d.writable+':'+d.enumerable+':'+d.configurable;`);
});

test('PromiseResolve constructor lookup is synchronous, exactly once and reentrant',async()=>{
  await differential(`let order='';const inner=Promise.resolve(2),p=Promise.resolve(1);
    Object.defineProperty(inner,'constructor',{get(){order+='i';return Promise;}});
    Object.defineProperty(p,'constructor',{get(){order+='g';order+=Promise.resolve(inner)===inner?'y':'bad';return Promise;}});
    const alias=p;order+=Promise.resolve(alias)===p?'p':'bad';order+='s';`);
});

test('await constructor getters preserve microtasks, cleanup and thrown getter identity',async()=>{
  await differential(`let order='';const reason={tag:7},p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){order+='g';throw reason;}});
    async function work(){try{await p;order+='bad';}catch(error){order+=error===reason?'c':'bad';}finally{order+='f';}}
    work().then(()=>{order+='r';});order+='s';queueMicrotask(()=>{order+='q';});`);
  await differential(`let order='';const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){order+='g';return Promise;}});
    async function work(){order+='a';const value=await p;order+=value;}
    work().then(()=>{order+='r';});order+='s';queueMicrotask(()=>{order+='q';});`);
});

test('nondefault constructor and live then getter retain PromiseResolve adoption order',async()=>{
  await differential(`let order='';const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){order+='c';return undefined;}});
    Object.defineProperty(p,'then',{get(){order+='g';return function(resolve){order+=this===p?'t':'bad';resolve(9);};}});
    Promise.resolve(p).then(value=>{order+=value;});order+='s';queueMicrotask(()=>{order+='q';});`);
});

test('throwing constructor getters during assimilation reject only their adopting promise',async()=>{
  for(const expression of ['new Promise(resolve=>resolve(p))','work()']){
    await differential(`let order='';const reason={tag:7},p=Promise.resolve(1);
      Object.defineProperty(p,'constructor',{get(){order+='g';throw reason;}});
      async function work(){return p;}
      ${expression}.catch(error=>{order+=error===reason?'c':'bad';});
      order+='s';queueMicrotask(()=>{order+='q';});`);
  }
});

test('finally cleanup PromiseResolve and SpeciesConstructor preserve getter and competing-job order',async()=>{
  for(const getter of ["order+='c';return Promise;","order+='c';return undefined;","order+='c';throw reason;"]){
    await differential(`let order='';const reason={tag:7},cleanup=Promise.resolve(9);
      Object.defineProperty(cleanup,'constructor',{get(){${getter}}});
      Promise.resolve(2).finally(()=>{order+='f';return cleanup;})
        .then(value=>{order+='v'+value;},error=>{order+=error===reason?'e':'bad';});
      Promise.resolve().then(()=>{order+='a';}).then(()=>{order+='b';}).then(()=>{order+='d';});order+='s';`);
  }
  await differential(`let order='';const cleanup=Promise.resolve(9),constructor={get [Symbol.species](){order+='s';return Promise;}};
    Object.defineProperty(cleanup,'constructor',{get(){order+='c';return constructor;}});
    Promise.reject(2).finally(()=>cleanup).catch(value=>{order+='e'+value;});queueMicrotask(()=>{order+='q';});`);
});

test('then and finally perform ordered constructor/species lookups and reject invalid descriptors',async()=>{
  await differential(`let order='';const p=Promise.resolve(2),constructor={get [Symbol.species](){order+='s';return Promise;}};
    Object.defineProperty(p,'constructor',{get(){order+='c';return constructor;}});
    p.then(value=>{order+=value;});p.finally(()=>{order+='f';});order+='x';`);
  await differential(`let order='';const p=Promise.resolve(2);
    Object.defineProperty(p,'constructor',{value:7});
    try{p.then(()=>{});}catch(error){order+=error.name;}
    try{Object.defineProperty(p,'constructor',{value:8});}catch(error){order+=':'+error.name;}`);
});

test('finally selects then between its own species lookup and the selected intrinsic then constructor lookup',async()=>{
  await differential(`let order='';const p=Promise.resolve(1),then=p.then;p.then=function(){order+='bad';};
    Object.defineProperty(p,'constructor',{get(){order+='c';p.then=then;return Promise;}});
    p.finally(()=>{order+='f';}).then(value=>{order+=value;});order+='x';`);
  await differential(`let order='';const p=Promise.resolve(1),then=p.then;p.then=function(){order+='bad';};
    p.constructor={get [Symbol.species](){order+='s';p.then=then;return Promise;}};
    p.finally(()=>{order+='f';}).then(value=>{order+=value;});order+='x';`);
  await differential(`let order='';let reads=0;const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){order+='c';reads++;
      if(reads===2)p.then=function(){order+='bad';};return Promise;}});
    p.finally(()=>{order+='f';}).then(value=>{order+=value;});order+='x';`);
  await differential(`let order='';const reason={},p=Promise.resolve(1);p.then=function(){order+='bad';};
    Object.defineProperty(p,'constructor',{get(){order+='c';throw reason;}});
    try{p.finally(()=>{order+='bad';});}catch(error){order+=error===reason?'e':'bad';}`);
  await differential(`let order='';const p=Promise.reject(1);
    Object.defineProperty(p,'constructor',{get(){order+='c';p.then=function(){order+='bad';};return Promise;}});
    p.catch(value=>{order+=value;});order+='x';`);
});

test('finally refuses a then override installed by constructor or species before it can become a caught success',()=>{
  for(const [setup,prefix]of [
    [`Object.defineProperty(p,'constructor',{get(){order+='c';p.then=replacement;return Promise;}});`,'c'],
    [`p.constructor={get [Symbol.species](){order+='s';p.then=replacement;return Promise;}};`,'s']
  ]){
    const body=`let order='';const p=Promise.resolve(1),replacement=function(){order+='t';return 42;};
      ${setup}try{const output=p.finally(()=>{order+='f';});order+=output===42?'42':'bad';}
      catch(error){order+='caught';}`;
    assert.deepEqual(nativeOrder(body),['str',prefix+'t42']);
    const runtime=start(body);
    assert.throws(()=>runtime.drive(),/Promise finally then override requires its owned call continuation/);
    assert.deepEqual(read(runtime,'order'),['str',prefix],'refusal follows the first lookup without a second lookup, callback or guest catch');
  }
});

test('data constructor species getters validate own and inherited identity, reentry, throws, adoption and finally cleanup',async()=>{
  for(const value of ['Promise','undefined','null'])
    await differential(`let order='';const p=Promise.resolve(1);
      p.constructor={get [Symbol.species](){order+='s';return ${value};}};
      p.then(value=>{order+=value;});`);
  await differential(`let order='';const reason={},p=Promise.resolve(1);
    p.constructor={get [Symbol.species](){order+='s';throw reason;}};
    try{p.then(()=>{order+='bad';});}catch(error){order+=error===reason?'e':'bad';}`);
  await differential(`let order='';const p=Promise.resolve(1),constructor={};
    Object.setPrototypeOf(constructor,{get [Symbol.species](){order+=this===constructor?'s':'bad';return Promise;}});
    Object.setPrototypeOf(p,{constructor,then:Promise.prototype.then});p.then(value=>{order+=value;});`);
  await differential(`let order='';const p=Promise.resolve(1),inner=Promise.resolve(2),replacement={
      get [Symbol.species](){order+='r';return Promise;}};
    inner.constructor={get [Symbol.species](){order+='i';return Promise;}};
    p.constructor={get [Symbol.species](){order+='s';p.constructor=replacement;
      inner.then(value=>{order+=value;});return Promise;}};
    p.then(value=>{order+=value;});p.then(value=>{order+='v'+value;});`);
  await differential(`let order='';const p=Promise.resolve(1);
    p.constructor={get [Symbol.species](){order+='s';return Promise;}};
    async function work(){return p;}work().then(value=>{order+=value;});queueMicrotask(()=>{order+='q';});`);
  await differential(`let order='';const constructor={get [Symbol.species](){order+='s';return Promise;}};
    Promise.prototype.constructor=constructor;
    Promise.resolve(1).finally(()=>{order+='f';return 0;}).then(value=>{order+=value;});queueMicrotask(()=>{order+='q';});`);
});

test('direct species getter restoration retains its selected data constructor and rejects substituted source authority',()=>{
  const body=`let order='';const p=Promise.resolve(1),otherPromise=Promise.resolve(2),constructor={},otherConstructor={};
    const getter=function(){order+='s';return Promise;};
    Object.defineProperty(constructor,Symbol.species,{get:getter});
    Object.defineProperty(otherConstructor,Symbol.species,{get:getter});
    p.constructor=constructor;otherPromise.constructor=constructor;p.then(value=>{order+=value;});`;
  const runtime=start(body);
  while(read(runtime,'order')?.[1]!=='s')runtime.step();
  const snapshot=wire(Object.fromEntries(Object.entries(runtime).filter(([name])=>name!=='adapters'))),
    restored=Object.assign(createRuntime(),snapshot);
  assert.equal(runtime.drive().kind,'terminated');assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(wire(restored.exportRun()),wire(runtime.exportRun()));
  assert.deepEqual(read(runtime,'order'),nativeOrder(body));
  const archive=wire(runtime.exportRun());
  assert.equal(validateBundle(archive).valid,true);assert.equal(replayExact(archive).valid,true);
  const alternate=read(runtime,'otherConstructor'),otherPromise=read(runtime,'otherPromise'),
    global=Object.keys(runtime.state.envs)[0];
  const mutations=[
    (frame)=>{frame.promiseConstructorLookup.property='constructor';},
    (frame)=>{frame.promiseConstructorLookup.continuation.phase='constructor';},
    (frame)=>{delete frame.promiseConstructorLookup.continuation.phase;},
    (frame)=>{frame.promiseConstructorLookup.continuation.frameId=frame.id;},
    (frame)=>{frame.promiseConstructorLookup.continuation.receiver=otherPromise;},
    (frame)=>{frame.promiseConstructorLookup.continuation.args=[['num',404]];},
    (frame)=>{frame.thisValue=otherPromise;},
    (frame,event)=>{event.stateChanges.find(change=>change.table==='envs'&&change.id===frame.envId).after.parent=global;}
  ];
  for(const mutate of mutations){
    const forged=wire(archive),event=forged.events.find(event=>event.stateChanges.some(change=>
      change.table==='frames'&&change.before===null&&change.after?.promiseConstructorLookup?.continuation.phase==='species')),
      frame=event.stateChanges.find(change=>change.table==='frames'&&change.before===null&&change.after?.promiseConstructorLookup).after;
    mutate(frame,event);assert.throws(()=>validateBundle(forged),/Promise|constructor|species|scope|capture/);
  }
  // The decoy has exactly the same getter and capture. Receiver/code checks
  // alone cannot distinguish it from the constructor actually read from p.
  const forged=wire(archive),frame=forged.events.flatMap(event=>event.stateChanges).find(change=>
    change.table==='frames'&&change.before===null&&change.after?.promiseConstructorLookup?.continuation.phase==='species').after;
  frame.promiseConstructorLookup.receiver=alternate;frame.thisValue=alternate;
  assert.throws(()=>validateBundle(forged),/species lookup changed its original data constructor/);
});

test('Promise prototype changes and nonextensibility use the same ordinary storage',async()=>{
  await differential(`let order='';const p=Promise.resolve(1),proto={value:4};
    Object.setPrototypeOf(p,proto);order+=(Object.getPrototypeOf(p)===proto)+':'+p.value+':'+p.then;
    Object.preventExtensions(p);order+=':'+Object.isExtensible(p)+':'+Object.isFrozen(p);
    try{p.extra=7;}catch(error){order+=':'+error.name;}
    try{Object.setPrototypeOf(p,null);}catch(error){order+=':'+error.name;}`);
});

test('own reflection never invokes inherited or own getters, and call/apply retain the actual receiver',async()=>{
  await differential(`let order='';const p=Promise.resolve(1);
    Object.defineProperty(Promise.prototype,'inherited',{get(){order+='bad';return 1;}});
    Object.defineProperty(p,'own',{get(){order+='bad';return 2;}});
    const has=Object.prototype.hasOwnProperty;
    order+=has.call(p,'own')+':'+has.apply(p,['inherited'])+':'+Reflect.apply(has,p,['constructor']);
    order+=':'+has.call('abc',1)+':'+Object.hasOwn(p,'own');`);
});

test('unsupported Promise species allocation cannot become a caught-error success',()=>{
  const body=`const p=Promise.resolve(1);Object.defineProperty(p,'constructor',{value:{
    [Symbol.species]:function(executor){return new Promise(executor);}}});
    try{p.then(()=>{});}catch(error){return 7;}`;
  assert.throws(()=>start(body).drive(),/Custom Promise species construction is outside the owned profile/);
  assert.throws(()=>start(`const p=Promise.resolve(1);Object.defineProperty(p,'constructor',{get(){return Promise;}});
    try{Promise.all([p]);}catch(error){return 7;}`).drive(),/Promise combinator constructor or then lookup requires an owned continuation/);
});

test('Promise static and prototype methods reject altered receivers before their callbacks run',async()=>{
  await differential(`let order='';const resolve=Promise.resolve,then=Promise.resolve(1).then;
    try{resolve(1);}catch(error){order+=error.name;}
    const holder={resolve};try{holder.resolve(1);}catch(error){order+=':'+error.name;}
    try{then(()=>{order+='bad';});}catch(error){order+=':'+error.name;}`);
});

test('constructor getter checkpoints restore without repeating effects and reject altered receivers and source inputs',async()=>{
  const body=`let order='';const p=Promise.resolve(1);Object.defineProperty(p,'constructor',{
    get(){order+='g';return Promise;}});Promise.resolve(p);order+='s';`;
  const runtime=start(body);
  while(read(runtime,'order')?.[1]!=='g')runtime.step();
  const snapshot=wire(Object.fromEntries(Object.entries(runtime).filter(([name])=>name!=='adapters'))),
    restored=Object.assign(createRuntime(),snapshot);
  assert.equal(runtime.drive().kind,'terminated');assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(wire(restored.exportRun()),wire(runtime.exportRun()));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  for(const mutate of [
    frame=>{frame.thisValue=['num',404];},
    frame=>{frame.promiseConstructorLookup.continuation.value=['promise','p404'];},
    frame=>{frame.promiseConstructorLookup.receiver=['promise','p404'];}
  ]){
    const forged=wire(runtime.exportRun()),created=forged.events.flatMap(event=>event.stateChanges)
      .find(change=>change.table==='frames'&&change.before===null&&change.after?.promiseConstructorLookup);
    mutate(created.after);assert.throws(()=>validateBundle(forged),/Promise|prototype/);
  }
  const {archive}=await differential(`let order='';const p=Promise.resolve(1);order+=Object.prototype.hasOwnProperty.call(p,'then');`);
  const call=archive.events.find(event=>event.operands[0]?.[1]?.[1]==='Function.prototype.call');
  assert(call);call.result=['bool',true];assert.throws(()=>validateBundle(archive),/adapter result/);
});
