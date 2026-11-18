#!/usr/bin/env node
// One reproducible current-v5 baseline. Each completed check and its logs are
// durable before the next check starts. No historical receipt is relabeled.
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {admissionEnvironment} from '../src/training/admission-identity.js';

process.env.TZ='UTC';
const root=fileURLToPath(new URL('..',import.meta.url));
const options=new Map(),booleans=new Set(['--skip-unit','--skip-recipes']);
const valued=new Set(['--out','--jobs','--megatoken','--python','--tokenizer','--native-policy']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];if(options.has(key)||!booleans.has(key)&&!valued.has(key))throw new Error('Unknown or repeated option '+key);
  if(booleans.has(key))options.set(key,true);
  else {const value=process.argv[++i];if(!value||value.startsWith('--'))throw new Error('Missing '+key);options.set(key,value);}
}
if(!options.get('--out'))throw new Error('Usage: npm run baseline:v5 -- --out DIRECTORY [--jobs 2] [--megatoken DIR --tokenizer FILE --python PYTHON]');
const output=resolve(options.get('--out')),jobs=Number(options.get('--jobs')??2);
if(!Number.isInteger(jobs)||jobs<1||jobs>8)throw new Error('--jobs must be 1..8');
if(existsSync(join(output,'baseline.json'))||existsSync(join(output,'baseline-start.json')))
  throw new Error('Baseline reports are immutable; choose a fresh output directory');
mkdirSync(output,{recursive:true});mkdirSync(join(output,'.tmp'),{recursive:true});
const env={...process.env,TMPDIR:join(output,'.tmp'),TZ:'UTC',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const report={schema:'semantic-v5-baseline/1',producerRevision:git('rev-parse','HEAD'),
  producerTree:git('rev-parse','HEAD^{tree}'),workingTreeClean:git('status','--porcelain','--untracked-files=no')==='',
  environment:admissionEnvironment(),executionEnvironment:{timezone:env.TZ,locale:env.LC_ALL},
  lockDigests:Object.fromEntries(['package-lock.json','tools/spec-oracle/package-lock.json',
    'tools/native-consumer/requirements.lock','profiles/release-environment.lock.json',
    'contracts/native-admission-policy-v5.json','contracts/semantic-harness-v5.json',
    'contracts/host-operations-v4.json'].map(path=>[path,existsSync(join(root,path))?sha(readFileSync(join(root,path))):null])),
  checks:[],corpora:[],optimizerSteps:0,learnedSuccess:null};
writeFileSync(join(output,'baseline-start.json'),JSON.stringify(report,null,2)+'\n');
function check(name,command,args,{timeout=900000}={}){
  const start=performance.now();
  const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout,maxBuffer:64*1024*1024});
  const stdout=result.stdout??'',stderr=result.stderr??'';
  writeFileSync(join(output,name+'.stdout.log'),stdout);writeFileSync(join(output,name+'.stderr.log'),stderr);
  const row={name,command:[command,...args],status:result.status===0?'passed':'failed',exitCode:result.status,
    signal:result.signal??null,reason:result.error?.message??null,wallSeconds:(performance.now()-start)/1000,
    stdout:{path:name+'.stdout.log',sha256:sha(stdout)},stderr:{path:name+'.stderr.log',sha256:sha(stderr)}};
  if(name==='unit')row.counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled','todo'].map(key=>{
    const match=stdout.match(new RegExp('^# '+key+' (\\d+)$','m'));return [key,match?Number(match[1]):null];
  }));
  report.checks.push(row);appendFileSync(join(output,'checks.jsonl'),JSON.stringify(row)+'\n');
  process.stderr.write(name+': '+row.status+' ('+row.wallSeconds.toFixed(1)+'s)\n');
  return row;
}
if(!options.has('--skip-unit')){
  check('unit',process.execPath,['--test','--test-reporter=tap',...readdirSync(join(root,'test')).filter(path=>path.endsWith('.test.js')).sort().map(path=>'test/'+path)]);
  check('reference-fixture',process.execPath,['fixtures/reference/reference-fixture.mjs']);
}else report.checks.push({name:'unit',status:'untested',reason:'Explicit --skip-unit'});
check('host-contract',process.execPath,['tools/generate-host-contract.mjs','--check']);
check('semantic-contract',process.execPath,['tools/generate-semantic-contract.mjs','--check']);
check('semantic-inspection',process.execPath,['tools/inspect-semantic-reasoning.mjs']);
check('capability-ledger',process.execPath,['tools/generate-capability-ledger.mjs','--out',join(output,'capabilities.json')]);
const native=[];
if(options.has('--megatoken')||options.has('--tokenizer')){
  if(!options.has('--megatoken')||!options.has('--tokenizer'))throw new Error('Native checks require both --megatoken and --tokenizer');
  for(const key of ['--megatoken','--tokenizer'])native.push(key,resolve(options.get(key)));
  native.push('--python',options.get('--python')??'python3','--native-policy',resolve(options.get('--native-policy')??join(root,'contracts/native-admission-policy-v5.json')),'--require-native');
}
if(!options.has('--skip-recipes'))for(const recipe of ['engineering','training-v4','benchmark-v1']){
  const directory=join(output,recipe);
  check('corpus-'+recipe,process.execPath,['tools/generate-effectful-training.mjs','--recipe',recipe,'--jobs',String(jobs),'--out',directory,...native]);
  const path=join(directory,'manifest.json');
  if(existsSync(path)){
    const manifest=JSON.parse(readFileSync(path,'utf8'));
    report.corpora.push({recipe,path:relative(output,path),sha256:sha(readFileSync(path)),counts:manifest.counts,
      families:new Set(manifest.cases.map(row=>row.family)).size,
      splitFamilies:Object.fromEntries(['train','validation','test'].map(split=>[split,new Set(manifest.cases.filter(row=>row.split===split).map(row=>row.family)).size])),
      evidenceStage:native.length?'native-admission':'local-verification'});
  }
}
report.status=report.checks.some(row=>row.status==='failed')?'failed':'passed';
report.evidenceBoundaries={acquisition:'not measured here',nativeAdmission:native.length?'executed; inspect per-corpus counts':'untested',
  browser:'untested; run npm run test:browser separately',modelEvaluation:'untested',learningImprovement:'unmeasured'};
writeFileSync(join(output,'baseline.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:join(output,'baseline.json'),status:report.status,checks:report.checks.length,corpora:report.corpora}));
if(report.status!=='passed')process.exitCode=1;
