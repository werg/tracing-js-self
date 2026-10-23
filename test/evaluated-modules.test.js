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

test('diamond dependencies initialize once, with two distinct module side effects',async()=>{
  const modules={
    'state.js':'export let n=0;export function next(){n+=1;}',
    'left.js':"import {next} from './state.js';next();",
    'right.js':"import {next} from './state.js';next();",
    'main.js':"import './left.js';import './right.js';import {n} from './state.js';"+
      'export function run(){return n;}'
  };
  const run=await verified({modules,entryModule:'main.js',exportName:'run'});
  assert.equal(run.result,2);
  assert.deepEqual(run.metadata.evaluationOrder,
    ['state.js','left.js','right.js','main.js']);
  const initialized=run.metadata.instantiationAndEvaluation.filter(x=>x.file==='state.js'&&x.kind==='evaluate');
  assert.equal(initialized.length,1);
});

test('native input arrival can be out of await order during ESM evaluation',async()=>{
  let invocations=0;
  const modules={
    'data.js':"const a=host.readAsync('slow');const b=host.readAsync('fast');"+
      'export const n=await a+await b;',
    'main.js':"import {n} from './data.js';export function run(){return n;}"
  };
  const run=await verified({modules,entryModule:'main.js',exportName:'run',
    services:{'demo.readAsync':({args})=>{
      invocations++;
      return args[0]==='slow'?
        new Promise(resolve=>setTimeout(()=>resolve(10),15)):
        Promise.resolve(20);
    }}});
  assert.equal(run.result,30);
  assert.equal(invocations,2);
  const effects=Object.values(run.bundle.effects).filter(f=>f.operation==='demo.readAsync');
  const arrivals=run.bundle.events.filter(e=>e.operation==='external.input.arrive');
  assert.equal(arrivals.length,2);
  assert.equal(arrivals[0].causes.find(c=>c.kind==='effect').effectId,effects[1].id);
  replayExact(run.bundle);
  assert.equal(invocations,2);
});

test('linker preflights unsupported guest syntax even when its function is never invoked',()=>{
  assert.throws(()=>linkEvaluatedModules({
    modules:{'main.js':'export function run(){return 4;}'+
      'export function unused(){return new Date(0);}'},
    entryModule:'main.js',exportName:'run'
  }),/Unsupported evaluated-module.*unowned generated guest syntax/);
});

test('unreferenced invalid forwarding exports still fail module instantiation',()=>{
  assert.throws(()=>linkEvaluatedModules({
    modules:{
      'src.js':'export const existing=2;',
      'barrel.js':"export {missing} from './src.js';",
      'main.js':"import './barrel.js';export function run(){return 3;}"
    },
    entryModule:'main.js',exportName:'run'
  }),/Unsupported evaluated-module.*unresolved export/);
});

test('module graph excludes unreachable private code and requires all runtime imports',()=>{
  const linked=linkEvaluatedModules({modules:{
    'main.js':'export const result=1;',
    'unreachable.js':'export const secret=928374;'
  },entryModule:'main.js',exportName:'result'});
  assert(!linked.source.includes('928374'));
  assert(!JSON.stringify(linked.metadata).includes('928374'));
  assert.throws(()=>linkEvaluatedModules({modules:{
    'main.js':"import {missing} from './base.js';export function run(){return 2;}",
    'base.js':'export const available=1;'
  },entryModule:'main.js',exportName:'run'}),/Unsupported evaluated-module.*unresolved export/);
});

test('module source collection never invokes host getters or proxy traps',()=>{
  let reads=0;
  const withGetter={};
  Object.defineProperty(withGetter,'main.js',{enumerable:true,get(){
    reads++;
    throw new Error('must never call a module getter');
  }});
  assert.throws(()=>linkEvaluatedModules({
    modules:withGetter,entryModule:'main.js',exportName:'run'
  }),/Module source entries must be string-keyed own data/);
  assert.equal(reads,0);
  const proxied=new Proxy({'main.js':'export const value=3;'},{
    ownKeys(){reads++;throw new Error('must never enumerate proxy');}
  });
  assert.throws(()=>linkEvaluatedModules({
    modules:proxied,entryModule:'main.js',exportName:'value'
  }),/plain data object/);
  assert.equal(reads,0);
});

test('star re-exports resolve live bindings through same-origin diamonds',async()=>{
  const modules={
    'leaf.js':'export let v=2;export function tick(){v+=1;}',
    'left.js':"export * from './leaf.js';",
    'right.js':"export {v,tick} from './leaf.js';",
    'barrel.js':"export * from './left.js';export * from './right.js';",
    'main.js':"import {v,tick} from './barrel.js';"+
      'export function run(){tick();return v;}'
  };
  const run=await verified({modules,entryModule:'main.js',exportName:'run'});
  assert.equal(run.result,3);
});

test('ambiguous distinct star binding origins fail without executing module effects',()=>{
  const modules={
    'a.js':'export const value=1;',
    'b.js':'export const value=2;',
    'barrel.js':"export * from './a.js';export * from './b.js';",
    'main.js':"import {value} from './barrel.js';export function run(){return value;}"
  };
  assert.throws(()=>linkEvaluatedModules({
    modules,entryModule:'main.js',exportName:'run'
  }),/ambiguous export/);
});

test('top-level module throw rejects the owned entry and prevents dependent initialization',async()=>{
  const modules={
    'bad.js':"throw 'dependency-failed';",
    'main.js':"import './bad.js';export function run(){return 5;}"
  };
  assert.deepEqual(linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'})
    .metadata.evaluationOrder,['bad.js','main.js']);
  await assert.rejects(executeEvaluatedModules({
    modules,entryModule:'main.js',exportName:'run'
  }),/Owned module evaluation rejected: dependency-failed/);
});

test('top-level block await and synchronous native service preserve module completion',async()=>{
  const first=await verified({modules:{
    'base.js':'export let n=2;if(true){n+=await Promise.resolve(3);}',
    'main.js':"import {n} from './base.js';export function run(){return n;}"
  },entryModule:'main.js',exportName:'run'});
  assert.equal(first.result,5);
  const second=await verified({modules:{
    'base.js':"export const n=host.readNumber('k');",
    'main.js':"import {n} from './base.js';export function run(){return n*2;}"
  },entryModule:'main.js',exportName:'run',
  services:{'demo.readNumber':()=>8}});
  assert.equal(second.result,16);
  assert.equal(second.bundle.events.filter(e=>e.operation==='external.input.deliver').length,1);
});

test('TypeScript mutable imports update through owned lexical cells',async()=>{
  const run=await verified({modules:{
    'counter.ts':'export let n: number=2;export function update():void{n+=3;}',
    'main.ts':"import {n,update} from './counter.ts';"+
      'export function run():number{update();return n;}'
  },entryModule:'main.ts',exportName:'run'});
  assert.equal(run.result,5);
  assert.equal(run.metadata.modules[0].sourceMap.version,3);
});

test('one evaluated module episode retains mutable binding state across exported calls',async()=>{
  const modules={
    'state.js':`export let n=0;
      export function next(){n+=1;return n;}
      export function snapshot(){return n;}`
  };
  const calls=[
    {exportName:'next',args:[]},
    {exportName:'next',args:[]},
    {exportName:'snapshot',args:[]}
  ];
  const linked=linkEvaluatedModules({
    modules,entryModule:'state.js',calls
  });
  assert.equal(linked.metadata.calls.length,3);
  assert.deepEqual(linked.metadata.calls.map(x=>x.exportName),
    ['next','next','snapshot']);
  const run=await verified({modules,entryModule:'state.js',calls});
  assert.deepEqual(run.result,[1,2,2]);
  assert.equal(run.bundle.sources.length,1);
  assert.deepEqual(run.metadata.evaluationOrder,['state.js']);
});

test('module batch keeps exported object aliases and awaited call order',async()=>{
  const shared={n:1};
  const modules={
    'main.js':`export function update(o){o.n+=2;return o;}
      export async function read(o){await Promise.resolve(0);return o.n;}`
  };
  const run=await verified({modules,entryModule:'main.js',calls:[
    {exportName:'update',args:[shared]},
    {exportName:'read',args:[shared]},
    {exportName:'update',args:[shared]}
  ]});
  assert.deepEqual(run.result,[{n:5},5,{n:5}]);
  assert.equal(run.result[0],run.result[2]);
  assert.equal(shared.n,1,'entry object is an imported owned snapshot');
});

test('invalid module batch entries fail closed at link time',()=>{
  const modules={'main.js':'export const x=1;export function run(){return x;}'};
  for(const calls of [
    [],[{exportName:'missing',args:[]}],
    [{exportName:'x',args:[1]}],
    [{exportName:'run',args:null}],
    [{exportName:'run'}]
  ])assert.throws(()=>linkEvaluatedModules({
    modules,entryModule:'main.js',calls
  }),/Unsupported evaluated-module|TypeError|Calls must be/);
});

test('module batch arguments never execute host getters or Proxy traps',()=>{
  let touches=0;
  const modules={'main.js':'export function run(x){return x;}'};
  const args=[1];
  Object.defineProperty(args,'0',{configurable:true,enumerable:true,get(){
    touches++;throw new Error('argument getter ran');
  }});
  assert.throws(()=>linkEvaluatedModules({
    modules,entryModule:'main.js',exportName:'run',args
  }),/dense own data elements/);
  const calls=[{exportName:'run',args:[2]}];
  Object.defineProperty(calls,'0',{configurable:true,enumerable:true,get(){
    touches++;throw new Error('batch getter ran');
  }});
  assert.throws(()=>linkEvaluatedModules({
    modules,entryModule:'main.js',calls
  }),/dense own data elements/);
  const proxiedCalls=new Proxy([{exportName:'run',args:[]}],{
    get(){touches++;throw new Error('proxy get trap');}
  });
  assert.throws(()=>linkEvaluatedModules({
    modules,entryModule:'main.js',calls:proxiedCalls
  }),/bounded ordinary data array/);
  assert.equal(touches,0);
});
