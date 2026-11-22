// Direct source-to-v8 protocol admission. Historical detailed projection is
// never called here; source, owned replay, public replay and native admission
// remain distinct authorities with separately checked evidence.
import {isDeepStrictEqual} from 'node:util';
import {createRuntime} from '../runtime.js';
import {encodeNativeGraph,decodeOwnedGraph} from '../host/graph-codec.js';
import {compileProtocolSourceV8} from './protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from './protocol-source-reference-v8.js';
import {RegionExecutionHarness} from './region-harness.js';
import {defineRegionProgram,evaluateLocalRegion,sharedRegionState,cloneRegionController,REGION_TRACE_VERSION} from './regions.js';
import {assertProtocolDetailCompatible} from './protocol-state-v8.js';
import {hashAlgorithmData} from './program.js';
import {compareObservableGraphs} from './observables.js';
import {validateV8NativePolicy,validateV8NativeReceipt} from './native-v8.js';

export const PROTOCOL_SOURCE_ARTIFACT_V8_SCHEMA='semantic-protocol-source-evidence/1';
export const PROTOCOL_REGION_EVIDENCE_V8_SCHEMA='semantic-protocol-region-evidence/1';
const copy=structuredClone,clean=value=>JSON.parse(JSON.stringify(value)),eq=isDeepStrictEqual;
const digest=value=>hashAlgorithmData(clean(value));
const fail=message=>{throw new TypeError('Protocol region evidence: '+message);};
const localKinds=new Set(['compute','choose','bind','return']);
function inputFixture(fixture){
  if(typeof fixture?.source!=='string'||typeof fixture.entry!=='string'||!fixture.entry||
    typeof fixture.family!=='string'||!fixture.family)fail('exact source, entry and source family required');
  if(Buffer.byteLength(fixture.source,'utf8')>262144)throw new RangeError('Protocol source byte bound');
  const license=fixture.license??'repository-fixture',trustTier=fixture.trustTier??'repository-fixture';
  if(typeof license!=='string'||!license||!['repository-fixture','trusted-owned-source'].includes(trustTier))fail('trusted source tier and license required');
  const maxSteps=fixture.maxSteps??10000,maxGenerated=fixture.projectionOptions?.maxGenerated??16384,timeoutMs=fixture.timeoutMs??10000;
  if([maxSteps,maxGenerated,timeoutMs].some(value=>!Number.isSafeInteger(value)||value<1))fail('positive execution bounds required');
  if(fixture.randomSeed!=null||fixture.fixture?.calls?.length)fail('first protocol source profile has no random or external inputs');
  const moduleNamespacePlan=fixture.projectionOptions?.moduleNamespacePlan;
  if(moduleNamespacePlan){
    const evidence=fixture.provenance?.moduleEvidence;
    if(evidence?.schema!=='semantic-module-evidence/1'||evidence.profile!=='evaluated-module-regions/1'||
      evidence.request?.experimentalNamespacePlan!==true||!evidence.request.modules||
      evidence.metadata?.namespaceSourcePlan===undefined)
      fail('experimental namespace plans require original module evidence');
  }
  return {source:fixture.source,entry:fixture.entry,family:fixture.family,license,trustTier,
    ...(moduleNamespacePlan?{moduleNamespacePlan:copy(moduleNamespacePlan)}:{}),
    ancestorIds:[...new Set([fixture.family,...(fixture.ancestorIds??fixture.ancestors??[])])],
    producerRevision:fixture.producerRevision??null,provenance:copy(fixture.provenance??{}),
    limits:{maxSteps,maxGenerated,timeoutMs},args:fixture.args??[]};
}
function executeOwned(input){
  const runtime=createRuntime({maxSteps:input.limits.maxSteps}).startEntry({text:input.source,functionName:input.entry,args:input.args,allowAsync:true,
    ...(input.moduleNamespacePlan?{moduleNamespaceIntrinsic:true}:{})});
  const progress=runtime.drive(),bundle=runtime.exportRun();
  if(progress.kind!=='terminated'&&!(progress.kind==='runtime.failure'&&runtime.state.control.a0.failure?.kind==='guest-abrupt'))
    fail('owned execution is not a completed source invocation');
  return bundle;
}
function originalModuleOutcomeAgrees(reference,outcome){
  const left=reference?.outcome,right=outcome;
  const anchors=graph=>graph.roots.slice(0,-1).filter(value=>value[0]==='ref').map(value=>value[1]);
  return left?.kind===right?.kind&&compareObservableGraphs(left.graph,right.graph,
    {leftInputIds:anchors(left.graph),rightInputIds:anchors(right.graph)}).equal;
}
function originalNamespaceRowsAgree(reference,claims){
  const observations=reference?.namespaceObservations;
  if(observations?.schema!=='semantic-module-namespace-observations/1'||!Array.isArray(observations.rows))
    return false;
  const records=claims.filter(row=>row.kind==='protocol'&&
    (row.record?.kind?.startsWith('namespace.')||row.record?.kind?.startsWith('cell.'))).map(row=>row.record);
  const fileById=new Map(),rows=[];
  for(const record of records){
    if(record.kind==='namespace.create'){
      fileById.set(record.namespaceId,record.moduleFile);rows.push({kind:record.kind,moduleFile:record.moduleFile});continue;
    }
    if(record.kind==='cell.initialize'||record.kind==='cell.write'){
      rows.push({kind:record.kind,cell:record.cell,loweredName:record.loweredName,value:record.value});continue;
    }
    const moduleFile=fileById.get(record.namespaceId);
    if(!moduleFile)return false;
    if(record.kind==='namespace.keys')rows.push({kind:record.kind,moduleFile,names:record.names});
    else if(record.kind==='namespace.read')rows.push({kind:record.kind,moduleFile,
      exportName:record.exportName,value:record.value});
    else if(record.kind==='namespace.descriptor')rows.push({kind:record.kind,moduleFile,
      exportName:record.exportName,value:record.value});
    else return false;
  }
  return eq(rows,observations.rows);
}
async function buildSourceArtifact(input){
  const archive=executeOwned(input),projection=compileProtocolSourceV8(archive,{maxGenerated:input.limits.maxGenerated,
    ...(input.moduleNamespacePlan?{moduleNamespacePlan:input.moduleNamespacePlan}:{})});
  if(!projection.claims.some(row=>row.kind==='protocol'&&
    (row.record.kind.startsWith('symbol.')||row.record.kind.startsWith('property.')))&&!projection.extensions?.length)
    fail('no declared source protocol boundary');
  const completionPolicy=projection.completionPolicy?{completionPolicy:projection.completionPolicy}:{},
    referenceInput={source:input.source,entry:input.entry,inputGraph:encodeNativeGraph(input.args),
      ...(projection.completionPolicy==='await-returned-promise'?{awaitReturnedPromise:true}:{})};
  let reference,referenceStatus='agreed',referenceBasis='generated-source-esm';
  if(input.moduleNamespacePlan){
    const moduleEvidence=input.provenance.moduleEvidence;
    reference=moduleEvidence?.reference;
    if(reference?.status!=='passed'||
       reference.namespaceObservations?.schema!=='semantic-module-namespace-observations/1'||
       !Array.isArray(reference.namespaceObservations.rows))
      fail('original module ESM namespace observations are required');
    if(!originalModuleOutcomeAgrees(reference,projection.outcome)||
       !originalNamespaceRowsAgree(reference,projection.claims))
      fail('fresh original ESM outcome or namespace observations differ from owned source projection');
    reference=copy(reference);referenceStatus='agreed';referenceBasis='original-module-esm';
  }else{
    reference=await auditProtocolSourceV8({bundle:archive,referenceInput,outcome:projection.outcome,
      timeoutMs:input.limits.timeoutMs});
  }
  const publicData={schema:'semantic-protocol-source-target/1',sourceDigest:hashAlgorithmData(input.source),
    entry:input.entry,inputGraph:projection.inputGraph,...completionPolicy,claims:projection.claims.map(({kind,line})=>({kind,line}))};
  return clean({public:publicData,sidecar:{schema:PROTOCOL_SOURCE_ARTIFACT_V8_SCHEMA,admission:'locally_verified',referenceStatus,
    ...(referenceBasis==='original-module-esm'?{referenceBasis}:{}),
    profile:projection.sourceProfile,sourceFamily:input.family,sourceLineage:input.family,ancestorIds:input.ancestorIds,
    producerRevision:input.producerRevision,license:input.license,trustTier:input.trustTier,
    sourceProvenance:{family:input.family,sourceDigest:hashAlgorithmData(input.source),upstream:input.provenance},
    ...(input.moduleNamespacePlan?{moduleNamespacePlan:copy(input.moduleNamespacePlan)}:{}),
    executionLimits:input.limits,referenceInput,reference,
    archive,archiveDigest:digest(archive),compiler:{schema:projection.schema,claims:projection.claims,
      ...(projection.extensions.length?{extensions:projection.extensions}:{})},
    outcome:projection.outcome,optimizerSteps:0,learningClaim:null}});
}

/** Rebuilds causal contexts and only replaces detail groups with equal state. */
export function projectProtocolRegionWitness(sourceArtifact){
  const side=sourceArtifact?.sidecar;
  const expectedReferenceStatus='agreed';
  if(side?.schema!==PROTOCOL_SOURCE_ARTIFACT_V8_SCHEMA||side.referenceStatus!==expectedReferenceStatus||
     side.admission!=='locally_verified')
    fail('independently checked direct source evidence required');
  if(side.moduleNamespacePlan&&side.referenceBasis!=='original-module-esm')
    fail('namespace projection must identify the actual original-module ESM reference');
  const projection=compileProtocolSourceV8(side.archive,{maxGenerated:side.executionLimits.maxGenerated,
    ...(side.moduleNamespacePlan?{moduleNamespacePlan:side.moduleNamespacePlan}:{})}),
    harness=new RegionExecutionHarness({sessionId:'protocol-source',automaticDelivery:false,now:()=>-Infinity,maxGenerated:side.executionLimits.maxGenerated});
  if(!eq(projection.claims,side.compiler.claims)||!eq(projection.extensions,side.compiler.extensions??[])||
    !eq(projection.outcome,side.outcome)||
    !eq({schema:'semantic-protocol-source-target/1',sourceDigest:hashAlgorithmData(projection.source),entry:projection.entry,
      inputGraph:projection.inputGraph,...(projection.completionPolicy?{completionPolicy:projection.completionPolicy}:{}),
      claims:projection.claims.map(({kind,line})=>({kind,line}))},sourceArtifact.public))
    fail('source target or projection certificate changed');
  harness.publishProgram({programId:'program1',source:projection.source,entry:projection.entry,capabilities:[],
    ...(side.moduleNamespacePlan?{moduleNamespacePlan:side.moduleNamespacePlan}: {})});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'protocol-entry',
    inputGraph:projection.inputGraph,realmPolicy:'fresh',completionPolicy:projection.completionPolicy??'call-return'});
  const locations=defineRegionProgram({source:projection.source,entry:projection.entry}).provenance.locations,
    contexts=[],receipts=[],refusals=[];
  let compactRecords=0,detailedRecords=0,protocolRecords=0,compactBytes=0,detailedBytes=0,protocolBytes=0;
  for(let index=0;index<projection.claims.length;){
    const claim=projection.claims[index],point=claim.certificate.source,controller=harness.controller;
    const candidates=!side.moduleNamespacePlan&&claim.kind==='detail'&&point?
      locations.filter(location=>point.start>=location.start&&point.end<=location.end):[];
    let compact=false;
    for(const location of candidates){
      const region=harness.program('invocation1').regions.find(row=>row.id===location.id);
      if(region.owner!==controller.frameFunctions.get(controller.stack.at(-1)))continue;
      let end=index;const consumed=[];
      while(end<projection.claims.length){const next=projection.claims[end],site=next.certificate.source;
        if(next.kind!=='detail'||!localKinds.has(next.record.kind)||!site||site.start<location.start||site.end>location.end)break;
        consumed.push(next);end++;
      }
      if(!consumed.length)continue;
      try{
        const candidate=harness.preview('invocation1',region.id),expected=cloneRegionController(controller),actual=cloneRegionController(controller);
        for(const row of consumed){if(expected.protocol)assertProtocolDetailCompatible(expected,row.record);
          expected.commitRecord(row.record,{mode:'generated',track:'worker1'});}
        for(const line of evaluateLocalRegion(region,controller).records)actual.commitRecord(line,{mode:'generated',track:'worker1'});
        if(expected.firstWitnessViolation||actual.firstWitnessViolation||!eq(sharedRegionState(expected),sharedRegionState(actual)))
          fail('compact replacement changed complete shared state');
        const context=harness.modelContext('invocation1');harness.select('invocation1',candidate);contexts.push(context);
        const emitted=harness.timeline.at(-1);receipts.push({sequence:emitted.sequence,rule:'source-protocol-local-region/1',region:region.id,
          sourceClaims:Array.from({length:end-index},(_,offset)=>index+offset),entry:candidate.entry,
          exitStateDigest:hashAlgorithmData(sharedRegionState(harness.controller))});
        compactRecords++;compactBytes+=Buffer.byteLength(emitted.fields.line);index=end;compact=true;break;
      }catch(error){refusals.push({sourceClaim:index,region:region.id,disposition:error instanceof RangeError?'resource_limited':'unsupported',reason:error.message});}
    }
    if(compact)continue;
    contexts.push(harness.modelContext('invocation1'));harness.select('invocation1',claim.line);
    const emitted=harness.timeline.at(-1),bytes=Buffer.byteLength(claim.line);detailedRecords++;detailedBytes+=bytes;
    if(claim.kind==='protocol'){protocolRecords++;protocolBytes+=bytes;}
    receipts.push({sequence:emitted.sequence,rule:claim.kind==='protocol'?'source-protocol-boundary/1':'source-protocol-detailed/1',sourceClaims:[index]});index++;
  }
  const observed={kind:harness.controller.completion?.kind,graph:harness.controller.observedGraph()};
  if(!eq(observed,projection.outcome))fail('public replay outcome differs from independently checked source');
  const replayed=RegionExecutionHarness.restore(harness.checkpoint());
  if(!eq(sharedRegionState(harness.controller),sharedRegionState(replayed.controller)))fail('public checkpoint changed shared state');
  const publicData=harness.exportEpisode(),regionCoverage={compactRegions:compactRecords,
    detailedRegions:publicData.timeline.filter((row,index,array)=>row.mode==='generated'&&row.kind!=='region'&&
      (index===0||array[index-1].mode!=='generated'||array[index-1].kind==='region')).length,
    compactRecords,detailedRecords,protocolRecords,compactBytes,detailedBytes,protocolBytes,
    detailTokenShare:null,tokenMeasurement:'untested'};
  return clean({public:publicData,contexts,sidecar:{schema:PROTOCOL_REGION_EVIDENCE_V8_SCHEMA,admission:'locally_verified',
    referenceStatus:'agreed',
    representation:REGION_TRACE_VERSION,profile:'compositional-regions/1',protocolProfile:projection.sourceProfile,
    ...(projection.extensions.length?{protocolExtensions:projection.extensions}:{}),
    sourceFamily:side.sourceFamily,family:side.sourceFamily,sourceArtifact:copy(sourceArtifact),sourceArtifactDigest:digest(sourceArtifact),
    publicDigest:digest(publicData),contextDigest:digest(contexts),receipts,refusals,regionCoverage,
    producerRevision:side.producerRevision,nativeAdmission:null,optimizerSteps:0,learningClaim:null}});
}

export async function verifyProtocolRegionTrainingCase(fixture){
  const identity=Object.fromEntries(['id','family','source','entry','ancestorIds','ancestors'].filter(key=>Object.hasOwn(fixture??{},key)).map(key=>[key,copy(fixture[key])]));
  let phase='source';
  try{
    const input=inputFixture(fixture);
    if(input.moduleNamespacePlan){
      phase='original-module-namespace-recheck';
      const {verifyModuleNamespaceInputEvidence}=await import('./module-v8.js');
      await verifyModuleNamespaceInputEvidence({source:input.source,entry:input.entry,args:input.args,
        moduleNamespacePlan:input.moduleNamespacePlan,provenance:input.provenance});
    }
    phase='owned-and-independent-source';const sourceArtifact=await buildSourceArtifact(input);
    phase='projection';const exported=projectProtocolRegionWitness(sourceArtifact);
    return {...identity,status:exported.sidecar.regionCoverage.compactRegions?'locally_verified':'detailed-fallback',
      representation:'mixed',profile:exported.sidecar.protocolProfile,exported,regionCoverage:exported.sidecar.regionCoverage};
  }catch(error){return {...identity,status:error instanceof RangeError||error.category==='resource_limited'?'resource_limited':
    String(error.category??'').startsWith('reference_')?'failed':'unsupported',phase,
    category:error.category??'unsupported.protocol-source',reason:error.message,regionDisposition:'source-unqualified'};}
}

export async function recheckProtocolRegionEvidence(exported,{nativeConsumer=null,nativePolicy=null,requireNative=false}={}){
  const side=exported?.sidecar,source=side?.sourceArtifact?.sidecar;
  const expectedRegionReferenceStatus='agreed';
  if(side?.schema!==PROTOCOL_REGION_EVIDENCE_V8_SCHEMA||side.representation!==REGION_TRACE_VERSION||
    side.referenceStatus!==expectedRegionReferenceStatus||
    side.sourceArtifactDigest!==digest(side.sourceArtifact)||side.publicDigest!==digest(exported.public)||
    side.contextDigest!==digest(exported.contexts)||side.optimizerSteps!==0||side.learningClaim!==null||
    source?.schema!==PROTOCOL_SOURCE_ARTIFACT_V8_SCHEMA||source.archiveDigest!==digest(source.archive))
    fail('incompatible or altered direct source evidence');
  const args=decodeOwnedGraph(JSON.stringify(source.referenceInput.inputGraph)),input=inputFixture({
    ...source.referenceInput,args,family:source.sourceFamily,ancestorIds:source.ancestorIds,license:source.license,trustTier:source.trustTier,
    producerRevision:source.producerRevision,provenance:source.sourceProvenance.upstream,
    ...(source.moduleNamespacePlan?{projectionOptions:{moduleNamespacePlan:source.moduleNamespacePlan}}:{}),
    maxSteps:source.executionLimits.maxSteps,
    timeoutMs:source.executionLimits.timeoutMs,
    projectionOptions:{maxGenerated:source.executionLimits.maxGenerated,
      ...(source.moduleNamespacePlan?{moduleNamespacePlan:source.moduleNamespacePlan}:{})}});
  if(source.moduleNamespacePlan){
    const {recheckModuleRegionEvidence}=await import('./module-v8.js');
    const moduleCheck=await recheckModuleRegionEvidence(exported);
    if(moduleCheck.status!=='passed'||!moduleCheck.applicable)
      fail('experimental namespace source requires fresh original-module and ESM recheck');
  }
  const fresh=await buildSourceArtifact(input);
  if(!eq(fresh,side.sourceArtifact))fail('source, owned archive or independent observations changed');
  const rebuilt=projectProtocolRegionWitness(fresh);
  for(const key of ['public','contexts'])if(!eq(rebuilt[key],exported[key]))fail(key+' differs from the source-certified protocol projection');
  for(const key of ['sourceFamily','family','protocolProfile','protocolExtensions','receipts','refusals','regionCoverage','publicDigest','contextDigest'])
    if(!eq(rebuilt.sidecar[key],side[key]))fail('changed protocol evidence: '+key);
  const replay=RegionExecutionHarness.replay(exported);let native={status:'untested',admitted:false};
  if(nativeConsumer){validateV8NativePolicy(nativePolicy);native=await nativeConsumer(exported);validateV8NativeReceipt(exported,native,nativePolicy);}
  else if(requireNative)fail('exact v8 native admission must be rechecked by the pinned consumer');
  return {valid:true,sourceValidated:true,projectionValidated:true,replayValidated:true,
    source:{schema:PROTOCOL_SOURCE_ARTIFACT_V8_SCHEMA,valid:true,reference:fresh.sidecar.reference},native,
    regionCoverage:copy(side.regionCoverage),completed:replay.invocations.size};
}
