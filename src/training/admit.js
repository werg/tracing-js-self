// Reproducible local gate. "locally_verified" is deliberately not "admitted":
// the independent megatoken adapter/schema gate lives in another repository.
import {isDeepStrictEqual} from 'node:util';
import {createRuntime} from '../runtime.js';
import {referenceOutcome,ownedOutcome} from './reference.js';
import {exportTraining} from './export.js';
import {auditReferenceOperations} from './operation-reference.js';

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
  if(progress.kind!=='terminated' || runtime.state.control.a0.completion?.kind!=='return' ||
     Object.keys(runtime.state.effects).length || Object.keys(runtime.state.promises).length ||
     Object.values(runtime.state.frames).some(f=>f.status!=='completed'))
    return {status:'unsupported',reason:'Only completed synchronous effect-free entries qualify'};
  const reference=referenceOutcome({source,entry,
    args:runtime.entrySpec.arguments,initialHeap:runtime.initialState.heap});
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
  let exported;
  try {exported=exportTraining(runtime,{maxGenerated});}
  catch(error) {
    return {status:error instanceof RangeError?'profile_limit':'projection_failure',
      reason:String(error.message)};
  }
  exported.sidecar.referenceStatus='agreed';
  exported.sidecar.operationAudit=operationAudit;
  exported.sidecar.sourceLineage=lineage;
  exported.sidecar.generationSeed=seed;
  exported.sidecar.reference={engine:'Node.js V8 vm (independent reference only)',outcome:reference};
  return {status:'locally_verified',exported};
}
