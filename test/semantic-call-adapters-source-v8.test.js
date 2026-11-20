import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeDetailedRecord} from '../src/semantic/detailed-v7.js';

test('receiver corpus idioms qualify and recheck using the existing public call contract',async()=>{
  for(const invoke of ['object.read.call(object,2)','object.read.apply(object,[2])','Reflect.apply(object.read,object,[2])']){
    const source='"use strict";function run(x){const object={n:x,read:function(d){return this.n+d;}};return '+invoke+';}',
      result=await verifyRegionTrainingCase({source,entry:'run',args:[4],family:'method-receiver-adapters'});
    assert(result.exported,result.reason);assert.equal(result.profile,'compositional-regions/1');
    const replay=RegionExecutionHarness.replay(result.exported),restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(replay.checkpoint())));
    assert.deepEqual(replay.controller.completion,{kind:'return',value:['num',6]});
    assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(replay.controller));
    const checked=await recheckRegionEvidence(result.exported);assert(checked.sourceValidated&&checked.replayValidated);
  }
});

test('source admission forwards effective apply arguments into rest parameters',async()=>{
  const source='"use strict";function run(){function f(a,...rest){return [this,a,rest.length,rest[0],rest[1]];}return Reflect.apply(f,null,{length:3,0:2,2:4});}',
    result=await verifyRegionTrainingCase({source,entry:'run',args:[],family:'apply-rest-arguments'});
  assert(result.exported,result.reason);
  const archive=result.exported.sidecar.sourceArtifact.sidecar.archive,
    event=archive.events.find(row=>row.operands[0]?.[1]?.[1]==='Reflect.apply');assert(event);
  assert.deepEqual(event.readObservations.map(row=>row.key),['length','0','1','2']);
  const records=result.exported.public.timeline.filter(row=>row.mode==='generated'&&row.kind!=='region')
    .map(row=>decodeDetailedRecord(row.fields.line)),call=records.findIndex(row=>row.kind==='call');
  assert(call>0);
  assert.deepEqual(records[call].fields.arguments,[['num',2],['undefined'],['num',4]]);
  assert.deepEqual(records.slice(0,call).filter(row=>row.kind==='read').map(row=>row.fields.key),['length','0','1','2']);
  const checked=await recheckRegionEvidence(result.exported);assert(checked.sourceValidated&&checked.replayValidated);
});

test('source admission keeps apply accessor continuations outside the bounded slice',async()=>{
  const source='"use strict";function run(){function f(x){return x;}return Reflect.apply(f,null,{length:1,get 0(){return 3;}});}',
    result=await verifyRegionTrainingCase({source,entry:'run',args:[],family:'apply-accessor-refusal'});
  assert.equal(result.exported,undefined);assert.notEqual(result.status,'locally_verified');
});
