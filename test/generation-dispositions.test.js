import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

function directory(t){const path=mkdtempSync(join(tmpdir(),'semantic-dispositions-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
test('explicit refusal collection retains exact failed candidates without relabeling or hiding them',t=>{
  const out=directory(t),tool=resolve('tools/generate-effectful-training.mjs');
  const args=[tool,'--out',out,'--recipe','real-source','--source-stream','exercism',
    '--per-family','1','--limit','2','--jobs','2','--compact-storage'];
  const strict=spawnSync(process.execPath,args,{encoding:'utf8',timeout:90000,maxBuffer:1048576});
  assert.equal(strict.status,1,strict.stderr);
  const initial=JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'));
  assert.equal(initial.refusalPolicy,'fail-collection');
  assert.equal(initial.counts.attempted,2);assert.equal(initial.counts.admitted,0);
  assert.ok(initial.cases.every(row=>row.status==='unsupported'),JSON.stringify(initial.counts));
  const log=readFileSync(join(out,'campaign.jsonl'),'utf8');
  const audited=spawnSync(process.execPath,[...args,'--allow-refusals','--resume'],
    {encoding:'utf8',timeout:90000,maxBuffer:1048576});
  assert.equal(audited.status,0,audited.stderr);
  const retained=JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'));
  assert.equal(retained.refusalPolicy,'retain-all-dispositions');
  assert.deepEqual(retained.counts,initial.counts);assert.deepEqual(retained.cases,initial.cases);
  assert.equal(retained.campaign.resumed,2);
  assert.equal(readFileSync(join(out,'campaign.jsonl'),'utf8'),log);
  assert.equal(retained.cases.filter(row=>row.status==='admitted').length,0);
  assert.equal(retained.optimizerSteps,0);assert.equal(retained.learnedSuccess,null);
});
test('allowing refusals never removes an explicit native-consumer requirement',t=>{
  const result=spawnSync(process.execPath,[resolve('tools/generate-effectful-training.mjs'),
    '--out',directory(t),'--allow-refusals','--require-native'],
    {encoding:'utf8',timeout:30000,maxBuffer:1048576});
  assert.equal(result.status,1);assert.match(result.stderr,/--require-native needs a pinned native consumer/);
});
