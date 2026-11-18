#!/usr/bin/env node
// One reproducible current-v5 baseline. Each completed check and its logs are
// durable before the next check starts. No historical receipt is relabeled.
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {admissionEnvironment} from '../src/training/admission-identity.js';
import {producerSnapshot,compareProducerSnapshot,compareReleaseEnvironment} from './lib/baseline-identity.mjs';

process.env.TZ='UTC';
const root=fileURLToPath(new URL('..',import.meta.url));
const options=new Map(),booleans=new Set(['--skip-unit','--skip-recipes']);
const valued=new Set(['--out','--jobs','--megatoken','--python','--tokenizer','--native-policy','--check-timeout-ms']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];if(options.has(key)||!booleans.has(key)&&!valued.has(key))throw new Error('Unknown or repeated option '+key);
  if(booleans.has(key))options.set(key,true);
  else {const value=process.argv[++i];if(!value||value.startsWith('--'))throw new Error('Missing '+key);options.set(key,value);}
}
if(!options.get('--out'))throw new Error('Usage: npm run baseline:v6 -- --out DIRECTORY [--jobs 2] [--check-timeout-ms 900000] [--megatoken DIR --tokenizer FILE --python PYTHON]');
const output=resolve(options.get('--out')),jobs=Number(options.get('--jobs')??2);
if(!Number.isInteger(jobs)||jobs<1||jobs>8)throw new Error('--jobs must be 1..8');
const checkTimeoutMs=Number(options.get('--check-timeout-ms')??900000);
if(!Number.isSafeInteger(checkTimeoutMs)||checkTimeoutMs<1000||checkTimeoutMs>3600000)
  throw new Error('--check-timeout-ms must be an integer from 1000 to 3600000');
if(existsSync(join(output,'baseline.json'))||existsSync(join(output,'baseline-start.json')))
  throw new Error('Baseline reports are immutable; choose a fresh output directory');
mkdirSync(output,{recursive:true});mkdirSync(join(output,'.tmp'),{recursive:true});
const env={...process.env,TMPDIR:join(output,'.tmp'),TZ:'UTC',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const initialProducer=producerSnapshot(root);
if(initialProducer.trackedChanges)throw new Error('A reproducible baseline needs a clean producer checkout; commit changes or use an immutable worktree');
const lockedEnvironment=JSON.parse(readFileSync(join(root,'profiles/release-environment.lock.json'),'utf8'));
const actualEnvironment={node:process.versions.node,v8:process.versions.v8,
  npm:execFileSync('npm',['--version'],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),
  platform:process.platform,arch:process.arch,timezone:env.TZ,locale:env.LC_ALL};
const environmentMismatches=compareReleaseEnvironment(lockedEnvironment,actualEnvironment);
const report={schema:'semantic-v5-baseline/1',producerRevision:git('rev-parse','HEAD'),
  producerTree:git('rev-parse','HEAD^{tree}'),workingTreeClean:git('status','--porcelain','--untracked-files=no')==='',
  environment:admissionEnvironment(),executionEnvironment:{timezone:env.TZ,locale:env.LC_ALL},
  executionLimits:{checkTimeoutMs,testConcurrency:jobs},
  lockDigests:Object.fromEntries(['package-lock.json','tools/spec-oracle/package-lock.json',
    'tools/native-consumer/requirements.lock','profiles/release-environment.lock.json',
    'contracts/native-admission-policy-v6.json','contracts/semantic-harness-v6.json',
    'contracts/host-operations-v4.json'].map(path=>[path,existsSync(join(root,path))?sha(readFileSync(join(root,path))):null])),
  qualificationEnvironment:{status:Object.keys(environmentMismatches).length?'failed':'passed',
    actual:actualEnvironment,mismatches:environmentMismatches},
  checks:[],corpora:[],optimizerSteps:0,learnedSuccess:null};
writeFileSync(join(output,'baseline-start.json'),JSON.stringify(report,null,2)+'\n');
let producerChanged=false;
function check(name,command,args,{timeout=checkTimeoutMs}={}){
  const before=producerSnapshot(root),beforeMismatch=compareProducerSnapshot(initialProducer,before);
  if(producerChanged||beforeMismatch.length){
    producerChanged=true;
    const row={name,command:[command,...args],status:'untested',reason:'Producer identity changed; remaining checks were not run',
      producerBefore:before,identityFailures:beforeMismatch};
    report.checks.push(row);appendFileSync(join(output,'checks.jsonl'),JSON.stringify(row)+'\n');
    return row;
  }
  const start=performance.now();
  const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout,maxBuffer:64*1024*1024});
  const stdout=result.stdout??'',stderr=result.stderr??'';
  writeFileSync(join(output,name+'.stdout.log'),stdout);writeFileSync(join(output,name+'.stderr.log'),stderr);
  const after=producerSnapshot(root),identityFailures=compareProducerSnapshot(initialProducer,after);
  producerChanged=identityFailures.length>0;
  const row={name,command:[command,...args],status:result.status===0&&!producerChanged?'passed':'failed',exitCode:result.status,
    signal:result.signal??null,reason:result.error?.message??null,timeoutMs:timeout,wallSeconds:(performance.now()-start)/1000,
    producerBefore:before,producerAfter:after,identityFailures,
    stdout:{path:name+'.stdout.log',sha256:sha(stdout)},stderr:{path:name+'.stderr.log',sha256:sha(stderr)}};
  if(name==='unit')row.counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled','todo'].map(key=>{
    const match=stdout.match(new RegExp('^# '+key+' (\\d+)$','m'));return [key,match?Number(match[1]):null];
  }));
  report.checks.push(row);appendFileSync(join(output,'checks.jsonl'),JSON.stringify(row)+'\n');
  process.stderr.write(name+': '+row.status+' ('+row.wallSeconds.toFixed(1)+'s)\n');
  return row;
}
if(!options.has('--skip-unit')){
  check('unit',process.execPath,['--test','--test-reporter=tap','--test-concurrency='+jobs,...readdirSync(join(root,'test')).filter(path=>path.endsWith('.test.js')).sort().map(path=>'test/'+path)]);
  check('reference-fixture',process.execPath,['fixtures/reference/reference-fixture.mjs']);
}else report.checks.push({name:'unit',status:'untested',reason:'Explicit --skip-unit'});
check('host-contract',process.execPath,['tools/generate-host-contract.mjs','--check']);
check('semantic-contract',process.execPath,['tools/generate-semantic-contract.mjs','--check']);
check('semantic-inspection',process.execPath,['tools/inspect-semantic-reasoning.mjs']);
check('teacher-mutations',process.execPath,['tools/audit-teacher-mutations.mjs','--out',join(output,'teacher-mutations.json')]);
check('target-gallery',process.execPath,['tools/semantic-trace-gallery.mjs','--out',join(output,'target-gallery')]);
check('target-gallery-compact',process.execPath,['tools/semantic-trace-gallery.mjs','--out',join(output,'target-gallery-compact'),'--local-state-compaction']);
check('summary-prototype',process.execPath,['tools/semantic-summary-experiment.mjs','--demo','--out',join(output,'summary-prototype')]);
const native=[];
if(options.has('--megatoken')||options.has('--tokenizer')){
  if(!options.has('--megatoken')||!options.has('--tokenizer'))throw new Error('Native checks require both --megatoken and --tokenizer');
  for(const key of ['--megatoken','--tokenizer'])native.push(key,resolve(options.get(key)));
  native.push('--python',options.get('--python')??'python3','--native-policy',resolve(options.get('--native-policy')??join(root,'contracts/native-admission-policy-v6.json')),'--require-native');
}
check('capability-ledger',process.execPath,['tools/generate-capability-ledger.mjs','--out',join(output,'capabilities.json'),...native]);
const registry=join(output,'source-registry.json');
if(!options.has('--skip-recipes'))check('source-registry',process.execPath,[
  'tools/freeze-source-registry.mjs','--out',registry,'--holdout-projects','exercism/javascript',
  '--holdout-compositions','square/even/maximum/alias/return']);
if(!options.has('--skip-recipes'))for(const recipe of ['engineering','training-v4','benchmark-v1']){
  const directory=join(output,recipe);
  check('corpus-'+recipe,process.execPath,['tools/generate-effectful-training.mjs','--recipe',recipe,'--jobs',String(jobs),'--out',directory,'--registry',registry,...native]);
  const path=join(directory,'manifest.json');
  if(existsSync(path)){
    const manifest=JSON.parse(readFileSync(path,'utf8'));
    if(manifest.producerRevision!==report.producerRevision){
      producerChanged=true;
      report.checks.push({name:'identity-'+recipe,status:'failed',reason:'Corpus producer differs from baseline revision'});
    }
    report.corpora.push({recipe,path:relative(output,path),sha256:sha(readFileSync(path)),counts:manifest.counts,
      families:new Set(manifest.cases.map(row=>row.family)).size,
      splitFamilies:Object.fromEntries(['train','validation','test'].map(split=>[split,new Set(manifest.cases.filter(row=>row.split===split).map(row=>row.family)).size])),
      lifecycleDispositions:manifest.recipe?.lifecycleDispositions??manifest.lifecycleDispositions??[],
      evidenceStage:native.length?'native-admission':'local-verification'});
  }
}
report.producerAtFinish=producerSnapshot(root);
report.identityFailures=compareProducerSnapshot(initialProducer,report.producerAtFinish);
report.status=producerChanged||report.identityFailures.length||Object.keys(environmentMismatches).length||
  report.checks.some(row=>row.status==='failed')?'failed':'passed';
if(existsSync(registry))report.sourceRegistry={path:'source-registry.json',sha256:sha(readFileSync(registry)),
  diagnostics:JSON.parse(readFileSync(registry,'utf8')).diagnostics};
report.evidenceBoundaries={acquisition:'not measured here',nativeAdmission:native.length?'executed; inspect per-corpus counts':'untested',
  browser:'untested; run npm run test:browser separately',modelEvaluation:'untested',learningImprovement:'unmeasured'};
report.activePolicy={publicRepresentation:'semantic-trace/6',sourceChecks:'effectful-source-checks/5',
  defaultProjection:'frozen-v5-control',
  nativePolicy:JSON.parse(readFileSync(join(root,'contracts/native-admission-policy-v6.json'),'utf8')),
  nativePolicyExecuted:native.length>0,containerDigest:lockedEnvironment.containerDigest,
  summaryPromotion:'experimental-only; native and learned behavior unmeasured'};
report.historicalEvidence=['docs/evidence/qualification-I-2026-11-18.json',
  'docs/evidence/semantic-v5/real-source-native-capped-release-D-2026-11-18.json',
  'docs/evidence/learning-diagnostics-2026-11-18.json',
  'docs/evidence/native-input-parity-2026-11-18.json'].filter(path=>existsSync(join(root,path))).map(path=>({
    path,sha256:sha(readFileSync(join(root,path))),authority:'Original receipt identity only; not reattributed to this baseline'}));
report.nextExperiment={name:'versioned-native-conditioning-parity-then-bounded-convergence',
  gates:['identical native training and serving input evidence','same-checkpoint conditional parity',
    'fresh prepared data and checkpoint after conditioning changes','declared bounded L1/L2 evaluation'],
  modelExecutedByThisBaseline:false};
writeFileSync(join(output,'baseline.json'),JSON.stringify(report,null,2)+'\n');
const status=['# Execution-training baseline','',
  'This receipt applies only to producer `'+report.producerRevision+'` (tree `'+report.producerTree+'`).',
  'Overall local status: **'+report.status+'**. Native admission: **'+report.evidenceBoundaries.nativeAdmission+'**.',
  'No model optimization or learned execution is asserted by this baseline.','',
  '| Check | Result | Seconds |','| --- | --- | ---: |',
  ...report.checks.map(row=>'| '+row.name+' | '+row.status+' | '+(row.wallSeconds?.toFixed(2)??'—')+' |'),'',
  'Each check retains its own stdout/stderr hashes and the producer identity before and after execution in `baseline.json`.',
  'Original I/D/learning receipts retain their original revisions; the manifest binds their current bytes without transferring their qualification.',
  'The next model experiment must first pass the native input/conditional parity gates and use newly qualified artifacts after any conditioning change.',''];
writeFileSync(join(output,'STATUS.md'),status.join('\n'));
console.log(JSON.stringify({report:join(output,'baseline.json'),status:report.status,checks:report.checks.length,corpora:report.corpora}));
if(report.status!=='passed')process.exitCode=1;
