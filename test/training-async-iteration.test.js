import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {version as acornVersion} from 'acorn';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {encode} from '../src/values.js';
import {parseTraining,TRAINING_PARSER,OWNED_SCRIPT_PARSER} from '../src/training/profile.js';

const wire=value=>JSON.parse(JSON.stringify(value));
const read=(runtime,name)=>runtime.state.envs[runtime.state.control.a0.globalEnvId]
  .bindings[name]?.token?.value??Object.values(runtime.state.envs)
  .flatMap(environment=>Object.entries(environment.bindings)).find(([key])=>key===name)?.[1]?.token?.value;
const script=(body,tail='')=>'"use strict";let order="";let outcome="pending";'+
  'async function run(){'+body+'}'+
  'run().then(value=>{outcome=value;},error=>{outcome=typeof error==="object"?error.name:error;});'+tail;
function start(source){
  const runtime=createRuntime({maxSteps:10000});
  return runtime.start(runtime.registerSource({text:source,scriptProfile:true}));
}
async function differential(body,{tail='',expected=null}={}){
  const source=script(body,tail),runtime=start(source);
  assert.equal(runtime.drive().kind,'terminated',source);
  const archive=wire(runtime.exportRun());
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  const context=vm.createContext({queueMicrotask},{codeGeneration:{strings:false,wasm:false}});
  vm.runInContext(source,context,{timeout:1000});
  await new Promise(resolve=>setImmediate(resolve));
  for(const name of ['order','outcome'])assert.deepEqual(read(runtime,name),encode(vm.runInContext(name,context)),name+'\n'+source);
  if(expected)assert.deepEqual([read(runtime,'order'),read(runtime,'outcome')],expected.map(encode));
  return {source,runtime,archive};
}

test('for-await prefers async iteration, caches next once and preserves its receiver',async()=>{
  await differential(`let gets=0;const iterator={i:0,get next(){gets++;return function(){
    this.next=()=>{throw 99;};return Promise.resolve({done:this.i===2,value:++this.i});};},set next(v){}};
    const values={get [Symbol.asyncIterator](){order+='a';return function(){order+=this===values?'r':'!';return iterator;};},
      get [Symbol.iterator](){throw 88;}};
    for await(const value of values)order+=value;return gets;`,{expected:['ar12',1]});
});

test('async iteration awaits next results but does not unwrap their value',async()=>{
  await differential(`const value=Promise.resolve(7);let calls=0;
    const iterator={[Symbol.asyncIterator](){return this;},next(){calls++;
      return {then(resolve){order+='t';resolve({done:calls>1,value:value});}};}};
    for await(const item of iterator){order+=item===value?'p':'!';}return calls;`,{expected:['tpt',2]});
});

test('sync fallback retains holes, code points, live lengths and per-iteration bindings',async()=>{
  await differential(`const values=[,Promise.resolve(2)];const closures=[];
    for await(let value of values){closures.push(()=>value);if(value===undefined)values.push(3);}
    for(const closure of closures)order+=closure()===undefined?'u':closure();
    for await(const value of 'a😀b')order+=value;
    for await(var [head,...tail] of [[4,5,6]])order+=head+':'+tail.join(',');
    return head;`,{expected:['u23a😀b4:5,6',4]});
});

test('sync fallback observes async-hook nullishness and unwraps thenables in job order',async()=>{
  for(const hook of ['null','undefined'])await differential(`
    const values={[Symbol.asyncIterator]:${hook},[Symbol.iterator](){order+='s';let first=true;
      return {next(){const done=!first;first=false;return {done:done,value:{get then(){order+='g';
        return resolve=>{order+='t';resolve(7);};}}};}};}};
    for await(const value of values)order+=value;return 'ok';`,{
      tail:'queueMicrotask(()=>{order+="q";});Promise.resolve().then(()=>{order+="a";}).then(()=>{order+="b";});'});
});

test('sync completion still reads and awaits value while async completion skips it',async()=>{
  for(const kind of ['iterator','asyncIterator'])await differential(`
    const values={[Symbol.${kind}](){return this;},next(){return {done:true,get value(){order+='v';
      return {then(resolve){order+='t';resolve(9);}};}};}};
    for await(const value of values)order+='!';return 'ok';`,{
      expected:kind==='iterator'?['vt','ok']:['','ok']});
  await differential(`const values={[Symbol.iterator](){return this;},next(){return {done:true,value:Promise.reject(7)};},
    return(){order+='!';return {};}};for await(const value of values)order+='!';return 'unreachable';`,{expected:['',7]});
});

test('current sync fallback closes a rejected value exactly once and exposes older reference behavior',async t=>{
  // AsyncFromSyncIteratorContinuation closes on rejected values in the current
  // specification. Keep the owned rule even if an older reference omits close.
  // https://tc39.es/ecma262/#sec-asyncfromsynciteratorcontinuation
  for(const close of ['return(){order+="c";return {};}',
    'return(){order+="c";throw 9;}', 'get return(){order+="c";throw 9;}']){
    const source=script(`const values={[Symbol.iterator](){return this;},next(){
      return {done:false,value:Promise.reject(7)};},${close}};
      for await(const value of values)order+='!';return 'unreachable';`),runtime=start(source);
    assert.equal(runtime.drive().kind,'terminated');
    assert.deepEqual([read(runtime,'order'),read(runtime,'outcome')],[encode('c'),encode(7)]);
    assert.equal(validateBundle(runtime.exportRun()).valid,true);
    assert.equal(replayExact(runtime.exportRun()).valid,true);
    const context=vm.createContext({queueMicrotask});vm.runInContext(source,context,{timeout:1000});
    await new Promise(resolve=>setImmediate(resolve));
    const reference=vm.runInContext('order',context);
    assert(['','c'].includes(reference),'unexpected reference cleanup: '+reference);
    assert.deepEqual(read(runtime,'outcome'),encode(vm.runInContext('outcome',context)));
    t.diagnostic(JSON.stringify({close,node:process.version,v8:process.versions.v8,
      ownedCloseCount:1,referenceCloseCount:reference.length,sourceAgreement:reference==='c'}));
  }
});

test('async close awaits return and preserves throws while replacing normal exits',async()=>{
  for(const abrupt of ['break;','throw 7;','return 8;'])for(const close of [
    'return(){order+="c";return Promise.resolve({});}',
    'return(){order+="c";return Promise.reject(9);}',
    'return(){order+="c";return 3;}',
    'get return(){order+="c";throw 9;}',
    'return:3', 'return:null'
  ])await differential(`const values={[Symbol.asyncIterator](){return this;},
      next(){return Promise.resolve({done:false,value:1});},${close}};
    for await(const value of values){order+='v';${abrupt}}return 'ok';`,{
      tail:'Promise.resolve().then(()=>{order+="a";}).then(()=>{order+="b";}).then(()=>{order+="d";});'});
});

test('sync close reads done/value and awaits the cleanup value, including absent return',async()=>{
  for(const close of [
    'return(){order+="c";return {get done(){order+="d";return false;},get value(){order+="v";return Promise.resolve(2);}};}',
    'return(){order+="c";return {done:true,value:Promise.reject(9)};}',
    'return(){order+="c";return 3;}',
    'get return(){order+="c";throw 9;}', 'return:null'
  ])for(const abrupt of ['break;','throw 7;'])await differential(`
    const values={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},${close}};
    for await(const value of values){order+='v';${abrupt}}return 'ok';`,{
      tail:'Promise.resolve().then(()=>{order+="a";}).then(()=>{order+="b";}).then(()=>{order+="d";});'});
});

test('async next, done and value failures do not spuriously close iterators',async()=>{
  for(const step of [
    'throw 7;', 'return 3;', 'return {get done(){throw 7;}};',
    'return {done:false,get value(){throw 7;}};'
  ])await differential(`const values={[Symbol.asyncIterator](){return this;},next(){${step}},
    return(){order+='!';return {};}};for await(const value of values)order+='!';return 'unreachable';`);
  await differential(`const values={[Symbol.asyncIterator](){return this;},next(){return Promise.reject(7);},
    return(){order+='!';return {};}};for await(const value of values)order+='!';return 'unreachable';`,{expected:['',7]});
});

test('sync next and result getter errors retain spec behavior and expose reference disagreements',async t=>{
  // %AsyncFromSyncIteratorPrototype%.next step 7 and continuation steps 3/5
  // reject immediately. They do not run the value-rejection close callback.
  // V8 in Node 24.22.3 instead closes here. Keep these original inputs and
  // both observations visible; a reference mismatch is not admission evidence.
  for(const step of ['throw 7;','return 3;','return {get done(){throw 7;}};',
    'return {done:false,get value(){throw 7;}};']){
    const source=script(`const values={[Symbol.iterator](){return this;},next(){${step}},
      return(){order+='c';return {};}};for await(const value of values)order+='!';return 'unreachable';`),runtime=start(source);
    assert.equal(runtime.drive().kind,'terminated');
    assert.deepEqual(read(runtime,'order'),['str','']);
    assert.deepEqual(read(runtime,'outcome'),encode(step==='return 3;'?'TypeError':7));
    assert.equal(validateBundle(runtime.exportRun()).valid,true);
    assert.equal(replayExact(runtime.exportRun()).valid,true);
    const context=vm.createContext({queueMicrotask});vm.runInContext(source,context,{timeout:1000});
    await new Promise(resolve=>setImmediate(resolve));
    const reference=vm.runInContext('order',context);
    assert(['','c'].includes(reference),'unexpected reference cleanup: '+reference);
    assert.deepEqual(read(runtime,'outcome'),encode(vm.runInContext('outcome',context)));
    t.diagnostic(JSON.stringify({phase:step,node:process.version,v8:process.versions.v8,
      ownedCloseCount:0,referenceCloseCount:reference.length,sourceAgreement:reference===''}));
  }
});

test('nested labelled exits close inner then outer and await body finally first',async()=>{
  await differential(`function make(name){return {[Symbol.asyncIterator](){return this;},
    next(){return Promise.resolve({done:false,value:1});},async return(){order+=name;await 0;order+='x';return {};}};}
    outer:for await(const a of make('o')){for await(const b of make('i')){
      try{break outer;}finally{order+='f';await 0;order+='g';}}}return 'ok';`,{expected:['fgixox','ok']});
});

test('continue does not close and destructuring failures do close',async()=>{
  await differential(`const values={[Symbol.asyncIterator](){return this;},i:0,
    next(){return {done:this.i===3,value:++this.i};},return(){order+='!';return {};}};
    for await(const value of values){if(value<3)continue;order+=value;}return 'ok';`,{expected:['3','ok']});
  await differential(`const values={[Symbol.asyncIterator](){return this;},
    next(){return {done:false,value:null};},return(){order+='c';return {};}};
    for await(const {x} of values)order+='!';return 'unreachable';`,{expected:['c','TypeError']});
});

test('malformed async iterables produce guest errors before reaching the loop body',async()=>{
  for(const value of ['null','3','{[Symbol.asyncIterator]:3,[Symbol.iterator](){order+="!";return this;}}',
    '{[Symbol.asyncIterator](){return 3;}}','{[Symbol.iterator](){return 3;}}',
    '{[Symbol.asyncIterator](){return {next:3,return(){order+="!";return {};}};}}'])
    await differential(`for await(const value of ${value})order+='!';return 'unreachable';`,{expected:['','TypeError']});
});

test('for-await and sync-wrapper suspension restore without repeated next/getter/close effects',()=>{
  const source=script(`const values={[Symbol.iterator](){return this;},get next(){order+='g';
    return function(){order+='n';return {done:false,value:Promise.resolve(7)};};},
    return(){order+='c';return {done:true,value:Promise.resolve(9)};}};
    for await(const value of values){order+=value;break;}return 'ok';`);
  const runtime=start(source),snapshots=new Map();
  for(let steps=0;steps<2000;steps++){
    const control=runtime.state.control.a0,frame=runtime.state.frames[control.activeFrameId];
    if(!frame&&control.queue[0]?.kind==='await'){
      const suspended=runtime.state.frames[control.queue[0].frameId],program=runtime.programs[suspended.codeId];
      const key=program.sourceRole??(suspended.handlers.some(handler=>handler.phase==='finally')?'loop-close':'loop-next');
      if(!snapshots.has(key))snapshots.set(key,wire(Object.fromEntries(Object.entries(runtime).filter(([name])=>name!=='adapters'))));
    }
    if(frame?.status==='running')runtime.step();else if(control.queue.length)runtime.enterQueuedJob();else break;
  }
  assert.equal(runtime.drive().kind,'terminated');
  assert.deepEqual([...snapshots.keys()].sort(),['async-from-sync-next','async-from-sync-return','loop-close','loop-next']);
  assert.deepEqual(read(runtime,'order'),['str','gn7c']);
  for(const [boundary,snapshot]of snapshots){
    const restored=Object.assign(createRuntime(),snapshot);
    assert.equal(restored.drive().kind,'terminated',boundary);
    assert.deepEqual(wire(restored.exportRun()),wire(runtime.exportRun()),boundary);
    assert.equal(validateBundle(restored.exportRun()).valid,true);
    assert.equal(replayExact(restored.exportRun()).valid,true);
  }
});

test('forged sync wrapper bytecode and continuation references fail exact replay',async()=>{
  const {archive}=await differential('for await(const value of [1])order+=value;return "ok";');
  const forged=wire(archive),helper=Object.values(forged.programs).find(program=>program.sourceRole==='async-from-sync-next');
  helper.instructions.find(instruction=>instruction.op==='AWAIT').op='POP';
  assert.throws(()=>replayExact(forged),/Replay divergence: compiled bytecode/);
  const damaged=wire(archive),resume=damaged.events.find(event=>event.operation==='job.enter'&&
    event.stateChanges.some(change=>change.table==='control'&&change.before?.queue?.[0]?.kind==='await'));
  resume.causes.find(cause=>cause.kind==='promise').promiseId='p404';
  assert.throws(()=>replayExact(damaged),/Job entry does not consume the next settled promise observer/);
});

test('parser provenance records the running Acorn and accepts current parsing without an edition ceiling',()=>{
  assert.equal(TRAINING_PARSER,'acorn/'+acornVersion+':training-js/1');
  assert.equal(OWNED_SCRIPT_PARSER,'acorn/'+acornVersion+':owned-script/1');
  assert.doesNotThrow(()=>parseTraining('"use strict";async function run(){for await(const value of []){}}'));
  assert.throws(()=>parseTraining('"use strict";function run(){for await(const value of []){}}'),SyntaxError);
});
