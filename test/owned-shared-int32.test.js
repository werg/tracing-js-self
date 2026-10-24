import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {encode} from '../src/values.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
const value=(r,name)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
function compare(source){
 const r=createRuntime().start(source);
 assert.equal(r.drive().kind,'terminated');
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(bundle).valid,true);
 assert.equal(replayExact(bundle).valid,true);
 assert.deepEqual(value(r,'out'),encode(vm.runInNewContext(source+'\nout;')));
 return {r,bundle};
}
test('two owned Int32Array views alias one shared buffer',()=>{
 const {r}=compare(`let b=new SharedArrayBuffer(8);
 let a=new Int32Array(b);let c=new Int32Array(b);
 Atomics.store(a,0,4);let prev=Atomics.add(c,0,3);
 let out=prev*10+Atomics.load(a,0)+c.length;`);
 assert.deepEqual(value(r,'out'),['num',49]);
});
test('Int32 wrap and compare-exchange agree with independent V8',()=>{
 compare(`let v=new Int32Array(new SharedArrayBuffer(4));
 Atomics.store(v,0,2147483647);let a=Atomics.add(v,0,1);
 let b=Atomics.compareExchange(v,0,-2147483648,42);
 let out=a+b+Atomics.load(v,0);`);
});
test('single-agent wait with timeout zero and notify',()=>{
 compare(`let v=new Int32Array(new SharedArrayBuffer(4));
 let a=Atomics.wait(v,0,0,0);let b=Atomics.notify(v,0,1);
 let out=a+'-'+b;`);
});
test('direct shared Int32 write refuses as a guest throw',()=>{
 const r=createRuntime().start('let v=new Int32Array(new SharedArrayBuffer(4));v[0]=3;');
 assert.equal(r.drive().kind,'runtime.failure');
 assert.equal(validateBundle(JSON.parse(JSON.stringify(r.exportRun()))).valid,true);
});
