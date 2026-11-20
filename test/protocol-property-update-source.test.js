import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

test('class public-field updates preserve numeric conversion and prefix/postfix values',async()=>{
  for(const [initial,expected] of [['"2"',[2,4,4]],['4n',[4n,6n,6n]],['-0',[-0,2,2]]]){
    const source='"use strict";function run(){class C{n='+initial+';inc(){const previous=this.n++;return [previous,++this.n,this.n];}}return new C().inc();}',
      result=await verifyProtocolRegionTrainingCase({source,entry:'run',args:[],family:'class-public-update'});
    assert(result.exported,result.reason);
    const controller=RegionExecutionHarness.replay(result.exported).controller;
    assert.deepEqual(controller.materialize(controller.completion.value),expected);
    assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
  }
});

test('Symbol-keyed updates keep the committed value and original Symbol identity',async()=>{
  const result=await verifyProtocolRegionTrainingCase({source:'"use strict";function run(){const key=Symbol("n");const o={[key]:"3"};const previous=o[key]--;return [previous,o[key],--o[key]];}',
    entry:'run',args:[],family:'symbol-property-update'});
  assert(result.exported,result.reason);
  const controller=RegionExecutionHarness.replay(result.exported).controller;
  assert.deepEqual(controller.materialize(controller.completion.value),[3,2,1]);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).sourceValidated,true);
});
