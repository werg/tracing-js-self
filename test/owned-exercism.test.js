import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadPinnedPairs,lowerPinnedProof,extractCanonicalCases,stableSplit,bindings,canonicalJavaScriptExpected}
  from '../src/corpus/owned-exercism.mjs';
import {generateInputVariations} from '../src/corpus/variation-exercism.mjs';
import {buildOwnedSourceMap,mapSourceSite,auditSourceSites} from '../src/corpus/original-sites.mjs';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence}
  from '../src/training/source-check.js';
import {canonicalReturnMatches} from '../src/corpus/exercism-language-bindings.mjs';

test('20 independently pinned real JS proof implementations pair with canonical inputs',()=>{
 const pairs=loadPinnedPairs();
 assert.equal(pairs.length,20);
 assert.equal(new Set(pairs.map(x=>x.slug)).size,20);
 for(const pair of pairs){
  assert.equal(pair.provenance.solution.repository,'exercism/javascript');
  assert.equal(pair.provenance.canonical.repository,'exercism/problem-specifications');
  assert.match(pair.provenance.solution.sha256,/^[0-9a-f]{64}$/);
  assert.match(pair.provenance.canonical.sha256,/^[0-9a-f]{64}$/);
  assert.equal(pair.split,stableSplit(pair.slug));
  assert.ok(extractCanonicalCases(pair).length>0,pair.slug);
 }
});
test('function-only ESM lowerer preserves computation and rejects top-level effects',()=>{
 const pair=loadPinnedPairs().find(x=>x.slug==='leap');
 const lowered=lowerPinnedProof(pair.source);
 assert.ok(lowered.exported.includes('isLeap'));
 assert.match(lowered.source,/^"use strict";\n/);
 assert.match(lowered.source,/function isLeap\(year\)/);
 assert.throws(()=>lowerPinnedProof('export const n=expensive(); export const f=x=>x+n;'),
  /Top-level non-function initialization/);
 assert.throws(()=>lowerPinnedProof('export const f=x=>this.value+x;'),
  /Arrow receiver\/arguments/);
 assert.throws(()=>lowerPinnedProof('export class C {}'),
  /Unsupported top-level ESM/);
});
test('original leap proof and canonical input pass owned independent recheck',()=>{
 const pair=loadPinnedPairs().find(x=>x.slug==='leap');
 const fixture=extractCanonicalCases(pair).find(x=>x.status==='candidate'&&x.args[0]===1996);
 assert.equal(fixture.expected,true);
 const p=lowerPinnedProof(pair.source);
 const verified=verifyOwnedSourceCase({source:p.source,entry:fixture.entry,args:fixture.args,
   maxSteps:12000,maxGenerated:256,lineage:{exercise:'leap',caseId:fixture.caseId}});
 assert.equal(verified.status,'locally_verified',verified.reason??'');
 const checked=recheckOwnedSourceEvidence(JSON.parse(JSON.stringify(verified.exported)));
 assert.equal(checked.valid,true,checked.reason??'');
 assert.equal(verified.exported.public.schema,'semantic-execution/5');
 assert.equal(verified.exported.sidecar.referenceStatus,'agreed');
});
test('canonical identity and split are stable by exercise, not input',()=>{
 const pairs=loadPinnedPairs();
 for(const pair of pairs){
  const samples=extractCanonicalCases(pair);
  const ids=new Set(samples.map(x=>x.caseId));
  assert.equal(ids.size,samples.length,pair.slug);
  assert.equal(pair.split,stableSplit(pair.slug));
 }
});

test('explicit JavaScript canonical bindings preserve original inputs and exact BigInt integer tokens',()=>{
 const pairs=loadPinnedPairs();
 const first=slug=>extractCanonicalCases(pairs.find(pair=>pair.slug===slug))[0];
 const absent=first('two-fer');
 assert.deepEqual(absent.args,[]);assert.deepEqual(absent.canonicalInput,{name:null});
 assert.equal(absent.argumentBinding,'two-fer-null-name-as-omitted-argument/1');
 const items=extractCanonicalCases(pairs.find(pair=>pair.slug==='knapsack'),{includeSuperseded:true})
   .find(row=>row.argumentBinding==='knapsack-empty-record-as-empty-items/1');
 assert.equal(items.status,'superseded_canonical_case');
 assert.deepEqual(items.args,[100,[]]);assert.deepEqual(items.canonicalInput,{maximumWeight:100,items:{}});
 assert.equal(items.argumentBinding,'knapsack-empty-record-as-empty-items/1');
 const grains=extractCanonicalCases(pairs.find(pair=>pair.slug==='grains'));
 const square=grains.find(row=>row.args?.[0]===64),total=grains.find(row=>row.property==='total');
 assert.equal(square.expectedBinding.decimal,'9223372036854775808');
 assert.equal(total.expectedBinding.decimal,'18446744073709551615');
 for(const row of [square,total]){
   const retained=JSON.parse(JSON.stringify(row));
   assert.equal(canonicalJavaScriptExpected(retained.expected,retained.expectedBinding),BigInt(row.expectedBinding.decimal));
 }
 assert.equal(canonicalJavaScriptExpected(1,grains[0].expectedBinding),1n);
 assert.throws(()=>canonicalJavaScriptExpected(2,grains[0].expectedBinding),/expected-value binding/);
 const imprecise=extractCanonicalCases({slug:'grains',canonical:{cases:[{
   uuid:'unbound',property:'square',input:{square:64},expected:9223372036854775808}]}});
 assert.equal(imprecise[0].status,'unsupported_expected_precision');
});

test('active canonical replacements retain the superseded identity without replaying obsolete inputs',()=>{
 const pair=loadPinnedPairs().find(x=>x.slug==='knapsack');
 const cases=extractCanonicalCases(pair);
 const superseded='knapsack/a4d7d2f0-ad8a-460c-86f3-88ba709d41a7';
 const replacement='knapsack/3993a824-c20e-493d-b3c9-ee8a7753ee59';
 assert.equal(cases.some(x=>x.caseId===superseded),false);
 assert.equal(cases[0].caseId,replacement);
 assert.equal(cases[0].reimplements,superseded.split('/')[1]);
 assert.deepEqual(cases[0].args,[100,[]]);
 const retired=extractCanonicalCases(pair,{includeSuperseded:true}).find(x=>x.caseId===superseded);
 assert.equal(retired.status,'superseded_canonical_case');
 assert.deepEqual(retired.replacedBy,[replacement]);
});

test('the two-fer JavaScript binding records omission while retaining the neutral null input',()=>{
 const cases=extractCanonicalCases(loadPinnedPairs().find(x=>x.slug==='two-fer'));
 assert.deepEqual(cases[0].canonicalInput,{name:null});
 assert.deepEqual(cases[0].args,[]);
 assert.deepEqual(cases[0].inputBinding,
   {schema:'exercism-two-fer-omitted-name/1',canonicalName:null,argumentCount:0});
 assert.deepEqual(cases[1].args,['Alice']);
 assert.equal(cases[1].inputBinding,null);
});

test('grains expectations retain exact pinned decimal bytes and require actual BigInt results',()=>{
 const cases=extractCanonicalCases(loadPinnedPairs().find(x=>x.slug==='grains'));
 const total=cases.find(x=>x.property==='total'),first=cases[0];
 assert.equal(total.expectedBinding.decimal,'18446744073709551615');
 assert.notEqual(String(total.expected),total.expectedBinding.decimal,'ordinary JSON Number has rounded');
 const context={family:'exercism/javascript:grains',property:'total'};
 assert.equal(canonicalReturnMatches(18446744073709551615n,total.expected,total.expectedBinding,context),true);
 for(const wrong of [18446744073709551614n,total.expected,total.expectedBinding.decimal])
   assert.equal(canonicalReturnMatches(wrong,total.expected,total.expectedBinding,context),false);
 assert.equal(canonicalReturnMatches(1n,first.expected,first.expectedBinding,{...context,property:'square'}),true);
 assert.equal(canonicalReturnMatches(1,first.expected,first.expectedBinding,{...context,property:'square'}),false);
 assert.equal(canonicalReturnMatches(1n,1,null),false,'unbound comparisons retain their exact types');
 for(const [binding,changed] of [[{...total.expectedBinding,decimal:'01'},context],
   [total.expectedBinding,{...context,family:'exercism/javascript:leap'}],
   [total.expectedBinding,{...context,property:'wrong'}]])
   assert.throws(()=>canonicalReturnMatches(1n,total.expected,binding,changed),/Invalid exact/);
});

test('exact grains expectations work without JSON.parse reviver source context',()=>{
 const originalParse=JSON.parse;
 try{
  // Exercise the older two-argument reviver API used by the Node 20 CI gate.
  JSON.parse=(text,reviver)=>originalParse(text,typeof reviver==='function'
    ?function(key,value){return reviver.call(this,key,value);}:reviver);
  const cases=extractCanonicalCases(loadPinnedPairs().find(x=>x.slug==='grains'));
  assert.equal(cases.find(x=>x.property==='total').expectedBinding.decimal,'18446744073709551615');
  assert.equal(cases.find(x=>x.args[0]===64).expectedBinding.decimal,'9223372036854775808');
 }finally{JSON.parse=originalParse;}
});

test('deterministic generated variants stay distinct from canonical provenance',()=>{
 const pairs=loadPinnedPairs();
 const leap=pairs.find(p=>p.slug==='leap');
 const tests=extractCanonicalCases(leap);
 const first=generateInputVariations('leap',tests,{limit:12});
 const second=generateInputVariations('leap',tests,{limit:12});
 assert.deepEqual(first,second);
 assert.equal(first.length,12);
 const canon=new Set(tests.filter(t=>t.status==='candidate').map(t=>JSON.stringify(t.args)));
 for(const t of first){
  assert.match(t.caseId,/^generated\/leap\//);
  assert.equal(t.expectedAuthority,'original-v8-oracle');
  assert.ok(!canon.has(JSON.stringify(t.args)));
  assert.ok(t.derivedFrom.startsWith('leap/'));
 }
 assert.deepEqual(generateInputVariations('leap',tests,{limit:0}),[]);
 assert.throws(()=>generateInputVariations('leap',tests,{limit:513}));
});


test('source-site audit maps original function bodies without guessing synthetic keywords',()=>{
 const pair=loadPinnedPairs().find(x=>x.slug==='leap');
 const lowered=lowerPinnedProof(pair.source);
 const map=buildOwnedSourceMap(pair.source,lowered.source);
 assert.equal(map.schema,'owned-original-sites/1');
 const fragment=map.segments.find(x=>x.owner==='isLeap');
 assert.ok(fragment);
 assert.equal(lowered.source.slice(fragment.generatedStart,fragment.generatedEnd),
   pair.source.slice(fragment.originalStart,fragment.originalEnd));
 assert.equal(mapSourceSite(map,0,8),null,'injected strict directive has no upstream site');
 const mapped=mapSourceSite(map,fragment.generatedStart,fragment.generatedStart+1);
 assert.equal(mapped.start,fragment.originalStart);
 const fixture=extractCanonicalCases(pair).find(x=>x.status==='candidate'&&x.args[0]===1996);
 const verified=verifyOwnedSourceCase({source:lowered.source,entry:fixture.entry,args:fixture.args});
 assert.equal(verified.status,'locally_verified',verified.reason??'');
 const siteAudit=auditSourceSites(map,verified.exported.sidecar.semantic,
    pair.source,lowered.source);
 assert.equal(siteAudit.valid,true);
 assert.ok(siteAudit.totals.mapped>0);
 for(const receipt of siteAudit.receipts)assert.equal(
   lowered.source.slice(receipt.generated.start,receipt.generated.end),
   pair.source.slice(receipt.original.start,receipt.original.end));
 assert.throws(()=>auditSourceSites(map,verified.exported.sidecar.semantic,
   pair.source+' ',lowered.source),/changed/);
});
