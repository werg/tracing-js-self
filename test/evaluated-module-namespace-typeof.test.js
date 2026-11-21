import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {executeEvaluatedModules} from '../src/evaluated-modules.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

async function original(modules,args){
  const directory=await mkdtemp(join(tmpdir(),'owned-namespace-typeof-'));
  try{
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    for(const [file,source]of Object.entries(modules))await writeFile(join(directory,file),source);
    const {run}=await import(pathToFileURL(join(directory,'main.js')).href);
    return await run(...args);
  }finally{await rm(directory,{recursive:true,force:true});}
}
async function checked(modules,expected,args=[]){
  for(const scheduled of [false,true]){
    const sources=scheduled?{...modules,'async.js':'await 0;',
      'main.js':"import './async.js';"+modules['main.js']}:modules;
    assert.deepEqual(await original(sources,args),expected);
    const owned=await executeEvaluatedModules({modules:sources,entryModule:'main.js',exportName:'run',args});
    assert.deepEqual(owned.result,expected);
    assert.equal(owned.metadata.evaluationStrategy,scheduled?
      'async-dependency-scheduler':'dependency-concatenation');
    assert.equal(validateBundle(owned.bundle).valid,true);
    assert.equal(replayExact(owned.bundle).valid,true);
  }
}

test('typeof source-owned namespace bindings and pure static namespace paths is object',async()=>{
  await checked({
    'leaf.js':'export const value=9;export default 17;',
    'forward.js':"export * as cells from './leaf.js';import * as local from './leaf.js';export {local as alias};",
    'main.js':"import * as ns from './leaf.js';import {cells,alias} from './forward.js';"+
      "import * as all from './forward.js';export function run(){return [typeof ns,typeof cells,"+
      "typeof alias,typeof all.cells,typeof all['alias'],typeof all?.cells,typeof ns.value,typeof ns.missing];}"
  },['object','object','object','object','object','object','number','undefined']);
});

test('typeof namespace folding respects parameter, block, catch and inner class-name shadows',async()=>{
  await checked({
    'leaf.js':'export const value=9;',
    'main.js':"import * as ns from './leaf.js';const outer=typeof ns;export function run(ns){"+
      'let before;{try{before=typeof ns;}catch(error){before=error.name;}let ns=0;}'+
      'let caught;try{throw 4;}catch(ns){caught=typeof ns;}'+
      'const Holder=class ns{static observed=typeof ns;};'+
      'return [outer,typeof ns,before,(()=>{let ns;return typeof ns;})(),caught,Holder.observed];}'
  },['object','number','ReferenceError','undefined','number','function'],[17]);
});

test('namespace typeof is available during a cycle without bypassing exported-cell temporal dead zones',async()=>{
  await checked({
    'a.js':"import {namespaceType,valueType} from './b.js';export let value=7;export {namespaceType,valueType};",
    'b.js':"import * as ns from './a.js';export const namespaceType=typeof ns;export let valueType;"+
      'try{valueType=typeof ns.value;}catch(error){valueType=error.name;}',
    'main.js':"import {namespaceType,valueType,value} from './a.js';"+
      'export function run(){return [namespaceType,valueType,value];}'
  },['object','ReferenceError',7]);
});

test('namespace typeof preserves surrounding effects and ordinary export reads',async()=>{
  await checked({
    'leaf.js':'export const value=9;',
    'state.js':'export let count=0;export function tick(){count++;return 0;}',
    'main.js':"import * as ns from './leaf.js';import {count,tick} from './state.js';"+
      'export function run(){const first=(tick(),typeof ns);const second=(typeof ns,tick());'+
      'const ordinary=(tick(),typeof ns.value);return [first,second,ordinary,count];}'
  },['object',0,'number',3]);
});

test('effectful namespace operands keep their evaluation and object identity',async()=>{
  for(const [expression,calls] of [
    ['typeof ns[(effect(),"inner")]',1],
    ['typeof (effect(),ns)',1],
    ['typeof identity(ns).inner',0]
  ])await checked({
    'leaf.js':'export const value=9;',
    'forward.js':"export * as inner from './leaf.js';",
    'main.js':"import * as ns from './forward.js';let calls=0;"+
      'function effect(){calls++;return "inner";}function identity(value){return value;}'+
      'export function run(){return ['+expression+',calls];}'
  },['object',calls]);
});
