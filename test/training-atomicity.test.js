import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticController} from '../src/training/controller.js';
import {encodeRecord} from '../src/training/format.js';
import {verifyTrainingCase} from '../src/training/admit.js';
import {evaluateSelectedTrajectory} from '../src/training/rollout.js';

function bareController() {
  const context=[
    encodeRecord('code',{
      sourceId:'src1',text:'function f(){}',
      codes:[{id:'c1',params:[]}],sites:[]
    }),
    encodeRecord('value',{entry:'f',graph:{roots:[],objects:[]}})
  ];
  const controller=new SemanticController(context);
  controller.commitGenerated(encodeRecord('enter',{
    invocation:'f0',entry:'f',code:'c1',receiver:['undefined'],arguments:[]
  }));
  return controller;
}

test('failed allocations are atomic and a corrected record may be committed',()=>{
  const controller=bareController();
  const makeAlloc=value=>encodeRecord('alloc',{
    id:'e1',allocations:[{
      identity:'h1',kind:'object',shapeVersion:0,
      properties:[{key:'x',version:0,value}]
    }]
  });
  const before=controller.segmentPacket();
  assert.throws(()=>controller.commitGenerated(makeAlloc(['ref','not-yet-allocated'])),
    error=>error.category==='identity');
  assert.deepEqual(controller.segmentPacket(),before);
  assert.equal(controller.heap.has('h1'),false);
  assert.equal(controller.producers.has('e1'),false);
  controller.commitGenerated(makeAlloc(['num',3]));
  assert.equal(controller.heap.get('h1').properties.get('x').value[1],3);
});

test('failed completion does not retire an activation or change committed history',()=>{
  const controller=bareController();
  const before=controller.segmentPacket();
  assert.throws(()=>controller.commitGenerated(encodeRecord('return',{
    id:'e1',invocation:'f0',result:['ref','never-allocated']
  })),error=>error.category==='identity');
  assert.deepEqual(controller.segmentPacket(),before);
  assert.equal(controller.activations.get('f0').status,'running');
  controller.commitGenerated(encodeRecord('return',{
    id:'e1',invocation:'f0',result:['num',7]
  }));
  controller.commitGenerated(encodeRecord('end',{invocation:'f0',kind:'return'}));
  assert.deepEqual(controller.completion,{kind:'return',value:['num',7]});
});

test('failed fragmented completion preserves uncommitted fragment state',()=>{
  const controller=bareController();
  const invalid=encodeRecord('return',{
    id:'e1',invocation:'f0',result:['ref','unpublished']
  });
  controller.commitGenerated(encodeRecord('value-open',{id:'e1',type:'semantic-record'}));
  controller.commitGenerated(encodeRecord('value-part',{id:'e1',data:invalid}));
  const count=controller.generated;
  const history=structuredClone(controller.history);
  assert.throws(()=>controller.commitGenerated(encodeRecord('value-close',{id:'e1'})),
    error=>error.category==='identity');
  assert.equal(controller.generated,count);
  assert.deepEqual(controller.history,history);
  assert.deepEqual(controller.open.parts,[invalid]);
  assert.equal(controller.activations.get('f0').status,'running');
});

test('missing terminal model records cannot be reported as valid rollouts',()=>{
  const run=verifyTrainingCase({
    source:'"use strict";function f(x){return x+1;}',entry:'f',args:[2]
  });
  assert.equal(run.status,'locally_verified',JSON.stringify(run));
  const complete=run.exported.public.groups;
  assert(complete.at(-1).events[0].record.startsWith('end '));
  const truncated=evaluateSelectedTrajectory({groups:complete.slice(0,-1)});
  assert.equal(truncated.valid,false);
  assert.equal(truncated.invalid?.category,'incomplete');
  assert.equal(truncated.correctness,'incomplete');
  assert.equal(truncated.completion,null);
  const intact=evaluateSelectedTrajectory({groups:complete});
  assert.equal(intact.valid,true);
});
