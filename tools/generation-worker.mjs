#!/usr/bin/env node
// Internal process worker. Inputs are trusted authored/pinned candidates only;
// process bounds and environment scrubbing do not make Node vm a sandbox.
import {deserialize} from 'node:v8';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {createNativeConsumer} from '../src/corpus/native-admission-client.mjs';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {verifyEffectfulSession} from '../src/training/effectful-session.js';

const chunks=[];let inputBytes=0;
for await(const chunk of process.stdin){inputBytes+=chunk.length;
  if(inputBytes>33554432)throw new RangeError('Generation worker input bound exceeded');chunks.push(chunk);}
const {task,output,maxOutputBytes}=deserialize(Buffer.concat(chunks));
let result;
try{
  const nativeConsumer=createNativeConsumer(task.native),options={...task.fixture,
    producerRevision:task.producerRevision,nativeConsumer,nativePolicy:task.native?.policy??null,
    taskId:task.fixture.id};
  if(task.kind==='source')result=await verifyEffectfulTrainingCase(options);
  else if(task.kind==='session')result=await verifyEffectfulSession(options);
  else throw new Error('Unknown generation task kind');
}catch(error){result={status:'collection_failed',reason:String(error.message??error)};}
let bytes=Buffer.from(JSON.stringify(result)+'\n');
if(bytes.length>maxOutputBytes)bytes=Buffer.from(JSON.stringify({status:'worker_output_limit',
  reason:'Generated evidence exceeded '+maxOutputBytes+' bytes'})+'\n');
atomicWrite(output,bytes);
process.stdout.write(JSON.stringify({peakRssBytes:process.resourceUsage().maxRSS*1024})+'\n');
