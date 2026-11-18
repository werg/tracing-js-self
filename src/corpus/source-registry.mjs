// Freeze connected source/ancestor components BEFORE expanding inputs or
// schedules. Source revisions and wrappers retain their original family.
import {createHash} from 'node:crypto';
import {tokenizer} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {fingerprintOwnedSource,clusterOwnedSources} from './source-clusters.mjs';

const ordered=value=>Array.isArray(value)?value.map(ordered):
  value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
export const canonicalHash=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const sha=text=>createHash('sha256').update(text).digest('hex');
const text=x=>typeof x==='string'&&x.length>0&&x.length<=2000;
const list=x=>Array.isArray(x)&&x.every(text)&&new Set(x).size===x.length;
const sort=x=>[...new Set(x)].sort();
const splitFor=(id,seed)=>{
  const bucket=parseInt(sha(seed+':'+id).slice(0,8),16)%100;
  return bucket<80?'train':bucket<90?'validation':'test';
};
// Literal changes are descendants, not independent source families. This
// conservative guard can over-group kernels; it never claims semantic equality.
function literalInsensitiveFingerprint(source){
  const scanner=tokenizer(source,{ecmaVersion:'latest'}),tokens=[],names=new Map();
  for(;;){
    const item=scanner.getToken(),kind=item.type.label;if(kind==='eof')break;
    if(kind==='name'){
      if(!names.has(item.value))names.set(item.value,names.size);
      tokens.push('id:'+names.get(item.value));
    }else tokens.push(['string','num','bigint'].includes(kind)?kind:source.slice(item.start,item.end));
  }
  return canonicalHash(tokens);
}
function sourceRecord(row){
  if(!text(row?.id)||!text(row.family)||typeof row.source!=='string'||!row.source||
    row.source.length>2000000||!list(row.ancestorIds??[])||
    row.project!=null&&!text(row.project)||row.upstreamPath!=null&&!text(row.upstreamPath)||
    row.composition!=null&&!text(row.composition))throw new TypeError('Invalid frozen source record');
  return {id:row.id,family:row.family,source:row.source,sourceSha256:sha(row.source),
    sourceFingerprint:fingerprintOwnedSource(row.source),
    literalInsensitiveHash:literalInsensitiveFingerprint(row.source),
    project:row.project??null,upstreamPath:row.upstreamPath??null,
    upstreamRevision:row.upstreamRevision??null,ancestorIds:sort(row.ancestorIds??[]),
    composition:row.composition??null};
}
export function buildSourceRegistry(input,{seed=17,nearThreshold=0.92,
    holdoutProjects=[],holdoutCompositions=[]}={}){
  if(!Array.isArray(input)||input.length===0||input.length>10000||
    !Number.isSafeInteger(seed)||!list(holdoutProjects)||!list(holdoutCompositions))
    throw new TypeError('Invalid source registry policy');
  const sources=input.map(sourceRecord).sort((a,b)=>a.id.localeCompare(b.id));
  if(new Set(sources.map(row=>row.id)).size!==sources.length)throw new Error('Repeated source registry ID');
  const byId=new Map(sources.map((row,index)=>[row.id,index]));
  const parents=sources.map((_,index)=>index),find=i=>{
    while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;
  };
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parents[Math.max(a,b)]=Math.min(a,b);};
  const lineage=new Map();
  for(const [index,row] of sources.entries()){
    const keys=['family:'+row.family,...row.ancestorIds.map(id=>'family:'+id),
      'shape:'+row.literalInsensitiveHash];
    // Upstream project/path is stable across revisions. Family is a function
    // identity; same-file helpers are deliberately grouped conservatively.
    if(row.project&&row.upstreamPath)keys.push('upstream:'+row.project+':'+row.upstreamPath);
    for(const key of keys){if(lineage.has(key))union(index,lineage.get(key));else lineage.set(key,index);}
  }
  const cloneAudit=clusterOwnedSources(sources.map(row=>({family:row.id,split:'train',
    sourceFingerprint:row.sourceFingerprint})),{nearThreshold});
  const clones=new Map();
  for(const row of sources){
    const key=cloneAudit.keyByFamily[row.id],index=byId.get(row.id);
    if(clones.has(key))union(index,clones.get(key));else clones.set(key,index);
  }
  const groups=new Map();
  for(const [index,row] of sources.entries()){
    const root=find(index),rows=groups.get(root)??[];rows.push(row);groups.set(root,rows);
  }
  const components=[...groups.values()].map(rows=>{
    const members=sort(rows.flatMap(row=>[row.family,...row.ancestorIds]));
    const id='component:'+sha(JSON.stringify(members));
    const projects=sort(rows.map(row=>row.project).filter(project=>holdoutProjects.includes(project)));
    const compositions=sort(rows.map(row=>row.composition).filter(key=>holdoutCompositions.includes(key)));
    const holdout=projects.length?{kind:'upstream-project',key:projects.join(',')}:
      compositions.length?{kind:'composition',key:compositions.join(',')}:null;
    return {id,members,sourceIds:rows.map(row=>row.id).sort(),
      split:holdout?'test':splitFor(id,seed),holdout};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  for(const project of holdoutProjects)if(!sources.some(row=>row.project===project))
    throw new Error('Unknown upstream holdout project: '+project);
  for(const composition of holdoutCompositions)if(!sources.some(row=>row.composition===composition))
    throw new Error('Unknown compositional holdout: '+composition);
  return {schema:'semantic-source-registry/1',policy:'source-components/1',seed,nearThreshold,
    holdoutProjects:sort(holdoutProjects),holdoutCompositions:sort(holdoutCompositions),sources,components,
    diagnostics:{sourceVariants:sources.length,sourceFamilies:new Set(sources.map(row=>row.family)).size,
      independentComponents:components.length,nearPairs:cloneAudit.nearPairs,
      splitComponents:Object.fromEntries(['train','validation','test'].map(split=>[split,components.filter(row=>row.split===split).length]))},
    warnings:[...cloneAudit.warnings,
      'Literal-insensitive and upstream-path grouping is conservative and may merge distinct computations.',
      'These holdouts do not establish absence from a pretrained model\'s pretraining data.']};
}
export function verifySourceRegistry(registry){
  if(registry?.schema!=='semantic-source-registry/1'||registry.policy!=='source-components/1')
    throw new Error('Unsupported frozen source registry');
  const rebuilt=buildSourceRegistry(registry.sources,registry);
  if(!isDeepStrictEqual(rebuilt,registry))throw new Error('Frozen source registry changed');
  return {valid:true,digest:canonicalHash(registry),components:registry.components.length};
}
export function frozenSplitIdentity(registry,family){
  verifySourceRegistry(registry);
  const component=registry.components.find(row=>row.members.includes(family));
  if(!component)throw new Error('Family absent from frozen registry');
  return {schema:'semantic-split-identity/1',policy:registry.policy,seed:registry.seed,
    componentId:component.id,members:component.members,split:component.split,holdout:component.holdout,
    registryDigest:canonicalHash(registry),registry};
}
export function verifyFrozenSplitIdentity(identity,{family,seed=identity?.seed}={}){
  if(identity?.schema!=='semantic-split-identity/1'||identity.seed!==seed)
    throw new Error('Frozen split seed/schema differs');
  const expected=frozenSplitIdentity(identity.registry,family);
  if(!isDeepStrictEqual(identity,expected))throw new Error('Frozen component, lineage, policy or split changed');
  return {valid:true,split:identity.split,sourceCluster:identity.componentId,registryDigest:identity.registryDigest};
}

// Deterministic post-admission selection. Caps apply to authenticated ancestor
// components and actual tokenizer counts, never byte counts called tokens.
export function balanceFamilyTokens(rows,{maxFamilyTokens,maxFamilyShare=1}={}){
  if(!Array.isArray(rows)||!Number.isSafeInteger(maxFamilyTokens)||maxFamilyTokens<1||
    !Number.isFinite(maxFamilyShare)||maxFamilyShare<=0||maxFamilyShare>1)
    throw new TypeError('Invalid family token budget');
  const groups=new Map();
  for(const row of [...rows].sort((a,b)=>a.id.localeCompare(b.id))){
    if(!text(row.id)||!text(row.sourceCluster)||row.status!=='admitted'||
      !Number.isSafeInteger(row.generatedTokens)||row.generatedTokens<1)
      throw new Error('Family balancing requires native-admitted rows and measured token counts');
    const group=groups.get(row.sourceCluster)??[];group.push(row);groups.set(row.sourceCluster,group);
  }
  const selected=[],refused=[],totals=new Map();
  for(const [family,group] of groups){let total=0;
    for(const row of group){if(total+row.generatedTokens<=maxFamilyTokens){selected.push(row);total+=row.generatedTokens;}
      else refused.push({id:row.id,reason:'family-token-budget'});}totals.set(family,total);
  }
  // Remove largest rows from any overrepresented component until the actual
  // selected token denominator satisfies the cap. Never silently relax it.
  for(;;){
    const total=[...totals.values()].reduce((a,b)=>a+b,0);
    const over=[...totals].filter(([,n])=>n>0&&n/total>maxFamilyShare+Number.EPSILON)
      .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    if(!over.length)break;
    const family=over[0][0],row=selected.filter(row=>row.sourceCluster===family)
      .sort((a,b)=>b.generatedTokens-a.generatedTokens||a.id.localeCompare(b.id))[0];
    selected.splice(selected.indexOf(row),1);totals.set(family,totals.get(family)-row.generatedTokens);
    refused.push({id:row.id,reason:'family-token-share'});
  }
  return {selected:selected.sort((a,b)=>a.id.localeCompare(b.id)),refused,
    generatedTokens:selected.reduce((n,row)=>n+row.generatedTokens,0),
    independentComponents:new Set(selected.map(row=>row.sourceCluster)).size,maxFamilyTokens,maxFamilyShare};
}
