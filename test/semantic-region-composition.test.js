import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {verifyRegionTrainingCase,recheckRegionEvidence,checkRegionCounterfactualPrefixes} from '../src/semantic/compiler-v8.js';
import {encodeRegionRecord,sharedRegionState} from '../src/semantic/regions.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';

const getter='"use strict";function run(x){let n=x+1;const a=n*2;let reads=0;const o={};'+
  'Object.defineProperty(o,"v",{get:()=>{reads++;return 20;}});const price=o.v;const total=a+price;return total+reads;}';
const fixture=source=>({source,entry:'run',args:[3],family:'mixed-region-getter',fixture:{calls:[]}});
function fresh(source='"use strict";function run(x){const a=x+1;const o={};return a*2;}'){
  const h=new RegionExecutionHarness({sessionId:'regions'});
  h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'entry',args:[3]});return h;
}
test('compact–getter detail–compact shares cells, receivers and completion, with independent source checks',async()=>{
  const result=await verifyRegionTrainingCase(fixture(getter));
  assert.equal(result.status,'locally_verified',result.reason);
  assert.equal(result.exported.public.schema,'semantic-execution/8');
  assert(result.regionCoverage.compactRegions>=2);assert(result.regionCoverage.detailedRegions>=1);
  const h=RegionExecutionHarness.replay(result.exported),controller=h.invocations.get('invocation1').controller;
  assert.deepEqual(controller.completion,{kind:'return',value:['num',29]});
  assert.deepEqual(controller.visibleLocals().get('reads'),['num',1]);
  assert.equal((await recheckRegionEvidence(result.exported)).sourceValidated,true);
  const generated=result.exported.public.timeline.filter(row=>row.mode==='generated');
  assert.equal(result.exported.contexts.length,generated.length);
  assert(generated.filter(row=>row.kind==='region').every(row=>!row.fields.line.includes('stateDigest')),
    'routing hashes belong to the trusted envelope, not prediction targets');
  assert.equal(generated.filter(row=>row.fields.line.includes('"kind":"call"')).length,1);
});
test('stale entries, forged outputs and replayed compact transitions fail before mutation',()=>{
  const h=fresh(),candidate=h.preview('i','r0'),before=sharedRegionState(h.controller);
  const forged=structuredClone(candidate);forged.bindings[0][1]=['num',99];
  assert.throws(()=>h.select('i',forged),/false compact/);assert.deepEqual(sharedRegionState(h.controller),before);
  h.select('i',{kind:'bind',fields:{name:'x',value:['num',7]}});
  assert.throws(()=>h.select('i',candidate),/stale/);
  const current=h.preview('i','r0');h.select('i',current);
  assert.deepEqual(h.controller.visibleLocals().get('a'),['num',8]);
  assert.throws(()=>h.select('i',h.preview('i','r0')),/already committed/);
  const {entry,...record}=current;
  assert.throws(()=>fresh().select('i',encodeRegionRecord(record)),/stale/);
});
test('local guard failures use detail from the untouched state and never invoke coercion hooks',()=>{
  const h=fresh('"use strict";function run(x){let a=x+1;let b=1n+1;return a;}');
  const before=h.modelContext('i');assert.throws(()=>h.preview('i','r0'),/BigInt/);
  assert.deepEqual(h.modelContext('i'),before);
  h.select('i',{kind:'compute',fields:{expr:{op:'binary',operator:'+',left:{op:'local',name:'x'},right:{op:'literal',value:['num',1]}},
    result:['num',4],bind:'a',invocation:'i'}});
  assert.deepEqual(h.controller.visibleLocals().get('a'),['num',4]);
});
test('checkpoint resumes the identical mixed cutoff without rerunning the getter or prior regions',async()=>{
  const result=await verifyRegionTrainingCase(fixture(getter));assert(result.exported,result.reason);
  const rows=result.exported.public.timeline,cut=rows.findLastIndex(row=>row.kind==='region');
  const prefix={...result.exported.public,timeline:rows.slice(0,cut)};
  const original=RegionExecutionHarness.replay(prefix,{requireTerminal:false});
  const restored=RegionExecutionHarness.restore(original.checkpoint());
  assert.deepEqual(restored.modelContext('invocation1'),original.modelContext('invocation1'));
  for(const row of rows.slice(cut)){
    if(row.mode==='observed')restored.importObserved(row);
    else restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  }
  assert.deepEqual(restored.controller.completion,{kind:'return',value:['num',29]});
  assert.deepEqual(restored.controller.visibleLocals().get('reads'),['num',1]);
  const packet=original.checkpoint();packet.regionCursor.consumed=[];
  const {integrity,...body}=packet;packet.integrity=hashAlgorithmData(JSON.parse(JSON.stringify(body)));
  assert.throws(()=>RegionExecutionHarness.restore(packet),/history/);
});
test('cleanup replaces a pending return and remains a checked local detailed boundary',async()=>{
  const result=await verifyRegionTrainingCase(fixture('"use strict";function run(x){const a=x+1;try{return a;}finally{throw "cleanup";}}'));
  assert.equal(result.status,'locally_verified',result.reason);
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind:'throw',value:['str','cleanup']});
  assert(result.regionCoverage.compactRegions);assert(result.regionCoverage.detailedRecords);
});
test('future replies leave the earlier mixed public prefix unchanged and stay observed',async()=>{
  const base=structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0'));
  const changed=structuredClone(base);changed.fixture.calls[0].result=21;changed.fixture.calls[1].arguments[1]=22;
  assert.equal((await checkRegionCounterfactualPrefixes([base,changed])).valid,true);
  const result=await verifyRegionTrainingCase(base);assert(result.exported,result.reason);
  assert(result.exported.public.timeline.filter(row=>row.kind==='result').every(row=>row.mode==='observed'));
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind:'return',value:['num',8]});
});

test('oversized compact blocks refuse before changing live cells or publishing a region',()=>{
  const h=fresh('"use strict";function run(x){const a="'+ 'x'.repeat(1024) +'";return a;}'),
    candidate=h.preview('i','r0'),before=h.exportEpisode(),state=sharedRegionState(h.controller);
  const entryBytes=Math.max(Buffer.byteLength(JSON.stringify(h.controller.segmentPacket()),'utf8'),
    Buffer.byteLength(JSON.stringify(state),'utf8'));
  h.controller.maxPacketBytes=entryBytes+1;
  assert.throws(()=>h.select('i',candidate),/packet budget|continuation byte bound/);
  assert.equal(h.controller.generated,0);
  assert.deepEqual(sharedRegionState(h.controller),state);
  assert.deepEqual(h.exportEpisode(),before);
});

test('a local region samples its deadline once and commits every hidden binding together',()=>{
  const h=new RegionExecutionHarness({sessionId:'local-deadline',now:()=>0});
  h.publishProgram({programId:'p',source:'"use strict";function run(x){let a=x+1;let b=a*2;return b;}',entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'entry',args:[3],deadline:1});
  const candidate=h.preview('i','r0');let clockReads=0;
  const advancingClock=()=>clockReads++;h.inner.now=advancingClock;
  h.select('i',candidate);
  assert.equal(clockReads,1);
  assert.equal(h.inner.now,advancingClock);
  assert.equal(h.active,null);
  assert.equal(h.controller.generated,3);
  assert.deepEqual(h.controller.visibleLocals().get('a'),['num',4]);
  assert.deepEqual(h.controller.visibleLocals().get('b'),['num',8]);
  assert.equal(h.timeline.at(-1).kind,'region');
  assert.equal(h.timeline.filter(row=>row.mode==='generated').length,1);
  assert.deepEqual(RegionExecutionHarness.restore(h.checkpoint()).modelContext('i'),h.modelContext('i'));
  const before=h.exportEpisode(),state=sharedRegionState(h.controller);
  assert.throws(()=>h.select('i',{kind:'end',fields:{kind:'return'}}),/deadline expired/);
  assert.deepEqual(h.exportEpisode(),before);
  assert.deepEqual(sharedRegionState(h.controller),state);
});

test('an expired local region leaves no partial bindings or active checkpoint cursor',()=>{
  const h=new RegionExecutionHarness({sessionId:'expired-local',now:()=>0});
  h.publishProgram({programId:'p',source:'"use strict";function run(x){let a=x+1;let b=a*2;return b;}',entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'entry',args:[3],deadline:1});
  const candidate=h.preview('i','r0'),before=h.checkpoint();
  h.inner.now=()=>1;
  assert.throws(()=>h.select('i',candidate),/deadline expired/);
  assert.equal(h.active,null);
  assert.equal(h.controller.generated,0);
  assert.deepEqual(h.checkpoint(),before);
  assert.deepEqual(RegionExecutionHarness.restore(h.checkpoint()).modelContext('i'),h.modelContext('i'));
});
