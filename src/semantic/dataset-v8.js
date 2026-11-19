// Export whole source-checked v8 executions and their causal training rows.
// Every input candidate gets a disposition, including unregistered refusals.
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hashAlgorithmData} from './program.js';
import {REGION_TRACE_VERSION,REGION_CONTEXT_VERSION,REGION_PROFILE} from './regions.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST} from './native-v8.js';
import {buildCausalLmV8Examples,CAUSAL_LM_V8_BRIDGE_VERSION} from './causal-lm-v8.js';
import {buildRegionFamilyRegistry,verifyRegionFamilyRegistry,regionSplitIdentity,
  verifyRegionSplitIdentity,validateRegionFamilyAssignments,regionArtifactSource,
  regionDatasetBinding,verifyRegionDatasetBinding,REGION_FAMILY_REGISTRY_SCHEMA,
  REGION_FAMILY_SPLIT_SCHEMA,REGION_DATASET_SPLITS} from './family-registry-v8.js';

export const REGION_DATASET_SCHEMA='semantic-training-dataset/8';
export const REGION_DATASET_DISPOSITION_SCHEMA='semantic-region-dataset-disposition/1';
const clean=value=>JSON.parse(JSON.stringify(value));
const digest=value=>hashAlgorithmData(clean(value));
const fail=message=>{throw new TypeError('Region dataset: '+message);};
const text=value=>typeof value==='string'&&value.length>0;
const sourceAccepted=status=>['locally_verified','admitted','detailed-fallback'].includes(status);
const normalizeAncestors=(values,family)=>{
  if(!Array.isArray(values)||values.some(value=>!text(value)))fail('invalid declared source ancestry');
  return [...new Set(values.filter(value=>value!==family))].sort();
};
const bySplit=()=>Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,[]]));
const splitCounts=()=>Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,0]));

/** Prefer source evidence over labels on an envelope or its result. */
export function regionFamilyMembership(candidate,index=0){
  const artifact=candidate?.exported??candidate,side=artifact?.sidecar;
  const hasArtifact=Boolean(artifact?.public&&side);
  let source,entry,family,ancestors,coreDigest;
  if(hasArtifact){
    ({source,entry,family,ancestors,coreDigest}=regionArtifactSource(artifact));
    for(const key of ['source','entry','family'])if(candidate?.[key]!==undefined&&
      candidate[key]!==({source,entry,family})[key])fail('candidate relabels independently checked '+key);
    for(const key of ['ancestors','ancestorIds'])if(candidate?.[key]!==undefined&&
      !isDeepStrictEqual(normalizeAncestors(candidate[key],family),ancestors))
      fail('candidate changes independently checked source ancestry');
  }else{
    source=candidate?.source;entry=candidate?.entry;family=candidate?.family??candidate?.sourceFamily;
    ancestors=normalizeAncestors(candidate?.ancestors??candidate?.ancestorIds??[],family);
    coreDigest=candidate?.coreDigest;
  }
  const existingIdentity=side?.splitIdentity??candidate?.splitIdentity;
  const exactSource=text(source)&&text(entry)&&text(family);
  if(existingIdentity!==undefined&&!exactSource)fail('pre-bound source identity lacks its exact source evidence');
  const status=candidate?.status??side?.admission??'unqualified';
  const candidateId=candidate?.id??side?.taskId??side?.sourceArtifact?.sidecar?.taskId??null;
  const episodeDigest=hasArtifact?digest(artifact.public):null;
  let id;
  if(existingIdentity!==undefined){
    if(existingIdentity?.schema!==REGION_FAMILY_SPLIT_SCHEMA)fail('pre-bound candidate has a legacy or unknown split');
    id=existingIdentity.sourceId;
    verifyRegionSplitIdentity(existingIdentity,{id,family,ancestors,source,entry,coreDigest});
  }else if(exactSource){
    const label=text(candidateId)?candidateId:family;
    id=label.slice(0,180)+':'+digest({source,entry,family,episodeDigest}).slice(0,40);
  }else id='unregistered:'+index;
  return {index,id,candidateId:text(candidateId)?candidateId:null,family:text(family)?family:null,
    source:text(source)?source:null,entry:text(entry)?entry:null,ancestors,coreDigest,
    exactSource,episodeDigest,qualified:hasArtifact&&exactSource&&sourceAccepted(status),status,
    reason:candidate?.reason??(!exactSource?'Exact source, entry or original family is missing':null),
    category:candidate?.category??null,phase:candidate?.phase??null,
    splitIdentity:existingIdentity??null,artifact:hasArtifact?artifact:null,candidate};
}

/** Frozen registries may be reused by subsets, but never replaced or expanded. */
export function resolveRegionFamilyRegistry(members,options={}){
  if(!Array.isArray(members)||!members.length)fail('complete candidate inventory required');
  const sourceMembers=members.filter(member=>member.exactSource&&!member.duplicateOf);
  if(!sourceMembers.length){
    if(!Number.isSafeInteger(options.seed))fail('explicit split seed required even when every candidate is refused');
    for(const key of ['families','sourceDigests','coreDigests'])if((options[key]??[]).length)
      fail('explicit holdouts cannot refer to an empty source inventory');
    return {registry:null,identityById:new Map(),members};
  }
  const bound=sourceMembers.filter(member=>member.splitIdentity);
  if(bound.length&&bound.length!==sourceMembers.length)fail('bound and unbound sources cannot share a dataset inventory');
  let registry;
  if(bound.length){
    registry=bound[0].splitIdentity.registry;verifyRegionFamilyRegistry(registry);
    if(Object.hasOwn(options,'seed')&&options.seed!==registry.seed)fail('a frozen split seed cannot be replaced');
    for(const key of ['families','sourceDigests','coreDigests'])if(Object.hasOwn(options,key)){
      if(!Array.isArray(options[key])||options[key].some(value=>!text(value))||
        new Set(options[key]).size!==options[key].length||
        !isDeepStrictEqual([...options[key]].sort(),registry.holdouts[key]))
        fail('frozen holdouts cannot be replaced: '+key);
    }
    for(const member of bound)if(!isDeepStrictEqual(member.splitIdentity.registry,registry))
      fail('candidates contain mixed immutable registries');
  }else registry=buildRegionFamilyRegistry(sourceMembers,options);
  const identityById=new Map();
  for(const member of sourceMembers){
    const identity=regionSplitIdentity(registry,member);
    if(member.splitIdentity&&!isDeepStrictEqual(identity,member.splitIdentity))fail('frozen membership changed');
    identityById.set(member.id,identity);
  }
  validateRegionFamilyAssignments(registry,sourceMembers.map(member=>({...member,
    split:identityById.get(member.id).split,splitIdentity:identityById.get(member.id)})));
  return {registry,identityById,members};
}
export function prepareRegionFamilyRegistry(candidates,options={}){
  if(!Array.isArray(candidates)||!candidates.length||candidates.length>20000)
    fail('one to 20000 candidates are required');
  const seen=new Map(),members=candidates.map((candidate,index)=>{
    const member=regionFamilyMembership(candidate,index),prior=seen.get(member.id);
    if(prior){
      for(const key of ['family','source','entry','ancestors','episodeDigest','splitIdentity'])
        if(!isDeepStrictEqual(member[key],prior[key]))fail('duplicate source identity has different evidence');
      member.duplicateOf=prior.index+1;
    }else seen.set(member.id,member);
    return member;
  });
  return resolveRegionFamilyRegistry(members,options);
}

export function bindRegionFamilySplit(candidate,membership,registry){
  const artifact=membership.artifact??candidate?.exported??candidate;
  const source=regionArtifactSource(artifact);
  for(const key of ['family','source','entry','ancestors'])if(!isDeepStrictEqual(source[key],membership[key]))
    fail('exact source membership differs before binding');
  const identity=regionSplitIdentity(registry,membership),bound=structuredClone(artifact);
  const binding=regionDatasetBinding(bound,identity);
  if(bound.sidecar.splitIdentity!==undefined){
    if(!isDeepStrictEqual(bound.sidecar.splitIdentity,identity))fail('an existing split identity cannot be replaced');
    verifyRegionDatasetBinding(bound,{expectedSplit:identity.split});return bound;
  }
  if(['split','sourceComponent','familyRegistryDigest','datasetBinding'].some(key=>Object.hasOwn(bound.sidecar,key)))
    fail('an incomplete or legacy dataset binding cannot be overwritten');
  Object.assign(bound.sidecar,{splitIdentity:identity,split:identity.split,
    sourceComponent:identity.componentId,familyRegistryDigest:registry.digest,datasetBinding:binding});
  verifyRegionDatasetBinding(bound,{expectedSplit:identity.split});return bound;
}

function configuration(options){
  const {tokenizer,eosTokenId,maxContextTokens,allowLocal=false,maxExamplesPerEpisode=4096}=options;
  if(typeof allowLocal!=='boolean')fail('allowLocal must be an explicit boolean');
  if(!tokenizer||!/^[a-f0-9]{64}$/.test(tokenizer.identity??'')||typeof tokenizer.encode!=='function'||
    typeof tokenizer.decode!=='function'||!Number.isSafeInteger(eosTokenId)||eosTokenId<0)
    fail('exact pinned lossless tokenizer and EOS are required');
  if(!Number.isSafeInteger(maxContextTokens)||maxContextTokens<2||
    !Number.isSafeInteger(maxExamplesPerEpisode)||maxExamplesPerEpisode<1)
    fail('explicit positive context and episode budgets are required');
  const evidence=options.tokenizerEvidence??tokenizer.evidence;
  if(evidence!==undefined&&evidence!==null&&evidence.identity?.fingerprint!==tokenizer.identity)
    fail('tokenizer evidence differs from the selected codec identity');
  return {tokenizer,eosTokenId,maxContextTokens,allowLocal,maxExamplesPerEpisode};
}
function disposition(member,identity,extra){
  return {schema:REGION_DATASET_DISPOSITION_SCHEMA,index:member.index,id:member.id,
    candidateId:member.candidateId,family:member.family,ancestors:member.ancestors,
    sourceStatus:member.status,sourceQualified:member.qualified,
    sourceDigest:identity?.sourceDigest??null,coreDigest:identity?.coreDigest??null,
    registryDigest:identity?.registryDigest??null,componentId:identity?.componentId??null,
    split:identity?.split??null,examples:0,generatedTokens:0,nativeAdmitted:false,
    optimizerSteps:0,learningClaim:null,...extra};
}

/** No partial episode or failed admission is silently retained as training data. */
export async function buildRegionDataset(candidates,options={}){
  const settings=configuration(options),{tokenizer,eosTokenId,maxContextTokens,allowLocal,maxExamplesPerEpisode}=settings;
  const registryOptions={};
  for(const key of ['seed','families','sourceDigests','coreDigests'])
    if(Object.hasOwn(options,key))registryOptions[key]=options[key];
  const prepared=prepareRegionFamilyRegistry(candidates,registryOptions);
  const examplesBySplit=bySplit(),artifactsBySplit=bySplit(),dispositions=[];
  for(const member of prepared.members){
    const identity=prepared.identityById.get(member.id);
    if(member.duplicateOf){
      dispositions.push(disposition(member,identity,{status:'duplicate',phase:'inventory',category:'duplicate-candidate',
        reason:'Exact candidate already appears at index '+(member.duplicateOf-1),duplicateOf:member.duplicateOf-1}));continue;
    }
    if(!member.qualified){
      dispositions.push(disposition(member,identity,{status:'source-refused',phase:member.phase??'source',
        category:member.category??(!member.exactSource?'missing-source-identity':'source-unqualified'),
        reason:member.reason??'Candidate has no independently qualified v8 source evidence'}));continue;
    }
    try{
      const exported=bindRegionFamilySplit(member.candidate,member,prepared.registry);
      let nativeReceipt=null;
      const nativeConsumer=typeof options.nativeConsumer==='function'?async value=>{
        // A consumer receives a transport copy; it cannot mutate the source
        // evidence after the serializer has independently checked that data.
        const receipt=await options.nativeConsumer(structuredClone(value));
        nativeReceipt=structuredClone(receipt);return receipt;
      }:options.nativeConsumer??null;
      const rows=await buildCausalLmV8Examples(exported,{tokenizer,eosTokenId,maxContextTokens,allowLocal,
        maxExamples:maxExamplesPerEpisode,expectedSplit:identity.split,
        nativePolicy:options.nativePolicy??null,nativeConsumer});
      if(!rows.length)fail('source episode produced no complete generated records');
      if(!allowLocal&&rows.some(row=>row.metadata?.nativeAdmission!==true))fail('default export requires independent native admission');
      if(rows.some(row=>row.metadata?.split!==identity.split||row.metadata?.sourceId!==identity.sourceId))
        fail('causal serializer changed immutable source membership');
      const nativeAdmitted=rows.every(row=>row.metadata.nativeAdmission===true);
      if(nativeAdmitted){
        if(nativeReceipt===null)fail('independent native receipt was not retained');
        exported.sidecar.nativeAdmission=nativeReceipt;exported.sidecar.admission='admitted';
      }
      const artifactRow={schema:'semantic-region-dataset-artifact/1',id:member.id,candidateId:member.candidateId,
        family:member.family,ancestors:member.ancestors,sourceDigest:identity.sourceDigest,coreDigest:identity.coreDigest,
        componentId:identity.componentId,split:identity.split,sourceStatus:member.status,
        admission:allowLocal?'local-diagnostic':'native-admitted',nativeAdmitted,
        optimizerSteps:0,learningClaim:null,exported};
      examplesBySplit[identity.split].push(...rows);artifactsBySplit[identity.split].push(artifactRow);
      dispositions.push(disposition(member,identity,{status:'exported',phase:'complete',category:null,reason:null,
        examples:rows.length,generatedTokens:rows.reduce((sum,row)=>sum+row.boundaries.targetTokens+row.boundaries.terminalTokens,0),
        nativeAdmitted,compactRegions:exported.sidecar.regionCoverage.compactRegions,
        detailedRegions:exported.sidecar.regionCoverage.detailedRegions}));
    }catch(error){
      dispositions.push(disposition(member,identity,{status:'export-refused',phase:'admission-or-serialization',
        category:error.category??'v8-export-refusal',reason:String(error.message)}));
    }
  }
  const accepted=dispositions.filter(row=>row.status==='exported');
  const examples=Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,examplesBySplit[split].length]));
  const episodes=Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,artifactsBySplit[split].length]));
  const generatedTokens=splitCounts();for(const row of accepted)generatedTokens[row.split]+=row.generatedTokens;
  const counts=Object.fromEntries(['exported','source-refused','export-refused','duplicate'].map(status=>
    [status,dispositions.filter(row=>row.status===status).length]));
  const tokenizerEvidence=options.tokenizerEvidence??tokenizer.evidence??null;
  const tokenizerQualification=tokenizer.qualification??tokenizerEvidence?.qualification??null;
  const manifest={schema:REGION_DATASET_SCHEMA,traceFormat:REGION_TRACE_VERSION,contextFormat:REGION_CONTEXT_VERSION,
    representation:'mixed',profile:REGION_PROFILE,adapter:CAUSAL_LM_V8_BRIDGE_VERSION,
    contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,
    seed:prepared.registry?.seed??registryOptions.seed,registrySchema:REGION_FAMILY_REGISTRY_SCHEMA,
    registryDigest:prepared.registry?.digest??null,registryMembers:prepared.registry?.sources.length??0,
    registryComponents:prepared.registry?.components.length??0,holdouts:structuredClone(prepared.registry?.holdouts??
      {families:[],sourceDigests:[],coreDigests:[]}),
    inputCandidates:candidates.length,registeredCandidates:prepared.members.filter(row=>row.exactSource).length,
    exactSourceVariants:new Set(prepared.members.filter(row=>row.exactSource).map(row=>digest({source:row.source,entry:row.entry}))).size,
    declaredFamilies:new Set(prepared.members.map(row=>row.family).filter(Boolean)).size,
    sourceQualifiedCandidates:prepared.members.filter(row=>row.qualified&&!row.duplicateOf).length,
    dispositions:counts,dispositionRows:dispositions.length,dispositionDigest:digest(dispositions),
    refusalCount:counts['source-refused']+counts['export-refused'],duplicateCount:counts.duplicate,
    examples,episodes,generatedTokens,tokenizerIdentity:tokenizer.identity,
    tokenizerEvidence:tokenizerEvidence?clean(tokenizerEvidence):null,
    tokenizerQualification:tokenizerQualification?clean(tokenizerQualification):null,
    eosTokenId,maxContextTokens,maxExamplesPerEpisode,allowLocal,
    nativeRequired:!allowLocal,admitted:!allowLocal&&accepted.length>0&&accepted.every(row=>row.nativeAdmitted),
    nativePolicyDigest:options.nativePolicy?digest(options.nativePolicy):null,
    nativePolicy:options.nativePolicy?clean(options.nativePolicy):null,
    optimizerSteps:0,learnedSuccess:null,scope:allowLocal?'candidate-local-diagnostic':'native-admitted-v8-training'};
  return {manifest,registry:prepared.registry,examplesBySplit,artifactsBySplit,dispositions,
    failures:dispositions.filter(row=>row.status==='source-refused'||row.status==='duplicate'),
    refusals:dispositions.filter(row=>row.status==='export-refused'),
    assignments:prepared.registry?[...prepared.identityById.values()].map(identity=>({id:identity.sourceId,
      family:identity.family,sourceDigest:identity.sourceDigest,coreDigest:identity.coreDigest,
      componentId:identity.componentId,split:identity.split})):[]};
}

async function writeRows(directory,name,rows){
  const file=await open(resolve(directory,name),'wx'),hash=createHash('sha256');let bytes=0;
  try{for(const row of rows){const value=Buffer.from(JSON.stringify(row)+'\n','utf8');
    hash.update(value);bytes+=value.length;await file.writeFile(value);}}
  finally{await file.close();}
  return {file:name,rows:rows.length,bytes,sha256:hash.digest('hex')};
}
/** A manifest written last is the completion marker for a new export directory. */
export async function exportRegionDatasetJSONL(candidates,{outputDirectory,...options}={}){
  if(!text(outputDirectory))fail('a new output directory is required');
  const dataset=await buildRegionDataset(candidates,options),directory=resolve(outputDirectory);
  await mkdir(directory,{recursive:false});
  const files={};
  for(const split of REGION_DATASET_SPLITS){
    files[split]=await writeRows(directory,split+'.jsonl',dataset.examplesBySplit[split]);
    files[split+'Artifacts']=await writeRows(directory,split+'-artifacts.jsonl',dataset.artifactsBySplit[split]);
  }
  files.dispositions=await writeRows(directory,'dispositions.jsonl',dataset.dispositions);
  files.failures=await writeRows(directory,'failures.jsonl',dataset.failures);
  files.refusals=await writeRows(directory,'refusals.jsonl',dataset.refusals);
  files.registry=await writeRows(directory,'family-registry.json',[dataset.registry]);
  dataset.manifest={...dataset.manifest,files};
  await writeRows(directory,'manifest.json',[dataset.manifest]);
  return {directory,...dataset};
}
