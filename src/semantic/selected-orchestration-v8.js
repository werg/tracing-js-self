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

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
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
  // timeoutMs aborts host child execution cooperatively. In-flight native RPCs
  // remain bounded by the selector's own request deadline so their ack state
  // is observed before cleanup starts.
  constructor({initialPublic,select,checkpointIdentity,tokenizerIdentity,trainingIdentity=null,seed=17,
      generationSettings,maxActive=1,childBudget=128,maxCoordinatorSelections=128,maxPredictions=4096,
      maxGenerated=16384,maxOutstanding=64,maxStaleRetries=8,timeoutMs=15000,
      automaticDelivery=null,harness=null,harnessOptions={}}={}){
    const ingress=validateIngress(initialPublic);
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
      select,bridge,checkpointIdentity,tokenizerIdentity,trainingIdentity,seed,
      generationSettings:copy(generationSettings),maxActive,childBudget,maxCoordinatorSelections,maxPredictions,
      maxGenerated,maxOutstanding,maxStaleRetries,timeoutMs,automaticDelivery:bridge.inner.automaticDelivery});
    this.policy=Object.freeze({checkpointIdentity,tokenizerIdentity,trainingIdentity,seed,
      generationSettings:copy(generationSettings),maxActive,childBudget,maxCoordinatorSelections,maxPredictions,
      maxGenerated,maxOutstanding,maxStaleRetries,timeoutMs,automaticDelivery:bridge.inner.automaticDelivery});
    this.coordinatorAttempts=[];this.state=null;this.initialState=null;this.nativeIdentity=null;
    this.continuation={phase:'unopened',coordinatorSelections:0,joinedAttempt:null,joinedDependency:null,elapsedMs:0};
    this.createdDependencies=new Map();this.pausedCheckpoint=null;this.historyReceipt=null;this.restored=false;this.running=false;this.used=false;
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
  startAutomaticHistory(){throw new Error('Selected orchestration v8: automatic composite history is not available');}
  static async restore(packet,{initialPublic,select,policy,harnessOptions={},signal=null}={}){
    packet=copy(packet);initialPublic=copy(initialPublic);policy=copy(policy);harnessOptions={...harnessOptions};
    demand(initialPublic&&typeof select==='function'&&typeof select.restore==='function'&&
      typeof select.checkpoint==='function'&&typeof select.status==='function',
      'external source cut and a fresh checkpoint-capable native selector are required');
    verifySelectedOrchestrationCheckpoint(packet,policy,{initialPublic});
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
      const ingressHarness=RegionExecutionHarness.replay(copy(packet.initialPublic),{...harnessOptions,
        requireTerminal:false,automaticDelivery:policy.automaticDelivery});
      const driver=new RegionSelectedOrchestrationDriver({initialPublic:copy(packet.initialPublic),select,
        ...policy,automaticDelivery:policy.automaticDelivery,harness:ingressHarness});
      driver.bridge=bridge;
      driver.state=copy(state);driver.initialState=copy(packet.initialState);
      driver.nativeIdentity=copy(packet.native.identity);driver.continuation=copy(packet.continuation);
      driver.coordinatorAttempts=copy(packet.coordinatorAttempts);driver.restored=true;
      for(const attempt of driver.coordinatorAttempts)if(attempt.action?.name==='track_create'){
        const dependency=attempt.commitReceipt?.completion_dependency;
        demand(dependency,'restored create has no exact dependency receipt');
        driver.createdDependencies.set(dependency.track,copy(dependency));
      }
      driver.#childDriver=await restoreSelectedOrchestrationChildDriver({packet,policy,
        initialPublic:driver.initialPublic,bridge,select,childSelect:childSelector(select)});
      return driver;
    }catch(error){select.close?.();throw error;}
  }
  static async restoreLatest(packet,{historyJournal,historyReceipt,initialPublic,select,policy,harnessOptions={},signal=null}={}){
    packet=copy(packet);historyReceipt=copy(historyReceipt);initialPublic=copy(initialPublic);
    policy=copy(policy);harnessOptions={...harnessOptions};
    demand(typeof historyJournal?.readAll==='function','independently retained composite history is required');
    validateSelectedHistoryReceipt(historyReceipt);
    const entries=validateSelectedHistoryChain(copy(await historyJournal.readAll(copy(historyReceipt))),copy(historyReceipt));
    demand(entries.some(entry=>isDeepStrictEqual(entry.checkpoint,packet)),
      'supplied composite checkpoint is absent from the independently acknowledged history');
    for(const entry of entries)verifySelectedOrchestrationCheckpoint(entry.checkpoint,policy,{initialPublic});
    const latest=entries.at(-1).checkpoint;
    demand(!entries.at(-1).terminal,'terminal orchestration disposition cannot be restored as active work');
    const restored=await this.restore(latest,{initialPublic,select,policy,harnessOptions,signal});
    restored.historyReceipt=copy(historyReceipt);return restored;
  }

  async run({signal=null,stopAt=null}={}){
    demand(!this.running&&!this.used,'coordinator driver is one-shot and cannot be reopened');
    demand(stopAt===null||stopAt&&typeof stopAt==='object'&&!Array.isArray(stopAt)&&
      Object.keys(stopAt).length===2&&['phase','coordinatorSelections'].every(key=>Object.hasOwn(stopAt,key))&&
      ['coordinator-ready','child-ready'].includes(stopAt.phase)&&
      Number.isSafeInteger(stopAt.coordinatorSelections)&&stopAt.coordinatorSelections>=0,
      'checkpoint stop point must name an explicit safe continuation phase and selection count');
    this.running=true;this.used=true;
    const started=performance.now(),abort=new AbortController(),coordinatorAttempts=this.coordinatorAttempts;
    let nativeIdentity=null,initialState=null,state=null,failure=null,cleanupFailure=null,
      closeReceipt=null,cancelReceipt=null,terminalReason=null,deadlineExceeded=false,opened=false,paused=false;
    let timer=null;
    const onExternalAbort=()=>abort.abort(signal.reason??new Error('Selected orchestration v8 cancelled'));
    const checkAbort=()=>{if(abort.signal.aborted)throw abort.signal.reason instanceof Error?
      abort.signal.reason:new Error(String(abort.signal.reason??'Selected orchestration v8 cancelled'));};
    const elapsed=()=>this.continuation.elapsedMs+performance.now()-started;
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
    const captureCheckpoint=async()=>{
      demand((this.continuation.phase!=='unopened'&&state?.status==='active')||
        (this.continuation.phase==='child-ready'&&state?.status==='waiting'),
        'only an active safe coordinator or acknowledged waiting child can be checkpointed');
      demand(this.#childDriver?.running.size===0,'a running child cannot be checkpointed');
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
      verifySelectedOrchestrationCheckpoint(packet,this.policy,{initialPublic:this.initialPublic});
      return packet;
    };
    const maybePause=async()=>{
      if(!stopAt||stopAt.phase!==this.continuation.phase||
        stopAt.coordinatorSelections!==this.continuation.coordinatorSelections)return false;
      checkAbort();this.pausedCheckpoint=await captureCheckpoint();checkAbort();
      this.state=copy(state);paused=true;return true;
    };
    try{
      if(signal){if(signal.aborted)onExternalAbort();else signal.addEventListener('abort',onExternalAbort,{once:true});}
      const remainingMs=this.timeoutMs-this.continuation.elapsedMs;
      if(remainingMs<=0){deadlineExceeded=true;abort.abort(new Error('Selected orchestration v8 deadline exceeded'));}
      else timer=setTimeout(()=>{deadlineExceeded=true;
        abort.abort(new Error('Selected orchestration v8 deadline exceeded'));},remainingMs);
      checkAbort();
      if(this.restored){
        nativeIdentity=copy(this.nativeIdentity);initialState=copy(this.initialState);state=copy(this.state);opened=true;
        demand(nativeIdentity&&state&&this.#childDriver,'restored coordinator continuation is incomplete');
      }else{
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
            const bootstrap=await this.select.bootstrapOrchestrationChild({session:this.session,
              track:state.track,childTrack:child.track});
            attempt.bootstrapReceipt=copy(bootstrap);state=await readState();
            const bound=state.tracks.find(row=>row.address===child.track);
            demand(bound?.bootstrap_ready===true&&isDeepStrictEqual(bound.execution,child.execution),
              'native child is not ready under the exact bootstrapped execution binding');
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
      }
    }catch(error){
      if(error?.selectedOrchestrationPause)paused=true;
      else{failure=failureOf(error);terminalReason=boundedCancellationReason(error?.message??error);}
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
      if(!paused&&nativeIdentity){
        try{closeReceipt=copy(await this.select.cancel({session:this.session,
          reason:terminalReason??'Selected orchestration v8 finished'}));}
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
          'Terminal histories remain unavailable; completed and failed sessions cannot be resumed'},
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
