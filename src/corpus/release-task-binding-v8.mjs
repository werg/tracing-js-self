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
const defaulted=(value,fallback)=>value===undefined?fallback:value;
function seed(fixture){
  // normalizeSeeds boxes falsy scalar metadata; null alone cannot be read.
  // Validate its values below without imposing a new record-only input rule.
  demand(fixture.seeds!==null,'original RNG settings cannot be null');
  const seeds=fixture.seeds??{},value=Object.hasOwn(fixture,'randomSeed')?fixture.randomSeed:seeds.guestRng??null;
  demand(value===null||Number.isInteger(value)&&value>=0&&value<=0xffffffff,
    'original guest RNG seed is not a uint32 or null');
  demand(seeds.guestRng===undefined||seeds.guestRng===value,
    'original declared guest RNG seed differs from its executed fixture');
  return value;
}

function sourceDefaults(fixture,{directModule=false}={}){
  // Source admission uses destructuring defaults (undefined only). Explicit
  // module plans enter the protocol source profile directly, whose nullable
  // custody defaults and ignored split-seed metadata are deliberately distinct.
  const license=directModule?fixture.license??'repository-fixture':defaulted(fixture.license,'repository-fixture'),
    trustTier=directModule?fixture.trustTier??'repository-fixture':defaulted(fixture.trustTier,'repository-fixture'),
    randomSeed=directModule?fixture.randomSeed??null:seed(fixture);
  demand(text(license)&&['repository-fixture','trusted-owned-source'].includes(trustTier),
    'invalid original source custody');
  let normalizedSeeds=null;
  if(!directModule){
    const seeds=defaulted(fixture.seeds,{}),split=defaulted(fixture.seed,17);
    normalizedSeeds={generation:null,input:null,schedule:null,optimizer:null,...seeds,guestRng:randomSeed,split};
    demand(Number.isSafeInteger(split)&&
      Object.values(normalizedSeeds).every(value=>value===null||Number.isSafeInteger(value)),
    'invalid original source seed declarations');
    demand([defaulted(fixture.maxSteps,100000),defaulted(fixture.timeoutMs,10000)]
      .every(value=>Number.isSafeInteger(value)&&value>0),'invalid original source execution limits');
  }
  // encodeGenerationTask already canonicalizes every truthy host fixture.
  // The producer also boxes these falsy primitives to an empty fixture; null
  // throws in ordinary source admission and is defaulted by the module caller.
  const value=fixture.fixture,host=value===undefined||value===false||value===0||value===''?emptyFixture():value;
  demand(record(host)&&Array.isArray(host.calls),'invalid original host fixture');
  return {license,trustTier,randomSeed,host,normalizedSeeds};
}

function sourceAncestors(fixture,protocol){
  const value=protocol?fixture.ancestorIds??fixture.ancestors??[]:defaulted(fixture.ancestorIds,[]);
  // Both source implementations spread the declared ancestry. JSON strings are
  // iterable too; validate the resulting IDs instead of changing that contract.
  demand(Array.isArray(value)||typeof value==='string','invalid original source ancestry');
  return [...value];
}

function graph(value){
  demand(record(value)&&value.schema==='owned-graph/1','original task has no encoded argument graph');
  // Re-encoding proves canonical graph IDs, aliases, scalar tags and prototypes.
  const canonical=encodeNativeGraph(decodeOwnedGraph(JSON.stringify(value)));
  demand(equal(canonical,value),'original task argument graph is not canonical');
  return value;
}

function sourceRequest(fixture,defaults){
  demand(text(fixture.source)&&text(fixture.entry),'original source or entry is missing');
  return {source:fixture.source,entry:fixture.entry,inputGraph:graph(fixture.argsGraph),
    fixture:defaults.host,randomSeed:defaults.randomSeed};
}

function checkSourceExecution(fixture,side,defaults){
  const protocol=side.schema==='semantic-protocol-source-evidence/1',options=fixture.projectionOptions;
  const limits=protocol?{maxSteps:fixture.maxSteps??10000,maxGenerated:options?.maxGenerated??16384,
    timeoutMs:fixture.timeoutMs??10000}:{maxSteps:defaulted(fixture.maxSteps,100000),
    timeoutMs:defaulted(fixture.timeoutMs,10000),maxGenerated:options?.maxGenerated??16384,
    maxOperators:options?.maxOperators??8};
  demand(equal(side.executionLimits,limits),'recorded execution limits differ from the original task');
  if(!protocol){
    // These options are recorded by source admission after compiler-v8 forces
    // its source mode. The compiler later replays this exact option object.
    const projection={sourceLineage:fixture.family,...options,semanticRegions:false,localStateCompaction:false};
    demand(equal(side.projectionOptions,projection),'recorded projection options differ from the original task');
    demand(equal(side.seeds,defaults.normalizedSeeds),'recorded source seeds differ from the original task');
  }
  // Direct protocol consumes only the limits above and bound module plans.
  // Ownership options and non-guest seed metadata are not recorded or used.
}

function checkSource(fixture,artifact,revision,{taskId,ancestry,directModule=false}={}){
  const side=sourceSide(artifact),reference=side?.referenceInput;
  demand(record(side)&&record(reference)&&side.producerRevision===revision,
    'artifact has no original source at the frozen producer revision');
  const defaults=sourceDefaults(fixture,{directModule});
  ancestry??=sourceAncestors(fixture,side.schema==='semantic-protocol-source-evidence/1');
  demand(side.sourceFamily===fixture.family&&artifact.sidecar.sourceFamily===fixture.family&&
    artifact.sidecar.family===fixture.family&&
    equal(ancestors(side.ancestorIds??[],fixture.family),ancestors(ancestry,fixture.family)),
  'artifact family or ancestry differs from the original task');
  demand(side.sourceLineage===undefined||side.sourceLineage===fixture.family,
    'artifact source lineage differs from the original task');
  if(side.taskId!==undefined)demand(side.taskId===(taskId??fixture.taskId??fixture.family),
    'artifact task ID differs from the original task');
  demand(side.license===defaults.license&&side.trustTier===defaults.trustTier,
  'artifact source custody differs from the original task');
  const request=sourceRequest(fixture,defaults);
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
  checkSourceExecution(fixture,side,defaults);
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
    demand(fixture[key]==null||typeof fixture[key]==='boolean','module plan switch must be boolean');
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
    const directModule=side?.schema==='semantic-protocol-source-evidence/1'&&
      (request.experimentalNamespacePlan===true&&record(side.moduleNamespacePlan)||
        request.experimentalSchedulerPlan===true&&record(side.moduleSchedulerPlan));
    // The original-module caller removes user-supplied plans before adding its
    // independently rebuilt plan. Ordinary module projection retains the rest.
    const {moduleNamespacePlan:_namespace,moduleSchedulerPlan:_scheduler,...projectionOptions}=fixture.projectionOptions??{};
    checkSource({...fixture,source:side.referenceInput?.source,entry:side.referenceInput?.entry,
      fixture:fixture.fixture??emptyFixture(),projectionOptions,argsGraph:request.inputGraph},artifact,task.producerRevision,
    {taskId:fixture.id,ancestry,directModule});
  }else if(Object.hasOwn(fixture,'sessionCases')){
    const cases=fixture.sessionCases,collection=side?.collection,reference=side?.referenceInput,
      seed=defaulted(fixture.seed,17),sessionId=defaulted(fixture.sessionId,'source-session-v8');
    demand(Array.isArray(cases)&&cases.length>=2&&cases.length<=16&&
      cases.every(item=>item?.source===cases[0].source&&item?.entry===cases[0].entry)&&
      Number.isSafeInteger(seed)&&seed>=0&&text(sessionId)&&side?.schema==='semantic-session-source-evidence/1'&&
      collection?.schema==='semantic-source-session-collection/1'&&
      Array.isArray(collection.components)&&collection.components.length===cases.length&&
      reference?.source===cases[0].source&&reference.entry===cases[0].entry&&
      side.producerRevision===task.producerRevision&&side.sourceFamily===fixture.family&&
      collection.plan?.seed===seed&&collection.plan.sessionId===sessionId,
    'original ordered source-session plan differs');
    const invocations=cases.map((item,index)=>checkSource({...item,family:fixture.family,seed,
      projectionOptions:{...item.projectionOptions,sessionId,programId:'program1',invocationId:'ingress'+(index+1),
        trackId:'worker1',realmId:'realm'+(index+1),realmPolicy:'fresh',triggerId:'outside'+(index+1)}},
      collection.components[index],task.producerRevision));
    const ancestry=collection.components.flatMap(component=>sourceSide(component).ancestorIds??[]);
    demand(equal(ancestors(side.ancestorIds??[],fixture.family),ancestors(ancestry,fixture.family)),
      'source-session ancestry differs from its original ordered components');
    request={source:cases[0].source,entry:cases[0].entry,invocations};
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
