// A known terminal close proves the exact closed adapter. It cannot authorize
// a live continuation or turn a missing native outcome into another close.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,TextDecoder} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON} from './ir.js';
import {decodeNativeV8CloseFrame,assertNativeV8TerminalCloseCheckpoint}
  from '../storage/native-request-journal-v8.js';

const same=isDeepStrictEqual,HASH=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(condition,message)=>{if(!condition)throw new TypeError('Native v8 durable close: '+message);};

export function verifyNativeV8DurableClose(value,intent,{recovered=false}={}){
  const {identity,requestBase64,checkpoint}=intent,{bytes,request}=decodeNativeV8CloseFrame(requestBase64);
  demand(request.op==='cancel'&&identity.operation==='cancel','response operation differs from terminal close');
  const pre=checkpoint.native,closedSession=assertNativeV8TerminalCloseCheckpoint(pre,request.session),
    scope=hashAlgorithmData({session_id:identity.session_id,stream_id:identity.stream_id,
      session_generation:identity.session_generation}),
    requestId=hashAlgorithmData({schema:'semantic-native-request-slot/1',scope,ordinal:identity.ordinal});
  const keys=['schema','requestId','identity','requestSha256','preCheckpointDigest','postCheckpointDigest',
    'responseBase64','responseSha256','postCheckpoint','recovered','restoreReceipt'];
  demand(value&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))&&
    value.schema==='semantic-native-durable-close/8'&&value.requestId===requestId&&
    same(value.identity,identity)&&value.requestSha256===sha(bytes)&&value.recovered===recovered&&
    value.preCheckpointDigest===pre.digest,'response changed its exact request authority');
  const post=value.postCheckpoint,{digest,...body}=post??{};
  demand(post?.schema==='semantic-model-checkpoint/8'&&HASH.test(digest??'')&&
    digest===hashAlgorithmData(body)&&value.postCheckpointDigest===digest&&
    same(Object.keys(post).sort(),Object.keys(pre).sort()),'closed checkpoint identity or fields differ');
  for(const key of Object.keys(pre).filter(key=>!['digest','sessions','closedSessions'].includes(key)))
    demand(same(post[key],pre[key]),'close changed unrelated native '+key);
  const expectedSessions=structuredClone(pre.sessions);delete expectedSessions[request.session];
  demand(same(post.sessions,expectedSessions)&&
    same(post.closedSessions,{...pre.closedSessions,[request.session]:closedSession}),
    'close changed a sibling or failed to retain the exact terminal session');
  let responseBytes,response;
  try{
    demand(typeof value.responseBase64==='string','missing exact response bytes');
    responseBytes=Buffer.from(value.responseBase64,'base64');
    demand(responseBytes.toString('base64')===value.responseBase64,'response base64 differs');
    response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(responseBytes));
  }catch(error){throw new TypeError('Native v8 durable close: invalid exact response bytes',{cause:error});}
  const result={schema:'semantic-native-close/8',session:request.session,closed:true,reason:request.reason};
  demand(responseBytes.equals(Buffer.from(stableAlgorithmJSON(response)+'\n'))&&
    sha(responseBytes)===value.responseSha256&&response.id===request.id&&response.ok===true&&
    Object.keys(response).length===3&&same(response.result,result),
    'stored reply differs from the exact terminal close and reason');
  if(recovered){
    const restored=value.restoreReceipt;
    demand(restored?.schema==='semantic-model-restore/8'&&restored.restored===true&&
      restored.equivalence==='verified-model-reexecution'&&restored.checkpointDigest===digest&&
      restored.restoredSessions===Object.keys(post.sessions).length&&
      restored.consumedAttempts===post.attempts.length&&restored.hostDispatches===0,
      'closed native state lacks exact independent reconstruction');
  }else demand(value.restoreReceipt===null,'ordinary close claimed restoration');
  return {request,result:structuredClone(result),postCheckpoint:structuredClone(post)};
}
