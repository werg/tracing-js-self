#!/usr/bin/env node
// plan, run, merge, compare: one frozen registry and candidate inventory.
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {canonicalHash} from '../src/corpus/source-registry.mjs';
import {generationIdentity} from '../src/corpus/campaign-identity.mjs';
import {trainingCandidateTasks} from '../src/corpus/training-candidates.mjs';
import {buildGenerationShardPlan,runGenerationShard,readGenerationShardReceipt,
  mergeGenerationShardReceipts,compareGenerationShardEquivalence} from '../src/corpus/generation-shards.mjs';

const operation=process.argv[2],options=new Map();
const booleans=new Set(['--resume','--retry-failures']);
const accepted=new Set(['--out','--registry','--recipe','--shards','--limit','--plan','--index','--directory','--single','--sharded']);
for(let index=3;index<process.argv.length;index++){
  const key=process.argv[index];if(options.has(key))throw Error('Repeated option '+key);
  if(booleans.has(key)){options.set(key,true);continue;}
  if(!accepted.has(key)||!process.argv[index+1]||process.argv[index+1].startsWith('--'))throw Error('Invalid option '+key);
  options.set(key,process.argv[++index]);
}
const need=key=>{if(!options.has(key))throw Error(key+' is required');return options.get(key);};
const read=path=>JSON.parse(readFileSync(resolve(path),'utf8'));
const root=fileURLToPath(new URL('..',import.meta.url));
const currentIdentity=plan=>generationIdentity(root,{producerRevision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  recipe:plan.identity.recipe,bounds:plan.identity.bounds,registryDigest:plan.registryDigest});
let result;
if(operation==='plan'){
  const registry=read(need('--registry')),recipe=options.get('--recipe')??'engineering';
  const limit=Number(options.get('--limit')??10000);
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('--limit must be 1..10000');
  const identity=generationIdentity(root,{producerRevision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    recipe,bounds:{memoryMb:768,timeoutMs:120000,maxOutputBytes:268435456},registryDigest:canonicalHash(registry)});
  result=buildGenerationShardPlan({tasks:trainingCandidateTasks(recipe,{root}).slice(0,limit),registry,identity,
    shardCount:Number(options.get('--shards')??1)});
}else if(operation==='run'){
  const plan=read(need('--plan'));
  if(plan.identity.nativePolicy)throw Error('This CLI supports local source qualification only; use the API with the pinned native configuration');
  const abort=new AbortController();
  const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{result=await runGenerationShard({plan,index:Number(need('--index')),directory:resolve(need('--directory')),
    currentIdentity:currentIdentity(plan),resume:options.has('--resume'),retryFailures:options.has('--retry-failures'),signal:abort.signal});}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  if(!result.complete)process.exitCode=2;
}else if(operation==='merge'){
  const plan=read(need('--plan')),directory=resolve(need('--directory'));
  const receipts=Array.from({length:plan.shardCount},(_,index)=>readGenerationShardReceipt({plan,index,
    directory:join(directory,'shard-'+index)}));
  result=mergeGenerationShardReceipts(plan,receipts);
}else if(operation==='compare'){
  result=compareGenerationShardEquivalence(read(need('--single')),read(need('--sharded')));
  if(result.status!=='agreed')process.exitCode=1;
}else throw Error('Usage: generation-shards.mjs plan|run|merge|compare [options]');
atomicWrite(resolve(need('--out')),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({operation,schema:result.schema,digest:result.digest??result.semanticDigest??null,
  candidates:result.candidates?.length??result.candidates??result.rows?.length??null,
  complete:result.complete??null,status:result.status??null}));
