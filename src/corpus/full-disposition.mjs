// Strict, exhaustive conversion disposition for every acquired external case.
// This classifier NEVER turns a declaration of expected output into evidence of
// owned execution. In particular, Test262 and JSON Schema catalog entries are
// not executable function+input pairs without their real harness/implementation.
export function classifyCorpusCandidate(candidate,verifiedCanonical=new Map(),verifiedTest262=new Map()){
 if(candidate?.schema!=='external-corpus-fixture/1'||candidate.admitted!==false||
    candidate.verified!==false||typeof candidate.id!=='string'||
    !/^[a-f0-9]{64}$/.test(candidate.id))
   throw new Error('Unrecognized or prematurely admitted external candidate');
 const program=candidate.program??{},fixture=candidate.fixture??{};
 if(program.kind==='test262-program'){
   const checked=verifiedTest262.get(candidate.provenance?.path);
   if(checked?.trainingStatus==='locally_verified'&&program.mode==='sloppy'){
     if(checked.suiteCommit!==candidate.provenance.revision||
        checked.sourceSha256!==candidate.provenance.sha256||
        checked.trainingEvidence?.postSerializationRechecked!==true||
        !(checked.trainingEvidence?.originalSitesMapped>0)||
        checked.trainingEvidence?.originalV8Assertions!==
          checked.trainingEvidence?.functionV8Assertions)
       throw new Error('Forged or stale independent Test262 training evidence');
     return {status:'owned_locally_verified',
       reason:'Narrow scalar Test262 subset passed original script reference, owned script replay, strict wrapper V8 check, independent training-js/1 operations/branches/controller and original-site evidence',
       evidence:{originalSource:checked.path,sourceSiteProfile:'test262-literal-body-sites/1',
         sourceSha256:checked.sourceSha256}};
   }
   if(candidate.status==='metadata-review')
     return {status:'refused_unparsed_metadata',reason:'Test262 metadata not safely interpreted'};
   if(program.mode==='module'||program.mode==='raw')
     return {status:'refused_module_or_raw_execution',
       reason:'Owned script trace and complete Test262 host/module realms unavailable'};
   if(program.flags?.includes('async'))
     return {status:'refused_async_test262',
       reason:'Async $DONE and service-scheduling evidence are unimplemented'};
   if(candidate.expected?.kind==='expected-error')
     return {status:'refused_negative_test262',
       reason:'Expected '+String(candidate.expected.phase)+
         ' error requires phase-accurate reference and owned exceptional evidence'};
   if(program.harness?.some(h=>!['assert.js','sta.js'].includes(h)))
     return {status:'refused_test262_extra_harness',
       reason:'Official Test262 included harness dependencies have no independently checked owned adapter'};
   return {status:'refused_test262_owned_harness',
     reason:'No independent official harness plus owned training-js/1 assertion-to-effect semantics'};
 }
 if(program.kind==='json-schema-contract'){
   return {status:'refused_json_schema_implementation',
     reason:'Schema/data/validity test is not JavaScript source; requires version-matched pinned JS validator, real execution and owned internal tracing'};
 }
 if(program.kind==='exercise-contract'){
   if(fixture.kind!=='canonical-input')
     return {status:'refused_exercise_input','reason':'Unsupported Exercism input shape'};
   const matched=/^exercises\/([^/]+)\/canonical-data\.json$/.exec(candidate.provenance?.path??'');
   if(!matched)return {status:'refused_exercise_path',reason:'Canonical source path not recognized'};
   const caseId=matched[1]+'/'+String(fixture.id);
   const verified=verifiedCanonical.get(caseId);
   if(verified){
     if(verified.status==='locally_verified'){
       if(verified.provenance?.canonical?.sha256!==candidate.provenance.sha256||
          verified.provenance?.canonical?.revision!==candidate.provenance.revision||
          verified.provenance?.canonical?.repository!==candidate.provenance.repository||
          verified.evidence?.postSerialization?.valid!==true||
          verified.evidence?.originalSites?.valid!==true||
          verified.evidence?.reference?.canonical!=='agreed')
         throw new Error('Forged or stale independent owned evidence for '+caseId);
       return {status:'owned_locally_verified',reason:'Independent original JS and owned source/operation/branch/controller/replay checks completed; not training-admitted',
         evidence:{ownedCaseId:caseId,sourceSiteProfile:'mapped-subset-with-explicit-synthetic-sites',
           originalJsRevision:verified.provenance.solution.revision}};
     }
     return {status:'refused_owned_attempt',reason:(verified.status??'unknown')+
       ': '+String(verified.reason??'No supported owned execution evidence').slice(0,200)};
   }
   return {status:'refused_unpaired_exercise',
     reason:'Canonical specification lacks a verified pinned JS implementation and compatible owned execution'};
 }
 return {status:'refused_unknown_kind',reason:'No independently verified owned adapter for program kind '+String(program.kind)};
}
export function validateOwnedReport(report){
 if(report?.schema!=='owned-exercism-evidence/1'||report.admitted!==false||
    !Array.isArray(report.records)||!report.totals||
    report.totals.attempted!==report.records.length)
  throw new Error('Invalid owned evidence ledger');
 const records=new Map();
 for(const item of report.records){
   if(typeof item.caseId!=='string'||records.has(item.caseId))
     throw new Error('Duplicate/missing owned candidate identity');
   records.set(item.caseId,item);
 }
 const verified=report.records.filter(x=>x.status==='locally_verified');
 if(verified.length!==report.totals.locallyVerified||report.totals.newAdmitted!==0||
    verified.some(x=>x.evidence?.postSerialization?.valid!==true||
      x.evidence?.originalSites?.valid!==true||
      (x.inputOrigin==='upstream-canonical'
        ?x.evidence?.reference?.canonical!=='agreed'
        :x.evidence?.reference?.canonical!=='not-applicable-generated')))
  throw new Error('Owned evidence count/rechecks inconsistent');
 return records;
}

export function validateTest262Report(report){
 if(report?.schema!=='owned-test262-scalar-diagnostics/1'||report.admitted!==false||
    !Array.isArray(report.rows)||report.attempted!==report.rows.length)
  throw new Error('Invalid Test262 proof ledger');
 const matches=new Map(),training=report.rows.filter(x=>x.trainingStatus==='locally_verified');
 if(training.length!==report.locallyVerifiedTraining)
   throw new Error('Test262 owned-training count inconsistent');
 for(const row of report.rows){
   if(!row.path||matches.has(row.path))throw new Error('Duplicate Test262 source identity');
   if(row.trainingStatus==='locally_verified' &&
      (row.status!=='owned_reference_replay_agreed'||
       row.trainingEvidence?.postSerializationRechecked!==true||
       !(row.trainingEvidence?.originalSitesMapped>0)))
     throw new Error('Unverified Test262 semantic trace entry');
   matches.set(row.path,row);
 }
 return matches;
}
