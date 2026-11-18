#!/usr/bin/env node
// Inspect original evidence read-only. A fresh inventory is not a new receipt.
import {readFileSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {CampaignStore,sha256} from '../src/corpus/campaign-store.mjs';
import {auditAffectedAssignments,summarizeAffectedAssignments} from '../src/training/affected-assignment-audit.js';

export async function auditInput(input,{tracerRoot=null}={}){
  input=resolve(input);
  if(statSync(input).isFile()){
    const bytes=readFileSync(input),document=JSON.parse(bytes);
    const episodes=Array.isArray(document)?document:[document];
    return summarizeAffectedAssignments(episodes.map((episode,index)=>auditAffectedAssignments(episode,
      {id:(episode?.sidecar?.taskId??'episode')+'#'+(index+1)})),
    {inventory:{kind:'supplied-episode-files',fileSha256:sha256(bytes),suppliedRows:episodes.length,
      historicalCampaignPopulation:null}});
  }
  const header=JSON.parse(readFileSync(join(input,'campaign.json'),'utf8'));
  const manifestBytes=readFileSync(join(input,'manifest.json')),
    manifest=JSON.parse(manifestBytes);
  let Reader=CampaignStore,readerRevision=null;
  if(tracerRoot!==null){
    tracerRoot=resolve(tracerRoot);
    readerRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:tracerRoot,encoding:'utf8'}).trim();
    if(readerRevision!==manifest.producerRevision)
      throw new Error('Historical campaign reader must use the exact producing revision');
    execFileSync('git',['diff','--quiet','HEAD','--'],{cwd:tracerRoot});
    ({CampaignStore:Reader}=await import(pathToFileURL(join(tracerRoot,'src/corpus/campaign-store.mjs')).href));
  }
  const campaign=new Reader(input,header.identity,{resume:true,readOnly:true,recoverTornLog:false,
    maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
  try{
    if(manifest.campaign?.identityDigest!==campaign.identityDigest)
      throw new Error('Historical manifest/campaign identity mismatch');
    const seen=new Set();
    for(const item of manifest.cases){
      const entry=campaign.latest.get(item.id);
      if(!entry||seen.has(item.id)||entry.status!==item.status||entry.candidateDigest!==item.candidateDigest)
        throw new Error('Historical manifest/log disagreement: '+item.id);
      seen.add(item.id);
    }
    if(seen.size!==campaign.latest.size)throw new Error('Manifest omits durable candidate identities');
    const rows=[];
    for(const entry of campaign.entries){
      if(!entry.public&&!['admitted','locally_verified'].includes(entry.status))continue;
      const exported=entry.public?campaign.exported(entry):null;
      const row=auditAffectedAssignments(exported,{id:entry.id+'#'+entry.attempt,
        producerRevision:manifest.producerRevision});
      Object.assign(row,{candidateId:entry.id,attempt:entry.attempt,
        candidateDigest:entry.candidateDigest,entryDigest:entry.entryDigest,sourceStatus:entry.status});
      rows.push(row);
    }
    return summarizeAffectedAssignments(rows,{inventory:{kind:'all-historical-positive-attempts',
      campaignIdentity:campaign.identityDigest,manifestSha256:sha256(manifestBytes),
      producerRevision:manifest.producerRevision,readerRevision,
      attempts:campaign.entries.length,candidates:campaign.latest.size,
      positiveAttempts:rows.length,nonPositiveAttempts:campaign.entries.length-rows.length}});
  }finally{campaign.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{input:{type:'string'},out:{type:'string'},'tracer-root':{type:'string'}}});
  if(!values.input)throw new Error('Usage: audit-affected-assignments.mjs --input EPISODE.json|CAMPAIGN_DIR [--out NEW.json] [--tracer-root EXACT_HISTORICAL_CHECKOUT]');
  if(values.out&&existsSync(resolve(values.out)))throw new Error('Audit output must be a new file; original evidence is immutable');
  const report=await auditInput(values.input,{tracerRoot:values['tracer-root']??null});
  const bytes=JSON.stringify(report,null,2)+'\n';
  if(values.out)writeFileSync(resolve(values.out),bytes,{flag:'wx'});
  else process.stdout.write(bytes);
}
