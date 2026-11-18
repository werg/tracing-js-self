import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {selectRegisteredCaseIds} from '../tools/registered-case-selection.mjs';
import {trainingCandidateTasks,candidateSourceInventory} from '../src/corpus/training-candidates.mjs';
import {CampaignStore,identityHash} from '../src/corpus/campaign-store.mjs';

const tool=resolve('tools/generate-effectful-training.mjs');
const simple=['first','second','third'].map(id=>({kind:'source',fixture:{id,family:'family:'+id,args:[id]}}));
function directory(t){const path=mkdtempSync(join(tmpdir(),'registered-case-selection-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
const invoke=args=>spawnSync(process.execPath,[tool,...args],{encoding:'utf8',timeout:90000,maxBuffer:1048576});

test('case selection preserves original registered objects and catalog order',()=>{
  const before=structuredClone(simple);
  const selected=selectRegisteredCaseIds(simple,['third','first'],{recipe:'real-source'});
  assert.deepEqual(selected,[simple[0],simple[2]]);
  assert.equal(selected[0],simple[0]);assert.equal(selected[1],simple[2]);
  assert.deepEqual(simple,before);
});

test('invalid selections cannot invent, repeat, truncate, or relabel registered tasks',()=>{
  for(const ids of [[],{},null,[''],[null],['first','first'],['unknown']])
    assert.throws(()=>selectRegisteredCaseIds(simple,ids,{recipe:'real-source'}));
  assert.throws(()=>selectRegisteredCaseIds(simple,['first','third'],{recipe:'real-source',limit:1}),/cannot truncate/);
  assert.throws(()=>selectRegisteredCaseIds(simple,['first'],{recipe:'engineering'}),/only.*real-source/);
  assert.throws(()=>selectRegisteredCaseIds([{...simple[0],kind:'session'}],['first'],{recipe:'real-source'}),/session or lifecycle/);
  assert.throws(()=>selectRegisteredCaseIds([simple[0],simple[0]],['first'],{recipe:'real-source'}),/not unique/);
});

test('malformed, duplicate and unknown CLI IDs fail before output or registry writes',t=>{
  const directoryPath=directory(t),id=trainingCandidateTasks('real-source',{streams:['utilities'],perFamily:1})[0].fixture.id;
  const cases=[['malformed','[',/JSON/],['empty','[]',/nonempty/],
    ['duplicate',JSON.stringify([id,id]),/duplicate/],['unknown',JSON.stringify(['not-registered']),/unknown registered/],
    ['wrong-recipe',JSON.stringify([id]),/only.*real-source/],
    ['truncated',JSON.stringify([id,'real-utilities-4dd52bb7e01ee8083fe45cd2']),/cannot truncate/]];
  for(const [name,contents,reason] of cases){
    const file=join(directoryPath,name+'.json'),out=join(directoryPath,name+'-out'),registry=join(directoryPath,name+'-registry.json');
    writeFileSync(file,contents);
    const run=invoke(['--recipe',name==='wrong-recipe'?'engineering':'real-source',
      '--source-stream','utilities','--per-family','1','--case-ids',file,'--out',out,
      '--freeze-registry',registry,...(name==='truncated'?['--limit','1']:[])]);
    assert.notEqual(run.status,0,name);assert.match(run.stderr,reason,name);
    assert.equal(existsSync(out),false,name+' wrote its output before validation');
    assert.equal(existsSync(registry),false,name+' wrote a filtered registry before validation');
  }
});

test('filtered collection retains complete registry and identical normal-gate candidate receipts',t=>{
  const directoryPath=directory(t),tasks=trainingCandidateTasks('real-source',{streams:['utilities'],perFamily:1});
  const inventory=candidateSourceInventory(tasks),ids=tasks.slice(0,2).map(task=>task.fixture.id);
  const file=join(directoryPath,'ids.json'),registryPath=join(directoryPath,'registry.json');
  const filtered=join(directoryPath,'filtered'),prefix=join(directoryPath,'prefix');
  writeFileSync(file,JSON.stringify([...ids].reverse()));
  const common=['--recipe','real-source','--source-stream','utilities','--per-family','1','--compact-storage'];
  const first=invoke([...common,'--out',filtered,'--case-ids',file,'--freeze-registry',registryPath]);
  assert.equal(first.status,0,first.stderr);
  const second=invoke([...common,'--out',prefix,'--limit','2','--registry',registryPath]);
  assert.equal(second.status,0,second.stderr);
  const read=path=>JSON.parse(readFileSync(path,'utf8'));
  const selected=read(join(filtered,'manifest.json')),baseline=read(join(prefix,'manifest.json'));
  assert.deepEqual(selected.cases.map(row=>row.id),ids);
  assert.deepEqual(selected.counts,{attempted:2,admitted:0,locally_verified:2});
  assert.equal(selected.campaign.planned,2);
  assert.deepEqual(selected.selection.caseIds,ids);
  assert.equal(selected.selection.registeredCandidates,tasks.length);
  assert.equal(selected.selection.sourceInventoryEntries,inventory.length);
  assert.equal(selected.selection.sourceInventoryDigest,identityHash(inventory));
  assert.equal(read(registryPath).sources.length,inventory.length);
  assert.deepEqual(selected.sourceRegistry,baseline.sourceRegistry);
  const headers=[filtered,prefix].map(path=>read(join(path,'campaign.json')));
  assert.equal(headers[0].identityDigest,headers[1].identityDigest);
  const stores=[filtered,prefix].map((path,index)=>new CampaignStore(path,headers[index].identity,
    {resume:true,recoverTornLog:false}));
  for(const [index,row] of selected.cases.entries()){
    const normal=baseline.cases[index];
    for(const field of ['id','family','candidateDigest','identityDigest','episodeDigest','split','status'])
      assert.deepEqual(row[field],normal[field],row.id+' '+field);
    const entries=stores.map(store=>store.latest.get(row.id));
    assert.deepEqual(stores[0].readObject(entries[0].candidate),stores[1].readObject(entries[1].candidate));
    assert.deepEqual(stores[0].exported(entries[0]),stores[1].exported(entries[1]));
  }
});
