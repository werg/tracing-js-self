import test from 'node:test';
import assert from 'node:assert/strict';
import {runNativeWorkerAgents} from '../src/native-worker-agents.js';

test('real worker threads share the same Int32 memory',async()=>{
  const code=`const cells=new Int32Array(buffers[0]);
    for(let i=0;i<500;i++)Atomics.add(cells,0,1);
    return Atomics.load(cells,0);`;
  const r=await runNativeWorkerAgents({workers:[code,code],byteLengths:[8]});
  assert.equal(r.schema,'native-worker-agents/1');
  const bytes=Uint8Array.from(r.bufferBytes[0]);
  assert.equal(new DataView(bytes.buffer).getInt32(0,true),1000);
  assert.equal(r.results.length,2);
});
test('native Atomics.wait/notify wake an independent worker',async()=>{
  const r=await runNativeWorkerAgents({workers:[
    `const cells=new Int32Array(buffers[0]);
      while(Atomics.load(cells,0)===0)Atomics.wait(cells,0,0,200);
      return Atomics.load(cells,0);`,
    `const cells=new Int32Array(buffers[0]);
      Atomics.store(cells,0,37);Atomics.notify(cells,0,1);
      return Atomics.load(cells,0);`
  ],byteLengths:[4]});
  assert.deepEqual(r.results,[37,37]);
});
test('native shared buffers work with BigInt64 atomics',async()=>{
  const r=await runNativeWorkerAgents({workers:[
    `const v=new BigInt64Array(buffers[0]);Atomics.add(v,0,1n);return 'ok';`,
    `const v=new BigInt64Array(buffers[0]);Atomics.add(v,0,2n);return 'ok';`
  ],byteLengths:[8]});
  assert.deepEqual(r.results,['ok','ok']);
  assert.equal(new DataView(Uint8Array.from(r.bufferBytes[0]).buffer).getBigInt64(0,true),3n);
});
test('native worker API refuses malformed agent inputs',async()=>{
 await assert.rejects(runNativeWorkerAgents({workers:[]}),TypeError);
 await assert.rejects(runNativeWorkerAgents({workers:['return 1'],byteLengths:[-3]}),TypeError);
});

test('real independent workers can rendezvous without serial scheduling',async()=>{
 const r=await runNativeWorkerAgents({workers:[
   `const f=new Int32Array(buffers[0]);
     Atomics.store(f,0,1);Atomics.notify(f,0);
     while(Atomics.load(f,1)===0){
       if(Atomics.wait(f,1,0,5000)==='timed-out')
         throw new Error('second agent did not execute concurrently');
     }
     return Atomics.load(f,1);`,
   `const f=new Int32Array(buffers[0]);
     Atomics.store(f,1,1);Atomics.notify(f,1);
     while(Atomics.load(f,0)===0){
       if(Atomics.wait(f,0,0,5000)==='timed-out')
         throw new Error('first agent did not execute concurrently');
     }
     return Atomics.load(f,0);`
 ],byteLengths:[8],timeoutMs:10000});
 assert.deepEqual(r.results,[1,1]);
});
test('atomic publication exposes ordinary byte writes to a second worker',async()=>{
 const r=await runNativeWorkerAgents({workers:[
   `const bytes=new Uint8Array(buffers[0]),flag=new Int32Array(buffers[1]);
     bytes[0]=0x44;bytes[1]=0x33;bytes[2]=0x22;bytes[3]=0x11;
     Atomics.store(flag,0,1);Atomics.notify(flag,0);
     return bytes.length;`,
   `const view=new DataView(buffers[0]),flag=new Int32Array(buffers[1]);
     while(Atomics.load(flag,0)===0){
       if(Atomics.wait(flag,0,0,5000)==='timed-out')
         throw new Error('atomic publication timed out');
     }
     return view.getUint32(0,true);`
 ],byteLengths:[8,4],timeoutMs:10000});
 assert.deepEqual(r.results,[8,0x11223344]);
 assert.deepEqual(r.bufferBytes[0].slice(0,4),[0x44,0x33,0x22,0x11]);
});


test('actual workers notify native Atomics.waitAsync without serializing agents',async()=>{
 if(typeof Atomics.waitAsync!=='function')return;
 const r=await runNativeWorkerAgents({workers:[
   `const cells=new Int32Array(buffers[0]);
     const waited=Atomics.waitAsync(cells,0,0,5000);
     if(!waited.async)throw new Error('waitAsync was not pending');
     Atomics.store(cells,1,1);Atomics.notify(cells,1);
     return await waited.value;`,
   `const cells=new Int32Array(buffers[0]);
     while(Atomics.load(cells,1)===0){
       if(Atomics.wait(cells,1,0,5000)==='timed-out')
         throw new Error('native waiter did not register');
     }
     Atomics.store(cells,0,1);Atomics.notify(cells,0,1);
     return Atomics.load(cells,0);`
 ],byteLengths:[8],timeoutMs:10000});
 assert.deepEqual(r.results,['ok',1]);
});
test('native concurrent agents observe grown shared byte storage after atomic publication',async()=>{
 if(typeof SharedArrayBuffer.prototype.grow!=='function')return;
 const r=await runNativeWorkerAgents({workers:[
   `const bytes=buffers[0],flag=new Int32Array(buffers[1]);
     bytes.grow(12);new Uint8Array(bytes)[10]=99;
     Atomics.store(flag,0,1);Atomics.notify(flag,0);
     return bytes.byteLength;`,
   `const bytes=buffers[0],flag=new Int32Array(buffers[1]);
     while(Atomics.load(flag,0)===0){
       if(Atomics.wait(flag,0,0,5000)==='timed-out')
         throw new Error('growth not published');
     }
     return [bytes.byteLength,new Uint8Array(bytes)[10]];`
 ],byteLengths:[4,4],maxByteLengths:[16,4],timeoutMs:10000});
 assert.deepEqual(r.results,[12,[12,99]]);
 assert.equal(r.bufferBytes[0][10],99);
});
test('native growable-worker arguments reject malformed maximum lengths',async()=>{
 await assert.rejects(runNativeWorkerAgents({workers:['return 1'],
   byteLengths:[8],maxByteLengths:[4]}),TypeError);
});
