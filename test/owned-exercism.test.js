import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadPinnedPairs,lowerPinnedProof,extractCanonicalCases,stableSplit,bindings}
  from '../src/corpus/owned-exercism.mjs';
import {generateInputVariations} from '../src/corpus/variation-exercism.mjs';
import {buildOwnedSourceMap,mapSourceSite,auditSourceSites} from '../src/corpus/original-sites.mjs';
import {verifyTrainingCase,recheckIndependentTrainingEvidence}
  from '../src/training/admit.js';

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
 const verified=verifyTrainingCase({source:p.source,entry:fixture.entry,args:fixture.args,
   maxSteps:12000,maxGenerated:256,lineage:{exercise:'leap',caseId:fixture.caseId}});
 assert.equal(verified.status,'locally_verified',verified.reason??'');
 const checked=recheckIndependentTrainingEvidence(JSON.parse(JSON.stringify(verified.exported)));
 assert.equal(checked.valid,true,checked.reason??'');
 assert.equal(verified.exported.public.schema,'semantic-execution/3');
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
 const verified=verifyTrainingCase({source:lowered.source,entry:fixture.entry,args:fixture.args});
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
