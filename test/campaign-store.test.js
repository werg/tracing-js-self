import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,appendFileSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {CampaignStore,identityHash,sha256} from '../src/corpus/campaign-store.mjs';

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
test('shared registries are stored once and materialize byte-identical evidence including sessions',t=>{
  const dir=temporary(t),store=new CampaignStore(dir,identity);
  const registry={schema:'semantic-source-registry/1',policy:'source-components/1',
    sources:Array.from({length:512},(_,index)=>({id:'source-'+index,
      source:'function sample(){return "'+sha256('pinned-original-'+index)+'";}'})),components:[]};
  const splitIdentity={registryDigest:sha256(JSON.stringify(registry)),registry};
  const markerLikeData={schema:'semantic-campaign-source-registry-reference/1',index:0};
  const exported={public:{timeline:[{kind:'semantic',line:'visible'}]},sidecar:{splitIdentity,
    identity:{splitIdentity},collection:{components:Array.from({length:3},()=>({sidecar:{splitIdentity}}))},
    markerLikeData,...Object.fromEntries([['__proto__',{registry}]])}};
  const candidateWithRegistry={...candidate,splitIdentity};
  const entry=store.record('one',candidateWithRegistry,{status:'locally_verified',exported,
    failure:{original:{splitIdentity}}});
  store.record('two',{...candidateWithRegistry,args:[2]},{status:'locally_verified',
    exported:{...exported,sidecar:{...exported.sidecar,invocation:2}}});
  assert.equal(store.storageStatistics().byKind.registries.objects,1);
  assert.ok(entry.private.format);
  assert.equal(entry.public.format,undefined);
  assert.ok(entry.private.bytes<gzipSync(JSON.stringify(exported.sidecar)+'\n').length/2);
  const packed=JSON.parse(gunzipSync(readFileSync(join(dir,entry.private.path))));
  assert.equal(packed.registryReferences.length,6);
  assert.equal(JSON.stringify(store.exported(entry)),JSON.stringify(exported));
  assert.deepEqual(store.readObject(entry.candidate),candidateWithRegistry);
  assert.deepEqual(store.readObject(entry.result).failure.original.splitIdentity,splitIdentity);
  assert.deepEqual(store.exported(entry).sidecar.markerLikeData,markerLikeData);
  assert.equal(Object.getPrototypeOf(store.exported(entry).sidecar),Object.prototype);
  store.materialize(entry);
  assert.equal(readFileSync(join(dir,'one.json'),'utf8'),JSON.stringify(exported)+'\n');
  const resumed=new CampaignStore(dir,identity,{resume:true});
  assert.deepEqual(resumed.exported(resumed.latest.get('one')),exported);
  const legacy=store.putObject('private',exported.sidecar,{compress:true,deduplicateRegistries:false});
  assert.equal(legacy.format,undefined);
  assert.deepEqual(store.readObject(legacy),exported.sidecar);
});
test('rehydration refuses changed or missing registry bytes and mismatched logical evidence',t=>{
  const dir=temporary(t),store=new CampaignStore(dir,identity);
  const registry={schema:'semantic-source-registry/1',sources:[{source:'trusted source bytes'}],components:[]};
  const entry=store.record('one',candidate,{status:'locally_verified',
    exported:{public:{timeline:[]},sidecar:{splitIdentity:{registry}}}});
  assert.throws(()=>store.readObject({...entry.private,valueSha256:'f'.repeat(64)}),/checksum mismatch/);
  assert.throws(()=>store.readObject({...entry.private,valueBytes:entry.private.valueBytes-1}),/size changed/);
  assert.throws(()=>store.readObject({...entry.private,valueBytes:store.maxObjectBytes+1}),/bound/);
  const packed=JSON.parse(gunzipSync(readFileSync(join(dir,entry.private.path))));
  const registryPath=join(dir,packed.registryReferences[0].reference.path),original=readFileSync(registryPath);
  const changed=Buffer.from(original);changed[changed.length-1]^=1;writeFileSync(registryPath,changed);
  assert.throws(()=>store.exported(entry),/checksum/);
  assert.throws(()=>new CampaignStore(dir,identity,{resume:true}),/checksum/);
  writeFileSync(registryPath,original);
  assert.equal(store.exported(entry).sidecar.splitIdentity.registry.sources[0].source,'trusted source bytes');
  rmSync(registryPath);
  assert.throws(()=>store.exported(entry),/ENOENT/);
});
