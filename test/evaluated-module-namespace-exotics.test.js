import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {linkEvaluatedModules,executeEvaluatedModules}
  from '../src/evaluated-modules.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {createBoundedRetainedModuleSession,
  restoreBoundedRetainedModuleSession} from '../src/evaluated-module-session.js';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {realizeGraph} from '../src/training/graph.js';

const sourceGraph={
  'base.js':`export let value=1;
    export const alpha=4;
    export const zeta=2;
    export function bump(){value++;}
    export function receiver(){return [this===undefined,
      Object.getPrototypeOf(this)===null,Object.isExtensible(this)===false];}`,
  'barrel.js':`export * as forwarded from './base.js';`,
  'empty.js':'export {};',
  'main.js':`import * as ns from './base.js';
    import {forwarded} from './barrel.js';
    import * as empty from './empty.js';
    export function inspect(){
      const before=Object.getOwnPropertyDescriptor(ns,'value');
      const dynamicKey='value',dynamicValue=ns[dynamicKey];
      ns.bump();
      const after=Object.getOwnPropertyDescriptor(ns,'value');
      let assignment,changed,readonly,freeze,badPrototype;
      try{ns.value=8;}catch(error){assignment=error.name;}
      const same=Object.defineProperty(ns,'value',{value:ns.value})===ns;
      try{Object.defineProperty(ns,'value',{value:8});}catch(error){changed=error.name;}
      try{Object.defineProperty(ns,'value',{writable:false});}catch(error){readonly=error.name;}
      try{Object.freeze(ns);}catch(error){freeze=error.name;}
      try{Object.setPrototypeOf(ns,{});}catch(error){badPrototype=error.name;}
      Object.preventExtensions(ns);
      const nullPrototype=Object.setPrototypeOf(ns,null)===ns;
      const tag=Object.getOwnPropertyDescriptor(ns,Symbol.toStringTag);
      return [ns===forwarded,Object.keys(ns),Object.getOwnPropertyNames(ns),
        Reflect.ownKeys(ns).map(key=>typeof key),Object.getOwnPropertySymbols(ns).length,
        ns.zeta,dynamicValue,
        [before.value,before.writable,before.enumerable,before.configurable,
          Object.hasOwn(before,'get')],
        [after.value,after.writable,after.enumerable,after.configurable],
        ns.receiver(),Object.getPrototypeOf(ns)===null,Object.isExtensible(ns),
        Object.isSealed(ns),Object.isFrozen(ns),ns[Symbol.toStringTag],
        [tag.value,tag.writable,tag.enumerable,tag.configurable],assignment,same,
        changed,readonly,freeze,badPrototype,
        Reflect.set(ns,'value',2),Reflect.deleteProperty(ns,'value'),
        Reflect.deleteProperty(ns,'missing'),Reflect.defineProperty(ns,'value',{value:8}),
        nullPrototype];
    }
    export function inspectEmpty(){
      const frozen=Object.freeze(empty)===empty;
      return [frozen,Object.isExtensible(empty),Object.isSealed(empty),
        Object.isFrozen(empty),Object.getOwnPropertySymbols(empty).length];
    }
    export function retained(){
      ns.bump();
      return [ns===forwarded,Object.getOwnPropertyDescriptor(ns,'value').value];
    }`
};

async function originalVmRun(modules,calls,entryModule='main.js'){
  const worker=`
    import vm from 'node:vm';
    import path from 'node:path';
    let input='';
    for await (const part of process.stdin) input+=part;
    const {modules:sources,calls,entryModule}=JSON.parse(input),context=vm.createContext({});
    const records=new Map(Object.entries(sources).map(([file,text])=>
      [file,new vm.SourceTextModule(text,{context,identifier:file})]));
    const entry=records.get(entryModule);
    await entry.link((specifier,referencing)=>{
      const target=path.posix.normalize(path.posix.join(
        path.posix.dirname(referencing.identifier),specifier));
      const record=records.get(target);
      if(!record)throw new Error('Missing test module '+target);
      return record;
    });
    await entry.evaluate();
    const out=[];
    for(const call of calls)
      out.push(await entry.namespace[call.exportName](...call.args));
    process.stdout.write(JSON.stringify(out));
  `;
  const result=spawnSync(process.execPath,
    ['--no-warnings','--experimental-vm-modules','--input-type=module','-e',worker],
    {input:JSON.stringify({modules,calls,entryModule}),encoding:'utf8',timeout:10000,
      env:process.env});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
async function originalVmEvaluationOutcome(modules,entryModule){
  const worker=`
    import vm from 'node:vm';
    import path from 'node:path';
    let input='';for await(const part of process.stdin)input+=part;
    const {modules:sources,entryModule}=JSON.parse(input),context=vm.createContext({});
    const records=new Map(Object.entries(sources).map(([file,text])=>
      [file,new vm.SourceTextModule(text,{context,identifier:file})]));
    const entry=records.get(entryModule);
    await entry.link((specifier,referencing)=>records.get(path.posix.normalize(
      path.posix.join(path.posix.dirname(referencing.identifier),specifier))));
    try{await entry.evaluate();process.stdout.write(JSON.stringify({status:'returned'}));}
    catch(error){process.stdout.write(JSON.stringify({status:'threw',name:error.name}));}
  `;
  const result=spawnSync(process.execPath,
    ['--no-warnings','--experimental-vm-modules','--input-type=module','-e',worker],
    {input:JSON.stringify({modules,entryModule}),encoding:'utf8',timeout:10000,
      env:process.env});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('namespace exports named __proto__, constructor and toString keep live own accessors',async()=>{
  const modules={
    'leaf.js':`export let value=1;export function bump(){value++;}
      export {value as '__proto__',value as 'constructor',value as 'toString'};`,
    'main.js':`import * as ns from './leaf.js';export function run(){
      const before=[ns.__proto__,ns.constructor,ns.toString];
      const descriptor=Object.getOwnPropertyDescriptor(ns,'__proto__');ns.bump();
      return [Object.keys(ns),before,[ns.__proto__,ns.constructor,ns.toString],
        descriptor.value,Object.hasOwn(ns,'__proto__'),Object.getPrototypeOf(ns)===null];
    }`
  };
  const calls=[{exportName:'run',args:[]}],native=await originalVmRun(modules,calls);
  const owned=await executeEvaluatedModules({modules,entryModule:'main.js',calls});
  assert.deepEqual(owned.result,native);
  assert.deepEqual(native[0],[['__proto__','bump','constructor','toString','value'],
    [1,1,1],[2,2,2],1,true,true]);
  const bundle=JSON.parse(JSON.stringify(owned.bundle));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});

test('observed namespace identities use live, sorted, null-prototype exotics',async()=>{
  const calls=[{exportName:'inspect',args:[]},{exportName:'inspectEmpty',args:[]}];
  const native=await originalVmRun(sourceGraph,calls);
  const linked=linkEvaluatedModules({modules:sourceGraph,entryModule:'main.js',
    calls});
  assert.equal(linked.metadata.requiresModuleNamespace,true);
  assert.deepEqual(linked.metadata.modules.map(({file})=>file),
    ['base.js','barrel.js','empty.js','main.js']);
  const owned=await executeEvaluatedModules({modules:sourceGraph,
    entryModule:'main.js',calls});
  assert.deepEqual(owned.result,native);
  assert.equal(owned.bundle.entrySpec.moduleNamespaceIntrinsic,true);
  assert.equal(Object.values(owned.bundle.finalState.heap)
    .filter(entity=>entity.kind==='module-namespace').length,2);
  assert.equal(validateBundle(owned.bundle).valid,true);
  assert.equal(replayExact(owned.bundle).valid,true);
});

test('namespace source paths remain explicitly unqualified and namespace output refuses',async()=>{
  const fixture={id:'namespace-reflection-unqualified',family:'module-namespace-exotic',
    modules:{
      'base.js':'export let value=1;',
      'main.js':`import * as ns from './base.js';
        export function run(key='value'){return {keys:Object.keys(ns),item:ns[key]};}`
    },moduleEntry:'main.js',exportName:'run'};
  const refusal=await verifyRegionModuleTrainingCase(fixture);
  assert.equal(refusal.status,'projection_refused');
  assert.equal(refusal.category,'unsupported.module-namespace-projection');
  assert.equal(refusal.moduleNamespace,'owned-internal');
  await assert.rejects(()=>executeEvaluatedModules({modules:{
    'base.js':'export const value=1;',
    'main.js':`import * as ns from './base.js';
      export function run(){return {namespace:ns};}`
  },entryModule:'main.js',exportName:'run'}),
  /Module namespace values are not supported by the evaluated-module result codec/);
});

test('quoted numeric namespace keys record the Node 24 ordering discrepancy',async()=>{
  const modules={
    'base.js':`const two=2,ten=10;export {two as "2",ten as "10"};
      export const z=1,a=3;`,
    'main.js':`import * as ns from './base.js';
      export function run(){return Object.keys(ns);}`
  };
  const native=await originalVmRun(modules,[{exportName:'run',args:[]}]);
  const owned=await executeEvaluatedModules({modules,entryModule:'main.js',
    exportName:'run'});
  assert.deepEqual(native[0],['2','10','a','z']);
  assert.deepEqual(owned.result,['10','2','a','z']);
  assert.notDeepEqual(owned.result,native[0],
    'Node 24.22.3 orders integer-index export names numerically; the module namespace algorithm sorts them lexically');
});

test('cyclic descriptor reads preserve the original namespace TDZ error',async()=>{
  const modules={
    'a.js':`import {observed,defined,reflected} from './b.js';
      export let later=2;
      export function run(){return [observed,defined,reflected,later];}`,
    'b.js':`import * as a from './a.js';
      export let observed,defined,reflected;
      try{Object.getOwnPropertyDescriptor(a,'later');observed='no-error';}
      catch(error){observed=error.name;}
      try{Object.defineProperty(a,'later',{writable:false});defined='no-error';}
      catch(error){defined=error.name;}
      try{Reflect.defineProperty(a,'later',{writable:false});reflected='no-error';}
      catch(error){reflected=error.name;}`
  };
  const native=await originalVmRun(modules,[{exportName:'run',args:[]}],'a.js');
  const owned=await executeEvaluatedModules({modules,entryModule:'a.js',
    exportName:'run'});
  assert.deepEqual(owned.result,native[0]);
  assert.deepEqual(owned.result,
    ['ReferenceError','ReferenceError','ReferenceError',2]);
});

test('namespace live getters work after async module environments are primed',async()=>{
  const modules={
    'base.js':'export let value=1;',
    'left.js':'export const left=await Promise.resolve(2);',
    'right.js':'export const right=await Promise.resolve(3);',
    'main.js':`import * as ns from './base.js';
      import {left} from './left.js';import {right} from './right.js';
      export function run(){return [ns.value,left,right,Object.keys(ns)];}`
  };
  const native=await originalVmRun(modules,[{exportName:'run',args:[]}]);
  const owned=await executeEvaluatedModules({modules,entryModule:'main.js',
    exportName:'run'});
  assert.equal(owned.metadata.evaluationStrategy,'async-dependency-scheduler');
  assert.equal(owned.metadata.requiresModuleNamespace,true);
  assert.deepEqual([owned.result],native);
});

test('namespace getter continuation restores through JSON and exact replay',async()=>{
  const modules={
    'base.js':'export let value=1;',
    'main.js':`import * as ns from './base.js';
      export function run(){return Object.getOwnPropertyDescriptor(ns,'value').value;}`
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  const runtime=createRuntime(),source=runtime.registerSource({text:linked.source,
    url:'namespace-checkpoint://test',trainingProfile:true,
    moduleNamespaceIntrinsic:true});
  runtime.startEntry({source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true,moduleNamespaceIntrinsic:true});
  for(let steps=0;steps<10000;steps++){
    if(Object.values(runtime.state.frames)
      .some(frame=>frame.pendingModuleNamespace))break;
    const frame=runtime.state.frames[runtime.state.control.a0.activeFrameId];
    if(frame?.status==='running')runtime.step();
    else if(runtime.state.control.a0.queue.length)runtime.enterQueuedJob();
    else throw new Error('Namespace getter did not start');
  }
  assert(Object.values(runtime.state.frames)
    .some(frame=>frame.pendingModuleNamespace?.kind==='descriptor'));
  const saved=JSON.parse(JSON.stringify(Object.fromEntries(
    Object.entries(runtime).filter(([key])=>key!=='adapters'))));
  assert.equal(runtime.drive().kind,'terminated');
  const restored=Object.assign(createRuntime(),saved);
  assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),
    JSON.parse(JSON.stringify(runtime.exportRun())));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
});

test('namespace identities and live values survive retained JSON history restore',async()=>{
  const native=await originalVmRun(sourceGraph,[
    {exportName:'retained',args:[]},{exportName:'retained',args:[]}]);
  const session=createBoundedRetainedModuleSession({modules:sourceGraph,
    entryModule:'main.js'});
  let restored;
  try{
    assert.deepEqual((await session.invoke('retained')).result,native[0]);
    const snapshot=JSON.parse(JSON.stringify(session.snapshot()));
    restored=await restoreBoundedRetainedModuleSession(snapshot);
    assert.deepEqual((await restored.invoke('retained')).result,native[1]);
  }finally{
    session.close();restored?.close();
  }
});

test('namespace hasOwn keys and integrity checks propagate cyclic export TDZ',async()=>{
  const operations=[
    ['hasOwn',"Object.hasOwn(ns,'later')"],
    ['keys','Object.keys(ns)'],
    ['isSealed','Object.isSealed(ns)'],
    ['isFrozen','Object.isFrozen(ns)'],
    ['seal','Object.seal(ns)===ns'],
    ['freeze','Object.freeze(ns)===ns'],
    ['names','Object.getOwnPropertyNames(ns)'],
    ['ownKeysLength','Reflect.ownKeys(ns).length']
  ];
  const modules={
    'a.js':"import {results} from './b.js'; export let later=1; export function run(){return results;}",
    'b.js':"import * as ns from './a.js'; export const results=[];"+
      operations.map(([name,expression])=>
        `try{results.push(['${name}',${expression}]);}catch(error){results.push(['${name}',error.name]);}`).join('\n')
  };
  const native=await originalVmRun(modules,[{exportName:'run',args:[]}],'a.js');
  const owned=await executeEvaluatedModules({modules,entryModule:'a.js',exportName:'run'});
  assert.deepEqual(owned.result,native[0]);
  assert.deepEqual(owned.result,[
    ['hasOwn','ReferenceError'],['keys','ReferenceError'],
    ['isSealed','ReferenceError'],['isFrozen','ReferenceError'],
    ['seal','ReferenceError'],['freeze','ReferenceError'],
    ['names',['later','run']],['ownKeysLength',3]
  ]);
  assert.equal(validateBundle(owned.bundle).valid,true);
  assert.equal(replayExact(owned.bundle).valid,true);
});

test('namespace freeze and frozen checks stop after the first initialized export',async()=>{
  const modules={
    'a.js':`import {inspect} from './b.js';
      export function aReady(){return 1;}
      export const observations=inspect();
      export let zLater=2;
      export function run(){return observations;}`,
    'b.js':`import * as ns from './a.js';
      export function inspect(){
        const capture=fn=>{try{return fn();}catch(error){return error.name;}};
        return [capture(()=>Object.isFrozen(ns)),
          capture(()=>Object.freeze(ns)===ns),capture(()=>Object.keys(ns)),
          capture(()=>Object.isSealed(ns)),capture(()=>Object.seal(ns)===ns),
          Object.getOwnPropertyNames(ns),Reflect.ownKeys(ns).length];
      }`
  };
  const native=await originalVmRun(modules,[{exportName:'run',args:[]}],'a.js');
  const owned=await executeEvaluatedModules({modules,entryModule:'a.js',exportName:'run'});
  assert.deepEqual(owned.result,native[0]);
  assert.deepEqual(owned.result.slice(0,5),[false,'TypeError','ReferenceError',
    'ReferenceError','ReferenceError']);
  assert.deepEqual(owned.result[5],['aReady','observations','run','zLater']);
  assert.equal(owned.result[6],5);
  assert.equal(validateBundle(owned.bundle).valid,true);
  assert.equal(replayExact(owned.bundle).valid,true);
});

test('uncaught namespace inspection TDZ propagates through module evaluation',async()=>{
  const modules={
    'a.js':`import './b.js';export let later=1;export function run(){return later;}`,
    'b.js':`import * as ns from './a.js';Object.hasOwn(ns,'later');`
  };
  assert.deepEqual(await originalVmEvaluationOutcome(modules,'a.js'),
    {status:'threw',name:'ReferenceError'});
  await assert.rejects(()=>executeEvaluatedModules({modules,
    entryModule:'a.js',exportName:'run'}),/Owned module evaluation rejected/);
});

test('uncaught namespace freeze TypeError propagates through module evaluation',async()=>{
  const modules={
    'a.js':`import {forceFreeze} from './b.js';
      export let aFirst=1;
      export const outcome=forceFreeze();
      export function run(){return outcome;}`,
    'b.js':`import * as ns from './a.js';
      export function forceFreeze(){return Object.freeze(ns);}`
  };
  assert.deepEqual(await originalVmEvaluationOutcome(modules,'a.js'),
    {status:'threw',name:'TypeError'});
  const linked=linkEvaluatedModules({modules,entryModule:'a.js',exportName:'run'}),
    runtime=createRuntime(),source=runtime.registerSource({text:linked.source,
      url:'namespace-freeze-abrupt://test',trainingProfile:true,
      moduleNamespaceIntrinsic:true});
  runtime.startEntry({source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true,moduleNamespaceIntrinsic:true});
  assert.equal(runtime.drive().kind,'terminated');
  const root=runtime.initialState.control.a0.activeFrameId,
    promiseId=runtime.initialState.frames[root].asyncPromiseId,
    rejected=runtime.state.promises[promiseId];
  assert.equal(rejected.status,'rejected');
  const reason=realizeGraph(runtime.state.heap,[rejected.value.value])[0];
  assert.equal(reason.name,'TypeError');
  assert.match(reason.message,/Cannot redefine property: aFirst/);
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});

test('namespace freeze define continuation restores through JSON and replay',async()=>{
  const modules={
    'base.js':'export let alpha=1;',
    'main.js':`import * as ns from './base.js';
      export function run(){try{Object.freeze(ns);}catch(error){return error.name;}}`
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  const runtime=createRuntime(),source=runtime.registerSource({text:linked.source,
    url:'namespace-freeze-checkpoint://test',trainingProfile:true,
    moduleNamespaceIntrinsic:true});
  runtime.startEntry({source,functionName:linked.entryFunction,
    args:[linked.entryInput],allowAsync:true,moduleNamespaceIntrinsic:true});
  for(let steps=0;steps<10000;steps++){
    const frame=runtime.state.frames[runtime.state.control.a0.activeFrameId];
    if(Object.values(runtime.state.frames).some(candidate=>
      candidate.pendingModuleNamespace?.kind==='namespace-inspection'&&
      candidate.pendingModuleNamespace.phase==='freeze-define'))break;
    if(frame?.status==='running')runtime.step();
    else if(runtime.state.control.a0.queue.length)runtime.enterQueuedJob();
    else throw new Error('Namespace freeze define getter did not start');
  }
  assert(Object.values(runtime.state.frames).some(frame=>
    frame.pendingModuleNamespace?.kind==='namespace-inspection'&&
    frame.pendingModuleNamespace.phase==='freeze-define'));
  const saved=JSON.parse(JSON.stringify(Object.fromEntries(
    Object.entries(runtime).filter(([key])=>key!=='adapters'))));
  assert.equal(runtime.drive().kind,'terminated');
  const original=JSON.parse(JSON.stringify(runtime.exportRun()));
  const restored=Object.assign(createRuntime(),saved);
  assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),original);
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
});
