// Source-first semantic execution, selected-state ownership and effect delivery.
// No source interpreter or teacher future participates in this serving boundary.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalCompletionPolicy,validateGraph,assertValue,validateTypedSemanticRecord} from './record-schema.js';
import {SELECTED_STATE_FIELDS,MODEL_CONTEXT_INTERVAL,validateLifecycleRecord} from './lifecycle-schema.js';
import {SemanticExecutionController} from './execution-controller.js';
import {renderSemanticRecord} from './record-render.js';
import {analyzeSemanticProgram} from '../training/semantic-program.js';
import {describeGraph} from '../training/graph.js';
import {hostOperation} from '../host/operations.js';
import {decodeHostPayload,ownedCallbackId} from '../host/materialize.js';
import {canonicalInvocationIngressDigest,validateCheckpointAuthority,
  validateNativeActionBinding} from './checkpoint-authority.js';
import {hashAlgorithmData} from './program.js';

const ID=/^[a-z][a-z0-9:_-]*$/;
const clone=x=>structuredClone(x);
function demand(value,message){if(!value)throw new TypeError(message);}
function id(value,name){demand(typeof value==='string'&&ID.test(value), 'Invalid '+name);}
function retainedClosureFunction(program,closure,entry){
  const sites=name=>program.functions.filter(fn=>fn.name===name||'function:'+fn.start===name),
    retained=sites(closure.code),selected=sites(entry);
  demand(retained.length===1&&selected.length===1&&retained[0].start===selected[0].start,
    'Callback entry must identify the same unique static function site as its retained closure');
  return selected[0];
}
function assertEventInvocation(h,fields){
  const event=h.timeline.at(-1);
  if(event?.kind!=='event'){
    demand(fields.activation!=='callback'||fields.parentInvocationId!==null,
      'Parentless callback requires its immediately preceding registered event');
    return;
  }
  const handler=h.handlers.get(event.subscriptionId);
  demand(handler&&fields.invocationId===event.invocationId&&fields.programId===handler.programId&&
    fields.trackId===handler.trackId&&fields.realmId===event.realmId&&fields.triggerId===event.triggerId&&
    fields.ingressKey===event.triggerId&&fields.activation==='callback'&&
    fields.realmPolicy===handler.realmPolicy&&(fields.entry??handler.entry)===handler.entry&&
    fields.closureId===handler.closureId&&fields.parentInvocationId===handler.ownerInvocationId&&
    fields.taskRevision===(h.realms.get(handler.realmId)?.taskRevision??1)&&fields.deadline===null&&
    fields.receiver===undefined&&(fields.receiverValue===null||isDeepStrictEqual(fields.receiverValue,['undefined']))&&
    fields.bindings&&typeof fields.bindings==='object'&&!Array.isArray(fields.bindings)&&
    Object.keys(fields.bindings).length===0,
    'Event invocation differs from its registered handler delivery');
}
function nextEventOrdinal(h){
  let ordinal=h.nextEventDelivery;
  demand(Number.isSafeInteger(ordinal)&&ordinal>=0,'Invalid event delivery counter');
  do{
    ordinal++;demand(Number.isSafeInteger(ordinal),'Event delivery counter exhausted');
  }while(h.invocations.has('event'+ordinal));
  return ordinal;
}
function registeredResultCallbacks(h,key){
  const callbacks=[...h.callbacks].filter(([callbackKey])=>callbackKey.startsWith(key+'/'))
    .map(([,callback])=>callback);
  for(const callback of callbacks){
    const handler=h.handlers.get(callback.subscriptionId);
    demand(handler&&callback.state!=='pending'&&
      ['programId','realmId','trackId','entry','closureId','lifetime','ownerInvocationId']
        .every(field=>handler[field]===callback[field]),
      'Callback result requires its exact observed handler registration');
  }
  return callbacks;
}
function validateIngressQueueOrder(rows,nextSequence){
  demand(Number.isSafeInteger(nextSequence)&&nextSequence>=1,
    'Invalid next host ingress sequence');
  demand(Array.isArray(rows),'Invalid host ingress queues');
  const subscriptions=new Set(),sequences=new Set();
  for(const row of rows){
    demand(Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&row[1]&&
      Array.isArray(row[1].queue)&&!subscriptions.has(row[0]),'Invalid host ingress queue owner');
    subscriptions.add(row[0]);let previous=0;
    for(const event of row[1].queue){
      const sequence=event?.arrivalSequence;
      demand(Number.isSafeInteger(sequence)&&sequence>=1&&sequence<nextSequence&&
        sequence>previous&&!sequences.has(sequence),
        'Host ingress arrival order is invalid, duplicated or reversed');
      previous=sequence;sequences.add(sequence);
    }
  }
}
function tag(value){
  if(value===undefined)return ['undefined'];
  if(value===null)return ['null'];
  if(typeof value==='string')return ['str',value];
  if(typeof value==='boolean')return ['bool',value];
  if(typeof value==='bigint')return ['bigint',String(value)];
  if(typeof value==='number'){
    if(Object.is(value,-0))return ['num','-0'];
    if(Number.isNaN(value))return ['num','NaN'];
    if(value===Infinity)return ['num','+Infinity'];
    if(value===-Infinity)return ['num','-Infinity'];
    return ['num',value];
  }
  throw new TypeError('Unregistered external result codec (primitive only)');
}
function fail(message){throw new Error(message);}
class GuestCallbackFailure extends Error {
  constructor(invocationId,value){
    super('Owned callback '+invocationId+' threw');this.name='GuestCallbackFailure';
    this.invocationId=invocationId;this.guestValue=value;
  }
}
function graphOf(values){
  const graph=describeGraph(values);
  return {roots:graph.roots,objects:graph.objects.map(({properties,...node})=>
    ({...node,properties:properties.map(([key,value])=>({key,value}))}))};
}
function canonicalResultGraph(graph){
  validateGraph(graph);
  // Record field order has no guest meaning. Keep identity, property and tag
  // arrays in their observed order while matching canonical detailed JSON.
  return {objects:graph.objects.map(node=>({id:node.id,kind:node.kind,
    properties:node.properties.map(property=>({key:property.key,value:clone(property.value)})),
    ...(Object.hasOwn(node,'prototype')?{prototype:node.prototype}:{})})),roots:clone(graph.roots)};
}
function observedResultDigest(status,result,graph=null){
  assertValue(result);
  const captured=graph===null?{objects:[],roots:[result]}:canonicalResultGraph(graph);
  demand(captured.roots.length===1&&isDeepStrictEqual(captured.roots[0],result),
    'Observed result graph root mismatch');
  // Incoming object IDs are renamed when introduced into an existing realm.
  // Hash their local identities and ordered topology, not those transport
  // names. References without an introduced graph retain their realm identity.
  const aliases=new Map(captured.objects.map((node,index)=>[node.id,index])),
    value=tag=>tag[0]==='ref'&&aliases.has(tag[1])?['introduced',aliases.get(tag[1])]:clone(tag),
    identity={status,graph:{objects:captured.objects.map((node,index)=>({id:index,kind:node.kind,
      properties:node.properties.map(property=>({key:property.key,value:value(property.value)})),
      ...(Object.hasOwn(node,'prototype')?{prototype:node.prototype}:{})})),roots:captured.roots.map(value)}};
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
function remapGraph(graph,reserved){
  const aliases=new Map();let ordinal=0;
  for(const node of graph.objects){
    let candidate;do{candidate='o'+ordinal++;}while(reserved.has(candidate));
    aliases.set(node.id,candidate);reserved.add(candidate);
  }
  const value=v=>v[0]==='ref'&&aliases.has(v[1])?['ref',aliases.get(v[1])]:v;
  for(const node of graph.objects){
    node.id=aliases.get(node.id);
    for(const property of node.properties)property.value=value(property.value);
  }
  graph.roots=graph.roots.map(value);return graph;
}
function freeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);Object.freeze(value);
  }
  return value;
}

/**
 * The embedding owns adapters. The model can only commit semantic witness
 * records; it cannot publish observed results, bypass a source callsite or
 * run arbitrary generated JS in the host. Adapters receive evaluated values
 * from the selected controller, not new model-authored arguments.
 */
export class SelectedExecutionCore {
  static Controller=SemanticExecutionController;
  static contract=Object.freeze({executionVersion:'semantic-lifecycle/1',
    traceVersion:'semantic-typed-records/1',contextVersion:'semantic-model-context/1',
    continuationVersion:'semantic-execution-state/1',profile:'selected-execution-core/1',
    checkpointVersion:'semantic-lifecycle-checkpoint/1',supervisionVersion:'semantic-supervision/1'});
  static encodeRecord(kind,fields){return clone(validateTypedSemanticRecord({kind,fields}));}
  static decodeRecord(record){return clone(validateTypedSemanticRecord(record));}
  get contract(){return this.constructor.contract;}
  encodeRecord(kind,fields){return this.constructor.encodeRecord(kind,fields);}
  decodeRecord(record){return this.constructor.decodeRecord(record);}
  validateRecord(record){
    return validateLifecycleRecord(record,{...this.contract,decodeRecord:value=>this.decodeRecord(value)});
  }
  renderRecord(record){return renderSemanticRecord(this.decodeRecord(record));}
  constructor({sessionId='session1',services={},maxGenerated=4096,
      maxOutstanding=64,grants=null,journal=null,now=Date.now,automaticDelivery=true,
      materializeCallbackResult=null,prepareCallbackInput=null}={}){
    id(sessionId,'session ID');
    demand(services&&typeof services==='object'&&!Array.isArray(services),
      'Registered services must be a plain record');
    demand(Object.getPrototypeOf(services)===Object.prototype||
      Object.getPrototypeOf(services)===null,'Service registry must be a plain record');
    this.sessionId=sessionId;this.services=Object.create(null);
    for(const operation of Reflect.ownKeys(services)){
      const descriptor=Object.getOwnPropertyDescriptor(services,operation);
      demand(typeof operation==='string'&&descriptor&&
        Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='function',
        'Services require own function data properties');
      this.services[operation]=descriptor.value;
    }
    this.maxGenerated=maxGenerated;
    demand(Number.isSafeInteger(maxGenerated)&&maxGenerated>0&&
      Number.isSafeInteger(maxOutstanding)&&maxOutstanding>0,'Invalid execution bounds');
    demand(journal===null||['append','claim','readIntent'].every(method=>typeof journal[method]==='function'),
      'Durable action journal requires append, atomic claim and independently readable intents');
    this.maxOutstanding=maxOutstanding;this.grants=grants===null?null:new Set(grants);
    this.journal=journal;this.now=now;
    demand(typeof automaticDelivery==='boolean','Invalid delivery scheduling policy');
    this.automaticDelivery=automaticDelivery;
    demand(materializeCallbackResult===null||typeof materializeCallbackResult==='function',
      'Callback result resolver must be an embedding function');
    this.materializeCallbackResult=materializeCallbackResult;
    demand(prepareCallbackInput===null||typeof prepareCallbackInput==='function',
      'Callback input preparation must be an embedding function');
    this.prepareCallbackInput=prepareCallbackInput;
    this.programs=new Map();this.invocations=new Map();
    this.intents=new Map();this.inflight=new Map();this.timeline=[];
    this.ownerSequences=new Map();this.globalSequence=0;
    this.realms=new Map();this.handlers=new Map();this.nextEventDelivery=0;this.nextIngressSequence=1;
    this.callbacks=new Map();this.nextCallback=0;
    this.ingress=new Map();this.deliveries=[];this.rejections=[];
    this.sourceAvailability=new Map();this.abortControllers=new Map();
    this.closureQueue=[];this.completionWaiters=new Map();this.wakeWaiters=new Set();
    this.runnableListeners=new Set();
  }
  record(mode,kind,track,details){
    const ownerSequence=(this.ownerSequences.get(track)??0)+1;
    const item=freeze({schema:this.contract.executionVersion,session:this.sessionId,
      sequence:this.globalSequence+1,ownerSequence,track,mode,kind,...clone(details)});
    this.validateRecord(item);
    this.ownerSequences.set(track,ownerSequence);this.globalSequence++;
    this.timeline.push(item);return item;
  }
  publishProgram({programId,source,entry,capabilities=[],dependencies=[],sourceMap=null,
      languageProfile='owned-javascript/1',module=false,sourceMetadata=null,randomSeed=null}){
    id(programId,'program ID');
    demand(!this.programs.has(programId),'Program IDs are immutable and cannot be republished');
    demand(typeof source==='string'&&source.length&&typeof entry==='string',
      'Exact JS source and entry are required');
    demand(Array.isArray(capabilities)&&capabilities.every(c=>typeof c==='string')&&
      new Set(capabilities).size===capabilities.length,'Invalid capability grant');
    for(const capability of capabilities){
      hostOperation(capability);
      demand(!this.grants||this.grants.has(capability),'Capability exceeds host authority');
    }
    demand(Array.isArray(dependencies)&&dependencies.every(dependency=>
      dependency&&typeof dependency.programId==='string'&&
      this.programs.get(dependency.programId)?.digest===dependency.digest),
      'Dependencies must identify already published immutable programs');
    const analyzed=analyzeSemanticProgram(source);
    const {sites,functions}=analyzed;
    const digest=createHash('sha256').update(source,'utf8').digest('hex');
    const random=randomSeed===null?{}:{randomSeed};
    const code=this.encodeRecord('code',{entry,source,sites,...random});
    this.programs.set(programId,freeze({source,entry,code,digest,functions,
      capabilities:[...capabilities],dependencies:clone(dependencies),sourceMap:clone(sourceMap),
      languageProfile,module:Boolean(module),sourceMetadata:clone(sourceMetadata),...random}));
    return this.record('observed','program','host',
      {programId,digest,entry,source,sites,functions,capabilities,
        dependencies,sourceMap,languageProfile,module:Boolean(module),sourceMetadata,...random});
  }
  admitInvocation({programId,invocationId,trackId,realmId,triggerId,args=[],inputGraph=null,
      completionPolicy='call-return',realmPolicy='fresh',entry=null,receiver=undefined,
      receiverValue=null,closureId=null,activation='call',parentInvocationId=null,
      taskRevision=1,deadline=null,bindings={},ingressKey=triggerId}={}){
    for(const [value,name] of [[programId,'program ID'],[invocationId,'invocation ID'],
      [trackId,'track ID'],[realmId,'realm ID'],[triggerId,'trigger ID']])id(value,name);
    demand(Number.isSafeInteger(taskRevision)&&taskRevision>=1,'Invalid task revision');
    demand(deadline===null||Number.isFinite(deadline),'Invalid invocation deadline');
    demand(deadline===null||deadline>this.now(),'Invocation deadline already expired');
    demand(['call','module-init','callback'].includes(activation),'Invalid activation kind');
    completionPolicy=canonicalCompletionPolicy(completionPolicy);
    assertEventInvocation(this,{programId,invocationId,trackId,realmId,triggerId,ingressKey,
      activation,realmPolicy,entry,closureId,parentInvocationId,taskRevision,deadline,receiver,receiverValue,bindings});
    const program=this.programs.get(programId);
    demand(program,'Program must be observed before an invocation');
    const previous=this.realms.get(realmId);
    const closure=closureId===null?null:previous?.heap.get(closureId);
    const selectedEntry=entry??closure?.code??program.entry;
    demand(Array.isArray(args),'Invocation arguments must be a graph');
    demand(inputGraph===null||args.length===0,
      'Cannot mix observed input graph with new JavaScript arguments');
    const graph=inputGraph===null?graphOf([receiver,...args]):clone(inputGraph);
    const ingressReceiver=inputGraph===null?graph.roots[0]:(receiverValue??['undefined']),
      ingressGraph=inputGraph===null?{...graph,roots:graph.roots.slice(1)}:graph;
    validateGraph(ingressGraph,{externalReferences:previous?[...previous.heap.keys()]:[]});
    assertValue(ingressReceiver);
    const ingressDigest=canonicalInvocationIngressDigest({programId,invocationId,
      trackId,realmId,triggerId,completionPolicy,realmPolicy,entry:selectedEntry,closureId,activation,
      parentInvocationId,taskRevision,deadline,bindings,ingressKey},ingressGraph,ingressReceiver);
    if(this.invocations.has(invocationId)){
      const prior=this.invocations.get(invocationId);
      demand(prior.ingressKey===ingressKey&&prior.programId===programId&&
        prior.taskRevision===taskRevision&&prior.trackId===trackId&&prior.realmId===realmId,
        'Invocation identity reused with a different delivery');
      demand(prior.ingressDigest===ingressDigest,'Conflicting duplicate invocation payload');
      return this.timeline.find(item=>item.kind==='invocation'&&item.invocationId===invocationId);
    }
    demand(!this.ingress.has(ingressKey),'Ingress key already owns another invocation');
    demand(closureId===null||closure?.kind==='closure','Invocation closure belongs to another or unknown realm');
    // A host may select an unambiguous spelling of the retained function, but
    // cannot pair another function's parameters/code with this closure's cells.
    // Check before importing input or publishing any realm/ingress mutation.
    const declared=closure?retainedClosureFunction(program,closure,selectedEntry):
      program.functions.find(f=>f.name===selectedEntry||'function:'+f.start===selectedEntry);
    demand(selectedEntry===program.entry||declared,
      'Invoked closure must have a declared static function site');
    demand(realmPolicy==='fresh'||realmPolicy==='retained','Invalid realm policy');
    demand(!previous||!previous.running,'Shared realm already has an active guest turn');
    demand(!previous?.closed,'Closed realm cannot be resurrected');
    demand(!previous||realmPolicy==='retained','Fresh realm identity cannot be reused');
    demand(!previous||previous.digest===program.digest,'Retained realm source revision mismatch');
    demand(!previous||this.programs.get(previous.programId)?.randomSeed===program.randomSeed,
      'Retained realm deterministic seed mismatch');
    demand(!previous||taskRevision>=previous.taskRevision,'Stale task revision');
    demand(activation==='module-init'||!program.module||previous?.initialized,
      'Module initialization must complete before entry invocation');
    demand(activation!=='module-init'||!previous?.initializationStarted,
      'Module initialization cannot be repeated');
    if(parentInvocationId!==null){
      const parent=this.invocations.get(parentInvocationId);
      demand(parent&&!['cancelled','failed'].includes(parent.status),'Child has no live owning invocation');
    }
    // A fresh selected state domain is an explicit policy, not an implicit
    // mutation of a previous invocation or native module initialization.
    // New argument objects must not reuse identities held by live captured
    // closures or old input graphs. Preserve aliases, sparse entries and cycles.
    if(inputGraph===null&&previous)remapGraph(graph,new Set(previous.heap.keys()));
    const selectedReceiver=inputGraph===null?graph.roots.shift():(receiverValue??['undefined']);
    assertValue(selectedReceiver);
    const retained=previous?[...previous.heap.keys()]:[];
    validateGraph(graph,{externalReferences:retained});
    demand(graph.objects.every(node=>!previous?.heap.has(node.id)),
      'Invocation input cannot overwrite a retained identity');
    if(selectedReceiver[0]==='ref')demand(retained.includes(selectedReceiver[1])||
      graph.objects.some(node=>node.id===selectedReceiver[1]),'Unknown receiver identity');
    // The legacy input wire uses JSON text. Restore its established schema
    // field order after checkpoint serialization, without changing any graph
    // identity, property-array order, alias or cycle. Validation precedes this
    // reconstruction so unknown fields cannot be silently removed.
    const inputGraphFields={roots:graph.roots,objects:graph.objects.map(node=>({id:node.id,kind:node.kind,
      ...(Object.hasOwn(node,'prototype')?{prototype:node.prototype}:{}),
      properties:node.properties.map(property=>({key:property.key,value:property.value}))}))};
    const input=this.encodeRecord('input',{graph:inputGraphFields,...(retained.length?{retained}:{})});
    const sourceCode=selectedEntry===program.entry?program.code:
      this.encodeRecord('code',{entry:selectedEntry,source:program.source,
        sites:analyzeSemanticProgram(program.source).sites,
        ...(program.randomSeed===undefined?{}:{randomSeed:program.randomSeed})});
    const initialBindings={};
    for(const [index,name] of (declared?.params??[]).entries())
      if(name)initialBindings[name]=graph.roots[index]??['undefined'];
    demand(bindings&&typeof bindings==='object'&&!Array.isArray(bindings),'Invalid source bindings');
    for(const [name,index] of Object.entries(bindings)){
      demand(Number.isSafeInteger(index)&&index>=0&&index<graph.roots.length,'Binding has no observed argument');
      initialBindings[name]=graph.roots[index];
    }
    const captureAliases=Object.fromEntries((closure?.captures??[]).map(c=>[c.binding,c.cell]));
    let bindingOrdinal=0;
    for(const name of Object.keys(initialBindings)){
      let cell;do{cell='a'+this.invocations.size+'b'+bindingOrdinal++;}while(previous?.locals.has(cell));
      captureAliases[name]=cell;
    }
    const controller=new this.constructor.Controller([sourceCode,input],{
      capabilities:program.capabilities,maxGenerated:this.maxGenerated,
      completionPolicy,observationAuthority:'broker',rootInvocation:invocationId,
      trackId,receiver:selectedReceiver,retainedState:previous,initialBindings,captureAliases,
      strictRequests:true});
    if(previous&&program.randomSeed!==undefined)controller.randomState=previous.randomState;
    this.realms.set(realmId,{...previous,digest:program.digest,programId,policy:realmPolicy,
      running:invocationId,heap:controller.heap,locals:controller.locals,
      ...(program.randomSeed===undefined?{}:{randomState:controller.randomState}),
      scheduler:controller.scheduler,
      revision:(previous?.revision??0)+1,taskRevision,
      initialized:previous?.initialized??!program.module,
      initializationStarted:previous?.initializationStarted||activation==='module-init'});
    this.invocations.set(invocationId,{programId,trackId,realmId,triggerId,
      controller,input,status:'running',completionPolicy,realmPolicy,entry:selectedEntry,
      receiver:selectedReceiver,closureId,activation,parentInvocationId,taskRevision,deadline,
      ingressKey,ingressDigest,bindings:clone(bindings)});
    this.ingress.set(ingressKey,invocationId);
    if(!this.sourceAvailability.has(trackId))this.sourceAvailability.set(trackId,new Set());
    this.sourceAvailability.get(trackId).add(programId);
    const receipt=this.record('observed','invocation',trackId,
      {programId,invocationId,realmId,triggerId,completionPolicy,realmPolicy,
        inputGraph:graph,entry:selectedEntry,sourceDigest:program.digest,receiver:selectedReceiver,
        closureId,activation,parentInvocationId,taskRevision,deadline,bindings,ingressKey});
    this.wake();
    if(activation==='callback'&&!this.replaying)
      for(const listener of this.runnableListeners)listener(invocationId);
    return receipt;
  }
  /** Outside handler ingress is host-authorized. It never invents a guest
   * subscription request; JS-selected listener registration has a separate
   * effect/callback ABI. One event activates a selected handler only after
   * a real host delivery has been admitted. */
  commitCallbackEvent(subscriptionId,eventId){
    const suffix=/^callbackevent([1-9][0-9]*)$/.exec(eventId);
    if(!suffix)return;
    const sequence=Number(suffix[1]);
    demand(Number.isSafeInteger(sequence),'Invalid native callback event sequence');
    for(const callback of this.callbacks.values())if(callback.subscriptionId===subscriptionId)
      callback.sequence=Math.max(callback.sequence,sequence);
  }
  registerEventHandler({subscriptionId,programId,realmId,trackId,entry=null,
      realmPolicy='retained',queueLimit=64,closureId=null,lifetime='subscription',
      ownerInvocationId=null}){
    for(const [value,name] of [[subscriptionId,'subscription ID'],
      [programId,'program ID'],[realmId,'realm ID'],[trackId,'track ID']])
      id(value,name);
    demand(this.programs.has(programId),'Handler requires an observed program');
    demand(!this.realms.get(realmId)?.closed,'Cannot register a handler in a closed realm');
    demand(!this.handlers.has(subscriptionId),'Subscription identity already exists');
    demand(realmPolicy==='retained'||realmPolicy==='fresh','Invalid handler realm policy');
    demand(Number.isSafeInteger(queueLimit)&&queueLimit>=1&&queueLimit<=4096,
      'Invalid bounded event queue');
    const program=this.programs.get(programId);
    demand(entry===null||entry===program.entry||
      program.functions.some(f=>f.name===entry||'function:'+f.start===entry),
      'Event handler closure must have a static function source site');
    demand(['subscription','call'].includes(lifetime),'Invalid callback lifetime');
    demand(closureId===null||this.realms.get(realmId)?.heap.get(closureId)?.kind==='closure',
      'Handler requires an owned closure in its realm');
    const realm=this.realms.get(realmId),closure=closureId===null?null:realm.heap.get(closureId),
      selectedEntry=entry??closure?.code??program.entry;
    for(const [key,callback] of this.callbacks)if(callback.subscriptionId===subscriptionId){
      const effectKey=key.slice(0,key.lastIndexOf('/'));
      demand(['dispatched','uncertain'].includes(this.intents.get(effectKey)?.status)&&
        callback.state==='pending'&&realmPolicy==='retained'&&queueLimit===64&&
        callback.programId===programId&&callback.realmId===realmId&&callback.trackId===trackId&&
        callback.entry===selectedEntry&&callback.closureId===closureId&&
        callback.lifetime===lifetime&&callback.ownerInvocationId===ownerInvocationId,
        'Handler registration differs from its dispatched callback capability');
    }
    demand(closureId===null||realmPolicy==='retained','A retained handler closure requires its retained realm');
    if(ownerInvocationId!==null){
      const owner=this.invocations.get(ownerInvocationId);
      demand(owner&&!['cancelled','failed'].includes(owner.status)&&owner.programId===programId&&
        owner.realmId===realmId&&owner.trackId===trackId,'Handler owner differs from its live source realm');
    }
    if(closure){
      demand(realm.digest===program.digest,'Handler closure belongs to a different source revision');
      retainedClosureFunction(program,closure,selectedEntry);
    }
    this.handlers.set(subscriptionId,{programId,realmId,trackId,realmPolicy,
      entry:selectedEntry,queueLimit,seen:new Set(),queue:[],state:'active',
      closureId,lifetime,ownerInvocationId});
    for(const callback of this.callbacks.values())
      if(callback.subscriptionId===subscriptionId)callback.state='active';
    return this.record('observed','handler','host',
      {subscriptionId,programId,realmId,trackId,realmPolicy,
        entry:selectedEntry,queueLimit,closureId,lifetime,ownerInvocationId});
  }
  queuedEventCanBeDelivered(handler){
    const head=handler?.queue?.[0],realm=this.realms.get(handler?.realmId);
    return Boolean(head&&Number.isSafeInteger(head.arrivalSequence)&&
      (['active','closing'].includes(handler.state)||
        handler.state==='lost'&&head.durableIngress===true)&&
      !realm?.closed&&!(handler.realmPolicy==='retained'&&realm?.running));
  }
  nextQueuedEventSubscription(realmId,{retainedOnly=false}={}){
    let selected=null,sequence=Infinity;
    for(const [subscriptionId,handler]of this.handlers){
      if(handler.realmId!==realmId||retainedOnly&&handler.realmPolicy!=='retained'||
         !this.queuedEventCanBeDelivered(handler))continue;
      const next=handler.queue[0].arrivalSequence;
      if(next<sequence){selected=subscriptionId;sequence=next;}
    }
    if(this.handlers.get(selected)?.realmPolicy==='retained'&&
      this.closureQueue.some(request=>this.invocations.get(request.ownerInvocationId)?.realmId===realmId&&
      Number.isSafeInteger(request.arrivalSequence)&&request.arrivalSequence<sequence))return null;
    return selected;
  }
  /** Queue each accepted outside arrival once. Delivery is separate, and
   * model-visible only when its realm can legally accept another turn. */
  postEvent({subscriptionId,eventId,args=[],completionPolicy='call-return',deliver=true}){
    if(this.hostIngressBroker)return this.hostIngressBroker.receive({subscriptionId,eventId,args,completionPolicy,deliver});
    id(subscriptionId,'subscription ID');id(eventId,'event ID');
    const handler=this.handlers.get(subscriptionId);
    demand(!this.realms.get(handler?.realmId)?.closed,'Cannot deliver an event to a closed realm');
    if(!handler||handler.state!=='active'){
      this.deliveries.push({subscriptionId,eventId,status:'quarantined',reason:'closed-or-unregistered'});
      throw new Error('Subscription is closed or unregistered');
    }
    if(handler.seen.has(eventId)){
      this.deliveries.push({subscriptionId,eventId,status:'duplicate'});
      return {status:'duplicate',subscriptionId,eventId};
    }
    demand(Array.isArray(args),'Event arguments require an explicit graph');
    graphOf(args); // Reject getters, proxies and unrepresentable payloads before accepting arrival.
    completionPolicy=canonicalCompletionPolicy(completionPolicy);
    if(handler.queue.length>=handler.queueLimit){
      this.deliveries.push({subscriptionId,eventId,status:'refused',reason:'overflow'});
      throw new Error('Event queue overflow');
    }
    const ownedArgs=clone(args),arrivalSequence=this.nextIngressSequence;
    demand(Number.isSafeInteger(arrivalSequence)&&arrivalSequence>=1&&
      arrivalSequence<Number.MAX_SAFE_INTEGER,'Host ingress sequence exhausted');
    handler.seen.add(eventId);
    handler.queue.push({eventId,arrivalSequence,args:ownedArgs,completionPolicy});
    this.nextIngressSequence=arrivalSequence+1;
    this.deliveries.push({subscriptionId,eventId,status:'buffered'});
    return deliver?this.deliverReadyEvents(subscriptionId):{status:'buffered',subscriptionId,eventId};
  }
  deliverReadyEvents(subscriptionId){
    const handler=this.handlers.get(subscriptionId);
    demand(handler,'Unknown subscription');
    demand(!this.realms.get(handler.realmId)?.closed,'Cannot deliver an event to a closed realm');
    if(!this.queuedEventCanBeDelivered(handler))return null;
    if(handler.realmPolicy==='retained'&&
       this.nextQueuedEventSubscription(handler.realmId,{retainedOnly:true})!==subscriptionId)return null;
    const ordinal=nextEventOrdinal(this),invocationId='event'+ordinal;
    const next=handler.queue.shift();this.nextEventDelivery=ordinal;
    const triggerId='event:'+subscriptionId+':'+next.eventId;
    const realmId=handler.realmPolicy==='retained'?
      handler.realmId:handler.realmId+invocationId;
    this.record('observed','event',handler.trackId,
      {subscriptionId,eventId:next.eventId,invocationId,triggerId,
        programId:handler.programId,realmId});
    this.commitCallbackEvent(subscriptionId,next.eventId);
    return this.admitInvocation({programId:handler.programId,invocationId,
      realmId,trackId:handler.trackId,triggerId,
      realmPolicy:handler.realmPolicy,entry:handler.entry,args:next.args,
      completionPolicy:next.completionPolicy,closureId:handler.closureId,
      activation:'callback',parentInvocationId:handler.ownerInvocationId,
      taskRevision:this.realms.get(handler.realmId)?.taskRevision??1});
  }
  closeEventHandler(subscriptionId){
    id(subscriptionId,'subscription ID');
    this.hostIngressBroker?.assertCanRetire(subscriptionId);
    const handler=this.handlers.get(subscriptionId);
    if(handler?.state==='closed')return this.timeline.findLast(item=>
      item.kind==='handler-close'&&item.subscriptionId===subscriptionId);
    demand(handler&&['active','closing','lost'].includes(handler.state),'No active subscription to close');
    handler.state='closed';
    for(const callback of this.callbacks.values())
      if(callback.subscriptionId===subscriptionId)callback.state='revoked';
    const discarded=handler.queue.map(event=>event.eventId);
    handler.queue.length=0;
    const receipt=this.record('observed','handler-close','host',{subscriptionId,discarded});
    for(const [callbackKey,callback] of this.callbacks)if(callback.subscriptionId===subscriptionId){
      const key=callbackKey.slice(0,callbackKey.lastIndexOf('/'));
      if(![...this.callbacks].some(([otherKey,other])=>otherKey.startsWith(key+'/')&&other.state==='active')){
        this.abortControllers.get(key)?.abort(new Error('Subscription closed'));
        this.abortControllers.delete(key);
      }
    }
    return receipt;
  }
  selected(invocationId,line){
    try{return this.commitSelected(invocationId,line);}
    catch(error){
      this.rejections.push({invocationId,line,error:String(error),sequence:this.globalSequence});
      throw error;
    }
  }
  commitSelected(invocationId,line){
    id(invocationId,'invocation ID');
    const activation=this.invocations.get(invocationId);
    demand(activation&&['running','suspended','returned'].includes(activation.status),
      'Invocation is not runnable');
    demand(activation.deadline===null||activation.deadline>this.now(),'Invocation deadline expired');
    demand(this.sourceAvailability.get(activation.trackId)?.has(activation.programId),
      'Source is unavailable; a checked source read is required');
    const realm=this.realms.get(activation.realmId);
    const {kind,fields}=this.decodeRecord(line);
    demand(kind==='end'||!realm.running||realm.running===invocationId,
      'Shared realm has another active guest turn');
    if(kind==='resume'||kind==='job'&&fields.action==='dispatch'){
      this.assertNoOtherActiveJob(invocationId);
      const selectedReady=activation.controller.continuations.get(fields.continuation)??
        activation.controller.jobs.get(fields.job);
      const earlier=[...this.invocations.values()].filter(other=>other.realmId===activation.realmId)
        .some(other=>other.controller.ready.some(identity=>{
          const ready=other.controller.continuations.get(identity)??other.controller.jobs.get(identity);
          return ready.readySequence<selectedReady?.readySequence;
        }));
      demand(!earlier,'Shared realm Promise jobs must preserve their global ready order');
    }
    demand(kind!=='observe'&&kind!=='code'&&kind!=='input',
      'Host observations are not selected model actions');
    if(kind==='request'){
      demand([...this.intents.values()].filter(intent=>
        intent.invocationId===invocationId&&['committed','dispatched','uncertain'].includes(intent.status)
      ).length<this.maxOutstanding,'Outstanding native effect budget exhausted');
      const spec=hostOperation(fields.operation);
      for(const slot of spec.callbackIndices??[]){
        const argument=fields.arguments[slot];
        const closure=argument?.[0]==='ref'?
          activation.controller.heap.get(argument[1]):null;
        const program=this.programs.get(activation.programId);
        demand(closure?.kind==='closure'&&typeof closure.code==='string'&&
          program.functions.some(fn=>fn.name===closure.code||'function:'+fn.start===closure.code),
          'Selected callback must be a declared owned closure');
      }
    }
    // Suspended invocations and callbacks share the realm's deterministic
    // stream. Refresh it before a resumed turn instead of resetting its seed.
    if(Object.hasOwn(realm,'randomState'))activation.controller.randomState=realm.randomState;
    const answer=activation.controller.commitRecord({kind,fields},{track:activation.trackId,mode:'generated'});
    if(Object.hasOwn(realm,'randomState'))realm.randomState=activation.controller.randomState;
    if(kind!=='end')realm.running=invocationId;
    activation.status='running';
    if(kind==='request'){
      const key=invocationId+'/'+fields.effect;
      // Controller validation happens BEFORE the dispatch intent becomes
      // committed; invalid or partial witness bytes have no external effects.
      demand(!this.intents.has(key),'Duplicate intent key');
      const effect=activation.controller.effects.get(fields.effect);
      this.intents.set(key,{status:'committed',operation:effect.operation,
        args:clone(effect.arguments),payload:effect.payload,invocationId,
        effectId:fields.effect,attempts:0,taskRevision:activation.taskRevision,
        payloadDigest:createHash('sha256').update(effect.payload).digest('hex'),
        witness:line,result:null});
      const spec=hostOperation(effect.operation);
      for(const slot of spec.callbackIndices??[]){
        const argument=fields.arguments[slot];
        const closureId=argument?.[0]==='ref'?argument[1]:null;
        const selectedClosure=activation.controller.heap.get(closureId);
        if(typeof closureId!=='string'||selectedClosure?.kind!=='closure'||
           typeof selectedClosure.code!=='string')
          throw new TypeError('Selected callback must reference an owned closure');
        const program=this.programs.get(activation.programId);
        demand(program.functions.some(f=>f.name===selectedClosure.code||
          'function:'+f.start===selectedClosure.code),
          'Callback source closure is not declared in immutable program');
        const callbackKey=key+'/'+slot;
        this.callbacks.set(callbackKey,{state:'pending',slot,closureId,
          entry:selectedClosure.code,realmId:activation.realmId,
          programId:activation.programId,trackId:activation.trackId,
          subscriptionId:'callback'+(++this.nextCallback),
          lifetime:spec.callbackLifetime??'call',sequence:0,queued:[],ownerInvocationId:invocationId});
      }
    }
    if(kind==='end'){
      activation.status='completed';
      realm.heap=activation.controller.heap;
      realm.locals=activation.controller.locals;
      if(realm.running===invocationId)realm.running=null;
      if(activation.activation==='module-init')realm.initialized=
        activation.controller.completion.kind==='return';
    }else if(!activation.controller.stack.length){
      activation.status=activation.controller.pending?'returned':'suspended';
      realm.running=null;
    }
    this.record('generated','semantic',activation.trackId,
      {invocationId,traceFormat:this.contract.traceVersion,line});
    if(kind==='end'){
      const waiter=this.completionWaiters.get(invocationId);
      if(waiter){
        this.completionWaiters.delete(invocationId);
        const completion=activation.controller.completion;
        try{
          const value=this.materializeCallbackResult?this.materializeCallbackResult({invocationId,
            realmId:activation.realmId,programId:activation.programId,value:clone(completion.value),
            completion:clone(completion)}):activation.controller.materialize(completion.value);
          if(completion.kind==='throw')waiter.reject(new GuestCallbackFailure(invocationId,value));
          else waiter.resolve(value);
        }catch(error){waiter.reject(error);}
      }
      if(!this.replaying)for(const [subscriptionId,handler] of this.handlers)
        if(handler.realmId===activation.realmId&&handler.state==='closing'&&!handler.queue.length&&
          !this.hostIngressBroker?.hasPendingSubscription(subscriptionId)&&
           ![...this.invocations.values()].some(other=>
             other.triggerId.startsWith('event:'+subscriptionId+':')&&
             !['completed','cancelled','failed'].includes(other.status)))
          this.closeEventHandler(subscriptionId);
    }
    if(!realm.running&&!this.replaying&&this.automaticDelivery)this.activateQueuedClosures(activation.realmId);
    if(!realm.running&&!this.replaying&&this.automaticDelivery){
      const subscriptionId=this.nextQueuedEventSubscription(activation.realmId);
      if(subscriptionId)this.deliverReadyEvents(subscriptionId);
    }
    this.wake();
    return answer;
  }
  onRunnable(listener){
    demand(typeof listener==='function','Runnable observer must be a function');
    this.runnableListeners.add(listener);return ()=>this.runnableListeners.delete(listener);
  }
  nextReadyInvocation(realmId){
    let selected=null,sequence=Infinity;
    for(const [invocationId,activation] of this.invocations)if(activation.realmId===realmId&&
        !['completed','cancelled','failed'].includes(activation.status)){
      const identity=activation.controller.ready[0];
      const ready=activation.controller.continuations.get(identity)??activation.controller.jobs.get(identity);
      if(ready&&ready.readySequence<sequence){sequence=ready.readySequence;selected=invocationId;}
    }
    return selected;
  }
  assertNoOtherActiveJob(invocationId){
    const activation=this.invocations.get(invocationId);
    demand(activation,'Unknown invocation');
    demand(![...this.invocations].some(([otherId,other])=>otherId!==invocationId&&
      other.realmId===activation.realmId&&other.controller.activeJob),
      'Shared realm has an unfinished Promise job owned by another invocation');
  }
  refreshRealmReady(realmId){
    for(const other of this.invocations.values())if(other.realmId===realmId)
      other.controller.refreshReady();
  }
  wake(){for(const resolve of this.wakeWaiters)resolve();this.wakeWaiters.clear();}
  waitForActivity(){return new Promise(resolve=>this.wakeWaiters.add(resolve));}
  prepareClosureInput({ownerInvocationId,closureId,args=[],receiver=undefined}){
    const owner=this.invocations.get(ownerInvocationId);
    demand(owner&&!['cancelled','failed'].includes(owner.status),'Callback owner is closed');
    demand(!this.realms.get(owner.realmId)?.closed,'Cannot enqueue a callback in a closed realm');
    demand(Array.isArray(args),'Callback arguments must be an array');
    const realm=this.realms.get(owner.realmId),closure=realm?.heap.get(closureId);
    demand(closure?.kind==='closure','Callback requires an owned closure');
    const prepared=this.prepareCallbackInput?.({ownerInvocationId,closureId,args,receiver,
      realmId:owner.realmId,programId:owner.programId});
    let inputGraph,receiverValue;
    if(prepared){
      demand(prepared&&typeof prepared==='object'&&prepared.inputGraph,
        'Callback input preparation requires an explicit graph');
      inputGraph=clone(prepared.inputGraph);receiverValue=clone(prepared.receiverValue??['undefined']);
    }else {
      // Capture receiver and arguments together. Separate structuredClone calls
      // split cross-root aliases and can give a callback a different receiver.
      inputGraph=remapGraph(graphOf([receiver,...args]),new Set(realm.heap.keys()));
      receiverValue=inputGraph.roots.shift();
    }
    validateGraph(inputGraph,{externalReferences:[...realm.heap.keys()]});
    demand(inputGraph.objects.every(node=>!realm.heap.has(node.id)),
      'Prepared callback graph cannot overwrite retained identities');
    assertValue(receiverValue);
    demand(receiverValue[0]!=='ref'||realm.heap.has(receiverValue[1])||
      inputGraph.objects.some(node=>node.id===receiverValue[1]),'Unknown callback receiver identity');
    return {ownerInvocationId,closureId,inputGraph,receiverValue};
  }
  enqueueClosure(options){
    if(this.hostIngressBroker)return this.hostIngressBroker.invokeClosure(options);
    const request=this.prepareClosureInput(options),owner=this.invocations.get(request.ownerInvocationId);
    demand(this.closureQueue.length<64,'Owned callback queue overflow');
    // Callback invocation names are identities, not notification registration
    // ordinals. Pending private input must not advance a public allocator that
    // replay can reconstruct only from selected registration requests.
    let ordinal=1;
    while(this.invocations.has('callbackinvoke'+ordinal)||
      this.closureQueue.some(request=>request.invocationId==='callbackinvoke'+ordinal)){
      ordinal++;demand(Number.isSafeInteger(ordinal),'Owned callback identity counter exhausted');
    }
    const invocationId='callbackinvoke'+ordinal;
    this.closureQueue.push({...request,invocationId});
    const completion=new Promise((resolve,reject)=>this.completionWaiters.set(invocationId,{resolve,reject}));
    // Prevent a host that abandons a callback on cancellation from causing an
    // unhandled native rejection; the original Promise still rejects to it.
    void completion.catch(()=>{});
    this.activateQueuedClosures(owner.realmId);this.wake();return completion;
  }
  /** Read the selected callback's saved completion after a process restore.
   * This reports guest state only: it never recreates the dead adapter Promise
   * or resumes/re-dispatches the native parent operation. A host adapter that
   * owns a durable continuation can use this value as input to explicit
   * reconciliation of that parent's uncertain intent.
   */
  callbackOutcome(invocationId){
    const activation=this.invocations.get(invocationId);
    demand(activation?.activation==='callback','Unknown selected callback invocation');
    if(activation.status==='completed'){
      const completion=clone(activation.controller.completion);
      return {status:completion.kind==='throw'?'rejected':'fulfilled',completion};
    }
    if(['failed','cancelled'].includes(activation.status))
      return {status:activation.status,reason:activation.reason??null};
    return {status:'pending'};
  }
  activateQueuedClosures(realmId){
    const realm=this.realms.get(realmId);
    if(!realm||realm.running)return null;
    const index=this.closureQueue.findIndex(request=>
      this.invocations.get(request.ownerInvocationId)?.realmId===realmId);
    if(index<0)return null;
    const request=this.closureQueue[index];
    if(Number.isSafeInteger(request.arrivalSequence)&&[...this.handlers.values()].some(handler=>
      handler.realmId===realmId&&handler.realmPolicy==='retained'&&this.queuedEventCanBeDelivered(handler)&&
      handler.queue[0].arrivalSequence<request.arrivalSequence))return null;
    const owner=this.invocations.get(request.ownerInvocationId);
    let inputGraph=request.inputGraph??null,receiverValue=request.receiverValue??null;
    if(inputGraph?.objects.some(node=>realm.heap.has(node.id))){
      // Preparation can precede another callback or guest allocation. Only
      // the new graph's local identities move; existing retained references
      // continue to designate the same owned objects.
      inputGraph=clone(inputGraph);inputGraph.roots.push(receiverValue??['undefined']);
      remapGraph(inputGraph,new Set(realm.heap.keys()));receiverValue=inputGraph.roots.pop();
    }
    const admitted=this.admitInvocation({programId:owner.programId,invocationId:request.invocationId,
      trackId:owner.trackId,realmId,triggerId:request.invocationId,
      args:request.args??[],receiver:request.receiver,inputGraph,
      receiverValue,closureId:request.closureId,
      realmPolicy:'retained',activation:'callback',parentInvocationId:request.ownerInvocationId,
      taskRevision:owner.taskRevision,deadline:owner.deadline,completionPolicy:'await-returned-promise'});
    this.closureQueue.splice(index,1);return admitted;
  }
  /**
   * Dispatch exactly one previously validated logical request. A retry gets
   * the same in-process promise; a restored uncertain dispatch never repeats
   * external writes without an explicit reconciliation receipt.
   */
  dispatch(invocationId,effectId,{beforeDispatch=null}={}){
    const key=invocationId+'/'+effectId, intent=this.intents.get(key);
    demand(intent,'No committed selected request for dispatch');
    if(this.inflight.has(key))return this.inflight.get(key);
    demand(intent.status==='committed',
      'Cannot redispatch settled or uncertain external intent');
    for(const [callbackKey,callback] of this.callbacks)if(callbackKey.startsWith(key+'/'))
      demand(callback.state==='pending'||['active','lost'].includes(callback.state)&&
        ['active','lost'].includes(this.handlers.get(callback.subscriptionId)?.state),
        'Cannot retry a retired callback registration');
    const adapter=this.services[intent.operation];
    demand(typeof adapter==='function','No granted native adapter for '+intent.operation);
    const activation=this.invocations.get(invocationId);
    demand(!['cancelled','failed','completed'].includes(activation.status),'Cannot dispatch closed invocation');
    demand(activation.deadline===null||activation.deadline>this.now(),'Invocation deadline expired');
    const attempt=intent.attempts+1;
    demand(Number.isSafeInteger(attempt)&&attempt>=1,'External dispatch attempt counter exhausted');
    intent.status='dispatching';
    const abort=new AbortController();this.abortControllers.set(key,abort);
    const callbackFor=slot=>{
      const registration=this.callbacks.get(key+'/'+slot);
      demand(registration,'Native adapter requested an undeclared callback slot');
      const fn=(...args)=>{
        if(registration.state==='revoked'||registration.state==='lost')
          throw new Error('Owned callback was revoked or lost');
        if(args.length>32)throw new TypeError('Native callback argument limit');
        graphOf(args);
        // Only a delivered event advances the durable counter. Buffered native
        // arrivals remain outside the model's causal prefix, while seen/queued
        // IDs still prevent two pending arrivals from receiving the same ID.
        const handler=this.handlers.get(registration.subscriptionId);
        let sequence=registration.sequence,eventId;
        do{
          sequence++;demand(Number.isSafeInteger(sequence),'Native callback event sequence exhausted');
          eventId='callbackevent'+sequence;
        }while(handler?.seen.has(eventId)||registration.queued.some(event=>event.eventId===eventId)||
          this.hostIngressBroker?.hasPending(registration.subscriptionId,eventId));
        if(registration.state==='pending'){
          if(registration.queued.length>=64)throw new Error('Callback event queue overflow');
          registration.queued.push({eventId,args});
        }else {
          // Notification callbacks retain their void host ABI. The broker
          // owns asynchronous failures and exposes acknowledgement via flush
          // and explicit postEvent/receive calls.
          this.postEvent({subscriptionId:registration.subscriptionId,eventId,args});
        }
        return undefined;
      };
      return Object.freeze(fn);
    };
    const run=Promise.resolve().then(async()=>{
      const durable={schema:'semantic-action-intent/4',session:this.sessionId,key,attempt,
        invocationId,effectId,operation:intent.operation,payload:intent.payload,
        payloadDigest:intent.payloadDigest,taskRevision:intent.taskRevision,witness:intent.witness};
      const recover=record=>{
        const {nativeAction,...identity}=record??{};
        demand(isDeepStrictEqual(identity,durable),
          'Durable intent contradicts the committed selected request');
        if(nativeAction!==undefined)validateNativeActionBinding(nativeAction,
          {...intent,ownerTrack:activation.trackId});
        if(abort.signal.aborted)throw abort.signal.reason;
        // The independently retained intent proves only that this attempt
        // may have crossed the external boundary. It does not prove a result,
        // a live subscription, or permission to repeat the adapter call.
        this.record('observed','dispatch',activation.trackId,{invocationId,effectId,key,attempt,
          ...(nativeAction?{nativeAction}:{})});
        intent.attempts=attempt;intent.status='uncertain';
        if(nativeAction)intent.nativeAction=clone(nativeAction);
        else delete intent.nativeAction;
        throw new Error('Durable intent already exists; reconcile before dispatch');
      };
      // Read first so a stale checkpoint cannot recommit model state before
      // learning that the same operation was already durably dispatched.
      if(this.journal){
        let existing;
        try{existing=await this.journal.readIntent(this.sessionId,key,attempt);}
        catch(error){if(error.code!=='ENOENT')throw error;}
        if(existing!==undefined)recover(existing);
      }
      let nativeAction=intent.nativeAction;
      if(beforeDispatch){
        nativeAction=await beforeDispatch();
        validateNativeActionBinding(nativeAction,{...intent,ownerTrack:activation.trackId});
        nativeAction=clone(nativeAction);
      }
      // The durable embedding acknowledges the intent before any adapter can
      // touch the environment. A crash after this point is uncertain, not an
      // automatic invitation to repeat a write.
      if(this.journal){
        const receipt=await this.journal.claim({...durable,...(nativeAction?{nativeAction}:{})});
        demand(typeof receipt?.claimed==='boolean','Durable dispatch claim was not acknowledged');
        if(!receipt.claimed)recover(await this.journal.readIntent(this.sessionId,key,attempt));
      }
      if(abort.signal.aborted){intent.status='cancelled';throw abort.signal.reason;}
      this.record('observed','dispatch',activation.trackId,
        {invocationId,effectId,key,attempt,...(nativeAction?{nativeAction}:{})});
      intent.attempts=attempt;intent.status='dispatched';
      if(nativeAction)intent.nativeAction=nativeAction;
      for(const registration of this.callbacks.values())if(registration.ownerInvocationId===invocationId&&
          this.callbacks.get(key+'/'+registration.slot)===registration){
        if(registration.state==='pending')this.registerEventHandler({subscriptionId:registration.subscriptionId,
            programId:registration.programId,realmId:registration.realmId,
            trackId:registration.trackId,entry:registration.entry,
            closureId:registration.closureId,lifetime:registration.lifetime,
            ownerInvocationId:invocationId,realmPolicy:'retained'});
        else{
          // Only a new authorized dispatch can create a fresh native handle
          // after a not-dispatched reconciliation. Its existing logical
          // registration is retained; neither a lost result nor JSON restore
          // alone reattaches the previous resource.
          registration.state='active';this.handlers.get(registration.subscriptionId).state='active';
        }
      }
      let returned;
      const descriptor=hostOperation(intent.operation);
      const nativeArgs=decodeHostPayload(intent.payload,descriptor.codec,
        {callbackIndices:descriptor.callbackIndices??[],callbackGraph:descriptor.callbackGraph??false});
      try{returned=adapter(nativeArgs,
      Object.freeze({sessionId:this.sessionId,invocationId,effectId,
        idempotencyKey:intent.nativeAction?.actionKey??this.sessionId+'/'+key,operation:intent.operation,
        realmId:activation.realmId,signal:abort.signal,
        callback:callbackFor,
        invokeClosure:(closureId,args,receiver)=>{
          demand(hostOperation(intent.operation).callbackGraph===true,
            'Operation has no declared callback-return contract');
          demand(descriptor.kind!=='synchronous'||intent.status==='settled',
            'Synchronous native calls cannot await immediate selected callback reentry');
          const found=new Set(),seen=new Set();
          const visit=value=>{
            if(!value||typeof value!=='object'||seen.has(value))return;
            seen.add(value);
            const callbackId=ownedCallbackId(value);if(callbackId)found.add(callbackId);
            for(const child of Object.values(value))visit(child);
          };
          visit(nativeArgs);demand(found.has(closureId),'Callback was not supplied to this committed request');
          return this.enqueueClosure({ownerInvocationId:invocationId,parentEffectId:effectId,closureId,args,receiver});
        },
        subscriptionId:slot=>this.callbacks.get(key+'/'+slot)?.subscriptionId,
        closeSubscription:id=>{
          const handler=this.handlers.get(id);
          demand(handler&&handler.realmId===this.invocations.get(invocationId).realmId,
            'Cannot revoke a foreign or unknown listener');
          return this.closeEventHandler(id);
        }}));}catch(error){
        return this.deliverResult(invocationId,effectId,{status:'rejected',
          value:error instanceof GuestCallbackFailure?error.guestValue:
            error instanceof Error?error.message:error,
          errorOrigin:error instanceof GuestCallbackFailure?'guest-callback-throw':'adapter-throw'});
      }
      let value;
      try{value=await returned;}catch(error){
        return this.deliverResult(invocationId,effectId,{status:'rejected',
          value:error instanceof GuestCallbackFailure?error.guestValue:
            error instanceof Error?error.message:error,
          errorOrigin:error instanceof GuestCallbackFailure?'guest-callback-throw':'adapter-rejection'});
      }
      return this.deliverResult(invocationId,effectId,{status:'fulfilled',value});
    }).catch(error=>{
      if(intent.status==='dispatching')intent.status='committed';
      else if(intent.status==='dispatched')intent.status='uncertain';
      if(intent.status==='committed')this.inflight.delete(key);
      throw error;
    });
    this.inflight.set(key,run);
    return run;
  }
  /** Only host code supplies an observed result. There is no reference/teacher repair. */
  deliverResult(invocationId,effectId,options){
    return this.commitPreparedResult(this.prepareResult(invocationId,effectId,options));
  }
  prepareResult(invocationId,effectId,{status,value,result:explicitResult=null,
      graph:explicitGraph=null,errorOrigin=null}){
    const key=invocationId+'/'+effectId,intent=this.intents.get(key);
    demand(intent&&['dispatched','uncertain','settled'].includes(intent.status),
      'Unknown, duplicate or uncommitted result');
    demand(status==='fulfilled'||status==='rejected','Invalid result status');
    registeredResultCallbacks(this,key);
    const activation=this.invocations.get(invocationId);
    const captured=explicitResult===null?canonicalResultGraph(graphOf([value])):null,
      declared=explicitGraph===null?null:canonicalResultGraph(explicitGraph);
    const resultDigest=observedResultDigest(status,
      explicitResult===null?captured.roots[0]:explicitResult,explicitResult===null?captured:declared);
    if(intent.status==='settled'){
      demand(intent.resultDigest===resultDigest,'Conflicting duplicate result');
      return {invocationId,effectId,intent,duplicate:true};
    }
    let graph=declared,result=explicitResult;
    if(result===null){
      if(value!==null&&typeof value==='object'){
        graph=remapGraph(captured,new Set(activation.controller.heap.keys()));
        result=graph.roots[0];
      }else result=tag(value);
    }
    const line=this.encodeRecord('observe',{effect:effectId,status,result,...(graph?{graph}:{})});
    // Validate the complete transition on an isolated controller before a
    // reconciliation receipt can acknowledge it. In particular, a well-typed
    // reference may still designate no owned object, or exceed a state bound.
    const staged=Object.assign(Object.create(Object.getPrototypeOf(activation.controller)),
      clone(activation.controller));
    staged.commitRecord(this.decodeRecord(line),{mode:'observed',track:activation.trackId});
    return {invocationId,effectId,key,intent,activation,status,result:clone(result),line,
      resultDigest,errorOrigin:clone(errorOrigin)};
  }
  commitPreparedResult({invocationId,effectId,key,intent,activation,status,result,line,
      resultDigest,errorOrigin,duplicate=false}){
    if(duplicate){
      this.deliveries.push({invocationId,effectId,status:'duplicate'});
      return clone(intent.result);
    }
    const readyCutoff=activation.controller.scheduler.ready;
    activation.controller.commitRecord(this.decodeRecord(line),{mode:'observed',track:activation.trackId});
    intent.status='settled';
    const receipt=this.record('observed','result',activation.trackId,
      {invocationId,effectId,status,result,line,errorOrigin});
    intent.result=clone(receipt);
    intent.resultDigest=resultDigest;
    // Keep abort ownership for retained listeners/resources after registration
    // returns. Cancellation and realm close can still close their native work.
    this.refreshRealmReady(activation.realmId,readyCutoff);
    if(!this.replaying){
      const ready=this.nextReadyInvocation(activation.realmId);
      if(ready)for(const listener of this.runnableListeners)listener(ready);
    }
    this.wake();
    for(const callback of this.settleCallbackCapabilities(key,status)){
      const handler=this.handlers.get(callback.subscriptionId);
      for(const event of callback.queued)this.postEvent({
        subscriptionId:callback.subscriptionId,eventId:event.eventId,args:event.args});
      callback.queued.length=0;
      if(handler?.state==='closing'&&!handler.queue.length&&
         !this.hostIngressBroker?.hasPendingSubscription(callback.subscriptionId)&&
         ![...this.invocations.values()].some(invocation=>
           invocation.triggerId.startsWith('event:'+callback.subscriptionId+':')&&
           !['completed','cancelled','failed'].includes(invocation.status)))
        this.closeEventHandler(callback.subscriptionId);
    }
    return receipt;
  }
  // Retirement is part of the result transition itself. Public replay applies
  // it too, but consumes queued arrivals and handler closure only as receipts.
  settleCallbackCapabilities(key,status){
    const callbacks=registeredResultCallbacks(this,key);
    for(const callback of callbacks){
      const handler=this.handlers.get(callback.subscriptionId);
      if(handler.state==='closed'||callback.state==='revoked'){
        callback.state='revoked';continue;
      }
      if(status!=='fulfilled'||callback.lifetime!=='subscription'){
        callback.state='revoked';
        if(handler)handler.state='closing';
      }
      // A successful subscription result preserves any lost process-local
      // handle. Reconciliation alone cannot perform resource reattachment.
    }
    return callbacks;
  }
  evictSource(trackId,programId){
    const program=this.programs.get(programId);demand(program,'Unknown source');
    this.sourceAvailability.get(trackId)?.delete(programId);
    return this.record('observed','source-evict',trackId,{programId,digest:program.digest});
  }
  restoreSource(trackId,programId,{digest=null}={}){
    const program=this.programs.get(programId);demand(program,'Unknown source');
    demand(digest===null||digest===program.digest,'Source reread digest mismatch');
    demand(createHash('sha256').update(program.source).digest('hex')===program.digest,
      'Immutable source bytes no longer match their digest');
    if(!this.sourceAvailability.has(trackId))this.sourceAvailability.set(trackId,new Set());
    this.sourceAvailability.get(trackId).add(programId);
    return this.record('observed','source-read',trackId,
      {programId,digest:program.digest,source:program.source});
  }
  selectionContext(invocationId){
    const activation=this.invocations.get(invocationId);demand(activation,'Unknown invocation');
    const realmActivations=[...this.invocations].filter(([,item])=>item.realmId===activation.realmId);
    const realmInvocations=new Set(realmActivations.map(([identity])=>identity));
    const realmPrograms=new Set(realmActivations.map(([,item])=>item.programId));
    const realmTracks=new Set(realmActivations.map(([,item])=>item.trackId));
    const realmSubscriptions=new Set([...this.handlers].filter(([,handler])=>handler.realmId===activation.realmId)
      .map(([identity])=>identity));
    const realmCommitted=this.timeline.filter(event=>
      event.kind==='program'&&realmPrograms.has(event.programId)||realmInvocations.has(event.invocationId)||
      realmSubscriptions.has(event.subscriptionId)||
      ['source-read','source-evict'].includes(event.kind)&&realmTracks.has(event.track)&&realmPrograms.has(event.programId));
    const packet=activation.controller.segmentPacket();
    // A suspended parent can lag behind a child in the same realm. Publish the
    // current realm stream so bounded model history can determine the next draw.
    packet.randomState=this.realms.get(activation.realmId)?.randomState??null;
    return clone({realmCommitted,selectedState:Object.fromEntries(SELECTED_STATE_FIELDS.map(field=>[field,packet[field]]))});
  }
  prepareModelContext(invocationId){
    const activation=this.invocations.get(invocationId);demand(activation,'Unknown invocation');
    if(['completed','cancelled','failed'].includes(activation.status))return null;
    const invocation=this.timeline.find(item=>item.kind==='invocation'&&item.invocationId===invocationId);
    const previous=this.timeline.findLast(item=>item.kind==='model-context'&&item.invocationId===invocationId&&
      Object.hasOwn(item,'selectedState'));
    const selected=this.timeline.filter(item=>item.kind==='semantic'&&item.invocationId===invocationId);
    const boundary=Math.max(previous?.sequence??invocation.sequence,selected.at(-1)?.sequence??invocation.sequence);
    const others=new Set([...this.invocations].filter(([identity,item])=>identity!==invocationId&&
      item.realmId===activation.realmId).map(([identity])=>identity));
    const retainedEntry=!previous&&!selected.length&&others.size>0;
    const changedTurn=this.timeline.some(item=>item.sequence>boundary&&item.kind==='semantic'&&others.has(item.invocationId));
    const segment=selected.filter(item=>item.sequence>(previous?.sequence??invocation.sequence)).length>=MODEL_CONTEXT_INTERVAL;
    if(!retainedEntry&&!changedTurn&&!segment)return null;
    this.restoreSource(activation.trackId,activation.programId);
    return this.recordModelContext(invocationId,[],{includeState:true});
  }
  recordModelContext(invocationId,sourceReads,{includeState=false}={}){
    const activation=this.invocations.get(invocationId);demand(activation,'Unknown invocation');
    const program=this.programs.get(activation.programId);
    demand(Array.isArray(sourceReads)&&sourceReads.every(read=>
      read.sourceDigest===program.digest&&read.mode==='checked-reread'&&
      Array.isArray(read.originalEventIds)&&Array.isArray(read.observedEventIds)),
      'Model source receipt has invalid provenance');
    let context={};
    if(includeState){
      const reread=this.timeline.at(-1);
      demand(reread?.kind==='source-read'&&reread.track===activation.trackId&&
        reread.programId===activation.programId&&reread.digest===program.digest,
        'Selected state refresh requires its immediately preceding checked source reread');
      const {realmCommitted,selectedState}=this.selectionContext(invocationId);
      context={selectedState,realmPrefixDigest:createHash('sha256').update(JSON.stringify(realmCommitted),'utf8').digest('hex'),
        visibleThrough:this.globalSequence};
    }
    return this.record('observed','model-context',activation.trackId,{invocationId,sourceReads,...context});
  }
  cancelInvocation(invocationId,{reason='cancelled'}={}){
    this.hostIngressBroker?.assertCanRetire();
    const activation=this.invocations.get(invocationId);demand(activation,'Unknown invocation');
    if(activation.status==='cancelled')return this.timeline.find(item=>
      item.kind==='cancel'&&item.invocationId===invocationId);
    const uncertain=[];
    for(const [key,intent] of this.intents)if(intent.invocationId===invocationId){
      this.abortControllers.get(key)?.abort(new Error(reason));
      if(['dispatched','uncertain'].includes(intent.status)){
        intent.status='uncertain';uncertain.push(intent.effectId);
      }else if(['committed','dispatching'].includes(intent.status))intent.status='cancelled';
    }
    activation.status='cancelled';
    const realm=this.realms.get(activation.realmId);
    if(realm.running===invocationId)realm.running=null;
    const receipt=this.record('observed','cancel',activation.trackId,{invocationId,reason,uncertain});
    if(this.replaying)return receipt;
    for(const child of this.invocations.values())if(child.parentInvocationId===invocationId&&
        child.status!=='cancelled')this.cancelInvocation(child.controller.rootInvocation,{reason});
    for(const [subscriptionId,handler] of this.handlers)if(handler.ownerInvocationId===invocationId&&
      ['active','closing','lost'].includes(handler.state))this.closeEventHandler(subscriptionId);
    this.closureQueue=this.closureQueue.filter(request=>{
      if(request.ownerInvocationId!==invocationId)return true;
      this.completionWaiters.get(request.invocationId)?.reject(new Error(reason));
      this.completionWaiters.delete(request.invocationId);return false;
    });
    this.completionWaiters.get(invocationId)?.reject(new Error(reason));
    this.completionWaiters.delete(invocationId);this.wake();return receipt;
  }
  closeRealm(realmId,{reason='realm closed'}={}){
    this.hostIngressBroker?.assertCanRetire();
    demand(this.realms.has(realmId),'Unknown realm');
    demand(typeof reason==='string'&&reason.length>0,'Realm closure requires a reason');
    const realm=this.realms.get(realmId);
    if(realm.closed){
      const receipt=this.timeline.findLast(item=>item.kind==='realm-close'&&item.realmId===realmId);
      demand(receipt,'Closed realm lacks its committed closure receipt');return receipt;
    }
    for(const [invocationId,activation] of this.invocations)if(activation.realmId===realmId&&
      activation.status!=='cancelled')this.cancelInvocation(invocationId,{reason});
    for(const [subscriptionId,handler] of this.handlers)if(handler.realmId===realmId&&
      ['active','closing','lost'].includes(handler.state))this.closeEventHandler(subscriptionId);
    for(const callback of this.callbacks.values())if(callback.realmId===realmId){
      callback.state='revoked';callback.queued.length=0;
    }
    realm.closed=true;
    return this.record('observed','realm-close','host',{realmId,reason});
  }
  reconcile(invocationId,effectId,{disposition,evidenceId,value,result=null,graph=null,errorOrigin=null}={}){
    const intent=this.intents.get(invocationId+'/'+effectId);
    demand(intent?.status==='uncertain','Only uncertain actions require reconciliation');
    demand(['not-dispatched','lost','fulfilled','rejected'].includes(disposition)&&
      typeof evidenceId==='string'&&evidenceId.length>0,'Reconciliation requires explicit external evidence');
    const prepared=['fulfilled','rejected'].includes(disposition)?this.prepareResult(invocationId,effectId,
      {status:disposition,value,result,graph,errorOrigin}):null;
    const receipt=this.record('observed','reconcile',this.invocations.get(invocationId).trackId,
      {invocationId,effectId,disposition,evidenceId});
    if(disposition==='not-dispatched'){
      intent.status='committed';this.inflight.delete(invocationId+'/'+effectId);
    }else if(disposition==='lost')intent.status='lost';
    else this.commitPreparedResult(prepared);
    return receipt;
  }
  reattachSubscription(subscriptionId,{evidenceId,attach}={}){
    const handler=this.handlers.get(subscriptionId);
    demand(handler?.state==='lost','Subscription does not require reattachment');
    demand(!this.realms.get(handler.realmId)?.closed,'Cannot reattach a callback in a closed realm');
    demand(![...this.callbacks.values()].some(callback=>
      callback.subscriptionId===subscriptionId&&callback.state==='revoked'),
      'Cannot reattach a revoked callback capability');
    demand(typeof evidenceId==='string'&&evidenceId&&typeof attach==='function',
      'Reattachment requires a host-authorized resource adapter and evidence');
    // The adapter reattaches the existing native registration, never reruns
    // guest initialization or its original effectful registration request.
    const buffered=[];let attached=false;
    const receive=(eventId,args)=>attached?this.postEvent({subscriptionId,eventId,args}):
      buffered.push({eventId,args});
    attach(receive);
    handler.state='active';
    for(const callback of this.callbacks.values())if(callback.subscriptionId===subscriptionId)
      callback.state='active';
    const receipt=this.record('observed','callback-reattach',handler.trackId,
      {subscriptionId,realmId:handler.realmId,evidenceId});
    attached=true;for(const event of buffered)this.postEvent({subscriptionId,...event});
    return receipt;
  }
  inspect(invocationId=null,{trackId=null,includeTransport=false}={}){
    const activation=invocationId===null?null:this.invocations.get(invocationId);
    demand(invocationId===null||activation,'Unknown invocation');
    const visible=[],depths=new Map();
    for(const item of this.timeline){
      if(trackId!==null&&item.track!==trackId&&item.kind!=='program')continue;
      if(activation&&!(item.invocationId===invocationId||
        item.kind==='program'&&item.programId===activation.programId))continue;
      const owner=item.invocationId?' ['+item.track+' / '+item.invocationId+']':' ['+item.track+']';
      let rendered;
      if(item.kind==='program')rendered='code '+item.entry+' @'+item.digest.slice(0,12)+'\n'+item.source;
      else if(item.kind==='invocation')rendered='invoke '+item.entry+' caused by '+item.triggerId+
        (item.parentInvocationId?' from '+item.parentInvocationId:'')+' in realm '+item.realmId+
        ' ('+item.completionPolicy+')';
      else if(item.line){
        const decoded=this.decodeRecord(item.line),depth=depths.get(item.invocationId)??0;
        if(['return','throw'].includes(decoded.kind))depths.set(item.invocationId,Math.max(0,depth-1));
        rendered='  '.repeat(depths.get(item.invocationId)??0)+this.renderRecord(item.line);
        if(decoded.kind==='call')depths.set(item.invocationId,depth+1);
        if(decoded.fields.site){
          const program=this.programs.get(this.invocations.get(item.invocationId).programId);
          rendered+=' — '+program.source.slice(decoded.fields.site.start,decoded.fields.site.end);
        }
      }else if(item.kind==='event')rendered='event '+item.eventId+' from '+item.subscriptionId+' activates '+item.invocationId;
      else if(item.kind==='handler')rendered='register '+item.subscriptionId+' for '+item.entry;
      else if(item.kind==='handler-close')rendered='close '+item.subscriptionId+
        (item.discarded.length?'; discard queued '+item.discarded.join(', '):'');
      else if(item.kind==='cancel')rendered='cancel '+item.invocationId+': '+item.reason+
        (item.uncertain.length?'; uncertain effects '+item.uncertain.join(', '):'');
      else if(item.kind==='source-read')rendered='restore checked source '+item.programId+' @'+item.digest.slice(0,12);
      else if(item.kind==='source-evict')rendered='source unavailable '+item.programId+'; checked reread required';
      else if(item.kind==='model-context'&&item.selectedState)rendered='refresh committed selected state through '+
        item.visibleThrough+' @'+item.realmPrefixDigest.slice(0,12)+(includeTransport?' '+JSON.stringify(item.selectedState):'');
      else if(item.kind==='model-context')rendered='restore checked model source context';
      else if(item.kind==='reconcile')rendered='reconcile '+item.effectId+': '+item.disposition;
      else if(includeTransport)rendered=item.kind+' '+JSON.stringify(item);
      else continue;
      visible.push(String(item.sequence).padStart(4,'0')+owner+' '+item.mode+': '+rendered);
    }
    return visible;
  }
  /**
   * The public transcript is intentionally not marked admitted. Independent
   * Node/browser reference evidence and source certificates are separate
   * authorities; a controlled selection is not teacher or learned success.
   */
  exportEpisode({sourceLineage=null,split=null}={}){
    if(split!==null&&!['train','validation','test','quarantine'].includes(split))
      throw new TypeError('Unknown frozen source-family split');
    return clone({public:{schema:this.contract.executionVersion,
        profile:this.contract.profile,traceFormat:this.contract.traceVersion,contextFormat:this.contract.contextVersion,
        timeline:this.timeline},
      sidecar:{schema:this.contract.supervisionVersion,admission:'locally_verified',
        representation:'compact',referenceStatus:'unverified',sourceLineage,split,
        selectionOrigin:'controlled-or-model-output-unverified'}});
  }
  /**
   * Independently apply only *previously committed* semantic and observed
   * witness records. Never call native adapters, infer missing observations,
   * or consult a private teacher journal. A replayed receipt is not evidence
   * that the original external operation really happened: that needs broker
   * receipts and an independent reference oracle.
   */
  /** Replay one receipt against the existing machine without executing adapters.
   * Mixed representations stage this operation against their complete history
   * before applying it to the live lifecycle, preserving native service handles. */
  replayRecord(item){
    const h=this,previous=this.replaying,index=this.timeline.length;
    this.validateRecord(item);
    demand(this.timeline.at(-1)?.kind!=='event'||item.kind==='invocation',
      'Registered event must be followed immediately by its callback invocation');
    const preceding=this.timeline.at(-1);
    if(preceding?.kind==='reconcile'&&['fulfilled','rejected'].includes(preceding.disposition))
      demand(item.kind==='result'&&item.invocationId===preceding.invocationId&&
        item.effectId===preceding.effectId&&item.status===preceding.disposition,
        'Reconciliation must be followed immediately by its matching observed result');
    this.replaying=true;
    try{
      if(item.kind==='program'){
        h.publishProgram({programId:item.programId,source:item.source,
          entry:item.entry,capabilities:item.capabilities,dependencies:item.dependencies,
          sourceMap:item.sourceMap,languageProfile:item.languageProfile,module:item.module,
          sourceMetadata:item.sourceMetadata,randomSeed:item.randomSeed??null});
      }else if(item.kind==='invocation'){
        h.admitInvocation({programId:item.programId,invocationId:item.invocationId,
          trackId:item.track,realmId:item.realmId,triggerId:item.triggerId,
          inputGraph:item.inputGraph,completionPolicy:item.completionPolicy,
          realmPolicy:item.realmPolicy,entry:item.entry,receiverValue:item.receiver,
          closureId:item.closureId,activation:item.activation,parentInvocationId:item.parentInvocationId,
          taskRevision:item.taskRevision,deadline:item.deadline,bindings:item.bindings,ingressKey:item.ingressKey});
      }else if(item.kind==='semantic'){
        h.selected(item.invocationId,item.line);
      }else if(item.kind==='handler'){
        h.registerEventHandler({subscriptionId:item.subscriptionId,
          programId:item.programId,realmId:item.realmId,trackId:item.trackId,
          entry:item.entry,realmPolicy:item.realmPolicy,queueLimit:item.queueLimit,
          closureId:item.closureId,lifetime:item.lifetime,ownerInvocationId:item.ownerInvocationId});
      }else if(item.kind==='event'){
        const handler=h.handlers.get(item.subscriptionId);
        demand(['active','closing'].includes(handler?.state)&&!handler.seen.has(item.eventId),
          'Replay event has no live unique subscription');
        const n=nextEventOrdinal(h);
        const expectedRealm=handler.realmPolicy==='retained'?handler.realmId:handler.realmId+'event'+n;
        demand(Number.isSafeInteger(n)&&item.invocationId==='event'+n&&
          item.track===handler.trackId&&item.programId===handler.programId&&item.realmId===expectedRealm&&
          item.triggerId==='event:'+item.subscriptionId+':'+item.eventId,
          'Replay event routing differs from its registered handler delivery');
        const realm=h.realms.get(item.realmId);
        demand(!h.realms.get(handler.realmId)?.closed&&!realm?.closed&&!realm?.running,
          'Replay event delivered during active or closed guest turn');
        const suffix=/^callbackevent([1-9][0-9]*)$/.exec(item.eventId);
        demand(!suffix||Number.isSafeInteger(Number(suffix[1])),'Invalid native callback event sequence');
        handler.seen.add(item.eventId);
        h.nextEventDelivery=n;
        h.record('observed','event',item.track,{
          subscriptionId:item.subscriptionId,eventId:item.eventId,
          invocationId:item.invocationId,triggerId:item.triggerId,
          programId:item.programId,realmId:item.realmId});
        h.commitCallbackEvent(item.subscriptionId,item.eventId);
      }else if(item.kind==='handler-close'){
        const handler=h.handlers.get(item.subscriptionId);
        demand(['active','closing','lost'].includes(handler?.state),'Replay closes nonexistent subscription');
        demand(Array.isArray(item.discarded)&&new Set(item.discarded).size===item.discarded.length&&
          item.discarded.every(identity=>typeof identity==='string'&&ID.test(identity)&&
            !h.timeline.some(row=>row.kind==='event'&&row.subscriptionId===item.subscriptionId&&row.eventId===identity)),
          'Handler close discards duplicate, invalid or already delivered events');
        demand(!handler.queue.length||isDeepStrictEqual(item.discarded,handler.queue.map(event=>event.eventId)),
          'Handler close differs from its retained pending inputs');
        for(const identity of item.discarded)handler.seen.add(identity);
        handler.queue.length=0;
        handler.state='closed';
        for(const callback of h.callbacks.values())
          if(callback.subscriptionId===item.subscriptionId)callback.state='revoked';
        h.record('observed','handler-close','host',{
          subscriptionId:item.subscriptionId,discarded:item.discarded});
      }else if(item.kind==='dispatch'){
        const key=item.invocationId+'/'+item.effectId;
        const intent=h.intents.get(key);
        demand(intent?.status==='committed'&&item.attempt===intent.attempts+1&&
          item.key===key,'Replay dispatch has no valid committed action');
        const activation=h.invocations.get(item.invocationId);
        demand(activation?.trackId===item.track,'Replay dispatch ownership mismatch');
        if(Object.hasOwn(item,'nativeAction'))validateNativeActionBinding(item.nativeAction,
          {...intent,ownerTrack:activation.trackId});
        intent.status='dispatched';intent.attempts=item.attempt;
        if(Object.hasOwn(item,'nativeAction'))intent.nativeAction=clone(item.nativeAction);
        h.record('observed','dispatch',activation.trackId,
          {invocationId:item.invocationId,effectId:item.effectId,key,attempt:item.attempt,
            ...(item.nativeAction?{nativeAction:item.nativeAction}:{})});
      }else if(item.kind==='result'){
        const key=item.invocationId+'/'+item.effectId;
        const intent=h.intents.get(key);
        demand(['dispatched','uncertain'].includes(intent?.status),'Replay result lacks dispatched cause');
        registeredResultCallbacks(h,key);
        const activation=h.invocations.get(item.invocationId);
        demand(activation?.trackId===item.track,'Replay result owner mismatch');
        const decoded=this.decodeRecord(item.line);
        demand(decoded.kind==='observe'&&decoded.fields.effect===item.effectId&&
          decoded.fields.status===item.status&&
          isDeepStrictEqual(decoded.fields.result,item.result),
          'Recorded result and observed witness disagree');
        const readyCutoff=activation.controller.scheduler.ready;
        activation.controller.commitRecord(decoded,{mode:'observed',track:activation.trackId});
        intent.status='settled';
        intent.result=h.record('observed','result',activation.trackId,
          {invocationId:item.invocationId,effectId:item.effectId,
            status:item.status,result:item.result,line:item.line,errorOrigin:item.errorOrigin});
        intent.resultDigest=observedResultDigest(item.status,decoded.fields.result,decoded.fields.graph??null);
        h.settleCallbackCapabilities(key,item.status);
        h.refreshRealmReady(activation.realmId,readyCutoff);
      }else if(item.kind==='source-evict')h.evictSource(item.track,item.programId);
      else if(item.kind==='source-read')h.restoreSource(item.track,item.programId,{digest:item.digest});
      else if(item.kind==='model-context')h.recordModelContext(item.invocationId,item.sourceReads,
        {includeState:Object.hasOwn(item,'selectedState')});
      else if(item.kind==='cancel')h.cancelInvocation(item.invocationId,{reason:item.reason});
      else if(item.kind==='realm-close'){
        const realm=h.realms.get(item.realmId);
        demand(realm&&!realm.closed&&realm.running===null,'Replay closes unknown, closed or active realm');
        demand([...h.invocations.values()].filter(invocation=>invocation.realmId===item.realmId)
          .every(invocation=>invocation.status==='cancelled'),'Realm closure lacks invocation cancellation receipts');
        demand([...h.handlers.values()].filter(handler=>handler.realmId===item.realmId)
          .every(handler=>handler.state==='closed'),'Realm closure lacks handler retirement receipts');
        for(const callback of h.callbacks.values())if(callback.realmId===item.realmId){
          callback.state='revoked';callback.queued.length=0;
        }
        realm.closed=true;h.record('observed','realm-close','host',{realmId:item.realmId,reason:item.reason});
      }
      else if(item.kind==='reconcile'){
        const intent=h.intents.get(item.invocationId+'/'+item.effectId);
        demand(intent&&['dispatched','uncertain'].includes(intent.status),'Reconciliation lacks an uncertain intent');
        demand(h.invocations.get(item.invocationId)?.trackId===item.track,'Reconciliation owner mismatch');
        demand(typeof item.evidenceId==='string'&&item.evidenceId&&
          ['not-dispatched','lost','fulfilled','rejected'].includes(item.disposition),
          'Invalid reconciliation evidence');
        intent.status=item.disposition==='not-dispatched'?'committed':
          item.disposition==='lost'?'lost':'uncertain';
        h.record('observed','reconcile',item.track,{invocationId:item.invocationId,
          effectId:item.effectId,disposition:item.disposition,evidenceId:item.evidenceId});
      }else if(item.kind==='callback-reattach'){
        const handler=h.handlers.get(item.subscriptionId);
        demand(handler&&handler.realmId===item.realmId&&handler.trackId===item.track&&
          ['active','lost'].includes(handler.state)&&!h.realms.get(item.realmId)?.closed&&
          ![...h.callbacks.values()].some(callback=>callback.subscriptionId===item.subscriptionId&&
            callback.state==='revoked'),'Unknown, closed or revoked reattached callback');
        demand(typeof item.evidenceId==='string'&&item.evidenceId.length>0,
          'Callback reattachment requires explicit external evidence');
        handler.state='active';
        for(const callback of h.callbacks.values())if(callback.subscriptionId===item.subscriptionId)
          callback.state='active';
        h.record('observed','callback-reattach',item.track,{subscriptionId:item.subscriptionId,
          realmId:item.realmId,evidenceId:item.evidenceId});
      }else{
        fail('Unregistered public replay record family');
      }
      demand(isDeepStrictEqual(h.timeline[index],item),
        'Replay sequence, identity, authority or fields disagree at '+index);
      return h.timeline[index];
    }finally{this.replaying=previous;}
  }
  static replay(exported,{requireTerminal=true}={}){
    const publicData=exported?.public;
    demand(publicData?.schema===this.contract.executionVersion&&
      publicData.traceFormat===this.contract.traceVersion&&
      publicData.contextFormat===this.contract.contextVersion&&
      publicData.profile===this.contract.profile,'Unsupported public replay contract');
    const records=publicData.timeline;
    demand(Array.isArray(records)&&records.length>1&&records.length<=50000,
      'Replay requires a bounded public causal timeline');
    const h=new this({sessionId:records[0]?.session,now:()=>-Infinity});
    h.replaying=true;
    for(const [index,item] of records.entries()){
      demand(item&&typeof item==='object','Malformed replay record');
      h.replayRecord(item);
      demand(isDeepStrictEqual(h.timeline[index],item),
        'Replay sequence, identity, authority or fields disagree at '+index);
    }
    if(requireTerminal){
      demand([...h.invocations.values()].every(v=>['completed','cancelled','failed'].includes(v.status)),
        'Incomplete replayed invocation');
      demand([...h.intents.values()].every(v=>['settled','cancelled'].includes(v.status)||
        ['cancelled','failed'].includes(h.invocations.get(v.invocationId).status)),
        'Replay contains unsettled selected native actions');
    }
    h.replaying=false;
    return h;
  }
  /** No service code executes during state restoration or trace inspection. */
  checkpoint(){
    demand(![...this.intents.values()].some(intent=>intent.status==='dispatching'),
      'Await durable action acknowledgement before checkpointing');
    validateIngressQueueOrder([...this.handlers],this.nextIngressSequence);
    const packet={schema:this.contract.checkpointVersion,profile:this.contract.profile,sessionId:this.sessionId,
      callbacks:[...this.callbacks],nextCallback:this.nextCallback,
      programs:[...this.programs],realms:[...this.realms].map(([key,realm])=>[key,{
        ...realm,heap:[...realm.heap].map(([id,node])=>[id,{...node,properties:[...node.properties]}]),
        locals:[...realm.locals]}]),
      handlers:[...this.handlers].map(([key,v])=>[key,{...v,seen:[...v.seen],
        queue:v.queue.map(({args,...event})=>({...event,argsGraph:graphOf(args)}))}]),
      nextEventDelivery:this.nextEventDelivery,nextIngressSequence:this.nextIngressSequence,
      invocations:[...this.invocations].map(([key,v])=>[
        key,{...v,controller:v.controller.segmentPacket()}]),
      intents:[...this.intents].map(([key,{args,...intent}])=>[key,intent]),timeline:this.timeline,
      ownerSequences:[...this.ownerSequences],globalSequence:this.globalSequence,
      maxGenerated:this.maxGenerated,maxOutstanding:this.maxOutstanding,
      automaticDelivery:this.automaticDelivery,
      sourceAvailability:[...this.sourceAvailability].map(([key,value])=>[key,[...value]]),
      ingress:[...this.ingress],deliveries:this.deliveries,rejections:this.rejections,
      closureQueue:this.closureQueue.map(({args,receiver,...request})=>request.inputGraph?
        request:({...request,argsGraph:graphOf([receiver,...args])}))};
    return clone({...packet,integrity:hashAlgorithmData(packet)});
  }
  static restore(packet,{services={},journal=null,grants=null,now=Date.now,
      materializeCallbackResult=null,prepareCallbackInput=null}={}){
    demand(packet?.schema===this.contract.checkpointVersion&&packet.profile===this.contract.profile,'Wrong checkpoint version');
    const {integrity,...body}=packet;
    demand(integrity===hashAlgorithmData(body),
      'Checkpoint integrity mismatch');
    validateIngressQueueOrder(packet.handlers,packet.nextIngressSequence);
    const verified=this.replay({public:{schema:this.contract.executionVersion,
      traceFormat:this.contract.traceVersion,contextFormat:this.contract.contextVersion,
      profile:this.contract.profile,timeline:packet.timeline}},{requireTerminal:false});
    validateCheckpointAuthority(packet,verified);
    demand(packet.nextEventDelivery===verified.nextEventDelivery,
      'Checkpoint event delivery counter contradicts committed events');
    for(const [key,activation] of packet.invocations){
      const expected=verified.invocations.get(key)?.controller.segmentPacket();
      demand(expected,'Checkpoint invocation lacks public provenance');
      for(const field of ['heap','locals','stack','effects','jobs','ready','pending','completion','continuations',
        'frameFunctions','callReturn','captureAliases','activeJob','scheduler','receiver',
        'context','input','rootInvocation','trackId','capabilities','observationAuthority','strictRequests',
        'randomState'])
        demand(isDeepStrictEqual(expected[field],activation.controller[field]),
          'Checkpoint selected state contradicts committed public history: '+field);
    }
    demand(isDeepStrictEqual(packet.programs,[...verified.programs]),
      'Checkpoint program metadata contradicts committed source context');
    for(const [key,realm] of packet.realms){
      const expected=verified.realms.get(key);
      demand(expected,'Checkpoint contains an unobserved realm');
      const heap=[...expected.heap].map(([id,node])=>[id,{...node,properties:[...node.properties]}]);
      demand(isDeepStrictEqual(heap,realm.heap)&&isDeepStrictEqual([...expected.locals],realm.locals),
        'Checkpoint realm state contradicts committed public history');
      for(const field of ['digest','programId','policy','revision','taskRevision','initialized',
        'initializationStarted','running','scheduler','randomState','closed'])
        demand(isDeepStrictEqual(expected[field],realm[field]),'Checkpoint realm ownership mismatch: '+field);
    }
    for(const [key,callback]of packet.callbacks??[])
      demand(verified.callbacks.get(key)?.sequence===callback.sequence,
        'Checkpoint callback counter contradicts committed event receipts');
    for(const [key,intent]of packet.intents)if(intent.status==='settled')
      demand(verified.intents.get(key)?.resultDigest===intent.resultDigest,
        'Checkpoint result identity contradicts committed observation');
    const harness=new this({
      sessionId:packet.sessionId,services,maxGenerated:packet.maxGenerated,
      maxOutstanding:packet.maxOutstanding,journal,grants,now,automaticDelivery:packet.automaticDelivery,
      materializeCallbackResult,prepareCallbackInput});
    harness.programs=new Map(clone(packet.programs).map(([key,value])=>[key,freeze(value)]));
    harness.realms=new Map(clone(packet.realms).map(([key,realm])=>[key,{...realm,
      heap:new Map(realm.heap.map(([id,node])=>[id,{...node,properties:new Map(node.properties)}])),
      locals:new Map(realm.locals)}]));
    harness.callbacks=new Map(clone(packet.callbacks??[]).map(([key,value])=>[
      key,{...value,state:value.state==='active'?'lost':value.state}]));
    harness.nextCallback=packet.nextCallback??0;
    harness.handlers=new Map(clone(packet.handlers).map(([key,v])=>[key,
      {...v,state:v.state==='active'?'lost':v.state,seen:new Set(v.seen),
        queue:v.queue.map(({argsGraph,...event})=>({...event,
          args:decodeHostPayload(JSON.stringify({schema:'owned-graph/1',...argsGraph}),'owned-graph/1')}))}]));
    harness.nextEventDelivery=packet.nextEventDelivery??0;
    harness.nextIngressSequence=packet.nextIngressSequence;
    harness.invocations=new Map(clone(packet.invocations).map(([id,v])=>{
      const controller=this.Controller.fromPacket(v.controller);
      const realm=harness.realms.get(v.realmId);
      demand(realm&&realm.programId===v.programId,'Checkpoint realm ownership mismatch');
      controller.heap=realm.heap;controller.locals=realm.locals;
      controller.scheduler=realm.scheduler;
      return [id,{...v,controller}];
    }));
    harness.intents=new Map(clone(packet.intents).map(([id,intent])=>{
      const spec=hostOperation(intent.operation);
      return [id,{...intent,args:decodeHostPayload(intent.payload,spec.codec,
        {callbackIndices:spec.callbackIndices??[],callbackGraph:spec.callbackGraph??false}),
        status:['dispatching','dispatched'].includes(intent.status)?'uncertain':intent.status}];
    }));
    harness.timeline=clone(packet.timeline);
    harness.ownerSequences=new Map(packet.ownerSequences);
    harness.globalSequence=packet.globalSequence;
    harness.sourceAvailability=new Map(packet.sourceAvailability.map(([key,value])=>[key,new Set(value)]));
    harness.ingress=new Map(packet.ingress);harness.deliveries=clone(packet.deliveries);
    harness.rejections=clone(packet.rejections);
    harness.closureQueue=packet.closureQueue.map(({argsGraph,...request})=>{
      if(request.inputGraph)return clone(request);
      const [receiver,...args]=decodeHostPayload(JSON.stringify({schema:'owned-graph/1',...argsGraph}),'owned-graph/1');
      return {...clone(request),receiver,args};
    });
    return harness;
  }
}
