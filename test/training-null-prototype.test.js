import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';

async function check(options){
  const verified=await verifyEffectfulTrainingCase({entry:'run',family:'null-prototype-data',
    fixture:{calls:[]},...options});
  assert.equal(verified.status,'locally_verified',verified.reason);
  const exported=JSON.parse(JSON.stringify(verified.exported));
  const source=await recheckEffectfulAdmission(exported,{requireAdmitted:false});
  assert(source.sourceValidated&&source.replayValidated&&source.effectsValidated);
  const fixture=controlledEvaluationCase(exported,{id:'null-prototype'});
  const selected=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
    request:fixture.request,representation:'compact',seed:17});
  assert.equal(selected.failure,null,JSON.stringify(selected.failure));
  assert.deepEqual(selected.outcome,fixture.expected);
  assert.equal(selected.costs.leakedResources,0);
  SelectedExecutionHarness.replay(exported);
  return exported;
}

test('selected input import preserves explicit null prototypes with alias, cycle and mutation evidence',async()=>{
  const value=Object.create(null);value.x=1;value.self=value;
  const exported=await check({source:'"use strict";function run(a,b){a.x=a.x+1;return [Object.getPrototypeOf(a)===null,a===b,a.self===a,a];}',
    args:[value,value]});
  const invocation=exported.public.timeline.find(record=>record.kind==='invocation');
  assert.equal(invocation.inputGraph.objects[0].prototype,null);
  assert.deepEqual(invocation.inputGraph.roots[0],invocation.inputGraph.roots[1]);
  const graph=exported.sidecar.reference.outcome.graph;
  assert(graph.objects.some(object=>object.prototype===null));
  assert.equal(value.x,1,'captured input remains outside guest mutation');
});

test('selected external observation preserves null prototypes through delivery and checkpoint replay',async()=>{
  const value=Object.create(null);value.x=1;value.self=value;
  const exported=await check({source:'"use strict";async function run(){const a=await host.natlangCall("nullgraph",null,[]);a.x=a.x+1;return [Object.getPrototypeOf(a)===null,a.self===a,a];}',
    fixture:{calls:[{operation:'natlang.call',arguments:['nullgraph',null,[]],result:value}]},
    projectionOptions:{checkpointAtFirstAwait:true}});
  const result=exported.public.timeline.find(record=>record.kind==='result'&&record.result[0]==='ref');
  assert.match(result.line,/"prototype":null/);
  assert.equal(exported.sidecar.compiler.checkpoints.length,1);
});
