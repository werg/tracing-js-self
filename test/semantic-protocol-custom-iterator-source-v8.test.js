import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

const fixture=body=>({source:'"use strict";function run(){'+body+'}',entry:'run',family:'custom-iterator-source',timeoutMs:30000});
const cases=[
  ['cached-next','let gets=0;let calls=0;let next=function(){calls++;this.next=()=>{throw 99;};return {done:calls>2,value:this.marker+calls};};const it={marker:10,get next(){gets++;return next;},set next(v){next=v;}};const xs={[Symbol.iterator](){return it;}};let out="";for(const n of xs)out+=n;return out+":"+gets;',['str','1112:1']],
  ['acquisition-receiver','const it={i:0,next(){return {done:this.i++>0,value:8};}};const xs={selected:it,[Symbol.iterator](){return this.selected;}};let out=0;for(const n of xs)out+=n;return out;',['num',8]],
  ['break-closes','let log="";const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){log+="c";return {};}};for(const n of it){log+=n;break;}return log;',['str','1c']],
  ['body-finally-before-close','let log="";const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){log+="c";return {};}};function f(){for(const n of it){try{return 3;}finally{log+="f";}}}return f()+log;',['str','3fc']],
  ['throw-precedes-close-failure','let log="";const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){log+="c";throw 9;}};try{for(const n of it){throw 7;}}catch(e){return log+e;}',['str','c7']],
  ['break-replaced-by-close-failure','const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){throw 9;}};try{for(const n of it){break;}}catch(e){return e;}',['num',9]],
  ['throw-precedes-return-getter-failure','let log="";const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},get return(){log+="g";throw 9;}};try{for(const n of it){throw 7;}}catch(e){return log+e;}',['str','g7']],
  ['next-failure-does-not-close','let closed=0;const it={[Symbol.iterator](){return this;},next(){throw 7;},return(){closed++;return {};}};try{for(const n of it){}}catch(e){return closed+":"+e;}',['str','0:7']],
  ['done-failure-does-not-close','let log="";const it={[Symbol.iterator](){return this;},next(){return {get done(){log+="d";throw 7;},get value(){log+="wrong";return 1;}};},return(){log+="wrong";return {};}};try{for(const n of it){}}catch(e){return log+e;}',['str','d7']],
  ['value-failure-does-not-close','let log="";const it={[Symbol.iterator](){return this;},next(){return {done:false,get value(){log+="v";throw 7;}};},return(){log+="wrong";return {};}};try{for(const n of it){}}catch(e){return log+e;}',['str','v7']],
  ['close-getter-and-receiver','let log="";const it={mark:5,[Symbol.iterator](){return this;},next(){return {done:false,value:1};},get return(){log+="g";return function(){log+=this.mark;return {};};}};for(const n of it){break;}return log;',['str','g5']],
  ['null-return-is-absent','const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return:null};for(const n of it){break;}return 3;',['num',3]],
  ['continue-and-exhaustion-do-not-close','let log="";const it={i:0,[Symbol.iterator](){return this;},next(){return {done:this.i===3,value:this.i++};},return(){log+="wrong";return {};}};for(const n of it){if(n<2)continue;log+=n;}return log;',['str','2']],
  ['nested-labeled-break','let log="";function make(name){return {[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){log+=name;return {};}};}outer:for(const a of make("o")){for(const b of make("i")){break outer;}}return log;',['str','io']],
  ['continue-outer-closes-inner-only','let log="";function make(name){let i=0;return {[Symbol.iterator](){return this;},next(){return {done:i++===2,value:1};},return(){log+=name;return {};}};}outer:for(const a of make("o")){for(const b of make("i")){continue outer;}}return log;',['str','ii']],
  ['number-throw-during-close','const o={valueOf(){throw 9;}};const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){Number(o);return {};}};try{for(const n of it){throw 7;}}catch(e){return e;}',['num',7]]
];

test('custom for-of independently checks acquisition, cached receiver, completion and IteratorClose ordering',async()=>{
  for(const [name,body,expected]of cases){
    const result=await verifyProtocolRegionTrainingCase({...fixture(body),family:name});assert(result.exported,name+': '+result.reason);
    const artifact=result.exported;
    assert.deepEqual(RegionExecutionHarness.replay(artifact).controller.completion,{kind:'return',value:expected},name);
    assert(artifact.sidecar.protocolExtensions.includes('custom-iterator-source/1'));
    const reference=artifact.sidecar.sourceArtifact.sidecar.reference;
    assert.equal(reference.extensionAudit.status,'agreed');assert.equal(reference.completionAudit.status,'agreed');
    const observations=reference.observations.extensions.find(row=>row.profile==='custom-iterator-observations/1').rows;
    if(name==='cached-next'){
      assert.equal(observations.filter(row=>row.kind==='read'&&row.operation==='next').length,1);
      const calls=observations.filter(row=>row.kind==='call'&&row.operation==='next');assert.equal(calls.length,3);
      for(const call of calls){assert.deepEqual(call.method,calls[0].method);assert.deepEqual(call.receiver,calls[0].receiver);}
    }
    if(name.endsWith('does-not-close')||name==='continue-and-exhaustion-do-not-close')
      assert.equal(observations.filter(row=>row.operation==='return').length,0,name);
  }
});

test('nested close callbacks retain exact loop targets and pending completion across every checkpoint',async()=>{
  const selectedCase=cases.find(row=>row[0]==='nested-labeled-break'),result=await verifyProtocolRegionTrainingCase(fixture(selectedCase[1]));
  assert(result.exported,result.reason);const artifact=result.exported;
  assert.equal((await recheckProtocolRegionEvidence(artifact)).sourceValidated,true);
  const rows=artifact.public.timeline;
  const boundaries=rows.flatMap((row,index)=>row.fields?.line?.includes('semantic-handler-scopes/1')||row.fields?.line?.includes('"kind":"call"')?[index]:[]);
  assert(boundaries.length>10);assert(artifact.contexts.some(row=>row.state.pending?.handler?.frames.some(frame=>
    frame.handlers.some(handler=>handler.pending?.kind==='break'&&handler.pending.target))));
  for(const index of boundaries){
    const prefix=structuredClone(artifact);prefix.public.timeline=rows.slice(0,index+1);
    const selected=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(selected.checkpoint())));
    assert.deepEqual(restored.modelContext('invocation1'),selected.modelContext('invocation1'));
    for(const row of rows.slice(index+1))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    assert.deepEqual(restored.exportEpisode(),artifact.public);
    assert.deepEqual(restored.controller.completion,{kind:'return',value:['str','io']});
  }
  const index=rows.findIndex(row=>row.fields?.line?.includes('"target":"target'));
  assert(index>0);const prefix=structuredClone(artifact);prefix.public.timeline=rows.slice(0,index);
  const harness=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),record=JSON.parse(rows[index].fields.line.slice(7));
  for(const mutate of [
    scope=>{scope.frames.flatMap(frame=>frame.handlers).find(handler=>handler.pending?.target).pending.target='missing';},
    scope=>{scope.frames.flatMap(frame=>frame.handlers).find(handler=>handler.pending?.target).pending.value=['num',1];},
    scope=>{const frame=scope.frames.find(frame=>frame.targets?.length);frame.targets.push(structuredClone(frame.targets[0]));},
    scope=>{scope.frames.find(frame=>frame.targets?.length).targets[0].targetPc=12;}
  ]){
    const changed=structuredClone(record);mutate(changed.fields.handler);const before=JSON.stringify(harness.checkpoint());
    assert.throws(()=>harness.select('invocation1',changed));assert.equal(JSON.stringify(harness.checkpoint()),before);
  }
});

test('unrepresented intrinsic iterator errors and generator cleanup remain explicit source refusals',async()=>{
  for(const body of [
    'const it={[Symbol.iterator](){return this;},next(){return 1;}};for(const n of it){}',
    'const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){return 3;}};for(const n of it){break;}',
    'const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return:3};for(const n of it){break;}',
    'function* g(){const it={[Symbol.iterator](){return this;},next(){return {done:true};}};for(const n of it){yield n;}}return g().next().done;'
  ]){const result=await verifyProtocolRegionTrainingCase(fixture(body));assert.equal(result.status,'unsupported',result.reason);assert(!result.exported);}
});
