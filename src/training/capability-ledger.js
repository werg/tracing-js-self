// Measured capability ladders. A parser success never implies execution,
// independent verification, public replay, native admission or model success.
import {parseTraining} from './profile.js';
import {verifyEffectfulTrainingCase} from './effectful-admit.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from './engineering-fixtures.js';
import {admissionEnvironment} from './admission-identity.js';
import {verifyAlgorithmTrainingCase,admitAlgorithmEvidence} from '../semantic/compiler.js';
import {hashAlgorithmData} from '../semantic/program.js';
import {encodeNativeGraph} from '../host/graph-codec.js';

export const LEGACY_CAPABILITY_STAGES=Object.freeze([
  'frontend','ownedEvaluation','independentOutcome','independentIntermediate',
  'v6ProjectionAndPublicReplay','nativeAdmission','modelEvaluation'
]);
export const CAPABILITY_STAGES=Object.freeze([
  'frontend','ownedEvaluation','independentOutcome','independentIntermediate',
  'projectionAndPublicReplay','compactRecognition','normalizationConvergence',
  'negativeSeparation','detailedFallback','nativeAdmission','modelComprehension',
  'modelNextStep','modelExecution','modelEvaluation'
]);
export const CAPABILITY_STATUSES=Object.freeze(['passed','failed','unsupported','resource_limited','untested']);
const pure=(id,body,args=[])=>({id,feature:id,source:'"use strict";'+body,entry:'run',args,fixture:{calls:[]}});
export const CAPABILITY_CASES=Object.freeze([
  pure('scalar-arithmetic','function run(a,b){return (a+b)*(a-b);}',[7,3]),
  pure('coercion-and-signed-zero','function run(){return ["2"-1,1/(-0),0/0];}'),
  pure('primitive-number-conversion','function run(){return [Number(),Number(undefined),Number(null),Number(true),Number(" 2.5 "),Number("-0"),1/Number("-0"),Number("7.5"),Number(3n)];}'),
  pure('primitive-bigint-conversion','function run(){return [BigInt(3),BigInt(false),BigInt(" 9007199254740993 "),BigInt(3n)];}'),
  pure('primitive-string-conversion','function run(){return [String(),String(undefined),String(null),String(true),String(-0),String(NaN),String(9007199254740993n)];}'),
  pure('invalid-bigint-catch-and-throw','function run(){try{BigInt("invalid");}catch(error){if(error.name==="SyntaxError"){throw error;}return error.name;}}'),
  pure('both-branch-outcomes','function run(){let n=0;for(let i=0;i<2;i++){if(i===0){n+=3;}else{n+=7;}}return n;}'),
  pure('zero-loop-trips','function run(){let n=0;while(n<0){n++;}return n;}'),
  pure('short-circuit-mutation','function run(){let n=0;false&&(n++);true&&(n++);return n;}'),
  pure('nested-calls-and-recursion','function step(n){if(n<1){return 0;}return n+step(n-1);}function run(){return step(3);}'),
  pure('parameter-body-scope','const x=7;function run(a=x){var x=3;return a;}'),
  pure('parameter-closure-capture','const x=7;function run(a=()=>x){var x=3;return a();}'),
  pure('parameter-camelcase-default-capture','function run(keyFn=()=>7){const get=()=>keyFn();return get();}'),
  pure('later-parameter-tdz','const b=9;function run(a=b,b=3){return a;}'),
  pure('async-helper-declaration','async function helper(){return 7;}async function run(){return typeof helper();}'),
  pure('sync-root-async-helper-rejection','async function fail(){throw 7;}function run(){return fail().catch(e=>e);}'),
  pure('slice-undefined-end','function run(){return [1,2,3].slice(0,undefined);}'),
  pure('fill-undefined-end','function run(){return [1,2,3].fill(7,1,undefined);}'),
  pure('copy-within-undefined-end','function run(){return [1,2,3].copyWithin(0,1,undefined);}'),
  pure('array-some-short-circuit','function run(){let seen=0;const found=[1,2,3].some(function(n){seen++;return n===2;});return [found,seen];}'),
  pure('array-for-each-owned-callback','function run(){let total=0;const result=[1,2,3].forEach(function(n){total+=n;});return [result,total];}'),
  pure('sparse-array-fill','function run(){return Array(3).fill(7);}'),
  pure('array-literal-spread','function run(){const xs=[1,2];return [0,...xs,xs.push(3),...xs];}'),
  pure('string-code-point-spread','function run(){return [..."A𝄞é"];}'),
  pure('call-spread-evaluation-order','function run(){const collect=(...ys)=>ys;const xs=[1,2];return collect(...xs,xs.push(3));}'),
  pure('input-graph-mutation','function run(a){a[0]=a[0]+1;return a;}',[[0,1]]),
  pure('alias-preserving-mutation','function run(){const a={n:1};const b=a;b.n=4;return [a,b];}'),
  pure('input-array-mutation','function run(values){values[0]=values[1];values.pop();return values.length;}',[[3,5,7]]),
  pure('synchronous-primitive-throw','function run(){throw 7;}'),
  pure('synchronous-declared-error','function run(){throw new Error("declared");}'),
  pure('finally-overrides-return','function run(){try{return 1;}finally{return 2;}}'),
  pure('finally-overrides-throw','function run(){try{throw 1;}finally{throw 2;}}'),
  pure('object-create-descriptors','function run(){return Object.create(null,{foo:{value:7}}).foo;}'),
  pure('array-index-accessor','function run(){const a=[];Object.defineProperty(a,"0",{get:function(){return 1;}});return a.length;}'),
  pure('forward-parameter-closure','const b=7;function run(a=()=>b,b=3){return a();}'),
  pure('receiver-this','function run(){return this;}'),
  pure('named-function-expression','function run(){const f=function recurse(n){return n?recurse(n-1):0;};return f(2);}'),
  pure('sparse-array-literal','function run(){return [1,,3];}'),
  pure('object-spread','function run(){const a={x:1};return {...a};}'),
  pure('class-declaration','function run(){class A{}return new A();}'),
  pure('generator-function','function* run(){yield 1;}'),
  pure('callback-abrupt-obligation','function run(){queueMicrotask(function(){throw 7;});return 3;}'),
  ...['counter-0','two-pending-reversed','rejection-finally','callback-captured-write',
    'promise-reaction','promise-rejection-finally','owned-microtask','http-response-stream',
    'filesystem-stream-copy','dom-mutation-release'].map(id=>{
      const row=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id===id);
      if(!row)throw new Error('Missing capability fixture '+id);
      return {...row,feature:id};
    })
]);

export function summarizeCapabilityRows(rows,{stages=CAPABILITY_STAGES}={}){
  return Object.fromEntries(stages.map(stage=>{
    const counts=Object.fromEntries(CAPABILITY_STATUSES.map(status=>[status,0]));
    for(const row of rows){
      const status=row.stages[stage];
      if(!CAPABILITY_STATUSES.includes(status))throw new TypeError('Unknown capability status '+status);
      counts[status]++;
    }
    return [stage,{total:rows.length,attempted:rows.length-counts.untested,...counts}];
  }));
}
const limited=result=>/limit|timeout|deadline|bound.exceeded/.test(result.status+' '+(result.reason??''));
const disposition=result=>limited(result)?'resource_limited':
  /unsupported|refused/.test(result.status)?'unsupported':'failed';
const generatedRows=exported=>(exported?.public?.timeline??[]).filter(row=>row.mode==='generated');
const targetLine=row=>row.line??row.fields?.line??'';
function regionCoverage(exported){
  const representation=exported.public.representation;
  // An episode is the only abstraction unit in v7. Never call its individual
  // arithmetic records independently certified regions.
  const regions=representation==='mixed'?exported.public.regions:null;
  const measured=exported.sidecar?.regionCoverage;
  if(representation==='mixed'&&measured){
    if(!['compactRegions','detailedRegions','compactRecords','detailedRecords'].every(key=>
      Number.isSafeInteger(measured[key])&&measured[key]>=0))throw new TypeError('Invalid certified mixed-region counts');
    return {status:'passed',unit:'certified region',compact:measured.compactRegions,
      detailed:measured.detailedRegions,total:measured.compactRegions+measured.detailedRegions,
      compactRecords:measured.compactRecords,detailedRecords:measured.detailedRecords};
  }
  if(representation==='mixed'&&!Array.isArray(regions))return {
    status:'untested',reason:'The producer did not publish a certified region inventory',
    compact:null,detailed:null,total:null};
  const kinds=regions?regions.map(region=>region.representation):[representation];
  if(kinds.some(kind=>!['algorithm','compact','detailed'].includes(kind)))throw new TypeError('Unknown region representation');
  return {status:'passed',unit:regions?'certified region':'whole episode',
    compact:kinds.filter(kind=>kind!=='detailed').length,
    detailed:kinds.filter(kind=>kind==='detailed').length,total:kinds.length};
}

/** Native admission, compact recognition and model success are distinct gates.
 * v8 requires its actual compiler adapter; changing a version label cannot
 * create a measured v8 receipt. */
export async function buildCapabilityLedger({producerRevision=null,cases=CAPABILITY_CASES,
    nativeConsumer=null,nativePolicy=null,traceVersion=7,verifyCase=null,contracts=null,
    population='capabilities',modelEvidence=null}={}){
  if(![6,7,8].includes(traceVersion))throw new TypeError('Capability traceVersion must be 6, 7 or 8');
  if(traceVersion===8&&(typeof verifyCase!=='function'||!contracts||
    contracts.execution!=='semantic-execution/8'||contracts.trace!=='semantic-trace/8'))
    throw new TypeError('V8 coverage needs its real compiler and exact contracts');
  if(modelEvidence!==null)throw new TypeError('Model evidence must be scored by the frozen experiment, not injected into a capability receipt');
  const legacy=traceVersion===6,stageNames=legacy?LEGACY_CAPABILITY_STAGES:CAPABILITY_STAGES;
  const versionContracts=contracts??{execution:`semantic-execution/${traceVersion}`,
    trace:`semantic-trace/${traceVersion}`,context:`semantic-context/${traceVersion}`,
    continuation:`semantic-continuation/${traceVersion}`,...(legacy?{harness:'selected-harness/2'}:{})};
  const verifier=verifyCase??(legacy?verifyEffectfulTrainingCase:verifyAlgorithmTrainingCase);
  const rows=[];
  for(const fixture of cases){
    const stages=Object.fromEntries(stageNames.map(stage=>[stage,'untested']));
    const row={id:fixture.id,feature:fixture.feature??fixture.family??fixture.id,
      profile:'training-js/1',traceVersion,sourceDigest:hashAlgorithmData(fixture.source),stages};
    try{parseTraining(fixture.source);stages.frontend='passed';}
    catch(error){stages.frontend='unsupported';row.disposition='frontend-refused';
      row.reason=error.message;rows.push(row);continue;}
    let result;
    try{result=await verifier({...fixture,family:fixture.family??'capability:'+fixture.id,producerRevision,
      nativeConsumer:legacy?nativeConsumer:null,nativePolicy:legacy?nativePolicy:null});}
    catch(error){result={status:error.category?.startsWith('unsupported')?'unsupported':'failed',
      reason:error.message,phase:'verifier'};}
    row.disposition=result.status;row.reason=result.reason??null;
    const success=['locally_verified','admitted','detailed-fallback','mixed'].includes(result.status);
    const afterTeacher=success||['projection','reference','native-consumer'].includes(result.phase);
    stages.ownedEvaluation=afterTeacher?'passed':disposition(result);
    if(afterTeacher){
      const projected=success||['reference','native-consumer'].includes(result.phase);
      stages[legacy?'v6ProjectionAndPublicReplay':'projectionAndPublicReplay']=projected?'passed':disposition(result);
      if(projected){
        const referenced=success||result.phase==='native-consumer';
        const intermediateMismatch=['reference_operation_mismatch','reference_branch_mismatch',
          'reference_completion_mismatch'].includes(result.status);
        stages.independentOutcome=referenced||intermediateMismatch?'passed':limited(result)?'resource_limited':'failed';
        stages.independentIntermediate=referenced?'passed':intermediateMismatch?'failed':'untested';
      }
    }
    if(result.status==='admitted')stages.nativeAdmission='passed';
    else if(result.phase==='native-consumer')stages.nativeAdmission=disposition(result);
    if(result.exported){
      const artifact=result.exported,side=artifact.sidecar;
      row.identityDigest=side.identityDigest??side.definitionDigest??side.sourceArtifactDigest;
      row.representation=artifact.public.representation??'detailed';
      row.executionProfile=side.profile??(legacy?'selected-detailed/1':null);
      row.sourceEvidence=side.sourceEvidence?.sourceChecks??side.reference?.sourceChecks??
        side.sourceArtifact?.sidecar?.reference?.sourceChecks??null;
      if(!legacy){
        if(artifact.public.schema!==versionContracts.execution||artifact.public.traceFormat!==versionContracts.trace)
          throw new TypeError('Capability artifact differs from the declared execution/trace contract');
        row.regions=regionCoverage(artifact);
        stages.compactRecognition=row.regions.compact>0?'passed':'unsupported';
        stages.detailedFallback=row.regions.detailed>0?'passed':'untested';
        row.domain=side.provenance?.inputGuards??side.provenance?.preconditions??null;
        const records=generatedRows(artifact),allBytes=records.reduce((n,item)=>n+Buffer.byteLength(targetLine(item)),0);
        const detailBytes=records.filter(item=>row.representation==='detailed'||item.representation==='detailed'||
          targetLine(item).startsWith('detail ')).reduce((n,item)=>n+Buffer.byteLength(targetLine(item)),0);
        row.publicCost={generatedRecords:records.length,generatedBytes:allBytes,detailedBytes:detailBytes,
          detailedByteShare:allBytes?detailBytes/allBytes:0,generatedTokens:null,detailedTokenShare:null,
          tokenStatus:'untested',reason:'No actual serving tokenizer measurement is supplied to this ledger'};
        if(nativeConsumer&&success){
          try{
            if(traceVersion!==7)throw new TypeError('V8 native admission requires its versioned admission adapter');
            const admitted=await admitAlgorithmEvidence(artifact,{nativeConsumer,nativePolicy});
            stages.nativeAdmission='passed';row.nativeReceipt=admitted.native;
          }catch(error){stages.nativeAdmission=/limit|timeout|deadline/.test(error.message)?'resource_limited':'failed';
            row.nativeReason=error.message;row.reason=error.message;}
        }
      }
      if(result.status==='admitted')row.nativeReceipt=side.nativeAdmission;
    }
    rows.push(row);
  }
  const measured=rows.filter(row=>row.regions?.status==='passed'),compact=measured.reduce((n,row)=>n+row.regions.compact,0),
    detailed=measured.reduce((n,row)=>n+row.regions.detailed,0);
  return {schema:legacy?'semantic-capability-ledger/2':'semantic-capability-ledger/3',producerRevision,
    population,populationDigest:hashAlgorithmData(cases.map(({id,source,entry,args,fixture})=>({
      id,source,entry,args:encodeNativeGraph(args??[]),fixture:encodeNativeGraph([fixture??null])}))),contracts:versionContracts,
    environment:admissionEnvironment(),nativePolicy,unit:'declared source/input/fixture probe',rows,
    totals:summarizeCapabilityRows(rows,{stages:stageNames}),
    ...(!legacy?{coverage:{episodes:{declared:rows.length,qualified:measured.length,
      wholeCompact:measured.filter(row=>row.regions.detailed===0).length,
      mixed:measured.filter(row=>row.regions.compact>0&&row.regions.detailed>0).length,
      whollyDetailed:measured.filter(row=>row.regions.compact===0).length},
      regions:{compact,detailed,total:compact+detailed,unmeasuredEpisodes:rows.length-measured.length},
      tokens:{status:'untested',detailedShare:null}},
      qualification:{normalization:'untested',comprehension:'untested',nextStep:'untested',
        completedExecution:'untested',nativeServingCost:'untested',standardPromotion:'not-qualified'}}:{}),
    otherProfiles:['bounded-js-subset/2','static-module/1','evaluated-module/1'].map(profile=>({
      profile,status:'untested',reason:'This command measures the strict training path only; separate profile tests are not promoted to this ladder.'})),
    otherAdapters:[{adapter:'typescript/5.9.3',targetProfile:'training-js/1',status:'untested',
      reason:'Syntax lowering and source-map preservation require their separate adapter tests.'}],
    claims:{fullEcmaScript:false,fullTest262:false,optimizerSteps:0,learnedSuccess:null},
    limitation:'Finite probes measure distinctions, not exhaustive feature conformance. Native admission is measured only when configured; model evaluation remains untested by this command.'};
}
