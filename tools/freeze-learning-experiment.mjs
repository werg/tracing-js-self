#!/usr/bin/env node
// Freeze source membership, checkpoint schedule and decision rules BEFORE any
// optimizer launch. This file is PRIVATE: only each envelope enters the runner.
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {controlledEvaluationCase} from '../src/training/selected-evaluation.js';
import {measureExecutionDifficulty} from '../src/corpus/execution-difficulty.mjs';
import {verifyFrozenSplitIdentity} from '../src/corpus/source-registry.mjs';
import {canonicalFixturePlan} from '../src/training/fixture-broker.js';
import {hostOperation} from '../src/host/operations.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const executeFile=promisify(execFile);
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&rel!=='..'&&!isAbsolute(rel);};

export async function mapConcurrent(items,concurrency,operation){
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new TypeError('Verification concurrency must be 1..8');
  const results=new Array(items.length);let next=0,failure;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(!failure&&next<items.length){
      const index=next++;
      try{results[index]=await operation(items[index],index);}catch(error){failure??=error;}
    }
  }));
  if(failure)throw failure;
  return results;
}

export function scenarioIdentity(request){
  const programs=request.programs??[request.program],invocations=request.invocations??[request.invocation];
  const sourceFor=invocation=>programs.find(program=>program.programId===invocation.programId)??
    (programs.length===1?programs[0]:null);
  const shape=invocations.map(invocation=>{const program=sourceFor(invocation);
    if(!program)throw new TypeError('Invocation source absent while freezing auxiliary cohort');
    return {source:program.source,entry:program.entry,realmPolicy:invocation.realmPolicy,
      completionPolicy:invocation.completionPolicy};});
  const plan=canonicalFixturePlan(request.fixture);
  const order=plan.settlementOrder??plan.calls.flatMap((call,index)=>hostOperation(call.operation).kind==='promise'?[index]:[]);
  return {sourceKey:sha(JSON.stringify(shape)),
    inputKey:sha(JSON.stringify(invocations.map(invocation=>({graph:invocation.inputGraph,
      receiver:invocation.receiverValue,randomSeed:sourceFor(invocation).randomSeed??null})))),
    observationKey:sha(JSON.stringify(plan.calls)),scheduleKey:sha(JSON.stringify(order))};
}

export function learningCase(exported,{path,fileSha256,sourceReceipt,decoderSeed=17,includeTrainingEnvelope=false}={}){
  const side=exported?.sidecar;
  if(side?.admission!=='admitted'||side.nativeAdmission?.admitted!==true||
    side.referenceStatus!=='agreed'||side.splitIdentity?.policy!=='source-components/1')
    throw new TypeError('Learning requires actual native admission and frozen global source components');
  verifyFrozenSplitIdentity(side.splitIdentity,{family:side.sourceFamily,seed:side.seeds.split});
  if(!sourceReceipt?.identityValidated||sourceReceipt.identityDigest!==side.identityDigest||
    sourceReceipt.producerRevision!==side.producerRevision||
    !sourceReceipt.sourceValidated||!sourceReceipt.journalValidated||!sourceReceipt.replayValidated||
    !sourceReceipt.effectsValidated)
    throw new TypeError('Fresh source, replay and immutable identity receipt required');
  if(![17,29,43].includes(decoderSeed))throw new TypeError('Unsupported frozen decoder seed');
  const id=side.sourceFamily+'/'+side.taskId+'@'+side.identityDigest.slice(0,16);
  const fixture=controlledEvaluationCase(exported,{id,family:side.sourceFamily,split:side.split});
  const request=structuredClone(fixture.request);
  delete request.controlledSelectionsByRepresentation;
  const difficulty=measureExecutionDifficulty(exported),slices=new Set(['new-source']);
  if(side.splitIdentity.holdout)slices.add(side.splitIdentity.holdout.kind);
  if(fixture.expected.effects.length)slices.add('effects');else slices.add('pure-selected');
  if(difficulty.exceptionOutcomes)slices.add('valid-errors');
  if(fixture.expected.effects.some(effect=>['demo.listen','demo.unlisten','dom.on','dom.off','dom.setTimer','dom.stopTimer']
    .includes(effect.operation)))slices.add('cleanup');
  if(difficulty.activations>1)slices.add('retained-state');
  if(difficulty.finalAliasEdges)slices.add('aliasing');
  if(difficulty.mutationEvents)slices.add('mutation');
  const tokens=side.nativeAdmission.generatedTokens;
  if(!Number.isSafeInteger(tokens)||tokens<1)throw new TypeError('Actual native learner-token count required');
  slices.add(tokens<=512?'length-short':tokens<=2048?'length-medium':'length-long');
  slices.add(difficulty.peakHeapObjects<=64?'heap-small':'heap-large');
  const row={id,sourceTaskId:side.taskId,family:side.sourceFamily,split:side.split,
    sourceCluster:side.splitIdentity.componentId,ancestorIds:side.ancestorIds,
    registryDigest:side.splitIdentity.registryDigest,identityDigest:side.identityDigest,
    episodeDigest:sourceReceipt.episodeDigest,producerRevision:side.producerRevision,
    generatedTokens:tokens,path,fileSha256,sourceReceipt,scenario:scenarioIdentity(request),slices:[...slices].sort(),
    difficulty:{activations:difficulty.activations,maxCallDepth:difficulty.maxCallDepth,
      loopTrips:difficulty.loopTrips,peakHeapObjects:difficulty.peakHeapObjects,
      finalAliasEdges:difficulty.finalAliasEdges,mutationEvents:difficulty.mutationEvents,
      exceptionOutcomes:difficulty.exceptionOutcomes,asyncDependencyDepth:difficulty.asyncDependencyDepth,
      peakPendingEffects:difficulty.peakPendingEffects,learnerGeneratedTokens:tokens}};
  if(side.split!=='train'||includeTrainingEnvelope)Object.assign(row,{expected:fixture.expected,
    envelope:{schema:'semantic-evaluation-request/4',caseId:id,request,
      seed:decoderSeed,representation:'compact'}});
  return row;
}

export function diverseSubset(rows,maximum){
  if(!Number.isSafeInteger(maximum)||maximum<1)throw new TypeError('Positive case cap required');
  const groups=new Map();
  for(const row of [...rows].sort((a,b)=>a.id.localeCompare(b.id))){
    const list=groups.get(row.sourceCluster)??[];list.push(row);groups.set(row.sourceCluster,list);
  }
  const selected=[];
  while(groups.size&&selected.length<maximum)for(const component of [...groups.keys()].sort()){
    if(selected.length===maximum)break;
    const group=groups.get(component);selected.push(group.shift());if(!group.length)groups.delete(component);
  }
  return selected;
}

export function selectAuxiliaryCases(candidates,training,maximum=32){
  const selectedIds=new Set(training.map(row=>row.id)),eligible=[];
  for(const candidate of candidates){
    if(candidate.split!=='train'||selectedIds.has(candidate.id))continue;
    const sameSource=training.filter(row=>row.sourceCluster===candidate.sourceCluster&&
      row.scenario.sourceKey===candidate.scenario.sourceKey).sort((a,b)=>a.id.localeCompare(b.id));
    if(!sameSource.length)continue;
    if(sameSource.some(row=>['inputKey','observationKey','scheduleKey'].every(key=>row.scenario[key]===candidate.scenario[key])))continue;
    const sameInput=sameSource.filter(row=>row.scenario.inputKey===candidate.scenario.inputKey);
    let match,slices;
    if(!sameInput.length){match=sameSource[0];slices=['new-inputs-known-source'];}
    else{
      match=sameInput.find(row=>row.scenario.observationKey===candidate.scenario.observationKey)??sameInput[0];
      slices=[];
      if(match.scenario.observationKey!==candidate.scenario.observationKey)slices.push('different-observations');
      if(match.scenario.scheduleKey!==candidate.scenario.scheduleKey)slices.push('different-schedules');
    }
    eligible.push({...candidate,evaluationRole:'auxiliary-known-source',matchedTrainingId:match.id,
      auxiliarySlices:slices,slices:[...new Set([...candidate.slices.filter(slice=>slice!=='new-source'),...slices])].sort()});
  }
  return {available:eligible.length,selected:diverseSubset(eligible,maximum)};
}

async function main(){
  const corpora=[],flags=new Map();
  for(let i=2;i<process.argv.length;i+=2){
    const flag=process.argv[i],value=process.argv[i+1];
    if(!value||value.startsWith('--'))throw new TypeError('Missing value for '+flag);
    if(flag==='--corpus')corpora.push(realpathSync(resolve(value)));
    else if(flags.has(flag))throw new TypeError('Repeated option '+flag);
    else flags.set(flag,value);
  }
  const allowed=new Set(['--out','--tracer-root','--name','--mode','--optimizer-seeds','--decoder-seed',
    '--rollout-tokens','--rollout-timeout','--initialization-seed','--checkpoint-steps','--minimum-improvement','--maximum-slice-regression','--bootstrap-replicates',
    '--bootstrap-seed','--minimum-test-components','--train-examples','--validation-cases','--test-cases','--auxiliary-cases',
    '--training-window-records','--training-window-decisions','--train-timeout','--verification-concurrency']);
  for(const key of flags.keys())if(!allowed.has(key))throw new TypeError('Unknown option '+key);
  if(!corpora.length||!flags.has('--out')||!flags.has('--minimum-improvement'))
    throw new TypeError('Usage: freeze-learning-experiment.mjs --corpus DIR [--corpus DIR] --out PRIVATE.json --minimum-improvement 0.05 [--checkpoint-steps 8,16 --train-examples 32 --validation-cases 16 --test-cases 32]');
  const integer=(name,fallback,min,max)=>{const value=Number(flags.get(name)??fallback);
    if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError('Invalid '+name);return value;};
  const numeric=(name,fallback,min,max)=>{const value=Number(flags.get(name)??fallback);
    if(!Number.isFinite(value)||value<min||value>max)throw new TypeError('Invalid '+name);return value;};
  const seeds=(flags.get('--optimizer-seeds')??'17').split(',').map(Number);
  if(!seeds.length||new Set(seeds).size!==seeds.length||seeds.some(seed=>![17,29,43].includes(seed)))
    throw new TypeError('Declare unique optimizer seeds among 17,29,43');
  const mode=flags.get('--mode')??'exploratory';
  if(!['exploratory','confirmatory'].includes(mode)||mode==='confirmatory'&&seeds.length<3)
    throw new TypeError('Confirmatory experiments require at least three optimizer seeds');
  const steps=(flags.get('--checkpoint-steps')??'16').split(',').map(Number);
  if(!steps.length||steps.some(step=>!Number.isSafeInteger(step)||step<1||step>1000000)||
    steps.some((step,index)=>index&&step<=steps[index-1]))throw new TypeError('Checkpoint steps must be unique, positive and ascending');
  const tracer=realpathSync(resolve(flags.get('--tracer-root')??fileURLToPath(new URL('..',import.meta.url))));
  execFileSync('git',['-C',tracer,'diff','--quiet','HEAD','--']);
  const revision=execFileSync('git',['-C',tracer,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const decoderSeed=integer('--decoder-seed',17,17,43),initializationSeed=integer('--initialization-seed',17,17,43);
  if(![17,29,43].includes(decoderSeed)||![17,29,43].includes(initializationSeed))throw new TypeError('Unsupported decoder seed');
  const nativePolicy=JSON.parse(readFileSync(join(tracer,'contracts/native-admission-policy-v6.json'),'utf8'));
  const pending=[],seen=new Set(),manifests=[];
  for(const directory of corpora){
    const bytes=readFileSync(join(directory,'manifest.json')),manifest=JSON.parse(bytes);
    if(manifest.producerRevision!==revision)throw new TypeError('Corpus differs from the clean producer revision');
    manifests.push({path:join(directory,'manifest.json'),sha256:sha(bytes),counts:manifest.counts});
    for(const item of manifest.cases){
      if(item.status!=='admitted')continue;
      if(typeof item.path!=='string')throw new TypeError('Materialize compact campaign exports before freezing');
      const path=realpathSync(resolve(directory,item.path));
      if(!inside(directory,path))throw new TypeError('Candidate path escapes corpus');
      const bytes=readFileSync(path),exported=JSON.parse(bytes),side=exported.sidecar;
      if(seen.has(side.identityDigest))continue;
      if(side.nativePolicy.consumerRevision!==nativePolicy.consumerRevision||
        side.nativePolicy.tokenizerIdentity!==nativePolicy.tokenizerIdentity||
        side.nativePolicy.tokenizerSha256!==nativePolicy.tokenizerSha256)
        throw new TypeError('Native consumer/tokenizer release policy changed');
      pending.push({id:item.id,exported,path,fileSha256:sha(bytes)});
      seen.add(side.identityDigest);
    }
  }
  const verificationConcurrency=integer('--verification-concurrency',1,1,8);
  const candidates=await mapConcurrent(pending,verificationConcurrency,async item=>{
    const receipt=JSON.parse((await executeFile('node',[join(tracer,'tools/verify-effectful-admission.mjs'),item.path],
      {encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024})).stdout);
    // Detect any concurrent corpus edit between membership enumeration and
    // the source recheck. A rejected candidate aborts the entire declaration.
    if(sha(readFileSync(item.path))!==item.fileSha256)throw new TypeError('Candidate changed while freezing');
    const candidate=learningCase(item.exported,{path:item.path,fileSha256:item.fileSha256,
      sourceReceipt:receipt,decoderSeed,includeTrainingEnvelope:true});
    process.stderr.write(item.id+': frozen verified '+candidate.split+'\n');
    return candidate;
  });
  if(new Set(candidates.map(row=>row.registryDigest)).size!==1)throw new TypeError('All streams must share one frozen global source registry');
  const selected=Object.fromEntries(['train','validation','test'].map(split=>[split,
    diverseSubset(candidates.filter(row=>row.split===split),integer(split==='train'?'--train-examples':`--${split}-cases`,split==='train'?32:split==='validation'?16:32,1,100000))]));
  if(Object.values(selected).some(rows=>!rows.length))throw new TypeError('Need independently admitted training, validation and test components');
  const auxiliary=selectAuxiliaryCases(candidates,selected.train,integer('--auxiliary-cases',32,1,100000));
  const training=selected.train.map(({envelope,expected,...row})=>row);
  const count=rows=>({episodes:rows.length,sourceFamilies:new Set(rows.map(row=>row.family)).size,
    independentComponents:new Set(rows.map(row=>row.sourceCluster)).size,
    learnerGeneratedTokens:rows.reduce((n,row)=>n+row.generatedTokens,0)});
  const payload={schema:'semantic-learning-experiment/1',name:flags.get('--name')??'bounded-v5-transfer',
    frozenAt:new Date().toISOString(),mode,baseOrigin:'newly-initialized',optimizerSeeds:seeds,decoderSeed,initializationSeed,checkpointSteps:steps,
    producerRevision:revision,nativePolicy,sourceRegistryDigest:candidates[0].registryDigest,
    corpusManifests:manifests,sourceVerification:{scope:'every-admitted-candidate',concurrency:verificationConcurrency},
    training,validation:selected.validation,test:selected.test,auxiliary:auxiliary.selected,
    rolloutBudget:{nativeMaxTokensPerFragment:integer('--rollout-tokens',32,1,1024),
      maximumFragmentsPerDecision:64,secondsPerCase:integer('--rollout-timeout',120,1,300)},
    trainingBudget:{sampler:'native-sequential-permuted-episodes',
      maxWindowRecords:integer('--training-window-records',1,1,1024),
      maxScoredDecisions:integer('--training-window-decisions',2,1,1024),
      maxWindowTokens:16384,seconds:integer('--train-timeout',900,1,86400)},
    policy:{minimumUsefulImprovement:numeric('--minimum-improvement',null,Number.EPSILON,1),
      maximumCriticalSliceRegression:numeric('--maximum-slice-regression',0.05,0,1),
      confidence:0.95,bootstrapReplicates:integer('--bootstrap-replicates',2000,100,100000),
      bootstrapSeed:integer('--bootstrap-seed',101,0,0xffffffff),
      minimumConfirmatoryTestComponents:integer('--minimum-test-components',100,2,100000)},
    population:Object.fromEntries(['train','validation','test'].map(split=>[split,{
      available:count(candidates.filter(row=>row.split===split)),selected:count(selected[split])}])),
    auxiliaryPopulation:{available:auxiliary.available,selected:count(auxiliary.selected)},
    selection:'deterministic-round-robin-by-authenticated-source-component',
    privateExpectedOutcomes:true,injectedSelections:false,optimizerSteps:0,learnedSuccess:null,
    limits:['Selected continuation execution is measured separately from pure output transfer.',
      'Frozen source components do not establish absence from a pretrained model training corpus.',
      'A small exploratory cohort does not support a confirmatory generalization claim.']};
  const output=resolve(flags.get('--out'));mkdirSync(dirname(output),{recursive:true});
  const bytes=JSON.stringify(payload,null,2)+'\n';writeFileSync(output,bytes,{flag:'wx'});
  process.stdout.write(JSON.stringify({experiment:output,sha256:sha(bytes),population:payload.population,optimizerSeeds:seeds})+'\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{process.stderr.write(String(error.stack??error)+'\n');process.exitCode=1;});
