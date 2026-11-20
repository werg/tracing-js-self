import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEffectfulTrainingCase,independentEffectfulReference} from '../src/training/effectful-admit.js';
import {AdmissionFailure,classifyAdmissionFailure,verifyFailureRecord} from '../src/training/failure-record.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {canonicalFixturePlan} from '../src/training/fixture-broker.js';

const fixture={source:'"use strict";function run(x){return x+1;}',entry:'run',args:[4],
  fixture:{calls:[]},family:'failure-evidence',seeds:{generation:7,input:9},
  producerRevision:'a'.repeat(40),provenance:{path:'original.js',licenseNotice:'Original fixture notice'}};
test('native refusal retains original source, inputs, oracle modes, environment and reproducible hashes',async()=>{
  const result=await verifyEffectfulTrainingCase({...fixture,
    nativePolicy:{consumerRevision:'b'.repeat(40),tokenizerIdentity:'test',tokenizerSha256:'c'.repeat(64)},
    nativeConsumer:async()=>({schema:'deliberately-incompatible'})});
  assert.equal(result.status,'native_rejected');
  assert.equal(result.phase,'native-consumer');
  assert.equal(result.exported,undefined);
  const record=JSON.parse(JSON.stringify(result.failure));
  assert.equal(verifyFailureRecord(record),true);
  assert.equal(record.original.source,fixture.source);
  assert.deepEqual(record.original.inputGraph,encodeNativeGraph(fixture.args));
  assert.equal(record.original.provenance.path,'original.js');
  assert.equal(record.original.seeds.input,9);
  assert.equal(record.original.environment.node,process.versions.node);
  assert(record.original.archiveDigest);
  assert.deepEqual(record.original.observations.owned.outcome,record.original.observations.original.outcome);
  assert.equal(record.original.observations.operations.operations.length,1);
  assert.deepEqual(record.original.observations.branches.decisions,[]);
  assert.equal(record.minimization.status,'not_attempted');
  record.original.source+='\n';
  assert.throws(()=>verifyFailureRecord(record),/evidence changed/);
});
test('unsupported source is retained separately from oracle, projection and resource failures',async()=>{
  const source='"use strict";function run(){return eval("1");}';
  const result=await verifyEffectfulTrainingCase({...fixture,source});
  assert.equal(result.status,'unsupported');
  assert.equal(result.category,'unsupported_source');
  assert.equal(result.failure.original.source,source);
  assert.deepEqual(result.failure.original.observations,{});
  assert.equal(verifyFailureRecord(result.failure),true);
  assert.deepEqual(classifyAdmissionFailure(new Error('internal bug'),'teacher'),
    {status:'teacher_failed',category:'teacher_execution_failed'});
  assert.equal(classifyAdmissionFailure(new RangeError('Owned instruction cap exceeded'),'teacher').category,
    'teacher_resource_limit');
  assert.equal(classifyAdmissionFailure(new Error('Owned teacher deadline exceeded'),'teacher').category,
    'teacher_timeout');
  for(const category of ['reference_outcome_mismatch','reference_operation_mismatch','reference_branch_mismatch',
    'reference_instrumentation_unsupported','reference_resource_limit','reference_process_failure'])
    assert.equal(classifyAdmissionFailure(new AdmissionFailure(category,'failure'),'reference').status,category);
});
test('reference timeout, output cap and unsupported instrumentation have distinct machine-readable failures',async()=>{
  const input={source:fixture.source,entry:fixture.entry,inputGraph:encodeNativeGraph(fixture.args),
    fixture:canonicalFixturePlan(fixture.fixture)};
  await assert.rejects(independentEffectfulReference(input,{timeoutMs:1}),
    error=>error.admissionCategory==='reference_timeout');
  await assert.rejects(independentEffectfulReference(input,{maxOutputBytes:1}),
    error=>error.admissionCategory==='reference_output_limit');
  await assert.rejects(independentEffectfulReference({...input,source:'"use strict";function run( {'}),
    error=>error.admissionCategory==='reference_instrumentation_unsupported');
});
test('the actual runtime step safety budget is a resource refusal, not an interpreter failure',async()=>{
  const result=await verifyEffectfulTrainingCase({...fixture,maxSteps:1});
  assert.equal(result.status,'profile_limit');
  assert.equal(result.category,'teacher_resource_limit');
  assert.match(result.reason,/Driver safety limit \(1 steps\)/);
  assert.equal(result.failure.original.limits.maxSteps,1);
  assert.equal(result.failure.original.error.name,'Error');
  assert.equal(verifyFailureRecord(result.failure),true);
  await assert.rejects(verifyEffectfulTrainingCase({...fixture,maxSteps:0}),/positive safe integers/);
});
test('callback failures cannot be silently discarded by otherwise-correct root qualification',async()=>{
  const result=await verifyEffectfulTrainingCase({...fixture,args:[],
    source:'"use strict";function run(){queueMicrotask(()=>{throw 7;});return 3;}'});
  assert.equal(result.status,'reference_callback_failure',result.reason);
  assert.equal(result.exported,undefined);
  assert.deepEqual(result.failure.original.observations.original.callbackFailures,
    [{kind:'throw',graph:{roots:[['num',7]],objects:[]}}]);
  assert.deepEqual(result.failure.original.observations.original.outcome,
    {kind:'return',graph:{roots:[['num',3]],objects:[]}});
  assert.equal(verifyFailureRecord(result.failure),true);
});
