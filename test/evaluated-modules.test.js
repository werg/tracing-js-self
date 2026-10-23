import test from 'node:test';
import assert from 'node:assert/strict';
import {executeEvaluatedModules,linkEvaluatedModules} from 'tracing-js-self/evaluated-modules';
import {validateBundle,replayExact} from 'tracing-js-self';

function verified(options){
  return executeEvaluatedModules(options).then(run=>{
    assert.equal(validateBundle(run.bundle).valid,true);
    assert.equal(replayExact(run.bundle).valid,true);
    assert.equal(run.bundle.entrySpec.kind,'function');
    assert.equal(run.metadata.profile,'evaluated-module/1');
    return run;
  });
}

test('evaluated modules run dependency initialization once and share mutable live bindings',async()=>{
  const modules={
    'counter.js':`export let count=1;
      export function advance(){count+=2;return count;}`,
    'main.js':`import {count,advance} from './counter.js';
      export function main(){const before=count;advance();return [before,count,advance(),count];}`
  };
  const run=await verified({modules,entryModule:'main.js',exportName:'main'});
  assert.deepEqual(run.result,[1,3,5,5]);
  assert.deepEqual(run.metadata.evaluationOrder,['counter.js','main.js']);
  assert(run.metadata.links.some(link=>link.local==='count'&&link.live));
  assert.match(run.bundle.sources[0].text,/__traced_eval_m1_count/);
});

test('module side effects use dependency ordering even with import elision',async()=>{
  const modules={
    'a.ts':'export let result = 2;',
    'side.ts':'export const unused = 9;',
    'main.ts':`import './side.ts';
      import {result} from './a.ts';
      export function run(){return result + 4;}`
  };
  const run=await verified({modules,entryModule:'main.ts',exportName:'run'});
  assert.equal(run.result,6);
  assert.deepEqual(run.metadata.evaluationOrder,['side.ts','a.ts','main.ts']);
});

test('explicit reexports and aliased live reads retain original lexical cell',async()=>{
  const modules={
    'state.js':'export let value=3; export function increment(){value+=4;}',
    'barrel.js':"export {value as n,increment as tick} from './state.js';",
    'main.js':`import {n,tick} from './barrel.js';
      export function run(){const before=n;tick();return [before,n];}`
  };
  const run=await verified({modules,entryModule:'main.js',exportName:'run'});
  assert.deepEqual(run.result,[3,7]);
});

test('top-level await settles an owned guest Promise prior to dependent evaluation',async()=>{
  const modules={
    'data.js':'export const initial=await Promise.resolve(5);',
    'main.js':`import {initial} from './data.js';
      export function run(x){return initial*x;}`
  };
  const run=await verified({modules,entryModule:'main.js',exportName:'run',args:[3]});
  assert.equal(run.result,15);
  assert(Object.values(run.bundle.finalState.promises).some(p=>p.status==='fulfilled'));
});

test('top-level native host service is journaled and replay does not invoke it',async()=>{
  let serviceCalls=0;
  const run=await verified({modules:{
    'config.js':"export const config=await host.readAsync('k');",
    'main.js':`import {config} from './config.js';
      export function run(){return config + 10;}`
  },entryModule:'main.js',exportName:'run',
  services:{'demo.readAsync':async()=>{serviceCalls++;return 7;}}});
  assert.equal(run.result,17);
  assert.equal(serviceCalls,1);
  assert.equal(run.bundle.events.filter(x=>x.operation==='external.input.arrive').length,1);
  assert.equal(run.bundle.events.filter(x=>x.operation==='external.input.deliver').length,1);
  assert.equal(serviceCalls,1);
});

test('result of pure JS ESM graph agrees with independent native module loader',async()=>{
  const leaf='export let n=2;export function step(){n+=3;}';
  const leafUrl='data:text/javascript,'+encodeURIComponent(leaf);
  const parent="import {n,step} from "+JSON.stringify(leafUrl)+
    ";export function run(x){step();return n*x;}";
  const parentUrl='data:text/javascript,'+encodeURIComponent(parent);
  const oracle=await import(parentUrl);
  const run=await verified({modules:{
    'leaf.mjs':leaf,
    'parent.mjs':"import {n,step} from './leaf.mjs';"+
      'export function run(x){step();return n*x;}'
  },entryModule:'parent.mjs',exportName:'run',args:[4]});
  assert.equal(run.result,oracle.run(4));
});

test('expression default exports and value exports evaluate once',async()=>{
  const modules={
    'base.js':'export const num=4;',
    'main.js':"import {num} from './base.js';export default num*3;"
  };
  const run=await verified({modules,entryModule:'main.js'});
  assert.equal(run.result,12);
});

test('module linker rejects cycles, unknown dependencies, and native packages',()=>{
  const requests=[
    {modules:{'a.js':"import {x} from './b.js';export const y=x;",
      'b.js':"import {y} from './a.js';export const x=y;"},entryModule:'a.js',exportName:'y'},
    {modules:{'a.js':"import {x} from './missing.js';export const y=x;"},entryModule:'a.js',exportName:'y'},
    {modules:{'a.js':"import fs from 'node:fs';export default fs;"},entryModule:'a.js'},
    {modules:{'a.js':"export * as ns from './b.js';",
      'b.js':'export const x=1;'},entryModule:'a.js'}
  ];
  for(const request of requests)
    assert.throws(()=>linkEvaluatedModules(request),/Unsupported evaluated-module|SyntaxError/);
});

test('imports are read-only and unknown named exports fail at link time',()=>{
  const invalid=[
    {modules:{'a.js':"export let x=2;",
      'b.js':"import {x} from './a.js';export function run(){x=3;return x;}"},
      entryModule:'b.js',exportName:'run'},
    {modules:{'a.js':'export const x=3;',
      'b.js':"import {missing} from './a.js';export function run(){return 1;}"},
      entryModule:'b.js',exportName:'run'}
  ];
  for(const request of invalid)
    assert.throws(()=>linkEvaluatedModules(request),/Unsupported evaluated-module/);
});

test('module namespace objects and exotic syntax do not silently delegate to Node',()=>{
  const invalid=[
    {modules:{'a.js':'export const x=3;',
      'b.js':"import * as ns from './a.js';export function run(){return ns.x;}"},
      entryModule:'b.js',exportName:'run'},
    {modules:{'a.js':"export class C {}"},entryModule:'a.js',exportName:'C'},
    {modules:{'a.js':"export function * f(){yield 1;}"},entryModule:'a.js',exportName:'f'}
  ];
  for(const request of invalid)
    assert.throws(()=>linkEvaluatedModules(request),/Unsupported evaluated-module/);
});
