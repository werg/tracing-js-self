import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root=process.argv[2];
const output=process.argv[3];
const {verifyEffectfulTrainingCase,recheckEffectfulAdmission}=await import(pathToFileURL(root+'/src/training/effectful-admit.js'));
const {decodeWitness}=await import(pathToFileURL(root+'/src/training/format.js'));
const rows=[];
for(const name of ['keyFn','_key','key_fn','keyFn_2','$key','key$Fn','$','éclair']){
  const source='"use strict";function run('+name+'){const read=()=>'+name+';'+name+'='+name+'+1;return read();}';
  const result=await verifyEffectfulTrainingCase({source,entry:'run',args:[2],fixture:{calls:[]},family:'received-main-capture-name-'+rows.length});
  assert.equal(result.status,'locally_verified',JSON.stringify({name,status:result.status,reason:result.reason}));
  const checked=await recheckEffectfulAdmission(JSON.parse(JSON.stringify(result.exported)),{requireAdmitted:false});
  assert.equal(checked.sourceValidated,true);
  const captures=result.exported.public.timeline.filter(row=>row.kind==='semantic')
    .map(row=>decodeWitness(row.line)).filter(row=>row.kind==='allocate'&&row.fields.kind==='closure')
    .flatMap(row=>row.fields.captures);
  assert(captures.some(row=>row.binding===name),JSON.stringify({name,captures}));
  rows.push({name,source,sourceSha256:createHash('sha256').update(source).digest('hex'),status:result.status,sourceValidated:true,captures});
}
const receipt={schema:'received-main-capture-name-smoke/1',producerRevision:'53180e0b0dfbf6c9544b680f854a442db53bb0ab',node:process.version,attempted:rows.length,locallyVerified:rows.length,nativeAdmissionClaim:false,rows};
await writeFile(output,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({producerRevision:receipt.producerRevision,attempted:receipt.attempted,locallyVerified:receipt.locallyVerified,nativeAdmissionClaim:false}));
