import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
const read=(r,k)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([name])=>name===k)?.[1]?.token?.value;
function check(source){
 const r=createRuntime().start(source);
 assert.equal(r.drive().kind,'terminated');
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(bundle).valid,true);
 assert.equal(replayExact(bundle).valid,true);
 return {r,bundle};
}
test('Promise.withResolvers first settlement wins after synchronous code',()=>{
 const {r}=check(`let order='';
 let c=Promise.withResolvers();c.promise.then(function(v){order+=v;});
 c.resolve(3);c.reject(8);order+='s';`);
 assert.deepEqual(read(r,'order'),['str','s3']);
});
test('Promise.withResolvers assimilates thenables on FIFO jobs',()=>{
 const {r,bundle}=check(`let order='';
 let c=Promise.withResolvers();
 c.resolve({then:function(resolve){order+='a';resolve(5);}});
 order+='b';c.promise.then(function(v){order+=v;});`);
 assert.deepEqual(read(r,'order'),['str','ba5']);
 assert.equal(bundle.events.filter(e=>e.operation==='job.enter').length,2);
});
test('Promise.withResolvers resolution can be deferred to virtual timer',()=>{
 const {r}=check(`let result=0;
 let c=Promise.withResolvers();function done(){c.resolve(7);}
 setTimeout(done,1);c.promise.then(function(v){result=v;});`);
 assert.deepEqual(read(r,'result'),['num',7]);
});
test('Promise.withResolvers returns own callable resolve and reject properties',()=>{
 const {r}=check(`let c=Promise.withResolvers();
 let out=typeof c.resolve+'-'+typeof c.reject+'-'+typeof c.promise;c.resolve(0);`);
 assert.deepEqual(read(r,'out'),['str','function-function-object']);
});
