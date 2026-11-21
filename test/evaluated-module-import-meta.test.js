import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {linkEvaluatedModules,executeEvaluatedModules}
  from '../src/evaluated-modules.js';
import {createBoundedRetainedModuleSession,
  restoreBoundedRetainedModuleSession} from '../src/evaluated-module-session.js';

const modulesFor=scheduled=>({
  'a.js':`export function touch(){
    const meta=import.meta;
    meta.count=(meta.count??0)+1;
    return [meta===import.meta,Object.getPrototypeOf(meta)===null,
      Object.keys(meta).length,meta.count];
  }`,
  'b.js':`export function touch(){
    const meta=import.meta;
    meta.count=(meta.count??0)+1;
    return [meta===import.meta,Object.getPrototypeOf(meta)===null,
      Object.keys(meta).length,meta.count];
  }`,
  ...(scheduled?{'async.js':'await 0;'}:{}),
  'main.js':`${scheduled?"import './async.js';":''}
    import {touch as touchA} from './a.js';
    import {touch as touchB} from './b.js';
    export function a(){return touchA();}
    export function b(){return touchB();}`
});

async function originalVmRun(modules,calls){
  const source=`
    import vm from 'node:vm';
    import path from 'node:path';
    let input='';
    for await (const part of process.stdin) input+=part;
    const {modules:sources,calls}=JSON.parse(input);
    const context=vm.createContext({});
    const records=new Map(Object.entries(sources).map(([file,text])=>
      [file,new vm.SourceTextModule(text,{context,identifier:file})]));
    const entry=records.get('main.js');
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
      out.push(await entry.namespace[call.exportName]());
    process.stdout.write(JSON.stringify(out));
  `;
  const result=spawnSync(process.execPath,
    ['--no-warnings','--experimental-vm-modules','--input-type=module','-e',source],
    {input:JSON.stringify({modules,calls}),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

const calls=[{exportName:'a',args:[]},{exportName:'b',args:[]},
  {exportName:'a',args:[]}];
const expected=[[true,true,1,1],[true,true,1,1],[true,true,1,2]];

test('modules without import.meta do not receive synthetic metadata allocations',()=>{
  const linked=linkEvaluatedModules({modules:{
    'main.js':'export function run(){return 1;}'
  },entryModule:'main.js',exportName:'run'});
  assert.equal(linked.source.includes('__traced_eval_import_meta_'),false);
});

test('import.meta is stable, module-local and mutable in both evaluation strategies',async()=>{
  for(const scheduled of [false,true]){
    const modules=modulesFor(scheduled);
    const native=await originalVmRun(modules,calls);
    assert.deepEqual(native,expected);
    const owned=await executeEvaluatedModules({modules,entryModule:'main.js',calls});
    assert.deepEqual(owned.result,native);
    assert.equal(owned.metadata.importMetaPolicy,'empty-null-prototype');
    assert.equal(owned.metadata.evaluationStrategy,scheduled?
      'async-dependency-scheduler':'dependency-concatenation');
  }
});

test('import.meta mutations survive retained calls and JSON history restoration',async()=>{
  const modules=modulesFor(false);
  const session=createBoundedRetainedModuleSession({modules,entryModule:'main.js'});
  let restored;
  try{
    assert.deepEqual((await session.invoke('a')).result,[true,true,1,1]);
    assert.deepEqual((await session.invoke('b')).result,[true,true,1,1]);
    assert.deepEqual((await session.invoke('a')).result,[true,true,1,2]);
    const snapshot=JSON.parse(JSON.stringify(session.snapshot()));
    restored=await restoreBoundedRetainedModuleSession(snapshot);
    assert.deepEqual((await restored.invoke('a')).result,[true,true,1,3]);
    assert.deepEqual(await originalVmRun(modules,[...calls,{exportName:'a',args:[]}]),[
      [true,true,1,1],[true,true,1,1],[true,true,1,2],[true,true,1,3]
    ]);
  }finally{
    session.close();
    restored?.close();
  }
});
