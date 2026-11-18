import {spawn} from 'node:child_process';
import {serialize} from 'node:v8';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('../../tools/generation-worker.mjs',import.meta.url));
// Deliberately do not forward credentials or network proxy settings to trusted
// reference workers. This is defense in depth, not an OS security boundary.
export function generationEnvironment(){
  const keys=['PATH','TMPDIR','TEMP','TMP','LANG','LC_ALL','PYTHONPATH','VIRTUAL_ENV','OMP_NUM_THREADS'];
  return Object.fromEntries(keys.filter(key=>process.env[key]!=null).map(key=>[key,process.env[key]]));
}
export async function runGenerationProcess(task,{outputDirectory,timeoutMs=120000,
    memoryMb=768,maxOutputBytes=268435456,signal}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>3600000||
    !Number.isSafeInteger(memoryMb)||memoryMb<64||memoryMb>8192||
    !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024||maxOutputBytes>1073741824)
    throw new TypeError('Invalid generation worker resource bounds');
  const directory=resolve(outputDirectory);mkdirSync(directory,{recursive:true});
  const output=join(directory,'worker-'+randomUUID()+'.json');
  if(signal?.aborted)return {result:{status:'cancelled',reason:'Campaign cancelled before launch'},durationMs:0,peakRssBytes:null};
  return new Promise(resolveRun=>{
    const start=performance.now(),child=spawn(process.execPath,
      ['--max-old-space-size='+memoryMb,worker],{stdio:['pipe','pipe','pipe'],
        detached:process.platform!=='win32',env:generationEnvironment(),shell:false});
    let stdout='',stderr='',finished=false;
    const stop=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const finish=(result,peakRssBytes=null)=>{
      if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      stop();rmSync(output,{force:true});resolveRun({result,durationMs:performance.now()-start,peakRssBytes});
    };
    const cancel=()=>finish({status:'cancelled',reason:'Campaign cancelled during generation'});
    const timer=setTimeout(()=>finish({status:'worker_timeout',reason:'Generation process exceeded '+timeoutMs+' ms'}),timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    child.once('error',error=>finish({status:'worker_failure',reason:String(error.message)}));
    child.stdin.on('error',error=>{if(!finished)finish({status:'worker_failure',reason:String(error.message)});});
    child.stdout.on('data',bytes=>{stdout+=bytes.toString();if(Buffer.byteLength(stdout)>8192)
      finish({status:'worker_output_limit',reason:'Worker protocol exceeded 8192 bytes'});});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-8192);});
    child.once('close',(code,exitSignal)=>{
      if(finished)return;
      try{
        if(code!==0)throw new Error('Worker exited '+(exitSignal??code)+(stderr?': '+stderr:''));
        if(statSync(output).size>maxOutputBytes)
          return finish({status:'worker_output_limit',reason:'Generated evidence exceeded '+maxOutputBytes+' bytes'});
        const result=JSON.parse(readFileSync(output,'utf8')),metadata=JSON.parse(stdout);
        if(typeof result.status!=='string'||!Number.isFinite(metadata.peakRssBytes))throw new Error('Invalid worker protocol');
        finish(result,metadata.peakRssBytes);
      }catch(error){finish({status:'worker_failure',reason:String(error.message)});}
    });
    child.stdin.end(serialize({task,output,maxOutputBytes}));
  });
}
