import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness as w,validateHarnessRecord} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {SemanticController} from '../src/training/controller.js';

const num=value=>['num',value];
const next=state=>(Math.imul(state,1664525)+1013904223)>>>0;
const finish=(h,id,value)=>{
  h.selected(id,w('return',{value}));
  h.selected(id,w('end',{kind:'return'}));
};
const rehash=packet=>{
  const {integrity,...body}=packet;
  packet.integrity=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return packet;
};

test('current public artifacts reject version four even when no random seed is used',()=>{
  const h=new SelectedExecutionHarness();
  h.publishProgram({programId:'plain',source:'function run(){return 1;}',entry:'run'});
  h.admitInvocation({programId:'plain',invocationId:'call',realmId:'realm',trackId:'worker',triggerId:'outside'});
  finish(h,'call',num(1));
  const current=h.exportEpisode();
  assert.equal(current.public.schema,'semantic-execution/5');
  assert.equal(current.public.traceFormat,'semantic-trace/5');
  assert.equal(current.public.contextFormat,'semantic-context/5');
  for(const field of ['schema','traceFormat','contextFormat']){
    const old=structuredClone(current);
    old.public[field]=old.public[field].replace('/5','/4');
    assert.throws(()=>SelectedExecutionHarness.replay(old),/version|contract|format/i);
  }
  const oldProgram={...current.public.timeline[0],schema:'semantic-execution/4'};
  assert.throws(()=>validateHarnessRecord(oldProgram),/schema|version/i);
  const oldCheckpoint=rehash({...h.checkpoint(),schema:'semantic-checkpoint/4'});
  assert.throws(()=>SelectedExecutionHarness.restore(oldCheckpoint),/checkpoint version/i);
  const oldContinuation={...h.invocations.get('call').controller.segmentPacket(),schema:'semantic-continuation/4'};
  assert.throws(()=>SemanticController.fromPacket(oldContinuation),/packet version/i);
});

test('unseeded selected state explicitly carries null and rejects missing or malformed random state',()=>{
  const h=new SelectedExecutionHarness();
  h.publishProgram({programId:'plain',source:'function run(){return 1;}',entry:'run'});
  h.admitInvocation({programId:'plain',invocationId:'call',realmId:'realm',trackId:'worker',triggerId:'outside'});
  h.restoreSource('worker','plain');
  const receipt=h.recordModelContext('call',[],{includeState:true});
  assert.equal(receipt.selectedState.schema,'semantic-continuation/5');
  assert.equal(receipt.selectedState.randomState,null);
  for(const value of [undefined,true,-1,4294967296,0.5]){
    const invalid=structuredClone(receipt);
    if(value===undefined)delete invalid.selectedState.randomState;
    else invalid.selectedState.randomState=value;
    assert.throws(()=>validateHarnessRecord(invalid),/state|context|continuation/i);
    const packet=h.invocations.get('call').controller.segmentPacket();
    if(value===undefined)delete packet.randomState;
    else packet.randomState=value;
    assert.throws(()=>SemanticController.fromPacket(packet),/random state/i);
  }
  finish(h,'call',num(1));
  const forged=h.exportEpisode();
  forged.public.timeline.find(item=>item.kind==='model-context').selectedState.randomState=0;
  assert.throws(()=>SelectedExecutionHarness.replay(forged),/Replay|context|fields/i);
});

test('resumed parent publishes the current realm random state after the child draw leaves bounded history',async()=>{
  let resolveRead;
  const source='async function run(){Math.random();await host.readAsync("x");return Math.random();} '+
    'function child(){const value=Math.random();for(let i=0;i<130;i++){i+1;}return value;}';
  const h=new SelectedExecutionHarness({services:{'demo.readAsync':()=>new Promise(resolve=>{resolveRead=resolve;})}});
  h.publishProgram({programId:'random',source,entry:'run',randomSeed:0,capabilities:['demo.readAsync']});
  h.admitInvocation({programId:'random',invocationId:'parent',realmId:'realm',trackId:'worker:parent',
    triggerId:'outside',realmPolicy:'retained',completionPolicy:'await-returned-promise'});
  const first=next(0),second=next(first),third=next(second);
  h.selected('parent',w('compute',{expr:{op:'random'},result:num(first/2**32)}));
  h.selected('parent',w('promise',{action:'create',promise:'proot'}));
  const site=analyzeSemanticProgram(source).sites.find(item=>item.operation==='demo.readAsync');
  h.selected('parent',w('request',{effect:'read',operation:'demo.readAsync',invocation:'parent',
    site:{start:site.start,end:site.end},arguments:[['str','x']],payload:'["x"]',promise:'pread'}));
  const pending=h.dispatch('parent','read');
  h.selected('parent',w('await',{promise:'pread',continuation:'resume',invocation:'parent',returnPromise:'proot'}));
  h.admitInvocation({programId:'random',entry:'child',invocationId:'child',realmId:'realm',trackId:'worker:child',
    triggerId:'nested',parentInvocationId:'parent',realmPolicy:'retained'});
  h.selected('child',w('compute',{expr:{op:'random'},result:num(second/2**32)}));
  for(let i=0;i<130;i++)h.selected('child',w('compute',{
    expr:{op:'binary',operator:'+',left:{op:'literal',value:num(i)},right:{op:'literal',value:num(1)}},result:num(i+1)}));
  finish(h,'child',num(second/2**32));
  assert.equal(h.invocations.get('parent').controller.randomState,first,'the suspended controller retains its earlier stream position');
  assert.equal(h.selectionContext('parent').selectedState.randomState,second,'the model sees the current shared stream');
  assert(h.timeline.slice(-128).every(item=>!item.line?.includes('"op":"random"')),
    'the latest random witness is outside the bounded prior history');
  const refreshed=h.prepareModelContext('parent');
  assert.equal(refreshed.selectedState.randomState,second);
  await Promise.resolve();await Promise.resolve();
  resolveRead(0);await pending;
  h.selected('parent',w('resume',{continuation:'resume',invocation:'parent',status:'fulfilled',result:num(0)}));
  h.selected('parent',w('compute',{expr:{op:'random'},result:num(third/2**32)}));
  h.selected('parent',w('promise',{action:'resolve',promise:'proot',value:num(third/2**32)}));
  finish(h,'parent',['ref','proot']);
  const exported=h.exportEpisode();
  assert.deepEqual(SelectedExecutionHarness.replay(exported).timeline,h.timeline);
  const forged=structuredClone(exported);
  forged.public.timeline.find(item=>item.kind==='model-context').selectedState.randomState=first;
  assert.throws(()=>SelectedExecutionHarness.replay(forged),/Replay|context|fields/i);
  const packet=h.checkpoint();
  packet.timeline.find(item=>item.kind==='model-context').selectedState.randomState=first;
  assert.throws(()=>SelectedExecutionHarness.restore(rehash(packet)),/Replay|context|fields/i);
});
