import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {candidateSourceInventory} from '../src/corpus/training-candidates.mjs';
import {buildSourceRegistry,canonicalHash} from '../src/corpus/source-registry.mjs';
import {identityHash} from '../src/corpus/campaign-store.mjs';
import {buildGenerationShardPlan,verifyGenerationShardPlan,runGenerationShard,readGenerationShardReceipt,
  mergeGenerationShardReceipts,compareGenerationShardEquivalence} from '../src/corpus/generation-shards.mjs';

const tasks=[1,2,3].map((n,index)=>({kind:'source',fixture:{id:'case-'+index,family:'shared-increment',
  source:'"use strict";function run(x){return x+1;}',entry:'run',args:[n],fixture:{calls:[]}}}));
tasks.push({kind:'source',fixture:{id:'unsupported',family:'unsupported-dynamic-source',source:'"use strict";function run(){return eval("1");}',entry:'run',args:[],fixture:{calls:[]}}});
const registry=buildSourceRegistry(candidateSourceInventory(tasks));
const identity={schema:'semantic-generation-identity/1',producerRevision:'a'.repeat(40),recipe:'test-only',
  registryDigest:canonicalHash(registry),nativePolicy:null,bounds:{memoryMb:256,timeoutMs:30000,maxOutputBytes:8388608}};
const plan=count=>buildGenerationShardPlan({tasks,registry,identity,shardCount:count});
const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'generation-shards-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

test('global-registry shard plan is independent of enumeration order and preserves splits',()=>{
  const original=plan(3),reversed=buildGenerationShardPlan({tasks:[...tasks].reverse(),registry,identity,shardCount:3});
  assert.deepEqual(original,reversed);
  assert.equal(original.inventoryDigest,plan(1).inventoryDigest);
  assert.equal(verifyGenerationShardPlan(original).valid,true);
  const changed=structuredClone(original);changed.candidates[0].split='changed';
  assert.throws(()=>verifyGenerationShardPlan(changed),/changed/);
  const unregistered=structuredClone(tasks);unregistered[0].fixture.source='"use strict";function run(x){return x+2;}';
  assert.throws(()=>buildGenerationShardPlan({tasks:unregistered,registry,identity,shardCount:2}),/source bytes/);
  assert.throws(()=>buildGenerationShardPlan({tasks:[...tasks,tasks[0]],registry,identity}),/Duplicate/);
});

test('actual single and sharded generation have equivalent final public/certification identities',async t=>{
  const directory=temporary(t),single=plan(1),sharded=plan(2);
  const one=await runGenerationShard({plan:single,index:0,directory:join(directory,'single'),currentIdentity:identity});
  const parts=[];
  for(let index=0;index<2;index++)parts.push(await runGenerationShard({plan:sharded,index,
    directory:join(directory,'shard-'+index),currentIdentity:identity}));
  const mergedOne=mergeGenerationShardReceipts(single,[one]),mergedParts=mergeGenerationShardReceipts(sharded,parts);
  assert.equal(compareGenerationShardEquivalence(mergedOne,mergedParts).status,'agreed');
  assert.equal(mergedParts.candidates,4);assert.equal(mergedParts.attempts,4);
  assert.equal(mergedParts.counts.locally_verified,3);
  assert(mergedParts.rows.some(row=>row.id==='unsupported'&&row.status!=='locally_verified'));
  assert.equal(mergedParts.nativeDeduplication,'required-after-merge');
  assert.throws(()=>mergeGenerationShardReceipts(sharded,parts.slice(0,1)),/All planned/);
  assert.throws(()=>mergeGenerationShardReceipts(sharded,[parts[0],parts[0]]),/Duplicate/);
  const forged=structuredClone(parts);forged[0].rows[0].split='changed';
  const {digest,...payload}=forged[0];forged[0].digest=identityHash(payload);
  assert.throws(()=>mergeGenerationShardReceipts(sharded,forged),/frozen split/);
  const unrun=structuredClone(parts);unrun[0].unrun.push({id:'unplanned',status:'unrun'});
  const {digest:unused,...changed}=unrun[0];unrun[0].digest=identityHash(changed);
  assert.throws(()=>mergeGenerationShardReceipts(sharded,unrun),/attempted\/unrun accounting/);
});

test('cancellation preserves the durable prefix and plain resume completes without repeating receipts',async t=>{
  const directory=temporary(t),frozen=plan(1),abort=new AbortController();
  const first=await runGenerationShard({plan:frozen,index:0,directory,currentIdentity:identity,signal:abort.signal,
    onRecord:()=>abort.abort()});
  assert.equal(first.complete,false);assert.equal(first.rows.length,1);
  assert.equal(first.attempted,1);assert.equal(first.unrun.length,3);
  assert.deepEqual([...first.rows,...first.unrun].map(row=>row.id).sort(),tasks.map(task=>task.fixture.id).sort());
  const prefix=readFileSync(join(directory,'campaign.jsonl'),'utf8');
  assert.throws(()=>mergeGenerationShardReceipts(frozen,[first]),/incomplete/);
  const resumed=await runGenerationShard({plan:frozen,index:0,directory,currentIdentity:identity,resume:true});
  assert.equal(resumed.complete,true);assert.equal(resumed.rows.length,4);
  assert(readFileSync(join(directory,'campaign.jsonl'),'utf8').startsWith(prefix));
  assert(resumed.rows.every(row=>row.attempts.length===1));
  assert.deepEqual(readGenerationShardReceipt({plan:frozen,index:0,directory}),resumed);
  await assert.rejects(runGenerationShard({plan:frozen,index:0,directory,currentIdentity:{...identity,recipe:'changed'},resume:true}),/identity differs/);
});

test('per-run candidate budgets preserve the complete inventory and resume only unfinished work',async t=>{
  const directory=temporary(t),limitedIdentity={...identity,bounds:{...identity.bounds,maxCandidates:1}};
  const limitedPlan=buildGenerationShardPlan({tasks,registry,identity:limitedIdentity,shardCount:1});
  let executions=0;
  const execute=async()=>{executions++;return {result:{status:'unsupported',reason:'counted test execution'},durationMs:0,peakRssBytes:null};};
  for(let run=0;run<tasks.length;run++){
    const receipt=await runGenerationShard({plan:limitedPlan,index:0,directory,currentIdentity:limitedIdentity,
      execute,resume:run>0});
    assert.equal(receipt.attempted,run+1);assert.equal(receipt.unrun.length,tasks.length-run-1);
    assert.equal(receipt.complete,run===tasks.length-1);
    assert(receipt.rows.every(row=>row.attempts.length===1));
    assert.deepEqual(receipt,readGenerationShardReceipt({plan:limitedPlan,index:0,directory}));
  }
  assert.equal(executions,tasks.length);
});

test('plans retain more than 10000 candidates and allow more than 64 shards',()=>{
  const expanded=Array.from({length:10001},(_,i)=>({...tasks[0],fixture:{...tasks[0].fixture,id:'large-'+i}}));
  const large=buildGenerationShardPlan({tasks:expanded,registry,identity,shardCount:65});
  assert.equal(large.candidates.length,10001);assert.equal(large.shardCount,65);
  assert.equal(new Set(large.candidates.map(row=>row.id)).size,10001);
});
