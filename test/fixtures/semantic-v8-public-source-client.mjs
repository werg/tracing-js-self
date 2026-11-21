// Run in a lock-bearing source checkout with historical wire clients blocked.
// All producer APIs below resolve through the supported public V8 subpath.
import assert from 'node:assert/strict';
import * as v8 from 'tracing-js-self/semantic/v8';

assert.equal(v8.REGION_EXECUTION_VERSION,'semantic-execution/8');
assert.equal(v8.V8_LIFECYCLE_CONTRACT.checkpointVersion,'semantic-checkpoint/8');
assert.equal(v8.SOURCE_ADMISSION_CONTRACT_V8.execution,'semantic-lifecycle/8');
const record={kind:'return',fields:{value:['num','-0']}};
assert.deepEqual(v8.decodeDetailedRecord(v8.encodeDetailedRecord(record)),record);
assert.equal(v8.renderAlgorithmV8Record({kind:'return',value:['ref','return']}),'return @"return"');

const cases=[
  {id:'pure',source:'"use strict";function run(x){let y=x+1;return y*2;}',args:[3],fixture:{calls:[]}},
  {id:'effect',source:'"use strict";function run(){const x=host.readNumber("x");return x+1;}',args:[],
    fixture:{calls:[{operation:'demo.readNumber',arguments:['x'],result:7}]}},
  {id:'protocol',source:'"use strict";function run(){const x={valueOf(){return 3;}};return Number(x)+1;}',args:[],fixture:{calls:[]}}
];
const results=[];
let pure;
for(const fixture of cases){
  const result=await v8.verifyRegionTrainingCase({...fixture,entry:'run',family:'installed-v8:'+fixture.id});
  assert(result.exported,result.reason);
  const checked=await v8.recheckRegionEvidence(result.exported);
  assert.equal(checked.sourceValidated,true);assert.equal(checked.projectionValidated,true);
  assert.equal(checked.replayValidated,true);assert.equal(checked.native.admitted,false);
  assert(!/semantic-(?:execution|trace|context|continuation|checkpoint)\/[67]/.test(
    JSON.stringify({public:result.exported.public,contexts:result.exported.contexts})));
  const replay=v8.RegionExecutionHarness.replay(result.exported),restored=v8.RegionExecutionHarness.restore(
    JSON.parse(JSON.stringify(replay.checkpoint())));
  assert.deepEqual(restored.exportEpisode(),result.exported.public);
  assert.deepEqual(v8.sharedRegionState(restored.controller),v8.sharedRegionState(replay.controller));
  const kinds=[...new Set(result.exported.public.timeline.map(row=>row.kind))];
  if(fixture.id==='effect')assert(kinds.includes('dispatch')&&kinds.includes('result'));
  if(fixture.id==='protocol')assert(kinds.includes('protocol'));
  results.push({id:fixture.id,sourceValidated:true,replayValidated:true,restored:true,kinds});
  if(fixture.id==='pure')pure=result.exported;
}

const first=pure.public.timeline.findIndex(row=>row.mode==='generated');
let live=v8.RegionExecutionHarness.replay({...pure.public,timeline:pure.public.timeline.slice(0,first)},
  {requireTerminal:false});
for(const [index,row]of pure.public.timeline.slice(first).entries()){
  assert.equal(row.mode,'generated');
  live.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  if(index===0)live=v8.RegionExecutionHarness.restore(JSON.parse(JSON.stringify(live.checkpoint())));
}
assert.deepEqual(live.exportEpisode(),pure.public);
assert.deepEqual(live.controller.completion.value,['num',8]);
await assert.rejects(v8.admitRegionEvidence(pure,{nativePolicy:v8.loadV8NativePolicy(),
  nativeConsumer:async()=>({admitted:true})}),/receipt is missing|missing fresh independent/);

const detailed=new v8.SelectedExecutionLifecycleV8();
detailed.publishProgram({programId:'p',source:'"use strict";function run(){return 7;}',entry:'run'});
detailed.admitInvocation({programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside'});
detailed.selected('call',v8.encodeDetailedRecord({kind:'return',fields:{value:['num',7]}}));
detailed.selected('call',v8.encodeDetailedRecord({kind:'end',fields:{kind:'return'}}));
assert.deepEqual(v8.SelectedExecutionLifecycleV8.restore(detailed.checkpoint()).timeline,detailed.timeline);

// The historical aggregate still eagerly loads its historical clients.
await assert.rejects(import('tracing-js-self/semantic'),/legacy dependency:/);
await assert.rejects(import('tracing-js-self/training'),/legacy dependency:/);
console.log(JSON.stringify({valid:true,entry:'tracing-js-self/semantic/v8',results,
  continuation:'restored-between-selected-records',nativeAdmission:'forged-receipt-refused',
  model:'engineering-only',defaultCutover:'not-claimed'}));
