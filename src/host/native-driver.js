// Opt-in Node transport for the bounded owned runtime. Native promises are
// never guest activations or continuations; only journaled delivery resumes JS.
import {types} from 'node:util';
import {createRuntime} from '../runtime.js';
import {hostOperation} from './operations.js';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';

const primitive=value=>value===null||
  ['undefined','boolean','number','string','bigint'].includes(typeof value);
const errorMessage=error=>error instanceof Error?error.message:String(error);

/** Execute bounded script code with real asynchronous, separately owned host I/O.
 * All service invocations are one-shot and replay never reinvokes a service. */
export async function executeWithNativeServices({text,entry=null,services={},maxSteps=100000,signal}={}) {
  if(entry!==null) {
    if(text!==undefined||!entry||typeof entry!=='object'||
       typeof entry.text!=='string'||typeof entry.functionName!=='string'||
       (entry.args!==undefined&&!Array.isArray(entry.args)) ||
       (entry.url!==undefined&&typeof entry.url!=='string'))
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
  const pending=new Set(),arrivals=[];
  let wake=null,active=true;
  const settled=(effectId,value,abrupt)=>{
    // A cancelled run must never synthesize a guest-visible host arrival.
    if(!active||signal?.aborted||!pending.has(effectId))return;
    arrivals.push({effectId,value,abrupt});
    if(wake){const notify=wake;wake=null;notify();}
  };
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
      const input=Object.freeze({...context,signal});
      // Native promises settle strictly outside the owned interpreter.
      Promise.resolve().then(()=>{
        // Dispatch was journaled before this microtask. Abort before starting
        // native work means the side effect must not be invoked at all.
        if(!active||signal?.aborted)return;
        return service(input);
      }).then(value=>{
        if(!primitive(value))
          settled(context.effectId,'Native service returned a non-primitive result',true);
        else settled(context.effectId,value,false);
      },error=>settled(context.effectId,errorMessage(error),true));
      return {kind:'pending'};
    };
  }
  const runtime=createRuntime({adapters,maxSteps});
  if(entry){
    const source=runtime.registerSource({text:entry.text,
      url:entry.url??'<native-entry>',trainingProfile:true});
    runtime.startEntry({source,functionName:entry.functionName,
      args:entry.args??[],allowAsync:true,allowHost:true});
  }else runtime.start(text);
  const abort=()=>{if(wake){const notify=wake;wake=null;notify();}};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    for(;;){
      if(signal?.aborted)throw signal.reason??new Error('Native driver aborted');
      // Arrival is committed independently before any guest-visible delivery.
      for(const {effectId,value,abrupt} of arrivals.splice(0)){
        if(!pending.delete(effectId))throw new Error('Unexpected duplicate service completion');
        const effect=runtime.state.effects[effectId];
        if(!effect)throw new Error('Unknown native completion effect');
        const received=runtime.recordInputArrival({effectId,
          kind:effect.kind==='promise'?'completion':'immediate',value,abrupt});
        runtime.deliverInput(received.inputId);
      }
      const progress=runtime.drive();
      if(progress.kind!=='waiting'){
        // Never seal an archive that omits a still-outstanding native effect.
        // A detached effect may already have started, so this is fail-closed,
        // not rollback or guest-visible host cancellation.
        if(pending.size)throw new Error(
          'Owned run ended with unresolved native effects; refusing incomplete archive');
        const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
        validateBundle(bundle);
        replayExact(bundle); // Recorded outcomes, never native service execution.
        return {progress,bundle,runtime};
      }
      if(arrivals.length)continue;
      if(!pending.size)
        throw new Error('Guest is waiting for an external effect without a registered native service');
      await new Promise(resolve=>{wake=resolve;});
    }
  }finally{
    active=false;
    signal?.removeEventListener('abort',abort);
    // Native deliveries belong to this run. Late external settlement cannot
    // append an arrival to an exported archive or wake another invocation.
    pending.clear();
    arrivals.length=0;
    wake=null;
  }
}
