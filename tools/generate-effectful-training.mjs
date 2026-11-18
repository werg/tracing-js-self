#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serialize} from 'node:v8';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import * as admission from '../src/training/effectful-admit.js';
import {effectfulMetrics,checkCounterfactualPrefixes,effectfulFamilySplit} from '../src/training/effectful-admit.js';
import {semanticRecipeFamilies,SEMANTIC_TASK_TEMPLATES,SEMANTIC_RECIPE_VERSION,SEMANTIC_RECIPE_NAME,
  benchmarkFamiliesV1,BENCHMARK_ALGORITHMS,BENCHMARK_RECIPE_NAME,BENCHMARK_RECIPE_VERSION}
  from '../src/training/recipe-fixtures.js';
import {hostOperationContract} from '../src/host/operations.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {EXECUTION_VERSION,WITNESS_VERSION,CONTEXT_VERSION,HARNESS_PROFILE} from '../src/training/format.js';
import {CampaignStore,atomicWrite,identityHash} from '../src/corpus/campaign-store.mjs';
import {generationIdentity} from '../src/corpus/campaign-identity.mjs';
import {runGenerationProcess} from '../src/corpus/generation-process.mjs';
import {loadNativeSettings,createNativeConsumer} from '../src/corpus/native-admission-client.mjs';
import {buildSourceRegistry,verifySourceRegistry,frozenSplitIdentity,canonicalHash}
  from '../src/corpus/source-registry.mjs';
import {trustedRealSourceCases} from '../src/corpus/trusted-source-candidates.mjs';

const booleanFlags=new Set(['--require-native','--resume','--retry-failures','--compact-storage']);
const valueFlags=new Set(['--out','--megatoken','--tokenizer','--python','--recipe','--jobs','--native-policy',
  '--worker-memory-mb','--worker-timeout-ms','--max-output-bytes','--limit','--registry','--freeze-registry',
  '--source-stream','--per-family','--mutations-per-family']);
const flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const name=process.argv[i];
  if(flags.has(name)||!booleanFlags.has(name)&&!valueFlags.has(name))throw new Error('Unknown or repeated option '+name);
  if(booleanFlags.has(name))flags.set(name,true);
  else {const value=process.argv[++i];if(value==null||value.startsWith('--'))throw new Error('Missing value for '+name);flags.set(name,value);}
}
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(flags.get('--out')??'corpus/out/semantic-v5');mkdirSync(output,{recursive:true});
const recipe=flags.get('--recipe')??'engineering';
if(!['engineering','real-source',SEMANTIC_RECIPE_NAME,BENCHMARK_RECIPE_NAME].includes(recipe))throw new Error('Unknown source recipe');
const bounded=(flag,fallback,min,max)=>{const n=Number(flags.get(flag)??fallback);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(flag+' must be '+min+'..'+max);return n;};
const jobs=bounded('--jobs',1,1,8),limit=bounded('--limit',10000,1,10000);
const bounds={memoryMb:bounded('--worker-memory-mb',768,64,8192),
  timeoutMs:bounded('--worker-timeout-ms',120000,10,3600000),
  maxOutputBytes:bounded('--max-output-bytes',268435456,1024,1073741824)};
const native=loadNativeSettings({megatoken:flags.get('--megatoken'),tokenizer:flags.get('--tokenizer'),
  python:flags.get('--python')??'python3',policyFile:flags.get('--native-policy'),
  temporaryDirectory:join(output,'.native'),timeoutMs:bounds.timeoutMs,maxOutputBytes:bounds.maxOutputBytes});
if(flags.has('--require-native')&&!native)throw new Error('--require-native needs a pinned native consumer');
const nativeConsumer=createNativeConsumer(native),representation='compact';
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const normalizedSourceAst=source=>{
  const visit=value=>Array.isArray(value)?value.map(visit):value&&typeof value==='object'?
    Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','loc'].includes(key))
      .map(([key,item])=>[key,visit(item)])):value;
  return visit(parse(source,{ecmaVersion:'latest'}));
};
const tasks=[];
const sourceTask=fixture=>tasks.push({kind:'source',fixture});
if(recipe==='engineering'){
  for(const fixture of EFFECTFUL_ENGINEERING_FIXTURES)sourceTask(fixture);
  tasks.push({kind:'session',fixture:{id:'repeated-ingress',family:'async-counter',
    cases:EFFECTFUL_ENGINEERING_FIXTURES.slice(0,2)}});
}else if(recipe==='real-source'){
  for(const fixture of trustedRealSourceCases({root,
    streams:(flags.get('--source-stream')??'utilities,exercism,production').split(','),
    perFamily:bounded('--per-family',2,1,100),
    mutationsPerFamily:bounded('--mutations-per-family',0,0,512)}))sourceTask(fixture);
}else{
  const authoredFamilies=recipe===BENCHMARK_RECIPE_NAME?benchmarkFamiliesV1({representation}):semanticRecipeFamilies({representation});
  for(const family of authoredFamilies){
    sourceTask({...family.pure,role:'common-support'});sourceTask({...family.callbacks,role:'effectful'});
    tasks.push({kind:'session',fixture:{...family.repeated,role:'effectful'}});
  }
}
const sourceInventory=tasks.flatMap(task=>(task.kind==='source'?[task.fixture]:task.fixture.cases).map((fixture,index)=>({
  id:task.fixture.id+'-source-'+index,family:task.fixture.family,source:fixture.source,
  ancestorIds:fixture.ancestorIds??[],project:fixture.provenance?.upstream?.repository??'repository-authored',
  upstreamPath:fixture.provenance?.upstream?.path??null,
  upstreamRevision:fixture.provenance?.upstream?.revision??producerRevision})));
let registry=null;
if(flags.has('--registry')&&flags.has('--freeze-registry'))throw new Error('Choose an existing registry or freeze a new one');
if(flags.has('--registry')){registry=JSON.parse(readFileSync(resolve(flags.get('--registry')),'utf8'));verifySourceRegistry(registry);}
if(flags.has('--freeze-registry')){
  registry=buildSourceRegistry(sourceInventory);atomicWrite(resolve(flags.get('--freeze-registry')),JSON.stringify(registry,null,2)+'\n');
}
if(registry)for(const task of tasks){
  const splitIdentity=frozenSplitIdentity(registry,task.fixture.family);
  task.fixture={...task.fixture,splitIdentity,seed:registry.seed};
  if(task.kind==='session')task.fixture.cases=task.fixture.cases.map(fixture=>({...fixture,splitIdentity,seed:registry.seed}));
}
const selectedTasks=tasks.slice(0,limit);
const campaign=new CampaignStore(output,generationIdentity(root,{producerRevision,recipe,native,
  bounds,registryDigest:registry?canonicalHash(registry):null}),{resume:flags.has('--resume'),maxObjectBytes:bounds.maxOutputBytes});
const start=performance.now(),cases=[],exportEntries=new Map(),summaryById=new Map();
let resumed=0,next=0;const freshlyRun=new Set();
const abort=new AbortController();
const cancel=()=>abort.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
const persistCandidate=task=>{
  const inputs=(task.kind==='source'?[task.fixture]:task.fixture.cases??[]).map(fixture=>({
    source:campaign.putObject('sources',fixture.source),
    input:campaign.putObject('inputs',encodeNativeGraph(fixture.args??[])),
    fixture:campaign.putObject('fixtures',fixture.fixture??{calls:[]})}));
  return {kind:task.kind,id:task.fixture.id,family:task.fixture.family,
    // V8's data serializer retains undefined, -0, nonfinite numbers and aliases;
    // its exact runtime version is part of the immutable campaign identity.
    fixtureEncoding:'node-v8-serialized/base64',fixtureBytes:serialize(task.fixture).toString('base64'),inputs};
};
function record(fixture,entry){
  const summary=campaign.readObject(entry.result),details=summary.campaignSummary;
  let path=null;
  if(entry.public){
    exportEntries.set(fixture.id,entry);
    if(!flags.has('--compact-storage'))path=campaign.materialize(entry);
  }
  const row={id:fixture.id,family:fixture.family,status:entry.status,
    ...(fixture.role?{role:fixture.role}:{}),...(path?{path}:{}),
    ...(entry.public?{publicShard:entry.public,privateEvidence:entry.private,
      representation:'compact',split:details.split,episodeDigest:details.episodeDigest,
      identityDigest:details.identityDigest,metrics:details.metrics}:{}),
    ...(!entry.public?{reason:summary.reason??null}:{}),candidateDigest:entry.candidateDigest,
    durationMs:entry.durationMs,peakRssBytes:entry.peakRssBytes};
  summaryById.set(fixture.id,row);
  process.stderr.write(fixture.id+': '+entry.status+(summary.reason?' — '+summary.reason:'')+'\n');
}
const prepareResult=result=>{
  if(result.exported)result.campaignSummary={split:result.exported.sidecar.split,
    episodeDigest:hash(result.exported.public),identityDigest:result.exported.sidecar.identityDigest??null,
    metrics:effectfulMetrics(result.exported)};
  return result;
};
await Promise.all(Array.from({length:Math.min(jobs,selectedTasks.length)},async()=>{
  for(;;){
    if(abort.signal.aborted)return;
    const index=next++;if(index>=selectedTasks.length)return;
    const task=selectedTasks[index],candidate=persistCandidate(task);
    let entry=campaign.cached(task.fixture.id,candidate,{retryFailures:flags.has('--retry-failures')});
    if(entry)resumed++;
    else{
      const run=await runGenerationProcess({...task,native,producerRevision},
        {...bounds,outputDirectory:join(output,'.workers'),signal:abort.signal});
      entry=campaign.record(task.fixture.id,candidate,prepareResult(run.result),run);
      freshlyRun.add(task.fixture.id);
    }
    record(task.fixture,entry);
  }
}));
for(const task of selectedTasks)if(summaryById.has(task.fixture.id))cases.push(summaryById.get(task.fixture.id));
const lifecycleInputs=[];
if(!['engineering','real-source'].includes(recipe)&&!abort.signal.aborted&&selectedTasks.length===tasks.length){
  for(const split of ['train','validation']){
    let parent,exported;
    for(const item of cases){
      if(item.split!==split||!item.id.endsWith('-repeated')||!exportEntries.has(item.id))continue;
      const value=campaign.exported(exportEntries.get(item.id));
      if(value.sidecar.collection){parent=item;exported=value;break;}
    }
    if(!parent)throw new Error('Authored recipe has no verified repeated source family in '+split);
    const child=structuredClone(exported.sidecar.collection.components[0]);
    const fixture={id:parent.id.replace(/-repeated$/,'-child'),family:parent.family,role:'lifecycle-child'};
    const candidate={kind:'certified-lifecycle-child',parent:parent.candidateDigest,
      sourceIdentity:child.sidecar.identityDigest??hash(child.public)};
    let entry=campaign.cached(fixture.id,candidate,{retryFailures:flags.has('--retry-failures')});
    if(entry)resumed++;
    else{
      const childStart=performance.now();let result;
      try{
        if(nativeConsumer){const receipt=await nativeConsumer(child);
          admission.bindNativeAdmission(child,receipt,native.policy);}
        result={status:child.sidecar.admission,exported:child};
      }catch(error){result={status:'native_rejected',reason:String(error.message)};}
      entry=campaign.record(fixture.id,candidate,prepareResult(result),{durationMs:performance.now()-childStart,
        peakRssBytes:process.resourceUsage().maxRSS*1024});
      freshlyRun.add(fixture.id);
    }
    record(fixture,entry);cases.push(summaryById.get(fixture.id));
    lifecycleInputs.push({id:fixture.id,...(flags.has('--compact-storage')?{}:{path:fixture.id+'.json'}),
      family:fixture.family,split,representation});
  }
}
const counterfactuals=[];
for(const pair of [['counter-0','counter-1'],['branch-0','branch-1']])
  if(pair.every(id=>exportEntries.has(id)))counterfactuals.push({pair,
    ...checkCounterfactualPrefixes(...pair.map(id=>campaign.exported(exportEntries.get(id))))});
const counts={attempted:cases.length,admitted:0,locally_verified:0};
for(const item of cases)counts[item.status]=(counts[item.status]??0)+1;
const recipeMetadata=['engineering','real-source'].includes(recipe)?{name:recipe,
  ...(recipe==='real-source'?{sourceStreams:(flags.get('--source-stream')??'utilities,exercism,production').split(','),
    perFamily:Number(flags.get('--per-family')??2),mutationsPerFamily:Number(flags.get('--mutations-per-family')??0),
    authority:'fresh-original-transformed-owned-reference-native-gates',
    admittedByLocalFlag:false}:{} )}:recipe===BENCHMARK_RECIPE_NAME?{
  schema:BENCHMARK_RECIPE_VERSION,name:recipe,
  algorithms:BENCHMARK_ALGORITHMS.map(({name,body})=>({name,body,
    family:'semantic-benchmark-v1:'+name,ancestor:'source-algorithm-v1:'+name,
    split:effectfulFamilySplit('semantic-benchmark-v1:'+name),
    normalizedAstDigest:hash(normalizedSourceAst('function run(a,b){'+body+'}'))})),
  families:BENCHMARK_ALGORITHMS.map(({name})=>'semantic-benchmark-v1:'+name),
  splitCounts:Object.fromEntries(['train','validation','test'].map(split=>[split,
    BENCHMARK_ALGORITHMS.filter(({name})=>effectfulFamilySplit('semantic-benchmark-v1:'+name)===split).length])),
  normalizedAstDuplicateCount:BENCHMARK_ALGORITHMS.length-new Set(BENCHMARK_ALGORITHMS.map(({body})=>
    hash(normalizedSourceAst('function run(a,b){'+body+'}')))).size,
  normalizedAstAncestorDuplicateCount:BENCHMARK_ALGORITHMS.filter(({body})=>
    SEMANTIC_TASK_TEMPLATES.some(template=>hash(normalizedSourceAst('function run(a,b){return '+template.expression+';}'))===
      hash(normalizedSourceAst('function run(a,b){'+body+'}')))).length,
  retainEveryAuthoredFamily:true,lifecycleInputs,
  coverage:{familyCount:BENCHMARK_ALGORITHMS.length,
    splitCounts:Object.fromEntries(['train','validation','test'].map(split=>[split,
      BENCHMARK_ALGORITHMS.filter(({name})=>effectfulFamilySplit('semantic-benchmark-v1:'+name)===split).length])),
    sourceKinds:['pure','retained-callback-recovery','repeated-invocation','lifecycle-child'],
    familyRoles:Object.fromEntries(['common-support','effectful','lifecycle-child'].map(role=>[role,
      [...new Set(cases.filter(item=>item.role===role).map(item=>item.family))].length]))}
}:{schema:SEMANTIC_RECIPE_VERSION,name:recipe,
  templateDigest:hash(SEMANTIC_TASK_TEMPLATES),families:SEMANTIC_TASK_TEMPLATES.map(t=>'semantic-recipe:'+t.name),
  splitSeed:17,retainEveryAuthoredFamily:true,lifecycleInputs};
const manifest={schema:'semantic-corpus-manifest/4',execution:EXECUTION_VERSION,trace:WITNESS_VERSION,
  context:CONTEXT_VERSION,profile:HARNESS_PROFILE,producerRevision,
  representation:'compact',
  recipe:recipeMetadata,
  catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),
  counts,cases,counterfactuals,selectionOrigin:nativeConsumer?'certified_teacher':'owned-interpreter-teacher',
  evidenceKind:recipe==='real-source'?'pinned-real-source':'deterministic-engineering',optimizerSteps:0,learnedSuccess:null};
const elapsedMs=performance.now()-start;
const generatedTokens=cases.reduce((sum,row)=>sum+(row.metrics?.generatedTokens??0),0);
const fresh=cases.filter(row=>freshlyRun.has(row.id));
const freshTokens=fresh.filter(row=>row.status==='admitted').reduce((sum,row)=>sum+(row.metrics?.generatedTokens??0),0);
Object.assign(manifest,{campaign:{schema:'semantic-generation-summary/1',identityDigest:campaign.identityDigest,
  completed:cases.length,planned:selectedTasks.length+(!['engineering','real-source'].includes(recipe)&&selectedTasks.length===tasks.length?2:0),
  resumed,cancelled:abort.signal.aborted,log:'campaign.jsonl',publicRecords:'objects/public',
  privateEvidence:'objects/private',compatibilityExports:!flags.has('--compact-storage'),
  limits:bounds,workers:jobs,receiptCache:'full-source-profile-runtime-verifier-identity'},
  sourceRegistry:registry?{digest:canonicalHash(registry),...registry.diagnostics}:null,
  throughput:{elapsedMs,totalVerificationMs:cases.reduce((n,row)=>n+row.durationMs,0),
    peakWorkerRssBytes:Math.max(0,...cases.map(row=>row.peakRssBytes??0)),
    admittedGeneratedTokens:native?generatedTokens:null,
    admittedLearnerTokensPerHour:native&&elapsedMs>0?freshTokens*3600000/elapsedMs:null,
    newlyGeneratedCases:fresh.length,newlyAdmittedGeneratedTokens:native?freshTokens:null,
    freshVerificationMs:fresh.reduce((n,row)=>n+row.durationMs,0),
    verifiedFamiliesPerHour:elapsedMs>0?new Set(fresh.filter(row=>['admitted','locally_verified'].includes(row.status)).map(row=>row.family)).size*3600000/elapsedMs:0,
    completedFamilies:new Set(cases.filter(row=>['admitted','locally_verified'].includes(row.status)).map(row=>row.family)).size,
    uniquePathsPerHour:null,
    publicBytes:cases.reduce((n,row)=>n+(row.publicShard?.bytes??0),0),
    compressedPrivateBytes:cases.reduce((n,row)=>n+(row.privateEvidence?.bytes??0),0),
    bytesPerAdmission:counts.admitted?cases.filter(row=>row.status==='admitted').reduce((n,row)=>n+
      (row.publicShard?.bytes??0)+(row.privateEvidence?.bytes??0),0)/counts.admitted:null},
  limitations:['Workers are bounded trusted-source processes; OS-level isolation for untrusted programs remains required.',
    'Worker heap limits are V8 heap limits, not whole-process cgroup memory limits.',
    'Unique executed-path throughput is unmeasured; episode/family counts do not substitute for it.']});
atomicWrite(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
if(abort.signal.aborted)process.exitCode=130;
else if(cases.some(item=>item.status!==(nativeConsumer?'admitted':'locally_verified')))
  process.exitCode=1;
