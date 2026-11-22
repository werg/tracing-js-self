import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {encodeGenerationTask,decodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {verifyV8TaskArtifactBinding} from '../src/corpus/release-task-binding-v8.mjs';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';

const REVISION='c'.repeat(40),clone=structuredClone,observations=[],cache=new Map();
const plain={id:'normalization-source',family:'normalization-source',
  source:'"use strict";function run(x){return x+1;}',entry:'run',args:[2]};
const session={...plain,id:'normalization-session',sessionCases:[
  {...plain,args:[2]},{...plain,args:[4]}]};
const moduleFixture={id:'normalization-module',family:'normalization-module',
  modules:{'main.js':'export function run(x){return x+1;}'},moduleEntry:'main.js',args:[2]};
const sourceSide=artifact=>artifact.sidecar.schema==='semantic-protocol-host-region-evidence/1'?
  artifact.sidecar:artifact.sidecar.sourceArtifact.sidecar;
function task(fixture,kind='source'){
  return encodeGenerationTask({kind,traceVersion:8,producerRevision:REVISION,fixture});
}
async function generate(encoded){
  const decoded=decodeGenerationTask(encoded),fixture=decoded.fixture,
    options={...fixture,producerRevision:decoded.producerRevision,taskId:fixture.id};
  // These are the exact source/module calls made after the generation worker's
  // encoded graph boundary. No result is synthesized for the binding helper.
  try{return await (decoded.kind==='module'?verifyRegionModuleTrainingCase:verifyRegionTrainingCase)(options);}
  catch(error){return {status:'threw',reason:error.message};}
}
async function actual(fixture,kind='source'){
  const encoded=task(fixture,kind),key=JSON.stringify(encoded);
  if(!cache.has(key))cache.set(key,(async()=>{
    const result=await generate(encoded);assert.ok(result.exported,result.reason);
    return {task:encoded,artifact:JSON.parse(JSON.stringify(result.exported))};
  })());
  return cache.get(key);
}
async function accepts(name,fixture,kind='source',schema=null){
  const {task:encoded,artifact}=await actual(fixture,kind);
  if(schema)assert.equal(sourceSide(artifact).schema,schema);
  const binding=verifyV8TaskArtifactBinding(encoded,artifact);
  observations.push({name,expected:'accepted',actualSourceQualified:true,
    sourceSchema:sourceSide(artifact).schema,requestDigest:binding.requestDigest});
}
async function refusesChangedTask(name,fixture,mutate,kind='source'){
  const {task:encoded,artifact}=await actual(fixture,kind),changed=clone(encoded);
  mutate(changed.fixture);
  const observed=await generate(changed);
  assert.equal(observed.exported,undefined,'The original changed task must actually fail source qualification');
  observations.push({name,expected:'refused',actualSourceQualified:false,
    generationStatus:observed.status,generationReason:observed.reason});
  assert.throws(()=>verifyV8TaskArtifactBinding(changed,artifact),/V8 release task binding:/);
}

for(const [name,fields] of [
  ['omitted source defaults',{}],
  ['explicit null guest RNG',{randomSeed:null}],
  ['inherited guest RNG',{seeds:{guestRng:7}}],
  ['false empty fixture',{fixture:false}],
  ['zero empty fixture',{fixture:0}],
  ['empty-string fixture',{fixture:''}],
  ['ordinary source ignores the protocol-only ancestry alias',{ancestors:['unused-alias']}],
])test('task normalization preserves '+name,()=>accepts(name,{...plain,...fields},'source','semantic-supervision/8'));

test('task normalization preserves the direct protocol ancestry alias',()=>accepts('protocol ancestry alias',{
  ...plain,ancestors:['protocol-ancestor'],
  source:'"use strict";function run(x){const key=Symbol("key");const o={};o[key]=x;return o[key];}',
},'source','semantic-protocol-source-evidence/1'));

for(const field of ['fixture','license','trustTier','ancestorIds','seeds','seed'])
  test('task normalization refuses explicit null '+field+' rejected by ordinary source generation',()=>
    refusesChangedTask('ordinary null '+field,plain,fixture=>{fixture[field]=null;}));
test('task normalization refuses conflicting explicit-null and inherited guest RNG declarations',()=>
  refusesChangedTask('conflicting guest RNG',plain,fixture=>{
    fixture.randomSeed=null;fixture.seeds={guestRng:7};
  }));

test('task normalization preserves omitted ordered-session defaults',()=>accepts('session defaults',session));
for(const field of ['seed','sessionId'])
  test('task normalization refuses explicit null session '+field,()=>
    refusesChangedTask('session null '+field,session,fixture=>{fixture[field]=null;}));
test('task normalization preserves explicit ordered-session seed and identity',()=>
  accepts('session explicit plan',{...session,seed:0,sessionId:'explicit-source-session'}));
test('task normalization derives session ancestry from its actual ordered components',()=>
  accepts('session component ancestry',{...session,sessionCases:[
    {...plain,args:[2],ancestorIds:['first-origin']},
    {...plain,args:[4],ancestorIds:['second-origin']},
  ]}));

for(const field of ['experimentalNamespacePlan','experimentalSchedulerPlan'])
  test('task normalization preserves the module null default for '+field,()=>
    accepts('module null '+field,{...moduleFixture,[field]:null},'module'));
test('task normalization preserves module null host-fixture default',()=>
  accepts('module null fixture',{...moduleFixture,fixture:null},'module'));
test('task normalization preserves explicit namespace-profile nullable custody defaults',()=>
  accepts('namespace nullable custody',{
    id:'normalization-namespace',family:'normalization-namespace',
    modules:{'main.js':'import * as view from "./value.js";export function run(){return view.value;}',
      'value.js':'export const value=4;'},moduleEntry:'main.js',args:[],
    experimentalNamespacePlan:true,license:null,trustTier:null,
  },'module','semantic-protocol-source-evidence/1'));

test('task normalization refuses null custody rejected by mixed host-protocol generation',async()=>{
  const fixture=clone(HOST_PROTOCOL_FIXTURES_V8[0]);
  const {artifact}=await actual(fixture);
  assert.equal(sourceSide(artifact).schema,'semantic-protocol-host-region-evidence/1');
  await refusesChangedTask('mixed host null license',fixture,changed=>{changed.license=null;});
});

after(()=>{if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'task-normalization-observations.json'),
  JSON.stringify({schema:'semantic-v8-task-normalization-controls/1',observations,
    actualProducerGeneration:true,nativeAdmissions:0,optimizerUpdates:0},null,2)+'\n');});
