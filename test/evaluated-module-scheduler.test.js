import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
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

test('self-import and cyclic graphs retain separate DFS and body completion state',async()=>{
  const self=await differential({
    'state.js':stateSource,
    'main.js':`import './main.js';import {add,log} from './state.js';
      add('m');await 0;add('M');export function run(){return log;}`
  });
  assert.equal(self.outcome.value,'mM');
  assert.equal(self.linked.metadata.cycles.length,1);
  for(const [a,b,expected] of [
    [`add('a');await 0;add('A');`,`add('b');`,'baAm'],
    [`add('a');`,`add('b');await 0;add('B');`,'bBam'],
    [`add('a');await 0;add('A');`,`add('b');await 0;add('B');`,'bBaAm']
  ]){
    const run=await differential({
      'state.js':stateSource,
      'a.js':`import './b.js';import {add} from './state.js';${a}`,
      'b.js':`import './a.js';import {add} from './state.js';${b}`,
      'main.js':`import './a.js';import {add,log} from './state.js';
        add('m');export function run(){return log;}`
    });
    assert.equal(run.outcome.value,expected);
    const modules=records(run.runtime),index=file=>run.linked.metadata.evaluationOrder.indexOf(file);
    assert.equal(modules[index('a.js')].cycleRoot[1],index('a.js'));
    assert.equal(modules[index('b.js')].cycleRoot[1],index('a.js'));
    assert(modules.every(record=>record.status[1]==='evaluated'&&record.started[1]));
  }
});

test('an outside import of an already-executed non-root cycle member waits for the cycle root',async()=>{
  const run=await differential({
    'state.js':stateSource,
    'a.js':`import './b.js';import {add} from './state.js';add('a');await 0;add('A');`,
    'b.js':`import './a.js';import {add} from './state.js';add('b');export let value=1;`,
    'outside.js':`import {value} from './b.js';import {add} from './state.js';add('c'+value);`,
    'main.js':`import './a.js';import './outside.js';import {add,log} from './state.js';
      add('m');export function run(){return log;}`
  });
  assert.equal(run.outcome.value,'baAc1m');
});

test('cyclic synchronous bodies retain hoisted functions, live cells and lexical TDZ with TLA',async()=>{
  const modules={
    'state.js':stateSource,
    'a.js':`import {fromB} from './b.js';import {add} from './state.js';
      export let value=1;export function read(){return value;}
      add('a');await 0;value=3;add(fromB());`,
    'b.js':`import {read} from './a.js';import {add} from './state.js';
      try{read();}catch(error){add(error.name);}export function fromB(){return read();}`,
    'main.js':`import './a.js';import {log} from './state.js';export function run(){return log;}`
  };
  const run=await differential(modules);
  assert.equal(run.outcome.value,'ReferenceErrora3');
});

test('untaken awaits in an SCC retain async completion jobs and sibling order',async()=>{
  const run=await differential({
    'state.js':stateSource,
    'a.js':`import './b.js';import {add} from './state.js';add('a');`,
    'b.js':`import './a.js';import {add} from './state.js';
      add('b');if(false){await 0;}add('B');queueMicrotask(()=>add('q'));`,
    'sibling.js':`import {add} from './state.js';add('s');await 0;add('S');`,
    'main.js':`import './a.js';import './sibling.js';import {add,log} from './state.js';
      add('m');const observed=log;export function run(){return observed;}`
  });
  assert.equal(run.outcome.value,'bBsqaSm');
});

test('async SCC errors before and after await retain one rejection and allow started siblings to finish',async()=>{
  for(const pause of ['',`await 0;add('B');`]){
    const run=await differential({
      'state.js':stateSource,
      'a.js':`import './b.js';import {add} from './state.js';add('a');`,
      'b.js':`import './a.js';import {add} from './state.js';
        add('b');${pause}throw new TypeError('cycle failure');await 0;`,
      'sibling.js':`import {add} from './state.js';add('s');await 0;add('S');`,
      'main.js':`import './a.js';import './sibling.js';import {add,log} from './state.js';
        add('m');export function run(){return log;}`
    });
    assert.equal(run.outcome.status,'rejected');
    assert.deepEqual(run.outcome.value,{name:'TypeError'});
    assert(!run.outcome.log.includes('a')&&!run.outcome.log.includes('m'));
    assert(run.outcome.log.includes('S'));
    const failed=records(run.runtime).filter(record=>record.failed[1]);
    assert.equal(failed.length,3);
    assert(failed.every(record=>record.error[1]===failed[0].error[1]),
      'all rejected parents retain the original guest error identity');
  }
});

test('a failed cycle root prevents waiting members starting without suppressing unrelated ready work',async()=>{
  const run=await differential({
    'state.js':stateSource,
    'a.js':`import './b.js';import './fail.js';import {add} from './state.js';add('a');`,
    'b.js':`import './a.js';import './base.js';import {add} from './state.js';add('b');`,
    'base.js':`import {add} from './state.js';add('x');await 0;await 0;add('X');`,
    'fail.js':`import {add} from './state.js';add('f');throw 7;await 0;`,
    'good.js':`import './base.js';import {add} from './state.js';add('g');`,
    'main.js':`import './a.js';import './good.js';import {log} from './state.js';
      export function run(){return log;}`
  });
  assert.deepEqual(run.outcome,{status:'rejected',value:7,log:'xfXg'});
  const b=records(run.runtime)[run.linked.metadata.evaluationOrder.indexOf('b.js')];
  assert.equal(b.started[1],false);
  assert.equal(b.pending[1],1);
});

test('a synchronous DFS failure in an open SCC preserves its error while started async members finish',async()=>{
  const run=await differential({
    'state.js':stateSource,
    'a.js':`import './b.js';import './fail.js';import {add} from './state.js';add('a');`,
    'b.js':`import './a.js';import {add} from './state.js';add('b');await 0;add('B');`,
    'fail.js':`import {add} from './state.js';add('f');throw 7;`,
    'later.js':`import {add} from './state.js';add('z');await 0;add('Z');`,
    'main.js':`import './a.js';import './later.js';import {log} from './state.js';
      export function run(){return log;}`
  });
  assert.deepEqual(run.outcome,{status:'rejected',value:7,log:'bfB'});
  const later=records(run.runtime)[run.linked.metadata.evaluationOrder.indexOf('later.js')];
  assert.equal(later.status[1],'linked');
  assert.equal(later.started[1],false);
});

test('an unresolved cyclic evaluation stays pending across JSON restore without inventing an error',()=>{
  const modules={
    'state.js':stateSource,
    'a.js':`import './b.js';import {add} from './state.js';add('a');`,
    'b.js':`import './a.js';import {add} from './state.js';add('b');await new Promise(()=>{});add('B');`,
    'main.js':`import './a.js';import {log} from './state.js';export function run(){return log;}`
  };
  // Original ESM in an isolated native VM, with fully linked modules before
  // evaluation. The observation turn drains ready jobs without awaiting the
  // deliberately unresolved top-level capability or inventing a timeout pass.
  const oracle=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',`
    import vm from 'node:vm';
    const sources=JSON.parse(await new Promise(resolve=>{let data='';
      process.stdin.on('data',part=>data+=part);process.stdin.on('end',()=>resolve(data));}));
    const context=vm.createContext({});
    const modules=new Map(Object.entries(sources).map(([file,source])=>
      [file,new vm.SourceTextModule(source,{context,identifier:file})]));
    const entry=modules.get('main.js');
    await entry.link(specifier=>modules.get(specifier.slice(2)));
    let status='pending';entry.evaluate().then(()=>status='fulfilled',()=>status='rejected');
    await new Promise(resolve=>setImmediate(resolve));
    console.log(JSON.stringify({status,log:modules.get('state.js').namespace.log}));
  `],{input:JSON.stringify(modules),encoding:'utf8',timeout:10000});
  assert.equal(oracle.status,0,oracle.stderr);
  assert.deepEqual(JSON.parse(oracle.stdout),{status:'pending',log:'b'});
  const run=startOwned(modules),runtime=run.runtime;
  assert.equal(runtime.drive().kind,'waiting');
  const root=runtime.initialState.control.a0.activeFrameId;
  assert.equal(runtime.state.promises[runtime.initialState.frames[root].asyncPromiseId].status,'pending');
  const saved=wire(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters')));
  const restored=Object.assign(createRuntime(),saved);
  assert.equal(restored.drive().kind,'waiting');
  assert.deepEqual(wire(restored.exportRun()),wire(runtime.exportRun()));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
  assert(records(restored).filter(record=>record.asyncOrder[1]>0)
    .every(record=>record.status[1]==='evaluating-async'&&!record.failed[1]));
});

test('open DFS components, closed cycles and ancestor release restore exact retained execution',()=>{
  const modules={
    'state.js':stateSource,
    'a.js':`import './b.js';import {add} from './state.js';add('a');await 0;add('A');`,
    'b.js':`import './a.js';import {add} from './state.js';add('b');await 0;add('B');`,
    'main.js':`import './a.js';import {log} from './state.js';export function run(){return log;}`
  };
  const run=startOwned(modules),runtime=run.runtime;
  const aIndex=run.linked.metadata.evaluationOrder.indexOf('a.js');
  const bIndex=run.linked.metadata.evaluationOrder.indexOf('b.js');
  const checkpoints=new Map();
  for(let steps=0;steps<20000;steps++){
    const entries=records(runtime),a=entries[aIndex],b=entries[bIndex];
    if(a?.status&&b?.status){
      const phases={
        'open-dfs':b.status[1]==='evaluating'&&b.started?.[1]===true&&b.cycleRoot?.[1]===-1,
        'closed-scc':a.status[1]==='evaluating-async'&&b.status[1]==='evaluating-async'&&
          a.cycleRoot?.[1]===aIndex&&b.cycleRoot?.[1]===aIndex,
        'ancestor-release':b.status[1]==='evaluated'&&a.status[1]==='evaluating-async'&&
          a.started?.[1]===false
      };
      for(const [phase,active] of Object.entries(phases))if(active&&!checkpoints.has(phase)){
        checkpoints.set(phase,wire(Object.fromEntries(Object.entries(runtime)
          .filter(([key])=>key!=='adapters'))));
      }
    }
    const control=runtime.state.control.a0,frame=runtime.state.frames[control.activeFrameId];
    if(frame?.status==='running')runtime.step();
    else if(control.queue.length)runtime.enterQueuedJob();
    else break;
  }
  assert.deepEqual([...checkpoints.keys()],['open-dfs','closed-scc','ancestor-release']);
  const completed=finishOwned(run);
  assert.equal(completed.outcome.value,'bBaA');
  for(const [phase,snapshot] of checkpoints){
    const restored=Object.assign(createRuntime(),snapshot);
    assert.equal(restored.drive().kind,'terminated',phase);
    assert.deepEqual(wire(restored.exportRun()),completed.bundle,phase);
    assert.equal(validateBundle(restored.exportRun()).valid,true,phase);
    assert.equal(replayExact(restored.exportRun()).valid,true,phase);
  }
});

test('two pending host reads inside one SCC restore in both result orders without redispatch',()=>{
  const modules={
    'state.js':stateSource,
    'a.js':`import './b.js';import './c.js';import {add} from './state.js';add('a');`,
    'b.js':`import './a.js';import {add} from './state.js';add('b');add(await host.readAsync('b'));`,
    'c.js':`import './a.js';import {add} from './state.js';add('c');add(await host.readAsync('c'));`,
    'main.js':`import './a.js';import {log} from './state.js';export function run(){return log;}`
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  let dispatches=0,restoredDispatches=0;
  const runtime=createRuntime({adapters:{'demo.readAsync':()=>{
    dispatches++;return {kind:'pending'};
  }}}).startEntry({text:linked.source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true,allowHost:true});
  assert.equal(runtime.drive().kind,'waiting');
  const effects=Object.values(runtime.state.effects).filter(effect=>effect.operation==='demo.readAsync');
  assert.equal(effects.length,2);
  assert.equal(dispatches,2);
  const saved=wire(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters')));
  for(const order of [[0,1],[1,0]]){
    const make=()=>Object.assign(createRuntime({adapters:{'demo.readAsync':()=>{
      restoredDispatches++;throw new Error('SCC continuation redispatched a committed read');
    }}}),wire(saved));
    const first=make(),second=make();
    for(const machine of [first,second])for(const index of order){
      const input=machine.recordInputArrival({effectId:effects[index].id,kind:'completion',
        value:index===0?'B':'C'});
      machine.deliverInput(input.inputId);
      machine.drive();
    }
    const completed=finishOwned({runtime:first,linked});
    assert.equal(completed.outcome.value,order[0]===0?'bcBCa':'bcCBa');
    assert.deepEqual(finishOwned({runtime:second,linked}).bundle,completed.bundle);
  }
  assert.equal(dispatches,2);
  assert.equal(restoredDispatches,0);
});

test('for-await iteration and generated scheduler identifiers remain explicit boundaries',()=>{
  assert.throws(()=>linkEvaluatedModules({modules:siblings(`{for await(const item of []){add(item);}}`,
    `add('b');`),entryModule:'main.js',exportName:'run'}),/for-await module iteration/);
  assert.throws(()=>linkEvaluatedModules({modules:siblings(`await 0;`,
    `__traced_eval_modules[0].status='evaluated';`),entryModule:'main.js',exportName:'run'}),/reserved generated identifier/);
});
