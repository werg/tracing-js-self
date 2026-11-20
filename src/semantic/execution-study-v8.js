// Study preparation and private scoring are separate from the live runner.
// Expected artifacts are never supplied to a selector or used to repair output.
import {isDeepStrictEqual} from 'node:util';
import {canonicalFixturePlan} from '../training/fixture-broker.js';
import {hashAlgorithmData} from './program.js';
import {recheckRegionEvidence} from './compiler-v8.js';
import {runSelectedRegionExecution} from './selected-execution-v8.js';

const copy=structuredClone,clean=value=>JSON.parse(JSON.stringify(value)),HASH=/^[a-f0-9]{64}$/;
const demand=(value,message)=>{if(!value)throw new TypeError('V8 execution study: '+message);};
const digest=value=>hashAlgorithmData(clean(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const bounded=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

/** Extract only already observable source/input and the declared environment.
 * The expectation remains a private, separately bound scoring artifact. */
export function prepareRegionExecutionCase({id,artifact,exported,fixture=null}={}){
  artifact??=exported;
  demand(typeof id==='string'&&id.length>0&&id.length<=256,'distinct case ID required');
  demand(artifact?.public?.schema==='semantic-execution/8'&&artifact.sidecar?.referenceStatus==='agreed',
    'source-qualified v8 artifact required');
  const first=artifact.public.timeline.findIndex(row=>row.mode==='generated');
  demand(first>=2,'source/input prefix and generated targets required');
  const initialPublic={...copy(artifact.public),timeline:copy(artifact.public.timeline.slice(0,first))};
  demand(initialPublic.timeline.every(row=>row.mode==='observed'&&['program','invocation'].includes(row.kind))&&
    initialPublic.timeline.filter(row=>row.kind==='invocation').length===1,'single-entry source/input profile required');
  const source=artifact.sidecar.sourceArtifact?.sidecar,
    environment=canonicalFixturePlan(fixture??source?.referenceInput?.fixture??{calls:[]});
  const request={initialPublic,fixture:environment};
  return {id,family:artifact.sidecar.sourceFamily??artifact.sidecar.family??id,request,
    requestDigest:digest(request),expectedArtifactDigest:digest(artifact),expectedArtifact:copy(artifact)};
}

export function freezeRegionExecutionStudy(cases,{id='semantic-v8-execution',model,settings,
    checkpointIdentity,tokenizerIdentity,seeds=[17],origin='model',maxPredictions=4096,
    maxGenerated=16384,maxOutstanding=64,maxStaleRetries=8,timeoutMs=15000}={}){
  demand(Array.isArray(cases)&&cases.length>0&&cases.length<=20000&&new Set(cases.map(row=>row.id)).size===cases.length,
    'nonempty distinct case inventory required');
  demand(typeof id==='string'&&id&&model&&typeof model.id==='string'&&model.id&&
    typeof model.revision==='string'&&model.revision&&settings&&typeof settings==='object'&&!Array.isArray(settings),
    'model revision and generation settings must be frozen');
  demand(HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??'')&&['model','engineering'].includes(origin),
    'checkpoint/tokenizer hashes and execution origin required');
  demand(Array.isArray(seeds)&&seeds.length>0&&seeds.length<=32&&new Set(seeds).size===seeds.length&&
    seeds.every(seed=>bounded(seed,0,Number.MAX_SAFE_INTEGER)),'distinct fixed seeds required');
  demand(bounded(maxPredictions,1,100000)&&bounded(maxGenerated,1,1000000)&&bounded(maxOutstanding,1,1024)&&
    bounded(maxStaleRetries,0,1000)&&bounded(timeoutMs,1,300000),'fixed prediction, continuation, retry and time bounds required');
  const inventory=cases.map(row=>{
    demand(row.requestDigest===digest(row.request)&&row.expectedArtifactDigest===digest(row.expectedArtifact),
      'prepared source or environment changed');
    return {id:row.id,family:row.family,request:copy(row.request),requestDigest:row.requestDigest,
      expectedArtifactDigest:row.expectedArtifactDigest};
  });
  const body={schema:'semantic-execution-study/8',id,model:copy(model),settings:copy(settings),
    checkpointIdentity,tokenizerIdentity,seeds:copy(seeds),origin,
    limits:{maxPredictions,maxGenerated,maxOutstanding,maxStaleRetries,timeoutMs},cases:inventory,
    declared:cases.length*seeds.length,
    scoring:{source:'exact-source-certified-projection/1',alternatives:'source-unqualified; never silently marked correct',
      nextStep:'exact canonical target at an independently source-qualified public boundary',
      teacherVisibility:'private scoring only after rollout',retries:'bounded stale-context retries only; every attempt consumes budget'},
    status:'frozen-unmeasured'};
  return freeze({...body,digest:digest(body)});
}

export function validateRegionExecutionStudy(study){
  const {digest:declared,...body}=study??{};
  demand(study?.schema==='semantic-execution-study/8'&&HASH.test(declared??'')&&digest(body)===declared,
    'study changed after freeze');
  demand(typeof study.id==='string'&&study.id&&typeof study.model?.id==='string'&&study.model.id&&
    typeof study.model.revision==='string'&&study.model.revision&&study.settings&&
    typeof study.settings==='object'&&!Array.isArray(study.settings)&&Array.isArray(study.cases)&&
    Array.isArray(study.seeds),'frozen model, settings and population required');
  demand(new Set(study.cases.map(row=>row.id)).size===study.cases.length&&study.cases.length>0&&
    study.cases.every(row=>typeof row.id==='string'&&row.id.length>0&&row.id.length<=256&&
      row.requestDigest===digest(row.request)&&HASH.test(row.expectedArtifactDigest??''))&&
    study.declared===study.cases.length*study.seeds.length,'study population or request changed');
  demand(study.cases.length<=20000&&study.seeds.length>0&&study.seeds.length<=32&&
    new Set(study.seeds).size===study.seeds.length&&
    study.seeds.every(seed=>bounded(seed,0,Number.MAX_SAFE_INTEGER))&&
    HASH.test(study.checkpointIdentity??'')&&HASH.test(study.tokenizerIdentity??'')&&
    ['model','engineering'].includes(study.origin),'study identity or seed population changed');
  const limits=study.limits;
  demand(bounded(limits?.maxPredictions,1,100000)&&bounded(limits.maxGenerated,1,1000000)&&
    bounded(limits.maxOutstanding,1,1024)&&bounded(limits.maxStaleRetries,0,1000)&&bounded(limits.timeoutMs,1,300000),
    'study execution limits changed');
  return true;
}

/** Rechecking the private source artifact happens after all model selections.
 * Exact matching is deliberately a bounded qualification; alternate correct
 * decompositions require additional source evidence and remain unqualified. */
export async function scoreSelectedRegionExecution(result,expectedArtifact){
  const {digest:claimed,...body}=result??{};
  demand(result?.schema==='semantic-selected-execution-result/8'&&claimed===digest(body),
    'selected result or original emission evidence changed');
  const checked=await recheckRegionEvidence(expectedArtifact);
  demand(checked.sourceValidated===true,'expected projection lacks independent source validation');
  const expectedRows=expectedArtifact.public.timeline.filter(row=>row.mode==='generated'),
    expectedContexts=expectedArtifact.contexts;
  const lookup=new Map(expectedRows.map((row,index)=>[digest(expectedContexts[index]),row.fields.line]));
  const nextStep=result.attempts.map(row=>{
    const expected=lookup.get(digest(row.context));
    return {attempt:row.attempt,status:expected===undefined?'unqualified-boundary':
      typeof row.record!=='string'?'no-complete-record':row.record===expected?'correct':'different-canonical-record'};
  });
  const exact=result.publicCompleted&&isDeepStrictEqual(result.public,expectedArtifact.public)&&
    isDeepStrictEqual(result.contexts,expectedContexts),sourceValidated=Boolean(exact),
    completedExecution=Boolean(exact&&result.publicAccepted);
  const scored={...body,sourceValidated,completedExecution,
    sourceStatus:exact?'passed-exact-projection':result.publicCompleted?'unqualified-projection':'incomplete',
    sourceEvidence:{expectedArtifactDigest:digest(expectedArtifact),sourceValidated:checked.sourceValidated,
      exactPublicProjection:exact,method:'exact-source-certified-projection/1'},
    nextStep:{scope:'canonical source-qualified boundaries; alternate decompositions remain unqualified',
      attempts:nextStep.length,qualifiedBoundaries:nextStep.filter(row=>row.status!=='unqualified-boundary').length,
      correct:nextStep.filter(row=>row.status==='correct').length,rows:nextStep},
    qualification:{...result.qualification,sourceCorrespondence:exact?'independently-rechecked-exact-projection':
      'not-established; a public completion or equal final value is insufficient',defaultPromotion:false}};
  return {...scored,digest:digest(scored)};
}

export async function runFrozenRegionExecutionStudy(study,{cases,select,caseIds=null,onResult=null}={}){
  validateRegionExecutionStudy(study);
  demand(Array.isArray(cases)&&cases.length===study.cases.length,'complete private case inventory required');
  const privateCases=new Map(cases.map(row=>[row.id,row]));
  demand(privateCases.size===cases.length,'private case IDs must remain distinct');
  for(const row of study.cases){const original=privateCases.get(row.id);
    demand(original&&row.requestDigest===digest(original.request)&&row.expectedArtifactDigest===digest(original.expectedArtifact),
      'private source artifact or fixture differs from the frozen study');}
  const selection=caseIds===null?new Set(study.cases.map(row=>row.id)):new Set(caseIds);
  demand(caseIds===null||Array.isArray(caseIds)&&selection.size===caseIds.length&&
    [...selection].every(id=>privateCases.has(id)),'diagnostic selection contains unknown or repeated cases');
  const rows=study.cases.flatMap(row=>study.seeds.map(seed=>({caseId:row.id,seed,status:'untested',
    sourceValidated:false,completedExecution:false,result:null})));
  const report=()=>({schema:'semantic-execution-study-results/8',studyDigest:study.digest,origin:study.origin,
    model:copy(study.model),settings:copy(study.settings),checkpointIdentity:study.checkpointIdentity,
    tokenizerIdentity:study.tokenizerIdentity,declared:study.declared,rows:copy(rows),
    summary:{attempted:rows.filter(row=>row.status!=='untested').length,
      untested:rows.filter(row=>row.status==='untested').length,
      publicCompleted:rows.filter(row=>row.result?.publicCompleted).length,
      sourceValidated:rows.filter(row=>row.sourceValidated).length,
      completedExecution:rows.filter(row=>row.completedExecution).length,
      completedExecutionRate:rows.filter(row=>row.completedExecution).length/study.declared,
      rateDenominator:study.declared,
      predictionAttempts:rows.reduce((sum,row)=>sum+(row.result?.costs.predictionAttempts??0),0),
      rejectedPredictions:rows.reduce((sum,row)=>sum+(row.result?.costs.rejected??0),0),
      staleRetries:rows.reduce((sum,row)=>sum+(row.result?.costs.staleRetries??0),0),
      generatedBytes:rows.reduce((sum,row)=>sum+(row.result?.costs.generatedBytes??0),0),
      generatedTokens:rows.reduce((sum,row)=>sum+(row.result?.costs.generatedTokens??0),0),
      unknownGenerationCostAttempts:rows.reduce((sum,row)=>sum+(row.result?.costs.unknownGenerationCostAttempts??0),0),
      elapsedMs:rows.reduce((sum,row)=>sum+(row.result?.costs.elapsedMs??0),0),
      nativeComputeSeconds:rows.reduce((sum,row)=>sum+Math.max(0,
        (row.result?.nativeMetricsAfter?.runtime?.computeSeconds??0)-
        (row.result?.nativeMetricsBefore?.runtime?.computeSeconds??0)),0),
      nativePeakMemoryBytes:rows.reduce((maximum,row)=>Math.max(maximum,
        row.result?.nativeMetricsAfter?.runtime?.peakMemoryBytes??0),0),
      nativeCostExecutions:rows.filter(row=>row.result?.nativeMetricsAfter?.runtime).length},
    qualification:{modelMeasurement:study.origin==='engineering'?'engineering-only':rows.some(row=>
      row.result?.qualification.modelMeasurement==='actual-model-selected')?'actual-model-selected':'unmeasured',
      settings:'frozen configuration; runtime attestation covers checkpoint, tokenizer and seed',
      defaultPromotion:false,nativeAdmissionClaim:false,optimizerSteps:0}});
  if(onResult)await onResult(report());
  for(const row of rows){
    if(!selection.has(row.caseId))continue;
    const item=study.cases.find(item=>item.id===row.caseId),privateCase=privateCases.get(row.caseId);
    try{
      const raw=await runSelectedRegionExecution({...copy(item.request),...study.limits,select,
        checkpointIdentity:study.checkpointIdentity,tokenizerIdentity:study.tokenizerIdentity,
        seed:row.seed,origin:study.origin});
      row.result=raw;row.status=raw.status;
      row.result=await scoreSelectedRegionExecution(raw,privateCase.expectedArtifact);
      row.sourceValidated=row.result.sourceValidated;row.completedExecution=row.result.completedExecution;
    }catch(error){row.status='failed';row.failure={category:error.category??error.name,message:String(error.message)};}
    if(onResult)await onResult(report());
  }
  return report();
}
