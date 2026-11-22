// A persistent exact-token meter. Its evidence is deliberately narrower than
// native parsing, supervision, serving, or learned-execution qualification.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {isAlgorithmDataRecord,assertAlgorithmDataArray} from './ir.js';

const worker=fileURLToPath(new URL('../../tools/semantic-algorithm-tokenizer.py',import.meta.url));
const copy=value=>structuredClone(value);
const sha=/^[a-f0-9]{64}$/;

export function validateAlgorithmTokenizerEvidence({identity,qualification},policy){
  if(!isAlgorithmDataRecord(policy)||Object.keys(policy).sort().join(',')!==
      'consumerRevision,tokenizerIdentity,tokenizerSha256'||
    !/^[a-f0-9]{40}$/.test(policy.consumerRevision)||!sha.test(policy.tokenizerIdentity)||!sha.test(policy.tokenizerSha256))
    throw new TypeError('An exact pinned token metering policy is required');
  if(!isAlgorithmDataRecord(identity)||identity.tokenizerSha256!==policy.tokenizerSha256||
    identity.fingerprint!==policy.tokenizerIdentity||typeof identity.name!=='string'||
    typeof identity.revision!=='string'||typeof identity.codecVersion!=='string'||
    !Number.isSafeInteger(identity.vocabSize)||identity.vocabSize<256||
    !isAlgorithmDataRecord(qualification)||qualification.schema!=='semantic-codec-meter/1'||
    qualification.status!=='qualified'||qualification.scope!=='byte-exact-token-meter-only'||
    qualification.consumerRevision!==policy.consumerRevision||qualification.consumerClean!==true||
    qualification.nativeAdmission!==false||typeof qualification.tokenizersVersion!=='string'||
    !/^\d+\.\d+(?:\.\d+)?(?:[a-zA-Z0-9.+-]*)$/.test(qualification.tokenizersVersion)||
    !sha.test(qualification.codecSourceSha256)||typeof qualification.pythonVersion!=='string')
    throw new TypeError('Token meter evidence differs from the exact codec policy');
  return true;
}

/** Start once, then reuse encode/decode for all paired targets and contexts. */
export async function createAlgorithmTokenizer({python='python3',consumerRoot,tokenizerJson,policy,
  startupTimeoutMs=30000,requestTimeoutMs=30000}={}){
  if(typeof python!=='string'||!python||typeof consumerRoot!=='string'||!consumerRoot||
    typeof tokenizerJson!=='string'||!tokenizerJson||!Number.isSafeInteger(startupTimeoutMs)||
    startupTimeoutMs<1||startupTimeoutMs>60000||!Number.isSafeInteger(requestTimeoutMs)||
    requestTimeoutMs<1||requestTimeoutMs>60000)
    throw new TypeError('Token meter needs a Python runtime, exact checkout and tokenizer file');
  if(!isAlgorithmDataRecord(policy))throw new TypeError('Exact metering policy required');
  const child=spawn(python,[worker,'--consumer-root',consumerRoot,'--tokenizer-json',tokenizerJson,
    '--policy-json',JSON.stringify(policy)],{stdio:['pipe','pipe','pipe']});
  let next=0,closed=false,ready=false,stderr='',resolveReady,rejectReady;
  const pending=new Map(),readyPromise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  function fail(error){
    if(closed)return;closed=true;
    clearTimeout(startupTimer);
    if(!ready)rejectReady(error);
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}pending.clear();
    if(!child.killed)child.kill();
  }
  const startupTimer=setTimeout(()=>fail(new Error('Token meter startup timed out')),startupTimeoutMs);
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);});
  child.on('error',fail);
  child.stdin.on('error',fail);
  child.on('exit',(code,signal)=>fail(new Error('Token meter stopped ('+(signal??code)+')'+(stderr?': '+stderr.trim():''))));
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    if(closed)return;
    let message;
    try{message=JSON.parse(line);}
    catch{return fail(new Error('Malformed token meter response'));}
    if(!ready){
      try{
        if(message.ready!==true)throw new Error('Token meter did not provide ready evidence');
        validateAlgorithmTokenizerEvidence(message,policy);
        ready=true;clearTimeout(startupTimer);resolveReady(message);
      }catch(error){fail(error);}return;
    }
    const request=pending.get(message.id);
    if(!request)return fail(new Error('Token meter response identity is not pending'));
    pending.delete(message.id);clearTimeout(request.timer);
    if(typeof message.error==='string')request.reject(new Error(message.error));
    else request.resolve(message);
  });
  const evidence=await readyPromise;
  function request(op,fields){
    if(closed)return Promise.reject(new Error('Token meter is closed'));
    const id=++next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>fail(new Error('Token meter request timed out')),requestTimeoutMs);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(JSON.stringify({id,op,...fields})+'\n',error=>{if(error)fail(error);});
    });
  }
  return {
    identity:copy(evidence.identity),qualification:copy(evidence.qualification),
    async encode(text){
      if(typeof text!=='string')throw new TypeError('Token meter input must be exact text');
      const {ids}=await request('encode',{text});assertAlgorithmDataArray(ids,'token IDs');
      if(ids.some(id=>!Number.isSafeInteger(id)||id<0||id>=evidence.identity.vocabSize))
        throw new TypeError('Malformed token meter IDs');
      return ids;
    },
    async decode(ids){
      assertAlgorithmDataArray(ids,'token IDs');
      if(ids.some(id=>!Number.isSafeInteger(id)||id<0))throw new TypeError('Malformed token IDs');
      const response=await request('decode',{ids});
      if(typeof response.text!=='string')throw new TypeError('Token meter did not decode text');
      return response.text;
    },
    async close(){
      if(closed)return;
      if(pending.size)throw new Error('Cannot close token meter with pending measurements');
      closed=true;clearTimeout(startupTimer);lines.close();
      await new Promise(resolve=>{
        const timer=setTimeout(()=>{child.kill();resolve();},1000);
        child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();
      });
    }
  };
}
