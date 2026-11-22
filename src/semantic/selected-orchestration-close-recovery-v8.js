// Only an independently known exact native close can finish this acknowledged
// application intent. The result is a terminal disposition, never a driver.
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {verifySelectedOrchestrationCheckpoint} from './selected-orchestration-checkpoint-v8.js';
import {validateSelectedOrchestrationTerminalEvent} from './selected-history-v8.js';

const copy=structuredClone,same=isDeepStrictEqual;
const demand=(condition,message)=>{if(!condition)throw new TypeError('Selected terminal close recovery: '+message);};

export function buildRecoveredTerminalCloseV8({checkpoint,terminal,recovery,native,elapsedMs,policy,initialPublic,
    serviceAdmission=null}={}){
  const base=copy(checkpoint),intent=copy(terminal),known=copy(recovery),closed=copy(native);
  policy=copy(policy);initialPublic=copy(initialPublic);
  verifySelectedOrchestrationCheckpoint(base,policy,{initialPublic});
  validateSelectedOrchestrationTerminalEvent(intent,base);
  demand(intent.closeBoundary&&['requested','completed','cancelled'].includes(intent.phase)&&
    ['completed','cancelled'].includes(intent.snapshot.state.status)&&
    (intent.phase==='requested'||intent.phase===intent.snapshot.state.status),
    'an exact acknowledged settled terminal close intent is required');
  const snapshot=intent.snapshot,boundary=intent.closeBoundary;
  demand(known?.schema==='semantic-native-transport-close-recovery/8'&&known.recovered===true&&
    known.hostDispatches===0&&known.hostRecoveryAuthorized===false&&
    known.preCheckpointDigest===snapshot.native.native.digest&&
    known.nativeCheckpointDigest===closed?.native?.digest&&known.request?.op==='cancel'&&
    known.request.session===snapshot.session&&known.request.reason===intent.reason&&
    ['ordinal','sessionId','streamId','sessionGeneration'].every(key=>known.receipt?.[key]===boundary[key]),
    'known close changed its native checkpoint, original request or acknowledged request boundary');
  demand(Number.isFinite(elapsedMs)&&elapsedMs>=Math.max(snapshot.continuation.elapsedMs,intent.closeElapsedMs??0)&&
    elapsedMs<snapshot.policy.timeoutMs,'terminal recovery refunded or expired the original execution clock');
  demand(same(closed.attempts,snapshot.native.attempts),
    'terminal recovery changed consumed model attempts or their original evidence');
  const ownerSnapshot=intent.ownerSnapshot??null;
  if(ownerSnapshot===null)demand(serviceAdmission===null,
    'unowned terminal close cannot acquire service completion authority');
  else{
    demand(serviceAdmission&&serviceAdmission.sessionId===intent.session&&serviceAdmission.reason===intent.reason,
      'service terminal close requires the exact retained session and reason fence');
    if(intent.phase!=='requested')demand(same(serviceAdmission,intent.serviceAdmission),
      'repeated terminal recovery changed the original service fence');
  }
  if(intent.phase!=='requested')demand(same(known.receipt,intent.closeRequestReceipt)&&
    same(known.result,intent.closeReceipt),'repeated recovery changed the original close outcome');
  const body={schema:'semantic-selected-orchestration-terminal-event/8',terminalId:intent.terminalId,
    phase:snapshot.state.status,session:intent.session,baseCheckpointDigest:intent.baseCheckpointDigest,
    pendingId:intent.pendingId,snapshot,snapshotDigest:intent.snapshotDigest,reason:intent.reason,
    ownerSnapshot,serviceAdmission:copy(serviceAdmission),closeBoundary:copy(boundary),
    closeRequestReceipt:copy(known.receipt),
    closeElapsedMs:elapsedMs,closeReceipt:copy(known.result),closedNativeDigest:hashAlgorithmData(closed),closedNative:closed};
  const result={...body,digest:hashAlgorithmData(body)};
  validateSelectedOrchestrationTerminalEvent(result,base,null,intent);
  return result;
}
