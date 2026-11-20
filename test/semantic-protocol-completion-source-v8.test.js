import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {allowsProtocolCompletionDetailV8} from '../src/semantic/protocol-state-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const fixture=body=>({source:'"use strict";function run(){'+body+'}',entry:'run',family:'number-cleanup-source',timeoutMs:30000});
const cases=[
  ['caller-catch','const o={valueOf(){throw 7;}};try{return Number(o);}catch(e){return e+1;}',['num',8]],
  ['caller-finally-override','const o={valueOf(){throw 7;}};try{return Number(o);}finally{return 11;}',['num',11]],
  ['callback-finally-override','const o={valueOf(){try{throw 7;}finally{return 5;}}};return Number(o);',['num',5]],
  ['callback-finally-throws','const o={valueOf(){try{return 3;}finally{throw 9;}}};try{return Number(o);}catch(e){return e+1;}',['num',10]],
  ['nested-conversion-cleanup','let log="";const inner={valueOf(){log+="i";throw 5;}};const outer={valueOf(){try{return Number(inner);}finally{log+="f";}}};try{Number(outer);}catch(e){return log+e;}',['str','if5']],
  ['nested-catch-preserves-outer-return','const o={valueOf(){throw 7;}};try{return 2;}finally{try{Number(o);}catch(e){const handled=e+1;}}',['num',2]],
  ['callback-catches-helper','function fail(){throw 7;}const o={valueOf(){try{return fail();}catch(e){return e-4;}}};return Number(o);',['num',3]],
  ['no-fallback-after-throw','let log="";const o={valueOf(){log+="v";throw 7;},toString(){log+="wrong";return "3";}};try{Number(o);}catch(e){return log+e;}',['str','v7']],
  ['normal-cleanup','let total=0;const o={valueOf(){try{return 3;}finally{total+=10;}}};return Number(o)+total;',['num',13]],
  ['later-conversion','const bad={valueOf(){throw 7;}};const good={valueOf(){return 3;}};try{Number(bad);}catch{}return Number(good);',['num',3]]
];

test('Number callback completion composes with independently checked ordinary catch and finally',async()=>{
  for(const [name,body,expected]of cases){
    const result=await verifyProtocolRegionTrainingCase({...fixture(body),family:name});assert(result.exported,name+': '+result.reason);
    const artifact=result.exported;
    assert.deepEqual(RegionExecutionHarness.replay(artifact).controller.completion,{kind:'return',value:expected},name);
    assert(artifact.sidecar.protocolExtensions.includes('ordinary-completions-source/1'));
    assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
    assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.completionAudit.status,'agreed');
    assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true,name);
  }
});

test('every retained cleanup boundary restores without repeating a conversion or losing an outer completion',async()=>{
  const body='const o={valueOf(){try{throw 7;}finally{const n=2+3;}}};try{return 2;}finally{try{Number(o);}catch(e){const handled=e+1;}}';
  const result=await verifyProtocolRegionTrainingCase(fixture(body));assert(result.exported,result.reason);
  const artifact=result.exported,transfers=artifact.public.timeline.flatMap((row,index)=>
    row.fields?.line?.includes('semantic-handler-scopes/1')?[index]:[]);
  assert(transfers.length>=6);
  assert(artifact.contexts.some(row=>row.state.pending?.handler?.frames?.flatMap(frame=>frame.handlers).some(handler=>
    handler.pending?.kind==='return'&&handler.pending.value[1]===2)));
  for(const index of transfers){
    const prefix=structuredClone(artifact);prefix.public.timeline=prefix.public.timeline.slice(0,index+1);
    const selected=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),packet=JSON.parse(JSON.stringify(selected.checkpoint())),
      restored=RegionExecutionHarness.restore(packet);
    assert.deepEqual(restored.modelContext('invocation1'),selected.modelContext('invocation1'));
    for(const row of artifact.public.timeline.slice(index+1))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    assert.deepEqual(restored.exportEpisode(),artifact.public);
    assert.deepEqual(restored.controller.completion,{kind:'return',value:['num',2]});
  }
  const changed=structuredClone(artifact),context=changed.contexts.find(row=>row.state.pending?.handler?.frames?.some(frame=>
    frame.handlers.some(handler=>handler.pending?.kind==='return')));
  const pending=context.state.pending.handler.frames.flatMap(frame=>frame.handlers).find(handler=>handler.pending?.kind==='return').pending;
  pending.value=['num',99];changed.sidecar.contextDigest=hashAlgorithmData(changed.contexts);
  await assert.rejects(()=>recheckProtocolRegionEvidence(changed),/contexts differs/);
});

test('malformed handler scopes are refused before changing selected state',async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture('const o={valueOf(){throw 7;}};try{Number(o);}catch(e){return e;}'));
  assert(result.exported,result.reason);const artifact=result.exported,index=artifact.public.timeline.findIndex(row=>row.fields?.line?.includes('semantic-handler-scopes/1'));
  const prefix=structuredClone(artifact);prefix.public.timeline=prefix.public.timeline.slice(0,index);
  const selected=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),original=JSON.parse(artifact.public.timeline[index].fields.line.slice(7));
  assert.equal(allowsProtocolCompletionDetailV8(selected.controller,original),true);
  for(const mutate of [
    record=>record.fields.handler.frames[0].invocation='absent',
    record=>record.fields.handler.frames.push(structuredClone(record.fields.handler.frames[0])),
    record=>record.fields.handler.frames[0].handlers[0].pending={kind:'return',value:['num',9]},
    record=>{const h=record.fields.handler.frames[0].handlers[0];h.phase='finally';h.finally=true;h.pending={kind:'throw',value:['ref','absent']};},
    record=>record.fields.handler.frames[0].handlers[0].bytecode=[],
    record=>record.fields.kind='return'
  ]){
    const changed=structuredClone(original);mutate(changed);const before=JSON.stringify(selected.checkpoint());
    assert.throws(()=>selected.select('invocation1',changed));assert.equal(JSON.stringify(selected.checkpoint()),before);
  }
});

test('loop-target and Symbol cleanup remain explicit source refusals',async()=>{
  for(const body of [
    'for(let i=0;i<2;i++){try{break;}finally{const n=1+2;}}return 3;',
    'try{throw Symbol("x");}catch(e){return 3;}'
  ]){
    const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.status,'unsupported');assert(!result.exported);
  }
});
