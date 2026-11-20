// Opt-in transport for the independent native v8 model. Only public execution
// prefixes cross this boundary; source evidence and expected answers do not.
import {spawn} from 'node:child_process';
import {TextDecoder} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {decodeCausalLmV8Target,validateRegionContext} from './causal-lm-v8.js';

const HASH=/^[a-f0-9]{64}$/;
const copy=structuredClone;
const demand=(condition,message)=>{if(!condition)throw new TypeError('Native v8: '+message);};
const bounded=(value,minimum,maximum)=>Number.isSafeInteger(value)&&value>=minimum&&value<=maximum;

export function createNativeV8ProcessSelector({command,args=[],cwd,env,
    timeoutMs=30000,maxMessageBytes=16*1024*1024}={}){
  demand(typeof command==='string'&&command.length>0,'model executable required');
  demand(Array.isArray(args)&&args.every(value=>typeof value==='string'),'invalid executable arguments');
  demand(bounded(timeoutMs,1,300000)&&bounded(maxMessageBytes,1024,64*1024*1024),'invalid transport bounds');
  const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
  const utf8=new TextDecoder('utf-8',{fatal:true}),pending=new Map(),sessions=new Map(),attempts=[];
  let nextId=0,buffer=Buffer.alloc(0),stderr='',closed=false,identity=null,epoch=0,shutdownPromise=null;
  const stop=error=>{
    if(closed)return;
    closed=true;identity=null;epoch++;
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}
    pending.clear();child.stdin.destroy();child.kill();
  };
  child.once('error',stop);
  child.once('exit',(code,signal)=>stop(new Error('Native v8 model exited '+String(code??signal)+
    (stderr?' (stderr: '+stderr.slice(-1000)+')':''))));
  child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-4096);});
  child.stdout.on('data',chunk=>{
    if(closed)return;
    buffer=Buffer.concat([buffer,chunk]);
    for(;;){
      const end=buffer.indexOf(10);
      if(end<0){if(buffer.length>maxMessageBytes)stop(new Error('Native v8 response exceeds byte limit'));return;}
      if(end>maxMessageBytes){stop(new Error('Native v8 response exceeds byte limit'));return;}
      let response;
      try{response=JSON.parse(utf8.decode(buffer.subarray(0,end)));}
      catch{stop(new Error('Native v8 response is not exact UTF-8 JSON'));return;}
      buffer=buffer.subarray(end+1);
      const item=pending.get(response?.id);
      if(!item){stop(new Error('Native v8 response has no matching request'));return;}
      clearTimeout(item.timer);pending.delete(response.id);
      if(response.ok===false){
        const error=new Error('Native v8 inference refused: '+String(response.error?.message??'unknown failure'));
        error.category=response.error?.category??'native-inference';
        error.evidence=copy(response.error?.evidence??null);item.reject(error);
      }else if(response.ok!==true)item.reject(new Error('Native v8 response lacks success authority'));
      else item.resolve(response.result);
    }
  });
  const request=body=>{
    if(closed)return Promise.reject(new Error('Native v8 process is closed'));
    if(pending.size)return Promise.reject(new Error('Native v8 model already has an outstanding request'));
    const id='v8-'+(++nextId),line=JSON.stringify({...body,id})+'\n';
    if(Buffer.byteLength(line)>maxMessageBytes)return Promise.reject(new Error('Native v8 request exceeds byte limit'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>stop(new Error('Native v8 request deadline exceeded')),timeoutMs);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(line,error=>{if(error)stop(error);});
    });
  };
  const validateRequest=input=>{
    demand(identity!==null,'model has not attested its checkpoint');
    demand(input&&typeof input.session==='string'&&input.session.length>0,'session required');
    const {public:publicData,contexts,context}=input;
    validateRegionContext(context);
    demand(publicData?.schema==='semantic-execution/8'&&Array.isArray(publicData.timeline)&&
      publicData.timeline[0]?.fields?.session===input.session,'public execution session changed');
    demand(Array.isArray(contexts)&&contexts.length===publicData.timeline.filter(row=>row.mode==='generated').length,
      'prior contexts must cover only committed generated records');
    demand(context.visibleThrough===publicData.timeline.length&&
      context.prefixDigest===hashAlgorithmData(publicData.timeline),'current context is not the supplied public cutoff');
    demand(!sessions.get(input.session)?.pending,'previous native output needs a commit or cancellation');
  };
  const select=async input=>{
    validateRequest(input);
    const capturedEpoch=epoch,capturedIdentity=identity,contextDigest=hashAlgorithmData(input.context);
    const evidence={attempt:attempts.length,session:input.session,invocationId:input.context.invocationId,
      prefixDigest:input.context.prefixDigest,contextDigest,checkpointIdentity:identity.checkpointIdentity,
      tokenizerIdentity:identity.tokenizerIdentity,status:'submitted',elapsedMs:null,selection:null,
      failure:null,failureEvidence:null};
    attempts.push(evidence);const started=performance.now();
    try{
      const output=await request({op:'select',session:input.session,public:input.public,
        contexts:input.contexts,context:input.context});
      demand(capturedEpoch===epoch&&identity===capturedIdentity,'checkpoint changed during selection');
      demand(output?.schema==='semantic-model-output/8'&&typeof output.record==='string',
        'model did not return a complete v8 selection');
      demand(Buffer.from(output.record,'utf8').toString('utf8')===output.record,'selected record is not exact UTF-8');
      const selection=output.selection;
      evidence.selection=copy(selection??null);
      demand(selection?.modelSelected===true&&selection.origin==='actual-model-selected'&&
        selection.checkpointIdentity===identity.checkpointIdentity&&selection.tokenizerIdentity===identity.tokenizerIdentity&&
        selection.prefixDigest===input.context.prefixDigest&&selection.contextDigest===contextDigest,
        'model selection is not bound to the frozen checkpoint and current prefix');
      demand(typeof selection.payloadHex==='string'&&/^(?:[0-9a-f]{2})+$/.test(selection.payloadHex)&&
        Buffer.from(selection.payloadHex,'hex').equals(Buffer.from(output.record,'utf8')),
        'original model bytes differ from the supplied record');
      demand(Array.isArray(selection.fragments)&&selection.fragments.length>0&&selection.fragments.every(fragment=>
        Array.isArray(fragment.tokenIds)&&fragment.tokenIds.length>0&&
        fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&typeof fragment.payloadHex==='string'&&
        /^(?:[0-9a-f]{2})*$/.test(fragment.payloadHex)),'original native fragment evidence required');
      demand(Buffer.concat(selection.fragments.map(fragment=>Buffer.from(fragment.payloadHex,'hex')))
        .equals(Buffer.from(output.record,'utf8')),'native fragments changed selected bytes');
      decodeCausalLmV8Target(output.record);
      evidence.status='decoded';
      sessions.set(input.session,{pending:{record:output.record,selection:copy(selection),contextDigest},evidence});
      return copy(output);
    }catch(error){evidence.status='failed';evidence.failure=String(error.message);
      evidence.failureEvidence=copy(error.evidence??null);throw error;}
    finally{evidence.elapsedMs=performance.now()-started;}
  };
  select.initialize=async input=>{
    const capturedEpoch=++epoch;identity=null;sessions.clear();
    demand(input&&HASH.test(input.checkpointIdentity??'')&&HASH.test(input.tokenizerIdentity??'')&&
      Number.isSafeInteger(input.seed)&&input.seed>=0,'frozen checkpoint, tokenizer and seed required');
    const receipt=await request({op:'initialize',seed:input.seed,
      checkpointIdentity:input.checkpointIdentity,tokenizerIdentity:input.tokenizerIdentity});
    demand(capturedEpoch===epoch&&receipt?.schema==='semantic-inference-identity/8'&&
      receipt.checkpointIdentity===input.checkpointIdentity&&receipt.tokenizerIdentity===input.tokenizerIdentity&&
      receipt.seed===input.seed,'loaded model identity differs from frozen experiment');
    identity=copy(receipt);return copy(receipt);
  };
  select.commit=async input=>{
    const session=sessions.get(input?.session),selected=session?.pending;
    demand(selected&&input.record===selected.record&&
      hashAlgorithmData(input.selection)===hashAlgorithmData(selected.selection),'commit changed original model selection');
    try{
      const result=await request({...input,op:'commit'});
      demand(result?.committed===true,'native model did not acknowledge semantic commit');
      session.evidence.status='accepted';session.pending=null;return result;
    }catch(error){session.evidence.status='commit-failed';session.evidence.failure=String(error.message);throw error;}
  };
  select.complete=input=>request({...input,op:'complete'});
  select.cancel=async input=>{
    const session=sessions.get(input?.session);
    if(session?.pending){session.evidence.status='rejected';session.evidence.failure=input.reason??'semantic rejection';}
    try{return await request({...input,op:'cancel'});}finally{sessions.delete(input?.session);}
  };
  select.metrics=()=>({schema:'semantic-native-model-metrics/8',attempts:copy(attempts),
    predictionAttempts:attempts.length,semanticallyAccepted:attempts.filter(row=>row.status==='accepted').length,
    failedAttempts:attempts.filter(row=>['failed','rejected','commit-failed'].includes(row.status)).length,
    unknownGenerationCostAttempts:attempts.filter(row=>row.selection===null).length,
    elapsedMs:attempts.reduce((sum,row)=>sum+(row.elapsedMs??0),0),
    nativeAdmissionClaim:false,sourceAdmissionClaim:false});
  select.status=()=>({closed,pending:pending.size,stderr:stderr.slice(-1000)});
  select.close=()=>stop(new Error('Native v8 model process closed'));
  select.shutdown=()=>{
    if(shutdownPromise)return shutdownPromise;
    if(closed)return Promise.reject(new Error('Native v8 process already closed'));
    if(pending.size)return Promise.reject(new Error('Native v8 request still outstanding'));
    closed=true;identity=null;epoch++;
    shutdownPromise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Native v8 shutdown deadline exceeded'));},10000);
      child.once('close',(code,signal)=>{clearTimeout(timer);
        if(code===0)resolve({graceful:true,exitCode:0});
        else reject(new Error('Native v8 shutdown failed '+String(code??signal)));});
      child.stdin.end();
    });
    return shutdownPromise;
  };
  return select;
}

export function createNativeV8PythonSelector({python='python3',megatokenRepository,servedBundle,
    device='cpu',maxTokens=1024,maxFragments=32,...options}={}){
  demand(typeof megatokenRepository==='string'&&megatokenRepository.length>0,'consumer checkout required');
  demand(typeof servedBundle==='string'&&servedBundle.length>0,'existing serving bundle required');
  demand(bounded(maxTokens,1,65536)&&bounded(maxFragments,1,1024),'invalid generation bounds');
  return createNativeV8ProcessSelector({...options,command:python,cwd:megatokenRepository,
    args:['scripts/serve_semantic_v8.py','--served',servedBundle,'--device',device,
      '--max-tokens',String(maxTokens),'--max-fragments',String(maxFragments)]});
}
