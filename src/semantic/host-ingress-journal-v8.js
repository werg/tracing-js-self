// Private write-ahead host input. A receipt is an integrity/ordering boundary,
// not host authentication; the embedding retains the independently expected head.
import {isDeepStrictEqual} from 'node:util';
import {describeGraph} from '../training/graph.js';
import {decodeHostPayload} from '../host/materialize.js';
import {canonicalCompletionPolicy} from './record-schema.js';
import {assertAlgorithmFields,stableAlgorithmJSON} from './ir.js';
import {hashAlgorithmData} from './program.js';
import {validatePendingIngressSnapshot} from './pending-ingress-v8.js';
import {validateCallbackArrival,captureCallbackArrival,verifyCallbackArrival,callbackRequest,
  sameCallbackInput,sameCallbackRetry} from './callback-ingress-v8.js';

const eq=isDeepStrictEqual,copy=structuredClone;
const ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const ownerFields=['programId','realmId','trackId','realmPolicy','entry','queueLimit',
  'closureId','lifetime','ownerInvocationId'];
const fail=message=>{throw new TypeError('Host ingress journal: '+message);};
const owner=handler=>Object.fromEntries(ownerFields.map(key=>[key,handler[key]]));
function graphOf(args){
  const graph=describeGraph(args);
  return {roots:graph.roots,objects:graph.objects.map(({properties,...node})=>
    ({...node,properties:properties.map(([key,value])=>({key,value}))}))};
}
const argsOf=graph=>decodeHostPayload(JSON.stringify({schema:'owned-graph/1',...graph}),'owned-graph/1');
const normalGraph=graph=>graphOf(argsOf(graph));

export function validateHostIngressLogReceipt(receipt){
  stableAlgorithmJSON(receipt);
  assertAlgorithmFields(receipt,['schema','streamId','position','id','bytes'],'ingress log receipt');
  if(receipt.schema!=='semantic-host-ingress-log-receipt/8'||!ID.test(receipt.streamId??'')||
    !Number.isSafeInteger(receipt.position)||receipt.position<1||!HASH.test(receipt.id??'')||
    !Number.isSafeInteger(receipt.bytes)||receipt.bytes<1)fail('invalid log receipt');
  return receipt;
}

export function validateHostIngressArrival(arrival){
  if(arrival?.schema==='semantic-callback-return-arrival/8')return validateCallbackArrival(arrival);
  stableAlgorithmJSON(arrival);
  assertAlgorithmFields(arrival,['schema','sessionId','visibleThrough','prefixDigest',
    'subscriptionId','binding','event'],'host arrival');
  if(arrival.schema!=='semantic-host-arrival/8')fail('invalid arrival schema');
  validatePendingIngressSnapshot({schema:'semantic-pending-host-ingress/8',
    sessionId:arrival.sessionId,visibleThrough:arrival.visibleThrough,prefixDigest:arrival.prefixDigest,
    nextIngressSequence:arrival.event.arrivalSequence+1,
    queues:[{subscriptionId:arrival.subscriptionId,binding:arrival.binding,events:[arrival.event]}]});
  return arrival;
}

export function validateHostIngressLogEntry(entry){
  stableAlgorithmJSON(entry);
  assertAlgorithmFields(entry,['schema','streamId','position','previous','arrival'],'ingress log entry');
  if(entry.schema!=='semantic-host-ingress-log-entry/8'||!ID.test(entry.streamId??'')||
    !Number.isSafeInteger(entry.position)||entry.position<1)fail('invalid log entry');
  validateHostIngressArrival(entry.arrival);
  if(entry.position===1){if(entry.previous!==null)fail('first entry has a predecessor');}
  else {
    validateHostIngressLogReceipt(entry.previous);
    if(entry.previous.streamId!==entry.streamId||entry.previous.position!==entry.position-1)
      fail('noncontiguous log chain');
  }
  return entry;
}

export function validateHostIngressLogChain(entries,receipt){
  validateHostIngressLogReceipt(receipt);
  if(!Array.isArray(entries)||entries.length!==receipt.position||entries.length>65536)
    fail('incomplete durable chain');
  let previous=null;
  for(const entry of entries){
    validateHostIngressLogEntry(entry);
    if(entry.streamId!==receipt.streamId||entry.position!==(previous?.position??0)+1||
      !eq(entry.previous,previous))fail('substituted durable chain');
    previous={schema:'semantic-host-ingress-log-receipt/8',streamId:entry.streamId,
      position:entry.position,id:hashAlgorithmData(entry),bytes:Buffer.byteLength(stableAlgorithmJSON(entry))};
  }
  if(!eq(previous,receipt))fail('durable chain differs from externally retained receipt');
  return entries;
}

function verifyOwnerAndPrefix(harness,arrival){
  const timeline=harness.exportEpisode().timeline,handler=harness.handlers.get(arrival.subscriptionId);
  if(arrival.sessionId!==harness.inner.sessionId||arrival.visibleThrough>timeline.length||
    hashAlgorithmData(timeline.slice(0,arrival.visibleThrough))!==arrival.prefixDigest)
    fail('arrival requires a different or later acknowledged public boundary');
  if(!handler||!eq(owner(handler),arrival.binding))fail('arrival has no matching source-owned handler');
  return {handler,timeline};
}

/** One ordered intake owner per live harness. All native postEvent calls use it.
 * Callers can await receive/postEvent for the durable acknowledgement. An ignored
 * native callback promise cannot hide a storage failure: flush/checkpoint refuse.
 */
export class DurableHostIngressBroker {
  constructor({harness,journal,receipt=null}={}){
    if(!harness?.inner||!journal||typeof journal.append!=='function'||typeof journal.readAll!=='function')
      fail('a V8 harness and durable journal are required');
    if(harness.inner.hostIngressBroker)fail('harness already has an intake owner');
    if(receipt!==null)validateHostIngressLogReceipt(receipt);
    this.harness=harness;this.journal=journal;this.head=copy(receipt);
    this.pending=new Map();this.accepted=new Map();this.acceptedCallbacks=new Map();
    this.failure=null;this.tail=Promise.resolve();
    harness.inner.hostIngressBroker=this;
  }
  get receipt(){return copy(this.head);}
  hasPending(subscriptionId,eventId){return this.pending.has(JSON.stringify([subscriptionId,eventId]));}
  hasPendingSubscription(subscriptionId){return [...this.pending.values()].some(row=>row.subscriptionId===subscriptionId);}
  assertCanRetire(subscriptionId=null){
    if(subscriptionId===null?this.pending.size:this.hasPendingSubscription(subscriptionId))
      fail('await durable arrivals before retiring their owner');
  }
  assertIdle(){
    if(this.failure)throw this.failure;
    if(this.pending.size)fail('unacknowledged durable arrivals are still being written');
  }
  async flush(){await this.tail;this.assertIdle();return this.receipt;}
  assertCallbackQueue(){
    let previous=0;
    const identities=new Set();
    for(const request of this.harness.inner.closureQueue){
      const arrival=this.acceptedCallbacks.get(request.invocationId);
      if(!arrival||!eq(request,callbackRequest(arrival)))fail('queued callback has no matching durable arrival');
      if(identities.has(request.invocationId)||request.arrivalSequence<=previous)
        fail('queued callbacks duplicate or reverse durable arrival order');
      identities.add(request.invocationId);previous=request.arrivalSequence;
    }
  }
  /** Acknowledgement and completion are distinct. The receipt is available as
   * soon as intake is durable; completion resolves only for this live adapter.
   */
  receiveCallback({invocationId=null,deliver=true,...options}={}){
    if(this.failure)throw this.failure;
    const harness=this.harness,inner=harness.inner;
    if(typeof deliver!=='boolean')fail('invalid callback delivery policy');
    invocationId??='callbackreturn'+(inner.nextIngressSequence+this.pending.size);
    const captured=captureCallbackArrival(harness,{...options,invocationId}),key='callback:'+invocationId,
      pending=this.pending.get(key),accepted=this.acceptedCallbacks.get(invocationId);
    if(pending){
      if(!sameCallbackRetry(pending.callback,captured))fail('conflicting pending callback duplicate');
      return pending.promise;
    }
    if(accepted){
      if(!sameCallbackRetry(accepted,captured))fail('conflicting accepted callback duplicate');
      return Promise.resolve({status:'duplicate',invocationId,receipt:this.receipt});
    }
    if(inner.invocations.has(invocationId)||inner.closureQueue.some(row=>row.invocationId===invocationId))
      fail('callback identity already belongs to other work');
    if(inner.closureQueue.length+[...this.pending.values()].filter(row=>row.callback).length>=64||
      this.pending.size>=4096)fail('callback queue overflow');
    const work=this.tail.then(async()=>{
      if(this.failure)throw this.failure;
      const checkLive=()=>{
        const owner=inner.invocations.get(options.ownerInvocationId),realm=inner.realms.get(owner?.realmId);
        verifyCallbackArrival(harness,captured);
        if(!owner||['cancelled','failed'].includes(owner.status)||realm?.closed||
          inner.invocations.has(invocationId)||inner.closureQueue.some(row=>row.invocationId===invocationId)||
          inner.closureQueue.length>=64)fail('callback owner changed before admission');
      };
      checkLive();captured.event.arrivalSequence=inner.nextIngressSequence;
      validateCallbackArrival(captured);
      const receipt=await this.journal.append(captured,{previous:this.head});
      const entries=validateHostIngressLogChain(await this.journal.readAll(receipt),receipt),last=entries.at(-1);
      if(!last||!eq(last.arrival,captured)||!eq(last.previous,this.head))fail('journal acknowledged different callback bytes');
      this.head=copy(receipt);checkLive();
      if(inner.nextIngressSequence!==captured.event.arrivalSequence)
        fail('callback arrival order changed after durable admission; explicit recovery required');
      this.acceptedCallbacks.set(invocationId,copy(captured));
      inner.closureQueue.push(callbackRequest(captured));inner.nextIngressSequence++;
      const completion=new Promise((resolve,reject)=>inner.completionWaiters.set(invocationId,{resolve,reject}));
      void completion.catch(()=>{});
      if(deliver)inner.activateQueuedClosures(captured.binding.realmId);
      inner.wake();harness.sync();
      return {status:inner.invocations.has(invocationId)?'delivered':'buffered',invocationId,receipt:copy(receipt),completion};
    });
    this.pending.set(key,{callback:captured,promise:work});
    this.tail=work.then(()=>{this.pending.delete(key);},error=>{this.pending.delete(key);this.failure??=error;});
    return work;
  }
  invokeClosure(options){
    const returned=this.receiveCallback(options).then(result=>{
      if(!result.completion)fail('duplicate callback completion requires explicit outcome reconciliation');
      return result.completion;
    });
    void returned.catch(()=>{});return returned;
  }
  receive({subscriptionId,eventId,args=[],completionPolicy='call-return',deliver=true}={}){
    if(this.failure)throw this.failure;
    if(!ID.test(subscriptionId??'')||!ID.test(eventId??'')||!Array.isArray(args)||typeof deliver!=='boolean')
      fail('invalid host event');
    const harness=this.harness,handler=harness.handlers.get(subscriptionId);
    if(!handler||handler.state!=='active'||harness.realms.get(handler.realmId)?.closed)
      fail('subscription is closed, lost or unregistered');
    // Capture and validate the caller graph before yielding or reserving an ID.
    const inputGraph=graphOf(args),policy=canonicalCompletionPolicy(completionPolicy);
    const key=JSON.stringify([subscriptionId,eventId]),pending=this.pending.get(key);
    if(pending){
      if(!eq(pending.inputGraph,inputGraph)||pending.policy!==policy)fail('conflicting pending duplicate');
      return pending.promise;
    }
    if(handler.seen.has(eventId)){
      let accepted=this.accepted.get(key);
      if(!accepted){
        const queued=handler.queue.find(row=>row.eventId===eventId),timeline=harness.exportEpisode().timeline;
        const delivered=timeline.find(row=>row.kind==='event'&&row.fields.subscriptionId===subscriptionId&&row.fields.eventId===eventId);
        const invoked=delivered&&timeline.find(row=>row.kind==='invocation'&&row.fields.invocationId===delivered.fields.invocationId);
        accepted=queued?{inputGraph:graphOf(queued.args),completionPolicy:queued.completionPolicy}:
          invoked?{inputGraph:normalGraph(invoked.fields.inputGraph),completionPolicy:invoked.fields.completionPolicy}:null;
      }
      if(!accepted||!eq(normalGraph(accepted.inputGraph),normalGraph(inputGraph))||accepted.completionPolicy!==policy)
        fail('conflicting accepted duplicate');
      return Promise.resolve({status:'duplicate',subscriptionId,eventId,receipt:this.receipt});
    }
    const reserved=[...this.pending.values()].filter(row=>row.subscriptionId===subscriptionId).length;
    if(handler.queue.length+reserved>=handler.queueLimit||this.pending.size>=4096)fail('event queue overflow');
    const timeline=harness.exportEpisode().timeline;
    const captured={schema:'semantic-host-arrival/8',sessionId:harness.inner.sessionId,
      visibleThrough:timeline.length,prefixDigest:hashAlgorithmData(timeline),subscriptionId,
      binding:owner(handler),event:{eventId,arrivalSequence:1,completionPolicy:policy,inputGraph}};
    validateHostIngressArrival(captured);
    const work=this.tail.then(async()=>{
      if(this.failure)throw this.failure;
      const {handler:current}=verifyOwnerAndPrefix(harness,captured);
      if(!['active','closing'].includes(current.state)||harness.realms.get(current.realmId)?.closed||current.seen.has(eventId)||
        current.queue.length>=current.queueLimit)fail('source handler changed before durable admission');
      captured.event.arrivalSequence=harness.inner.nextIngressSequence;
      validateHostIngressArrival(captured);
      const receipt=await this.journal.append(captured,{previous:this.head});
      validateHostIngressLogReceipt(receipt);
      // Read back the exact independent bytes before changing the live queue.
      const entries=validateHostIngressLogChain(await this.journal.readAll(receipt),receipt),last=entries.at(-1);
      if(!last||!eq(last.arrival,captured)||!eq(last.previous,this.head))fail('journal acknowledged different arrival bytes');
      this.head=copy(receipt);
      const {handler:live}=verifyOwnerAndPrefix(harness,captured);
      if(!['active','closing'].includes(live.state)||harness.realms.get(live.realmId)?.closed||live.seen.has(eventId)||
        live.queue.length>=live.queueLimit||harness.inner.nextIngressSequence!==captured.event.arrivalSequence)
        fail('source handler changed after durable admission; explicit recovery required');
      live.seen.add(eventId);
      this.accepted.set(key,copy(captured.event));
      live.queue.push({...copy(captured.event),args:argsOf(inputGraph),durableIngress:true});
      delete live.queue.at(-1).inputGraph;
      harness.inner.nextIngressSequence++;
      harness.inner.deliveries.push({subscriptionId,eventId,status:'buffered'});
      const result=deliver?harness.deliverReadyEvents(subscriptionId):null;
      return {status:result?'delivered':'buffered',subscriptionId,eventId,receipt:copy(receipt),delivery:result};
    });
    this.pending.set(key,{subscriptionId,inputGraph,policy,promise:work});
    this.tail=work.then(()=>{
      this.pending.delete(key);
      try{
        if(handler.state==='closing'&&!handler.queue.length&&!this.hasPendingSubscription(subscriptionId)&&
          ![...harness.invocations.values()].some(row=>row.triggerId.startsWith('event:'+subscriptionId+':')&&
            !['completed','cancelled','failed'].includes(row.status)))harness.closeEventHandler(subscriptionId);
      }catch(error){this.failure??=error;}
    },error=>{this.pending.delete(key);this.failure??=error;});
    return work;
  }
  /** Validate the complete externally selected chain, then add only arrivals
   * absent from the saved boundary. No delivery, service call or model restore.
   */
  static async recover({harness,journal,receipt}={}){
    validateHostIngressLogReceipt(receipt);
    if(!harness?.inner||harness.inner.hostIngressBroker||typeof journal?.append!=='function'||
      typeof journal?.readAll!=='function')fail('recovery requires a fresh intake owner and journal');
    const entries=validateHostIngressLogChain(await journal.readAll(receipt),receipt),
      staged=[],callbacks=[],callbackClaims=new Map(),identities=new Set(),sequences=new Set();
    let next=harness.inner.nextIngressSequence,previousSequence=0;
    const counts=new Map();
    for(const entry of entries){
      validateHostIngressLogEntry(entry);
      const arrival=entry.arrival,event=arrival.event,isCallback=arrival.schema==='semantic-callback-return-arrival/8',
        key=isCallback?'callback:'+event.invocationId:JSON.stringify([arrival.subscriptionId,event.eventId]);
      if(identities.has(key)||sequences.has(event.arrivalSequence)||
        previousSequence&&event.arrivalSequence!==previousSequence+1)
        fail('duplicate or reversed durable arrival');
      identities.add(key);sequences.add(event.arrivalSequence);previousSequence=event.arrivalSequence;
      if(isCallback){
        const {owner,timeline}=verifyCallbackArrival(harness,arrival),request=callbackRequest(arrival),
          queued=harness.inner.closureQueue.find(row=>row.invocationId===event.invocationId),
          invoked=timeline.find(row=>row.kind==='invocation'&&row.fields.invocationId===event.invocationId);
        callbackClaims.set(event.invocationId,request);
        if(queued){
          if(invoked||event.arrivalSequence>=harness.inner.nextIngressSequence||!eq(queued,request))
            fail('saved callback queue differs from durable arrival');
          continue;
        }
        if(invoked){
          const fields=invoked.fields;
          if(event.arrivalSequence>=harness.inner.nextIngressSequence||invoked.sequence<=arrival.visibleThrough||
            fields.activation!=='callback'||fields.parentInvocationId!==arrival.binding.ownerInvocationId||
            fields.closureId!==arrival.binding.closureId||fields.programId!==arrival.binding.programId||
            fields.realmId!==arrival.binding.realmId||fields.track!==arrival.binding.trackId||
            fields.taskRevision!==arrival.binding.taskRevision||fields.deadline!==arrival.binding.deadline||
            fields.triggerId!==event.invocationId||fields.ingressKey!==event.invocationId||fields.realmPolicy!=='retained'||
            fields.completionPolicy!=='await-returned-promise'||
            !sameCallbackInput(event,{inputGraph:fields.inputGraph,receiverValue:fields.receiver}))
            fail('delivered callback differs from durable arrival');
          continue;
        }
        if(event.arrivalSequence>next)fail('callback arrival skips the saved order');
        if(event.arrivalSequence===next)next++;
        if(['cancelled','failed'].includes(owner?.status)||harness.realms.get(owner?.realmId)?.closed){
          if(!timeline.some(row=>row.sequence>arrival.visibleThrough&&row.kind==='cancel'&&
            row.fields.invocationId===arrival.binding.ownerInvocationId))fail('discarded callback lacks owner cancellation');
          continue;
        }
        if(!owner||harness.inner.ingress.has(event.invocationId)||harness.inner.closureQueue.length+callbacks.length>=64)
          fail('callback has no available source owner or exceeds queue bound');
        callbacks.push(request);continue;
      }
      const {handler,timeline}=verifyOwnerAndPrefix(harness,arrival);
      const queued=handler.queue.find(row=>row.eventId===event.eventId);
      if(queued){
        if(!handler.seen.has(event.eventId)||event.arrivalSequence>=harness.inner.nextIngressSequence||
          queued.arrivalSequence!==event.arrivalSequence||queued.completionPolicy!==event.completionPolicy||
          !eq(graphOf(queued.args),normalGraph(event.inputGraph)))fail('saved queue differs from durable arrival');
        continue;
      }
      const delivered=timeline.find(row=>row.kind==='event'&&row.fields.subscriptionId===arrival.subscriptionId&&
        row.fields.eventId===event.eventId);
      if(delivered){
        const invoked=timeline.find(row=>row.kind==='invocation'&&row.fields.invocationId===delivered.fields.invocationId);
        if(event.arrivalSequence>=harness.inner.nextIngressSequence||delivered.sequence<=arrival.visibleThrough||
          !invoked||invoked.fields.completionPolicy!==event.completionPolicy||
          !eq(normalGraph(invoked.fields.inputGraph),normalGraph(event.inputGraph)))
          fail('delivered input differs from durable arrival');
        continue;
      }
      const discarded=timeline.find(row=>row.kind==='handler-close'&&row.fields.subscriptionId===arrival.subscriptionId&&
        row.fields.discarded.includes(event.eventId));
      if(discarded){if(discarded.sequence<=arrival.visibleThrough)fail('discard precedes arrival');continue;}
      if(event.arrivalSequence!==next||handler.seen.has(event.eventId)||
        !['active','lost'].includes(handler.state)||harness.realms.get(handler.realmId)?.closed)
        fail('unaccounted arrival cannot be applied at this saved boundary');
      const count=(counts.get(arrival.subscriptionId)??handler.queue.length)+1;
      if(count>handler.queueLimit)fail('restored arrival queue overflow');
      counts.set(arrival.subscriptionId,count);
      staged.push({handler,event:{eventId:event.eventId,arrivalSequence:event.arrivalSequence,
        completionPolicy:event.completionPolicy,args:argsOf(event.inputGraph),durableIngress:true}});next++;
    }
    if(previousSequence+1!==next)fail('saved arrival cursor does not match the durable head');
    const queuedIds=new Set();let queuedSequence=0;
    for(const request of harness.inner.closureQueue){
      if(queuedIds.has(request.invocationId)||request.arrivalSequence<=queuedSequence||
        !eq(request,callbackClaims.get(request.invocationId)))
        fail('saved callback queue contains unauthenticated, duplicate or reversed work');
      queuedIds.add(request.invocationId);queuedSequence=request.arrivalSequence;
    }
    // A saved subset can contain a later acknowledged arrival while an older
    // one exists only in the journal. Rebuild their authenticated FIFO together.
    const callbackQueue=[...harness.inner.closureQueue,...callbacks]
      .sort((left,right)=>left.arrivalSequence-right.arrivalSequence);
    // Every source, prefix, order and graph was checked before any live mutation.
    for(const {handler,event}of staged){handler.seen.add(event.eventId);handler.queue.push(event);}
    harness.inner.closureQueue.splice(0,harness.inner.closureQueue.length,...callbackQueue);
    harness.inner.nextIngressSequence=next;
    const broker=new DurableHostIngressBroker({harness,journal,receipt});
    for(const {arrival}of entries){
      if(arrival.schema==='semantic-callback-return-arrival/8')broker.acceptedCallbacks.set(arrival.event.invocationId,copy(arrival));
      else broker.accepted.set(JSON.stringify([arrival.subscriptionId,arrival.event.eventId]),copy(arrival.event));
    }
    return broker;
  }
}
