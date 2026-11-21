// A service owns this gate and its durable journal. A producer checkpoint or a
// newer dispatch attempt cannot grant a second right to execute the same action.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {encode,decode} from '../values.js';
import {assertAlgorithmFields,assertAlgorithmValue,stableAlgorithmJSON} from '../semantic/ir.js';
import {hostOperation,SUBSCRIPTION_CLOSERS} from './operations.js';
import {decodeHostPayload} from './materialize.js';

const ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const demand=(condition,message)=>{if(!condition)throw new TypeError('Selected service: '+message);};
const actionFields=['schema','serviceId','sessionId','invocationId','effectId','operation',
  'idempotencyKey','payload','payloadDigest','taskRevision','witness'];

/** A service/storage failure is never a guest rejection. In particular, an
 * existing claim without a durable outcome means unknown, not safe to retry. */
export class SelectedServiceBoundaryError extends Error {
  constructor(message,{code='service-unavailable',cause}={}){
    super(message,{cause});this.name='SelectedServiceBoundaryError';this.code=code;
  }
}

// Preserve the original adapter throw/rejection distinction through this async
// wrapper, including a recovered rejection read in a later process.
export class SelectedServiceRejectedError extends Error {
  constructor(value,errorOrigin){
    super('Durably observed service rejection');this.name='SelectedServiceRejectedError';
    this.value=value;this.errorOrigin=errorOrigin;
  }
}

function serviceDescriptor(operation){
  demand(typeof operation==='string','operation must be a string');
  const descriptor=hostOperation(operation);
  demand(descriptor.lifetime==='invocation'&&descriptor.resultCodec==='canonical-scalar/1'&&
    descriptor.callbackIndices.length===0&&!descriptor.callbackGraph&&
    !Object.hasOwn(SUBSCRIPTION_CLOSERS,operation),
    'durable result recovery requires a callback-free, invocation-scoped scalar operation');
  return descriptor;
}

export function validateSelectedServiceAction(action){
  assertAlgorithmFields(action,actionFields,'service action');
  stableAlgorithmJSON(action);
  demand(action.schema==='semantic-service-action/8'&&
    ['serviceId','sessionId','invocationId','effectId'].every(key=>
      typeof action[key]==='string'&&ID.test(action[key]))&&
    typeof action.idempotencyKey==='string'&&action.idempotencyKey.length>0&&
    typeof action.payload==='string'&&HASH.test(action.payloadDigest??'')&&
    digest(action.payload)===action.payloadDigest&&
    Number.isSafeInteger(action.taskRevision)&&action.taskRevision>=1&&
    typeof action.witness==='string'&&action.witness.length>0,
    'invalid bound action identity');
  const descriptor=serviceDescriptor(action.operation);
  demand(Buffer.byteLength(action.payload)<=descriptor.limits.payloadBytes,'request exceeds payload bound');
  const args=decodeHostPayload(action.payload,descriptor.codec);
  demand(args.length===descriptor.arity,'request argument arity differs');
  return action;
}

export function selectedServiceActionKey(action){
  validateSelectedServiceAction(action);
  // Deliberately exclude attempt, payload and the caller's idempotency key.
  // Reusing one logical action for different bytes is a conflict, not a new key.
  return digest(stableAlgorithmJSON([action.serviceId,action.sessionId,action.invocationId,action.effectId]));
}

export function selectedServiceActionDigest(action){
  validateSelectedServiceAction(action);return digest(stableAlgorithmJSON(action));
}

export function validateSelectedServiceOutcome(outcome,action){
  assertAlgorithmFields(outcome,['schema','actionDigest','status','result','errorOrigin'],'service outcome');
  stableAlgorithmJSON(outcome);assertAlgorithmValue(outcome.result,{allowReference:false});
  demand(outcome.schema==='semantic-service-outcome/8'&&
    outcome.actionDigest===selectedServiceActionDigest(action)&&
    (outcome.status==='fulfilled'&&outcome.errorOrigin===null||outcome.status==='rejected'&&
      ['adapter-throw','adapter-rejection'].includes(outcome.errorOrigin)),
    'outcome does not bind the same action and completion');
  return outcome;
}

function validateAcknowledgement(receipt,action,kind,record){
  assertAlgorithmFields(receipt,['key','kind','digest','bytes','claimed'],'service journal acknowledgement');
  const bytes=stableAlgorithmJSON(record);
  demand(receipt.key===selectedServiceActionKey(action)&&receipt.kind===kind&&
    receipt.digest===digest(bytes)&&receipt.bytes===Buffer.byteLength(bytes)&&typeof receipt.claimed==='boolean',
    'service journal acknowledgement does not bind the published bytes');
}

function returnOutcome(outcome){
  const value=decode(outcome.result);
  if(outcome.status==='rejected')throw new SelectedServiceRejectedError(value,outcome.errorOrigin);
  return value;
}

/** Wrap the actual service, with one shared durable journal for every worker.
 * Only the atomic claim winner invokes service(). Losers may return an already
 * retained outcome; without one they stop. There is intentionally no reset,
 * expiry, ownership takeover, or automatic retry of an uncertain action.
 */
export function createDurableSelectedService({serviceId,operation,journal,service}={}){
  demand(typeof serviceId==='string'&&ID.test(serviceId)&&typeof service==='function',
    'service ID and implementation required');
  serviceDescriptor(operation);
  demand(journal&&['claim','read','complete'].every(key=>typeof journal[key]==='function'),
    'service requires atomic durable claims and independently readable outcomes');
  return Object.freeze(async function durableSelectedService(args,context){
    try{
      // Capture and check the producer-supplied binding before the first await.
      // No model-generated result or producer checkpoint is an outcome receipt.
      const selected=context?.selectedAction;
      assertAlgorithmFields(selected,['sessionId','invocationId','effectId','operation','idempotencyKey',
        'payload','payloadDigest','taskRevision','witness'],'selected service binding');
      stableAlgorithmJSON(selected);
      const action={schema:'semantic-service-action/8',serviceId,...structuredClone(selected)};
      validateSelectedServiceAction(action);
      demand(action.operation===operation&&['sessionId','invocationId','effectId','operation','idempotencyKey']
        .every(key=>context[key]===action[key]),'adapter context differs from selected action');
      demand(isDeepStrictEqual(args,decodeHostPayload(action.payload,hostOperation(operation).codec)),
        'adapter arguments differ from selected action');
      const receipt=await journal.claim(action);
      validateAcknowledgement(receipt,action,'claim',{schema:'semantic-service-claim/8',action});
      if(!receipt.claimed){
        const retained=await journal.read(action);
        if(!retained.outcome)throw new SelectedServiceBoundaryError(
          'Service action is already claimed and its outcome is unknown',{code:'outcome-unknown'});
        validateSelectedServiceOutcome(retained.outcome,action);
        return returnOutcome(retained.outcome);
      }
      // A cancellation after claiming also consumes the one execution right.
      // Without an atomic external transaction it cannot safely be reassigned.
      if(context.signal?.aborted)throw new SelectedServiceBoundaryError(
        'Service action was cancelled after its durable claim',{code:'outcome-unknown',cause:context.signal.reason});
      let returned,value,status='fulfilled',errorOrigin=null;
      try{returned=service(decodeHostPayload(action.payload,hostOperation(operation).codec),context);}
      catch(error){
        if(error instanceof SelectedServiceBoundaryError)throw error;
        status='rejected';value=error instanceof Error?error.message:error;errorOrigin='adapter-throw';
      }
      if(status==='fulfilled')try{value=await returned;}
      catch(error){
        if(error instanceof SelectedServiceBoundaryError)throw error;
        status='rejected';value=error instanceof Error?error.message:error;errorOrigin='adapter-rejection';
      }
      const outcome={schema:'semantic-service-outcome/8',actionDigest:selectedServiceActionDigest(action),
        status,result:encode(value),errorOrigin};
      validateSelectedServiceOutcome(outcome,action);
      // Both the result bytes and directory entry must be durable before the
      // producer is allowed to expose the observed completion to guest code.
      const completed=await journal.complete(action,outcome,receipt);
      validateAcknowledgement(completed,action,'outcome',outcome);
      return returnOutcome(outcome);
    }catch(error){
      if(error instanceof SelectedServiceBoundaryError||error instanceof SelectedServiceRejectedError)throw error;
      throw new SelectedServiceBoundaryError('Durable selected service boundary failed',{cause:error});
    }
  });
}
