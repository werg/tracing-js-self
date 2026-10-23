import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase} from '../src/training/admit.js';
import {SemanticController} from '../src/training/controller.js';
import {decodeRecord,restoreLines,encodeRecord} from '../src/training/format.js';

const strict=code=>'"use strict";\n'+code;
function rollout(program,args=[]){
  const result=verifyTrainingCase({source:strict(program),entry:'f',args});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const groups=result.exported.public.groups;
  const first=groups.findIndex(g=>g.mode==='generated');
  const source=restoreLines(groups.slice(0,first).map(g=>g.events[0].record));
  const controller=new SemanticController(source);
  for(const group of groups.slice(first)){
    const event=group.events[0];
    if(group.mode==='generated')controller.commitGenerated(event.record,{track:event.track});
    else controller.commitObserved(event.record,{track:event.track});
  }
  return {controller,source,groups,first};
}

test('selected model trajectory follows pure arithmetic and root return without executing JS',()=>{
  const {controller}=rollout('function f(x){let y=x+2;return y;}',[3]);
  assert.deepEqual(controller.completion,{kind:'return',value:['num',5]});
  assert(controller.generated>2);
});
test('graph identity, shared reads, loops, and coupled array writes survive replay',()=>{
  const o={n:2};
  const mutation=rollout('function f(o){o.n=o.n+1;return o.n;}',[o]);
  assert.deepEqual(mutation.controller.completion.value,['num',3]);
  const arr=rollout('function f(){const a=[1,2,3];a.length=1;return a;}',[]);
  assert.deepEqual(arr.controller.completion.value[0],'ref');
  assert.equal(arr.controller.heap.get(arr.controller.completion.value[1]).properties.size,2);
  const nested=rollout('function g(y){return y+1;} function f(x){return g(x);}',[4]);
  assert.deepEqual(nested.controller.completion.value,['num',5]);
});

test('trace controller rejects first inconsistent model predicted shared read',()=>{
  const verified=verifyTrainingCase({source:strict('function f(o){return o.x;}'),
    entry:'f',args:[{x:4}]});
  assert.equal(verified.status,'locally_verified');
  const groups=verified.exported.public.groups;
  const first=groups.findIndex(g=>g.mode==='generated');
  const prefix=restoreLines(groups.slice(0,first).map(g=>g.events[0].record));
  const controller=new SemanticController(prefix);
  let detected=false;
  for(const group of groups.slice(first)){
    const original=group.events[0].record;
    const {kind,fields}=decodeRecord(original);
    if(kind==='read' && fields.reads?.some(r=>r.kind==='property')){
      const forged=structuredClone(fields);
      const read=forged.reads.find(r=>r.kind==='property');
      read.value=['num',900];
      assert.throws(()=>controller.commitGenerated(encodeRecord(kind,forged)), e=>
        e.category==='read' && /inconsistent/.test(e.message));
      detected=true;
      break;
    }
    controller.commitGenerated(original,{track:group.events[0].track});
  }
  assert(detected);
});

test('continuation packet round trips the committed selected prefix, never future state',()=>{
  const {source,groups,first}=rollout('function f(x){let y=x+3;return y;}',[7]);
  const controller=new SemanticController(source);
  const partial=groups.slice(first,first+3);
  for(const group of partial)controller.commitGenerated(group.events[0].record);
  const packet=controller.segmentPacket();
  assert.equal(packet.schema,'semantic-continuation/2');
  assert.equal(JSON.stringify(packet).includes('referenceOutcome'),false);
  assert.equal(packet.source,'committed-model-state');
  const resumed=SemanticController.fromSegmentPacket(packet);
  for(const group of groups.slice(first+3))resumed.commitGenerated(group.events[0].record);
  assert.deepEqual(resumed.completion,{kind:'return',value:['num',10]});
});

test('continuation serializer refuses an incomplete generated value',()=>{
  const {source}=rollout('function f(x){return x;}',[2]);
  const controller=new SemanticController(source);
  controller.commitGenerated(encodeRecord('value-open',{id:'e1',type:'semantic-record'}));
  assert.throws(()=>controller.segmentPacket(),e=>e.category==='fragment');
});
