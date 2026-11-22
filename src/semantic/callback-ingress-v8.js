// Private return-value callback inputs. Neither a log receipt nor a saved guest
// completion reconstructs the external adapter's process-local continuation.
import {isDeepStrictEqual as eq} from 'node:util';
import {assertAlgorithmFields,stableAlgorithmJSON} from './ir.js';
import {hashAlgorithmData} from './program.js';
import {assertValue,validateGraph} from './record-schema.js';
import {hostOperation} from '../host/operations.js';
import {ownedCallbackId,decodeHostPayload} from '../host/materialize.js';

const ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const fail=message=>{throw new TypeError('Durable callback ingress: '+message);};
const bindingFields=['ownerInvocationId','parentEffectId','programId','sourceDigest','realmId','trackId',
  'taskRevision','deadline','closureId','closureCode','closureCaptures','effectDigest','retainedIds'];

function bindingFor(harness,{ownerInvocationId,parentEffectId,closureId}){
  const inner=harness.inner,owner=inner.invocations.get(ownerInvocationId),
    intent=inner.intents.get(ownerInvocationId+'/'+parentEffectId),realm=inner.realms.get(owner?.realmId),
    closure=realm?.heap.get(closureId),program=inner.programs.get(owner?.programId);
  if(!owner||['cancelled','failed'].includes(owner.status)||realm?.closed||closure?.kind!=='closure'||
    !intent||!['dispatched','uncertain','settled'].includes(intent.status)||
    hostOperation(intent.operation).callbackGraph!==true)fail('callback has no committed external parent and owned closure');
  const supplied=new Set(),seen=new Set();
  const visit=value=>{
    if(!value||typeof value!=='object'||seen.has(value))return;
    seen.add(value);const callback=ownedCallbackId(value);if(callback)supplied.add(callback);
    for(const child of Object.values(value))visit(child);
  };
  const descriptor=hostOperation(intent.operation);
  visit(decodeHostPayload(intent.payload,descriptor.codec,{callbackGraph:true,
    callbackIndices:descriptor.callbackIndices??[]}));
  if(!supplied.has(closureId))fail('closure was not supplied to its committed parent effect');
  return {ownerInvocationId,parentEffectId,programId:owner.programId,sourceDigest:program.digest,
    realmId:owner.realmId,trackId:owner.trackId,taskRevision:owner.taskRevision,deadline:owner.deadline,
    closureId,closureCode:closure.code,closureCaptures:structuredClone(closure.captures??[]),
    effectDigest:hashAlgorithmData({operation:intent.operation,payload:intent.payload,witness:intent.witness}),
    retainedIds:[...realm.heap.keys()]};
}

export function validateCallbackArrival(arrival){
  stableAlgorithmJSON(arrival);
  assertAlgorithmFields(arrival,['schema','sessionId','visibleThrough','prefixDigest','binding','event'],'callback arrival');
  const {binding,event}=arrival;
  assertAlgorithmFields(binding,bindingFields,'callback arrival binding');
  assertAlgorithmFields(event,['invocationId','arrivalSequence','inputGraph','receiverValue'],'callback arrival input');
  if(arrival.schema!=='semantic-callback-return-arrival/8'||!ID.test(arrival.sessionId??'')||
    !Number.isSafeInteger(arrival.visibleThrough)||arrival.visibleThrough<1||!HASH.test(arrival.prefixDigest??'')||
    !['ownerInvocationId','parentEffectId','programId','realmId','trackId','closureId'].every(key=>ID.test(binding[key]??''))||
    !HASH.test(binding.sourceDigest??'')||!HASH.test(binding.effectDigest??'')||
    !Number.isSafeInteger(binding.taskRevision)||binding.taskRevision<1||
    binding.deadline!==null&&!Number.isFinite(binding.deadline)||
    typeof binding.closureCode!=='string'||!binding.closureCode||!Array.isArray(binding.closureCaptures)||
    !Array.isArray(binding.retainedIds)||binding.retainedIds.length>100000||
    !binding.retainedIds.every(id=>ID.test(id))||new Set(binding.retainedIds).size!==binding.retainedIds.length||
    !ID.test(event.invocationId??'')||!Number.isSafeInteger(event.arrivalSequence)||event.arrivalSequence<1||
    event.arrivalSequence>=Number.MAX_SAFE_INTEGER)fail('invalid callback identity or bounds');
  validateGraph(event.inputGraph,{externalReferences:binding.retainedIds});assertValue(event.receiverValue);
  if(event.inputGraph.objects.some(node=>binding.retainedIds.includes(node.id)))
    fail('callback inputs overwrite retained identities');
  if(event.receiverValue[0]==='ref'&&!binding.retainedIds.includes(event.receiverValue[1])&&
    !event.inputGraph.objects.some(node=>node.id===event.receiverValue[1]))fail('unknown callback receiver');
  return arrival;
}

export function captureCallbackArrival(harness,{invocationId,...options}){
  const prepared=harness.inner.prepareClosureInput(options),timeline=harness.exportEpisode().timeline;
  return validateCallbackArrival({schema:'semantic-callback-return-arrival/8',sessionId:harness.inner.sessionId,
    visibleThrough:timeline.length,prefixDigest:hashAlgorithmData(timeline),binding:bindingFor(harness,options),
    event:{invocationId,arrivalSequence:1,inputGraph:prepared.inputGraph,receiverValue:prepared.receiverValue}});
}

export function verifyCallbackArrival(harness,arrival){
  validateCallbackArrival(arrival);
  const publicData=harness.exportEpisode(),timeline=publicData.timeline;
  if(arrival.sessionId!==harness.inner.sessionId||arrival.visibleThrough>timeline.length||
    hashAlgorithmData(timeline.slice(0,arrival.visibleThrough))!==arrival.prefixDigest)
    fail('callback requires a different or later acknowledged public boundary');
  // The authority is the exact original prefix, not today's heap or a caller's
  // rehashed retained-ID list. This also checks closure capture cell identities.
  const prefix=harness.constructor.replay({...publicData,timeline:timeline.slice(0,arrival.visibleThrough)},
    {requireTerminal:false});
  if(!eq(bindingFor(prefix,arrival.binding),arrival.binding))fail('callback owner, effect or retained identities changed');
  return {owner:harness.invocations.get(arrival.binding.ownerInvocationId),timeline};
}

export function callbackRequest(arrival){
  return {ownerInvocationId:arrival.binding.ownerInvocationId,closureId:arrival.binding.closureId,
    invocationId:arrival.event.invocationId,inputGraph:structuredClone(arrival.event.inputGraph),
    receiverValue:structuredClone(arrival.event.receiverValue),arrivalSequence:arrival.event.arrivalSequence,
    durableIngress:true};
}

function normalizedInput(inputGraph,receiverValue){
  const names=new Map(inputGraph.objects.map((node,index)=>[node.id,index]));
  const value=tag=>tag[0]==='ref'&&names.has(tag[1])?['introduced',names.get(tag[1])]:tag;
  return {objects:inputGraph.objects.map((node,index)=>({...node,id:index,
    properties:node.properties.map(property=>({...property,value:value(property.value)}))})),
    roots:inputGraph.roots.map(value),receiver:value(receiverValue)};
}
export function sameCallbackInput(a,b){
  return eq(normalizedInput(a.inputGraph,a.receiverValue),normalizedInput(b.inputGraph,b.receiverValue));
}
export function sameCallbackRetry(a,b){
  const {retainedIds:unusedA,...left}=a.binding,{retainedIds:unusedB,...right}=b.binding;
  return a.sessionId===b.sessionId&&a.event.invocationId===b.event.invocationId&&eq(left,right)&&sameCallbackInput(a.event,b.event);
}
