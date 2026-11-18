import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CampaignStore,atomicWrite} from '../src/corpus/campaign-store.mjs';
import {selectAdmittedCampaign} from '../tools/select-admitted-campaign.mjs';

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
});
