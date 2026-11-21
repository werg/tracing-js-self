// Explicit supplied decoder for history orchestration controls. These records
// and model-shaped snapshots are not learned selections or native admission.
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../../src/semantic/program.js';

const copy=structuredClone,seal=body=>({...body,digest:hashAlgorithmData(body)});
export const historyTestIdentity={schema:'semantic-inference-identity/8',checkpointIdentity:'c'.repeat(64),
  tokenizerIdentity:'e'.repeat(64),seed:17,
  generationSettings:{device:'cpu',maxTokens:128,maxFragments:8,effort:1}};
export const historyTestPolicy={checkpointIdentity:historyTestIdentity.checkpointIdentity,
  tokenizerIdentity:historyTestIdentity.tokenizerIdentity,nativeIdentity:historyTestIdentity,
  hostLimits:{maxGenerated:4096,maxOutstanding:64},automaticDelivery:true,
  maxSelections:16,maxOutstanding:4,maxStaleRetries:2};

export function suppliedHistorySelector(choose){
  let attempts=[],modelAttempts=[],sessions={},openings=[],restoreCalls=0,checkpointCalls=0,closed=false,
    runtimeMetrics={rpcCalls:0,computeSeconds:0,peakMemoryBytes:0};
  const select=async request=>{
    const index=attempts.length,attempt={attempt:index,session:request.session,invocationId:request.context.invocationId,
      status:'submitted',record:null,selection:null};
    attempts.push(attempt);
    const record=await choose(request),payloadHex=Buffer.from(record).toString('hex');
    const selection={modelSelected:true,origin:'actual-model-selected',selectionId:'v8:'+index,
      session:request.session,invocationId:request.context.invocationId,
      checkpointIdentity:historyTestIdentity.checkpointIdentity,tokenizerIdentity:historyTestIdentity.tokenizerIdentity,
      prefixDigest:request.context.prefixDigest,contextDigest:hashAlgorithmData(request.context),payloadHex,
      generatedTokens:Buffer.byteLength(record),fragments:[{tokenIds:[...Buffer.from(record)],payloadHex}]};
    Object.assign(attempt,{record,selection:copy(selection),status:'decoded'});
    modelAttempts.push({...copy(selection),status:'awaiting-commit'});
    if(!sessions[request.session]){
      openings.push({session:request.session});
      sessions[request.session]={public:copy(request.public),contexts:copy(request.contexts),completed:[],
        openingRandom:{seed:17},replay:[],ingestedThrough:0,continuationDigest:'0'.repeat(64),
        unacknowledgedSelection:null};
    }
    return {record,selection};
  };
  select.commit=async request=>{
    RegionExecutionHarness.replay(request.public,{requireTerminal:false});
    const index=Number(request.selection.selectionId.split(':')[1]),saved=sessions[request.session];
    attempts[index].status='accepted';modelAttempts[index].status='committed';
    saved.public=copy(request.public);saved.contexts=copy(request.contexts);
    saved.ingestedThrough=request.contexts.at(-1).visibleThrough+1;
    saved.replay.push({attempt:index,contextIndex:saved.contexts.length-1,
      acknowledgedThrough:request.public.timeline.length,randomBefore:{attempt:index}});
    saved.continuationDigest=hashAlgorithmData(saved.contexts);
    return {schema:'semantic-native-commit/8',committed:true,selectionId:request.selection.selectionId,
      publicDigest:hashAlgorithmData(request.public)};
  };
  select.complete=async request=>{
    const saved=sessions[request.session];saved.public=copy(request.public);
    saved.completed=[...new Set([...saved.completed,request.invocationId])].sort();
    return {completed:true};
  };
  select.reject=async request=>{
    const index=Number(request.selectionId.split(':')[1]);
    attempts[index].status='rejected';modelAttempts[index].status='semantic-rejected';
    return {rejected:true};
  };
  select.cancel=async input=>{
    const attempt=attempts.findLast(row=>row.session===input.session&&row.status==='decoded');
    if(attempt){attempt.status='cancelled';attempt.failure=input.reason??'selected session cancelled';}
    const native=modelAttempts[attempt?.attempt];
    if(native?.status==='awaiting-commit')native.status='cancelled';
    return {schema:'semantic-native-close/8',closed:true,session:input.session,
      reason:String(input.reason??'')};
  };
  select.checkpoint=async()=>{
    checkpointCalls++;runtimeMetrics.rpcCalls++;
    const native=seal({schema:'semantic-model-checkpoint/8',equivalence:'verified-model-reexecution',
      initialization:copy(historyTestIdentity),contractDigest:'f'.repeat(64),settings:{fixture:'supplied-decoder'},
      randomState:{attempts:attempts.length},openings:copy(openings),attempts:copy(modelAttempts),sessions:copy(sessions)});
    return seal({schema:'semantic-native-transport-checkpoint/8',identity:copy(historyTestIdentity),native,
      attempts:copy(attempts),runtimeMetrics:copy(runtimeMetrics)});
  };
  select.restore=async({checkpoint})=>{
    restoreCalls++;assert.equal(attempts.length,0);
    attempts=copy(checkpoint.attempts);modelAttempts=copy(checkpoint.native.attempts);sessions=copy(checkpoint.native.sessions);
    openings=copy(checkpoint.native.openings);runtimeMetrics=copy(checkpoint.runtimeMetrics);
    return {restored:true,hostDispatches:0,transportCheckpointDigest:checkpoint.digest};
  };
  select.metrics=()=>({schema:'semantic-native-model-metrics/8',attempts:copy(attempts),
    predictionAttempts:attempts.length,semanticallyAccepted:attempts.filter(row=>row.status==='accepted').length,
    failedAttempts:attempts.filter(row=>['failed','rejected','cancelled','commit-failed','abandoned-on-restore'].includes(row.status)).length,
    unknownAcknowledgements:attempts.filter(row=>row.status==='acknowledgement-unknown').length,
    unknownGenerationCostAttempts:attempts.filter(row=>row.selection===null).length,elapsedMs:0,
    runtime:copy(runtimeMetrics),nativeAdmissionClaim:false,sourceAdmissionClaim:false});
  select.close=()=>{closed=true;};
  select.controls=()=>({restoreCalls,checkpointCalls,closed,attempts:copy(attempts)});
  return select;
}
