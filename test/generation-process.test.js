import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runGenerationProcess,generationEnvironment,encodeGenerationTask,decodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {materializeCampaign} from '../tools/materialize-campaign.mjs';
import {CampaignStore} from '../src/corpus/campaign-store.mjs';

const task={kind:'source',producerRevision:'a'.repeat(40),fixture:{id:'one',
  source:'"use strict";function run(x){return x+1;}',entry:'run',args:[1],fixture:{calls:[]},family:'increment'}};
function directory(t){const path=mkdtempSync(join(tmpdir(),'semantic-worker-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
test('bounded generation process keeps the source gate and reports measured RSS',async t=>{
  const previousTZ=process.env.TZ;process.env.TZ='UTC';
  t.after(()=>{if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;});
  const run=await runGenerationProcess(task,{outputDirectory:directory(t),timeoutMs:30000});
  assert.equal(run.result.status,'locally_verified',run.result.reason);
  assert.equal(run.result.exported.sidecar.referenceStatus,'agreed');
  assert.equal(run.result.exported.sidecar.environment.timezone,'UTC');
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
test('worker transport preserves null prototypes and shared input identities',async t=>{
  const value=Object.create(null);value.x=1;
  const request={...task,fixture:{...task.fixture,args:[value,value],
    source:'"use strict";function run(a,b){return Object.getPrototypeOf(a)===null&&a===b;}'}};
  const decoded=decodeGenerationTask(JSON.parse(JSON.stringify(encodeGenerationTask(request))));
  assert.equal(Object.getPrototypeOf(decoded.fixture.args[0]),null);
  assert.equal(decoded.fixture.args[0],decoded.fixture.args[1]);
  const direct=await verifyEffectfulTrainingCase(request.fixture);
  const run=await runGenerationProcess(request,{outputDirectory:directory(t),timeoutMs:30000});
  // The worker and JSON campaign representation must preserve the exact input
  // graph, rather than silently certifying a plain object with another meaning.
  assert.equal(run.result.status,direct.status,run.result.reason);
  assert.equal(run.result.reason,direct.reason);
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
  assert.ok(manifest.throughput.preparationMs>0);assert.ok(manifest.throughput.collectionMs>=0);
  assert.equal(manifest.throughput.elapsedMs,manifest.throughput.preparationMs+manifest.throughput.collectionMs);
  assert.equal(manifest.throughput.timingScope,'process-start-through-final-manifest-measurement');
  const manifestBytes=readFileSync(join(out,'manifest.json'));
  const destination=directory(t),materialization=materializeCampaign(out,{output:destination});
  assert.equal(materialization.materialized,2);
  assert.equal(materialization.sourceCampaignRequiredForAudit,true);
  assert.deepEqual(readFileSync(join(out,'manifest.json')),manifestBytes);
  assert.equal(readFileSync(join(out,'campaign.jsonl'),'utf8'),original);
  const expanded=JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8'));
  const header=JSON.parse(readFileSync(join(out,'campaign.json'),'utf8'));
  const store=new CampaignStore(out,header.identity,{readOnly:true,recoverTornLog:false});
  for(const row of expanded.cases)assert.deepEqual(JSON.parse(readFileSync(join(destination,row.path),'utf8')),
    store.exported(store.latest.get(row.id)));
  store.close();
  assert.throws(()=>materializeCampaign(out,{output:join(out,'..nested')}),/outside/);
});
