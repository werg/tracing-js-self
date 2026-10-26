// Production inference consumes selected bytes and observed feedback. It never
// evaluates guest source, invokes a teacher, or repairs a selected answer.
import {createHash} from 'node:crypto';
import {decodeWitness,restoreWitness} from './format.js';
import {SelectedExecutionHarness} from './harness-v4.js';
import {hostOperation} from '../host/operations.js';
const copy=value=>structuredClone(value);
function fail(message){throw new Error('Selected execution: '+message);}
function readyToEnd(activation){
  const controller=activation.controller,returned=controller.pending?.value;
  return Boolean(controller.pending&&!controller.stack.length&&!controller.ready.length&&
    [...controller.jobs.values()].every(job=>job.status==='completed')&&
    [...controller.continuations.values()].every(continuation=>continuation.state==='resumed')&&
    [...controller.effects.values()].every(effect=>effect.status!=='requested')&&
    !(activation.completionPolicy==='await-returned-promise'&&returned?.[0]==='ref'&&
      controller.heap.get(returned[1])?.kind==='promise'&&controller.heap.get(returned[1]).state==='pending'));
}

export function selectedWitnessFromGroup(group,trackId){
  const tape=group?.tape;
  if(!tape||!Array.isArray(tape.payloads)||tape.payloads.length!==1||
      tape.valid?.[0]!==true||tape.modalities?.[0]!=='text'||
      tape.tracks?.[0]!==trackId||tape.event_ids?.length!==1)
    fail('Model group must contain one complete committed text selection on its owner');
  const payload=tape.payloads[0];
  if(typeof payload!=='string'||Buffer.byteLength(payload)>65536)
    fail('Selected group must preserve complete canonical witness UTF-8 text');
  if(['observe','code','input'].includes(decodeWitness(payload).kind))
    fail('Model cannot select host-controlled observations');
  return payload;
}

export class SelectedModelDriver {
  constructor({select,harness=new SelectedExecutionHarness(),maxSelections=4096,maxOutstanding=64}={}){
    if(typeof select!=='function')throw new TypeError('An actual selected-model adapter is required');
    if(!Number.isSafeInteger(maxSelections)||maxSelections<1||
       !Number.isSafeInteger(maxOutstanding)||maxOutstanding<1)
      throw new RangeError('Selected inference limits require positive integers');
    Object.assign(this,{select,harness,maxSelections,maxOutstanding});
    this.rejections=[];this.running=new Map();
    this.detachRunnable=this.harness.onRunnable(invocationId=>queueMicrotask(()=>{
      if(this.running.has(invocationId))return;
      void this.runInvocation(invocationId).catch(error=>{
        this.rejections.push({invocationId,error:String(error),phase:'callback'});
      });
    }));
  }
  prefix(invocationId){
    const a=this.harness.invocations.get(invocationId),p=this.harness.programs.get(a.programId);
    const committed=this.harness.timeline.filter(event=>
      event.kind==='program'&&event.programId===a.programId||event.invocationId===invocationId||
      ['source-read','source-evict'].includes(event.kind)&&event.track===a.trackId&&event.programId===a.programId);
    const {realmCommitted,selectedState}=this.harness.selectionContext(invocationId);
    return copy({schema:'selected-inference-prefix/2',programId:a.programId,entry:a.entry,
      source:p.source,sourceDigest:p.digest,invocationId,trackId:a.trackId,realmId:a.realmId,
      committed,realmCommitted,completionPolicy:a.completionPolicy,maxOutstanding:this.maxOutstanding,
      taskRevision:a.taskRevision,parentInvocationId:a.parentInvocationId,receiver:a.receiver,
      closureId:a.closureId,activation:a.activation,
      selectedState});
  }
  async run({programId,source=null,entry=null,capabilities=[],invocationId,trackId,realmId,
      triggerId,args=[],inputGraph=null,realmPolicy='fresh',completionPolicy='call-return',
      selectedEntry=null,receiver=undefined,receiverValue=null,closureId=null,activation='call',
      parentInvocationId=null,taskRevision=1,deadline=null,signal=null,bindings={},
      sourceMetadata=null,dependencies=[],sourceMap=null,module=false,randomSeed}={}){
    if(!this.harness.programs.has(programId)){
      if(typeof source!=='string'||typeof entry!=='string')
        fail('First invocation must publish exact immutable source and entry');
      this.harness.publishProgram({programId,source,entry,capabilities,sourceMetadata,dependencies,sourceMap,module,randomSeed});
    }else if(randomSeed!==undefined&&randomSeed!==(this.harness.programs.get(programId).randomSeed??null)){
      fail('Invocation cannot change the immutable program deterministic seed');
    }
    this.harness.admitInvocation({programId,invocationId,trackId,realmId,triggerId,args,inputGraph,
      realmPolicy,completionPolicy,entry:selectedEntry,receiver,receiverValue,closureId,activation,
      parentInvocationId,taskRevision,deadline,bindings});
    return this.runInvocation(invocationId,{signal});
  }
  invokeClosure(request){return this.harness.enqueueClosure(request);}
  close({closeSelector=false}={}){
    this.detachRunnable();
    for(const invocationId of this.running.keys())
      this.harness.cancelInvocation(invocationId,{reason:'selected driver closed'});
    if(closeSelector)this.select.close?.();
  }
  runInvocation(invocationId,{signal=null}={}){
    if(this.running.has(invocationId))return this.running.get(invocationId).publicResult;
    const activation=this.harness.invocations.get(invocationId);
    if(!activation)throw new TypeError('Unknown selected invocation');
    let resolve,reject;
    const publicResult=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const run={publicResult,early:false};this.running.set(invocationId,run);
    let task;
    task=this.execute(invocationId,{signal,onCallReturn:completion=>{
      if(activation.completionPolicy!=='call-return'||run.early)return;
      run.early=true;
      const selectedState=activation.controller.segmentPacket();
      const rendered=this.harness.inspect(invocationId),episode=this.harness.exportEpisode();
      queueMicrotask(()=>resolve({completion:copy(completion),pending:true,
        selectedState,rendered,episode,observableGraph:null,taskCompletion:task}));
    }});
    run.task=task;
    void task.then(outcome=>{if(!run.early)resolve(outcome);},error=>{
      if(!run.early)reject(error);
    }).finally(()=>this.running.delete(invocationId));
    return publicResult;
  }
  async execute(invocationId,{signal,onCallReturn}){
    const a=this.harness.invocations.get(invocationId),abort=new AbortController();
    const cancel=()=>abort.abort(signal?.reason??new Error('Selected invocation cancelled'));
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    const timer=a.deadline===null?null:setTimeout(()=>abort.abort(new Error('Selected invocation deadline exceeded')),
      Math.max(0,Math.min(2147483647,a.deadline-this.harness.now())));
    let rejectAbort;
    const aborted=new Promise((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
    const onAbort=()=>rejectAbort(abort.signal.reason??new Error('Selected invocation cancelled'));
    abort.signal.addEventListener('abort',onAbort,{once:true});if(abort.signal.aborted)onAbort();
    const check=()=>{if(abort.signal.aborted)throw abort.signal.reason;
      if(['cancelled','failed'].includes(a.status))fail('Invocation is closed');};
    const pending=new Map(),transportFailures=[];let selections=0,modelCalls=0,callReturnReported=false;
    const wait=()=>Promise.race([aborted,this.harness.waitForActivity(),...pending.values()]);
    try{
      for(;;){
        check();
        if(transportFailures.length)throw transportFailures.shift();
        if(a.controller.callReturn&&!callReturnReported){
          callReturnReported=true;onCallReturn?.(a.controller.callReturn);
        }
        if(a.status==='completed'){
          if(typeof this.select.complete==='function')await this.select.complete(this.prefix(invocationId));
          let observableGraph=null;
          try{observableGraph=a.controller.observedGraph();}
          catch(error){if(error.category!=='unsupported-boundary')throw error;}
          return {completion:copy(a.controller.completion),selectedState:a.controller.segmentPacket(),
            rendered:this.harness.inspect(invocationId),episode:this.harness.exportEpisode(),
            selectedRecords:selections,modelCalls,jobErrors:copy(a.controller.jobErrors),observableGraph};
        }
        if(typeof this.select.complete==='function'){
          // A callback can release its guest turn at return before its selected
          // end and native completion acknowledgement. Finish that owned task
          // before asking the same bounded native realm to select another one.
          // Suspended parents remain runnable dependencies, never barriers.
          const earlier=[];
          for(const entry of this.running){if(entry[0]===invocationId)break;earlier.push(entry);}
          const previous=earlier.find(([identity,run])=>{
            if(!run.task)return false;
            const other=this.harness.invocations.get(identity);
            return other?.realmId===a.realmId&&(other.status==='completed'||
              other.activation==='callback'&&readyToEnd(other));
          });
          if(previous){await Promise.race([previous[1].task,aborted]);continue;}
        }
        const realm=this.harness.realms.get(a.realmId);
        const controller=a.controller;
        const endEligible=readyToEnd(a);
        if(!endEligible&&realm.running&&realm.running!==invocationId){
          if(this.harness.invocations.get(realm.running).activation==='callback')
            await Promise.race([this.runInvocation(realm.running,{signal:abort.signal}),aborted]);
          else await Promise.race([this.harness.waitForActivity(),aborted]);
          continue;
        }
        const nextReady=this.harness.nextReadyInvocation(a.realmId);
        if(!endEligible&&!a.controller.stack.length&&nextReady&&nextReady!==invocationId){
          if(!this.running.has(nextReady))void this.runInvocation(nextReady).catch(error=>
            this.rejections.push({invocationId:nextReady,error:String(error),phase:'continuation'}));
          await Promise.race([this.harness.waitForActivity(),aborted]);continue;
        }
        if(!a.controller.stack.length&&!a.controller.pending&&!a.controller.ready.length&&
           ![...a.controller.jobs.values()].some(job=>job.status==='running')){
          if(!pending.size&&![...this.harness.intents.values()].some(intent=>intent.invocationId===invocationId&&
              ['dispatched','uncertain','dispatching'].includes(intent.status)))
            fail('Suspended invocation has no pending observation or runnable continuation');
          await wait();continue;
        }
        if(!this.harness.sourceAvailability.get(a.trackId)?.has(a.programId))
          this.harness.restoreSource(a.trackId,a.programId);
        if(modelCalls++>=this.maxSelections)fail('Model selection budget exhausted without complete return/throw');
        this.harness.prepareModelContext(invocationId);
        let decision=await Promise.race([this.select(this.prefix(invocationId)),aborted]);check();
        if(transportFailures.length)throw transportFailures.shift();
        const selection=decision?.selection??null;
        if(selection?.sourceReads?.length)this.harness.recordModelContext(invocationId,selection.sourceReads);
        if(decision?.tape)decision=selectedWitnessFromGroup(decision,a.trackId);
        if(decision&&typeof decision==='object'&&Array.isArray(decision.fragments)){
          const records=restoreWitness(decision.fragments);
          if(records.length!==1)fail('Fragments must reconstruct exactly one semantic record');decision=records[0];
        }else if(decision&&typeof decision==='object'&&typeof decision.record==='string')decision=decision.record;
        if(decision?.wait===true||decision==='wait'){
          if(!pending.size)fail('A selected wait cannot poll without an outstanding dependency');
          if(this.harness.closureQueue.some(item=>item.ownerInvocationId===invocationId)&&a.controller.stack.length)
            fail('Callback progress requires an explicit selected await at a legal guest boundary');
          await wait();continue;
        }
        if(typeof decision!=='string'||Buffer.byteLength(decision,'utf8')>65536)
          fail('The model did not produce a bounded complete semantic record');
        let kind,fields;
        try{
          ({kind,fields}=decodeWitness(decision));
          if(kind==='request'&&pending.size>=this.maxOutstanding)fail('Outstanding native effect budget exhausted');
          this.harness.selected(invocationId,decision);selections++;
        }catch(error){this.rejections.push({invocationId,record:decision,selection:copy(selection),
          error:String(error),phase:'semantic-validation'});throw error;}
        if(kind==='request'){
          let beforeDispatch=null;
          if(selection?.modelSelected===true||this.select.nativeCommitRequired===true){
            if(!selection||typeof selection.selectedEventId!=='string'||
                typeof selection.modelTrack!=='string'||selection.ownerTrack!==a.trackId)
              fail('Native request needs its original committed selection receipt');
            if(typeof this.select.commitRequest!=='function')fail('Actual model request requires native committed-action validation');
            const heap=Object.fromEntries([...a.controller.heap].map(([id,node])=>[id,
              {id,kind:node.kind,properties:[...node.properties].map(([key,value])=>({key,value})),
                ...(node.prototype===null?{prototype:null}:{})}]));
            const validation={schema:'selected-source-validation/4',
              sourceDigest:this.harness.programs.get(a.programId).digest,invocationId,effectId:fields.effect,
              payloadDigest:createHash('sha256').update(decision).digest('hex'),heap};
            beforeDispatch=()=>this.select.commitRequest(this.prefix(invocationId),
              {record:decision,selection:copy(selection),validation});
          }
          const work=this.harness.dispatch(invocationId,fields.effect,{beforeDispatch});
          pending.set(fields.effect,work);
          void work.then(()=>pending.delete(fields.effect),error=>{
            pending.delete(fields.effect);transportFailures.push(error);this.harness.wake();
            this.rejections.push({invocationId,record:decision,error:String(error),phase:'native-commit-or-delivery'});
          });
          if(hostOperation(fields.operation).kind==='synchronous')await Promise.race([work,aborted]);
        }
      }
    }catch(error){
      if(error.evidence)this.rejections.push({invocationId,error:String(error),
        evidence:copy(error.evidence),phase:'inference-selection'});
      this.harness.cancelInvocation(invocationId,{reason:String(error.message??error)});
      if(typeof this.select.cancel==='function')try{await this.select.cancel(this.prefix(invocationId));}catch{/* Preserve original failure. */}
      throw error;
    }finally{
      if(timer!==null)clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      abort.signal.removeEventListener('abort',onAbort);
    }
  }
}
