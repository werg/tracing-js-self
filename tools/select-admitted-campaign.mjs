#!/usr/bin/env node
// Select already admitted bytes for the native consumer without rewriting an
// identity, a frozen split, or a receipt. Keep the full campaign for audit.
import {readFileSync,existsSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {CampaignStore,atomicWrite,sha256} from '../src/corpus/campaign-store.mjs';
import {balanceFamilyTokens} from '../src/corpus/source-registry.mjs';
import {verifyNativeBinding} from '../src/training/effectful-admit.js';

export function selectAdmittedCampaign({input,output,maxFamilyTokens=Number.MAX_SAFE_INTEGER,
    maxFamilyShare=1,split='all'}={}){
  input=resolve(input);output=resolve(output);
  if(input===output||existsSync(output)&&readdirSync(output).length)
    throw new Error('Selection requires a new output directory distinct from the complete campaign');
  if(!['all','train','validation','test'].includes(split))throw new Error('Invalid requested split');
  const header=JSON.parse(readFileSync(join(input,'campaign.json'),'utf8'));
  const campaign=new CampaignStore(input,header.identity,{resume:true,
    maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
  const sourceBytes=readFileSync(join(input,'manifest.json')),
    sourceManifest=JSON.parse(sourceBytes.toString('utf8'));
  if(sourceManifest.campaign?.identityDigest!==campaign.identityDigest)
    throw new Error('Manifest and campaign identity disagree');
  mkdirSync(output,{recursive:true});
  const eligible=[],exclusions=[],originalRows=new Map();
  const exclude=(entry,status,reason)=>{
    const result=campaign.readObject(entry.result);
    const failurePath=result.failure?'refusals/'+entry.id+'.json.gz':null;
    if(failurePath)atomicWrite(join(output,failurePath),gzipSync(JSON.stringify({id:entry.id,
      candidateDigest:entry.candidateDigest,failure:result.failure})+'\n'));
    exclusions.push({id:entry.id,sourceStatus:entry.status,status,reason,
      candidateDigest:entry.candidateDigest,sourceEntryDigest:entry.entryDigest,
      resultReference:entry.result,...(failurePath?{failurePath}: {})});
  };
  for(const row of sourceManifest.cases){
    const entry=campaign.latest.get(row.id);
    if(!entry||entry.candidateDigest!==row.candidateDigest||entry.status!==row.status||originalRows.has(row.id))
      throw new Error('Manifest and durable candidate disagree: '+row.id);
    originalRows.set(row.id,row);
    if(entry.status!=='admitted'){exclude(entry,'not_admitted',campaign.readObject(entry.result).reason??'Candidate did not pass native admission');continue;}
    try{
      const exported=campaign.exported(entry),side=exported?.sidecar;
      if(side?.admission!=='admitted'||side.selectionOrigin!=='certified_teacher'||
        row.episodeDigest!==sha256(JSON.stringify(exported.public))||row.identityDigest!==side.identityDigest)
        throw new Error('Manifest/public/private admission binding changed');
      verifyNativeBinding(exported,header.identity.nativePolicy);
      if(split!=='all'&&side.split!==split){exclude(entry,'split_excluded','Requested '+split+' split');continue;}
      eligible.push({id:entry.id,status:'admitted',sourceCluster:side.splitIdentity.componentId,
        family:side.sourceFamily,split:side.split,generatedTokens:side.nativeAdmission.generatedTokens});
    }catch(error){exclude(entry,'admission_invalid',String(error.message));}
  }
  const balanced=balanceFamilyTokens(eligible.filter(row=>row.split==='train'),{maxFamilyTokens,maxFamilyShare});
  for(const row of balanced.refused)exclude(campaign.latest.get(row.id),'training_budget_excluded',row.reason);
  const selected=[...balanced.selected,...eligible.filter(row=>row.split!=='train')].sort((a,b)=>a.id.localeCompare(b.id));
  const report={schema:'semantic-admitted-selection/1',sourceCampaignDigest:campaign.identityDigest,
    sourceManifestSha256:sha256(sourceBytes),sourceCounts:sourceManifest.counts,
    sourceCandidates:sourceManifest.cases.length,selected:selected.length,excluded:exclusions.length,
    split,budgetScope:'train-only; evaluation tokens do not subsidize a training-family cap',
    maxFamilyTokens,maxFamilyShare,
    splits:Object.fromEntries(['train','validation','test'].map(name=>[name,{
      episodes:selected.filter(row=>row.split===name).length,
      sourceComponents:new Set(selected.filter(row=>row.split===name).map(row=>row.sourceCluster)).size,
      generatedTokens:selected.filter(row=>row.split===name).reduce((n,row)=>n+row.generatedTokens,0)}])),
    exclusions,originalCampaignRequiredForAudit:true,
    admission:'retained-existing-receipts; independent consumer preparation must rerun source/native gates',optimizerSteps:0};
  atomicWrite(join(output,'selection-report.json'),JSON.stringify(report,null,2)+'\n');
  atomicWrite(join(output,'selection-source-manifest.json'),sourceBytes);
  if(!selected.length)throw new Error('No native-admitted candidates survived selection; refusal report retained');
  const cases=selected.map(row=>{
    const exported=campaign.exported(campaign.latest.get(row.id)),path=row.id+'.json';
    atomicWrite(join(output,path),JSON.stringify(exported)+'\n');
    return {...originalRows.get(row.id),path};
  });
  const selectedIds=new Set(selected.map(row=>row.id)),families=new Set(selected.map(row=>row.family));
  const recipe={...sourceManifest.recipe,retainEveryAuthoredFamily:false,
    ...(sourceManifest.recipe.families?{families:sourceManifest.recipe.families.filter(family=>families.has(family))}:{}),
    ...(sourceManifest.recipe.algorithms?{algorithms:sourceManifest.recipe.algorithms.filter(row=>families.has(row.family))}:{}),
    ...(sourceManifest.recipe.lifecycleInputs?{lifecycleInputs:sourceManifest.recipe.lifecycleInputs.filter(row=>selectedIds.has(row.id))}:{})};
  // Inventory metadata remains evidence of what was attempted, not a selected
  // dataset denominator. Publish separate, exact selected-family counts.
  if(recipe.coverage){recipe.inventoryCoverage=recipe.coverage;delete recipe.coverage;}
  recipe.selectedCoverage={families:families.size,components:new Set(selected.map(row=>row.sourceCluster)).size,
    splitFamilies:Object.fromEntries(['train','validation','test'].map(name=>[name,new Set(selected.filter(row=>row.split===name).map(row=>row.family)).size]))};
  recipe.splitCounts=recipe.selectedCoverage.splitFamilies;
  const manifest={...sourceManifest,recipe,cases,counts:{attempted:cases.length,admitted:cases.length,locally_verified:0},
    counterfactuals:sourceManifest.counterfactuals.filter(row=>row.pair.every(id=>selectedIds.has(id))),
    selection:report,campaign:{...sourceManifest.campaign,sourceCampaignDigest:campaign.identityDigest,
      log:null,publicRecords:null,privateEvidence:null,completed:cases.length,planned:cases.length,
      compatibilityExports:true,selectedSubset:true},
    throughput:{measuredDuringSourceCampaign:sourceManifest.throughput,selectionDoesNotGenerateNewTokens:true}};
  atomicWrite(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const flags=new Map(),allowed=new Set(['--input','--out','--max-family-tokens','--max-family-share','--split']);
  for(let index=2;index<process.argv.length;index++){
    const key=process.argv[index],value=process.argv[++index];
    if(!allowed.has(key)||flags.has(key)||!value||value.startsWith('--'))throw new Error('Invalid option '+key);
    flags.set(key,value);
  }
  if(!flags.has('--input')||!flags.has('--out'))throw new Error('--input and --out are required');
  const result=selectAdmittedCampaign({input:flags.get('--input'),output:flags.get('--out'),
    maxFamilyTokens:Number(flags.get('--max-family-tokens')??Number.MAX_SAFE_INTEGER),
    maxFamilyShare:Number(flags.get('--max-family-share')??1),split:flags.get('--split')??'all'});
  console.log(JSON.stringify({selected:result.selected,excluded:result.excluded,splits:result.splits}));
}
