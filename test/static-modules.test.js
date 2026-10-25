import test from 'node:test';
import assert from 'node:assert/strict';
import {executeStaticModule,linkStaticModules} from 'tracing-js-self/modules';
import {validateBundle,replayExact} from 'tracing-js-self';
import {verifyTrainingCase} from 'tracing-js-self/training/diagnostic';

test('TypeScript static imports and aliased exports link as owned JS',()=>{
  const modules={
    'helper.ts':'export function increment(x: number): number { return x + 1; }',
    'main.ts':`import {increment as plusOne} from './helper.ts';
      export function twice(x: number): number { return plusOne(x) * 2; }`
  };
  const request={modules,entryModule:'main.ts',exportName:'twice',args:[4]};
  const run=executeStaticModule(request);
  assert.equal(run.result,10);
  assert.equal(run.metadata.links.length,1);
  assert.deepEqual(run.metadata.modules.map(m=>m.file),['helper.ts','main.ts']);
  assert.equal(run.metadata.modules[0].sourceMap.version,3);
  assert.equal(validateBundle(run.bundle).valid,true);
  assert.equal(replayExact(run.bundle).valid,true);
  const compiled=linkStaticModules(request);
  assert.equal(verifyTrainingCase({source:compiled.source,
    entry:compiled.entryFunction,args:[4]}).status,'locally_verified');
});

test('linked pure ESM function calls agree with the native V8 module loader',async()=>{
  const helper='export function plus(x){return x+2;}';
  const top=`import {plus as step} from './helper.mjs';
      export function run(x){return step(x)*3;}`;
  const run=executeStaticModule({modules:{
    'pkg/helper.mjs':helper,'pkg/main.mjs':top},
    entryModule:'pkg/main.mjs',exportName:'run',args:[5]});
  const helperURL='data:text/javascript;charset=utf-8,'+encodeURIComponent(helper);
  const nativeSource='import {plus as step} from '+
    JSON.stringify(helperURL)+'; export function run(x){return step(x)*3;}';
  const nativeURL='data:text/javascript;charset=utf-8,'+encodeURIComponent(nativeSource);
  const oracle=await import(nativeURL);
  assert.equal(run.result,oracle.run(5));
  assert.equal(run.result,21);
});

test('function-only cycles and export aliases resolve by lexical identity',()=>{
  const modules={
    'a.js':`import {odd} from './b.js';
      export function even(n){return n===0?true:odd(n-1);}`,
    'b.js':`import {even} from './a.js';
      function odd(n){return n===0?false:even(n-1);}
      export {odd as odd};`
  };
  const run=executeStaticModule({
    modules,entryModule:'a.js',exportName:'even',args:[8]
  });
  assert.equal(run.result,true);
  assert.equal(replayExact(run.bundle).valid,true);
  assert.equal(run.metadata.modules.length,2);
});

test('dynamic imports, side effects and unknown packages fail before guest execution',()=>{
  const invalid=[
    {'main.js':`import 'node:fs'; export function f(){return 1;}`},
    {'main.js':`export const x=3; export function f(){return x;}`},
    {'main.js':`import {x} from 'missing'; export function f(){return x();}`},
    {'main.js':`export function f(){return import('./other.js');}`},
    {'main.js':`export default ()=>3;`},
    {'main.js':`export * from './other.js';`},
    {'main.js':`import {x} from './helper.js';
      export function f(){x=3;return x;}`,
      'helper.js':'export function x(){return 1;}'}
  ];
  for(const modules of invalid)assert.throws(()=>
    executeStaticModule({modules,entryModule:'main.js',exportName:'f'}),
    /Unsupported|unbound|entry|module|training-js/);
});

test('unreachable module source never enters the executable guest bundle',()=>{
  const linked=linkStaticModules({modules:{
    'main.js':'export function f(){return 3;}',
    'private.js':'export function secret(){return 928374;}'
  },entryModule:'main.js',exportName:'f'});
  assert(!linked.source.includes('928374'));
  assert(!JSON.stringify(linked.metadata).includes('928374'));
});

test('function-only named re-exports link through multiple TS modules and match native ESM',async()=>{
  const base='export function bump(x: number){return x+1;}';
  const barrel="export {bump as step} from './base.ts';";
  const main="import {step as next} from './barrel.ts'; export function run(x: number){return next(x)*3;}";
  const modules={'base.ts':base,'barrel.ts':barrel,'main.ts':main};
  const traced=executeStaticModule({modules,entryModule:'main.ts',exportName:'run',args:[4]});
  assert.equal(traced.result,15);
  assert.equal(validateBundle(traced.bundle).valid,true);
  assert.equal(replayExact(traced.bundle).valid,true);
  assert(traced.metadata.links.some(link=>link.kind==='reexport'&&link.exported==='step'));
  const baseURL='data:text/javascript,'+encodeURIComponent('export function bump(x){return x+1;}');
  const barrelURL='data:text/javascript,'+encodeURIComponent(
    'export {bump as step} from '+JSON.stringify(baseURL)+';');
  const mainURL='data:text/javascript,'+encodeURIComponent(
    'import {step as next} from '+JSON.stringify(barrelURL)+
    '; export function run(x){return next(x)*3;}');
  assert.equal(traced.result,(await import(mainURL)).run(4));
});

test('star re-exports resolve same-origin diamonds and cycles but not default',()=>{
  const modules={
    'a.js':"export function inc(n){return n+1;}",
    'left.js':"export * from './a.js';",
    'right.js':"export {inc} from './a.js';",
    'barrel.js':"export * from './left.js'; export * from './right.js';",
    'loop.js':"export * from './barrel.js'; export * from './loop.js';",
    'main.js':"import {inc} from './loop.js'; export function run(n){return inc(n)*2;}"
  };
  const run=executeStaticModule({modules,entryModule:'main.js',exportName:'run',args:[7]});
  assert.equal(run.result,16);
  assert.equal(replayExact(run.bundle).valid,true);
  assert.equal(run.metadata.modules.length,6);
  const defaults={
    'base.js':'export default function hidden(){return 1;}',
    'barrel.js':"export * from './base.js';"
  };
  assert.throws(()=>linkStaticModules({modules:defaults,entryModule:'barrel.js'}),
    /unresolved export/);
});

test('ambiguous and invalid source re-exports fail closed before execution',()=>{
  const bad=[
    {
      'a.js':'export function f(){return 1;}',
      'b.js':'export function f(){return 2;}',
      'barrel.js':"export * from './a.js'; export * from './b.js';",
      'main.js':"import {f} from './barrel.js'; export function run(){return f();}"
    },
    {
      'a.js':'export function other(){return 1;}',
      'barrel.js':"export {missing} from './a.js';",
      'main.js':"import {missing} from './barrel.js'; export function run(){return missing();}"
    },
    {
      'a.js':'export function f(){return 1;}',
      'barrel.js':"export * as ns from './a.js'; export function run(){return 1;}"
    },
    {
      'a.js':'export function f(){return 1;}',
      'barrel.js':"export {f as foo} from './a.js'; export {f as foo} from './a.js';"
    }
  ];
  for(const modules of bad){
    const entryModule=Object.hasOwn(modules,'main.js')?'main.js':'barrel.js';
    assert.throws(()=>linkStaticModules({modules,entryModule,exportName:'run'}),
      error=>error instanceof SyntaxError &&
        /Unsupported static-module\/1|Duplicate export/.test(error.message));
  }
});

test('linked imported function shorthand retains the original property key',()=>{
  const modules={
    'base.js':'export function plusOne(x){return x+1;}',
    'main.js':"import {plusOne as hop} from './base.js'; "+
      "export function run(){const cell={hop}; return cell.hop===hop;}"
  };
  const traced=executeStaticModule({modules,entryModule:'main.js',exportName:'run'});
  assert.equal(traced.result,true);
  assert.equal(replayExact(traced.bundle).valid,true);
  const linked=linkStaticModules({modules,entryModule:'main.js',exportName:'run'});
  assert.match(linked.source,/\{\s*hop:\s*__traced_m\d+_plusOne\s*\}/);
});
