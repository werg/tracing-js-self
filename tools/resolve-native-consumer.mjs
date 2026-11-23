#!/usr/bin/env node
// Select current development code once, then retain an exact policy for the run.
import {spawnSync} from 'node:child_process';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const revisionPattern=/^[a-f0-9]{40}$/;
export function remoteRevision(repository,ref){
  const result=spawnSync('git',['ls-remote','--exit-code','https://github.com/'+repository+'.git',ref],
    {encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  if(result.status===2&&!result.error)return null;
  if(result.error||result.status!==0)throw new Error('Cannot resolve paired repository: '+
    (result.error?.message||result.stderr.trim()||'git exited '+result.status));
  const rows=result.stdout.trim().split('\n').map(line=>line.split(/\s+/));
  if(rows.length!==1||rows[0][1]!==ref||!revisionPattern.test(rows[0][0]))
    throw new Error('Paired repository did not return one exact revision for '+ref);
  return rows[0][0];
}
function branchRef(branch){
  if(typeof branch!=='string'||!branch||branch.includes('\n')||branch.includes('\r')||
    spawnSync('git',['check-ref-format','refs/heads/'+branch]).status!==0)
    throw new TypeError('Invalid paired branch name');
  return 'refs/heads/'+branch;
}
export function resolveNativeConsumerPolicy(declared,{explicitRef,branch,lookup=remoteRevision}={}){
  if(declared?.schema!=='semantic-native-policy/8'||declared.consumerRepository!=='werg/megatoken')
    throw new TypeError('Expected the current independent native consumer policy');
  let revision,ref,selection;
  if(Object.hasOwn(declared,'consumerRevision')){
    if(!revisionPattern.test(declared.consumerRevision))throw new TypeError('Invalid recorded consumer revision');
    if(explicitRef&&explicitRef!==declared.consumerRevision)
      throw new Error('An explicit ref cannot override a recorded consumer revision');
    revision=ref=declared.consumerRevision;selection='recorded-revision';
  }else if(explicitRef){
    ref=revisionPattern.test(explicitRef)?explicitRef:branchRef(explicitRef);
    revision=revisionPattern.test(explicitRef)?explicitRef:lookup(declared.consumerRepository,ref);
    if(!revision)throw new Error('Explicit paired branch does not exist: '+explicitRef);
    selection='explicit-ref';
  }else{
    if(branch){ref=branchRef(branch);revision=lookup(declared.consumerRepository,ref);}
    if(revision)selection='matching-branch';
    else{ref='HEAD';revision=lookup(declared.consumerRepository,ref);selection='default-head';}
  }
  if(!revisionPattern.test(revision??''))throw new Error('Paired repository has no exact observed revision');
  return {policy:{...declared,consumerRevision:revision},selection:{repository:declared.consumerRepository,
    requestedBranch:branch??null,ref,revision,kind:selection}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),flags=new Map();
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!['--policy','--out'].includes(key)||flags.has(key)||!value||value.startsWith('--'))
      throw new Error('Usage: node tools/resolve-native-consumer.mjs --out FILE [--policy FILE]');
    flags.set(key,value);
  }
  if(!flags.has('--out'))throw new Error('A new per-run policy output path is required');
  const input=resolve(flags.get('--policy')??'contracts/semantic-native-policy-v8.json'),
    output=resolve(flags.get('--out'));
  if(input===output||/[\r\n]/.test(output))throw new Error('Run policy must be separate from the development policy');
  const bytes=readFileSync(input),result=resolveNativeConsumerPolicy(JSON.parse(bytes),{
    explicitRef:process.env.MEGATOKEN_REF,branch:process.env.GITHUB_HEAD_REF||process.env.GITHUB_REF_NAME});
  writeFileSync(output,JSON.stringify(result.policy,null,2)+'\n',{flag:'wx'});
  writeFileSync(output+'.resolution.json',JSON.stringify({schema:'semantic-native-resolution/1',
    ...result.selection,declaredPolicySha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n',{flag:'wx'});
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,
    'consumer='+result.policy.consumerRevision+'\npolicy='+output+'\n');
  console.log(JSON.stringify(result.selection));
}
