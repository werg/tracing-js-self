import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runGenerationProcess,generationEnvironment} from '../src/corpus/generation-process.mjs';

const task={kind:'source',producerRevision:'a'.repeat(40),fixture:{id:'one',
  source:'"use strict";function run(x){return x+1;}',entry:'run',args:[1],fixture:{calls:[]},family:'increment'}};
function directory(t){const path=mkdtempSync(join(tmpdir(),'semantic-worker-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
test('bounded generation process keeps the source gate and reports measured RSS',async t=>{
  const run=await runGenerationProcess(task,{outputDirectory:directory(t),timeoutMs:30000});
  assert.equal(run.result.status,'locally_verified',run.result.reason);
  assert.equal(run.result.exported.sidecar.referenceStatus,'agreed');
  assert.ok(run.durationMs>0);assert.ok(run.peakRssBytes>0);
  assert.equal(Object.keys(generationEnvironment()).some(key=>/TOKEN|SECRET|PROXY/i.test(key)),false);
});
test('times out or cancels workers and refuses oversized evidence with explicit statuses',async t=>{
  const outputDirectory=directory(t);
  const limited=await runGenerationProcess(task,{outputDirectory,maxOutputBytes:1024,timeoutMs:30000});
  assert.equal(limited.result.status,'worker_output_limit');
  const timed=await runGenerationProcess(task,{outputDirectory,timeoutMs:10});
  assert.equal(timed.result.status,'worker_timeout');
  const controller=new AbortController();controller.abort();
  const cancelled=await runGenerationProcess(task,{outputDirectory,signal:controller.signal});
  assert.equal(cancelled.result.status,'cancelled');
});
test('collector resumes exact successful receipts without launching new attempts',t=>{
  const out=directory(t),tool=resolve('tools/generate-effectful-training.mjs');
  const args=[tool,'--out',out,'--jobs','2','--limit','2','--compact-storage'];
  const first=spawnSync(process.execPath,args,{encoding:'utf8',timeout:90000,maxBuffer:1048576});
  assert.equal(first.status,0,first.stderr);
  const original=readFileSync(join(out,'campaign.jsonl'),'utf8');
  const again=spawnSync(process.execPath,[...args,'--resume'],{encoding:'utf8',timeout:90000,maxBuffer:1048576});
  assert.equal(again.status,0,again.stderr);
  assert.equal(readFileSync(join(out,'campaign.jsonl'),'utf8'),original);
  const manifest=JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'));
  assert.equal(manifest.counts.locally_verified,2);assert.equal(manifest.campaign.resumed,2);
  assert.equal(manifest.campaign.compatibilityExports,false);
  assert.ok(manifest.cases.every(row=>row.publicShard&&row.privateEvidence&&!row.path));
  assert.equal(manifest.throughput.admittedLearnerTokensPerHour,null);
});
