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
test('direct shared typed array stores alias indexed and atomic reads',()=>{
 const {r}=compare('let v=new Int32Array(new SharedArrayBuffer(4));v[0]=3;let out=Atomics.load(v,0);');
 assert.deepEqual(value(r,'out'),['num',3]);
});
test('different owned typed array widths alias the same SAB byte storage',()=>{
 compare(`let b=new SharedArrayBuffer(16);
 let i=new Int32Array(b);let u=new Uint8Array(b);
 Atomics.store(i,0,0);Atomics.store(u,0,17);
 let out=Atomics.load(i,0)+u[0];`);
});
test('offset subarrays and shared buffer slice preserve byte-level semantics',()=>{
 compare(`let b=new SharedArrayBuffer(16);
 let view=new Uint8Array(b);view[4]=12;view[5]=23;
 let narrow=new Uint8Array(b,4,2);
 let sub=narrow.subarray(1,2);
 let snap=new Uint8Array(b.slice(4,6));
 let out=sub[0]+snap[0]+snap[1];`);
});
