import test from 'node:test';
import assert from 'node:assert/strict';
import {executeStaticModule,linkStaticModules} from 'tracing-js-self/modules';
import {validateBundle,replayExact} from 'tracing-js-self';

test('side-effect-only import of pure function graph links without executing host JS',async()=>{
  const modules={
    'unused.js':"export function never(){throw new Error('not called');}",
    'main.js':"import './unused.js'; export function run(x){return x+1;}"
  };
  const run=executeStaticModule({modules,entryModule:'main.js',exportName:'run',args:[3]});
  assert.equal(run.result,4);
  assert.deepEqual(run.metadata.modules.map(m=>m.file),['main.js','unused.js']);
  assert(run.metadata.links.some(l=>l.kind==='inert-dependency'));
  assert(validateBundle(run.bundle).valid);
  assert(replayExact(run.bundle).valid);
  const dep='data:text/javascript,'+encodeURIComponent(modules['unused.js']);
  const native='data:text/javascript,'+encodeURIComponent(
    "import "+JSON.stringify(dep)+"; export function run(x){return x+1;}");
  assert.equal(run.result,(await import(native)).run(3));
});

test('TypeScript-elided unused value imports and empty source reexports remain validated',()=>{
  const modules={
    'extra.ts':'export function unused(){return 100;}',
    'main.ts':"import {unused} from './extra.ts'; export function run(){return 7;}",
    'barrel.ts':"export {} from './extra.ts'; export function run(){return 8;}"
  };
  for(const file of ['main.ts','barrel.ts']){
    const linked=linkStaticModules({modules,entryModule:file,exportName:'run'});
    assert(linked.metadata.modules.some(m=>m.file==='extra.ts'),file);
    const result=executeStaticModule({modules,entryModule:file,exportName:'run'});
    assert.equal(result.result,file==='main.ts'?7:8);
    assert.equal(replayExact(result.bundle).valid,true);
  }
});

test('a TS-elided value import cannot hide an unsupported side-effect module',()=>{
  const modules={
    'bad.ts':"globalThis.escape=1;",
    'main.ts':"import {unused} from './bad.ts'; export function run(){return 1;}",
    'barrel.ts':"export {} from './bad.ts'; export function run(){return 2;}"
  };
  for(const entryModule of ['main.ts','barrel.ts'])
    assert.throws(()=>linkStaticModules({modules,entryModule,exportName:'run'}),
      /Unsupported static-module\/1/);
});

test('type-only TypeScript dependencies do not turn into guest runtime imports',()=>{
  const linked=linkStaticModules({modules:{
    'main.ts':"import type {MissingType} from './unprovided.ts'; export function run(){return 6;}"
  },entryModule:'main.ts',exportName:'run'});
  assert.equal(linked.metadata.modules.length,1);
});
