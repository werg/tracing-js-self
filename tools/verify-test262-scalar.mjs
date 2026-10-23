#!/usr/bin/env node
// Execute a bounded Test262 scalar *diagnostic* slice in BOTH the owned script
// profile and an independent native V8 reference with scalar assertions.
// Passing this is NOT semantic-execution/2 training admission: it lacks the
// owned training controller, full official harness, and all JS feature coverage.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {walk} from '../src/corpus/import-external.mjs';
import {scalarTest262Reference} from '../src/corpus/test262-scalar-reference.mjs';
import {executeRuntimeTest262} from '../src/test262-runtime.js';
const argv=process.argv.slice(2);
const arg=(k,v)=>{const i=argv.indexOf('--'+k);return i===-1?v:argv[i+1]};
const root=resolve(arg('root','corpus/extension/snapshots/test262'));
const output=resolve(arg('output','corpus/out/test262-owned-scalar-diagnostics.json'));
const max=Number(arg('max-candidates','200'));
const min=Number(arg('min-agreed','0'));
if(!Number.isSafeInteger(max)||max<1||max>2000||
   !Number.isSafeInteger(min)||min<0||min>max)throw new TypeError('Invalid bounds');
const lock=JSON.parse(readFileSync(resolve('coverage/test262-runtime.lock.json'),'utf8'));
const suiteCommit='d53ebc8b1931d9f1541e43d59650776e4b766248';
if(lock.suiteCommit!==suiteCommit)throw new Error('Unpinned Test262 baseline');
const current=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(current!==suiteCommit)throw new Error('Wrong pinned Test262 checkout');
if(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())
 throw new Error('Modified pinned Test262 source');
const sha=src=>createHash('sha256').update(src).digest('hex');
const gitSha=src=>createHash('sha1').update('blob '+Buffer.byteLength(src)+'\0').update(src).digest('hex');
const primary=new Map(lock.tests.map(x=>[x.path,x]));
const seen=new Set();
const rows=[],counts={};
const count=k=>counts[k]=(counts[k]??0)+1;
function runCase(path,seed=false){
 if(rows.length>=max||seen.has(path))return;
 seen.add(path);
 const source=readFileSync(join(root,path),'utf8');
 const original=primary.get(path);
 if(original&&gitSha(source)!==original.gitBlobSha)
  throw new Error('Altered pinned Test262 fixture '+path);
 const item={path,sourceSha256:sha(source),suiteCommit,admitted:false,
   source:'official-Test262-pinned',mode:'non-strict-script',
   profile:'bounded-scalar-test262/1',seed};
 let owned;
 try{owned=executeRuntimeTest262(source,{url:path,maxSteps:14000,
   expectedAssertions:original?.expectedAssertions??null});}
 catch(error){item.status='owned_exception';item.reason=String(error.message).slice(0,250);}
 if(!item.status){
  if(owned.status!=='passed'){
   item.status='owned_'+owned.status;
   item.reason=String(owned.reason??owned.phase??'').slice(0,250);
  }else{
   const reference=scalarTest262Reference(source,{timeoutMs:300});
   if(reference.status!=='passed'){
     item.status='reference_unsupported';item.reason=reference.reason;
   }else if(reference.assertionCount!==owned.assertionCount){
     item.status='reference_mismatch';item.reason='Assertion count mismatch';
   }else{
     item.status='owned_reference_replay_agreed';
     item.assertions=owned.assertionCount;
     item.trace={...owned.trace};
   }
  }
 }
 rows.push(item);count(item.status);
}
for(const x of lock.tests)runCase(x.path,true);
for await(const full of walk(join(root,'test'))){
 if(rows.length>=max)break;
 const rel=full.slice(root.length+1).split('\\').join('/');
 if(!/^test\/language\/expressions\/(addition|multiplication|division|modulus|exponentiation)\//.test(rel)||
    !rel.endsWith('.js'))continue;
 runCase(rel);
}
const agreed=counts.owned_reference_replay_agreed??0;
const report={schema:'owned-test262-scalar-diagnostics/1',admitted:false,
  suiteCommit,attempted:rows.length,agreed,counts,rows,
  warnings:[
    'These are owned script-level replay and V8 scalar-assertion diagnostics, not training semantic-execution/2.',
    'The independently executed scalar assertion harness is not the complete official Test262 harness.',
    'Strict variants, modules, async, unusual includes and negative-phase tests remain uncovered.',
    'The chosen extra path cohort is bounded and not a representative success rate over Test262.'
  ]};
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({attempted:rows.length,agreed,counts,output}));
if(agreed<min)throw new Error('Insufficient independently checked Test262 scalar passes '+agreed+' < '+min);
