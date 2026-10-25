#!/usr/bin/env node
// No expected outcomes, private teacher or native guest execution in this process.
import {readFileSync} from 'node:fs';
import {evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {createMegatokenProcessSelector} from '../src/training/megatoken-process.js';
const flags=new Map();for(let i=2;i<process.argv.length;i+=2)flags.set(process.argv[i],process.argv[i+1]);
const origin=flags.get('--origin')??'controlled';
const deadline=(flag,fallback,maximum)=>{
  const value=flags.has(flag)?Number(flags.get(flag)):fallback;
  if(!Number.isSafeInteger(value)||value<1||value>maximum)throw new TypeError('Invalid '+flag);
  return value;
};
const timeoutMs=deadline('--timeout-ms',15000,300000),
  cleanupTimeoutMs=deadline('--cleanup-timeout-ms',1000,30000);
const envelope=JSON.parse(readFileSync(0,'utf8'));
const orchestration=envelope.request?.schema==='selected-orchestration-evaluation-case/4';
const select=origin==='controlled'&&!orchestration?null:createMegatokenProcessSelector({
  command:flags.get('--model-command'),args:JSON.parse(flags.get('--model-args')??'[]'),
  cwd:flags.get('--model-cwd'),timeoutMs:30000,representation:envelope.representation});
try{
  const result=await evaluateSelectedCase(envelope,{origin,select,
    checkpointIdentity:flags.get('--checkpoint-identity')??null,timeoutMs,cleanupTimeoutMs});
  process.stdout.write(JSON.stringify(result)+'\n');
}finally{select?.close();}
