import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,rmSync,mkdirSync,statSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {atomicWrite} from './campaign-store.mjs';
import {generationEnvironment} from './generation-process.mjs';

/** Capture the code actually selected for a run, rather than a release pair.
 * An explicitly supplied revision still constrains that particular observation.
 */
export function captureNativeConsumerRevision(megatoken,expected){
  const root=realpathSync(resolve(megatoken)),env=generationEnvironment();
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',env}).trim();
  const revision=git('rev-parse','HEAD');
  if(!/^[a-f0-9]{40}$/.test(revision)||realpathSync(git('rev-parse','--show-toplevel'))!==root)
    throw new Error('Native consumer must identify one exact repository checkout');
  if(expected!==undefined&&(!/^[a-f0-9]{40}$/.test(expected)||expected!==revision))
    throw new Error('Native checkout disagrees with the recorded consumer revision');
  if(git('status','--porcelain','--untracked-files=no'))
    throw new Error('Native consumer checkout has uncommitted tracked changes');
  // Include ignored code: an untracked package may shadow a tracked module.
  const untracked=git('ls-files','--others','-z','--','src','scripts').split('\0')
    .filter(path=>path&&/\.(?:py|pyc|pyo|so|pyd)$/.test(path)&&!/(?:^|\/)__pycache__\/[^/]+\.pyc$/.test(path));
  if(untracked.length)throw new Error('Native consumer contains untracked importable code: '+untracked.join(', '));
  return revision;
}

export function loadNativeSettings({megatoken,tokenizer,python='python3',policyFile,
    timeoutMs=120000,maxOutputBytes=268435456,temporaryDirectory}={}){
  if(!megatoken&&!tokenizer&&!policyFile)return null;
  if(!megatoken||!tokenizer||!policyFile)throw new Error('Native generation requires --megatoken, --tokenizer and --native-policy');
  const declared=JSON.parse(readFileSync(resolve(policyFile),'utf8'));
  if(Object.hasOwn(declared,'consumerRevision')&&!/^[a-f0-9]{40}$/.test(declared.consumerRevision)||
    !/^[a-f0-9]{64}$/.test(declared.tokenizerSha256??'')||
    typeof declared.tokenizerIdentity!=='string'||!declared.tokenizerIdentity)
    throw new Error('Native policy must declare exact tokenizerIdentity and tokenizerSha256, and a valid optional consumerRevision');
  const revision=captureNativeConsumerRevision(megatoken,declared.consumerRevision);
  const policy={...declared,consumerRevision:revision};
  const tokenizerHash=createHash('sha256').update(readFileSync(resolve(tokenizer))).digest('hex');
  if(policy.tokenizerSha256!==tokenizerHash)
    throw new Error('Native tokenizer bytes disagree with the declared policy');
  const installed=JSON.parse(execFileSync(python,['-c',
    'import json,pathlib,megatoken; print(json.dumps({"moduleFile":str(pathlib.Path(megatoken.__file__).resolve())}))'],
    {encoding:'utf8',timeout:30000,maxBuffer:65536,env:generationEnvironment()}));
  const relativeModule=relative(realpathSync(resolve(megatoken)),realpathSync(installed.moduleFile));
  if(!relativeModule||relativeModule==='..'||relativeModule.startsWith('..'+(process.platform==='win32'?'\\':'/'))||
    isAbsolute(relativeModule))throw new Error('Selected Python imports megatoken outside the pinned consumer checkout');
  return {megatoken:resolve(megatoken),tokenizer:resolve(tokenizer),python,policy,timeoutMs,maxOutputBytes,
    temporaryDirectory:resolve(temporaryDirectory)};
}
export function createNativeConsumer(settings,{script='scripts/admit_semantic_harness.py',extraArguments=[]}={}){
  if(!settings)return null;
  return async exported=>{
    captureNativeConsumerRevision(settings.megatoken,settings.policy.consumerRevision);
    const directory=settings.temporaryDirectory;mkdirSync(directory,{recursive:true});
    const input=join(directory,'native-'+randomUUID()+'.json'),receipt=input+'.receipt';
    atomicWrite(input,JSON.stringify(exported)+'\n');
    try{
      await new Promise((resolveRun,reject)=>{
        const child=spawn(settings.python,[resolve(settings.megatoken,script),
          '--input',input,'--output',receipt,'--tokenizer-json',settings.tokenizer,...extraArguments],
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
      captureNativeConsumerRevision(settings.megatoken,settings.policy.consumerRevision);
      if(statSync(receipt).size>settings.maxOutputBytes)throw new Error('Native receipt exceeds output bound');
      return JSON.parse(readFileSync(receipt,'utf8'));
    }finally{rmSync(input,{force:true});rmSync(receipt,{force:true});}
  };
}
