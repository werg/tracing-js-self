import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

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
test('a fatal campaign write aborts and drains detached workers before closing evidence',t=>{
  const out=directory(t),support=directory(t),events=join(support,'events.jsonl');
  const wrapper=join(support,'fail-record.mjs');
  const worker=resolve('tools/generation-worker.mjs');
  writeFileSync(wrapper,`
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
import {CampaignStore} from ${JSON.stringify(pathToFileURL(resolve('src/corpus/campaign-store.mjs')).href)};
const event=value=>appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n');
const originalSpawn=childProcess.spawn;let launches=0;
childProcess.spawn=function(command,args,options){
  const generation=command===process.execPath&&args.includes(${JSON.stringify(worker)});
  if(generation&&launches++>0)args=[args[0],'--input-type=module','--eval',
    'await new Promise(resolve=>setTimeout(resolve,5000));await import('+${JSON.stringify(JSON.stringify(pathToFileURL(worker).href))}+')'];
  const child=originalSpawn(command,args,options);
  if(generation){event({kind:'started',pid:child.pid});
    child.once('close',(code,signal)=>event({kind:'closed',pid:child.pid,code,signal}));}
  return child;
};
syncBuiltinESMExports();
const record=CampaignStore.prototype.record,close=CampaignStore.prototype.close;let failed=false;
CampaignStore.prototype.record=function(...args){
  if(!failed){failed=true;throw new Error('Injected campaign write failure');}
  return record.apply(this,args);
};
CampaignStore.prototype.close=function(...args){event({kind:'campaign-closed'});return close.apply(this,args);};
try{await import(${JSON.stringify(pathToFileURL(resolve('tools/generate-effectful-training.mjs')).href)});}
catch(error){event({kind:'rejected',reason:error.message});process.exitCode=1;}
`);
  const result=spawnSync(process.execPath,[wrapper,'--out',out,'--jobs','3','--limit','3'],
    {encoding:'utf8',timeout:30000,maxBuffer:1048576});
  assert.equal(result.status,1,result.stderr);
  const recorded=readFileSync(events,'utf8').trim().split('\n').map(JSON.parse);
  const started=recorded.filter(row=>row.kind==='started'),closed=recorded.filter(row=>row.kind==='closed');
  assert.equal(started.length,3);assert.equal(closed.length,3);
  assert.ok(closed.some(row=>row.signal==='SIGKILL'));
  const closeIndex=recorded.findIndex(row=>row.kind==='campaign-closed');
  assert.ok(closeIndex>recorded.findLastIndex(row=>row.kind==='closed'),JSON.stringify(recorded));
  assert.equal(recorded.at(-1).kind,'rejected');assert.match(recorded.at(-1).reason,/Injected campaign write failure/);
  assert.equal(existsSync(join(out,'manifest.json')),false);
  assert.deepEqual(readdirSync(join(out,'.workers')),[]);
  const entries=readFileSync(join(out,'campaign.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length,2);assert.ok(entries.every(entry=>entry.status==='cancelled'));
});
