import {createHash} from 'node:crypto';
import {isDeepStrictEqual,TextDecoder} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON} from './ir.js';
import {decodeNativeV8CommitFrame} from '../storage/native-request-journal-v8.js';
import {verifyCallbackNativeDeltaV8} from './orchestration-callback-v8.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(value,message)=>{if(!value)throw new TypeError('Native v8 durable commit: '+message);};
const same=isDeepStrictEqual,HASH=/^[a-f0-9]{64}$/;

/** Verify the returned bytes against both the original producer request and the
 * complete before/after native state. Neither a digest nor a saved reply alone
 * supplies authority to restore a commit. */
export function verifyNativeV8DurableCommit(value,intent,{recovered=false}={}){
  const {identity,requestBase64,checkpoint}=intent,{bytes,request}=decodeNativeV8CommitFrame(requestBase64);
  const scope=hashAlgorithmData({session_id:identity.session_id,stream_id:identity.stream_id,
    session_generation:identity.session_generation});
  const requestId=hashAlgorithmData({schema:'semantic-native-request-slot/1',scope,ordinal:identity.ordinal});
  const keys=['schema','requestId','identity','requestSha256','preCheckpointDigest','postCheckpointDigest',
    'responseBase64','responseSha256','postCheckpoint','recovered','restoreReceipt'];
  demand(value&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))&&
    value.schema==='semantic-native-durable-commit/8'&&value.requestId===requestId&&
    same(value.identity,identity)&&value.requestSha256===sha(bytes)&&value.recovered===recovered&&
    value.preCheckpointDigest===checkpoint.native.digest,'response changed its exact request authority');
  const post=value.postCheckpoint,{digest,...body}=post??{},pre=checkpoint.native;
  demand(post?.schema==='semantic-model-checkpoint/8'&&HASH.test(digest??'')&&digest===hashAlgorithmData(body)&&
    value.postCheckpointDigest===digest&&post.sessions&&typeof post.sessions==='object'&&
    !Array.isArray(post.sessions)&&Array.isArray(post.attempts),'postcheckpoint identity or shape differs');
  for(const key of ['schema','equivalence','contractDigest','initialization','settings','randomState','openings','closedSessions'])
    demand(same(post[key],pre[key]),'commit changed unrelated native '+key);
  const callback=request.op==='admit-orchestration-callback';
  const beforeAttempts=callback?pre.attempts:pre.attempts.map(row=>row.selectionId===request.selection.selectionId?
    {...row,status:'committed'}:row);
  demand((callback||pre.attempts.filter(row=>same(row,request.selection)).length===1&&
    request.selection.status==='awaiting-commit')&&same(post.attempts,beforeAttempts),
    'commit changed original selection evidence or a sibling attempt');
  demand(same(Object.keys(post.sessions).sort(),Object.keys(pre.sessions).sort()),'commit changed session population');
  for(const [session,saved] of Object.entries(post.sessions)){
    demand(saved&&typeof saved==='object'&&saved.unacknowledgedSelection===null,
      'postcheckpoint retains an uncommitted selection');
    if(session!==request.session)demand(same(saved,pre.sessions[session]),'commit changed a sibling session');
  }
  const committed=post.sessions[request.session];
  demand(committed,'postcheckpoint omitted the committed session');
  let responseBytes,response;
  try{
    demand(typeof value.responseBase64==='string','missing exact response bytes');
    responseBytes=Buffer.from(value.responseBase64,'base64');
    demand(responseBytes.toString('base64')===value.responseBase64,'response base64 differs');
    response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(responseBytes));
  }catch(error){throw new TypeError('Native v8 durable commit: invalid exact response bytes',{cause:error});}
  demand(responseBytes.equals(Buffer.from(stableAlgorithmJSON(response)+'\n'))&&
    sha(responseBytes)===value.responseSha256&&response.id===request.id&&response.ok===true&&
    Object.keys(response).length===3,'stored response changed its original bytes or success authority');
  let expected;
  if(callback){
    expected=verifyCallbackNativeDeltaV8(pre,post,request);
  }else if(request.op==='commit'){
    demand(same(committed.public,request.public)&&same(committed.contexts,request.contexts),
      'semantic postcheckpoint differs from the exact committed source cut');
    expected={schema:'semantic-native-commit/8',selectionId:request.selection.selectionId,
      publicDigest:hashAlgorithmData(request.public),committed:true};
  }else{
    const decisions=committed.orchestration?.decisions?.filter(row=>row.selectionId===request.selection.selectionId);
    demand(decisions?.length===1&&decisions[0].record===request.record,
      'orchestration postcheckpoint omitted the original decision');
    expected=decisions[0].outcome;
    demand(expected?.schema==='semantic-orchestration-commit/8'&&expected.committed===true&&
      expected.selectionId===request.selection.selectionId,'invalid orchestration acknowledgement');
  }
  demand(same(response.result,expected),'stored reply differs from independently committed native state');
  if(recovered){
    const restored=value.restoreReceipt;
    demand(restored?.schema==='semantic-model-restore/8'&&restored.restored===true&&
      restored.equivalence==='verified-model-reexecution'&&restored.checkpointDigest===digest&&
      restored.restoredSessions===Object.keys(post.sessions).length&&
      restored.consumedAttempts===post.attempts.length&&restored.hostDispatches===0,
      'restored native state lacks exact independent reexecution');
  }else demand(value.restoreReceipt===null,'ordinary acknowledgement claimed restoration');
  return {request,result:structuredClone(response.result),postCheckpoint:structuredClone(post)};
}
