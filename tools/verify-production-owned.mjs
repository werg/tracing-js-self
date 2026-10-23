#!/usr/bin/env node
// Trusted, already vendored real library functions only: source hashes checked
// before independent owned/V8 execution. No native-only promotions.
import {resolve,dirname} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {verifyPinnedProductionHelpers} from '../src/corpus/production-owned.mjs';
const argv=process.argv.slice(2);
const option=(key,fallback)=>{const i=argv.indexOf('--'+key);
 return i<0?fallback:argv[i+1];};
const reportPath=resolve(option('report','corpus/out/production-helpers-owned.json'));
const localPath=resolve(option('local-episodes','corpus/out/production-helpers-local.jsonl'));
const {report,verified}=verifyPinnedProductionHelpers();
for(const file of [reportPath,localPath])mkdirSync(dirname(file),{recursive:true});
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
writeFileSync(localPath,verified.map(x=>JSON.stringify({
 schema:'owned-production-local-episode/1',id:x.id,admitted:false,
 originalSource:x.provenance,exported:x.exported})).join('\n')+
 (verified.length?'\n':''));
console.log(JSON.stringify({attempted:report.attempted,
 locallyVerified:report.locallyVerified,refused:report.refused,admitted:0}));
