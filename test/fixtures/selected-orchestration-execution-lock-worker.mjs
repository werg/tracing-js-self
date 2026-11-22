#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DurableSelectedOrchestrationExecutionLock} from '../../src/storage/selected-orchestration-execution-lock.js';

const [directory,sessionId,streamId,mode='hold',flockPath='/usr/bin/flock']=process.argv.slice(2);
try{
 if(mode==='inherited-holder'){
  process.stdout.write('inherited\n');
  for await(const chunk of process.stdin)if(String(chunk).includes('release'))break;
 }else{
  const lock=new DurableSelectedOrchestrationExecutionLock({directory,sessionId,streamId,flockPath});
  const lease=await lock.acquire();
  process.stdout.write('acquired\n');
  if(mode==='hold'){
   for await(const chunk of process.stdin){
    if(String(chunk).includes('release')){
     await lease.release();process.stdout.write('released\n');break;
    }
   }
  }else if(mode==='crash'){
   setInterval(()=>{},1000);
  }else if(mode==='inherit'){
   const child=spawn(process.execPath,[fileURLToPath(new URL(import.meta.url)),directory,
     sessionId,streamId,'inherited-holder'],{
       stdio:['pipe','pipe','pipe',lease.fileDescriptor],shell:false});
   let nativeReady=false;
   child.stdout.on('data',chunk=>{
    if(!nativeReady&&String(chunk).includes('inherited')){
     nativeReady=true;process.stdout.write('native-held\n');
    }
   });
   for await(const chunk of process.stdin){
    const command=String(chunk);
    if(command.includes('release-parent')){
     await lease.release();process.stdout.write('parent-released\n');
    }
    if(command.includes('release-child'))child.stdin.write('release\n');
    if(command.includes('release-child'))break;
   }
   await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
   process.stdout.write('child-exited\n');
  }else{
   await lease.release();process.stdout.write('released\n');
  }
 }
}catch(error){
 process.stderr.write(String(error.message)+'\n');process.exitCode=3;
}
