import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase} from '../src/training/source-check.js';
import {profileOwnedEpisode,selectNovelEpisodes}
 from '../src/corpus/coverage-selection.mjs';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const revision='a'.repeat(40);
const branchSource='"use strict";function f(n){let sum=0;if(n>0){sum=n+1;}else{sum=n-1;}return sum;}';
const otherSource='"use strict";function f(n){let result=n*3;return result;}';
const make=(source,args,id,slug='branch')=>{
 const verified=verifyOwnedSourceCase({source,entry:'f',args,maxGenerated:2048});
 assert.equal(verified.status,'locally_verified',JSON.stringify(verified).slice(0,400));
 return {schema:'owned-exercism-local-episode/1',admitted:false,
  id,slug,caseId:id,split:'train',inputOrigin:'upstream-canonical',
  originalSource:{repository:'example/lib',revision,path:'src/'+slug+'.js'},
  exported:JSON.parse(JSON.stringify(verified.exported))};
};
test('only independently rechecked owned execution can contribute novelty',()=>{
 const row=make(branchSource,[2],'a');
 const shape=profileOwnedEpisode(row);
 assert.equal(shape.authority,'owned-locally-verified-non-admitted');
 assert.equal(shape.admitted,false);
 assert(shape.branchCount>0);
 assert(shape.operations.length>0);
 const negative=profileOwnedEpisode(make(branchSource,[-1],'b'));
 assert.notEqual(negative.pathHash,shape.pathHash);
 assert.equal(negative.family,shape.family);
 const forged=structuredClone(row);
 forged.exported.sidecar.branchAudit.status='unverified';
 assert.throws(()=>profileOwnedEpisode(forged),/audited/);
 const altered=structuredClone(row);
 altered.exported.sidecar.referenceStatus='not-checked';
 assert.throws(()=>profileOwnedEpisode(altered),/recheck/);
 assert.throws(()=>profileOwnedEpisode({...row,admitted:true}),/audited/);
});
test('novel branch paths and operation types beat repeated seed counts',()=>{
 const rows=[
   make(branchSource,[3],'b'),
   make(branchSource,[3],'a'),
   make(branchSource,[-2],'c'),
   make(otherSource,[4],'d','multiply')
 ];
 const profiles=rows.map(profileOwnedEpisode);
 assert.equal(profiles[0].pathHash,profiles[1].pathHash);
 const selected=selectNovelEpisodes([...profiles].reverse(),{limit:10});
 assert.equal(selected.candidateCount,4);
 assert.equal(selected.distinctFamilies,2);
 assert.equal(selected.distinctPaths,3);
 assert.equal(selected.selectedCount,3);
 assert.equal(selected.admitted,0);
 assert(selected.selected.some(x=>x.branchCount>0));
 assert(selected.selected.every(x=>x.noveltyScore>0));
 assert.deepEqual(selected.selected.map(x=>x.id),
  selectNovelEpisodes(profiles,{limit:10}).selected.map(x=>x.id));
 assert.equal(selectNovelEpisodes(profiles,{limit:1}).selectedCount,1);
 assert.throws(()=>selectNovelEpisodes([{...profiles[0],split:'validation'},profiles[1]]),
  /leakage/);
 assert.throws(()=>selectNovelEpisodes([profiles[0],profiles[0]]),/Duplicate/);
});
test('offline selected subset contains no fabricated admission and refuses forged rows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'owned-novelty-'));
 try{
  const one=make(branchSource,[3],'a');
  const two=make(branchSource,[-2],'b');
  const forged={...one,id:'fake',exported:structuredClone(one.exported)};
  forged.exported.sidecar.branchAudit.checked++;
  const input=join(dir,'episodes.jsonl'),output=join(dir,'selection.json');
  writeFileSync(input,[one,two,forged].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const cli=resolve('tools/select-owned-episodes.mjs');
  const result=spawnSync(process.execPath,[cli,'--input',input,'--output',output,
   '--limit','3'],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(readFileSync(output));
  assert.equal(report.inputRows,3);
  assert.equal(report.selectedCount,2);
  assert.equal(report.admitted,0);
  assert.equal(Object.values(report.evidenceRefusals).reduce((a,b)=>a+b,0),1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
