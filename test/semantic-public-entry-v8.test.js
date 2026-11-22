import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import * as v8 from 'tracing-js-self/semantic/v8';
import * as aggregate from 'tracing-js-self/semantic';
import * as training from 'tracing-js-self/training';
import {encodeDetailedRecord,decodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {SemanticControllerV8} from '../src/semantic/controller-v8.js';
import {SelectedExecutionLifecycleV8} from '../src/semantic/lifecycle-v8.js';

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const legacyFiles=[
  ...['format','trace-text','harness-v4','controller','render','model-driver','effectful-compiler',
    'effectful-admit','effectful-session','admission-identity'].map(name=>'src/training/'+name+'.js'),
  ...['trace-codec','detailed-v7','causal-lm-v7','compiler','controller','harness','dataset-v7','native-v7']
    .map(name=>'src/semantic/'+name+'.js')
];

test('the public V8 entry reuses direct implementations and retains historical public routes',()=>{
  assert.equal(v8.encodeDetailedRecord,encodeDetailedRecord);assert.equal(v8.decodeDetailedRecord,decodeDetailedRecord);
  assert.equal(v8.SemanticControllerV8,SemanticControllerV8);
  assert.equal(v8.SelectedExecutionLifecycleV8,SelectedExecutionLifecycleV8);
  for(const [name,value]of Object.entries(v8))if(Object.hasOwn(aggregate,name)&&
    !['encodeDetailedRecord','decodeDetailedRecord'].includes(name))assert.equal(value,aggregate[name],name);
  for(const name of ['compileSourceWitnessV8','verifySourceProjectionV8','verifySourceTrainingCaseV8',
    'recheckSourceAdmissionV8','independentSourceReferenceV8','verifyRegionTrainingCase','recheckRegionEvidence','admitRegionEvidence',
    'RegionSelectedModelDriver','createNativeV8ProcessSelector','buildRegionDataset'])
    assert.equal(typeof v8[name],'function',name);
  assert.equal(aggregate.ALGORITHM_TRACE_VERSION,'semantic-trace/7');
  assert.equal(typeof aggregate.verifyAlgorithmTrainingCase,'function');
  assert.equal(training.WITNESS_VERSION,'semantic-trace/6');
  assert.deepEqual(training.decodeWitness(training.encodeWitness('return',{value:['num',7]})),
    {kind:'return',fields:{value:['num',7]}});
});

test('shared value presentation retains exact historical and V8 rendering without a V7 codec dependency',()=>{
  const values=[
    [['undefined'],'undefined'],[['null'],'null'],[['bool',false],'false'],
    [['num','-0'],'-0'],[['num','NaN'],'NaN'],[['num','+Infinity'],'Infinity'],[['num','-Infinity'],'-Infinity'],
    [['bigint','9007199254740993'],'9007199254740993n'],[['str','\ud800😀'],'"\\ud800😀"'],
    [['ref','cell'],'@cell'],[['ref','return'],'@"return"'],[['ref','a:b'],'@"a:b"']
  ];
  for(const [value,expected]of values){
    assert.equal(aggregate.encodeAlgorithmValue(value),expected);
    assert.equal(v8.renderAlgorithmV8Record({kind:'return',value}),'return '+expected);
    assert.deepEqual(aggregate.decodeAlgorithmRecord(aggregate.encodeAlgorithmRecord({kind:'return',value})),
      {kind:'return',value});
  }
});

test('public V8 source certification and protocol admission checks run with legacy imports blocked',t=>{
  // Resolve first: an alias or relative import cannot evade the dependency gate.
  const loader='const blocked='+JSON.stringify(legacyFiles)+';'+
    'export async function resolve(s,c,next){const r=await next(s,c);'+
    'if(blocked.some(path=>new URL(r.url).pathname.endsWith("/"+path)))'+
    'throw new Error("legacy dependency: "+r.url);return r;}';
  const run=spawnSync(process.execPath,['--no-warnings','--experimental-loader',
    'data:text/javascript,'+encodeURIComponent(loader),
    fileURLToPath(new URL('./fixtures/semantic-v8-public-source-client.mjs',import.meta.url))],
    {cwd:root,encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024});
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const receipt=JSON.parse(run.stdout.trim());
  assert.equal(receipt.valid,true);assert.deepEqual(receipt.results.map(row=>row.id),['pure','effect','protocol']);
  assert.equal(receipt.nativeAdmission,'forged-receipt-refused');
  t.diagnostic(JSON.stringify(receipt));
});

test('packed public V8 installation certifies source and restores execution with legacy clients absent',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'public-v8-install-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const staging=join(directory,'staging'),application=join(directory,'application'),
    installed=join(application,'node_modules','tracing-js-self'),cache=join(directory,'npm-cache');
  await mkdir(staging,{recursive:true});await mkdir(application,{recursive:true});
  // Package the runtime assets used by this gate with the repository's exact
  // package metadata. Large historical reports are not runtime dependencies;
  // full release-archive restoration remains a separate qualification.
  for(const name of ['src','tools','contracts','catalog','bin','package.json','npm-shrinkwrap.json','README.md'])
    await cp(join(root,name),join(staging,name),{recursive:true});
  const env={...process.env,npm_config_cache:cache,npm_config_update_notifier:'false'};
  const packed=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',directory],
    {cwd:staging,env,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
  assert.equal(packed.status,0,packed.stderr||packed.error?.message);
  const manifest=JSON.parse(packed.stdout)[0],filename=manifest.filename;
  assert(manifest.files.some(file=>file.path==='npm-shrinkwrap.json'));
  assert(!manifest.files.some(file=>file.path==='package-lock.json'));
  await writeFile(join(application,'package.json'),JSON.stringify({name:'public-v8-consumer',private:true,type:'module'}));
  // Archive the already-installed dependency bytes without invoking their build
  // lifecycles. npm 10's pack runs prepare even with --ignore-scripts; published
  // Acorn's prepare expects its absent monorepo. Keep package metadata and code
  // unchanged, and give npm explicit local archives so installation stays offline.
  const archives=[join(directory,filename)];
  for(const name of ['acorn','typescript']){
    const dependencyRoot=dirname(require.resolve(name+'/package.json')),
      dependencyStage=join(directory,'dependency-'+name),archive=join(directory,name+'.tgz');
    await mkdir(dependencyStage);
    await cp(dependencyRoot,join(dependencyStage,'package'),{recursive:true});
    const dependency=spawnSync('tar',['-czf',archive,'-C',dependencyStage,'package'],
      {cwd:application,env,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
    assert.equal(dependency.status,0,dependency.stderr||dependency.error?.message);
    archives.push(archive);
  }
  const install=spawnSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',
    '--package-lock=false','--omit=dev',...archives],
    {cwd:application,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(install.status,0,install.stderr||install.error?.message);
  for(const name of ['acorn','typescript']){
    const source=dirname(require.resolve(name+'/package.json')),
      target=join(application,'node_modules',name);
    assert.deepEqual(await readFile(join(target,'package.json')),await readFile(join(source,'package.json')),
      name+' package metadata must remain byte-identical');
  }
  assert.deepEqual(JSON.parse(await readFile(join(installed,'package.json'),'utf8')).exports,
    JSON.parse(await readFile(join(root,'package.json'),'utf8')).exports);
  const lock=await readFile(join(root,'npm-shrinkwrap.json'));
  await assert.rejects(readFile(join(root,'package-lock.json')),error=>error.code==='ENOENT');
  assert.deepEqual(await readFile(join(installed,'npm-shrinkwrap.json')),lock);
  await assert.rejects(readFile(join(installed,'package-lock.json')),error=>error.code==='ENOENT');
  for(const path of legacyFiles){
    await rm(join(installed,path));
    await assert.rejects(readFile(join(installed,path)),error=>error.code==='ENOENT');
  }
  await cp(new URL('./fixtures/semantic-v8-installed-client.mjs',import.meta.url),join(application,'run.mjs'));
  const run=spawnSync(process.execPath,['run.mjs'],{cwd:application,env,encoding:'utf8',
    timeout:90000,maxBuffer:2*1024*1024});
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const receipt=JSON.parse(run.stdout.trim());
  assert.equal(receipt.valid,true);assert.deepEqual(receipt.results.map(row=>row.id),['pure','effect']);
  assert.equal(receipt.nativeCalls,1);
  t.diagnostic(JSON.stringify(receipt));

  await cp(new URL('./fixtures/semantic-v8-public-source-client.mjs',import.meta.url),join(application,'source.mjs'));
  const sourceRun=spawnSync(process.execPath,['source.mjs','--installed','--write-evidence','source-evidence.json'],
    {cwd:application,env,encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024});
  assert.equal(sourceRun.status,0,sourceRun.stderr||sourceRun.error?.message);
  const sourceReceipt=JSON.parse(sourceRun.stdout.trim());
  assert.equal(sourceReceipt.sourceAdmission,'verified-exact-lock-evidence');
  assert.deepEqual(sourceReceipt.results.map(row=>row.id),['pure','effect','protocol']);
  t.diagnostic(JSON.stringify(sourceReceipt));

  // Rechecking previously admitted bytes must reject changed dependency
  // evidence before consulting a native consumer, even when JSON stays valid.
  await writeFile(join(installed,'npm-shrinkwrap.json'),Buffer.concat([lock,Buffer.from('\n')]));
  const tamper=`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
    import {recheckRegionEvidence,loadV8NativePolicy} from 'tracing-js-self/semantic/v8';
    const candidate=JSON.parse(readFileSync('source-evidence.json','utf8'));let nativeCalls=0;
    await assert.rejects(recheckRegionEvidence(candidate,{nativePolicy:loadV8NativePolicy(),
      nativeConsumer:async()=>{nativeCalls++;return {admitted:true};}}),/runtime, dependency or verifier environment/);
    assert.equal(nativeCalls,0);`;
  const tampered=spawnSync(process.execPath,['--input-type=module','--eval',tamper],
    {cwd:application,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(tampered.status,0,tampered.stderr||tampered.error?.message);

  await rm(join(installed,'npm-shrinkwrap.json'));
  const missing=`import assert from 'node:assert/strict';
    import {verifyRegionTrainingCase} from 'tracing-js-self/semantic/v8';
    await assert.rejects(verifyRegionTrainingCase({source:'"use strict";function run(){return 7;}',
      entry:'run',family:'missing-lock',fixture:{calls:[]}}),
      error=>error.code==='ENOENT'&&error.path.endsWith('/npm-shrinkwrap.json'));`;
  const omitted=spawnSync(process.execPath,['--input-type=module','--eval',missing],
    {cwd:application,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(omitted.status,0,omitted.stderr||omitted.error?.message);
  t.diagnostic('Changed and omitted packaged lock evidence refused; zero native admission calls.');
});
