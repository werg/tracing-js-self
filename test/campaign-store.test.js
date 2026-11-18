import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,appendFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CampaignStore,identityHash} from '../src/corpus/campaign-store.mjs';

const identity={producer:'a'.repeat(40),runtime:process.version,verifier:'v5',tokenizer:null};
const candidate={source:'"use strict"; function run(x){return x+1;}',args:[1],family:'increment'};
function temporary(t){const dir=mkdtempSync(join(tmpdir(),'semantic-campaign-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('resumes completed receipts and preserves rejected attempts without private learner data',t=>{
  const dir=temporary(t),store=new CampaignStore(dir,identity);
  const exported={public:{timeline:[{kind:'semantic',line:'visible'}]},sidecar:{secret:'private proof'}};
  store.record('one',candidate,{status:'locally_verified',exported},{durationMs:14,peakRssBytes:100});
  store.record('two',{...candidate,args:[2]},{status:'reference_mismatch',reason:'disagreement'});
  const resumed=new CampaignStore(dir,identity,{resume:true});
  const entry=resumed.cached('one',candidate);
  assert.deepEqual(resumed.exported(entry),exported);
  assert.equal(readFileSync(join(dir,entry.public.path),'utf8').includes('private proof'),false);
  assert.equal(resumed.cached('two',{...candidate,args:[2]},{retryFailures:true}),null);
  resumed.record('two',{...candidate,args:[2]},{status:'unsupported',reason:'still refused'});
  assert.equal(resumed.latest.get('two').attempt,2);
  assert.equal(resumed.entries.length,3);
  assert.equal(resumed.readObject(resumed.entries[1].result).reason,'disagreement');
  assert.throws(()=>resumed.cached('one',{...candidate,args:[3]}),/Candidate changed/);
  assert.throws(()=>new CampaignStore(dir,{...identity,tokenizer:'changed'},{resume:true}),/identity changed/);
});
test('recovers a torn final log append but refuses committed corruption',t=>{
  const dir=temporary(t),store=new CampaignStore(dir,identity);
  const entry=store.record('one',candidate,{status:'unsupported',reason:'original failure'});
  appendFileSync(join(dir,'campaign.jsonl'),'{"interrupted":');
  const resumed=new CampaignStore(dir,identity,{resume:true});
  assert.equal(resumed.latest.size,1);
  assert.equal(readdirSync(join(dir,'recovery')).length,1);
  const object=join(dir,entry.result.path),bytes=readFileSync(object);
  bytes[bytes.length-1]^=1;writeFileSync(object,bytes);
  assert.throws(()=>new CampaignStore(dir,identity,{resume:true}),/checksum/);
});
test('log order is authenticated and candidate identity preserves special numbers and aliases',t=>{
  const dir=temporary(t),store=new CampaignStore(dir,identity);
  store.record('one',candidate,{status:'unsupported'});
  store.record('two',{...candidate,args:[2]},{status:'unsupported'});
  const path=join(dir,'campaign.jsonl'),lines=readFileSync(path,'utf8').trim().split('\n');
  writeFileSync(path,lines.reverse().join('\n')+'\n');
  assert.throws(()=>new CampaignStore(dir,identity,{resume:true}),/reordered/);
  assert.notEqual(identityHash([undefined]),identityHash([null]));
  assert.notEqual(identityHash([-0]),identityHash([0]));
  const a={x:1};assert.notEqual(identityHash([a,a]),identityHash([{x:1},{x:1}]));
  assert.equal(identityHash({b:1,a:2}),identityHash({a:2,b:1}));
});
