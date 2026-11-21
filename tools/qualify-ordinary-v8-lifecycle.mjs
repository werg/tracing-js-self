#!/usr/bin/env node
// Exercise the ordinary command path at one exact pair with real assets.
// The two updates qualify optimizer/resume/export plumbing, not learned quality.
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,existsSync,cpSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const known=new Set(['--out','--producer-root','--megatoken','--python','--tokenizer','--native-policy','--source-id']);
const flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=process.argv[++i];
  if(!known.has(key)||flags.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Unknown, duplicate or incomplete ordinary lifecycle option: '+key);
  flags.set(key,value);
}
for(const key of ['--out','--megatoken','--python','--tokenizer'])
  if(!flags.has(key))throw new TypeError('Required ordinary lifecycle option: '+key);
const producer=resolve(flags.get('--producer-root')??fileURLToPath(new URL('..',import.meta.url))),
  consumer=resolve(flags.get('--megatoken')),out=resolve(flags.get('--out')),
  python=flags.get('--python'),tokenizer=resolve(flags.get('--tokenizer')),
  selectedId=flags.get('--source-id')??'promise-number-proxy-memory-join',seed=17;
const within=(root,path)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
if(within(producer,out)||within(consumer,out)||existsSync(out))
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
const {regionQualificationPopulation}=await moduleAt('fixtures/semantic-regions/qualification.js');
const {prepareRegionFamilyRegistry,bindRegionFamilySplit}=await moduleAt('src/semantic/dataset-v8.js');
const {verifyRegionTrainingCase}=await moduleAt('src/semantic/compiler-v8.js');
const population=regionQualificationPopulation({population:'interoperability',allInputs:true}),
  candidates=[...population.scripts,...population.modules],
  prepared=prepareRegionFamilyRegistry(candidates,{seed}),
  membership=prepared.members.find(member=>member.candidateId===selectedId);
if(!membership||prepared.identityById.get(membership.id).split!=='train')
  throw new Error('The predeclared lifecycle source must belong to the frozen training split');

mkdirSync(out);
const write=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n');
const env={...process.env,PYTHONPATH:join(consumer,'src'),OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'};
const report={schema:'semantic-ordinary-command-lifecycle/8',status:'running',producerRevision,consumerRevision,
  selectedId,seed,populationCount:candidates.length,registryDigest:prepared.registry.digest,
  nativePolicy:settings.policy,runnerSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  optimizerUpdates:0,learnedSuccess:null,stages:[],
  scope:'One predeclared training source, two ordinary optimizer updates, checkpoint resume, export and real service restoration. No held-out, accepted-record recovery or whole-program success claim.'};
const record=()=>write('command-report.json',report);
const run=(stage,command,args)=>{
  assertRoots();
  const log=stage+'.log',fd=openSync(join(out,log),'wx'),started=Date.now();let result;
  try{result=spawnSync(command,args,{cwd:consumer,env,stdio:['ignore',fd,fd],timeout:600000});}
  finally{closeSync(fd);}
  report.stages.push({stage,command:[command,...args],log,exitCode:result.status,
    signal:result.signal,error:result.error?.message??null,durationMs:Date.now()-started});record();
  if(result.error||result.status!==0)throw new Error('Ordinary lifecycle '+stage+' failed; see '+join(out,log));
  assertRoots();
};
try{
  record();
  write('frozen-population.json',{schema:'semantic-v8-ordinary-source-population/1',producerRevision,
    seed,declared:candidates.length,selectedId,candidates,
    scope:'Complete interoperability source inventory frozen before source execution or optimizer work.'});
  write('family-registry.json',prepared.registry);
  const source=await verifyRegionTrainingCase(candidates[membership.index]);
  write('source-result.json',source);
  if(!source.exported)throw new Error('Independent lifecycle source verification failed: '+source.reason);
  const bound=bindRegionFamilySplit(source.exported,membership,prepared.registry);
  write('source.json',bound);
  run('prepare',python,[join(consumer,'scripts/prepare_semantic_v8.py'),
    '--input',join(out,'source.json'),'--output',join(out,'prepared'),
    '--producer-root',producer,'--producer-revision',producerRevision,
    '--consumer-revision',consumerRevision,'--tokenizer-json',tokenizer,
    '--max-positions','128','--max-history','128']);
  const codec=JSON.parse(execFileSync(python,['-c',
    'import json,sys; from megatoken.generation.codec import ByteCodec,LING_TOKENIZER_SHA256; c=ByteCodec.from_tokenizer_json(sys.argv[1],expected_sha256=LING_TOKENIZER_SHA256); print(json.dumps({"vocabSize":c.vocab_size,"identity":c.fingerprint}))',tokenizer],
    {encoding:'utf8',cwd:consumer,env,timeout:30000}));
  if(codec.identity!==settings.policy.tokenizerIdentity||!Number.isSafeInteger(codec.vocabSize))
    throw new Error('Ordinary training codec differs from the admitted tokenizer');
  const configuration={purpose:'diagnostic',phase:'SC',model:'tiny',seed,codec:tokenizer,
    model_overrides:{vocab_size:codec.vocabSize,max_history_chunks:128,max_capacity:128},
    datasets:[join(out,'prepared')],output:join(out,'fit'),device:'cpu',precision:'fp32',
    max_steps:1,checkpoint_every:1,keep_checkpoints:2,microbatch_episodes:1,
    accumulate_scored:1,accumulate_ingested:1,max_accumulation_windows:1,
    generated_capacity:128,max_window_records:128,max_history_tokens:16384,
    gradient_checkpointing:false,expert_backend:'torch',semantic_v8_policy:{
      schema:'semantic-training-policy/8',producerRevision,consumerRevision,registryDigest:prepared.registry.digest}};
  write('training-config.json',configuration);
  const config=join(out,'training-config.json'),first=join(out,'first-checkpoint'),
    firstLive=join(out,'fit/checkpoints/SC-000000001-periodic'),
    resumed=join(out,'fit/checkpoints/SC-000000002-periodic'),served=join(out,'served');
  const completedStep=expected=>{
    const latest=JSON.parse(readFileSync(join(out,'fit/checkpoints/latest.json'),'utf8'));
    if(join(out,'fit/checkpoints',latest.checkpoint)!==expected)
      throw new Error('Ordinary trainer performed an unexpected number of updates');
    return JSON.parse(readFileSync(join(expected,'metadata.json'),'utf8')).global_step;
  };
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
  run('qualify-lifecycle',python,[join(consumer,'scripts/qualify_semantic_v8_lifecycle.py'),
    '--consumer-root',consumer,'--prepared',join(out,'prepared'),'--source',join(out,'source.json'),
    '--first-checkpoint',first,'--resumed-checkpoint',resumed,'--served',served,'--output',join(out,'qualification')]);
  const measured=JSON.parse(readFileSync(join(out,'qualification/summary.json'),'utf8'));
  report.status='passed';report.qualification='qualification/summary.json';
  report.limits=measured.limits;report.serving=measured.serving;record();
  console.log(JSON.stringify({output:out,producerRevision,consumerRevision,selectedId,
    declared:candidates.length,optimizerUpdates:2,status:report.status,learnedSuccess:null}));
}catch(error){report.status='failed';report.reason=error.message;record();throw error;}
