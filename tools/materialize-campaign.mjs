#!/usr/bin/env node
// Restore legacy consumer input files from checksummed public/private shards.
// This does not re-admit anything: downstream source/native gates still run.
import {readFileSync,existsSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CampaignStore,atomicWrite,sha256} from '../src/corpus/campaign-store.mjs';

export function materializeCampaign(directory,{output=directory}={}){
  directory=resolve(directory);output=resolve(output);
  const external=output!==directory,path=relative(directory,output);
  if(external&&(!(path==='..'||path.startsWith('..'+sep))||
    existsSync(output)&&readdirSync(output).length))
    throw new Error('Materialization needs a new destination outside its original campaign');
  const header=JSON.parse(readFileSync(join(directory,'campaign.json'),'utf8'));
  const campaign=new CampaignStore(directory,header.identity,{resume:true,readOnly:external,recoverTornLog:false,
    maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
  try{
  const manifestBytes=readFileSync(join(directory,'manifest.json'));
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(manifest.campaign?.identityDigest!==campaign.identityDigest)throw new Error('Manifest belongs to another campaign');
  mkdirSync(output,{recursive:true});
  let count=0;
  const seen=new Set();
  for(const row of manifest.cases){
    const entry=campaign.latest.get(row.id);
    if(!entry||entry.candidateDigest!==row.candidateDigest||entry.status!==row.status||seen.has(row.id))
      throw new Error('Manifest and durable campaign disagree: '+row.id);
    seen.add(row.id);
    if(entry.public){
      row.path=entry.id+'.json';
      atomicWrite(join(output,row.path),JSON.stringify(campaign.exported(entry))+'\n');count++;
    }
  }
  if(seen.size!==campaign.latest.size)throw new Error('Manifest omits durable campaign cases');
  for(const row of manifest.recipe?.lifecycleInputs??[])if(campaign.latest.get(row.id)?.public)row.path=row.id+'.json';
  manifest.campaign.compatibilityExports=true;
  if(external){
    atomicWrite(join(output,'materialization-source-manifest.json'),manifestBytes);
    manifest.materialization={schema:'semantic-campaign-materialization/1',
      sourceCampaignDigest:campaign.identityDigest,sourceManifestSha256:sha256(manifestBytes),
      sourceCampaignRequiredForAudit:true,admissionUnchanged:true};
    Object.assign(manifest.campaign,{log:null,publicRecords:null,privateEvidence:null,sharedRegistries:null,
      sourceCampaignDigest:campaign.identityDigest,materializedFromCampaign:true});
  }
  atomicWrite(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {materialized:count,identityDigest:campaign.identityDigest,admissionUnchanged:true,
    sourceCampaignRequiredForAudit:external};
  }finally{campaign.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(!args[0]||![1,3].includes(args.length)||args.length===3&&args[1]!=='--out')
    throw new Error('Usage: node tools/materialize-campaign.mjs DIRECTORY [--out NEWDIRECTORY]');
  console.log(JSON.stringify(materializeCampaign(args[0],args.length===3?{output:args[2]}:{})));
}
