import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission,independentEffectfulReference} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {canonicalFixturePlan} from '../src/training/fixture-broker.js';

const source=body=>'"use strict";function run(a){'+body+'}';
const cases=[
  {body:'throw 7;',value:['num',7]},
  {body:'throw undefined;',value:['undefined']},
  {body:'throw null;',value:['null']},
  {body:'throw "bad";',value:['str','bad']},
  {body:'throw -0;',value:['num','-0']},
  {body:'throw NaN;',value:['num','NaN']},
  {body:'try{throw 7;}finally{throw 8;}',value:['num',8]},
  {body:'try{throw 7;}finally{const x=2;}',value:['num',7]},
  {body:'a.x=3;throw a;',args:[{x:1}],value:['ref','o0']}
];

test('synchronous guest throws are positive v5 outcomes with independent source and replay evidence',async()=>{
  for(const c of cases){
    const result=await verifyEffectfulTrainingCase({source:source(c.body),entry:'run',
      args:c.args??[],fixture:{calls:[]},family:'sync-throw'});
    assert.equal(result.status,'locally_verified',c.body+': '+result.reason);
    assert.equal(result.exported.sidecar.reference.outcome.kind,'throw');
    assert.deepEqual(result.exported.sidecar.reference.outcome.graph.roots.at(-1),c.value);
    const checked=await recheckEffectfulAdmission(result.exported,{requireAdmitted:false});
    assert(checked.sourceValidated&&checked.replayValidated&&checked.effectsValidated);
  }
});

test('synchronous throw runs through the selected driver with exact error and cleanup outcome',async()=>{
  const verified=await verifyEffectfulTrainingCase({
    source:source('try{throw 7;}finally{host.store("cleanup",1);}'),entry:'run',
    family:'sync-throw-cleanup',fixture:{calls:[{operation:'demo.store',arguments:['cleanup',1]}]}});
  assert.equal(verified.status,'locally_verified',verified.reason);
  const fixture=controlledEvaluationCase(verified.exported,{id:'sync-throw-cleanup'});
  const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
    request:fixture.request,seed:17,representation:'compact'});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));
  assert.deepEqual(actual.outcome,fixture.expected);
  assert.deepEqual(actual.outcome.completion,{kind:'throw',value:['num',7]});
});

function worker(code,{mode,timeoutMs=100,fixture={calls:[]}}={}){
  const process=spawnSync(globalThis.process.execPath,['tools/effectful-reference-worker.mjs'],{
    encoding:'utf8',input:JSON.stringify({source:code,entry:'run',inputGraph:encodeNativeGraph([]),
      fixture:canonicalFixturePlan(fixture),mode,timeoutMs}),timeout:2000});
  assert.notEqual(process.stdout,'',process.stderr);
  return JSON.parse(process.stdout);
}

test('oracle deadlines, invalid syntax and caught broker errors never become guest throw labels',()=>{
  const deadline=worker(source('while(true){}'),{timeoutMs:20});
  assert.equal(deadline.failure.category,'reference_resource_limit');
  assert.equal(deadline.outcome,undefined);
  const syntax=worker('"use strict";function run( {');
  assert.equal(syntax.failure.category,'reference_instrumentation_unsupported');
  const broker=worker(source('try{host.readNumber("wrong");}catch(e){return 1;}'),{
    fixture:{calls:[{operation:'demo.readNumber',arguments:['right'],result:2}]}});
  assert.equal(broker.failure.category,'reference_process_failure');
  assert.equal(broker.outcome,undefined);
});

test('reference callback failures and detached rejections retain original thrown values separately from root result',async()=>{
  const callback=await independentEffectfulReference({source:source('queueMicrotask(()=>{throw 7;});return 3;'),
    entry:'run',inputGraph:encodeNativeGraph([]),fixture:canonicalFixturePlan({calls:[]})});
  assert.deepEqual(callback.outcome,{kind:'return',graph:{roots:[['num',3]],objects:[]}});
  assert.deepEqual(callback.callbackFailures,[{kind:'throw',graph:{roots:[['num',7]],objects:[]}}]);
  const rejection=worker(source('Promise.reject(9);return 3;'));
  assert.deepEqual(rejection.unhandledRejections,[{kind:'throw',graph:{roots:[['num',9]],objects:[]}}]);
});
