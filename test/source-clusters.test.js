import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fingerprintOwnedSource,clusterOwnedSources}
 from '../src/corpus/source-clusters.mjs';

const first='"use strict";function add(a,b){const total=a+b;if(total>10)return total*2;return total-3;}';
const second='// fork\n"use strict"; function renamed(x,y) {const z=x+y;if(z>10)return z*2;return z-3;}';
const distinct='"use strict";function multiply(a,b){const total=a*b;if(total>10)return total*2;return total-3;}';
const profile=(family,split,source)=>({family,split,
 sourceFingerprint:fingerprintOwnedSource(source)});

test('token fingerprints ignore formatting but preserve executable operators',()=>{
 const a=fingerprintOwnedSource(first),b=fingerprintOwnedSource(second);
 assert.equal(a.schema,'owned-source-fingerprint/1');
 assert.notEqual(a.exactHash,b.exactHash);
 assert.equal(a.alphaHash,b.alphaHash);
 assert.notEqual(a.alphaHash,fingerprintOwnedSource(distinct).alphaHash);
 assert.deepEqual(fingerprintOwnedSource(first),a);
 assert.throws(()=>fingerprintOwnedSource(''),/Invalid/);
});
test('cross-fork alpha-equivalent owned source shares a cluster',()=>{
 const a=profile('a/repo@a/source.js','train',first),
  b=profile('b/fork@b/renamed.js','train',second);
 const clustered=clusterOwnedSources([b,a]);
 assert.equal(clustered.distinctFamilies,2);
 assert.equal(clustered.distinctSourceClusters,1);
 assert.deepEqual(clustered.clusters[0].members,[a.family,b.family]);
 assert.deepEqual(clustered,clusterOwnedSources([a,b]));
});
test('cross-split clones reject a selection even when source paths differ',()=>{
 const a=profile('one@revision','train',first);
 assert.throws(()=>clusterOwnedSources([a,profile('other@revision','test',second)]),
  /leakage/);
 assert.equal(clusterOwnedSources([a,profile('other@revision','test',distinct)])
  .distinctSourceClusters,2);
 assert.throws(()=>clusterOwnedSources([a,{...a,split:'test'}]),/Conflicting/);
 const broken={...a,sourceFingerprint:{...a.sourceFingerprint,exactHash:'bogus'}};
 assert.throws(()=>clusterOwnedSources([broken]),/Invalid/);
});
test('near-identical long programs cluster by overlapping token shingles',()=>{
 const body=Array.from({length:30},(_,i)=>'const value'+i+'=input+'+i+';').join('');
 const a=profile('one@sha','train','function f(input){'+body+'return value29;}');
 const b=profile('two@sha','train','function f(input){'+
  body.replace('input+17','input-17')+'return value29;}');
 const cluster=clusterOwnedSources([a,b],{nearThreshold:0.8});
 assert.equal(cluster.distinctSourceClusters,1);
 assert(cluster.nearPairs>0);
 assert.throws(()=>clusterOwnedSources([a,{...b,split:'validation'}],
  {nearThreshold:0.8}),/leakage/);
});
