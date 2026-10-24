import test from 'node:test';
import assert from 'node:assert/strict';
import {encode} from '../src/values.js';
import {newSharedBuffer,newSharedDataView,effectiveDataViewLength,readSharedDataView,
 writeSharedDataView} from '../src/owned-shared-memory.js';

test('DataView aliases shared bytes in both endian modes',()=>{
 const b=newSharedBuffer('b',16),v=newSharedDataView('v',b,2,8);
 writeSharedDataView(b,v,'setUint32',0,encode(0x11223344),true);
 assert.deepEqual(b.bytes.slice(2,6),[0x44,0x33,0x22,0x11]);
 assert.deepEqual(readSharedDataView(b,v,'getUint16',0,false),encode(0x4433));
 assert.deepEqual(readSharedDataView(b,v,'getUint16',2,true),encode(0x1122));
});
test('DataView BigInt, float and byte-range checks',()=>{
 const b=newSharedBuffer('b',24),v=newSharedDataView('v',b);
 writeSharedDataView(b,v,'setBigUint64',0,encode((1n<<64n)-1n),true);
 assert.deepEqual(readSharedDataView(b,v,'getBigInt64',0,true),encode(-1n));
 writeSharedDataView(b,v,'setFloat64',8,encode(1.5));
 assert.deepEqual(readSharedDataView(b,v,'getFloat64',8),encode(1.5));
 assert.throws(()=>readSharedDataView(b,v,'getFloat64',19),RangeError);
 assert.throws(()=>newSharedDataView('bad',b,25),RangeError);
});
test('DataView growable byte length tracking',()=>{
 const b=newSharedBuffer('b',8,24),tracking=newSharedDataView('t',b),
   fixed=newSharedDataView('f',b,2,4);
 assert.equal(effectiveDataViewLength(b,tracking),8);
 b.bytes.push(...Array(8).fill(0));b.byteLength=16;
 assert.equal(effectiveDataViewLength(b,tracking),16);
 assert.equal(effectiveDataViewLength(b,fixed),4);
});
