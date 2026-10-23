#!/usr/bin/env node
// Join all native-V8 Test262 diagnostic shards from exactly one pinned
// acquired catalog. Accounting only: never owned or admitted training data.
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {aggregateNativeReferenceShards} from '../src/corpus/native-reference-shards.mjs';

const argv=process.argv.slice(2);
const arg=name=>{
 const index=argv.indexOf('--'+name);
 if(index<0)return null;
 const value=argv[index+1];
 if(!value||value.startsWith('--'))throw new Error('Missing --'+name);
 return value;
};
const directory=arg('directory'),output=arg('output');
const expectedTotal=arg('expect-enumerated');
if(!directory||!output||!expectedTotal||!/^\d+$/.test(expectedTotal))
 throw new Error('Require --directory, --output, --expect-enumerated');
const root=resolve(directory),shards=[];
for(const item of readdirSync(root,{withFileTypes:true})){
 if(!item.isDirectory()||!/^native-test262-part-\d+$/.test(item.name))continue;
 const dir=join(root,item.name);
 const report=JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));
 const rowsContent=readFileSync(join(dir,'rows.jsonl'),'utf8');
 const rows=rowsContent.split('\n').filter(Boolean).map(line=>JSON.parse(line));
 shards.push({report,rows,rowsContent});
}
const summary=aggregateNativeReferenceShards(shards,{
 expectedTotal:Number(expectedTotal)});
mkdirSync(dirname(resolve(output)),{recursive:true});
writeFileSync(resolve(output),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({attempted:summary.attempted,
 counts:summary.counts,shardCount:summary.shardCount,
 verifiedOwned:0,admitted:0,output:resolve(output)}));
