import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {installedQualificationInventory,installedQualificationOutcome,parseInstalledQualificationOptions} from '../tools/qualify-installed-v8.mjs';
import {decodeInstalledFixtureTask,executeInstalledV8Task} from '../tools/installed-v8-worker.mjs';
import {decodeGenerationTask,encodeGenerationTask,generationEnvironment} from '../src/corpus/generation-process.mjs';
import {prepareInstalledV8Package,restoreInstalledV8Package,verifyInstalledArchiveIntegrity,runInstalledCommand,
  LEGACY_V8_CLIENT_FILES,installedSha256} from '../src/corpus/installed-v8-qualification.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
test('installed inventory retains all 665 original and 66 selected inputs including five module graphs',()=>{
  const all=installedQualificationInventory({producerRevision:'test'}),
    smoke=installedQualificationInventory({producerRevision:'test',requested:['interoperability:key-getter']});
  assert.deepEqual(all.declared,{all:665,interoperability:66});assert.deepEqual(all.selected,all.declared);
  assert.equal(all.rows.length,731);assert.equal(all.rows.filter(row=>row.kind==='module').length,5);
  assert.deepEqual(smoke.selected,{all:0,interoperability:1});
  assert.deepEqual(smoke.rows.map(({selected,...row})=>row),all.rows.map(({selected,...row})=>row));
  for(const row of all.rows)assert.deepEqual(decodeInstalledFixtureTask(JSON.parse(JSON.stringify(row.task))),decodeGenerationTask(row.task));
  assert.equal(all.rows.filter(row=>row.task.fixture.originalReferenceSource).length,27);
  assert.equal(all.rows.filter(row=>row.task.fixture.originalReferenceSource&&
    row.task.fixture.originalReferenceSource!==row.task.fixture.source).length,1);
  assert.throws(()=>installedQualificationInventory({producerRevision:'test',requested:['missing']}),/Unknown/);
  assert.throws(()=>installedQualificationInventory({population:'gallery'}),/Unknown/);
});

test('installed fixture transport preserves holes, cycles, null prototypes, special numbers and bigint',()=>{
  const shared=Object.assign(Object.create(null),{value:-0});shared.self=shared;
  const sparse=[,shared,undefined];
  const task=encodeGenerationTask({kind:'source',traceVersion:8,fixture:{id:'data',args:[shared,shared,sparse,NaN,Infinity,-Infinity,12n]}}),
    actual=decodeInstalledFixtureTask(JSON.parse(JSON.stringify(task))).fixture.args;
  assert.equal(Object.getPrototypeOf(actual[0]),null);assert.equal(actual[0],actual[1]);assert.equal(actual[0].self,actual[0]);
  assert.equal(0 in actual[2],false);assert.equal(actual[2][1],actual[0]);assert(Object.is(actual[0].value,-0));
  assert.deepEqual(actual,[shared,shared,sparse,NaN,Infinity,-Infinity,12n]);
});

test('installed CLI refuses malformed bounds and keeps diagnostic selection explicit',()=>{
  const options=parseInstalledQualificationOptions(['--out','/tmp/output','--cases','interoperability:key-getter',
    '--workers','2','--worker-timeout-ms','20000']);
  assert.equal(options.population,'both');assert.equal(options.workers,2);assert.equal(options.bounds.timeoutMs,20000);
  assert.deepEqual(options.requested,['interoperability:key-getter']);
  for(const args of [[],['--out'],['--out','x','--out','y'],['--out','x','--workers','0'],['--out','x','--unknown']])
    assert.throws(()=>parseInstalledQualificationOptions(args));
});

test('public worker source, callback and original module controls recheck and continue without a native receipt',async()=>{
  const population=installedQualificationInventory({producerRevision:'worker-control',population:'interoperability'}),
    lock=installedSha256(await readFile(join(root,'npm-shrinkwrap.json')));
  for(const id of ['key-getter','return-callback-receiver-alias','module-scoped-var-isolation']){
    const row=population.rows.find(row=>row.id===id);assert(row,id);
    const result=await executeInstalledV8Task(row.task,{producerRevision:'worker-control',packageLockSha256:lock});
    assert.equal(result.installedChecks?.source,'passed',id+': '+result.reason);
    assert.equal(result.installedChecks.continuedFromPrefix,true);assert.equal(result.installedChecks.native,'untested');
    assert.equal(result.exported.sidecar.nativeAdmission,null);
  }
});

test('public worker checks original source separately and retains a disagreement before projection',async()=>{
  const fixture={id:'original',family:'installed-original-control',entry:'run',args:[],fixture:{calls:[]},
    source:'"use strict";function run(){return 7;}',originalReferenceSource:'"use strict";function run(){return 9;}'};
  const result=await executeInstalledV8Task(encodeGenerationTask({kind:'source',traceVersion:8,fixture}),
    {producerRevision:'worker-control',packageLockSha256:installedSha256(await readFile(join(root,'npm-shrinkwrap.json')))});
  assert.equal(result.status,'original_source_mismatch');assert(!result.exported);
  assert.equal(result.originalSourceEvidence.input.source,fixture.originalReferenceSource);
  assert.equal(result.originalSourceEvidence.transformedSource,fixture.source);
  assert.notEqual(result.originalSourceEvidence.originalReferenceDigest,result.originalSourceEvidence.transformedReferenceDigest);
});

test('a refused selected original-population source makes the installed gate fail without dropping its disposition',async()=>{
  const fixture={id:'deliberately-refused-original-control',family:'installed-refusal-control',entry:'run',args:[],fixture:{calls:[]},
    source:'"use strict";function run(){return new WeakMap();}'};
  const result=await executeInstalledV8Task(encodeGenerationTask({kind:'source',traceVersion:8,fixture}),
    {producerRevision:'worker-control',packageLockSha256:installedSha256(await readFile(join(root,'npm-shrinkwrap.json')))});
  assert(!result.exported);assert.equal(result.installedChecks.source,'refused');
  const rows=[{id:fixture.id,population:'all',selected:true,source:'unqualified',status:result.status,reason:result.reason}];
  const outcome=installedQualificationOutcome(rows);
  assert.equal(outcome.status,'failed');assert.equal(outcome.coverageComplete,true);assert.equal(outcome.sourcePopulationQualified,false);
  assert.deepEqual(outcome.selectedSourceFailures,['all:'+fixture.id]);assert.equal(rows[0].reason,result.reason);
});

test('canonical expected results remain an independent gate even when original and transformed sources agree',async()=>{
  const source='"use strict";function run(){return 7;}',fixture={id:'canonical',family:'installed-canonical-control',
    entry:'run',args:[],fixture:{calls:[]},source,originalReferenceSource:source,
    provenance:{inputOrigin:'upstream-canonical',canonicalExpected:9}};
  const result=await executeInstalledV8Task(encodeGenerationTask({kind:'source',traceVersion:8,fixture}),
    {producerRevision:'worker-control',packageLockSha256:installedSha256(await readFile(join(root,'npm-shrinkwrap.json')))});
  assert.equal(result.status,'canonical_mismatch');assert(!result.exported);
  assert.equal(result.originalSourceEvidence.originalReferenceDigest,result.originalSourceEvidence.transformedReferenceDigest);
  assert.equal(result.originalSourceEvidence.canonicalCheck.status,'disagreed');
  assert.equal(result.originalSourceEvidence.canonicalExpected,9);
});

test('complete Git package staging includes sparse files and installs exact locked archives without scripts',async t=>{
  const directory=await mkdtemp(join(dirname(root.slice(0,-1)),'installed-v8-package-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,'source'),output=join(directory,'evidence'),dependencyDirectory=join(directory,'dependency-archives'),
    dependencyStage=join(directory,'dependency-stage');
  await mkdir(source,{recursive:true});await mkdir(dependencyDirectory);await mkdir(join(dependencyStage,'package'),{recursive:true});
  const command=(name,args,cwd=source)=>runInstalledCommand(name,args,{cwd,timeoutMs:60000});
  const dep={name:'installed-gate-dependency',version:'1.0.0',scripts:{install:'node -e "require(\'node:fs\').writeFileSync(\'SCRIPT_RAN\',\'bad\')"'}};
  await writeFile(join(dependencyStage,'package','package.json'),JSON.stringify(dep)+'\n');
  await writeFile(join(dependencyStage,'package','index.js'),'module.exports=7;\n');
  const depArchive=join(dependencyDirectory,'installed-gate-dependency-1.0.0.tgz');
  await command('tar',['-czf',depArchive,'-C',dependencyStage,'package']);
  const integrity='sha512-'+createHash('sha512').update(await readFile(depArchive)).digest('base64');
  const tarball=await readFile(depArchive),server=createServer((request,response)=>{
    if(request.url!=='/installed-gate-dependency-1.0.0.tgz'){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'content-type':'application/octet-stream'});response.end(tarball);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>{server.closeAllConnections();server.close();});
  const dependencyUrl='http://127.0.0.1:'+server.address().port+'/installed-gate-dependency-1.0.0.tgz',
    dependencyCache=join(directory,'locked-url-cache');
  const metadata={name:'tracing-js-self',version:'0.0.0',private:true,type:'module',
    exports:{'./semantic/v8':'./src/semantic/index-v8.js'},dependencies:{'installed-gate-dependency':'1.0.0'}};
  await writeFile(join(source,'package.json'),JSON.stringify(metadata)+'\n');
  await writeFile(join(source,'npm-shrinkwrap.json'),JSON.stringify({name:metadata.name,version:metadata.version,lockfileVersion:3,
    packages:{'':metadata,'node_modules/installed-gate-dependency':{version:'1.0.0',
      resolved:dependencyUrl,integrity}}})+'\n');
  const files=['tools/installed-v8-worker.mjs','src/semantic/index-v8.js','fixtures/not-curated/sparse-proof.txt',...LEGACY_V8_CLIENT_FILES];
  for(const file of files){await mkdir(dirname(join(source,file)),{recursive:true});await writeFile(join(source,file),'retained '+file+'\n');}
  await command('git',['init','-q']);await command('git',['config','user.email','installed-test@example.invalid']);
  await command('git',['config','user.name','Installed Gate Test']);await command('git',['add','.']);
  await command('git',['commit','-qm','Fixture package']);
  const sparse='fixtures/not-curated/sparse-proof.txt';
  await command('git',['update-index','--skip-worktree',sparse]);await rm(join(source,sparse));
  assert.equal((await command('git',['status','--porcelain'])).stdout.trim(),'');
  const missingCache=join(directory,'missing-url-cache');
  await assert.rejects(runInstalledCommand('npm',['pack',dependencyUrl,'--offline','--ignore-scripts','--json',
    '--pack-destination',dependencyDirectory],{cwd:source,timeoutMs:60000,env:{...generationEnvironment(),npm_config_cache:missingCache,
      npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'}}),
    /ENOTCACHED|cache mode|offline/);
  await runInstalledCommand('npm',['cache','add',dependencyUrl,'--ignore-scripts','--no-audit','--no-fund'],
    {cwd:source,timeoutMs:60000,env:{...generationEnvironment(),npm_config_cache:dependencyCache}});
  await new Promise(resolve=>server.close(resolve));
  const install=await prepareInstalledV8Package({root:source,output,dependencyCache});
  assert.equal(install.evidence.source.method,'complete-git-archive');assert(install.evidence.source.trackedFiles.includes(sparse));
  assert.equal(await readFile(join(install.installed,sparse),'utf8'),'retained '+sparse+'\n');
  const pack=JSON.parse(await readFile(join(output,'npm-pack.json'),'utf8'));assert(pack.files.some(row=>row.path===sparse));
  assert.equal(install.evidence.dependencies[0].lockIntegrity,integrity);
  assert.equal(install.evidence.dependencies[0].resolved,dependencyUrl);
  assert.equal(install.evidence.dependencies[0].source,'offline-locked-tarball-url');
  assert.equal(install.evidence.installation.legacyClientsRemoved.length,LEGACY_V8_CLIENT_FILES.length);
  await assert.rejects(access(join(install.application,'node_modules','installed-gate-dependency','SCRIPT_RAN')),error=>error.code==='ENOENT');
  await restoreInstalledV8Package({output});
  const bad=join(directory,'bad.tgz');await writeFile(bad,Buffer.concat([await readFile(depArchive),Buffer.from('changed')]));
  await assert.rejects(verifyInstalledArchiveIntegrity(bad,integrity),/integrity mismatch/);
  const truncated=join(directory,'truncated.tgz');await writeFile(truncated,(await readFile(depArchive)).subarray(0,-8));
  await assert.rejects(verifyInstalledArchiveIntegrity(truncated,integrity),/integrity mismatch/);
  await writeFile(join(install.application,'node_modules','installed-gate-dependency','index.js'),'changed\n');
  await assert.rejects(restoreInstalledV8Package({output}),/dependency or archive changed/);
});
