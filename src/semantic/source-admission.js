// Format-neutral source certification. Owned execution, independent original
// source observations, projection, and native admission remain separate gates.
// The static caller supplies the public representation and identity authority.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {executeWithNativeServices} from '../host/native-driver.js';
import {hostOperationContract,hostOperation} from '../host/operations.js';
import {encodeNativeGraph} from '../host/graph-codec.js';
import {decodeHostPayload} from '../host/materialize.js';
import {realizeGraph} from '../training/graph.js';
import {createFixtureBroker,canonicalFixturePlan} from '../training/fixture-broker.js';
import {defaultSplitIdentity,validateSplitIdentity,cloneSplitIdentity,normalizeSeeds,
  admissionEnvironment} from './source-identity.js';
import {AdmissionFailure,createFailureRecord} from '../training/failure-record.js';
import {independentEffectfulReference,independentSemanticChecks} from './source-reference.js';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const noNative=()=>{throw new TypeError('Native admission belongs to the final representation gate');};

export function createSourceAdmissionClient({compileProjection,verifyProjection,bindIdentity,verifyIdentity,
    validateNativePolicy=noNative,validateNativeProducer=noNative,bindNativeAdmission=noNative,
    verifyNativeBinding=noNative,recheckSession=null,receiptSchema='semantic-source-admission/1'}={}){
  if([compileProjection,verifyProjection,bindIdentity,verifyIdentity].some(fn=>typeof fn!=='function'))
    throw new TypeError('A source admission client requires a static projection and identity authority');
async function verifyTrainingCase({source,entry,args=[],fixture,
    family,license='repository-fixture',trustTier='repository-fixture',maxSteps=100000,
    timeoutMs=10000,nativeConsumer=null,seed=17,projectionOptions={},producerRevision=null,
    ancestorIds=[],taskId=null,fixtureFamily=null,provenance={},seeds={},splitIdentity=null,nativePolicy=null,randomSeed=seeds.guestRng??null}={}){
  if(typeof source!=='string'||typeof entry!=='string'||!entry||
    typeof family!=='string'||!family||typeof license!=='string'||!license||
    !['repository-fixture','trusted-owned-source'].includes(trustTier))
    throw new TypeError('Effectful admission requires source family, license and declared trusted source tier');
  if(randomSeed!==null&&(!Number.isInteger(randomSeed)||randomSeed<0||randomSeed>0xffffffff))
    throw new TypeError('The guest RNG fixture seed must be a uint32 or null');
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)
    throw new TypeError('Teacher step and deadline limits must be positive safe integers');
  normalizeSeeds(seeds,seed,randomSeed);
  if(nativeConsumer||nativePolicy!==null)nativePolicy=validateNativePolicy(nativePolicy);
  if(nativeConsumer)validateNativeProducer(producerRevision);
  splitIdentity=cloneSplitIdentity(splitIdentity??defaultSplitIdentity(family,{seed}));
  validateSplitIdentity(splitIdentity,{family,seed});
  fixture=canonicalFixturePlan(fixture);
  const broker=createFixtureBroker(fixture),abort=new AbortController();
  const timer=setTimeout(()=>{const error=new Error('Owned teacher deadline exceeded');
    broker.abort(error);abort.abort(error);},timeoutMs);
  let phase='teacher',bundle;const observations={};
  const candidate={source,entry,args,fixture,family,license,trustTier,maxSteps,timeoutMs,seed,
    projectionOptions,producerRevision,ancestorIds,taskId,fixtureFamily,provenance,seeds,splitIdentity,nativePolicy,randomSeed};
  try{
    const run=await executeWithNativeServices({entry:{text:source,functionName:entry,args},
      services:broker.services,maxSteps,randomSeed,signal:abort.signal});bundle=run.bundle;
    const effects=broker.finish();phase='projection';
    const compiled=compileProjection(bundle,{sourceLineage:family,...projectionOptions});
    observations.owned={outcome:compiled.outcome,effects};
    phase='reference';
    const input={source,entry,inputGraph:encodeNativeGraph(args),fixture,randomSeed};
    const reference=observations.original=await independentEffectfulReference(input,{timeoutMs});
    const operationReference=observations.operations=await independentEffectfulReference({...input,mode:'operations'},{timeoutMs});
    const branchReference=observations.branches=await independentEffectfulReference({...input,mode:'branches'},{timeoutMs});
    const completionReference=observations.completions=await independentEffectfulReference({...input,mode:'completions'},{timeoutMs});
    for(const result of [reference,operationReference,branchReference,completionReference]){
      if(result.callbackFailures.length)throw new AdmissionFailure('reference_callback_failure',
        'Callback failures are outside the qualified observable completion profile',result.callbackFailures);
      if(result.unhandledRejections?.length)throw new AdmissionFailure('reference_unhandled_rejection',
        'Unhandled rejections are outside the qualified observable completion profile',result.unhandledRejections);
      if(!isDeepStrictEqual(result.outcome,compiled.outcome)||!isDeepStrictEqual(result.effects,effects))
        throw new AdmissionFailure('reference_outcome_mismatch',
          'Independent Node source outcome, mutations, callback order or effects disagree',
          {expected:observations.owned,actual:{outcome:result.outcome,effects:result.effects}});
    }
    const sourceChecks=independentSemanticChecks(bundle,source,operationReference.operations,
      branchReference.decisions,completionReference.completions);
    const exported=compiled.exported;
    Object.assign(exported.sidecar,{admission:'locally_verified',referenceStatus:'agreed',
      split:splitIdentity.split,splitIdentity,sourceLineage:family,
      sourceFamily:family,fixtureFamily:fixtureFamily??family,ancestorIds:[...new Set([family,...ancestorIds])],
      taskId:taskId??family,producerRevision,license,trustTier,nativePolicy,
      capabilityProfile:compiled.exported.sidecar.compiler.capabilities,
      sourceProvenance:{family,license,trustTier,sourceDigest:hash(source),fixtureDigest:hash(fixture),seed,
        upstream:structuredClone(provenance)},
      executionLimits:{maxSteps,timeoutMs,maxGenerated:projectionOptions.maxGenerated??16384,
        maxOperators:projectionOptions.maxOperators??8},
      seeds:normalizeSeeds(seeds,seed,bundle.initialState.control.a0.randomSeed??null),
      environment:admissionEnvironment(),
      archive:bundle,projectionOptions:{sourceLineage:family,...projectionOptions},
      referenceInput:input,
      reference:{...reference,sourceChecks},effects,
      replay:verifyProjection(bundle,exported,{sourceLineage:family,...projectionOptions}),
      catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),
      evidenceKind:'deterministic-engineering',optimizerSteps:0});
    bindIdentity(exported);
    if(nativeConsumer){
      phase='native-consumer';
      const receipt=await nativeConsumer(exported);bindNativeAdmission(exported,receipt,nativePolicy);
    }
    return {status:exported.sidecar.admission,exported};
  }catch(error){
    const failure=createFailureRecord({candidate,error,phase,archive:bundle??null,observations});
    return {status:failure.original.status,category:failure.original.category,
      phase,reason:failure.original.reason,family,archiveDigest:failure.original.archiveDigest,failure};
  }finally{clearTimeout(timer);broker.abort();}
}

async function recheckAdmission(exported,{requireAdmitted=true,timeoutMs=10000,expectedIdentityDigest=null,nativePolicy=null}={}){
  const side=exported?.sidecar;
  if(side?.collection){
    if(typeof recheckSession!=='function')throw new Error('This source client does not admit collected session evidence');
    return recheckSession(exported,{requireAdmitted,timeoutMs,expectedIdentityDigest,nativePolicy});
  }
  if(!side?.archive||!side.referenceInput||side.referenceStatus!=='agreed'||
    requireAdmitted&&(side.admission!=='admitted'||side.selectionOrigin!=='certified_teacher'))
    throw new Error('Missing complete independent effectful admission evidence');
  const projection=verifyProjection(side.archive,exported,side.projectionOptions);
  const {sourceId,functionName,arguments:args}=side.archive.entrySpec;
  const source=side.archive.sources.find(s=>s.sourceId===sourceId)?.text;
  const inputGraph=encodeNativeGraph(realizeGraph(side.archive.initialState.heap,args));
  const input={source,entry:functionName,inputGraph,fixture:side.referenceInput.fixture,
    randomSeed:side.archive.initialState.control.a0.randomSeed??null};
  if(!isDeepStrictEqual(input,side.referenceInput)||hash(source)!==side.sourceProvenance?.sourceDigest||
    hash(input.fixture)!==side.sourceProvenance?.fixtureDigest)
    throw new Error('Source/reference inputs differ from the owned initial context');
  verifyIdentity(exported,{expectedIdentityDigest});
  const references=[];
  for(const mode of [null,'operations','branches','completions'])references.push(await independentEffectfulReference(
    mode?{...input,mode}:input,{timeoutMs}));
  for(const result of references){
    if(result.callbackFailures.length)throw new AdmissionFailure('reference_callback_failure',
      'Callback failures are outside the qualified observable completion profile',result.callbackFailures);
    if(result.unhandledRejections?.length)throw new AdmissionFailure('reference_unhandled_rejection',
      'Unhandled rejections are outside the qualified observable completion profile',result.unhandledRejections);
    if(!isDeepStrictEqual(result.outcome,side.reference.outcome)||
      !isDeepStrictEqual(result.effects,side.effects)||
      !isDeepStrictEqual(result.callbackFailures,side.reference.callbackFailures)||
      !isDeepStrictEqual(result.unhandledRejections??[],side.reference.unhandledRejections??[]))
      throw new Error('Independent effectful source evidence changed');
  }
  const sourceChecks=independentSemanticChecks(side.archive,source,references[1].operations,references[2].decisions,references[3].completions);
  if(!isDeepStrictEqual(sourceChecks,side.reference.sourceChecks))throw new Error('Source computation evidence changed');
  const dispatches=side.archive.events.filter(event=>event.operation==='effect.dispatch');
  const recorded=side.effects.filter(receipt=>receipt.kind==='dispatch');
  if(dispatches.length!==recorded.length)throw new Error('Native effect count differs from owned dispatch journal');
  for(const [index,event] of dispatches.entries()){
    const id=event.causes.find(cause=>cause.kind==='effect')?.effectId;
    const effect=side.archive.finalState.effects[id],spec=hostOperation(effect.operation);
    const actual=decodeHostPayload(effect.request.payload,spec.codec,spec).map((arg,slot)=>
      spec.callbackIndices.includes(slot)?{callback:true}:arg);
    if(effect.operation!==recorded[index].operation||!isDeepStrictEqual(encodeNativeGraph(actual),recorded[index].arguments))
      throw new Error('Native evaluated argument receipt differs from owned request');
    const input=side.archive.finalState.inputs[effect.inputIds[0]];
    const outcome=side.effects.find(receipt=>receipt.kind==='settlement'&&receipt.call===index);
    if(!input||!outcome||outcome.status!==(input.abrupt?'rejected':'fulfilled')||
      !isDeepStrictEqual(input.graph??encodeNativeGraph(realizeGraph(side.archive.finalState.heap,[input.value])),outcome.result))
      throw new Error('Native settlement receipt differs from owned delivery');
  }
  if(requireAdmitted)verifyNativeBinding(exported,nativePolicy);
  return {schema:receiptSchema,episodeDigest:projection.publicDigest,
    identityDigest:side.identityDigest,identityValidated:true,
    producerRevision:side.producerRevision,catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),
    referenceStatus:'agreed',journalValidated:true,replayValidated:true,sourceValidated:true,
    effectsValidated:true,optimizerSteps:0};
}


return Object.freeze({verifyTrainingCase,recheckAdmission});
}
