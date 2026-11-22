// Public observation authority for the one-late-callback coordinator profile.
// Private arrival/input agreement is checked separately against its journal.
import {isDeepStrictEqual as same} from 'node:util';
import {RegionExecutionHarness} from './region-harness.js';
import {hashAlgorithmData} from './program.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
const demand=(value,message)=>{if(!value)throw new TypeError('V8 callback admission: '+message);};
const without=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));

export function observedExecutionBindingV8(program,invocation,completionTarget){
  const source=program.fields,fields=invocation.fields;
  demand(source.programId===fields.programId&&source.digest===fields.sourceDigest&&
    hashAlgorithmData(source.source)===source.digest,'source and observed input differ');
  return {schema:'semantic-execution-binding/4',program_id:source.programId,source_digest:source.digest,
    entry:fields.entry,invocation_id:fields.invocationId,realm_id:fields.realmId,trigger_id:fields.triggerId,
    input_ref:hashAlgorithmData(fields.inputGraph),realm_policy:fields.realmPolicy,
    completion_mode:fields.completionPolicy,capability_grants:copy(source.capabilities),completion_target:completionTarget};
}

export function deriveCallbackAdmissionV8({session,state,previousPublic,previousContexts,completed,public:publicData,contexts}){
  demand(state?.maxActive===1&&state.children?.length===1&&state.cancelled===null&&
    Array.isArray(state.operations)&&!state.operations.some(row=>row.kind==='callback-admission')&&
    same(contexts,previousContexts),'one unchanged quiescent root history is required');
  const root=state.children[0],parent=root.invocation?.fields,rows=publicData?.timeline,
    previous=previousPublic?.timeline;
  demand(parent?.realmPolicy==='retained'&&completed.includes(parent.invocationId)&&
    root.completion?.completion?.kind==='return'&&same(state.published,[parent.invocationId]),
    'the retained root must have completed and published its result');
  demand(Array.isArray(rows)&&Array.isArray(previous)&&
    same({...publicData,timeline:[]},{...previousPublic,timeline:[]})&&
    same(rows.slice(0,previous.length),previous)&&rows.length===previous.length+2,
    'one observed event and invocation must extend the exact retained cut');
  const [event,invocation]=rows.slice(previous.length),incoming=invocation?.fields;
  demand(event?.mode==='observed'&&event.kind==='event'&&invocation?.mode==='observed'&&invocation.kind==='invocation'&&
    rows.every(row=>row.fields?.session===session),'the callback suffix must be exact observed session input');
  const before=RegionExecutionHarness.replay(copy(previousPublic),{requireTerminal:false}),
    replayed=RegionExecutionHarness.replay(copy(publicData),{requireTerminal:false}),
    handler=before.handlers.get(event.fields.subscriptionId),owner=before.invocations.get(parent.invocationId);
  demand(same(root.program,previous.find(row=>row.kind==='program'&&row.fields.programId===parent.programId))&&
    same(root.invocation,previous.find(row=>row.kind==='invocation'&&row.fields.invocationId===parent.invocationId))&&
    owner?.status==='completed'&&handler?.lifetime==='subscription'&&handler.closureId!==null&&
    handler.ownerInvocationId===parent.invocationId&&incoming.activation==='callback'&&
    incoming.parentInvocationId===parent.invocationId&&incoming.programId===parent.programId&&
    incoming.sourceDigest===parent.sourceDigest&&incoming.realmId===parent.realmId&&
    incoming.realmPolicy==='retained'&&incoming.track===parent.track&&
    incoming.closureId===handler.closureId&&incoming.entry===handler.entry&&
    replayed.invocations.has(incoming.invocationId),
    'the callback differs from the independently retained source, handler or owner');
  const child={program:copy(root.program),invocation:copy(invocation),
    execution:observedExecutionBindingV8(root.program,invocation,state.track),track:null,completion:null},
    receipt={schema:'semantic-orchestration-callback-admission/8',session,track:state.track,admitted:true,
      parentInvocationId:parent.invocationId,invocationId:incoming.invocationId,eventSequence:event.sequence,
      publicDigest:hashAlgorithmData(publicData),contextsDigest:hashAlgorithmData(contexts),execution:copy(child.execution)};
  return {child,receipt};
}

export function callbackAdmissionOperationV8(request,receipt,randomBefore){
  return {kind:'callback-admission',acknowledgedThrough:request.public.timeline.length,
    contextCount:request.contexts.length,randomBefore:copy(randomBefore),receipt:copy(receipt)};
}

export function verifyCallbackNativeDeltaV8(pre,post,request){
  demand(request.op==='admit-orchestration-callback'&&same(Object.keys(pre.sessions).sort(),Object.keys(post.sessions).sort())&&
    same(without(pre,['digest','sessions']),without(post,['digest','sessions']))&&
    Object.values(pre.sessions).every(saved=>saved.unacknowledgedSelection===null),
    'admission changed whole-adapter identity, attempts or pending authority');
  for(const [session,saved]of Object.entries(pre.sessions))if(session!==request.session)
    demand(same(saved,post.sessions[session]),'admission changed a sibling session');
  const before=pre.sessions[request.session],after=post.sessions[request.session],state=before?.orchestration;
  demand(state?.track===request.track&&after,'admission has no exact original coordinator');
  const derived=deriveCallbackAdmissionV8({session:request.session,state,previousPublic:before.public,
    previousContexts:before.contexts,completed:before.completed,public:request.public,contexts:request.contexts}),
    expectedState=copy(state);
  expectedState.children.push(derived.child);
  expectedState.operations.push(callbackAdmissionOperationV8(request,derived.receipt,pre.randomState));
  const expected={...before,public:request.public,orchestration:expectedState};
  demand(same(without(expected,['continuationDigest']),without(after,['continuationDigest']))&&
    HASH.test(after.continuationDigest??'')&&after.continuationDigest!==before.continuationDigest,
    'admission changed more than its exact observed child and ordered receipt');
  return derived.receipt;
}
