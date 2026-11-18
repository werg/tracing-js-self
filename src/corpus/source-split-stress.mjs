// Bounded adversarial audit of the existing source registry. Generated probes
// are syntactic descendants, never execution-equivalent training examples.
import {parse,tokenizer} from 'acorn';
import {createHash} from 'node:crypto';
import {buildSourceRegistry,verifySourceRegistry} from './source-registry.mjs';

const hash=source=>createHash('sha256').update(source).digest('hex');
const sorted=values=>[...new Set(values)].sort();
const contextWords=new Set(['async','await','yield','of','let','static','get','set']);

function editTokens(source,replace){
  const scan=tokenizer(source,{ecmaVersion:'latest'}),parts=[];let offset=0;
  for(;;){const token=scan.getToken();if(token.type.label==='eof')break;
    parts.push(source.slice(offset,token.start),replace(token)??source.slice(token.start,token.end));offset=token.end;}
  parts.push(source.slice(offset));return parts.join('');
}
export function sourceStressVariants(source){
  parse(source,{ecmaVersion:'latest',sourceType:'script'});
  const names=new Map();
  const renamed=editTokens(source,token=>{
    if(token.type.label!=='name'||contextWords.has(token.value))return null;
    if(!names.has(token.value))names.set(token.value,'__clone_probe_'+names.size);
    return names.get(token.value);
  });
  const literals=editTokens(source,token=>token.type.label==='num'?
    (typeof token.value==='bigint'?'13n':'13'):null);
  return [
    {kind:'leading-comment',source:'/* source-clone stress: original tokens retained */\n'+source,
      relation:'identical token sequence'},
    {kind:'identifier-token-renaming',source:renamed,
      relation:'syntactic descendant; property/builtin renaming is not semantic equivalence'},
    {kind:'numeric-literal-variation',source:literals,
      relation:'syntactic descendant; changed values are not independent programs'},
    {kind:'function-wrapper',source:'function __source_clone_wrapper(){\n'+source+'\n}',
      relation:'syntactic descendant with an additional lexical wrapper'},
    {kind:'dead-block-suffix',source:source+'\nif(false){const __source_clone_dead=0;}',
      relation:'syntactic descendant; no training-profile or semantic equivalence assertion'}
  ];
}

export function auditSourceSplitStress(registry,{maxSources=64,maxComponentShare=.2,
    benchmarkFamilies=[]}={}){
  const verified=verifySourceRegistry(registry);
  if(!Number.isSafeInteger(maxSources)||maxSources<1||maxSources>1000||
     !Number.isFinite(maxComponentShare)||maxComponentShare<=0||maxComponentShare>1||
     !Array.isArray(benchmarkFamilies)||benchmarkFamilies.some(value=>typeof value!=='string'||!value)||
     new Set(benchmarkFamilies).size!==benchmarkFamilies.length)
    throw new TypeError('Invalid source stress audit bounds or benchmark declarations');
  const sourceComponent=new Map(registry.components.flatMap(component=>component.sourceIds.map(id=>[id,component])));
  const familyComponent=new Map(registry.components.flatMap(component=>component.members.map(family=>[family,component])));
  const benchmarks=sorted(benchmarkFamilies).map(family=>{
    const component=familyComponent.get(family);
    return {family,status:!component?'missing':component.split==='test'?'excluded-from-training':'training-or-validation-leak',
      componentId:component?.id??null,split:component?.split??null};
  });
  const holdouts=registry.components.filter(component=>component.holdout).map(component=>({
    componentId:component.id,holdout:component.holdout,split:component.split,
    sourceVariants:component.sourceIds.length,families:component.members.length}));
  const chosen=[...registry.sources].sort((a,b)=>a.id.localeCompare(b.id)).slice(0,maxSources),probes=[];
  for(const original of chosen){
    let variants;
    try{variants=sourceStressVariants(original.source);}
    catch(error){probes.push({sourceId:original.id,kind:'source-parse',status:'unsupported',reason:error.message});continue;}
    for(const variant of variants){
      const row={sourceId:original.id,sourceSha256:original.sourceSha256,
        originalFamily:original.family,originalComponent:sourceComponent.get(original.id).id,
        originalSplit:sourceComponent.get(original.id).split,kind:variant.kind,
        relation:variant.relation,variantSha256:hash(variant.source),status:'checked'};
      try{
        parse(variant.source,{ecmaVersion:'latest',sourceType:'script'});
        const pair=[{id:'probe-base',family:'probe-base',source:original.source},
          {id:'probe-derived',family:'probe-derived',source:variant.source}];
        const options={seed:registry.seed,nearThreshold:registry.nearThreshold};
        const heuristic=buildSourceRegistry(pair,options);
        const explicit=buildSourceRegistry([pair[0],{...pair[1],ancestorIds:['probe-base']}],options);
        row.heuristicGrouped=heuristic.components.length===1;
        row.explicitLineageGrouped=explicit.components.length===1;
        row.disposition=row.heuristicGrouped?'heuristic-detected':
          'retain-explicit-lineage-and-review-heuristic-miss';
      }catch(error){row.status='unsupported';row.reason=error.message;}
      probes.push(row);
    }
  }
  const checked=probes.filter(row=>row.status==='checked'),misses=checked.filter(row=>!row.heuristicGrouped);
  const giants=registry.components.filter(component=>component.sourceIds.length/registry.sources.length>maxComponentShare)
    .map(component=>({componentId:component.id,split:component.split,sourceVariants:component.sourceIds.length,
      sourceShare:component.sourceIds.length/registry.sources.length,families:component.members.length,
      holdout:component.holdout,review:'Conservative grouping may merge distinct computations; never split it after seeing evaluation results'}));
  const hardGates={registryVerified:true,declaredHoldoutsRemainTest:holdouts.every(row=>row.split==='test'),
    knownDescendantsRemainConnected:checked.every(row=>row.explicitLineageGrouped),
    declaredBenchmarkExclusions:benchmarks.every(row=>row.status==='excluded-from-training')};
  return {schema:'source-split-stress-audit/1',sourceRegistryDigest:verified.digest,
    status:Object.values(hardGates).some(value=>!value)?'failed':misses.length||giants.length?'review_required':'passed-bounded-audit',
    hardGates,bounds:{maxSources,maxComponentShare,variantKinds:5},
    counts:{registrySources:registry.sources.length,registryComponents:registry.components.length,
      auditedSources:chosen.length,unauditedSources:registry.sources.length-chosen.length,
      probes:probes.length,checked:checked.length,unsupported:probes.length-checked.length,
      heuristicMisses:misses.length,explicitLineageFailures:checked.filter(row=>!row.explicitLineageGrouped).length},
    holdouts,benchmarkExclusions:{status:benchmarkFamilies.length?'declared-inventory':'not-declared',rows:benchmarks},
    giantComponents:giants,heuristicMisses:misses,probes,
    originalRegistryModified:false,admitted:0,optimizerSteps:0,learnedSuccess:null,
    limitations:['This finite lexical audit does not establish absence of all source clones or pretraining contamination.',
      'Probe variants are never admitted or moved into a split; syntactic derivation is not execution equivalence.',
      'Explicit ancestry must survive transformations even when a clone heuristic misses a relationship.',
      'Holdout results are never used to change sampling or dissolve conservative source components.']};
}
