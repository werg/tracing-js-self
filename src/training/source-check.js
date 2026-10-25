// Synchronous, trusted-source conformance gate for the canonical semantic
// execution witness. The native effectful admission pipeline uses the same
// v4 producer; this fixture-only helper cannot grant corpus admission.
import {isDeepStrictEqual} from 'node:util';
import {createRuntime} from '../runtime.js';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {referenceOutcome,ownedOutcome} from './reference.js';
import {auditReferenceOperations} from './operation-reference.js';
import {auditReferenceBranches} from './branch-reference.js';
import {compileEffectfulWitness,verifyEffectfulProjection} from './effectful-compiler.js';
import {realizeGraph,describeGraph} from './graph.js';
import {validateSemantic} from '../semantic/normalize.js';

function checkSource(bundle,source,entry,owned,reference){
  const options={source,entry,args:bundle.entrySpec.arguments,
    initialHeap:bundle.initialState.heap,bundle,reference};
  const operationAudit=auditReferenceOperations(options);
  const branchAudit=auditReferenceBranches(options);
  if(operationAudit.status!=='agreed'||branchAudit.status!=='agreed')
    throw new Error('Independent source operation/branch observations disagree');
  if(!isDeepStrictEqual(owned,reference))
    throw new Error('Independent native source outcome differs from owned result');
  return {operationAudit,branchAudit};
}

export function verifyOwnedSourceCase({source,entry,args=[],seed=null,lineage=null,
    maxSteps=10000,maxGenerated=4096}={}){
  let runtime,progress;
  try{runtime=createRuntime({maxSteps,randomSeed:seed}).startEntry({
    text:source,functionName:entry,args});}
  catch(error){return {status:'unsupported',reason:String(error.message)};}
  try{progress=runtime.drive();}
  catch(error){return {status:error instanceof RangeError?'profile_limit':'runtime_failure',
    reason:String(error.message)};}
  if(progress.kind==='runtime.failure'){
    const failure=progress.failure??runtime.state.control.a0.failure;
    const completion=failure?.completion;
    return {status:completion?.message==='Not a callable guest function'?
      'runtime_failure':'unsupported',
      reason:completion?.message?'Owned guest '+(completion.errorType??'Error')+': '+completion.message:
        'Owned runtime terminated with '+(failure?.kind??'unknown failure')};
  }
  if(progress.kind!=='terminated'||runtime.state.control.a0.completion?.kind!=='return'||
     Object.keys(runtime.state.effects).length||Object.keys(runtime.state.promises).length||
     Object.values(runtime.state.frames).some(frame=>frame.status!=='completed'))
    return {status:'unsupported',reason:'Only completed synchronous effect-free entries qualify'};
  const bundle=runtime.exportRun();
  let reference,owned;
  try {
    reference=referenceOutcome({source,entry,args:runtime.entrySpec.arguments,
      initialHeap:runtime.initialState.heap,
      randomSeed:runtime.initialState.control.a0.randomSeed??null});
    owned=ownedOutcome(runtime);
    if(!isDeepStrictEqual(reference,owned))
      return {status:'reference_mismatch',owned,reference};
  }catch(error){return {status:'reference_mismatch',
    reason:'Independent reference failed: '+String(error.message)};}
  let evidence;
  try{evidence=checkSource(bundle,source,entry,owned,reference);}
  catch(error){return {status:'reference_mismatch',reason:String(error.message),owned,reference};}
  try{
    const projectionOptions={sourceLineage:lineage,maxGenerated};
    const compiled=compileEffectfulWitness(bundle,projectionOptions);
    if(!isDeepStrictEqual(compiled.outcome,reference))
      throw new Error('Canonical selected outcome diverges from independent reference');
    const exported=compiled.exported;
    Object.assign(exported.sidecar,{
      archive:bundle,semantic:compiled.semantic,projectionOptions,referenceStatus:'agreed',
      reference:{outcome:reference},sourceLineage:lineage,
      operationAudit:evidence.operationAudit,branchAudit:evidence.branchAudit,
      generationSeed:seed,referenceEngine:'Node.js V8 (trusted-source reference only)'});
    return {status:'locally_verified',exported};
  }catch(error){return {status:error instanceof RangeError?'profile_limit':'projection_failure',
    reason:String(error.message)};}
}

/** Rechecks a serialized v4 episode against a newly run independent V8
 * reference and the actual guest journal. Never dispatches native effects or
 * upgrades an owned fixture to admitted model training data. */
export function recheckOwnedSourceEvidence(exported){
  try{
    const side=exported?.sidecar;
    if(side?.referenceStatus!=='agreed'||side?.representation!=='compact'||
       side.operationAudit?.status!=='agreed'||side.branchAudit?.status!=='agreed')
      throw new Error('Missing independent source evidence for canonical representation');
    const bundle=side.archive;
    validateSemantic(bundle,side.semantic);
    if(validateBundle(bundle).valid!==true||replayExact(bundle).valid!==true)
      throw new Error('Invalid owned journal or private replay');
    if(bundle.manifest.profile!=='training-js/1')
      throw new Error('Outside the supported synchronous guest profile');
    const {sourceId,functionName:entry,arguments:args}=bundle.entrySpec;
    const source=bundle.sources.find(item=>item.sourceId===sourceId)?.text;
    if(typeof source!=='string')throw new Error('Missing original guest source');
    const reference=referenceOutcome({source,entry,args,initialHeap:bundle.initialState.heap,
      randomSeed:bundle.initialState.control.a0.randomSeed??null});
    const finished=bundle.finalState.control.a0.completion;
    if(finished?.kind!=='return')throw new Error('Missing completed source reference');
    const owned={kind:'return',graph:describeGraph(realizeGraph(bundle.finalState.heap,
      [...args,finished.value]))};
    if(!isDeepStrictEqual(reference,owned)||
       !isDeepStrictEqual(side.reference?.outcome,reference))
      throw new Error('Independent observable source outcome has changed');
    const current=checkSource(bundle,source,entry,owned,reference);
    if(!isDeepStrictEqual(current.operationAudit,side.operationAudit)||
       !isDeepStrictEqual(current.branchAudit,side.branchAudit))
      throw new Error('Independent source operation or branch evidence has changed');
    verifyEffectfulProjection(bundle,exported,side.projectionOptions);
    return {valid:true,scope:'locally_verified_only',admitted:false,
      traceFormat:'semantic-trace/4',operations:current.operationAudit.checked,
      branches:current.branchAudit.checked};
  }catch(error){return {valid:false,scope:'locally_verified_only',admitted:false,
    reason:String(error.message)};}
}
