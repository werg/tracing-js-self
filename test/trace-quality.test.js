import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';
import {profileOwnedEpisode,selectNovelEpisodes}
 from '../src/corpus/coverage-selection.mjs';

const source='"use strict";function answer(n){if(n>4)return n*2;return n+1;}';
const make=(n,id)=>{
 const verified=verifyOwnedSourceCase({source,entry:'answer',args:[n],maxGenerated:256});
 assert.equal(verified.status,'locally_verified',verified.reason);
 return {schema:'owned-exercism-local-episode/1',admitted:false,id,slug:'answer',
  split:'train',inputOrigin:'upstream-canonical',
  originalSource:{repository:'a/b',revision:'a'.repeat(40),path:'answer.js'},
  exported:JSON.parse(JSON.stringify(verified.exported))};
};
test('rechecked owned source profiles carry quantitative trace review metrics',()=>{
 const a=profileOwnedEpisode(make(6,'a'));
 const b=profileOwnedEpisode(make(1,'b'));
 assert(a.quality.rawEvents>0);
 assert(a.quality.generatedRecords>0);
 assert(a.quality.generatedBytes>0);
 assert.equal(a.quality.sourceAuditAvailable,false);
 const selection=selectNovelEpisodes([a,b]);
 assert.equal(selection.traceQuality.admitted,0);
 assert.equal(selection.traceQuality.episodes,2);
 assert.equal(selection.traceQuality.reportedOriginalSourceCoverage,null);
 assert.equal(selection.traceQuality.inspectionQueue.length,2);
 assert(selection.traceQuality.quantiles.generatedBytes.max>0);
 assert.equal(selection.distinctSourceClusters,1);
});
test('malformed or unverified source receipts cannot enter quality metrics',()=>{
 const bad=make(2,'bad');
 bad.sourceSites={schema:'owned-source-site-audit/1',valid:false,
  totals:{total:3,mapped:3}};
 assert.throws(()=>profileOwnedEpisode(bad),/Invalid original-source receipt/);
});
