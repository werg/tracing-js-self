import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {ownedProtocolSourceObservations} from '../src/semantic/protocol-source-observations-v8.js';
import {compareProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';
import {LANGUAGE_EXPANSION_INTERACTIONS} from '../fixtures/language-expansion/benchmark.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
const frozen=LANGUAGE_EXPANSION_INTERACTIONS.find(row=>row.id==='typed-views-shared-backing');
const fixture=source=>({source:'"use strict";function run(x){'+source+'}',entry:'run',args:[7],family:'binary-source-regression'});

test('the frozen shared-backing interaction qualifies through independent byte and alias observations',async()=>{
  const result=await verifyProtocolRegionTrainingCase(frozen);assert(result.exported,result.reason);
  assert.deepEqual(result.exported.sidecar.protocolExtensions,['owned-binary-memory/1']);
  assert.equal(result.regionCoverage.protocolRecords,13);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).valid,true);
  const reference=result.exported.sidecar.sourceArtifact.sidecar.reference;
  assert.equal(reference.metadataAudit.status,'agreed');
  assert(reference.observations.metadata.some(row=>row.objects.some(node=>node.annotations?.some(item=>item.name==='binary-buffer'&&item.data.bytes[1]===8))));
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion.kind,'return');
});
test('binary state survives compact arithmetic on both sides and exact checkpoint resumption',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture('const before=x+2;const b=new ArrayBuffer(4),a=new Uint8Array(b),d=new DataView(b);a[0]=x;d.setUint8(1,x+1);const read=a[1];const after=before+read;return after;'));
  assert(result.exported,result.reason);assert(result.regionCoverage.compactRegions>=2);
  const {public:episode}=result.exported;
  const cut=episode.timeline.findIndex(row=>row.kind==='protocol'&&row.fields.line.includes('memory.set'))+1;
  assert(cut>2);
  const prefix={...episode,timeline:episode.timeline.slice(0,cut)},h=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    checkpoint=JSON.parse(JSON.stringify(h.checkpoint())),restored=RegionExecutionHarness.restore(checkpoint);
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(h.controller));
  for(const row of episode.timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(RegionExecutionHarness.replay(episode).controller));
  const forged=structuredClone(checkpoint),state=forged.selected.invocations[0][1].state;
  state.heap.find(([,node])=>node.kind==='array-buffer')[1].bytes[3]=9;
  const {integrity,...body}=forged;forged.integrity=hashAlgorithmData(body);
  assert.throws(()=>RegionExecutionHarness.restore(forged),/exact public shared state/);
});
test('conversion, copying, floating point and BigInt views have independent source receipts',async()=>{
  for(const source of [
    'const a=new Uint8Array("4.9");const assigned=(a[0]=257);a[-1]=9;return [assigned,a[0],a[-1],a.length];',
    'const b=new ArrayBuffer(8),a=new Uint8Array(b);a[2]=7;const part=a.subarray(2,4),copy=b.slice(2,4),c=new Uint8Array(copy);part[0]=9;return [a[2],c[0],part.buffer===a.buffer];',
    'const b=new ArrayBuffer(16),d=new DataView(b),a=new BigInt64Array(b);a[0]="18446744073709551615";d.setFloat64(8,-0,true);return [a[0],1/d.getFloat64(8,true)];',
    'const b=new SharedArrayBuffer(4,{maxByteLength:12}),v=new Int32Array(b),bytes=new Uint8Array(b,0,4);Atomics.store(v,0,257);b.grow(12);return [v.length,bytes.length,bytes[0],v[2]];'
  ]){const result=await verifyProtocolRegionTrainingCase(fixture(source));assert(result.exported,result.reason);}
});
test('independent metadata rejects backing bytes changed outside the returned scalar',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture('const b=new ArrayBuffer(4),a=new Uint8Array(b);a[0]=1;return 7;'));
  assert(result.exported,result.reason);const source=result.exported.sidecar.sourceArtifact.sidecar,mutant=structuredClone(source.archive);
  const corrupt=node=>{if(node?.kind==='array-buffer')node.bytes[3]=17;};
  for(const state of [mutant.initialState,mutant.finalState])for(const node of Object.values(state.heap))corrupt(node);
  for(const event of mutant.events)for(const patch of event.stateChanges)if(patch.table==='heap'){corrupt(patch.before);corrupt(patch.after);}
  const observed=ownedProtocolSourceObservations(mutant,source.referenceInput.source);
  assert.deepEqual(observed.completions,source.reference.observations.completions);
  assert.equal(compareProtocolMetadata(observed.metadata,source.reference.observations.metadata).status,'mismatch');
  assert.throws(()=>compileProtocolSourceV8(mutant),/replay|archive|backing|Checkpoint boundary/);
});
test('memory capability and resource refusals remain outside admitted source evidence',async()=>{
  for(const [source,status]of [['new ArrayBuffer(1025);return 7;','resource_limited'],
    ['new ArrayBuffer(4,{maxByteLength:8});return 7;','unsupported'],
    ['const a=new Uint8Array(4);Atomics.load(a,0);return 7;','unsupported']]){
    const result=await verifyProtocolRegionTrainingCase(fixture(source));assert.equal(result.status,status,result.reason);assert(!result.exported);
  }
});
