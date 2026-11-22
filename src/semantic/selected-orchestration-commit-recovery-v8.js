// A known native acknowledgement can resolve one coordinator fence only when
// the host never crossed a child-dispatch boundary. No host operation runs here.
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {nativeV8OrchestrationContext} from './native-orchestration-transport-v8.js';
import {verifySelectedOrchestrationCheckpoint} from './selected-orchestration-checkpoint-v8.js';
import {validateSelectedHistoryExtension} from './selected-history-v8.js';

const copy=structuredClone,same=isDeepStrictEqual;
const demand=(value,message)=>{if(!value)throw new TypeError('Selected coordinator commit recovery: '+message);};

/** Reconstruct an exact settled host/native cut, without authorizing its use.
 * The caller must first verify latest durable history, independently recover
 * native state under its kernel lease, and obtain live elapsed-time authority.
 * It must then durably publish and independently acknowledge the returned cut.
 */
export function buildRecoveredCoordinatorCheckpointV8({checkpoint,pending,recovery,native,state,elapsedMs,
    policy,initialPublic}={}){
  const base=copy(checkpoint),fence=copy(pending),known=copy(recovery),transport=copy(native),current=copy(state);
  policy=copy(policy);initialPublic=copy(initialPublic);
  verifySelectedOrchestrationCheckpoint(base,policy,{initialPublic});
  const {id,...fenceBody}=fence??{};
  demand(fence?.schema==='semantic-selected-orchestration-pending/8'&&fence.kind==='coordinator-selection'&&
    fence.session===base.session&&fence.checkpointDigest===base.digest&&id===hashAlgorithmData(fenceBody)&&
    fence.attempt===base.coordinatorAttempts.length&&
    fence.coordinatorSelections===base.continuation.coordinatorSelections&&fence.track===base.state.track&&
    base.continuation.phase==='coordinator-ready'&&base.state.status==='active',
    'only the exact pending coordinator selection can be reconciled');
  demand(known?.schema==='semantic-native-transport-commit-recovery/8'&&known.recovered===true&&
    known.hostDispatches===0&&known.hostRecoveryAuthorized===false&&
    known.nativeCheckpointDigest===transport?.native?.digest,
    'independent exact native commit recovery is required');
  demand(fence.requestBoundary?.schema==='semantic-native-producer-request-boundary/8'&&
    ['ordinal','sessionId','streamId','sessionGeneration'].every(key=>
      known.receipt?.[key]===fence.requestBoundary[key])&&fence.requestBoundary.sessionId===base.session,
    'native request belongs to another history fence, stream, generation or ordinal');
  const request=known.request,receipt=known.result,selection=request?.selection;
  demand(request?.op==='commit-orchestration'&&request.session===base.session&&request.track===base.state.track&&
    typeof request.record==='string'&&selection?.family==='orchestration'&&
    selection.contextDigest===hashAlgorithmData(nativeV8OrchestrationContext(base.state))&&
    selection.publicDigest===base.state.publicDigest&&receipt?.schema==='semantic-orchestration-commit/8'&&
    receipt.committed===true&&receipt.selectionId===selection.selectionId,
    'recovered selection differs from the exact source and coordinator fence');
  const action=JSON.parse(request.record);
  demand(['track_create','track_join','track_progress'].includes(action?.name),
    'only acknowledged create, join and progress commits can preserve this host cut');
  demand(transport.attempts?.length===base.native.attempts.length+1&&
    transport.native?.attempts?.length===base.native.native.attempts.length+1&&
    transport.attempts.at(-1)?.selection?.selectionId===selection.selectionId&&
    transport.attempts.at(-1)?.status==='accepted'&&
    same(transport.attempts.at(-1)?.durableRequestReceipt,known.receipt),
    'recovery must consume exactly one original native selection and durable request');
  demand(Number.isFinite(elapsedMs)&&elapsedMs>=base.continuation.elapsedMs&&elapsedMs<policy.timeoutMs,
    'recovered elapsed execution budget is absent, refunded or expired');
  const attempt={attempt:fence.attempt,family:'orchestration',session:base.session,track:base.state.track,
    contextDigest:selection.contextDigest,publicDigest:selection.publicDigest,status:'committed',
    record:request.record,selection:copy(selection),commitReceipt:copy(receipt),failure:null,failureEvidence:null,
    action:copy(action)};
  const continuation={phase:action.name==='track_join'?'child-ready':
      action.name==='track_create'?'bootstrap-ready':'coordinator-ready',
    coordinatorSelections:base.continuation.coordinatorSelections+1,
    joinedAttempt:action.name==='track_join'?attempt.attempt:null,
    joinedDependency:action.name==='track_join'?copy(action.arguments.completion_dependency):null,elapsedMs,
    clockReceipt:copy(fence.clockReceipt)};
  const {digest:oldDigest,...oldBody}=base;
  const body={...oldBody,state:current,coordinatorAttempts:[...base.coordinatorAttempts,attempt],
    continuation,native:transport};
  const result={...body,digest:hashAlgorithmData(body)};
  // The ordinary complete verifier binds original source bytes, every native
  // operation/selection, child ownership, heap, context, random state and cost.
  // Full cross-cut validation additionally prevents replacing prior history.
  verifySelectedOrchestrationCheckpoint(result,policy,{initialPublic});
  validateSelectedHistoryExtension(base,result);
  demand(same(result.bridge,base.bridge)&&same(result.contexts,base.contexts)&&
    same(result.childAttempts,base.childAttempts)&&same(result.childRejections,base.childRejections)&&
    result.staleRetries===base.staleRetries,
    'coordinator reconciliation cannot introduce host or child work');
  return result;
}

/** Recover the same already sealed cut after another process loss. The native
 * primitive must have adopted this exact cut's accounting before this call. */
export function refreshRecoveredCoordinatorCheckpointV8({checkpoint,recovery,native,state,elapsedMs,
    policy,initialPublic}={}){
  const base=copy(checkpoint),known=copy(recovery),transport=copy(native),current=copy(state);
  verifySelectedOrchestrationCheckpoint(base,policy,{initialPublic});
  const last=base.coordinatorAttempts.at(-1),original=base.native.attempts.at(-1);
  demand(base.continuation.clockReceipt&&(['track_join','track_progress'].includes(last?.action?.name)||
    last?.action?.name==='track_create'&&base.continuation.phase==='bootstrap-ready')&&
    original?.family==='orchestration'&&original.status==='accepted'&&original.durableRequestReceipt&&
    known?.schema==='semantic-native-transport-commit-recovery/8'&&known.recovered===true&&
    known.hostDispatches===0&&known.hostRecoveryAuthorized===false&&
    same(known.receipt,original.durableRequestReceipt)&&known.request?.op==='commit-orchestration'&&
    known.request.session===base.session&&known.request.track===base.state.track&&
    known.request.record===last.record&&same(known.request.selection,last.selection)&&same(known.result,last.commitReceipt)&&
    known.nativeCheckpointDigest===base.native.native.digest&&same(transport.native,base.native.native)&&
    same(transport.attempts,base.native.attempts)&&same(current,base.state),
    'sealed recovery must restore exactly the same original commit, host cut and native state');
  demand(Number.isFinite(elapsedMs)&&elapsedMs>=base.continuation.elapsedMs&&elapsedMs<policy.timeoutMs,
    'sealed recovery elapsed budget is absent, refunded or expired');
  const {digest,...body}=base;
  body.native=transport;body.continuation={...body.continuation,elapsedMs};
  const result={...body,digest:hashAlgorithmData(body)};
  verifySelectedOrchestrationCheckpoint(result,policy,{initialPublic});
  validateSelectedHistoryExtension(base,result);
  return result;
}

/** Resolve only the second operation of a recorded child reservation. */
export function buildRecoveredBootstrapCheckpointV8({checkpoint,pending,recovery,native,state,elapsedMs,
    policy,initialPublic}={}){
  const base=copy(checkpoint),fence=copy(pending),known=copy(recovery),transport=copy(native),current=copy(state);
  verifySelectedOrchestrationCheckpoint(base,policy,{initialPublic});
  const {id,...body}=fence??{},last=base.coordinatorAttempts.at(-1),request=known?.request;
  demand(fence?.schema==='semantic-selected-orchestration-pending/8'&&fence.kind==='child-bootstrap'&&
    id===hashAlgorithmData(body)&&fence.session===base.session&&fence.checkpointDigest===base.digest&&
    fence.attempt===base.coordinatorAttempts.length-1&&fence.track===base.state.track&&
    fence.childTrack===last?.commitReceipt?.track?.address&&base.continuation.phase==='bootstrap-ready'&&
    same(fence.clockReceipt,base.continuation.clockReceipt)&&last.action?.name==='track_create'&&
    last.bootstrapReceipt===undefined,'bootstrap recovery requires its exact reserved-child history fence');
  demand(known?.schema==='semantic-native-transport-bootstrap-recovery/8'&&known.recovered===true&&
    known.hostDispatches===0&&known.hostRecoveryAuthorized===false&&
    known.nativeCheckpointDigest===transport?.native?.digest&&
    request?.op==='bootstrap-orchestration-child'&&request.session===base.session&&
    request.track===base.state.track&&request.childTrack===fence.childTrack&&
    known.result?.schema==='semantic-orchestration-bootstrap/8'&&known.result.bootstrapped===true&&
    known.result.track?.address===fence.childTrack&&
    ['ordinal','sessionId','streamId','sessionGeneration'].every(key=>
      known.receipt?.[key]===fence.requestBoundary?.[key]),
    'bootstrap recovery changed its exact operation, child, outcome or journal identity');
  demand(same(transport.attempts,base.native.attempts)&&
    same(transport.native.attempts,base.native.native.attempts),
    'bootstrap recovery cannot consume or alter any model selection');
  demand(Number.isFinite(elapsedMs)&&elapsedMs>=base.continuation.elapsedMs&&elapsedMs<policy.timeoutMs,
    'bootstrap recovery elapsed budget is absent, refunded or expired');
  const {digest,...resultBody}=base;
  resultBody.state=current;resultBody.native=transport;
  resultBody.coordinatorAttempts.at(-1).bootstrapReceipt=copy(known.result);
  resultBody.coordinatorAttempts.at(-1).bootstrapRequestReceipt=copy(known.receipt);
  resultBody.continuation={...base.continuation,phase:'coordinator-ready',elapsedMs};
  const result={...resultBody,digest:hashAlgorithmData(resultBody)};
  verifySelectedOrchestrationCheckpoint(result,policy,{initialPublic});
  validateSelectedHistoryExtension(checkpoint,result);
  demand(same(result.bridge,checkpoint.bridge)&&same(result.contexts,checkpoint.contexts)&&
    same(result.childAttempts,checkpoint.childAttempts)&&same(result.childRejections,checkpoint.childRejections)&&
    result.staleRetries===checkpoint.staleRetries,'bootstrap recovery cannot introduce host or child work');
  return result;
}

/** A second process loss restores the same sealed bootstrap without repeating it. */
export function refreshRecoveredBootstrapCheckpointV8({checkpoint,recovery,native,state,elapsedMs,
    policy,initialPublic}={}){
  const base=copy(checkpoint),known=copy(recovery),transport=copy(native),current=copy(state),
    last=base.coordinatorAttempts.at(-1);
  verifySelectedOrchestrationCheckpoint(base,policy,{initialPublic});
  demand(base.continuation.clockReceipt&&base.continuation.phase==='coordinator-ready'&&
    last?.action?.name==='track_create'&&last.bootstrapReceipt?.bootstrapped===true&&
    known?.schema==='semantic-native-transport-bootstrap-recovery/8'&&known.recovered===true&&
    known.hostDispatches===0&&known.hostRecoveryAuthorized===false&&
    same(known.receipt,last.bootstrapRequestReceipt)&&known.request?.op==='bootstrap-orchestration-child'&&
    known.request.session===base.session&&known.request.track===base.state.track&&
    known.request.childTrack===last.commitReceipt.track.address&&same(known.result,last.bootstrapReceipt)&&
    known.nativeCheckpointDigest===base.native.native.digest&&same(transport.native,base.native.native)&&
    same(transport.attempts,base.native.attempts)&&same(current,base.state),
    'sealed bootstrap recovery must restore the exact original outcome and complete host/native cut');
  demand(Number.isFinite(elapsedMs)&&elapsedMs>=base.continuation.elapsedMs&&elapsedMs<policy.timeoutMs,
    'sealed bootstrap elapsed budget is absent, refunded or expired');
  const {digest,...body}=base;
  body.native=transport;body.continuation={...body.continuation,elapsedMs};
  const result={...body,digest:hashAlgorithmData(body)};
  verifySelectedOrchestrationCheckpoint(result,policy,{initialPublic});
  validateSelectedHistoryExtension(base,result);
  return result;
}
