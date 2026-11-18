#!/usr/bin/env node
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {minimizeFailureRecord} from '../src/training/minimize-failure.js';

const [input,output,...args]=process.argv.slice(2),options={};
if(!input||!output)throw new TypeError('Usage: minimize-admission-failure.mjs FAILURE.json[.gz] OUTPUT.json [--max-attempts N] [--timeout-ms N]');
for(let i=0;i<args.length;i+=2){
  if(!['--max-attempts','--timeout-ms'].includes(args[i])||args[i+1]===undefined)
    throw new TypeError('Unknown or incomplete minimization option');
  options[args[i]==='--max-attempts'?'maxAttempts':'maxTimeMs']=Number(args[i+1]);
}
const bytes=readFileSync(input),item=JSON.parse((input.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8'));
const result=await minimizeFailureRecord(item.failure??item,options),target=resolve(output);
mkdirSync(dirname(target),{recursive:true});
const temporary=target+'.tmp-'+process.pid;
writeFileSync(temporary,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
renameSync(temporary,target);
process.stdout.write(JSON.stringify({path:target,failureDigest:result.failureDigest,
  status:result.minimization.status,attempts:result.minimization.attempts,
  originalBytes:Buffer.byteLength(result.original.source),
  reducedBytes:result.minimization.counterexample?Buffer.byteLength(result.minimization.counterexample.source):null})+'\n');
