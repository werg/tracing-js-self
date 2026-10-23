import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,validateTrainingExport} from 'tracing-js-self/training';
import {validateBundle,replayExact} from 'tracing-js-self';
import {evaluateSelectedTrajectory} from '../src/training/rollout.js';

function verified(body) {
  const result=verifyTrainingCase({source:'"use strict";\n'+body,
    entry:'f',maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  assert.equal(validateTrainingExport(result.exported).valid,true);
  const archive=JSON.parse(JSON.stringify(result.exported.sidecar.archive));
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  assert.equal(result.exported.sidecar.operationAudit.status,'agreed');
  return result.exported;
}

test('Math and Number scalar leaves independently match signed-zero and finite reference values',()=>{
  verified(`function f(){
    return [Math.round(-0.5),Math.trunc(-2.9),Math.max(-2,8,3),
      Math.hypot(3,4),Number.isFinite(1/0),Number.isNaN(0/0),
      Number.isInteger(3),Number.isSafeInteger(2**53)];
  }`);
  verified('function f(){return [Math.min(),Math.max(),Math.sign(-0),Math.sqrt(9)];}');
});

test('owned dense push/pop preserve array identity and observable versioned writes',()=>{
  const exported=verified(`function f(){
    const a=[1,2];
    let n=a.push(3,4);
    let last=a.pop();
    return [n,last,a[2],a.length,Array.isArray(a)];
  }`);
  const mutations=exported.sidecar.semantic.events.filter(e=>e.op==='write' &&
    e.writes.some(w=>w.kind==='property'));
  assert(mutations.some(e=>e.writes.some(w=>w.key==='2')));
  assert(mutations.some(e=>e.writes.some(w=>w.key==='length')));
  verified('function f(){const a=[];return [a.pop(),a.push(),a.length,Array.isArray({})];}');
});

test('Object keys and own-key presence allocate explicitly traced dense results',()=>{
  const exported=verified(`function f(){
    const obj={a:1,b:2};
    const keys=Object.keys(obj);
    return [keys[0],keys[1],keys.length,Object.hasOwn(obj,'a'),
      Object.hasOwn(obj,'missing'),Array.isArray(keys)];
  }`);
  assert(exported.sidecar.semantic.events.some(e=>e.op==='alloc' &&
    e.allocations?.some(a=>a.kind==='array')));
  const rollout=evaluateSelectedTrajectory({
    groups:exported.public.groups,referenceGroups:exported.public.groups,
    maxGenerated:1024
  });
  assert.equal(rollout.valid,true,JSON.stringify(rollout.invalid));
});
test('freshly allocated empty arrays expose their length to serving validation',()=>{
  const exported=verified('function f(){const a=[];return a.length;}');
  const rollout=evaluateSelectedTrajectory({groups:exported.public.groups,
    referenceGroups:exported.public.groups,maxGenerated:1024});
  assert.equal(rollout.valid,true,JSON.stringify(rollout.invalid));
});

test('unmodeled or host-dependent builtins remain unadmitted',()=>{
  for(const code of ['Math.random()','Array.from([1,2])','new Date()']) {
    const result=verifyTrainingCase({source:`"use strict"; function f(){return ${code};}`,entry:'f'});
    assert.notEqual(result.status,'locally_verified',code);
  }
});
