import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase} from '../src/training/admit.js';
import {encodeRecord,decodeRecord} from '../src/training/format.js';
import {evaluateSelectedTrajectory} from '../src/training/rollout.js';

const make=(body,args=[])=>{
  const verified=verifyTrainingCase({source:'"use strict";\n'+body,entry:'f',args});
  assert.equal(verified.status,'locally_verified',JSON.stringify(verified));
  return verified.exported;
};

test('free-running selected trajectory checks exact graph and aliases after commit',()=>{
  const archive=make('function f(o){o.x=o.x+2;return [o,o.x];}',[{x:4}]);
  const result=evaluateSelectedTrajectory({
    groups:archive.public.groups,
    referenceGroups:archive.public.groups,
    referenceOutcome:archive.sidecar.reference.outcome
  });
  assert.equal(result.valid,true);
  assert.equal(result.correctness,'correct');
  assert.equal(result.firstDivergence,null);
  assert.deepEqual(result.completion.kind,'return');
});

test('changed predicted outcome is not overwritten by reference continuation',()=>{
  const archive=make('function f(x){return x+1;}',[4]);
  const groups=structuredClone(archive.public.groups);
  const row=groups.find(g=>g.mode==='generated' && g.events[0].record.startsWith('return '));
  assert(row);
  const prior=decodeRecord(row.events[0].record);
  row.events[0].record=encodeRecord('return',{...prior.fields,result:['num',99]});
  const result=evaluateSelectedTrajectory({
    groups,referenceGroups:archive.public.groups,
    referenceOutcome:archive.sidecar.reference.outcome
  });
  assert.equal(result.valid,true);
  assert.equal(result.completion.value[1],99);
  assert.equal(result.correctness,'state_mismatch');
  assert(result.firstDivergence);
});

test('a wrong shared read reports invalid output at the first inconsistent semantic fact',()=>{
  const archive=make('function f(o){return o.x;}',[{x:3}]);
  const groups=structuredClone(archive.public.groups);
  const index=groups.findIndex(g=>g.mode==='generated' &&
    g.events[0].record.startsWith('read ') &&
    decodeRecord(g.events[0].record).fields.reads?.some(r=>r.kind==='property'));
  assert(index>0);
  const original=decodeRecord(groups[index].events[0].record);
  const changed=structuredClone(original.fields);
  changed.reads.find(r=>r.kind==='property').value=['num',124];
  groups[index].events[0].record=encodeRecord('read',changed);
  const result=evaluateSelectedTrajectory({groups,referenceGroups:archive.public.groups});
  assert.equal(result.valid,false);
  assert.equal(result.invalid.category,'read');
  assert.equal(result.invalid.index,index);
  assert.equal(result.completion,null);
});

test('new selected references must be explicitly allocated before any return',()=>{
  const archive=make('function f(x){return x+1;}',[4]);
  const selected=structuredClone(archive.public.groups);
  const row=selected.find(g=>g.mode==='generated' && g.events[0].record.startsWith('return '));
  const payload=decodeRecord(row.events[0].record);
  row.events[0].record=encodeRecord('return',{...payload.fields,result:['ref','unallocated']});
  const result=evaluateSelectedTrajectory({groups:selected,referenceGroups:archive.public.groups});
  assert.equal(result.valid,false);
  assert.equal(result.invalid.category,'identity');
});
