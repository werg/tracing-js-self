import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fingerprintOwnedSource,clusterOwnedSources,SourceCloneResourceError}
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

const syntheticProfile=(id,shingles,split='train')=>({family:'source-'+id,split,
 sourceFingerprint:{schema:'owned-source-fingerprint/1',tokenCount:80,
  exactHash:id.toString(16).padStart(64,'0'),alphaHash:(id+100000).toString(16).padStart(64,'0'),
  shingles:[...new Set(shingles)].sort((a,b)=>a-b).map(n=>n.toString(16).padStart(24,'0'))}});

test('common shingles are never silently discarded as an inventory grows',()=>{
 const common=Array.from({length:20},(_,i)=>i);
 const profiles=Array.from({length:140},(_,i)=>syntheticProfile(i,[...common,1000+i]));
 const result=clusterOwnedSources(profiles,{nearThreshold:0.9});
 assert.equal(result.distinctSourceClusters,1);
 assert.equal(result.nearPairs,140*139/2);
 assert.equal(result.audit.complete,true);
 assert.throws(()=>clusterOwnedSources(profiles.map((row,i)=>({...row,split:i?'train':'test'})),
  {nearThreshold:0.9}),/leakage/);
});

test('prefix-filtered near pairs and components agree with exhaustive Jaccard comparisons',()=>{
 let seed=18271;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const profiles=[];
 for(let group=0;group<8;group++){
  const common=Array.from({length:24},(_,i)=>group*100+i);
  for(let variant=0;variant<7;variant++)profiles.push(syntheticProfile(profiles.length,
   [...common.filter(()=>random()%20!==0),1000+profiles.length,2000+random()%4]));
 }
 // Short and heavily repetitive programs must obey the same Jaccard rule.
 profiles.push(syntheticProfile(profiles.length,[9999]));
 profiles.push(syntheticProfile(profiles.length,[9999]));
 for(const threshold of [0.8,0.9,0.92,1]){
  const parents=profiles.map((_,i)=>i);
  const find=i=>parents[i]===i?i:(parents[i]=find(parents[i]));
  let pairs=0;
  for(let i=0;i<profiles.length;i++)for(let j=0;j<i;j++){
   const a=new Set(profiles[i].sourceFingerprint.shingles),b=new Set(profiles[j].sourceFingerprint.shingles);
   const intersection=[...a].filter(item=>b.has(item)).length;
   if(intersection/(a.size+b.size-intersection)>=threshold){parents[find(i)]=find(j);pairs++;}
  }
  const result=clusterOwnedSources(profiles,{nearThreshold:threshold});
  assert.equal(result.nearPairs,pairs);
  for(let i=0;i<profiles.length;i++)for(let j=0;j<i;j++)
   assert.equal(result.keyByFamily[profiles[i].family]===result.keyByFamily[profiles[j].family],find(i)===find(j));
  assert.deepEqual(result,clusterOwnedSources([...profiles].reverse(),{nearThreshold:threshold}));
 }
});

test('clone resource exhaustion is explicit, fails closed, and can be retried with a larger budget',()=>{
 const profiles=[syntheticProfile(0,[1,2,3]),syntheticProfile(1,[1,2,3])];
 for(const [resource,limit] of [['comparisons','maxComparisons'],['candidateVisits','maxCandidateVisits'],['indexEntries','maxIndexEntries']]){
  assert.throws(()=>clusterOwnedSources(profiles,{cloneBudget:{[limit]:0}}),error=>{
   assert(error instanceof SourceCloneResourceError);
   assert.equal(error.status,'resource_exhausted');assert.equal(error.complete,false);
   assert.equal(error.resource,resource);assert.equal(error.costs[resource],0);
   assert.equal(error.budget[limit],0);return true;
  });
 }
 const result=clusterOwnedSources(profiles,{cloneBudget:{maxComparisons:1}});
 assert.equal(result.distinctSourceClusters,1);assert.equal(result.audit.costs.comparisons,1);
 assert.throws(()=>clusterOwnedSources(profiles,{cloneBudget:{maxComparisons:-1}}),/resource budgets/);
 assert.throws(()=>clusterOwnedSources(profiles,{cloneBudget:{maxComparisons:Infinity}}),/resource budgets/);
});

test('inventories have no preselected family ceiling and fingerprints must contain canonical sets',()=>{
 const profiles=Array.from({length:10001},(_,i)=>syntheticProfile(i,[i]));
 assert.equal(clusterOwnedSources(profiles).distinctFamilies,10001);
 for(const shingles of [[2,1],[1,1]]){
  const row=syntheticProfile(1,[]);
  row.sourceFingerprint.shingles=shingles.map(n=>n.toString(16).padStart(24,'0'));
  assert.throws(()=>clusterOwnedSources([row]),/Invalid owned source profile/);
 }
});
