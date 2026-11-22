import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {verifyV8TaskArtifactBinding} from '../src/corpus/release-task-binding-v8.mjs';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {bindRegionFamilySplit,regionFamilyMembership,prepareRegionFamilyRegistry} from '../src/semantic/dataset-v8.js';
import {attachSourceQualifiedOrchestrationV8} from '../src/semantic/orchestration-training-v8.js';
import {buildSemanticRegionSupportCohortV8} from '../fixtures/semantic-regions/support-cohort.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';

const REVISION='a'.repeat(40),clone=structuredClone,cohort=buildSemanticRegionSupportCohortV8();
const cache=new Map();
async function source(index){
  if(cache.has(index))return cache.get(index);
  const fixture=clone(cohort.fixtures[index]),task=encodeGenerationTask({kind:'source',traceVersion:8,
    producerRevision:REVISION,fixture});
  const result=await verifyRegionTrainingCase({...fixture,taskId:fixture.id,producerRevision:REVISION});
  assert.ok(result.exported,result.reason);
  let artifact=result.exported;
  if(fixture.orchestrationTeacher)artifact=await attachSourceQualifiedOrchestrationV8(artifact);
  const membership=cohort.registry.sources.find(row=>row.id===fixture.id);
  artifact=bindRegionFamilySplit(artifact,membership,cohort.registry);
  const value={task,artifact:JSON.parse(JSON.stringify(artifact))};cache.set(index,value);return value;
}
const bind=(task,artifact)=>verifyV8TaskArtifactBinding(task,artifact,
  {registry:cohort.registry,expectedSourceId:task.fixture.id});

test('original source, callback fixture, ordered session and teacher requests bind actual source artifacts',async t=>{
  for(const [index,name] of ['pure','callbacks-recovery','repeated-two-calls','child-teacher'].entries())
    await t.test(name,async()=>{
      const {task,artifact}=await source(index),receipt=bind(task,artifact);
      assert.equal(receipt.caseId,task.fixture.id);assert.equal(receipt.membership.sourceId,task.fixture.id);
      assert.equal(receipt.membership.registryDigest,cohort.registry.digest);
      assert.equal(receipt.orchestrationTeacher,index===3);
    });
});

test('individually valid source artifacts cannot be swapped between original frozen task IDs',async()=>{
  const first=await source(0),other=await source(4);
  assert.doesNotThrow(()=>bind(first.task,first.artifact));
  assert.doesNotThrow(()=>bind(other.task,other.artifact));
  assert.throws(()=>bind(first.task,other.artifact),/original task/);
  assert.throws(()=>bind(other.task,first.artifact),/original task/);
});

test('coherent original-task substitutions cannot retain another artifact source or inputs',async t=>{
  const {task,artifact}=await source(0);
  const mutations={
    source:task=>{task.fixture.source='function run(){return 999;}';},
    entry:task=>{task.fixture.entry='another';},
    argument:task=>{task.fixture.argsGraph.roots[0]=['num',123];},
    'boolean-versus-number':task=>{task.fixture.argsGraph.roots[0]=['bool',true];},
    family:task=>{task.fixture.family='another-family';},
    ancestry:task=>{task.fixture.ancestorIds.push('different-ancestor');},
    'producer-revision':task=>{task.producerRevision='b'.repeat(40);},
    'task-id':task=>{task.fixture.id='different-task';},
    'random-seed':task=>{task.fixture.randomSeed=0;},
    'host-fixture':task=>{task.fixture.fixture.calls.push({operation:'demo.readAsync',status:'fulfilled',
      argumentGraph:encodeNativeGraph(['key']),resultGraph:encodeNativeGraph([123])});},
    'teacher-requirement':task=>{task.fixture.orchestrationTeacher=true;},
  };
  for(const [name,mutate] of Object.entries(mutations))await t.test(name,()=>{
    const changed=clone(task);mutate(changed);
    assert.throws(()=>bind(changed,artifact),/V8 release task binding:/);
  });
});

test('ordered session request binds every component including arguments and callback outcomes',async t=>{
  const {task,artifact}=await source(2);
  const mutations={
    order:task=>task.fixture.sessionCases.reverse(),
    omitted:task=>task.fixture.sessionCases.pop(),
    argument:task=>{task.fixture.sessionCases[1].argsGraph.roots[1]=['num',900];},
    'callback-outcome':task=>{task.fixture.sessionCases[1].fixture.calls[0].resultGraph.roots[0]=['num',900];},
  };
  for(const [name,mutate] of Object.entries(mutations))await t.test(name,()=>{
    const changed=clone(task);mutate(changed);assert.throws(()=>bind(changed,artifact),/V8 release task binding:/);
  });
});

test('relabeling a valid artifact and resealing its dataset hashes cannot replace frozen registry membership',async()=>{
  const first=await source(0),other=await source(4),changed=clone(first.artifact);
  changed.sidecar.splitIdentity=clone(other.artifact.sidecar.splitIdentity);
  changed.sidecar.datasetBinding={...changed.sidecar.datasetBinding,
    sourceId:other.task.fixture.id,sourceDigest:other.artifact.sidecar.datasetBinding.sourceDigest};
  assert.throws(()=>bind(first.task,changed),/split identity differs/);
  const registry=clone(cohort.registry);registry.sources.find(row=>row.id===first.task.fixture.id).source='function run(){return 0;}';
  const {digest,...body}=registry;registry.digest=hashAlgorithmData(body);
  assert.throws(()=>verifyV8TaskArtifactBinding(first.task,first.artifact,
    {registry,expectedSourceId:first.task.fixture.id}),/original task registry member/);
});

test('actual source membership keeps the case label separate from its digest-suffixed physical identity',async t=>{
  const fixture={id:'release-source-label',family:'release-source-family',ancestorIds:['original-template'],
    source:'"use strict";function run(value){return (value+2)*3;}',entry:'run',args:[4],fixture:{calls:[]}},
    task=encodeGenerationTask({kind:'source',traceVersion:8,producerRevision:REVISION,fixture}),
    result=await verifyRegionTrainingCase({...fixture,taskId:fixture.id,producerRevision:REVISION});
  assert.ok(result.exported,result.reason);
  const candidate={id:fixture.id,exported:result.exported},member=regionFamilyMembership(candidate),
    {registry}=prepareRegionFamilyRegistry([candidate],{seed:17}),
    artifact=JSON.parse(JSON.stringify(bindRegionFamilySplit(result.exported,member,registry))),
    options={registry,expectedSourceId:member.id},binding=verifyV8TaskArtifactBinding(task,artifact,options);
  assert.match(member.id,new RegExp('^'+fixture.id+':[a-f0-9]{40}$'));
  assert.equal(binding.caseId,fixture.id);assert.equal(binding.membership.sourceId,member.id);
  assert.notEqual(binding.caseId,binding.membership.sourceId);
  for(const [name,changed] of [['absent',null],['case-label',fixture.id],['another-physical-source',member.id+'0']])
    await t.test(name,()=>assert.throws(()=>verifyV8TaskArtifactBinding(task,artifact,
      {registry,expectedSourceId:changed}),/physical source identity|unique frozen registry membership/));
  await t.test('changed-split',()=>{
    const changed=clone(artifact);changed.sidecar.datasetBinding.split=
      binding.membership.split==='train'?'test':'train';
    assert.throws(()=>verifyV8TaskArtifactBinding(task,changed,options),/dataset binding differs/);
  });
});

test('original ancestry uses the existing normalized set identity without weakening different-ancestor refusal',async()=>{
  const {task,artifact}=await source(0),equivalent=clone(task);
  equivalent.fixture.ancestorIds.push(task.fixture.family,...task.fixture.ancestorIds);
  assert.doesNotThrow(()=>bind(equivalent,artifact));
  equivalent.fixture.ancestorIds.push('another-original-template');
  assert.throws(()=>bind(equivalent,artifact),/family or ancestry differs/);
});

test('the original host settlement schedule remains part of the request',async()=>{
  const {task,artifact}=await source(1),changed=clone(task);
  changed.fixture.fixture.settlementOrder=[0];
  assert.throws(()=>bind(changed,artifact),/host fixture or RNG seed differs/);
});

test('actual source RNG settings distinguish zero, omission, explicit null and conflicting guest declarations',async t=>{
  const fixture={id:'release-rng-request',family:'release-rng-request',
    source:'"use strict";function run(value){return value+1;}',entry:'run',args:[4],fixture:{calls:[]}};
  let nullArtifact;
  for(const [name,settings,expected] of [
    ['explicit-zero',{randomSeed:0},0],['guest-zero',{seeds:{guestRng:0}},0],
    ['omitted-random-with-guest-seed',{seeds:{guestRng:19}},19],
    ['explicit-null',{randomSeed:null},null],['matching-null',{randomSeed:null,seeds:{guestRng:null}},null],
  ])await t.test(name,async()=>{
    const input={...fixture,...settings},task=encodeGenerationTask({kind:'source',traceVersion:8,
      producerRevision:REVISION,fixture:input}),
      result=await verifyRegionTrainingCase({...input,taskId:fixture.id,producerRevision:REVISION});
    assert.ok(result.exported,result.reason);
    const artifact=JSON.parse(JSON.stringify(result.exported)),reference=artifact.sidecar.sourceArtifact.sidecar.referenceInput;
    assert.equal(reference.randomSeed,expected);assert.doesNotThrow(()=>verifyV8TaskArtifactBinding(task,artifact));
    const changed=clone(task);changed.fixture.randomSeed=expected===null?0:null;
    assert.throws(()=>verifyV8TaskArtifactBinding(changed,artifact),/RNG seed/);
    if(name==='explicit-null')nullArtifact=artifact;
  });
  for(const randomSeed of [null,0])await t.test('conflicting-guest-seed-with-'+String(randomSeed),async()=>{
    const input={...fixture,randomSeed,seeds:{guestRng:19}};
    await assert.rejects(verifyRegionTrainingCase({...input,taskId:fixture.id,producerRevision:REVISION}),
      /declared guest RNG seed must match/);
    const task=encodeGenerationTask({kind:'source',traceVersion:8,producerRevision:REVISION,fixture:input});
    assert.throws(()=>verifyV8TaskArtifactBinding(task,nullArtifact),/declared guest RNG seed differs/);
  });
});

test('original module graph, entry, export, aliases and ordered calls bind actual module evidence',async t=>{
  const shared={n:1},fixtures=[
    {id:'release-module-alias',family:'release-module',modules:{'main.js':'export function run(a,b){a.n++;return [a,b];}'},
      moduleEntry:'/main.js',args:[shared,shared],fixture:{calls:[]}},
    {id:'release-module-calls',family:'release-module',modules:{'main.js':'export let n=0;export function add(x){n+=x;return n;}export function read(){return n;}'},
      entryModule:'main.js',calls:[{exportName:'add',args:[3]},{exportName:'add',args:[4]},{exportName:'read',args:[]}],fixture:{calls:[]}},
  ];
  for(const fixture of fixtures)await t.test(fixture.id,async t=>{
    const task=encodeGenerationTask({kind:'module',traceVersion:8,producerRevision:REVISION,fixture}),
      result=await verifyRegionModuleTrainingCase({...fixture,producerRevision:REVISION,taskId:fixture.id});
    assert.ok(result.exported,result.reason);
    const artifact=JSON.parse(JSON.stringify(result.exported));
    assert.equal(verifyV8TaskArtifactBinding(task,artifact).kind,'module');
    const mutations={
      graph:task=>{task.fixture.modules['main.js']+='\n// changed original module bytes';},
      entry:task=>{task.fixture.moduleEntry='missing.js';},
      export:task=>{task.fixture.exportName='different';},
      'plan-boolean':task=>{task.fixture.experimentalNamespacePlan=0;},
      input:task=>{if(task.fixture.calls)task.fixture.calls[0].args=[900];
        else task.fixture.argsGraph=encodeNativeGraph([{n:1},{n:1}]);},
    };
    for(const [name,mutate] of Object.entries(mutations))await t.test(name,()=>{
      const changed=clone(task);mutate(changed);
      assert.throws(()=>verifyV8TaskArtifactBinding(changed,artifact),/V8 release task binding:/);
    });
  });
});

test('direct protocol and mixed host protocol requests bind their actual source evidence',async t=>{
  const fixtures=[
    {id:'release-protocol-source',family:'release-protocol-source',source:'"use strict";function run(x){const s=Symbol("key");const o={};o[s]=x+1;return o[s];}',entry:'run',args:[4]},
    clone(HOST_PROTOCOL_FIXTURES_V8[0]),
  ];
  for(const fixture of fixtures)await t.test(fixture.id,async()=>{
    const task=encodeGenerationTask({kind:'source',traceVersion:8,producerRevision:REVISION,fixture});
    const result=await verifyRegionTrainingCase({...fixture,producerRevision:REVISION,taskId:fixture.id});
    assert.ok(result.exported,result.reason);
    const artifact=JSON.parse(JSON.stringify(result.exported));
    assert.equal(verifyV8TaskArtifactBinding(task,artifact).caseId,fixture.id);
    if(fixture.id==='release-protocol-source'){
      const changed=clone(task);changed.fixture.fixture={calls:[{operation:'demo.readAsync',arguments:['required']}],settlementOrder:null};
      assert.throws(()=>verifyV8TaskArtifactBinding(changed,artifact),/omitted original external inputs/);
    }
  });
});
