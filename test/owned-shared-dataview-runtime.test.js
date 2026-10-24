import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {encode} from '../src/values.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
const read=(r,k)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
 .find(([key])=>key===k)?.[1]?.token?.value;
function compare(source){
 const r=createRuntime().start(source);
 assert.equal(r.drive().kind,'terminated');
 const bundle=JSON.parse(JSON.stringify(r.exportRun()));
 assert.equal(validateBundle(bundle).valid,true);
 assert.equal(replayExact(bundle).valid,true);
 assert.deepEqual(read(r,'out'),encode(vm.runInNewContext(source+'\nout;')));
 return r;
}
test('DataView mixed endian accesses alias native typed array bytes',()=>{
 compare(`let b=new SharedArrayBuffer(12);let d=new DataView(b,2,8);
   let u=new Uint8Array(b);d.setUint32(0,287454020,true);
   let out=d.getUint16(0,false)+d.getUint16(2,true)+u[2]+u[5];`);
});
test('DataView float and signed view reads match native V8',()=>{
 compare(`let b=new SharedArrayBuffer(12);let d=new DataView(b);
   d.setFloat64(0,1.5,false);d.setInt16(4,-32000,true);
   let out=d.getFloat32(0,false)+d.getInt16(4,true);`);
});
test('DataView signed and unsigned BigInt reads preserve byte identity',()=>{
 compare(`let b=new SharedArrayBuffer(16);let d=new DataView(b,4,8);
   d.setBigUint64(0,18446744073709551615n,true);
   let out=d.getBigInt64(0,true);`);
});
test('length-tracking DataView follows shared buffer growth',()=>{
 if(typeof SharedArrayBuffer.prototype.grow!=='function')return;
 compare(`let b=new SharedArrayBuffer(8,{maxByteLength:24});
   let t=new DataView(b);let f=new DataView(b,2,4);
   b.grow(16);t.setUint8(15,55);
   let out=t.byteLength*100+f.byteLength*10+t.getUint8(15);`);
});
test('DataView out-of-bounds read is a catchable owned RangeError',()=>{
 const r=compare(`let d=new DataView(new SharedArrayBuffer(4));
   let out='';try{d.getUint32(2);}catch(e){out=e.name;}`);
 assert.deepEqual(read(r,'out'),['str','RangeError']);
});
