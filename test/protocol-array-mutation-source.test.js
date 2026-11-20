import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {LANGUAGE_EXPANSION_INTERACTIONS} from '../fixtures/language-expansion/benchmark.js';

async function checked(source,args=[]){
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',args,family:'ordinary-array-mutation'});
  assert(result.exported,result.reason);
  const artifact=result.exported,controller=RegionExecutionHarness.replay(artifact).controller;
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
  return {artifact,controller};
}

test('generator delegation runs Array.push cleanup exactly once before returning',async()=>{
  const fixture=LANGUAGE_EXPANSION_INTERACTIONS.find(row=>row.id==='generator-delegation-close');
  const {artifact,controller}=await checked(fixture.source,fixture.args);
  assert.deepEqual(controller.materialize(controller.completion.value),[1,['close']]);
  assert(artifact.sidecar.protocolExtensions.includes('synchronous-generator-source/1'));
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
});

test('push and pop preserve live length, sparse prefixes and shared element identity',async()=>{
  const {controller}=await checked('"use strict";function run(){const a=[,1];const object={n:4};const length=a.push(object,object);const last=a.pop();last.n=7;return [length,a.length,a[0],a[2]===last,a[2].n,a.push()];}');
  assert.deepEqual(controller.materialize(controller.completion.value),[4,3,undefined,true,7,3]);
});

test('array mutation preserves Symbol values without erasing their identity',async()=>{
  const {controller}=await checked('"use strict";function run(){const s=Symbol("x");const a=[];const empty=a.pop();a.push(s);const same=a.pop()===s;return [empty,same,a.length];}');
  assert.deepEqual(controller.materialize(controller.completion.value),[undefined,true,0]);
});

test('unsupported method replacement cannot be silently treated as builtin array mutation',async()=>{
  const result=await verifyProtocolRegionTrainingCase({source:'"use strict";function run(){const a=[];a.push=function(x){return x+8;};return [a.push(1),a.length];}',
    entry:'run',args:[],family:'array-method-replacement'});
  assert.equal(result.exported,undefined);
  assert.match(result.reason,/inherited intrinsic property requires its callable protocol/);
});
