import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {buildRegionFamilyRegistry} from '../src/semantic/family-registry-v8.js';
import {buildSemanticRegionSupportCohortV8} from '../fixtures/semantic-regions/support-cohort.js';
import {verifyLifecycleSourcePopulation,verifyLifecycleTargetPopulation} from '../tools/support-lifecycle-inventory.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const runner=join(root,'..','tools','qualify-ordinary-v8-lifecycle.mjs');

function invoke(extra){
  return spawnSync(process.execPath,[runner,'--out','/tmp/support-lifecycle-out',
    '--megatoken','/tmp/megatoken','--python','python','--tokenizer','/tmp/tokenizer.json',...extra],
    {encoding:'utf8'});
}

const complete=['--prepared-root','/tmp/prepared','--source-inventory','/tmp/inventory.json',
  '--sample-source','/tmp/sample.json'];
{
  const result=invoke(['--prepared-root','/tmp/prepared']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/requires --source-inventory and --sample-source/);
}
{
  const result=invoke(['--source-inventory','/tmp/inventory.json','--sample-source','/tmp/sample.json']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/require --prepared-root/);
}
{
  const result=invoke([...complete,'--source-id','synthetic']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/selects its source only from the admitted source artifact/);
}
{
  const result=invoke([...complete,'--orchestration-teacher']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/do not attach a second teacher/);
}

{
  const result=invoke(['--full-target-coverage']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Full target coverage requires the explicit prepared support corpus/);
}

{
  const result=invoke([...complete,'--full-target-coverage','--full-target-coverage']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Duplicate ordinary lifecycle option: --full-target-coverage/);
}

{
  const result=spawnSync(process.execPath,[runner,'--out','/tmp/prepared/nested-output',
    '--megatoken','/tmp/megatoken','--python','python','--tokenizer','/tmp/tokenizer.json',
    ...complete],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/outside both pinned checkouts/);
}

const populationFor=registry=>({schema:'semantic-v8-source-population/1',registryDigest:registry.digest,
  sourceIds:registry.sources.map(source=>source.id)});

test('lifecycle inventory derives all current members without a fixed population size',()=>{
  for(const count of [3,65]){
    const registry=buildRegionFamilyRegistry(Array.from({length:count},(_,i)=>({id:'source-'+i,
      family:'same-source',source:'function run(x){return x;}',entry:'run'})),{seed:17});
    const inventory=populationFor(registry),population=verifyLifecycleSourcePopulation(registry,inventory);
    assert.equal(population.populationCount,count);
    assert.equal(Object.values(population.splitCounts).reduce((a,b)=>a+b,0),count);
    assert.equal(population.trainSourceIds.length,population.splitCounts.train);
    assert.throws(()=>verifyLifecycleSourcePopulation(registry,{...inventory,sourceIds:inventory.sourceIds.slice(1)}),/differs/);
    assert.throws(()=>verifyLifecycleSourcePopulation(registry,{...inventory,sourceIds:inventory.sourceIds.map((id,i)=>i?'substituted-'+i:id)}),/differs/);
    assert.throws(()=>verifyLifecycleSourcePopulation(registry,{...inventory,sourceIds:[...inventory.sourceIds.slice(1),inventory.sourceIds[1]]}),/unique/);
    const forged=structuredClone(registry);forged.components[0].split='changed';
    assert.throws(()=>verifyLifecycleSourcePopulation(forged,inventory),/digest|changed/);
  }
});

test('lifecycle target inventory binds exact authenticated training IDs and actual split counts',()=>{
  const {registry}=buildSemanticRegionSupportCohortV8();
  const population=verifyLifecycleSourcePopulation(registry,populationFor(registry));
  const target={sourceIds:[...population.trainSourceIds].reverse(),trainEpisodeCount:population.splitCounts.train,
    registryDigest:registry.digest,windowCount:3,optimizerWindowCount:2,
    phaseMeter:'P',onePassMeterCount:10,phaseBudget:100};
  assert.equal(verifyLifecycleTargetPopulation(target,population).valid,true);
  const changed={...target,sourceIds:[...target.sourceIds]};changed.sourceIds[0]='unregistered';
  assert.throws(()=>verifyLifecycleTargetPopulation(changed,population),/authenticated/);
  changed.sourceIds[0]=population.sourceIds.find(id=>!population.trainSourceIds.includes(id));
  assert.throws(()=>verifyLifecycleTargetPopulation(changed,population),/authenticated/);
  for(const key of ['windowCount','optimizerWindowCount','phaseBudget','onePassMeterCount']){
    assert.throws(()=>verifyLifecycleTargetPopulation({...target,[key]:undefined},population),/job budget/);
    assert.throws(()=>verifyLifecycleTargetPopulation({...target,[key]:NaN},population),/job budget/);
  }
  assert.throws(()=>verifyLifecycleTargetPopulation({...target,trainEpisodeCount:target.trainEpisodeCount+1},population),/authenticated/);
  assert.throws(()=>verifyLifecycleTargetPopulation({...target,optimizerWindowCount:4},population),/job budget/);
  assert.throws(()=>verifyLifecycleTargetPopulation({...target,onePassMeterCount:101},population),/job budget/);
});
