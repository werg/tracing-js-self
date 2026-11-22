import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitBlobSha} from '../src/test262-baseline.js';
import {buildTest262Catalog,createTest262Campaign,recordTest262Stages,selectTest262Shard}
  from '../src/conformance/test262-catalog.js';
import {createTest262CampaignReport,readTest262Json,writeTest262Json} from '../src/conformance/test262-campaign.js';
import {createTest262CampaignAggregation} from '../src/conformance/test262-aggregate.js';

function setup(){
  const sources=Object.fromEntries(Array.from({length:12},(_,i)=>['test/source-'+i+'.js',
    '/*---\ndescription: aggregation control\n---*/\nvar value=1;']));
  const profile={name:'aggregation-control',edition:'ECMAScript (living)',specification:null,
    parser:{name:'control'},hostProfile:{name:'control'},resourcePolicy:{maxSteps:10,maxSourceBytes:1024}};
  const catalog=buildTest262Catalog({sources,profile,snapshot:{repository:'tc39/test262',revision:'a'.repeat(40),
    files:Object.fromEntries(Object.entries(sources).map(([path,text])=>[path,gitBlobSha(text)]))}});
  const part=(index,{policyPatch={},selectedIds=null,status='passed'}={})=>{
    const runPolicy={stages:['parse','reference'],jobs:1,workerTimeoutMs:10000,heapMb:384,...policyPatch,
      selection:{paths:null,cases:null,limit:null,all:true,
        shard:{index,count:3,strategy:'source-path-sha256/1'}}};
    const implementation={producerRevision:'b'.repeat(40),codeDigest:'c'.repeat(64),runnerDigest:'d'.repeat(64),runPolicy};
    let campaign=createTest262Campaign({catalog,implementation,
      selectedIds:selectedIds??selectTest262Shard(catalog.variants,{index,count:3}).map(row=>row.id)});
    const observations=campaign.rows.filter(row=>row.selected).flatMap(row=>[
      {caseId:row.id,stage:'parseStatic',status:'passed',evidence:{parseOnly:false}},
      {caseId:row.id,stage:'independentReference',status,evidence:{status,caseId:row.id}}
    ]);
    campaign=recordTest262Stages(campaign,observations);
    return createTest262CampaignReport({baseCatalog:catalog,catalog,campaign,runPolicy});
  };
  return {catalog,part};
}

test('aggregation retains missing shard variants as unrun, never as successful or excluded cases',()=>{
  const {catalog,part}=setup();
  const aggregate=createTest262CampaignAggregation({baseCatalog:catalog,shardCount:3});
  aggregate.add(part(0));aggregate.add(part(2,{status:'resource_limited'}));
  const report=aggregate.finish(),missing=selectTest262Shard(catalog.variants,{index:1,count:3});
  assert.equal(report.catalogVariants,24);
  assert.deepEqual(report.missingShards,[1]);
  assert.deepEqual(report.missingVariants.map(row=>[row.path,row.mode]),missing.map(row=>[row.path,row.mode]));
  assert.equal(report.stages.parseStatic.not_run,missing.length);
  assert.equal(report.stages.independentReference.not_run,missing.length);
  assert.equal(report.stages.ownedExecution.not_run,24);
  assert.equal(report.allShardsPresent,false);assert.equal(report.requestedWorkFinished,false);
  for(const counts of Object.values(report.stages))assert.equal(Object.values(counts).reduce((a,b)=>a+b),24);
  assert(Object.values(report.claims).every(value=>value===false));
});

test('full aggregation keeps guest errors, resource stops and unexecuted downstream stages visible',()=>{
  const {catalog,part}=setup();
  const aggregate=createTest262CampaignAggregation({baseCatalog:catalog,shardCount:3});
  for(const [index,status] of ['passed','failed','resource_limited'].entries())aggregate.add(part(index,{status}));
  const report=aggregate.finish();
  assert.equal(report.observedVariants,24);assert.deepEqual(report.missingVariants,[]);
  assert.equal(report.allShardsPresent,true);assert.equal(report.requestedWorkFinished,true);
  assert.equal(report.stages.independentReference.not_run,0);
  assert(report.stages.independentReference.failed>0);assert(report.stages.independentReference.resource_limited>0);
  assert.equal(report.stages.nativeReplay.passed,0);
  assert.throws(()=>aggregate.add(part(0)),/already finished/);
});

test('interrupted attempts remain unfinished even when every shard report exists',()=>{
  const {catalog,part}=setup();
  const aggregate=createTest262CampaignAggregation({baseCatalog:catalog,shardCount:3});
  for(let index=0;index<3;index++)aggregate.add(part(index,{status:index===1?'interrupted':'passed'}));
  const report=aggregate.finish();
  assert.equal(report.allShardsPresent,true);assert.equal(report.requestedWorkFinished,false);
  assert(report.stages.independentReference.interrupted>0);
});

test('substituted, duplicated or partially selected shards fail before mutating the aggregate',()=>{
  const {catalog,part}=setup();
  const aggregate=createTest262CampaignAggregation({baseCatalog:catalog,shardCount:3});
  aggregate.add(part(0));
  assert.throws(()=>aggregate.add(part(0)),/Duplicate Test262 campaign shard/);
  const selectedIds=selectTest262Shard(catalog.variants,{index:1,count:3}).map(row=>row.id).slice(1);
  assert.throws(()=>aggregate.add(part(1,{selectedIds})),/selection differs/);
  assert.throws(()=>aggregate.add(part(1,{policyPatch:{workerTimeoutMs:20000}})),/different implementations/);
  const corrupted=part(1);corrupted.campaign.rows.find(row=>row.selected).stages.independentReference.status='passed';
  corrupted.campaign.rows.find(row=>row.selected).attempts[1].evidence.status='invented';
  assert.throws(()=>aggregate.add(corrupted),/evidence digest/);
  aggregate.add(part(1));aggregate.add(part(2));
  assert.equal(aggregate.finish().observedVariants,24);
});

test('merge CLI reads original campaign parts and retains actual part content digests',()=>{
  const {catalog,part}=setup(),directory=mkdtempSync(join(process.cwd(),'test262-aggregate-'));
  try{
    const catalogPath=join(directory,'catalog.json.gz'),parts=join(directory,'parts'),output=join(directory,'summary.json.gz');
    mkdirSync(parts);writeTest262Json(catalogPath,catalog);
    for(let index=0;index<2;index++){
      const path=join(parts,'part-'+index);mkdirSync(path);
      writeTest262Json(join(path,'report.json.gz'),part(index));
    }
    execFileSync(process.execPath,['tools/merge-test262-campaigns.mjs','--catalog',catalogPath,
      '--directory',parts,'--shard-count','3','--out',output],{timeout:30000});
    const report=readTest262Json(output);
    assert.deepEqual(report.missingShards,[2]);assert.equal(report.parts.length,2);
    for(const part of report.parts)assert.match(part.source.sha256,/^[a-f0-9]{64}$/);
    assert.equal(report.parts[0].source.path,'part-0/report.json.gz');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
