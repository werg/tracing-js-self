#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {DEFAULT_AGGREGATE_BUDGET,probeAggregateRunner,runAggregateQuotaCommand} from '../src/corpus/aggregate-runner.mjs';

const options=new Map();let command=[];
for(let index=2;index<process.argv.length;index++){
  const option=process.argv[index];
  if(option==='--'){command=process.argv.slice(index+1);break;}
  if(option==='--preflight'){options.set(option,true);continue;}
  if(!['--workspace','--budget','--manager','--receipt'].includes(option)||options.has(option)||
    !process.argv[index+1]||process.argv[index+1].startsWith('--'))throw Error('Invalid option '+option);
  options.set(option,process.argv[++index]);
}
if(!options.has('--workspace'))throw Error('--workspace must name an existing dedicated capped tmpfs mount');
const input={workspace:resolve(options.get('--workspace')),manager:options.get('--manager')??'user',
  budget:options.has('--budget')?JSON.parse(readFileSync(resolve(options.get('--budget')),'utf8')):DEFAULT_AGGREGATE_BUDGET};
let result;
if(options.has('--preflight'))result=probeAggregateRunner(input);
else{
  if(!command.length)throw Error('Supply an executable and arguments after --, or use --preflight');
  const abort=new AbortController(),stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{result=await runAggregateQuotaCommand({...input,command:command[0],args:command.slice(1),signal:abort.signal});}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(options.has('--receipt'))atomicWrite(resolve(options.get('--receipt')),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(!['completed','prerequisites-available'].includes(result.status))process.exitCode=2;
