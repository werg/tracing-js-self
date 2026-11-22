import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {encodeGenerationTask,decodeGenerationTask} from '../producer-promise-then-profile/src/corpus/generation-process.mjs';
import {verifyV8TaskArtifactBinding} from '../producer-promise-then-profile/src/corpus/release-task-binding-v8.mjs';
import {verifyRegionTrainingCase} from '../producer-promise-then-profile/src/semantic/compiler-v8.js';
import {verifyRegionModuleTrainingCase} from '../producer-promise-then-profile/src/semantic/module-v8.js';
import {effectfulFamilySplit} from '../producer-promise-then-profile/src/semantic/source-identity.js';

const source={id:'request-field-review',family:'request-field-review',
  source:'"use strict";function run(x){return (x+1)*(x+2);}',entry:'run',args:[2]};
const protocol={...source,id:'request-field-protocol',family:'request-field-protocol',
  source:'"use strict";function run(x){const key=Symbol("k");const o={};o[key]=x;return o[key];}'};
const moduleFixture={id:'request-field-module',family:'request-field-module',moduleEntry:'main.js',args:[2],
  modules:{'main.js':'export function run(x){return (x+1)*(x+2);}'} };
const session={id:'request-field-session',family:'request-field-session',sessionCases:[source,{...source,args:[4]}]};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceSide=artifact=>artifact.sidecar.schema==='semantic-protocol-host-region-evidence/1'?
  artifact.sidecar:artifact.sidecar.sourceArtifact.sidecar;
const cache=new Map();
async function generate(fixture,kind='source'){
  const task=encodeGenerationTask({kind,traceVersion:8,producerRevision:'c'.repeat(40),fixture}),key=JSON.stringify(task);
  if(!cache.has(key))cache.set(key,(async()=>{
    const decoded=decodeGenerationTask(task),options={...decoded.fixture,taskId:decoded.fixture.id,producerRevision:task.producerRevision};
    let result;
    try{result=await (kind==='module'?verifyRegionModuleTrainingCase:verifyRegionTrainingCase)(options);}
    catch(error){result={status:'threw',reason:error.message};}
    return {task,result,artifact:result.exported?JSON.parse(JSON.stringify(result.exported)):null};
  })());
  return cache.get(key);
}
let splitSeed=0;
while(effectfulFamilySplit(source.family,{seed:splitSeed})===effectfulFamilySplit(source.family,{seed:17}))splitSeed++;
const cases=[
  ['ordinary ownership session',source,{projectionOptions:{sessionId:'different-owned-session'}}],
  ['ordinary generated-record cap',source,{projectionOptions:{maxGenerated:1}}],
  ['ordinary expression operator cap',source,{projectionOptions:{maxOperators:1}}],
  ['ordinary non-guest seed metadata',source,{seeds:{generation:11,input:12,schedule:13,optimizer:14}}],
  ['ordinary original split seed',source,{seed:splitSeed}],
  ['module ownership session',moduleFixture,{projectionOptions:{sessionId:'different-module-session'}},'module'],
  ['session outer ignored projection options',session,{projectionOptions:{sessionId:'unused-outer-session'}}],
  ['session overridden component ownership',session,{sessionCases:session.sessionCases.map(item=>({...item,
    projectionOptions:{sessionId:'overridden-component-session'}}))}],
  ['direct protocol ignored ownership option',protocol,{projectionOptions:{sessionId:'unused-protocol-session'}}],
];
const rows=[];
for(const [name,fixture,fields,kind='source'] of cases){
  const original=await generate(fixture,kind),changed=await generate({...fixture,...fields},kind);
  if(!original.artifact)throw new Error('base failed: '+name+': '+original.result.reason);
  let wrongTaskAccepted=false,bindingError=null;
  try{verifyV8TaskArtifactBinding(changed.task,original.artifact);wrongTaskAccepted=true;}
  catch(error){bindingError=error.message;}
  const before=sourceSide(original.artifact),after=changed.artifact?sourceSide(changed.artifact):null;
  const row={name,kind,changedFields:fields,originalQualified:true,changedQualified:Boolean(changed.artifact),
    changedStatus:changed.result.status,changedReason:changed.result.reason??null,wrongTaskAccepted,bindingError,
    originalArtifactSha256:digest(original.artifact),changedArtifactSha256:changed.artifact?digest(changed.artifact):null,
    publicEqual:changed.artifact?equal(original.artifact.public,changed.artifact.public):null,
    contextsEqual:changed.artifact?equal(original.artifact.contexts,changed.artifact.contexts):null,
    sourceSchema:before.schema,metadata:[]};
  for(const key of ['projectionOptions','executionLimits','seeds','splitIdentity','sourceProvenance'])
    if(after&&!equal(before[key],after[key]))row.metadata.push({field:key,
      before:key==='sourceProvenance'?{seed:before[key]?.seed}:before[key]??null,
      after:key==='sourceProvenance'?{seed:after[key]?.seed}:after[key]??null});
  rows.push(row);console.log(JSON.stringify({name,changedQualified:row.changedQualified,
    wrongTaskAccepted,publicEqual:row.publicEqual,contextsEqual:row.contextsEqual,metadata:row.metadata.map(x=>x.field)}));
}
writeFileSync('/workspace/scratch/05d92519587f/task-normalization-proof/request-field-review.json',
  JSON.stringify({schema:'semantic-v8-request-field-readonly-observation/1',
    sourceRevision:'182c3f0fa9cce1065d9c4ef6ed10942b6ca2c30b',
    qualification:'Bounded actual-generation diagnostic only; not a repository test or native admission',
    nativeAdmissions:0,optimizerUpdates:0,rows},null,2)+'\n');
