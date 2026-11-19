import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {defineRegionProgram} from '../src/semantic/regions.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

test('forward parameter closure uses checked detailed execution when a pure core cannot represent its identity',async()=>{
  const source='"use strict";function run(f=()=>n,n=7){return f();}';
  assert.equal(defineRegionProgram({source,entry:'run'}).program.algorithm,null);
  const result=await verifyRegionTrainingCase({source,entry:'run',family:'forward-parameter-closure',fixture:{calls:[]}});
  assert(result.exported,result.reason);assert.equal(result.status,'detailed-fallback');
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind:'return',value:['num',7]});
  assert.equal((await recheckRegionEvidence(result.exported)).sourceValidated,true);
});
