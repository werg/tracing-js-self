// Native selected model process transport. It is deliberately a separate,
// opt-in adapter to Megatoken's real checkpoint-backed multitrack inference.
// The process cannot supply a guest observation or execute external effects.
import {spawn} from 'node:child_process';

function demand(allowed,message){if(!allowed)throw new TypeError(message);}

/**
 * JSONL model protocol: {id,op:"select",prefix} ->
 * {id,ok:true,result:{schema:"selected-model-output/1",record,selection}}.
 * A complete selected record is validated a second time by the semantic
 * controller before any real host tool dispatch. This adapter is not a
 * substitute for that selected-state validation.
 */
export function createMegatokenProcessSelector({command,args=[],cwd=undefined,
    env=undefined,maxLineBytes=1048576,maxOutstanding=32}={}){
  demand(typeof command==='string'&&command.length,'Model process executable is required');
  demand(Array.isArray(args)&&args.every(x=>typeof x==='string'),'Model arguments must be strings');
  demand(Number.isSafeInteger(maxLineBytes)&&maxLineBytes>=1024&&
    Number.isSafeInteger(maxOutstanding)&&maxOutstanding>=1,'Model JSONL limits are invalid');
  const process=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],
    shell:false,windowsHide:true});
  let closed=false,nextId=0,buffer='',stderr='';
  const pending=new Map();
  const abort=error=>{
    if(closed)return;
    closed=true;
    for(const {reject} of pending.values())reject(error);
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
    buffer+=String(bytes);
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
      pending.delete(result.id);
      if(result.ok===false)message.reject(new Error(
        'Selected Megatoken inference refused: '+
        String(result.error?.category??'failure')+': '+String(result.error?.message??'')));
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
      pending.set(id,{resolve,reject});
      process.stdin.write(line,'utf8',error=>{
        if(error&&pending.delete(id))reject(error);
      });
    });
  };
  const select=async prefix=>{
    const output=await send({op:'select',prefix});
    demand(output?.schema==='selected-model-output/1'&&
      typeof output.record==='string','Model did not return a committed selected text result');
    demand(output.selection?.modelSelected===true&&
      output.selection.ownerTrack===prefix.trackId&&
      typeof output.selection.selectedEventId==='string'&&
      output.selection.selectedEventId.length>0,
      'Selected output is not tied to its original Megatoken model track');
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
  select.close=()=>{
    if(closed)return;
    abort(new Error('Megatoken selected process was closed'));
  };
  select.status=()=>({closed,pending:pending.size,stderr:stderr.slice(-1000)});
  return select;
}

/** Load only an already exported serving bundle. This never launches an
 * optimizer, trainer, teacher compiler or hidden Python guest execution. */
export function createMegatokenPythonSelector({python='python3',
    megatokenRepository,servedBundle,device='cpu',effort=1,maxTokens=512}={}){
  demand(typeof megatokenRepository==='string'&&megatokenRepository.length,
    'Pinned Megatoken repository path required');
  demand(typeof servedBundle==='string'&&servedBundle.length,
    'Pinned exported model bundle required');
  return createMegatokenProcessSelector({
    command:python,cwd:megatokenRepository,
    args:['scripts/serve_selected_semantic.py','--served',servedBundle,
      '--device',device,'--effort',String(effort),'--max-tokens',String(maxTokens)],
  });
}
