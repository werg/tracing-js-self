import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const source='"use strict";function run(key){const current=host.readAsync(key); const next=current+1; host.store(key,next); return next;}';
const site=operation=>{
  const found=analyzeSemanticProgram(source).sites.find(s=>s.operation===operation);
  assert(found,'missing grounded source operation '+operation);
  return {start:found.start,end:found.end};
};
const req=(effect,operation,args,payload)=>
  encodeWitness('request',{effect,operation,invocation:'i1',site:site(operation),
    arguments:args,payload});
const tag=n=>['num',n];
const selectedValue=(h,invocation,value)=>{
  h.selected(invocation,encodeWitness('return',{value:tag(value)}));
  h.selected(invocation,encodeWitness('end',{kind:'return'}));
};

test('source is published once, two explicit outside calls dispatch one action each',async()=>{
  const receipts=[],store=new Map([['a',7],['b',11]]);
  const harness=new SelectedExecutionHarness({services:{
    'demo.readAsync':async ([key],meta)=>{receipts.push(['read',meta.idempotencyKey]);return store.get(key);},
    'demo.store':([key,value],meta)=>{receipts.push(['write',meta.idempotencyKey]);store.set(key,value);}
  }});
  harness.publishProgram({programId:'counter',source,entry:'run',
    capabilities:['demo.readAsync','demo.store']});
  for(const [invocation,key,next] of [['call1','a',8],['call2','b',12]]){
    harness.admitInvocation({programId:'counter',invocationId:invocation,
      trackId:'worker:'+invocation,realmId:'realm:'+invocation,
      triggerId:'outside:'+invocation,args:[key]});
    harness.selected(invocation,req('read1','demo.readAsync',[['str',key]],JSON.stringify([key])));
    const result=await harness.dispatch(invocation,'read1');
    assert.equal(result.status,'fulfilled');
    assert.deepEqual(result.result,tag(next-1));
    harness.selected(invocation,encodeWitness('compute',{expr:{op:'binary',operator:'+',
      left:{op:'literal',value:tag(next-1)},right:{op:'literal',value:tag(1)}},
      result:tag(next)}));
    harness.selected(invocation,req('write1','demo.store',[['str',key],tag(next)],
      JSON.stringify([key,next])));
    const written=await harness.dispatch(invocation,'write1');
    assert.equal(written.status,'fulfilled');
    selectedValue(harness,invocation,next);
    assert.match(harness.inspect(invocation).join('\n'),/observe read1 fulfilled/);
    assert.equal(harness.invocations.get(invocation).controller.completion.value[1],next);
  }
  assert.deepEqual([...store],[['a',8],['b',12]]);
  assert.equal(receipts.length,4);
  assert.equal(harness.timeline.filter(x=>x.kind==='program').length,1);
  assert.equal(harness.timeline.filter(x=>x.kind==='invocation').length,2);
  const count=receipts.length;
  const duplicate=await harness.dispatch('call1','read1');
  assert.equal(duplicate.status,'fulfilled','repeat dispatch gets the same committed outcome');
  assert.equal(receipts.length,count,'repeat dispatch must never reinvoke the native adapter');
});

test('partial or ungrounded selection does not dispatch or corrupt selected state',()=>{
  let calls=0;
  const h=new SelectedExecutionHarness({services:{
    'demo.readAsync':()=>{calls++;return 2;}
  }});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'p',invocationId:'i',realmId:'r',
    trackId:'dynamic:9',triggerId:'outside:1',args:['x']});
  const packet=h.invocations.get('i').controller.segmentPacket();
  assert.throws(()=>h.selected('i','request {"effect":'),/Invalid|Malformed|JSON/);
  assert.throws(()=>h.selected('i',req('fx1','demo.readAsync',
    [['str','x']],'["forged"]')),/payload|arguments/i);
  assert.deepEqual(h.invocations.get('i').controller.segmentPacket(),packet);
  assert.equal(h.intents.size,0);assert.equal(calls,0);
  assert.throws(()=>h.selected('i',encodeWitness('observe',{
    effect:'fx1',status:'fulfilled',result:tag(2)})),/observation|selected/i);
  assert.throws(()=>h.dispatch('i','fx1'),/committed/);
});

test('two pending async tools may settle in opposite order',async()=>{
  const responses={};
  const h=new SelectedExecutionHarness({services:{
    'demo.readAsync':([key])=>new Promise(resolve=>{responses[key]=resolve;})
  }});
  const pairSource='function run(){const a=host.readAsync("a");const b=host.readAsync("b");return 1;}';
  const sites=analyzeSemanticProgram(pairSource).sites.filter(s=>s.operation==='demo.readAsync');
  assert.equal(sites.length,2);
  h.publishProgram({programId:'pair',source:pairSource,entry:'run',
    capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'pair',invocationId:'i',trackId:'t9',
    realmId:'r1',triggerId:'direct1'});
  for(const [n,key] of [['f1','a'],['f2','b']]){
    const s=sites[key==='a'?0:1];
    h.selected('i',encodeWitness('request',{effect:n,operation:'demo.readAsync',
      invocation:'i1',site:{start:s.start,end:s.end},
      arguments:[['str',key]],payload:JSON.stringify([key])}));
  }
  const one=h.dispatch('i','f1'),two=h.dispatch('i','f2');
  await Promise.resolve();await Promise.resolve();
  assert.equal(typeof responses.a,'function');assert.equal(typeof responses.b,'function');
  responses.b(4);await two;responses.a(2);await one;
  assert.deepEqual(h.timeline.filter(x=>x.kind==='result').map(x=>x.effectId),['f2','f1']);
  selectedValue(h,'i',1);
});

test('restoration preserves uncertain intent and does not replay native side effects',async()=>{
  let resolve,invoked=0;
  const service={ 'demo.readAsync':()=>{invoked++;return new Promise(r=>{resolve=r;});} };
  const h=new SelectedExecutionHarness({services:service});
  h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'p',invocationId:'i',trackId:'t0',
    realmId:'r1',triggerId:'call1',args:['counter']});
  h.selected('i',req('fx','demo.readAsync',[['str','counter']],'["counter"]'));
  const pending=h.dispatch('i','fx');
  const restored=SelectedExecutionHarness.restore(h.checkpoint(),{services:service});
  assert.throws(()=>restored.dispatch('i','fx'),/uncertain/);
  assert.equal(invoked,0);
  await Promise.resolve();assert.equal(invoked,1);
  restored.deliverResult('i','fx',{status:'fulfilled',value:5});
  selectedValue(restored,'i',5);
  assert.equal(invoked,1);
  resolve(5);await pending;
  assert.equal(restored.invocations.get('i').controller.completion.value[1],5);
});

test('exact replay verifies public causal selected records without invoking any native adapter',async()=>{
  let executions=0;
  const h=new SelectedExecutionHarness({sessionId:'replay1',services:{
    'demo.readAsync':([key])=>{executions++;assert.equal(key,'counter');return 7;}
  }});
  h.publishProgram({programId:'counter',source,entry:'run',
    capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'counter',invocationId:'call1',
    realmId:'realm1',trackId:'worker:1',triggerId:'outside:1',args:['counter']});
  h.selected('call1',req('fx1','demo.readAsync',
    [['str','counter']],'["counter"]'));
  await h.dispatch('call1','fx1');
  selectedValue(h,'call1',7);
  const exported=h.exportEpisode();
  const original=executions;
  const replay=SelectedExecutionHarness.replay(exported);
  assert.equal(executions,original,'archive validation cannot repeat native effects');
  assert.deepEqual(replay.timeline,h.timeline,'all receipt bytes and causal records agree');
  assert.equal(replay.invocations.get('call1').controller.completion.value[1],7);
  assert.throws(()=>replay.dispatch('call1','fx1'),/redispatch/);
  assert.equal(replay.exportEpisode().sidecar.admission,'locally_verified');
  const forbidden=structuredClone(exported);
  forbidden.public.timeline.find(x=>x.kind==='semantic').mode='observed';
  assert.throws(()=>SelectedExecutionHarness.replay(forbidden),/Replay|observed|sequence/i);
  const reorder=structuredClone(exported);
  const index=reorder.public.timeline.findIndex(x=>x.kind==='result');
  [reorder.public.timeline[index],reorder.public.timeline[index-1]]=[
    reorder.public.timeline[index-1],reorder.public.timeline[index]
  ];
  assert.throws(()=>SelectedExecutionHarness.replay(reorder),/Replay|cause|sequence/i);
  const mismatched=structuredClone(exported);
  mismatched.public.timeline.find(x=>x.kind==='result').result=['num',99];
  assert.throws(()=>SelectedExecutionHarness.replay(mismatched),/Recorded result/);
  const uncommitted=structuredClone(exported);
  uncommitted.public.timeline=uncommitted.public.timeline.filter(x=>x.kind!=='dispatch');
  assert.throws(()=>SelectedExecutionHarness.replay(uncommitted),/Replay result|dispatched cause/i);
});
