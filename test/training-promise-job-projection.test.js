import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileEffectfulWitness,verifyEffectfulProjection} from '../src/training/effectful-compiler.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {decodeWitness,encodeWitness} from '../src/training/format.js';
import {compileEffectfulRegionWitnessV8} from '../src/semantic/effectful-teacher-v8.js';

const cases=[
  ['adoption-order','async function target(){return 1;}async function run(){let order="";const targetPromise=target();async function outer(){return targetPromise;}const adopted=outer();adopted.then(()=>{order+="a";});targetPromise.then(()=>{order+="d";});queueMicrotask(()=>{order+="q";});await adopted;return order;}', ['str','dqa']],
  ['rejected-adoption','async function fail(){throw "bad";}async function run(){return fail();}', ['str','bad']],
  ['finally-order','async function run(){let order="";const p=Promise.resolve(1).finally(()=>{order+="f";});queueMicrotask(()=>{order+="q";queueMicrotask(()=>{order+="n";});});await p;return order;}', ['str','fqn']],
  ['finally-promise','async function run(){try{return await Promise.reject(3).finally(()=>Promise.resolve(0));}catch(e){return e;}}', ['num',3]],
  ['finally-rejection','async function run(){return await Promise.resolve(3).finally(()=>Promise.reject(5));}', ['num',5]],
  ['finally-throw','async function run(){return await Promise.resolve(3).finally(()=>{throw 7;});}', ['num',7]]
];
function project(body){
  const source='"use strict";'+body,
    runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});
  runtime.drive();const bundle=runtime.exportRun();
  return {source,bundle,...compileEffectfulWitness(bundle,{semanticRegions:false})};
}
const records=episode=>episode.public.timeline.filter(row=>row.kind==='semantic').map(row=>decodeWitness(row.line));

test('adoption and callable finally retain each owned queue boundary and native ordering',async()=>{
  for(const [name,body,expected]of cases){
    const result=project(body);
    let native,kind='return';
    try{native=await new Function(result.source+';return run();')();}catch(error){native=error;kind='throw';}
    assert.deepEqual(result.outcome,{kind,graph:{roots:[expected],objects:[]}},name);
    assert.equal(native,expected[1],name);
    const publicRecords=records(result.exported),jobs=publicRecords.filter(row=>row.kind==='job');
    assert(jobs.some(row=>row.fields.action==='dispatch'),name);
    for(const row of jobs.filter(row=>row.fields.action==='dispatch'))
      assert(jobs.some(other=>other.fields.action==='complete'&&other.fields.job===row.fields.job),name);
    if(name!=='finally-throw'){
      assert(result.certificates.some(row=>row.rule==='owned-promise-adoption-enqueue/4'),name);
      assert(result.certificates.some(row=>row.rule==='owned-promise-forwarding-dispatch/4'),name);
    }
    assert(verifyEffectfulProjection(result.bundle,result.exported,{semanticRegions:false}).valid);
  }
});

test('every published queue boundary restores without rerunning guest work',()=>{
  for(const [,body]of [cases[0],cases[2],cases[4]]){
    const {exported}=project(body),timeline=exported.public.timeline;
    for(let index=0;index<timeline.length;index++){
      const row=timeline[index];
      if(row.kind!=='semantic'||!['job','promise','await','resume'].includes(decodeWitness(row.line).kind))continue;
      const prefix=structuredClone(exported);prefix.public.timeline=timeline.slice(0,index+1);
      const replayed=SelectedExecutionHarness.replay(prefix,{requireTerminal:false}),
        checkpoint=JSON.parse(JSON.stringify(replayed.checkpoint())),
        restored=SelectedExecutionHarness.restore(checkpoint);
      assert.deepEqual(restored.checkpoint(),checkpoint);
    }
  }
});

test('forwarding queue tampering and unpaired V8 promotion are refused',()=>{
  const {exported,bundle}=project(cases[0][1]),tampered=structuredClone(exported),
    dispatches=tampered.public.timeline.filter(row=>row.kind==='semantic'&&
      decodeWitness(row.line).kind==='job'&&decodeWitness(row.line).fields.action==='dispatch');
  const adoption=dispatches.find(row=>decodeWitness(row.line).fields.job.startsWith('adopt')),
    forwarding=dispatches.find(row=>decodeWitness(row.line).fields.job.startsWith('forward'));
  assert(adoption&&forwarding);
  const record=decodeWitness(adoption.line);record.fields.job=decodeWitness(forwarding.line).fields.job;
  adoption.line=encodeWitness(record.kind,record.fields);
  assert.throws(()=>SelectedExecutionHarness.replay(tampered),/FIFO|owner|job/i);
  assert.throws(()=>verifyEffectfulProjection(bundle,tampered,{semanticRegions:false}),/certificates|bytes/);
  for(const index of [0,2,3]){
    const candidate=project(cases[index][1]);
    // The bare teacher has no adoption component. The paired source compiler
    // supplies that owner; unpaired projection must still refuse explicitly.
    assert.throws(()=>compileEffectfulRegionWitnessV8(candidate.bundle),index===0?
      {name:'TypeError',category:'unsupported.effectful-region-source'}:/explicit.*jobs/);
  }
});
