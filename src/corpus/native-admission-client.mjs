import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,rmSync,mkdirSync,statSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {atomicWrite} from './campaign-store.mjs';
import {generationEnvironment} from './generation-process.mjs';

export function loadNativeSettings({megatoken,tokenizer,python='python3',policyFile,
    timeoutMs=120000,maxOutputBytes=268435456,temporaryDirectory}={}){
  if(!megatoken&&!tokenizer&&!policyFile)return null;
  if(!megatoken||!tokenizer||!policyFile)throw new Error('Native generation requires --megatoken, --tokenizer and --native-policy');
  const policy=JSON.parse(readFileSync(resolve(policyFile),'utf8'));
  if(!/^[a-f0-9]{40}$/.test(policy.consumerRevision??'')||
    !/^[a-f0-9]{64}$/.test(policy.tokenizerSha256??'')||
    typeof policy.tokenizerIdentity!=='string'||!policy.tokenizerIdentity)
    throw new Error('Native policy must declare exact consumerRevision, tokenizerIdentity and tokenizerSha256');
  const revision=execFileSync('git',['-C',resolve(megatoken),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const changes=execFileSync('git',['-C',resolve(megatoken),'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();
  if(changes)throw new Error('Native consumer checkout has uncommitted tracked changes');
  const tokenizerHash=createHash('sha256').update(readFileSync(resolve(tokenizer))).digest('hex');
  if(policy.consumerRevision!==revision||policy.tokenizerSha256!==tokenizerHash)
    throw new Error('Native checkout or tokenizer bytes disagree with release policy');
  const installed=JSON.parse(execFileSync(python,['-c',
    'import json,pathlib,megatoken; print(json.dumps({"moduleFile":str(pathlib.Path(megatoken.__file__).resolve())}))'],
    {encoding:'utf8',timeout:30000,maxBuffer:65536,env:generationEnvironment()}));
  const relativeModule=relative(realpathSync(resolve(megatoken)),realpathSync(installed.moduleFile));
  if(!relativeModule||relativeModule==='..'||relativeModule.startsWith('..'+(process.platform==='win32'?'\\':'/'))||
    isAbsolute(relativeModule))throw new Error('Selected Python imports megatoken outside the pinned consumer checkout');
  return {megatoken:resolve(megatoken),tokenizer:resolve(tokenizer),python,policy,timeoutMs,maxOutputBytes,
    temporaryDirectory:resolve(temporaryDirectory)};
}
export function createNativeConsumer(settings){
  if(!settings)return null;
  return async exported=>{
    const directory=settings.temporaryDirectory;mkdirSync(directory,{recursive:true});
    const input=join(directory,'native-'+randomUUID()+'.json'),receipt=input+'.receipt';
    atomicWrite(input,JSON.stringify(exported)+'\n');
    try{
      await new Promise((resolveRun,reject)=>{
        const child=spawn(settings.python,[resolve(settings.megatoken,'scripts/admit_semantic_harness.py'),
          '--input',input,'--output',receipt,'--tokenizer-json',settings.tokenizer],
        {stdio:['ignore','pipe','pipe'],shell:false,env:generationEnvironment()});
        let error='',bytes=0,done=false;
        const finish=problem=>{if(done)return;done=true;clearTimeout(timer);
          if(problem){child.kill('SIGKILL');reject(problem);}else resolveRun();};
        const timer=setTimeout(()=>finish(new Error('Native consumer deadline exceeded')),settings.timeoutMs);
        child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>settings.maxOutputBytes)
          finish(new Error('Native consumer output bound exceeded'));});
        child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(-8192);});
        child.once('error',finish);child.once('close',code=>finish(code===0?null:new Error(error||'Native admission failed')));
      });
      if(statSync(receipt).size>settings.maxOutputBytes)throw new Error('Native receipt exceeds output bound');
      return JSON.parse(readFileSync(receipt,'utf8'));
    }finally{rmSync(input,{force:true});rmSync(receipt,{force:true});}
  };
}
