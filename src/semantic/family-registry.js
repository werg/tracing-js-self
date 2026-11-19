// Immutable semantic-family assignment for prepared v7 corpora. A split is
// assigned to the connected component of declared lineage, exact source, and
// normalized algorithm core, so related variants cannot cross a holdout.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {defineAlgorithmProgram,hashAlgorithmData} from './program.js';

export const SEMANTIC_FAMILY_REGISTRY_SCHEMA='semantic-family-registry/1';
export const SEMANTIC_FAMILY_SPLIT_SCHEMA='semantic-split-identity/2';
export const SEMANTIC_FAMILY_POLICY='semantic-family-components/1';
const splits=new Set(['train','validation','test']);
const sha=value=>createHash('sha256').update(value).digest('hex');
const sorted=values=>[...new Set(values)].sort();
const fail=message=>{throw new TypeError('Semantic family registry: '+message);};
const text=value=>typeof value==='string'&&value.length>0;
const cmp=(left,right)=>left<right?-1:left>right?1:0;
const splitFor=(componentId,seed)=>{
  const bucket=Number.parseInt(sha(seed+':'+componentId).slice(0,8),16)%100;
  return bucket<80?'train':bucket<90?'validation':'test';
};
const holdoutOptions=Object.freeze(['families','sourceDigests','coreDigests']);

function normalizedCoreDigest(source,entry,declared){
  let derived=null;
  try{derived=defineAlgorithmProgram({source,entry}).program.coreDigest;}
  catch(error){
    if(error?.category!=='unsupported.algorithm-profile'&&!/No certified algorithm profile/.test(error.message))throw error;
  }
  if(declared!==undefined&&declared!==null&&declared!==derived)
    fail('declared normalized core differs from source-derived core');
  return derived;
}

function canonicalSource(row){
  if(!row||!text(row.id)||row.id.length>256||!text(row.family)||row.family.length>256||
    typeof row.source!=='string'||!row.source.length||Buffer.byteLength(row.source,'utf8')>2000000||
    !text(row.entry)||row.entry.length>256||
    row.ancestors!==undefined&&(!Array.isArray(row.ancestors)||row.ancestors.some(x=>!text(x)||x.length>256)||
      new Set(row.ancestors).size!==row.ancestors.length))fail('invalid immutable source membership');
  const sourceDigest=sha(row.source),coreDigest=normalizedCoreDigest(row.source,row.entry,row.coreDigest);
  return {id:row.id,family:row.family,ancestors:sorted(row.ancestors??[]),entry:row.entry,
    source:row.source,sourceDigest,coreDigest};
}

function normalizedHoldouts(options){
  for(const key of holdoutOptions){
    const values=options[key]??[];
    if(!Array.isArray(values)||values.some(value=>!text(value))||new Set(values).size!==values.length)
      fail('invalid explicit holdout list: '+key);
  }
  return Object.fromEntries(holdoutOptions.map(key=>[key,sorted(options[key]??[])]));
}

/** Build the complete, deterministic relation registry before dataset splits. */
export function buildSemanticFamilyRegistry(input,{seed=17,families=[],sourceDigests=[],coreDigests=[]}={}){
  if(!Array.isArray(input)||input.length===0||input.length>20000||!Number.isSafeInteger(seed))
    fail('source list and seed are required');
  const holdouts=normalizedHoldouts({families,sourceDigests,coreDigests});
  const sources=input.map(canonicalSource).sort((a,b)=>cmp(a.id,b.id));
  if(new Set(sources.map(row=>row.id)).size!==sources.length)fail('duplicate source ID');
  for(const digest of holdouts.sourceDigests)if(!/^[a-f0-9]{64}$/.test(digest))fail('invalid source holdout digest');
  for(const digest of holdouts.coreDigests)if(!/^[a-f0-9]{64}$/.test(digest))fail('invalid core holdout digest');
  const parent=sources.map((_,index)=>index),find=index=>{
    while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}return index;
  };
  const join=(left,right)=>{left=find(left);right=find(right);if(left!==right)parent[Math.max(left,right)]=Math.min(left,right);};
  const related=new Map();
  for(const [index,row] of sources.entries()){
    const keys=[...new Set([...row.ancestors,row.family])].map(value=>'family:'+value);
    keys.push('source:'+row.sourceDigest);
    if(row.coreDigest)keys.push('core:'+row.coreDigest);
    for(const key of keys){if(related.has(key))join(index,related.get(key));else related.set(key,index);}
  }
  const grouped=new Map();
  for(const [index,row] of sources.entries()){
    const root=find(index),rows=grouped.get(root)??[];rows.push(row);grouped.set(root,rows);
  }
  const components=[...grouped.values()].map(rows=>{
    const memberRows=rows.map(row=>({id:row.id,family:row.family,ancestors:row.ancestors,
      entry:row.entry,sourceDigest:row.sourceDigest,coreDigest:row.coreDigest}))
      .sort((a,b)=>cmp(a.id,b.id));
    const members=sorted(rows.flatMap(row=>[row.family,...row.ancestors]));
    const id='semantic-component:'+hashAlgorithmData(memberRows);
    const holdoutFamilies=members.filter(member=>holdouts.families.includes(member));
    const holdoutSources=rows.map(row=>row.sourceDigest).filter(value=>holdouts.sourceDigests.includes(value));
    const holdoutCores=rows.map(row=>row.coreDigest).filter(value=>value&&holdouts.coreDigests.includes(value));
    const holdout=holdoutFamilies.length?{kind:'family',keys:holdoutFamilies}:
      holdoutSources.length?{kind:'exact-source',keys:sorted(holdoutSources)}:
      holdoutCores.length?{kind:'normalized-core',keys:sorted(holdoutCores)}:null;
    return {id,members,sourceIds:rows.map(row=>row.id).sort(),split:holdout?'test':splitFor(id,seed),holdout};
  }).sort((a,b)=>cmp(a.id,b.id));
  const knownFamilies=new Set(sources.flatMap(row=>[row.family,...row.ancestors]));
  for(const family of holdouts.families)if(!knownFamilies.has(family))fail('unknown family holdout: '+family);
  for(const digest of holdouts.sourceDigests)if(!sources.some(row=>row.sourceDigest===digest))fail('unknown source holdout: '+digest);
  for(const digest of holdouts.coreDigests)if(!sources.some(row=>row.coreDigest===digest))fail('unknown core holdout: '+digest);
  const registry={schema:SEMANTIC_FAMILY_REGISTRY_SCHEMA,policy:SEMANTIC_FAMILY_POLICY,seed,
    holdouts,sources,components,
    diagnostics:{sourceVariants:sources.length,declaredFamilies:new Set(sources.map(row=>row.family)).size,
      normalizedCores:new Set(sources.map(row=>row.coreDigest).filter(Boolean)).size,
      connectedComponents:components.length,
      splitComponents:Object.fromEntries([...splits].map(split=>[split,components.filter(row=>row.split===split).length]))}};
  return {...registry,digest:hashAlgorithmData(registry)};
}

/** Rebuild all membership/core relations; a claimed digest never grants trust. */
export function verifySemanticFamilyRegistry(registry){
  if(registry?.schema!==SEMANTIC_FAMILY_REGISTRY_SCHEMA||registry.policy!==SEMANTIC_FAMILY_POLICY||
    !Number.isSafeInteger(registry.seed)||!Array.isArray(registry.sources)||!Array.isArray(registry.components))
    fail('unsupported or incomplete registry');
  const {digest,...body}=registry;
  if(digest!==hashAlgorithmData(body))fail('registry digest');
  const rebuilt=buildSemanticFamilyRegistry(registry.sources,{seed:registry.seed,
    families:registry.holdouts?.families,sourceDigests:registry.holdouts?.sourceDigests,
    coreDigests:registry.holdouts?.coreDigests});
  if(!isDeepStrictEqual(rebuilt,registry))fail('complete family membership, split or holdout changed');
  return {valid:true,digest,components:registry.components.length};
}

function memberFor(registry,{id,family,source,entry,coreDigest}={}){
  if(!text(id)||!text(family)||typeof source!=='string'||!text(entry))fail('source identity required');
  const sourceDigest=sha(source),core=normalizedCoreDigest(source,entry,coreDigest);
  const row=registry.sources.find(item=>item.id===id);
  if(!row||row.family!==family||row.entry!==entry||row.sourceDigest!==sourceDigest||row.coreDigest!==core)
    fail('unknown, relabeled, or changed registry member');
  return row;
}

/** Bind one training row to its exact immutable registry membership. */
export function semanticSplitIdentity(registry,{id,family,source,entry,coreDigest}={}){
  verifySemanticFamilyRegistry(registry);
  const row=memberFor(registry,{id,family,source,entry,coreDigest});
  const component=registry.components.find(item=>item.sourceIds.includes(row.id));
  if(!component)fail('member has no connected component');
  return {schema:SEMANTIC_FAMILY_SPLIT_SCHEMA,policy:SEMANTIC_FAMILY_POLICY,
    registryDigest:registry.digest,seed:registry.seed,sourceId:row.id,family:row.family,
    sourceDigest:row.sourceDigest,coreDigest:row.coreDigest,componentId:component.id,
    members:structuredClone(component.members),split:component.split,holdout:structuredClone(component.holdout),
    registry:structuredClone(registry)};
}

export function verifySemanticSplitIdentity(identity,{id,family,source,entry,coreDigest}={}){
  if(identity?.schema!==SEMANTIC_FAMILY_SPLIT_SCHEMA)fail('split identity schema');
  const expected=semanticSplitIdentity(identity.registry,{id,family,source,entry,coreDigest});
  if(!isDeepStrictEqual(identity,expected))fail('split assignment, lineage, or complete registry changed');
  return {valid:true,split:identity.split,componentId:identity.componentId,
    registryDigest:identity.registryDigest};
}

/** Reject forged, unknown, mixed, or relabeled rows before any export. */
export function validateSemanticFamilyAssignments(registry,rows,{expectedSplit=null}={}){
  verifySemanticFamilyRegistry(registry);
  if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'))fail('dataset rows required');
  if(expectedSplit!==null&&!splits.has(expectedSplit))fail('unknown requested split');
  const seen=new Set(),byComponent=new Map(),assignments=[];
  for(const row of rows){
    const identity=semanticSplitIdentity(registry,{id:row.id,family:row.family,source:row.source,
      entry:row.entry,coreDigest:row.coreDigest});
    if(seen.has(row.id))fail('duplicate dataset source identity');seen.add(row.id);
    if(row.split!==identity.split||expectedSplit!==null&&row.split!==expectedSplit)
      fail('forged or mixed split assignment for '+row.id);
    if(row.splitIdentity&&!isDeepStrictEqual(row.splitIdentity,identity))fail('row split identity changed');
    const existing=byComponent.get(identity.componentId);
    if(existing&&existing!==row.split)fail('related variants leak across splits');
    byComponent.set(identity.componentId,row.split);
    assignments.push({id:row.id,family:row.family,sourceDigest:identity.sourceDigest,
      coreDigest:identity.coreDigest,componentId:identity.componentId,split:identity.split});
  }
  return {valid:true,registryDigest:registry.digest,assignments,
    components:[...byComponent.keys()].sort()};
}
