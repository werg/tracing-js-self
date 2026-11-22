// Opt-in Node transport for the bounded owned runtime. Native promises are
// never guest activations or continuations; only journaled delivery resumes JS.
import {types} from 'node:util';
import {createRuntime} from '../runtime.js';
import {hostOperation} from './operations.js';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {compilePendingEffectJS,materializeNativeEffectArguments} from '../effect-javascript.js';
import {encodeNativeGraph,materializeOwnedGraph,decodeOwnedGraph} from './graph-codec.js';

const primitive=value=>value===null||
  ['undefined','boolean','number','string','bigint'].includes(typeof value);
const errorMessage=error=>error instanceof Error?error.message:String(error);

/** Execute bounded script code with real asynchronous, separately owned host I/O.
 * All service invocations are one-shot and replay never reinvokes a service. */
export async function executeWithNativeServices({text,entry=null,services={},maxSteps=100000,randomSeed=null,signal}={}) {
  if(entry!==null) {
    if(text!==undefined||!entry||typeof entry!=='object'||
       typeof entry.text!=='string'||typeof entry.functionName!=='string'||
       (entry.args!==undefined&&!Array.isArray(entry.args)) ||
       (entry.url!==undefined&&typeof entry.url!=='string')||
       (entry.moduleNamespaceIntrinsic!==undefined&&
        typeof entry.moduleNamespaceIntrinsic!=='boolean'))
      throw new TypeError('Native strict entry needs source text, name and optional argument array');
  }else if(typeof text!=='string')
    throw new TypeError('Native driver needs JS source text');
  if(services===null||typeof services!=='object'||Array.isArray(services)||
     types.isProxy(services)||
     ![Object.prototype,null].includes(Object.getPrototypeOf(services)))
    throw new TypeError('Native services must be a plain operation-to-function record');
  if(signal!==undefined && (typeof signal!=='object'||
     typeof signal.addEventListener!=='function'||
     typeof signal.removeEventListener!=='function'))
    throw new TypeError('signal must be an AbortSignal');
  if(signal?.aborted)throw signal.reason??new Error('Native driver aborted');
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1)
    throw new RangeError('Native execution step budget must be a positive safe integer');
  const owner=new AbortController();
  const pending=new Set(),arrivals=[],deliveries=[],callbackReturns=new Map();
  let callbackOrdinal=0;
  let wake=null,active=true;
  let inJobGroup=false,remainingJobs=0;
  const enqueue=item=>{
    if(!active||owner.signal.aborted)return;
    arrivals.push(item);
    if(wake){const notify=wake;wake=null;notify();}
  };
  // The emitted effect JS always calls this bridge; no service call bypasses
  // the native-to-owned settlement or callback scheduling boundary.
  const bridge=Object.freeze({
    arguments:(effectId,payload)=>{
      const effect=runtime.state.effects[effectId];
      if(!effect||effect.request?.payload!==payload||!pending.has(effectId))
        throw new Error('Owned argument snapshot is unavailable or changed');
      return materializeNativeEffectArguments(effect,bridge.callback);
    },
    settle:(effectId,value,abrupt=false)=>{
      if(!pending.has(effectId))return;
      if(abrupt&&value instanceof Error)value=value.message;
      let graph=null;
      if(!primitive(value))try{
        if(hostOperation(runtime.state.effects[effectId].operation).resultCodec!=='owned-graph/1')
          throw new TypeError('Native service returned a non-primitive result outside its declared codec');
        graph=encodeNativeGraph([value]);
      }catch(error){value=errorMessage(error);abrupt=true;}
      enqueue({kind:'settlement',effectId,value:graph?undefined:value,graph,abrupt});
    },
    callback:(effectId,callbackId)=>function(...args){
      if(!active||owner.signal.aborted||!pending.has(effectId)&&
          runtime.state.effects[effectId]?.subscription?.state!=='active')
        throw new Error('Owned callback is no longer active');
      const spec=hostOperation(runtime.state.effects[effectId].operation);
      if(spec.callbackGraph){
        if(spec.kind!=='promise')throw new TypeError('Return-value callbacks require an asynchronous host operation');
        if(args.length>32)throw new TypeError('Owned callback requires at most 32 arguments');
        if(callbackReturns.size>=4096)throw new RangeError('Owned callback return queue limit');
        // Capture the entire boundary graph before yielding. This preserves
        // aliases between this, every argument, sparse arrays and cycles.
        const inputGraph=encodeNativeGraph([this,...args]);
        const returnId='callbackreturn'+(++callbackOrdinal);
        const completion=new Promise((resolve,reject)=>callbackReturns.set(returnId,{resolve,reject}));
        void completion.catch(()=>{});
        enqueue({kind:'callback',effectId,callbackId,returnId,inputGraph});
        return completion;
      }
      if(args.length>32||!args.every(primitive))
        throw new TypeError('Owned callback requires at most 32 primitive arguments');
      enqueue({kind:'callback',effectId,callbackId,args});
      return undefined; // Guest closure runs later in the owned VM.
    }
  });
  const adapters=Object.create(null);
  for(const operation of Reflect.ownKeys(services)){
    // Do not execute accessors or proxy traps merely by registering services.
    const descriptor=Object.getOwnPropertyDescriptor(services,operation);
    if(typeof operation!=='string'||!descriptor||
       !Object.hasOwn(descriptor,'value')||!descriptor.enumerable)
      throw new TypeError('Native services must be enumerable own data properties');
    hostOperation(operation); // Only explicitly versioned operation contracts.
    const service=descriptor.value;
    if(typeof service!=='function')throw new TypeError('Host service must be a function: '+operation);
    adapters[operation]=context=>{
      if(pending.has(context.effectId))throw new Error('Duplicate native dispatch');
      pending.add(context.effectId);
      const input=Object.freeze({...context,signal:owner.signal});
      // Real external JS is compiled once, after owned dispatch. Service
      // handlers still receive the existing native-driver context signature.
      const javascript=compilePendingEffectJS(runtime,context.effectId);
      Promise.resolve().then(()=>{
        if(!active||owner.signal.aborted)return;
        const wrapped=(...args)=>service(Object.freeze({...input,
          args:Object.freeze(args)}));
        return new Function('effects','bridge',javascript)(
          {[operation]:wrapped},bridge);
      }).catch(error=>bridge.settle(context.effectId,errorMessage(error),true));
      return {kind:'pending'};
    };
  }
  const runtime=createRuntime({adapters,maxSteps,randomSeed});
  const completeCallbacks=()=>{
    for(const frame of Object.values(runtime.state.frames)){
      const id=frame.externalCallbackReturn?.id,waiter=callbackReturns.get(id);
      if(!waiter||!['completed','thrown'].includes(frame.status))continue;
      let value=frame.asyncPromiseId?['promise',frame.asyncPromiseId]:frame.completion?.value?.value;
      let abrupt=frame.status==='thrown';
      if(value?.[0]==='promise'){
        const promise=runtime.state.promises[value[1]];
        if(!promise||promise.status==='pending')continue;
        abrupt=promise.status==='rejected';value=promise.value.value;
      }
      const graph=materializeOwnedGraph(runtime.state.heap,[value]);
      const result=decodeOwnedGraph(graph.payload)[0];
      callbackReturns.delete(id);
      if(abrupt)waiter.reject(result);else waiter.resolve(result);
    }
  };
  if(entry){
    const moduleNamespaceIntrinsic=entry.moduleNamespaceIntrinsic===true;
    const source=runtime.registerSource({text:entry.text,
      url:entry.url??'<native-entry>',trainingProfile:true,moduleNamespaceIntrinsic});
    runtime.startEntry({source,functionName:entry.functionName,
      args:entry.args??[],allowAsync:true,allowHost:true,moduleNamespaceIntrinsic});
  }else runtime.start(text);
  const abort=()=>{owner.abort(signal?.reason??new Error('Native driver aborted'));
    if(wake){const notify=wake;wake=null;notify();}};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  try{
    for(;;){
      if(signal?.aborted)throw signal.reason??new Error('Native driver aborted');
      // Preserve the FIFO prefix that was already ready when this native turn
      // began. Jobs created by that prefix belong to a later native microtask
      // turn, after already-scheduled service settlements. A synchronous host
      // call can suspend transport but cannot end its current guest job; retain
      // that prefix and postpone unrelated delivery until the job group ends.
      while(arrivals.length){
        const next=arrivals.shift();
        if(next.kind==='callback')deliveries.push(next);
        else{
          const {effectId,value,graph,abrupt}=next;
          if(!pending.has(effectId))throw new Error('Unexpected duplicate service completion');
          const effect=runtime.state.effects[effectId];
          if(!effect)throw new Error('Unknown native completion effect');
          const received=runtime.recordInputArrival({effectId,
            kind:effect.kind==='promise'?'completion':'immediate',value,graph,abrupt});
          deliveries.push({kind:'delivery',effectId,inputId:received.inputId});
        }
      }
      const activeBefore=runtime.state.frames[runtime.state.control.a0.activeFrameId];
      for(let index=0;index<deliveries.length;){
        const next=deliveries[index];
        const unblocks=next.kind==='delivery'&&activeBefore?.status==='blocked'&&
          activeBefore.blockedOn===next.effectId;
        if(inJobGroup&&!unblocks){index++;continue;}
        deliveries.splice(index,1);
        if(next.kind==='callback')runtime.recordExternalCallback(next);
        else{
          if(!pending.delete(next.effectId))throw new Error('Unexpected duplicate service delivery');
          runtime.deliverInput(next.inputId);
        }
      }
      // Yield boundaries must not reset the resource limit. Count committed
      // work across this collection, including deliveries and job entries.
      if(!inJobGroup){remainingJobs=runtime.state.control.a0.queue.length;inJobGroup=true;}
      let progress;
      for(let index=0;;index++){
        if(runtime.events.length>=maxSteps)
          throw new Error('Native driver safety limit ('+maxSteps+' committed steps) exceeded');
        if(index>0){runtime.enterQueuedJob();remainingJobs--;}
        const remaining=maxSteps-runtime.events.length;
        if(remaining<1)throw new Error('Native driver safety limit ('+maxSteps+' committed steps) exceeded');
        progress=runtime.drive({yieldBeforeJob:true,stepLimit:remaining});
        completeCallbacks();
        if(progress.kind!=='yield'||remainingJobs===0)break;
      }
      if(progress.kind==='yield'){
        inJobGroup=false;
        await Promise.resolve();
        continue;
      }
      if(progress.kind!=='waiting'){
        if(progress.kind==='unsupported'){
          const error=new Error('Unsupported owned execution: '+
            (progress.failure?.completion?.feature??progress.failure?.kind??'undeclared feature'));
          error.category='unsupported.runtime';error.details=progress.failure;
          throw error;
        }
        // Never seal an archive that omits a still-outstanding native effect.
        // A detached effect may already have started, so this is fail-closed,
        // not rollback or guest-visible host cancellation.
        if(pending.size||callbackReturns.size)throw new Error(
          'Owned run ended with unresolved native effects; refusing incomplete archive');
        const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
        validateBundle(bundle);
        replayExact(bundle); // Recorded outcomes, never native service execution.
        return {progress,bundle,runtime};
      }
      const activeAfter=runtime.state.frames[runtime.state.control.a0.activeFrameId];
      if(activeAfter?.status!=='blocked')inJobGroup=false;
      if(arrivals.length||!inJobGroup&&deliveries.length)continue;
      if(activeAfter?.status==='blocked'&&!pending.has(activeAfter.blockedOn))
        throw new Error('Guest is waiting for an external effect without a registered native service');
      if(!pending.size&&!Object.values(runtime.state.effects).some(effect=>effect.subscription?.state==='active'))
        throw new Error('Guest is waiting for an external effect without a registered native service');
      await new Promise(resolve=>{wake=resolve;});
    }
  }finally{
    active=false;
    signal?.removeEventListener('abort',abort);
    // Retained native listeners and timers belong to this collection run.
    // Abort also releases them when a VM limit or invalid delivery stops the
    // run before guest source can issue its ordinary close operation.
    owner.abort(new Error('Native service owner closed'));
    for(const waiter of callbackReturns.values())waiter.reject(owner.signal.reason);
    callbackReturns.clear();
    // Native deliveries belong to this run. Late external settlement cannot
    // append an arrival to an exported archive or wake another invocation.
    pending.clear();
    arrivals.length=0;
    deliveries.length=0;
    wake=null;
  }
}
