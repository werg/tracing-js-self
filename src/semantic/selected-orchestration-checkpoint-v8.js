// Composite recovery authority for one bounded native V8 coordinator session.
// The ordinary selected-execution checkpoint remains semantic-only; this
// validator joins that child ledger with the native coordinator operation log.
import {isDeepStrictEqual} from 'node:util';
import {RegionExecutionHarness} from './region-harness.js';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON} from './ir.js';
import {validateServiceAdmissionOwnerSnapshot} from './service-admission-v8.js';

const HASH=/^[a-f0-9]{64}$/;
const copy=structuredClone;
const demand=(value,message)=>{if(!value)throw new TypeError('Selected orchestration checkpoint v8: '+message);};
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
const policyKeys=['checkpointIdentity','tokenizerIdentity','trainingIdentity','seed','generationSettings',
  'maxActive','childBudget','maxCoordinatorSelections','maxPredictions','maxGenerated','maxOutstanding',
  'maxStaleRetries','timeoutMs','automaticDelivery'],
  policyKeysWithService=[...policyKeys,'serviceAdmission'];
const nativeStateKeys=['schema','initialPublic','maxActive','childBudget','origin','track','children','decisions',
  'operations','published','cancelled'];
const nativeStatusKeys=['schema','session','track','origin','sourceAdmissionClaim','status','children','decisions',
  'tracks','receipts','published','publicDigest','pendingSelection'];

function parseStrictJSON(text){
  demand(typeof text==='string','JSON value is not text');
  let index=0;
  const whitespace=()=>{while(/[\u0009\u000a\u000d\u0020]/.test(text[index]??''))index++;};
  const string=()=>{
    const start=index++;
    while(index<text.length){
      const code=text.charCodeAt(index);
      if(code===0x22){index++;return JSON.parse(text.slice(start,index));}
      if(code===0x5c){index+=2;continue;}
      if(code<=0x1f)throw new TypeError('JSON string contains a control character');
      index++;
    }
    throw new TypeError('JSON string is incomplete');
  };
  const value=depth=>{
    if(depth>128)throw new TypeError('JSON value exceeds the nesting bound');
    whitespace();
    const current=text[index];
    if(current==='"')return string();
    if(current==='{'){
      index++;whitespace();const result={},seen=new Set();
      if(text[index]==='}'){index++;return result;}
      for(;;){
        whitespace();if(text[index]!=='"')throw new TypeError('JSON object key is invalid');
        const key=string();
        if(seen.has(key))throw new TypeError('JSON object contains a duplicate key');
        seen.add(key);whitespace();
        if(text[index++]!==':')throw new TypeError('JSON object field separator is missing');
        Object.defineProperty(result,key,{value:value(depth+1),enumerable:true,configurable:true,writable:true});
        whitespace();const separator=text[index++];
        if(separator==='}')return result;
        if(separator!==',')throw new TypeError('JSON object separator is invalid');
      }
    }
    if(current==='['){
      index++;whitespace();const result=[];
      if(text[index]===']'){index++;return result;}
      for(;;){
        result.push(value(depth+1));whitespace();const separator=text[index++];
        if(separator===']')return result;
        if(separator!==',')throw new TypeError('JSON array separator is invalid');
      }
    }
    for(const [literal,parsed]of [['true',true],['false',false],['null',null]]){
      if(text.startsWith(literal,index)){index+=literal.length;return parsed;}
    }
    const match=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex=index;const numeric=match.exec(text);
    if(!numeric)throw new TypeError('JSON value is invalid');
    index=match.lastIndex;const number=Number(numeric[0]);
    if(!Number.isFinite(number))throw new TypeError('JSON number is nonfinite');
    return number;
  };
  const parsed=value(0);whitespace();
  if(index!==text.length)throw new TypeError('JSON value has trailing data');
  return parsed;
}

function validPolicy(policy){
  return (keys(policy,policyKeys)||keys(policy,policyKeysWithService))&&HASH.test(policy.checkpointIdentity??'')&&HASH.test(policy.tokenizerIdentity??'')&&
    (policy.trainingIdentity===null||HASH.test(policy.trainingIdentity))&&Number.isSafeInteger(policy.seed)&&policy.seed>=0&&
    policy.generationSettings&&typeof policy.generationSettings==='object'&&!Array.isArray(policy.generationSettings)&&
    Number.isSafeInteger(policy.maxActive)&&policy.maxActive>=1&&policy.maxActive<=16&&
    Number.isSafeInteger(policy.childBudget)&&policy.childBudget>=1&&policy.childBudget<=100000&&
    Number.isSafeInteger(policy.maxCoordinatorSelections)&&policy.maxCoordinatorSelections>=1&&
    policy.maxCoordinatorSelections<=10000&&Number.isSafeInteger(policy.maxPredictions)&&policy.maxPredictions>=1&&
    policy.maxPredictions<=100000&&Number.isSafeInteger(policy.maxGenerated)&&policy.maxGenerated>=1&&
    policy.maxGenerated<=1000000&&Number.isSafeInteger(policy.maxOutstanding)&&policy.maxOutstanding>=1&&
    policy.maxOutstanding<=1024&&Number.isSafeInteger(policy.maxStaleRetries)&&policy.maxStaleRetries>=0&&
    policy.maxStaleRetries<=1000&&Number.isSafeInteger(policy.timeoutMs)&&policy.timeoutMs>=1&&
    policy.timeoutMs<=300000&&typeof policy.automaticDelivery==='boolean'&&
    (policy.serviceAdmission==null||validateServiceAdmissionOwnerSnapshot(policy.serviceAdmission)===policy.serviceAdmission);
}

function nativeIndex(id){
  demand(typeof id==='string'&&/^v8:(0|[1-9][0-9]*)$/.test(id),'native selection id is not canonical');
  const index=Number(id.slice(3));
  demand(Number.isSafeInteger(index),'native selection id exceeds its attempt range');
  return index;
}

function recordAction(record){
  demand(typeof record==='string'&&Buffer.from(record,'utf8').toString('utf8')===record&&
    Buffer.byteLength(record)<=65536,'original model record is not bounded UTF-8');
  const action=parseStrictJSON(record);
  demand(action&&typeof action==='object'&&!Array.isArray(action)&&
    Object.keys(action).length===2&&Object.hasOwn(action,'name')&&Object.hasOwn(action,'arguments')&&
    typeof action.name==='string'&&action.arguments&&typeof action.arguments==='object'&&
    !Array.isArray(action.arguments)&&['track_create','track_join','track_progress','track_complete','track_cancel']
      .includes(action.name),'original coordinator record is not one supported lifecycle action');
  return action;
}

function selectedDigest(selection){
  const volatile=new Set(['status','generationSeconds','preparationSeconds','totalSeconds']);
  return hashAlgorithmData(Object.fromEntries(Object.entries(selection).filter(([key])=>!volatile.has(key))));
}

function expectedInitialChildren(publicData,session,coordinatorTrack){
  const programs=new Map(),children=[];
  for(const row of publicData.timeline){
    const fields=row.fields;
    if(row.kind==='program'){programs.set(fields.programId,row);continue;}
    const program=programs.get(fields.programId),source=program?.fields;
    demand(fields.activation==='call'&&fields.parentInvocationId===null&&fields.closureId===null&&
      fields.taskRevision===1&&source&&fields.session===session&&source.session===session&&
      source.programId===fields.programId&&fields.sourceDigest===source.digest&&
      hashAlgorithmData(source.source)===source.digest,
      'immutable source or declared root input binding changed');
    children.push({program:copy(program),invocation:copy(row),execution:{
      schema:'semantic-execution-binding/4',program_id:source.programId,source_digest:source.digest,
      entry:fields.entry,invocation_id:fields.invocationId,realm_id:fields.realmId,trigger_id:fields.triggerId,
      input_ref:hashAlgorithmData(fields.inputGraph),realm_policy:fields.realmPolicy,
      completion_mode:fields.completionPolicy,capability_grants:copy(source.capabilities),
      completion_target:coordinatorTrack},track:null,completion:null});
  }
  demand(children.length>=1&&children.length<=16,'bounded V8 root input count differs');
  return children;
}

function withoutChildState(child){
  const {track,completion,...immutable}=child;
  return immutable;
}

function checkSelectionLedgers(packet,session,native,transport,allowTerminal=false,allowCancelled=false){
  const all=new Map();
  for(const [kind,rows]of [['coordinator',packet.coordinatorAttempts],['child',packet.childAttempts]]){
    demand(Array.isArray(rows),kind+' attempts are missing');
    for(const [local,row]of rows.entries()){
      const expectedLocal=local;
      demand(row&&row.attempt===expectedLocal&&
        (kind==='coordinator'?row.session===session:row.session===undefined)&&typeof row.record==='string'&&
        row.selection?.modelSelected===true&&row.selection.origin==='actual-model-selected'&&
        nativeIndex(row.selection.selectionId)>=0&&!all.has(row.selection.selectionId),
        kind+' attempt ledger is malformed, duplicated or unacknowledged');
      const action=kind==='coordinator'?recordAction(row.record):null;
      if(kind==='coordinator'){
        demand(row.family==='orchestration'&&row.status==='committed'&&
          row.commitReceipt?.schema==='semantic-orchestration-commit/8'&&row.commitReceipt.committed===true&&
          row.commitReceipt.selectionId===row.selection.selectionId&&row.action&&
          isDeepStrictEqual(row.action,action),'coordinator commit evidence is not an exact positive receipt');
        const terminalAction=action.name==='track_complete'&&allowTerminal||
          action.name==='track_cancel'&&allowCancelled;
        demand(!['track_complete','track_cancel'].includes(action.name)||
          terminalAction&&kind==='coordinator'&&expectedLocal===rows.length-1,
          'terminal orchestration cannot be restored as active work');
      }else{
        demand(!Object.hasOwn(row,'family')&&['accepted','stale'].includes(row.status)&&
          row.selection.invocationId===row.invocationId&&row.selection.contextDigest===hashAlgorithmData(row.context),
          'child attempt is not a settled semantic selection');
        demand(row.status!=='accepted'||row.commitReceipt?.committed===true&&
          row.commitReceipt.selectionId===row.selection.selectionId,'accepted child lacks its exact native receipt');
        demand(row.status!=='stale'||typeof row.failure==='string'&&row.failure.length>0,
          'stale child selection lacks its exact preflight refusal');
      }
      all.set(row.selection.selectionId,{kind,row,local,action});
    }
  }
  demand(all.size===native.attempts.length&&all.size===transport.attempts.length,
    'mixed coordinator and child ledgers omit or import native selection attempts');
  for(let index=0;index<native.attempts.length;index++){
    const model=native.attempts[index],retained=transport.attempts[index],id=model?.selectionId,
      entry=all.get(id),stale=entry?.kind==='child'&&entry.row.status==='stale',
      comparedModel=stale?Object.fromEntries(Object.entries(model??{}).filter(([key])=>key!=='failure')):model;
    demand(model?.selectionId===id&&retained?.attempt===index&&nativeIndex(id)===index&&entry&&
      retained.session===session&&model.session===session&&retained.record===entry.row.record&&
      isDeepStrictEqual(retained.selection,entry.row.selection)&&
      retained.invocationId===(entry.kind==='coordinator'?null:entry.row.invocationId)&&
      model.invocationId===(entry.kind==='coordinator'?null:entry.row.invocationId)&&
      retained.contextDigest===(entry.kind==='coordinator'?entry.row.contextDigest:hashAlgorithmData(entry.row.context))&&
      selectedDigest(comparedModel)===selectedDigest(entry.row.selection)&&
      (!stale||model.failure===entry.row.failure&&retained.failure===entry.row.failure)&&
      model.checkpointIdentity===entry.row.selection.checkpointIdentity&&
      model.tokenizerIdentity===entry.row.selection.tokenizerIdentity&&
      (model.trainingIdentity??null)===(entry.row.selection.trainingIdentity??null)&&
      model.payloadHex===entry.row.selection.payloadHex&&
      isDeepStrictEqual(model.fragments,entry.row.selection.fragments),
      'original native attempt bytes, contexts or model ownership differ from the host ledger');
    if(entry.kind==='coordinator'){
      demand(model.family==='orchestration'&&model.status==='committed'&&retained.status==='accepted'&&
        retained.family==='orchestration'&&retained.contextDigest===entry.row.contextDigest&&
        retained.publicDigest===entry.row.publicDigest,'coordinator selection lacks an exact native commit');
    }else if(entry.row.status==='accepted'){
      demand(model.family===undefined&&model.status==='committed'&&retained.family===undefined&&
        retained.status==='accepted','accepted child selection differs from the native ledger');
    }else{
      demand(model.family===undefined&&model.status==='semantic-rejected'&&retained.family===undefined&&
        retained.status==='rejected'&&model.failure===entry.row.failure&&retained.failure===entry.row.failure,
        'stale child selection lacks its exact native rejection');
    }
  }
  return all;
}

function checkCoordinatorHistory(packet,nativeSession,all,session){
  const state=nativeSession.orchestration;
  demand(state&&typeof state.track==='string','native checkpoint has no coordinator address');
  const expectedChildren=expectedInitialChildren(packet.initialPublic,session,state?.track);
  demand(state&&keys(state,nativeStateKeys)&&state.schema==='semantic-orchestration/8'&&
    state.origin==='model'&&state.initialPublic&&isDeepStrictEqual(state.initialPublic,packet.initialPublic)&&
    state.maxActive===packet.policy.maxActive&&state.childBudget===packet.policy.childBudget&&
    Array.isArray(state.operations)&&Array.isArray(state.children)&&Array.isArray(state.decisions)&&
    state.children.length===expectedChildren.length&&state.children.every((child,index)=>{
      return (child.track===null||typeof child.track==='string')&&
        (child.completion===null||child.completion?.schema==='semantic-child-completion/8')&&
        isDeepStrictEqual(withoutChildState(child),withoutChildState(expectedChildren[index]));
    }),
    'native checkpoint lacks the exact bounded model-only coordinator state');
  const decisions=state.decisions;
  demand(decisions.length===packet.coordinatorAttempts.length,'native coordinator decision count differs');
  for(let index=0;index<decisions.length;index++){
    const attempt=packet.coordinatorAttempts[index],decision=decisions[index];
    demand(decision.selectionId===attempt.selection.selectionId&&decision.record===attempt.record&&
      decision.selectionDigest===selectedDigest(attempt.selection)&&
      isDeepStrictEqual(decision.outcome,attempt.commitReceipt),
      'native coordinator decision or lifecycle receipt differs from the original host attempt');
  }
  const semanticReplay=nativeSession.replay;
  demand(Array.isArray(semanticReplay)&&Array.isArray(nativeSession.contexts)&&
    isDeepStrictEqual(nativeSession.contexts,packet.contexts),
    'native child context/replay ledger differs from the host checkpoint');
  const expectedCommitted=[...all.entries()].filter(([,entry])=>entry.kind==='coordinator'||entry.row.status==='accepted')
    .map(([id])=>nativeIndex(id)).sort((a,b)=>a-b);
  const operations=state.operations,selectionOperations=operations.filter(row=>
    row?.kind==='coordinator'||row?.kind==='semantic');
  demand(operations.every(row=>row&&(
    row.kind==='coordinator'&&keys(row,['kind','attempt','randomBefore','commitRandom'])||
    row.kind==='semantic'&&keys(row,['kind','replay'])||
    row.kind==='bootstrap'&&keys(row,['kind','track','randomBefore'])||
    row.kind==='completion'&&keys(row,['kind','invocationId','acknowledgedThrough','randomBefore'])
  )),'native operation history contains an unknown or malformed recovery boundary');
  demand(selectionOperations.length===expectedCommitted.length,
    'ordered native operation log omits an acknowledged mixed selection');
  let replayIndex=0;
  const acceptedChildren=packet.childAttempts.filter(row=>row.status==='accepted');
  for(const [position,globalIndex]of expectedCommitted.entries()){
    const item=all.get(packet.native.native.attempts[globalIndex].selectionId),
      operation=selectionOperations[position];
    if(item.kind==='coordinator'){
      demand(operation.kind==='coordinator'&&operation.attempt===globalIndex&&
        all.get(item.row.selection.selectionId)?.kind==='coordinator',
        'ordered native coordinator operations differ from committed coordinator selections');
    }else{
      const replay=nativeSession.replay[replayIndex];
      const accepted=acceptedChildren[replayIndex],context=packet.contexts[replayIndex],through=replay?.acknowledgedThrough,
        appended=Number.isSafeInteger(through)?packet.bridge.public.timeline.slice(context?.visibleThrough,through):[];
      demand(operation.kind==='semantic'&&operation.replay===replayIndex&&
        replay&&keys(replay,['attempt','contextIndex','acknowledgedThrough','randomBefore'])&&
        replay.attempt===globalIndex&&replay.contextIndex===replayIndex&&
        Number.isSafeInteger(replay.acknowledgedThrough)&&
        replay.acknowledgedThrough>packet.contexts[replayIndex].visibleThrough&&
        replay.acknowledgedThrough<=packet.bridge.public.timeline.length&&accepted&&
        accepted.selection.selectionId===item.row.selection.selectionId&&appended[0]?.mode==='generated'&&
        appended[0]?.fields?.invocationId===accepted.invocationId&&appended[0]?.fields?.line===accepted.record&&
        appended.slice(1).every(row=>row.mode==='observed'),
        'ordered native child operations differ from committed semantic selections');
      replayIndex++;
    }
  }
  demand(replayIndex===packet.contexts.length&&semanticReplay.length===packet.contexts.length,
    'native semantic replay entries and contexts differ');
  const creates=packet.coordinatorAttempts.filter(row=>row.action.name==='track_create'),
    joins=packet.coordinatorAttempts.filter(row=>row.action.name==='track_join'),
    progress=packet.coordinatorAttempts.filter(row=>row.action.name==='track_progress'),
    bootstraps=operations.filter(row=>row?.kind==='bootstrap'),
    completions=operations.filter(row=>row?.kind==='completion');
  const bootstrapTracks=new Set(bootstraps.map(row=>row.track));
  demand(bootstraps.length===creates.length&&bootstrapTracks.size===bootstraps.length&&
    creates.every(row=>bootstrapTracks.has(row.commitReceipt.track?.address))&&
    bootstraps.every(row=>creates.some(create=>create.commitReceipt.track?.address===row.track)),
    'native bootstrap operation count or exact create-track coverage differs');
  for(const create of creates){
    const receipt=create.commitReceipt,dependency=receipt.completion_dependency,
      child=state.children.find(row=>row.execution?.invocation_id===dependency?.invocation),
      bootstrap=create.bootstrapReceipt,track=state.children.find(row=>row.track===dependency?.track);
    demand(dependency?.schema==='semantic-completion-dependency/4'&&dependency.track===receipt.track?.address&&
      dependency.invocation===receipt.track?.execution?.invocation_id&&child&&track===child&&
      isDeepStrictEqual(receipt.track.execution,child.execution)&&bootstrap?.schema==='semantic-orchestration-bootstrap/8'&&
      bootstrap.bootstrapped===true&&bootstrap.track?.address===child.track&&bootstrap.track.bootstrap_ready===true&&
      isDeepStrictEqual(bootstrap.track.execution,child.execution),
      'create, dependency or bootstrap receipt changed its exact declared root binding');
    demand(bootstraps.some(row=>row.track===child.track),'native bootstrap operation has no exact create receipt');
    const createdAt=operations.findIndex(row=>row.kind==='coordinator'&&
      row.attempt===nativeIndex(create.selection.selectionId)),nextCoordinator=operations.findIndex((row,index)=>
      index>createdAt&&row.kind==='coordinator'),bootstrapAt=operations.findIndex((row,index)=>
      index>createdAt&&row.kind==='bootstrap'&&row.track===child.track);
    demand(createdAt>=0&&bootstrapAt>createdAt&&(nextCoordinator<0||bootstrapAt<nextCoordinator),
      'create bootstrap was not acknowledged before the next coordinator choice');
  }
  demand(completions.length===state.children.filter(row=>row.completion!==null).length,
    'native completion operation count differs from typed child completion receipts');
  const completionInvocations=new Set();
  for(const operation of completions){
    const child=state.children.find(row=>row.execution.invocation_id===operation.invocationId),
      receipt=child?.completion,hostJoin=joins.find(row=>row.action.arguments.completion_dependency?.invocation===operation.invocationId),
      acceptedThrough=operation.acknowledgedThrough;
    demand(!completionInvocations.has(operation.invocationId)&&child&&receipt?.schema==='semantic-child-completion/8'&&receipt.session===session&&
      receipt.invocationId===operation.invocationId&&receipt.track===child.track&&hostJoin?.childCompletion&&
      isDeepStrictEqual(hostJoin.childCompletion,receipt)&&Number.isSafeInteger(acceptedThrough)&&
      acceptedThrough>0&&acceptedThrough<=packet.bridge.public.timeline.length,
      'native completion operation changed its exact owner, child or acknowledgement');
    completionInvocations.add(operation.invocationId);
    const prefix=packet.bridge.public.timeline.slice(0,acceptedThrough),completionOperation=operations.indexOf(operation),
      contextsThrough=operations.slice(0,completionOperation).filter(row=>row.kind==='semantic').length;
    demand(receipt.publicDigest===hashAlgorithmData({...packet.bridge.public,timeline:prefix})&&
      receipt.contextsDigest===hashAlgorithmData(packet.contexts.slice(0,contextsThrough)),
      'typed child completion is detached from its exact host public/context cut');
  }
  const expectedCompletionInvocations=new Set(state.children.filter(child=>child.completion!==null)
    .map(child=>child.execution.invocation_id));
  demand(completionInvocations.size===expectedCompletionInvocations.size&&
    [...completionInvocations].every(invocation=>expectedCompletionInvocations.has(invocation)),
    'native completion operation identities omit or duplicate a child result');
  const expectedRuntimeReceipts=completions.map(operation=>{
    const child=state.children.find(row=>row.execution.invocation_id===operation.invocationId),
      create=creates.find(row=>row.commitReceipt.completion_dependency?.invocation===operation.invocationId),
      completion=child?.completion?.completion;
    return {schema:'semantic-completion/4',dependency:create?.commitReceipt.completion_dependency,
      kind:completion?.kind,value:completion?.value,parent:state.track,target:state.track};
  });
  demand(Array.isArray(packet.state.receipts)&&isDeepStrictEqual(packet.state.receipts,expectedRuntimeReceipts),
    'native runtime completion receipts differ from exact child dependency and result receipts');
  demand(progress.length===state.published.length&&progress.every((row,index)=>{
    const completion=state.children.find(child=>child.execution.invocation_id===state.published[index])?.completion;
    try{return completion&&stableAlgorithmJSON(parseStrictJSON(row.action.arguments.progress))===
      stableAlgorithmJSON(completion.completion);}catch{return false;}
  }),'published coordinator progress differs from exact delivered child results');
  for(const join of joins){
    const dependency=join.action.arguments.completion_dependency,
      create=creates.find(row=>row.commitReceipt.completion_dependency?.id===dependency?.id);
    demand(create&&isDeepStrictEqual(create.commitReceipt.completion_dependency,dependency),
      'join does not use the exact dependency from an acknowledged native create receipt');
  }
  let joined=null;
  for(const operation of operations){
    if(operation.kind==='coordinator'){
      demand(!joined||joined.completed,'native coordinator selected before its joined child completed');
      joined=null;
      const attempt=packet.coordinatorAttempts.find(row=>
        nativeIndex(row.selection.selectionId)===operation.attempt);
      demand(attempt,'native coordinator operation has no original model selection');
      if(attempt.action.name==='track_join'){
        const dependency=attempt.action.arguments.completion_dependency;
        joined={attempt,invocation:dependency.invocation,completed:false};
      }
    }else if(operation.kind==='semantic'){
      const replay=nativeSession.replay[operation.replay],attempt=all.get(
        packet.native.native.attempts[replay.attempt].selectionId)?.row;
      demand(joined&&!joined.completed&&attempt?.invocationId===joined.invocation,
        'native child selection is outside its exact acknowledged join interval');
    }else if(operation.kind==='completion'){
      demand(joined&&!joined.completed&&operation.invocationId===joined.invocation,
        'native child completion is outside its exact acknowledged join interval');
      joined.completed=true;
    }else demand(!joined||joined.completed,
      'native child operation crossed an uncompleted joined-child interval');
  }
  if(packet.continuation.phase==='child-ready')
    demand(joined&&!joined.completed&&packet.coordinatorAttempts[packet.continuation.joinedAttempt]===joined.attempt,
      'join-before-run continuation differs from native operation order');
  else demand(!joined||joined.completed,'coordinator-ready continuation has an incomplete join');
}

function checkContinuation(packet,nativeSession,allowTerminal=false,allowCancelled=false,bridge=null){
  const continuation=packet.continuation,state=packet.state,policy=packet.policy;
  demand(keys(continuation,['phase','coordinatorSelections','joinedAttempt','joinedDependency','elapsedMs'])&&
    ['coordinator-ready','child-ready'].includes(continuation.phase)&&
    continuation.coordinatorSelections===packet.coordinatorAttempts.length&&
    continuation.coordinatorSelections<=policy.maxCoordinatorSelections&&
    Number.isFinite(continuation.elapsedMs)&&continuation.elapsedMs>=0&&
    continuation.elapsedMs<policy.timeoutMs,
    'explicit active continuation phase or consumed coordinator budget differs');
  demand(keys(state,nativeStatusKeys)&&state.schema==='semantic-orchestration-state/8'&&state.session===packet.session&&
    state.origin==='model'&&state.sourceAdmissionClaim===false&&
    (['active','waiting'].includes(state.status)||allowTerminal&&state.status==='completed'||
      allowCancelled&&state.status==='cancelled')&&
    state.pendingSelection===null&&state.publicDigest===hashAlgorithmData(packet.bridge.public)&&
    isDeepStrictEqual(state.children,nativeSession.orchestration.children)&&
    isDeepStrictEqual(state.decisions,nativeSession.orchestration.decisions)&&
    isDeepStrictEqual(state.published,nativeSession.orchestration.published),
    'host continuation status differs from the retained native coordinator state');
  demand(Array.isArray(state.tracks),'native coordinator track table is missing');
  const directTracks=state.tracks.filter(row=>row.parent===state.track),
    activeChildren=directTracks.filter(row=>row.status==='active'),
    childTracks=new Map(directTracks.map(row=>[row.address,row])),
    coordinatorTrack=state.tracks.find(row=>row.address===state.track);
  demand(coordinatorTrack&&coordinatorTrack.parent===null&&coordinatorTrack.execution===null&&
    coordinatorTrack.status===state.status&&coordinatorTrack.bootstrap_ready===false&&
    directTracks.length===state.children.filter(child=>child.track!==null).length&&
    childTracks.size===directTracks.length&&activeChildren.length<=policy.maxActive&&state.children.every(child=>{
    const track=child.track===null?null:childTracks.get(child.track);
    if(child.track===null)return child.completion===null&&!track;
    if(!track||!isDeepStrictEqual(track.execution,child.execution)||track.bootstrap_ready!==true)return false;
    if(child.completion!==null)return track.status==='completed';
    if(allowCancelled)return track.status==='cancelled';
    return ['active','waiting'].includes(track.status);
  })&&activeChildren.every(track=>{
    const child=state.children.find(row=>row.track===track.address),create=packet.coordinatorAttempts.find(row=>
      row.action?.name==='track_create'&&row.commitReceipt?.track?.address===track.address);
    return child&&child.completion===null&&create?.bootstrapReceipt?.bootstrapped===true&&
      !packet.childAttempts.some(row=>row.invocationId===child.execution.invocation_id);
  }),'native active child tracks are not quiescent exact bootstrapped roots');
  if(continuation.phase==='child-ready'){
    const index=continuation.joinedAttempt,join=packet.coordinatorAttempts[index],dependency=continuation.joinedDependency;
    demand(Number.isSafeInteger(index)&&join?.action?.name==='track_join'&&join.childCompletion===undefined&&
      isDeepStrictEqual(join.action.arguments.completion_dependency,dependency)&&state.status==='waiting'&&
      activeChildren.some(row=>row.address===dependency?.track&&row.bootstrap_ready===true&&
        row.execution?.invocation_id===dependency.invocation)&&
      !packet.childAttempts.some(row=>row.invocationId===dependency.invocation),
      'joined child is not at the exact runnable pre-execution boundary');
  }else if(allowTerminal){
    demand(continuation.joinedAttempt===null&&continuation.joinedDependency===null&&state.status==='completed'&&
      activeChildren.length===0&&state.children.every(child=>child.completion?.schema==='semantic-child-completion/8')&&
      state.published.length===state.children.length&&state.children.every(child=>
        state.published.includes(child.execution.invocation_id)),
      'completed coordinator cut still has unpublished or incomplete children');
    const latest=packet.coordinatorAttempts.at(-1);
    demand(latest?.status==='committed'&&latest.action?.name==='track_complete'&&
      latest.commitReceipt?.committed===true&&
      coordinatorTrack?.status==='completed',
      'completed cut has no exact final coordinator commit');
  }else if(allowCancelled){
    const latest=packet.coordinatorAttempts.at(-1);
    demand(continuation.joinedAttempt===null&&continuation.joinedDependency===null&&state.status==='cancelled'&&
      activeChildren.length===0&&
      state.children.every(child=>child.track===null||child.completion?.schema==='semantic-child-completion/8')&&
      latest?.status==='committed'&&latest.action?.name==='track_cancel'&&latest.commitReceipt?.committed===true&&
      coordinatorTrack?.status==='cancelled',
      'cancelled cut is not the exact settled track_cancel boundary');
  }else{
    demand(continuation.joinedAttempt===null&&continuation.joinedDependency===null&&state.status==='active'&&
      activeChildren.every(row=>row.bootstrap_ready===true),'coordinator-ready continuation contains an unbootstrapped child');
    if(packet.coordinatorAttempts.length){
      const latest=packet.coordinatorAttempts.at(-1);
      demand(latest.status==='committed'&&latest.action?.name!=='track_complete'&&
        latest.action?.name!=='track_cancel'&&(latest.action?.name!=='track_join'||latest.childCompletion),
        'coordinator-ready phase does not follow a settled nonterminal action');
    }
  }
}

/** Verify a complete mixed native/host cut before any native restoration RPC. */
export function verifySelectedOrchestrationCheckpoint(packet,policy,{initialPublic,allowTerminal=false,allowCancelled=false,returnBridge=false}={}){
  stableAlgorithmJSON(packet);
  demand(keys(packet,['schema','policy','session','initialPublic','initialState','state','bridge','contexts',
    'coordinatorAttempts','childAttempts','childRejections','staleRetries','continuation','native','digest'])&&
    packet.schema==='semantic-selected-orchestration-checkpoint/8'&&
    HASH.test(packet.digest??'')&&packet.digest===hashAlgorithmData(Object.fromEntries(Object.entries(packet)
      .filter(([key])=>key!=='digest'))),'composite checkpoint fields or digest differ');
  demand(validPolicy(policy)&&isDeepStrictEqual(packet.policy,policy)&&
    (policy.serviceAdmission==null||policy.serviceAdmission.policy.sessionId===packet.session),
    'external orchestration identity, host policy or work budgets differ');
  demand(packet.session===packet.initialPublic?.timeline?.[0]?.fields?.session&&
    packet.session===packet.bridge?.public?.timeline?.[0]?.fields?.session&&
    (initialPublic===undefined||isDeepStrictEqual(initialPublic,packet.initialPublic)),
    'immutable original source/input session changed');
  RegionExecutionHarness.replay(copy(packet.initialPublic),{requireTerminal:false,
    automaticDelivery:policy.automaticDelivery});
  const expectedChildren=expectedInitialChildren(packet.initialPublic,packet.session,packet.initialState?.track);
  demand(packet.initialPublic.timeline.every(row=>row.mode==='observed'&&['program','invocation'].includes(row.kind))&&
    keys(packet.initialState,nativeStatusKeys)&&packet.initialState.schema==='semantic-orchestration-state/8'&&
    packet.initialState.session===packet.session&&packet.initialState.track===packet.state?.track&&
    packet.initialState.origin==='model'&&packet.initialState.sourceAdmissionClaim===false&&
    packet.initialState.status==='active'&&packet.initialState.pendingSelection===null&&
    packet.initialState.publicDigest===hashAlgorithmData(packet.initialPublic)&&
    Array.isArray(packet.initialState.decisions)&&packet.initialState.decisions.length===0&&
    Array.isArray(packet.initialState.published)&&packet.initialState.published.length===0&&
    Array.isArray(packet.initialState.receipts)&&packet.initialState.receipts.length===0,
    'initial model-only coordinator ingress or receipt differs');
  demand(isDeepStrictEqual(packet.initialState.children,expectedChildren),
    'initial declared child bindings differ from immutable source and input rows');
  demand(!Object.hasOwn(packet.bridge,'ingress')&&!Object.hasOwn(packet.bridge,'ingressLog'),
    'durable callback history requires its independent journal path');
  const bridge=RegionExecutionHarness.restore(copy(packet.bridge),{now:()=>-Infinity,
    maxGenerated:policy.maxGenerated,maxOutstanding:policy.maxOutstanding});
  demand(isDeepStrictEqual(bridge.exportEpisode(),packet.bridge.public)&&
    bridge.inner.maxGenerated===policy.maxGenerated&&bridge.inner.maxOutstanding===policy.maxOutstanding&&
    bridge.inner.automaticDelivery===policy.automaticDelivery&&
    [...bridge.inner.intents.values()].every(row=>['settled','cancelled'].includes(row.status))&&
    packet.bridge.public.timeline.length>=packet.initialPublic.timeline.length&&
    isDeepStrictEqual(packet.bridge.public.timeline.slice(0,packet.initialPublic.timeline.length),
      packet.initialPublic.timeline),'host bridge is not the immutable ingress plus a settled public continuation');
  const accepted=packet.childAttempts.filter(row=>row.status==='accepted'),generated=packet.bridge.public.timeline
    .filter(row=>row.mode==='generated');
  demand(packet.childAttempts.length<=policy.maxPredictions&&packet.coordinatorAttempts.length<=policy.maxCoordinatorSelections&&
    packet.contexts.length===accepted.length&&generated.length===accepted.length&&
    Number.isSafeInteger(packet.staleRetries)&&packet.staleRetries===packet.childAttempts
      .filter(row=>row.status==='stale').length&&packet.staleRetries<=policy.maxStaleRetries&&
    Array.isArray(packet.childRejections),'child attempts, contexts, generated rows or retry budget differ');
  for(let index=0;index<accepted.length;index++){
    const attempt=accepted[index],row=generated[index],context=packet.contexts[index];
    demand(isDeepStrictEqual(context,attempt.context),
      'accepted child causal context differs from its original selection context');
    demand(row.fields?.invocationId===attempt.invocationId&&row.fields?.line===attempt.record,
      'accepted child bytes or invocation differ from the immutable public bridge');
    demand(Number.isSafeInteger(context.visibleThrough)&&context.visibleThrough>=packet.initialPublic.timeline.length&&
      context.visibleThrough<=packet.bridge.public.timeline.length,
      'accepted child causal context has an invalid public boundary');
    demand(context.prefixDigest===hashAlgorithmData(
      packet.bridge.public.timeline.slice(0,context.visibleThrough)),
      'accepted child causal prefix digest differs from the immutable public bridge');
  }
  const stale=packet.childAttempts.filter(row=>row.status==='stale'),rejectedIds=new Set(
    packet.childRejections.map(row=>row.selection?.selectionId));
  demand(packet.childRejections.length===stale.length&&rejectedIds.size===stale.length&&
    packet.childRejections.every(rejection=>stale.some(attempt=>
      rejection.invocationId===attempt.invocationId&&rejection.record===attempt.record&&
      (rejection.error===attempt.failure||rejection.error.endsWith(': '+attempt.failure))&&
      rejection.phase==='semantic-validation'&&
      isDeepStrictEqual(rejection.selection,attempt.selection))),
    'child retry rejection evidence was dropped or substituted');
  const transport=packet.native,{digest:transportDigest,...transportBody}=transport??{};
  demand(transport?.schema==='semantic-native-transport-checkpoint/8'&&HASH.test(transportDigest??'')&&
    transportDigest===hashAlgorithmData(transportBody)&&isDeepStrictEqual(transport.identity,{
      ...transport.identity,schema:'semantic-inference-identity/8'})&&
    transport.identity?.adapter==='native-semantic-v8/1'&&
    transport.identity.checkpointIdentity===policy.checkpointIdentity&&
    transport.identity.tokenizerIdentity===policy.tokenizerIdentity&&
    (transport.identity.trainingIdentity??null)===policy.trainingIdentity&&
    transport.identity.seed===policy.seed&&
    isDeepStrictEqual(transport.identity.generationSettings,policy.generationSettings)&&
    transport.identity.nativeAdmissionClaim===false&&
    (transport.identity.sourceAdmissionClaim===undefined||transport.identity.sourceAdmissionClaim===false)&&
    Array.isArray(transport.attempts)&&transport.runtimeMetrics&&
    ['rpcCalls','computeSeconds','peakMemoryBytes'].every(key=>Number.isFinite(transport.runtimeMetrics[key])&&
      transport.runtimeMetrics[key]>=0),'native model identity or measured transport costs differ');
  const native=transport.native,{digest:nativeDigest,...nativeBody}=native??{};
  demand(native?.schema==='semantic-model-checkpoint/8'&&HASH.test(nativeDigest??'')&&
    nativeDigest===hashAlgorithmData(nativeBody)&&isDeepStrictEqual(native.initialization,transport.identity)&&
    Array.isArray(native.attempts)&&native.attempts.length===transport.attempts.length&&
    native.sessions&&typeof native.sessions==='object'&&!Array.isArray(native.sessions)&&
    Object.keys(native.sessions).length===1&&Object.hasOwn(native.sessions,packet.session)&&
    (!native.closedSessions||Object.keys(native.closedSessions).length===0)&&
    native.sessions[packet.session].unacknowledgedSelection===null&&
    isDeepStrictEqual(native.sessions[packet.session].public,packet.bridge.public)&&
    isDeepStrictEqual(native.sessions[packet.session].contexts,packet.contexts)&&
    native.sessions[packet.session].orchestration&&
    isDeepStrictEqual(native.sessions[packet.session].orchestration.initialPublic,packet.initialPublic),
    'native checkpoint does not retain exactly this open coordinator and child bridge cut');
  demand(Array.isArray(native.openings)&&native.openings.length===1&&native.openings[0]?.session===packet.session&&
    native.closedSessions&&typeof native.closedSessions==='object'&&!Array.isArray(native.closedSessions)&&
    Object.keys(native.closedSessions).length===0&&
    !native.attempts.some(row=>row.session!==packet.session||!['committed','semantic-rejected'].includes(row.status)),
    'native checkpoint contains another session or an unacknowledged attempt');
  const all=checkSelectionLedgers(packet,packet.session,native,transport,allowTerminal,allowCancelled);
  checkCoordinatorHistory(packet,native.sessions[packet.session],all,packet.session);
  checkContinuation(packet,native.sessions[packet.session],allowTerminal,allowCancelled,bridge);
  return returnBridge?bridge:true;
}
