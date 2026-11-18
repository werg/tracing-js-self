#!/usr/bin/env node
// Freeze a small diagnostic cohort. This is deliberately not the production
// semantic-evaluation-cohort/4 or a substitute for SE/SC launch qualification.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {controlledEvaluationCase} from '../src/training/selected-evaluation.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const inside=(root,path)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../');};

export function holdoutCase(exported,{seed=17,id,build=controlledEvaluationCase}={}){
  if(exported?.sidecar?.admission!=='admitted'||exported.sidecar.split!=='test'||
    exported.sidecar.nativeAdmission?.admitted!==true)
    throw new TypeError('Exploratory holdout requires natively admitted test examples');
  if(![17,29,43].includes(seed))throw new TypeError('Use a declared evaluation seed');
  const fixture=build(exported,{id}),request=structuredClone(fixture.request);
  delete request.controlledSelectionsByRepresentation;
  return {id:fixture.id,family:fixture.family,split:'test',expected:fixture.expected,
    envelope:{schema:'semantic-evaluation-request/4',caseId:fixture.id,request,
      seed,representation:'compact'}};
}

export function requireDisjointComponent(split,trainingComponents,registryDigest){
  if(split?.policy!=='source-components/1'||split.split!=='test'||
    split.registryDigest!==registryDigest||typeof split.componentId!=='string')
    throw new TypeError('Holdout must use the same authenticated test-component registry');
  if(trainingComponents.has(split.componentId))
    throw new TypeError('Holdout component occurs in the prepared training corpus');
}

export async function freezeExploratoryHoldout({trainingRun,corpora,tracerRoot,registryPath,output,
    maximum=32,seed=17}){
  trainingRun=resolve(trainingRun);tracerRoot=resolve(tracerRoot);
  registryPath=resolve(registryPath);corpora=corpora.map(path=>resolve(path));
  const reportPath=resolve(trainingRun,'report.json'),training=read(reportPath);
  if(training.schema!=='optimization-smoke/1'||training.status!=='completed'||
    training.purpose!=='diagnostic'||training.generalizationClaim!==false||
    !Number.isSafeInteger(training.optimizerSteps)||training.optimizerSteps<1)
    throw new Error('A completed actual optimization diagnostic is required');
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>128)
    throw new TypeError('Exploratory cohort cap must be between 1 and 128');
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:tracerRoot,encoding:'utf8'}).trim();
  execFileSync('git',['diff','--quiet','HEAD','--'],{cwd:tracerRoot});
  if(revision!==training.producerRevision)throw new Error('Frozen source verifier revision differs');
  const load=name=>import(pathToFileURL(resolve(tracerRoot,name)).href);
  const [{verifySourceRegistry},{verifyAdmissionIdentity},{controlledEvaluationCase:build}]=await Promise.all([
    load('src/corpus/source-registry.mjs'),load('src/training/admission-identity.js'),
    load('src/training/selected-evaluation.js')]);
  const registry=read(registryPath),registryCheck=verifySourceRegistry(registry);
  const trainingComponents=new Set(),trainingFamilies=new Set();
  for(const item of training.inputIdentities){
    const bytes=readFileSync(item.path);
    if(sha(bytes)!==item.sha256)throw new Error('Prepared training input bytes changed');
    const exported=JSON.parse(bytes),side=exported.sidecar;
    verifyAdmissionIdentity(exported);
    if(side.split!=='train'||side.splitIdentity?.registryDigest!==registryCheck.digest)
      throw new Error('Training member does not belong to the same frozen training registry');
    trainingComponents.add(side.splitIdentity.componentId);trainingFamilies.add(side.sourceFamily);
  }
  if(!trainingComponents.size)throw new Error('No authenticated training components');
  const sources=[],groups=new Map(),seen=new Map();
  for(const corpus of corpora){
    const manifestPath=resolve(corpus,'manifest.json'),manifest=read(manifestPath);
    if(manifest.producerRevision!==revision)throw new Error('Holdout corpus producer revision differs');
    sources.push({path:corpus,manifestSha256:sha(readFileSync(manifestPath))});
    for(const row of manifest.cases){
      if(row.status!=='admitted'||row.split!=='test'||typeof row.path!=='string')continue;
      const path=resolve(corpus,row.path);
      if(!inside(corpus,path))throw new Error('Holdout input path escapes its corpus');
      const bytes=readFileSync(path),exported=JSON.parse(bytes),side=exported.sidecar;
      verifyAdmissionIdentity(exported,{expectedIdentityDigest:row.identityDigest});
      if(side.producerRevision!==revision||side.nativeAdmission?.consumerRevision!==training.consumerRevision||
        side.nativeAdmission?.tokenizerIdentity!==training.tokenizerIdentity||
        side.sourceFamily!==row.family||sha(JSON.stringify(exported.public))!==row.episodeDigest)
        throw new Error('Holdout manifest, native admission, or identity binding differs');
      requireDisjointComponent(side.splitIdentity,trainingComponents,registryCheck.digest);
      if(seen.has(row.id)){
        if(seen.get(row.id)!==row.episodeDigest)throw new Error('Holdout candidate ID has conflicting bytes');
        continue;
      }
      seen.set(row.id,row.episodeDigest);
      const entry={...holdoutCase(exported,{seed,id:row.id,build}),sourceCluster:side.splitIdentity.componentId,
        componentMembers:side.splitIdentity.members,inputPath:path,inputSha256:sha(bytes),
        identityDigest:side.identityDigest,episodeDigest:row.episodeDigest,
        generatedTokens:row.metrics?.generatedTokens,
        publicBytes:row.publicShard?.uncompressedBytes};
      const group=groups.get(entry.sourceCluster)??[];group.push(entry);groups.set(entry.sourceCluster,group);
    }
  }
  const cost=row=>[Number.isSafeInteger(row.generatedTokens)?row.generatedTokens:Infinity,
    Number.isSafeInteger(row.publicBytes)?row.publicBytes:Infinity,row.id];
  const order=(a,b)=>{const x=cost(a),y=cost(b);return x[0]-y[0]||x[1]-y[1]||x[2].localeCompare(y[2]);};
  const cases=[...groups.values()].map(rows=>rows.sort(order)[0])
    .sort((a,b)=>a.family.localeCompare(b.family)||a.id.localeCompare(b.id)).slice(0,maximum);
  if(!cases.length)throw new Error('No independent native-admitted test components');
  const cohort={schema:'exploratory-heldout-diagnostic-cohort/1',createdAt:new Date().toISOString(),
    purpose:'diagnostic',confirmatory:false,productionQualification:false,
    selectionPolicy:'One smallest generated-token example per frozen test component; then public bytes and ID. Alphabetical family order if capped.',
    seed,representation:'compact',producerRevision:revision,consumerRevision:training.consumerRevision,
    tokenizerIdentity:training.tokenizerIdentity,tokenizerSha256:training.tokenizerSha256,
    trainingReport:{path:reportPath,sha256:sha(readFileSync(reportPath)),optimizerSteps:training.optimizerSteps},
    registry:{path:registryPath,fileSha256:sha(readFileSync(registryPath)),digest:registryCheck.digest},
    sourceCorpora:sources,trainingComponents:[...trainingComponents].sort(),
    trainingFamilies:[...trainingFamilies].sort(),availableTestComponents:groups.size,
    testComponents:cases.map(row=>row.sourceCluster),families:cases.map(row=>row.family),cases,
    limits:{modelTokens:128,caseTimeoutSeconds:120,cleanupTimeoutSeconds:10},
    limitations:['One optimizer seed and a newly initialized diagnostic model.',
      'The cohort is frozen before held-out inference, after observing held-in diagnostic failures.',
      'This bounded representative sample does not measure the full held-out distribution.',
      'No production semantic experiment budget or SE/SC launch qualification is claimed.']};
  writeFileSync(output,JSON.stringify(cohort,null,2)+'\n',{flag:'wx'});
  return {path:resolve(output),sha256:sha(readFileSync(output)),cases:cases.length,
    independentComponents:cases.length,families:cohort.families};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const flags=new Map(),corpora=[];
  for(let i=2;i<process.argv.length;i+=2){
    if(process.argv[i]==='--corpus')corpora.push(process.argv[i+1]);
    else flags.set(process.argv[i],process.argv[i+1]);
  }
  for(const flag of ['--training-run','--tracer-root','--registry','--output'])
    if(!flags.get(flag))throw new TypeError('Missing '+flag);
  if(!corpora.length)throw new TypeError('At least one --corpus is required');
  console.log(JSON.stringify(await freezeExploratoryHoldout({trainingRun:flags.get('--training-run'),corpora,
    tracerRoot:flags.get('--tracer-root'),registryPath:flags.get('--registry'),output:flags.get('--output'),
    maximum:Number(flags.get('--maximum')??32),seed:Number(flags.get('--seed')??17)})));
}
