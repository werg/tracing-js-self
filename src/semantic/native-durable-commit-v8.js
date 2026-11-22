import {createHash} from 'node:crypto';
import {isDeepStrictEqual,TextDecoder} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON} from './ir.js';
import {decodeNativeV8RequestFrame} from '../storage/native-request-journal-v8.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(value,message)=>{if(!value)throw new TypeError('Native v8 durable commit: '+message);};
const same=isDeepStrictEqual,HASH=/^[a-f0-9]{64}$/;

/** Verify the returned bytes against both the original producer request and the
 * complete before/after native state. Neither a digest nor a saved reply alone
 * supplies authority to restore a commit. */
export function verifyNativeV8DurableCommit(value,intent,{recovered=false}={}){
  return verifyDurableOperation(value,intent,{recovered,bootstrap:false});
}

export function verifyNativeV8DurableBootstrap(value,intent,{recovered=false}={}){
  return verifyDurableOperation(value,intent,{recovered,bootstrap:true});
}

function verifyDurableOperation(value,intent,{recovered,bootstrap}){
  const {identity,requestBase64,checkpoint}=intent,{bytes,request}=decodeNativeV8RequestFrame(requestBase64);
  demand(bootstrap?request.op==='bootstrap-orchestration-child':
    ['commit','commit-orchestration'].includes(request.op),'response operation differs from requested recovery');
  const scope=hashAlgorithmData({session_id:identity.session_id,stream_id:identity.stream_id,
    session_generation:identity.session_generation});
  const requestId=hashAlgorithmData({schema:'semantic-native-request-slot/1',scope,ordinal:identity.ordinal});
  const keys=['schema','requestId','identity','requestSha256','preCheckpointDigest','postCheckpointDigest',
    'responseBase64','responseSha256','postCheckpoint','recovered','restoreReceipt'];
  demand(value&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))&&
    value.schema===(bootstrap?'semantic-native-durable-bootstrap/8':'semantic-native-durable-commit/8')&&
    value.requestId===requestId&&
    same(value.identity,identity)&&value.requestSha256===sha(bytes)&&value.recovered===recovered&&
    value.preCheckpointDigest===checkpoint.native.digest,'response changed its exact request authority');
  const post=value.postCheckpoint,{digest,...body}=post??{},pre=checkpoint.native;
  demand(post?.schema==='semantic-model-checkpoint/8'&&HASH.test(digest??'')&&digest===hashAlgorithmData(body)&&
    value.postCheckpointDigest===digest&&post.sessions&&typeof post.sessions==='object'&&
    !Array.isArray(post.sessions)&&Array.isArray(post.attempts),'postcheckpoint identity or shape differs');
  for(const key of ['schema','equivalence','contractDigest','initialization','settings','randomState','openings','closedSessions'])
    demand(same(post[key],pre[key]),'commit changed unrelated native '+key);
  if(bootstrap)demand(same(post.attempts,pre.attempts),'bootstrap changed original selection evidence');
  else{
    const beforeAttempts=pre.attempts.map(row=>row.selectionId===request.selection.selectionId?
      {...row,status:'committed'}:row);
    demand(pre.attempts.filter(row=>same(row,request.selection)).length===1&&
      request.selection.status==='awaiting-commit'&&same(post.attempts,beforeAttempts),
      'commit changed original selection evidence or a sibling attempt');
  }
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
  if(bootstrap){
    const previous=pre.sessions[request.session],priorState=previous?.orchestration,state=committed.orchestration,
      child=priorState?.children?.find(row=>row.track===request.childTrack),last=priorState?.decisions?.at(-1),
      description=response.result?.track;
    demand(previous&&previous.unacknowledgedSelection===null&&priorState?.track===request.track&&
      child&&child.completion===null&&last?.outcome?.track?.address===request.childTrack&&
      last.outcome.track.bootstrap_ready===false&&JSON.parse(last.record).name==='track_create'&&
      priorState.operations.every(row=>row.kind!=='bootstrap'||row.track!==request.childTrack),
      'bootstrap is not the exact latest unbootstrapped child reservation');
    for(const key of Object.keys(previous).filter(key=>!['orchestration','continuationDigest'].includes(key)))
      demand(same(committed[key],previous[key]),'bootstrap changed unrelated session '+key);
    demand(same(Object.keys(committed).sort(),Object.keys(previous).sort())&&
      same(Object.keys(state??{}).sort(),Object.keys(priorState).sort()),'bootstrap changed checkpoint fields');
    for(const key of Object.keys(priorState).filter(key=>key!=='operations'))
      demand(same(state[key],priorState[key]),'bootstrap changed unrelated coordinator '+key);
    demand(same(state.operations,[...priorState.operations,
      {kind:'bootstrap',track:request.childTrack,randomBefore:pre.randomState}]),
      'bootstrap omitted or changed its exact ordered native operation');
    demand(description&&same(description.execution,child.execution)&&description.address===request.childTrack&&
      description.parent===request.track&&description.bootstrap_ready===true&&
      ['active','waiting'].includes(description.status)&&
      same(Object.keys(description).sort(),Object.keys(last.outcome.track).sort())&&
      Object.keys(last.outcome.track).filter(key=>!['status','bootstrap_ready'].includes(key))
        .every(key=>same(description[key],last.outcome.track[key])),
      'bootstrap reply changed its exact reserved child binding');
    expected={schema:'semantic-orchestration-bootstrap/8',track:description,bootstrapped:true};
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
