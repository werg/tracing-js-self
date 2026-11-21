import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {linkEvaluatedModules,executeEvaluatedModules} from '../src/evaluated-modules.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

async function original(modules){
  const directory=await mkdtemp(join(tmpdir(),'owned-namespace-'));
  try{
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    for(const [file,source] of Object.entries(modules))await writeFile(join(directory,file),source);
    const {run}=await import(pathToFileURL(join(directory,'main.js')).href);
    return await run();
  }finally{await rm(directory,{recursive:true,force:true});}
}
async function checked(modules,{scheduled=false}={}){
  if(scheduled)modules={...modules,'sibling.js':'await 0;',
    'main.js':"import './sibling.js';"+modules['main.js']};
  const expected=await original(modules);
  const run=await executeEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  assert.deepEqual(run.result,expected);
  assert.equal(run.metadata.evaluationStrategy,scheduled?
    'async-dependency-scheduler':'dependency-concatenation');
  assert.equal(validateBundle(run.bundle).valid,true);
  assert.equal(replayExact(run.bundle).valid,true);
  return run;
}
async function specificationControl(t,modules,expected){
  const run=await executeEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  assert.deepEqual(run.result,expected);
  assert.equal(validateBundle(run.bundle).valid,true);
  assert.equal(replayExact(run.bundle).valid,true);
  // The retained ECMA-262 17th-edition ResolveExport and GetModuleNamespace
  // algorithms are the authority for these controls. The current Node/V8
  // engine disagrees; retain that failure explicitly, never label it a pass.
  let reference;
  try{reference={status:'returned',value:await original(modules)};}
  catch(error){reference={status:'threw',name:error.name,message:error.message};}
  let nativeDifferential='failed';
  if(reference.status==='returned'){
    try{assert.deepEqual(reference.value,expected);nativeDifferential='passed';}catch{}
  }
  t.diagnostic(JSON.stringify({authority:'ECMA-262 17.0 ResolveExport/GetModuleNamespace',
    node:process.version,v8:process.versions.v8,owned:'passed',nativeDifferential,
    expected,reference},(_,value)=>value===undefined?{type:'undefined'}:value));
  return run;
}

test('missing namespace properties are undefined even with a shadowed undefined name',async()=>{
  for(const scheduled of [false,true]){
    const run=await checked({
      'leaf.js':'export const x=3;',
      'main.js':`import * as ns from './leaf.js';
        export function run(){const undefined=91;return [ns.x,ns.missing,ns['not-an-identifier'],
          ns.toString,ns.__proto__,typeof ns.missing,undefined];}`
    },{scheduled});
    assert.deepEqual(run.result,[3,undefined,undefined,undefined,undefined,'undefined',91]);
  }
});

test('direct namespace ambiguity is absent while same-origin stars preserve live cells',async()=>{
  for(const scheduled of [false,true]){
    const run=await checked({
      'a.js':'export let x=1;export function bump(){x+=2;}export const conflict=4;',
      'b.js':'export const conflict=5;',
      'left.js':"export * from './a.js';",
      'right.js':"export * from './a.js';",
      'barrel.js':"export * from './left.js';export * from './right.js';export * from './b.js';",
      'main.js':`import * as ns from './barrel.js';import {bump} from './a.js';
        export function run(){const before=ns.x;bump();return [before,ns.x,ns.conflict];}`
    },{scheduled});
    assert.deepEqual(run.result,[1,3,undefined]);
  }
});

test('namespace forwards and local namespace exports compose through named and star imports',async()=>{
  for(const scheduled of [false,true]){
    const run=await checked({
      'leaf.js':'export let x=2;export function bump(){x+=3;}export default 17;',
      'direct.js':"export * as cells from './leaf.js';",
      'local.js':"import * as space from './leaf.js';export {space as local};",
      'barrel.js':"export * from './direct.js';export {local as cells2} from './local.js';",
      'main.js':`import * as all from './barrel.js';import {cells,cells2} from './barrel.js';
        import {bump} from './leaf.js';export function run(){
          const before=all.cells.x;bump();return [before,cells.x,cells2['x'],all.cells.default];}`
    },{scheduled});
    assert.deepEqual(run.result,[2,5,5,17]);
  }
});

test('specification control: nested ambiguity cannot be supplied by a later star path',async t=>{
  await specificationControl(t,{
    'a.js':'export const x=1;',
    'b.js':'export const x=2;',
    'ambiguous.js':"export * from './a.js';export * from './b.js';",
    'barrel.js':"export * from './ambiguous.js';export * from './a.js';",
    'main.js':"import * as ns from './barrel.js';export function run(){return ns.x;}"
  },undefined);
});

test('specification control: same-origin namespace reexports survive a star diamond',async t=>{
  const run=await specificationControl(t,{
    'leaf.js':'export const x=23;',
    'left.js':"export * as cells from './leaf.js';",
    'right.js':"export * as cells from './leaf.js';",
    'barrel.js':"export * from './left.js';export * from './right.js';",
    'main.js':"import {cells} from './barrel.js';export function run(){return cells.x;}"
  },23);
  assert.equal(run.result,23);
});

test('missing and ambiguous named imports and unused indirect exports still fail linking',()=>{
  const modules={
    'a.js':'export const x=1;',
    'b.js':'export const x=2;',
    'ambiguous.js':"export * from './a.js';export * from './b.js';",
    'barrel.js':"export * from './ambiguous.js';export * from './a.js';"
  };
  for(const statement of ["import {x} from './barrel.js';","export {x} from './barrel.js';",
    "import {missing} from './a.js';","export {missing} from './a.js';"])
    assert.throws(()=>linkEvaluatedModules({modules:{...modules,
      'main.js':statement+'export function run(){return 0;}'},entryModule:'main.js',exportName:'run'}),
    /ambiguous export|unresolved export/);
});

test('namespace aliases cannot escape, become receivers, mutate or bind generated identities',()=>{
  for(const expression of ['return cells;','return all.cells;','return cells.fn();',
    'return all.cells.fn();','return cells.fn`x`;','cells.x=7;','all.cells.x++;',
    '[cells.x]=[7];','({x:cells.x}={x:7});','for(cells.x of [1]){}',
    'return all.cells[key];']){
    assert.throws(()=>linkEvaluatedModules({modules:{
      'leaf.js':'export let x=1;export function fn(){return this;}',
      'barrel.js':"export * as cells from './leaf.js';",
      'main.js':`import * as all from './barrel.js';import {cells} from './barrel.js';
        export function run(key){${expression}}`
    },entryModule:'main.js',exportName:'run'}),/Unsupported evaluated-module/);
  }
});

test('namespace lexical shadows refuse instead of reading an unrelated imported cell',()=>{
  for(const body of ["let ns={x:9};return ns.x;","{const ns={x:9};return ns.x;}",
    "function ns(){return 9;}return ns();","const read=function ns(){return ns;};return read();",
    "class ns{}return ns;","const C=class ns{};return C;"])
    assert.throws(()=>linkEvaluatedModules({modules:{'leaf.js':'export const x=1;',
      'main.js':"import * as ns from './leaf.js';export function run(){"+body+'}'},
      entryModule:'main.js',exportName:'run'}),/shadowed/);
});

test('property keys sharing a namespace name are not namespace reads',async()=>{
  const run=await checked({'leaf.js':'export const x=3;',
    'main.js':`import * as ns from './leaf.js';export function run(){
      const object={ns:7};return [object.ns,ns.x];}`});
  assert.deepEqual(run.result,[7,3]);
});

test('destructuring and loop assignments cannot mutate imported live cells',()=>{
  for(const body of ['[x]=[7];','({x}={x:7});','[...x]=[];',
    'for(x of [1]){}','for({x} of [{x:1}]){}','for(x in {a:1}){}'])
    assert.throws(()=>linkEvaluatedModules({modules:{'leaf.js':'export let x=1;',
      'main.js':"import {x} from './leaf.js';export function run(){"+body+'return x;}'},
      entryModule:'main.js',exportName:'run'}),/read-only import/);
});
