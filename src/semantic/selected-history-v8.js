// Explicit application-owned checkpoint cuts. Hashes bind retained bytes and
// order; the embedding supplies the independently expected journal head.
import {isDeepStrictEqual} from 'node:util';
import {assertAlgorithmFields,stableAlgorithmJSON} from './ir.js';
import {hashAlgorithmData} from './program.js';
import {validateServiceAdmissionPolicy,validateServiceAdmissionFence} from './service-admission-v8.js';
import {verifySelectedOrchestrationCheckpoint} from './selected-orchestration-checkpoint-v8.js';

const eq=isDeepStrictEqual,ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const fail=message=>{throw new TypeError('Selected checkpoint history: '+message);};
const demand=(condition,message)=>{if(!condition)fail(message);};
const prefix=(before,after,label)=>demand(Array.isArray(before)&&Array.isArray(after)&&
  after.length>=before.length&&eq(before,after.slice(0,before.length)),label+' is not an exact extension');
const publicPrefix=(before,after,label)=>{
  demand(before&&after&&eq({...before,timeline:[]},{...after,timeline:[]}),label+' identity changed');
  prefix(before.timeline,after.timeline,label);
};
const terminalStatuses=new Set(['submitted','decoded','acknowledging','accepted','stale','rejected',
  'semantic-rejected','acknowledgement-unknown','commit-failed','stale-limit','cancelled']);
const terminalStatusTransitions={submitted:new Set(['submitted','decoded','rejected','acknowledgement-unknown','commit-failed']),
  decoded:new Set(['decoded','accepted','stale','rejected','semantic-rejected','acknowledgement-unknown','commit-failed','cancelled']),
  acknowledging:new Set(['acknowledging','accepted','stale','acknowledgement-unknown','commit-failed','cancelled']),
  accepted:new Set(['accepted']),stale:new Set(['stale']),rejected:new Set(['rejected']),
  'semantic-rejected':new Set(['semantic-rejected']),
  'acknowledgement-unknown':new Set(['acknowledgement-unknown']),
  'commit-failed':new Set(['commit-failed']),
  'stale-limit':new Set(['stale-limit']),cancelled:new Set(['cancelled'])};
const nativeStatusTransitions={submitted:new Set(['submitted','decoded','failed','acknowledgement-unknown']),
  decoded:new Set(['decoded','accepted','rejected','commit-failed','acknowledgement-unknown','cancelled']),
  'awaiting-commit':new Set(['awaiting-commit','committed','semantic-rejected','rejected','commit-failed',
    'acknowledgement-unknown','cancelled']),accepted:new Set(['accepted']),committed:new Set(['committed']),
  rejected:new Set(['rejected']),failed:new Set(['failed']),
  'acknowledgement-unknown':new Set(['acknowledgement-unknown']),
  'commit-failed':new Set(['commit-failed']),
  'semantic-rejected':new Set(['semantic-rejected']),cancelled:new Set(['cancelled'])};

function validateTerminalSnapshot(snapshot,checkpoint){
  assertAlgorithmFields(snapshot,['attempts','contexts','staleRetries','public','rejections','nativeMetrics'],
    'selected terminal snapshot');
  demand(Array.isArray(snapshot.attempts)&&Array.isArray(snapshot.contexts)&&Array.isArray(snapshot.rejections)&&
    Number.isSafeInteger(snapshot.staleRetries)&&snapshot.staleRetries>=checkpoint.staleRetries&&
    snapshot.staleRetries<=checkpoint.policy.maxStaleRetries,
    'terminal attempt, context or retry evidence is invalid');
  prefix(checkpoint.attempts,snapshot.attempts,'terminal consumed attempts');
  prefix(checkpoint.contexts,snapshot.contexts,'terminal causal contexts');
  for(const [index,row]of snapshot.attempts.entries())
    demand(row&&row.attempt===index&&terminalStatuses.has(row.status),
      'terminal attempt status or ordering is invalid');
  const generated=snapshot.public?.timeline?.filter(row=>row.mode==='generated')??null;
  demand(Array.isArray(generated)&&generated.length===snapshot.contexts.length,
    'terminal public records and causal contexts differ');
  publicPrefix(checkpoint.bridge.public,snapshot.public,'terminal public history');
  const session=checkpoint.bridge.public.timeline[0]?.fields?.session;
  demand(typeof session==='string'&&snapshot.public.timeline[0]?.fields?.session===session,
    'terminal session identity changed');
  for(const [index,row]of generated.entries()){
    const attempt=snapshot.attempts.find(candidate=>candidate.invocationId===row.fields?.invocationId&&
      candidate.record===row.fields?.line);
    demand(attempt&&['accepted','acknowledging','acknowledgement-unknown','commit-failed'].includes(attempt.status)&&
      eq(attempt.context,snapshot.contexts[index]),'terminal generated record has no matching consumed attempt');
  }
  for(const attempt of snapshot.attempts.filter(row=>row.status==='accepted')){
    const selection=attempt.selection,payloadHex=typeof attempt.record==='string'?
      Buffer.from(attempt.record,'utf8').toString('hex'):null,policy=checkpoint.policy;
    demand(payloadHex!==null&&selection?.modelSelected===true&&selection.origin==='actual-model-selected'&&
      typeof selection.selectionId==='string'&&selection.selectionId.length>0&&
      selection.checkpointIdentity===policy.checkpointIdentity&&selection.tokenizerIdentity===policy.tokenizerIdentity&&
      (selection.trainingIdentity??null)===(policy.nativeIdentity.trainingIdentity??null)&&
      selection.prefixDigest===attempt.context.prefixDigest&&selection.contextDigest===hashAlgorithmData(attempt.context)&&
      selection.payloadHex===payloadHex&&Array.isArray(selection.fragments)&&selection.fragments.length>0&&
      selection.fragments.every(fragment=>Array.isArray(fragment?.tokenIds)&&fragment.tokenIds.length>0&&
        fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&typeof fragment.payloadHex==='string'&&
        /^(?:[0-9a-f]{2})*$/.test(fragment.payloadHex))&&
      Buffer.concat(selection.fragments.map(fragment=>Buffer.from(fragment.payloadHex,'hex')))
        .equals(Buffer.from(attempt.record,'utf8')),
      'terminal accepted selection changed its original model bytes or causal provenance');
    demand(generated.some(row=>row.fields?.invocationId===attempt.invocationId&&row.fields?.line===attempt.record),
      'terminal accepted attempt is absent from the public record history');
    assertAlgorithmFields(attempt.commitReceipt,['schema','committed','selectionId','publicDigest'],
      'terminal native commit receipt');
    const committedPublic={...snapshot.public,
      timeline:snapshot.public.timeline.slice(0,attempt.context.visibleThrough+1)};
    demand(attempt.commitReceipt.schema==='semantic-native-commit/8'&&attempt.commitReceipt.committed===true&&
      attempt.commitReceipt.selectionId===selection.selectionId&&HASH.test(attempt.commitReceipt.publicDigest??'')&&
      attempt.commitReceipt.publicDigest===hashAlgorithmData(committedPublic),
      'terminal accepted attempt lacks its exact native commit receipt');
  }
  for(const attempt of snapshot.attempts.filter(row=>row.status==='acknowledgement-unknown'))
    demand(attempt.commitReceipt?.committed!==true,
      'terminal unknown acknowledgement carries a positive commit receipt');
  const metrics=snapshot.nativeMetrics;
  stableAlgorithmJSON(metrics);
  demand(metrics?.schema==='semantic-native-model-metrics/8'&&Array.isArray(metrics.attempts)&&
    metrics.attempts.length===snapshot.attempts.length&&metrics.runtime&&
    Number.isSafeInteger(metrics.runtime.rpcCalls)&&metrics.runtime.rpcCalls>=0&&
    Number.isFinite(metrics.runtime.computeSeconds)&&metrics.runtime.computeSeconds>=0&&
    Number.isFinite(metrics.runtime.peakMemoryBytes)&&metrics.runtime.peakMemoryBytes>=0,
    'terminal native metrics are invalid or omit consumed attempts');
  // The terminal suffix repeats an active checkpoint rather than replacing it.
  // Keep that checkpoint's original transport evidence and inherited costs even
  // when an application supplies a newly hashed terminal head.
  prefix(checkpoint.native?.attempts,metrics.attempts,'terminal original native attempts');
  for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
    demand(Number.isFinite(checkpoint.native?.runtimeMetrics?.[key])&&
      metrics.runtime[key]>=checkpoint.native.runtimeMetrics[key],
      'terminal native cost accounting precedes its anchored checkpoint');
  for(const [index,row]of metrics.attempts.entries())
    demand(row?.attempt===index&&row.session===session&&
      row.invocationId===snapshot.attempts[index].invocationId&&typeof row.status==='string',
      'terminal native attempt identity differs');
  for(const attempt of snapshot.attempts.filter(row=>row.status==='accepted'))
    demand(metrics.attempts[attempt.attempt].status==='accepted',
      'driver acceptance differs from native attempt metrics');
  return true;
}

function validateTerminalSnapshotExtension(before,after){
  demand(before.attempts.length===after.attempts.length,
    'terminal cancellation added another model attempt');
  for(let index=0;index<before.attempts.length;index++){
    const left=before.attempts[index],right=after.attempts[index];
    for(const key of ['attempt','invocationId','context','prefixDigest'])
      demand(eq(left[key],right[key]),'terminal original attempt evidence changed');
    for(const key of ['record','selection','rawPayloadHex'])
      if(left[key]!==null&&left[key]!==undefined)
        demand(eq(left[key],right[key]),'terminal original attempt bytes or provenance changed');
    demand(left.completeRecord===undefined||left.completeRecord===false||left.completeRecord===right.completeRecord,
      'terminal completion evidence changed');
    demand(left.provenanceValidated===undefined||left.provenanceValidated===false||
      left.provenanceValidated===right.provenanceValidated,'terminal provenance validation changed');
    demand(terminalStatusTransitions[left.status]?.has(right.status),
      'terminal attempt outcome moved backwards or changed meaning');
    for(const key of ['generationMs','commitMs'])if(left[key]!==null&&left[key]!==undefined)
      demand(Number.isFinite(right[key])&&right[key]>=left[key],'terminal attempt cost accounting rolled back');
  }
  prefix(before.contexts,after.contexts,'terminal causal contexts');
  prefix(before.rejections,after.rejections,'terminal failure artifacts');
  publicPrefix(before.public,after.public,'terminal public history');
  demand(after.staleRetries>=before.staleRetries,'terminal stale retry count rolled back');
  if(before.nativeMetrics!==null&&after.nativeMetrics!==null){
    demand(before.nativeMetrics.attempts.length===after.nativeMetrics.attempts.length,
      'terminal native attempt count changed');
    for(let index=0;index<before.nativeMetrics.attempts.length;index++){
      const left=before.nativeMetrics.attempts[index],right=after.nativeMetrics.attempts[index];
      for(const key of ['attempt','session','invocationId','prefixDigest','contextDigest','checkpointIdentity',
        'tokenizerIdentity','trainingIdentity'])if(left[key]!==undefined)
        demand(eq(left[key],right[key]),'terminal native attempt identity changed');
      for(const key of ['record','selection'])if(left[key]!==null&&left[key]!==undefined)
        demand(eq(left[key],right[key]),'terminal native original output changed');
      demand(nativeStatusTransitions[left.status]?.has(right.status),
        'terminal native attempt outcome moved backwards or changed meaning');
    }
    for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
      demand(after.nativeMetrics.runtime[key]>=before.nativeMetrics.runtime[key],
        'terminal native cost accounting rolled back');
  }else demand(before.nativeMetrics===after.nativeMetrics,'terminal native metrics appeared or disappeared');
}

function validateTerminalEvent(event,checkpoint,previous=null){
  demand(event&&typeof event==='object','terminal event is missing');
  const fields=event.phase==='requested'?['schema','terminalId','phase','session','invocationId','reason',
    'baseCheckpointDigest','snapshot','snapshotDigest']:
    event.phase==='closed'?['schema','terminalId','phase','session','invocationId','reason',
      'baseCheckpointDigest','snapshot','snapshotDigest','closeReceipt']:
      event.phase==='unknown'?['schema','terminalId','phase','session','invocationId','reason',
        'baseCheckpointDigest','snapshot','snapshotDigest','failure']:[];
  demand(fields.length>0,'invalid terminal phase');
  const admissionPolicy=checkpoint.policy.serviceAdmission??null;
  if(admissionPolicy!==null)fields.push('serviceAdmission');
  assertAlgorithmFields(event,fields,'selected terminal event');
  const expectedSession=checkpoint.bridge.public.timeline[0]?.fields?.session,
    identity={schema:'semantic-selected-terminal/1',session:event.session,
      invocationId:event.invocationId,reason:event.reason,baseCheckpointDigest:event.baseCheckpointDigest};
  if(admissionPolicy!==null){
    validateServiceAdmissionPolicy(admissionPolicy,expectedSession);
    validateServiceAdmissionFence(event.serviceAdmission,admissionPolicy,event.reason);
  }
  demand(event.schema==='semantic-selected-terminal-event/1'&&HASH.test(event.terminalId??'')&&
    typeof event.session==='string'&&event.session===expectedSession&&
    typeof event.invocationId==='string'&&event.invocationId.length>0&&event.invocationId.length<=512&&
    typeof event.reason==='string'&&event.reason.length>0&&event.reason.length<=4096&&
    event.baseCheckpointDigest===checkpoint.digest&&event.terminalId===hashAlgorithmData(identity)&&
    HASH.test(event.snapshotDigest??'')&&event.snapshotDigest===hashAlgorithmData(event.snapshot),
    'terminal identity or snapshot digest differs');
  validateTerminalSnapshot(event.snapshot,checkpoint);
  if(event.phase==='closed'){
    assertAlgorithmFields(event.closeReceipt,['schema','closed','session','reason'],'native close receipt');
    demand(event.closeReceipt.schema==='semantic-native-close/8'&&event.closeReceipt.closed===true&&
      event.closeReceipt.session===event.session&&typeof event.closeReceipt.reason==='string'&&
      event.closeReceipt.reason.length<=4096&&event.closeReceipt.reason===event.reason,
      'native close receipt is not positive for this session and terminal reason');
  }else if(event.phase==='unknown')
    demand(typeof event.failure==='string'&&event.failure.length>0&&event.failure.length<=4096,
      'terminal uncertainty requires a bounded failure');
  if(previous){
    demand(previous.phase==='requested'&&previous.terminalId===event.terminalId&&
      previous.session===event.session&&previous.invocationId===event.invocationId&&
      previous.reason===event.reason&&previous.baseCheckpointDigest===event.baseCheckpointDigest&&
      eq(previous.serviceAdmission,event.serviceAdmission)&&
      isDeepStrictEqual(checkpoint.digest,previous.baseCheckpointDigest),
      'terminal final event differs from the independently acknowledged request');
    validateTerminalSnapshotExtension(previous.snapshot,event.snapshot);
  }
  return event;
}

export function validateSelectedHistoryReceipt(receipt){
  stableAlgorithmJSON(receipt);
  assertAlgorithmFields(receipt,['schema','streamId','position','id','bytes'],'selected history receipt');
  demand(receipt.schema==='semantic-selected-history-receipt/8'&&ID.test(receipt.streamId??'')&&
    Number.isSafeInteger(receipt.position)&&receipt.position>0&&receipt.position<=65536&&
    HASH.test(receipt.id??'')&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0,'invalid receipt');
  return receipt;
}

function validateCompositePending(pending,checkpoint){
  demand(pending&&pending.schema==='semantic-selected-orchestration-pending/8'&&
    HASH.test(pending.checkpointDigest??'')&&pending.checkpointDigest===checkpoint.digest&&
    pending.session===checkpoint.session,'pending marker is not bound to this composite checkpoint');
  const {id,...body}=pending;
  demand(HASH.test(id??'')&&id===hashAlgorithmData(body),'pending marker integrity differs');
  if(pending.kind==='coordinator-selection'){
    assertAlgorithmFields(pending,['schema','kind','session','checkpointDigest','attempt',
      'coordinatorSelections','track','id'],'composite coordinator pending marker');
    demand(checkpoint.continuation.phase==='coordinator-ready'&&checkpoint.state.status==='active'&&
      pending.attempt===checkpoint.coordinatorAttempts.length&&
      pending.coordinatorSelections===checkpoint.continuation.coordinatorSelections&&
      pending.track===checkpoint.state.track,'coordinator selection fence differs from its safe cut');
  }else if(pending.kind==='child-dispatch'){
    assertAlgorithmFields(pending,['schema','kind','session','checkpointDigest','attempt',
      'invocationId','track','dependency','id'],'composite child pending marker');
    const child=checkpoint.state.children.find(row=>row.track===pending.track);
    demand(checkpoint.continuation.phase==='child-ready'&&checkpoint.state.status==='waiting'&&
      pending.attempt===checkpoint.continuation.joinedAttempt&&
      child?.execution.invocation_id===pending.invocationId&&
      isDeepStrictEqual(pending.dependency,checkpoint.continuation.joinedDependency),
      'child dispatch fence differs from the exact waiting join dependency');
  }else fail('unknown composite pending marker kind');
  return pending;
}

function validatePendingResolution(pending,before,after){
  demand(after?.schema==='semantic-selected-orchestration-checkpoint/8',
    'pending composite work cannot resolve into a semantic-only cut');
  const attempt=after.coordinatorAttempts[pending.attempt];
  if(pending.kind==='coordinator-selection'){
    demand(attempt?.attempt===pending.attempt&&attempt.status==='committed'&&
      attempt.selection?.modelSelected===true&&attempt.commitReceipt?.committed===true&&attempt.action&&
      after.coordinatorAttempts.length===pending.attempt+1&&
      after.continuation.coordinatorSelections===pending.coordinatorSelections+1,
      'coordinator selection fence must resolve exactly one committed selection in the next cut');
  }else{
    demand(before.continuation.phase==='child-ready'&&before.continuation.joinedAttempt===pending.attempt&&
      before.continuation.joinedDependency?.track===pending.track&&
      before.continuation.joinedDependency?.invocation===pending.invocationId&&
      after.continuation.phase==='coordinator-ready'&&attempt?.action?.name==='track_join'&&
      attempt.childCompletion?.schema==='semantic-child-completion/8'&&
      attempt.childCompletion.session===pending.session&&attempt.childCompletion.track===pending.track&&
      attempt.childCompletion.invocationId===pending.invocationId&&
      attempt.action.arguments.completion_dependency?.track===pending.track&&
      attempt.action.arguments.completion_dependency?.invocation===pending.invocationId&&
      isDeepStrictEqual(attempt.childOutcome?.completion,attempt.childCompletion.completion)&&
      isDeepStrictEqual(after.state.children.find(row=>row.track===pending.track)?.completion,
        attempt.childCompletion)&&
      after.state.status==='active'&&
      after.coordinatorAttempts.length===before.coordinatorAttempts.length&&
      after.continuation.coordinatorSelections===before.continuation.coordinatorSelections&&
      after.childAttempts.length>before.childAttempts.length&&
      after.childAttempts.slice(before.childAttempts.length).every(row=>row.invocationId===pending.invocationId),
      'child dispatch fence must resolve only the joined invocation before another coordinator action');
  }
}

export function validateSelectedHistoryEntry(entry){
  stableAlgorithmJSON(entry);
  const fields=['schema','streamId','position','previous','checkpoint',
    ...(Object.hasOwn(entry??{},'terminal')?['terminal']:[]),
    ...(Object.hasOwn(entry??{},'pending')?['pending']:[])];
  assertAlgorithmFields(entry,fields,'selected history entry');
  demand(entry.schema==='semantic-selected-history-entry/8'&&ID.test(entry.streamId??'')&&
    Number.isSafeInteger(entry.position)&&entry.position>0&&entry.position<=65536,'invalid entry');
  if(entry.position===1)demand(entry.previous===null,'first entry has a predecessor');
  else{
    validateSelectedHistoryReceipt(entry.previous);
    demand(entry.previous.streamId===entry.streamId&&entry.previous.position===entry.position-1,
      'noncontiguous predecessor');
  }
  const packet=entry.checkpoint;
  if(packet?.schema==='semantic-selected-orchestration-checkpoint/8'){
    demand(!Object.hasOwn(entry,'terminal'),
      'composite terminal history is unsupported until its terminal disposition is independently verified');
    if(Object.hasOwn(entry,'pending'))validateCompositePending(entry.pending,packet);
    verifySelectedOrchestrationCheckpoint(packet,packet.policy,{initialPublic:packet.initialPublic});
  }else{
    demand(!Object.hasOwn(entry,'pending'),
      'pending composite markers cannot be attached to semantic-only history');
    assertAlgorithmFields(packet,['schema','policy','bridge','contexts','attempts','staleRetries','native','digest'],
      'selected history checkpoint');
    const {digest,...body}=packet;
    demand(packet.schema==='semantic-selected-driver-checkpoint/8'&&HASH.test(digest??'')&&
      digest===hashAlgorithmData(body),'checkpoint integrity differs');
  }
  if(Object.hasOwn(entry,'terminal'))validateTerminalEvent(entry.terminal,packet);
  return entry;
}

/** Full source/continuation validation is performed by the driver before any
 * native restore. These cross-cut invariants additionally prevent a valid cut
 * on another branch, or a budget rollback, replacing recorded history. */
export function validateSelectedHistoryExtension(before,after){
  if(before?.schema==='semantic-selected-orchestration-checkpoint/8'||
      after?.schema==='semantic-selected-orchestration-checkpoint/8'){
    demand(before?.schema==='semantic-selected-orchestration-checkpoint/8'&&
      after?.schema==='semantic-selected-orchestration-checkpoint/8',
      'checkpoint history cannot mix semantic and composite cuts');
    verifySelectedOrchestrationCheckpoint(before,before.policy,{initialPublic:before.initialPublic});
    verifySelectedOrchestrationCheckpoint(after,after.policy,{initialPublic:after.initialPublic});
    demand(eq(before.policy,after.policy)&&eq(before.initialPublic,after.initialPublic)&&
      eq(before.initialState,after.initialState)&&before.session===after.session&&
      before.bridge?.schema===after.bridge?.schema&&before.bridge?.profile===after.bridge?.profile,
      'composite execution identity, ingress or initial coordinator state changed');
    prefix(before.contexts,after.contexts,'composite causal contexts');
    demand(after.coordinatorAttempts.length>=before.coordinatorAttempts.length,
      'composite coordinator decisions were removed');
    for(let index=0;index<before.coordinatorAttempts.length;index++){
      const prior=before.coordinatorAttempts[index],next=after.coordinatorAttempts[index];
      const stripJoinCompletion=row=>Object.fromEntries(Object.entries(row)
        .filter(([key])=>key!=='childCompletion'&&key!=='childOutcome'));
      demand(eq(stripJoinCompletion(prior),stripJoinCompletion(next)),
        'a recorded coordinator selection or receipt changed');
      if(prior.childCompletion!==undefined||prior.childOutcome!==undefined)
        demand(eq(prior.childCompletion,next.childCompletion)&&eq(prior.childOutcome,next.childOutcome),
          'acknowledged child completion evidence changed');
      else if(next.childCompletion!==undefined||next.childOutcome!==undefined)
        demand(prior.action?.name==='track_join'&&prior.status==='committed'&&
          next.childCompletion?.schema==='semantic-child-completion/8'&&next.childOutcome&&
          typeof next.childOutcome==='object',
          'only an acknowledged join may acquire its exact child completion outcome');
    }
    prefix(before.childAttempts,after.childAttempts,'child selections');
    prefix(before.childRejections,after.childRejections,'child rejections');
    publicPrefix(before.bridge?.public,after.bridge?.public,'composite public history');
    demand(Number.isSafeInteger(before.staleRetries)&&Number.isSafeInteger(after.staleRetries)&&
      after.staleRetries>=before.staleRetries&&
      Number.isSafeInteger(before.continuation?.coordinatorSelections)&&
      Number.isSafeInteger(after.continuation?.coordinatorSelections)&&
      after.continuation.coordinatorSelections>=before.continuation.coordinatorSelections&&
      Number.isFinite(before.continuation?.elapsedMs)&&Number.isFinite(after.continuation?.elapsedMs)&&
      after.continuation.elapsedMs>=before.continuation.elapsedMs&&
      (before.continuation.phase===after.continuation.phase||
        before.continuation.phase==='coordinator-ready'&&after.continuation.phase==='child-ready'||
        before.continuation.phase==='child-ready'&&after.continuation.phase==='coordinator-ready'),
      'composite retry budget, phase, selection count or elapsed deadline rolled back');
    const oldNative=before.native?.native,newNative=after.native?.native,
      oldTransport=before.native,newTransport=after.native,
      oldSession=oldNative?.sessions?.[before.session],newSession=newNative?.sessions?.[after.session];
    demand(eq(oldTransport?.identity,newTransport?.identity)&&oldSession&&newSession,
      'composite native identity or session changed');
    for(const key of ['schema','equivalence','contractDigest','initialization','settings'])
      demand(eq(oldNative?.[key],newNative?.[key]),'composite native '+key+' changed');
    prefix(oldNative?.openings,newNative?.openings,'composite native openings');
    demand(eq(oldSession.openingRandom,newSession.openingRandom),
      'composite native session random state changed');
    prefix(oldSession.replay,newSession.replay,'composite native replay history');
    for(const [key,value] of Object.entries(oldTransport?.runtimeMetrics??{}))
      demand(Number.isFinite(value)&&value>=0&&Number.isFinite(newTransport?.runtimeMetrics?.[key])&&
        newTransport.runtimeMetrics[key]>=value,'composite native runtime accounting rolled back');
    prefix(oldTransport?.attempts,newTransport?.attempts,'composite transport attempts');
    prefix(oldNative?.attempts,newNative?.attempts,'composite native attempts');
    prefix(oldSession.orchestration?.operations,newSession.orchestration?.operations,
      'composite acknowledged operation history');
    prefix(oldSession.orchestration?.decisions,newSession.orchestration?.decisions,
      'composite coordinator decisions');
    prefix(oldSession.contexts,newSession.contexts,'composite native contexts');
    demand(after.native.native.attempts.length>=before.native.native.attempts.length,
      'composite acknowledged work rolled back');
    return true;
  }
  demand(eq(before.policy,after.policy),'execution policy or model identity changed');
  demand(before.bridge?.schema===after.bridge?.schema&&before.bridge?.profile===after.bridge?.profile,
    'host continuation identity changed');
  publicPrefix(before.bridge?.public,after.bridge?.public,'public history');
  prefix(before.contexts,after.contexts,'causal contexts');
  prefix(before.attempts,after.attempts,'consumed driver attempts');
  demand(Number.isSafeInteger(before.staleRetries)&&Number.isSafeInteger(after.staleRetries)&&
    after.staleRetries>=before.staleRetries,'stale retry budget rolled back');
  demand(Number.isSafeInteger(before.bridge.ingressCursor)&&Number.isSafeInteger(after.bridge.ingressCursor)&&
    before.bridge.ingressCursor>=1&&after.bridge.ingressCursor>=before.bridge.ingressCursor,'ingress cursor rolled back');
  const oldHead=before.bridge.ingressLog,newHead=after.bridge.ingressLog;
  if(oldHead)demand(newHead&&newHead.streamId===oldHead.streamId&&newHead.position>=oldHead.position&&
    (newHead.position!==oldHead.position||eq(newHead,oldHead)),'ingress acknowledgement rolled back or changed');
  const oldTransport=before.native,newTransport=after.native;
  demand(oldTransport?.schema===newTransport?.schema&&eq(oldTransport?.identity,newTransport?.identity),
    'native transport identity changed');
  prefix(oldTransport?.attempts,newTransport?.attempts,'consumed transport attempts');
  for(const [key,value]of Object.entries(oldTransport?.runtimeMetrics??{}))
    demand(Number.isFinite(value)&&value>=0&&Number.isFinite(newTransport?.runtimeMetrics?.[key])&&
      newTransport.runtimeMetrics[key]>=value,'native runtime cost accounting rolled back');
  const oldNative=oldTransport.native,newNative=newTransport.native;
  for(const key of ['schema','equivalence','contractDigest','initialization','settings'])
    demand(eq(oldNative?.[key],newNative?.[key]),'native '+key+' changed');
  prefix(oldNative?.attempts,newNative?.attempts,'consumed native attempts');
  if(oldNative.openings!==undefined||newNative.openings!==undefined)
    prefix(oldNative.openings,newNative.openings,'native session openings');
  demand(oldNative.sessions&&newNative.sessions,'native sessions are missing');
  for(const [session,oldSession]of Object.entries(oldNative.sessions)){
    const newSession=newNative.sessions[session];
    demand(newSession,'native session was retired without a durable terminal cut');
    publicPrefix(oldSession.public,newSession.public,'native acknowledged public history');
    prefix(oldSession.contexts,newSession.contexts,'native causal contexts');
    if(oldSession.replay!==undefined||newSession.replay!==undefined)
      prefix(oldSession.replay,newSession.replay,'native reconstruction ledger');
    demand(eq(oldSession.openingRandom,newSession.openingRandom),'native opening random state changed');
    if(oldSession.ingestedThrough!==undefined||newSession.ingestedThrough!==undefined)
      demand(Number.isSafeInteger(oldSession.ingestedThrough)&&Number.isSafeInteger(newSession.ingestedThrough)&&
        newSession.ingestedThrough>=oldSession.ingestedThrough,'native observation cursor rolled back');
    if(oldSession.completed!==undefined||newSession.completed!==undefined)
      demand(Array.isArray(oldSession.completed)&&Array.isArray(newSession.completed)&&
        oldSession.completed.every(id=>newSession.completed.includes(id)),'native completion acknowledgement disappeared');
  }
  return true;
}

export function validateSelectedHistoryChain(entries,receipt){
  validateSelectedHistoryReceipt(receipt);
  demand(Array.isArray(entries)&&entries.length===receipt.position&&entries.length<=65536,
    'incomplete acknowledged chain');
  let previous=null,checkpoint=null,terminal=null,pending=null,pendingCheckpoint=null;
  for(const entry of entries){
    validateSelectedHistoryEntry(entry);
    demand(entry.streamId===receipt.streamId&&entry.position===(previous?.position??0)+1&&eq(entry.previous,previous),
      'substituted or reordered acknowledged chain');
    if(pending){
      validateSelectedHistoryExtension(pendingCheckpoint,entry.checkpoint);
      validatePendingResolution(pending,pendingCheckpoint,entry.checkpoint);
      pending=null;pendingCheckpoint=null;
    }
    if(terminal?.phase==='requested'){
      demand(Object.hasOwn(entry,'terminal')&&['closed','unknown'].includes(entry.terminal.phase)&&
        eq(entry.checkpoint,checkpoint),'terminal request must be followed only by its final disposition');
      validateTerminalEvent(entry.terminal,entry.checkpoint,terminal);
      terminal=entry.terminal;
    }else if(terminal){
      fail('history continues after terminal disposition');
    }else if(Object.hasOwn(entry,'terminal')){
      demand(checkpoint&&entry.terminal.phase==='requested'&&eq(entry.checkpoint,checkpoint),
        'terminal request must anchor the latest validated checkpoint');
      validateTerminalEvent(entry.terminal,entry.checkpoint);
      terminal=entry.terminal;
    }else if(checkpoint)validateSelectedHistoryExtension(checkpoint,entry.checkpoint);
    checkpoint=entry.checkpoint;
    if(Object.hasOwn(entry,'pending')){
      demand(entry.checkpoint?.schema==='semantic-selected-orchestration-checkpoint/8'&&!terminal,
        'pending markers are restricted to active composite history');
      pending=entry.pending;pendingCheckpoint=entry.checkpoint;
    }
    previous={schema:'semantic-selected-history-receipt/8',streamId:entry.streamId,position:entry.position,
      id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))};
  }
  demand(eq(previous,receipt),'chain differs from the independently retained head');
  return entries;
}
