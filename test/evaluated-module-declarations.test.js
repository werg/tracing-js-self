import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {executeEvaluatedModules} from '../src/evaluated-modules.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

async function differential(original,scheduled,{exportName='run',args=[]}={}){
  const modules=scheduled?{...original,'sibling.js':'await 0;','padding.js':'export const marker=0;',
    'main.js':"import './sibling.js';import './padding.js';"+original['main.js']}:original;
  const directory=await mkdtemp(join(tmpdir(),'owned-module-declarations-'));
  try{
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    for(const [file,source] of Object.entries(modules))await writeFile(join(directory,file),source);
    const namespace=await import(pathToFileURL(join(directory,'main.js')).href);
    const expected=await namespace[exportName](...args);
    const owned=await executeEvaluatedModules({modules,entryModule:'main.js',exportName,args});
    assert.deepEqual(owned.result,expected);
    assert.equal(owned.metadata.evaluationStrategy,scheduled?
      'async-dependency-scheduler':'dependency-concatenation');
    assert.equal(validateBundle(owned.bundle).valid,true);
    assert.equal(replayExact(owned.bundle).valid,true);
    return owned;
  }finally{await rm(directory,{recursive:true,force:true});}
}

test('module class declarations retain names, imported heritage, private fields and inner class identity',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential({
      'base.js':'export class Base{constructor(value){this.value=value;}read(){return this.value;}}',
      'main.js':`import {Base} from './base.js';
        export class Child extends Base{
          #extra=3;static observed=this.name;
          read(){return super.read()+this.#extra;}
          static self(){return Child;}
        }
        const original=Child;Child=17;
        export function run(){const instance=new original(4);
          return [original.name,original.observed,instance.read(),original.self()===original,Child];}`
    },scheduled);
    assert.deepEqual(owned.result,['Child','Child',7,true,17]);
  }
});

test('class declarations remain in TDZ during cyclic module evaluation and initialize once',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential({
      'main.js':`import {early,read} from './peer.js';
        export class C{static value=11;}
        export function run(){return [early,read()===C,C.value];}`,
      'peer.js':`import {C} from './main.js';let early;
        try{early=typeof C;}catch(error){early=error.name;}
        export {early};export function read(){return C;}`
    },scheduled);
    assert.deepEqual(owned.result,['ReferenceError',true,11]);
  }
});

test('generator declarations are instantiated before cyclic evaluation and keep live mutable bindings',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential({
      'main.js':`import {early} from './peer.js';export let value=9;
        export function* sequence(){yield value;return 12;}
        export function* before(){yield 5;}
        export function run(){const iterator=sequence();const name=sequence.name;
          const first=iterator.next();value=13;const last=iterator.next();
          return [early,name,first.value,first.done,last.value,last.done];}`,
      'peer.js':`import {before} from './main.js';export const early=before().next().value;`
    },scheduled);
    assert.deepEqual(owned.result,[5,'sequence',9,false,12,true]);
  }
});

test('anonymous default function and generator declarations are hoisted with the default name',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential({
      'main.js':`import {early} from './peer.js';
        export default async /* preserved declaration comment */ function (value){return value+early;}
        export function run(){return early;}`,
      'peer.js':`import value from './generator.js';export const early=[value.name,value().next().value];`,
      'generator.js':`export default /* preserved declaration comment */ function* (){yield 6;}`
    },scheduled);
    assert.deepEqual(owned.result,['default',6]);
    const called=await differential({'main.js':'export default async function (value){await 0;return value+2;}'},
      scheduled,{exportName:'default',args:[5]});
    assert.equal(called.result,7);
  }
});

test('named and anonymous default class declarations preserve static names and lexical bindings',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential({
      'anonymous.js':`export default class {static observed=this.name;static value=3;}`,
      'named.js':`export default class Named{static observed=this.name;static value=4;}
        export function read(){return Named;}`,
      'main.js':`import Anonymous from './anonymous.js';import Named,{read} from './named.js';
        export function run(){return [Anonymous.name,Anonymous.observed,Anonymous.value,
          Named.name,Named.observed,Named.value,read()===Named];}`
    },scheduled);
    assert.deepEqual(owned.result,['default','default',3,'Named','Named',4,true]);
  }
});

test('destructured module declarations retain source keys, inferred names, live cells and module var isolation',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential({
      'leaf.js':`export let {x=2,other:y=3}={x:7};
        export const [first,,last]=[4,5,6];
        export const {Ctor=class {static observed=this.name;}}={};
        export const {generator=function*(){yield x;}}={};
        {var {shared}= {shared:13};}
        export function bump(){x+=1;y+=2;}
        export function read(){return shared;}`,
      'main.js':`import {x,y,first,last,Ctor,generator,bump,read} from './leaf.js';
        const before=shared;{var [shared]=[19];}
        export function run(){bump();return [x,y,first,last,Ctor.name,Ctor.observed,
          generator.name,generator().next().value,before,shared,read()];}`
    },scheduled);
    assert.deepEqual(owned.result,[8,5,4,6,'Ctor','Ctor','generator',8,undefined,19,13]);
  }
});

test('shorthand destructuring assignment defaults read their original property before using a default',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential({'main.js':`
      let C;let count=0;function fallback(){count+=1;return 99;}
      export function run(){({C=fallback()}={C:17});return [C,count];}`},scheduled);
    assert.deepEqual(owned.result,[17,0]);
  }
});

test('class and generator environments restore from JSON while a module is suspended',async()=>{
  const owned=await differential({
    'leaf.js':`export class C{#value=9;read(){return this.#value;}}
      export function* sequence(){yield new C();yield 12;}`,
    'main.js':`import {C,sequence} from './leaf.js';const iterator=sequence();
      const first=iterator.next().value;await 0;
      export function run(){return [C.name,first.read(),iterator.next().value];}`
  },true);
  const {bundle}=owned;
  const runtime=createRuntime().startEntry({text:bundle.sources[0].text,
    functionName:bundle.entrySpec.functionName,args:[{args:[]}],allowAsync:true});
  let saved;
  for(let count=0;count<10000;count++){
    const control=runtime.state.control.a0,frame=runtime.state.frames[control.activeFrameId];
    const hasInstance=Object.values(runtime.state.heap).some(object=>Object.keys(object.privateSlots??{}).length);
    if(hasInstance&&frame?.status!=='running'){
      saved=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters'))));
      break;
    }
    if(frame?.status==='running')runtime.step();
    else if(control.queue.length)runtime.enterQueuedJob();
    else break;
  }
  assert(saved,'capture the module with a private instance and suspended generator');
  assert.equal(runtime.drive().kind,'terminated');
  const restored=Object.assign(createRuntime(),saved);
  assert.equal(restored.drive().kind,'terminated');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),JSON.parse(JSON.stringify(runtime.exportRun())));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
});
