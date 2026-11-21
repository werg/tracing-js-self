// Explicit application-owned checkpoint cuts. Hashes bind retained bytes and
// order; the embedding supplies the independently expected journal head.
import {isDeepStrictEqual} from 'node:util';
import {assertAlgorithmFields,stableAlgorithmJSON} from './ir.js';
import {hashAlgorithmData} from './program.js';

const eq=isDeepStrictEqual,ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const fail=message=>{throw new TypeError('Selected checkpoint history: '+message);};
const demand=(condition,message)=>{if(!condition)fail(message);};
const prefix=(before,after,label)=>demand(Array.isArray(before)&&Array.isArray(after)&&
  after.length>=before.length&&eq(before,after.slice(0,before.length)),label+' is not an exact extension');
const publicPrefix=(before,after,label)=>{
  demand(before&&after&&eq({...before,timeline:[]},{...after,timeline:[]}),label+' identity changed');
  prefix(before.timeline,after.timeline,label);
};

export function validateSelectedHistoryReceipt(receipt){
  stableAlgorithmJSON(receipt);
  assertAlgorithmFields(receipt,['schema','streamId','position','id','bytes'],'selected history receipt');
  demand(receipt.schema==='semantic-selected-history-receipt/8'&&ID.test(receipt.streamId??'')&&
    Number.isSafeInteger(receipt.position)&&receipt.position>0&&receipt.position<=65536&&
    HASH.test(receipt.id??'')&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0,'invalid receipt');
  return receipt;
}

export function validateSelectedHistoryEntry(entry){
  stableAlgorithmJSON(entry);
  assertAlgorithmFields(entry,['schema','streamId','position','previous','checkpoint'],'selected history entry');
  demand(entry.schema==='semantic-selected-history-entry/8'&&ID.test(entry.streamId??'')&&
    Number.isSafeInteger(entry.position)&&entry.position>0&&entry.position<=65536,'invalid entry');
  if(entry.position===1)demand(entry.previous===null,'first entry has a predecessor');
  else{
    validateSelectedHistoryReceipt(entry.previous);
    demand(entry.previous.streamId===entry.streamId&&entry.previous.position===entry.position-1,
      'noncontiguous predecessor');
  }
  const packet=entry.checkpoint;
  assertAlgorithmFields(packet,['schema','policy','bridge','contexts','attempts','staleRetries','native','digest'],
    'selected history checkpoint');
  const {digest,...body}=packet;
  demand(packet.schema==='semantic-selected-driver-checkpoint/8'&&HASH.test(digest??'')&&
    digest===hashAlgorithmData(body),'checkpoint integrity differs');
  return entry;
}

/** Full source/continuation validation is performed by the driver before any
 * native restore. These cross-cut invariants additionally prevent a valid cut
 * on another branch, or a budget rollback, replacing recorded history. */
export function validateSelectedHistoryExtension(before,after){
  demand(eq(before.policy,after.policy),'execution policy or model identity changed');
  demand(before.bridge?.schema===after.bridge?.schema&&before.bridge?.profile===after.bridge?.profile,
    'host continuation identity changed');
  publicPrefix(before.bridge?.public,after.bridge?.public,'public history');
  prefix(before.contexts,after.contexts,'causal contexts');
  prefix(before.attempts,after.attempts,'consumed driver attempts');
  demand(Number.isSafeInteger(before.staleRetries)&&Number.isSafeInteger(after.staleRetries)&&
    after.staleRetries>=before.staleRetries,'stale retry budget rolled back');
  demand(Number.isSafeInteger(before.bridge.ingressCursor)&&Number.isSafeInteger(after.bridge.ingressCursor)&&
    before.bridge.ingressCursor>=1&&after.bridge.ingressCursor>=before.bridge.ingressCursor,'ingress cursor rolled back');
  const oldHead=before.bridge.ingressLog,newHead=after.bridge.ingressLog;
  if(oldHead)demand(newHead&&newHead.streamId===oldHead.streamId&&newHead.position>=oldHead.position&&
    (newHead.position!==oldHead.position||eq(newHead,oldHead)),'ingress acknowledgement rolled back or changed');
  const oldTransport=before.native,newTransport=after.native;
  demand(oldTransport?.schema===newTransport?.schema&&eq(oldTransport?.identity,newTransport?.identity),
    'native transport identity changed');
  prefix(oldTransport?.attempts,newTransport?.attempts,'consumed transport attempts');
  for(const [key,value]of Object.entries(oldTransport?.runtimeMetrics??{}))
    demand(Number.isFinite(value)&&value>=0&&Number.isFinite(newTransport?.runtimeMetrics?.[key])&&
      newTransport.runtimeMetrics[key]>=value,'native runtime cost accounting rolled back');
  const oldNative=oldTransport.native,newNative=newTransport.native;
  for(const key of ['schema','equivalence','contractDigest','initialization','settings'])
    demand(eq(oldNative?.[key],newNative?.[key]),'native '+key+' changed');
  prefix(oldNative?.attempts,newNative?.attempts,'consumed native attempts');
  if(oldNative.openings!==undefined||newNative.openings!==undefined)
    prefix(oldNative.openings,newNative.openings,'native session openings');
  demand(oldNative.sessions&&newNative.sessions,'native sessions are missing');
  for(const [session,oldSession]of Object.entries(oldNative.sessions)){
    const newSession=newNative.sessions[session];
    demand(newSession,'native session was retired without a durable terminal cut');
    publicPrefix(oldSession.public,newSession.public,'native acknowledged public history');
    prefix(oldSession.contexts,newSession.contexts,'native causal contexts');
    if(oldSession.replay!==undefined||newSession.replay!==undefined)
      prefix(oldSession.replay,newSession.replay,'native reconstruction ledger');
    demand(eq(oldSession.openingRandom,newSession.openingRandom),'native opening random state changed');
    if(oldSession.ingestedThrough!==undefined||newSession.ingestedThrough!==undefined)
      demand(Number.isSafeInteger(oldSession.ingestedThrough)&&Number.isSafeInteger(newSession.ingestedThrough)&&
        newSession.ingestedThrough>=oldSession.ingestedThrough,'native observation cursor rolled back');
    if(oldSession.completed!==undefined||newSession.completed!==undefined)
      demand(Array.isArray(oldSession.completed)&&Array.isArray(newSession.completed)&&
        oldSession.completed.every(id=>newSession.completed.includes(id)),'native completion acknowledgement disappeared');
  }
  return true;
}

export function validateSelectedHistoryChain(entries,receipt){
  validateSelectedHistoryReceipt(receipt);
  demand(Array.isArray(entries)&&entries.length===receipt.position&&entries.length<=65536,
    'incomplete acknowledged chain');
  let previous=null,checkpoint=null;
  for(const entry of entries){
    validateSelectedHistoryEntry(entry);
    demand(entry.streamId===receipt.streamId&&entry.position===(previous?.position??0)+1&&eq(entry.previous,previous),
      'substituted or reordered acknowledged chain');
    if(checkpoint)validateSelectedHistoryExtension(checkpoint,entry.checkpoint);
    checkpoint=entry.checkpoint;
    previous={schema:'semantic-selected-history-receipt/8',streamId:entry.streamId,position:entry.position,
      id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))};
  }
  demand(eq(previous,receipt),'chain differs from the independently retained head');
  return entries;
}
