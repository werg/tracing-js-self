import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
const read=(r,k)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
 .find(([key])=>key===k)?.[1]?.token?.value;
function drive(source,kind='terminated'){
 const r=createRuntime().start(source);assert.equal(r.drive().kind,kind);
 const b=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(b).valid,true);assert.equal(replayExact(b).valid,true);
 return r;
}
test('async Promise constructor executor resumes after await without adoption',()=>{
 const r=drive(`let out='';
 let p=new Promise(async function(resolve){out+='a';await Promise.resolve(0);out+='b';resolve(7);});
 p.then(function(v){out+=v;});out+='c';`);
 assert.deepEqual(read(r,'out'),['str','acb7']);
});
test('async executor throw rejects its ignored returned promise, not constructed Promise',()=>{
 const r=drive(`let out=0;
 new Promise(async function(resolve){resolve(9);throw 3;})
 .then(function(v){out=v;});`);
 assert.deepEqual(read(r,'out'),['num',9]);
});
test('async executor return alone does not settle the constructed promise',()=>{
 const r=drive(`let out=0;
 new Promise(async function(resolve){return 9;}).then(function(v){out=v;});`,'waiting');
 assert.deepEqual(read(r,'out'),['num',0]);
});
