// Paired semantic evaluation keeps refusals and detailed dispositions in the
// denominator. Wire, serialized envelopes, and actual context snapshots are
// different measurements; no native token cost is inferred from UTF-8 bytes.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {encodeNativeGraph} from '../host/graph-codec.js';
import {algorithmDigest,canonicalAlgorithmString} from './ir.js';
import {canonicalObservableGraph} from './observables.js';
import {defineAlgorithmProgram,hashAlgorithmData,ALGORITHM_CONTEXT_VERSION} from './program.js';
import {ALGORITHM_TRACE_VERSION,decodeAlgorithmRecord} from './trace-codec.js';
import {validateAlgorithmTokenizerEvidence} from './tokenizer.js';

export const ALGORITHM_COMPARISON_VERSION='semantic-algorithm-comparison/1';
const sha=value=>createHash('sha256').update(value).digest('hex');
const bytes=value=>Buffer.byteLength(value,'utf8');
const json=value=>JSON.stringify(value);
const linesOf=episode=>(episode?.timeline??[]).filter(row=>row.mode==='generated'&&typeof row.line==='string').map(row=>row.line);
const maybeSum=values=>values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0):null;

export function pairedDistribution(values){
  const data=values.filter(Number.isFinite).sort((a,b)=>a-b),n=data.length;
  return {cases:values.length,measured:n,total:n?data.reduce((a,b)=>a+b,0):null,
    median:n?n%2?data[(n-1)/2]:(data[n/2-1]+data[n/2])/2:null,
    p95:n?data[Math.max(0,Math.ceil(n*0.95)-1)]:null};
}

function qualifiedTokenizer(tokenizer,policy){
  if(!tokenizer)return null;
  try{
    if(typeof tokenizer.encode!=='function'||typeof tokenizer.decode!=='function')throw new TypeError('Tokenizer methods missing');
    validateAlgorithmTokenizerEvidence(tokenizer,policy);
  }catch(error){throw new TypeError('Token accounting requires the exact qualified consumer/codec/tokenizer policy: '+error.message);}
  return tokenizer;
}
async function countTokens(text,tokenizer){
  if(!tokenizer)return null;
  const tokens=await tokenizer.encode(text);
  if(!Array.isArray(tokens)||tokens.some(id=>!Number.isSafeInteger(id)||id<0)||
    await tokenizer.decode(tokens)!==text)throw new TypeError('Tokenizer changed the measured bytes');
  return tokens.length;
}

/** Exact JSONL accounting for the supplied public transcript, not a native wire audit. */
export async function auditAlgorithmCosts(episode,{contexts=null,tokenizer=null,tokenizerPolicy=null}={}){
  if(!Array.isArray(episode?.timeline))throw new TypeError('A public timeline is required for cost accounting');
  const codec=qualifiedTokenizer(tokenizer,tokenizerPolicy);
  let generated=0,observed=0,framing=0,generatedRecords=0,observedRecords=0;
  const generatedTokens=[],observedTokens=[],serializedTokens=[],observedByKind={},prefixes=[];
  let prefixBytes=0;
  for(const row of episode.timeline){
    if(!row||!['generated','observed'].includes(row.mode))throw new TypeError('Public record authority missing');
    if(row.mode==='generated'&&typeof row.line!=='string')throw new TypeError('Generated record lacks exact target bytes');
    const serialized=json(row)+'\n',payload=typeof row.line==='string'?row.line:json(row);
    const payloadBytes=bytes(payload),serializedBytes=bytes(serialized);
    if(row.mode==='generated'){
      if(episode.traceFormat===ALGORITHM_TRACE_VERSION)decodeAlgorithmRecord(row.line,{role:'generated'});
      generated+=payloadBytes;generatedRecords++;generatedTokens.push(await countTokens(payload,codec));
    }else{
      if(episode.traceFormat===ALGORITHM_TRACE_VERSION&&typeof row.line==='string')
        decodeAlgorithmRecord(row.line,{role:'observed'});
      observed+=payloadBytes;observedRecords++;observedTokens.push(await countTokens(payload,codec));
      observedByKind[row.kind??'untyped']=(observedByKind[row.kind??'untyped']??0)+payloadBytes;
    }
    framing+=serializedBytes-payloadBytes;serializedTokens.push(await countTokens(serialized,codec));
    if(row.mode==='generated')prefixes.push(prefixBytes);
    prefixBytes+=serializedBytes;
  }
  // These contexts must be the snapshots actually requested by the JS serving
  // harness, not a synthesized all-history replacement for missing evidence.
  let serving={status:'unavailable',reason:'No actual model-context snapshots supplied',
    boundaries:null,peakBytes:null,cumulativeBytes:null,peakTokens:null,cumulativeTokens:null,
    definitionPublications:null,definitionReferences:null,definitionBytes:null,
    inputPublications:null,inputReferences:null,inputBytes:null,cacheRetrievalCost:null};
  if(contexts!==null){
    if(!Array.isArray(contexts)||contexts.length!==generatedRecords)
      throw new TypeError('One actual context snapshot is required for each generated prediction');
    const definitions=new Map(),inputs=new Map(),invocationInputs=new Map(),sizes=[],tokens=[];
    let definitionPublications=0,definitionReferences=0,definitionBytes=0;
    let inputPublications=0,inputReferences=0,inputBytes=0;
    for(const context of contexts){
      if(!context||typeof context.definition!=='string')throw new TypeError('Context definition identity missing');
      if(episode.traceFormat===ALGORITHM_TRACE_VERSION&&context.schema!==ALGORITHM_CONTEXT_VERSION)
        throw new TypeError('Algorithm context version missing or changed');
      if(context.program){
        if(context.program.definitionDigest!==context.definition)
          throw new TypeError('Context publishes another definition');
        if(definitions.has(context.definition)&&!isDeepStrictEqual(definitions.get(context.definition),context.program))
          throw new TypeError('Immutable context definition changed');
        definitions.set(context.definition,context.program);definitionPublications++;
        definitionBytes+=bytes(json(context.program));
      }else{
        if(!definitions.has(context.definition))throw new TypeError('Context references an unavailable definition');
        definitionReferences++;
      }
      if(context.schema===ALGORITHM_CONTEXT_VERSION){
        if(typeof context.input!=='string')throw new TypeError('Context input identity missing');
        if(Object.hasOwn(context,'inputGraph')){
          // Hash the exact immutable graph, not an alpha-renamed copy: public
          // live-state references address these original input identities.
          canonicalObservableGraph(context.inputGraph);
          if(hashAlgorithmData(context.inputGraph)!==context.input)
            throw new TypeError('Context publishes another input graph');
          if(inputs.has(context.input)&&!isDeepStrictEqual(inputs.get(context.input),context.inputGraph))
            throw new TypeError('Immutable context input graph changed');
          inputs.set(context.input,context.inputGraph);inputPublications++;
          inputBytes+=bytes(json(context.inputGraph));
        }else{
          if(!inputs.has(context.input))throw new TypeError('Context references an unavailable input graph');
          inputReferences++;
        }
        if(invocationInputs.has(context.invocationId)&&invocationInputs.get(context.invocationId)!==context.input)
          throw new TypeError('Context invocation changed its immutable input graph');
        invocationInputs.set(context.invocationId,context.input);
      }
      const serialized=json(context)+'\n';sizes.push(bytes(serialized));tokens.push(await countTokens(serialized,codec));
    }
    serving={status:'measured-js-snapshots',scope:'Exact JSON.stringify(context) plus LF at each JS prediction boundary; not native model framing',
      boundaries:contexts.length,peakBytes:sizes.length?Math.max(...sizes):0,cumulativeBytes:sizes.reduce((a,b)=>a+b,0),
      peakTokens:codec&&tokens.length?Math.max(...tokens):null,cumulativeTokens:codec?maybeSum(tokens):null,
      definitionPublications,definitionReferences,definitionBytes,inputPublications,inputReferences,inputBytes,
      cacheRetrievalCost:null,
      cacheRetrievalReason:'Definition and input references are counted; no native cache/retrieval timing or token cost measured'};
  }
  return {scope:'Exact target/observed payload bytes and compact JSONL public-envelope accounting',
    byteDefinition:'Generated/observed line payloads are raw text. Non-line observations are their exact JSON object. Framing includes JSON escaping, metadata around line payloads, and LF separators.',
    records:{generated:generatedRecords,observed:observedRecords,total:episode.timeline.length},
    bytes:{generated,observed,framing,serializedTotal:generated+observed+framing,observedByKind},
    tokens:{status:codec?'measured':'unavailable',identity:codec?structuredClone(codec.identity):null,
      reason:codec?null:'No qualified tokenizer adapter supplied; bytes are not token estimates',
      generated:codec?maybeSum(generatedTokens):null,observed:codec?maybeSum(observedTokens):null,
      serializedTotal:codec?maybeSum(serializedTokens):null,
      framing:null,framingReason:'Tokenizer merges cross payload/envelope boundaries; subtraction is not an exact framing token count'},
    transcriptPrefix:{scope:'Uncompacted JSONL transcript prefixes; distinct from actual serving context',
      predictionBoundaries:prefixes.length,peakBytes:prefixes.length?Math.max(...prefixes):0,
      cumulativeBytes:prefixes.reduce((a,b)=>a+b,0)},serving};
}

function inputGraph(args){const {schema,...graph}=encodeNativeGraph(args);return graph;}
function normalizedGraph(graph){return canonicalObservableGraph(graph);}
const inputDigest=args=>sha(json(normalizedGraph(inputGraph(args))));
const sourceDigest=source=>sha(source);
function extractProgram(exported){return exported?.public?.timeline?.find(row=>row.kind==='program')?.program??null;}
function statusClass(status){return status==='locally_verified'?'normalized':status==='detailed-fallback'?'fallback':'failure';}
function snapshotCosts(exported){return exported?.contexts??exported?.public?.contexts??null;}

export function compareFrozenBaseline(frozen,fixture,detailed){
  if(!frozen||!detailed?.public)return {status:'unavailable',reason:'Frozen case or detailed execution unavailable'};
  const mismatches=[];
  if(frozen.source!==fixture.source||frozen.sourceDigest!==sourceDigest(fixture.source))mismatches.push('source');
  const initial=frozen.invocationInputs?.[0]?.inputGraph;
  try{if(!isDeepStrictEqual(normalizedGraph(initial),normalizedGraph(inputGraph(fixture.args??[]))))mismatches.push('inputs');}
  catch{mismatches.push('inputs');}
  const oldLines=frozen.records.filter(row=>row.targetMask==='generated').map(row=>row.raw);
  if(!isDeepStrictEqual(oldLines,linesOf(detailed.public)))mismatches.push('generated-targets');
  return {status:mismatches.length?'changed':'identical',mismatches,
    frozenGeneratedBytes:oldLines.reduce((sum,line)=>sum+bytes(line),0),
    frozenGeneratedTokens:frozen.metrics?.generatedTokens??null,
    sourceDigest:frozen.sourceDigest,inputDigest:initial?sha(json(normalizedGraph(initial))):null,
    boundary:'Raw target/source/input comparison. Fresh detailed envelope costs belong to the current producer, not to the frozen producer.'};
}

async function measureCase(fixture,verifyCase,{frozen=null,tokenizer=null,tokenizerPolicy=null}={}){
  const started=performance.now();let result;
  try{result=await verifyCase(fixture);}
  catch(error){result={status:'verification-failed',reason:error.message};}
  const elapsedMs=performance.now()-started,classification=statusClass(result.status);
  const detailed=result.detailed??(classification==='fallback'?result.exported:null);
  const exported=result.exported??detailed,program=classification==='normalized'?extractProgram(exported):null;
  let coreDigest=null,canonicalCore=null,measurementFailure=null;
  try{if(program){coreDigest=algorithmDigest(program.core);canonicalCore=canonicalAlgorithmString(program.core);}}
  catch(error){measurementFailure='Invalid exported algorithm core: '+error.message;}
  if(classification==='normalized'&&!program)measurementFailure='Locally verified candidate lacks its public algorithm definition';
  let currentCosts=null,detailedCosts=null;
  try{
    if(exported?.public)currentCosts=await auditAlgorithmCosts(exported.public,
      {contexts:classification==='normalized'?snapshotCosts(exported):null,tokenizer,tokenizerPolicy});
    if(detailed?.public)detailedCosts=await auditAlgorithmCosts(detailed.public,{tokenizer,tokenizerPolicy});
  }catch(error){measurementFailure=error.message;}
  const row={id:fixture.id,family:fixture.family??null,sourceDigest:sourceDigest(fixture.source),
    inputDigest:inputDigest(fixture.args??[]),inputGraph:inputGraph(fixture.args??[]),
    status:measurementFailure?'measurement-failed':result.status,
    disposition:measurementFailure?'failure':classification,reason:measurementFailure??result.reason??null,
    representation:exported?.public?.traceFormat??null,
    behavior:{status:['normalized','fallback'].includes(classification)&&!measurementFailure?'locally-checked':'unqualified',
      scope:'Owned source/reference/replay and selected semantic checks in the verification result; no native admission is inferred'},
    coreDigest,canonicalCore,targets:linesOf(exported?.public),
    costs:{detailed:detailedCosts,current:currentCosts},
    delta:{generatedBytes:currentCosts&&detailedCosts?currentCosts.bytes.generated-detailedCosts.bytes.generated:null,
      observedBytes:currentCosts&&detailedCosts?currentCosts.bytes.observed-detailedCosts.bytes.observed:null,
      framingBytes:currentCosts&&detailedCosts?currentCosts.bytes.framing-detailedCosts.bytes.framing:null,
      serializedBytes:currentCosts&&detailedCosts?currentCosts.bytes.serializedTotal-detailedCosts.bytes.serializedTotal:null,
      generatedTokens:currentCosts?.tokens.generated!==null&&detailedCosts?.tokens.generated!==null&&currentCosts&&detailedCosts?
        currentCosts.tokens.generated-detailedCosts.tokens.generated:null},
    timing:{totalVerificationMs:elapsedMs,loweringMs:null,normalizationMs:null,checkingMs:null,dispatchMs:null,continuationMs:null},
    ...(frozen?{frozenBaseline:compareFrozenBaseline(frozen,fixture,detailed)}:{})};
  // Canonical core strings aid grouping internally; reports carry the digest
  // and public definition in the source artifact rather than duplicating it.
  return row;
}

export async function evaluateNegativeFamilies(negatives,{verifyCase,recognize=defineAlgorithmProgram}={}){
  const rows=[];
  for(const negative of negatives){
    if(negative.expect==='refused'){
      let refused=false,reason=null;
      try{recognize({source:negative.source,entry:negative.entry??'run'});}
      catch(error){refused=error.category==='unsupported.algorithm-profile';reason=error.message;
        if(!refused){rows.push({id:negative.id,expected:'refused',stage:'source-recognition',status:'failed',
          falseMerge:false,unsafeAdmission:false,reason});continue;}}
      rows.push({id:negative.id,expected:'refused',stage:'source-recognition',
        status:refused?'passed':'failed',falseMerge:false,unsafeAdmission:!refused,
        reason:reason??'Source unexpectedly entered the algorithm profile'});
    }else if(negative.expect==='distinct'){
      const sides=[];
      for(const side of ['left','right'])sides.push(await measureCase({id:negative.id+'/'+side,
        family:'negative/'+negative.id,source:negative[side],entry:negative.entry??'run',
        args:negative.args??[],fixture:{calls:[]}},verifyCase));
      const accepted=sides.every(row=>row.disposition==='normalized'),falseMerge=accepted&&sides[0].coreDigest===sides[1].coreDigest;
      rows.push({id:negative.id,expected:'distinct',stage:'independently-checked-execution',
        status:accepted&&!falseMerge?'passed':'failed',falseMerge,unsafeAdmission:false,
        reason:falseMerge?'Different certified algorithms share a canonical core':accepted?null:'A distinct-pair member was not locally verified',
        sides:sides.map(({id,status,coreDigest,sourceDigest,inputDigest})=>({id,status,coreDigest,sourceDigest,inputDigest}))});
    }else throw new TypeError('Unknown negative-family expectation');
  }
  return {cases:rows.length,passed:rows.filter(row=>row.status==='passed').length,
    failed:rows.filter(row=>row.status==='failed').length,falseMerges:rows.filter(row=>row.falseMerge).length,
    unsafeAdmissions:rows.filter(row=>row.unsafeAdmission).length,rows};
}

function totals(rows){
  const measurements=rows.map(row=>row.costs.current);
  return {cases:rows.length,normalized:rows.filter(row=>row.disposition==='normalized').length,
    fallbacks:rows.filter(row=>row.disposition==='fallback').length,failures:rows.filter(row=>row.disposition==='failure').length,
    generatedBytes:pairedDistribution(measurements.map(cost=>cost?.bytes.generated??null)),
    observedBytes:pairedDistribution(measurements.map(cost=>cost?.bytes.observed??null)),
    framingBytes:pairedDistribution(measurements.map(cost=>cost?.bytes.framing??null)),
    serializedBytes:pairedDistribution(measurements.map(cost=>cost?.bytes.serializedTotal??null)),
    generatedTokenCounts:pairedDistribution(measurements.map(cost=>cost?.tokens.generated??null)),
    servingPeakBytes:pairedDistribution(measurements.map(cost=>cost?.serving.peakBytes??null)),
    servingCumulativeBytes:pairedDistribution(measurements.map(cost=>cost?.serving.cumulativeBytes??null)),
    generatedByteDelta:pairedDistribution(rows.map(row=>row.delta.generatedBytes)),
    verificationMs:pairedDistribution(rows.map(row=>row.timing.totalVerificationMs))};
}

export async function compareSemanticRepresentations({baseline,galleryFixtures,families,negatives=[],
  verifyCase=null,recognize=defineAlgorithmProgram,tokenizer=null,tokenizerPolicy=null,onProgress=()=>{}}={}){
  if(!Array.isArray(galleryFixtures)||!Array.isArray(families)||!Array.isArray(baseline?.cases))
    throw new TypeError('Frozen baseline and explicit gallery/equivalence families required');
  if(!verifyCase)verifyCase=(await import('./compiler.js')).verifyAlgorithmTrainingCase;
  if(typeof verifyCase!=='function')throw new TypeError('Algorithm verification API unavailable');
  const oldById=new Map(baseline.cases.map(row=>[row.id,row])),gallery=[];
  if(oldById.size!==baseline.cases.length||galleryFixtures.length!==baseline.cases.length||
    galleryFixtures.some(row=>!oldById.has(row.id)))throw new TypeError('Unchanged gallery case denominator required');
  for(const fixture of galleryFixtures){
    const row=await measureCase(fixture,verifyCase,{frozen:oldById.get(fixture.id),tokenizer,tokenizerPolicy});
    gallery.push(row);onProgress({stage:'gallery',id:row.id,status:row.status});
  }
  const familyReports=[];
  for(const family of families){
    const rows=[],groups=[];
    for(let caseIndex=0;caseIndex<family.cases.length;caseIndex++){
      const group=[];
      for(const variant of family.variants){
        const row=await measureCase({id:family.id+'/'+variant.id+'/'+caseIndex,family:family.id,
          source:variant.source,entry:variant.entry,args:family.cases[caseIndex],inputTypes:family.inputTypes,
          fixture:{calls:[]}},verifyCase,{tokenizer,tokenizerPolicy});
        row.variant=variant.id;row.caseIndex=caseIndex;rows.push(row);group.push(row);
        onProgress({stage:'family',id:row.id,status:row.status});
      }
      const supported=group.filter(row=>row.disposition==='normalized');
      const coreCount=new Set(supported.map(row=>row.canonicalCore)).size;
      const targetCount=new Set(supported.map(row=>json(row.targets))).size;
      groups.push({caseIndex,variants:group.length,supported:supported.length,
        canonicalCoreCount:coreCount,canonicalTargetCount:targetCount,
        converged:supported.length===group.length&&coreCount===1&&targetCount===1});
    }
    familyReports.push({id:family.id,domain:family.domain,inputTypes:family.inputTypes,
      description:family.description,variants:family.variants.length,inputCases:family.cases.length,
      expectedExecutions:family.variants.length*family.cases.length,groups,
      convergence:{groups:groups.length,converged:groups.filter(row=>row.converged).length,
        supportedExecutions:rows.filter(row=>row.disposition==='normalized').length},totals:totals(rows),rows});
  }
  const negativeReport=await evaluateNegativeFamilies(negatives,{verifyCase,recognize});
  const all=[...gallery,...familyReports.flatMap(family=>family.rows)],summary=totals(all);
  const baselineDrift=gallery.filter(row=>row.frozenBaseline?.status!=='identical').length;
  const unconverged=familyReports.reduce((n,row)=>n+row.convergence.groups-row.convergence.converged,0);
  const engineeringPass=summary.failures===0&&baselineDrift===0&&unconverged===0&&negativeReport.failed===0;
  for(const row of all)delete row.canonicalCore;
  return {schema:ALGORITHM_COMPARISON_VERSION,candidateRepresentation:ALGORITHM_TRACE_VERSION,
    baseline:{representation:baseline.representation,revision:baseline.frozenRevision??null,cases:baseline.cases.length,
      scope:'Exact source/input/target pairing; fresh detailed envelope costs have current producer identity'},
    gallery:{totals:totals(gallery),rows:gallery},families:familyReports,negatives:negativeReport,totals:summary,
    gates:{engineering:{status:engineeringPass?'passed':'failed',baselineDrift,unconvergedGroups:unconverged,
      failedExecutions:summary.failures,falseMerges:negativeReport.falseMerges,unsafeAdmissions:negativeReport.unsafeAdmissions},
      native:{status:'unavailable',reason:'No independent v7 companion consumer executed by this runner'},
      tokenizer:{status:tokenizer?'measured':'unavailable'},
      comprehension:{status:'unmeasured',reason:'Controlled renderer checks are not a reader study'},
      learning:{status:'unmeasured',optimizerSteps:0},
      promotion:{status:'not-qualified',reason:'Native, complete native serving cost, and comprehension gates require separate evidence'}},
    limitations:['Family source refusals are recognition checks, not executed behavioral proofs.',
      'Reported JSONL framing and JS snapshot costs are not native model transport measurements.',
      'Finite zero-false-merge results do not prove universal equivalence.',
      'Private source evidence and source-specific context are excluded from canonical core identity, not from measured public context.']};
}
