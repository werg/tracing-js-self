// Public replay owns execution authority. A checksum protects serialized bytes,
// but cannot authorize a new owner, request, result, resource or native action.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {stableAlgorithmJSON} from './ir.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw new TypeError('Checkpoint authority: '+message);};
const data=value=>JSON.parse(JSON.stringify(value));
const without=(value,...keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
function same(actual,expected,message){if(!equal(data(actual),data(expected)))fail(message);}
function publicMap(rows,expected,name){
  if(!Array.isArray(rows)||rows.some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string')||
    new Set(rows.map(row=>row[0])).size!==rows.length||
    !equal(rows.map(row=>row[0]),[...expected.keys()]))fail(name+' membership or identity differs from public history');
  return new Map(rows);
}
function plainData(value,ancestors=new Set(),depth=0){
  if(value===null||typeof value==='string'||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value)&&!Object.is(value,-0);
  if(!value||typeof value!=='object'||depth>64||ancestors.has(value)||
    !Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const keys=Reflect.ownKeys(value).filter(key=>!(Array.isArray(value)&&key==='length'));
  if(Array.isArray(value)&&(keys.length!==value.length||
    Array.from({length:value.length},(_,index)=>index).some(index=>!Object.hasOwn(value,index))))return false;
  const descriptors=keys.map(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key));
  if(descriptors.some(descriptor=>!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')))return false;
  ancestors.add(value);
  const valid=descriptors.every(descriptor=>plainData(descriptor.value,ancestors,depth+1));
  ancestors.delete(value);return valid;
}

/** Bind a native receipt to the exact selected request. The embedding separately
 * authenticates the native receipt; these fields alone do not prove model origin. */
export function validateNativeActionBinding(nativeAction,
    {invocationId,effectId,operation,payload,ownerTrack,witness}){
  if(!nativeAction||Array.isArray(nativeAction)||!plainData(nativeAction)||
    ['schema','actionKey','invocationId','effectId','operation','payload','ownerTrack','recordDigest']
      .some(field=>!Object.hasOwn(nativeAction,field))||
    nativeAction.schema!=='semantic-native-action/4'||
    typeof nativeAction.actionKey!=='string'||!nativeAction.actionKey||
    nativeAction.invocationId!==invocationId||nativeAction.effectId!==effectId||
    nativeAction.operation!==operation||nativeAction.payload!==payload||nativeAction.ownerTrack!==ownerTrack||
    nativeAction.recordDigest!==digest(typeof witness==='string'?witness:JSON.stringify(witness)))
    throw new TypeError('Native selected-action receipt differs from its committed request binding');
  return nativeAction;
}

/** Raw host arguments and their observed graph use different transport names.
 * Hash the selected entry, separate receiver and ordered graph topology, so a
 * restored invocation recognizes the same delivery without trusting a saved hash. */
export function canonicalInvocationIngressDigest(fields,graph,receiver){
  const aliases=new Map(graph.objects.map((node,index)=>[node.id,index])),
    value=tag=>tag[0]==='ref'&&aliases.has(tag[1])?['introduced',aliases.get(tag[1])]:tag;
  return digest(stableAlgorithmJSON({...fields,receiver:value(receiver),graph:{
    objects:graph.objects.map((node,index)=>({id:index,kind:node.kind,
      properties:node.properties.map(property=>({key:property.key,value:value(property.value)})),
      ...(Object.hasOwn(node,'prototype')?{prototype:node.prototype}:{})})),
    roots:graph.roots.map(value)}}));
}

/** Validate a direct core snapshot against an already checked public replay.
 * Pending private input is restored by the Region checked-ingress path, which
 * reads its independent receipt and original bytes. This direct snapshot API has
 * no such receipt, so its checksum never authorizes additional queued work.
 */
export function validateCheckpointAuthority(packet,verified){
  for(const name of ['sessionId','globalSequence','nextEventDelivery'])
    same(packet[name],verified[name],name+' differs from committed public history');
  for(const name of ['ownerSequences','ingress']){
    publicMap(packet[name],verified[name],name);
    same(packet[name],[...verified[name]],name+' differs from committed public history');
  }
  publicMap(packet.sourceAvailability,verified.sourceAvailability,'source availability');
  same(packet.sourceAvailability,[...verified.sourceAvailability].map(([key,value])=>[key,[...value]]),
    'source availability differs from committed public history');
  publicMap(packet.programs,verified.programs,'program');
  same(packet.programs,[...verified.programs],'program metadata differs from committed source context');

  const realms=publicMap(packet.realms,verified.realms,'realm');
  for(const [key,saved]of realms){
    const expected=verified.realms.get(key);
    same(saved,{...expected,heap:[...expected.heap].map(([id,node])=>[id,
      {...node,properties:[...node.properties]}]),locals:[...expected.locals]},
    'realm ownership or state differs from committed public history');
  }
  const activations=publicMap(packet.invocations,verified.invocations,'invocation');
  for(const [key,saved]of activations){
    const expected=verified.invocations.get(key);
    same(without(saved,'controller'),without(expected,'controller'),
      'invocation metadata differs from committed public history');
    // maxGenerated is an embedding policy also used when creating the restored
    // harness. Every saved controller must use that same checked positive bound.
    same(saved.controller,{...expected.controller.segmentPacket(),maxGenerated:packet.maxGenerated},
      'selected state contradicts committed public history');
  }

  const intents=publicMap(packet.intents,verified.intents,'intent');
  for(const [key,saved]of intents){
    const expected=verified.intents.get(key);
    if(saved.status==='dispatching')fail('unfinished durable dispatch boundary cannot be restored');
    if(saved.status!==expected.status&&!(expected.status==='dispatched'&&saved.status==='uncertain'))
      fail('intent status differs from committed public history');
    same({...saved,status:expected.status},without(expected,'args'),
      'intent or result identity differs from committed public history');
  }
  const callbacks=publicMap(packet.callbacks,verified.callbacks,'callback');
  for(const [key,saved]of callbacks){
    const expected=verified.callbacks.get(key);
    if(saved.state!==expected.state&&!(expected.state==='active'&&saved.state==='lost'))
      fail('callback lifetime differs from committed public history');
    if(!Array.isArray(saved.queued)||saved.queued.length)
      fail('pending private callback input requires independently retained checked ingress');
    same({...saved,state:expected.state},expected,
      'callback counter or descriptor differs from committed public history');
  }
  const handlers=publicMap(packet.handlers,verified.handlers,'handler');
  for(const [key,saved]of handlers){
    const expected=verified.handlers.get(key);
    if(saved.state!==expected.state&&!(expected.state==='active'&&saved.state==='lost'))
      fail('handler lifetime differs from committed public history');
    if(!Array.isArray(saved.queue)||saved.queue.length)
      fail('pending private handler input requires independently retained checked ingress');
    same({...saved,state:expected.state},{...expected,seen:[...expected.seen]},
      'handler descriptor or delivered input identities differ from committed public history');
  }
  if(!Array.isArray(packet.closureQueue)||packet.closureQueue.length)
    fail('pending private closure input requires independently retained checked ingress');
  // Notification registrations advance this counter through selected requests.
  // Ordinary and return-callback invocation spellings do not reserve it.
  if(!Number.isSafeInteger(packet.nextCallback)||packet.nextCallback!==verified.nextCallback)
    fail('callback counter differs from committed public identities');
  // Arrival ordering is private until delivered. Its cursor is checked against
  // independent ingress records by the durable Region restore path.
  if(!Number.isSafeInteger(packet.nextIngressSequence)||packet.nextIngressSequence<1)
    fail('invalid private ingress sequence cursor');
  return true;
}
