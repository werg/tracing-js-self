#!/usr/bin/env node
// Exercise the ordinary command path at one exact pair with real assets.
// The two updates qualify optimizer/resume/export plumbing, not learned quality.
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,existsSync,cpSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertIndependentPositionCoverage} from './semantic-v8-position-coverage.mjs';

const known=new Set(['--out','--producer-root','--megatoken','--python','--tokenizer','--native-policy','--source-id','--prepared-root','--source-inventory','--sample-source']);
const booleans=new Set(['--orchestration-teacher','--full-target-coverage']);
const flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(booleans.has(key)){
    if(flags.has(key))throw new TypeError('Duplicate ordinary lifecycle option: '+key);
    flags.set(key,true);continue;
  }
  const value=process.argv[++i];
  if(!known.has(key)||flags.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Unknown, duplicate or incomplete ordinary lifecycle option: '+key);
  flags.set(key,value);
}
for(const key of ['--out','--megatoken','--python','--tokenizer'])
  if(!flags.has(key))throw new TypeError('Required ordinary lifecycle option: '+key);
const producer=resolve(flags.get('--producer-root')??fileURLToPath(new URL('..',import.meta.url))),
  consumer=resolve(flags.get('--megatoken')),out=resolve(flags.get('--out')),
  python=flags.get('--python'),tokenizer=resolve(flags.get('--tokenizer')),
  selectedId=flags.get('--source-id')??'promise-number-proxy-memory-join',seed=17,
  orchestrationTeacher=flags.has('--orchestration-teacher'),
  fullTargetCoverage=flags.has('--full-target-coverage'),
  supportMode=flags.has('--prepared-root'),
  supportPrepared= supportMode ? resolve(flags.get('--prepared-root')) : null,
  supportInventory= supportMode ? resolve(flags.get('--source-inventory')??'') : null,
  supportSample= supportMode ? resolve(flags.get('--sample-source')??'') : null;
let supportInventoryForRun=supportInventory,supportSampleForRun=supportSample;
const within=(root,path)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
if(supportMode && (!flags.has('--source-inventory')||!flags.has('--sample-source')))
  throw new TypeError('Support lifecycle requires --source-inventory and --sample-source');
if(!supportMode && (flags.has('--source-inventory')||flags.has('--sample-source')))
  throw new TypeError('Support inventory and sample options require --prepared-root');
if(fullTargetCoverage&&!supportMode)
  throw new TypeError('Full target coverage requires the explicit prepared support corpus');
if(supportMode&&flags.has('--source-id'))
  throw new TypeError('Support lifecycle selects its source only from the admitted source artifact');
if(supportMode&&orchestrationTeacher)
  throw new TypeError('Support lifecycle uses the admitted source; do not attach a second teacher');
if(within(producer,out)||within(consumer,out)||supportMode&&
   (within(supportPrepared,out)||within(out,supportPrepared))||existsSync(out))
  throw new TypeError('Use a new output directory outside both pinned checkouts');
const moduleAt=path=>import(pathToFileURL(join(producer,path)));
const {loadNativeV8Settings}=await moduleAt('src/corpus/native-admission-v8.mjs');
const settings=loadNativeV8Settings({megatoken:consumer,python,tokenizer,
  policyFile:resolve(flags.get('--native-policy')??join(producer,'contracts/semantic-native-policy-v8.json')),
  temporaryDirectory:join(out,'native')});
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const producerRevision=settings.producerRevision,consumerRevision=settings.policy.consumerRevision;
const assertRoots=()=>{
  for(const [root,revision]of [[producer,producerRevision],[consumer,consumerRevision]])
    if(git(root,'rev-parse','HEAD')!==revision||git(root,'status','--porcelain','--untracked-files=all'))
      throw new Error('Ordinary lifecycle checkout changed during qualification: '+root);
};
assertRoots();
const {prepareRegionFamilyRegistry,bindRegionFamilySplit}=await moduleAt('src/semantic/dataset-v8.js');
const {verifyRegionTrainingCase}=await moduleAt('src/semantic/compiler-v8.js');
const {encodeGenerationTask}=await moduleAt('src/corpus/generation-process.mjs');
let candidates=[],prepared,membership,supportRegistry=null,sourceId=selectedId,
  supportInventoryBytes=null,supportSampleBytes=null;
if(supportMode){
  if(!existsSync(supportPrepared)||!existsSync(supportInventory)||!existsSync(supportSample))
    throw new Error('Support lifecycle inputs must already exist');
  supportInventoryBytes=readFileSync(supportInventory);
  supportSampleBytes=readFileSync(supportSample);
  supportRegistry=JSON.parse(readFileSync(join(supportPrepared,'semantic-v8-families.json'),'utf8'));
  const inventory=JSON.parse(supportInventoryBytes.toString('utf8'));
  const ids=inventory?.sourceIds;
  if(inventory?.schema!=='semantic-v8-source-population/1'||inventory.registryDigest!==supportRegistry.digest||
     !Array.isArray(ids)||ids.length!==64||new Set(ids).size!==64||ids.some(id=>typeof id!=='string'||!id))
    throw new Error('Support inventory must bind exactly 64 unique sources to the prepared registry');
  const {verifyRegionDatasetBinding,verifyRegionFamilyRegistry}=
    await moduleAt('src/semantic/family-registry-v8.js');
  const registryCheck=verifyRegionFamilyRegistry(supportRegistry);
  const registryIds=supportRegistry.sources?.map(row=>row.id);
  if(!registryCheck.valid||!Array.isArray(registryIds)||registryIds.length!==64||
     new Set(registryIds).size!==64||registryIds.some(id=>!ids.includes(id))||ids.some(id=>!registryIds.includes(id)))
    throw new Error('Prepared support registry differs from the immutable source inventory');
  const sample=JSON.parse(supportSampleBytes.toString('utf8'));
  const checked=verifyRegionDatasetBinding(sample,{expectedSplit:'train'});
  if(checked.registryDigest!==supportRegistry.digest||
     !isDeepStrictEqual(sample.sidecar.splitIdentity.registry,supportRegistry)||
     !ids.includes(checked.sourceId))
    throw new Error('Support sample binding differs from the exact registry or immutable inventory');
  sourceId=checked.sourceId;prepared={registry:supportRegistry};membership=null;
}else{
  const {regionQualificationPopulation}=await moduleAt('fixtures/semantic-regions/qualification.js');
  const population=regionQualificationPopulation({population:'interoperability',allInputs:true});
  candidates=[...population.scripts,...population.modules];
  prepared=prepareRegionFamilyRegistry(candidates,{seed});
  membership=prepared.members.find(member=>member.candidateId===selectedId);
  if(!membership||prepared.identityById.get(membership.id).split!=='train')
    throw new Error('The predeclared lifecycle source must belong to the frozen training split');
}

mkdirSync(out);
if(supportMode){
  const inventorySnapshot=join(out,'support-source-ids.json'),sampleSnapshot=join(out,'support-sample.json');
  writeFileSync(inventorySnapshot,supportInventoryBytes,{flag:'wx'});
  writeFileSync(sampleSnapshot,supportSampleBytes,{flag:'wx'});
  supportInventoryForRun=inventorySnapshot;supportSampleForRun=sampleSnapshot;
}
const write=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n');
const env={...process.env,PYTHONPATH:join(consumer,'src'),OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'};
const report={schema:'semantic-ordinary-command-lifecycle/8',status:'running',producerRevision,consumerRevision,
  selectedId:supportMode?sourceId:selectedId,seed,orchestrationTeacher,populationCount:supportMode?64:candidates.length,registryDigest:prepared.registry.digest,
  ...(supportMode?{supportPopulation:{count:64,fullLaunchQualified:false,optimizerTargetExposure:'two-step lifecycle plus pending target-inventory comparison'}}:{}),
  nativePolicy:settings.policy,runnerSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  optimizerUpdates:0,learnedSuccess:null,stages:[],
  fullTargetCoverageRequested:fullTargetCoverage,fullTargetCoverageQualified:false,
  targetCoverageStatus:fullTargetCoverage?'pending':'not-requested',
  scope:supportMode?(fullTargetCoverage?
    'Two-step resume/export/service route plus an explicitly selected bounded fresh ordinary training pass over the exact prequalified 64-source SE support corpus. Complete target-presence coverage requires its separate final checkpoint comparison; token or mask-position coverage and learned success remain unmeasured.':
    'Two ordinary optimizer updates, fresh resume, export and real service restoration over the exact prequalified 64-source SE support corpus, with measured partial target presence against the complete planner inventory. Full optimizer target coverage was not requested or qualified.'):
    'One predeclared training source, two ordinary optimizer updates, checkpoint resume, export and real service restoration. No held-out, accepted-record recovery or whole-program success claim.'};
const record=()=>write('command-report.json',report);
const run=(stage,command,args,{timeoutMs=600000}={})=>{
  assertRoots();
  const log=stage+'.log',fd=openSync(join(out,log),'wx'),started=Date.now();let result;
  try{result=spawnSync(command,args,{cwd:consumer,env,stdio:['ignore',fd,fd],timeout:timeoutMs});}
  finally{closeSync(fd);}
  report.stages.push({stage,command:[command,...args],log,exitCode:result.status,
    signal:result.signal,error:result.error?.message??null,durationMs:Date.now()-started});record();
  if(result.error||result.status!==0){
    process.stderr.write(readFileSync(join(out,log),'utf8').slice(-12000));
    throw new Error('Ordinary lifecycle '+stage+' failed; see '+join(out,log));
  }
  assertRoots();
};
try{
  record();
  if(supportMode){
    write('support-inventory.json',JSON.parse(readFileSync(supportInventoryForRun,'utf8')));
    write('family-registry.json',prepared.registry);
    cpSync(supportSampleForRun,join(out,'source.json'));
  }else{
    write('frozen-population.json',{schema:'semantic-v8-ordinary-source-population/1',producerRevision,
      seed,declared:candidates.length,selectedId,orchestrationTeacher,fixtureEncoding:'canonical-generation-fixture/1',
      tasks:candidates.map(fixture=>encodeGenerationTask({
        kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision})),
      scope:'Complete interoperability source inventory frozen before source execution or optimizer work.'});
    write('family-registry.json',prepared.registry);
  }
  const source=supportMode?{exported:JSON.parse(readFileSync(supportSampleForRun,'utf8'))}:await verifyRegionTrainingCase(candidates[membership.index]);
  if(!supportMode)write('source-result.json',source);
  if(!source.exported)throw new Error('Independent lifecycle source verification failed: '+source.reason);
  let exported=source.exported;
  if(orchestrationTeacher){
    const {attachSourceQualifiedOrchestrationV8,validateOrchestrationTranscriptV8}=
      await moduleAt('src/semantic/orchestration-training-v8.js');
    exported=await attachSourceQualifiedOrchestrationV8(exported);
    report.orchestration=validateOrchestrationTranscriptV8(exported);
    report.scope+=' This run also admits four source-qualified teacher lifecycle targets; their materialization does not assert that every target was consumed by the two optimizer updates.';
    record();
  }
  const bound=supportMode?exported:bindRegionFamilySplit(exported,membership,prepared.registry);
  if(!supportMode)write('source.json',bound);
  const trainingPrepared=supportMode?supportPrepared:join(out,'prepared');
  if(supportMode){
    run('requalify-support-supply',python,[join(consumer,'scripts/qualify_semantic_v8_supply.py'),
      '--prepared-root',supportPrepared,'--expected-source-ids',supportInventoryForRun,
      '--producer-revision',producerRevision,'--consumer-revision',consumerRevision,
      '--registry-digest',prepared.registry.digest,'--tokenizer-json',tokenizer,
      '--max-positions','128','--max-history','128','--output',join(out,'support-supply.json')]);
  }else{
    run('prepare',python,[join(consumer,'scripts/prepare_semantic_v8.py'),
      '--input',join(out,'source.json'),'--output',trainingPrepared,
      '--producer-root',producer,'--producer-revision',producerRevision,
      '--consumer-revision',consumerRevision,'--tokenizer-json',tokenizer,
      '--max-positions','128','--max-history','128']);
  }
  const codec=JSON.parse(execFileSync(python,['-c',
    'import json,sys; from megatoken.generation.codec import ByteCodec,LING_TOKENIZER_SHA256; c=ByteCodec.from_tokenizer_json(sys.argv[1],expected_sha256=LING_TOKENIZER_SHA256); print(json.dumps({"vocabSize":c.vocab_size,"identity":c.fingerprint}))',tokenizer],
    {encoding:'utf8',cwd:consumer,env,timeout:30000}));
  if(codec.identity!==settings.policy.tokenizerIdentity||!Number.isSafeInteger(codec.vocabSize))
    throw new Error('Ordinary training codec differs from the admitted tokenizer');
  const phase=supportMode?'SE':'SC';
  const configuration={purpose:'diagnostic',phase,model:'tiny',seed,codec:tokenizer,
    model_overrides:{vocab_size:codec.vocabSize,max_history_chunks:128,max_capacity:128},
    datasets:[trainingPrepared],output:join(out,'fit'),device:'cpu',precision:'fp32',
    max_steps:1,checkpoint_every:1,keep_checkpoints:2,microbatch_episodes:1,
    accumulate_scored:1,accumulate_ingested:1,max_accumulation_windows:1,
    generated_capacity:128,max_window_records:128,max_history_tokens:16384,
    gradient_checkpointing:false,expert_backend:'torch',semantic_v8_policy:{
      schema:'semantic-training-policy/8',producerRevision,consumerRevision,registryDigest:prepared.registry.digest}};
  write('training-config.json',configuration);
  const config=join(out,'training-config.json'),first=join(out,'first-checkpoint'),
    firstLive=join(out,'fit/checkpoints/'+phase+'-000000001-periodic'),
    resumed=join(out,'fit/checkpoints/'+phase+'-000000002-periodic'),served=join(out,'served');
  const completedStep=expected=>{
    const latest=JSON.parse(readFileSync(join(out,'fit/checkpoints/latest.json'),'utf8'));
    if(join(out,'fit/checkpoints',latest.checkpoint)!==expected)
      throw new Error('Ordinary trainer performed an unexpected number of updates');
    return JSON.parse(readFileSync(join(expected,'metadata.json'),'utf8')).global_step;
  };
  let targetInventory=null;
  const targetInventoryPath=join(out,'target-inventory.json');
  if(supportMode){
    run('inventory-positive-loss-targets',python,[join(consumer,'scripts/qualify_semantic_v8_target_inventory.py'),
      '--config',config,'--expected-source-ids',supportInventoryForRun,'--output',targetInventoryPath]);
    targetInventory=JSON.parse(readFileSync(targetInventoryPath,'utf8'));
    if(targetInventory.sourceIds.length!==48||targetInventory.trainEpisodeCount!==48||
       targetInventory.windowCount<1||targetInventory.optimizerWindowCount<1||
       targetInventory.phaseMeter!=='P'||targetInventory.onePassMeterCount>targetInventory.phaseBudget||
       targetInventory.registryDigest!==prepared.registry.digest)
      throw new Error('Positive-loss target inventory differs from exact 64-source support training split');
    console.log('V8_TARGET_INVENTORY_EVIDENCE_JSON '+JSON.stringify(targetInventory));
  }
  run('train-first',python,['-m','megatoken','train','--config',config]);
  cpSync(firstLive,first,{recursive:true,errorOnExist:true,force:false});
  report.optimizerUpdates=completedStep(firstLive);record();
  if(report.optimizerUpdates!==1)throw new Error('First ordinary trainer did not stop after one update');
  // max_steps bounds updates in this invocation, including after resume.
  // Reuse the unchanged one-update configuration for the second invocation.
  run('train-resume',python,['-m','megatoken','train','--config',config,'--resume',first]);
  report.optimizerUpdates=completedStep(resumed);record();
  if(report.optimizerUpdates!==2)throw new Error('Ordinary resume did not advance exactly one update');
  run('export',python,['-m','megatoken','export','--checkpoint',resumed,'--output',served,'--codec',tokenizer]);
  const lifecycleArgs=[join(consumer,'scripts/qualify_semantic_v8_lifecycle.py'),
    '--consumer-root',consumer,'--prepared',trainingPrepared,'--source',join(out,'source.json'),
    '--first-checkpoint',first,'--resumed-checkpoint',resumed,'--served',served,'--output',join(out,'qualification')];
  if(supportMode)lifecycleArgs.push('--expected-source-ids',supportInventoryForRun,
    '--target-inventory',targetInventoryPath);
  run('qualify-lifecycle',python,lifecycleArgs);
  const measured=JSON.parse(readFileSync(join(out,'qualification/summary.json'),'utf8'));
  const exposure=measured.optimizerResumeExport?.optimizerTargetExposure;
  if(exposure?.historyContinued!==true||exposure.registryDigest!==prepared.registry.digest||
     !exposure.firstCheckpointCounts||!exposure.resumedCounts||
     supportMode&&exposure.targetPresenceComparison?.inventoryDigest!==targetInventory.digest)
    throw new Error('Ordinary lifecycle collector did not retain the exact resumed target-exposure and inventory comparison');
  report.qualification='qualification/summary.json';
  report.optimizerTargetExposure=exposure;
  report.optimizerUpdateCounts={lifecycle:2,coverage:0,total:2};
  report.optimizerUpdatesScope='optimizerUpdates retains the original two-step lifecycle count; optimizerUpdateCounts reports lifecycle, separate coverage-fit and combined counts';
  if(supportMode){
    report.targetInventory={digest:targetInventory.digest,windowCount:targetInventory.windowCount,
      sourceIds:targetInventory.sourceIds,available:targetInventory.available,
      positiveWeight:targetInventory.positiveWeight};
    report.supportPopulation.optimizerTargetExposure='verified two-update target-presence subset; complete optimizer pass '+(fullTargetCoverage?'pending':'not requested');
    record();
  }
  if(fullTargetCoverage){
    const coverageConfig={...configuration,output:join(out,'fit-coverage'),
      max_steps:targetInventory.optimizerWindowCount,
      checkpoint_every:targetInventory.optimizerWindowCount,keep_checkpoints:1};
    const coverageConfigPath=join(out,'coverage-training-config.json');
    writeFileSync(coverageConfigPath,JSON.stringify(coverageConfig,null,2)+'\n',{flag:'wx'});
    report.coverageBudget={kind:'one-train-window-pass',windowCount:targetInventory.windowCount,
      optimizerWindowCount:targetInventory.optimizerWindowCount,phase:coverageConfig.phase,
      phaseMeter:targetInventory.phaseMeter,phaseBudget:targetInventory.phaseBudget,
      onePassMeterCount:targetInventory.onePassMeterCount,timeoutMs:7200000};
    run('train-full-target-window-pass',python,['-m','megatoken','train','--config',coverageConfigPath],
      {timeoutMs:7200000});
    const latest=JSON.parse(readFileSync(join(out,'fit-coverage/checkpoints/latest.json'),'utf8'));
    const coverageCheckpoint=join(out,'fit-coverage/checkpoints',latest.checkpoint);
    const coverageMetadata=JSON.parse(readFileSync(join(coverageCheckpoint,'metadata.json'),'utf8'));
    if(coverageMetadata.global_step!==targetInventory.optimizerWindowCount)
      throw new Error('Ordinary target coverage run stopped before its bounded one-pass update count');
    const coverageEvidencePath=join(out,'target-coverage-evidence.json');
    run('qualify-full-target-window-pass',python,[join(consumer,'scripts/qualify_semantic_v8_target_coverage.py'),
      '--checkpoint',coverageCheckpoint,'--prepared',trainingPrepared,
      '--expected-source-ids',supportInventoryForRun,'--inventory',targetInventoryPath,
      '--output',coverageEvidencePath]);
    const coverageEvidence=JSON.parse(readFileSync(coverageEvidencePath,'utf8'));
    if(coverageEvidence.consumerRevision!==consumerRevision||
       coverageEvidence.globalStep!==targetInventory.optimizerWindowCount||
       coverageEvidence.inventory?.digest!==targetInventory.digest||
       coverageEvidence.comparison?.allPositiveWeightTargetsExposed!==true||
       coverageEvidence.comparison?.exactOnePassCensus!==true||
       coverageEvidence.learnedSuccess!==null)
      throw new Error('Ordinary one-pass route did not prove exact target-presence coverage');
    assertIndependentPositionCoverage(coverageEvidence,targetInventory);
    report.targetCoverage=coverageEvidence;
    report.targetCoverageStatus='passed';
    report.fullTargetCoverageQualified=true;
    report.optimizerUpdateCounts={lifecycle:2,coverage:coverageMetadata.global_step,
      total:2+coverageMetadata.global_step};
    report.supportPopulation.optimizerTargetExposure='verified positive-weight target presence and independently reconstructed plain-text loss positions across all inventory keys';
    console.log('V8_TARGET_COVERAGE_EVIDENCE_JSON '+JSON.stringify(coverageEvidence));
  }
  report.limits=measured.limits;report.serving=measured.serving;
  report.status='passed';record();
  console.log(JSON.stringify({output:out,producerRevision,consumerRevision,selectedId:supportMode?sourceId:selectedId,
    declared:supportMode?64:candidates.length,optimizerUpdates:2,optimizerUpdateCounts:report.optimizerUpdateCounts,
    status:report.status,optimizerTargetExposure:report.optimizerTargetExposure,
    fullTargetCoverageRequested:report.fullTargetCoverageRequested,
    fullTargetCoverageQualified:report.fullTargetCoverageQualified,
    targetCoverageStatus:report.targetCoverageStatus,
    targetCoverage:report.targetCoverage??null,learnedSuccess:null,fullLaunchQualified:false}));
}catch(error){
  report.status='failed';report.reason=error.message;
  if(fullTargetCoverage){report.targetCoverageStatus='failed';report.fullTargetCoverageQualified=false;}
  record();throw error;
}
