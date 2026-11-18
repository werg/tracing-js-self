import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,linkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CampaignStore,sha256} from '../src/corpus/campaign-store.mjs';
import {verifyReleaseCampaign} from '../tools/verify-release-campaign.mjs';

function fixture(t,{compact=false,sharedRegistry=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'release-campaign-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const producerRevision='a'.repeat(40),store=new CampaignStore(directory,{producerRevision}),cases=[];
  const registry={schema:'semantic-source-registry/1',sources:[{source:'pinned source'}],components:[]};
  for(const [id,status]of [['one','admitted'],['two','admitted'],['refused','unsupported']]){
    const candidate={id,family:'family',...(sharedRegistry?{splitIdentity:{registry}}:{})},exported=status==='admitted'?{
      public:{value:id},sidecar:{admission:status,producerRevision,sourceFamily:'family',
        split:'train',representation:'compact',identityDigest:sha256(id),
        ...(sharedRegistry?{splitIdentity:{componentId:'family',registry}}:{})}}:null;
    const details=exported?{split:'train',identityDigest:exported.sidecar.identityDigest,
      episodeDigest:sha256(JSON.stringify(exported.public)),metrics:{generatedTokens:5},
      difficulty:{},sourceCluster:'family'}:null;
    const entry=store.record(id,candidate,exported?{status,exported,campaignSummary:details}:
      {status,reason:'Deliberately outside the profile'});
    cases.push({id,family:'family',status,candidateDigest:entry.candidateDigest,
      durationMs:entry.durationMs,peakRssBytes:entry.peakRssBytes,...(exported?{
        ...details,representation:'compact',publicShard:entry.public,privateEvidence:entry.private,
        ...(compact?{}:{path:store.materialize(entry)})}:{reason:'Deliberately outside the profile'})});
  }
  const manifest={schema:'semantic-corpus-manifest/4',producerRevision,cases,
    campaign:{identityDigest:store.identityDigest,completed:cases.length},
    counts:{attempted:3,admitted:2,unsupported:1,locally_verified:0}};
  store.close();
  const save=()=>writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));save();
  return {directory,manifest,save};
}

test('release campaign receipt retains exact admissions, refusals and compact object identities',async t=>{
  for(const compact of [false,true]){
    const {directory,manifest}=fixture(t,{compact});
    const receipt=await verifyReleaseCampaign(directory);
    assert.equal(receipt.status,'verified');assert.equal(receipt.attempted,3);
    assert.equal(receipt.attempts,3);assert.deepEqual(receipt.counts,{admitted:2,unsupported:1});
    assert.equal(receipt.dispositions[2].reason,'Deliberately outside the profile');
    assert.equal(receipt.dispositions[0].episodeDigest,manifest.cases[0].episodeDigest);
    assert.equal(receipt.manifestSha256,sha256(readFileSync(join(directory,'manifest.json'))));
  }
});

test('release inventory includes shared registry objects required to rehydrate all original evidence',async t=>{
  const {directory}=fixture(t,{compact:true,sharedRegistry:true});
  const receipt=await verifyReleaseCampaign(directory);
  const registries=receipt.objects.filter(ref=>ref.path.startsWith('objects/registries/'));
  assert.equal(registries.length,1);
  assert.equal(registries[0].sha256,sha256(readFileSync(join(directory,registries[0].path))));
  assert.equal(receipt.dispositions.length,3);
});

test('release verification rejects altered IDs, dispositions, summaries, digests and omitted refusals',async t=>{
  const attacks=[
    ['duplicate ID',m=>{m.cases[1].id=m.cases[0].id;},/duplicate/],
    ['changed disposition',m=>{m.cases[2].status='admitted';},/disposition/],
    ['public digest',m=>{m.cases[0].episodeDigest='b'.repeat(64);},/binding/],
    ['candidate digest',m=>{m.cases[0].candidateDigest='b'.repeat(64);},/digest/],
    ['summary tokens',m=>{m.cases[0].metrics.generatedTokens=6;},/summary/],
    ['omitted refusal',m=>{m.cases.pop();m.counts={attempted:2,admitted:2};m.campaign.completed=2;},/complete campaign/],
    ['surplus count',m=>{m.counts.native_rejected=1;},/counts/],
    ['refusal reason',m=>{m.cases[2].reason='accepted elsewhere';},/refusal/],
    ['duplicated path',m=>{m.cases[1].path=m.cases[0].path;},/duplicate candidate path/],
    ['path alias',m=>{m.cases[0].path='./one.json';},/noncanonical/],
  ];
  for(const [name,change,pattern]of attacks)await t.test(name,async t=>{
    const {directory,manifest,save}=fixture(t);change(manifest);save();
    await assert.rejects(verifyReleaseCampaign(directory),pattern);
  });
});

test('release verification detects materialized bytes and hardlink path aliases',async t=>{
  const changed=fixture(t);writeFileSync(join(changed.directory,'one.json'),'{}');
  await assert.rejects(verifyReleaseCampaign(changed.directory),/materialized/);
  const aliased=fixture(t);unlinkSync(join(aliased.directory,'two.json'));
  linkSync(join(aliased.directory,'one.json'),join(aliased.directory,'two.json'));
  await assert.rejects(verifyReleaseCampaign(aliased.directory),/duplicate physical/);
});
