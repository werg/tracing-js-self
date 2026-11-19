// Prepared semantic-trace/7 dataset planning and streaming export support.
// The immutable family registry is built from the complete candidate source
// inventory before any row receives a train/validation/test assignment.
import {hashAlgorithmData} from './program.js';
import {buildCausalLmV7Examples,CAUSAL_LM_V7_BRIDGE_VERSION} from './causal-lm-v7.js';
import {buildSemanticFamilyRegistry,semanticSplitIdentity,validateSemanticFamilyAssignments,
  SEMANTIC_FAMILY_REGISTRY_SCHEMA} from './family-registry.js';
import {DETAILED_TRACE_VERSION} from './detailed-v7.js';

const fail=message=>{throw new TypeError('V7 dataset: '+message);};
const text=value=>typeof value==='string'&&value.length>0;
const statusOk=value=>['locally_verified','admitted','detailed-fallback'].includes(value);

function sourceArtifactOf(candidate){
  const exported=candidate?.exported??candidate;
  return {exported,sourceArtifact:exported?.sidecar?.sourceArtifact??
    (exported?.sidecar?.archive?exported:null)};
}

/** Pull registry identity from exact source evidence; never trust a row label. */
export function semanticFamilyMembership(candidate,index=0){
  const {exported,sourceArtifact}=sourceArtifactOf(candidate);
  const privateSide=sourceArtifact?.sidecar??{};
  const source=privateSide.referenceInput?.source??sourceArtifact?.public?.timeline?.find(row=>row.kind==='program')?.source??
    candidate?.source;
  const entry=privateSide.referenceInput?.entry??sourceArtifact?.public?.timeline?.find(row=>row.kind==='program')?.entry??
    candidate?.entry;
  const family=exported?.sidecar?.sourceFamily??exported?.sidecar?.family??privateSide.sourceFamily??candidate?.family;
  if(!text(family)||typeof source!=='string'||!source||!text(entry))
    return {id:`unqualified:${index}`,family:family??`unqualified:${index}`,source:typeof source==='string'?source:'',entry:entry??'',
      qualified:false,reason:'Exact source, entry, or declared family is missing'};
  const episodeDigest=exported?.public?hashAlgorithmData(exported.public):null;
  const explicitId=candidate?.id??exported?.sidecar?.taskId??privateSide.taskId??family;
  const id=text(explicitId)?`${explicitId}:${(episodeDigest??hashAlgorithmData({source,entry,family})).slice(0,20)}`:
    `${family}:${(episodeDigest??hashAlgorithmData({source,entry,family})).slice(0,20)}`;
  return {id,family,source,entry,coreDigest:exported?.sidecar?.coreDigest??undefined,
    qualified:Boolean(exported?.public&&statusOk(candidate?.status??exported.sidecar?.admission)),
    status:candidate?.status??exported?.sidecar?.admission??'unqualified',
    reason:candidate?.reason??null,exported,candidate};
}

/** Build a complete frozen relation map before assigning any candidate. */
export function prepareSemanticFamilyRegistry(candidates,{seed,families=[],sourceDigests=[],coreDigests=[]}={}){
  if(!Number.isSafeInteger(seed))fail('an explicit seeded split assignment is required');
  if(!Array.isArray(candidates)||!candidates.length)fail('candidate source inventory is required');
  const members=candidates.map((candidate,index)=>semanticFamilyMembership(candidate,index));
  const sourceMembers=members.filter(row=>row.source&&row.entry&&text(row.family));
  if(!sourceMembers.length)fail('no exact source members can be frozen');
  const registry=buildSemanticFamilyRegistry(sourceMembers,{seed,families,sourceDigests,coreDigests});
  const identityById=new Map(sourceMembers.map(row=>[row.id,
    semanticSplitIdentity(registry,{id:row.id,family:row.family,source:row.source,entry:row.entry,
      coreDigest:row.coreDigest})]));
  return {registry,members,identityById};
}

/** Bind one candidate to a complete v2 registry without mutating source evidence. */
export function bindSemanticFamilySplit(candidate,membership,registry){
  const exported=membership.exported??candidate?.exported??candidate;
  const identity=semanticSplitIdentity(registry,{id:membership.id,family:membership.family,
    source:membership.source,entry:membership.entry,coreDigest:membership.coreDigest});
  if(!exported?.sidecar||!exported.public)fail('a v7 certified export is required');
  const bound=structuredClone(exported);
  bound.sidecar.sourceFamily=membership.family;
  bound.sidecar.splitIdentity=identity;
  bound.sidecar.split=identity.split;
  bound.sidecar.sourceComponent=identity.componentId;
  bound.sidecar.familyRegistryDigest=registry.digest;
  bound.sidecar.datasetBinding={schema:'semantic-dataset-binding/1',
    representation:bound.public.representation,episodeDigest:hashAlgorithmData(bound.public),
    contextsDigest:hashAlgorithmData(bound.contexts??[]),registryDigest:registry.digest,
    componentId:identity.componentId,split:identity.split,sourceId:identity.sourceId,
    sourceDigest:identity.sourceDigest,coreDigest:identity.coreDigest};
  return bound;
}

/**
 * Build exact train/validation/test examples. Refusals are returned alongside
 * rows so missing admission or source replay never disappears from reports.
 */
export async function buildSemanticV7Dataset(candidates,options={}){
  const {tokenizer,eosTokenId,maxContextTokens,seed,families=[],sourceDigests=[],coreDigests=[],
    allowLocal=false,maxExamplesPerEpisode=4096,nativePolicy=null,nativeConsumer=null}=options;
  const prepared=prepareSemanticFamilyRegistry(candidates,{seed,families,sourceDigests,coreDigests});
  const assignmentRows=[];
  for(const member of prepared.members){
    if(!prepared.registry.sources.some(row=>row.id===member.id))continue;
    const identity=prepared.identityById.get(member.id);
    assignmentRows.push({...member,split:identity.split,splitIdentity:identity});
  }
  validateSemanticFamilyAssignments(prepared.registry,assignmentRows);
  const examplesBySplit={train:[],validation:[],test:[]},failures=[],refusals=[];
  const splitCounts={train:0,validation:0,test:0};
  for(const member of prepared.members){
    if(!member.qualified){failures.push({id:member.id,family:member.family,status:member.status,
      reason:member.reason??'candidate is not source-qualified'});continue;}
    const identity=prepared.identityById.get(member.id);
    try{
      const exported=bindSemanticFamilySplit(member.candidate??member.exported,member,prepared.registry);
      const rows=await buildCausalLmV7Examples(exported,{tokenizer,eosTokenId,maxContextTokens,
        allowLocal,maxExamples:maxExamplesPerEpisode,expectedSplit:identity.split,nativePolicy,nativeConsumer});
      examplesBySplit[identity.split].push(...rows);
      splitCounts[identity.split]++;
    }catch(error){refusals.push({id:member.id,family:member.family,split:identity.split,
      category:error.category??'v7-export-refusal',reason:error.message});}
  }
  const exportedRows=[...examplesBySplit.train,...examplesBySplit.validation,...examplesBySplit.test];
  const admitted=!allowLocal&&exportedRows.length>0&&exportedRows.every(row=>row.metadata.nativeAdmission===true);
  const registryDigest=prepared.registry.digest;
  const manifest={schema:'semantic-training-dataset/7',traceFormat:DETAILED_TRACE_VERSION,
    adapter:CAUSAL_LM_V7_BRIDGE_VERSION,representation:'algorithm-or-detailed',seed,
    registrySchema:SEMANTIC_FAMILY_REGISTRY_SCHEMA,registryDigest,
    registryMembers:prepared.registry.sources.length,registryComponents:prepared.registry.components.length,
    holdouts:structuredClone(prepared.registry.holdouts),
    examples:Object.fromEntries(Object.entries(examplesBySplit).map(([split,rows])=>[split,rows.length])),
    episodes:splitCounts,generatedTokens:Object.fromEntries(Object.entries(examplesBySplit).map(([split,rows])=>
      [split,rows.reduce((total,row)=>total+row.boundaries.targetTokens+1,0)])),
    tokenizerIdentity:tokenizer?.identity??null,eosTokenId:eosTokenId??null,maxContextTokens:maxContextTokens??null,
    allowLocal,admitted,optimizerSteps:0,learnedSuccess:null,
    refusalCount:refusals.length,failureCount:failures.length,
    scope:allowLocal?'candidate-local-diagnostic':'native-admitted-v7-training'};
  return {manifest,registry:prepared.registry,examplesBySplit,failures,refusals,
    assignments:assignmentRows.map(({exported,candidate,...row})=>({id:row.id,family:row.family,
      componentId:row.splitIdentity.componentId,split:row.splitIdentity.split,
      sourceDigest:row.splitIdentity.sourceDigest,coreDigest:row.splitIdentity.coreDigest}))};
}
