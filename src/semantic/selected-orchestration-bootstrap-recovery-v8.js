// Bootstrap recovery adopts an independently reexecuted native result. It adds
// no selected action, child dispatch or replacement execution clock.
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {verifySelectedOrchestrationCheckpoint} from './selected-orchestration-checkpoint-v8.js';
import {validateSelectedHistoryExtension} from './selected-history-v8.js';

const copy=structuredClone,same=isDeepStrictEqual;
const demand=(value,message)=>{if(!value)throw new TypeError('Selected child bootstrap recovery: '+message);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const producerReceipt=value=>exact(value,['schema','ordinal','digest','bytes','sessionId','streamId','sessionGeneration'])&&
  value.schema==='semantic-native-producer-request-receipt/8'&&/^[a-f0-9]{64}$/.test(value.digest??'')&&
  ['ordinal','bytes','sessionGeneration'].every(key=>Number.isSafeInteger(value[key])&&value[key]>0)&&
  ['sessionId','streamId'].every(key=>typeof value[key]==='string'&&/^[a-z][a-z0-9:_-]{0,255}$/.test(value[key]));
const recoveredBootstrap=value=>exact(value,['schema','recovered','request','result','receipt','createReceipt',
    'nativeCheckpointDigest','hostDispatches','hostRecoveryAuthorized'])&&
  value.schema==='semantic-native-transport-bootstrap-recovery/8'&&value.recovered===true&&
  value.hostDispatches===0&&value.hostRecoveryAuthorized===false&&
  producerReceipt(value.receipt)&&producerReceipt(value.createReceipt);
const checkElapsed=(elapsed,base,policy)=>demand(Number.isFinite(elapsed)&&
  elapsed>=base.continuation.elapsedMs&&elapsed<policy.timeoutMs,
  'recovered elapsed execution budget is absent, refunded or expired');

/** Construct a complete safe cut; callers still must append, read back and
 * independently acknowledge it before obtaining a runnable host driver. */
export function buildRecoveredBootstrapCheckpointV8({checkpoint,pending,recovery,native,state,elapsedMs,
    policy,initialPublic}={}){
  const base=copy(checkpoint),fence=copy(pending),known=copy(recovery),transport=copy(native),current=copy(state);
  policy=copy(policy);initialPublic=copy(initialPublic);
  verifySelectedOrchestrationCheckpoint(base,policy,{initialPublic});
  const create=base.coordinatorAttempts.at(-1),original=base.native.attempts.at(-1),{id,...body}=fence??{};
  demand(exact(fence,['schema','kind','session','checkpointDigest','attempt','track','childTrack',
      'clockReceipt','requestBoundary','createReceipt','id'])&&
    fence.schema==='semantic-selected-orchestration-pending/8'&&fence.kind==='child-bootstrap'&&
    fence.session===base.session&&fence.checkpointDigest===base.digest&&id===hashAlgorithmData(body)&&
    base.continuation.phase==='bootstrap-ready'&&base.state.status==='active'&&create?.action?.name==='track_create'&&
    fence.attempt===create.attempt&&fence.track===base.state.track&&fence.childTrack===create.commitReceipt.track.address&&
    same(fence.clockReceipt,base.continuation.clockReceipt)&&producerReceipt(fence.createReceipt)&&
    same(fence.createReceipt,original.durableRequestReceipt)&&fence.createReceipt.sessionId===base.session,
    'only the exact clock-bound child-bootstrap fence can be reconciled');
  demand(recoveredBootstrap(known)&&
    known.nativeCheckpointDigest===transport?.native?.digest&&same(known.createReceipt,fence.createReceipt)&&
    exact(fence.requestBoundary,['schema','ordinal','sessionId','streamId','sessionGeneration'])&&
    fence.requestBoundary.schema==='semantic-native-producer-request-boundary/8'&&
    fence.requestBoundary.ordinal===fence.createReceipt.ordinal+1&&
    fence.requestBoundary.sessionId===base.session&&
    ['sessionId','streamId','sessionGeneration'].every(key=>fence.requestBoundary[key]===fence.createReceipt[key])&&
    ['sessionId','streamId','sessionGeneration','ordinal'].every(key=>known.receipt?.[key]===fence.requestBoundary[key]),
    'independent bootstrap recovery changed the causal create, owner, generation or request ordinal');
  demand(exact(known.request,['id','op','session','track','childTrack'])&&
    known.request.op==='bootstrap-orchestration-child'&&known.request.session===base.session&&
    known.request.track===base.state.track&&known.request.childTrack===fence.childTrack&&
    known.result?.schema==='semantic-orchestration-bootstrap/8'&&known.result.bootstrapped===true&&
    known.result.track?.address===fence.childTrack&&
    transport.attempts?.length===base.native.attempts.length&&
    same(transport.attempts.at(-1)?.durableBootstrap?.receipt,known.receipt)&&
    same(transport.attempts.at(-1)?.durableBootstrap?.request,known.request)&&
    transport.attempts.at(-1)?.durableBootstrap?.preCheckpointDigest===base.native.native.digest,
    'recovered bootstrap differs from the exact reserved child or introduces another selection');
  checkElapsed(elapsedMs,base,policy);
  const {digest,...oldBody}=base,attempts=copy(base.coordinatorAttempts);
  attempts.at(-1).bootstrapReceipt=copy(known.result);
  const next={...oldBody,state:current,coordinatorAttempts:attempts,native:transport,
    continuation:{...base.continuation,phase:'coordinator-ready',elapsedMs}},
    result={...next,digest:hashAlgorithmData(next)};
  verifySelectedOrchestrationCheckpoint(result,policy,{initialPublic});
  validateSelectedHistoryExtension(base,result);
  return result;
}

/** Repeat process loss at an already sealed bootstrap cannot refund retained
 * native costs or advance any coordinator/child work while rebuilding state. */
export function refreshRecoveredBootstrapCheckpointV8({checkpoint,recovery,native,state,elapsedMs,
    policy,initialPublic}={}){
  const base=copy(checkpoint),known=copy(recovery),transport=copy(native),current=copy(state);
  verifySelectedOrchestrationCheckpoint(base,policy,{initialPublic});
  const create=base.coordinatorAttempts.at(-1),original=base.native.attempts.at(-1),proof=original?.durableBootstrap;
  demand(base.continuation.phase==='coordinator-ready'&&base.continuation.clockReceipt&&
    create?.action?.name==='track_create'&&create.bootstrapReceipt?.bootstrapped===true&&proof&&
    recoveredBootstrap(known)&&same(known.receipt,proof.receipt)&&
    same(known.createReceipt,original.durableRequestReceipt)&&same(known.request,proof.request)&&
    same(known.result,create.bootstrapReceipt)&&known.nativeCheckpointDigest===base.native.native.digest&&
    same(transport.native,base.native.native)&&same(transport.attempts,base.native.attempts)&&same(current,base.state),
    'sealed bootstrap recovery must restore the same original create, bootstrap and full native/host cut');
  checkElapsed(elapsedMs,base,policy);
  const {digest,...body}=base;
  body.native=transport;body.continuation={...body.continuation,elapsedMs};
  const result={...body,digest:hashAlgorithmData(body)};
  verifySelectedOrchestrationCheckpoint(result,policy,{initialPublic});
  validateSelectedHistoryExtension(base,result);
  return result;
}
