import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {encode} from '../src/values.js';
import {newSharedBuffer,newSharedView,effectiveSharedLength,growSharedBuffer,
 atomicSharedElement} from '../src/owned-shared-memory.js';
const read=(r,k)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
 .find(([key])=>key===k)?.[1]?.token?.value;
function compare(source){
 const r=createRuntime().start(source);
 assert.equal(r.drive().kind,'terminated');
 const b=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(b).valid,true);
 assert.equal(replayExact(b).valid,true);
 if(typeof SharedArrayBuffer.prototype.grow==='function')
   assert.deepEqual(read(r,'out'),encode(vm.runInNewContext(source+'\nout;')));
 return {r,b};
}
test('growable SAB expands zero-filled byte heap and tracking Int16 views',()=>{
 const b=newSharedBuffer('b',3,12);
 const a=newSharedView('a',b,'Int16Array');
 assert.equal(a.lengthTracking,true);
 assert.equal(effectiveSharedLength(b,a),1);
 growSharedBuffer(b,11);
 assert.equal(effectiveSharedLength(b,a),5);
 assert.equal(b.bytes.length,11);
 assert.deepEqual(atomicSharedElement(b,a,'load',4),encode(0));
 assert.throws(()=>growSharedBuffer(b,10),RangeError);
 assert.throws(()=>growSharedBuffer(b,13),RangeError);
});
test('guest grow and length-tracking view agree with independent V8',()=>{
 const {r}=compare(`let b=new SharedArrayBuffer(4,{maxByteLength:12});
 let v=new Int16Array(b);let fixed=new Uint8Array(b,0,1);
 let initial=v.length;b.grow(12);Atomics.store(v,4,99);
 let out=initial*1000+v.length*100+fixed.length*10+Atomics.load(v,4);`);
 assert.deepEqual(read(r,'out'),['num',2709]);
});
test('unbounded view subarray tracks subsequent growth and fixed view does not',()=>{
 const {r}=compare(`let b=new SharedArrayBuffer(4,{maxByteLength:12});
 let a=new Uint8Array(b);let sub=a.subarray(2);
 let fixed=new Uint8Array(b,0,2);
 b.grow(9);let out=sub.length*100+fixed.length*10+a.length;`);
 assert.deepEqual(read(r,'out'),['num',729]);
});
test('SAB growable, maxByteLength and invalid growth are observable',()=>{
 const {r}=compare(`let b=new SharedArrayBuffer(4,{maxByteLength:16});
 let name='';try{b.grow(3);}catch(e){name=e.name;}
 let out=name+':'+b.growable+':'+b.maxByteLength+':'+b.byteLength;`);
 assert.deepEqual(read(r,'out'),['str','RangeError:true:16:4']);
});
test('ordinary fixed SAB refuses grow with catchable TypeError',()=>{
 const {r}=compare(`let b=new SharedArrayBuffer(4);let out='';
 try{b.grow(8);}catch(e){out=e.name;}`);
 assert.deepEqual(read(r,'out'),['str','TypeError']);
});
