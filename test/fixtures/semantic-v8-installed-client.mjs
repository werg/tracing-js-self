// Run from a separate packed installation with historical clients absent.
// This tests direct source projection and runtime execution. Complete source
// admission currently also requires the repository's dependency-lock evidence.
import assert from 'node:assert/strict';
import * as v8 from 'tracing-js-self/semantic/v8';
import {executeWithNativeServices} from 'tracing-js-self/native';

assert.match(import.meta.resolve('tracing-js-self/semantic/v8'),/\/node_modules\/tracing-js-self\/src\/semantic\/index-v8\.js$/);
assert.equal(v8.REGION_EXECUTION_VERSION,'semantic-execution/8');
const record={kind:'return',fields:{value:['num','-0']}};
assert.deepEqual(v8.decodeDetailedRecord(v8.encodeDetailedRecord(record)),record);
assert.equal(v8.renderAlgorithmV8Record({kind:'return',value:['ref','return']}),'return @"return"');

const cases=[
  {id:'pure',source:'"use strict";function run(x){let y=x+1;return y*2;}',args:[3]},
  {id:'effect',source:'"use strict";function run(){const x=host.readNumber("x");return x+1;}',args:[]}
];
let calls=0;
const results=[];
for(const fixture of cases){
  const {bundle}=await executeWithNativeServices({entry:{text:fixture.source,functionName:'run',args:fixture.args},
    services:{'demo.readNumber':({args})=>{assert.deepEqual(args,['x']);calls++;return 7;}}});
  const {exported}=v8.compileSourceWitnessV8(bundle);
  assert.equal(v8.verifySourceProjectionV8(bundle,exported).valid,true);
  const replay=v8.SelectedExecutionLifecycleV8.replay(exported),restored=v8.SelectedExecutionLifecycleV8.restore(
    JSON.parse(JSON.stringify(replay.checkpoint())));
  assert.deepEqual(restored.timeline,exported.public.timeline);
  assert.deepEqual([...restored.invocations.values()][0].controller.completion.value,['num',8]);
  assert(!/semantic-(?:execution|trace|context|continuation|checkpoint)\/[67]/.test(JSON.stringify(exported.public)));
  results.push({id:fixture.id,projectionValidated:true,replayValidated:true,restored:true});
}
assert.equal(calls,1,'projection, replay and restoration do not dispatch native work');

let mixed=new v8.RegionExecutionHarness();
mixed.publishProgram({programId:'p',source:cases[0].source,entry:'run'});
mixed.admitInvocation({programId:'p',invocationId:'call',trackId:'t',realmId:'r',triggerId:'outside',args:[3]});
mixed.select('call',mixed.preview('call','r0'));
mixed=v8.RegionExecutionHarness.restore(JSON.parse(JSON.stringify(mixed.checkpoint())));
mixed.select('call',{kind:'end',fields:{kind:'return'}});
assert.deepEqual(mixed.controller.completion.value,['num',8]);
assert.deepEqual(v8.RegionExecutionHarness.replay(mixed.exportEpisode()).exportEpisode(),mixed.exportEpisode());

// npm excludes package-lock.json from archives. Keep that existing admission
// boundary explicit; do not inject or manufacture provenance to make it pass.
await assert.rejects(v8.verifyRegionTrainingCase({...cases[0],entry:'run',
  family:'installed-source-provenance-boundary',fixture:{calls:[]}}),
  error=>error.code==='ENOENT'&&error.path.endsWith('/package-lock.json'));
await assert.rejects(import('tracing-js-self/semantic'),error=>error.code==='ERR_MODULE_NOT_FOUND');
await assert.rejects(import('tracing-js-self/training'),error=>error.code==='ERR_MODULE_NOT_FOUND');
console.log(JSON.stringify({valid:true,entry:'tracing-js-self/semantic/v8',results,
  nativeCalls:calls,mixedContinuation:'restored-between-selected-records',
  sourceAdmission:'refused-missing-packaged-lock-evidence',model:'engineering-only',defaultCutover:'not-claimed'}));
