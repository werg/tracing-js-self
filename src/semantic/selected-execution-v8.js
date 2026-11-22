// Live v8 inference reuses the established host/callback lifecycle. Only the
// selected public prefix crosses the model boundary; no teacher or oracle does.
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionDriver} from './execution-driver.js';
import {createFixtureBroker} from '../training/fixture-broker.js';
import {hostOperation} from '../host/operations.js';
import {RegionExecutionHarness} from './region-harness.js';
import {commitCausalLmV8Selection,decodeCausalLmV8Target} from './causal-lm-v8.js';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON} from './ir.js';
import {validateSelectedHistoryReceipt,validateSelectedHistoryChain,validateSelectedHistoryExtension}
  from './selected-history-v8.js';
import {validateHostIngressLogChain} from './host-ingress-journal-v8.js';
import {validateServiceAdmissionPolicy,validateServiceAdmissionFence} from './service-admission-v8.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
const demand=(value,message)=>{if(!value)throw new TypeError('Selected v8: '+message);};
const positive=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;
const isPayloadHex=value=>typeof value==='string'&&/^(?:[0-9a-f]{2})*$/.test(value);
export function boundedCancellationReason(value){
  const source=Buffer.from(String(value),'utf8').toString('utf8');let bytes=0;const parts=[];
  for(const point of source){const size=Buffer.byteLength(point,'utf8');if(bytes+size>4096)break;
    parts.push(point);bytes+=size;}
  return parts.join('')||'selected execution cancelled';
}
const originalFragments=(payloadHex,selection)=>isPayloadHex(payloadHex)&&Array.isArray(selection?.fragments)&&
  selection.fragments.length>0&&selection.fragments.every(fragment=>Array.isArray(fragment?.tokenIds)&&fragment.tokenIds.length>0&&
    fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&isPayloadHex(fragment.payloadHex))&&
  Buffer.concat(selection.fragments.map(fragment=>Buffer.from(fragment.payloadHex,'hex')))
    .equals(Buffer.from(payloadHex,'hex'));
const boundPayload=(payloadHex,selection,context,checkpointIdentity,tokenizerIdentity,trainingIdentity=null)=>
  selection?.modelSelected===true&&selection.origin==='actual-model-selected'&&
  typeof selection.selectionId==='string'&&selection.selectionId.length>0&&
  selection.checkpointIdentity===checkpointIdentity&&selection.tokenizerIdentity===tokenizerIdentity&&
  (selection.trainingIdentity??null)===trainingIdentity&&
  selection.prefixDigest===context.prefixDigest&&selection.contextDigest===hashAlgorithmData(context)&&
  selection.payloadHex===payloadHex&&originalFragments(payloadHex,selection);
const boundSelection=(record,selection,context,checkpointIdentity,tokenizerIdentity,trainingIdentity=null)=>typeof record==='string'&&
  boundPayload(Buffer.from(record,'utf8').toString('hex'),selection,context,checkpointIdentity,tokenizerIdentity,trainingIdentity);
const attemptPayload=row=>typeof row.record==='string'?Buffer.from(row.record,'utf8').toString('hex'):
  isPayloadHex(row.rawPayloadHex)?row.rawPayloadHex:null;
const recoveryTickets=new WeakSet();

function admissionCoordinatorPolicy(coordinator,sessionId,expected=null){
  demand(coordinator&&typeof coordinator.terminate==='function'&&typeof coordinator.verify==='function'&&
    typeof coordinator.assertActive==='function',
    'configured service admission requires its independently owned coordinator');
  const policy=copy(coordinator.policy);validateServiceAdmissionPolicy(policy,sessionId);
  demand(expected===null||isDeepStrictEqual(policy,expected),'service admission policy changed');
  return policy;
}
async function verifyTerminalServiceAdmission(terminal,policy,coordinator){
  if(!policy.serviceAdmission){
    demand(coordinator===null,'unfenced history cannot acquire a service admission claim on restore');return;
  }
  admissionCoordinatorPolicy(coordinator,terminal.session,policy.serviceAdmission);
  validateServiceAdmissionFence(terminal.serviceAdmission,policy.serviceAdmission,terminal.reason);
  const receipt=await coordinator.verify(copy(terminal.serviceAdmission));
  demand(isDeepStrictEqual(receipt,terminal.serviceAdmission),
    'service admission recovery acknowledged a different terminal fence');
}

function verifyDriverCheckpoint(packet,policy){
  stableAlgorithmJSON(packet);
  const fields=['schema','policy','bridge','contexts','attempts','staleRetries','native','digest'];
  demand(packet&&Object.keys(packet).length===fields.length&&fields.every(key=>Object.hasOwn(packet,key)),
    'invalid selected driver checkpoint fields');
  const {digest,...body}=packet;
  demand(packet.schema==='semantic-selected-driver-checkpoint/8'&&HASH.test(digest??'')&&
    digest===hashAlgorithmData(body),'selected driver checkpoint integrity differs');
  demand(policy&&isDeepStrictEqual(packet.policy,policy)&&HASH.test(policy.checkpointIdentity??'')&&
    HASH.test(policy.tokenizerIdentity??'')&&positive(policy.maxSelections,100000)&&
    positive(policy.maxOutstanding,1024)&&Number.isSafeInteger(policy.maxStaleRetries)&&
    policy.maxStaleRetries>=0&&policy.maxStaleRetries<=1000&&
    policy.nativeIdentity?.schema==='semantic-inference-identity/8'&&
    Number.isSafeInteger(policy.nativeIdentity.seed)&&policy.nativeIdentity.seed>=0&&
    policy.nativeIdentity.generationSettings&&typeof policy.nativeIdentity.generationSettings==='object'&&
    !Array.isArray(policy.nativeIdentity.generationSettings)&&
    positive(policy.hostLimits?.maxGenerated,1000000)&&positive(policy.hostLimits?.maxOutstanding,1024)&&
    typeof policy.automaticDelivery==='boolean',
    'recovery requires the externally expected model identities and execution budgets');
  demand(Array.isArray(packet.contexts)&&Array.isArray(packet.attempts)&&
    packet.attempts.length<=policy.maxSelections&&Number.isSafeInteger(packet.staleRetries)&&
    packet.staleRetries===packet.attempts.filter(row=>row.status==='stale').length&&
    packet.staleRetries<=policy.maxStaleRetries,'retained prediction or stale-retry budget differs');
  const transport=packet.native,{digest:transportDigest,...transportBody}=transport??{};
  demand(transport?.schema==='semantic-native-transport-checkpoint/8'&&HASH.test(transportDigest??'')&&
    transportDigest===hashAlgorithmData(transportBody)&&
    transport.identity?.checkpointIdentity===policy.checkpointIdentity&&
    transport.identity?.tokenizerIdentity===policy.tokenizerIdentity&&
    isDeepStrictEqual(transport.identity,policy.nativeIdentity)&&
    Array.isArray(transport.attempts)&&transport.attempts.length===packet.attempts.length,
    'model transport checkpoint does not cover the driver identity and consumed attempts');
  const native=transport.native,{digest:nativeDigest,...nativeBody}=native??{};
  demand(transport.runtimeMetrics&&['rpcCalls','computeSeconds','peakMemoryBytes'].every(key=>
    Number.isFinite(transport.runtimeMetrics[key])&&transport.runtimeMetrics[key]>=0)&&
    Number.isSafeInteger(transport.runtimeMetrics.rpcCalls),'invalid retained native cost accounting');
  demand(native?.schema==='semantic-model-checkpoint/8'&&HASH.test(nativeDigest??'')&&
    nativeDigest===hashAlgorithmData(nativeBody)&&isDeepStrictEqual(native.initialization,transport.identity)&&
    Array.isArray(native.attempts)&&native.attempts.length===packet.attempts.length,
    'native checkpoint does not preserve the same acknowledged attempts');
  const publicData=packet.bridge?.public,session=publicData?.timeline?.[0]?.fields?.session;
  if(Object.hasOwn(policy,'serviceAdmission'))validateServiceAdmissionPolicy(policy.serviceAdmission,session);
  demand(typeof session==='string'&&native.sessions&&typeof native.sessions==='object'&&!Array.isArray(native.sessions)&&
    Object.keys(native.sessions).every(key=>key===session),
    'driver recovery requires a dedicated native transport for this session');
  demand(native.closedSessions===undefined||native.closedSessions&&
    typeof native.closedSessions==='object'&&!Array.isArray(native.closedSessions)&&
    Object.keys(native.closedSessions).length===0,
    'a closed native session cannot restore an active selected driver');
  const accepted=packet.attempts.filter(row=>row.status==='accepted');
  demand(accepted.length===packet.contexts.length,'acknowledged selections and causal contexts differ');
  for(const [index,attempt]of packet.attempts.entries()){
    const retained=transport.attempts[index],model=native.attempts[index];
    demand(attempt.attempt===index&&['accepted','stale'].includes(attempt.status)&&
      boundSelection(attempt.record,attempt.selection,attempt.context,policy.checkpointIdentity,policy.tokenizerIdentity,
        policy.nativeIdentity.trainingIdentity??null)&&
      retained?.attempt===index&&retained.session===session&&retained.invocationId===attempt.invocationId&&
      retained.record===attempt.record&&isDeepStrictEqual(retained.selection,attempt.selection)&&
      retained.status===(attempt.status==='accepted'?'accepted':'rejected')&&
      model?.selectionId===attempt.selection.selectionId&&model.session===session&&
      model.invocationId===attempt.invocationId&&model.payloadHex===attempt.selection.payloadHex&&
      isDeepStrictEqual(model.fragments,attempt.selection.fragments)&&
      model.status===(attempt.status==='accepted'?'committed':'semantic-rejected'),
      'checkpoint contains unacknowledged, changed or omitted original selections');
  }
  const saved=native.sessions[session];
  if(!saved)demand(packet.attempts.length===0,'native checkpoint omitted its selected session');
  else{
    const prefix=saved.public?.timeline;
    demand(Array.isArray(prefix)&&saved.unacknowledgedSelection===null&&
      isDeepStrictEqual(saved.contexts,packet.contexts)&&
      isDeepStrictEqual({...saved.public,timeline:[]},{...publicData,timeline:[]})&&
      isDeepStrictEqual(prefix,publicData.timeline.slice(0,prefix.length))&&
      publicData.timeline.slice(prefix.length).every(row=>row.mode==='observed'),
      'native acknowledged history is not the same public prefix');
  }
  // Rebuild the causal boundaries from the public machine. Saved contexts or
  // locally rehashed state never substitute for the state before each record.
  const replay=new RegionExecutionHarness({sessionId:session,automaticDelivery:false,now:()=>-Infinity,
    ...policy.hostLimits});
  let generated=0;
  for(const row of publicData.timeline){
    if(row.mode==='generated'){
      const attempt=accepted[generated],context=packet.contexts[generated];
      demand(attempt&&row.fields.invocationId===attempt.invocationId&&row.fields.line===attempt.record&&
        isDeepStrictEqual(context,attempt.context)&&
        isDeepStrictEqual(context,replay.modelContext(attempt.invocationId)),
        'checkpoint causal boundary or accepted record differs from public history');
      commitCausalLmV8Selection(replay,attempt.invocationId,attempt.record,{context});generated++;
    }else replay.importObserved(row);
    demand(isDeepStrictEqual(replay.timeline.at(-1),row),'checkpoint public history changed during replay');
  }
  demand(generated===accepted.length,'checkpoint omitted acknowledged generated records');
  return true;
}

function verifyRestoredHostLimits(harness,policy){
  demand(harness.inner.maxGenerated===policy.hostLimits.maxGenerated&&
    harness.inner.maxOutstanding===policy.hostLimits.maxOutstanding&&
    harness.inner.automaticDelivery===policy.automaticDelivery&&
    [...harness.invocations.values()].every(row=>row.controller.maxGenerated===policy.hostLimits.maxGenerated),
    'restored host continuation changed its externally expected resource limits');
}

// The externally retained history head anchors every recorded cut, including
// its private-ingress references. Validate all cuts without opening native
// model state or attaching any live services. Later, separately acknowledged
// ingress is applied only to the final cut by the ordinary restore path.
async function verifyRecordedHistoryCuts(entries,policy,{ingressStore=null,ingressJournal=null}={}){
  let previous=null,ingressHead=null;
  for(const {checkpoint}of entries){
    verifyDriverCheckpoint(checkpoint,policy);
    if(previous)validateSelectedHistoryExtension(previous,checkpoint);
    const bridge=checkpoint.bridge,head=bridge.ingressLog??null;
    if(head){
      demand(typeof ingressJournal?.readAll==='function','recorded ingress requires its independently read journal');
      const arrivals=validateHostIngressLogChain(copy(await ingressJournal.readAll(copy(head))),head);
      if(ingressHead){
        const earlier=arrivals[ingressHead.position-1];
        demand(earlier&&head.streamId===ingressHead.streamId&&hashAlgorithmData(earlier)===ingressHead.id&&
          Buffer.byteLength(stableAlgorithmJSON(earlier))===ingressHead.bytes,
          'recorded ingress head does not extend its earlier acknowledgement');
      }
      ingressHead=head;
    }
    const harness=bridge.ingress||head?
      await RegionExecutionHarness.restoreDurable(bridge,{ingressStore,ingressReceipt:bridge.ingress??null,
        ...(head?{ingressJournal,ingressLogReceipt:copy(head)}:{}),now:()=>-Infinity}):
      RegionExecutionHarness.restore(bridge,{now:()=>-Infinity});
    verifyRestoredHostLimits(harness,policy);previous=checkpoint;
  }
}

function driverFacade(bridge,contexts,predictions){
  const host={
    publishProgram:options=>bridge.publishProgram(options),
    admitInvocation:options=>bridge.admitInvocation(options),
    prepareModelContext:invocationId=>bridge.modelContext(invocationId),
    selected(invocationId,line){
      const context=predictions.get(invocationId);
      demand(context,'selection has no captured public context');
      const result=commitCausalLmV8Selection(bridge,invocationId,line,{context});
      contexts.push(copy(context));predictions.delete(invocationId);return result;
    },
    dispatch:(...args)=>bridge.dispatch(...args),
    exportEpisode:()=>({public:bridge.exportEpisode(),contexts:copy(contexts)}),
    inspect:invocationId=>bridge.inner.inspect(invocationId),
    onRunnable:listener=>bridge.inner.onRunnable(invocationId=>{bridge.sync();listener(invocationId);})
  };
  for(const key of ['programs','invocations','intents','realms','sourceAvailability','closureQueue','now'])
    Object.defineProperty(host,key,{get:()=>bridge.inner[key]});
  for(const name of ['cancelInvocation','enqueueClosure','nextReadyInvocation','waitForActivity','wake',
    'restoreSource','recordModelContext'])host[name]=(...args)=>{
      const result=bridge.inner[name](...args);bridge.sync();return result;
    };
  return host;
}

/** No source-success claim is made here: the public machine checks values and
 * transitions; a separate private scorer checks correspondence after rollout. */
export class RegionSelectedModelDriver extends SelectedExecutionDriver {
  constructor({select,harness=new RegionExecutionHarness(),maxSelections=4096,maxOutstanding=64,
      maxStaleRetries=8,origin='model',checkpointIdentity=null,tokenizerIdentity=null,nativeIdentity=null,
      trainingIdentity=nativeIdentity?.trainingIdentity??null,
      hostLimits=null,automaticDelivery=null,signal=null,recovery=null,
      serviceAdmission=null,serviceAdmissionCoordinator=null}={}){
    demand(typeof select==='function'&&['model','engineering'].includes(origin),'selector and explicit origin required');
    if(origin==='model')demand(typeof select.commit==='function'&&HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??''),
      'model selections require pinned identities and native commit acknowledgments');
    demand(trainingIdentity===null||HASH.test(trainingIdentity),'invalid expected training-lineage identity');
    demand(nativeIdentity===null||(nativeIdentity.trainingIdentity??null)===trainingIdentity,
      'native identity differs from the expected training lineage');
    demand(recovery===null||recoveryTickets.has(recovery),'driver recovery must pass verified restoration');
    const admissionPolicy=serviceAdmissionCoordinator===null?null:
      admissionCoordinatorPolicy(serviceAdmissionCoordinator,harness.inner.sessionId,serviceAdmission);
    demand(serviceAdmission===null||isDeepStrictEqual(serviceAdmission,admissionPolicy),
      'configured service admission requires its independently owned coordinator');
    const retainedHostLimits={maxGenerated:harness.inner.maxGenerated,maxOutstanding:harness.inner.maxOutstanding};
    demand(hostLimits===null||isDeepStrictEqual(hostLimits,retainedHostLimits),
      'host continuation limits differ from the externally expected execution policy');
    const retainedAutomaticDelivery=harness.inner.automaticDelivery;
    demand(automaticDelivery===null||automaticDelivery===retainedAutomaticDelivery,
      'host callback delivery differs from the externally expected execution policy');
    const contexts=copy(recovery?.contexts??[]),predictions=new Map(),attempts=copy(recovery?.attempts??[]),acknowledged=new Map();
    for(const attempt of attempts)if(attempt.status==='accepted')
      acknowledged.set(attempt.invocationId,{record:attempt.record,selection:copy(attempt.selection)});
    let driver,queue=Promise.resolve(),releaseActive=null,fatal=null,automaticHistory=null,
      activeSelection=null,activeAcknowledgement=null,
      cancellationPromise=null,
      serviceFenceFailure=null,terminalCancellationRequest=null,
      terminalCancel=null,terminalCancellationError=null,
      staleRetries=recovery?.staleRetries??0;
    const acquire=async()=>{
      const previous=queue;let release;queue=new Promise(resolve=>{release=resolve;});
      await previous;if(fatal){release();throw fatal;}return release;
    };
    const release=()=>{releaseActive?.();releaseActive=null;};
    const packet=invocationId=>({session:harness.inner.sessionId,public:harness.exportEpisode(),
      contexts:copy(contexts),invocationId});
    const selected=async previous=>{
      const unlock=await acquire();releaseActive=unlock;
      let selectionSettled;activeSelection=new Promise(resolve=>{selectionSettled=resolve;});
      let attempt;
      try{
        demand(attempts.length<maxSelections,'global prediction budget exhausted');
        const invocationId=previous.context.invocationId,current=driver.prefix(invocationId);
        predictions.set(invocationId,copy(current.context));
        attempt={attempt:attempts.length,invocationId,context:copy(current.context),
          prefixDigest:current.context.prefixDigest,status:'submitted',record:null,selection:null,
          rawPayloadHex:null,completeRecord:false,generationMs:null,commitMs:null,failure:null};
        attempts.push(attempt);const start=performance.now();let output;
        try{output=await select({...current,attempt:attempt.attempt});}
        finally{attempt.generationMs=performance.now()-start;}
        const record=typeof output==='string'?output:output?.record,selection=output?.selection??null;
        attempt.record=typeof record==='string'?record:null;attempt.selection=copy(selection);
        if(attempt.record!==null)attempt.rawPayloadHex=Buffer.from(attempt.record,'utf8').toString('hex');
        if(origin==='model')demand(selection?.modelSelected===true&&selection.origin==='actual-model-selected',
          'model experiment requires original model selection provenance');
        demand(typeof record==='string','one original canonical v8 record required');
        if(origin==='model')demand(boundSelection(record,selection,current.context,checkpointIdentity,tokenizerIdentity,trainingIdentity),
          'selected bytes, model identity or causal provenance differ from the frozen invocation');
        attempt.provenanceValidated=origin==='model';
        decodeCausalLmV8Target(record);attempt.completeRecord=true;attempt.status='decoded';
        if(fatal)throw fatal;
        return {record,selection};
      }catch(error){
        if(attempt){attempt.status='rejected';attempt.failure=String(error.message);
          if(error.evidence){attempt.evidence=copy(error.evidence);
            // A transport can reject malformed output before returning it. Keep
            // those original bytes and token costs as failures, never repairs.
            if(attempt.record===null&&(typeof error.evidence.record==='string'||typeof error.evidence.rawPayloadHex==='string')){
              attempt.record=typeof error.evidence.record==='string'?error.evidence.record:null;
              attempt.selection=copy(error.evidence.selection??null);
              attempt.rawPayloadHex=typeof error.evidence.rawPayloadHex==='string'?error.evidence.rawPayloadHex:
                Buffer.from(attempt.record,'utf8').toString('hex');
              const bound=attempt.record!==null?boundSelection(attempt.record,attempt.selection,
                attempt.context,checkpointIdentity,tokenizerIdentity,trainingIdentity):
                boundPayload(attempt.rawPayloadHex,attempt.selection,attempt.context,checkpointIdentity,tokenizerIdentity,trainingIdentity)&&
                  attempt.selection.session===harness.inner.sessionId&&attempt.selection.invocationId===attempt.invocationId;
              attempt.provenanceValidated=origin==='model'&&error.evidence.schema==='semantic-native-selection-failure/1'&&
                error.evidence.provenanceValidated===true&&bound;
            }
          }}
        predictions.delete(previous.context.invocationId);fatal=error;release();throw error;
      }finally{activeSelection=null;selectionSettled();}
    };
    const onCommitted=async({invocationId,record,selection})=>{
      const attempt=attempts.at(-1),start=performance.now();
      attempt.status='acknowledging';let nativeAcknowledged=false;
      let acknowledgementSettled;activeAcknowledgement=new Promise(resolve=>{acknowledgementSettled=resolve;});
      try{
        if(typeof select.commit==='function'){
          const receipt=await select.commit({...packet(invocationId),record,selection:copy(selection)});
          demand(receipt?.committed===true,'native model did not acknowledge the selected record');
          attempt.commitReceipt=copy(receipt);
        }else demand(origin==='engineering'&&!selection?.modelSelected,'model selection lacks a native acknowledgement');
        acknowledged.set(invocationId,{record,selection:copy(selection)});
        attempt.status='accepted';attempt.commitMs=performance.now()-start;nativeAcknowledged=true;
        if(fatal)throw fatal;
        // Keep the selection lock until both the complete cut and its externally
        // retained head are acknowledged. The caller cannot dispatch a request
        // or expose the next selected transition before this returns.
        await persistAutomaticHistory();
      }catch(error){
        // Storage failure does not undo an actual native acknowledgement. Its
        // final outcome may be recoverable from the application's trusted head.
        if(!nativeAcknowledged){
          if(attempt.status!=='acknowledgement-unknown')
            attempt.status=error.acknowledgementUnknown?'acknowledgement-unknown':'commit-failed';
          attempt.failure=String(error.message);
        }
        fatal=error;throw error;
      }finally{
        if(attempt.commitMs===null)attempt.commitMs=performance.now()-start;
        activeAcknowledgement=null;release();acknowledgementSettled();
      }
    };
    const onRejected=async({invocationId,selection,error})=>{
      const attempt=attempts.at(-1);
      // Only a refused preflight can retry. An acknowledgement failure occurs
      // after local commitment and must stop even if it names a stale context.
      if(error.category!=='causal-lm-stale-context'||attempt?.status!=='decoded'||!predictions.has(invocationId))return false;
      if(staleRetries>=maxStaleRetries){
        const exhausted=new RangeError('Selected v8: stale prediction retry budget exhausted');
        exhausted.category='causal-lm-stale-retry-budget';attempt.status='stale-limit';attempt.failure=exhausted.message;
        throw exhausted;
      }
      attempt.status='stale';attempt.failure=String(error.message);
      predictions.delete(invocationId);staleRetries++;
      let rejectionSettled;activeAcknowledgement=new Promise(resolve=>{rejectionSettled=resolve;});
      try{
        if(selection?.modelSelected)demand(typeof select.reject==='function','native stale prediction requires rejection acknowledgement');
        await select.reject?.({session:harness.inner.sessionId,selectionId:selection?.selectionId,
          reason:error.message});
        await persistAutomaticHistory();
        return true;
      }catch(error){fatal=error;throw error;}
      finally{activeAcknowledgement=null;release();rejectionSettled();}
    };
    selected.complete=async previous=>{
      const invocationId=previous.context.invocationId,unlock=await acquire();
      let completionSettled;activeAcknowledgement=new Promise(resolve=>{completionSettled=resolve;});
      try{
        const receipt=await select.complete?.({...packet(invocationId),
          completion:copy(harness.activation(invocationId).controller.completion)});
        await persistAutomaticHistory();return receipt;
      }
      catch(error){fatal=error;throw error;}
      finally{activeAcknowledgement=null;unlock();completionSettled();}
    };
    selected.cancel=previous=>{
      if(cancellationPromise!==null)return cancellationPromise;
      const hostCancellation=harness.inner.timeline.findLast?.(row=>row.kind==='cancel'&&
        (row.fields?.invocationId??row.invocationId)===previous.context.invocationId),
        invocationId=previous.context.invocationId,
        suppliedReason=previous.reason??hostCancellation?.fields?.reason??hostCancellation?.reason??
          driver.rejections.at(-1)?.error??'selected execution cancelled',
        reason=boundedCancellationReason(suppliedReason?.message??suppliedReason),
        settlement=activeAcknowledgement??activeSelection;
      fatal??=suppliedReason instanceof Error?suppliedReason:new Error(reason);
      terminalCancellationRequest={context:{invocationId},reason};
      if(automaticHistory===null){
        const acknowledging=attempts.findLast(row=>row.invocationId===invocationId&&row.status==='acknowledging');
        if(acknowledging)acknowledging.status='acknowledgement-unknown';
      }
      // Keep the original selection/commit outcome intact. Automatic history
      // records a request before waiting on a live model operation; the final
      // event records its settled result and the returned close receipt.
      cancellationPromise=(async()=>{
        try{
          if(terminalCancel)return await terminalCancel({invocationId,reason,settlement});
          await settlement;
          const attempt=attempts.findLast(row=>row.invocationId===invocationId&&row.status==='decoded');
          if(attempt){attempt.status='cancelled';attempt.failure=reason;}
          predictions.delete(invocationId);release();
          return await select.cancel?.({...packet(invocationId),reason});
        }catch(error){terminalCancellationError=error;throw error;}
      })();
      return cancellationPromise;
    };
    const decodeSelection=line=>{
      const decoded=decodeCausalLmV8Target(line);
      return decoded.kind==='semantic'?decoded.record:{kind:decoded.kind,fields:{}};
    };
    super({select:selected,harness:driverFacade(harness,contexts,predictions),maxSelections,maxOutstanding,
      decodeSelection,onCommitted,onRejected,prepareRequestDispatch:({invocationId,record,selection})=>{
        const checked=acknowledged.get(invocationId);
        demand(checked?.record===record&&isDeepStrictEqual(checked.selection,selection),
          'request cannot dispatch before its own selected record is acknowledged');
        return null; // The v8 acknowledgement already checked original native bytes.
      }});
    driver=this;this.bridge=harness;this.contexts=contexts;this.attempts=attempts;
    this.originalSelect=select;this.origin=origin;this.executionSignal=signal;
    const policy=Object.freeze({checkpointIdentity,tokenizerIdentity,nativeIdentity:copy(nativeIdentity),
      hostLimits:copy(retainedHostLimits),automaticDelivery:retainedAutomaticDelivery,
      maxSelections,maxOutstanding,maxStaleRetries,
      ...(admissionPolicy===null?{}:{serviceAdmission:copy(admissionPolicy)})});
    const checkpointUnlocked=async({ingressStore=null}={})=>{
      demand(origin==='model'&&typeof select.checkpoint==='function',
        'durable recovery requires a checkpoint-capable native model selector');
      // The caller owns the same lock as selection/acknowledgement, so no
      // speculative local record can enter the saved public history. Native
      // observations may arrive while the model snapshot is collected; only
      // an observed suffix beyond its acknowledged prefix is permitted.
      demand(predictions.size===0,'cannot checkpoint an uncommitted prediction');
      demand(harness.inner.maxGenerated===retainedHostLimits.maxGenerated&&
        harness.inner.maxOutstanding===retainedHostLimits.maxOutstanding&&
        harness.inner.automaticDelivery===retainedAutomaticDelivery&&
        [...harness.invocations.values()].every(row=>row.controller.maxGenerated===retainedHostLimits.maxGenerated),
        'host continuation limits changed after the driver policy was frozen');
      const native=await select.checkpoint();
      const bridge=ingressStore?await harness.checkpointDurable({ingressStore}):harness.checkpoint();
      const body={schema:'semantic-selected-driver-checkpoint/8',policy:copy(policy),
        bridge,contexts:copy(contexts),attempts:copy(attempts),staleRetries,native:copy(native)};
      const packet={...body,digest:hashAlgorithmData(body)};
      verifyDriverCheckpoint(packet,policy);return packet;
    };
    this.checkpoint=async(options={})=>{
      const unlock=await acquire();
      try{return await checkpointUnlocked(options);}finally{unlock();}
    };
    const historyUnlocked=async({journal,previous=null,ingressStore=null,
        ingressJournal=harness.inner.hostIngressBroker?.journal??null}={})=>{
      demand(typeof journal?.append==='function'&&typeof journal?.readAll==='function',
        'durable checkpoint history requires append and independent reads');
      const retainedHead=copy(previous);
      if(retainedHead!==null)validateSelectedHistoryReceipt(retainedHead);
      const earlier=retainedHead===null?[]:
        validateSelectedHistoryChain(copy(await journal.readAll(copy(retainedHead))),retainedHead);
      const checkpoint=await checkpointUnlocked({ingressStore});
      await verifyRecordedHistoryCuts([...earlier,{checkpoint}],policy,{ingressStore,ingressJournal});
      const receipt=copy(await journal.append(copy(checkpoint),{previous:copy(retainedHead)}));
      validateSelectedHistoryReceipt(receipt);
      const recorded=validateSelectedHistoryChain(copy(await journal.readAll(copy(receipt))),receipt),last=recorded.at(-1);
      demand(recorded.length===earlier.length+1&&isDeepStrictEqual(recorded.slice(0,-1),earlier)&&
        isDeepStrictEqual(last.previous,retainedHead)&&isDeepStrictEqual(last.checkpoint,checkpoint),
        'history journal acknowledged a different complete checkpoint');
      return {checkpoint:copy(checkpoint),receipt:copy(receipt)};
    };
    const terminalSnapshot=()=>({attempts:copy(attempts),contexts:copy(contexts),staleRetries,
      public:copy(harness.exportEpisode()),rejections:copy(driver.rejections),
      nativeMetrics:copy(select.metrics())});
    this.checkpointDurableHistory=async(options={})=>{
      const unlock=await acquire();
      try{
        demand(automaticHistory===null,'automatic history owns its acknowledged head; use flushDurableHistory');
        return await historyUnlocked(options);
      }finally{unlock();}
    };
    async function persistAutomaticHistory(state=automaticHistory){
      if(state===null)return null;
      if(fatal)throw fatal;
      demand(state.headStatus!=='failed','automatic history head acknowledgement is uncertain');
      state.headStatus='saving';
      try{
        const previous=copy(state.previous),saved=await historyUnlocked(state);
        const acknowledgedHead=await state.acknowledge({receipt:copy(saved.receipt),previous});
        validateSelectedHistoryReceipt(acknowledgedHead);
        demand(isDeepStrictEqual(acknowledgedHead,saved.receipt),
          'automatic history acknowledgement differs from the recorded cut');
        state.previous=copy(saved.receipt);state.headStatus='acknowledged';
        if(fatal)throw fatal;
        return saved;
      }catch(error){
        if(state.headStatus==='saving'){state.headStatus='failed';state.headFailure=error;}
        throw error;
      }
    }
    const appendTerminalHistory=async({phase,invocationId,reason,requested=null,closeReceipt=null,failure=null,
        serviceFence=null}={})=>{
      const state=automaticHistory;
      demand(state!==null,'durable terminal cancellation requires automatic history');
      demand(state.headStatus==='acknowledged','cannot extend an unacknowledged or uncertain history head');
      state.headStatus='saving';
      try{
        const previous=copy(state.previous);validateSelectedHistoryReceipt(previous);
        const earlier=validateSelectedHistoryChain(copy(await state.journal.readAll(copy(previous))),previous),
          last=earlier.at(-1),checkpoint=copy(last.checkpoint),snapshot=terminalSnapshot(),
          session=harness.inner.sessionId,
          terminalId=hashAlgorithmData({schema:'semantic-selected-terminal/1',session,invocationId,reason,
            baseCheckpointDigest:checkpoint.digest}),
          terminal={schema:'semantic-selected-terminal-event/1',terminalId,phase,session,invocationId,reason,
            baseCheckpointDigest:checkpoint.digest,snapshot,snapshotDigest:hashAlgorithmData(snapshot)};
        if(admissionPolicy!==null){
          validateServiceAdmissionFence(serviceFence,admissionPolicy,reason);
          terminal.serviceAdmission=copy(serviceFence);
        }
        if(phase==='closed')terminal.closeReceipt=copy(closeReceipt);
        else if(phase==='unknown')terminal.failure=
          String(failure?.message??failure??'Native close outcome unavailable').slice(0,4096)||
            'Native close outcome unavailable';
        if(requested)demand(last.terminal?.phase==='requested'&&last.terminal.terminalId===requested.terminalId,
          'terminal outcome has no independently acknowledged request');
        else demand(!last.terminal,'history already has a terminal disposition');
        const receipt=copy(await state.journal.append(checkpoint,{previous,terminal}));
        validateSelectedHistoryReceipt(receipt);
        const recorded=validateSelectedHistoryChain(copy(await state.journal.readAll(copy(receipt))),receipt),
          saved=recorded.at(-1);
        demand(recorded.length===earlier.length+1&&isDeepStrictEqual(recorded.slice(0,-1),earlier)&&
          isDeepStrictEqual(saved.previous,previous)&&isDeepStrictEqual(saved.checkpoint,checkpoint)&&
          isDeepStrictEqual(saved.terminal,terminal),
          'terminal history journal acknowledged a different cancellation event');
        await verifyRecordedHistoryCuts(recorded,policy,{ingressStore:state.ingressStore,
          ingressJournal:state.ingressJournal});
        const acknowledgedHead=await state.acknowledge({receipt:copy(receipt),previous:copy(previous)});
        validateSelectedHistoryReceipt(acknowledgedHead);
        demand(isDeepStrictEqual(acknowledgedHead,receipt),
          'terminal history acknowledgement differs from the recorded disposition');
        state.previous=copy(receipt);state.headStatus='acknowledged';
        return {receipt:copy(receipt),terminal:copy(terminal)};
      }catch(error){
        if(state.headStatus==='saving'){state.headStatus='failed';state.headFailure=error;}
        throw error;
      }
    };
    const terminalDisposition=(terminal,receipt)=>({schema:'semantic-selected-terminal-disposition/1',
      phase:terminal.phase,status:terminal.phase,terminalId:terminal.terminalId,session:terminal.session,
      invocationId:terminal.invocationId,reason:terminal.reason,historyReceipt:copy(receipt),
      snapshotDigest:terminal.snapshotDigest,
      ...(terminal.serviceAdmission?{serviceAdmission:copy(terminal.serviceAdmission)}:{}),
      ...(terminal.phase==='closed'?{closeReceipt:copy(terminal.closeReceipt)}:{}),
      ...(terminal.phase==='unknown'?{failure:terminal.failure}:{})});
    terminalCancel=async({invocationId,reason,settlement})=>{
      const state=automaticHistory;
      // Fatal selection admission is already closed synchronously by cancel().
      // Fence every declared service before publishing even a requested terminal
      // cut. Partial service failure cannot become an acknowledged history fence.
      let serviceFence=null;
      if(admissionPolicy!==null){
        try{
          serviceFence=copy(await serviceAdmissionCoordinator.terminate({sessionId:harness.inner.sessionId,reason}));
          validateServiceAdmissionFence(serviceFence,admissionPolicy,reason);
          const verified=await serviceAdmissionCoordinator.verify(copy(serviceFence));
          demand(isDeepStrictEqual(verified,serviceFence),'service admission acknowledged a different fence');
        }catch(error){serviceFenceFailure=error;throw error;}
      }
      if(!state){
        await settlement;
        const attempt=attempts.findLast(row=>row.invocationId===invocationId&&row.status==='decoded');
        if(attempt){attempt.status='cancelled';attempt.failure=reason;}
        predictions.delete(invocationId);release();
        return select.cancel?.({...packet(invocationId),reason});
      }
      // A concurrent regular cut must settle first. If it fails or its head
      // acknowledgement is lost, no later terminal event may guess a head.
      if(state.headStatus==='saving'){
        await settlement;
        demand(state.headStatus==='acknowledged','previous automatic history acknowledgement is uncertain');
        settlement=activeAcknowledgement??activeSelection;
      }
      demand(state.headStatus==='acknowledged','previous automatic history acknowledgement is uncertain');
      const requestedCut=await appendTerminalHistory({phase:'requested',invocationId,reason,serviceFence});
      await settlement;
      predictions.delete(invocationId);release();
      const attempt=attempts.findLast(row=>row.invocationId===invocationId&&row.status==='decoded');
      let closeReceipt;
      try{
        closeReceipt=await select.cancel?.({...packet(invocationId),reason});
        demand(closeReceipt?.schema==='semantic-native-close/8'&&closeReceipt.closed===true&&
          closeReceipt.session===harness.inner.sessionId&&closeReceipt.reason===reason,
          'native selector did not return a positive close receipt for this terminal reason');
      }catch(error){
        try{
          const final=await appendTerminalHistory({phase:'unknown',invocationId,reason,requested:requestedCut.terminal,
            failure:String(error?.message??error),serviceFence});
          return terminalDisposition(final.terminal,final.receipt);
        }catch(persistError){
          if(error&&typeof error==='object')error.terminalPersistenceError=String(persistError?.message??persistError);
          throw error;
        }
      }
      if(attempt){attempt.status='cancelled';attempt.failure=reason;}
      const final=await appendTerminalHistory({phase:'closed',invocationId,reason,requested:requestedCut.terminal,
        closeReceipt,serviceFence});
      return terminalDisposition(final.terminal,final.receipt);
    };
    Object.defineProperty(this,'historyReceipt',{enumerable:true,get:()=>copy(automaticHistory?.previous??null)});
    Object.defineProperty(this,'terminalCancellation',{enumerable:true,get:()=>cancellationPromise});
    Object.defineProperty(this,'terminalCancellationError',{enumerable:true,get:()=>terminalCancellationError});
    this.retryServiceAdmissionCancellation=()=>{
      demand(serviceFenceFailure!==null&&terminalCancellationError!==null&&terminalCancellationRequest!==null,
        'only an unacknowledged service fence can retry its original cancellation');
      // This failure occurred before any terminal history append or native
      // close. Reuse its exact original reason; never retry a lost history head.
      serviceFenceFailure=null;terminalCancellationError=null;cancellationPromise=null;
      return selected.cancel(copy(terminalCancellationRequest));
    };
    this.enableDurableHistory=async({acknowledge,journal,previous=null,ingressStore=null,
        ingressJournal=harness.inner.hostIngressBroker?.journal??null}={})=>{
      demand(typeof acknowledge==='function','automatic history requires independent durable head acknowledgement');
      demand(typeof select.metrics==='function','automatic history requires live native attempt and cost metrics');
      const unlock=await acquire();
      try{
        demand(automaticHistory===null,'automatic history is already enabled');
        demand(!driver.running.size&&predictions.size===0,'enable automatic history before execution starts');
        if(admissionPolicy!==null)demand(isDeepStrictEqual(await serviceAdmissionCoordinator.assertActive(),admissionPolicy),
          'service admission did not acknowledge the active policy');
        const state={acknowledge,journal,previous:copy(previous),ingressStore,ingressJournal,
          headStatus:'idle',headFailure:null};
        try{
          const saved=await persistAutomaticHistory(state);automaticHistory=state;return saved;
        }catch(error){fatal=error;throw error;}
      }finally{unlock();}
    };
    this.flushDurableHistory=async()=>{
      const unlock=await acquire();
      try{
        demand(automaticHistory!==null,'automatic history is not enabled');
        try{return await persistAutomaticHistory();}catch(error){fatal=error;throw error;}
      }finally{unlock();}
    };
  }
  static async restoreLatest(packet,{historyJournal,historyReceipt,select,policy,harnessOptions={},signal=null,
      serviceAdmissionCoordinator=null}={}){
    demand(typeof historyJournal?.readAll==='function','independently read checkpoint history is required');
    stableAlgorithmJSON(packet);
    const saved=copy(packet),retainedHead=copy(historyReceipt);
    validateSelectedHistoryReceipt(retainedHead);
    const entries=validateSelectedHistoryChain(copy(await historyJournal.readAll(copy(retainedHead))),retainedHead);
    demand(entries.some(entry=>isDeepStrictEqual(entry.checkpoint,saved)),
      'supplied checkpoint is absent from the independently retained history');
    await verifyRecordedHistoryCuts(entries,policy,harnessOptions);
    const terminal=entries.at(-1).terminal;
    if(terminal){
      await verifyTerminalServiceAdmission(terminal,policy,serviceAdmissionCoordinator);
      return {schema:'semantic-selected-terminal-disposition/1',phase:terminal.phase,status:terminal.phase,
      terminalId:terminal.terminalId,session:terminal.session,invocationId:terminal.invocationId,
      reason:terminal.reason,historyReceipt:copy(retainedHead),snapshotDigest:terminal.snapshotDigest,
      ...(terminal.serviceAdmission?{serviceAdmission:copy(terminal.serviceAdmission)}:{}),
      ...(terminal.phase==='closed'?{closeReceipt:copy(terminal.closeReceipt)}:{}),
      ...(terminal.phase==='unknown'?{failure:terminal.failure}:{})};
    }
    const latest=entries.at(-1).checkpoint,options={...harnessOptions};
    // A history receipt independently binds its recorded ingress receipts.
    // An explicitly supplied newer ingress head still undergoes the existing
    // prefix/owner checks and may refuse an unsaved later public boundary.
    if(!Object.hasOwn(options,'ingressReceipt'))options.ingressReceipt=latest.bridge.ingress??null;
    if(!Object.hasOwn(options,'ingressLogReceipt'))options.ingressLogReceipt=latest.bridge.ingressLog??null;
    if(!latest.bridge.ingressLog&&!options.ingressLogReceipt)delete options.ingressJournal;
    return this.restore(latest,{select,policy,harnessOptions:options,signal,serviceAdmissionCoordinator});
  }
  static async restore(packet,{select,policy,harnessOptions={},signal=null,serviceAdmissionCoordinator=null}={}){
    demand(typeof select==='function'&&typeof select.restore==='function'&&typeof select.checkpoint==='function',
      'fresh native model transport with checkpoint/restore is required');
    stableAlgorithmJSON(packet);
    const saved=copy(packet);verifyDriverCheckpoint(saved,policy);
    if(saved.policy.serviceAdmission){
      admissionCoordinatorPolicy(serviceAdmissionCoordinator,saved.bridge.public.timeline[0].fields.session,
        saved.policy.serviceAdmission);
      demand(isDeepStrictEqual(await serviceAdmissionCoordinator.assertActive(),saved.policy.serviceAdmission),
        'service admission did not acknowledge the active recovery policy');
    }
    else demand(serviceAdmissionCoordinator===null,'unfenced checkpoint cannot acquire a service admission claim on restore');
    // Restore host ownership before opening native model state. Neither step
    // dispatches a request or re-registers an existing callback. Unknown host
    // outcomes remain uncertain and require an explicit broker receipt.
    const harness=saved.bridge.ingress||saved.bridge.ingressLog||harnessOptions.ingressReceipt||harnessOptions.ingressJournal||harnessOptions.ingressLogReceipt?
      await RegionExecutionHarness.restoreDurable(saved.bridge,harnessOptions):
      RegionExecutionHarness.restore(saved.bridge,harnessOptions);
    verifyRestoredHostLimits(harness,policy);
    try{
      const receipt=await select.restore({checkpoint:saved.native});
      demand(receipt?.restored===true&&receipt.transportCheckpointDigest===saved.native.digest&&
        receipt.hostDispatches===0,'native restoration did not attest this checkpoint without host dispatch');
      const recovery={contexts:saved.contexts,attempts:saved.attempts,staleRetries:saved.staleRetries};
      recoveryTickets.add(recovery);
      const driver=new RegionSelectedModelDriver({select,harness,...saved.policy,origin:'model',signal,recovery,
        serviceAdmissionCoordinator});
      recoveryTickets.delete(recovery);return driver;
    }catch(error){select.close?.();throw error;}
  }
  runInvocation(invocationId,{signal=this.executionSignal??null}={}){
    return super.runInvocation(invocationId,{signal});
  }
  prefix(invocationId){
    return {session:this.bridge.inner.sessionId,public:this.bridge.exportEpisode(),
      contexts:copy(this.contexts),context:this.bridge.modelContext(invocationId)};
  }
  metrics(){
    const rows=this.attempts,knownTokens=row=>originalFragments(attemptPayload(row),row.selection)&&
      (this.origin==='engineering'||row.provenanceValidated),
      tokenCount=row=>row.selection.fragments.reduce((total,fragment)=>total+fragment.tokenIds.length,0);
    return {predictionAttempts:rows.length,accepted:rows.filter(row=>row.status==='accepted').length,
      rejected:rows.filter(row=>!['accepted','submitted','decoded','acknowledging','acknowledgement-unknown'].includes(row.status)).length,
      unknownAcknowledgements:rows.filter(row=>row.status==='acknowledgement-unknown').length,
      staleRetries:rows.filter(row=>row.status==='stale').length,
      stalePredictions:rows.filter(row=>['stale','stale-limit'].includes(row.status)).length,
      generatedBytes:rows.reduce((sum,row)=>sum+(attemptPayload(row)?.length??0)/2,0),
      generatedTokens:rows.filter(knownTokens).reduce((sum,row)=>sum+tokenCount(row),0),
      unverifiedClaimedTokens:rows.filter(row=>originalFragments(attemptPayload(row),row.selection)&&!knownTokens(row))
        .reduce((sum,row)=>sum+tokenCount(row),0),
      unknownGenerationCostAttempts:rows.filter(row=>!knownTokens(row)).length,
      generationMs:rows.reduce((sum,row)=>sum+(row.generationMs??0),0),
      commitMs:rows.reduce((sum,row)=>sum+(row.commitMs??0),0),
      nativeAdmissionClaim:false,sourceAdmissionClaim:false};
  }
}

/** The initial prefix contains only host-published definitions and input.
 * Fixture replies and callbacks are supplied only when the selected request
 * reaches the ordinary broker; none are included in a model request. */
export async function runSelectedRegionExecution({initialPublic,fixture={calls:[]},select,
    checkpointIdentity,tokenizerIdentity,trainingIdentity=null,seed=17,origin='model',maxPredictions=4096,
    maxGenerated=16384,maxStaleRetries=8,maxOutstanding=64,timeoutMs=15000,generationSettings=null}={}){
  demand(HASH.test(checkpointIdentity??'')&&HASH.test(tokenizerIdentity??'')&&
    (trainingIdentity===null||HASH.test(trainingIdentity))&&
    Number.isSafeInteger(seed)&&seed>=0,'frozen checkpoint, tokenizer and seed required');
  demand(positive(maxPredictions,100000)&&positive(maxGenerated,1000000)&&positive(maxOutstanding,1024)&&
    positive(timeoutMs,300000)&&Number.isSafeInteger(maxStaleRetries)&&maxStaleRetries>=0&&maxStaleRetries<=1000,
    'explicit bounded execution limits required');
  demand(typeof select==='function'&&typeof select.initialize==='function','an attested selector is required');
  demand(origin!=='model'||generationSettings&&typeof generationSettings==='object'&&!Array.isArray(generationSettings),
    'model execution requires frozen generation settings');
  const requestedSettings=copy(generationSettings);
  demand(initialPublic?.schema==='semantic-execution/8'&&initialPublic.timeline?.length>=2&&
    initialPublic.timeline.every(row=>row.mode==='observed'&&['program','invocation'].includes(row.kind)),
    'initial prefix may contain only published source and invocation input');
  demand(initialPublic.timeline.filter(row=>row.kind==='invocation').length===1,'one initial invocation is supported');
  const harness=RegionExecutionHarness.replay(copy(initialPublic),{requireTerminal:false}),
    broker=createFixtureBroker(copy(fixture)),contextsBefore=select.metrics?.()??null;
  harness.inner.automaticDelivery=true;harness.inner.maxGenerated=maxGenerated;
  harness.inner.maxOutstanding=maxOutstanding;
  for(const activation of harness.invocations.values())activation.controller.maxGenerated=maxGenerated;
  let calls=0;
  for(const operation of [...new Set(fixture.calls.map(call=>call.operation))])harness.inner.services[operation]=(args,meta)=>{
    calls++;const spec=hostOperation(operation),result=broker.invoke(operation,args.map((arg,index)=>
      spec.callbackIndices.includes(index)?meta.callback(index):arg));
    if(['demo.unlisten','dom.off','dom.stopTimer'].includes(operation))return Promise.resolve(result)
      .then(value=>{meta.closeSubscription(args[0]);return value;});
    return result;
  };
  const abort=new AbortController(),driver=new RegionSelectedModelDriver({select,harness,
    maxSelections:maxPredictions,maxStaleRetries,maxOutstanding,origin,checkpointIdentity,tokenizerIdentity,
    trainingIdentity,signal:abort.signal}),
    invocationId=initialPublic.timeline.find(row=>row.kind==='invocation').fields.invocationId,
    started=performance.now();
  let inferenceIdentity=null,initializationTask=null,failure=null,cleanupFailure=null,outcome=null,deadlineExceeded=false;
  let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
  const onAbort=()=>rejectAbort(abort.signal.reason);abort.signal.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>{deadlineExceeded=true;abort.abort(new Error('Selected v8 execution deadline exceeded'));},timeoutMs);
  try{
    initializationTask=Promise.resolve().then(()=>select.initialize({seed,checkpointIdentity,tokenizerIdentity,trainingIdentity}));
    inferenceIdentity=copy(await Promise.race([initializationTask,aborted]));
    demand(inferenceIdentity?.checkpointIdentity===checkpointIdentity&&inferenceIdentity.tokenizerIdentity===tokenizerIdentity&&
      (inferenceIdentity.trainingIdentity??null)===trainingIdentity&&
      inferenceIdentity.seed===seed,'selector attestation differs from the frozen experiment');
    if(origin==='model')demand(isDeepStrictEqual(inferenceIdentity.generationSettings,requestedSettings),
      'loaded generation settings differ from the frozen experiment');
    outcome=await driver.runInvocation(invocationId,{signal:abort.signal});
    if(outcome.taskCompletion)outcome=await outcome.taskCompletion;
    await Promise.all([...driver.running.values()].map(row=>row.task));
    broker.finish();
  }catch(error){failure={category:error.category??error.name,message:String(error.message),evidence:copy(error.evidence??null)};}
  finally{
    if(driver.running.size&&!abort.signal.aborted)abort.abort(new Error('Selected v8 execution closed'));
    clearTimeout(timer);abort.signal.removeEventListener('abort',onAbort);driver.close();broker.abort();
    await Promise.allSettled([...driver.running.values()].map(row=>row.task));
    let cleanupTimer;
    try{await Promise.race([(async()=>{
      // Initialization and selection/acknowledgement have the same ownership
      // rule: graceful cancellation cannot race a late native response.
      try{await initializationTask;}catch{/* Preserve the original failure. */}
      return driver.select.cancel({context:{invocationId},reason:failure?'failed':'completed'});
    })(),new Promise((_,reject)=>{
        cleanupTimer=setTimeout(()=>reject(new Error('Selected v8 cleanup deadline exceeded')),Math.min(timeoutMs,1000));
      })]);}
    catch(error){cleanupFailure={category:error.category??error.name,message:String(error.message)};
      failure??=cleanupFailure;
      // A bounded graceful shutdown may expire while native work never settles.
      // Closing the transport invalidates late identities and releases resources.
      try{select.close?.();}catch{/* Preserve the cleanup failure. */}
    }
    finally{clearTimeout(cleanupTimer);}
  }
  const publicData=harness.exportEpisode(),controllers=[...harness.invocations.values()],
    publicCompleted=!failure&&controllers.every(row=>row.status==='completed'),
    firstViolation=controllers.map(row=>row.controller.firstWitnessViolation).find(Boolean)??null;
  if(publicCompleted)RegionExecutionHarness.replay(publicData);
  const result={schema:'semantic-selected-execution-result/8',origin,checkpointIdentity,tokenizerIdentity,trainingIdentity,seed,
    generationSettings:requestedSettings,
    inferenceIdentity,status:failure?(failure.message.includes('budget')||deadlineExceeded?'resource_limited':'failed'):
      publicCompleted?'completed':'incomplete',publicAccepted:!firstViolation&&!failure,publicCompleted,
    sourceValidated:false,sourceStatus:'unmeasured',completedExecution:false,
    public:publicData,contexts:copy(driver.contexts),attempts:copy(driver.attempts),
    completion:copy(harness.activation(invocationId).controller.completion??null),
    effects:copy(broker.receipts),failure,cleanupFailure,rejections:copy(driver.rejections),firstViolation:copy(firstViolation),
    costs:{...driver.metrics(),elapsedMs:performance.now()-started,hostDispatches:calls},
    nativeMetricsBefore:contextsBefore,nativeMetricsAfter:select.metrics?.()??null,
    optimizerSteps:0,qualification:{modelMeasurement:origin==='engineering'?'engineering-only':
      driver.attempts.some(row=>row.provenanceValidated)?'actual-model-selected':'unmeasured',
      sourceCorrespondence:'not-checked-by-public-replay',defaultPromotion:false}};
  return {...result,digest:hashAlgorithmData(result)};
}
