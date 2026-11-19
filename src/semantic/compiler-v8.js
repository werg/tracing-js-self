// Teacher-only projection into the compositional contract. Every accepted local
// replacement agrees on the entire shared continuation, not just its result.
import {isDeepStrictEqual} from 'node:util';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../training/effectful-admit.js';
import {decodeWitness} from '../training/format.js';
import {SemanticController} from '../training/controller.js';
import {encodeDetailedRecord} from './detailed-v7.js';
import {RegionExecutionHarness} from './region-harness.js';
import {defineRegionProgram,sharedRegionState,evaluateLocalRegion,REGION_TRACE_VERSION} from './regions.js';
import {hashAlgorithmData} from './program.js';
import {evaluatePureRegion} from './pure-region-v8.js';
import {compareObservableGraphs} from './observables.js';
import {validateV8NativePolicy,validateV8NativeReceipt} from './native-v8.js';

const copy=structuredClone,eq=isDeepStrictEqual;
const clean=value=>JSON.parse(JSON.stringify(value));
const digest=value=>hashAlgorithmData(clean(value));
const fail=message=>{throw new TypeError('Region projection: '+message);};
const localKinds=new Set(['compute','choose','bind','return']);

function observedRow(row){
  const {schema,sequence,ownerSequence,mode,kind,traceFormat,...fields}=copy(row);
  if(kind==='program')fields.regionProgram=defineRegionProgram({source:fields.source,entry:fields.entry}).program;
  if(kind==='result')fields.line=encodeDetailedRecord(decodeWitness(fields.line),{role:'observed'});
  return clean({mode,kind,fields});
}
function sourceLocations(sourceArtifact){
  const archive=sourceArtifact.sidecar.archive,sites=new Map(archive.sites.map(row=>[row.siteId,row]));
  const events=new Map(archive.events.map(row=>[row.eventId,row]));
  const certificates=new Map(sourceArtifact.sidecar.compiler.certificates.map(row=>[row.sequence,row]));
  return row=>{
    const certificate=certificates.get(row.sequence);if(!certificate)return [];
    const ids=[...(certificate.journalEvents??[]),...(certificate.binding?.journalEvent?[certificate.binding.journalEvent]:[])];
    return ids.map(id=>sites.get(events.get(id)?.siteId)).filter(Boolean);
  };
}
function sameState(left,right){return eq(sharedRegionState(left),sharedRegionState(right));}
function evidence(sourceArtifact,harness,contexts,receipts,refusals,regionCoverage){
  const publicData=harness.exportEpisode(),sourceFamily=sourceArtifact.sidecar.sourceFamily;
  return {public:publicData,contexts,sidecar:{schema:'semantic-region-evidence/1',
    admission:'locally_verified',referenceStatus:'agreed',representation:REGION_TRACE_VERSION,
    profile:'compositional-regions/1',sourceFamily,family:sourceFamily,
    sourceArtifact:copy(sourceArtifact),sourceArtifactDigest:digest(sourceArtifact),
    publicDigest:digest(publicData),contextDigest:digest(contexts),receipts,refusals,
    regionCoverage:{...regionCoverage,detailTokenShare:null,tokenMeasurement:'untested'},
    nativeAdmission:null,optimizerSteps:0,learningClaim:null}};
}
function projectWholePureWitness(sourceArtifact){
  const rows=sourceArtifact.public.timeline,programs=rows.filter(row=>row.kind==='program'),invocations=rows.filter(row=>row.kind==='invocation');
  if(programs.length!==1||invocations.length!==1||rows.some(row=>['request','dispatch','result','event'].includes(row.kind)))return null;
  const harness=new RegionExecutionHarness({sessionId:rows[0].session,automaticDelivery:false,now:()=>-Infinity,maxGenerated:16384});
  harness.importObserved(observedRow(programs[0]));harness.importObserved(observedRow(invocations[0]));
  const invocationId=invocations[0].invocationId,program=harness.program(invocationId),controller=harness.activation(invocationId).controller;
  if(!program.algorithm)return null;
  let evaluated,candidate;try{evaluated=evaluatePureRegion(program,controller);candidate=harness.previewAlgorithm(invocationId);}catch{return null;}
  const expected=sourceArtifact.sidecar.reference.outcome;
  const inputIds=graph=>[...new Set(graph.roots.slice(0,controller.input.graph.roots.length).filter(value=>value[0]==='ref').map(value=>value[1]))];
  const comparison=compareObservableGraphs(evaluated.graph,expected.graph,{leftInputIds:inputIds(evaluated.graph),rightInputIds:inputIds(expected.graph)});
  if(expected.kind!==evaluated.record.completion.kind||!comparison.equal)return null;
  const contexts=[harness.modelContext(invocationId)];harness.select(invocationId,candidate);
  const algorithm=harness.timeline.at(-1);contexts.push(harness.modelContext(invocationId));
  harness.select(invocationId,{kind:'end',fields:{kind:evaluated.record.completion.kind}});
  RegionExecutionHarness.restore(harness.checkpoint());
  return evidence(sourceArtifact,harness,contexts,[{sequence:algorithm.sequence,rule:'source-pure-algorithm/2',
    coreDigest:hashAlgorithmData(program.algorithm),entry:candidate.entry,identityMap:evaluated.identityMap,
    sourceSequences:rows.filter(row=>row.mode==='generated').map(row=>row.sequence)}],[],
    {compactRegions:1,detailedRegions:1,compactRecords:1,detailedRecords:1,
      compactBytes:Buffer.byteLength(algorithm.fields.line),detailedBytes:Buffer.byteLength(harness.timeline.at(-1).fields.line)});
}

export function projectRegionWitness(sourceArtifact){
  if(!sourceArtifact?.sidecar?.archive||!sourceArtifact?.public?.timeline)fail('owned source evidence missing');
  if(sourceArtifact.sidecar.referenceStatus!=='agreed'||!['locally_verified','admitted'].includes(sourceArtifact.sidecar.admission))
    fail('independently checked source evidence is required');
  const pure=projectWholePureWitness(sourceArtifact);if(pure)return pure;
  const rows=sourceArtifact.public.timeline,harness=new RegionExecutionHarness({
    sessionId:rows[0].session,automaticDelivery:false,now:()=>-Infinity,maxGenerated:16384});
  const locate=sourceLocations(sourceArtifact),locations=new Map(),contexts=[],receipts=[],refusals=[];
  let compactRecords=0,detailedRecords=0,compactBytes=0,detailedBytes=0;
  for(let index=0;index<rows.length;){
    const row=rows[index];
    if(row.kind==='model-context'){index++;continue;}
    if(row.mode==='observed'){
      harness.importObserved(observedRow(row));
      if(row.kind==='program')locations.set(row.programId,defineRegionProgram({source:row.source,entry:row.entry}).provenance.locations);
      index++;continue;
    }
    if(row.kind!=='semantic')fail('unrecognized generated authority');
    const activation=harness.invocations.get(row.invocationId),controller=activation?.controller;
    if(!controller)fail('missing live invocation');
    const program=harness.program(row.invocationId),points=locate(row);
    const candidates=(locations.get(activation.programId)??[]).filter(location=>points.length&&
      points.every(point=>point.start>=location.start&&point.end<=location.end));
    let compact=false;
    for(const location of candidates){
      const region=program.regions.find(candidate=>candidate.id===location.id);
      if(region.owner!==controller.frameFunctions.get(controller.stack.at(-1)))continue;
      let end=index;
      const consumed=[];
      while(end<rows.length){
        const item=rows[end];
        if(item.kind==='model-context'){end++;continue;}
        const itemPoints=locate(item);
        if(item.kind!=='semantic'||item.invocationId!==row.invocationId||
          !localKinds.has(decodeWitness(item.line).kind)||!itemPoints.length||
          !itemPoints.every(point=>point.start>=location.start&&point.end<=location.end))break;
        consumed.push(item);end++;
      }
      if(!consumed.length)continue;
      try{
        const candidate=harness.preview(row.invocationId,region.id);
        const expected=SemanticController.fromPacket(controller.segmentPacket());
        for(const item of consumed)expected.commit(item.line,{mode:'generated',track:activation.trackId});
        const actual=SemanticController.fromPacket(controller.segmentPacket());
        for(const witness of evaluateLocalRegion(region,controller).records)actual.commit(witness,{mode:'generated',track:activation.trackId});
        if(expected.firstWitnessViolation||!sameState(actual,expected))throw new TypeError('shared locals, aliases, heap, completion or obligations differ');
        const context=harness.modelContext(row.invocationId);
        harness.select(row.invocationId,candidate);contexts.push(context);
        const projected=harness.timeline.at(-1);
        receipts.push({sequence:projected.sequence,rule:'source-local-region/1',region:region.id,
          regionDigest:region.digest,sourceSequences:consumed.map(item=>item.sequence),
          entry:candidate.entry,exitStateDigest:hashAlgorithmData(sharedRegionState(harness.invocations.get(row.invocationId).controller))});
        compactRecords++;compactBytes+=Buffer.byteLength(projected.fields.line);index=end;compact=true;break;
      }catch(error){refusals.push({sourceSequence:row.sequence,region:region.id,
        disposition:error.category==='resource-limit'?'resource_limited':'unsupported',reason:error.message});}
    }
    if(compact)continue;
    contexts.push(harness.modelContext(row.invocationId));
    const record=decodeWitness(row.line),line=encodeDetailedRecord(record,{role:'generated'});
    harness.select(row.invocationId,line);detailedRecords++;detailedBytes+=Buffer.byteLength(line);
    receipts.push({sequence:harness.timeline.at(-1).sequence,rule:'checked-detailed-boundary/1',sourceSequences:[row.sequence]});index++;
  }
  const publicData=harness.exportEpisode();
  const restored=RegionExecutionHarness.restore(harness.checkpoint());
  for(const [id,activation] of harness.invocations){
    const counterpart=restored.invocations.get(id);
    if(!counterpart||!sameState(activation.controller,counterpart.controller))fail('restored shared state differs');
  }
  let detailedRegions=0,prior=null;
  for(const row of publicData.timeline.filter(item=>item.mode==='generated')){
    const kind=row.kind==='region'?'compact':'detailed';if(kind==='detailed'&&prior!=='detailed')detailedRegions++;prior=kind;
  }
  return evidence(sourceArtifact,harness,contexts,receipts,refusals,
    {compactRegions:compactRecords,detailedRegions,compactRecords,detailedRecords,compactBytes,detailedBytes});
}

export async function verifyRegionTrainingCase(fixture){
  const identity=Object.fromEntries(['id','family','source','entry','ancestorIds','ancestors']
    .filter(key=>Object.hasOwn(fixture,key)).map(key=>[key,copy(fixture[key])]));
  const source=await verifyEffectfulTrainingCase({...fixture,nativeConsumer:null,nativePolicy:null,
    projectionOptions:{...fixture.projectionOptions,semanticRegions:false,localStateCompaction:false}});
  if(!['locally_verified','admitted'].includes(source.status))return {...identity,...source,regionDisposition:'source-unqualified',exported:undefined};
  try{
    const exported=projectRegionWitness(source.exported),count=exported.sidecar.regionCoverage.compactRegions;
    return {...identity,status:count?'locally_verified':'detailed-fallback',representation:'mixed',profile:'compositional-regions/1',
      exported,detailed:source.exported,regionCoverage:exported.sidecar.regionCoverage};
  }catch(error){return {...identity,status:'unsupported',phase:'projection',sourceStatus:source.status,
    category:error.category??'unsupported.region-projection',reason:error.message};}
}

export async function recheckRegionEvidence(exported,{nativeConsumer=null,nativePolicy=null,requireNative=false}={}){
  const side=exported?.sidecar;
  if(side?.schema!=='semantic-region-evidence/1'||side.representation!==REGION_TRACE_VERSION||
    side.referenceStatus!=='agreed'||side.sourceArtifactDigest!==digest(side.sourceArtifact)||
    side.optimizerSteps!==0||side.learningClaim!==null)fail('incompatible or altered source evidence');
  const source=await recheckEffectfulAdmission(side.sourceArtifact,{requireAdmitted:false});
  let moduleReference={status:'untested',applicable:false};
  if(side.sourceArtifact.sidecar?.sourceProvenance?.upstream?.moduleEvidence){
    const {recheckModuleRegionEvidence}=await import('./module-v8.js');
    moduleReference=await recheckModuleRegionEvidence(side.sourceArtifact);
  }
  const rebuilt=projectRegionWitness(side.sourceArtifact);
  for(const key of ['public','contexts'])if(!eq(rebuilt[key],exported[key]))fail(key+' differs from source-certified projection');
  for(const key of ['receipts','refusals','regionCoverage','publicDigest','contextDigest'])
    if(!eq(rebuilt.sidecar[key],side[key]))fail('changed region evidence: '+key);
  const replay=RegionExecutionHarness.replay(exported);
  let native={status:'untested',admitted:false};
  if(nativeConsumer){
    validateV8NativePolicy(nativePolicy);native=await nativeConsumer(exported);
    validateV8NativeReceipt(exported,native,nativePolicy);
  }else if(requireNative)fail('exact v8 native admission must be rechecked by the pinned consumer');
  return {valid:true,sourceValidated:true,projectionValidated:true,replayValidated:true,
    source,moduleReference,native,regionCoverage:copy(side.regionCoverage),completed:replay.invocations.size};
}

export async function admitRegionEvidence(exported,{nativeConsumer,nativePolicy}={}){
  if(typeof nativeConsumer!=='function')fail('exact v8 native consumer is required');
  const checked=await recheckRegionEvidence(exported,{nativeConsumer,nativePolicy,requireNative:true});
  return {valid:true,admitted:true,native:checked.native,exported:{...copy(exported),sidecar:{
    ...copy(exported.sidecar),admission:'admitted',nativeAdmission:copy(checked.native)}}};
}

export async function checkRegionCounterfactualPrefixes(fixtures){
  const results=[];
  for(const fixture of fixtures){const result=await verifyRegionTrainingCase(fixture);
    if(!result.exported)fail('counterfactual fixture lacks source evidence');results.push(result.exported);}
  const first=results[0];if(!first)fail('counterfactual fixtures required');
  const prefix=episode=>{const rows=episode.public.timeline,index=rows.findIndex(row=>row.kind==='result');
    return rows.slice(0,index<0?rows.length:index);};
  for(const episode of results.slice(1))if(!eq(prefix(first),prefix(episode)))fail('future observation changed an earlier public prefix');
  return {valid:true,executions:results.length,prefixDigest:digest(prefix(first))};
}
