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
