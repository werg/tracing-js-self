#!/usr/bin/env node
import {readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createTest262CampaignAggregation} from '../src/conformance/test262-aggregate.js';
import {readTest262Json,writeTest262Json} from '../src/conformance/test262-campaign.js';

const flags=new Map();
for(let index=2;index<process.argv.length;index++){
  const key=process.argv[index],value=process.argv[++index];
  if(!['--catalog','--directory','--shard-count','--out'].includes(key)||flags.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Require --catalog FILE --directory DIR --shard-count COUNT --out FILE');
  flags.set(key,value);
}
if(['--catalog','--directory','--shard-count','--out'].some(key=>!flags.has(key)))
  throw new TypeError('Require --catalog FILE --directory DIR --shard-count COUNT --out FILE');
const loaded=readTest262Json(flags.get('--catalog'));
const aggregation=createTest262CampaignAggregation({baseCatalog:loaded.catalog??loaded,
  shardCount:Number(flags.get('--shard-count'))});
const directory=resolve(flags.get('--directory'));
const paths=[];
function collect(root){
  for(const entry of readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(root,entry.name);
    if(entry.isDirectory())collect(path);
    else if(entry.isFile()&&/^report\.json(?:\.gz)?$/.test(entry.name))paths.push(path);
  }
}
collect(directory);
// Retain only the selected-row accounting between parts, not every full
// population report in memory at once.
for(const path of paths){
  const digest=createHash('sha256').update(readFileSync(path)).digest('hex');
  aggregation.add(readTest262Json(path),{source:{path:path.slice(directory.length+1),sha256:digest}});
}
const result=aggregation.finish();
writeTest262Json(flags.get('--out'),result);
console.log(JSON.stringify({output:resolve(flags.get('--out')),catalogVariants:result.catalogVariants,
  observedVariants:result.observedVariants,allShardsPresent:result.allShardsPresent,
  requestedWorkFinished:result.requestedWorkFinished,missingShards:result.missingShards,stages:result.stages,
  claims:result.claims}));
