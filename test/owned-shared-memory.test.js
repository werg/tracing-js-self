import test from 'node:test';
import assert from 'node:assert/strict';
import {SHARED_TYPES,newSharedBuffer,newSharedView,readSharedElement,writeSharedElement,
 atomicSharedElement} from '../src/owned-shared-memory.js';
import {encode,decode} from '../src/values.js';

test('owned bytes alias across integer, unsigned, floating and BigInt views',()=>{
 const b=newSharedBuffer('b',32);
 const i32=newSharedView('a',b,'Int32Array',0,2),u8=newSharedView('u',b,'Uint8Array');
 const f=newSharedView('f',b,'Float32Array',8,1);
 const big=newSharedView('g',b,'BigUint64Array',16,1);
 writeSharedElement(b,i32,0,encode(0x11223344));
 assert.deepEqual([0,1,2,3].map(i=>decode(readSharedElement(b,u8,i))),
   Array.from(new Uint8Array(new Int32Array([0x11223344]).buffer)));
 writeSharedElement(b,f,0,encode(2.5));
 assert.equal(decode(readSharedElement(b,f,0)),2.5);
 writeSharedElement(b,big,0,encode(2n**64n-1n));
 assert.equal(decode(readSharedElement(b,big,0)),2n**64n-1n);
});
test('owned byte offsets and subarray bounds',()=>{
 const b=newSharedBuffer('b',12);
 assert.equal(newSharedView('v',b,'Int16Array',2,3).length,3);
 assert.throws(()=>newSharedView('bad',b,'Int32Array',2),RangeError);
 assert.throws(()=>newSharedView('bad',b,'Float64Array',8),RangeError);
});
test('atomic coercion, return values and mixed aliases',()=>{
 const b=newSharedBuffer('b',8),v=newSharedView('i',b,'Int32Array');
 const u=newSharedView('u',b,'Uint8Array');
 assert.deepEqual(atomicSharedElement(b,v,'store',0,[encode(2147483647)]),encode(2147483647));
 assert.deepEqual(atomicSharedElement(b,v,'add',0,[encode(1)]),encode(2147483647));
 assert.equal(decode(readSharedElement(b,v,0)),-2147483648);
 assert.deepEqual(atomicSharedElement(b,v,'compareExchange',0,[encode(-2147483648),encode(7)]),
   encode(-2147483648));
 assert.equal(decode(readSharedElement(b,u,0)),7);
 const g=newSharedView('g',b,'BigInt64Array');
 assert.deepEqual(atomicSharedElement(b,g,'exchange',0,[encode(9n)]),encode(7n));
 assert.equal(decode(readSharedElement(b,v,0)),9);
});
test('typed-array semantics reject noninteger atomics and invalid element widths',()=>{
 const b=newSharedBuffer('b',16);
 assert.throws(()=>atomicSharedElement(b,newSharedView('f',b,'Float64Array'),
   'add',0,[encode(1)]),TypeError);
 assert.throws(()=>writeSharedElement(b,newSharedView('g',b,'BigInt64Array'),0,encode(2)),TypeError);
 assert.equal(Object.keys(SHARED_TYPES).length,10);
});

test('Atomics.store returns untruncated integer, unlike the stored lane',()=>{
 for(const [name,value] of [['Int8Array',257],['Uint8Array',257],
   ['Int16Array',65537],['Uint16Array',65537],
   ['Int32Array',4294967297],['Uint32Array',4294967297]]){
   const b=newSharedBuffer('b',16),v=newSharedView('v',b,name);
   const n=new globalThis[name](new SharedArrayBuffer(16));
   assert.deepEqual(atomicSharedElement(b,v,'store',0,[encode(value)]),
     encode(Atomics.store(n,0,value)));
   assert.deepEqual(readSharedElement(b,v,0),encode(Atomics.load(n,0)));
 }
 const b=newSharedBuffer('b',16),v=newSharedView('v',b,'BigInt64Array');
 const n=new BigInt64Array(new SharedArrayBuffer(16)),value=(1n<<64n)-1n;
 assert.deepEqual(atomicSharedElement(b,v,'store',0,[encode(value)]),
   encode(Atomics.store(n,0,value)));
 assert.deepEqual(readSharedElement(b,v,0),encode(Atomics.load(n,0)));
});
