import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {verifyV8TaskArtifactBinding} from '../src/corpus/release-task-binding-v8.mjs';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {bindRegionFamilySplit} from '../src/semantic/dataset-v8.js';
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
const bind=(task,artifact)=>verifyV8TaskArtifactBinding(task,artifact,{registry:cohort.registry});

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
  assert.throws(()=>verifyV8TaskArtifactBinding(first.task,first.artifact,{registry}),/original task registry member/);
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
  });
});
