import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase} from '../src/training/admit.js';
import {decodeWitness} from '../src/training/format.js';
import {renderWitness} from '../src/training/render.js';
import {checkWitnessClaim} from '../src/training/witness-check.js';

function verified(source,args){
  const checked=verifyTrainingCase({source:'"use strict";'+source,entry:'run',args});
  assert.equal(checked.status,'locally_verified',checked.reason);
  const {compiled,reference}=checked.exported.sidecar;
  return {lines:compiled.generated,records:compiled.generated.map(decodeWitness),
    certificates:compiled.certificates,reference};
}

test('source-linked choice replaces redundant test arithmetic without losing its receipt',()=>{
  const result=verified('function run(x){if(x>0)return x+3;return x-2;}',[4]);
  const index=result.records.findIndex(r=>r.kind==='choose');
  assert(index>0);
  const choice=result.records[index];
  assert.equal(choice.fields.expr.op,'binary');
  assert.equal(choice.fields.expr.operator,'>');
  assert.deepEqual(choice.fields.expr.left,{op:'local',name:'arg0'});
  assert.deepEqual(choice.fields.decision,['bool',true]);
  assert(result.certificates[index].journalEvents.length>=2,
    'original pure computation and branch evidence must be retained privately');
  assert.equal(result.records.slice(0,index).filter(r=>r.kind==='compute').length,0);
  assert.match(renderWitness(result.lines[index]),/choose \(arg0 > 0\)/);
  assert.deepEqual(result.reference.graph.roots.at(-1),['num',7]);
});

test('nested arithmetic in a choice is one independently checkable explanation',()=>{
  for(const x of [0,3]){
    const result=verified('function run(x){if(x+1>=3)return 10;return 20;}',[x]);
    const choice=result.records.find(r=>r.kind==='choose');
    assert.equal(choice.fields.expr.op,'binary');
    assert.equal(choice.fields.expr.left.op,'binary');
    assert.equal(choice.fields.expr.left.operator,'+');
    const index=result.records.indexOf(choice);
    assert.equal(result.records.slice(0,index).filter(r=>r.kind==='compute').length,0);
    assert.equal(result.reference.graph.roots.at(-1)[1],x===3?10:20);
  }
});

test('primitive and object truthiness use committed input aliases',()=>{
  for(const x of [0,7]){
    const result=verified('function run(x){if(x)return 1;return 0;}',[x]);
    const choice=result.records.find(r=>r.kind==='choose');
    assert.deepEqual(choice.fields.expr,{op:'local',name:'arg0'});
    assert.deepEqual(choice.fields.decision,['num',x]);
    assert.equal(result.reference.graph.roots.at(-1)[1],x?1:0);
  }
  const result=verified('function run(o){if(!o)return 1;return 2;}',[{n:3}]);
  const choice=result.records.find(r=>r.kind==='choose');
  assert.equal(choice.fields.expr.op,'unary');
  assert.equal(choice.fields.expr.operator,'!');
  assert.deepEqual(choice.fields.expr.arg,{op:'local',name:'arg0'});
  assert.deepEqual(choice.fields.decision,['bool',false]);
  assert.equal(result.reference.graph.roots.at(-1)[1],2);
  assert.equal(checkWitnessClaim({op:'unary',operator:'!',
    arg:{op:'local',name:'obj'}},['bool',false],
    {locals:new Map([['obj',['ref','o1']]])}).consistent,true);
  assert.equal(checkWitnessClaim({op:'unary',operator:'+',
    arg:{op:'local',name:'obj'}},['num',1],
    {locals:new Map([['obj',['ref','o1']]])}).consistent,false);
});

test('side-effecting decisions retain their writes and are not speculatively flattened',()=>{
  const result=verified('function run(o){if(o.n++<3)return o.n;return -1;}',[{n:2}]);
  assert(result.records.some(r=>r.kind==='write'&&r.fields.key==='n'));
  assert(result.records.some(r=>r.kind==='choose'&&r.fields.expr.op==='literal'));
  assert.equal(result.reference.graph.roots.at(-1)[1],3);
});

test('small loops keep the iteration state while folding repeated pure checks',()=>{
  const result=verified('function run(x){let s=0;for(let i=0;i<3;i++)s+=x+i;return s;}',[4]);
  assert.equal(result.records.filter(r=>r.kind==='choose').length,4);
  assert(result.records.filter(r=>r.kind==='choose').every(r=>r.fields.expr.op==='binary'));
  assert(result.records.some(r=>r.kind==='compute'&&r.fields.bind?.startsWith('s')));
  assert.deepEqual(result.reference.graph.roots.at(-1),['num',15]);
});

test('named helper call exposes a source-level name rather than a code coordinate',()=>{
  const result=verified('function inc(y){return y+1;}function run(x){return inc(x);}',[4]);
  const call=result.records.find(r=>r.kind==='call');
  assert(call);
  assert.equal(call.fields.callee,'inc');
  assert.equal(result.reference.graph.roots.at(-1)[1],5);
});
