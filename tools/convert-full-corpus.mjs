#!/usr/bin/env node
// Exhaustive 1:1 disposition of acquired fixture records. An inventory being
// fully ACCOUNTED FOR is not a fully verified execution corpus. This tool
// explicitly fails if input identity/count evidence is corrupted or incomplete.
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname,resolve} from 'node:path';
import {once} from 'node:events';
import {classifyCorpusCandidate,validateOwnedReport,validateTest262Report}
  from '../src/corpus/full-disposition.mjs';

const argv=process.argv.slice(2);
const arg=k=>{const i=argv.indexOf('--'+k);return i===-1?null:argv[i+1];};
const inputNames=['test262','exercism','json-schema'];
const paths=Object.fromEntries(inputNames.map(k=>[k,arg(k)]));
if(Object.values(paths).some(x=>!x||x.startsWith('--')))throw new Error(
  'Require --test262 --exercism --json-schema acquired full JSONL paths');
const out=resolve(arg('output')??'corpus/out/full-conversion-disposition.jsonl');
const reportPath=resolve(arg('report')??'corpus/out/full-conversion-report.json');
const minExpected=Number(arg('min-inventory')??0);
if(!Number.isSafeInteger(minExpected)||minExpected<0)throw new Error('Invalid inventory floor');
const proofPath=arg('owned-report');
const owned=proofPath?validateOwnedReport(JSON.parse(readFileSync(resolve(proofPath),'utf8'))):new Map();
const test262Path=arg('test262-report');
const test262Evidence=test262Path?validateTest262Report(
  JSON.parse(readFileSync(resolve(test262Path),'utf8'))):new Map();
const totals={schema:'full-corpus-conversion-disposition/1',admitted:0,
  outcome:'all-inputs-accounted-for-not-all-verified',sourceInventories:{},
  statuses:{},families:{},readCount:0,locallyVerified:0,refused:0,
  interpretation:[
    'Every acquired fixture receives exactly one explicit disposition.',
    'Only accepted independent owned evidence is marked owned_locally_verified.',
    'All Test262 and JSON Schema inputs remain explicit refusals until their genuine JS implementations/harness can be owned-executed.',
    'Full accounting is NOT a claim of complete semantic conversion or admission.',
    'No training sidecar is included in the model-visible disposition output.'
  ]};
const seen=new Set(),outputHash=createHash('sha256');
mkdirSync(dirname(out),{recursive:true});mkdirSync(dirname(reportPath),{recursive:true});
const output=createWriteStream(out,{encoding:'utf8'});
try{
 for(const [name,rawPath] of Object.entries(paths)){
  const group={count:0,locallyVerified:0,refused:0,statuses:{},
    inputIdentityHash:null},rolling=createHash('sha256');
  const input=createInterface({input:createReadStream(resolve(rawPath)),crlfDelay:Infinity});
  for await(const line of input){
   if(!line.trim())continue;
   const x=JSON.parse(line);
   if(x.schema!=='external-corpus-fixture/1'||typeof x.provenance?.repository!=='string')
     throw new Error('Invalid acquisition fixture within '+name);
   const type={test262:'test262-program',exercism:'exercise-contract',
     'json-schema':'json-schema-contract'}[name];
   if(x.program?.kind!==type)throw new Error('Wrong source-family attribution in '+name);
   if(seen.has(x.id))throw new Error('Duplicate cross-source fixture identity '+x.id);
   seen.add(x.id);rolling.update(x.id+'\n');
   const result=classifyCorpusCandidate(x,owned,test262Evidence);
   if(!/^refused_|^owned_locally_verified$/.test(result.status))
     throw new Error('Unaccounted disposition '+result.status);
   const row={schema:'full-corpus-row/1',id:x.id,
     repository:x.provenance.repository,revision:x.provenance.revision,
     sourceFile:x.provenance.path,split:x.split,sourceKind:type,
     status:result.status,admitted:false,reason:result.reason,
     ...(result.evidence?{evidence:result.evidence}:{})};
   group.statuses[result.status]=(group.statuses[result.status]??0)+1;
   totals.statuses[result.status]=(totals.statuses[result.status]??0)+1;
   if(result.status==='owned_locally_verified'){
     group.locallyVerified++;totals.locallyVerified++;
   }else{group.refused++;totals.refused++;}
   const bytes=JSON.stringify(row)+'\n';outputHash.update(bytes);
   if(!output.write(bytes))await once(output,'drain');
   group.count++;totals.readCount++;
  }
  group.inputIdentityHash=rolling.digest('hex');
  totals.sourceInventories[name]=group;
 }
 output.end();await once(output,'finish');
}catch(error){output.destroy();throw error;}
if(totals.readCount<minExpected||totals.readCount!==totals.refused+totals.locallyVerified)
 throw new Error('Incomplete conversion ledger');
const successes=totals.sourceInventories.exercism.locallyVerified;
const uniqueOwned=[...owned.values()].filter(x=>x.status==='locally_verified');
totals.ownedEvidence={
  totalRecheckedOwnedInputEpisodes:uniqueOwned.length,
  canonicalCatalogMatched:successes,
  generatedOutsideAcquiredCatalog:uniqueOwned.filter(x=>x.inputOrigin!=='upstream-canonical').length,
  attemptedCanonicalSourceFamilies:new Set(uniqueOwned.map(x=>x.slug)).size
};
if(successes>uniqueOwned.length)throw new Error('Evidence ledger join overcounted');
totals.ownedEvidence.test262TrainingVerified=[...test262Evidence.values()]
  .filter(x=>x.trainingStatus==='locally_verified').length;
totals.status='complete-accounting';
totals.allConverted=totals.refused===0;
totals.dispositionSha256=outputHash.digest('hex');
writeFileSync(reportPath,JSON.stringify(totals,null,2)+'\n');
console.log(JSON.stringify({total:totals.readCount,locallyVerified:totals.locallyVerified,
  refused:totals.refused,bySource:totals.sourceInventories,
  evidence:totals.ownedEvidence,allConverted:totals.allConverted,
  output:out,report:reportPath}));
