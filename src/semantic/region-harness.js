// V8 compact and detailed records commit into one existing selected machine.
// No guest interpreter, teacher archive, service replay, or parallel heap lives
// here. Compact blocks are staged before any shared mutation is committed.
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionLifecycleV8} from './lifecycle-v8.js';
import {encodeDetailedRecord,decodeDetailedRecord} from './detail-v8.js';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON,assertAlgorithmFields} from './ir.js';
import {defineRegionProgram,validateRegionProgram,sharedRegionState,cloneRegionController,regionEntry,evaluateLocalRegion,
  encodeRegionRecord,decodeRegionRecord,REGION_EXECUTION_VERSION,REGION_TRACE_VERSION,
  REGION_CONTEXT_VERSION,REGION_CONTINUATION_VERSION,REGION_PROFILE} from './regions.js';
import {pureRegionEntry,evaluatePureRegion,encodePureRegionRecord,decodePureRegionRecord} from './pure-region-v8.js';
import {encodeProtocolRecordV8,decodeProtocolRecordV8} from './protocol-codec-v8.js';
import {applyProtocolRecordV8,assertProtocolDetailCompatible,restoreProtocolStateV8,allowsProtocolInternalSchedulerV8,allowsProtocolCompletionDetailV8} from './protocol-state-v8.js';
import {assertPlainPromiseResolutionV8,assertObservedPromiseResolutionV8} from './scheduler-boundaries-v8.js';
import {capturePendingIngress,restorePendingIngress} from './pending-ingress-v8.js';
import {DurableHostIngressBroker,validateHostIngressLogChain,validateHostIngressLogReceipt} from './host-ingress-journal-v8.js';

const copy=structuredClone,eq=isDeepStrictEqual;
const clean=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{const error=new TypeError('Region execution: '+message);error.category='region-authority';throw error;};
const protocolCheckpointSchema='semantic-protocol-continuation/1';
const ingressTickets=new WeakSet();
const ingressLogTickets=new WeakSet();
const protocolDetailKinds=new Set(['allocate','bind','compute','choose','read','write','call','return','throw','end','request']);
const internalSchedulerDetailKinds=new Set(['promise','await','resume','job','transfer']);
function assertSchedulerDetail(controller,{kind,fields}){
  if(kind==='promise'){
    if(fields.action==='adopt'){
      controller.promise(fields.target);
      fail('Promise adoption requires explicit assimilation jobs');
    }
    if(fields.action==='resolve')assertPlainPromiseResolutionV8(controller,fields.value);
  }
  if(kind==='job'&&fields.action==='complete'){
    const job=controller.jobs.get(fields.job),returned=job?.returned;
    if(job?.target&&job.reaction==='finally'&&returned?.kind==='return')
      fail('Normal Promise finally completion requires explicit cleanup jobs');
    if(job?.target&&returned?.kind==='return')assertPlainPromiseResolutionV8(controller,returned.value);
    if(job?.target&&!returned&&job.originalStatus==='fulfilled')
      assertPlainPromiseResolutionV8(controller,job.originalResult);
  }
}
export class RegionExecutionHarness {
  constructor(options={}){
    this.inner=new SelectedExecutionLifecycleV8(options);
    this.bindRealmReadiness();
    this.programs=new Map();this.moduleNamespacePlans=new Map();this.timeline=[];this.innerCursor=0;this.consumed=[];this.active=null;
  }
  bindRealmReadiness(){this.inner.refreshRealmReady=(realmId,cutoff)=>this.refreshRealmReady(realmId,cutoff);}
  get invocations(){return this.inner.invocations;}
  get intents(){return this.inner.intents;}
  get handlers(){return this.inner.handlers;}
  get realms(){return this.inner.realms;}
  get controller(){return this.inner.invocations.values().next().value?.controller??null;}
  hasProtocol(){return [...this.invocations.values()].some(item=>item.controller.protocol!==undefined&&item.controller.protocol!==null);}
  refreshRealmReady(realmId,cutoff){
    const controllers=[...this.invocations.values()].filter(item=>item.realmId===realmId)
      .map(item=>item.controller),scheduler=this.realms.get(realmId).scheduler;
    // One settlement may wake waiters owned by several retained invocations.
    // Local refresh discovers eligibility; publish that single wave in global
    // registration order without changing any previously queued work.
    for(const controller of controllers)controller.refreshReady();
    const fresh=[];
    for(const controller of controllers)for(const identity of controller.ready){
      const item=controller.continuations.get(identity)??controller.jobs.get(identity);
      if(item.readySequence>cutoff)fresh.push({controller,identity,item});
    }
    const dependency=fresh.filter(row=>Number.isSafeInteger(row.item.sequence));
    // Explicit queueMicrotask jobs have no dependency registration. A record
    // enqueues one such job or settles a dependency; it cannot perform both.
    if(dependency.length&&dependency.length!==fresh.length)fail('mixed explicit and dependency readiness wave');
    if(!dependency.length)return;
    dependency.sort((a,b)=>a.item.sequence-b.item.sequence);
    for(const controller of controllers)controller.ready=controller.ready.filter(identity=>{
      const item=controller.continuations.get(identity)??controller.jobs.get(identity);
      return item.readySequence<=cutoff;
    });
    scheduler.ready=cutoff;
    for(const {controller,identity,item}of dependency){item.readySequence=++scheduler.ready;controller.ready.push(identity);}
  }
  publishProgram(options){
    const {moduleNamespacePlan,...ownedOptions}=options;
    if(moduleNamespacePlan!==undefined)this.moduleNamespacePlans.set(options.programId,copy(moduleNamespacePlan));
    this.inner.publishProgram(ownedOptions);this.sync();return this.timeline.at(-1);
  }
  admitInvocation(options){this.inner.admitInvocation(options);this.sync();return this.timeline.at(-1);}
  append(mode,kind,fields){
    const row=clean({sequence:this.timeline.length+1,mode,kind,fields});this.timeline.push(row);return copy(row);
  }
  sync(){
    for(const raw of this.inner.timeline.slice(this.innerCursor)){
      if(raw.kind==='model-context')continue; // V8 publishes its own checked context.
      const {schema,sequence,ownerSequence,mode,kind,traceFormat,...fields}=raw;
      if(kind==='program'){
        const program=defineRegionProgram({source:fields.source,entry:fields.entry,
          moduleNamespacePlan:this.moduleNamespacePlans.get(fields.programId)}).program;
        this.programs.set(fields.programId,program);fields.regionProgram=program;
      }
      if(kind==='semantic'||kind==='result'){
        decodeDetailedRecord(fields.line,{role:kind==='result'?'observed':'generated'});
      }
      this.append(mode,kind,fields);
    }
    this.innerCursor=this.inner.timeline.length;
  }
  activation(invocationId){const item=this.inner.invocations.get(invocationId);if(!item)fail('unknown invocation');return item;}
  program(invocationId){return this.programs.get(this.activation(invocationId).programId);}
  region(invocationId,id){const region=this.program(invocationId)?.regions.find(item=>item.id===id);
    if(!region)fail('unknown source-defined region');return region;}
  entry(invocationId,id){this.sync();const region=this.region(invocationId,id);
    return regionEntry(this.program(invocationId),region,this.activation(invocationId).controller,this.timeline.length);}
  preview(invocationId,id){
    const entry=this.entry(invocationId,id),controller=this.activation(invocationId).controller;
    const {records,...result}=evaluateLocalRegion(this.region(invocationId,id),controller);
    return {region:id,entry,...result};
  }
  previewAlgorithm(invocationId){
    this.sync();const controller=this.activation(invocationId).controller,program=this.program(invocationId);
    return {entry:pureRegionEntry(program,controller,this.timeline.length),...evaluatePureRegion(program,controller).record};
  }
  select(invocationId,selected,{entry:providedEntry=null}={}){
    this.sync();
    if(typeof selected!=='string'&&Object.hasOwn(selected,'entry')){
      const {entry,...record}=selected;providedEntry=entry;selected=record;
    }
    const line=typeof selected==='string'?selected:Object.hasOwn(selected,'claims')?encodePureRegionRecord(selected):
      Object.hasOwn(selected,'region')?encodeRegionRecord(selected):Object.hasOwn(selected,'kind')&&!Object.hasOwn(selected,'fields')?
        encodeProtocolRecordV8(selected):encodeDetailedRecord(selected,{role:'generated'});
    if(line.startsWith('detail ')){
      const record=decodeDetailedRecord(line,{role:'generated'});
      const controller=this.activation(invocationId).controller,completionDetail=allowsProtocolCompletionDetailV8(controller,record);
      if(controller.protocol){
        if(!protocolDetailKinds.has(record.kind)&&!completionDetail&&!(internalSchedulerDetailKinds.has(record.kind)&&
          allowsProtocolInternalSchedulerV8(controller,record)))fail('asynchronous or external work requires an extended protocol profile');
        assertProtocolDetailCompatible(controller,record);
      }
      assertSchedulerDetail(controller,record);
      const realmId=this.activation(invocationId).realmId,readyCutoff=controller.scheduler.ready;
      const result=this.inner.selected(invocationId,line);
      this.refreshRealmReady(realmId,readyCutoff);
      this.sync();return result;
    }
    if(line.startsWith('protocol '))return this.selectProtocol(invocationId,line);
    if(line.startsWith('algorithm '))return this.selectAlgorithm(invocationId,line,providedEntry);
    const record=decodeRegionRecord(line),activation=this.activation(invocationId),controller=activation.controller;
    const region=this.region(invocationId,record.region),entry=this.entry(invocationId,record.region);
    if(!eq(providedEntry,entry))fail('stale region entry, live state, identity, or causal cutoff');
    const cursor={invocationId,frame:controller.stack.at(-1),region:region.id};
    if(this.consumed.some(item=>eq(item,cursor)))fail('region already committed in this activation');
    const evaluated=evaluateLocalRegion(region,controller),{records,...expected}=evaluated;
    if(!eq({bindings:record.bindings,decisions:record.decisions,completion:record.completion},expected))
      fail('false compact state, branch, or completion claim');
    // This replay is bounded and effect-free. It detects every detailed-state
    // precondition before the first real binding is changed.
    const staged=cloneRegionController(controller);
    for(const witness of records){
      if(staged.protocol)assertProtocolDetailCompatible(staged,witness);
      staged.commitRecord(witness,{mode:'generated',track:activation.trackId});
    }
    if(staged.firstWitnessViolation)fail('compact transition conflicts with earlier selected claims');
    // Check post-region shared state size before mutating any live cell.
    sharedRegionState(staged);
    this.commitCompactRecords(invocationId,records,{...cursor,entry:copy(entry)});
    // Preserve any host lifecycle receipts emitted on the return boundary.
    const created=this.inner.timeline.slice(this.innerCursor);
    this.innerCursor=this.inner.timeline.length;
    this.append('generated','region',{session:this.inner.sessionId,track:activation.trackId,invocationId,entry:copy(entry),line});
    for(const raw of created)if(raw.mode==='observed'&&raw.kind!=='model-context'){
      const {schema,sequence,ownerSequence,mode,kind,...fields}=raw;this.append(mode,kind,fields);
    }
    this.consumed.push(cursor);this.active=null;
    return {status:'committed',region:region.id,completion:copy(controller.completion),
      state:sharedRegionState(controller)};
  }
  commitCompactRecords(invocationId,records,active=null){
    const inner=this.inner,activation=this.activation(invocationId),now=inner.now;
    // One bounded public selection has one deadline decision. Rechecking the
    // clock for its hidden witnesses can reject halfway through an otherwise
    // preflighted region, leaving unpublished bindings or allocations behind.
    const committedAt=activation.deadline===null?null:inner.now();
    if(activation.deadline!==null&&!(activation.deadline>committedAt))fail('invocation deadline expired');
    if(activation.deadline!==null)inner.now=()=>committedAt;
    this.active=active;
    try{for(const witness of records)inner.selected(invocationId,encodeDetailedRecord(witness,{role:'generated'}));}
    finally{inner.now=now;this.active=null;}
  }
  selectProtocol(invocationId,line){
    this.sync();const record=typeof line==='string'?decodeProtocolRecordV8(line):line;
    line=encodeProtocolRecordV8(record);
    const activation=this.activation(invocationId),controller=activation.controller,realm=this.realms.get(activation.realmId);
    if(!(['running','returned'].includes(activation.status)||activation.status==='suspended'&&
      allowsProtocolInternalSchedulerV8(controller,record))||controller.completion)fail('protocol invocation is not runnable');
    if(activation.deadline!==null&&activation.deadline<=this.inner.now())fail('protocol invocation deadline expired');
    if(realm.running!==null&&realm.running!==invocationId)
      fail('another invocation owns the active realm turn');
    if(record.kind==='promise.join.step'){
      this.inner.assertNoOtherActiveJob(invocationId);
      if(this.inner.nextReadyInvocation(activation.realmId)!==invocationId)
        fail('join step violates shared realm global ready order');
    }
    if((controller.jobs.size||controller.continuations.size||controller.activeJob)&&
      !allowsProtocolInternalSchedulerV8(controller,record))fail('protocol profile requires a declared internal scheduler');
    if(!this.inner.sourceAvailability.get(activation.trackId)?.has(activation.programId))fail('protocol source is unavailable');
    if(controller.generated>=controller.maxGenerated)fail('protocol generated record bound');
    const readyCutoff=controller.scheduler.ready;
    const staged=cloneRegionController(controller),result=applyProtocolRecordV8(staged,record);staged.generated++;
    const state=sharedRegionState(staged); // Full descriptor/Symbol size is checked before mutation.
    // Retained callbacks share these exact objects. Replacing one controller's
    // maps would silently split the realm when a callback creates a join.
    const {heap,locals,scheduler}=controller;
    heap.clear();for(const [key,value]of staged.heap)heap.set(key,value);
    locals.clear();for(const [key,value]of staged.locals)locals.set(key,value);
    Object.assign(scheduler,staged.scheduler);
    Object.assign(controller,staged,{heap,locals,scheduler});
    realm.heap=heap;realm.locals=locals;realm.scheduler=scheduler;
    this.refreshRealmReady(activation.realmId,readyCutoff);
    if(controller.completion){activation.status='completed';realm.running=null;}
    else if(!controller.stack.length){activation.status=controller.pending?'returned':'suspended';realm.running=null;}
    else {activation.status='running';realm.running=invocationId;}
    this.append('generated','protocol',{session:this.inner.sessionId,track:activation.trackId,invocationId,line});
    return {...result,state:sharedRegionState(controller)};
  }
  selectAlgorithm(invocationId,line,providedEntry){
    const record=decodePureRegionRecord(line),activation=this.activation(invocationId),controller=activation.controller;
    const program=this.program(invocationId),entry=pureRegionEntry(program,controller,this.timeline.length);
    if(!eq(entry,providedEntry))fail('stale pure region entry');
    const evaluated=evaluatePureRegion(program,controller);
    if(!eq(record,evaluated.record))fail('false algorithm value, allocation identity or completion');
    const staged=cloneRegionController(controller);
    for(const witness of evaluated.records)staged.commitRecord(witness,{mode:'generated',track:activation.trackId});
    if(staged.firstWitnessViolation)fail('pure region conflicts with earlier selected claims');
    // Check the complete post-region continuation size before committing any
    // allocations or completion. Oversized traces must fail atomically.
    sharedRegionState(staged);
    this.commitCompactRecords(invocationId,evaluated.records);
    const created=this.inner.timeline.slice(this.innerCursor);
    this.innerCursor=this.inner.timeline.length;
    this.consumed.push({invocationId,frame:controller.rootInvocation,region:'whole'});
    this.append('generated','algorithm',{session:this.inner.sessionId,track:activation.trackId,invocationId,entry:copy(entry),line});
    // Just as for local regions, preserve host lifecycle observations emitted
    // on the terminal boundary instead of dropping them with the inner cursor.
    for(const raw of created)if(raw.mode==='observed'&&raw.kind!=='model-context'){
      const {schema,sequence,ownerSequence,mode,kind,...fields}=raw;this.append(mode,kind,fields);
    }
    return {status:'committed',region:'whole',state:sharedRegionState(controller)};
  }
  modelContext(invocationId){
    this.sync();const activation=this.activation(invocationId),controller=activation.controller;
    const state=sharedRegionState(controller);
    // Lost process-local handles and uncertain transports do not change the
    // acknowledged model history. Recover their public obligations by checked
    // replay; live dispatch/reattachment still consults the stricter host state.
    let host=this.inner;
    if([...host.intents.values()].some(item=>['dispatching','uncertain'].includes(item.status))||
       [...host.handlers.values()].some(item=>item.state==='lost')||
       [...host.callbacks.values()].some(item=>item.state==='lost')){
      const digest=hashAlgorithmData(this.timeline);
      if(this.obligationReplay?.digest!==digest)this.obligationReplay={digest,
        host:RegionExecutionHarness.replay(this.exportEpisode(),{requireTerminal:false,
          maxGenerated:host.maxGenerated,maxOutstanding:host.maxOutstanding}).inner};
      host=this.obligationReplay.host;
    }
    const publicResult=intent=>{
      if(!intent.result)return intent;
      const row=this.timeline.findLast(row=>row.kind==='result'&&
        row.fields.invocationId===intent.invocationId&&row.fields.effectId===intent.effectId);
      if(!row)fail('intent result lacks a public observation');
      return {...intent,result:{...intent.result,sequence:row.sequence,
        ownerSequence:this.timeline.filter(item=>item.sequence<=row.sequence&&item.fields.track===row.fields.track).length}};
    };
    return clean({schema:REGION_CONTEXT_VERSION,representation:'mixed',profile:REGION_PROFILE,
      invocationId,programs:[...this.programs].map(([id,program])=>({id,program})),
      input:controller.input,state,regionCursor:{active:this.active,consumed:this.consumed},
      obligations:{intents:[...host.intents].map(([key,{args,resultDigest,...intent}])=>[key,publicResult(intent)]),
        handlers:[...host.handlers].map(([key,handler])=>[key,{...handler,
          seen:[...handler.seen].filter(id=>!handler.queue.some(event=>event.eventId===id)),queue:[]}]),
        callbacks:[...host.callbacks].map(([key,callback])=>[key,{...callback,queued:[]}]),
        closureQueue:[]},
      visibleThrough:this.timeline.length,prefixDigest:hashAlgorithmData(this.timeline)});
  }
  exportEpisode(){this.sync();return {schema:REGION_EXECUTION_VERSION,traceFormat:REGION_TRACE_VERSION,
    contextFormat:REGION_CONTEXT_VERSION,representation:'mixed',profile:REGION_PROFILE,timeline:copy(this.timeline)};}
  /** Import an observed receipt only. No model record can create observations. */
  importObserved(row){
    if(row?.mode!=='observed'||['semantic','region','algorithm','protocol'].includes(row.kind))fail('host receipt authority');
    this.sync();const fields=copy(row.fields),kind=row.kind;
    if(kind==='program'){
      validateRegionProgram(fields.regionProgram);
      const moduleNamespacePlan=fields.regionProgram.moduleNamespacePlan;
      const expected=defineRegionProgram({source:fields.source,entry:fields.entry,moduleNamespacePlan}).program;
      if(!eq(fields.regionProgram,expected))fail('program publication changed');delete fields.regionProgram;
      if(moduleNamespacePlan!==undefined)this.moduleNamespacePlans.set(fields.programId,copy(moduleNamespacePlan));
      this.inner.publishProgram(fields);this.sync();return;
    }
    if(kind==='result'){const record=decodeDetailedRecord(fields.line,{role:'observed'});
      assertObservedPromiseResolutionV8(this.activation(fields.invocationId).controller,record.fields);
}
    const raw={schema:this.inner.contract.executionVersion,session:this.inner.sessionId,
      sequence:this.inner.globalSequence+1,ownerSequence:(this.inner.ownerSequences.get(fields.track)??0)+1,
      mode:'observed',kind,...fields};
    // Validate against the entire mixed machine before changing the live host.
    // The replay flag prevents recursive staging while checking an exact prefix.
    if(!this.replayingPublic)RegionExecutionHarness.replay({...this.exportEpisode(),
      timeline:[...this.timeline,{sequence:this.timeline.length+1,...copy(row)}]},
      {requireTerminal:false});
    this.inner.replayRecord(raw);
    this.sync();
  }
  async dispatch(invocationId,effectId,options){
    const result=await this.inner.dispatch(invocationId,effectId,options);this.sync();return result;
  }
  deliverResult(invocationId,effectId,options){
    assertObservedPromiseResolutionV8(this.activation(invocationId).controller,{...options,effect:effectId});
    const result=this.inner.deliverResult(invocationId,effectId,options);
    this.sync();return result;
  }
  registerEventHandler(options){const result=this.inner.registerEventHandler(options);this.sync();return result;}
  postEvent(options){const result=this.inner.postEvent(options);this.sync();return result;}
  deliverReadyEvents(id){const result=this.inner.deliverReadyEvents(id);this.sync();return result;}
  closeEventHandler(id){const result=this.inner.closeEventHandler(id);this.sync();return result;}
  closeRealm(id,options){const result=this.inner.closeRealm(id,options);this.sync();return result;}
  reconcile(invocationId,effectId,options){
    assertObservedPromiseResolutionV8(this.activation(invocationId).controller,
      {...options,effect:effectId,status:options?.disposition});
    const result=this.inner.reconcile(invocationId,effectId,options);this.sync();return result;
  }
  checkpoint({ingress=null}={}){
    if([...this.intents.values()].some(intent=>intent.status==='dispatching'))
      fail('await durable action acknowledgement before checkpointing');
    this.inner.hostIngressBroker?.assertIdle();
    this.inner.hostIngressBroker?.assertCallbackQueue();
    this.sync();if(this.active)fail('cannot checkpoint an uncommitted local transition');
    if(ingress!==null){
      if(!ingressTickets.has(ingress)||!eq(ingress.snapshot,capturePendingIngress(this)))
        fail('durable ingress snapshot differs from the current callback boundary');
    }else if([...this.inner.handlers.values()].some(handler=>handler.queue.length)||
      [...this.inner.callbacks.values()].some(callback=>callback.queued.length)||
      this.inner.closureQueue.length&&!this.inner.hostIngressBroker)
      fail('unjournaled native arrivals require an explicit durable ingress receipt');
    const body={schema:REGION_CONTINUATION_VERSION,profile:REGION_PROFILE,public:this.exportEpisode(),
      regionCursor:{active:null,consumed:copy(this.consumed)},ingressCursor:this.inner.nextIngressSequence,
      selected:this.hasProtocol()||ingress||this.inner.closureQueue.length?
        this.protocolCheckpoint({ingress}):this.inner.checkpoint(),...(ingress?{ingress:copy(ingress.receipt)}:{}),
      ...(this.inner.hostIngressBroker?.receipt?{ingressLog:this.inner.hostIngressBroker.receipt}:{})};
    return {...body,integrity:hashAlgorithmData(clean(body))};
  }
  async checkpointDurable({ingressStore}={}){
    await this.inner.hostIngressBroker?.flush();
    if(!ingressStore||typeof ingressStore.put!=='function'||typeof ingressStore.get!=='function')
      fail('durable ingress storage is required');
    const snapshot=capturePendingIngress(this);
    if(!snapshot.queues.length)return this.checkpoint();
    const receipt=await ingressStore.put(snapshot),retained=await ingressStore.get(receipt);
    if(!eq(snapshot,retained)||receipt.id!==hashAlgorithmData(snapshot))
      fail('durable ingress storage did not acknowledge the exact snapshot');
    const ticket={snapshot,receipt};ingressTickets.add(ticket);
    try{return this.checkpoint({ingress:ticket});}finally{ingressTickets.delete(ticket);}
  }
  protocolCheckpoint({ingress=null}={}){
    this.inner.hostIngressBroker?.assertCallbackQueue();
    if(!ingress&&[...this.inner.handlers.values()].some(handler=>handler.queue.length)||
      [...this.inner.callbacks.values()].some(callback=>callback.queued.length)||
      this.inner.closureQueue.length&&!this.inner.hostIngressBroker)
      fail('unjournaled native arrivals require an explicit durable ingress receipt');
    return clean({schema:protocolCheckpointSchema,invocations:[...this.invocations].map(([id,activation])=>[
      id,{status:activation.status,state:sharedRegionState(activation.controller)}]),
      policy:{maxGenerated:this.inner.maxGenerated,maxOutstanding:this.inner.maxOutstanding,
        automaticDelivery:this.inner.automaticDelivery}});
  }
  static replay(exported,{requireTerminal=true,...options}={}){
    const publicData=exported?.public??exported;
    assertAlgorithmFields(publicData,['schema','traceFormat','contextFormat','representation','profile','timeline'],'region episode');
    if(publicData.schema!==REGION_EXECUTION_VERSION||publicData.traceFormat!==REGION_TRACE_VERSION||
      publicData.contextFormat!==REGION_CONTEXT_VERSION||publicData.representation!=='mixed'||publicData.profile!==REGION_PROFILE)
      fail('incompatible execution contract');
    if(!Array.isArray(publicData.timeline)||publicData.timeline.length>50000)fail('timeline bound');
    const harness=new RegionExecutionHarness({...options,sessionId:publicData.timeline[0]?.fields?.session??'regions',automaticDelivery:false,now:()=>-Infinity});
    harness.replayingPublic=true;harness.inner.replaying=true;
    for(const row of publicData.timeline){
      assertAlgorithmFields(row,['sequence','mode','kind','fields'],'region timeline row');
      if(row.sequence!==harness.timeline.length+1)fail('noncontiguous public cutoff');
      if(row.mode==='generated'&&['semantic','region','algorithm','protocol'].includes(row.kind))harness.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
      else if(row.mode==='observed')harness.importObserved(row);else fail('invalid public role or record');
      if(!eq(harness.timeline.at(-1),row))fail('public record differs from checked replay');
    }
    if(requireTerminal){
      if([...harness.inner.invocations.values()].some(item=>!['completed','cancelled','failed'].includes(item.status)))fail('unfinished invocation');
      if([...harness.inner.intents.values()].some(item=>!['settled','cancelled'].includes(item.status)))fail('pending request');
    }
    harness.replayingPublic=false;harness.inner.replaying=false;return harness;
  }
  static async restoreDurable(packet,{ingressStore,ingressReceipt=null,
      ingressJournal=null,ingressLogReceipt=null,...options}={}){
    stableAlgorithmJSON(packet);const saved=copy(packet);
    let logTicket=null;
    if(saved?.ingressLog||ingressJournal!==null||ingressLogReceipt!==null){
      if(!ingressJournal||typeof ingressJournal.readAll!=='function')fail('independently retained ingress journal is required');
      const entries=validateHostIngressLogChain(await ingressJournal.readAll(ingressLogReceipt),ingressLogReceipt);
      if(saved?.ingressLog){
        validateHostIngressLogReceipt(saved.ingressLog);
        const prior=entries[saved.ingressLog.position-1],wire=prior&&stableAlgorithmJSON(prior);
        if(!prior||saved.ingressLog.streamId!==ingressLogReceipt.streamId||saved.ingressLog.id!==hashAlgorithmData(prior)||
          saved.ingressLog.bytes!==Buffer.byteLength(wire))fail('external journal head predates or substitutes the saved acknowledgement');
      }
      logTicket={receipt:saved?.ingressLog??null};
    }
    const finish=async harness=>{
      if(ingressJournal!==null||ingressLogReceipt!==null)
        await DurableHostIngressBroker.recover({harness,journal:ingressJournal,receipt:ingressLogReceipt});
      return harness;
    };
    if(!eq(saved?.ingress??null,ingressReceipt))
      fail('restore requires the externally retained ingress receipt');
    const restore=restoreOptions=>{
      if(logTicket)ingressLogTickets.add(logTicket);
      try{return this.restore(saved,{...restoreOptions,ingressLog:logTicket});}
      finally{if(logTicket)ingressLogTickets.delete(logTicket);}
    };
    if(!saved?.ingress)return finish(restore(options));
    if(!ingressStore||typeof ingressStore.get!=='function')fail('durable ingress storage is required');
    const snapshot=await ingressStore.get(saved.ingress);
    if(hashAlgorithmData(snapshot)!==saved.ingress.id)fail('durable ingress receipt differs from stored snapshot');
    const ticket={snapshot,receipt:saved.ingress};ingressTickets.add(ticket);
    let restored;
    try{restored=restore({...options,ingress:ticket});}finally{ingressTickets.delete(ticket);}
    return finish(restored);
  }
  static restore(packet,options={}){
    assertAlgorithmFields(packet,['schema','profile','public','regionCursor','ingressCursor','selected','integrity',
      ...(Object.hasOwn(packet??{},'ingress')?['ingress']:[]),
      ...(Object.hasOwn(packet??{},'ingressLog')?['ingressLog']:[])],'region checkpoint');
    const {integrity,...body}=packet;
    if(body.schema!==REGION_CONTINUATION_VERSION||body.profile!==REGION_PROFILE||hashAlgorithmData(clean(body))!==integrity)
      fail('checkpoint version or integrity');
    if(!Number.isSafeInteger(body.ingressCursor)||body.ingressCursor<1)
      fail('invalid private ingress sequence cursor');
    if(body.ingressLog&&(!ingressLogTickets.has(options.ingressLog)||!eq(options.ingressLog.receipt,body.ingressLog)))
      fail('checkpoint requires the independently read durable ingress journal');
    const policy=body.selected?.schema===protocolCheckpointSchema?body.selected.policy:null;
    if(body.selected?.schema===protocolCheckpointSchema&&!policy)fail('missing protocol host policy');
    if(policy){
      assertAlgorithmFields(policy,['maxGenerated','maxOutstanding','automaticDelivery'],'protocol host policy');
      if(!Number.isSafeInteger(policy.maxGenerated)||policy.maxGenerated<1||
        !Number.isSafeInteger(policy.maxOutstanding)||policy.maxOutstanding<1||typeof policy.automaticDelivery!=='boolean')
        fail('invalid protocol host policy');
    }
    const replayed=RegionExecutionHarness.replay(body.public,{...policy,requireTerminal:false});
    if(!eq(body.regionCursor,{active:null,consumed:replayed.consumed}))fail('checkpoint region cursor differs from public history');
    if(body.selected?.schema===protocolCheckpointSchema){
      replayed.inner.automaticDelivery=policy.automaticDelivery;
      if(!eq(body.selected,replayed.protocolCheckpoint()))fail('protocol checkpoint differs from exact public shared state');
      if(body.ingress){
        const ticket=options.ingress;
        if(!ticket||!ingressTickets.has(ticket)||!eq(ticket.receipt,body.ingress))
          fail('pending callbacks require independently read durable ingress');
        if(ticket.snapshot.nextIngressSequence!==body.ingressCursor)
          fail('durable ingress sequence cursor differs from its checkpoint');
        restorePendingIngress(replayed,ticket.snapshot);
      }else replayed.inner.nextIngressSequence=body.ingressCursor;
      for(const {controller} of replayed.invocations.values())if(controller.protocol)
        restoreProtocolStateV8(controller,controller.protocol);
      // Reattach only the embedding's explicitly supplied live services. Never
      // dispatch acknowledged requests or recreate native subscriptions here.
      const bindings=new SelectedExecutionLifecycleV8({...policy,...options});
      for(const field of ['services','journal','grants','now','materializeCallbackResult','prepareCallbackInput'])
        replayed.inner[field]=bindings[field];
      for(const intent of replayed.inner.intents.values())
        if(['dispatching','dispatched'].includes(intent.status))intent.status='uncertain';
      for(const handler of replayed.inner.handlers.values())
        if(handler.state==='active')handler.state='lost';
      for(const callback of replayed.inner.callbacks.values())if(callback.state==='active')callback.state='lost';
      return replayed;
    }
    if(body.ingress)fail('durable ingress requires the checked shared-state checkpoint');
    if(
      !eq(body.selected.timeline,replayed.inner.timeline))fail('checkpoint differs from public region history');
    replayed.inner=SelectedExecutionLifecycleV8.restore(body.selected,options);
    if(replayed.inner.nextIngressSequence!==body.ingressCursor)
      fail('generic host ingress sequence cursor differs from the checkpoint');
    replayed.bindRealmReadiness();
    replayed.innerCursor=replayed.inner.timeline.length;return replayed;
  }
}
