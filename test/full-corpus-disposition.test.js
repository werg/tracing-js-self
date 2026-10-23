import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyCorpusCandidate,validateOwnedReport,validateTest262Report}
 from '../src/corpus/full-disposition.mjs';
const fixture=(kind,extra={})=>({
 schema:'external-corpus-fixture/1',admitted:false,verified:false,
 id:'0'.repeat(64),program:{kind,mode:'sloppy',flags:[],harness:['assert.js','sta.js']},
 provenance:{path:kind==='exercise-contract'?
   'exercises/leap/canonical-data.json':'test/a.js',
   repository:'exercism/problem-specifications',revision:'1234567890abcdef1234567890abcdef12345678',sha256:'a'.repeat(64)},
 fixture:{kind:'canonical-input',id:'case1'},...extra
});
test('full-corpus classifier refuses unsupported language and metadata rather than inventing traces',()=>{
 const test262=fixture('test262-program');
 assert.equal(classifyCorpusCandidate(test262).status,'refused_test262_owned_harness');
 assert.equal(classifyCorpusCandidate(fixture('test262-program',{
   expected:{kind:'expected-error',phase:'parse'}})).status,'refused_negative_test262');
 assert.equal(classifyCorpusCandidate(fixture('test262-program',{
   program:{kind:'test262-program',mode:'module'}})).status,'refused_module_or_raw_execution');
 assert.equal(classifyCorpusCandidate(fixture('test262-program',{
   program:{kind:'test262-program',flags:['async'],mode:'sloppy'}})).status,'refused_async_test262');
 assert.equal(classifyCorpusCandidate(fixture('json-schema-contract')).status,'refused_json_schema_implementation');
 assert.equal(classifyCorpusCandidate(fixture('exercise-contract')).status,'refused_unpaired_exercise');
 assert.throws(()=>classifyCorpusCandidate({...test262,admitted:true}),/admitted/);
});
test('claimed owned conversions require exact canonical SHA/revision and independent evidence',()=>{
 const row=fixture('exercise-contract');
 const good={status:'locally_verified',caseId:'leap/case1',
  provenance:{canonical:{repository:row.provenance.repository,
    sha256:row.provenance.sha256,revision:row.provenance.revision},
    solution:{revision:'f'.repeat(40)}},
  evidence:{postSerialization:{valid:true},reference:{canonical:'agreed'},
    originalSites:{valid:true}}};
 const m=new Map([['leap/case1',good]]);
 assert.equal(classifyCorpusCandidate(row,m).status,'owned_locally_verified');
 assert.throws(()=>classifyCorpusCandidate(row,new Map([
  ['leap/case1',{...good,provenance:{canonical:{...good.provenance.canonical,sha256:'x'}}}]])),/Forged or stale/);
 assert.equal(classifyCorpusCandidate(row,new Map([['leap/case1',{
  ...good,status:'profile_limit',reason:'Exceeded cap'}]])).status,'refused_owned_attempt');
 assert.equal(validateOwnedReport({schema:'owned-exercism-evidence/1',admitted:false,
  records:[good],totals:{attempted:1,locallyVerified:1,newAdmitted:0}}).size,1);
 assert.throws(()=>validateOwnedReport({schema:'owned-exercism-evidence/1',
  admitted:false,records:[good,good],totals:{attempted:2,locallyVerified:2,newAdmitted:0}}));
});

test('generated input oracle is valid but never asserted to be official canonical data',()=>{
 const row={status:'locally_verified',caseId:'generated/leap/fake',
   inputOrigin:'exercism-deterministic-boundaries/1',
   evidence:{postSerialization:{valid:true},originalSites:{valid:true},
     reference:{canonical:'not-applicable-generated'}}};
 const report={schema:'owned-exercism-evidence/1',admitted:false,
   records:[row],totals:{attempted:1,locallyVerified:1,newAdmitted:0}};
 assert.equal(validateOwnedReport(report).size,1);
 assert.throws(()=>validateOwnedReport({...report,records:[{
   ...row,evidence:{...row.evidence,reference:{canonical:'agreed'}}}]}));
});

test('Test262 training joins only exact source-hash matched and rechecked modes',()=>{
 const row=fixture('test262-program',{program:{kind:'test262-program',mode:'sloppy',
   flags:[],harness:['assert.js','sta.js']},
  provenance:{repository:'tc39/test262',
   path:'test/language/expressions/addition/x.js',sha256:'c'.repeat(64),
   revision:'d'.repeat(40)}});
 const proven={path:row.provenance.path,sourceSha256:row.provenance.sha256,
   suiteCommit:row.provenance.revision,status:'owned_reference_replay_agreed',
   trainingStatus:'locally_verified',
   trainingEvidence:{postSerializationRechecked:true,originalSitesMapped:3,
     originalV8Assertions:1,functionV8Assertions:1}};
 const report={schema:'owned-test262-scalar-diagnostics/1',admitted:false,
   attempted:1,locallyVerifiedTraining:1,rows:[proven]};
 const m=validateTest262Report(report);
 assert.equal(classifyCorpusCandidate(row,new Map(),m).status,'owned_locally_verified');
 assert.equal(classifyCorpusCandidate({...row,program:{...row.program,mode:'strict'}},
   new Map(),m).status,'refused_test262_owned_harness');
 assert.throws(()=>classifyCorpusCandidate({...row,
   provenance:{...row.provenance,sha256:'b'.repeat(64)}},new Map(),m),/Forged/);
 assert.throws(()=>validateTest262Report({...report,locallyVerifiedTraining:0}));
});
