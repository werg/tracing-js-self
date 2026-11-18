import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {measureExecutionDifficulty} from '../src/corpus/execution-difficulty.mjs';

test('difficulty measures executed loops, nested calls, aliases and mutations across distinct inputs',async()=>{
  const source='"use strict";function add(x){return x+1;}function run(a){let s=0;for(let i=0;i<a.length;i++){s+=add(a[i]);}a[0]=s;return [a,a];}';
  const rows=[];
  for(const args of [[[]],[[1,2,3]]]){
    const checked=await verifyEffectfulTrainingCase({source,entry:'run',args,fixture:{calls:[]},family:'difficulty'});
    assert.equal(checked.status,'locally_verified',checked.reason);rows.push(measureExecutionDifficulty(checked.exported));
  }
  assert.equal(rows[0].loopTrips,0);assert.equal(rows[1].loopTrips,3);
  assert.equal(rows[1].maxCallDepth,2);assert.ok(rows[1].finalAliasEdges>=2);
  assert.ok(rows[1].mutationEvents>rows[0].mutationEvents);
  assert.notEqual(rows[0].pathDigest,rows[1].pathDigest);
  assert.equal(rows[1].learnerGeneratedTokens,null);assert.equal(rows[1].maxModelContextTokens,null);
});
test('difficulty records actual pending concurrency and thrown outcomes',async()=>{
  const asyncCase=await verifyEffectfulTrainingCase(EFFECTFUL_ENGINEERING_FIXTURES.find(row=>row.id==='two-pending-reversed'));
  assert.equal(asyncCase.status,'locally_verified',asyncCase.reason);
  const parallel=measureExecutionDifficulty(asyncCase.exported);
  assert.equal(parallel.peakPendingEffects,2);assert.equal(parallel.awaits,2);
  assert.ok(parallel.asyncDependencyDepth>=1);assert.equal(parallel.episodes[0].pendingWorkAtCompletion.effects,0);
  const thrown=await verifyEffectfulTrainingCase({source:'"use strict";function run(){throw 7;}',entry:'run',fixture:{calls:[]},family:'difficulty-throw'});
  assert.equal(thrown.status,'locally_verified',thrown.reason);
  assert.equal(measureExecutionDifficulty(thrown.exported).exceptionOutcomes,1);
});
