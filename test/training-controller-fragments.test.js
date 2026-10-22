import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticController} from '../src/training/controller.js';
import {encodeRecord} from '../src/training/format.js';

const context=[encodeRecord('code',{sourceId:'src1',text:'function f(){}',codes:[{id:'c1',params:[]}],sites:[]}),
  encodeRecord('value',{entry:'f',graph:{roots:[],objects:[]}})];
const open=(id,type='semantic-record')=>encodeRecord('value-open',{id,type});
const part=(id,data)=>encodeRecord('value-part',{id,data});
const close=id=>encodeRecord('value-close',{id});

test('serving controller rejects a forged fragmented semantic identity',()=>{
  const controller=new SemanticController(context);
  controller.commitGenerated(open('e1'));
  controller.commitGenerated(part('e1',encodeRecord('value',{id:'e2',invocation:'f',site:null})));
  assert.throws(()=>controller.commitGenerated(close('e1')),e=>e.category==='fragment');
});

test('serving controller rejects empty, invalid-type and non-string fragments',()=>{
  assert.throws(()=>new SemanticController(context).commitGenerated(open('e1','forged')),
    e=>e.category==='fragment');
  const c=new SemanticController(context);
  c.commitGenerated(open('e1'));
  assert.throws(()=>c.commitGenerated(part('e1','')),e=>e.category==='fragment');
  assert.throws(()=>c.commitGenerated(close('e1')),e=>e.category==='fragment');
});

test('failed generated fragment does not consume model event budget',()=>{
  const c=new SemanticController(context,{maxGenerated:2});
  c.commitGenerated(open('e1'));
  assert.throws(()=>c.commitGenerated(part('e1','')),e=>e.category==='fragment');
  assert.equal(c.generated,1);
  c.commitGenerated(part('e1',encodeRecord('value',{id:'e1',result:['num',1]})));
  assert.equal(c.generated,2);
  assert.throws(()=>c.commitGenerated(close('e1')),e=>e.category==='profile_limit');
});

test('serving controller rejects nested record envelopes',()=>{
  const c=new SemanticController(context);
  c.commitGenerated(open('e1'));
  c.commitGenerated(part('e1',open('e1')));
  assert.throws(()=>c.commitGenerated(close('e1')),e=>e.category==='fragment');
});
