import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
const read=(r,k)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([key])=>key===k)?.[1]?.token?.value;
function check(source){
 const r=createRuntime().start(source);assert.equal(r.drive().kind,'terminated');
 const b=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(b).valid,true);assert.equal(replayExact(b).valid,true);
 return {r,b};
}
test('thenable runs after synchronous code with original receiver',()=>{
 const {r,b}=check(`let order='';
 let t={value:42,then:function(resolve,reject){order+='t';resolve(this.value);reject(9);}};
 let p=Promise.resolve(t);order+='s';p.then(function(x){order+=x;});`);
 assert.deepEqual(read(r,'order'),['str','st42']);
 assert.equal(b.events.some(e=>e.operation==='job.enter'&&
   e.causes.some(c=>c.kind==='promise')&&e.causes.some(c=>c.kind==='invocation')),true);
});
test('executor resolver assimilates thenable adopting another promise',()=>{
 const {r}=check(`let out=0;
 let t={then:function(resolve){resolve(Promise.resolve(6));}};
 new Promise(function(resolve){resolve(t);}).then(function(x){out+=x;});`);
 assert.deepEqual(read(r,'out'),['num',6]);
});
test('thenable callback throw rejects promise',()=>{
 const {r}=check(`let out=0;
 Promise.resolve({then:function(resolve){throw 5;}}).catch(function(x){out+=x;});`);
 assert.deepEqual(read(r,'out'),['num',5]);
});
test('forged queued thenable fails independent reconstruction',()=>{
 const {b}=check(`Promise.resolve({then:function(resolve){resolve(2);}});`);
 const e=b.events.find(e=>e.operation==='job.enter');
 assert(e);e.causes[0].promiseId='p999';assert.throws(()=>validateBundle(b));
});
