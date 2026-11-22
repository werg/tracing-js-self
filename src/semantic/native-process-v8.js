// Opt-in transport for the independent native v8 model. Only public execution
// prefixes cross this boundary; source evidence and expected answers do not.
import {spawn} from 'node:child_process';
import {TextDecoder} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {decodeCausalLmV8Target,validateRegionContext} from './causal-lm-v8.js';
import {attachNativeV8OrchestrationTransport} from './native-orchestration-transport-v8.js';
import {verifyNativeV8DurableCommit} from './native-durable-commit-v8.js';
import {assertDurableNativeV8RequestJournal} from '../storage/native-request-journal-v8.js';
import {assertSelectedOrchestrationExecutionLease,claimSelectedOrchestrationExecutionLeaseForNative}
  from '../storage/selected-orchestration-execution-lock.js';

const HASH=/^[a-f0-9]{64}$/;
const copy=structuredClone;
const demand=(condition,message)=>{if(!condition)throw new TypeError('Native v8: '+message);};
const bounded=(value,minimum,maximum)=>Number.isSafeInteger(value)&&value>=minimum&&value<=maximum;

export function createNativeV8ProcessSelector({command,args=[],cwd,env,
    timeoutMs=30000,maxMessageBytes=16*1024*1024,durableRequests=null}={}){
  demand(typeof command==='string'&&command.length>0,'model executable required');
  demand(Array.isArray(args)&&args.every(value=>typeof value==='string'),'invalid executable arguments');
  demand(bounded(timeoutMs,1,300000)&&bounded(maxMessageBytes,1024,64*1024*1024),'invalid transport bounds');
  const durable=durableRequests===null?null:{
    journal:assertDurableNativeV8RequestJournal(durableRequests.journal),
    lease:assertSelectedOrchestrationExecutionLease(durableRequests.executionLease,{
      sessionId:durableRequests.journal?.sessionId,streamId:durableRequests.journal?.streamId})};
  const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe',
    ...(durable?[claimSelectedOrchestrationExecutionLeaseForNative(durable.lease)]:[])],shell:false,windowsHide:true});
  const utf8=new TextDecoder('utf-8',{fatal:true}),pending=new Map(),sessions=new Map(),attempts=[];
  const runtimeMetrics={rpcCalls:0,computeSeconds:0,peakMemoryBytes:0};
  let nextId=0,buffer=Buffer.alloc(0),stderr='',closed=false,identity=null,epoch=0,shutdownPromise=null;
  let requestBusy=false,nextOrdinal=0,lastDurableRequest=null;
  const stop=error=>{
    if(closed)return;
    closed=true;identity=null;epoch++;
    for(const attempt of attempts)if(attempt.status==='acknowledging'){
      attempt.status='acknowledgement-unknown';attempt.failure=String(error.message);
    }
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}
    pending.clear();child.stdin.destroy();child.kill();
  };
  child.once('error',stop);
  child.once('exit',(code,signal)=>stop(new Error('Native v8 model exited '+String(code??signal)+
    (stderr?' (stderr: '+stderr.slice(-1000)+')':''))));
  child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-4096);});
  child.stdout.on('data',chunk=>{
    if(closed)return;
    buffer=Buffer.concat([buffer,chunk]);
    for(;;){
      const end=buffer.indexOf(10);
      if(end<0){if(buffer.length>maxMessageBytes)stop(new Error('Native v8 response exceeds byte limit'));return;}
      if(end>maxMessageBytes){stop(new Error('Native v8 response exceeds byte limit'));return;}
      let response;
      try{response=JSON.parse(utf8.decode(buffer.subarray(0,end)));}
      catch{stop(new Error('Native v8 response is not exact UTF-8 JSON'));return;}
      buffer=buffer.subarray(end+1);
      const item=pending.get(response?.id);
      if(!item){stop(new Error('Native v8 response has no matching request'));return;}
      if(response.runtimeMetrics!==undefined){
        const metrics=response.runtimeMetrics;
        if(metrics?.schema!=='semantic-inference-metrics/8'||
          ![metrics.computeSeconds,metrics.peakMemoryBytes].every(value=>Number.isFinite(value)&&value>=0)){
          stop(new Error('Native v8 response contains invalid measured costs'));return;
        }
        runtimeMetrics.rpcCalls++;runtimeMetrics.computeSeconds+=metrics.computeSeconds;
        runtimeMetrics.peakMemoryBytes=Math.max(runtimeMetrics.peakMemoryBytes,metrics.peakMemoryBytes);
      }
      clearTimeout(item.timer);pending.delete(response.id);
      if(response.ok===false){
        const error=new Error('Native v8 inference refused: '+String(response.error?.message??'unknown failure'));
        error.category=response.error?.category??'native-inference';
        error.evidence=copy(response.error?.evidence??null);
        if(response.error?.durabilityFenced===true)error.durabilityFenced=true;
        item.reject(error);
      }else if(response.ok!==true)item.reject(new Error('Native v8 response lacks success authority'));
      else item.resolve(response.result);
    }
  });
  const rawRequest=body=>{
    if(closed)return Promise.reject(new Error('Native v8 process is closed'));
    if(pending.size)return Promise.reject(new Error('Native v8 model already has an outstanding request'));
    const id='v8-'+(++nextId),line=JSON.stringify({...body,id})+'\n';
    if(Buffer.byteLength(line)>maxMessageBytes)return Promise.reject(new Error('Native v8 request exceeds byte limit'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>stop(new Error('Native v8 request deadline exceeded')),timeoutMs);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(line,error=>{if(error)stop(error);});
    });
  };
  const transportPacket=native=>{
    const {digest,...body}=native??{};
    demand(native?.schema==='semantic-model-checkpoint/8'&&
      native.equivalence==='verified-model-reexecution'&&HASH.test(digest??'')&&
      digest===hashAlgorithmData(body)&&hashAlgorithmData(native.initialization)===hashAlgorithmData(identity),
      'native session checkpoint is not bound to the attested model');
    const packet={schema:'semantic-native-transport-checkpoint/8',native:copy(native),
      identity:copy(identity),attempts:copy(attempts),runtimeMetrics:copy(runtimeMetrics)};
    return {...packet,digest:hashAlgorithmData(packet)};
  };
  const request=async body=>{
    if(requestBusy)throw new Error('Native v8 model already has an outstanding request');
    const captured=copy(body);requestBusy=true;let durableIntentStarted=false;
    try{
      if(durable)assertSelectedOrchestrationExecutionLease(durable.lease);
      if(durable&&captured.op==='initialize')demand((await durable.journal.list()).length===0,
        'existing durable requests require explicit commit recovery before initialization');
      if(!durable||!['commit','commit-orchestration'].includes(captured.op))return await rawRequest(captured);
      const {journal,lease}=durable;
      demand(identity!==null&&captured.session===journal.sessionId,'durable commit differs from execution scope');
      const checkpoint=transportPacket(await rawRequest({op:'checkpoint'}));
      const ordinal=nextOrdinal+1,requestIdentity={schema:'semantic-native-request-identity/1',
        session_id:journal.sessionId,stream_id:journal.streamId,session_generation:journal.sessionGeneration,
        ordinal,operation:captured.op,model_identity:{checkpoint:identity.checkpointIdentity,
          tokenizer:identity.tokenizerIdentity,...(identity.trainingIdentity?{training:identity.trainingIdentity}:{})}};
      const requestBase64=Buffer.from(JSON.stringify({...captured,
        id:'v8-commit-'+journal.sessionGeneration+'-'+ordinal})+'\n').toString('base64');
      const intent={identity:requestIdentity,requestBase64,checkpoint};
      const evidence=attempts.find(row=>row.session===captured.session&&
        row.selection?.selectionId===captured.selection.selectionId);
      demand(evidence,'durable commit has no matching native selection attempt');
      // Once append begins, publication may have reached durable storage even if
      // its acknowledgement is lost. Preserve identity, never invent a receipt,
      // and fence this live selector on every later error.
      evidence.durableRequestIdentity=copy(requestIdentity);
      durableIntentStarted=true;
      const receipt=await journal.append(intent);
      nextOrdinal=ordinal;lastDurableRequest=copy(receipt);
      evidence.durableRequestReceipt=copy(receipt);
      assertSelectedOrchestrationExecutionLease(lease);
      const retained=await journal.read(receipt,{latest:true});
      try{
        const result=await rawRequest({op:'durable-commit',identity:requestIdentity,requestBase64,
          preCheckpointDigest:checkpoint.native.digest});
        const verified=verifyNativeV8DurableCommit(result,retained).result;
        durableIntentStarted=false;return verified;
      }catch(error){
        // After dispatch, missing durability/poststate proof must fence every
        // later action even when the child returned an explicit error frame.
        stop(error);throw error;
      }
    }catch(error){
      if(durable&&(durableIntentStarted||error.durabilityFenced||/^NativeRequest/.test(error.category??'')))stop(error);
      throw error;
    }finally{requestBusy=false;}
  };
  const validateRequest=input=>{
    demand(identity!==null,'model has not attested its checkpoint');
    demand(input&&typeof input.session==='string'&&input.session.length>0,'session required');
    const {public:publicData,contexts,context}=input;
    validateRegionContext(context);
    demand(publicData?.schema==='semantic-execution/8'&&Array.isArray(publicData.timeline)&&
      publicData.timeline[0]?.fields?.session===input.session,'public execution session changed');
    demand(Array.isArray(contexts)&&contexts.length===publicData.timeline.filter(row=>row.mode==='generated').length,
      'prior contexts must cover only committed generated records');
    demand(context.visibleThrough===publicData.timeline.length&&
      context.prefixDigest===hashAlgorithmData(publicData.timeline),'current context is not the supplied public cutoff');
    demand(!sessions.get(input.session)?.pending,'previous native output needs a commit or cancellation');
  };
  const select=async input=>{
    demand(!requestBusy&&pending.size===0,'cannot record a selection while a native request is outstanding');
    validateRequest(input);
    const capturedEpoch=epoch,capturedIdentity=identity,contextDigest=hashAlgorithmData(input.context);
    const evidence={attempt:attempts.length,session:input.session,invocationId:input.context.invocationId,
      prefixDigest:input.context.prefixDigest,contextDigest,checkpointIdentity:identity.checkpointIdentity,
      tokenizerIdentity:identity.tokenizerIdentity,trainingIdentity:identity.trainingIdentity??null,
      status:'submitted',elapsedMs:null,selection:null,
      record:null,failure:null,failureEvidence:null};
    attempts.push(evidence);const started=performance.now();
    let output=null,provenanceValidated=false;
    try{
      output=await request({op:'select',session:input.session,public:input.public,
        contexts:input.contexts,context:input.context});
      evidence.record=typeof output?.record==='string'?output.record:null;
      evidence.selection=copy(output?.selection??null);
      demand(capturedEpoch===epoch&&identity===capturedIdentity,'checkpoint changed during selection');
      demand(output?.schema==='semantic-model-output/8'&&typeof output.record==='string',
        'model did not return a complete v8 selection');
      demand(Buffer.from(output.record,'utf8').toString('utf8')===output.record,'selected record is not exact UTF-8');
      const selection=output.selection;
      evidence.selection=copy(selection??null);
      demand(selection?.modelSelected===true&&selection.origin==='actual-model-selected'&&
        typeof selection.selectionId==='string'&&selection.selectionId.length>0&&
        selection.checkpointIdentity===identity.checkpointIdentity&&selection.tokenizerIdentity===identity.tokenizerIdentity&&
        (selection.trainingIdentity??null)===(identity.trainingIdentity??null)&&
        selection.prefixDigest===input.context.prefixDigest&&selection.contextDigest===contextDigest,
        'model selection is not bound to the frozen checkpoint and current prefix');
      demand(typeof selection.payloadHex==='string'&&/^(?:[0-9a-f]{2})+$/.test(selection.payloadHex)&&
        Buffer.from(selection.payloadHex,'hex').equals(Buffer.from(output.record,'utf8')),
        'original model bytes differ from the supplied record');
      demand(Array.isArray(selection.fragments)&&selection.fragments.length>0&&selection.fragments.every(fragment=>
        Array.isArray(fragment.tokenIds)&&fragment.tokenIds.length>0&&
        fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&typeof fragment.payloadHex==='string'&&
        /^(?:[0-9a-f]{2})*$/.test(fragment.payloadHex)),'original native fragment evidence required');
      demand(Buffer.concat(selection.fragments.map(fragment=>Buffer.from(fragment.payloadHex,'hex')))
        .equals(Buffer.from(output.record,'utf8')),'native fragments changed selected bytes');
      provenanceValidated=true;
      decodeCausalLmV8Target(output.record);
      evidence.status='decoded';
      sessions.set(input.session,{pending:{record:output.record,selection:copy(selection),contextDigest},evidence});
      return copy(output);
    }catch(error){evidence.status='failed';evidence.failure=String(error.message);
      if(output!==null)error.evidence={schema:'semantic-native-selection-failure/1',
        record:evidence.record,selection:copy(evidence.selection),provenanceValidated,
        nativeFailure:copy(error.evidence??null)};
      else if(error.evidence){
        const partial=copy(error.evidence),fragments=partial.fragments;
        const bound=partial.modelSelected===true&&partial.origin==='actual-model-selected'&&
          typeof partial.selectionId==='string'&&partial.selectionId.length>0&&
          partial.session===input.session&&partial.invocationId===input.context.invocationId&&
          partial.checkpointIdentity===capturedIdentity.checkpointIdentity&&
          partial.tokenizerIdentity===capturedIdentity.tokenizerIdentity&&
          (partial.trainingIdentity??null)===(capturedIdentity.trainingIdentity??null)&&
          partial.prefixDigest===input.context.prefixDigest&&partial.contextDigest===contextDigest&&
          typeof partial.payloadHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(partial.payloadHex)&&
          Array.isArray(fragments)&&fragments.length>0&&fragments.every(fragment=>
            Array.isArray(fragment?.tokenIds)&&fragment.tokenIds.length>0&&
            fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&
            typeof fragment.payloadHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(fragment.payloadHex))&&
          fragments.map(fragment=>fragment.payloadHex).join('')===partial.payloadHex;
        evidence.selection=partial;
        error.evidence={schema:'semantic-native-selection-failure/1',record:null,
          rawPayloadHex:typeof partial.payloadHex==='string'?partial.payloadHex:null,
          selection:partial,provenanceValidated:Boolean(bound)};
      }
      evidence.failureEvidence=copy(error.evidence??null);throw error;}
    finally{evidence.elapsedMs=performance.now()-started;}
  };
  select.initialize=async input=>{
    demand(!requestBusy&&pending.size===0,'cannot initialize while a native request is outstanding');
    demand(!durable||identity===null&&attempts.length===0&&sessions.size===0,
      'durable initialization requires a fresh transport; existing work must be reconciled');
    input=copy(input);
    const capturedEpoch=++epoch;identity=null;sessions.clear();orchestration.reset();
    demand(input&&HASH.test(input.checkpointIdentity??'')&&HASH.test(input.tokenizerIdentity??'')&&
      (input.trainingIdentity==null||HASH.test(input.trainingIdentity))&&
      Number.isSafeInteger(input.seed)&&input.seed>=0,'frozen checkpoint, tokenizer, training lineage and seed required');
    const receipt=await request({op:'initialize',seed:input.seed,
      checkpointIdentity:input.checkpointIdentity,tokenizerIdentity:input.tokenizerIdentity,
      trainingIdentity:input.trainingIdentity??null});
    demand(capturedEpoch===epoch&&receipt?.schema==='semantic-inference-identity/8'&&
      receipt.checkpointIdentity===input.checkpointIdentity&&receipt.tokenizerIdentity===input.tokenizerIdentity&&
      (receipt.trainingIdentity??null)===(input.trainingIdentity??null)&&
      receipt.seed===input.seed,'loaded model identity differs from frozen experiment');
    identity=copy(receipt);return copy(receipt);
  };
  select.commit=async input=>{
    demand(!requestBusy&&pending.size===0,'cannot commit while a native request is outstanding');
    input=copy(input);
    const session=sessions.get(input?.session),selected=session?.pending;
    demand(selected&&selected.family!=='orchestration'&&input.record===selected.record&&
      hashAlgorithmData(input.selection)===hashAlgorithmData(selected.selection),'commit changed original model selection');
    session.evidence.status='acknowledging';
    try{
      const result=await request({op:'commit',session:input.session,public:input.public,contexts:input.contexts,
        invocationId:input.invocationId,record:input.record,selection:input.selection});
      demand(result?.schema==='semantic-native-commit/8'&&result.committed===true&&
        result.selectionId===selected.selection.selectionId&&result.publicDigest===hashAlgorithmData(input.public),
        'native model did not acknowledge this exact semantic commit');
      session.evidence.status='accepted';session.pending=null;return result;
    }catch(error){
      // Closing the transport cannot tell whether the remote commit preceded
      // the lost reply. Preserve that uncertainty through later cleanup.
      session.evidence.status=closed?'acknowledgement-unknown':'commit-failed';
      if(closed)error.acknowledgementUnknown=true;
      session.evidence.failure=String(error.message);throw error;
    }
  };
  select.complete=async input=>{
    input=copy(input);
    const result=await request({op:'complete',session:input.session,public:input.public,
      contexts:input.contexts,invocationId:input.invocationId,
      ...(input.completion!==undefined?{completion:input.completion}:{})});
    const child=orchestration.verifyCompletion(input,result);
    demand(result?.schema==='semantic-native-completion/8'&&result.completed===true&&
      result.session===input.session&&result.invocationId===input.invocationId&&(result.sessionRetained===true||child)&&
      result.publicDigest===hashAlgorithmData(input.public),'native model did not acknowledge this completed invocation');
    return result;
  };
  select.reject=async input=>{
    const session=sessions.get(input?.session),selected=session?.pending;
    demand(selected&&input.selectionId===selected.selection.selectionId,
      'rejection must name the original pending native selection');
    const result=await request({op:'reject',session:input.session,selectionId:input.selectionId,reason:input.reason});
    demand(result?.schema==='semantic-native-rejection/8'&&result.rejected===true&&
      result.selectionId===selected.selection.selectionId,'native model did not acknowledge this candidate rejection');
    session.evidence.status='rejected';session.evidence.failure=input.reason??'stale prediction';
    session.pending=null;return result;
  };
  select.checkpoint=async()=>{
    demand(identity!==null,'model has not attested its checkpoint');
    return transportPacket(await request({op:'checkpoint'}));
  };
  select.recoverCommit=async({receipt}={})=>{
    demand(durable&&identity===null&&attempts.length===0&&sessions.size===0&&pending.size===0&&!requestBusy,
      'durable commit recovery requires a fresh guarded native transport');
    const captured=copy(receipt);requestBusy=true;
    try{
      assertSelectedOrchestrationExecutionLease(durable.lease);
      const intent=await durable.journal.read(captured,{latest:true});
      const value=await rawRequest({op:'recover-commit',identity:intent.identity,requestBase64:intent.requestBase64,
        preCheckpointDigest:intent.checkpoint.native.digest});
      const verified=verifyNativeV8DurableCommit(value,intent,{recovered:true});
      identity=copy(intent.checkpoint.identity);epoch++;
      orchestration.restore(verified.postCheckpoint);
      const restored=copy(intent.checkpoint.attempts),target=restored.find(row=>row.session===verified.request.session&&
        row.selection?.selectionId===verified.request.selection.selectionId);
      target.status='accepted';target.failure=null;target.durableRequestReceipt=captured;
      target.durableRequestIdentity=copy(intent.identity);
      if(verified.request.op==='commit-orchestration')target.commitReceipt=copy(verified.result);
      attempts.push(...restored);
      if(verified.request.op==='commit-orchestration')orchestration.rememberRecoveredCommit(target);
      for(const session of Object.keys(verified.postCheckpoint.sessions))sessions.set(session,{pending:null,evidence:null});
      const costs=intent.checkpoint.runtimeMetrics;
      demand(costs&&['rpcCalls','computeSeconds','peakMemoryBytes'].every(key=>Number.isFinite(costs[key])&&costs[key]>=0),
        'invalid retained native costs');
      runtimeMetrics.rpcCalls+=costs.rpcCalls;runtimeMetrics.computeSeconds+=costs.computeSeconds;
      runtimeMetrics.peakMemoryBytes=Math.max(runtimeMetrics.peakMemoryBytes,costs.peakMemoryBytes);
      nextOrdinal=intent.identity.ordinal;lastDurableRequest=captured;
      return {schema:'semantic-native-transport-commit-recovery/8',recovered:true,
        request:copy(verified.request),result:verified.result,receipt:captured,
        nativeCheckpointDigest:verified.postCheckpoint.digest,hostDispatches:0,hostRecoveryAuthorized:false};
    }catch(error){stop(error);throw error;}finally{requestBusy=false;}
  };
  select.restore=async({checkpoint}={})=>{
    demand(!durable,'guarded durable transports require explicit commit recovery');
    demand(identity===null&&attempts.length===0&&sessions.size===0&&pending.size===0&&!requestBusy,
      'restore requires a fresh native transport');
    const {digest,...body}=checkpoint??{};
    demand(checkpoint?.schema==='semantic-native-transport-checkpoint/8'&&HASH.test(digest??'')&&
      digest===hashAlgorithmData(body)&&Array.isArray(checkpoint.attempts)&&
      checkpoint.attempts.every((row,index)=>row?.attempt===index)&&
      checkpoint.native?.schema==='semantic-model-checkpoint/8'&&
      hashAlgorithmData(checkpoint.native.initialization)===hashAlgorithmData(checkpoint.identity)&&
      HASH.test(checkpoint.identity?.checkpointIdentity??'')&&HASH.test(checkpoint.identity?.tokenizerIdentity??''),
      'invalid native transport checkpoint');
    demand(checkpoint.identity.trainingIdentity==null||HASH.test(checkpoint.identity.trainingIdentity),
      'invalid retained training-lineage identity');
    const native=checkpoint.native,{digest:nativeDigest,...nativeBody}=native;
    demand(HASH.test(nativeDigest??'')&&nativeDigest===hashAlgorithmData(nativeBody)&&
      Array.isArray(native.attempts)&&native.sessions&&typeof native.sessions==='object',
      'invalid native model checkpoint');
    const costs=checkpoint.runtimeMetrics;
    demand(costs&&['rpcCalls','computeSeconds','peakMemoryBytes'].every(key=>Number.isFinite(costs[key])&&costs[key]>=0),
      'invalid retained native costs');
    try{
      const result=await request({op:'restore',checkpoint:copy(native)});
      demand(result?.schema==='semantic-model-restore/8'&&result.restored===true&&
        result.checkpointDigest===nativeDigest&&result.equivalence==='verified-model-reexecution'&&
        result.restoredSessions===Object.keys(native.sessions).length&&
        result.consumedAttempts===native.attempts.length&&result.hostDispatches===0,
        'native model did not attest exact checkpoint restoration');
      identity=copy(checkpoint.identity);epoch++;
      orchestration.restore(native);
      attempts.push(...copy(checkpoint.attempts).map(row=>['submitted','decoded'].includes(row.status)?
        {...row,status:'abandoned-on-restore',failure:'Unacknowledged candidate excluded from restored history'}:row));
      for(const session of Object.keys(native.sessions))sessions.set(session,{pending:null,evidence:null});
      runtimeMetrics.rpcCalls+=costs.rpcCalls;runtimeMetrics.computeSeconds+=costs.computeSeconds;
      runtimeMetrics.peakMemoryBytes=Math.max(runtimeMetrics.peakMemoryBytes,costs.peakMemoryBytes);
      return {...copy(result),transportCheckpointDigest:digest};
    }catch(error){stop(error);throw error;}
  };
  select.cancel=async input=>{
    demand(!requestBusy&&pending.size===0,'cannot close a session while a native request is outstanding');
    input=copy(input);
    demand(typeof input?.session==='string'&&input.session.length>0&&
      typeof input.reason==='string'&&input.reason.length<=4096,'invalid native close request');
    const session=sessions.get(input?.session);
    if(session?.pending&&!['acknowledgement-unknown','commit-failed'].includes(session.evidence.status)){
      session.evidence.status='cancelled';session.evidence.failure=input.reason??'selected session cancelled';
    }
    try{
      const result=await request({op:'cancel',session:input.session,reason:input.reason});
      const fields=['schema','session','closed','reason'];
      demand(result&&typeof result==='object'&&!Array.isArray(result)&&
        Object.keys(result).length===fields.length&&fields.every(key=>Object.hasOwn(result,key))&&
        result.schema==='semantic-native-close/8'&&result.closed===true&&
        result.session===input.session&&result.reason===input.reason,
        'native model did not acknowledge closing this session with the exact close receipt');
      orchestration.closed(input.session);
      return result;
    }
    finally{sessions.delete(input?.session);}
  };
  select.metrics=()=>({schema:'semantic-native-model-metrics/8',attempts:copy(attempts),
    predictionAttempts:attempts.length,semanticallyAccepted:attempts.filter(row=>row.status==='accepted').length,
    failedAttempts:attempts.filter(row=>['failed','rejected','cancelled','commit-failed','abandoned-on-restore'].includes(row.status)).length,
    unknownAcknowledgements:attempts.filter(row=>row.status==='acknowledgement-unknown').length,
    unknownGenerationCostAttempts:attempts.filter(row=>row.selection===null).length,
    elapsedMs:attempts.reduce((sum,row)=>sum+(row.elapsedMs??0),0),
    runtime:copy(runtimeMetrics),
    nativeAdmissionClaim:false,sourceAdmissionClaim:false});
  select.status=()=>({closed,pending:pending.size||Number(requestBusy),stderr:stderr.slice(-1000)});
  select.durableRequestReceipt=()=>copy(lastDurableRequest);
  select.close=()=>stop(new Error('Native v8 model process closed'));
  select.shutdown=()=>{
    if(shutdownPromise)return shutdownPromise;
    if(closed)return Promise.reject(new Error('Native v8 process already closed'));
    if(pending.size||requestBusy)return Promise.reject(new Error('Native v8 request still outstanding'));
    closed=true;identity=null;epoch++;
    shutdownPromise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Native v8 shutdown deadline exceeded'));},10000);
      child.once('close',(code,signal)=>{clearTimeout(timer);
        if(code===0)resolve({graceful:true,exitCode:0});
        else reject(new Error('Native v8 shutdown failed '+String(code??signal)));});
      child.stdin.end();
    });
    return shutdownPromise;
  };
  const orchestration=attachNativeV8OrchestrationTransport(select,
    {request,identity:()=>identity,epoch:()=>epoch,sessions,attempts,stop,
      ensureIdle:()=>demand(!requestBusy&&pending.size===0,
        'cannot mutate orchestration history while a native request is outstanding'),
      durableRequestsEnabled:()=>Boolean(durable)});
  return select;
}

export function createNativeV8PythonSelector({python='python3',megatokenRepository,servedBundle,
    device='cpu',maxTokens=1024,maxFragments=32,effort=1,...options}={}){
  demand(typeof megatokenRepository==='string'&&megatokenRepository.length>0,'consumer checkout required');
  demand(typeof servedBundle==='string'&&servedBundle.length>0,'existing serving bundle required');
  demand(bounded(maxTokens,1,8192)&&bounded(maxFragments,1,64)&&bounded(effort,1,6),'invalid generation bounds');
  const durable=options.durableRequests;
  if(durable){
    assertDurableNativeV8RequestJournal(durable.journal);
    assertSelectedOrchestrationExecutionLease(durable.executionLease,{
      sessionId:durable.journal.sessionId,streamId:durable.journal.streamId});
  }
  return createNativeV8ProcessSelector({...options,command:python,cwd:megatokenRepository,
    args:['scripts/serve_semantic_v8.py','--served',servedBundle,'--device',device,
      '--max-tokens',String(maxTokens),'--max-fragments',String(maxFragments),'--effort',String(effort),
      ...(durable?['--request-journal-dir',durable.journal.directory,
        '--execution-lock-fd','3','--execution-lock-path',durable.executionLease.lockPath,
        '--execution-session-id',durable.journal.sessionId,'--execution-stream-id',durable.journal.streamId,
        '--execution-session-generation',String(durable.journal.sessionGeneration)]:[])]});
}
