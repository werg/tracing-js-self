// Native selected model process transport. It is deliberately a separate,
// opt-in adapter to Megatoken's real checkpoint-backed multitrack inference.
// The process cannot supply a guest observation or execute external effects.
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

function demand(allowed,message){if(!allowed)throw new TypeError(message);}

/**
 * JSONL model protocol: {id,op:"select",prefix} ->
 * {id,ok:true,result:{schema:"selected-model-output/2",record,selection}}.
 * A complete selected record is validated a second time by the semantic
 * controller before any real host tool dispatch. This adapter is not a
 * substitute for that selected-state validation.
 */
export function createMegatokenProcessSelector({command,args=[],cwd=undefined,
    env=undefined,maxLineBytes=1048576,maxOutstanding=32,timeoutMs=30000,representation='explicit'}={}){
  demand(typeof command==='string'&&command.length,'Model process executable is required');
  demand(Array.isArray(args)&&args.every(x=>typeof x==='string'),'Model arguments must be strings');
  demand(['explicit','compact','outcome-only'].includes(representation),'Unknown selected model representation');
  demand(Number.isSafeInteger(maxLineBytes)&&maxLineBytes>=1024&&
    Number.isSafeInteger(maxOutstanding)&&maxOutstanding>=1&&
    Number.isSafeInteger(timeoutMs)&&timeoutMs>0,'Model JSONL limits are invalid');
  const process=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],
    shell:false,windowsHide:true});
  let closed=false,nextId=0,buffer='',stderr='';
  const decoder=new StringDecoder('utf8');
  const pending=new Map();
  const nativeMetrics={schema:'semantic-inference-metrics/4',rpcCalls:0,computeSeconds:0,peakMemoryBytes:0};
  const abort=error=>{
    if(closed)return;
    closed=true;
    for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(error);}
    pending.clear();
    process.stdin.destroy();
    process.kill();
  };
  process.once('error',error=>abort(error));
  process.once('exit',(code,signal)=>abort(new Error(
    'Megatoken selected process exited '+String(code??signal)+
    (stderr?' (stderr: '+stderr.slice(-1000)+')':''))));
  process.stderr.on('data',bytes=>{
    stderr=(stderr+String(bytes)).slice(-4096);
  });
  process.stdout.on('data',bytes=>{
    if(closed)return;
    buffer+=decoder.write(bytes);
    if(Buffer.byteLength(buffer,'utf8')>maxLineBytes*2){
      abort(new Error('Oversized model response stream'));return;
    }
    for(;;){
      const end=buffer.indexOf('\n');if(end<0)break;
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      if(Buffer.byteLength(line,'utf8')>maxLineBytes){
        abort(new Error('Model response byte cap exceeded'));return;
      }
      let result;
      try{result=JSON.parse(line);}
      catch(error){abort(new Error('Malformed selected model JSON response'));return;}
      const message=pending.get(result?.id);
      if(!message){abort(new Error('Model response identity has no request'));return;}
      if(result.runtimeMetrics!==undefined){
        const metrics=result.runtimeMetrics;
        if(metrics?.schema!=='semantic-inference-metrics/4'||
          ![metrics.computeSeconds,metrics.peakMemoryBytes].every(value=>
            typeof value==='number'&&Number.isFinite(value)&&value>=0)){
          abort(new Error('Native inference returned invalid measured costs'));return;
        }
        nativeMetrics.rpcCalls++;nativeMetrics.computeSeconds+=metrics.computeSeconds;
        nativeMetrics.peakMemoryBytes=Math.max(nativeMetrics.peakMemoryBytes,metrics.peakMemoryBytes);
      }
      pending.delete(result.id);
      clearTimeout(message.timer);
      if(result.ok===false){
        const error=new Error('Selected Megatoken inference refused: '+
          String(result.error?.category??'failure')+': '+String(result.error?.message??''));
        error.category=String(result.error?.category??'inference-failure');
        error.evidence=result.error?.evidence??null;
        message.reject(error);
      }
      else if(result.ok!==true)message.reject(new Error('Invalid model RPC success authority'));
      else message.resolve(result.result);
    }
  });
  const send=(request)=>{
    if(closed)return Promise.reject(new Error('Megatoken model process is closed'));
    if(pending.size>=maxOutstanding)
      return Promise.reject(new Error('Model outstanding RPC capacity exhausted'));
    const id='s'+(++nextId);
    const line=JSON.stringify({id,...request})+'\n';
    if(Buffer.byteLength(line,'utf8')>maxLineBytes)
      return Promise.reject(new Error('Model request exceeds its declared size limit'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>abort(new Error('Megatoken selected RPC deadline exceeded')),timeoutMs);
      timer.unref?.();
      pending.set(id,{resolve,reject,timer});
      process.stdin.write(line,'utf8',error=>{
        if(error&&pending.delete(id)){clearTimeout(timer);reject(error);}
      });
    });
  };
  const select=async prefix=>{
    const output=await send({op:'select',prefix,representation});
    demand(output?.schema==='selected-model-output/2'&&
      typeof output.record==='string','Model did not return a committed selected text result');
    demand(output.selection?.modelSelected===true&&
      output.selection.ownerTrack===prefix.trackId&&
      typeof output.selection.selectedEventId==='string'&&
      output.selection.selectedEventId.length>0,
      'Selected output is not tied to its original Megatoken model track');
    demand(output.representation===undefined||output.representation===representation,
      'Selected output representation differs from the requested experiment');
    return output;
  };
  select.initialize=async({seed,checkpointIdentity})=>{
    demand([17,29,43].includes(seed)&&/^[0-9a-f]{64}$/.test(checkpointIdentity??''),
      'Evaluation initialization requires a declared seed and immutable checkpoint');
    const receipt=await send({op:'initialize',seed,checkpointIdentity});
    demand(receipt?.schema==='semantic-inference-identity/4'&&receipt.seed===seed&&
      receipt.checkpointIdentity===checkpointIdentity&&typeof receipt.tokenizerIdentity==='string',
      'Inference process did not attest its actual checkpoint and seed');
    return receipt;
  };
  select.outcome=async prefix=>{
    const output=await send({op:'outcome',prefix});
    demand(output?.schema==='selected-outcome-output/4'&&output.representation==='outcome-only'&&
      typeof output.record==='string'&&output.outcome?.schema==='semantic-outcome/4'&&
      output.selection?.modelSelected===true&&output.selection.ownerTrack===prefix.trackId&&
      typeof output.selection.selectedEventId==='string'&&output.selection.selectedEventId.length>0,
      'Outcome prediction is not bound to an actual selected model record');
    let parsed;try{parsed=JSON.parse(output.record);}catch{
      throw new TypeError('Outcome prediction is not a complete selected JSON record');
    }
    demand(isDeepStrictEqual(parsed,output.outcome),'Outcome prediction differs from original selected bytes');
    return output;
  };
  select.complete=prefix=>{
    const session=prefix.committed[0]?.session;
    return send({op:'complete',session,invocation:prefix.invocationId,prefix});
  };
  select.cancel=prefix=>{
    const session=prefix.committed[0]?.session;
    return send({op:'cancel',session,invocation:prefix.invocationId});
  };
  select.commitRequest=async(prefix,{record,selection,validation})=>{
    const descriptor=await send({op:'commit-request',session:prefix.committed[0]?.session,
      invocation:prefix.invocationId,record,selection,validation});
    const digest=createHash('sha256').update(record,'utf8').digest('hex');
    demand(descriptor?.schema==='semantic-native-action/4'&&
      descriptor.invocationId===prefix.invocationId&&
      descriptor.effectId===validation.effectId&&descriptor.recordDigest===digest&&
      descriptor.ownerTrack===prefix.trackId&&descriptor.modelTrack===selection.modelTrack&&
      typeof descriptor.actionKey==='string'&&descriptor.actionKey.length>0,
      'Native action descriptor is not bound to the committed semantic selection');
    return descriptor;
  };
  select.checkpoint=({session,prefixes})=>send({op:'checkpoint',session,prefixes});
  select.restore=checkpoint=>send({op:'restore',checkpoint});
  select.close=()=>{
    if(closed)return;
    abort(new Error('Megatoken selected process was closed'));
  };
  select.status=()=>({closed,pending:pending.size,stderr:stderr.slice(-1000)});
  select.metrics=()=>({...nativeMetrics});
  Object.defineProperty(select,'representation',{value:representation,enumerable:true});
  return select;
}

/** Load only an already exported serving bundle. This never launches an
 * optimizer, trainer, teacher compiler or hidden Python guest execution. */
export function createMegatokenPythonSelector({python='python3',
    megatokenRepository,servedBundle,device='cpu',effort=1,maxTokens=512,representation='explicit'}={}){
  demand(typeof megatokenRepository==='string'&&megatokenRepository.length,
    'Pinned Megatoken repository path required');
  demand(typeof servedBundle==='string'&&servedBundle.length,
    'Pinned exported model bundle required');
  return createMegatokenProcessSelector({
    command:python,cwd:megatokenRepository,representation,
    args:['scripts/serve_selected_semantic.py','--served',servedBundle,
      '--device',device,'--effort',String(effort),'--max-tokens',String(maxTokens)],
  });
}
