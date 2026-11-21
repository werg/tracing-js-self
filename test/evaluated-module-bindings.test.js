import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {linkEvaluatedModules,executeEvaluatedModules} from '../src/evaluated-modules.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {createRuntime} from '../src/runtime.js';

async function differential(body,{scheduled=false,leaf='export let x=5;export function bump(){x+=2;}'}={}){
  const modules={'leaf.js':leaf,
    ...(scheduled?{'sibling.js':'await 0;'}:{}),
    'main.js':(scheduled?"import './sibling.js';":'')+
      "import {x,bump} from './leaf.js';import * as ns from './leaf.js';"+body};
  const directory=await mkdtemp(join(tmpdir(),'owned-binding-scope-'));
  try{
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    for(const [file,source] of Object.entries(modules))await writeFile(join(directory,file),source);
    const {run:original}=await import(pathToFileURL(join(directory,'main.js')).href);
    const expected=await original();
    const owned=await executeEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
    assert.deepEqual(owned.result,expected);
    assert.equal(validateBundle(owned.bundle).valid,true);
    assert.equal(replayExact(owned.bundle).valid,true);
    assert.equal(owned.metadata.evaluationStrategy,scheduled?
      'async-dependency-scheduler':'dependency-concatenation');
    return owned;
  }finally{await rm(directory,{recursive:true,force:true});}
}

test('parameters, blocks, catches, named functions and classes shadow imported and namespace bindings',async()=>{
  const body=`
    function parameter(x,ns){x+=1;ns.x+=2;return [x,ns.x];}
    function caught(){try{throw {x:8};}catch(ns){return ns.x;}}
    function named(){const read=function x(n){return n?x(n-1):11;};return read(2);}
    function localClass(){class ns{static x=13;}return ns.x;}
    function blocks(){let result;{const ns={x:9};result=()=>ns.x;}return result();}
    export function run(){const before=[x,ns.x];bump();return [before,
      parameter(2,{x:4}),caught(),named(),localClass(),blocks(),x,ns.x];}`;
  for(const scheduled of [false,true]){
    const run=await differential(body,{scheduled});
    assert.deepEqual(run.result,[[5,5],[3,6],8,11,13,9,7,7]);
  }
});

test('parameter defaults see imports before body var declarations and retain lexical TDZ',async()=>{
  const run=await differential(`
    function defaultValue(value=x){var x=19;return [value,x];}
    function namespaceDefault(value=ns.x){var ns={x:20};return [value,ns.x];}
    function hoisted(){const before=typeof x;var x=21;return [before,x];}
    function deadZone(){try{return x;}catch(error){return error.name;}let x=22;}
    function parameterTDZ(x=x){return x;}
    export function run(){let errorName='';try{parameterTDZ();}catch(error){errorName=error.name;}
      return [defaultValue(),namespaceDefault(),hoisted(),deadZone(),errorName,x];}`);
  assert.deepEqual(run.result,[[5,19],[5,20],['undefined',21],'ReferenceError','ReferenceError',5]);
});

test('loop, switch and destructuring scopes retain reads and writes to their own local cells',async()=>{
  const run=await differential(`
    function loops(){let total=0;for(let x=0;x<3;x++){total+=x;}
      for(const ns of [{x:3},{x:4}])total+=ns.x;return total;}
    function destructure({x=ns.x,ns:space}={ns:{x:8}}){[x]=[x+1];return [x,space.x];}
    function branch(value){switch(value){case 1:let x=12;return x;default:return 0;}}
    function switched(){switch(x){case 5:let x=14;return x;default:return 0;}}
    function classScope(){const C=class x{static value=x.name;};return C.value;}
    export function run(){return [loops(),destructure(),branch(1),switched(),classScope(),x,ns.x];}`);
  assert.deepEqual(run.result,[10,[6,8],12,14,'x',5,5]);
});

test('shadowed namespace receivers remain ordinary method calls',async()=>{
  const run=await differential(`
    function call(ns){return ns.value();}
    function local(){const ns={x:23,value(){return this.x;}};return ns.value();}
    export function run(){return [call({x:17,value(){return this.x;}}),local(),ns.x];}`);
  assert.deepEqual(run.result,[17,23,5]);
});

test('an import write after an unrelated shadow still rejects before module execution',()=>{
  for(const statement of ['x=9;','[x]=[9];','({x}={x:9});','ns.x=9;'])
    assert.throws(()=>linkEvaluatedModules({modules:{'leaf.js':'export let x=5;',
      'main.js':"import {x} from './leaf.js';import * as ns from './leaf.js';"+
        'export function run(){{let x=2;const ns={x:3};x++;ns.x++;}'+statement+'}'},
      entryModule:'main.js',exportName:'run'}),/read-only/);
});

test('captured shadow cells survive JSON restoration without rebinding the module import',()=>{
  const linked=linkEvaluatedModules({modules:{'leaf.js':'export let x=5;',
    'main.js':`import {x} from './leaf.js';import * as ns from './leaf.js';
      function imported(){return x;}
      export async function run(){const ns={x:20};let x=30;const read=()=>ns.x+x;
        await 0;ns.x+=1;x+=2;return [read(),imported()];}`},
    entryModule:'main.js',exportName:'run'});
  const runtime=createRuntime().startEntry({text:linked.source,
    functionName:linked.entryFunction,args:[linked.entryInput],allowAsync:true});
  let checkpoint;
  for(let steps=0;steps<10000;steps++){
    const control=runtime.state.control.a0,frame=runtime.state.frames[control.activeFrameId];
    const captured=Object.values(runtime.state.envs).some(environment=>
      environment.bindings.ns?.token?.value?.[0]==='ref'&&
      environment.bindings.x?.token?.value?.[1]===30);
    if(captured&&frame?.status!=='running'){
      checkpoint=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(runtime)
        .filter(([key])=>key!=='adapters'))));break;
    }
    if(frame?.status==='running')runtime.step();
    else if(control.queue.length)runtime.enterQueuedJob();
    else break;
  }
  assert(checkpoint,'capture the await with both shadow cells initialized');
  assert.equal(runtime.drive().kind,'terminated');
  const expected=JSON.parse(JSON.stringify(runtime.exportRun()));
  const restored=Object.assign(createRuntime(),checkpoint);
  assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),expected);
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
});

test('module-scoped vars in blocks and loops do not leak across flattened module environments',async()=>{
  for(const scheduled of [false,true]){
    const run=await differential(`
      import {read} from './leaf.js';
      const before=shared;{var shared=11;}for(var index=0;index<2;index++){}
      var shared;export function run(){return [before,shared,index,x,read(),ns.index];}`,{
      scheduled,leaf:`{var shared=7;}for(var index=0;index<3;index++){}
        export let x=shared;export function bump(){x++;}
        export function read(){return shared;}export {index};`
    });
    assert.deepEqual(run.result,[undefined,11,2,7,7,3]);
  }
});

test('module var exports are initialized before cyclic dependency evaluation',async()=>{
  const modules={
    'a.js':"import {before} from './b.js';export var x=3;export function run(){return [before,x];}",
    'b.js':"import {x} from './a.js';export const before=x;"
  };
  const directory=await mkdtemp(join(tmpdir(),'owned-var-cycle-'));
  try{
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    for(const [file,source] of Object.entries(modules))await writeFile(join(directory,file),source);
    const {run:original}=await import(pathToFileURL(join(directory,'a.js')).href);
    const owned=await executeEvaluatedModules({modules,entryModule:'a.js',exportName:'run'});
    assert.deepEqual(owned.result,original());
    assert.deepEqual(owned.result,[undefined,3]);
    assert.equal(validateBundle(owned.bundle).valid,true);
    assert.equal(replayExact(owned.bundle).valid,true);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('imported constructors retain new-expression grouping around scheduled binding getters',async()=>{
  for(const scheduled of [false,true]){
    const run=await differential(`import {Ctor} from './leaf.js';
      export function run(){const named=new Ctor(11);const property=new ns.Ctor(13);
        return [named.value,property.value];}`,{scheduled,
      leaf:'export let x=5;export function bump(){x++;}export function Ctor(value){this.value=value;}'});
    assert.deepEqual(run.result,[11,13]);
  }
});
