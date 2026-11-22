// Child bootstrap is one host-owned operation after an exact selected create.
// It must not manufacture another model selection or mutate sibling work.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,TextDecoder} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON} from './ir.js';
import {verifyNativeV8DurableCommit} from './native-durable-commit-v8.js';
import {decodeNativeV8CommitFrame,decodeNativeV8BootstrapFrame} from '../storage/native-request-journal-v8.js';

const same=isDeepStrictEqual,copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(condition,message)=>{if(!condition)throw new TypeError('Native v8 durable bootstrap: '+message);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const requestId=identity=>hashAlgorithmData({schema:'semantic-native-request-slot/1',
  scope:hashAlgorithmData({session_id:identity.session_id,stream_id:identity.stream_id,
    session_generation:identity.session_generation}),ordinal:identity.ordinal});

export function verifyNativeV8DurableBootstrap(value,intent,createIntent,{recovered=false}={}){
  const {identity,requestBase64,checkpoint}=intent,{bytes,request}=decodeNativeV8BootstrapFrame(requestBase64),
    {bytes:createBytes,request:createRequest}=decodeNativeV8CommitFrame(createIntent.requestBase64),
    pre=checkpoint.native,createPre=createIntent.checkpoint.native;
  const keys=['schema','requestId','identity','requestSha256','preCheckpointDigest','postCheckpointDigest',
    'responseBase64','responseSha256','createIdentity','createRequestId','createRequestSha256',
    'createPreCheckpointDigest','createPostCheckpointDigest','createResponseSha256','postCheckpoint',
    'recovered','restoreReceipt'];
  demand(exact(value,keys)&&value.schema==='semantic-native-durable-bootstrap-child/8'&&
    value.requestId===requestId(identity)&&same(value.identity,identity)&&value.requestSha256===sha(bytes)&&
    value.recovered===recovered&&value.preCheckpointDigest===pre.digest&&
    same(value.createIdentity,createIntent.identity)&&value.createRequestId===requestId(createIntent.identity)&&
    value.createRequestSha256===sha(createBytes)&&value.createPreCheckpointDigest===createPre.digest&&
    value.createPostCheckpointDigest===pre.digest,
    'returned bootstrap or causal create identity differs from the exact retained requests');
  demand(createIntent.identity.ordinal+1===identity.ordinal&&
    same({...createIntent.identity,ordinal:identity.ordinal,operation:'bootstrap-orchestration-child'},identity)&&
    createRequest.op==='commit-orchestration'&&createRequest.session===request.session&&
    createRequest.track===request.track&&JSON.parse(createRequest.record).name==='track_create',
    'bootstrap changed the adjacent selected create, owner, model or generation');
  const createResult=pre.sessions?.[request.session]?.orchestration?.decisions?.find(row=>
    row.selectionId===createRequest.selection.selectionId)?.outcome;
  demand(createResult?.track?.address===request.childTrack&&createResult.track.parent===request.track&&
    createResult.track.bootstrap_ready===false,'bootstrap does not name the exact reserved child');
  const createResponse=Buffer.from(stableAlgorithmJSON({id:createRequest.id,ok:true,result:createResult})+'\n');
  demand(value.createResponseSha256===sha(createResponse),'causal create response bytes differ');
  // Verify the entire create-pre -> bootstrap-pre transition with the existing
  // independent commit checker. A claimed create digest alone supplies no proof.
  verifyNativeV8DurableCommit({schema:'semantic-native-durable-commit/8',
    requestId:requestId(createIntent.identity),identity:createIntent.identity,requestSha256:sha(createBytes),
    preCheckpointDigest:createPre.digest,postCheckpointDigest:pre.digest,
    responseBase64:createResponse.toString('base64'),responseSha256:sha(createResponse),
    postCheckpoint:pre,recovered:false,restoreReceipt:null},createIntent);
  const post=value.postCheckpoint,{digest,...body}=post??{};
  demand(post?.schema==='semantic-model-checkpoint/8'&&HASH.test(digest??'')&&digest===hashAlgorithmData(body)&&
    value.postCheckpointDigest===digest&&post.sessions&&typeof post.sessions==='object'&&!Array.isArray(post.sessions)&&
    same(Object.keys(post.sessions).sort(),Object.keys(pre.sessions).sort()),'bootstrap postcheckpoint differs');
  const immutable=node=>Object.fromEntries(Object.entries(node).filter(([key])=>!['digest','sessions'].includes(key)));
  demand(same(immutable(post),immutable(pre)),
    'bootstrap changed native attempts, random state, identity or unrelated adapter work');
  for(const [session,saved]of Object.entries(pre.sessions)){
    demand(saved.unacknowledgedSelection===null,'bootstrap precheckpoint contains an unresolved selection');
    const after=post.sessions[session];
    if(session!==request.session){demand(same(saved,after),'bootstrap changed a sibling native session');continue;}
    const stable=node=>Object.fromEntries(Object.entries(node).filter(([key])=>!['continuationDigest','orchestration'].includes(key)));
    demand(after&&same(stable(saved),stable(after))&&HASH.test(after.continuationDigest??''),
      'bootstrap changed host public data, causal contexts or child accounting');
    const beforeOperations=saved.orchestration?.operations,afterOperations=after.orchestration?.operations,
      operation=afterOperations?.at(-1);
    demand(Array.isArray(beforeOperations)&&Array.isArray(afterOperations)&&
      afterOperations.length===beforeOperations.length+1&&
      same({...after.orchestration,operations:afterOperations.slice(0,-1)},saved.orchestration)&&
      exact(operation,['kind','track','randomBefore'])&&operation.kind==='bootstrap'&&
      operation.track===request.childTrack&&same(operation.randomBefore,pre.randomState),
      'bootstrap must append only its exact child operation and preserve all prior work');
  }
  let responseBytes,response;
  try{
    demand(typeof value.responseBase64==='string','missing exact response bytes');
    responseBytes=Buffer.from(value.responseBase64,'base64');
    demand(responseBytes.toString('base64')===value.responseBase64,'response base64 differs');
    response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(responseBytes));
  }catch(error){throw new TypeError('Native v8 durable bootstrap: invalid exact response bytes',{cause:error});}
  const result=response?.result,track=result?.track;
  demand(responseBytes.equals(Buffer.from(stableAlgorithmJSON(response)+'\n'))&&
    sha(responseBytes)===value.responseSha256&&exact(response,['id','ok','result'])&&
    response.id===request.id&&response.ok===true&&exact(result,['schema','track','bootstrapped'])&&
    result.schema==='semantic-orchestration-bootstrap/8'&&result.bootstrapped===true&&
    ['active','waiting'].includes(track?.status)&&same(track,{...createResult.track,
      bootstrap_ready:true,status:track.status}),
    'bootstrap response changed its original bytes or reserved child binding');
  if(recovered){
    const restored=value.restoreReceipt;
    demand(restored?.schema==='semantic-model-restore/8'&&restored.restored===true&&
      restored.equivalence==='verified-model-reexecution'&&restored.checkpointDigest===pre.digest&&
      restored.restoredSessions===Object.keys(pre.sessions).length&&restored.consumedAttempts===pre.attempts.length&&
      restored.hostDispatches===0,'bootstrap recovery lacks exact independent native reexecution');
  }else demand(value.restoreReceipt===null,'ordinary bootstrap claimed restoration');
  return {request,result:copy(result),postCheckpoint:copy(post)};
}

export function nativeV8DurableBootstrapEvidence(verified,intent,receipt){
  return {schema:'semantic-native-transport-bootstrap/8',request:copy(verified.request),receipt:copy(receipt),
    createReceipt:copy(intent.createReceipt),preCheckpointDigest:intent.checkpoint.native.digest,
    postCheckpointDigest:verified.postCheckpoint.digest,result:copy(verified.result)};
}
