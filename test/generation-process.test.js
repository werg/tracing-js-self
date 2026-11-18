import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runGenerationProcess,generationEnvironment,encodeGenerationTask,decodeGenerationTask,
  persistGenerationCandidate} from '../src/corpus/generation-process.mjs';
import {decodeOwnedGraph} from '../src/host/graph-codec.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {materializeCampaign} from '../tools/materialize-campaign.mjs';
import {CampaignStore,identityHash} from '../src/corpus/campaign-store.mjs';
import {trainingCandidateTasks,candidateSourceInventory,SOURCE_RECIPES} from '../src/corpus/training-candidates.mjs';
import {buildSourceRegistry,immutableSourceRegistry,frozenSplitIdentity,verifyFrozenSplitIdentity}
  from '../src/corpus/source-registry.mjs';

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
test('encoded fixtures separate structural metadata aliases from exact guest graphs',()=>{
  const value=Object.create(null);value.self=value;
  const sparse=[undefined,,NaN,-0,Infinity,3n];
  const metadata={values:['shared']};
  const request={...task,fixture:{...task.fixture,args:[value,value,sparse],
    provenance:{first:metadata,second:metadata},fixture:{calls:[{operation:'demo.effect',
      arguments:[value,value],result:sparse}]}}};
  const encoded=encodeGenerationTask(request),persisted=JSON.parse(JSON.stringify(encoded));
  assert.equal(identityHash(encoded),identityHash(persisted));
  assert.notEqual(encoded.fixture.provenance.first,encoded.fixture.provenance.second);
  const decoded=decodeGenerationTask(persisted),args=decoded.fixture.args;
  assert.equal(Object.getPrototypeOf(args[0]),null);assert.equal(args[0],args[1]);
  assert.equal(args[0].self,args[0]);assert.equal(args[2][0],undefined);
  assert.equal(Object.hasOwn(args[2],0),true);assert.equal(Object.hasOwn(args[2],1),false);
  assert.ok(Number.isNaN(args[2][2]));assert.ok(Object.is(args[2][3],-0));
  assert.equal(args[2][4],Infinity);assert.equal(args[2][5],3n);
  for(const optional of [undefined,NaN,-0,1n,()=>{},Symbol('metadata')])
    assert.throws(()=>encodeGenerationTask({...task,fixture:{...task.fixture,optional}}),/metadata/);
  const circular={};circular.self=circular;
  assert.throws(()=>encodeGenerationTask({...task,fixture:{...task.fixture,circular}}),/acyclic JSON/);
});
test('durable fixture references use the same canonical host and input graphs',t=>{
  const value={n:3n},sparse=[undefined,,NaN,-0,Infinity];
  const request={...task,fixture:{...task.fixture,args:[value,value],fixture:{calls:[{
    operation:'demo.effect',arguments:[value,value],result:sparse}]}}};
  const store=new CampaignStore(directory(t),{purpose:'canonical-host-fixture'});t.after(()=>store.close());
  const candidate=persistGenerationCandidate(store,request);
  const entry=store.record('special',candidate,{status:'unsupported',reason:'storage regression only'});
  const restored=store.readObject(entry.candidate),input=restored.inputs[0];
  assert.deepEqual(store.readObject(input.input),restored.fixture.argsGraph);
  const fixture=store.readObject(input.fixture);assert.deepEqual(fixture,restored.fixture.fixture);
  const args=decodeOwnedGraph(JSON.stringify(fixture.calls[0].argumentGraph));
  assert.equal(args[0],args[1]);assert.equal(args[0].n,3n);
  const [result]=decodeOwnedGraph(JSON.stringify(fixture.calls[0].resultGraph));
  assert.equal(result[0],undefined);assert.ok(Object.hasOwn(result,0));assert.ok(!Object.hasOwn(result,1));
  assert.ok(Number.isNaN(result[2]));assert.ok(Object.is(result[3],-0));assert.equal(result[4],Infinity);
});
test('verified registry trees are reused across candidates and distinct within each stored session',()=>{
  const registry=immutableSourceRegistry(buildSourceRegistry(candidateSourceInventory([task])));
  const splitIdentity=frozenSplitIdentity(registry,task.fixture.family);
  const request={...task,fixture:{...task.fixture,splitIdentity}};
  const first=encodeGenerationTask(request),second=encodeGenerationTask(request);
  assert.equal(first.fixture.splitIdentity.registry,second.fixture.splitIdentity.registry);
  assert.ok(Object.isFrozen(first.fixture.splitIdentity.registry.sources));
  assert.throws(()=>{first.fixture.splitIdentity.registry.sources[0].source='changed';},TypeError);
  const session={kind:'session',fixture:{id:'session',family:task.fixture.family,splitIdentity,
    cases:[request.fixture,request.fixture]}};
  const stored=encodeGenerationTask(session),transport=encodeGenerationTask(session,{jsonStorage:false});
  assert.notEqual(stored.fixture.splitIdentity.registry,stored.fixture.cases[0].splitIdentity.registry);
  assert.notEqual(stored.fixture.cases[0].splitIdentity.registry,stored.fixture.cases[1].splitIdentity.registry);
  assert.equal(transport.fixture.splitIdentity.registry,transport.fixture.cases[0].splitIdentity.registry);
  assert.equal(identityHash(stored),identityHash(JSON.parse(JSON.stringify(stored))));
});
test('all five recipe fixture inventories survive frozen-registry campaign storage',t=>{
  const inventory=SOURCE_RECIPES.flatMap(recipe=>trainingCandidateTasks(recipe,{perFamily:12}));
  const registry=immutableSourceRegistry(buildSourceRegistry(candidateSourceInventory(inventory),{
    holdoutProjects:['exercism/javascript'],holdoutCompositions:['square/even/maximum/alias/return']}));
  const out=directory(t),store=new CampaignStore(out,{purpose:'fixture-storage-regression'});
  t.after(()=>store.close());
  const counts={};
  for(const recipe of SOURCE_RECIPES){
    const tasks=trainingCandidateTasks(recipe,{perFamily:recipe==='generated-v1'?4:2});
    counts[recipe]=tasks.length;
    for(const original of tasks){
      const splitIdentity=frozenSplitIdentity(registry,original.fixture.family);
      const fixture={...original.fixture,splitIdentity,seed:registry.seed};
      if(original.kind==='session')fixture.cases=fixture.cases.map(item=>({...item,splitIdentity,seed:registry.seed}));
      const candidate=encodeGenerationTask({...original,fixture});
      const entry=store.record(recipe+'-'+fixture.id,candidate,{status:'unsupported',reason:'serialization regression only'});
      const restored=store.readObject(entry.candidate);
      assert.equal(identityHash(restored),identityHash(candidate),recipe+': '+fixture.id);
      assert.equal(verifyFrozenSplitIdentity(restored.fixture.splitIdentity,{family:fixture.family}).valid,true);
    }
  }
  assert.ok(Object.values(counts).every(count=>count>0));
  assert.equal(store.storageStatistics().byKind.registries.objects,1);
  const total=Object.values(counts).reduce((sum,count)=>sum+count,0);
  store.close();
  const resumed=new CampaignStore(out,{purpose:'fixture-storage-regression'},{readOnly:true});
  assert.equal(resumed.entries.length,total);resumed.close();
  t.diagnostic(JSON.stringify({recipeFixtureCounts:counts,total}));
});
test('collector resumes exact successful receipts without launching new attempts',t=>{
  const out=directory(t),tool=resolve('tools/generate-effectful-training.mjs');
  const registry=join(directory(t),'source-registry.json');
  const freeze=spawnSync(process.execPath,[resolve('tools/freeze-source-registry.mjs'),'--out',registry,
    '--holdout-projects','exercism/javascript','--holdout-compositions','square/even/maximum/alias/return'],
    {encoding:'utf8',timeout:30000,maxBuffer:1048576});
  assert.equal(freeze.status,0,freeze.stderr);
  const args=[tool,'--out',out,'--jobs','2','--limit','2','--compact-storage','--registry',registry];
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
