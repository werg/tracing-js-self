import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {CampaignStore,atomicWrite,sha256,identityHash} from '../src/corpus/campaign-store.mjs';
import {exactPublicRepresentatives,nativeEpisodeMetadata,selectAdmittedCampaign} from '../tools/select-admitted-campaign.mjs';

test('admitted selection retains refusals and never promotes local or forged admitted flags',async t=>{
  const root=mkdtempSync(join(tmpdir(),'campaign-selection-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const input=join(root,'input'),store=new CampaignStore(input,{nativePolicy:null});
  const first=store.record('local',{source:'reviewed'}, {status:'locally_verified'});
  const forged=store.record('forged',{source:'reviewed'}, {status:'admitted',
    exported:{public:{timeline:[]},sidecar:{admission:'locally_verified'}}});
  atomicWrite(join(input,'manifest.json'),JSON.stringify({schema:'semantic-corpus-manifest/4',
    campaign:{identityDigest:store.identityDigest},counts:{attempted:2,locally_verified:1,admitted:1},
    cases:[first,forged].map(entry=>({id:entry.id,status:entry.status,candidateDigest:entry.candidateDigest}))}));
  store.close();
  const output=join(root,'selection');
  await assert.rejects(selectAdmittedCampaign({input,output}),/No native-admitted/);
  const report=JSON.parse(readFileSync(join(output,'selection-report.json'),'utf8'));
  assert.equal(report.selected,0);assert.equal(report.excluded,2);
  assert.deepEqual(report.exclusions.map(row=>row.status),['not_admitted','admission_invalid']);
  assert.equal(report.exactPublicSelection.enabled,false);
  await assert.rejects(selectAdmittedCampaign({input,output:join(root,'historical-selection'),
    tracerRoot:fileURLToPath(new URL('../',import.meta.url))}),/exact immutable producing checkout/);
});

// These rows exercise selection only; they are not fabricated admission receipts.
const alias=(id,overrides={})=>{
  const row={id,episodeDigest:'a'.repeat(64),identityDigest:id+'-identity',
    taskId:id,componentPolicy:'source-components/1',sourceCluster:'component:shared',
    registryDigest:'registry',split:'train',family:'source-family',ancestorIds:['source-family','ancestor'],
    parentEpisodeId:null,nativeContractDigest:'native-contract',...overrides};
  row.nativeEpisodeMetadataDigest=sha256(JSON.stringify(nativeEpisodeMetadata({
    schema:'semantic-supervision/2',representation:'compact',admission:'admitted',referenceStatus:'agreed',
    selectionOrigin:'certified_teacher',sourceFamily:row.family,sourceLineage:row.family,
    ancestorIds:row.ancestorIds,parentEpisodeId:row.parentEpisodeId,split:row.split,taskId:id})));
  return row;
};

test('exact-public representatives are deterministic and retain distinct streams unchanged',()=>{
  const z=alias('z'),a=alias('a'),different=alias('different',{episodeDigest:'b'.repeat(64)});
  const original=structuredClone([z,a,different]);
  const result=exactPublicRepresentatives([z,a,different]);
  assert.deepEqual(result.selected.map(row=>row.id),['a','different']);
  assert.equal(result.selected[0],a);
  assert.equal(result.selected[1],different);
  assert.deepEqual(result.aliases,[{row:z,representative:a}]);
  assert.deepEqual(result.representatives[0].aliases,['z']);
  assert.equal(result.representatives[0].representativeIdentityDigest,'a-identity');
  assert.deepEqual([z,a,different],original);
  assert.deepEqual(exactPublicRepresentatives([different,a,z]),result);
});

test('exact-public aliases across components, splits, registries or native contracts fail closed',()=>{
  for(const overrides of [{sourceCluster:'component:other'},{split:'test'},
    {registryDigest:'other-registry'},{nativeContractDigest:'other-native'},
    {componentPolicy:'family-hash/1'}]){
    assert.throws(()=>exactPublicRepresentatives([alias('a'),alias('b',overrides)]),error=>{
      assert.equal(error.code,'EXACT_PUBLIC_ALIAS_CONFLICT');
      assert.equal(error.details.episodeDigest,'a'.repeat(64));
      assert.deepEqual(error.details.members.map(row=>row.id),['a','b']);
      return true;
    });
  }
  assert.throws(()=>exactPublicRepresentatives([alias('a',{episodeDigest:undefined})]),/authenticated public digests/);
});

test('same-component public aliases cannot erase native family, ancestry or parent metadata',()=>{
  for(const overrides of [{family:'linked-source-family'},
    {ancestorIds:['source-family','different-ancestor']},
    {ancestorIds:['ancestor','source-family']},
    {parentEpisodeId:'native-parent-episode'}]){
    assert.throws(()=>exactPublicRepresentatives([alias('a'),alias('b',overrides)]),
      /native episode metadata/);
  }
});

test('native metadata projection ignores only private task identity and unused source annotations',()=>{
  const side={schema:'semantic-supervision/2',representation:'compact',admission:'admitted',referenceStatus:'agreed',
    selectionOrigin:'certified_teacher',sourceFamily:'family',sourceLineage:'family',ancestorIds:['family','ancestor'],
    parentEpisodeId:null,split:'train',taskId:'a',sourceProvenance:{inputIndex:0}};
  const initial=nativeEpisodeMetadata(side);
  assert.deepEqual(nativeEpisodeMetadata({...side,taskId:'b',sourceProvenance:{inputIndex:1}}),initial);
  assert.deepEqual(nativeEpisodeMetadata({...side,parentEpisodeId:undefined}),initial);
  for(const [field,value] of [['schema','semantic-supervision/other'],['representation','expanded'],
    ['admission','locally_verified'],['referenceStatus','unverified'],['selectionOrigin','model'],['split','test']])
    assert.notDeepEqual(nativeEpisodeMetadata({...side,[field]:value}),initial);
  assert.throws(()=>nativeEpisodeMetadata({...side,sourceLineage:'other-family'}),/family and ancestor/);
  assert.throws(()=>nativeEpisodeMetadata({...side,ancestorIds:undefined}),/family and ancestor/);
});

// A bounded reconstruction of the original entry/1 writer/read rules. The
// shared object is deliberately hashed before JSON serialization, exactly the
// historical behavior. These are refused/local fixture rows, never native proof.
function legacyFixture(t){
  const root=mkdtempSync(join(tmpdir(),'legacy-selection-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const producer=join(root,'producer');mkdirSync(join(producer,'src/corpus'),{recursive:true});
  mkdirSync(join(producer,'src/training'),{recursive:true});
  writeFileSync(join(producer,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(producer,'src/corpus/campaign-store.mjs'),`
import {readFileSync} from 'node:fs';
import {CampaignStore as Current,identityHash} from ${JSON.stringify(new URL('../src/corpus/campaign-store.mjs',import.meta.url).href)};
export class CampaignStore extends Current {
  readLog(){
    const bytes=readFileSync(this.logPath),end=bytes.lastIndexOf(10)+1;
    if(end!==bytes.length)throw new Error('Incomplete historical campaign log');
    for(const line of bytes.toString('utf8').split('\\n').filter(Boolean)){
      const entry=JSON.parse(line),{entryDigest,...payload}=entry;
      if(entry.schema!=='semantic-generation-entry/1'||entry.campaignDigest!==this.identityDigest||
        entry.previous!==this.previous||identityHash(payload)!==entryDigest)
        throw new Error('Corrupt historical campaign log');
      for(const ref of [entry.candidate,entry.result,entry.public,entry.private].filter(Boolean))this.readObject(ref);
      this.entries.push(entry);this.latest.set(entry.id,entry);this.previous=entryDigest;
    }
  }
}
`);
  writeFileSync(join(producer,'src/training/effectful-admit.js'),
    'export function verifyNativeBinding(){throw new Error("Fixture has no native receipts");}\n');
  const git=(...args)=>execFileSync('git',args,{cwd:producer,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','--quiet');git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Freeze legacy reader fixture');
  const revision=git('rev-parse','HEAD'),input=join(root,'campaign');
  const store=new CampaignStore(input,{nativePolicy:null});
  const shared={value:7},candidate={kind:'source',id:'legacy',left:shared,right:shared};
  const payload={schema:'semantic-generation-entry/1',id:'legacy',campaignDigest:store.identityDigest,
    candidateDigest:store.candidateDigest(candidate),attempt:1,previous:null,status:'locally_verified',
    candidate:store.putObject('candidates',candidate,{compress:true}),
    result:store.putObject('results',{status:'locally_verified'},{compress:true}),
    public:null,private:null,durationMs:1,peakRssBytes:null};
  assert.notEqual(payload.candidateDigest,store.candidateDigest(store.readObject(payload.candidate)));
  const entry={...payload,entryDigest:identityHash(payload)};
  appendFileSync(store.logPath,JSON.stringify(entry)+'\n');
  atomicWrite(join(input,'manifest.json'),JSON.stringify({schema:'semantic-corpus-manifest/4',producerRevision:revision,
    campaign:{identityDigest:store.identityDigest},counts:{attempted:1,locally_verified:1},
    cases:[{id:entry.id,status:entry.status,candidateDigest:entry.candidateDigest}]}));
  store.close();
  return {root,producer,input,payload};
}

test('legacy graph commitments require explicit pinned routing and remain byte-identical',async t=>{
  const {root,producer,input}=legacyFixture(t),before=readFileSync(join(input,'campaign.jsonl'));
  await assert.rejects(selectAdmittedCampaign({input,output:join(root,'current')}),/candidate binding changed/);
  const output=join(root,'historical');
  await assert.rejects(selectAdmittedCampaign({input,output,tracerRoot:producer}),/No native-admitted/);
  const report=JSON.parse(readFileSync(join(output,'selection-report.json'),'utf8'));
  assert.equal(report.selected,0);assert.equal(report.excluded,1);
  assert.equal(report.exclusions[0].status,'not_admitted');
  assert.equal(report.producerVerifier.campaignReader,'exact-producing-format-under-shared-lock');
  assert.match(report.producerVerifier.campaignReaderSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(join(input,'campaign.jsonl')),before);
});

test('historical routing rejects changed manifest and result bindings without rewriting evidence',async t=>{
  const {root,producer,input,payload}=legacyFixture(t);
  const writeEntry=value=>atomicWrite(join(input,'campaign.jsonl'),JSON.stringify({...value,entryDigest:identityHash(value)})+'\n');
  writeEntry({...payload,candidateDigest:'f'.repeat(64)});
  await assert.rejects(selectAdmittedCampaign({input,output:join(root,'changed-candidate'),tracerRoot:producer}),
    /Manifest and durable candidate disagree/);
  const bytes=Buffer.from(JSON.stringify({status:'unsupported'})+'\n'),hash=sha256(bytes);
  const result={path:'objects/results/'+hash+'.json',sha256:hash,contentSha256:hash,
    bytes:bytes.length,uncompressedBytes:bytes.length,encoding:'json'};
  atomicWrite(join(input,result.path),bytes);writeEntry({...payload,result});
  const before=readFileSync(join(input,'campaign.jsonl'));
  await assert.rejects(selectAdmittedCampaign({input,output:join(root,'changed-result'),tracerRoot:producer}),
    /Historical campaign result, attempt or public\/private binding changed/);
  assert.deepEqual(readFileSync(join(input,'campaign.jsonl')),before);
});
