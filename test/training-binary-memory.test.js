import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {newArrayBuffer,newSharedView,newSharedDataView} from '../src/owned-shared-memory.js';
import {validateBinaryMemoryState} from '../src/binary-memory-validation.js';

test('ordinary ArrayBuffer preserves shared backing identities across typed views and DataView',()=>{
  const {runtime}=runtimeDifferential('const buffer=new ArrayBuffer(4);const a=new Uint8Array(buffer);const b=new DataView(buffer);a[0]=x;b.setUint8(1,x+1);return [a[0],a[1],b.getUint8(0),a.buffer===b.buffer];',{args:[7]});
  const buffer=Object.values(runtime.state.heap).find(node=>node.kind==='array-buffer');
  assert.deepEqual(buffer.bytes,[7,8,0,0]);
  assert.equal(Object.values(runtime.state.heap).filter(node=>node.bufferId===buffer.id).length,2);
  runtimeDifferential('const b=new ArrayBuffer(16);const d=new DataView(b,2,8);const bytes=new Uint8Array(b);d.setUint32(0,287454020,true);return [d.getUint16(0,false),d.getUint16(2,true),bytes[2],bytes[5],d.byteOffset,d.byteLength];');
});
test('typed array allocation, scalar ToIndex, numeric keys and failed bounds match independent V8',()=>{
  runtimeDifferential('const a=new Int16Array("3.8");a[0]=65537;a[1]=-2;a[2]=true;a[3]=9;a[-1]=8;a["-0"]=7;a[1.5]=6;return [a.length,a.byteLength,a[0],a[1],a[2],a[3],a[-1],a["-0"],a[1.5]];');
  runtimeDifferential('return [new ArrayBuffer().byteLength,new ArrayBuffer("4.9").byteLength,new ArrayBuffer(-0.9).byteLength,new Uint8Array(null).length,new DataView(new ArrayBuffer(8),"2.7","3.8").byteLength];');
  runtimeDifferential('let a="";try{new ArrayBuffer(-1);}catch(e){a=e.name;}let b="";try{new ArrayBuffer(1n);}catch(e){b=e.name;}let c="";try{new Int32Array(new ArrayBuffer(8),2);}catch(e){c=e.name;}return [a,b,c];');
});
test('binary scalar conversion and DataView failure ordering remain guest-visible',()=>{
  runtimeDifferential('const b=new ArrayBuffer(16),a=new BigInt64Array(b),d=new DataView(b);a[0]="18446744073709551615";a[1]=true;return [a[0],a[1],d.getBigInt64(0,true)];');
  runtimeDifferential('const a=new Uint8Array(0),d=new DataView(new ArrayBuffer(1));let first="",second="",third="";try{a[100]=1n;}catch(e){first=e.name;}try{d.setBigInt64(100,1);}catch(e){second=e.name;}try{d.setBigInt64(100,"bad");}catch(e){third=e.name;}return [first,second,third];');
  runtimeDifferential('const d=new DataView(new ArrayBuffer(16));d.setFloat64(undefined,-0,true);d.setFloat32(8,1.5);return [1/d.getFloat64(0,true),d.getFloat32(8),d.getUint8()];');
});
test('subarray aliases while ArrayBuffer.slice copies, with scalar clipping and buffer capabilities',()=>{
  runtimeDifferential('const b=new ArrayBuffer(4),a=new Uint8Array(b);a[1]=7;const part=a.subarray("1",-1),copy=b.slice(1,-1),c=new Uint8Array(copy);part[0]=9;return [a[1],c[0],part.buffer===b,c.buffer===b,part.byteOffset,b.maxByteLength,b.resizable,b.detached,ArrayBuffer.isView(a),ArrayBuffer.isView(new DataView(b)),ArrayBuffer.isView(b)];');
  runtimeDifferential('const a=new Uint8Array(4),b=new ArrayBuffer(4);return [a.subarray(0/0).length,a.subarray(-1/0,1/0).length,b.slice(0/0).byteLength,b.slice(1/0).byteLength];');
});
test('binary views survive JSON restoration without losing backing aliases',()=>{
  const text='"use strict";function run(){const b=new ArrayBuffer(8),a=new Uint8Array(b),d=new DataView(b);a[0]=4;d.setUint8(1,9);return a[0]+a[1];}';
  const runtime=createRuntime().startEntry({text,functionName:'run'});
  while(!Object.values(runtime.state.heap).some(node=>node.kind==='data-view'))runtime.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);runtime.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),JSON.parse(JSON.stringify(runtime.exportRun())));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
});
test('binary archive validation rejects altered backing identities, bytes, lengths and capabilities',()=>{
  const buffer=newArrayBuffer('b',8),typed=newSharedView('v',buffer,'Uint16Array',2,2),data=newSharedDataView('d',buffer,1,3);
  const state={heap:{b:buffer,v:typed,d:data}},fail=message=>{throw new Error(message);};
  validateBinaryMemoryState(state,fail);
  for(const mutate of [s=>s.heap.b.bytes[0]=256,s=>s.heap.b.resizable=true,s=>s.heap.v.bufferId='missing',s=>s.heap.v.byteOffset=3,s=>s.heap.d.byteLength=9,s=>s.heap.v.lengthTracking=true]){
    const forged=structuredClone(state);mutate(forged);
    assert.throws(()=>validateBinaryMemoryState(forged,fail),/binary|ArrayBuffer/i);
  }
});
test('resource limits, object conversions and unmodeled memory capabilities refuse the profile',()=>{
  for(const body of ['new ArrayBuffer(1025);','new ArrayBuffer(4,{maxByteLength:8});','new Uint8Array({length:3});','new ArrayBuffer({valueOf(){return 4;}});','const a=new Uint8Array(4);Atomics.load(a,0);']){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'return 1;}',functionName:'run'});
    assert.throws(()=>runtime.drive(),/profile|continuation|qualification/);
  }
});
