#!/usr/bin/env node
// Restore legacy consumer input files from checksummed public/private shards.
// This does not re-admit anything: downstream source/native gates still run.
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {CampaignStore,atomicWrite} from '../src/corpus/campaign-store.mjs';

if(process.argv.length!==3)throw new Error('Usage: node tools/materialize-campaign.mjs DIRECTORY');
const directory=resolve(process.argv[2]);
const header=JSON.parse(readFileSync(join(directory,'campaign.json'),'utf8'));
const campaign=new CampaignStore(directory,header.identity,{resume:true,
  maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
if(manifest.campaign?.identityDigest!==campaign.identityDigest)throw new Error('Manifest belongs to another campaign');
let count=0;
for(const row of manifest.cases){
  const entry=campaign.latest.get(row.id);
  if(!entry||entry.candidateDigest!==row.candidateDigest||entry.status!==row.status)
    throw new Error('Manifest and durable campaign disagree: '+row.id);
  if(entry.public){row.path=campaign.materialize(entry);count++;}
}
for(const row of manifest.recipe?.lifecycleInputs??[])if(campaign.latest.get(row.id)?.public)row.path=row.id+'.json';
manifest.campaign.compatibilityExports=true;
atomicWrite(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({materialized:count,identityDigest:campaign.identityDigest,admissionUnchanged:true}));
