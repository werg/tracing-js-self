import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase} from '../src/training/admit.js';
import {restoreLines} from '../src/training/format.js';
import {SemanticController} from '../src/training/controller.js';

test('multiple bounded model sessions reconstruct exact live state without a reference oracle',()=>{
  const result=verifyTrainingCase({source:'"use strict";function f(o){let i=0;while(i<5){o.x=o.x+1;i+=1;}return o.x;}',
    entry:'f',args:[{x:1}],maxGenerated:256});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const groups=result.exported.public.groups;
  const cut=groups.findIndex(g=>g.mode==='generated');
  const initial=restoreLines(groups.slice(0,cut).map(g=>g.events[0].record));
  let controller=new SemanticController(initial,{maxGenerated:10});
  let segments=0;
  for(const group of groups.slice(cut)){
    if(controller.generated===9 && !controller.open && !controller.completion){
      const packet=controller.segmentPacket();
      assert.equal(packet.schema,'semantic-continuation/2');
      assert.equal(packet.source,'committed-model-state');
      assert(!JSON.stringify(packet).includes('referenceOutcome'));
      const next=SemanticController.fromSegmentPacket(packet);
      assert.equal(next.generated,0);
      controller=next;segments++;
    }
    controller.commitGenerated(group.events[0].record,{track:group.events[0].track});
  }
  assert(segments>=3);
  assert.deepEqual(controller.completion,{kind:'return',value:['num',6]});
});

test('segment handoff rejects corrupt graph versions and incomplete fragments',()=>{
  const result=verifyTrainingCase({source:'"use strict";function f(a){return a.x;}',
    entry:'f',args:[{x:3}]});
  assert.equal(result.status,'locally_verified');
  const groups=result.exported.public.groups;
  const cut=groups.findIndex(g=>g.mode==='generated');
  const context=restoreLines(groups.slice(0,cut).map(g=>g.events[0].record));
  const controller=new SemanticController(context);
  controller.commitGenerated(groups[cut].events[0].record);
  const packet=controller.segmentPacket();
  const forged=structuredClone(packet);
  const [,obj]=forged.state.heap.find(([id,item])=>item.kind==='object');
  const first=obj.versions.find(([key])=>key==='x');
  first[1]=9999;
  assert.throws(()=>SemanticController.fromSegmentPacket(forged),e=>e.category==='context');
});
