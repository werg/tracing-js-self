import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,appendFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openQualificationProgress,mapQualificationCases} from '../src/corpus/qualification-progress.mjs';

const identity={producerRevision:'fixed-producer',populationDigest:'fixed-population',nativePolicy:null,
  bounds:{timeoutMs:1000,memoryMb:128},workers:2};
const task={kind:'source',fixture:{id:'case',source:'function run(){return 1;}',argsGraph:{roots:[]}}};
const row={id:'case',status:'locally_verified',source:'passed',native:'untested',durationMs:10,peakRssBytes:1024};
function directory(t){const parent=mkdtempSync(join(tmpdir(),'qualification-progress-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));return join(parent,'run');}

test('resume preserves refusals and completed evidence while leaving incomplete cases untested',t=>{
  const path=directory(t),run=openQualificationProgress(path,identity);
  const digest=run.save('case.source.json',{source:'exact source',contexts:[{through:3}]});
  run.complete('case',task,row,['case.source.json']);
  run.save('pending.source.json',{unfinished:true});
  const refused={...row,id:'refused',status:'unsupported',source:'unsupported'};
  run.save('refused.result.json',{status:'unsupported',reason:'declared refusal'});
  run.complete('refused',{...task,fixture:{...task.fixture,id:'refused'}},refused,['refused.result.json']);
  assert.throws(()=>openQualificationProgress(path,identity,{resume:true}),/another writer/);
  run.close();
  appendFileSync(join(path,'progress','campaign.jsonl'),'{"torn":');
  const resumed=openQualificationProgress(path,identity,{resume:true});
  try{
    assert.equal(resumed.cached('case',task).artifacts['case.source.json'],digest);
    assert.deepEqual(resumed.cached('case',task).row,row);
    assert.equal(resumed.cached('pending',{...task,fixture:{id:'pending'}}),null);
    assert.equal(resumed.cached('refused',{...task,fixture:{...task.fixture,id:'refused'}}).row.source,'unsupported');
    assert.throws(()=>resumed.cached('case',{...task,fixture:{...task.fixture,source:'changed'}}),/Candidate changed/);
  }finally{resumed.close();}
});

test('resume rejects stale revisions, changed policies or bounds, and corrupted completed bytes',t=>{
  const path=directory(t),run=openQualificationProgress(path,identity);
  run.save('case.source.json',{source:'original'});run.complete('case',task,row,['case.source.json']);run.close();
  assert.throws(()=>openQualificationProgress(path,identity),/already exists/);
  for(const changed of [{producerRevision:'different'},{nativePolicy:{consumerRevision:'different'}},
    {bounds:{timeoutMs:2000,memoryMb:128}}])
    assert.throws(()=>openQualificationProgress(path,{...identity,...changed},{resume:true}),/identity changed/);
  appendFileSync(join(path,'case.source.json'),' ');
  const resumed=openQualificationProgress(path,identity,{resume:true});
  try{assert.throws(()=>resumed.cached('case',task),/artifact changed/);}
  finally{resumed.close();}
  assert.equal(readFileSync(join(path,'case.source.json'),'utf8').endsWith(' '),true);
});

test('bounded independent jobs preserve declared result order and wait for active jobs on failure',async()=>{
  let active=0,peak=0;const completed=[];
  const results=await mapQualificationCases([30,20,10,1],2,async(value,index)=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,value));active--;completed.push(index);return index;
  });
  assert.deepEqual(results,[0,1,2,3]);assert.equal(peak,2);assert.notDeepEqual(completed,results);
  await assert.rejects(mapQualificationCases([1],0,async()=>null),/workers/);
  let settled=false,launched=0;
  await assert.rejects(mapQualificationCases([0,1,2],2,async value=>{
    launched++;if(value===0)throw new Error('failed');
    await new Promise(resolve=>setTimeout(resolve,10));settled=true;
  }),/failed/);
  // An already-running worker is always awaited before the caller may close
  // the evidence store; no third case starts after the rejection is observed.
  assert.equal(launched,2);assert.equal(settled,true);
  launched=0;settled=false;
  await assert.rejects(mapQualificationCases([0,1,2],2,async value=>{
    launched++;await new Promise(resolve=>setTimeout(resolve,value===0?1:10));
    if(value===0)throw new Error('failed');settled=true;
  }),/failed/);
  assert.equal(launched,2);assert.equal(settled,true);
});
