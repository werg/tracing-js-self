#!/usr/bin/env node
// Requires an externally installed, exact Ajv 8.17.1 package, verified by
// the caller's package-lock/tarball integrity. No generated code is claimed
// to be executed or traced by the owned runtime.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {importers} from '../src/corpus/import-external.mjs';
import {AJV_VERSION,AJV_TARBALL_INTEGRITY,verifyAjvContract}
 from '../src/corpus/ajv-reference.mjs';
import {attemptOwnedAjvGeneratedValidator} from '../src/corpus/ajv-owned.mjs';
const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf('--'+name);
 if(i<0)return null;
 if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing --'+name);
 return args[i+1];};
const root=arg('snapshot-root')??'corpus/extension/snapshots/json-schema';
const ajvRoot=arg('ajv-root');
const output=resolve(arg('output')??'corpus/out/ajv-production-diagnostics.jsonl');
const ownedMax=Number(arg('owned-max')??0);
if(!Number.isSafeInteger(ownedMax)||ownedMax<0||ownedMax>64)
 throw new TypeError('Expected --owned-max in 0..64');
const ownedOutput=resolve(arg('owned-output')??'corpus/out/ajv-owned-attempts.jsonl');
const ownedEpisodes=resolve(arg('owned-episodes')??'corpus/out/ajv-owned-local.jsonl');
const reportPath=resolve(arg('report')??'corpus/out/ajv-production-report.json');
if(!ajvRoot||!args.includes('--trusted-execution'))
 throw new Error('Require --ajv-root and --trusted-execution; native Ajv is not an isolation boundary');
const rootDir=resolve(root);
const lock=JSON.parse(readFileSync(resolve(rootDir,'snapshot.lock.json'),'utf8'));
if(lock.repository!=='json-schema-org/JSON-Schema-Test-Suite'||
 !/^[0-9a-f]{40}$/.test(lock.revision))
 throw new Error('Expected exact pinned JSON Schema suite');
const require=createRequire(resolve(ajvRoot,'validator-entry.cjs'));
const pkg=require('ajv/package.json');
if(pkg.version!==AJV_VERSION)throw new Error('Production Ajv version mismatch');
const Ajv=require('ajv'),Ajv2019=require('ajv/dist/2019'),
 Ajv2020=require('ajv/dist/2020');
const klass=x=>x.default??x;
const constructors={
 draft7:()=>new (klass(Ajv))({strict:false,allErrors:true,code:{source:true}}),
 'draft2019-09':()=>new (klass(Ajv2019))({strict:false,allErrors:true,code:{source:true}}),
 'draft2020-12':()=>new (klass(Ajv2020))({strict:false,allErrors:true,code:{source:true}})
};
const sha256=b=>createHash('sha256').update(b).digest('hex');
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const checked=new Map(),rows=[],counts={},ownedRows=[],localEpisodes=[];
const attemptedGeneratedCodes=new Set();
for await(const record of importers['json-schema'](rootDir,{
 project:'json-schema-org/JSON-Schema-Test-Suite',
 repository:lock.repository,revision:lock.revision,license:'MIT'
})){
 const relative=record.provenance.path;
 if(!Object.hasOwn(lock.files,relative))
  throw new Error('Unpinned original JSON Schema file '+relative);
 if(!checked.has(relative)){
  const bytes=readFileSync(resolve(rootDir,relative));
  if(blob(bytes)!==lock.files[relative]||
   sha256(bytes)!==record.provenance.sha256)
   throw new Error('Tampered original JSON Schema source '+relative);
  checked.set(relative,sha256(bytes));
 }
 if(checked.get(relative)!==record.provenance.sha256)
  throw new Error('Source changed during validator reference run');
 const result=verifyAjvContract(record,constructors);
 rows.push({id:record.id,originalPath:relative,
  originalSha256:record.provenance.sha256,
  originalRevision:lock.revision,
  implementation:{name:'ajv',version:AJV_VERSION,
   integrity:AJV_TARBALL_INTEGRITY},
  ...result});
 counts[result.status]=(counts[result.status]??0)+1;

 // Separate from the native agreement. A candidate must execute the exact
 // generated function through the owned machine and independently recheck
 // its *operations*, not merely reproduce a boolean diagnostic.
 if(ownedRows.length<ownedMax&&result.status==='reference-agreed'&&
    result.generatedCodeSha256&&!attemptedGeneratedCodes.has(result.generatedCodeSha256)){
  attemptedGeneratedCodes.add(result.generatedCodeSha256);
  let attempted;
  try{
   const fresh=constructors[record.program.draft]().compile(record.fixture.schema);
   const freshResult=fresh(structuredClone(record.fixture.data));
   if(freshResult!==result.observedResult)
    attempted={row:{schema:'ajv-generated-owned-attempt/1',
     status:'reference_mismatch',reason:'Repeated production Ajv output changed',
     verifiedOwned:false,admitted:false},exported:null};
   else attempted=attemptOwnedAjvGeneratedValidator({
    validator:fresh,data:record.fixture.data,observedResult:freshResult,
    originalId:record.id,maxSteps:12000});
  }catch(error){
   attempted={row:{schema:'ajv-generated-owned-attempt/1',
    status:'unsupported',reason:String(error.message??error).slice(0,250),
    verifiedOwned:false,admitted:false},exported:null};
  }
  ownedRows.push({id:record.id,originalPath:relative,
   originalSha256:record.provenance.sha256,
   originalRevision:lock.revision,
   implementation:{name:'ajv',version:AJV_VERSION,
    integrity:AJV_TARBALL_INTEGRITY},...attempted.row});
  if(attempted.exported)localEpisodes.push({
   schema:'ajv-owned-local-episode/1',id:record.id,
   generatedCodeSha256:attempted.row.generatedCodeSha256,
   originalRevision:lock.revision,originalSha256:record.provenance.sha256,
   admitted:false,exported:attempted.exported});
 }

}
if(!rows.length)throw new Error('No locked JSON Schema fixtures');
const report={schema:'production-ajv-reference-report/1',
 implementation:{name:'ajv',version:AJV_VERSION,
  integrity:AJV_TARBALL_INTEGRITY},
 inputRevision:lock.revision,inputRepository:lock.repository,
 sourceFilesChecked:checked.size,attempted:rows.length,
 counts,verifiedOwned:0,admitted:0,
 ownedCandidateSummary:{attempted:ownedRows.length,
  locallyVerified:localEpisodes.length,
  refused:ownedRows.length-localEpisodes.length,admitted:0},
 authority:'native-v8-diagnostic-only',
 warning:'These are real Ajv native V8 executions with generated validator code hashes. No independent owned interpreter journal or downstream training admission is asserted.'};
for(const filename of [output,reportPath,...(ownedMax?[ownedOutput,ownedEpisodes]:[])])
 mkdirSync(dirname(filename),{recursive:true});
writeFileSync(output,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
if(ownedMax){
 writeFileSync(ownedOutput,ownedRows.map(x=>JSON.stringify(x)).join('\n')+
  (ownedRows.length?'\n':''));
 writeFileSync(ownedEpisodes,localEpisodes.map(x=>JSON.stringify(x)).join('\n')+
  (localEpisodes.length?'\n':''));
}
console.log(JSON.stringify({attempted:rows.length,counts,
 sourceFilesChecked:checked.size,verifiedOwned:0,admitted:0,
 ownedCandidateSummary:report.ownedCandidateSummary}));
