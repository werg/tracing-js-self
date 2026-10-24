// Native worker-thread diagnostics for TRUSTED programs only.
// Uses real V8 SharedArrayBuffer / Atomics, not the owned guest interpreter.
import {Worker} from 'node:worker_threads';

const BOOT = `
const {parentPort,workerData} = require('node:worker_threads');
parentPort.once('message',async message=>{
  if(message!=='start')return;
  try{
    const fn=new Function('buffers','"use strict"; return (async()=>{\\n'+workerData.source+'\\n})()');
    const value=await fn(workerData.buffers);
    parentPort.postMessage({type:'result',value});
  }catch(error){
    parentPort.postMessage({type:'error',name:String(error?.name??'Error'),
      message:String(error?.message??error)});
  }finally{parentPort.close();}
});
parentPort.postMessage({type:'ready'});
`;

/**
 * Run explicitly trusted JavaScript on genuine parallel Node worker threads.
 * All agents receive the *same* SharedArrayBuffer objects via structured clone.
 * No events here are owned traces; do not use this on untrusted corpus inputs.
 */
export async function runNativeWorkerAgents({workers,byteLengths=[4],timeoutMs=5000}={}){
  if(!Array.isArray(workers)||workers.length<1||workers.length>8||
     workers.some(w=>typeof w!=='string'||w.length>32768)||
     !Array.isArray(byteLengths)||byteLengths.length<1||byteLengths.length>8||
     byteLengths.some(n=>!Number.isSafeInteger(n)||n<0||n>65536)||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)
    throw new TypeError('Invalid bounded native worker configuration');
  const buffers=byteLengths.map(n=>new SharedArrayBuffer(n));
  const threads=[],values=Array(workers.length);
  let ready=0,finished=0,closed=false;
  return await new Promise((resolve,reject)=>{
    let deadline;
    const end=(error,output)=>{
      if(closed)return;
      closed=true;clearTimeout(deadline);
      for(const t of threads)t.terminate().catch(()=>{});
      if(error)reject(error);else resolve(output);
    };
    deadline=setTimeout(()=>end(new Error('Native worker deadline exceeded')),timeoutMs);
    try{
      for(let i=0;i<workers.length;i++){
        const thread=new Worker(BOOT,{eval:true,env:{},workerData:{source:workers[i],buffers}});
        threads.push(thread);
        let readyOnce=false,resultOnce=false;
        thread.on('message',m=>{
          if(closed)return;
          if(m?.type==='ready'&&!readyOnce){
            readyOnce=true;
            if(++ready===workers.length)for(const t of threads)t.postMessage('start');
          }else if(m?.type==='error'){
            end(new Error('Native worker '+i+' '+m.name+': '+m.message));
          }else if(m?.type==='result'&&!resultOnce){
            resultOnce=true;values[i]=m.value;
            if(++finished===workers.length)end(null,{
              schema:'native-worker-agents/1',results:values,
              byteLengths:[...byteLengths],
              bufferBytes:buffers.map(b=>Array.from(new Uint8Array(b))),
              evidence:'native-V8-workers-not-owned-traces'
            });
          }else end(new Error('Invalid native worker protocol'));
        });
        thread.on('error',error=>end(error));
        thread.on('exit',code=>{
          if(!closed&&!resultOnce)end(new Error('Native worker '+i+' exited without result ('+code+')'));
        });
      }
    }catch(error){end(error);}
  });
}
