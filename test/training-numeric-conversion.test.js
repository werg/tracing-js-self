import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

async function qualify(body){
  const source='"use strict";'+body;
  const checked=await verifyEffectfulTrainingCase({source,entry:'run',family:'bounded-numeric-conversion',fixture:{calls:[]}});
  assert.equal(checked.status,'locally_verified',checked.reason);
  const rechecked=await recheckEffectfulAdmission(checked.exported,{requireAdmitted:false});
  assert(rechecked.sourceValidated&&rechecked.replayValidated&&rechecked.effectsValidated);
  const pure=verifyOwnedSourceCase({source,entry:'run'});
  assert.equal(pure.status,'locally_verified',pure.reason);assert.equal(recheckOwnedSourceEvidence(pure.exported).valid,true);
  return checked.exported;
}

test('Number primitive conversion retains missing arguments, special numbers and BigInt boundaries',async()=>{
  await qualify('function run(){return [Number(),Number(undefined),Number(null),Number(false),Number(true),'+
    'Number(""),Number("  -12.5e1  "),Number("0x10"),Number("Infinity"),Number("invalid"),'+
    'Number(-0),Number(9007199254740993n),typeof Number];}');
});
test('String primitive conversion preserves missing arguments, signed zero and exact BigInts',async()=>{
  await qualify('function run(){return [String(),String(undefined),String(null),String(false),String(true),'+
    'String("unchanged"),String(-0),String(NaN),String(Infinity),String(9007199254740993n),typeof String];}');
  await qualify('function argument(log,value){log.push(value);return value;}'+
    'function run(){const log=[];const value=String(argument(log,12),argument(log,"ignored"),{value:99});'+
    'return [value,log];}');
});
test('numeric calls evaluate ignored arguments once before conversion without coercing them',async()=>{
  await qualify('function argument(log,value){log.push(value);return value;}'+
    'function run(){const log=[];'+
    'const first=Number(argument(log,"12"),argument(log,"ignored"),{value:99});'+
    'const second=BigInt(argument(log,"13"),argument(log,"also ignored"));return [first,second,log];}');
});
test('BigInt converts exact primitive integers and preserves real catchable conversion errors',async()=>{
  await qualify('function run(){return [BigInt(0),BigInt(-0),BigInt(true),BigInt(false),BigInt(""),'+
    'BigInt("0xff"),BigInt("18446744073709551615"),BigInt(-7),BigInt(9n),typeof BigInt];}');
  for(const value of ['undefined','null','1.5','Infinity','"1.5"','"invalid"'])
    await qualify('function run(){try{return BigInt('+value+');}catch(error){return [error.name,error.message];}}');
});
test('uncaught numeric conversion errors complete selected execution after finally cleanup',async()=>{
  const checked=await verifyEffectfulTrainingCase({source:'"use strict";function run(){try{return BigInt(1.5);}'+
    'finally{host.store("cleanup",1);}}',entry:'run',family:'numeric-error-cleanup',
    fixture:{calls:[{operation:'demo.store',arguments:['cleanup',1]}]}});
  assert.equal(checked.status,'locally_verified',checked.reason);
  const fixture=controlledEvaluationCase(checked.exported,{id:'numeric-error-cleanup'});
  const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
    request:fixture.request,seed:17,representation:'compact'});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));assert.deepEqual(actual.outcome,fixture.expected);
  assert.equal(actual.outcome.completion.kind,'throw');
});
test('owned Number callbacks require protocol evidence and restore their original receiver',async()=>{
  const source='"use strict";function run(){const o={x:7,valueOf:function(){return this.x;}};return Number(o);}',
    fixture={source,entry:'run',family:'number-object-protocol',fixture:{calls:[]}},
    historical=await verifyEffectfulTrainingCase(fixture);
  assert.equal(historical.status,'projection_refused',historical.reason);
  assert.match(historical.reason,/explicit v8 protocol profile/);
  assert.equal(historical.exported,undefined);
  const result=await verifyRegionTrainingCase(fixture);assert(result.exported,result.reason);
  const artifact=result.exported;
  assert(artifact.sidecar.protocolExtensions.includes('primitive-conversion-source/1'));
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.extensionAudit.status,'agreed');
  const cut=artifact.public.timeline.findIndex(row=>row.fields?.line?.includes('"kind":"conversion.call"'))+1;
  assert(cut>0);
  const partial=RegionExecutionHarness.replay({...artifact.public,timeline:artifact.public.timeline.slice(0,cut)},{requireTerminal:false}),
    restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(partial.checkpoint())));
  for(const row of artifact.public.timeline.slice(cut))
    restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(restored.exportEpisode(),artifact.public);
  assert.deepEqual(restored.controller.completion,{kind:'return',value:['num',7]});
  assert.equal((await recheckRegionEvidence(artifact)).sourceValidated,true);
});
test('BigInt and String object conversion remain explicit uncaught profile refusals',async()=>{
  for(const intrinsic of ['BigInt','String']){
    const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(){try{return '+intrinsic+
      '({valueOf:function(){return 7;}});}catch(error){return 8;}}',entry:'run',family:'numeric-object-refusal',fixture:{calls:[]}});
    assert.equal(result.status,'unsupported',result.reason);
    assert.match(result.reason,/outside the bounded scalar profile/);
  }
});
