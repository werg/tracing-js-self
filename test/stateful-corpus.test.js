import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {scenarios,upstream,pinnedSha256} from '../corpus/stateful/cases.mjs';

test('60 adversarial production scenarios have unique names, pinned module sources and full licenses',()=>{
 assert.equal(scenarios.length,67);
 assert.equal(Object.keys(upstream).length,7);
 assert.equal(new Set(scenarios.map(x=>x.id)).size,67);
 for(const row of scenarios){
  assert.match(row.id,/^[a-z\d-]+\/[a-z\d-]+$/);
  assert(row.modules.length>0);
  for(const mod of row.modules)assert(Object.hasOwn(upstream,mod));
  assert.match(row.run,/\b(?:async\s+)?function\s+run\s*\(/);
  assert.equal(typeof row.adversarial,'string');
 }
 for(const [name,meta] of Object.entries(upstream)){
  assert.match(meta.revision,/^[0-9a-f]{40}$/);
  assert(existsSync('corpus/stateful/upstream/'+meta.path),name);
  assert(existsSync('corpus/stateful/upstream/'+name+'/LICENSE'),name);
  assert(readFileSync('corpus/stateful/upstream/'+meta.path,'utf8').length>100);
  assert.equal(createHash('sha256').update(readFileSync('corpus/stateful/upstream/'+meta.path)).digest('hex'),pinnedSha256[name]);
 }
 const counts={};
 for(const row of scenarios)(counts[row.project]??=[]).push(row);
 assert.equal(Object.keys(counts).length,8);
 assert.equal(counts.application.length,6);
 for(const row of counts.application){
  assert(row.modules.length<=3);
  assert(row.modules.every(mod=>row.run.includes("__require('"+mod+"')")));
 }
});

test('real event listeners generate explicitly unadmitted, independently matching stateful observations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'stateful-observation-'));
 try {
  const input=join(dir,'out.jsonl'),report=join(dir,'report.json'),review=join(dir,'review.md');
  const result=spawnSync(process.execPath,['tools/build-stateful-corpus.mjs',
    '--limit','2','--per-scenario','2','--min-verified','4',
    '--output',input,'--report',report,'--review',review],
    {encoding:'utf8',timeout:100000});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  const data=JSON.parse(readFileSync(report,'utf8'));
  assert.equal(data.admitted,false);
  assert.equal(data.counts.requested,4);
  assert.equal(data.counts.agreed,4);
  assert.equal(data.counts.observerErrors,0);
  assert(data.counts.mutationEffects>0);
  const lines=readFileSync(input,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,4);
  assert(lines.every(x=>x.verified&&x.authority==='trusted-v8-diagnostic-only'));
  assert(readFileSync(review,'utf8').includes('mitt/'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
