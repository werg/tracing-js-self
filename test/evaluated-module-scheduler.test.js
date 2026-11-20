import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntime} from '../src/runtime.js';
import {linkEvaluatedModules,executeEvaluatedModules} from '../src/evaluated-modules.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {realizeGraph} from '../src/training/graph.js';

const wire=value=>JSON.parse(JSON.stringify(value));
const stateSource=`export let log='';export function add(value){log+=value;}`;
const failure=error=>error&&typeof error==='object'?{name:error.name}:error;
const binding=(runtime,name)=>Object.values(runtime.state.envs)
  .flatMap(environment=>Object.entries(environment.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;

function startOwned(modules,options={}){
  const request={modules,entryModule:'main.js',exportName:'run',...options};
  const linked=linkEvaluatedModules(request);
  const runtime=createRuntime().startEntry({text:linked.source,
    functionName:linked.entryFunction,args:[linked.entryInput],allowAsync:true});
  return {runtime,linked,request};
}
function finishOwned(run){
  const {runtime,linked}=run;
  assert.equal(runtime.drive().kind,'terminated');
  const bundle=wire(runtime.exportRun());
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  const root=runtime.initialState.control.a0.activeFrameId;
  const promise=runtime.state.promises[runtime.initialState.frames[root].asyncPromiseId];
  const value=realizeGraph(runtime.state.heap,[promise.value.value])[0];
  const index=linked.metadata.evaluationOrder.indexOf('state.js')+1;
  const log=binding(runtime,'__traced_eval_m'+index+'_log')?.[1];
  return {...run,bundle,outcome:{status:promise.status,
    value:promise.status==='rejected'?failure(value):value,log}};
}
async function nativeGraph(modules,options={}){
  // The oracle executes the ORIGINAL ESM graph in Node's loader. It does not
  // import the linked source, scheduler helper, or any owned runtime module.
  const directory=await mkdtemp(join(tmpdir(),'owned-esm-scheduler-'));
  try{
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    for(const [file,source] of Object.entries(modules)){
      await mkdir(dirname(join(directory,file)),{recursive:true});
      await writeFile(join(directory,file),source);
    }
    let value,status='fulfilled';
    try{
      const namespace=await import(pathToFileURL(join(directory,options.entryModule??'main.js')).href);
      const invoke=async(exportName,args=[])=>typeof namespace[exportName]==='function'?
        await namespace[exportName](...args):await namespace[exportName];
      if(options.calls){
        value=[];
        for(const call of options.calls)value.push(await invoke(call.exportName,call.args));
      }else value=await invoke(options.exportName??'run',options.args??[]);
    }catch(error){status='rejected';value=failure(error);}
    // Already-started sibling modules finish even if another sibling fails.
    await new Promise(resolve=>setImmediate(resolve));
    const state=await import(pathToFileURL(join(directory,'state.js')).href);
    return {status,value,log:state.log};
  }finally{await rm(directory,{recursive:true,force:true});}
}
async function differential(modules,options={},strategy='async-dependency-scheduler'){
  const native=await nativeGraph(modules,options);
  const owned=finishOwned(startOwned(modules,options));
  assert.equal(owned.linked.metadata.evaluationStrategy,strategy);
  assert.deepEqual(owned.outcome,native);
  return owned;
}
function siblings(a,b,main=''){
  return {
    'state.js':stateSource,
    'a.js':`import {add} from './state.js';${a}`,
    'b.js':`import {add} from './state.js';${b}`,
    'main.js':`import './a.js';import './b.js';import {add,log} from './state.js';
      ${main}const observed=log;export function run(){return observed;}`
  };
}
function records(runtime){
  const reference=binding(runtime,'__traced_eval_modules');
  if(!reference)return [];
  const array=runtime.state.heap[reference[1]];
  return Object.entries(array.properties).filter(([key])=>key!=='length')
    .map(([,value])=>runtime.state.heap[value.value[1]])
    .map(entity=>Object.fromEntries(Object.entries(entity.properties)
      .map(([key,value])=>[key,value.value])));
}

test('independent TLA siblings start before either await resumes, including a sync sibling',async()=>{
  for(const [b,expected] of [
    [`add('b');await Promise.resolve(0);add('B');`,'abAB'],
    [`add('b');`,'abA']
  ]){
    const modules=siblings(`add('a');await 0;add('A');`,b);
    const run=await differential(modules);
    assert.equal(run.outcome.value,expected);
    assert.equal(run.outcome.log,expected);
    assert(records(run.runtime).every(record=>record.status[1]==='evaluated'));
  }
});

test('a shared async dependency evaluates once and releases both async parents',async()=>{
  const modules={
    'state.js':stateSource,
    'base.js':`import {add} from './state.js';add('x');await 0;add('X');export let n=1;`,
    'left.js':`import {n} from './base.js';import {add} from './state.js';
      add('l');await Promise.resolve(n);add('L');`,
    'right.js':`import {n} from './base.js';import {add} from './state.js';
      add('r');await Promise.resolve(n);add('R');`,
    'main.js':`import './left.js';import './right.js';import {add,log} from './state.js';
      add('m');const observed=log;export function run(){return observed;}`
  };
  const run=await differential(modules);
  assert.equal(run.outcome.value,'xXlrLRm');
  assert.equal(run.linked.metadata.evaluationOrder.filter(file=>file==='base.js').length,1);
});

test('ready synchronous ancestors run in DFS async order without per-edge jobs',async()=>{
  const modules={
    'state.js':stateSource,
    'base.js':`import {add} from './state.js';add('x');await 0;add('X');`,
    'left.js':`import './base.js';import {add} from './state.js';add('l');queueMicrotask(()=>add('q'));`,
    'parent.js':`import './left.js';import {add} from './state.js';add('p');`,
    'right.js':`import './base.js';import {add} from './state.js';add('r');`,
    'sibling.js':`import {add} from './state.js';add('s');await 0;add('S');`,
    'main.js':`import './parent.js';import './right.js';import './sibling.js';
      import {add,log} from './state.js';add('m');const observed=log;
      export function run(){return observed;}`
  };
  const run=await differential(modules);
  assert.equal(run.outcome.value,'xsXSlprm');
  assert.equal(run.outcome.log,'xsXSlprmq');
});

test('syntactic TLA gets a completion job even when no await executes',async()=>{
  const modules=siblings(`add('a');if(false){await 0;}add('A');queueMicrotask(()=>add('q'));`,
    `add('b');`,`add('m');`);
  const run=await differential(modules);
  assert.equal(run.outcome.value,'aAbqm');
});

test('single-chain and synchronous graphs retain their qualified path with native completion-job timing',async()=>{
  for(const suspension of ['await 0;','if(false){await 0;}','']){
    const modules={
      'state.js':stateSource,
      'a.js':`import {add} from './state.js';add('a');${suspension}add('A');
        Promise.resolve().then(()=>add('q')).then(()=>add('r'));`,
      'main.js':`import './a.js';import {add,log} from './state.js';add('m');
        const observed=log;export function run(){return observed;}`
    };
    const run=await differential(modules,{},'dependency-concatenation');
    assert.equal(run.outcome.value,suspension?'aAqm':'aAm');
  }
});

test('then getters, assimilation and competing microtasks retain native module job order',async()=>{
  const modules=siblings(`add('a');const value=await {get then(){add('g');
    return function(resolve){add('t');resolve(7);};}};
    add(value);queueMicrotask(()=>add('q'));`,
    `add('b');Promise.resolve().then(()=>add('p'));await 0;add('B');`,`add('m');`);
  const run=await differential(modules);
  assert.equal(run.outcome.value,'agbtpB7qm');
});

test('nested await operands, caught rejection and finally keep their generator continuations',async()=>{
  const modules=siblings(`async function inner(){await 0;return 2;}
    let value=(await await Promise.resolve(3))+(await inner());
    try{await Promise.reject(7);}catch(error){value+=error;}
    finally{await 0;add('f');}add(value);`,
    `add('b');await 0;add('B');`);
  const run=await differential(modules);
  assert.equal(run.outcome.value,'bBf12');
});

test('module getters retain live imported cells, namespaces, closures and strict call receivers',async()=>{
  const modules={
    'state.js':stateSource+`export let count=1;export function step(){count+=2;}
      export function receiver(){return this===undefined;}`,
    'a.js':`import {add,count,step} from './state.js';add('a');await 0;step();add(count);`,
    'b.js':`import {add,count,step} from './state.js';add('b');await 0;step();add(count);`,
    'barrel.js':`export {count as value,step,receiver} from './state.js';`,
    'main.js':`import './a.js';import './b.js';import {value,step,receiver} from './barrel.js';
      import * as cells from './barrel.js';
      export function read(){return [value,cells.value,receiver()];}
      export function update(){step();return value;}
      export function run(){return value;}`
  };
  const options={calls:[{exportName:'read',args:[]},{exportName:'update',args:[]},
    {exportName:'read',args:[]}]};
  const run=await differential(modules,options);
  assert.deepEqual(run.outcome.value,[[5,5,true],7,[7,7,true]]);
  assert.equal(run.outcome.log,'ab35');
});

test('module environments keep lexical TDZ and hoisted functions while another module is suspended',async()=>{
  const modules={
    'state.js':stateSource+`export let read;export let hoisted;
      export function store(a,b){read=a;hoisted=b;}`,
    'a.js':`import {store,add} from './state.js';store(()=>value,fn);
      await 0;let value=4;add(value);function fn(){return 9;}`,
    'b.js':`import {read,hoisted,add} from './state.js';
      try{read();}catch(error){add(error.name);}add(hoisted());await 0;add(read());`,
    'main.js':`import './a.js';import './b.js';import {log} from './state.js';
      const observed=log;export function run(){return observed;}`
  };
  const run=await differential(modules);
  assert.equal(run.outcome.value,'ReferenceError944');
});

test('async throws before and after await reject parents while already-started siblings finish',async()=>{
  for(const source of [`add('a');throw 7;await 0;`,
    `add('a');await 0;add('A');throw 7;`]){
    const run=await differential(siblings(source,`add('b');await 0;add('B');`,`add('m');`));
    assert.equal(run.outcome.status,'rejected');
    assert.equal(run.outcome.value,7);
    assert(!run.outcome.log.includes('m'));
    assert.equal(records(run.runtime).at(-1).failed[1],true);
  }
});

test('a synchronous initial throw prevents later siblings starting without cancelling earlier async work',async()=>{
  const modules={
    'state.js':stateSource,
    'first.js':`import {add} from './state.js';add('x');await 0;add('X');`,
    'fail.js':`import {add} from './state.js';add('f');throw 7;`,
    'last.js':`import {add} from './state.js';add('z');await 0;add('Z');`,
    'main.js':`import './first.js';import './fail.js';import './last.js';
      import {log} from './state.js';export function run(){return log;}`
  };
  const run=await differential(modules);
  assert.deepEqual(run.outcome,{status:'rejected',value:7,log:'xfX'});
  const last=records(run.runtime)[run.linked.metadata.evaluationOrder.indexOf('last.js')];
  assert.equal(last.status[1],'linked');
});

test('a throwing ready parent skips its ancestors but not unrelated ready siblings',async()=>{
  const modules={
    'state.js':stateSource,
    'base.js':`import {add} from './state.js';add('x');await 0;add('X');`,
    'bad.js':`import './base.js';import {add} from './state.js';add('f');throw 7;`,
    'ancestor.js':`import './bad.js';import {add} from './state.js';add('z');`,
    'good.js':`import './base.js';import {add} from './state.js';add('g');`,
    'other.js':`import {add} from './state.js';add('o');await 0;add('O');`,
    'main.js':`import './ancestor.js';import './good.js';import './other.js';
      import {log} from './state.js';export function run(){return log;}`
  };
  const run=await differential(modules);
  assert.deepEqual(run.outcome,{status:'rejected',value:7,log:'xoXOfg'});
});

test('module instantiation, await suspension and ready-parent work restore exactly from JSON',()=>{
  const modules=siblings(`add('a');await 0;add('A');await 0;add('1');`,
    `add('b');await 0;add('B');`,`add('m');`);
  const original=startOwned(modules);
  const checkpoints=[];
  let previousAwait=false,previousJob=false,previousGenerator=false;
  for(let steps=0;steps<20000;steps++){
    const runtime=original.runtime;
    const generators=Object.values(runtime.state.heap).filter(value=>value.kind==='generator');
    const allPrimed=generators.length===4&&generators.every(value=>value.state==='suspendedYield');
    const awaiting=Object.values(runtime.state.frames).filter(frame=>frame.status==='suspended').length>=2;
    const job=runtime.state.control.a0.queue.some(value=>value.kind==='reaction');
    if((allPrimed&&!previousGenerator)||(awaiting&&!previousAwait)||(job&&!previousJob)){
      checkpoints.push(wire(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters'))));
    }
    previousGenerator||=allPrimed;previousAwait||=awaiting;previousJob||=job;
    const control=runtime.state.control.a0;
    const frame=runtime.state.frames[control.activeFrameId];
    if(frame?.status==='running')runtime.step();
    else if(control.queue.length)runtime.enterQueuedJob();
    else break;
  }
  const completed=finishOwned(original);
  assert.equal(checkpoints.length,3,'capture instantiation, suspended drivers and completion jobs');
  for(const checkpoint of checkpoints){
    const restored=Object.assign(createRuntime(),checkpoint);
    assert.equal(restored.drive().kind,'terminated');
    assert.deepEqual(wire(restored.exportRun()),completed.bundle);
    assert.equal(validateBundle(restored.exportRun()).valid,true);
    assert.equal(replayExact(restored.exportRun()).valid,true);
  }
});

test('parallel module execution journals each external read once and replay does not redispatch it',async()=>{
  let invocations=0;
  const modules=siblings(`add('a');const value=await host.readAsync('a');add(value);`,
    `add('b');const value=await host.readAsync('b');add(value);`);
  const run=await executeEvaluatedModules({modules,entryModule:'main.js',exportName:'run',
    services:{'demo.readAsync':async({args})=>{invocations++;return args[0]==='a'?1:2;}}});
  assert.equal(run.result,'ab12');
  assert.equal(invocations,2);
  assert.equal(run.bundle.events.filter(event=>event.operation==='external.input.arrive').length,2);
  assert.equal(replayExact(run.bundle).valid,true);
  assert.equal(invocations,2);
});

test('pending sibling host reads restore retained module state without executing initializers or dispatch twice',()=>{
  const modules=siblings(`add('a');const value=await host.readAsync('a');add(value);`,
    `add('b');const value=await host.readAsync('b');add(value);`);
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  let dispatches=0,restoredDispatches=0;
  const runtime=createRuntime({adapters:{'demo.readAsync':()=>{
    dispatches++;return {kind:'pending'};
  }}}).startEntry({text:linked.source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true,allowHost:true});
  assert.equal(runtime.drive().kind,'waiting');
  assert.equal(dispatches,2);
  const effects=Object.values(runtime.state.effects).filter(effect=>effect.operation==='demo.readAsync');
  assert.equal(effects.length,2);
  const saved=wire(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters')));
  const restored=Object.assign(createRuntime({adapters:{'demo.readAsync':()=>{
    restoredDispatches++;throw new Error('Snapshot must not redispatch committed reads');
  }}}),saved);
  for(const machine of [runtime,restored]){
    for(const [effect,value] of [[effects[1],2],[effects[0],1]]){
      const input=machine.recordInputArrival({effectId:effect.id,kind:'completion',value});
      machine.deliverInput(input.inputId);
      machine.drive();
    }
  }
  const original=finishOwned({runtime,linked});
  const continued=finishOwned({runtime:restored,linked});
  assert.equal(original.outcome.value,'ab21');
  assert.deepEqual(continued.bundle,original.bundle);
  assert.equal(dispatches,2);
  assert.equal(restoredDispatches,0);
});

test('async cycles, for-await iteration and generated scheduler identifiers remain explicit boundaries',()=>{
  assert.throws(()=>linkEvaluatedModules({modules:{
    'main.js':`import './a.js';export function run(){return 1;}await 0;`,
    'a.js':`import './main.js';`
  },entryModule:'main.js',exportName:'run'}),/cyclic module initialization with await/);
  assert.throws(()=>linkEvaluatedModules({modules:siblings(`{for await(const item of []){add(item);}}`,
    `add('b');`),entryModule:'main.js',exportName:'run'}),/for-await module iteration/);
  assert.throws(()=>linkEvaluatedModules({modules:siblings(`await 0;`,
    `__traced_eval_modules[0].status='evaluated';`),entryModule:'main.js',exportName:'run'}),/reserved generated identifier/);
});
