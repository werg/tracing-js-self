import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {decodeWitness} from '../src/training/format.js';

const cases=[
  {name:'rejected-await-finally',body:'try{return await host.readAsync("bad");}finally{host.store("cleanup",1);}',
    kind:'throw',value:['str','missing'],cleanup:true},
  {name:'rejected-await-direct',body:'return await host.readAsync("bad");',
    kind:'throw',value:['str','missing'],cleanup:false},
  {name:'finally-replaces-rejection',body:'try{return await host.readAsync("bad");}finally{host.store("cleanup",1);throw "cleanup failed";}',
    kind:'throw',value:['str','cleanup failed'],cleanup:true},
  {name:'finally-returns-after-rejection',body:'try{return await host.readAsync("bad");}finally{host.store("cleanup",1);return 7;}',
    kind:'return',value:['num',7],cleanup:true}
];

for(const representation of ['explicit','compact'])for(const scenario of cases)
  test(representation+' '+scenario.name+' preserves the root Promise outcome and ordered finally effects',async()=>{
    const result=await verifyEffectfulTrainingCase({
      source:'"use strict";async function run(){'+scenario.body+'}',entry:'run',args:[],
      family:scenario.name,projectionOptions:{representation},fixture:{calls:[
        {operation:'demo.readAsync',arguments:['bad'],status:'rejected',result:'missing'},
        ...(scenario.cleanup?[{operation:'demo.store',arguments:['cleanup',1]}]:[])
      ]}});
    assert.equal(result.status,'locally_verified',result.reason);
    const exported=result.exported;
    assert.deepEqual(exported.sidecar.reference.outcome,
      {kind:scenario.kind,graph:{roots:[scenario.value],objects:[]}});
    const records=exported.public.timeline.filter(item=>item.kind==='semantic').map(item=>decodeWitness(item.line));
    const rootPromise=exported.sidecar.archive.initialState.frames.f1.asyncPromiseId;
    assert(records.some(item=>item.kind==='promise'&&item.fields.promise===rootPromise&&
      item.fields.action===(scenario.kind==='throw'?'reject':'resolve')));
    assert(records.some(item=>item.kind==='return'&&item.fields.value[0]==='ref'&&
      item.fields.value[1]===rootPromise),'async call returns its original Promise even when its body throws');
    const rechecked=await recheckEffectfulAdmission(exported,{requireAdmitted:false});
    assert(rechecked.sourceValidated&&rechecked.effectsValidated&&rechecked.replayValidated);
    const fixture=controlledEvaluationCase(exported,{id:scenario.name+'-'+representation});
    const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
      request:fixture.request,seed:17,representation});
    assert.equal(actual.failure,null,JSON.stringify(actual.failure));
    assert.deepEqual(actual.outcome,fixture.expected);
    assert.deepEqual(actual.outcome.completion,{kind:scenario.kind,value:scenario.value});
    assert.deepEqual(actual.outcome.effects.filter(item=>item.kind==='dispatch').map(item=>item.operation),
      ['demo.readAsync',...(scenario.cleanup?['demo.store']:[])]);
    assert.deepEqual(actual.outcome.cleanup,{pendingEffects:0,pendingJobs:0,openHandlers:0});
  });
