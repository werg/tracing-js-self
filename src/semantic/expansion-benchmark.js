// Benchmark source/reference execution is a separate authority. It validates
// fixture meaning and near misses, never substitutes native execution for owned
// execution or promotes a failed source certificate.
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {LANGUAGE_EXPANSION_BENCHMARK as benchmark} from '../../fixtures/language-expansion/benchmark.js';
import {trustedRealSourceCases} from '../corpus/trusted-source-candidates.mjs';
import {importGraph} from '../training/graph.js';
import {referenceOutcome} from '../training/reference.js';
import {encodeNativeGraph} from '../host/graph-codec.js';
import {compareObservableGraphs} from './observables.js';
import {hashAlgorithmData,defineAlgorithmProgram} from './program.js';
import {buildSemanticFamilyRegistry} from './family-registry.js';
import {tryLowerJavaScriptV8} from './lower-v8.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../training/semantic-trace-gallery.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const status=row=>['return','throw'].includes(row?.kind);
const semanticEqual=(a,b)=>a.kind===b.kind&&compareObservableGraphs(a.graph,b.graph).equal;
export function independentBenchmarkOutcome(source,args,{entry='run'}={}){
  const state={heap:{}};let next=0;
  const roots=importGraph(state,structuredClone(args),()=> 'o'+next++);
  return referenceOutcome({source,entry,args:roots,initialHeap:state.heap,timeout:1000});
}

/** Every family and stratum is declared before owned results are considered.
 * This selects by immutable source identity, never by successful admission. */
export function expansionRealSourceSlice({repositoryRoot=root,perStratum=8}={}){
  if(!Number.isSafeInteger(perStratum)||perStratum<1||perStratum>32)throw new TypeError('Real-source stratum bound');
  const inventory=trustedRealSourceCases({root:repositoryRoot,streams:['utilities'],perFamily:1}),groups=new Map();
  for(const fixture of inventory){
    const match=/^utility:(vscode|lodash)\/([^/]+)\//.exec(fixture.family);
    if(!match)throw new TypeError('Unexpected real-source family');
    const stratum=match[1]==='lodash'?'lodash-arrays-and-primitives':'vscode-'+match[2].replace('.ts','');
    if(!groups.has(stratum))groups.set(stratum,[]);groups.get(stratum).push({...fixture,stratum});
  }
  const selected=[...groups].sort(([a],[b])=>a.localeCompare(b)).flatMap(([,rows])=>
    rows.sort((a,b)=>a.id.localeCompare(b.id)).slice(0,perStratum));
  return {population:'pinned-utilities-stratified-v1',inventoryDenominator:inventory.length,
    selection:'First eight immutable source IDs per declared project/file stratum; no result-dependent filtering',
    strata:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([id,rows])=>({id,
      available:rows.length,selected:Math.min(rows.length,perStratum)})),cases:selected};
}

// The declaration inventory is deeply frozen to pin the benchmark. That is
// metadata protection, not a request to pass frozen guest objects to run().
// Materialize each interaction consistently for both coverage and admission.
export function expansionInteractionCases(){
  return benchmark.interactions.map(row=>structuredClone(row));
}

export function expansionSourceCases({allInputs=true,includeInteractions=true,includeRealSource=true}={}){
  const cases=benchmark.families.flatMap(family=>family.variants.flatMap(variant=>
    (allInputs?family.inputs:family.inputs.slice(0,1)).map((args,index)=>({
      id:variant.id+'-input-'+index,feature:family.id,family:family.family,domain:family.domain,
      source:variant.source,entry:family.entry,args:structuredClone(args),fixture:{calls:[]},
      ancestors:[family.family],sourceProfile:family.sourceProfile}))));
  if(includeInteractions)cases.push(...expansionInteractionCases().filter(row=>row.source));
  if(includeRealSource)cases.push(...expansionRealSourceSlice().cases);
  return cases;
}

export function expansionCoveragePopulation({population='all',allInputs=true}={}){
  if(!['all','families','interactions','real-source','gallery'].includes(population))
    throw new TypeError('Unknown expansion population');
  if(population==='gallery')return {scripts:SEMANTIC_GALLERY_FIXTURES.map(row=>structuredClone(row)),modules:[]};
  if(population==='real-source')return {scripts:expansionRealSourceSlice().cases,modules:[]};
  const interactions=population==='all'||population==='interactions';
  let scripts=expansionSourceCases({allInputs,includeInteractions:interactions,includeRealSource:population==='all'});
  if(population==='interactions')scripts=scripts.filter(row=>row.family.startsWith('interaction:'));
  return {scripts,modules:interactions?expansionInteractionCases().filter(row=>row.modules):[]};
}
export function expansionManifest(){
  const real=expansionRealSourceSlice();
  const manifest={schema:'semantic-expansion-manifest/1',id:benchmark.id,version:1,
    semanticReference:benchmark.semanticReference,policy:benchmark.policy,
    families:benchmark.families.map(family=>({id:family.id,family:family.family,domain:family.domain,
      sourceProfile:family.sourceProfile,meaning:family.meaning,
      variants:family.variants.map(variant=>({id:variant.id,sourceDigest:hashAlgorithmData(variant.source)})),
      inputs:family.inputs.map(args=>encodeNativeGraph(structuredClone(args))),
      distinguishingPairs:family.negatives.map(row=>({id:row.label,distinction:row.distinction,
        sourceDigest:hashAlgorithmData(row.source),inputs:encodeNativeGraph(structuredClone(row.args))}))})),
    interactions:benchmark.interactions.map(row=>({id:row.id,sourceProfile:row.sourceProfile,
      sourceDigest:hashAlgorithmData(row.source??row.modules),inputs:encodeNativeGraph(structuredClone(row.args))})),
    realSource:{population:real.population,inventoryDenominator:real.inventoryDenominator,
      selectedDenominator:real.cases.length,strata:real.strata,selection:real.selection,
      sources:real.cases.map(row=>({id:row.id,family:row.family,stratum:row.stratum,
        sourceDigest:hashAlgorithmData(row.source),originalSourceDigest:row.provenance.originalSourceSha256,
        upstream:row.provenance.upstream,transform:row.provenance.transform,inputs:encodeNativeGraph(structuredClone(row.args))}))}};
  return {...manifest,digest:hashAlgorithmData(manifest)};
}
export function validateExpansionManifest(manifest){
  if(!isDeepStrictEqual(manifest,expansionManifest()))throw new TypeError('Frozen expansion source, inputs, profile or stratum changed');
  return true;
}

export function expansionFamilyRegistry(){
  const rows=benchmark.families.flatMap(family=>[
    ...family.variants.map(row=>({...row,family:family.family,entry:family.entry,ancestors:[family.family]})),
    ...family.negatives.map(row=>({id:family.id+'-negative-'+row.label,source:row.source,
      entry:family.entry,family:family.family,ancestors:[family.family]}))]);
  rows.push(...benchmark.interactions.filter(row=>row.source).map(row=>({...row,ancestors:[row.family]})));
  rows.push(...expansionRealSourceSlice().cases.map(row=>({...row,ancestors:row.ancestorIds})));
  return buildSemanticFamilyRegistry(rows,{seed:17});
}

export function validateExpansionReferencePopulation({traceVersion=7}={}){
  if(![7,8].includes(traceVersion))throw new TypeError('Expansion normalization requires an explicit supported trace version');
  const recognize=(source,entry)=>{
    if(traceVersion===8){
      const lowered=tryLowerJavaScriptV8({source,entry});
      return lowered.status==='lowered'?{status:'passed',digest:hashAlgorithmData(lowered.core)}:
        {status:'unsupported',reason:lowered.reason};
    }
    try{return {status:'passed',digest:defineAlgorithmProgram({source,entry}).program.coreDigest};}
    catch(error){return {status:'unsupported',reason:error.message};}
  };
  const families=[];
  for(const family of benchmark.families){
    const positives=[];
    for(const [inputIndex,args] of family.inputs.entries()){
      const outcomes=family.variants.map(variant=>independentBenchmarkOutcome(variant.source,args));
      const usable=outcomes.every(status),equal=usable&&outcomes.every(outcome=>semanticEqual(outcome,outcomes[0]));
      positives.push({inputIndex,status:!usable?'unsupported':equal?'passed':'failed',
        outcomes:outcomes.map(outcome=>({kind:outcome.kind,digest:hashAlgorithmData(outcome)}))});
    }
    const negatives=family.negatives.map(negative=>{
      const left=independentBenchmarkOutcome(family.variants[0].source,negative.args),
        right=independentBenchmarkOutcome(negative.source,negative.args);
      const cores=[family.variants[0].source,negative.source].map(source=>recognize(source,family.entry).digest??null);
      return {id:negative.label,status:!status(left)||!status(right)?'unsupported':semanticEqual(left,right)?'failed':'passed',
        distinction:negative.distinction,left,right,
        normalizationSeparation:{status:cores.every(Boolean)?cores[0]!==cores[1]?'passed':'failed':'unsupported',
          leftCore:cores[0],rightCore:cores[1],reason:cores.every(Boolean)?null:'At least one source is explicitly outside compact lowering'}};
    });
    const lowered=family.variants.map(variant=>recognize(variant.source,family.entry));
    const allLowered=lowered.every(row=>row.status==='passed');
    families.push({id:family.id,domain:family.domain,positiveReference:positives,distinguishingPairs:negatives,
      sourceRecognition:lowered,normalization:{status:!allLowered?'unsupported':
        new Set(lowered.map(row=>row.digest)).size===1?'passed':'failed',
        scope:'Source-derived cores only; independently checked owned claims and actual-domain execution remain separate gates'}});
  }
  const positive=families.flatMap(row=>row.positiveReference),negative=families.flatMap(row=>row.distinguishingPairs);
  return {schema:'semantic-expansion-reference-report/1',manifestDigest:expansionManifest().digest,traceVersion,
    normalizedCoreSchema:traceVersion===8?'semantic-algorithm/2':'semantic-algorithm/1',
    engine:process.version,scope:'Independent V8 execution of trusted frozen fixtures; not owned/runtime/native admission',
    totals:{families:families.length,positiveInputs:positive.length,positiveExecutions:positive.length*3,
      positivePassed:positive.filter(row=>row.status==='passed').length,
      distinguishingPairs:negative.length,distinguishingPassed:negative.filter(row=>row.status==='passed').length},families,
    qualification:{ownedExecution:'untested',independentIntermediate:'untested',native:'untested',model:'untested'}};
}
