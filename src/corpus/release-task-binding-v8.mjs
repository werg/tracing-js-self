// Establish what was requested before replaying what an artifact claims.
// This is a read-only JSON/graph comparison; it imports no semantic compiler.
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import {encodeNativeGraph,decodeOwnedGraph} from '../host/graph-codec.js';

const fail=message=>{throw new Error('V8 release task binding: '+message);};
const demand=(condition,message)=>{if(!condition)fail(message);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>0;
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(sorted(value))).digest('hex');
function sorted(value){
  if(value===null||typeof value!=='object')return value;
  return Array.isArray(value)?value.map(sorted):Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]));
}
const clean=value=>JSON.parse(JSON.stringify(value));
const ancestors=(values,family)=>{
  demand(Array.isArray(values)&&values.every(text),'invalid original source ancestry');
  return [...new Set(values.filter(value=>value!==family))].sort();
};
const emptyFixture=()=>({calls:[],settlementOrder:null});
const sourceSide=artifact=>artifact?.sidecar?.schema==='semantic-protocol-host-region-evidence/1'?
  artifact.sidecar:artifact?.sidecar?.sourceArtifact?.sidecar;
function seed(fixture){
  demand(fixture.seeds===undefined||record(fixture.seeds),'original RNG settings are not a seed record');
  const seeds=fixture.seeds??{},value=Object.hasOwn(fixture,'randomSeed')?fixture.randomSeed:seeds.guestRng??null;
  demand(value===null||Number.isInteger(value)&&value>=0&&value<=0xffffffff,
    'original guest RNG seed is not a uint32 or null');
  demand(seeds.guestRng===undefined||seeds.guestRng===value,
    'original declared guest RNG seed differs from its executed fixture');
  return value;
}

function graph(value){
  demand(record(value)&&value.schema==='owned-graph/1','original task has no encoded argument graph');
  // Re-encoding proves canonical graph IDs, aliases, scalar tags and prototypes.
  const canonical=encodeNativeGraph(decodeOwnedGraph(JSON.stringify(value)));
  demand(equal(canonical,value),'original task argument graph is not canonical');
  return value;
}

function sourceRequest(fixture){
  demand(text(fixture.source)&&text(fixture.entry),'original source or entry is missing');
  return {source:fixture.source,entry:fixture.entry,inputGraph:graph(fixture.argsGraph),
    fixture:fixture.fixture??emptyFixture(),randomSeed:seed(fixture)};
}

function checkSource(fixture,artifact,revision,{taskId,ancestry=fixture.ancestorIds??fixture.ancestors??[]}={}){
  const side=sourceSide(artifact),reference=side?.referenceInput;
  demand(record(side)&&record(reference)&&side.producerRevision===revision,
    'artifact has no original source at the frozen producer revision');
  demand(side.sourceFamily===fixture.family&&artifact.sidecar.sourceFamily===fixture.family&&
    artifact.sidecar.family===fixture.family&&
    equal(ancestors(side.ancestorIds??[],fixture.family),ancestors(ancestry,fixture.family)),
  'artifact family or ancestry differs from the original task');
  demand(side.sourceLineage===undefined||side.sourceLineage===fixture.family,
    'artifact source lineage differs from the original task');
  if(side.taskId!==undefined)demand(side.taskId===(taskId??fixture.taskId??fixture.family),
    'artifact task ID differs from the original task');
  demand(side.license===(fixture.license??'repository-fixture')&&
    side.trustTier===(fixture.trustTier??'repository-fixture'),
  'artifact source custody differs from the original task');
  const request=sourceRequest(fixture);
  if(side.schema==='semantic-protocol-source-evidence/1'){
    demand(equal(request.fixture,emptyFixture())&&request.randomSeed===null,
      'protocol source artifact omitted original external inputs or random seed');
    const expected={source:request.source,entry:request.entry,inputGraph:request.inputGraph,
      ...(reference.awaitReturnedPromise===true?{awaitReturnedPromise:true}:{})};
    demand(equal(reference,expected),'protocol source request differs from the original task');
  }else{
    demand(['semantic-supervision/8','semantic-protocol-host-region-evidence/1'].includes(side.schema),
      'unsupported original source evidence');
    demand(equal(reference,request),'source, entry, argument graph, host fixture or RNG seed differs from the original task');
  }
  return request;
}

function moduleRequest(fixture){
  demand(record(fixture.modules)&&Object.keys(fixture.modules).length>0,'original module graph is missing');
  const modules={};
  for(const [name,source] of Object.entries(fixture.modules)){
    const id=name.startsWith('/')?name.slice(1):name;
    demand(text(id)&&typeof source==='string'&&posix.normalize(id)===id&&
      !id.startsWith('../')&&!/[\\?#\0]/.test(id)&&!Object.hasOwn(modules,id),
    'original module graph has noncanonical or duplicate paths');
    Object.defineProperty(modules,id,{value:source,enumerable:true,writable:true,configurable:true});
  }
  const originalEntry=fixture.moduleEntry??fixture.entryModule;
  demand(text(originalEntry),'original module entry is missing');
  const entryModule=originalEntry.startsWith('/')?originalEntry.slice(1):originalEntry;
  demand(Object.hasOwn(modules,entryModule),'original module entry is outside its graph');
  const args=decodeOwnedGraph(JSON.stringify(graph(fixture.argsGraph))),calls=fixture.calls??null;
  demand(calls===null||Array.isArray(calls)&&calls.length>0&&args.length===0&&calls.every(call=>
    record(call)&&equal(Object.keys(call).sort(),['args','exportName'])&&text(call.exportName)&&Array.isArray(call.args)),
  'invalid original module call sequence');
  for(const key of ['experimentalNamespacePlan','experimentalSchedulerPlan'])
    demand(fixture[key]===undefined||typeof fixture[key]==='boolean','module plan switch must be boolean');
  const input=calls===null?{args}:{calls:calls.map(call=>({args:call.args}))};
  return {modules,entryModule,exportName:fixture.exportName??'run',
    inputGraph:encodeNativeGraph([input],{maxBytes:1048576}),
    calls:calls===null?null:calls.map(({exportName})=>({exportName})),
    ...(fixture.experimentalNamespacePlan===true?{experimentalNamespacePlan:true}:{}),
    ...(fixture.experimentalSchedulerPlan===true?{experimentalSchedulerPlan:true}:{})};
}

function checkRegistry(task,artifact,registry,expectedSourceId){
  const side=artifact.sidecar,binding=side.datasetBinding,identity=side.splitIdentity,fixture=task.fixture;
  demand(record(registry)&&registry.schema==='semantic-region-family-registry/1'&&
    Array.isArray(registry.sources)&&Array.isArray(registry.components),'original family registry is missing');
  const {digest:registryDigest,...body}=registry;
  demand(digest(body)===registryDigest,'original family registry digest differs');
  demand(text(expectedSourceId),'original task has no explicit physical source identity');
  // The committed case label can differ from regionFamilyMembership's physical
  // source ID. Select the independently recorded identity, then compare all of
  // its frozen original-source and split fields; never infer it from a filename.
  const members=registry.sources.filter(row=>row.id===expectedSourceId),
    components=registry.components.filter(row=>row.sourceIds.includes(expectedSourceId));
  demand(members.length===1&&components.length===1,'original task has no unique frozen registry membership');
  const member=members[0],component=components[0],source=sourceSide(artifact);
  demand(member.family===fixture.family&&member.source===source.referenceInput.source&&
    member.entry===source.referenceInput.entry&&member.sourceDigest===digest(member.source)&&
    equal(member.ancestors,ancestors(source.ancestorIds??[],fixture.family)),
  'artifact source is not the original task registry member');
  const expected={schema:'semantic-region-split-identity/1',policy:'semantic-region-family-components/1',
    traceFormat:'semantic-trace/8',registryDigest,seed:registry.seed,sourceId:expectedSourceId,
    family:member.family,ancestors:member.ancestors,entry:member.entry,sourceDigest:member.sourceDigest,
    coreDigest:member.coreDigest,coreStatus:member.coreStatus,componentId:component.id,
    members:component.members,split:component.split,holdout:component.holdout,registry};
  demand(equal(identity,expected),'artifact split identity differs from the original task registry membership');
  const direct=side.schema==='semantic-protocol-host-region-evidence/1';
  const expectedBinding={schema:'semantic-region-dataset-binding/1',traceFormat:'semantic-trace/8',
    episodeDigest:digest(artifact.public),contextsDigest:digest(artifact.contexts),
    sourceArtifactDigest:direct?null:digest(side.sourceArtifact),
    ...(direct?{sourceIdentityDigest:side.identityDigest}:{}),
    ...(Object.hasOwn(side,'orchestrationTranscript')?{orchestrationTranscriptDigest:digest(side.orchestrationTranscript)}:{}),
    registryDigest,componentId:component.id,split:component.split,sourceId:expectedSourceId,family:member.family,
    sourceDigest:member.sourceDigest,coreDigest:member.coreDigest};
  demand(equal(binding,expectedBinding)&&side.split===component.split&&
    side.sourceComponent===component.id&&side.familyRegistryDigest===registryDigest,
  'artifact dataset binding differs from the original task registry membership');
  return {sourceId:expectedSourceId,split:component.split,registryDigest};
}

export function verifyV8TaskArtifactBinding(task,artifact,{registry=null,expectedSourceId=null}={}){
  demand(record(task)&&task.traceVersion===8&&['source','module'].includes(task.kind)&&
    record(task.fixture)&&text(task.fixture.id)&&text(task.fixture.family),
  'invalid original encoded task');
  demand(artifact?.public?.schema==='semantic-execution/8'&&record(artifact.sidecar),
    'task result has no V8 source artifact');
  const fixture=task.fixture,side=sourceSide(artifact);
  demand(fixture.originalReferenceSource===undefined,
    'transformed original-source tasks need an explicit original-source binding before release');
  demand(fixture.orchestrationTeacher===undefined||typeof fixture.orchestrationTeacher==='boolean',
    'original orchestration teacher switch must be boolean');
  demand(Object.hasOwn(artifact.sidecar,'orchestrationTranscript')===(fixture.orchestrationTeacher===true),
    'artifact orchestration teacher requirement differs from the original task');
  let request;
  if(task.kind==='module'){
    request=moduleRequest(fixture);
    const evidence=side?.sourceProvenance?.upstream?.moduleEvidence;
    demand(evidence?.schema==='semantic-module-evidence/1'&&equal(evidence.request,request)&&
      evidence.graphDigest===digest(request.modules),'original module graph, entry, export or argument/call graph differs');
    const ancestry=[...(fixture.ancestorIds??[]),'module-graph:'+digest(request.modules),
      ...Object.values(request.modules).map(source=>'module-source:'+digest(source))];
    checkSource({...fixture,source:side.referenceInput?.source,entry:side.referenceInput?.entry,
      argsGraph:request.inputGraph},artifact,task.producerRevision,{taskId:fixture.id,ancestry});
  }else if(Object.hasOwn(fixture,'sessionCases')){
    const cases=fixture.sessionCases,collection=side?.collection,reference=side?.referenceInput;
    demand(Array.isArray(cases)&&cases.length>=2&&side?.schema==='semantic-session-source-evidence/1'&&
      collection?.schema==='semantic-source-session-collection/1'&&
      Array.isArray(collection.components)&&collection.components.length===cases.length&&
      reference?.source===fixture.source&&reference.entry===fixture.entry&&
      side.producerRevision===task.producerRevision&&side.sourceFamily===fixture.family&&
      equal(ancestors(side.ancestorIds??[],fixture.family),ancestors(fixture.ancestorIds??[],fixture.family))&&
      collection.plan?.seed===(fixture.seed??17)&&collection.plan.sessionId===(fixture.sessionId??'source-session-v8'),
    'original ordered source-session plan differs');
    const invocations=cases.map((item,index)=>checkSource({...item,family:fixture.family},
      collection.components[index],task.producerRevision));
    request={source:fixture.source,entry:fixture.entry,invocations};
    demand(equal(reference,request),'source-session component count, order or inputs differ from the original task');
  }else request=checkSource(fixture,artifact,task.producerRevision,{taskId:fixture.id});
  const membership=registry===null?null:checkRegistry(task,artifact,registry,expectedSourceId);
  return {schema:'semantic-v8-release-task-artifact-binding/1',caseId:fixture.id,kind:task.kind,
    taskDigest:digest(clean(task)),requestDigest:digest(request),
    sourceEvidenceDigest:digest(side),membership,orchestrationTeacher:fixture.orchestrationTeacher===true};
}

export function verifyV8RecordedAdmissionBinding(source,admitted,receipt,policy,producerRevision){
  demand(record(source?.sidecar)&&record(receipt)&&record(policy),
    'recorded native admission has no source, receipt or frozen policy');
  // This is the complete mutation performed by admitRegionEvidence. A native
  // copy for a different source cannot become this source by renaming a file.
  const expected={...source,sidecar:{...source.sidecar,admission:'admitted',nativeAdmission:receipt}};
  demand(equal(admitted,expected),'recorded admitted artifact differs from the original task source');
  const direct=source.sidecar.schema==='semantic-protocol-host-region-evidence/1',
    teacher=Object.hasOwn(source.sidecar,'orchestrationTranscript'),
    publicDigest=digest(source.public),contextsDigest=digest(source.contexts),
    sourceArtifactDigest=direct?null:digest(source.sidecar.sourceArtifact),
    transportSha256=digest(JSON.stringify(source)+'\n');
  const links={publicDigest,contextsDigest,sourceArtifactDigest,
    datasetBindingDigest:source.sidecar.datasetBinding?digest(source.sidecar.datasetBinding):null,
    ...(direct?{sourceIdentityDigest:source.sidecar.identityDigest}:{}),
    ...(teacher?{orchestrationTranscriptDigest:digest(source.sidecar.orchestrationTranscript)}:{})};
  demand(receipt.schema==='semantic-native-admission/8'&&receipt.admitted===true&&
    receipt.optimizerSteps===0&&receipt.learningClaim===null&&
    Object.entries(links).every(([key,value])=>equal(receipt[key],value))&&
    (direct||!Object.hasOwn(receipt,'sourceIdentityDigest'))&&
    (teacher||!Object.hasOwn(receipt,'orchestrationTranscriptDigest')),
  'recorded native receipt is bound to another source or claim');
  for(const key of ['consumerRevision','contractDigest','fixtureDigest','interoperabilityDigest'])
    demand(receipt[key]===policy[key],'recorded native receipt differs from the frozen '+key);
  demand(receipt.tokenizer?.status==='passed'&&receipt.tokenizer.identity===policy.tokenizerIdentity&&
    receipt.tokenizer.sha256===policy.tokenizerSha256,'recorded native tokenizer differs from frozen policy');
  const verification=receipt.sourceVerification;
  demand(verification?.schema==='semantic-native-source-recheck/1'&&verification.producerRevision===producerRevision&&
    verification.producerTreeClean===true&&verification.sourceValidated===true&&
    verification.projectionValidated===true&&verification.replayValidated===true&&
    verification.artifactSha256===transportSha256&&verification.publicDigest===publicDigest&&
    verification.contextDigest===contextsDigest&&verification.sourceArtifactDigest===sourceArtifactDigest&&
    (direct?verification.sourceIdentityDigest===source.sidecar.identityDigest&&verification.identityValidated===true:
      !Object.hasOwn(verification,'sourceIdentityDigest'))&&
    (teacher?verification.orchestrationTranscriptDigest===links.orchestrationTranscriptDigest&&
      verification.orchestrationValidated===true:!Object.hasOwn(verification,'orchestrationTranscriptDigest')&&
      !Object.hasOwn(verification,'orchestrationValidated')),
  'recorded native source verification differs from the original task source and transport bytes');
  return {schema:'semantic-v8-release-recorded-native-binding/1',transportSha256,
    nativeReceiptDigest:digest(receipt),admittedArtifactDigest:digest(admitted),
    authority:'Recorded correspondence only; independent fresh native admission remains required'};
}
