import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import {encodeGenerationTask,decodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {verifyV8TaskArtifactBinding} from '../src/corpus/release-task-binding-v8.mjs';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';

const REVISION='d'.repeat(40),cache=new Map(),observations=[];
const source={id:'request-field-review',family:'request-field-review',
  source:'"use strict";function run(x){return (x+1)*(x+2);}',entry:'run',args:[2]};
const protocol={...source,id:'request-field-protocol',family:'request-field-protocol',
  source:'"use strict";function run(x){const key=Symbol("k");const o={};o[key]=x;return o[key];}'};
const moduleFixture={id:'request-field-module',family:'request-field-module',moduleEntry:'main.js',args:[2],
  modules:{'main.js':'export function run(x){return (x+1)*(x+2);}'} };
const session={id:'request-field-session',family:'request-field-session',sessionCases:[source,{...source,args:[4]}]};
const namespace={id:'request-field-namespace',family:'request-field-namespace',moduleEntry:'main.js',args:[],
  experimentalNamespacePlan:true,modules:{'main.js':'import * as ns from "./value.js";export function run(){return Object.keys(ns);}',
    'value.js':'export const value=4;'}};
const side=artifact=>artifact.sidecar.schema==='semantic-protocol-host-region-evidence/1'?
  artifact.sidecar:artifact.sidecar.sourceArtifact.sidecar;
async function generate(fixture,kind='source'){
  const task=encodeGenerationTask({kind,traceVersion:8,producerRevision:REVISION,fixture}),key=JSON.stringify(task);
  if(!cache.has(key))cache.set(key,(async()=>{
    const decoded=decodeGenerationTask(task),options={...decoded.fixture,taskId:fixture.id,producerRevision:REVISION};
    let result;
    try{result=await (kind==='module'?verifyRegionModuleTrainingCase:verifyRegionTrainingCase)(options);}
    catch(error){result={status:'threw',reason:error.message};}
    return {task,result,artifact:result.exported?JSON.parse(JSON.stringify(result.exported)):null};
  })());
  return cache.get(key);
}
async function changedRequest(name,fixture,fields,{kind='source',qualified=true,publicChanged=false,inspect=()=>{}}={}){
  const original=await generate(fixture,kind),changed=await generate({...fixture,...fields},kind);
  assert.ok(original.artifact,original.result.reason);
  assert.doesNotThrow(()=>verifyV8TaskArtifactBinding(original.task,original.artifact));
  assert.equal(Boolean(changed.artifact),qualified,changed.result.reason);
  if(qualified){
    assert.doesNotThrow(()=>verifyV8TaskArtifactBinding(changed.task,changed.artifact));
    assert.equal(!equal(original.artifact.public,changed.artifact.public),publicChanged);
    assert.equal(!equal(original.artifact.contexts,changed.artifact.contexts),publicChanged);
    inspect(original.artifact,changed.artifact);
  }
  assert.throws(()=>verifyV8TaskArtifactBinding(changed.task,original.artifact),/V8 release task binding:/);
  observations.push({name,expected:'old artifact refused',changedQualified:qualified,
    changedStatus:changed.result.status,changedReason:changed.result.reason??null,publicChanged:qualified?publicChanged:null});
}
async function ignoredRequest(name,fixture,fields,kind='source'){
  const original=await generate(fixture,kind),changed=await generate({...fixture,...fields},kind);
  assert.ok(original.artifact,original.result.reason);assert.ok(changed.artifact,changed.result.reason);
  assert.deepEqual(changed.artifact,original.artifact,'The producer genuinely ignores or overrides these fields');
  assert.doesNotThrow(()=>verifyV8TaskArtifactBinding(changed.task,original.artifact));
  observations.push({name,expected:'same artifact accepted',changedQualified:true,wholeArtifactUnchanged:true});
}

test('ordinary source projection ownership binds actual changed public records and contexts',()=>
  changedRequest('source session identity',source,{projectionOptions:{sessionId:'different-owned-session'}},{publicChanged:true}));
test('ordinary module projection ownership binds actual changed public records and contexts',()=>
  changedRequest('module session identity',moduleFixture,{projectionOptions:{sessionId:'different-module-session'}},
    {kind:'module',publicChanged:true}));
for(const [name,fixture,kind] of [['source',source,'source'],['module',moduleFixture,'module'],['direct protocol',protocol,'source']])
  test(name+' generated-record cap cannot borrow a successful artifact from another bound',()=>
    changedRequest(name+' record cap',fixture,{projectionOptions:{maxGenerated:1}},{kind,qualified:false}));
test('ordinary source instruction cap must match actual bounded generation',()=>
  changedRequest('source instruction cap',source,{maxSteps:1},{qualified:false}));
test('ordinary source invalid deadline cannot borrow a prior successful artifact',()=>
  changedRequest('source deadline refusal',source,{timeoutMs:0},{qualified:false}));
test('ordinary source retained deadline is bound even when both executions finish',()=>
  changedRequest('source recorded deadline',source,{timeoutMs:9999},{inspect:(before,after)=>{
    assert.equal(side(before).executionLimits.timeoutMs,10000);assert.equal(side(after).executionLimits.timeoutMs,9999);
  }}));
test('ordinary source operator bound is tied to its recorded options and execution limits',()=>
  changedRequest('source operator bound',source,{projectionOptions:{maxOperators:1}},{inspect:(before,after)=>{
    assert.equal(side(before).executionLimits.maxOperators,8);assert.equal(side(after).executionLimits.maxOperators,1);
  }}));
test('ordinary source non-guest seeds bind private source identity without claiming a public semantic difference',()=>
  changedRequest('source private seeds',source,{seeds:{generation:11,input:12,schedule:13,optimizer:14}},
    {inspect:(before,after)=>{
      assert.notDeepEqual(side(before).seeds,side(after).seeds);
      assert.notEqual(side(before).identityDigest,side(after).identityDigest);
    }}));
test('ordinary source split seed binds its original split identity',()=>
  changedRequest('source original split',source,{seed:0},{inspect:(before,after)=>{
    assert.equal(side(before).splitIdentity.seed,17);assert.equal(side(after).splitIdentity.seed,0);
    assert.notEqual(side(before).splitIdentity.split,side(after).splitIdentity.split);
  }}));
test('ordered-session component record caps remain material after session ownership overrides',()=>
  changedRequest('session component record cap',session,{sessionCases:[source,
    {...source,args:[4],projectionOptions:{maxGenerated:1}}]},{qualified:false}));
test('ordered-session component private seeds remain bound after the outer split seed override',()=>
  changedRequest('session component private seeds',session,{sessionCases:[source,
    {...source,args:[4],seeds:{optimizer:14}}]}));

test('ordered-session outer projection options and limits remain genuinely ignored',()=>
  ignoredRequest('session ignored outer options',session,{projectionOptions:{sessionId:'unused',maxGenerated:1},
    seeds:{optimizer:14},maxSteps:1,timeoutMs:0}));
test('ordered-session component ownership options retain the actual forced identities',()=>
  ignoredRequest('session overridden ownership',session,{sessionCases:session.sessionCases.map(item=>({...item,
    projectionOptions:{sessionId:'unused',programId:'unused',invocationId:'unused',trackId:'unused',realmId:'unused',
      realmPolicy:'retained',triggerId:'unused'}}))}));
test('direct protocol ignores ownership and operator options outside its actual profile',()=>
  ignoredRequest('protocol ignored projection',protocol,{projectionOptions:{sessionId:'unused',maxOperators:1}}));
test('direct protocol ignores valid non-guest seed metadata discarded by that profile',()=>
  ignoredRequest('protocol ignored seed metadata',protocol,{seed:0,seeds:{generation:11,input:12,schedule:13,optimizer:14}}));
test('direct protocol preserves its nullable generated-record default',()=>
  ignoredRequest('protocol null record default',protocol,{projectionOptions:{maxGenerated:null}}));
test('module caller still strips untrusted projection plans before source admission',()=>
  ignoredRequest('module stripped plans',moduleFixture,{projectionOptions:{moduleNamespacePlan:{untrusted:true},
    moduleSchedulerPlan:{untrusted:true}}},'module'));
test('explicit namespace module profile ignores ownership options and nullable source limit defaults',()=>
  ignoredRequest('namespace ignored ownership',namespace,{projectionOptions:{sessionId:'unused',maxGenerated:null},
    maxSteps:null,timeoutMs:null},'module'));

after(()=>{if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'request-field-observations.json'),
  JSON.stringify({schema:'semantic-v8-request-field-controls/1',observations,actualProducerGeneration:true,
    nativeAdmissions:0,optimizerUpdates:0},null,2)+'\n');});
