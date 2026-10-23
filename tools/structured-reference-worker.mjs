#!/usr/bin/env node
// Single-use native execution worker. NOT a sandbox for untrusted packages.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const reply=x=>process.stdout.write(JSON.stringify({schema:'structured-reference-worker/1',...x})+'\n');
try{
 const request=JSON.parse(readFileSync(0,'utf8'));
 if(typeof request?.file!=='string'||typeof request.entry!=='string'||
    !Array.isArray(request.args))
   throw new Error('Invalid worker request');
 const module=await import(pathToFileURL(request.file).href);
 const entry=module[request.entry];
 if(typeof entry!=='function')throw new Error('Pinned module export is not a function');
 const value=await entry(...request.args);
 // Refuse non-JSON/exotic output; no coercion of undefined, NaN or cycles.
 const json=JSON.stringify(value,(_k,v)=>{
  if(typeof v==='bigint'||typeof v==='function'||typeof v==='symbol'||
     typeof v==='number'&&!Number.isFinite(v))
    throw new Error('Non-JSON reference result');
  return v;
 });
 if(typeof json!=='string')throw new Error('Undefined reference result');
 reply({status:'returned',value:JSON.parse(json)});
}catch(error){
 reply({status:'threw',reason:String(error?.message??error).slice(0,200)});
}
