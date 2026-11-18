// Measured capability ladders. A parser success never implies execution,
// independent verification, public replay, native admission or model success.
import {parseTraining} from './profile.js';
import {verifyEffectfulTrainingCase} from './effectful-admit.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from './engineering-fixtures.js';
import {admissionEnvironment} from './admission-identity.js';

export const CAPABILITY_STAGES=Object.freeze([
  'frontend','ownedEvaluation','independentOutcome','independentIntermediate',
  'v5ProjectionAndPublicReplay','nativeAdmission','modelEvaluation'
]);
export const CAPABILITY_STATUSES=Object.freeze(['passed','failed','unsupported','resource_limited','untested']);
const pure=(id,body,args=[])=>({id,feature:id,source:'"use strict";'+body,entry:'run',args,fixture:{calls:[]}});
export const CAPABILITY_CASES=Object.freeze([
  pure('scalar-arithmetic','function run(a,b){return (a+b)*(a-b);}',[7,3]),
  pure('coercion-and-signed-zero','function run(){return ["2"-1,1/(-0),0/0];}'),
  pure('primitive-number-conversion','function run(){return [Number(),Number(undefined),Number(null),Number(true),Number(" 2.5 "),1/Number("-0"),Number(3n)];}'),
  pure('primitive-bigint-conversion','function run(){return [BigInt(3),BigInt(false),BigInt(" 9007199254740993 "),BigInt(3n)];}'),
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
  pure('slice-undefined-end','function run(){return [1,2,3].slice(0,undefined);}'),
  pure('fill-undefined-end','function run(){return [1,2,3].fill(7,1,undefined);}'),
  pure('copy-within-undefined-end','function run(){return [1,2,3].copyWithin(0,1,undefined);}'),
  pure('array-some-short-circuit','function run(){let seen=0;const found=[1,2,3].some(function(n){seen++;return n===2;});return [found,seen];}'),
  pure('array-for-each-owned-callback','function run(){let total=0;const result=[1,2,3].forEach(function(n){total+=n;});return [result,total];}'),
  pure('sparse-array-fill','function run(){return Array(3).fill(7);}'),
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

export function summarizeCapabilityRows(rows){
  return Object.fromEntries(CAPABILITY_STAGES.map(stage=>{
    const counts=Object.fromEntries(CAPABILITY_STATUSES.map(status=>[status,0]));
    for(const row of rows){
      const status=row.stages[stage];
      if(!CAPABILITY_STATUSES.includes(status))throw new TypeError('Unknown capability status '+status);
      counts[status]++;
    }
    return [stage,{total:rows.length,attempted:rows.length-counts.untested,...counts}];
  }));
}
export async function buildCapabilityLedger({producerRevision=null,cases=CAPABILITY_CASES,
    nativeConsumer=null,nativePolicy=null}={}){
  const rows=[];
  for(const fixture of cases){
    const stages=Object.fromEntries(CAPABILITY_STAGES.map(stage=>[stage,'untested']));
    const row={id:fixture.id,feature:fixture.feature,profile:'training-js/1',stages};
    try{parseTraining(fixture.source);stages.frontend='passed';}
    catch(error){stages.frontend='unsupported';row.reason=error.message;rows.push(row);continue;}
    const result=await verifyEffectfulTrainingCase({...fixture,family:'capability:'+fixture.id,producerRevision,
      nativeConsumer,nativePolicy});
    row.disposition=result.status;row.reason=result.reason??null;
    const success=['locally_verified','admitted'].includes(result.status);
    const afterTeacher=success||['projection','reference','native-consumer'].includes(result.phase);
    stages.ownedEvaluation=afterTeacher?'passed':
      /limit|timeout|deadline/.test(result.status)?'resource_limited':
      result.status==='unsupported'?'unsupported':'failed';
    if(afterTeacher){
      const projected=success||['reference','native-consumer'].includes(result.phase);
      stages.v5ProjectionAndPublicReplay=projected?'passed':result.status==='projection_refused'?'unsupported':'failed';
      if(projected){
        const referenced=success||result.phase==='native-consumer';
        const intermediateMismatch=['reference_operation_mismatch','reference_branch_mismatch'].includes(result.status);
        stages.independentOutcome=referenced||intermediateMismatch?'passed':/timeout|limit/.test(result.status)?'resource_limited':'failed';
        stages.independentIntermediate=referenced?'passed':intermediateMismatch?'failed':'untested';
      }
    }
    if(result.status==='admitted')stages.nativeAdmission='passed';
    else if(result.phase==='native-consumer')stages.nativeAdmission='failed';
    if(result.exported)row.identityDigest=result.exported.sidecar.identityDigest;
    if(result.exported?.sidecar.nativeAdmission){
      const receipt=result.exported.sidecar.nativeAdmission;
      row.nativeReceipt={episodeDigest:receipt.episodeDigest,consumerRevision:receipt.consumerRevision,
        tokenizerIdentity:receipt.tokenizerIdentity,tokenizerSha256:receipt.tokenizerSha256,
        generatedTokens:receipt.generatedTokens,observedTokens:receipt.observedTokens,
        visibilityValidated:receipt.visibilityValidated,lossMaskValidated:receipt.lossMaskValidated,
        fragmentationValidated:receipt.fragmentationValidated};
    }
    rows.push(row);
  }
  return {schema:'semantic-capability-ledger/1',producerRevision,
    contracts:{execution:'semantic-execution/5',trace:'semantic-trace/5',context:'semantic-context/5',
      continuation:'semantic-continuation/5',harness:'selected-harness/2'},
    environment:admissionEnvironment(),nativePolicy,unit:'declared source/input/fixture probe',rows,
    totals:summarizeCapabilityRows(rows),
    otherProfiles:['bounded-js-subset/2','static-module/1','evaluated-module/1'].map(profile=>({
      profile,status:'untested',reason:'This command measures the strict training path only; separate profile tests are not promoted to this ladder.'})),
    otherAdapters:[{adapter:'typescript/5.9.3',targetProfile:'training-js/1',status:'untested',
      reason:'Syntax lowering and source-map preservation require their separate adapter tests.'}],
    claims:{fullEcmaScript:false,fullTest262:false,optimizerSteps:0,learnedSuccess:null},
    limitation:'Finite probes measure distinctions, not exhaustive feature conformance. Native and model stages remain untested without executed evidence.'};
}
