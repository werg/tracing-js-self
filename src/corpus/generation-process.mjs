import {spawn} from 'node:child_process';
import {serialize} from 'node:v8';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeNativeGraph,decodeOwnedGraph} from '../host/graph-codec.js';
import {canonicalFixturePlan} from '../training/fixture-broker.js';

const worker=fileURLToPath(new URL('../../tools/generation-worker.mjs',import.meta.url));
// Guest aliases are explicit graph IDs by this point. Shared registry metadata
// and reused scalar tags instead have structural JSON identity: copying those
// references must not change a durable candidate's authenticated digest.
function fixtureJsonTree(value,ancestors=new Set()){
  if(value===null||['string','boolean'].includes(typeof value))return value;
  if(typeof value==='number'&&Number.isFinite(value)&&!Object.is(value,-0))return value;
  if(typeof value!=='object'||ancestors.has(value)||
    !Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    throw new TypeError('Generation fixture metadata must be acyclic JSON data; encode guest values as graphs');
  ancestors.add(value);
  try{
    const keys=Object.keys(value);
    if(Array.isArray(value)&&(keys.length!==value.length||keys.some((key,index)=>key!==String(index))))
      throw new TypeError('Generation fixture metadata arrays must be dense JSON data');
    const entries=keys.map(key=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!Object.hasOwn(descriptor,'value'))
        throw new TypeError('Generation fixture metadata cannot contain accessors');
      return [key,fixtureJsonTree(descriptor.value,ancestors)];
    });
    return Array.isArray(value)?entries.map(([,item])=>item):Object.fromEntries(entries);
  }finally{ancestors.delete(value);}
}
// V8 serialization retains aliases and special numbers but discards null
// prototypes. Use the canonical graph boundary for every semantic value.
export function encodeGenerationTask(task){
  const encodeFixture=fixture=>{
    const {args,cases,...data}=fixture;
    return {...data,argsGraph:encodeNativeGraph(args??[]),
      ...(data.fixture?{fixture:canonicalFixturePlan(data.fixture)}:{}),
      ...(cases?{cases:cases.map(encodeFixture)}:{})};
  };
  return {...task,fixture:fixtureJsonTree(encodeFixture(task.fixture))};
}
export function decodeGenerationTask(task){
  const decodeFixture=fixture=>{
    const {argsGraph,cases,...data}=fixture;
    return {...data,args:decodeOwnedGraph(JSON.stringify(argsGraph)),
      ...(cases?{cases:cases.map(decodeFixture)}:{})};
  };
  return {...task,fixture:decodeFixture(task.fixture)};
}
// Deliberately do not forward credentials or network proxy settings to trusted
// reference workers. This is defense in depth, not an OS security boundary.
export function generationEnvironment(){
  const keys=['PATH','TMPDIR','TEMP','TMP','LANG','LC_ALL','TZ','PYTHONPATH','VIRTUAL_ENV','OMP_NUM_THREADS','MKL_NUM_THREADS','TRACING_REFERENCE_ISOLATION'];
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
  let encodedTask;
  try{encodedTask=encodeGenerationTask(task);}catch(error){
    return {result:{status:'input_unportable',phase:'worker-input',reason:String(error.message)},durationMs:0,peakRssBytes:null};
  }
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
    child.stdin.end(serialize({task:encodedTask,output,maxOutputBytes}));
  });
}
