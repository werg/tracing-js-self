import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRuntime} from '/workspace/scratch/9faed68167fb/async-return-producer/src/runtime.js';
import {compileProtocolSourceV8} from '/workspace/scratch/9faed68167fb/async-return-producer/src/semantic/protocol-source-compiler-v8.js';
import {createAsyncCallSourceAdapterV8} from '/workspace/scratch/9faed68167fb/async-return-producer/src/semantic/protocol-async-call-source-v8.js';
import {createHash} from 'node:crypto';
const source=readFileSync(new URL('./computed-key-case.js',import.meta.url),'utf8');
const sourceSha256=createHash('sha256').update(source).digest('hex');
const host=spawnSync(process.execPath,['-e','const unmodifiedThen=Promise.prototype.then;'+source+
  ';unmodifiedThen.call(run(),value=>process.stdout.write(JSON.stringify(value)))'],
  {encoding:'utf8',timeout:10000});
let adapterDisposition;
try{createAsyncCallSourceAdapterV8({source});adapterDisposition={disposition:'accepted'};}
catch(error){adapterDisposition={disposition:'refused',name:error.name,message:error.message,category:error.category??null};}
let producer;
try{
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});
  runtime.drive();
  const projection=compileProtocolSourceV8(runtime.exportRun());
  producer={disposition:'accepted',outcome:projection.outcome,asyncResolutionKinds:projection.claims
    .filter(row=>row.kind==='protocol'&&row.record.kind.startsWith('async.resolve.')).map(row=>row.record.kind)};
}catch(error){
  producer={disposition:'refused',name:error.name,message:error.message,category:error.category??null,
    stack:String(error.stack??'')};
}
process.stdout.write(JSON.stringify({sourceSha256,host:{status:host.status,signal:host.signal,stdout:host.stdout,
  stderr:host.stderr,error:host.error?String(host.error):null},adapter:adapterDisposition,producer})+'\n');
