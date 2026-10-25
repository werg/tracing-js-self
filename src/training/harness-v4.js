// Transitional semantic-execution/4 harness ingress for controlled selected output.
// Semantic work is still validated by the v3 selected-state machine. The public
// envelope makes source, invocation, dispatch and external observation distinct;
// it does NOT assert that the complete semantic-trace/4 migration has happened.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {decodeWitness,encodeWitness} from './format.js';
import {SemanticController} from './controller.js';
import {analyzeSemanticProgram} from './semantic-program.js';
import {describeGraph} from './graph.js';
import {renderWitness} from './render.js';
import {hostOperation} from '../host/operations.js';

export const HARNESS_ENVELOPE_VERSION='semantic-execution/4';
export const HARNESS_SELECTED_TRACE_VERSION='semantic-trace/3';
const ID=/^[a-z][a-z0-9:_-]*$/;
const clone=x=>structuredClone(x);
function demand(value,message){if(!value)throw new TypeError(message);}
function id(value,name){demand(typeof value==='string'&&ID.test(value), 'Invalid '+name);}
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

/**
 * The embedding owns adapters. The model can only commit semantic witness
 * records; it cannot publish observed results, bypass a source callsite or
 * run arbitrary generated JS in the host. Adapters receive evaluated values
 * from the selected controller, not new model-authored arguments.
 */
export class SelectedExecutionHarness {
  constructor({sessionId='session1',services={},maxGenerated=4096}={}){
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
    this.programs=new Map();this.invocations=new Map();
    this.intents=new Map();this.inflight=new Map();this.timeline=[];
    this.ownerSequences=new Map();this.globalSequence=0;
    this.realms=new Map();this.handlers=new Map();this.nextEventDelivery=0;
    this.callbacks=new Map();this.nextCallback=0;
  }
  record(mode,kind,track,details){
    const ownerSequence=(this.ownerSequences.get(track)??0)+1;
    this.ownerSequences.set(track,ownerSequence);
    const item=Object.freeze({schema:HARNESS_ENVELOPE_VERSION,session:this.sessionId,
      sequence:++this.globalSequence,ownerSequence,track,mode,kind,...clone(details)});
    this.timeline.push(item);return item;
  }
  publishProgram({programId,source,entry,capabilities=[]}){
    id(programId,'program ID');
    demand(!this.programs.has(programId),'Program IDs are immutable and cannot be republished');
    demand(typeof source==='string'&&source.length&&typeof entry==='string',
      'Exact JS source and entry are required');
    demand(Array.isArray(capabilities)&&capabilities.every(c=>typeof c==='string')&&
      new Set(capabilities).size===capabilities.length,'Invalid capability grant');
    const analyzed=analyzeSemanticProgram(source);
    const {sites,functions}=analyzed;
    const digest=createHash('sha256').update(source,'utf8').digest('hex');
    const code=encodeWitness('code',{entry,source,sites});
    this.programs.set(programId,{source,entry,code,digest,functions,
      capabilities:[...capabilities]});
    return this.record('observed','program','host',
      {programId,digest,entry,source,sites,functions,capabilities});
  }
  admitInvocation({programId,invocationId,trackId,realmId,triggerId,args=[],inputGraph=null,
      completionPolicy='immediate-root',realmPolicy='fresh',entry=null}){
    for(const [value,name] of [[programId,'program ID'],[invocationId,'invocation ID'],
      [trackId,'track ID'],[realmId,'realm ID'],[triggerId,'trigger ID']])id(value,name);
    demand(!this.invocations.has(invocationId),'Invocation already admitted');
    const program=this.programs.get(programId);
    demand(program,'Program must be observed before an invocation');
    const selectedEntry=entry??program.entry;
    demand(selectedEntry===program.entry||program.functions.some(f=>f.name===selectedEntry),
      'Invoked closure must have a declared static function site');
    demand(Array.isArray(args),'Invocation arguments must be a graph');
    demand(completionPolicy==='immediate-root'||completionPolicy==='owned-quiescence',
      'Invalid completion policy');
    demand(realmPolicy==='fresh'||realmPolicy==='retained','Invalid realm policy');
    const previous=this.realms.get(realmId);
    demand(!previous||!previous.running,'Shared realm already has an active guest turn');
    demand(!previous||realmPolicy==='retained','Fresh realm identity cannot be reused');
    demand(!previous||previous.digest===program.digest,'Retained realm source revision mismatch');
    // A fresh selected state domain is an explicit policy, not an implicit
    // mutation of a previous invocation or native module initialization.
    demand(inputGraph===null||args.length===0,
      'Cannot mix observed input graph with new JavaScript arguments');
    const comparison=inputGraph===null?describeGraph(args):null;
    const graph=inputGraph===null?{roots:comparison.roots,objects:comparison.objects.map(
      ({properties,...node})=>({...node,properties:properties.map(
        ([key,value])=>({key,value}))}))}:clone(inputGraph);
    // New argument objects must not reuse identities held by live captured
    // closures or old input graphs. Preserve aliases, sparse entries and cycles.
    if(previous){
      const reserved=new Set(previous.heap.keys());
      const aliases=new Map();
      let ordinal=0;
      for(const node of graph.objects){
        let candidate;
        do {candidate='o'+ordinal++;} while(reserved.has(candidate));
        aliases.set(node.id,candidate);reserved.add(candidate);
      }
      for(const node of graph.objects){
        node.id=aliases.get(node.id);
        for(const prop of node.properties)
          if(prop.value[0]==='ref'&&aliases.has(prop.value[1]))
            prop.value[1]=aliases.get(prop.value[1]);
      }
      for(const root of graph.roots)
        if(root[0]==='ref'&&aliases.has(root[1]))
          root[1]=aliases.get(root[1]);
    }
    const input=encodeWitness('input',{graph});
    const sourceCode=selectedEntry===program.entry?program.code:
      encodeWitness('code',{entry:selectedEntry,source:program.source,
        sites:analyzeSemanticProgram(program.source).sites});
    const controller=new SemanticController([sourceCode,input],{
      capabilities:program.capabilities,maxGenerated:this.maxGenerated,
      completionPolicy,observationAuthority:'broker'});
    if(previous){
      // A retained realm has one authoritative selected heap/cell set.
      // Copy-on-new-invocation is safe because another turn cannot be active;
      // the new controller becomes the realm's only mutable owner.
      for(const [name,value] of previous.heap)
        if(!controller.heap.has(name))controller.heap.set(name,clone(value));
      controller.locals=new Map(clone([...previous.locals]));
    }
    this.realms.set(realmId,{digest:program.digest,programId,policy:realmPolicy,
      running:invocationId,heap:controller.heap,locals:controller.locals,
      revision:(previous?.revision??0)+1});
    this.invocations.set(invocationId,{programId,trackId,realmId,triggerId,
      controller,input,status:'running',completionPolicy,realmPolicy,entry:selectedEntry});
    return this.record('observed','invocation',trackId,
      {programId,invocationId,realmId,triggerId,completionPolicy,realmPolicy,
        inputGraph:graph,entry:selectedEntry,sourceDigest:program.digest});
  }
  /** Outside handler ingress is host-authorized. It never invents a guest
   * subscription request; JS-selected listener registration has a separate
   * effect/callback ABI. One event activates a selected handler only after
   * a real host delivery has been admitted. */
  registerEventHandler({subscriptionId,programId,realmId,trackId,entry=null,
      realmPolicy='retained',queueLimit=64}){
    for(const [value,name] of [[subscriptionId,'subscription ID'],
      [programId,'program ID'],[realmId,'realm ID'],[trackId,'track ID']])
      id(value,name);
    demand(this.programs.has(programId),'Handler requires an observed program');
    demand(!this.handlers.has(subscriptionId),'Subscription identity already exists');
    demand(realmPolicy==='retained'||realmPolicy==='fresh','Invalid handler realm policy');
    demand(Number.isSafeInteger(queueLimit)&&queueLimit>=1&&queueLimit<=4096,
      'Invalid bounded event queue');
    const program=this.programs.get(programId);
    demand(entry===null||entry===program.entry||
      program.functions.some(f=>f.name===entry),
      'Event handler closure must have a static function source site');
    this.handlers.set(subscriptionId,{programId,realmId,trackId,realmPolicy,
      entry:entry??program.entry,queueLimit,seen:new Set(),queue:[],state:'active'});
    return this.record('observed','handler','host',
      {subscriptionId,programId,realmId,trackId,realmPolicy,
        entry:entry??program.entry,queueLimit});
  }
  /** Queue each accepted outside arrival once. Delivery is separate, and
   * model-visible only when its realm can legally accept another turn. */
  postEvent({subscriptionId,eventId,args=[],completionPolicy='immediate-root'}){
    id(subscriptionId,'subscription ID');id(eventId,'event ID');
    const handler=this.handlers.get(subscriptionId);
    demand(handler&&handler.state==='active','Subscription is closed or unregistered');
    demand(!handler.seen.has(eventId),'Duplicate event identity');
    demand(Array.isArray(args),'Event arguments require an explicit graph');
    demand(handler.queue.length<handler.queueLimit,'Event queue overflow');
    handler.seen.add(eventId);
    handler.queue.push({eventId,args:clone(args),completionPolicy});
    return this.deliverReadyEvents(subscriptionId);
  }
  deliverReadyEvents(subscriptionId){
    const handler=this.handlers.get(subscriptionId);
    demand(handler,'Unknown subscription');
    if(handler.state!=='active'||!handler.queue.length||
       (handler.realmPolicy==='retained'&&this.realms.get(handler.realmId)?.running))
      return null;
    const next=handler.queue.shift();
    const invocationId='event'+(++this.nextEventDelivery);
    const triggerId='event:'+subscriptionId+':'+next.eventId;
    const realmId=handler.realmPolicy==='retained'?
      handler.realmId:handler.realmId+invocationId;
    this.record('observed','event',handler.trackId,
      {subscriptionId,eventId:next.eventId,invocationId,triggerId,
        programId:handler.programId,realmId});
    return this.admitInvocation({programId:handler.programId,invocationId,
      realmId,trackId:handler.trackId,triggerId,
      realmPolicy:handler.realmPolicy,entry:handler.entry,args:next.args,
      completionPolicy:next.completionPolicy});
  }
  closeEventHandler(subscriptionId){
    id(subscriptionId,'subscription ID');
    const handler=this.handlers.get(subscriptionId);
    demand(handler&&handler.state==='active','No active subscription to close');
    handler.state='closed';
    for(const callback of this.callbacks.values())
      if(callback.subscriptionId===subscriptionId)callback.state='revoked';
    const discarded=handler.queue.map(event=>event.eventId);
    handler.queue.length=0;
    return this.record('observed','handler-close','host',
      {subscriptionId,discarded});
  }
  selected(invocationId,line){
    id(invocationId,'invocation ID');
    const activation=this.invocations.get(invocationId);
    demand(activation&&activation.status==='running','Invocation is not runnable');
    const {kind,fields}=decodeWitness(line);
    demand(kind!=='observe'&&kind!=='code'&&kind!=='input',
      'Host observations are not selected model actions');
    const answer=activation.controller.commit(line,{track:'t0',mode:'generated'});
    if(kind==='request'){
      const key=invocationId+'/'+fields.effect;
      // Controller validation happens BEFORE the dispatch intent becomes
      // committed; invalid or partial witness bytes have no external effects.
      demand(!this.intents.has(key),'Duplicate intent key');
      const effect=activation.controller.effects.get(fields.effect);
      this.intents.set(key,{status:'committed',operation:effect.operation,
        args:clone(effect.arguments),payload:effect.payload,invocationId,
        effectId:fields.effect,attempts:0});
      const spec=hostOperation(effect.operation);
      for(const slot of spec.callbackIndices??[]){
        const descriptor=effect.arguments[slot];
        const closureId=descriptor?.$ownedCallback;
        const selectedClosure=activation.controller.heap.get(closureId);
        if(typeof closureId!=='string'||selectedClosure?.kind!=='closure'||
           typeof selectedClosure.code!=='string')
          throw new TypeError('Selected callback must reference an owned closure');
        const program=this.programs.get(activation.programId);
        demand(program.functions.some(f=>f.name===selectedClosure.code),
          'Callback source closure is not declared in immutable program');
        const callbackKey=key+'/'+slot;
        this.callbacks.set(callbackKey,{state:'pending',slot,closureId,
          entry:selectedClosure.code,realmId:activation.realmId,
          programId:activation.programId,trackId:activation.trackId,
          subscriptionId:'callback'+(++this.nextCallback),
          lifetime:spec.callbackLifetime??'call',sequence:0,queued:[]});
      }
    }
    if(kind==='end'){
      activation.status='completed';
      const realm=this.realms.get(activation.realmId);
      realm.heap=activation.controller.heap;
      realm.locals=activation.controller.locals;
      realm.running=null;
    }
    this.record('generated','semantic',activation.trackId,
      {invocationId,traceFormat:HARNESS_SELECTED_TRACE_VERSION,line});
    return answer;
  }
  /**
   * Dispatch exactly one previously validated logical request. A retry gets
   * the same in-process promise; a restored uncertain dispatch never repeats
   * external writes without an explicit reconciliation receipt.
   */
  dispatch(invocationId,effectId){
    const key=invocationId+'/'+effectId, intent=this.intents.get(key);
    demand(intent,'No committed selected request for dispatch');
    if(this.inflight.has(key))return this.inflight.get(key);
    demand(intent.status==='committed',
      'Cannot redispatch settled or uncertain external intent');
    const adapter=this.services[intent.operation];
    demand(typeof adapter==='function','No granted native adapter for '+intent.operation);
    intent.status='dispatched';intent.attempts++;
    this.record('observed','dispatch',this.invocations.get(invocationId).trackId,
      {invocationId,effectId,key,attempt:intent.attempts});
    const callbackFor=slot=>{
      const registration=this.callbacks.get(key+'/'+slot);
      demand(registration,'Native adapter requested an undeclared callback slot');
      const fn=(...args)=>{
        if(registration.state==='revoked'||registration.state==='lost')
          throw new Error('Owned callback was revoked or lost');
        if(args.length>32||args.some(x=>x!==null&&!['undefined','boolean',
             'number','string','bigint'].includes(typeof x)))
          throw new TypeError('Native callback result needs primitive arguments');
        const eventId='callbackevent'+(++registration.sequence);
        if(registration.state==='pending'){
          if(registration.queued.length>=64)throw new Error('Callback event queue overflow');
          registration.queued.push({eventId,args});
        }else this.postEvent({subscriptionId:registration.subscriptionId,eventId,args});
        return undefined;
      };
      return Object.freeze(fn);
    };
    const run=Promise.resolve().then(()=>adapter(clone(intent.args),
      Object.freeze({sessionId:this.sessionId,invocationId,effectId,
        idempotencyKey:key,operation:intent.operation,
        realmId:this.invocations.get(invocationId).realmId,
        callback:callbackFor,
        subscriptionId:slot=>this.callbacks.get(key+'/'+slot)?.subscriptionId,
        closeSubscription:id=>{
          const handler=this.handlers.get(id);
          demand(handler&&handler.realmId===this.invocations.get(invocationId).realmId,
            'Cannot revoke a foreign or unknown listener');
          return this.closeEventHandler(id);
        }})))
      .then(value=>this.deliverResult(invocationId,effectId,
        {status:'fulfilled',value}))
      .catch(error=>this.deliverResult(invocationId,effectId,
        {status:'rejected',value:error instanceof Error?error.message:String(error)}));
    this.inflight.set(key,run);
    return run;
  }
  /** Only host code supplies an observed result. There is no reference/teacher repair. */
  deliverResult(invocationId,effectId,{status,value}){
    const key=invocationId+'/'+effectId,intent=this.intents.get(key);
    demand(intent&&['dispatched','uncertain'].includes(intent.status),
      'Unknown, duplicate or uncommitted result');
    demand(status==='fulfilled'||status==='rejected','Invalid result status');
    const activation=this.invocations.get(invocationId);
    const result=tag(value);
    const line=encodeWitness('observe',{effect:effectId,status,result});
    activation.controller.commit(line,{mode:'observed',track:'t0'});
    intent.status='settled';
    const receipt=this.record('observed','result',activation.trackId,
      {invocationId,effectId,status,result,line});
    const callbacks=[...this.callbacks].filter(([callbackKey])=>callbackKey.startsWith(key+'/'));
    for(const [callbackKey,callback] of callbacks){
      if(status!=='fulfilled'){
        callback.state='revoked';callback.queued.length=0;continue;
      }
      if(callback.lifetime!=='subscription'){
        callback.state='revoked';callback.queued.length=0;continue;
      }
      this.registerEventHandler({subscriptionId:callback.subscriptionId,
        programId:callback.programId,realmId:callback.realmId,
        trackId:callback.trackId,entry:callback.entry,realmPolicy:'retained'});
      callback.state='active';
      for(const event of callback.queued)this.postEvent({
        subscriptionId:callback.subscriptionId,eventId:event.eventId,args:event.args});
      callback.queued.length=0;
    }
    return receipt;
  }
  inspect(invocationId){
    const activation=this.invocations.get(invocationId);
    demand(activation,'Unknown invocation');
    const program=this.programs.get(activation.programId);
    const visible=['code '+program.entry+' @'+program.digest.slice(0,12),
      'invoke '+invocationId+' on '+activation.trackId+' caused by '+activation.triggerId];
    for(const item of this.timeline){
      if(item.invocationId===invocationId&&item.line)
        visible.push((item.mode==='observed'?'observed: ':'generated: ')+
          renderWitness(item.line));
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
    return clone({public:{schema:HARNESS_ENVELOPE_VERSION,
        profile:'selected-harness/1',traceFormat:HARNESS_SELECTED_TRACE_VERSION,
        timeline:this.timeline},
      sidecar:{schema:'semantic-supervision/2',admission:'locally_verified',
        referenceStatus:'unverified',sourceLineage,split,
        selectionOrigin:'controlled-or-model-output-unverified'}});
  }
  /**
   * Independently apply only *previously committed* semantic and observed
   * witness records. Never call native adapters, infer missing observations,
   * or consult a private teacher journal. A replayed receipt is not evidence
   * that the original external operation really happened: that needs broker
   * receipts and an independent reference oracle.
   */
  static replay(exported,{requireTerminal=true}={}){
    const publicData=exported?.public;
    demand(publicData?.schema===HARNESS_ENVELOPE_VERSION&&
      publicData.traceFormat===HARNESS_SELECTED_TRACE_VERSION&&
      publicData.profile==='selected-harness/1','Unsupported public replay contract');
    const records=publicData.timeline;
    demand(Array.isArray(records)&&records.length>1&&records.length<=50000,
      'Replay requires a bounded public causal timeline');
    const h=new SelectedExecutionHarness({sessionId:records[0]?.session});
    for(const [index,item] of records.entries()){
      demand(item&&typeof item==='object','Malformed replay record');
      if(item.kind==='program'){
        h.publishProgram({programId:item.programId,source:item.source,
          entry:item.entry,capabilities:item.capabilities});
      }else if(item.kind==='invocation'){
        h.admitInvocation({programId:item.programId,invocationId:item.invocationId,
          trackId:item.track,realmId:item.realmId,triggerId:item.triggerId,
          inputGraph:item.inputGraph,completionPolicy:item.completionPolicy,
          realmPolicy:item.realmPolicy??'fresh',entry:item.entry});
      }else if(item.kind==='semantic'){
        h.selected(item.invocationId,item.line);
      }else if(item.kind==='handler'){
        h.registerEventHandler({subscriptionId:item.subscriptionId,
          programId:item.programId,realmId:item.realmId,trackId:item.trackId,
          entry:item.entry,realmPolicy:item.realmPolicy,queueLimit:item.queueLimit});
      }else if(item.kind==='event'){
        const handler=h.handlers.get(item.subscriptionId);
        demand(handler?.state==='active'&&!handler.seen.has(item.eventId),
          'Replay event has no live unique subscription');
        const realm=h.realms.get(item.realmId);
        demand(!realm?.running,'Replay event delivered during active guest turn');
        handler.seen.add(item.eventId);
        const n=Number(String(item.invocationId).replace(/^event/,''));
        demand(Number.isSafeInteger(n)&&n>h.nextEventDelivery,
          'Invalid replay dynamic event invocation identity');
        h.nextEventDelivery=n;
        h.record('observed','event',item.track,{
          subscriptionId:item.subscriptionId,eventId:item.eventId,
          invocationId:item.invocationId,triggerId:item.triggerId,
          programId:item.programId,realmId:item.realmId});
      }else if(item.kind==='handler-close'){
        const handler=h.handlers.get(item.subscriptionId);
        demand(handler?.state==='active','Replay closes nonexistent subscription');
        handler.state='closed';
        for(const callback of h.callbacks.values())
          if(callback.subscriptionId===item.subscriptionId)callback.state='revoked';
        h.record('observed','handler-close','host',{
          subscriptionId:item.subscriptionId,discarded:item.discarded});
      }else if(item.kind==='dispatch'){
        const key=item.invocationId+'/'+item.effectId;
        const intent=h.intents.get(key);
        demand(intent?.status==='committed'&&item.attempt===1&&
          item.key===key,'Replay dispatch has no valid committed action');
        const activation=h.invocations.get(item.invocationId);
        demand(activation?.trackId===item.track,'Replay dispatch ownership mismatch');
        intent.status='dispatched';intent.attempts=1;
        h.record('observed','dispatch',activation.trackId,
          {invocationId:item.invocationId,effectId:item.effectId,key,attempt:1});
      }else if(item.kind==='result'){
        const key=item.invocationId+'/'+item.effectId;
        const intent=h.intents.get(key);
        demand(intent?.status==='dispatched','Replay result lacks dispatched cause');
        const activation=h.invocations.get(item.invocationId);
        demand(activation?.trackId===item.track,'Replay result owner mismatch');
        const decoded=decodeWitness(item.line);
        demand(decoded.kind==='observe'&&decoded.fields.effect===item.effectId&&
          decoded.fields.status===item.status&&
          isDeepStrictEqual(decoded.fields.result,item.result),
          'Recorded result and observed witness disagree');
        activation.controller.commit(item.line,{mode:'observed',track:'t0'});
        intent.status='settled';
        h.record('observed','result',activation.trackId,
          {invocationId:item.invocationId,effectId:item.effectId,
            status:item.status,result:item.result,line:item.line});
      }else{
        fail('Unregistered public replay record family');
      }
      demand(isDeepStrictEqual(h.timeline[index],item),
        'Replay sequence, identity, authority or fields disagree at '+index);
    }
    if(requireTerminal){
      demand([...h.invocations.values()].every(v=>v.status==='completed'),
        'Incomplete replayed invocation');
      demand([...h.intents.values()].every(v=>v.status==='settled'),
        'Replay contains unsettled selected native actions');
    }
    return h;
  }
  /** No service code executes during state restoration or trace inspection. */
  checkpoint(){
    return clone({schema:'semantic-checkpoint/4',sessionId:this.sessionId,
      callbacks:[...this.callbacks],nextCallback:this.nextCallback,
      programs:[...this.programs],realms:[...this.realms],
      handlers:[...this.handlers].map(([key,v])=>[key,{...v,seen:[...v.seen]}]),
      nextEventDelivery:this.nextEventDelivery,
      invocations:[...this.invocations].map(([key,v])=>[
        key,{...v,controller:v.controller.segmentPacket()}]),
      intents:[...this.intents],timeline:this.timeline,
      ownerSequences:[...this.ownerSequences],globalSequence:this.globalSequence,
      maxGenerated:this.maxGenerated});
  }
  static restore(packet,{services={}}={}){
    demand(packet?.schema==='semantic-checkpoint/4','Wrong checkpoint version');
    const harness=new SelectedExecutionHarness({
      sessionId:packet.sessionId,services,maxGenerated:packet.maxGenerated});
    harness.programs=new Map(clone(packet.programs));
    harness.realms=new Map(clone(packet.realms??[]));
    harness.callbacks=new Map(clone(packet.callbacks??[]).map(([key,value])=>[
      key,{...value,state:value.state==='active'?'lost':value.state}]));
    harness.nextCallback=packet.nextCallback??0;
    harness.handlers=new Map((packet.handlers??[]).map(([key,v])=>[key,
      {...v,seen:new Set(v.seen)}]));
    harness.nextEventDelivery=packet.nextEventDelivery??0;
    harness.invocations=new Map(packet.invocations.map(([id,v])=>[id,{
      ...v,controller:SemanticController.fromPacket(v.controller)}]));
    harness.intents=new Map(clone(packet.intents).map(([id,intent])=>[
      id,{...intent,status:intent.status==='dispatched'?'uncertain':intent.status}]));
    harness.timeline=clone(packet.timeline);
    harness.ownerSequences=new Map(packet.ownerSequences);
    harness.globalSequence=packet.globalSequence;
    return harness;
  }
}
