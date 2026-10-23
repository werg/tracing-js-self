// Reproducible local gate. "locally_verified" is deliberately not "admitted":
// the independent megatoken adapter/schema gate lives in another repository.
import {isDeepStrictEqual} from 'node:util';
import {createRuntime} from '../runtime.js';
import {realizeGraph,describeGraph} from './graph.js';
import {referenceOutcome,ownedOutcome} from './reference.js';
import {exportTraining,validateTrainingExport} from './export.js';
import {auditReferenceOperations} from './operation-reference.js';
import {auditReferenceBranches} from './branch-reference.js';
import {evaluateSelectedTrajectory} from './rollout.js';

export function verifyTrainingCase({source,entry,args=[],seed=null,lineage=null,
    maxSteps=10000,maxGenerated=256}={}) {
  let runtime, progress;
  try {
    runtime=createRuntime({maxSteps}).startEntry({text:source,functionName:entry,args});
  } catch(error) {
    return {status:'unsupported',reason:String(error.message)};
  }
  try {progress=runtime.drive();}
  catch(error) {
    return {status:error instanceof RangeError?'profile_limit':'runtime_failure',
      reason:String(error.message)};
  }
  if(progress.kind==='runtime.failure'){
    const failure=progress.failure??runtime.state.control.a0.failure;
    const completion=failure?.completion;
    // Distinguish a missing callable implementation from intentional guest throws.
    const missingCallable=completion?.message==='Not a callable guest function';
    return {status:missingCallable?'runtime_failure':'unsupported',reason:completion?.message?
      'Owned guest '+(completion.errorType??'Error')+': '+completion.message:
      'Owned runtime terminated with '+(failure?.kind??'unknown failure')};
  }
  if(progress.kind!=='terminated' || runtime.state.control.a0.completion?.kind!=='return' ||
     Object.keys(runtime.state.effects).length || Object.keys(runtime.state.promises).length ||
     Object.values(runtime.state.frames).some(f=>f.status!=='completed'))
    return {status:'unsupported',reason:'Only completed synchronous effect-free entries qualify'};
  let reference;
  try {reference=referenceOutcome({source,entry,
    args:runtime.entrySpec.arguments,initialHeap:runtime.initialState.heap});}
  catch(error) {return {status:'reference_mismatch',
    reason:'Independent reference failed: '+String(error.message)};}
  let owned;
  try {owned=ownedOutcome(runtime);}
  catch(error) {return {status:'unsupported',reason:String(error.message)};}
  if(!isDeepStrictEqual(owned,reference))
    return {status:'reference_mismatch',owned,reference};
  let operationAudit;
  try {
    operationAudit=auditReferenceOperations({source,entry,
      args:runtime.entrySpec.arguments,initialHeap:runtime.initialState.heap,
      bundle:runtime.exportRun(),reference});
  } catch(error) {
    return {status:'reference_mismatch',reason:'Source-boundary observation failed: '+String(error.message),
      owned,reference};
  }
  if(operationAudit.status!=='agreed')
    return {status:'reference_mismatch',reason:'Source-boundary operation observation disagrees',
      operationAudit,owned,reference};
  let branchAudit;
  try {
    branchAudit=auditReferenceBranches({source,entry,
      args:runtime.entrySpec.arguments,initialHeap:runtime.initialState.heap,
      bundle:runtime.exportRun(),reference});
  } catch(error) {
    return {status:'reference_mismatch',
      reason:'V8 control observation failed: '+String(error.message),owned,reference};
  }
  if(branchAudit.status!=='agreed')
    return {status:'reference_mismatch',reason:'Executed V8 control decisions disagree',
      branchAudit,owned,reference};
  let exported;
  try {exported=exportTraining(runtime,{maxGenerated});}
  catch(error) {
    return {status:error instanceof RangeError?'profile_limit':'projection_failure',
      reason:String(error.message)};
  }
  const selected=evaluateSelectedTrajectory({groups:exported.public.groups,
    referenceOutcome:reference,maxGenerated});
  if(!selected.valid || selected.correctness!=='correct')
    return {status:'projection_failure',reason:'Public controller trajectory disagrees with reference',
      invalid:selected.invalid,correctness:selected.correctness};
  exported.sidecar.referenceStatus='agreed';
  exported.sidecar.operationAudit=operationAudit;
  exported.sidecar.branchAudit=branchAudit;
  exported.sidecar.sourceLineage=lineage;
  exported.sidecar.generationSeed=seed;
  exported.sidecar.reference={engine:'Node.js V8 vm (independent reference only)',outcome:reference};
  return {status:'locally_verified',exported};
}

// Explicit post-serialization *local* evidence check. This recomputes the
// independent V8 outcome and executed operation/control receipts; it never
// upgrades an episode to admitted training data. Run only on trusted sources:
// Node vm is a reference realm, NOT an isolation boundary for hostile code.
export function recheckIndependentTrainingEvidence(exported) {
  try {
    validateTrainingExport(exported);
    const {archive,referenceStatus,reference:stored,operationAudit,branchAudit}
      =exported.sidecar;
    if(referenceStatus!=='agreed' || !stored?.outcome ||
       operationAudit?.status!=='agreed'||branchAudit?.status!=='agreed')
      throw new Error('Missing independent reference evidence');
    if(archive.manifest.profile!=='training-js/1')
      throw new Error('Outside the independently checked training profile');
    const {sourceId,functionName,arguments:args}=archive.entrySpec;
    const source=archive.sources.find(s=>s.sourceId===sourceId)?.text;
    if(typeof source!=='string')
      throw new Error('Missing original training source');
    const reference=referenceOutcome({source,entry:functionName,args,
      initialHeap:archive.initialState.heap});
    const completion=archive.finalState.control.a0.completion;
    const owned={kind:'return',graph:describeGraph(realizeGraph(archive.finalState.heap,
      [...args,completion.value]))};
    if(!isDeepStrictEqual(owned,reference) ||
       !isDeepStrictEqual(stored.outcome,reference))
      throw new Error('Independent reference outcome disagrees');
    const options={source,entry:functionName,args,
      initialHeap:archive.initialState.heap,bundle:archive,reference};
    const operations=auditReferenceOperations(options);
    if(operations.status!=='agreed'||
       !isDeepStrictEqual(operations,operationAudit))
      throw new Error('Independent operation evidence disagrees');
    const branches=auditReferenceBranches(options);
    if(branches.status!=='agreed'||!isDeepStrictEqual(branches,branchAudit))
      throw new Error('Independent control evidence disagrees');
    return {valid:true,scope:'locally_verified_only',admitted:false,
      operations:operations.checked,branches:branches.checked};
  } catch(error) {
    return {valid:false,scope:'locally_verified_only',admitted:false,
      reason:String(error.message)};
  }
}
