import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {encode} from '../src/values.js';

const read=(r,key)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([k])=>k===key)?.[1]?.token?.value;
async function compare(source,key,expected){
 const r=createRuntime().start(source);
 assert.equal(r.drive().kind,'terminated');
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(bundle).valid,true);
 assert.equal(replayExact(bundle).valid,true);
 const ctx=vm.createContext({queueMicrotask});
 vm.runInContext(source,ctx);
 await new Promise(resolve=>setImmediate(resolve));
 const native=vm.runInContext(key,ctx);
 assert.deepEqual(read(r,key),encode(native));
 if(expected!==undefined)assert.deepEqual(read(r,key),encode(expected));
 return {r,bundle};
}

test('Promise executor and thenable adoption preserve guest microtask FIFO',async()=>{
 await compare(`let out='';
 let obj={value:7,then:function(resolve,reject){out+='t';resolve(this.value);reject(99);}};
 let p=new Promise(function(resolve,reject){out+='e';resolve(obj);reject(3);});
 p.then(function(v){out+=v;});
 queueMicrotask(function(){out+='m';});
 out+='s';`,'out','estm7');
});

test('thenable throw rejects only once and can be caught in owned handlers',async()=>{
 await compare(`let out=0;
 let first={then:function(resolve){throw 8;}};
 let second={then:function(resolve){resolve(9);throw 14;}};
 Promise.resolve(first).catch(function(v){out+=v;});
 Promise.resolve(second).then(function(v){out+=v;});`,'out',17);
});

test('nested thenable and Promise adoption also works for Promise.all',async()=>{
 await compare(`let out=0;
 let t={then:function(resolve){resolve(Promise.resolve(6));}};
 Promise.all([t,Promise.resolve(4)]).then(function(v){out=v[0]+v[1];});`,'out',10);
});

test('allSettled returns per-input outcomes and does not short circuit',async()=>{
 await compare(`let out='';
 Promise.allSettled([Promise.reject(3),Promise.resolve(4)]).then(function(v){
   out=v[0].status+v[0].reason+v[1].status+v[1].value;
 });`,'out','rejected3fulfilled4');
});

test('Promise.any takes first fulfillment and aggregates all rejected reasons',async()=>{
 await compare(`let out=0;
 Promise.any([Promise.reject(3),Promise.resolve(8)]).then(function(v){out+=v;});
 Promise.any([Promise.reject(4),Promise.reject(5)]).catch(function(e){
   out+=e.errors[0]+e.errors[1];
 });`,'out',17);
});

test('allSettled empty and any empty settle with expected shape',async()=>{
 await compare(`let out=0;
 Promise.allSettled([]).then(function(v){out+=v.length;});
 Promise.any([]).catch(function(e){out+=e.errors.length+1;});`,'out',1);
});

test('attempt to forge queued thenable function identity is rejected',async()=>{
 const {bundle}=await compare(`let t={then:function(resolve){resolve(1);}};
 Promise.resolve(t);`,'undefined');
 const event=bundle.events.find(x=>x.operation==='job.enter'&&
   x.causes.some(c=>c.kind==='promise'));
 assert(event);
 const mutation=event.stateChanges.find(p=>p.table==='frames'&&p.before===null);
 assert(mutation);
 event.causes.find(c=>c.kind==='promise').promiseId='p404';
 assert.throws(()=>validateBundle(bundle));
});
