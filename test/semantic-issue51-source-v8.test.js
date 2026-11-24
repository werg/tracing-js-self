import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {decodeProtocolRecordV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {issue51ObjectFixtures} from '../fixtures/semantic-regions/objects-issue51.js';
import {issue51UnsupportedControls} from '../fixtures/semantic-regions/objects-issue51.js';

const fixture=(body,args=[4])=>({source:'"use strict";function run(x){'+body+'}',entry:'run',args,family:'issue51-property-enumeration-reference'});
const fixtureById=new Map(issue51ObjectFixtures.map(row=>[row.id,row]));
async function checked(body,args=[4]){
  return checkedSource(fixture(body,args));
}
async function checkedFixture(id){
  const selected=fixtureById.get(id);assert(selected,'Unknown issue51 positive source fixture '+id);
  return checkedSource(structuredClone(selected));
}
async function checkedSource(input){
  const result=await verifyProtocolRegionTrainingCase(input);
  assert(result.exported,result.reason);
  const reference=result.exported.sidecar.sourceArtifact.sidecar.reference;
  assert.equal(reference.status,'agreed');
  for(const name of ['operationAudit','branchAudit','completionAudit','metadataAudit'])
    if(reference[name])assert.equal(reference[name].status,'agreed',name);
  return result.exported;
}
const completion=artifact=>RegionExecutionHarness.replay(artifact).controller.completion;

test('all issue51 source members share the frozen original-object ancestor',()=>{
  for(const fixture of [...issue51ObjectFixtures,...issue51UnsupportedControls])
    assert.deepEqual(fixture.ancestorIds,['issue51-original-objects'],fixture.id);
});

test('primitive in operator projects inherited property existence from original source',async()=>{
  const artifact=await checked('const object=Object.create({present:1});return "present" in object;');
  const claims=artifact.sidecar.sourceArtifact.sidecar.compiler.claims.map(row=>row.record);
  assert(claims.some(row=>row.kind==='property.has'&&row.key?.[0]==='str'&&row.key[1]==='present'&&row.result?.[1]===true));
  assert.deepEqual(completion(artifact),{kind:'return',value:['bool',true]});
  const timeline=artifact.public.timeline,at=timeline.findIndex(row=>row.fields.line?.includes('"kind":"property.has"'));
  assert(at>0);const prefix={...artifact.public,timeline:timeline.slice(0,at)};
  const harness=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(RegionExecutionHarness.replay(prefix,{requireTerminal:false}).checkpoint())));
  const selected=decodeProtocolRecordV8(timeline[at].fields.line),before=sharedRegionState(harness.controller);
  for(const changed of [
    {...selected,object:'forged'},
    {...selected,key:['str','absent']},
    {...selected,result:['bool',false]}
  ]){
    assert.throws(()=>harness.select(timeline[at].fields.invocationId,encodeProtocolRecordV8(changed),{entry:timeline[at].fields.entry??null}));
    assert.deepEqual(sharedRegionState(harness.controller),before);
  }
  for(const row of timeline.slice(at))harness.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(harness.controller),sharedRegionState(RegionExecutionHarness.replay(artifact).controller));
  const forged=structuredClone(artifact),sourceArtifact=forged.sidecar.sourceArtifact,
    propertyClaim=sourceArtifact.sidecar.compiler.claims.find(row=>row.record.kind==='property.has'),
    alternate=sourceArtifact.sidecar.compiler.claims.find(row=>row.record.kind==='property.define')?.record.object;
  assert(propertyClaim&&alternate&&alternate!==propertyClaim.record.object);
  const plausible=RegionExecutionHarness.replay(prefix,{requireTerminal:false});
  assert.doesNotThrow(()=>plausible.select(timeline[at].fields.invocationId,
    encodeProtocolRecordV8({...selected,object:alternate}),{entry:timeline[at].fields.entry??null}));
  propertyClaim.record.object=alternate;
  propertyClaim.line=encodeProtocolRecordV8(propertyClaim.record);
  assert.deepEqual(decodeProtocolRecordV8(propertyClaim.line),propertyClaim.record);
  forged.sidecar.sourceArtifactDigest=hashAlgorithmData(sourceArtifact);
  await assert.rejects(()=>recheckProtocolRegionEvidence(forged),/source|projection|claim|target|ownership/i);
});

test('in and Reflect.has preserve receiver, effectful operand order, Symbols and accessor non-observation',async()=>{
  const artifact=await checkedFixture('issue51-has-in-reflect-symbol-accessor'),claims=artifact.sidecar.sourceArtifact.sidecar.compiler.claims;
  const has=claims.map(row=>row.record).filter(row=>row.kind==='property.has');
  assert.equal(has.length,2);
  assert.deepEqual(has.map(row=>row.result),[['bool',true],['bool',true]]);
  assert(has.every(row=>typeof row.object==='string'&&row.object.length>0));
  assert(has.some(row=>row.key?.[0]==='symbol'));
  const value=RegionExecutionHarness.replay(artifact).controller.materialize(completion(artifact).value);
  assert.deepEqual(value,[true,true,['key','receiver','receiver']]);
});

test('object-valued in keys convert once after evaluating a valid right operand',async()=>{
  const artifact=await checkedFixture('issue51-in-object-key-to-primitive-order');
  const value=RegionExecutionHarness.replay(artifact).controller.materialize(completion(artifact).value);
  assert.deepEqual(value,[true,['receiver','string']]);
});

test('computed deletion retains its object-key conversion site and runs the key hook once',async()=>{
  const artifact=await checked('const log=[];const object={x:1};'+
    'const key={[Symbol.toPrimitive](hint){log.push(hint);return "x";}};'+
    'const removed=delete object[key];return [removed,"x" in object,log];');
  const value=RegionExecutionHarness.replay(artifact).controller.materialize(completion(artifact).value);
  assert.deepEqual(value,[true,false,['string']]);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('Reflect object keys project conversion and property operations at the original call sites',async()=>{
  const artifact=await checkedFixture('issue51-reflect-object-key-getter-and-argument-order');
  const controller=RegionExecutionHarness.replay(artifact).controller;
  assert.deepEqual(controller.materialize(controller.completion.value),
    [true,true,false,['extra','getter','string','extra','getter','string']]);
  const records=artifact.sidecar.sourceArtifact.sidecar.compiler.claims.map(row=>row.record);
  assert.equal(records.filter(row=>row.kind==='conversion.begin').length,2);
  assert.equal(records.filter(row=>row.kind==='property.delete').length,1);
  assert.equal(records.filter(row=>row.kind==='property.has').length,2);
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('invalid in RHS projects an authenticated TypeError before key coercion',async()=>{
  const fixture=fixtureById.get('issue51-control-in-invalid-rhs-before-key-coercion');
  assert(fixture);
  const oracle=vm.runInNewContext(fixture.source+';run(4)');
  assert.deepEqual(structuredClone(oracle),[true,[]]);
  const artifact=await checkedSource(structuredClone(fixture)),claims=artifact.sidecar.sourceArtifact.sidecar.compiler.claims.map(row=>row.record),
    faults=claims.filter(row=>row.kind==='property.fault');
  assert.equal(faults.length,1);
  assert.deepEqual(faults[0].target,['null']);
  assert.equal(faults[0].operation,'has');
  assert.equal(typeof faults[0].error,'string');
  assert.equal(claims.some(row=>row.kind==='conversion.begin'),false);
  const controller=RegionExecutionHarness.replay(artifact).controller;
  assert.equal(controller.heap.get(faults[0].error)?.declaredError,'TypeError');
  assert.deepEqual(controller.materialize(completion(artifact).value),[true,[]]);
  assert(artifact.sidecar.sourceArtifact.sidecar.reference.observations.metadata.some(row=>row.objects
    .some(node=>node.kind==='error'&&node.errorType==='TypeError')));
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('invalid in RHS preserves earlier operand effects and caught error identity',async()=>{
  const artifact=await checkedFixture('issue51-invalid-in-rhs-caught-error-identity-partial-effects'),
    controller=RegionExecutionHarness.replay(artifact).controller,
    claims=artifact.sidecar.sourceArtifact.sidecar.compiler.claims.map(row=>row.record),
    faults=claims.filter(row=>row.kind==='property.fault');
  assert.deepEqual(controller.materialize(completion(artifact).value),[true,'TypeError',['left','right','caught']]);
  assert.equal(faults.length,1);assert.deepEqual(faults[0].target,['null']);
  assert.equal(claims.some(row=>row.kind==='conversion.begin'),false);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('caught TypeError identity survives mutable name and message writes',async()=>{
  const artifact=await checked('const events=[];const key={[Symbol.toPrimitive](){events.push("key");return "p";}};'+
    'try{key in null;}catch(error){const alias=error;error.name="changed";error.message="changed";'+
    'return [alias===error,error.name,error.message,events];}return [false];');
  const controller=RegionExecutionHarness.replay(artifact).controller;
  assert.deepEqual(controller.materialize(completion(artifact).value),[true,'changed','changed',[]]);
  const records=artifact.sidecar.sourceArtifact.sidecar.compiler.claims.map(row=>row.record);
  const fault=records.find(row=>row.kind==='property.fault');assert(fault);
  assert.equal(records.filter(row=>row.kind==='property.set'&&row.object===fault.error).length,2);
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('for-in snapshots candidates, skips deleted keys, ignores additions, and checks live inherited fallback',async()=>{
  const artifact=await checkedFixture('issue51-for-in-delete-fallback-addition');
  assert.equal(completion(artifact).kind,'return');
  const value=RegionExecutionHarness.replay(artifact).controller.materialize(completion(artifact).value);
  assert.deepEqual(value,['a','b','c']);
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
});

test('for-in can observe new enumerable inherited fallback and omits a key deleted before its turn',async()=>{
  const artifact=await checkedFixture('issue51-for-in-delete-prototype-candidate');
  const value=RegionExecutionHarness.replay(artifact).controller.materialize(completion(artifact).value);
  assert.deepEqual(value,['a','b']);
  const rows=artifact.public.timeline.map(row=>row.fields.line).filter(line=>typeof line==='string'&&line.includes('enumeration.next'));
  assert(rows.length>=3);
});

test('delete expressions expose strict completion and delete records distinguish own from inherited keys',async()=>{
  const artifact=await checkedFixture('issue51-delete-own-and-inherited');
  const value=RegionExecutionHarness.replay(artifact).controller.materialize(completion(artifact).value);
  assert.deepEqual(value,[true,true,false,true]);
  const records=artifact.sidecar.sourceArtifact.sidecar.compiler.claims.map(row=>row.record).filter(row=>row.kind==='property.delete');
  assert.equal(records.length,2);
  assert(records.every(row=>typeof row.object==='string'&&row.key?.[0]==='str'&&typeof row.success==='boolean'));
});

test('restored enumeration checkpoint rejects forged receiver, key and outcome without state changes',async()=>{
  const artifact=await checkedFixture('issue51-for-in-sparse-array');
  const timeline=artifact.public.timeline,at=timeline.findIndex(row=>row.fields.line?.includes('"kind":"enumeration.next"'));
  assert(at>0);const prefix={...artifact.public,timeline:timeline.slice(0,at)};
  const harness=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(RegionExecutionHarness.replay(prefix,{requireTerminal:false}).checkpoint())));
  const selected=decodeProtocolRecordV8(timeline[at].fields.line),before=sharedRegionState(harness.controller);
  for(const changed of [
    {...selected,object:'forged'},
    {...selected,result:['str','forged']},
    {...selected,done:!selected.done}
  ]){
    assert.throws(()=>harness.select(timeline[at].fields.invocationId,encodeProtocolRecordV8(changed),{entry:timeline[at].fields.entry??null}));
    assert.deepEqual(sharedRegionState(harness.controller),before);
  }
  for(const row of timeline.slice(at))harness.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(harness.controller),sharedRegionState(RegionExecutionHarness.replay(artifact).controller));
  assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
});

test('issue51 original fixtures preserve sparse length, delete failure, key order, accessor and Symbol behavior',async()=>{
  const cases=[
    ['issue51-reflect-delete-property',[true,true,false,true]],
    ['issue51-sparse-array-delete-preserves-length-and-holes',[true,4,false,false,true]],
    ['issue51-reflect-delete-nonconfigurable-returns-false',[false,true]],
    ['issue51-delete-and-readd-changes-key-order',['a','c','b']],
    ['issue51-existence-distinguishes-missing-undefined-accessor',[false,true,true,0]],
    ['issue51-delete-symbol-key',[true,true,false]],
    ['issue51-delete-own-tostring-reveals-intrinsic',[true,true,true]],
    ['issue51-delete-accessor-without-getter-call',[true,true,false,0]],
    ['issue51-for-in-sparse-array',['1','4']],
    ['issue51-accessor-existence-enumeration-no-read',[true,['value','other'],0]],
    ['issue51-for-in-delete-fallback-addition',['a','b','c']],
    ['issue51-for-in-delete-prototype-candidate',['a','b']],
    ['issue51-delete-inherited-for-in-candidate',['first','b']],
    ['issue51-reflect-object-key-symbol',[true,true,false,['string','string']]],
    ['issue51-promise-reflect-object-key',[true,true,false,['string','string']]],
    ['issue51-promise-property-composition',[true,true,true,false]],
    ['issue51-promise-enumeration-mutation-composition',['a']],
    ['issue51-promise-object-key-conversion-composition',[true,['string']]],
    ['issue51-promise-symbol-and-escaped-string-keys',[true,true,false,true,9]]
  ];
  for(const [id,expected] of cases){
    const artifact=await checkedFixture(id),actual=RegionExecutionHarness.replay(artifact).controller.materialize(completion(artifact).value);
    assert.deepEqual(actual,expected,id);
  }
});

for(const id of ['issue51-invalid-in-message-object-no-conversion','issue51-invalid-in-message-symbol',
  'issue51-invalid-in-message-negative-zero','issue51-invalid-in-message-null-prototype'])
  test(id+' derives the native diagnostic from authenticated operands',async()=>{
    const artifact=await checkedFixture(id),controller=RegionExecutionHarness.replay(artifact).controller;
    const row=fixtureById.get(id),expected=structuredClone(vm.runInNewContext(row.source+';run(4)'));
    assert.deepEqual(controller.materialize(controller.completion.value),expected);
    assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
  });

for(const id of ['issue51-control-for-in-prototype-replacement','issue51-for-in-replaced-prototype-live-existence',
  'issue51-for-in-removed-prototype-skips-candidate','issue51-for-in-flags-retain-original-candidates',
  'issue51-for-in-initial-nonenumerable-shadow-survives'])
  test(id+' preserves captured order with live prototype existence',async()=>{
    const artifact=await checkedFixture(id),controller=RegionExecutionHarness.replay(artifact).controller;
    const row=fixtureById.get(id),expected=structuredClone(vm.runInNewContext(row.source+';run(4)'));
    assert.deepEqual(controller.materialize(controller.completion.value),expected);
    assert.equal((await recheckProtocolRegionEvidence(artifact)).valid,true);
  });
