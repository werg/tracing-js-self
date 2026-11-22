// A terminal history cut may name service fences, but hashes alone are not
// service authority. Recovery also reads the independently owned service logs.
import {assertAlgorithmFields,stableAlgorithmJSON} from './ir.js';

const ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const demand=(condition,message)=>{if(!condition)throw new TypeError('Selected service admission: '+message);};
const identity=value=>typeof value==='string'&&value.length<=256&&ID.test(value);

export function validateServiceAdmissionPolicy(policy,sessionId=policy?.sessionId){
  assertAlgorithmFields(policy,['schema','sessionId','serviceIds'],'service admission policy');
  stableAlgorithmJSON(policy);
  demand(policy.schema==='semantic-service-admission-policy/8'&&identity(sessionId)&&
    policy.sessionId===sessionId&&Array.isArray(policy.serviceIds)&&
    policy.serviceIds.length>=1&&policy.serviceIds.length<=64&&
    policy.serviceIds.every((id,index)=>identity(id)&&(index===0||policy.serviceIds[index-1]<id)),
    'policy requires a session and an exact sorted set of participating services');
  return policy;
}

export function validateServiceFenceReceipt(receipt,serviceId,sessionId){
  assertAlgorithmFields(receipt,['schema','serviceId','sessionId','position','id','bytes'],'service fence receipt');
  stableAlgorithmJSON(receipt);
  demand(receipt.schema==='semantic-service-fence-receipt/8'&&receipt.serviceId===serviceId&&
    receipt.sessionId===sessionId&&Number.isSafeInteger(receipt.position)&&receipt.position>=1&&
    receipt.position<=65536&&typeof receipt.id==='string'&&HASH.test(receipt.id)&&
    Number.isSafeInteger(receipt.bytes)&&receipt.bytes>=1,'invalid service fence receipt');
  return receipt;
}

export function validateServiceAdmissionFence(fence,policy,reason=fence?.reason){
  validateServiceAdmissionPolicy(policy);
  assertAlgorithmFields(fence,['schema','sessionId','reason','services'],'service admission fence');
  stableAlgorithmJSON(fence);
  demand(fence.schema==='semantic-service-admission-fence/8'&&fence.sessionId===policy.sessionId&&
    typeof reason==='string'&&reason.length>0&&Buffer.byteLength(reason)<=4096&&fence.reason===reason&&
    Array.isArray(fence.services)&&fence.services.length===policy.serviceIds.length,
    'fence must bind the complete service policy and terminal reason');
  for(const [index,row]of fence.services.entries()){
    assertAlgorithmFields(row,['serviceId','owner','terminal'],'service admission fence member');
    demand(row.serviceId===policy.serviceIds[index],'omitted, repeated or substituted service fence');
    validateServiceFenceReceipt(row.owner,row.serviceId,policy.sessionId);
    validateServiceFenceReceipt(row.terminal,row.serviceId,policy.sessionId);
    demand(row.terminal.position>row.owner.position,'terminal fence must follow its owner');
  }
  return fence;
}

/** Snapshot the exact coordinator-bound owners; this is a binding, not proof of a
 * terminal write. Recovery must compare it to a fresh coordinator and re-read
 * each independently owned service journal before acting on it. */
export function validateServiceAdmissionOwnerSnapshot(snapshot,sessionId=snapshot?.policy?.sessionId){
  assertAlgorithmFields(snapshot,['schema','policy','services'],'service admission owner snapshot');
  stableAlgorithmJSON(snapshot);
  validateServiceAdmissionPolicy(snapshot.policy,sessionId);
  demand(snapshot.schema==='semantic-service-admission-owner-snapshot/8'&&
    Array.isArray(snapshot.services)&&snapshot.services.length===snapshot.policy.serviceIds.length,
    'owner snapshot must bind every participating service');
  for(const [index,row]of snapshot.services.entries()){
    assertAlgorithmFields(row,['serviceId','owner'],'service admission owner snapshot member');
    demand(row.serviceId===snapshot.policy.serviceIds[index],'owner snapshot changed the sorted service set');
    validateServiceFenceReceipt(row.owner,row.serviceId,sessionId);
  }
  return snapshot;
}
