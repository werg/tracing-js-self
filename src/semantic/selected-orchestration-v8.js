// Model-selected bounded V8 coordination. Lifecycle bytes remain native model
// output; this host driver only acknowledges, bootstraps and runs declared roots.
import {isDeepStrictEqual} from 'node:util';
import {RegionExecutionHarness} from './region-harness.js';
import {RegionSelectedModelDriver,boundedCancellationReason,restoreSelectedOrchestrationChildDriver} from
  './selected-execution-v8.js';
import {nativeV8OrchestrationContext} from './native-orchestration-transport-v8.js';
import {verifySelectedOrchestrationCheckpoint} from './selected-orchestration-checkpoint-v8.js';
import {hashAlgorithmData} from './program.js';
import {validateSelectedHistoryReceipt,validateSelectedHistoryChain} from './selected-history-v8.js';
import {validateServiceAdmissionOwnerSnapshot} from './service-admission-v8.js';
import {assertSelectedOrchestrationExecutionClock} from '../storage/selected-orchestration-clock.js';
import {buildRecoveredCoordinatorCheckpointV8,refreshRecoveredCoordinatorCheckpointV8}
  from './selected-orchestration-commit-recovery-v8.js';
import {buildRecoveredBootstrapCheckpointV8,refreshRecoveredBootstrapCheckpointV8}
  from './selected-orchestration-bootstrap-recovery-v8.js';
import {buildRecoveredTerminalCloseV8} from './selected-orchestration-close-recovery-v8.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
function freezeTree(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
const demand=(value,message)=>{if(!value)throw new TypeError('Selected orchestration v8: '+message);};
const positive=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;
const hex=value=>typeof value==='string'&&/^(?:[0-9a-f]{2})*$/.test(value);

function validateIngress(publicData){
  demand(publicData?.schema==='semantic-execution/8'&&Array.isArray(publicData.timeline)&&
    publicData.timeline.length>=2&&publicData.timeline.every(row=>row?.mode==='observed'&&
      ['program','invocation'].includes(row.kind)),
    'initial public cut must contain observed V8 source and root inputs only');
  const session=publicData.timeline[0]?.fields?.session;
  demand(typeof session==='string'&&session.length>0&&publicData.timeline.every(row=>row.fields.session===session),
    'all declared roots must belong to one exact session');
  const invocations=publicData.timeline.filter(row=>row.kind==='invocation');
  demand(invocations.length>=1&&invocations.length<=16,'one to sixteen declared root invocations are required');
  const ids=new Set(),realms=new Set();
  for(const row of invocations){
    const fields=row.fields;
    demand(fields.activation==='call'&&fields.parentInvocationId===null&&fields.closureId===null&&
      fields.taskRevision===1,'coordinator roots must be declared call invocations');
    demand(typeof fields.invocationId==='string'&&fields.invocationId.length>0&&!ids.has(fields.invocationId),
      'declared root invocation identities must be unique');
    ids.add(fields.invocationId);
    // The shared host scheduler and the independent native prefix validator
    // both reject simultaneous roots retained in one realm. A single retained
    // root is valid; a multi-root cohort needs distinct fresh realms.
    if(invocations.length>1){
      demand(fields.realmPolicy==='fresh'&&typeof fields.realmId==='string'&&!realms.has(fields.realmId),
        'multiple declared roots require distinct fresh realms accepted by native prefix validation');
    }
    if(typeof fields.realmId==='string')realms.add(fields.realmId);
  }
  RegionExecutionHarness.replay(copy(publicData),{requireTerminal:false});
  return {session,invocations};
}

function childSelector(select){
  const view=async input=>select(input);
  view.commit=input=>select.commit(input);
  if(typeof select.complete==='function')view.complete=input=>select.complete(input);
  if(typeof select.reject==='function')view.reject=input=>select.reject(input);
  if(typeof select.metrics==='function')view.metrics=()=>select.metrics();
  // A child failure must first cancel the coordinator with the same bounded
  // reason. The outer driver owns native session close after that receipt.
  return view;
}

function checkCoordinatorSelection(output,{session,track,state,context,checkpointIdentity,tokenizerIdentity,trainingIdentity}){
  const record=output?.record,selection=output?.selection;
  demand(output?.schema==='semantic-orchestration-output/8'&&typeof record==='string'&&
    Buffer.from(record,'utf8').toString('utf8')===record&&Buffer.byteLength(record)<=65536,
    'coordinator must return one complete bounded original UTF-8 selection');
  const payloadHex=Buffer.from(record,'utf8').toString('hex');
  demand(selection?.family==='orchestration'&&selection.modelSelected===true&&
    selection.origin==='actual-model-selected'&&selection.session===session&&selection.invocationId===null&&
    typeof selection.selectionId==='string'&&selection.selectionId.length>0&&
    selection.checkpointIdentity===checkpointIdentity&&selection.tokenizerIdentity===tokenizerIdentity&&
    (selection.trainingIdentity??null)===trainingIdentity&&selection.contextDigest===hashAlgorithmData(context)&&
    selection.publicDigest===state.publicDigest&&selection.payloadHex===payloadHex&&
    Array.isArray(selection.fragments)&&selection.fragments.length>0,
    'coordinator selection is not bound to its original model, state, public cut and exact bytes');
  for(const fragment of selection.fragments){
    demand(fragment&&hex(fragment.payloadHex)&&Array.isArray(fragment.tokenIds)&&fragment.tokenIds.length>0&&
      fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&
      isDeepStrictEqual(fragment.emittedTokenIds,fragment.tokenIds)&&
      typeof fragment.selectedEventId==='string'&&fragment.selectedEventId.length>0&&
      Number.isSafeInteger(fragment.meridian)&&fragment.meridian>=0&&fragment.modelTrack===track&&
      typeof fragment.terminal==='boolean',
      'coordinator fragment lost its original bytes, token ids or native ownership');
  }
  demand(selection.fragments.at(-1).terminal===true&&selection.fragments.slice(0,-1).every(row=>!row.terminal)&&
    selection.fragments.map(row=>row.payloadHex).join('')===payloadHex,
    'coordinator fragments do not reconstruct the exact original terminal selection');
  return {record,selection};
}

function parseAction(record){
  const value=JSON.parse(record);
  demand(value&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===2&&Object.hasOwn(value,'name')&&Object.hasOwn(value,'arguments')&&
    typeof value.name==='string'&&value.arguments&&typeof value.arguments==='object'&&
    !Array.isArray(value.arguments),'committed coordinator record is not one exact lifecycle action');
  return value;
}

function failureOf(error){
  return {category:error?.category??error?.name??'Error',message:String(error?.message??error),
    ...(error?.evidence!==undefined?{evidence:copy(error.evidence)}:{})};
}

export class RegionSelectedOrchestrationDriver {
  #childDriver=null;
  #executionClock=null;
  // timeoutMs aborts host child execution cooperatively. In-flight native RPCs
  // remain bounded by the selector's own request deadline so their ack state
  // is observed before cleanup starts.
  constructor({initialPublic,select,checkpointIdentity,tokenizerIdentity,trainingIdentity=null,seed=17,
      generationSettings,maxActive=1,childBudget=128,maxCoordinatorSelections=128,maxPredictions=4096,
      maxGenerated=16384,maxOutstanding=64,maxStaleRetries=8,timeoutMs=15000,
      automaticDelivery=null,harness=null,harnessOptions={},serviceAdmissionCoordinator=null}={}){
    const ingress=validateIngress(initialPublic);
    demand(serviceAdmissionCoordinator===null||typeof serviceAdmissionCoordinator.ownerSnapshot==='function'&&
      typeof serviceAdmissionCoordinator.assertActive==='function'&&typeof serviceAdmissionCoordinator.terminate==='function'&&
      typeof serviceAdmissionCoordinator.verify==='function',
      'composite service fencing requires its independently owned admission coordinator');
    const serviceAdmission=serviceAdmissionCoordinator===null?null:copy(serviceAdmissionCoordinator.ownerSnapshot());
    if(serviceAdmission!==null)validateServiceAdmissionOwnerSnapshot(serviceAdmission,ingress.session);
    demand(typeof select==='function'&&typeof select.initialize==='function'&&
      typeof select.openOrchestration==='function'&&typeof select.statusOrchestration==='function'&&
      typeof select.selectOrchestration==='function'&&typeof select.commitOrchestration==='function'&&
      typeof select.bootstrapOrchestrationChild==='function'&&typeof select.cancelOrchestration==='function'&&
      typeof select.commit==='function'&&typeof select.complete==='function'&&typeof select.cancel==='function',
      'an attested native V8 selector with coordinator and child acknowledgements is required');
    demand(HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??'')&&
      (trainingIdentity===null||HASH.test(trainingIdentity))&&Number.isSafeInteger(seed)&&seed>=0&&
      generationSettings&&typeof generationSettings==='object'&&!Array.isArray(generationSettings),
      'frozen model identities, seed and generation settings are required');
    demand(positive(maxActive,16)&&positive(childBudget,100000)&&
      positive(maxCoordinatorSelections,10000)&&positive(maxPredictions,100000)&&
      positive(maxGenerated,1000000)&&positive(maxOutstanding,1024)&&
      Number.isSafeInteger(maxStaleRetries)&&maxStaleRetries>=0&&maxStaleRetries<=1000&&
      positive(timeoutMs,300000),'explicit bounded V8 orchestration limits are required');
    demand(harnessOptions&&typeof harnessOptions==='object'&&!Array.isArray(harnessOptions),
      'host execution options must be a record');
    const bridge=harness??RegionExecutionHarness.replay(copy(initialPublic),{...harnessOptions,requireTerminal:false});
    demand(bridge instanceof RegionExecutionHarness&&
      hashAlgorithmData(bridge.exportEpisode())===hashAlgorithmData(initialPublic),
      'host execution harness must represent the exact original public ingress');
    bridge.inner.maxGenerated=maxGenerated;bridge.inner.maxOutstanding=maxOutstanding;
    for(const activation of bridge.invocations.values())activation.controller.maxGenerated=maxGenerated;
    demand(automaticDelivery===null||automaticDelivery===bridge.inner.automaticDelivery,
      'host callback delivery differs from the frozen orchestration policy');
    Object.assign(this,{initialPublic:copy(initialPublic),session:ingress.session,invocations:ingress.invocations.map(row=>copy(row)),
      select,bridge,checkpointIdentity,tokenizerIdentity,trainingIdentity,seed,serviceAdmissionCoordinator,
      generationSettings:copy(generationSettings),maxActive,childBudget,maxCoordinatorSelections,maxPredictions,
      maxGenerated,maxOutstanding,maxStaleRetries,timeoutMs,automaticDelivery:bridge.inner.automaticDelivery,
      ...(serviceAdmission===null?{}:{serviceAdmission:copy(serviceAdmission)})});
    const retainedServiceAdmission=serviceAdmission===null?null:freezeTree(copy(serviceAdmission));
    this.policy=Object.freeze({checkpointIdentity,tokenizerIdentity,trainingIdentity,seed,
      generationSettings:copy(generationSettings),maxActive,childBudget,maxCoordinatorSelections,maxPredictions,
      maxGenerated,maxOutstanding,maxStaleRetries,timeoutMs,automaticDelivery:bridge.inner.automaticDelivery,
      ...(retainedServiceAdmission===null?{}:{serviceAdmission:retainedServiceAdmission})});
    this.coordinatorAttempts=[];this.state=null;this.initialState=null;this.nativeIdentity=null;
    this.continuation={phase:'unopened',coordinatorSelections:0,joinedAttempt:null,joinedDependency:null,elapsedMs:0};
    this.createdDependencies=new Map();this.pausedCheckpoint=null;this.historyReceipt=null;this.automaticHistory=null;this.terminalDisposition=null;this.restored=false;this.running=false;this.used=false;
  }

  checkpoint(){
    demand(this.pausedCheckpoint,'checkpoint is available only after a requested quiescent safe-point pause');
    return copy(this.pausedCheckpoint);
  }
  async checkpointDurableHistory({journal,acknowledge,previous=this.historyReceipt??null}={}){
    demand(this.pausedCheckpoint,'durable history requires a verified quiescent composite checkpoint');
    demand(typeof journal?.append==='function'&&typeof journal?.readAll==='function'&&
      typeof acknowledge==='function','durable history requires the selected history journal and an independent head acknowledgement');
    const prior=previous===null?null:copy(previous);
    if(prior!==null)validateSelectedHistoryReceipt(prior);
    const checkpoint=this.checkpoint();
    const receipt=copy(await journal.append(copy(checkpoint),{previous:copy(prior)}));
    validateSelectedHistoryReceipt(receipt);
    const entries=validateSelectedHistoryChain(copy(await journal.readAll(copy(receipt))),copy(receipt));
    demand(isDeepStrictEqual(entries.at(-1)?.checkpoint,checkpoint)&&
      entries.at(-1)?.position===receipt.position&&isDeepStrictEqual(entries.at(-1)?.previous,prior),
      'durable journal did not retain the exact composite checkpoint and requested predecessor');
    const acknowledged=await acknowledge({receipt:copy(receipt),previous:copy(prior)});
    validateSelectedHistoryReceipt(acknowledged);
    demand(isDeepStrictEqual(acknowledged,receipt),
      'independent durable head acknowledgement differs from the recorded composite checkpoint');
    this.historyReceipt=copy(receipt);return copy(receipt);
  }
  startAutomaticHistory({journal,acknowledge,previous=this.historyReceipt??null,executionClock=null}={}){
    demand(!this.running&&!this.used,'automatic history must be configured before execution starts');
    demand(this.automaticHistory===null,'automatic history is already configured');
    demand(typeof journal?.append==='function'&&typeof journal?.readAll==='function'&&
      typeof acknowledge==='function','automatic history requires a durable journal and independent head acknowledgement');
    const head=previous===null?null:copy(previous);
    if(head!==null)validateSelectedHistoryReceipt(head);
    if(this.historyReceipt!==null)demand(isDeepStrictEqual(head,this.historyReceipt),
      'automatic history must continue the exact already acknowledged composite head');
    if(executionClock!==null){
      assertSelectedOrchestrationExecutionClock(executionClock);
      demand(typeof this.select.durableRequestBoundary==='function'&&this.select.durableRequestBoundary()!==null,
        'clock-bound recovery requires a guarded durable native request journal');
    }
    demand(!this.continuation.clockReceipt||executionClock!==null,
      'retained execution clock must continue with automatic history');
    this.#executionClock=executionClock;
    this.automaticHistory={journal,acknowledge,previous:head,status:'ready',failure:null,executionClock};
    return this;
  }
  static async restore(packet,{initialPublic,select,policy,harnessOptions={},signal=null,serviceAdmissionCoordinator=null,
      executionClock=null}={}){
    packet=copy(packet);initialPublic=copy(initialPublic);policy=copy(policy);harnessOptions={...harnessOptions};
    demand(initialPublic&&typeof select==='function'&&typeof select.restore==='function'&&
      typeof select.checkpoint==='function'&&typeof select.status==='function',
      'external source cut and a fresh checkpoint-capable native selector are required');
    const expectedPolicy={...policy,...(Object.hasOwn(packet.policy??{},'serviceAdmission')?
      {serviceAdmission:copy(packet.policy.serviceAdmission)}:{})};
    verifySelectedOrchestrationCheckpoint(packet,expectedPolicy,{initialPublic});
    if(packet.continuation.clockReceipt){
      assertSelectedOrchestrationExecutionClock(executionClock);
      const consumed=await executionClock.elapsed(packet.continuation.clockReceipt,{timeoutMs:policy.timeoutMs});
      demand(consumed>=packet.continuation.elapsedMs,'live clock predates the retained consumed budget');
    }
    if(packet.policy.serviceAdmission!=null){
      demand(serviceAdmissionCoordinator&&
        isDeepStrictEqual(copy(serviceAdmissionCoordinator.ownerSnapshot()),packet.policy.serviceAdmission),
        'composite restoration requires the exact retained service owner snapshot');
      demand(isDeepStrictEqual(await serviceAdmissionCoordinator.assertActive(),packet.policy.serviceAdmission.policy),
        'composite restoration service owners changed or are terminal');
    }else demand(serviceAdmissionCoordinator===null,
      'unfenced composite checkpoint cannot acquire service admission authority on restore');
    demand(select.status().closed===false&&select.status().pending===0,
      'restore requires a fresh native process selector');
    const bridge=RegionExecutionHarness.restore(copy(packet.bridge),{...harnessOptions,
      maxGenerated:policy.maxGenerated,maxOutstanding:policy.maxOutstanding});
    demand(hashAlgorithmData(bridge.checkpoint())===hashAlgorithmData(packet.bridge),
      'restored host bridge differs from the independently verified cut');
    try{
      const receipt=await select.restore({checkpoint:copy(packet.native)});
      demand(receipt?.restored===true&&receipt.transportCheckpointDigest===packet.native.digest&&
        receipt.hostDispatches===0&&receipt.consumedAttempts===packet.native.native.attempts.length,
        'native restore did not acknowledge the exact checkpoint without host dispatch');
      const state=await select.statusOrchestration({session:packet.session,track:packet.state.track});
      demand(isDeepStrictEqual(state,packet.state),'restored coordinator state differs from the composite cut');
      return await this.#adoptRestoredNative(packet,{select,policy,harnessOptions,serviceAdmissionCoordinator,
        executionClock,bridge,state});
    }catch(error){select.close?.();throw error;}
  }
  static async #adoptRestoredNative(packet,{select,policy,harnessOptions,serviceAdmissionCoordinator,
      executionClock,bridge=null,state=null}){
    bridge??=RegionExecutionHarness.restore(copy(packet.bridge),{...harnessOptions,
      maxGenerated:policy.maxGenerated,maxOutstanding:policy.maxOutstanding});
    demand(hashAlgorithmData(bridge.checkpoint())===hashAlgorithmData(packet.bridge),
      'restored host bridge differs from the independently verified cut');
    state??=await select.statusOrchestration({session:packet.session,track:packet.state.track});
    demand(isDeepStrictEqual(state,packet.state),'restored coordinator state differs from the composite cut');
    const ingressHarness=RegionExecutionHarness.replay(copy(packet.initialPublic),{...harnessOptions,
      requireTerminal:false,automaticDelivery:policy.automaticDelivery});
    const driver=new RegionSelectedOrchestrationDriver({initialPublic:copy(packet.initialPublic),select,
      ...policy,serviceAdmissionCoordinator,automaticDelivery:policy.automaticDelivery,harness:ingressHarness});
    driver.bridge=bridge;driver.state=copy(state);driver.initialState=copy(packet.initialState);
    driver.nativeIdentity=copy(packet.native.identity);driver.continuation=copy(packet.continuation);
    driver.coordinatorAttempts=copy(packet.coordinatorAttempts);driver.restored=true;
    for(const attempt of driver.coordinatorAttempts)if(attempt.action?.name==='track_create'){
      const dependency=attempt.commitReceipt?.completion_dependency;
      demand(dependency,'restored create has no exact dependency receipt');
      driver.createdDependencies.set(dependency.track,copy(dependency));
    }
    driver.#childDriver=await restoreSelectedOrchestrationChildDriver({packet,policy,
      initialPublic:driver.initialPublic,bridge,select,childSelect:childSelector(select)});
    if(packet.continuation.clockReceipt){
      assertSelectedOrchestrationExecutionClock(executionClock);driver.#executionClock=executionClock;
      const consumed=await executionClock.elapsed(packet.continuation.clockReceipt,{timeoutMs:policy.timeoutMs});
      demand(consumed>=packet.continuation.elapsedMs,'live clock predates the retained consumed budget');
      driver.continuation.elapsedMs=consumed;
    }
    return driver;
  }
  static async restoreLatest(packet,{historyJournal,historyReceipt,initialPublic,select,policy,harnessOptions={},signal=null,
      serviceAdmissionCoordinator=null,acknowledge=null,executionClock=null,commitRecovery=null,bootstrapRecovery=null,
      closeRecovery=null}={}){
    const checkAbort=()=>{if(signal?.aborted)throw signal.reason instanceof Error?
      signal.reason:new Error(String(signal.reason??'Selected orchestration v8 restore cancelled'));};
    checkAbort();
    packet=copy(packet);historyReceipt=copy(historyReceipt);initialPublic=copy(initialPublic);
    policy=copy(policy);harnessOptions={...harnessOptions};
    commitRecovery=copy(commitRecovery);
    bootstrapRecovery=copy(bootstrapRecovery);
    closeRecovery=copy(closeRecovery);
    demand(commitRecovery===null||commitRecovery&&Object.keys(commitRecovery).length===1&&
      Object.hasOwn(commitRecovery,'receipt'),'commit recovery must name one exact retained request receipt');
    demand(bootstrapRecovery===null||bootstrapRecovery&&Object.keys(bootstrapRecovery).length===1&&
      Object.hasOwn(bootstrapRecovery,'receipt'),'bootstrap recovery must name one exact retained request receipt');
    demand(closeRecovery===null||closeRecovery&&Object.keys(closeRecovery).length===1&&
      Object.hasOwn(closeRecovery,'receipt'),'close recovery must name one exact retained request receipt');
    demand([commitRecovery,bootstrapRecovery,closeRecovery].filter(value=>value!==null).length<=1,
      'one exact native recovery operation is required');
    demand(typeof historyJournal?.readLatest==='function','independently verified latest composite history is required');
    validateSelectedHistoryReceipt(historyReceipt);
    const retainedEntries=copy(await historyJournal.readLatest(copy(historyReceipt)));
    checkAbort();
    const entries=validateSelectedHistoryChain(retainedEntries,copy(historyReceipt));
    demand(entries.some(entry=>isDeepStrictEqual(entry.checkpoint,packet)),
      'supplied composite checkpoint is absent from the independently acknowledged history');
    for(const entry of entries){
      const expectedPolicy={...policy,...(Object.hasOwn(entry.checkpoint.policy,'serviceAdmission')?
        {serviceAdmission:copy(entry.checkpoint.policy.serviceAdmission)}:{})};
      demand(entries.every(row=>isDeepStrictEqual(row.checkpoint.policy.serviceAdmission,
        entry.checkpoint.policy.serviceAdmission)),'service admission owner snapshot changed within composite history');
      verifySelectedOrchestrationCheckpoint(entry.checkpoint,expectedPolicy,{initialPublic});
    }
    const latestEntry=entries.at(-1);
    if(closeRecovery!==null){
      const terminal=latestEntry.terminal,snapshot=terminal?.snapshot;
      const ownerSnapshot=terminal?.ownerSnapshot??null;
      demand(terminal?.schema==='semantic-selected-orchestration-terminal-event/8'&&terminal.closeBoundary&&
        ['requested','completed','cancelled'].includes(terminal.phase)&&
        typeof acknowledge==='function'&&
        typeof historyJournal.append==='function'&&typeof select?.recoverClose==='function'&&
        typeof select.checkpoint==='function'&&select.status?.().closed===false&&select.status().pending===0,
        'known terminal close requires its exact latest acknowledged intent and a fresh guarded selector');
      demand(ownerSnapshot===null?serviceAdmissionCoordinator===null:Boolean(serviceAdmissionCoordinator)&&
        isDeepStrictEqual(copy(serviceAdmissionCoordinator.ownerSnapshot()),ownerSnapshot),
        'known terminal close requires the exact retained service owner snapshot');
      const closePolicy={...policy,...(ownerSnapshot===null?{}:{serviceAdmission:copy(ownerSnapshot)})};
      assertSelectedOrchestrationExecutionClock(executionClock);
      const beforeElapsed=await executionClock.elapsed(snapshot.continuation.clockReceipt,{timeoutMs:policy.timeoutMs});
      demand(beforeElapsed>=Math.max(snapshot.continuation.elapsedMs,terminal.closeElapsedMs??0),
        'terminal recovery clock predates its retained consumed budget');
      const boundary=terminal.closeBoundary;
      demand(['ordinal','sessionId','streamId','sessionGeneration'].every(key=>closeRecovery.receipt?.[key]===boundary[key])&&
        (terminal.phase==='requested'||isDeepStrictEqual(closeRecovery.receipt,terminal.closeRequestReceipt)),
        'close recovery receipt differs from the exact acknowledged terminal boundary');
      checkAbort();
      try{
        let serviceAdmission=null;
        if(ownerSnapshot!==null){
          if(terminal.phase==='requested'){
            serviceAdmission=copy(await serviceAdmissionCoordinator.terminate({
              sessionId:terminal.session,reason:terminal.reason}));
            const verified=copy(await serviceAdmissionCoordinator.verify(copy(serviceAdmission)));
            demand(isDeepStrictEqual(verified,serviceAdmission),
              'same-owner terminal close fence differs from independent service journal reads');
          }else{
            serviceAdmission=copy(terminal.serviceAdmission);
            const verified=copy(await serviceAdmissionCoordinator.verify(copy(serviceAdmission)));
            demand(isDeepStrictEqual(verified,serviceAdmission),
              'retained terminal close fence differs from independent service journal reads');
          }
          checkAbort();
        }
        const serviceElapsed=await executionClock.elapsed(snapshot.continuation.clockReceipt,
          {timeoutMs:policy.timeoutMs});
        demand(serviceElapsed>=Math.max(snapshot.continuation.elapsedMs,terminal.closeElapsedMs??0),
          'terminal close service verification refunded its retained clock');
        checkAbort();
        const beforeClose=validateSelectedHistoryChain(
          copy(await historyJournal.readLatest(copy(historyReceipt))),copy(historyReceipt));
        demand(isDeepStrictEqual(beforeClose,entries),
          'acknowledged terminal history changed during service verification');
        const beforeCloseElapsed=await executionClock.elapsed(snapshot.continuation.clockReceipt,
          {timeoutMs:policy.timeoutMs});
        demand(beforeCloseElapsed>=Math.max(snapshot.continuation.elapsedMs,terminal.closeElapsedMs??0),
          'terminal close history verification refunded its retained clock');
        checkAbort();
        const recovered=copy(await select.recoverClose({receipt:closeRecovery.receipt,
          accountingCheckpoint:terminal.phase!=='requested'?terminal.closedNative:null}));
        checkAbort();
        const native=copy(await select.checkpoint()),elapsedMs=await executionClock.elapsed(
          snapshot.continuation.clockReceipt,{timeoutMs:policy.timeoutMs});
        const finalTerminal=buildRecoveredTerminalCloseV8({checkpoint:latestEntry.checkpoint,terminal,recovery:recovered,
          native,elapsedMs,policy:closePolicy,initialPublic,serviceAdmission});
        const stillLatest=validateSelectedHistoryChain(copy(await historyJournal.readLatest(copy(historyReceipt))),historyReceipt);
        demand(isDeepStrictEqual(stillLatest,entries),'acknowledged terminal history changed during native recovery');
        checkAbort();
        const previous=copy(historyReceipt),receipt=copy(await historyJournal.append(copy(latestEntry.checkpoint),
          {previous,terminal:copy(finalTerminal)}));
        validateSelectedHistoryReceipt(receipt);
        const recorded=validateSelectedHistoryChain(copy(await historyJournal.readLatest(copy(receipt))),receipt),tail=recorded.at(-1);
        demand(isDeepStrictEqual(tail?.terminal,finalTerminal)&&isDeepStrictEqual(tail?.previous,previous)&&
          isDeepStrictEqual(tail?.checkpoint,latestEntry.checkpoint),
          'terminal recovery journal retained a different closed application outcome');
        const acknowledged=copy(await acknowledge({receipt:copy(receipt),previous:copy(previous)}));
        validateSelectedHistoryReceipt(acknowledged);
        demand(isDeepStrictEqual(acknowledged,receipt),'terminal recovery head acknowledgement differs');
        checkAbort();
        return {schema:'semantic-selected-orchestration-disposition/8',status:finalTerminal.phase,resumable:false,
          session:terminal.session,terminalId:terminal.terminalId,historyReceipt:receipt,snapshotDigest:terminal.snapshotDigest,
          closeReceipt:copy(finalTerminal.closeReceipt),initialPublic:copy(snapshot.initialPublic),
          public:copy(snapshot.bridge.public),publicCompleted:finalTerminal.phase==='completed',
          ...(ownerSnapshot===null?{}:{ownerSnapshot:copy(ownerSnapshot),serviceAdmission:copy(serviceAdmission)}),
          completionReceipts:copy(snapshot.state.children.map(row=>row.completion)),
          nativeIdentity:copy(snapshot.native.identity),sourceValidated:false,
          qualification:{modelMeasurement:'actual-model-selected',sourceCorrespondence:'not-checked-by-public-replay',
            defaultPromotion:false}};
      }catch(error){select.close?.();throw error;}
    }
    if(commitRecovery!==null)demand(!latestEntry.terminal&&
      (latestEntry.pending?.kind==='coordinator-selection'&&latestEntry.pending.clockReceipt&&latestEntry.pending.requestBoundary||
        !latestEntry.pending&&latestEntry.checkpoint.continuation.clockReceipt&&
        (['track_join','track_progress'].includes(latestEntry.checkpoint.coordinatorAttempts.at(-1)?.action?.name)||
          latestEntry.checkpoint.coordinatorAttempts.at(-1)?.action?.name==='track_create'&&
          latestEntry.checkpoint.continuation.phase==='bootstrap-ready')&&
        latestEntry.checkpoint.native.attempts.at(-1)?.durableRequestReceipt),
      'known commit recovery requires its clock-bound coordinator fence or exact sealed acknowledgement');
    if(bootstrapRecovery!==null)demand(!latestEntry.terminal&&
      (latestEntry.pending?.kind==='child-bootstrap'&&latestEntry.pending.clockReceipt&&latestEntry.pending.requestBoundary||
        !latestEntry.pending&&latestEntry.checkpoint.continuation.clockReceipt&&
        latestEntry.checkpoint.continuation.phase==='coordinator-ready'&&
        latestEntry.checkpoint.coordinatorAttempts.at(-1)?.action?.name==='track_create'&&
        latestEntry.checkpoint.native.attempts.at(-1)?.durableBootstrap),
      'known bootstrap recovery requires its clock-bound child-bootstrap fence or exact sealed acknowledgement');
    if(latestEntry.terminal?.schema==='semantic-selected-orchestration-terminal-event/8'){
      let terminal=latestEntry.terminal,snapshot=terminal.snapshot,closedOnThisSelector=false;
      demand(!terminal.closeBoundary,'durable terminal history requires explicit exact close recovery');
      if(terminal.phase==='requested'){
        demand(typeof acknowledge==='function'&&serviceAdmissionCoordinator&&
          isDeepStrictEqual(copy(serviceAdmissionCoordinator.ownerSnapshot()),terminal.ownerSnapshot),
          'cancellation reconciliation requires the exact retained service owner snapshot and head acknowledger');
        checkAbort();
        const serviceFence=copy(await serviceAdmissionCoordinator.terminate({
          sessionId:terminal.session,reason:terminal.reason}));
        const verifiedFence=copy(await serviceAdmissionCoordinator.verify(copy(serviceFence)));
        demand(isDeepStrictEqual(verifiedFence,serviceFence),'service terminal fence differs from independent journal reads');
        checkAbort();
        demand(typeof select==='function'&&typeof select.restore==='function'&&
          typeof select.status==='function'&&select.status().closed===false&&select.status().pending===0,
          'cancellation reconciliation requires a fresh native process selector');
        const restored=copy(await select.restore({checkpoint:copy(snapshot.native)}));
        checkAbort();
        demand(restored?.schema==='semantic-model-restore/8'&&restored.restored===true&&
          restored.restoredSessions===1&&restored.consumedAttempts===snapshot.native.native.attempts.length&&
          restored.hostDispatches===0&&restored.equivalence==='verified-model-reexecution'&&
          restored.transportCheckpointDigest===snapshot.native.digest,
          'cancelled native snapshot did not reexecute without host dispatch');
        const current=copy(await select.statusOrchestration({session:terminal.session,track:snapshot.state.track}));
        checkAbort();
        demand(isDeepStrictEqual(current,snapshot.state)&&current.status===snapshot.state.status&&
          ['completed','cancelled'].includes(current.status)&&current.pendingSelection===null,
          'restored orchestration state is not the exact committed cancellation intent');
        const closeReceipt=copy(await select.cancel({session:terminal.session,reason:terminal.reason}));
        demand(closeReceipt?.schema==='semantic-native-close/8'&&closeReceipt.closed===true&&
          closeReceipt.session===terminal.session&&closeReceipt.reason===terminal.reason,
          'native selector did not acknowledge the exact cancellation reason');
        const closedNative=copy(await select.checkpoint());
        const finalPhase=snapshot.state.status==='completed'?'completed':'cancelled';
        const unsigned={schema:'semantic-selected-orchestration-terminal-event/8',
          terminalId:terminal.terminalId,phase:finalPhase,session:terminal.session,
          baseCheckpointDigest:terminal.baseCheckpointDigest,pendingId:terminal.pendingId,
          snapshot:copy(terminal.snapshot),snapshotDigest:terminal.snapshotDigest,reason:terminal.reason,
          ownerSnapshot:copy(terminal.ownerSnapshot),serviceAdmission:copy(serviceFence),
          closeReceipt,closedNativeDigest:hashAlgorithmData(closedNative),closedNative},
          finalTerminal={...unsigned,digest:hashAlgorithmData(unsigned)};
        const previous=copy(historyReceipt),receipt=copy(await historyJournal.append(
          copy(latestEntry.checkpoint),{previous:copy(previous),terminal:copy(finalTerminal)}));
        validateSelectedHistoryReceipt(receipt);
        const recorded=validateSelectedHistoryChain(copy(await historyJournal.readAll(copy(receipt))),copy(receipt)),
          tail=recorded.at(-1);
        demand(isDeepStrictEqual(tail?.terminal,finalTerminal)&&isDeepStrictEqual(tail?.checkpoint,latestEntry.checkpoint)&&
          isDeepStrictEqual(tail?.previous,previous),
          'reconciled cancellation history retained different terminal evidence');
        const acknowledged=copy(await acknowledge({receipt:copy(receipt),previous:copy(previous)}));
        validateSelectedHistoryReceipt(acknowledged);
        demand(isDeepStrictEqual(acknowledged,receipt),'reconciled cancellation head acknowledgement differs');
        terminal=finalTerminal;historyReceipt=receipt;snapshot=terminal.snapshot;closedOnThisSelector=true;
      }
      if(terminal.phase==='cancelled'){
        demand(serviceAdmissionCoordinator&&
          isDeepStrictEqual(copy(serviceAdmissionCoordinator.ownerSnapshot()),terminal.ownerSnapshot),
          'cancelled disposition requires its exact retained service owners');
        const verifiedFence=copy(await serviceAdmissionCoordinator.verify(copy(terminal.serviceAdmission)));
        demand(isDeepStrictEqual(verifiedFence,terminal.serviceAdmission),
          'cancelled disposition service fence differs from independent journal reads');
        checkAbort();
      }else if(terminal.phase==='completed'){
        if(terminal.ownerSnapshot){
          demand(serviceAdmissionCoordinator&&
            isDeepStrictEqual(copy(serviceAdmissionCoordinator.ownerSnapshot()),terminal.ownerSnapshot),
            'completed disposition service owners changed');
          const verifiedFence=copy(await serviceAdmissionCoordinator.verify(copy(terminal.serviceAdmission)));
          demand(isDeepStrictEqual(verifiedFence,terminal.serviceAdmission),
            'completed disposition service fence differs from independent journal reads');
          checkAbort();
        }else demand(serviceAdmissionCoordinator===null,
          'unfenced completed history cannot acquire service authority during recovery');
      }
      checkAbort();
      demand(typeof select==='function'&&typeof select.restore==='function'&&
        typeof select.status==='function'&&select.status().closed===false&&select.status().pending===0,
        'terminal verification requires a fresh native process selector');
      if(!closedOnThisSelector){
        const closedRestore=copy(await select.restore({checkpoint:copy(terminal.closedNative)}));
        checkAbort();
        const {digest:closedTransportDigest,...closedTransportBody}=terminal.closedNative;
        demand(closedRestore?.schema==='semantic-model-restore/8'&&closedRestore.restored===true&&
          closedRestore.restoredSessions===0&&closedRestore.consumedAttempts===terminal.closedNative.native.attempts.length&&
          closedRestore.hostDispatches===0&&closedRestore.equivalence==='verified-model-reexecution'&&
          closedRestore.transportCheckpointDigest===closedTransportDigest&&
          closedTransportDigest===hashAlgorithmData(closedTransportBody),
          'native closed-session tombstone did not reexecute without restoring active sessions');
      }
      return {schema:'semantic-selected-orchestration-disposition/8',status:terminal.phase,
        resumable:false,session:terminal.session,terminalId:terminal.terminalId,
        historyReceipt:copy(historyReceipt),snapshotDigest:terminal.snapshotDigest,
        closeReceipt:copy(terminal.closeReceipt),initialPublic:copy(snapshot.initialPublic),
        public:copy(snapshot.bridge.public),publicCompleted:terminal.phase==='completed',
        completionReceipts:copy(snapshot.state.children.map(row=>row.completion)),
        nativeIdentity:copy(snapshot.native.identity),sourceValidated:false,
        qualification:{modelMeasurement:'actual-model-selected',sourceCorrespondence:'not-checked-by-public-replay',
          defaultPromotion:false}};
    }
    const latest=latestEntry.checkpoint;
    demand(!latestEntry.terminal,'terminal orchestration disposition cannot be restored as active work');
    if(commitRecovery!==null||bootstrapRecovery!==null){
      const unresolved=Boolean(latestEntry.pending),bootstrap=bootstrapRecovery!==null,
        recover=bootstrap?select?.recoverBootstrapChild:select?.recoverCommit;
      demand(typeof acknowledge==='function'&&typeof historyJournal.append==='function'&&
        typeof recover==='function'&&typeof select?.durableRequestBoundary==='function',
        'known commit recovery requires exact native restoration and independent new-head acknowledgement');
      assertSelectedOrchestrationExecutionClock(executionClock);
      const boundary=unresolved?latestEntry.pending.requestBoundary:bootstrap?
          latest.native.attempts.at(-1).durableBootstrap.receipt:latest.native.attempts.at(-1).durableRequestReceipt,
        clockReceipt=unresolved?latestEntry.pending.clockReceipt:latest.continuation.clockReceipt,
        receipt=(bootstrap?bootstrapRecovery:commitRecovery).receipt,
        liveBoundary=select.durableRequestBoundary();
      demand(receipt&&['sessionId','streamId','sessionGeneration','ordinal'].every(key=>receipt[key]===boundary[key])&&
        liveBoundary&&['sessionId','streamId','sessionGeneration'].every(key=>liveBoundary[key]===boundary[key]),
        'known commit receipt or live owner differs from the retained request scope');
      await executionClock.elapsed(clockReceipt,{timeoutMs:policy.timeoutMs});
      checkAbort();
      if(latest.policy.serviceAdmission!=null){
        demand(serviceAdmissionCoordinator&&
          isDeepStrictEqual(copy(serviceAdmissionCoordinator.ownerSnapshot()),latest.policy.serviceAdmission),
          'known commit recovery requires the retained service owner snapshot');
        demand(isDeepStrictEqual(await serviceAdmissionCoordinator.assertActive(),latest.policy.serviceAdmission.policy),
          'known commit recovery service owners changed or are terminal');
      }else demand(serviceAdmissionCoordinator===null,'unfenced history cannot acquire service authority during recovery');
      try{
        const recovered=copy(await recover.call(select,{receipt:copy(receipt),
          ...(unresolved?{}:{accountingCheckpoint:copy(latest.native)})}));checkAbort();
        demand(isDeepStrictEqual(recovered.receipt,receipt),'recovered native request receipt changed');
        const state=copy(await select.statusOrchestration({session:latest.session,track:latest.state.track})),
          native=copy(await select.checkpoint()),
          elapsedMs=await executionClock.elapsed(clockReceipt,{timeoutMs:policy.timeoutMs});
        const expectedPolicy={...policy,...(Object.hasOwn(latest.policy,'serviceAdmission')?
          {serviceAdmission:copy(latest.policy.serviceAdmission)}:{})};
        const builder=bootstrap?(unresolved?buildRecoveredBootstrapCheckpointV8:refreshRecoveredBootstrapCheckpointV8):
          (unresolved?buildRecoveredCoordinatorCheckpointV8:refreshRecoveredCoordinatorCheckpointV8);
        const reconciled=builder({
          checkpoint:latest,pending:latestEntry.pending,recovery:recovered,native,state,elapsedMs,
          policy:expectedPolicy,initialPublic});
        checkAbort();
        const stillLatest=validateSelectedHistoryChain(copy(await historyJournal.readLatest(copy(historyReceipt))),historyReceipt);
        demand(isDeepStrictEqual(stillLatest.at(-1),latestEntry),'latest coordinator fence changed during native recovery');
        const previous=copy(historyReceipt),nextReceipt=copy(await historyJournal.append(copy(reconciled),{previous}));
        validateSelectedHistoryReceipt(nextReceipt);
        const recorded=validateSelectedHistoryChain(copy(await historyJournal.readLatest(copy(nextReceipt))),nextReceipt),tail=recorded.at(-1);
        demand(isDeepStrictEqual(tail?.checkpoint,reconciled)&&isDeepStrictEqual(tail?.previous,previous)&&
          !Object.hasOwn(tail??{},'pending')&&!Object.hasOwn(tail??{},'terminal'),
          'reconciled history differs from the exact recovered safe cut');
        const acknowledged=copy(await acknowledge({receipt:copy(nextReceipt),previous:copy(previous)}));
        validateSelectedHistoryReceipt(acknowledged);
        demand(isDeepStrictEqual(acknowledged,nextReceipt),'reconciled history head acknowledgement differs');
        checkAbort();
        const restored=await this.#adoptRestoredNative(reconciled,{select,policy,harnessOptions,
          serviceAdmissionCoordinator,executionClock,state});
        checkAbort();
        restored.historyReceipt=copy(nextReceipt);
        restored.startAutomaticHistory({journal:historyJournal,acknowledge,previous:nextReceipt,executionClock});
        return restored;
      }catch(error){select.close?.();throw error;}
    }
    demand(!latestEntry.pending,'latest composite history head has unresolved in-flight work and cannot be replayed');
    if(latest.policy.serviceAdmission!=null){
      demand(serviceAdmissionCoordinator&&
        isDeepStrictEqual(copy(serviceAdmissionCoordinator.ownerSnapshot()),latest.policy.serviceAdmission),
        'active composite recovery requires the exact retained service owner snapshot');
      checkAbort();
      demand(isDeepStrictEqual(await serviceAdmissionCoordinator.assertActive(),latest.policy.serviceAdmission.policy),
        'active composite recovery service owners changed or are terminal');
      checkAbort();
    }else demand(serviceAdmissionCoordinator===null,
      'unfenced composite history cannot acquire service admission authority during recovery');
    const restored=await this.restore(latest,{initialPublic,select,policy,harnessOptions,signal,serviceAdmissionCoordinator,
      executionClock});
    restored.historyReceipt=copy(historyReceipt);return restored;
  }

  async run({signal=null,stopAt=null}={}){
    demand(!this.running&&!this.used,'coordinator driver is one-shot and cannot be reopened');
    demand(this.serviceAdmissionCoordinator===null||this.automaticHistory!==null,
      'service-aware orchestration requires independently acknowledged durable history');
    demand(stopAt===null||stopAt&&typeof stopAt==='object'&&!Array.isArray(stopAt)&&
      Object.keys(stopAt).length===2&&['phase','coordinatorSelections'].every(key=>Object.hasOwn(stopAt,key))&&
      ['coordinator-ready','bootstrap-ready','child-ready'].includes(stopAt.phase)&&
      Number.isSafeInteger(stopAt.coordinatorSelections)&&stopAt.coordinatorSelections>=0,
      'checkpoint stop point must name an explicit safe continuation phase and selection count');
    stopAt=stopAt===null?null:copy(stopAt);
    this.running=true;this.used=true;
    let started=process.hrtime.bigint(),baseElapsed=this.continuation.elapsedMs;
    const abort=new AbortController(),coordinatorAttempts=this.coordinatorAttempts;
    let nativeIdentity=null,initialState=null,state=null,failure=null,cleanupFailure=null,
      closeReceipt=null,cancelReceipt=null,terminalReason=null,terminalCheckpoint=null,cancellationIntent=null,
      cancellationServiceAdmission=null,serviceTerminalVerified=false,durableCloseRequired=false,
      deadlineExceeded=false,opened=false,paused=false;
    let timer=null;
    const onExternalAbort=()=>abort.abort(signal.reason??new Error('Selected orchestration v8 cancelled'));
    const checkAbort=()=>{if(abort.signal.aborted)throw abort.signal.reason instanceof Error?
      abort.signal.reason:new Error(String(abort.signal.reason??'Selected orchestration v8 cancelled'));};
    const elapsed=()=>baseElapsed+Number(process.hrtime.bigint()-started)/1_000_000;
    const readState=async()=>{
      state=await this.select.statusOrchestration({session:this.session,track:state.track});
      this.state=copy(state);return state;
    };
    const rootById=new Map(this.invocations.map(row=>[row.fields.invocationId,row]));
    const runJoinedChild=async dependency=>{
      const child=state.children.find(row=>row.track===dependency.track&&
        row.execution.invocation_id===dependency.invocation);
      demand(child&&this.createdDependencies.has(child.track)&&
        isDeepStrictEqual(this.createdDependencies.get(child.track),dependency),
        'join must name the exact dependency returned for this coordinator child');
      const track=state.tracks.find(row=>row.address===child.track);
      demand(track?.status==='active'&&track.bootstrap_ready===true,
        'native join did not make its exact bootstrapped child runnable');
      demand(rootById.has(child.execution.invocation_id),
        'native coordinator selected an undeclared root invocation');
      const outcome=await this.#childDriver.runInvocation(child.execution.invocation_id,{signal:abort.signal});
      const completed=outcome.taskCompletion?await outcome.taskCompletion:outcome;
      checkAbort();
      while(this.#childDriver.running.size){
        await Promise.allSettled([...this.#childDriver.running.values()].map(row=>row.task));
        await new Promise(resolve=>queueMicrotask(resolve));
      }
      demand(this.#childDriver.running.size===0,'child execution must settle before composite recovery');
      const after=await readState(),saved=after.children.find(row=>row.track===child.track),
        receipt=saved?.completion;
      demand(receipt?.schema==='semantic-child-completion/8'&&receipt.session===this.session&&
        receipt.invocationId===child.execution.invocation_id&&receipt.track===child.track&&
        receipt.publicDigest===hashAlgorithmData(this.bridge.exportEpisode())&&
        receipt.contextsDigest===hashAlgorithmData(this.#childDriver.contexts)&&
        ['return','throw'].includes(receipt.completion?.kind)&&Object.hasOwn(receipt.completion,'value')&&
        isDeepStrictEqual(receipt.completion,completed.completion),
        'native complete did not retain this exact child result and public/context cut');
      demand(after.status==='active','native completion did not resume the joined coordinator');
      return {invocationId:child.execution.invocation_id,track:child.track,
        completion:copy(receipt),outcome:copy(completed)};
    };
    const captureCheckpoint=async({allowTerminal=false,allowCancelled=false}={})=>{
      demand(allowTerminal?state?.status==='completed':allowCancelled?state?.status==='cancelled':
        (this.continuation.phase!=='unopened'&&state?.status==='active')||
        (this.continuation.phase==='child-ready'&&state?.status==='waiting'),
        'only an active safe coordinator, acknowledged waiting child or proved completion can be checkpointed');
      demand(this.#childDriver?.running.size===0,'a running child cannot be checkpointed');
      if(allowCancelled)demand([...this.bridge.invocations.values()].every(row=>row.status==='completed'),
        'cancelled terminal cut requires every host invocation to be already settled');
      const transportStatus=this.select.status?.();
      demand(transportStatus?.closed===false&&transportStatus.pending===0,
        'in-flight native acknowledgements cannot be checkpointed');
      state=await readState();
      const bridge=this.bridge.checkpoint(),native=await this.select.checkpoint(),
        elapsedMs=elapsed();
      demand(elapsedMs<this.timeoutMs,'cooperative orchestration deadline expired before checkpoint');
      this.continuation={...this.continuation,elapsedMs};
      const body={schema:'semantic-selected-orchestration-checkpoint/8',policy:copy(this.policy),session:this.session,
          initialPublic:copy(this.initialPublic),initialState:copy(initialState),state:copy(state),bridge,
          contexts:copy(this.#childDriver.contexts),coordinatorAttempts:copy(coordinatorAttempts),
          childAttempts:copy(this.#childDriver.attempts),childRejections:copy(this.#childDriver.rejections),
          staleRetries:this.#childDriver.metrics().staleRetries,continuation:copy(this.continuation),native};
      const packet={...body,digest:hashAlgorithmData(body)};
      verifySelectedOrchestrationCheckpoint(packet,this.policy,{initialPublic:this.initialPublic,allowTerminal,allowCancelled});
      return packet;
    };
    const pendingMarker=(checkpoint,kind,details)=>{
      const body={schema:'semantic-selected-orchestration-pending/8',kind,session:this.session,
        checkpointDigest:checkpoint.digest,...copy(details)};
      return {...body,id:hashAlgorithmData(body)};
    };
    const persistAutomaticCheckpoint=async(checkpoint,pending=null)=>{
      const history=this.automaticHistory;
      if(history===null)return null;
      demand(history.status==='ready','automatic history head acknowledgement is uncertain');
      history.status='saving';
      try{
        const previous=copy(history.previous),saved=copy(checkpoint);
        const receipt=copy(await history.journal.append(saved,{previous:copy(previous),
          ...(pending===null?{}:{pending:copy(pending)})}));
        validateSelectedHistoryReceipt(receipt);
        const entries=validateSelectedHistoryChain(copy(await history.journal.readAll(copy(receipt))),copy(receipt)),
          latest=entries.at(-1);
        demand(isDeepStrictEqual(latest?.checkpoint,saved)&&isDeepStrictEqual(latest?.previous,previous)&&
          (pending===null?!Object.hasOwn(latest??{},'pending'):
            Object.hasOwn(latest??{},'pending')&&isDeepStrictEqual(latest.pending,pending)),
          'automatic history journal retained a different checkpoint, predecessor or pending fence');
        const acknowledged=copy(await history.acknowledge({receipt:copy(receipt),previous:copy(previous)}));
        validateSelectedHistoryReceipt(acknowledged);
        demand(isDeepStrictEqual(acknowledged,receipt),
          'automatic history head acknowledgement differs from the recorded checkpoint');
        history.previous=copy(receipt);history.status='ready';this.historyReceipt=copy(receipt);
        return copy(receipt);
      }catch(error){this.pausedCheckpoint=null;history.status='failed';history.failure=error;throw error;}
    };
    const persistCompletedTerminal=async(snapshot,closeReceipt,closedNative)=>{
      const history=this.automaticHistory;
      demand(history!==null&&history.status==='ready',
        'completed terminal disposition requires an acknowledged active history head');
      history.status='saving';
      try{
        demand(closeReceipt?.schema==='semantic-native-close/8'&&closeReceipt.closed===true&&
          closeReceipt.session===this.session&&closeReceipt.reason==='Selected orchestration v8 completed',
          'completed terminal disposition requires the exact positive native close receipt');
        const previous=copy(history.previous);
        validateSelectedHistoryReceipt(previous);
        const entries=validateSelectedHistoryChain(copy(await history.journal.readAll(copy(previous))),copy(previous)),
          tail=entries.at(-1),base=copy(tail?.checkpoint),pending=tail?.pending,saved=copy(snapshot);
        demand(base&&pending?.kind==='coordinator-selection'&&
          pending.checkpointDigest===base.digest&&pending.attempt===base.coordinatorAttempts.length,
          'completed terminal disposition has no exact pending completion selection');
        const snapshotDigest=hashAlgorithmData(saved),identity={schema:'semantic-selected-orchestration-terminal-event/8',
          phase:'completed',session:this.session,baseCheckpointDigest:base.digest,pendingId:pending.id,
          snapshotDigest,closeReceipt:copy(closeReceipt),closedNativeDigest:hashAlgorithmData(closedNative)},terminalId=hashAlgorithmData(identity),
          unsigned={...identity,terminalId,snapshot:saved,closedNative:copy(closedNative)},
          terminal={...unsigned,digest:hashAlgorithmData(unsigned)};
        const receipt=copy(await history.journal.append(base,{previous:copy(previous),terminal:copy(terminal)}));
        validateSelectedHistoryReceipt(receipt);
        const recorded=validateSelectedHistoryChain(copy(await history.journal.readAll(copy(receipt))),copy(receipt)),
          latest=recorded.at(-1);
        demand(isDeepStrictEqual(latest?.checkpoint,base)&&isDeepStrictEqual(latest?.previous,previous)&&
          isDeepStrictEqual(latest?.terminal,terminal)&&!Object.hasOwn(latest??{},'pending'),
          'terminal history journal retained a different base cut or close disposition');
        const acknowledged=copy(await history.acknowledge({receipt:copy(receipt),previous:copy(previous)}));
        validateSelectedHistoryReceipt(acknowledged);
        demand(isDeepStrictEqual(acknowledged,receipt),
          'independent terminal history acknowledgement differs from the recorded disposition');
        history.previous=copy(receipt);history.status='ready';this.historyReceipt=copy(receipt);
        this.terminalDisposition=copy(terminal);return copy(receipt);
      }catch(error){history.status='failed';history.failure=error;throw error;}
    };
    const persistServiceTerminalIntent=async(snapshot,reason,{closeBoundary=null}={})=>{
      const history=this.automaticHistory,ownerSnapshot=this.policy.serviceAdmission??null;
      demand(history!==null&&history.status==='ready'&&(closeBoundary!==null?
        this.#executionClock!==null&&typeof this.select.closeTerminal==='function'&&
          typeof this.select.durableRequestBoundary==='function'&&
          (ownerSnapshot===null?this.serviceAdmissionCoordinator===null:Boolean(this.serviceAdmissionCoordinator)):
        ownerSnapshot!==null&&this.serviceAdmissionCoordinator),
        'terminal intent requires acknowledged history and exact native or service close authority');
      history.status='saving';
      try{
        const previous=copy(history.previous);
        validateSelectedHistoryReceipt(previous);
        const entries=validateSelectedHistoryChain(copy(await history.journal.readAll(copy(previous))),copy(previous)),
          tail=entries.at(-1),base=copy(tail?.checkpoint),pending=tail?.pending,saved=copy(snapshot);
        demand(base&&pending?.kind==='coordinator-selection'&&pending.checkpointDigest===base.digest&&
          pending.attempt===base.coordinatorAttempts.length,'cancelled terminal intent lacks its exact selection fence');
        const snapshotDigest=hashAlgorithmData(saved),reasonCopy=String(reason),identity={schema:
          'semantic-selected-orchestration-terminal-event/8',phase:'requested',session:this.session,
          baseCheckpointDigest:base.digest,pendingId:pending.id,snapshotDigest,reason:reasonCopy,
          ownerSnapshotDigest:hashAlgorithmData(ownerSnapshot),...(closeBoundary!==null?
            {closeBoundary:copy(closeBoundary)}:{})},terminalId=hashAlgorithmData(identity),
          unsigned={...identity,terminalId,snapshot:saved,ownerSnapshot:copy(ownerSnapshot)},
          terminal={...unsigned,digest:hashAlgorithmData(unsigned)};
        const receipt=copy(await history.journal.append(base,{previous:copy(previous),terminal:copy(terminal)}));
        validateSelectedHistoryReceipt(receipt);
        const recorded=validateSelectedHistoryChain(copy(await history.journal.readAll(copy(receipt))),copy(receipt)),
          latest=recorded.at(-1);
        demand(isDeepStrictEqual(latest?.checkpoint,base)&&isDeepStrictEqual(latest?.previous,previous)&&
          isDeepStrictEqual(latest?.terminal,terminal)&&!Object.hasOwn(latest??{},'pending'),
          'cancellation intent journal retained a different base or owner binding');
        const acknowledged=copy(await history.acknowledge({receipt:copy(receipt),previous:copy(previous)}));
        validateSelectedHistoryReceipt(acknowledged);
        demand(isDeepStrictEqual(acknowledged,receipt),'cancellation intent head acknowledgement differs');
        history.previous=copy(receipt);history.status='ready';this.historyReceipt=copy(receipt);
        return {base:copy(base),terminal:copy(terminal),receipt:copy(receipt)};
      }catch(error){history.status='failed';history.failure=error;throw error;}
    };
    const persistServiceTerminalFinal=async(intent,phase,serviceAdmission,closeReceipt,closedNative)=>{
      const history=this.automaticHistory;
      demand(history!==null&&history.status==='ready'&&intent?.terminal?.phase==='requested',
        'cancelled disposition requires an acknowledged terminal intent');
      history.status='saving';
      try{
        const previous=copy(history.previous);
        validateSelectedHistoryReceipt(previous);
        const entries=validateSelectedHistoryChain(copy(await history.journal.readAll(copy(previous))),copy(previous)),
          tail=entries.at(-1);
        demand(tail?.terminal?.phase==='requested'&&tail.terminal.terminalId===intent.terminal.terminalId&&
          isDeepStrictEqual(tail.terminal,intent.terminal),
          'cancelled disposition differs from the independently acknowledged intent');
        const closeEvidence=intent.terminal.closeBoundary?{
          closeBoundary:copy(intent.terminal.closeBoundary),closeRequestReceipt:copy(this.select.durableRequestReceipt()),
          closeElapsedMs:await this.#executionClock.elapsed(intent.terminal.snapshot.continuation.clockReceipt,
            {timeoutMs:this.policy.timeoutMs})}:{};
        const unsigned={schema:'semantic-selected-orchestration-terminal-event/8',
          terminalId:intent.terminal.terminalId,phase,session:intent.terminal.session,
          baseCheckpointDigest:intent.terminal.baseCheckpointDigest,pendingId:intent.terminal.pendingId,
          snapshot:intent.terminal.snapshot,snapshotDigest:intent.terminal.snapshotDigest,
          reason:intent.terminal.reason,ownerSnapshot:copy(intent.terminal.ownerSnapshot),
          serviceAdmission:copy(serviceAdmission),...closeEvidence,closeReceipt:copy(closeReceipt),
          closedNativeDigest:hashAlgorithmData(closedNative),closedNative:copy(closedNative)},
          terminal={...unsigned,digest:hashAlgorithmData(unsigned)};
        const receipt=copy(await history.journal.append(copy(tail.checkpoint),{
          previous:copy(previous),terminal:copy(terminal)}));
        validateSelectedHistoryReceipt(receipt);
        const recorded=validateSelectedHistoryChain(copy(await history.journal.readAll(copy(receipt))),copy(receipt)),
          latest=recorded.at(-1);
        demand(isDeepStrictEqual(latest?.checkpoint,tail.checkpoint)&&isDeepStrictEqual(latest?.previous,previous)&&
          isDeepStrictEqual(latest?.terminal,terminal)&&!Object.hasOwn(latest??{},'pending'),
          'cancelled disposition journal retained different terminal evidence');
        const acknowledged=copy(await history.acknowledge({receipt:copy(receipt),previous:copy(previous)}));
        validateSelectedHistoryReceipt(acknowledged);
        demand(isDeepStrictEqual(acknowledged,receipt),'cancelled disposition head acknowledgement differs');
        history.previous=copy(receipt);history.status='ready';this.historyReceipt=copy(receipt);
        this.terminalDisposition=copy(terminal);return copy(receipt);
      }catch(error){history.status='failed';history.failure=error;throw error;}
    };
    const terminalCloseBoundary=()=>this.#executionClock!==null&&
      typeof this.select.closeTerminal==='function'&&typeof this.select.durableRequestBoundary==='function'?
      copy(this.select.durableRequestBoundary()):null;
    const maybePause=async()=>{
      const requested=Boolean(stopAt&&stopAt.phase===this.continuation.phase&&
        stopAt.coordinatorSelections===this.continuation.coordinatorSelections);
      if(!requested&&this.automaticHistory===null)return false;
      checkAbort();
      this.pausedCheckpoint=await captureCheckpoint();
      if(this.automaticHistory!==null){
        const pending=!requested&&this.continuation.phase==='child-ready'?pendingMarker(this.pausedCheckpoint,
          'child-dispatch',{attempt:this.continuation.joinedAttempt,invocationId:
            this.continuation.joinedDependency.invocation,track:this.continuation.joinedDependency.track,
            dependency:this.continuation.joinedDependency}):null;
        await persistAutomaticCheckpoint(this.pausedCheckpoint,pending);
      }
      checkAbort();
      if(!requested){this.pausedCheckpoint=null;return false;}
      this.state=copy(state);paused=true;return true;
    };
    try{
      if(signal){if(signal.aborted)onExternalAbort();else signal.addEventListener('abort',onExternalAbort,{once:true});}
      if(this.continuation.clockReceipt){
        assertSelectedOrchestrationExecutionClock(this.#executionClock);
        const consumed=await this.#executionClock.elapsed(this.continuation.clockReceipt,{timeoutMs:this.timeoutMs});
        demand(consumed>=this.continuation.elapsedMs,'live clock predates the retained execution budget');
        this.continuation.elapsedMs=consumed;
        // Keep the retained clock origin. Rebasing after the asynchronous read
        // would silently refund the interval between sampling and resumption.
        baseElapsed=this.continuation.clockReceipt.consumedElapsedMs;
        started=BigInt(this.continuation.clockReceipt.issuedMonotonicNs);
      }
      const remainingMs=this.timeoutMs-elapsed();
      if(remainingMs<=0){deadlineExceeded=true;abort.abort(new Error('Selected orchestration v8 deadline exceeded'));}
      else timer=setTimeout(()=>{deadlineExceeded=true;
        abort.abort(new Error('Selected orchestration v8 deadline exceeded'));},remainingMs);
      checkAbort();
      if(this.restored){
        nativeIdentity=copy(this.nativeIdentity);initialState=copy(this.initialState);state=copy(this.state);opened=true;
        demand(nativeIdentity&&state&&this.#childDriver,'restored coordinator continuation is incomplete');
      }else{
        if(this.serviceAdmissionCoordinator){
          demand(isDeepStrictEqual(copy(this.serviceAdmissionCoordinator.ownerSnapshot()),this.policy.serviceAdmission),
            'composite service owner snapshot changed before execution');
          checkAbort();
          demand(isDeepStrictEqual(await this.serviceAdmissionCoordinator.assertActive(),this.policy.serviceAdmission.policy),
            'composite services are not active under the retained owner snapshot');
          checkAbort();
        }
        nativeIdentity=copy(await this.select.initialize({seed:this.seed,checkpointIdentity:this.checkpointIdentity,
          tokenizerIdentity:this.tokenizerIdentity,trainingIdentity:this.trainingIdentity}));
        demand(nativeIdentity?.schema==='semantic-inference-identity/8'&&
          nativeIdentity.adapter==='native-semantic-v8/1'&&nativeIdentity.checkpointIdentity===this.checkpointIdentity&&
          nativeIdentity.tokenizerIdentity===this.tokenizerIdentity&&
          (nativeIdentity.trainingIdentity??null)===this.trainingIdentity&&nativeIdentity.seed===this.seed&&
          nativeIdentity.generationSettings&&isDeepStrictEqual(nativeIdentity.generationSettings,this.generationSettings),
          'loaded native V8 model differs from the frozen identity or generation settings');
        demand(nativeIdentity.nativeAdmissionClaim===false&&
          (nativeIdentity.sourceAdmissionClaim===undefined||nativeIdentity.sourceAdmissionClaim===false),
          'native initialization made an unsupported admission claim');
        this.nativeIdentity=copy(nativeIdentity);checkAbort();
        state=await this.select.openOrchestration({session:this.session,public:copy(this.initialPublic),
          maxActive:this.maxActive,childBudget:this.childBudget,origin:'model'});
        opened=true;initialState=copy(state);this.initialState=copy(state);this.state=copy(state);
        demand(state?.schema==='semantic-orchestration-state/8'&&state.session===this.session&&
          state.origin==='model'&&state.sourceAdmissionClaim===false&&Array.isArray(state.children)&&
          state.children.length===this.invocations.length&&typeof state.track==='string',
          'native coordinator opening changed the model-only ingress authority');
        this.continuation={phase:'coordinator-ready',coordinatorSelections:0,joinedAttempt:null,
          joinedDependency:null,elapsedMs:this.continuation.elapsedMs};
        this.#childDriver=new RegionSelectedModelDriver({select:childSelector(this.select),harness:this.bridge,
          maxSelections:this.maxPredictions,maxOutstanding:this.maxOutstanding,maxStaleRetries:this.maxStaleRetries,
          origin:'model',checkpointIdentity:this.checkpointIdentity,tokenizerIdentity:this.tokenizerIdentity,
          nativeIdentity,trainingIdentity:this.trainingIdentity,
          hostLimits:{maxGenerated:this.maxGenerated,maxOutstanding:this.maxOutstanding},
          automaticDelivery:this.automaticDelivery});
      }
      if(await maybePause())throw Object.assign(new Error('orchestration paused at requested checkpoint boundary'),
        {selectedOrchestrationPause:true});
      while(state.status!=='completed'&&state.status!=='cancelled'){
        checkAbort();
        if(this.continuation.phase==='bootstrap-ready'){
          const attempt=coordinatorAttempts.at(-1),receipt=attempt?.commitReceipt,
            child=state.children.find(row=>row.track===receipt?.track?.address),
            durableBoundary=this.select.durableRequestBoundary?.()??null;
          demand(attempt?.status==='committed'&&attempt.action?.name==='track_create'&&child&&
            !Object.hasOwn(attempt,'bootstrapReceipt')&&receipt.track.bootstrap_ready===false,
            'child bootstrap requires the exact latest acknowledged reserved create');
          if(this.automaticHistory!==null){
            const beforeBootstrap=await captureCheckpoint();
            let clockFields={};
            if(this.automaticHistory.executionClock!==null){
              const original=beforeBootstrap.native.attempts.at(-1),
                requestBoundary=copy(this.select.durableRequestBoundary());
              demand(this.continuation.clockReceipt&&original?.durableRequestReceipt&&
                original.selection.selectionId===attempt.selection.selectionId&&
                requestBoundary?.ordinal===original.durableRequestReceipt.ordinal+1,
                'durable bootstrap lacks its original create request and unchanged execution clock');
              clockFields={clockReceipt:copy(this.continuation.clockReceipt),requestBoundary,
                createReceipt:copy(original.durableRequestReceipt)};
            }
            await persistAutomaticCheckpoint(beforeBootstrap,pendingMarker(beforeBootstrap,'child-bootstrap',{
              attempt:attempt.attempt,track:state.track,childTrack:child.track,...clockFields}));
            checkAbort();
          }
          try{
            const bootstrap=await this.select.bootstrapOrchestrationChild({session:this.session,
              track:state.track,childTrack:child.track});
            attempt.bootstrapReceipt=copy(bootstrap);state=await readState();
            const bound=state.tracks.find(row=>row.address===child.track);
            demand(bound?.bootstrap_ready===true&&isDeepStrictEqual(bound.execution,child.execution),
              'native child is not ready under the exact bootstrapped execution binding');
          }catch(error){
            // Unguarded callers retain the existing failure accounting. A
            // guarded create stays committed: bootstrap has its own request
            // outcome and pending history, never another model attempt.
            if(durableBoundary===null){attempt.status='post-commit-failed';attempt.failure=String(error?.message??error);}
            throw error;
          }
          this.continuation={...this.continuation,phase:'coordinator-ready'};
          if(await maybePause())throw Object.assign(new Error('orchestration paused at requested checkpoint boundary'),
            {selectedOrchestrationPause:true});
          continue;
        }
        if(this.continuation.phase==='child-ready'){
          const index=this.continuation.joinedAttempt,attempt=coordinatorAttempts[index],
            joined=await runJoinedChild(this.continuation.joinedDependency);
          attempt.childCompletion=copy(joined.completion);attempt.childOutcome=copy(joined.outcome);
          this.continuation={...this.continuation,phase:'coordinator-ready',joinedAttempt:null,joinedDependency:null};
          if(await maybePause())throw Object.assign(new Error('orchestration paused at requested checkpoint boundary'),
            {selectedOrchestrationPause:true});
          continue;
        }
        demand(this.continuation.phase==='coordinator-ready'&&state.status==='active',
          'native coordinator is waiting without an acknowledged child continuation');
        demand(this.continuation.coordinatorSelections<this.maxCoordinatorSelections,
          'Selected orchestration v8 coordinator selection budget exhausted');
        if(this.automaticHistory!==null){
          const beforeSelection=await captureCheckpoint();
          let clockFields={};
          if(this.automaticHistory.executionClock!==null){
            const clockReceipt=await this.automaticHistory.executionClock.capture({timeoutMs:this.timeoutMs,
              elapsedMs:sample=>baseElapsed+Number(sample-started)/1_000_000});
            const requestBoundary=copy(this.select.durableRequestBoundary());
            demand(requestBoundary?.sessionId===this.session,
              'durable request boundary belongs to another coordinator session');
            clockFields={clockReceipt,requestBoundary};
          }
          await persistAutomaticCheckpoint(beforeSelection,pendingMarker(beforeSelection,'coordinator-selection',{
            attempt:coordinatorAttempts.length,coordinatorSelections:this.continuation.coordinatorSelections,
            track:state.track,...clockFields}));
          if(clockFields.clockReceipt)this.continuation.clockReceipt=copy(clockFields.clockReceipt);
          checkAbort();
        }
        const context=nativeV8OrchestrationContext(state),attempt={attempt:coordinatorAttempts.length,
          family:'orchestration',session:this.session,track:state.track,contextDigest:hashAlgorithmData(context),
          publicDigest:state.publicDigest,status:'submitted',record:null,selection:null,commitReceipt:null,
          failure:null,failureEvidence:null};
        coordinatorAttempts.push(attempt);
        let output,action=null,commitStarted=false;
        try{
          output=await this.select.selectOrchestration({session:this.session,track:state.track});
          const original=checkCoordinatorSelection(output,{session:this.session,track:state.track,state,context,
            checkpointIdentity:this.checkpointIdentity,tokenizerIdentity:this.tokenizerIdentity,
            trainingIdentity:this.trainingIdentity});
          attempt.record=original.record;attempt.selection=copy(original.selection);attempt.status='decoded';
          checkAbort();commitStarted=true;
          const receipt=await this.select.commitOrchestration({session:this.session,track:state.track,
            record:original.record,selection:copy(original.selection)});
          attempt.commitReceipt=copy(receipt);attempt.status='committed';checkAbort();
          action=parseAction(original.record);attempt.action=copy(action);
          this.continuation={...this.continuation,
            coordinatorSelections:this.continuation.coordinatorSelections+1};
          state=await readState();
          if(action.name==='track_create'){
            const invocationId=action.arguments.execution?.invocation_id,
              child=state.children.find(row=>row.execution.invocation_id===invocationId);
            demand(child&&child.track===receipt.track?.address&&receipt.track?.parent===state.track&&
              receipt.track.bootstrap_ready===false&&receipt.completion_dependency?.track===child.track&&
              receipt.completion_dependency.invocation===invocationId,
              'native create receipt changed its original declared child binding');
            this.createdDependencies.set(child.track,copy(receipt.completion_dependency));
            this.continuation={...this.continuation,phase:'bootstrap-ready'};
          }else if(action.name==='track_join'){
            this.continuation={...this.continuation,phase:'child-ready',joinedAttempt:attempt.attempt,
              joinedDependency:copy(action.arguments.completion_dependency)};
            if(await maybePause())throw Object.assign(new Error('orchestration paused at requested checkpoint boundary'),
              {selectedOrchestrationPause:true});
            continue;
          }
        }catch(error){
          if(error?.selectedOrchestrationPause)throw error;
          if(output&&typeof output==='object'){
            if(attempt.record===null&&typeof output.record==='string')attempt.record=output.record;
            if(attempt.selection===null&&output.selection!==undefined)attempt.selection=copy(output.selection);
          }
          if(error?.evidence&&typeof error.evidence==='object'){
            if(attempt.record===null&&typeof error.evidence.record==='string')attempt.record=error.evidence.record;
            if(attempt.rawPayloadHex===undefined&&typeof error.evidence.rawPayloadHex==='string')
              attempt.rawPayloadHex=error.evidence.rawPayloadHex;
            if(attempt.selection===null&&error.evidence.selection!==undefined)
              attempt.selection=copy(error.evidence.selection);
          }
          if(attempt.status==='submitted'||attempt.status==='decoded'||attempt.status==='committed'){
            attempt.status=abort.signal.aborted&&!commitStarted?'cancelled':error?.acknowledgementUnknown?
              'acknowledgement-unknown':attempt.status==='committed'?'post-commit-failed':
                commitStarted?'commit-failed':'failed';
            attempt.failure=String(error?.message??error);
          }
          if(error?.evidence!==undefined)attempt.failureEvidence=copy(error.evidence);
          throw error;
        }
        if(!['track_complete','track_cancel'].includes(action?.name)&&await maybePause())
          throw Object.assign(new Error('orchestration paused at requested checkpoint boundary'),
            {selectedOrchestrationPause:true});
      }
      if(!paused){
        if(state.status!=='completed'&&state.status!=='cancelled')
          throw new RangeError('Selected orchestration v8 coordinator selection budget exhausted');
        terminalReason=state.status==='cancelled'?boundedCancellationReason(state.receipts.find(row=>
          row.schema==='semantic-orchestration-cancel/8')?.reason??'selected coordinator cancellation'):
          'Selected orchestration v8 completed';
        if(state.status==='completed'&&this.automaticHistory!==null){
          terminalCheckpoint=await captureCheckpoint({allowTerminal:true});
          const closeBoundary=terminalCloseBoundary();
          if(this.serviceAdmissionCoordinator){
            if(closeBoundary!==null)durableCloseRequired=true;
            cancellationIntent=await persistServiceTerminalIntent(terminalCheckpoint,terminalReason,
              closeBoundary===null?{}:{closeBoundary});
            checkAbort();
            cancellationServiceAdmission=copy(await this.serviceAdmissionCoordinator.terminate({
              sessionId:this.session,reason:terminalReason}));
            const verified=copy(await this.serviceAdmissionCoordinator.verify(copy(cancellationServiceAdmission)));
            demand(isDeepStrictEqual(verified,cancellationServiceAdmission),
              'service coordinator acknowledged a different completion fence');
            serviceTerminalVerified=true;
            checkAbort();
          }else if(closeBoundary!==null){
            durableCloseRequired=true;
            cancellationIntent=await persistServiceTerminalIntent(terminalCheckpoint,terminalReason,
              {closeBoundary});
            checkAbort();
          }
        }
        if(state.status==='cancelled'&&this.automaticHistory!==null&&this.serviceAdmissionCoordinator){
          const cancelledSnapshot=await captureCheckpoint({allowCancelled:true});
          const closeBoundary=terminalCloseBoundary();
          if(closeBoundary!==null)durableCloseRequired=true;
          cancellationIntent=await persistServiceTerminalIntent(cancelledSnapshot,terminalReason,
            closeBoundary===null?{}:{closeBoundary});
          checkAbort();
          cancellationServiceAdmission=copy(await this.serviceAdmissionCoordinator.terminate({
            sessionId:this.session,reason:terminalReason}));
          const verified=copy(await this.serviceAdmissionCoordinator.verify(copy(cancellationServiceAdmission)));
          demand(isDeepStrictEqual(verified,cancellationServiceAdmission),
            'service coordinator acknowledged a different cancellation fence');
          serviceTerminalVerified=true;
          checkAbort();
        }else if(state.status==='cancelled'&&this.automaticHistory!==null&&
            this.serviceAdmissionCoordinator===null&&this.#executionClock!==null&&
            typeof this.select.closeTerminal==='function'&&typeof this.select.durableRequestBoundary==='function'){
          // Unsettled host children cannot use this complete-history path.
          const closeBoundary=terminalCloseBoundary();
          if(closeBoundary!==null){
            const cancelledSnapshot=await captureCheckpoint({allowCancelled:true});
            durableCloseRequired=true;
            cancellationIntent=await persistServiceTerminalIntent(cancelledSnapshot,terminalReason,
              {closeBoundary});
            checkAbort();
          }
        }
      }
    }catch(error){
      if(error?.selectedOrchestrationPause)paused=true;
      else{failure=failureOf(error);terminalReason=cancellationIntent?.terminal.reason??
        boundedCancellationReason(error?.message??error);}
    }finally{
      if(timer!==null)clearTimeout(timer);
      signal?.removeEventListener('abort',onExternalAbort);
      if(failure)abort.abort(new Error(terminalReason));
      if(this.#childDriver?.running.size){
        const settled=await Promise.allSettled([...this.#childDriver.running.values()].map(row=>row.task));
        const rejected=settled.find(row=>row.status==='rejected');
        if(rejected&&failure===null)failure=failureOf(rejected.reason);
      }
      this.#childDriver?.close();
      if(!paused&&opened&&failure&&state?.status!=='completed'&&state?.status!=='cancelled'){
        try{cancelReceipt=copy(await this.select.cancelOrchestration({session:this.session,track:state.track,
          reason:terminalReason}));state=cancelReceipt;}
        catch(error){cleanupFailure??=failureOf(error);}
      }
      const preserveUnacknowledgedTerminalIntent=!paused&&
        ['cancelled','completed'].includes(state?.status)&&this.automaticHistory!==null&&
        (this.serviceAdmissionCoordinator&&(cancellationIntent===null||!serviceTerminalVerified)||
          durableCloseRequired&&cancellationIntent===null);
      if(!paused&&nativeIdentity&&!preserveUnacknowledgedTerminalIntent){
        try{const close=cancellationIntent?.terminal.closeBoundary?this.select.closeTerminal:this.select.cancel;
          closeReceipt=copy(await close({session:this.session,
          ...(cancellationIntent?.terminal.closeBoundary?{
            expectedBoundary:copy(cancellationIntent.terminal.closeBoundary),
            expectedCheckpointDigest:cancellationIntent.terminal.snapshot.native.native.digest}:{}),
          reason:terminalReason??(state?.status==='completed'?'Selected orchestration v8 completed':'Selected orchestration v8 finished')}));}
        catch(error){cleanupFailure??=failureOf(error);}
      }
      if(!paused&&failure===null&&terminalCheckpoint&&this.automaticHistory!==null&&closeReceipt&&
        cancellationIntent===null){
        try{const closedNative=copy(await this.select.checkpoint());
          await persistCompletedTerminal(terminalCheckpoint,closeReceipt,closedNative);}
        catch(error){cleanupFailure??=failureOf(error);}
      }
      if(!paused&&failure===null&&cancellationIntent&&(cancellationServiceAdmission||
          cancellationIntent.terminal.closeBoundary)&&closeReceipt){
        try{const closedNative=copy(await this.select.checkpoint());
          await persistServiceTerminalFinal(cancellationIntent,terminalCheckpoint?'completed':'cancelled',
            cancellationServiceAdmission,closeReceipt,closedNative);}
        catch(error){cleanupFailure??=failureOf(error);}
      }
      if(cleanupFailure&&failure===null)failure=cleanupFailure;
      this.running=false;
    }
    const publicData=this.bridge.exportEpisode(),controllers=[...this.bridge.invocations.values()],
      publicCompleted=state?.status==='completed'&&controllers.length===this.invocations.length&&
        controllers.every(row=>row.status==='completed'),
      firstViolation=controllers.map(row=>row.controller.firstWitnessViolation).find(Boolean)??null,
      childMetrics=this.#childDriver?.metrics()??{predictionAttempts:0,accepted:0,rejected:0,generatedBytes:0,
        generatedTokens:0,unknownGenerationCostAttempts:0,nativeAdmissionClaim:false,sourceAdmissionClaim:false},
      coordinatorMetrics={attempts:coordinatorAttempts.length,
        acknowledged:coordinatorAttempts.filter(row=>row.commitReceipt?.committed===true).length,
        unknownAcknowledgements:coordinatorAttempts.filter(row=>row.status==='acknowledgement-unknown').length,
        postCommitFailures:coordinatorAttempts.filter(row=>row.status==='post-commit-failed').length,
        rejected:coordinatorAttempts.filter(row=>!['committed','submitted','decoded','acknowledgement-unknown','post-commit-failed']
          .includes(row.status)).length,
        generatedBytes:coordinatorAttempts.reduce((sum,row)=>sum+(typeof row.record==='string'?
          Buffer.byteLength(row.record,'utf8'):typeof row.rawPayloadHex==='string'?row.rawPayloadHex.length/2:0),0),
        generatedTokens:coordinatorAttempts.reduce((sum,row)=>sum+
          (row.selection?.modelSelected===true&&row.selection?.origin==='actual-model-selected'&&
            Array.isArray(row.selection.fragments)?row.selection.fragments.reduce((total,fragment)=>
              total+(Array.isArray(fragment.tokenIds)?fragment.tokenIds.length:0),0):0),0)},
      nativeMetrics=copy(this.select.metrics?.()??null),
      finalStatus=paused?'paused':failure?(failure.message.includes('budget')||deadlineExceeded?'resource_limited':'failed'):
        state?.status==='cancelled'?'cancelled':publicCompleted?'completed':'incomplete',
      totalElapsed=paused?this.continuation.elapsedMs:elapsed();
    const result={schema:'semantic-selected-orchestration-result/8',origin:'model',session:this.session,
      checkpointIdentity:this.checkpointIdentity,tokenizerIdentity:this.tokenizerIdentity,
      trainingIdentity:this.trainingIdentity,seed:this.seed,generationSettings:copy(this.generationSettings),
      inferenceIdentity:nativeIdentity,initialState,finalState:state,status:finalStatus,
      initialPublic:copy(this.initialPublic),public:publicData,publicCompleted,
      publicAccepted:!failure&&!firstViolation,sourceValidated:false,
      coordinatorAttempts:copy(coordinatorAttempts),contexts:copy(this.#childDriver?.contexts??[]),
      childAttempts:copy(this.#childDriver?.attempts??[]),childRejections:copy(this.#childDriver?.rejections??[]),
      metrics:{...childMetrics,coordinatorAttempts:coordinatorMetrics.attempts,
        coordinatorAccepted:coordinatorMetrics.acknowledged,coordinatorRejected:coordinatorMetrics.rejected,
        coordinatorPostCommitFailures:coordinatorMetrics.postCommitFailures,
        coordinatorUnknownAcknowledgements:coordinatorMetrics.unknownAcknowledgements,
        coordinatorGeneratedBytes:coordinatorMetrics.generatedBytes,
        coordinatorGeneratedTokens:coordinatorMetrics.generatedTokens,elapsedMs:totalElapsed},
      nativeMetrics,completionReceipts:copy(state?.children?.map(row=>
        row.completion).filter(Boolean)??[]),cancelReceipt,closeReceipt,terminalReason,
      failure,cleanupFailure,firstViolation:copy(firstViolation),recovery:{resumable:paused,
        reason:paused?'Composite checkpoint paused at a verified quiescent phase':
          this.terminalDisposition?'Completed session retained as a nonresumable terminal disposition':
            'Only verified active cuts can be restored; terminal histories without a positive disposition remain fenced'},
      ...(this.terminalDisposition?{terminalDisposition:copy(this.terminalDisposition),
        historyReceipt:copy(this.historyReceipt)}:{}),
      ...(paused?{checkpoint:copy(this.pausedCheckpoint)}:{}),
      limits:{hostExecutionTimeoutMs:this.timeoutMs,nativeRequestDeadlineOwnedBySelector:true},
      qualification:{modelMeasurement:childMetrics.accepted>0?'actual-model-selected':'unmeasured',
        sourceCorrespondence:'not-checked-by-public-replay',defaultPromotion:false}};
    return {...result,digest:hashAlgorithmData(result)};
  }
}

export async function runSelectedRegionOrchestrationV8(options){
  return new RegionSelectedOrchestrationDriver(options).run({signal:options?.signal??null,stopAt:options?.stopAt??null});
}
