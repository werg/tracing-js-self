// V8 compact and detailed records commit into one existing selected machine.
// No guest interpreter, teacher archive, service replay, or parallel heap lives
// here. Compact blocks are staged before any shared mutation is committed.
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionHarness,HARNESS_ENVELOPE_VERSION,HARNESS_SELECTED_TRACE_VERSION} from '../training/harness-v4.js';
import {encodeWitness,decodeWitness,CONTEXT_VERSION,HARNESS_PROFILE} from '../training/format.js';
import {encodeDetailedRecord,decodeDetailedRecord} from './detailed-v7.js';
import {hashAlgorithmData} from './program.js';
import {stableAlgorithmJSON,assertAlgorithmFields} from './ir.js';
import {defineRegionProgram,validateRegionProgram,sharedRegionState,cloneRegionController,regionEntry,evaluateLocalRegion,
  encodeRegionRecord,decodeRegionRecord,REGION_EXECUTION_VERSION,REGION_TRACE_VERSION,
  REGION_CONTEXT_VERSION,REGION_CONTINUATION_VERSION,REGION_PROFILE} from './regions.js';
import {pureRegionEntry,evaluatePureRegion,encodePureRegionRecord,decodePureRegionRecord} from './pure-region-v8.js';
import {encodeProtocolRecordV8,decodeProtocolRecordV8} from './protocol-codec-v8.js';
import {applyProtocolRecordV8,assertProtocolDetailCompatible,restoreProtocolStateV8} from './protocol-state-v8.js';

const copy=structuredClone,eq=isDeepStrictEqual;
const clean=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{const error=new TypeError('Region execution: '+message);error.category='region-authority';throw error;};
const protocolCheckpointSchema='semantic-protocol-continuation/1';
const protocolDetailKinds=new Set(['allocate','bind','compute','choose','read','write','call','return','throw','end']);
function oldEpisode(inner,timeline){return {public:{schema:HARNESS_ENVELOPE_VERSION,
  traceFormat:HARNESS_SELECTED_TRACE_VERSION,contextFormat:CONTEXT_VERSION,profile:HARNESS_PROFILE,timeline}};}

export class RegionExecutionHarness {
  constructor(options={}){
    this.inner=new SelectedExecutionHarness(options);
    this.programs=new Map();this.timeline=[];this.innerCursor=0;this.consumed=[];this.active=null;
  }
  get invocations(){return this.inner.invocations;}
  get intents(){return this.inner.intents;}
  get handlers(){return this.inner.handlers;}
  get realms(){return this.inner.realms;}
  get controller(){return this.inner.invocations.values().next().value?.controller??null;}
  hasProtocol(){return [...this.invocations.values()].some(item=>item.controller.protocol!==undefined&&item.controller.protocol!==null);}
  assertBaseLifecycle(){if(this.hasProtocol())fail('host lifecycle after protocol work requires an extended asynchronous profile');}
  publishProgram(options){this.assertBaseLifecycle();this.inner.publishProgram(options);this.sync();return this.timeline.at(-1);}
  admitInvocation(options){this.assertBaseLifecycle();this.inner.admitInvocation(options);this.sync();return this.timeline.at(-1);}
  append(mode,kind,fields){
    const row=clean({sequence:this.timeline.length+1,mode,kind,fields});this.timeline.push(row);return copy(row);
  }
  sync(){
    for(const raw of this.inner.timeline.slice(this.innerCursor)){
      if(raw.kind==='model-context')continue; // V8 publishes its own checked context.
      const {schema,sequence,ownerSequence,mode,kind,traceFormat,...fields}=raw;
      if(kind==='program'){
        const program=defineRegionProgram({source:fields.source,entry:fields.entry}).program;
        this.programs.set(fields.programId,program);fields.regionProgram=program;
      }
      if(kind==='semantic'||kind==='result'){
        const record=decodeWitness(fields.line);
        fields.line=encodeDetailedRecord(record,{role:kind==='result'?'observed':'generated'});
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
      const controller=this.activation(invocationId).controller;
      if(controller.protocol){
        if(!protocolDetailKinds.has(record.kind))fail('asynchronous or external work requires an extended protocol profile');
        assertProtocolDetailCompatible(controller,record);
      }
      const result=this.inner.selected(invocationId,encodeWitness(record.kind,record.fields));
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
      if(staged.protocol)assertProtocolDetailCompatible(staged,decodeWitness(witness));
      staged.commit(witness,{mode:'generated',track:activation.trackId});
    }
    if(staged.firstWitnessViolation)fail('compact transition conflicts with earlier selected claims');
    this.active={...cursor,entry:copy(entry)};
    for(const witness of records)this.inner.selected(invocationId,witness);
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
  selectProtocol(invocationId,line){
    this.sync();const record=typeof line==='string'?decodeProtocolRecordV8(line):line;
    line=encodeProtocolRecordV8(record);
    const activation=this.activation(invocationId),controller=activation.controller,realm=this.realms.get(activation.realmId);
    if(!['running','returned'].includes(activation.status)||controller.completion)fail('protocol invocation is not runnable');
    if(activation.deadline!==null&&activation.deadline<=this.inner.now())fail('protocol invocation deadline expired');
    if(this.invocations.size!==1||activation.realmPolicy!=='fresh'||controller.effects.size||controller.jobs.size||
      controller.continuations.size||controller.activeJob||this.intents.size||this.handlers.size||this.inner.callbacks.size||
      this.inner.closureQueue.length)fail('protocol profile requires one synchronous fresh invocation without host work');
    if(!this.inner.sourceAvailability.get(activation.trackId)?.has(activation.programId))fail('protocol source is unavailable');
    if(controller.generated>=controller.maxGenerated)fail('protocol generated record bound');
    const staged=cloneRegionController(controller),result=applyProtocolRecordV8(staged,record);staged.generated++;
    const state=sharedRegionState(staged); // Full descriptor/Symbol size is checked before mutation.
    Object.assign(controller,staged);
    realm.heap=controller.heap;realm.locals=controller.locals;realm.scheduler=controller.scheduler;
    if(controller.completion){activation.status='completed';realm.running=null;}
    else if(!controller.stack.length){activation.status='returned';realm.running=null;}
    else {activation.status='running';realm.running=invocationId;}
    this.append('generated','protocol',{session:this.inner.sessionId,track:activation.trackId,invocationId,line});
    return {...result,state};
  }
  selectAlgorithm(invocationId,line,providedEntry){
    const record=decodePureRegionRecord(line),activation=this.activation(invocationId),controller=activation.controller;
    const program=this.program(invocationId),entry=pureRegionEntry(program,controller,this.timeline.length);
    if(!eq(entry,providedEntry))fail('stale pure region entry');
    const evaluated=evaluatePureRegion(program,controller);
    if(!eq(record,evaluated.record))fail('false algorithm value, allocation identity or completion');
    const staged=cloneRegionController(controller);
    for(const witness of evaluated.records)staged.commit(witness,{mode:'generated',track:activation.trackId});
    for(const witness of evaluated.records)this.inner.selected(invocationId,witness);
    this.innerCursor=this.inner.timeline.length;
    this.consumed.push({invocationId,frame:controller.rootInvocation,region:'whole'});
    this.append('generated','algorithm',{session:this.inner.sessionId,track:activation.trackId,invocationId,entry:copy(entry),line});
    return {status:'committed',region:'whole',state:sharedRegionState(controller)};
  }
  modelContext(invocationId){
    this.sync();const activation=this.activation(invocationId),controller=activation.controller;
    const state=sharedRegionState(controller);
    return clean({schema:REGION_CONTEXT_VERSION,representation:'mixed',profile:REGION_PROFILE,
      invocationId,programs:[...this.programs].map(([id,program])=>({id,program})),
      input:controller.input,state,regionCursor:{active:this.active,consumed:this.consumed},
      obligations:{intents:[...this.inner.intents].map(([key,{args,...intent}])=>[key,intent]),
        handlers:[...this.inner.handlers].map(([key,handler])=>[key,{...handler,seen:[...handler.seen],queue:[]}]),
        callbacks:[...this.inner.callbacks],closureQueue:this.inner.closureQueue.map(({args,...row})=>row)},
      visibleThrough:this.timeline.length,prefixDigest:hashAlgorithmData(this.timeline)});
  }
  exportEpisode(){this.sync();return {schema:REGION_EXECUTION_VERSION,traceFormat:REGION_TRACE_VERSION,
    contextFormat:REGION_CONTEXT_VERSION,representation:'mixed',profile:REGION_PROFILE,timeline:copy(this.timeline)};}
  /** Import an observed receipt only. No model record can create observations. */
  importObserved(row){
    if(row?.mode!=='observed'||['semantic','region','algorithm','protocol'].includes(row.kind))fail('host receipt authority');
    if(this.hasProtocol())fail('observations after protocol work require an extended asynchronous profile');
    this.sync();const fields=copy(row.fields),kind=row.kind;
    if(kind==='program'){
      validateRegionProgram(fields.regionProgram);
      const expected=defineRegionProgram({source:fields.source,entry:fields.entry}).program;
      if(!eq(fields.regionProgram,expected))fail('program publication changed');delete fields.regionProgram;
      this.inner.publishProgram(fields);this.sync();return;
    }
    if(kind==='result'){const record=decodeDetailedRecord(fields.line,{role:'observed'});
      fields.line=encodeWitness(record.kind,record.fields);}
    const raw={schema:HARNESS_ENVELOPE_VERSION,session:this.inner.sessionId,
      sequence:this.inner.globalSequence+1,ownerSequence:(this.inner.ownerSequences.get(fields.track)??0)+1,
      mode:'observed',kind,...fields};
    // Use the existing independently specified host lifecycle machine. This
    // read-only replay never dispatches a service or calls a retained handler.
    this.inner=SelectedExecutionHarness.replay(oldEpisode(this.inner,[...this.inner.timeline,raw]),{requireTerminal:false});
    this.sync();
  }
  async dispatch(invocationId,effectId,options){
    if(this.hasProtocol())fail('protocol profile does not dispatch host work');
    const result=await this.inner.dispatch(invocationId,effectId,options);this.sync();return result;
  }
  deliverResult(invocationId,effectId,options){this.assertBaseLifecycle();const result=this.inner.deliverResult(invocationId,effectId,options);this.sync();return result;}
  registerEventHandler(options){this.assertBaseLifecycle();const result=this.inner.registerEventHandler(options);this.sync();return result;}
  postEvent(options){this.assertBaseLifecycle();const result=this.inner.postEvent(options);this.sync();return result;}
  closeEventHandler(id){this.assertBaseLifecycle();const result=this.inner.closeEventHandler(id);this.sync();return result;}
  reconcile(invocationId,effectId,options){this.assertBaseLifecycle();const result=this.inner.reconcile(invocationId,effectId,options);this.sync();return result;}
  checkpoint(){
    this.sync();if(this.active)fail('cannot checkpoint an uncommitted local transition');
    const body={schema:REGION_CONTINUATION_VERSION,profile:REGION_PROFILE,public:this.exportEpisode(),
      regionCursor:{active:null,consumed:copy(this.consumed)},selected:this.hasProtocol()?this.protocolCheckpoint():this.inner.checkpoint()};
    return {...body,integrity:hashAlgorithmData(clean(body))};
  }
  protocolCheckpoint(){
    return clean({schema:protocolCheckpointSchema,invocations:[...this.invocations].map(([id,activation])=>[
      id,{status:activation.status,state:sharedRegionState(activation.controller)}])});
  }
  static replay(exported,{requireTerminal=true}={}){
    const publicData=exported?.public??exported;
    assertAlgorithmFields(publicData,['schema','traceFormat','contextFormat','representation','profile','timeline'],'region episode');
    if(publicData.schema!==REGION_EXECUTION_VERSION||publicData.traceFormat!==REGION_TRACE_VERSION||
      publicData.contextFormat!==REGION_CONTEXT_VERSION||publicData.representation!=='mixed'||publicData.profile!==REGION_PROFILE)
      fail('incompatible execution contract');
    if(!Array.isArray(publicData.timeline)||publicData.timeline.length>50000)fail('timeline bound');
    const harness=new RegionExecutionHarness({sessionId:publicData.timeline[0]?.fields?.session??'regions',automaticDelivery:false,now:()=>-Infinity});
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
    return harness;
  }
  static restore(packet,options={}){
    assertAlgorithmFields(packet,['schema','profile','public','regionCursor','selected','integrity'],'region checkpoint');
    const {integrity,...body}=packet;
    if(body.schema!==REGION_CONTINUATION_VERSION||body.profile!==REGION_PROFILE||hashAlgorithmData(clean(body))!==integrity)
      fail('checkpoint version or integrity');
    const replayed=RegionExecutionHarness.replay(body.public,{requireTerminal:false});
    if(!eq(body.regionCursor,{active:null,consumed:replayed.consumed}))fail('checkpoint region cursor differs from public history');
    if(replayed.hasProtocol()){
      if(!eq(body.selected,replayed.protocolCheckpoint()))fail('protocol checkpoint differs from exact public shared state');
      for(const {controller} of replayed.invocations.values())if(controller.protocol)
        restoreProtocolStateV8(controller,controller.protocol);
      if(typeof options.now==='function')replayed.inner.now=options.now;
      return replayed;
    }
    if(
      !eq(body.selected.timeline,replayed.inner.timeline))fail('checkpoint differs from public region history');
    replayed.inner=SelectedExecutionHarness.restore(body.selected,options);
    replayed.innerCursor=replayed.inner.timeline.length;return replayed;
  }
}
