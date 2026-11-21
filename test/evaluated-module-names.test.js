import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {executeEvaluatedModules} from '../src/evaluated-modules.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

async function differential(body,scheduled){
  const modules={
    ...(scheduled?{'sibling.js':'await 0;'}:{}),
    'leaf.js':'export const seed=7;',
    'main.js':(scheduled?"import './sibling.js';":'')+
      "import {seed} from './leaf.js';"+body
  };
  const directory=await mkdtemp(join(tmpdir(),'owned-module-names-'));
  try{
    await writeFile(join(directory,'package.json'),'{"type":"module"}');
    for(const [file,source] of Object.entries(modules))await writeFile(join(directory,file),source);
    const {run}=await import(pathToFileURL(join(directory,'main.js')).href);
    const expected=await run();
    const owned=await executeEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
    assert.deepEqual(owned.result,expected);
    assert.equal(owned.metadata.evaluationStrategy,scheduled?
      'async-dependency-scheduler':'dependency-concatenation');
    assert.equal(validateBundle(owned.bundle).valid,true);
    assert.equal(replayExact(owned.bundle).valid,true);
    return owned;
  }finally{await rm(directory,{recursive:true,force:true});}
}

test('renamed module bindings retain anonymous class and generator names during initialization',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential(`
      export const C=class {static observed=this.name;static value=seed;};
      let G=function*(){yield seed;};
      var Other=class {static observed=this.name;};
      const Named=class Original {static observed=this.name;};
      const __proto__=class {static observed=this.name;};
      export function run(){return [C.name,C.observed,C.value,G.name,G().next().value,
        Other.name,Other.observed,Named.name,Named.observed,__proto__.name,__proto__.observed];}`,scheduled);
    assert.deepEqual(owned.result,['C','C',7,'G',7,'Other','Other','Original','Original',
      '__proto__','__proto__']);
  }
});

test('anonymous assignment names use original module names and preserve outer lexical reads',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential(`
      let C;let G;const Object=19;
      export function run(){
        C=class {static observed=this.name;static before=C;};
        G=function*(){yield Object;};
        return [C.name,C.observed,C.before,G.name,G().next().value];}`,scheduled);
    assert.deepEqual(owned.result,['C','C',undefined,'G',19]);
  }
});

test('name inference does not manufacture an inner binding for an anonymous class',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential(`
      let observed;
      try{const C=class {static value=C;};}catch(error){observed=error.name;}
      const C=class {static read(){return C;}};
      export function run(){return [observed,C.name,C.read()===C];}`,scheduled);
    assert.deepEqual(owned.result,['ReferenceError','C',true]);
  }
});

test('module assignment defaults keep source names when creating anonymous definitions',async()=>{
  for(const scheduled of [false,true]){
    const owned=await differential(`
      let C;let G;
      export function run(){
        [C=class {static observed=this.name;}]=[];
        ({value:G=function*(){yield seed;}}={});
        return [C.name,C.observed,G.name,G().next().value];}`,scheduled);
    assert.deepEqual(owned.result,['C','C','G',7]);
  }
});
