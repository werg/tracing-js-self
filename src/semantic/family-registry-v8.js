// A v8 registry freezes the complete source relation graph before assigning
// any execution to a split. v7 registries are intentionally not migrated.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {defineRegionProgram,REGION_TRACE_VERSION} from './regions.js';
import {hashAlgorithmData} from './program.js';

export const REGION_FAMILY_REGISTRY_SCHEMA='semantic-region-family-registry/1';
export const REGION_FAMILY_SPLIT_SCHEMA='semantic-region-split-identity/1';
export const REGION_FAMILY_POLICY='semantic-region-family-components/1';
export const REGION_DATASET_BINDING_SCHEMA='semantic-region-dataset-binding/1';
export const REGION_DATASET_SPLITS=Object.freeze(['train','validation','test']);
const HASH=/^[a-f0-9]{64}$/;
const holdoutKeys=['families','sourceDigests','coreDigests'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const text=value=>typeof value==='string'&&value.length>0;
const sorted=values=>[...new Set(values)].sort();
const compare=(left,right)=>left<right?-1:left>right?1:0;
const fail=message=>{throw new TypeError('Region family registry: '+message);};
const splitFor=(component,seed)=>{
  const bucket=Number.parseInt(sha(seed+':'+component).slice(0,8),16)%100;
  return bucket<80?'train':bucket<90?'validation':'test';
};
function ancestorsOf(values=[],family){
  if(!Array.isArray(values)||values.length>1024||values.some(value=>!text(value)||value.length>256))
    fail('invalid source ancestors');
  return sorted(values.filter(value=>value!==family));
}

/** Only an actual source-derived /2 core creates a normalized-core edge. */
export function deriveRegionCoreIdentity(source,entry){
  let program;
  try{program=defineRegionProgram({source,entry}).program;}
  catch(error){
    if(error instanceof SyntaxError||error?.category==='unsupported.region-profile')
      return {coreDigest:null,coreStatus:'source-refused'};
    throw error;
  }
  return program.algorithm===null?{coreDigest:null,coreStatus:'detailed'}:
    {coreDigest:hashAlgorithmData(program.algorithm),coreStatus:'algorithm'};
}
function canonicalSource(row){
  if(!row||!text(row.id)||row.id.length>256||!text(row.family)||row.family.length>256||
    !text(row.source)||Buffer.byteLength(row.source,'utf8')>2000000||
    !text(row.entry)||row.entry.length>256)fail('invalid exact source membership');
  const derived=deriveRegionCoreIdentity(row.source,row.entry),sourceDigest=sha(row.source);
  if(row.sourceDigest!==undefined&&row.sourceDigest!==sourceDigest)fail('declared exact source digest differs');
  if(row.coreDigest!==undefined&&row.coreDigest!==derived.coreDigest)fail('declared core differs from source-derived /2 core');
  if(row.coreStatus!==undefined&&row.coreStatus!==derived.coreStatus)fail('declared core status differs');
  return {id:row.id,family:row.family,ancestors:ancestorsOf(row.ancestors,row.family),
    source:row.source,entry:row.entry,sourceDigest,...derived};
}
function normalizeHoldouts(options){
  const result={};
  for(const key of holdoutKeys){
    const values=options[key]??[];
    if(!Array.isArray(values)||values.some(value=>!text(value)||
      (key!=='families'&&!HASH.test(value)))||new Set(values).size!==values.length)
      fail('invalid explicit holdout list: '+key);
    result[key]=sorted(values);
  }
  return result;
}

export function buildRegionFamilyRegistry(input,{seed,families=[],sourceDigests=[],coreDigests=[]}={}){
  if(!Array.isArray(input)||!input.length||input.length>20000||!Number.isSafeInteger(seed))
    fail('complete nonempty source inventory and explicit seed are required');
  const holdouts=normalizeHoldouts({families,sourceDigests,coreDigests});
  const sources=input.map(canonicalSource).sort((a,b)=>compare(a.id,b.id));
  if(new Set(sources.map(row=>row.id)).size!==sources.length)fail('duplicate source ID');
  const parent=sources.map((_,index)=>index),find=index=>{
    while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}return index;
  };
  const join=(left,right)=>{left=find(left);right=find(right);
    if(left!==right)parent[Math.max(left,right)]=Math.min(left,right);};
  const edges=new Map();
  for(const [index,row] of sources.entries()){
    const keys=[row.family,...row.ancestors].map(value=>'family:'+value);
    keys.push('source:'+row.sourceDigest);
    // Null is the absence of an edge, never a universal "detailed" core.
    if(row.coreDigest!==null)keys.push('core:'+row.coreDigest);
    for(const key of keys){if(edges.has(key))join(index,edges.get(key));else edges.set(key,index);}
  }
  const groups=new Map();
  for(const [index,row] of sources.entries()){
    const root=find(index),rows=groups.get(root)??[];rows.push(row);groups.set(root,rows);
  }
  const components=[...groups.values()].map(rows=>{
    const identityRows=rows.map(({source,...row})=>row);
    const id='semantic-region-component:'+hashAlgorithmData(identityRows);
    const members=sorted(rows.flatMap(row=>[row.family,...row.ancestors]));
    const matched={families:members.filter(value=>holdouts.families.includes(value)),
      sourceDigests:sorted(rows.map(row=>row.sourceDigest).filter(value=>holdouts.sourceDigests.includes(value))),
      coreDigests:sorted(rows.map(row=>row.coreDigest).filter(value=>value!==null&&holdouts.coreDigests.includes(value)))};
    const holdout=Object.values(matched).some(values=>values.length)?matched:null;
    return {id,members,sourceIds:rows.map(row=>row.id),split:holdout?'test':splitFor(id,seed),holdout};
  }).sort((a,b)=>compare(a.id,b.id));
  const known={families:new Set(sources.flatMap(row=>[row.family,...row.ancestors])),
    sourceDigests:new Set(sources.map(row=>row.sourceDigest)),
    coreDigests:new Set(sources.map(row=>row.coreDigest).filter(value=>value!==null))};
  for(const key of holdoutKeys)for(const value of holdouts[key])
    if(!known[key].has(value))fail('unknown '+key+' holdout: '+value);
  const body={schema:REGION_FAMILY_REGISTRY_SCHEMA,policy:REGION_FAMILY_POLICY,
    traceFormat:REGION_TRACE_VERSION,coreSchema:'semantic-algorithm/2',seed,holdouts,sources,components,
    diagnostics:{sourceMembers:sources.length,exactSourceVariants:new Set(sources.map(row=>row.sourceDigest+':'+row.entry)).size,
      declaredFamilies:new Set(sources.map(row=>row.family)).size,
      normalizedCores:known.coreDigests.size,withoutNormalizedCore:sources.filter(row=>row.coreDigest===null).length,
      connectedComponents:components.length,splitComponents:Object.fromEntries(REGION_DATASET_SPLITS.map(split=>
        [split,components.filter(row=>row.split===split).length]))}};
  return {...body,digest:hashAlgorithmData(body)};
}

/** Re-derive source cores and all relations; a self-consistent hash is not proof. */
export function verifyRegionFamilyRegistry(registry){
  if(registry?.schema!==REGION_FAMILY_REGISTRY_SCHEMA||registry.policy!==REGION_FAMILY_POLICY||
    registry.traceFormat!==REGION_TRACE_VERSION||registry.coreSchema!=='semantic-algorithm/2'||
    !Array.isArray(registry.sources)||!Array.isArray(registry.components))fail('unsupported registry schema or profile');
  const {digest,...body}=registry;if(digest!==hashAlgorithmData(body))fail('registry digest differs');
  const expected=buildRegionFamilyRegistry(registry.sources,{seed:registry.seed,...registry.holdouts});
  if(!isDeepStrictEqual(expected,registry))fail('source relation, complete membership, split or holdout changed');
  return {valid:true,digest,components:registry.components.length};
}
function findMember(registry,{id,family,source,entry,ancestors,coreDigest}={}){
  const derived=canonicalSource({id,family,source,entry,ancestors,coreDigest});
  const row=registry.sources.find(item=>item.id===id);
  if(!row||row.family!==family||row.entry!==entry||row.sourceDigest!==derived.sourceDigest||
    row.coreDigest!==derived.coreDigest||ancestors!==undefined&&!isDeepStrictEqual(row.ancestors,derived.ancestors))
    fail('unknown, relabeled or changed source member');
  return row;
}
function identityFor(registry,row){
  const component=registry.components.find(item=>item.sourceIds.includes(row.id));
  if(!component)fail('source member has no component');
  return {schema:REGION_FAMILY_SPLIT_SCHEMA,policy:REGION_FAMILY_POLICY,traceFormat:REGION_TRACE_VERSION,
    registryDigest:registry.digest,seed:registry.seed,sourceId:row.id,family:row.family,
    ancestors:structuredClone(row.ancestors),entry:row.entry,sourceDigest:row.sourceDigest,
    coreDigest:row.coreDigest,coreStatus:row.coreStatus,componentId:component.id,
    members:structuredClone(component.members),split:component.split,holdout:structuredClone(component.holdout),
    registry:structuredClone(registry)};
}
export function regionSplitIdentity(registry,member){
  verifyRegionFamilyRegistry(registry);return identityFor(registry,findMember(registry,member));
}
export function verifyRegionSplitIdentity(identity,member){
  if(identity?.schema!==REGION_FAMILY_SPLIT_SCHEMA)fail('unsupported split identity');
  const expected=regionSplitIdentity(identity.registry,member);
  if(!isDeepStrictEqual(identity,expected))fail('split assignment, lineage or complete registry changed');
  return {valid:true,split:identity.split,componentId:identity.componentId,
    registryDigest:identity.registryDigest,sourceId:identity.sourceId};
}
export function validateRegionFamilyAssignments(registry,rows,{expectedSplit=null}={}){
  verifyRegionFamilyRegistry(registry);
  if(!Array.isArray(rows)||expectedSplit!==null&&!REGION_DATASET_SPLITS.includes(expectedSplit))
    fail('invalid dataset rows or requested split');
  const seen=new Set(),assignments=[];
  for(const row of rows){
    const member=findMember(registry,row),identity=identityFor(registry,member);
    if(seen.has(row.id))fail('duplicate dataset source identity');seen.add(row.id);
    if(row.split!==identity.split||expectedSplit!==null&&row.split!==expectedSplit||
      row.splitIdentity!==undefined&&!isDeepStrictEqual(row.splitIdentity,identity))
      fail('forged or mixed split assignment');
    assignments.push({id:row.id,family:row.family,sourceDigest:identity.sourceDigest,
      coreDigest:identity.coreDigest,componentId:identity.componentId,split:identity.split});
  }
  return {valid:true,registryDigest:registry.digest,assignments};
}

/** Extract the family and lineage carried by independently checked source data. */
export function regionArtifactSource(artifact){
  const side=artifact?.sidecar,direct=side?.schema==='semantic-protocol-host-region-evidence/1',
    sourceSide=direct?side:side?.sourceArtifact?.sidecar,reference=sourceSide?.referenceInput;
  if(artifact?.public?.schema!=='semantic-execution/8'||artifact.public.traceFormat!==REGION_TRACE_VERSION||
    !Array.isArray(artifact.contexts)||!reference||!text(reference.source)||!text(reference.entry)||
    !text(sourceSide.sourceFamily)||side.sourceFamily!==sourceSide.sourceFamily||side.family!==sourceSide.sourceFamily)
    fail('exact v8 source, entry and original family evidence required');
  const family=sourceSide.sourceFamily,ancestors=ancestorsOf(sourceSide.ancestorIds??[],family);
  if(sourceSide.sourceLineage!==undefined&&sourceSide.sourceLineage!==family)
    fail('original source lineage differs from its family');
  return {family,ancestors,source:reference.source,entry:reference.entry,
    ...(side.coreDigest!==undefined?{coreDigest:side.coreDigest}:{})};
}
export function regionDatasetBinding(artifact,identity){
  // Source evidence may contain in-memory optional undefined fields. Bind the
  // exact JSON representation that survives transport, as the compiler does.
  const digest=value=>hashAlgorithmData(JSON.parse(JSON.stringify(value)));
  const direct=artifact.sidecar.schema==='semantic-protocol-host-region-evidence/1';
  if(direct&&!HASH.test(artifact.sidecar.identityDigest??''))fail('direct source identity is missing');
  return {schema:REGION_DATASET_BINDING_SCHEMA,traceFormat:REGION_TRACE_VERSION,
    episodeDigest:digest(artifact.public),contextsDigest:digest(artifact.contexts),
    sourceArtifactDigest:direct?null:digest(artifact.sidecar.sourceArtifact),
    ...(direct?{sourceIdentityDigest:artifact.sidecar.identityDigest}:{}),
    ...(Object.hasOwn(artifact.sidecar,'orchestrationTranscript')?
      {orchestrationTranscriptDigest:digest(artifact.sidecar.orchestrationTranscript)}:{}),
    registryDigest:identity.registryDigest,componentId:identity.componentId,split:identity.split,
    sourceId:identity.sourceId,family:identity.family,sourceDigest:identity.sourceDigest,
    coreDigest:identity.coreDigest};
}
/** Serving/training entry point: frozen assignment plus exact bound artifact. */
export function verifyRegionDatasetBinding(artifact,{expectedSplit=null}={}){
  if(expectedSplit!==null&&!REGION_DATASET_SPLITS.includes(expectedSplit))fail('unknown requested split');
  const source=regionArtifactSource(artifact),side=artifact.sidecar,identity=side.splitIdentity;
  const checked=verifyRegionSplitIdentity(identity,{id:identity?.sourceId,...source});
  if(side.split!==identity.split||side.sourceComponent!==identity.componentId||
    side.familyRegistryDigest!==identity.registryDigest||expectedSplit!==null&&identity.split!==expectedSplit||
    !isDeepStrictEqual(side.datasetBinding,regionDatasetBinding(artifact,identity)))
    fail('dataset binding, public/context bytes or split changed');
  return {...checked,errors:[]};
}
