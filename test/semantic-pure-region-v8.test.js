import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {encodePureRegionRecord,decodePureRegionRecord} from '../src/semantic/pure-region-v8.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {decodeDetailedRecord} from '../src/semantic/detailed-v7.js';

function fresh(source,args){
  const h=new RegionExecutionHarness({sessionId:'pure'});h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'entry',args});return h;
}
test('source-certified map/filter/fold pure regions commit ordinary identities into the shared selected heap',async()=>{
  for(const [body,expected] of [
    ['return xs.map(x=>x*2);',[4,6,8]],['return xs.filter(x=>x>2);',[3,4]],
    ['return xs.reduce((a,x)=>a+x,0);',9],
    ['const value={n:2};return [value,value];',[{n:2},{n:2}]]
  ]){
    const result=await verifyRegionTrainingCase({source:'"use strict";function run(xs){'+body+'}',entry:'run',
      args:[[2,3,4]],family:'pure-v8-heap',fixture:{calls:[]}});
    assert.equal(result.status,'locally_verified',result.reason);
    assert(result.exported.public.timeline.some(row=>row.kind==='algorithm'));
    const h=RegionExecutionHarness.replay(result.exported),actual=h.controller.materialize(h.controller.completion.value);
    assert.deepEqual(actual,expected);if(body.includes('value,value'))assert.equal(actual[0],actual[1]);
    assert.deepEqual(RegionExecutionHarness.restore(h.checkpoint()).controller.observedGraph(),h.controller.observedGraph());
  }
});
test('anchored input aliases survive return allocation and independent source rechecking',async()=>{
  const result=await verifyRegionTrainingCase({source:'"use strict";function run(x){return [x,x];}',entry:'run',args:[{n:7}],
    family:'pure-v8-input-alias',fixture:{calls:[]}});assert(result.exported,result.reason);
  assert.equal((await recheckRegionEvidence(result.exported)).valid,true);
  const h=RegionExecutionHarness.replay(result.exported),root=h.controller.input.graph.roots[0];
  const array=h.controller.heap.get(h.controller.completion.value[1]);
  assert.deepEqual(array.properties.get('0'),root);assert.deepEqual(array.properties.get('1'),root);
});
test('false pure claims, changed aliases, noncanonical bytes and stale entry are rejected atomically',()=>{
  const h=fresh('"use strict";function run(x){const a={n:x};return [a,a];}',[2]);
  const good=h.previewAlgorithm('i'),before=h.checkpoint(),forged=structuredClone(good);
  forged.allocations[0].properties[0].value=['num',9];
  assert.throws(()=>h.select('i',forged),/false algorithm/);assert.deepEqual(h.checkpoint(),before);
  const {entry,...record}=good,line=encodePureRegionRecord(record);
  assert.deepEqual(decodePureRegionRecord(line),record);
  assert.throws(()=>decodePureRegionRecord(line+' '),/noncanonical/);
  h.select('i',{kind:'bind',fields:{name:'x',value:['num',2]}});
  assert.throws(()=>h.select('i',good),/stale/);
});
test('mixed request dispatch restores without duplicate service calls',async()=>{
  const fixture=structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0'));
  const result=await verifyRegionTrainingCase(fixture);assert(result.exported,result.reason);
  const rows=result.exported.public.timeline;
  const index=rows.findIndex(row=>row.kind==='semantic'&&decodeDetailedRecord(row.fields.line).kind==='request');
  const prefix={...result.exported.public,timeline:rows.slice(0,index+1)};
  const before=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),request=decodeDetailedRecord(rows[index].fields.line).fields;
  let calls=0;const options={services:{'demo.readAsync':async()=>{calls++;return 7;}}};
  const resumed=RegionExecutionHarness.restore(before.checkpoint(),options);
  await resumed.dispatch(rows[index].fields.invocationId,request.effect);
  await resumed.dispatch(rows[index].fields.invocationId,request.effect);
  const restored=RegionExecutionHarness.restore(resumed.checkpoint(),options);
  await assert.rejects(restored.dispatch(rows[index].fields.invocationId,request.effect),/redispatch/);
  assert.equal(calls,1);
});

test('pure allocation output is checked against the continuation byte bound before any live mutation',()=>{
  const h=fresh('"use strict";function run(){const value={n:2};return [value,value];}',[]);
  const candidate=h.previewAlgorithm('i'),before=h.exportEpisode(),state=sharedRegionState(h.controller);
  // Entry fits, but its two newly allocated graph nodes do not.
  h.controller.maxPacketBytes=Buffer.byteLength(JSON.stringify(state),'utf8')+1;
  assert.throws(()=>h.select('i',candidate),/continuation byte bound/);
  assert.equal(h.controller.generated,0);
  assert.deepEqual(sharedRegionState(h.controller),state);
  assert.deepEqual(h.exportEpisode(),before);
});
