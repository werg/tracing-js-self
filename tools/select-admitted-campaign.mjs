#!/usr/bin/env node
// Select already admitted bytes for the native consumer without rewriting an
// identity, a frozen split, or a receipt. Keep the full campaign for audit.
import {readFileSync,existsSync,readdirSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {CampaignStore,atomicWrite,sha256} from '../src/corpus/campaign-store.mjs';
import {balanceFamilyTokens} from '../src/corpus/source-registry.mjs';
import {verifyNativeBinding} from '../src/training/effectful-admit.js';

// Every private input consumed by semantic_harness_v5, except lineage.task_id.
// The complete public document and native codec/physical limits are bound
// separately. Ancestor order is deliberately retained: the native Lineage
// tuple preserves it, so sorting here would hide changed episode metadata.
export function nativeEpisodeMetadata(side){
  if(typeof side?.sourceFamily!=='string'||!side.sourceFamily||side.sourceLineage!==side.sourceFamily||
    !Array.isArray(side.ancestorIds)||side.ancestorIds.some(value=>typeof value!=='string'||!value))
    throw new Error('Exact-public selection requires explicit native family and ancestor metadata');
  return {schema:side.schema,representation:side.representation,admission:side.admission,
    referenceStatus:side.referenceStatus,selectionOrigin:side.selectionOrigin,
    lineage:{familyId:side.sourceLineage,ancestorIds:[...side.ancestorIds],
      parentEpisodeId:side.parentEpisodeId??null,split:side.split}};
}

// Exact public aliases can have distinct private task IDs. The native adapter
// derives episode identity from the public stream, so feeding both unchanged
// task lineages to its immutable episode store is correctly refused. Select a
// representative before native preparation, retaining every alias in the audit.
export function exactPublicRepresentatives(rows){
  const groups=new Map(),selected=[],aliases=[],representatives=[];
  for(const row of [...rows].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){
    if(typeof row.episodeDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.episodeDigest))
      throw new Error('Exact-public selection requires authenticated public digests');
    const group=groups.get(row.episodeDigest)??[];group.push(row);groups.set(row.episodeDigest,group);
  }
  for(const [episodeDigest,group] of groups){
    const representative=group[0];
    if(group.length>1){
      const fields=['componentPolicy','sourceCluster','registryDigest','split','nativeContractDigest',
        'nativeEpisodeMetadataDigest'];
      if(representative.componentPolicy!=='source-components/1'||
        typeof representative.sourceCluster!=='string'||typeof representative.registryDigest!=='string'||
        typeof representative.nativeContractDigest!=='string'||
        typeof representative.nativeEpisodeMetadataDigest!=='string'||
        group.some(row=>fields.some(field=>row[field]!==representative[field]))){
        const error=new Error('Exact public aliases have incompatible frozen component, split, native episode metadata, or native contract');
        error.code='EXACT_PUBLIC_ALIAS_CONFLICT';
        error.details={episodeDigest,members:group.map(row=>({id:row.id,sourceCluster:row.sourceCluster,
          split:row.split,registryDigest:row.registryDigest,nativeContractDigest:row.nativeContractDigest,
          nativeEpisodeMetadataDigest:row.nativeEpisodeMetadataDigest}))};
        throw error;
      }
      representatives.push({episodeDigest,representativeId:representative.id,
        representativeIdentityDigest:representative.identityDigest,componentId:representative.sourceCluster,
        registryDigest:representative.registryDigest,split:representative.split,
        nativeContractDigest:representative.nativeContractDigest,
        nativeEpisodeMetadataDigest:representative.nativeEpisodeMetadataDigest,
        declaredFamilies:[...new Set(group.map(row=>row.family))].sort(),
        aliases:group.slice(1).map(row=>row.id)});
      for(const row of group.slice(1))aliases.push({row,representative});
    }
    selected.push(representative);
  }
  return {selected,aliases,representatives};
}

export async function selectAdmittedCampaign({input,output,maxFamilyTokens=Number.MAX_SAFE_INTEGER,
    maxFamilyShare=1,split='all',deduplicateExactPublic=false,tracerRoot=null}={}){
  input=resolve(input);output=resolve(output);
  if(input===output||existsSync(output)&&readdirSync(output).length)
    throw new Error('Selection requires a new output directory distinct from the complete campaign');
  if(!['all','train','validation','test'].includes(split))throw new Error('Invalid requested split');
  if(typeof deduplicateExactPublic!=='boolean')throw new Error('Exact-public representative selection must be explicitly boolean');
  const header=JSON.parse(readFileSync(join(input,'campaign.json'),'utf8'));
  const sourceBytes=readFileSync(join(input,'manifest.json')),
    sourceManifest=JSON.parse(sourceBytes.toString('utf8'));
  let Store=CampaignStore,verifyBinding=verifyNativeBinding,producerVerifier=null;
  if(tracerRoot!==null){
    tracerRoot=resolve(tracerRoot);
    const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:tracerRoot,encoding:'utf8'}).trim();
    if(revision!==sourceManifest.producerRevision)
      throw new Error('Historical selection requires the exact immutable producing checkout');
    execFileSync('git',['diff','--quiet','HEAD','--'],{cwd:tracerRoot});
    const [storage,admission]=await Promise.all([
      import(pathToFileURL(join(tracerRoot,'src/corpus/campaign-store.mjs')).href),
      import(pathToFileURL(join(tracerRoot,'src/training/effectful-admit.js')).href)]);
    Store=storage.CampaignStore;verifyBinding=admission.verifyNativeBinding;
    producerVerifier={root:tracerRoot,revision,trackedFilesClean:true,
      sourceEnvironmentChecksUnchanged:true};
  }
  const campaign=new Store(input,header.identity,{resume:true,recoverTornLog:false,
    maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
  if(sourceManifest.campaign?.identityDigest!==campaign.identityDigest)
    throw new Error('Manifest and campaign identity disagree');
  mkdirSync(output,{recursive:true});
  const eligible=[],exclusions=[],originalRows=new Map();
  const exclude=(entry,status,reason,evidence={})=>{
    const result=campaign.readObject(entry.result);
    const failurePath=result.failure?'refusals/'+entry.id+'.json.gz':null;
    if(failurePath)atomicWrite(join(output,failurePath),gzipSync(JSON.stringify({id:entry.id,
      candidateDigest:entry.candidateDigest,failure:result.failure})+'\n'));
    exclusions.push({id:entry.id,sourceStatus:entry.status,status,reason,
      candidateDigest:entry.candidateDigest,sourceEntryDigest:entry.entryDigest,
      resultReference:entry.result,...(failurePath?{failurePath}: {}),...evidence});
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
      verifyBinding(exported,header.identity.nativePolicy);
      const native=side.nativeAdmission,episodeMetadata=nativeEpisodeMetadata(side),
        metadataDigest=sha256(JSON.stringify(episodeMetadata));
      eligible.push({id:entry.id,status:'admitted',sourceCluster:side.splitIdentity.componentId,
        componentPolicy:side.splitIdentity.policy,
        registryDigest:side.splitIdentity.registryDigest,episodeDigest:row.episodeDigest,
        identityDigest:side.identityDigest,taskId:side.taskId,ancestorIds:side.ancestorIds,
        provenanceDigest:sha256(JSON.stringify(side.sourceProvenance)),
        nativeReceiptDigest:side.nativeBinding.receiptDigest,
        nativeEpisodeMetadataDigest:metadataDigest,
        nativeContractDigest:sha256(JSON.stringify({producerRevision:side.producerRevision,
          environment:side.environment,representation:side.representation,license:side.license,trustTier:side.trustTier,
          nativePolicyDigest:side.nativeBinding.policyDigest,consumerRevision:native.consumerRevision,
          tokenizerIdentity:native.tokenizerIdentity,tokenizerSha256:native.tokenizerSha256,
          contractDigest:native.contractDigest,schemaDigest:native.schemaDigest,fixtureDigest:native.fixtureDigest,
          generatedTokens:native.generatedTokens,observedTokens:native.observedTokens,
          physicalRecords:native.physicalRecords,contextTransportRecords:native.contextTransportRecords,
          episodeMetadata})),
        family:side.sourceFamily,split:side.split,generatedTokens:native.generatedTokens});
    }catch(error){exclude(entry,'admission_invalid',String(error.message));}
  }
  let candidates=eligible,representatives=[];
  if(deduplicateExactPublic){
    let exact;
    try{exact=exactPublicRepresentatives(eligible);}
    catch(error){
      atomicWrite(join(output,'selection-conflicts.json'),JSON.stringify({
        schema:'semantic-exact-public-selection-conflict/1',status:'refused',sourceCampaignDigest:campaign.identityDigest,
        sourceManifestSha256:sha256(sourceBytes),originalCampaignRequiredForAudit:true,
        reason:error.message,details:error.details??null},null,2)+'\n');throw error;
    }
    candidates=exact.selected;representatives=exact.representatives;
    for(const {row,representative} of exact.aliases)exclude(campaign.latest.get(row.id),'exact_public_alias',
      'Exact public stream represented by '+representative.id,{
        representativeId:representative.id,representativeIdentityDigest:representative.identityDigest,
        episodeDigest:row.episodeDigest,identityDigest:row.identityDigest,taskId:row.taskId,
        sourceFamily:row.family,ancestorIds:row.ancestorIds,componentId:row.sourceCluster,
        registryDigest:row.registryDigest,split:row.split,provenanceDigest:row.provenanceDigest,
        nativeReceiptDigest:row.nativeReceiptDigest,nativeContractDigest:row.nativeContractDigest,
        nativeEpisodeMetadataDigest:row.nativeEpisodeMetadataDigest});
  }
  // Inspect collisions before applying a requested split: a train/test alias
  // must not disappear from the conflict check because one side was filtered.
  for(const row of candidates)if(split!=='all'&&row.split!==split)
    exclude(campaign.latest.get(row.id),'split_excluded','Requested '+split+' split');
  candidates=candidates.filter(row=>split==='all'||row.split===split);
  const balanced=balanceFamilyTokens(candidates.filter(row=>row.split==='train'),{maxFamilyTokens,maxFamilyShare});
  for(const row of balanced.refused)exclude(campaign.latest.get(row.id),'training_budget_excluded',row.reason);
  const selected=[...balanced.selected,...candidates.filter(row=>row.split!=='train')].sort((a,b)=>a.id.localeCompare(b.id));
  const selectedIdentities=new Set(selected.map(row=>row.id));
  for(const alias of exclusions)if(alias.status==='exact_public_alias')
    alias.representativeSelected=selectedIdentities.has(alias.representativeId);
  const trainingComponents=[...new Set(selected.filter(row=>row.split==='train').map(row=>row.sourceCluster))].sort()
    .map(componentId=>{const rows=selected.filter(row=>row.split==='train'&&row.sourceCluster===componentId);
      const generatedTokens=rows.reduce((n,row)=>n+row.generatedTokens,0);
      return {componentId,episodes:rows.length,declaredFamilies:[...new Set(rows.map(row=>row.family))].sort(),
        generatedTokens,shareOfTrainingTokens:generatedTokens/balanced.generatedTokens};});
  const report={schema:'semantic-admitted-selection/1',sourceCampaignDigest:campaign.identityDigest,
    producerVerifier,
    sourceManifestSha256:sha256(sourceBytes),sourceCounts:sourceManifest.counts,
    sourceCandidates:sourceManifest.cases.length,selected:selected.length,excluded:exclusions.length,
    split,budgetScope:'train-only; evaluation tokens do not subsidize a training-family cap',
    exactPublicSelection:{enabled:deduplicateExactPublic,
      policy:deduplicateExactPublic?'exact-public-within-frozen-component/2':null,
      nativeEpisodeDifferenceAllowed:['lineage.task_id'],
      representativeOrder:'lexicographic candidate ID; selected export bytes remain unchanged',
      excludedAliases:exclusions.filter(row=>row.status==='exact_public_alias').length,groups:representatives,
      nativeDedupUnchanged:true,rawAdmissionsUnchanged:true},
    maxFamilyTokens,maxFamilyShare,
    groupingPolicies:[...new Set(eligible.map(row=>row.componentPolicy))].sort(),trainingComponents,
    maximumTrainingComponentShare:Math.max(0,...trainingComponents.map(row=>row.shareOfTrainingTokens)),
    splits:Object.fromEntries(['train','validation','test'].map(name=>[name,{
      episodes:selected.filter(row=>row.split===name).length,
      declaredFamilies:new Set(selected.filter(row=>row.split===name).map(row=>row.family)).size,
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
  const flags=new Map(),allowed=new Set(['--input','--out','--max-family-tokens','--max-family-share','--split',
    '--deduplicate-exact-public','--tracer-root']);
  for(let index=2;index<process.argv.length;index++){
    const key=process.argv[index],value=process.argv[++index];
    if(!allowed.has(key)||flags.has(key)||!value||value.startsWith('--'))throw new Error('Invalid option '+key);
    flags.set(key,value);
  }
  if(!flags.has('--input')||!flags.has('--out'))throw new Error('--input and --out are required');
  if(flags.has('--deduplicate-exact-public')&&!['true','false'].includes(flags.get('--deduplicate-exact-public')))
    throw new Error('--deduplicate-exact-public must be true or false');
  const result=await selectAdmittedCampaign({input:flags.get('--input'),output:flags.get('--out'),
    maxFamilyTokens:Number(flags.get('--max-family-tokens')??Number.MAX_SAFE_INTEGER),
    maxFamilyShare:Number(flags.get('--max-family-share')??1),split:flags.get('--split')??'all',
    deduplicateExactPublic:flags.get('--deduplicate-exact-public')==='true',
    tracerRoot:flags.get('--tracer-root')??null});
  console.log(JSON.stringify({selected:result.selected,excluded:result.excluded,splits:result.splits}));
}
