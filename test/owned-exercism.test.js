import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadPinnedPairs,lowerPinnedProof,extractCanonicalCases,stableSplit,bindings}
  from '../src/corpus/owned-exercism.mjs';
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
 assert.equal(verified.exported.public.schema,'semantic-execution/2');
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
