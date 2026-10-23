#!/usr/bin/env node
// Explicitly opt-in reference-oracle check against original pinned JS modules.
// Run only in an externally isolated, network-disabled worker for untrusted code.
import {readFileSync,realpathSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve,relative,dirname,sep,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateBinding,contractArguments,assessReferenceResult,structuredReferenceWarning}
 from '../src/corpus/structured-reference.mjs';
const argv=process.argv.slice(2);
const arg=name=>{const i=argv.indexOf('--'+name);return i<0?null:argv[i+1];};
if(!argv.includes('--trusted-execution'))
 throw new Error('Require explicit --trusted-execution; Node processes are not a sandbox');
for(const name of ['binding','input','inputs-root','implementation-root','output','report'])
 if(!arg(name)||arg(name).startsWith('--'))throw new Error('Require --'+name);
const max=Number(arg('max')??100),timeoutMs=Number(arg('timeout-ms')??500);
if(!Number.isSafeInteger(max)||max<1||max>10000||
   !Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>5000)
 throw new Error('Invalid bounded reference execution settings');
const binding=validateBinding(JSON.parse(readFileSync(resolve(arg('binding')),'utf8')));
const inputRoot=realpathSync(resolve(arg('inputs-root')));
const implementationRoot=realpathSync(resolve(arg('implementation-root')));
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:10000}).trim();
for(const [root,expected] of [[inputRoot,binding.inputRevision],
 [implementationRoot,binding.implementation.revision]]){
 if(git(root,'rev-parse','HEAD')!==expected)throw new Error('Pinned checkout revision mismatch');
 if(git(root,'status','--porcelain','--untracked-files=no'))
  throw new Error('Tracked checkout is dirty');
}
const inside=(root,path)=>{
 const full=realpathSync(join(root,path));
 const rel=relative(root,full);
 if(rel==='..'||rel.startsWith('..'+sep)||rel.startsWith(sep)||!statSync(full).isFile())
  throw new Error('Source escapes pinned checkout or is not a file');
 return full;
};
const impl=inside(implementationRoot,binding.implementation.file);
const sha256=s=>createHash('sha256').update(s).digest('hex');
if(sha256(readFileSync(impl))!==binding.implementation.sha256)
 throw new Error('Implementation content SHA-256 mismatch');
const inputs=new Map(),seen=new Set(),rows=[],counts={};
const worker=fileURLToPath(new URL('./structured-reference-worker.mjs',import.meta.url));
for await(const line of createInterface({input:createReadStream(resolve(arg('input'))),
 crlfDelay:Infinity})){
 if(!line.trim())continue;
 if(rows.length>=max)break;
 const record=JSON.parse(line);
 if(typeof record.id!=='string'||seen.has(record.id))throw new Error('Duplicate/missing input identity');
 seen.add(record.id);
 const contract=contractArguments(record,binding);
 let result=contract;
 if(contract.status==='ready'){
  const sourcePath=record.provenance.path;
  if(!inputs.has(sourcePath)){
   const source=readFileSync(inside(inputRoot,sourcePath));
   inputs.set(sourcePath,sha256(source));
  }
  if(inputs.get(sourcePath)!==record.provenance.sha256)
   throw new Error('Input source SHA-256 mismatch: '+sourcePath);
  const child=spawnSync(process.execPath,['--max-old-space-size=96','--no-addons',worker],
   {input:JSON.stringify({file:impl,entry:binding.implementation.entry,args:contract.args}),
    encoding:'utf8',timeout:timeoutMs,maxBuffer:1024*1024,
    env:Object.fromEntries(Object.entries(process.env).filter(([k])=>
      !/^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_REPL_HISTORY)$/.test(k)))});
  if(child.error||child.status!==0)
   result={status:'unsupported',reason:child.error?.code==='ETIMEDOUT'?
     'Worker deadline exceeded':'Worker process failed'};
  else {
   let observed;
   try{observed=JSON.parse(child.stdout.trim());}catch{
    observed={status:'invalid'};
   }
   result=assessReferenceResult(binding,contract.expected,observed);
  }
 }
 counts[result.status]=(counts[result.status]??0)+1;
 rows.push({schema:'structured-reference-row/1',id:record.id,
  repository:record.provenance?.repository??null,path:record.provenance?.path??null,
  sourceSha256:record.provenance?.sha256??null,implementationSha256:binding.implementation.sha256,
  authority:'native-v8-diagnostic-only',verifiedOwned:false,admitted:false,
  status:result.status,reason:result.reason,...(result.resultHash?{resultHash:result.resultHash}:{})});
}
if(rows.length===0)throw new Error('No structured contract rows found');
const report={schema:'structured-reference-report/1',binding,attempted:rows.length,
 counts,verifiedOwned:0,admitted:0,max,timeoutMs,warning:structuredReferenceWarning};
mkdirSync(dirname(resolve(arg('output'))),{recursive:true});
mkdirSync(dirname(resolve(arg('report'))),{recursive:true});
writeFileSync(resolve(arg('output')),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
writeFileSync(resolve(arg('report')),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({attempted:rows.length,counts,verifiedOwned:0,admitted:0}));
