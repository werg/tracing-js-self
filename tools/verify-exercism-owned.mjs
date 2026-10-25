#!/usr/bin/env node
// Attempt actual owned semantic-execution/4 traces for pinned, real JavaScript
// Exercism reference implementations with independently specified inputs.
// All refusals are retained; source acquisition does NOT imply verification.
// Only declared, SHA-locked, audited upstream snapshots may execute in Node vm.
// Node vm is NOT a security boundary: do NOT point this at untrusted code.
import {resolve,dirname} from 'node:path';
import {mkdirSync,writeFileSync,createWriteStream} from 'node:fs';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {isDeepStrictEqual} from 'node:util';
import ts from 'typescript';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence}
  from '../src/training/source-check.js';
import {loadPinnedPairs,lowerPinnedProof,extractCanonicalCases}
  from '../src/corpus/owned-exercism.mjs';
import {generateInputVariations} from '../src/corpus/variation-exercism.mjs';
import {shrinkReferenceMismatch} from '../src/corpus/reference-shrinker.mjs';
import {buildOwnedSourceMap,auditSourceSites} from '../src/corpus/original-sites.mjs';

const argv=process.argv.slice(2);
const option=(name,fallback)=>argv.includes('--'+name)?argv[argv.indexOf('--'+name)+1]:fallback;
const perFamily=Number(option('per-family','12'));
const maxCases=Number(option('max-cases','1000'));
const mutationsPerFamily=Number(option('mutations-per-family','0'));
const maxGenerated=Number(option('max-generated','256'));
const minOwned=Number(option('min-owned','0'));
const shrinkMismatches=argv.includes('--shrink-reference-mismatches');
if(!Number.isSafeInteger(mutationsPerFamily)||mutationsPerFamily<0||mutationsPerFamily>512 ||
   !Number.isSafeInteger(perFamily)||perFamily<1||perFamily>100 ||
   !Number.isSafeInteger(maxCases)||maxCases<1||maxCases>10000 ||
   !Number.isSafeInteger(maxGenerated)||maxGenerated<1||maxGenerated>2048 ||
   !Number.isSafeInteger(minOwned)||minOwned<0)
  throw new Error('Invalid bounded owned Exercism options');
const output=resolve(option('output','corpus/out/exercism-owned-report.json'));
const episodes=option('local-episodes',null);
const episodePath=episodes?resolve(episodes):null;
const review=option('review',null);
const reviewPath=review?resolve(review):null;
const sha=v=>createHash('sha256').update(v).digest('hex');
const records=[],failureReasons={},byExercise={},features={};
let attempted=0,claimed=0,committed=0;
const report={schema:'owned-exercism-evidence/1',admitted:false,profile:'training-js/1',
  authority:'owned-runtime-plus-independent-V8-scalar-operation-branch-checks',
  options:{perFamily,maxCases,maxGenerated,mutationsPerFamily,shrinkMismatches},
  verification:'Full post-serialization independent recheck for each retained locally verified candidate',
  provenance:'Pinned original Exercism JS reference solutions and canonical problem specifications',
  limitations:[
    'Only curated SHA-locked proof implementations are executed; Node vm is not an isolation boundary.',
    'Static top-level arrow-to-function lowering changes ESM declaration structure; an independent V8 original-source comparison is required for every retained example.',
    'Only synchronous JSON-representable canonical return outcomes and input mutations are checked.',
    'Caught throws, async effects, classes, import effects, RegExp and exotic objects remain explicit refusals.',
    'Compactness counters are diagnostics, not evidence that omitted intermediate effects are safe.',
    'No result is admitted for megatoken training by this local gate.'
  ],records,byExercise,failuresByReason:failureReasons,
  quality:{records:0,generatedRecords:0,generatedBytes:0,originalJournalEvents:0}};
const fail=(record,why,reason)=>{
 record.status=why;record.reason=String(reason).slice(0,400);
 const key=why+': '+record.reason.slice(0,120);
 failureReasons[key]=(failureReasons[key]??0)+1;
};
const cleanJSON=(value)=>{
 const encoded=JSON.stringify(value,(_k,v)=>{
  if(typeof v==='number'&&!Number.isFinite(v))
    throw new TypeError('Nonfinite JSON result refused');
  if(typeof v==='bigint'||typeof v==='function'||typeof v==='symbol')
    throw new TypeError('Non-JSON canonical result refused');
  return v;
 });
 if(typeof encoded!=='string')throw new TypeError('Non-JSON result refused');
 return JSON.parse(encoded);
};
const snap=({result,args})=>cleanJSON({result,args});
function originalScript(source){
 const sf=ts.createSourceFile('proof.ci.js',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
 let last=0,parts=['"use strict";\n'];
 for(const statement of sf.statements){
  for(const m of statement.modifiers??[]){
   if(m.kind!==ts.SyntaxKind.ExportKeyword)continue;
   parts.push(source.slice(last,m.getStart(sf)));last=m.end;
  }
 }
 parts.push(source.slice(last));return parts.join('');
}
function executePure(source,entry,args){
 const cloned=structuredClone(args);
 const result=runInNewContext(source+'\n('+entry+')(...__args);',
   {__args:cloned}, {timeout:800,contextCodeGeneration:{strings:false,wasm:false}});
 if(result&&typeof result.then==='function')
   throw new TypeError('Async result is outside strict owned profile');
 return snap({result,args:cloned});
}
mkdirSync(dirname(output),{recursive:true});
if(episodePath)mkdirSync(dirname(episodePath),{recursive:true});
const stream=episodePath?createWriteStream(episodePath,{encoding:'utf8'}):null;
try{
 for(const pair of loadPinnedPairs()){
  const group=byExercise[pair.slug]={split:pair.split,candidates:0,
    locallyVerified:0,unsupported:0,referenceMismatch:0,projectionFailure:0,
    status:'not-evaluated'};
  const canonical=extractCanonicalCases(pair);
  let lowered=null,original=null,originalSiteMap=null;
  try{
   lowered=lowerPinnedProof(pair.source);
   original=originalScript(pair.source);
   originalSiteMap=buildOwnedSourceMap(pair.source,lowered.source);
   group.status='attempted';
  }catch(error){group.status='source_unsupported';group.sourceReason=String(error.message);}
  const variants=generateInputVariations(pair.slug,canonical,{limit:mutationsPerFamily});
  for(const fixture of [...canonical.slice(0,perFamily),...variants]){
   if(attempted>=maxCases)break;
   attempted++;group.candidates++;
   const item={id:sha(JSON.stringify([pair.provenance,fixture.caseId])),
     schema:'owned-exercism-row/1',admitted:false,slug:pair.slug,
     split:pair.split,caseId:fixture.caseId,property:fixture.property,
     inputOrigin:fixture.generator??'upstream-canonical',
     derivedFrom:fixture.derivedFrom??null,
     provenance:pair.provenance,lowering:lowered?.lowering??null};
   records.push(item);
   if(fixture.status!=='candidate'){fail(item,'fixture_unsupported',fixture.status);continue;}
   if(!lowered){fail(item,'source_unsupported',group.sourceReason);continue;}
   if(!lowered.exported.includes(fixture.entry)){
    fail(item,'fixture_unsupported','Entry absent from original ESM export '+fixture.entry);continue;
   }
   if(fixture.expected&&typeof fixture.expected==='object'&&
      Object.hasOwn(fixture.expected,'error')){
    fail(item,'expected_throw_unsupported','Cannot admit abrupt guest completions');continue;
   }
   if(JSON.stringify(fixture.args).length>2500){
    fail(item,'input_budget','Large canonical input graph');continue;
   }
   try {
    const referenceOriginal=executePure(original,fixture.entry,fixture.args);
    const expected=fixture.generator?referenceOriginal.result:cleanJSON(fixture.expected);
    if(!isDeepStrictEqual(referenceOriginal.result,expected)){
      fail(item,'canonical_mismatch','Original pinned JS solution disagrees with declared exercise expected result');
      group.referenceMismatch++;continue;
    }
    const projection=executePure(lowered.source,fixture.entry,fixture.args);
    if(!isDeepStrictEqual(referenceOriginal,projection)){
      if(shrinkMismatches){
       item.referenceShrink=shrinkReferenceMismatch(fixture.args,candidate=>{
        try{
         const before=executePure(original,fixture.entry,candidate);
         const after=executePure(lowered.source,fixture.entry,candidate);
         return !isDeepStrictEqual(before,after);
        }catch{return false;}
       },{maxEvaluations:24});
      }
      fail(item,'lowering_mismatch','Function-only lowering changed original ESM behavior or arguments');
      group.referenceMismatch++;continue;
    }
    item.reference={canonical:fixture.generator?'not-applicable-generated':'agreed',originalSource:'agreed',
      transformedV8:'agreed',returnHash:sha(JSON.stringify(referenceOriginal))};
   }catch(error){
    fail(item,'reference_failure',error.message);group.referenceMismatch++;continue;
   }
   const lineage={
     source:'exercism/javascript-canonical/1',slug:pair.slug,
     caseId:fixture.caseId,split:pair.split,
     solution:pair.provenance.solution,canonical:pair.provenance.canonical,
     generator:fixture.generator??null,derivedFrom:fixture.derivedFrom??null,
     lowering:lowered.lowering,loweredSha256:sha(lowered.source)};
   let checked;
   try {
     checked=verifyOwnedSourceCase({
       source:lowered.source,entry:fixture.entry,args:structuredClone(fixture.args),
       lineage,maxSteps:12000,maxGenerated
     });
   }catch(error){
     fail(item,'verification_exception',error.message);continue;
   }
   if(checked.status!=='locally_verified'){
     fail(item,checked.status,checked.reason??'No locally verified owned trace');
     if(checked.status==='projection_failure')group.projectionFailure++;
     else group.unsupported++;
     continue;
   }
   const serialized=JSON.parse(JSON.stringify(checked.exported));
   const renewed=recheckOwnedSourceEvidence(serialized);
   if(!renewed.valid){
     fail(item,'independent_recheck_failure',renewed.reason);continue;
   }
   let sourceSites;
   try{
     sourceSites=auditSourceSites(originalSiteMap,serialized.sidecar.semantic,
       pair.source,lowered.source);
   }catch(error){
     fail(item,'source_site_audit_failure',error.message);
     continue;
   }
   const tape=serialized.public.timeline;
   const generated=tape.filter(item=>item.kind==='semantic'&&item.mode==='generated');
   const quality={totalRecords:tape.length,generatedRecords:generated.length,
     generatedBytes:generated.reduce((n,item)=>n+Buffer.byteLength(item.line,'utf8'),0),
     journalEvents:serialized.sidecar.archive.events.length,
     sourceBytes:Buffer.byteLength(lowered.source,'utf8'),
     originalSourceBytes:Buffer.byteLength(pair.source,'utf8'),
     shortPreview:generated.slice(0,12).map(item=>item.line.slice(0,140))};
   item.status='locally_verified';
   item.quality=quality;
   item.evidence={postSerialization:renewed,reference:item.reference,
     originalSites:{valid:sourceSites.valid,totals:sourceSites.totals}};
   group.locallyVerified++;committed++;
   report.quality.records+=quality.totalRecords;
   report.quality.generatedRecords+=quality.generatedRecords;
   report.quality.generatedBytes+=quality.generatedBytes;
   report.quality.originalJournalEvents+=quality.journalEvents;
   if(stream){
     const payload={schema:'owned-exercism-local-episode/1',admitted:false,
       id:item.id,slug:pair.slug,caseId:fixture.caseId,split:pair.split,
       originalSource:pair.provenance.solution,canonicalInput:fixture.args,
       inputOrigin:item.inputOrigin,derivedFrom:item.derivedFrom,
       canonicalExpected:fixture.generator?null:fixture.expected,reference:item.reference,
       quality,sourceSites,exported:serialized};
     if(!stream.write(JSON.stringify(payload)+'\n'))await once(stream,'drain');
   }
  }
  if(attempted>=maxCases)break;
 }
 if(stream){stream.end();await once(stream,'finish');}
} catch(error){if(stream)stream.destroy();throw error;}
report.totals={attempted,locallyVerified:committed,refused:attempted-committed,
  newAdmitted:0,distinctExercises:Object.keys(byExercise).length,
  exercisedProofs:Object.values(byExercise).filter(v=>v.candidates>0).length,
  distinctVerifiedExercises:Object.values(byExercise).filter(v=>v.locallyVerified>0).length};
report.quality.avgGeneratedBytes=committed?
  Math.round(report.quality.generatedBytes/committed):null;
report.quality.avgGeneratedRecords=committed?
  Math.round(100*report.quality.generatedRecords/committed)/100:null;
report.quality.avgJournalEvents=committed?
  Math.round(100*report.quality.originalJournalEvents/committed)/100:null;
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(reviewPath){
 mkdirSync(dirname(reviewPath),{recursive:true});
 const lines=[
  '# Original-source verified owned Exercism JS traces',
  '',
  '**Only locally verified, non-admitted semantic-execution/4 candidates.**',
  'No claim of full JS semantics or minimal/lossless source-level trace compression.',
  '',
  '- Attempted original/canonical and generated candidates: '+report.totals.attempted,
  '- Independently rechecked owned successes: '+report.totals.locallyVerified,
  '- Explicit refusals: '+report.totals.refused,
  '- Distinct successful source families: '+report.totals.distinctVerifiedExercises,
  '- Generated semantic records / original owned journal events: '+
    report.quality.generatedRecords+' / '+report.quality.originalJournalEvents,
  '- Generated semantic record bytes: '+report.quality.generatedBytes,
  '',
  '## Harder verified traces for human review',
  '',
  'These previews are abbreviated; the full candidate public trace and its private',
  'evidence sidecar remain available only in the local JSONL artifact.',
  ''
 ];
 const best=records.filter(x=>x.status==='locally_verified')
   .sort((a,b)=>b.quality.generatedRecords-a.quality.generatedRecords);
 const shown=new Set();
 for(const x of best){
  if(shown.has(x.slug)||shown.size>=12)continue;
  shown.add(x.slug);
  lines.push('### '+x.slug+' / '+x.caseId,'',
   '- Origin: '+x.inputOrigin,
   '- Original source: '+x.provenance.solution.repository+'@'+
      x.provenance.solution.revision+'/'+x.provenance.solution.path,
   '- Split: '+x.split,
   '- Generated records: '+x.quality.generatedRecords+
      '; owned journal events: '+x.quality.journalEvents+
      '; generated bytes: '+x.quality.generatedBytes,
   '- Source lowering: '+x.lowering,
   '', '~~~text',...x.quality.shortPreview,'~~~','');
 }
 lines.push('## Refusal ledger','','No unsupported or mismatched case was promoted to owned training.',
   '',...Object.entries(failureReasons)
    .sort((a,b)=>b[1]-a[1]).map(([why,n])=>'- '+n+' × '+why),'',
   '## Evidence boundaries','',
   '- Original upstream reference and canonical expected results independently checked for official cases.',
   '- Generated variants are checked against the original upstream solution, not falsely counted as canonical cases.',
   '- The original arrow-based ESM source is lowered only after conservative rejection rules; original-vs-lowered V8 agreement gates every success.',
   '- The owned journal is validated and replayed, checked against independently observed V8 operation and branch behavior, and independently rechecked after serialization.',
   '- Readability/size metrics do not certify unobserved getter/proxy/host effects or justify dropping causal computation.','');
 writeFileSync(reviewPath,lines.join('\n'));
}

console.log(JSON.stringify({totals:report.totals,quality:report.quality,
  byExercise,output,episodes:episodePath,refusals:failureReasons}));
if(committed<minOwned)
 throw new Error('Below independently rechecked owned verification floor '+committed+' < '+minOwned);
