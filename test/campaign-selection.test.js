import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CampaignStore,atomicWrite} from '../src/corpus/campaign-store.mjs';
import {exactPublicRepresentatives,selectAdmittedCampaign} from '../tools/select-admitted-campaign.mjs';

test('admitted selection retains refusals and never promotes local or forged admitted flags',t=>{
  const root=mkdtempSync(join(tmpdir(),'campaign-selection-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const input=join(root,'input'),store=new CampaignStore(input,{nativePolicy:null});
  const first=store.record('local',{source:'reviewed'}, {status:'locally_verified'});
  const forged=store.record('forged',{source:'reviewed'}, {status:'admitted',
    exported:{public:{timeline:[]},sidecar:{admission:'locally_verified'}}});
  atomicWrite(join(input,'manifest.json'),JSON.stringify({schema:'semantic-corpus-manifest/4',
    campaign:{identityDigest:store.identityDigest},counts:{attempted:2,locally_verified:1,admitted:1},
    cases:[first,forged].map(entry=>({id:entry.id,status:entry.status,candidateDigest:entry.candidateDigest}))}));
  const output=join(root,'selection');
  assert.throws(()=>selectAdmittedCampaign({input,output}),/No native-admitted/);
  const report=JSON.parse(readFileSync(join(output,'selection-report.json'),'utf8'));
  assert.equal(report.selected,0);assert.equal(report.excluded,2);
  assert.deepEqual(report.exclusions.map(row=>row.status),['not_admitted','admission_invalid']);
  assert.equal(report.exactPublicSelection.enabled,false);
});

// These rows exercise selection only; they are not fabricated admission receipts.
const alias=(id,overrides={})=>({id,episodeDigest:'a'.repeat(64),identityDigest:id+'-identity',
  taskId:id,componentPolicy:'source-components/1',sourceCluster:'component:shared',
  registryDigest:'registry',split:'train',family:'source-family',nativeContractDigest:'native-contract',
  ...overrides});

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

test('aliases retain distinct original family identities inside one frozen component',()=>{
  const result=exactPublicRepresentatives([alias('a'),alias('b',{family:'linked-source-family'})]);
  assert.deepEqual(result.representatives[0].declaredFamilies,['linked-source-family','source-family']);
  assert.equal(result.aliases[0].row.family,'linked-source-family');
  assert.equal(result.aliases[0].representative.id,'a');
});
