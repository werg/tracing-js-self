import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {PRIMITIVE_CONVERSION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion.js';
import {PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES} from '../fixtures/semantic-regions/primitive-conversion-composition.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {encode} from '../src/values.js';

const fixtures=[...PRIMITIVE_CONVERSION_FIXTURES,...PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES];
for(const fixture of fixtures.filter(row=>!row.boundary))test('registered source conversion: '+fixture.id,async()=>{
  const result=await verifyProtocolRegionTrainingCase({...fixture,timeoutMs:30000});assert(result.exported,result.reason);
  assert(result.exported.sidecar.protocolExtensions.includes('primitive-conversion-source/1'));
  const replay=RegionExecutionHarness.replay(result.exported);
  if(!Array.isArray(fixture.expectedOwned))assert.deepEqual(replay.controller.completion,{kind:'return',value:encode(fixture.expectedOwned)});
  else{
    const graph=replay.controller.observedGraph(),result=graph.objects.find(row=>row.id===graph.roots.at(-1)[1]);
    assert.equal(result.kind,'array');
    for(const [index,value]of fixture.expectedOwned.entries())assert.deepEqual(result.properties.find(([key])=>key===String(index))[1],encode(value));
  }
  assert.equal(result.exported.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
});

test('every conversion boundary restores the complete nested getter and method continuation',async()=>{
  const fixture=fixtures.find(row=>row.id==='nested-goals'),result=await verifyProtocolRegionTrainingCase(fixture);
  assert(result.exported,result.reason);
  const artifact=result.exported,timeline=artifact.public.timeline;
  const boundaryKinds=new Set();
  for(let index=0;index<timeline.length;index++){
    const line=timeline[index].fields?.line;
    if(!line?.startsWith('protocol '))continue;
    const record=decodeProtocolRecordV8(line);if(!record.kind.startsWith('conversion.'))continue;
    boundaryKinds.add(record.kind);
    const prefix=RegionExecutionHarness.replay({...artifact.public,timeline:timeline.slice(0,index+1)},{requireTerminal:false}),
      packet=JSON.parse(JSON.stringify(prefix.checkpoint())),restored=RegionExecutionHarness.restore(packet);
    assert.deepEqual(restored.modelContext('invocation1'),prefix.modelContext('invocation1'));
    for(const row of timeline.slice(index+1))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    assert.deepEqual(restored.exportEpisode(),artifact.public,'restore must resume only the retained public continuation');
  }
  for(const kind of ['conversion.begin','conversion.lookup','conversion.getter.call','conversion.getter.return',
    'conversion.call','conversion.return','conversion.finish'])assert(boundaryKinds.has(kind),kind);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
});

test('rehashed getter continuation substitutions cannot change captured method or conversion goal',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixtures.find(row=>row.id==='getter-replacement'));
  assert(result.exported,result.reason);
  const timeline=result.exported.public.timeline,index=timeline.findIndex(row=>row.fields?.line?.includes('"kind":"conversion.getter.return"'));
  assert(index>0);
  const prefix=RegionExecutionHarness.replay({...result.exported.public,timeline:timeline.slice(0,index+1)},{requireTerminal:false}),
    packet=JSON.parse(JSON.stringify(prefix.checkpoint()));
  for(const mutate of [row=>{row.goal='Number';},row=>{row.method=['undefined'];},row=>{row.index=0;},row=>{row.phase='finish';}]){
    const changed=structuredClone(packet);mutate(changed.selected.invocations[0][1].state.protocol.primitiveConversions.operations[0]);
    const {integrity,...body}=changed;changed.integrity=hashAlgorithmData(body);
    assert.throws(()=>RegionExecutionHarness.restore(changed),/conversion|exact public shared state|checkpoint/i);
  }
});

test('original intrinsic-fault and engine-disagreement rows remain explicit unqualified source dispositions',async()=>{
  const boundaries=PRIMITIVE_CONVERSION_FIXTURES.filter(row=>row.boundary);
  assert.equal(PRIMITIVE_CONVERSION_FIXTURES.length,16);assert.equal(boundaries.length,5);
  for(const fixture of boundaries){
    const result=await verifyProtocolRegionTrainingCase(fixture);assert(!result.exported);
    assert.equal(result.status,'unsupported');assert.equal(result.regionDisposition,'source-unqualified');
    assert.match(result.reason,fixture.boundary==='intrinsic-error-source-metadata'?/intrinsic conversion fault/:/pinned reference edition/);
  }
});

test('the ordinary V8 entry selects registered conversion and keeps unsupported exotic boundaries closed',async()=>{
  const result=await verifyRegionTrainingCase(fixtures.find(row=>row.id==='key-getter'));
  assert(result.exported,result.reason);assert(result.exported.sidecar.protocolExtensions.includes('primitive-conversion-source/1'));
  for(const body of [
    'const key=new Proxy({toString(){return "x";}},{});return {x:1}[key];',
    'const key=[,];return {"":1}[key];',
    'const key={get [Symbol.toStringTag](){return "Key";}};return {"[object Key]":1}[key];',
    'const key=Object.create(function parent(){});return {"[object Object]":1}[key];',
    'return Number(Object.create(function parent(){}));',
    'return Number(2,3);'
  ]){
    const refused=await verifyProtocolRegionTrainingCase({source:'"use strict";function run(){'+body+'}',entry:'run',family:'conversion-boundary'});
    assert.equal(refused.status,'unsupported',refused.reason);assert(!refused.exported);
  }
});


test('frozen native conversion inputs recheck against the composed source profiles',async()=>{
  const packet=JSON.parse(gunzipSync(Buffer.from(readFileSync(new URL(
    './fixtures/semantic-primitive-conversion-v8.json.gz.b64',import.meta.url),'utf8'),'base64')).toString('utf8'));
  const ids=['getter-replacement','nested-goals','promise-key','mapped-key'],
    cases=packet.cases.filter(row=>ids.includes(row.id));
  assert.deepEqual(cases.map(row=>row.id).sort(),[...ids].sort());
  for(const row of cases){
    assert(row.artifact,row.id+': missing frozen source artifact');
    let checked;
    try{checked=await recheckProtocolRegionEvidence(row.artifact);}
    catch(error){throw new Error(row.id+': '+error.message,{cause:error});}
    for(const flag of ['valid','sourceValidated','projectionValidated','replayValidated'])
      assert.equal(checked[flag],true,row.id+': '+flag);
  }
});
