// Private host arrivals are not public observations until a callback is delivered.
// A durable snapshot binds their graphs and order to one exact public boundary.
import {isDeepStrictEqual} from 'node:util';
import {describeGraph} from '../training/graph.js';
import {decodeHostPayload} from '../host/materialize.js';
import {canonicalCompletionPolicy,validateGraph} from './record-schema.js';
import {assertAlgorithmFields,stableAlgorithmJSON} from './ir.js';
import {hashAlgorithmData} from './program.js';

const ID=/^[a-z][a-z0-9:_-]*$/,HASH=/^[a-f0-9]{64}$/;
const fields=['programId','realmId','trackId','realmPolicy','entry','queueLimit',
  'closureId','lifetime','ownerInvocationId'];
const fail=message=>{throw new TypeError('Pending host ingress: '+message);};
const binding=handler=>Object.fromEntries(fields.map(key=>[key,handler[key]]));
const graphOf=args=>{
  const graph=describeGraph(args);
  return {roots:graph.roots,objects:graph.objects.map(({properties,...node})=>
    ({...node,properties:properties.map(([key,value])=>({key,value}))}))};
};

export function validatePendingIngressSnapshot(snapshot){
  stableAlgorithmJSON(snapshot);
  assertAlgorithmFields(snapshot,['schema','sessionId','visibleThrough','prefixDigest',
    'nextIngressSequence','queues'],
    'pending ingress snapshot');
  if(snapshot.schema!=='semantic-pending-host-ingress/8'||!ID.test(snapshot.sessionId??'')||
     !Number.isSafeInteger(snapshot.visibleThrough)||snapshot.visibleThrough<0||
     !HASH.test(snapshot.prefixDigest??'')||!Number.isSafeInteger(snapshot.nextIngressSequence)||
     snapshot.nextIngressSequence<1||!Array.isArray(snapshot.queues)||snapshot.queues.length>4096)
    fail('invalid snapshot identity or bounds');
  const subscriptions=new Set(),arrivalSequences=new Set();
  for(const row of snapshot.queues){
    assertAlgorithmFields(row,['subscriptionId','binding','events'],'pending ingress queue');
    assertAlgorithmFields(row.binding,fields,'pending ingress owner');
    if(!ID.test(row.subscriptionId??'')||subscriptions.has(row.subscriptionId)||
       !Array.isArray(row.events)||row.events.length<1||row.events.length>4096)
      fail('invalid or duplicate subscription queue');
    subscriptions.add(row.subscriptionId);
    const seen=new Set();let previousSequence=0;
    for(const event of row.events){
      assertAlgorithmFields(event,['eventId','arrivalSequence','completionPolicy','inputGraph'],
        'pending ingress event');
      if(!ID.test(event.eventId??'')||seen.has(event.eventId)||
         !Number.isSafeInteger(event.arrivalSequence)||event.arrivalSequence<1||
         event.arrivalSequence>=snapshot.nextIngressSequence||event.arrivalSequence<=previousSequence||
         arrivalSequences.has(event.arrivalSequence))
        fail('invalid, duplicate or reversed event identity/order');
      seen.add(event.eventId);
      arrivalSequences.add(event.arrivalSequence);previousSequence=event.arrivalSequence;
      if(canonicalCompletionPolicy(event.completionPolicy)!==event.completionPolicy)
        fail('noncanonical completion policy');
      validateGraph(event.inputGraph);
    }
  }
  // Descriptor-only canonicalization also rejects accessors, proxies and cycles
  // outside the explicitly encoded argument graphs without executing caller code.
  stableAlgorithmJSON(snapshot);
  return snapshot;
}

export function capturePendingIngress(harness){
  if([...harness.inner.callbacks.values()].some(callback=>callback.queued.length)||
    harness.inner.closureQueue.length&&!harness.inner.hostIngressBroker)
    fail('unregistered or return-value callbacks require their own durable continuation');
  harness.inner.hostIngressBroker?.assertCallbackQueue();
  const publicData=harness.exportEpisode(),queues=[];
  for(const [subscriptionId,handler]of harness.handlers){
    if(!handler.queue.length)continue;
    if(!['active','closing','lost'].includes(handler.state))fail('queued event belongs to a closed handler');
    const events=handler.queue.map(event=>{
      if(!handler.seen.has(event.eventId))fail('queued event lacks accepted ingress ownership');
      return {eventId:event.eventId,arrivalSequence:event.arrivalSequence,
        completionPolicy:event.completionPolicy,inputGraph:graphOf(event.args)};
    });
    queues.push({subscriptionId,binding:binding(handler),events});
  }
  return validatePendingIngressSnapshot({schema:'semantic-pending-host-ingress/8',
    sessionId:harness.inner.sessionId,visibleThrough:publicData.timeline.length,
    prefixDigest:hashAlgorithmData(publicData.timeline),
    nextIngressSequence:harness.inner.nextIngressSequence,queues});
}

export function restorePendingIngress(harness,snapshot){
  validatePendingIngressSnapshot(snapshot);
  const publicData=harness.exportEpisode();
  if(snapshot.sessionId!==harness.inner.sessionId||snapshot.visibleThrough!==publicData.timeline.length||
     snapshot.prefixDigest!==hashAlgorithmData(publicData.timeline))fail('snapshot belongs to another public boundary');
  const staged=[];
  for(const row of snapshot.queues){
    const handler=harness.handlers.get(row.subscriptionId);
    if(!handler||!['active','closing'].includes(handler.state)||harness.realms.get(handler.realmId)?.closed||
       !isDeepStrictEqual(binding(handler),row.binding)||handler.queue.length||row.events.length>handler.queueLimit)
      fail('saved queue has no matching live source-owned handler');
    const events=row.events.map(event=>{
      if(handler.seen.has(event.eventId))fail('saved event was already delivered');
      const args=decodeHostPayload(JSON.stringify({schema:'owned-graph/1',...event.inputGraph}),'owned-graph/1');
      return {eventId:event.eventId,arrivalSequence:event.arrivalSequence,
        completionPolicy:event.completionPolicy,args,durableIngress:true};
    });
    staged.push({handler,events});
  }
  // No queue or duplicate set changes until every graph and owner is verified.
  for(const {handler,events}of staged){
    for(const event of events)handler.seen.add(event.eventId);
    handler.queue.push(...events);
  }
  harness.inner.nextIngressSequence=snapshot.nextIngressSequence;
}
